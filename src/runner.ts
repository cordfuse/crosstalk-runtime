#!/usr/bin/env node
import { resolve, join } from 'path';
import { readFile, access, watch } from 'fs/promises';
import { hostname as osHostname } from 'os';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const { version } = _require('../package.json') as { version: string };
import { loadConfig, configFromFlags, findHostFile, expandHostFile, type AgentConfig, type RuntimeConfig, type HostFile } from './config.js';
import { readCursor, writeCursor, cursorExists, listMessages, messagesAfterCursor, currentTip, discoverChannels } from './cursor.js';
import { pull, commitAndPush, initCoordinator } from './git.js';
import { dispatchTick, dispatchSingle } from './dispatch.js';
import { parseFrontmatter } from './frontmatter.js';
import { JobQueue, type Job } from './queue.js';
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
  --turnq-url <url>        turnq server URL for distributed push serialization
  --turnq-channel <name>   turnq channel name (default: crosstalk:push)
  --interval <seconds>    Tick interval per agent (default: 60)
  --channels-dir <path>   Channels dir relative to transport (default: data/channels)
  --help                  Show this message
`.trim();

// ── Shared helpers ─────────────────────────────────────────────────────────

async function resolveSystemPrompt(transportPath: string, agent: Pick<AgentConfig, 'name' | 'systemPromptFile'>): Promise<string | undefined> {
  const candidatePath = agent.systemPromptFile
    ? join(transportPath, agent.systemPromptFile)
    : join(transportPath, 'manifest', 'custom', 'actors', `${agent.name}.md`);
  try {
    return await readFile(candidatePath, 'utf-8');
  } catch {
    if (agent.systemPromptFile) console.warn(`[${agent.name}] systemPromptFile not found: ${agent.systemPromptFile}`);
    return undefined;
  }
}

async function resolveGitIdentity(
  transportPath: string,
  agentName: string,
  systemPromptFile?: string,
  hostAlias?: string,
): Promise<{ name: string; email: string }> {
  const candidatePath = systemPromptFile
    ? join(transportPath, systemPromptFile)
    : join(transportPath, 'manifest', 'custom', 'actors', `${agentName}.md`);
  const emailHost = hostAlias ? `${hostAlias}.crosstalk.local` : 'crosstalk.local';
  try {
    const raw = await readFile(candidatePath, 'utf-8');
    const { data } = parseFrontmatter(raw);
    const meta = data.metadata as Record<string, string> | undefined;
    const alias = meta?.alias ?? String(data.alias ?? '');
    const displayName = alias ? `${alias} (${agentName})` : agentName;
    return { name: displayName, email: `${agentName}@${emailHost}` };
  } catch {
    return { name: agentName, email: `${agentName}@${emailHost}` };
  }
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

// ── v3 Coordinator ─────────────────────────────────────────────────────────
//
// Replaces N per-agent polling loops with a single coordinator:
//   1. Pull git
//   2. Scan all channels × actors, enqueue unread messages
//   3. Drain the queue — dispatch up to each actor's total count concurrently
//   4. Wait interval, repeat
//
// Hash-based instance selection (v2) is dropped: the queue guarantees
// exactly-once delivery without needing per-instance disambiguation.

interface ActorMeta {
  totalCount: number;                   // sum of tier counts from host file
  tiers: Array<{ name: string; cli: string; count: number }>;
  systemPrompt: string | undefined;
  gitIdentity: { name: string; email: string };
}

async function buildActorMeta(
  transportPath: string,
  hostFile: HostFile,
  hostAlias?: string,
): Promise<Map<string, ActorMeta>> {
  const map = new Map<string, ActorMeta>();
  for (const [actorName, tierMap] of Object.entries(hostFile.actors)) {
    const tiers: ActorMeta['tiers'] = [];
    let totalCount = 0;
    for (const [tierName, tierValue] of Object.entries(tierMap)) {
      const cli   = typeof tierValue === 'string' ? tierValue : tierValue.cli;
      const count = typeof tierValue === 'string' ? 1 : (tierValue.count ?? 1);
      tiers.push({ name: tierName, cli, count });
      totalCount += count;
    }
    const systemPrompt  = await resolveSystemPrompt(transportPath, { name: actorName });
    const gitIdentity   = await resolveGitIdentity(transportPath, actorName, undefined, hostAlias);
    map.set(actorName, { totalCount, tiers, systemPrompt, gitIdentity });
  }
  return map;
}

// Pick a CLI for a job. For now: use the first tier's CLI. A future version
// can accept tier hints from the message's metadata to select dynamically.
function pickCli(meta: ActorMeta): { tier: string; cli: string } {
  return { tier: meta.tiers[0].name, cli: meta.tiers[0].cli };
}

async function runCoordinator(config: RuntimeConfig, hostFile: HostFile): Promise<void> {
  const transportPath = resolve(config.transport);
  const hostAlias     = hostFile.alias;
  const actorMeta     = await buildActorMeta(transportPath, hostFile, hostAlias);
  const queue         = new JobQueue();

  console.log(`[v3] host=${hostAlias} actors=${[...actorMeta.keys()].join(', ')}`);

  await initCoordinator(config.turnq
    ? { url: config.turnq.url, apiKey: config.turnq.apiKey, channel: config.turnq.channel }
    : undefined);

  async function cycle(): Promise<void> {
    try {
      await pull(transportPath);
    } catch {
      console.error('[v3] git pull failed — skipping cycle');
      return;
    }

    const channels = await discoverChannels(transportPath, config.channelsDir);

    // Enqueue unread messages for each actor × channel
    for (const channelGuid of channels) {
      const channelDir = join(transportPath, config.channelsDir, channelGuid);
      const allRelPaths = await listMessages(channelDir);

      for (const [actorName, meta] of actorMeta) {
        // Initialise cursor on first encounter
        if (!await cursorExists(transportPath, actorName, channelGuid)) {
          const tip = currentTip(allRelPaths);
          if (tip) await writeCursor(transportPath, actorName, channelGuid, tip);
          continue;
        }

        const cursor  = await readCursor(transportPath, actorName, channelGuid);
        const unread  = messagesAfterCursor(allRelPaths, cursor);
        const { cli, tier } = pickCli(meta);

        for (const relPath of unread) {
          queue.enqueue({ actor: actorName, tier, cli, channelGuid, messageRelPath: relPath });
        }
      }
    }

    if (queue.pendingCount() === 0 && queue.inFlightCount() === 0) return;

    // Dispatch: for each actor, drain up to totalCount concurrent jobs
    const promises: Promise<void>[] = [];

    for (const [actorName, meta] of actorMeta) {
      const jobs = queue.drain(actorName, meta.totalCount);

      for (const job of jobs) {
        const channelDir  = join(transportPath, config.channelsDir, job.channelGuid);
        const allRelPaths = await listMessages(channelDir);

        const promise = (async () => {
          try {
            const stagedFiles = await dispatchSingle({
              transportPath,
              channelsDir: config.channelsDir,
              channelGuid: job.channelGuid,
              allRelPaths,
              messageRelPath: job.messageRelPath,
              actorName: job.actor,
              hostAlias,
              systemPrompt: meta.systemPrompt,
              cli: job.cli,
            });

            if (stagedFiles.length > 0) {
              const now   = new Date();
              const label = `${now.toISOString().slice(0, 16).replace('T', ' ')}Z`;
              const ok    = await commitAndPush({
                transportPath,
                files: stagedFiles,
                message: `crosstalk: ${job.actor} ${label}`,
                identity: meta.gitIdentity,
              });
              if (ok) {
                await writeCursor(transportPath, job.actor, job.channelGuid, job.messageRelPath);
              } else {
                console.error(`[${job.actor}] push failed — will retry next cycle`);
              }
            } else {
              // No reply staged (skipped or failed) — advance cursor anyway
              await writeCursor(transportPath, job.actor, job.channelGuid, job.messageRelPath);
            }
          } finally {
            queue.complete(job);
          }
        })();

        promises.push(promise);
      }
    }

    await Promise.all(promises);
  }

  // Main loop
  const interval = config.interval;
  console.log(`[v3] coordinator running — interval=${interval}s`);

  while (true) {
    await cycle();
    await new Promise(r => setTimeout(r, interval * 1000));
  }
}

// ── v2 Legacy polling (agents: list mode) ─────────────────────────────────

function runtimeKeyFor(agents: AgentConfig[], target: AgentConfig): string {
  const sameName = agents.filter(a => a.name === target.name);
  if (sameName.length <= 1) return target.name;
  return `${target.name}#${sameName.indexOf(target)}`;
}

