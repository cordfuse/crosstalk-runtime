#!/usr/bin/env node
import { resolve, join } from 'path';
import { readFile, access, watch } from 'fs/promises';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const { version } = _require('../package.json') as { version: string };
import { loadConfig, configFromFlags, type AgentConfig, type RuntimeConfig } from './config.js';
import { readCursor, writeCursor, cursorExists, listMessages, messagesAfterCursor, currentTip, discoverChannels } from './cursor.js';
import { pull, commitAndPush, commitAndPushWithTokn } from './git.js';
import { ensureChannel } from './tokn.js';
import { dispatchTick } from './dispatch.js';
import { parseFrontmatter } from './frontmatter.js';
import { runInit } from './init.js';

const HELP = `
Usage:
  crosstalk init [--transport <path>]
  crosstalk --config <path>
  crosstalk-runtime --transport <path> --agent "name:cli" [--agent ...] [options]

Options:
  --config <path>         Load config from YAML file (default: config.yaml)
  --transport <path>      Path to transport repo (flag mode — no YAML needed)
  --agent "name:cli"      Agent definition; repeat for multiple agents
  --tokn-url <url>        tokn server URL for push serialization
  --tokn-channel <name>   tokn channel name (default: crosstalk:push)
  --interval <seconds>    Tick interval per agent (default: 60)
  --jitter <ms>           Max jitter ms for fallback push (default: 5000)
  --channels-dir <path>   Channels dir relative to transport (default: data/channels)
  --help                  Show this message
`.trim();

// Tracks interval handles for running agents so they can be stopped on reload.
// Keyed by runtime key (see runtimeKeyFor) — distinct per process instance, so
// shared-name instance groups (CROSSTALK.md Instance groups) don't collide.
const agentHandles = new Map<string, ReturnType<typeof setInterval>>();

// Process-local key for state tracking. Equals agent.name when the name is
// unique. For shared names, appends `#<index>` so each instance has its own
// cursor + handle. Transport-facing identity (from:, to:, git author) still
// uses agent.name — only on-disk runtime state uses this key.
function runtimeKeyFor(agents: AgentConfig[], target: AgentConfig): string {
  const sameName = agents.filter(a => a.name === target.name);
  if (sameName.length <= 1) return target.name;
  return `${target.name}#${sameName.indexOf(target)}`;
}

async function resolveConfig(): Promise<{ config: RuntimeConfig; configPath: string | null }> {
  const argv = process.argv;
  if (argv.includes('--help')) { console.log(HELP); process.exit(0); }
  const configIdx = argv.indexOf('--config');
  if (configIdx !== -1) {
    const configPath = argv[configIdx + 1];
    return { config: await loadConfig(configPath), configPath: resolve(configPath) };
  }
  if (argv.includes('--transport')) return { config: configFromFlags(argv), configPath: null };
  try {
    await access('config.yaml');
    return { config: await loadConfig('config.yaml'), configPath: resolve('config.yaml') };
  } catch {}
  console.error('error: provide --config <path>, --transport <path> --agent "name:cli", or a config.yaml in the current directory\n\n' + HELP);
  process.exit(1);
}

// Resolve system prompt: explicit file override → convention path → undefined
async function resolveSystemPrompt(transportPath: string, agent: AgentConfig): Promise<string | undefined> {
  const candidatePath = agent.systemPromptFile
    ? join(transportPath, agent.systemPromptFile)
    : join(transportPath, 'manifest', 'custom', 'actors', `${agent.name}.md`);
  try {
    return await readFile(candidatePath, 'utf-8');
  } catch {
    if (agent.systemPromptFile) {
      console.warn(`[${agent.name}] systemPromptFile not found: ${agent.systemPromptFile}`);
    }
    return undefined;
  }
}

// Derive git identity: explicit override → actor frontmatter alias → bare name.
// Persona-file lookup mirrors resolveSystemPrompt so fan-out slots
// (slot name ≠ persona file name) still pick up the alias.
async function resolveGitIdentity(
  transportPath: string,
  agent: AgentConfig,
): Promise<{ name: string; email: string }> {
  if (agent.git) return agent.git;
  const candidatePath = agent.systemPromptFile
    ? join(transportPath, agent.systemPromptFile)
    : join(transportPath, 'manifest', 'custom', 'actors', `${agent.name}.md`);
  try {
    const raw = await readFile(candidatePath, 'utf-8');
    const { data } = parseFrontmatter(raw);
    const meta = data.metadata as Record<string, string> | undefined;
    const alias = meta?.alias ?? String(data.alias ?? '');
    const displayName = alias ? `${alias} (${agent.name})` : agent.name;
    return { name: displayName, email: `${agent.name}@crosstalk.local` };
  } catch {
    return { name: agent.name, email: `${agent.name}@crosstalk.local` };
  }
}