const agentHandles = new Map<string, ReturnType<typeof setInterval>>();

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
  hostAlias?: string;
}): Promise<void> {
  const { config, agent, runtimeKey, channelGuid, transportPath, systemPrompt, gitIdentity, instanceIndex, groupSize } = opts;
  const channelDir = join(transportPath, config.channelsDir, channelGuid);
  const allRelPaths = await listMessages(channelDir);

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
    hostAlias: opts.hostAlias,
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
  const ok = await commitAndPush({
    transportPath,
    files: stagedFiles,
    message: `crosstalk: ${agent.name} ${label}`,
    identity: gitIdentity,
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
    await tickChannel({ config, agent, runtimeKey, channelGuid, transportPath, systemPrompt, gitIdentity, instanceIndex, groupSize, hostAlias: config.hostAlias });
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
  const systemPrompt  = await resolveSystemPrompt(transportPath, agent);
  const gitIdentity   = await resolveGitIdentity(transportPath, agent.name, agent.systemPromptFile, config.hostAlias);

  const sameName = config.agents.filter(a => a.name === agent.name);
  const instanceIndex = sameName.indexOf(agent);
  const groupSize     = sameName.length;
  const runtimeKey    = runtimeKeyFor(config.agents, agent);

  const allChannels = await discoverChannels(transportPath, config.channelsDir);
  const channels    = agent.channels?.length
    ? agent.channels.filter(g => allChannels.includes(g))
    : allChannels;

  if (channels.length === 0) {
    console.warn(`[${runtimeKey}] no channels found — waiting`);
  }

  if (!agentHandles.size) {
    await initCoordinator(config.turnq
      ? { url: config.turnq.url, apiKey: config.turnq.apiKey, channel: config.turnq.channel }
      : undefined);
  }

  const interval  = agent.interval ?? config.interval;
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

  for (const key of running) {
    if (!incomingKeys.has(key)) stopAgent(key);
  }

  const toStart = config.agents.filter(a => !agentHandles.has(runtimeKeyFor(config.agents, a)));
  await Promise.all(toStart.map(agent => startAgent(config, agent)));
}

async function watchConfig(configPath: string): Promise<void> {
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
    // watch not available or file removed — silently stop
  }
}

// ── Entry point ────────────────────────────────────────────────────────────

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
  const transportPath = resolve(config.transport);

  // v3 path: no agents list → resolve host file → run coordinator
  if (config.agents.length === 0) {
    const hostFile = findHostFile(transportPath, config.hostAlias);
    if (!hostFile) {
      const attempted = config.hostAlias ?? osHostname();
      console.error(
        `[runtime] no host file found for "${attempted}" in ${join(transportPath, 'manifest', 'hosts')}\n` +
        `[runtime] create manifest/hosts/<alias>.md with hostname: ${osHostname()}, or set host: <alias> in config.yaml\n` +
        `[runtime] idling — no agents will dispatch until a host file is found`
      );
      return;
    }
    console.log(`crosstalk runtime v${version} — transport=${config.transport} host=${hostFile.alias} [v3]`);
    await runCoordinator(config, hostFile);
    return;
  }

  // v2 legacy path: explicit agents list
  console.log(`crosstalk runtime v${version} — transport=${config.transport} agents=${config.agents.length} [v2 legacy]`);
  await applyConfig(config);
  if (configPath) watchConfig(configPath);
}

main().catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});