async function tickChannel(opts: {
  config: RuntimeConfig;
  agent: AgentConfig;
  runtimeKey: string;
  channelGuid: string;
  transportPath: string;
  systemPrompt: string | undefined;
  gitIdentity: { name: string; email: string };
  instanceIndex: number;
  groupSize: number;
}): Promise<void> {
  const { config, agent, runtimeKey, channelGuid, transportPath, systemPrompt, gitIdentity, instanceIndex, groupSize } = opts;
  const channelDir = join(transportPath, config.channelsDir, channelGuid);
  const allRelPaths = await listMessages(channelDir);

  // First time this agent sees this channel — initialize cursor to tip, skip history.
  if (!await cursorExists(transportPath, runtimeKey, channelGuid)) {
    const tip = currentTip(allRelPaths);
    if (tip) await writeCursor(transportPath, runtimeKey, channelGuid, tip);
    return;
  }

  const cursor = await readCursor(transportPath, runtimeKey, channelGuid);
  const unread = messagesAfterCursor(allRelPaths, cursor);

  if (unread.length === 0) return;

  const { stagedFiles, lastProcessed } = await dispatchTick({
    transportPath,
    channelsDir: config.channelsDir,
    channelGuid,
    allRelPaths,
    unreadRelPaths: unread,
    agent,
    systemPrompt,
    instanceIndex,
    groupSize,
  });

  if (stagedFiles.length === 0) {
    const advance = lastProcessed ?? unread[unread.length - 1];
    await writeCursor(transportPath, runtimeKey, channelGuid, advance);
    return;
  }

  const now = new Date();
  const label = `${now.toISOString().slice(0, 16).replace('T', ' ')}Z`;
  const ok = config.tokn
    ? await commitAndPushWithTokn({
        transportPath,
        files: stagedFiles,
        message: `crosstalk: ${agent.name} ${label}`,
        identity: gitIdentity,
        tokn: config.tokn,
      })
    : await commitAndPush({
        transportPath,
        files: stagedFiles,
        message: `crosstalk: ${agent.name} ${label}`,
        identity: gitIdentity,
        jitterMs: config.jitter,
      });

  if (ok && lastProcessed) {
    await writeCursor(transportPath, runtimeKey, channelGuid, lastProcessed);
  } else if (!ok) {
    console.error(`[${agent.name}] push failed after retries — will retry next tick`);
  }
}

async function tick(
  config: RuntimeConfig,
  agent: AgentConfig,
  runtimeKey: string,
  channels: string[],
  systemPrompt: string | undefined,
  gitIdentity: { name: string; email: string },
  instanceIndex: number,
  groupSize: number,
): Promise<void> {
  const transportPath = resolve(config.transport);
  try {
    await pull(transportPath);
  } catch {
    console.error(`[${runtimeKey}] git pull failed — skipping tick`);
    return;
  }
  for (const channelGuid of channels) {
    await tickChannel({ config, agent, runtimeKey, channelGuid, transportPath, systemPrompt, gitIdentity, instanceIndex, groupSize });
  }
}

function stopAgent(name: string): void {
  const handle = agentHandles.get(name);
  if (handle) {
    clearInterval(handle);
    agentHandles.delete(name);
    console.log(`[${name}] stopped`);
  }
}

async function startAgent(config: RuntimeConfig, agent: AgentConfig): Promise<void> {
  const transportPath = resolve(config.transport);
  const systemPrompt = await resolveSystemPrompt(transportPath, agent);
  const gitIdentity = await resolveGitIdentity(transportPath, agent);

  // Instance group: agents in this config that share our name. Position via
  // reference equality is stable because each AgentConfig is a distinct object.
  const sameName = config.agents.filter(a => a.name === agent.name);
  const instanceIndex = sameName.indexOf(agent);
  const groupSize = sameName.length;
  const runtimeKey = runtimeKeyFor(config.agents, agent);

  const allChannels = await discoverChannels(transportPath, config.channelsDir);
  const channels = agent.channels?.length
    ? agent.channels.filter(g => allChannels.includes(g))
    : allChannels;

  if (channels.length === 0) {
    console.warn(`[${runtimeKey}] no channels found in ${join(transportPath, config.channelsDir)} — waiting`);
  }

  if (config.tokn && !agentHandles.size) {
    await ensureChannel(config.tokn);
  }

  const interval = agent.interval ?? config.interval;
  const groupInfo = groupSize > 1 ? ` instance=${instanceIndex + 1}/${groupSize}` : '';
  console.log(`[${runtimeKey}] starting — channels=${channels.length} interval=${interval}s git="${gitIdentity.name}"${groupInfo}`);

  const run = () => tick(config, agent, runtimeKey, channels, systemPrompt, gitIdentity, instanceIndex, groupSize).catch(err => {
    console.error(`[${runtimeKey}] tick error:`, err);
  });

  await run();
  agentHandles.set(runtimeKey, setInterval(run, interval * 1000));
}

async function applyConfig(config: RuntimeConfig): Promise<void> {
  const incomingKeys = new Set(config.agents.map(a => runtimeKeyFor(config.agents, a)));
  const running = new Set(agentHandles.keys());

  // Stop agents that were removed or changed
  for (const key of running) {
    if (!incomingKeys.has(key)) {
      stopAgent(key);
    }
  }

  // Start agents that are new
  const toStart = config.agents.filter(a => !agentHandles.has(runtimeKeyFor(config.agents, a)));
  await Promise.all(toStart.map(agent => startAgent(config, agent)));
}

async function watchConfig(configPath: string, getCurrentConfig: () => RuntimeConfig): Promise<void> {
  let debounce: ReturnType<typeof setTimeout> | null = null;
  try {
    const watcher = watch(configPath);
    for await (const _ of watcher) {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(async () => {
        try {
          const next = await loadConfig(configPath);
          console.log(`config reloaded — agents=${next.agents.length}`);
          await applyConfig(next);
        } catch (err) {
          console.error('config reload failed:', err);
        }
      }, 500);
    }
  } catch {
    // watch not available or file removed — silently stop watching
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === 'init') {
    await runInit(process.argv.slice(3));
    return;
  }
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    console.log(version);
    return;
  }
  const { config, configPath } = await resolveConfig();
  console.log(`crosstalk runtime v2 — transport=${config.transport} agents=${config.agents.length}`);
  await applyConfig(config);
  if (configPath) watchConfig(configPath, () => config);
}

main().catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});
