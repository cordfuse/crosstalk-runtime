import { resolve, join } from 'path';
import { readFile } from 'fs/promises';
import { loadConfig, type AgentConfig, type RuntimeConfig } from './config.js';
import { readCursor, writeCursor, listMessages, messagesAfterCursor, discoverChannels } from './cursor.js';
import { pull, commitAndPush } from './git.js';
import { dispatchTick } from './dispatch.js';
import { parseFrontmatter } from './frontmatter.js';

const CONFIG_PATH = process.argv.find((_, i, a) => a[i - 1] === '--config') ?? 'config.yaml';

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

// Derive git identity: explicit override → actor frontmatter alias → bare name
async function resolveGitIdentity(
  transportPath: string,
  agent: AgentConfig,
): Promise<{ name: string; email: string }> {
  if (agent.git) return agent.git;
  try {
    const actorFile = join(transportPath, 'manifest', 'custom', 'actors', `${agent.name}.md`);
    const raw = await readFile(actorFile, 'utf-8');
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
  channelGuid: string;
  transportPath: string;
  systemPrompt: string | undefined;
  gitIdentity: { name: string; email: string };
}): Promise<void> {
  const { config, agent, channelGuid, transportPath, systemPrompt, gitIdentity } = opts;
  const channelDir = join(transportPath, config.channelsDir, channelGuid);
  const allRelPaths = await listMessages(channelDir);
  const cursor = await readCursor(transportPath, agent.name, channelGuid);
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
  });

  if (stagedFiles.length === 0) {
    const advance = lastProcessed ?? unread[unread.length - 1];
    await writeCursor(transportPath, agent.name, channelGuid, advance);
    return;
  }

  const now = new Date();
  const label = `${now.toISOString().slice(0, 16).replace('T', ' ')}Z`;
  const ok = await commitAndPush({
    transportPath,
    files: stagedFiles,
    message: `crosstalk: ${agent.name} ${label}`,
    identity: gitIdentity,
    jitterMs: config.jitter,
  });

  if (ok && lastProcessed) {
    await writeCursor(transportPath, agent.name, channelGuid, lastProcessed);
  } else if (!ok) {
    console.error(`[${agent.name}] push failed after retries — will retry next tick`);
  }
}

async function tick(
  config: RuntimeConfig,
  agent: AgentConfig,
  channels: string[],
  systemPrompt: string | undefined,
  gitIdentity: { name: string; email: string },
): Promise<void> {
  const transportPath = resolve(config.transport);
  try {
    await pull(transportPath);
  } catch {
    console.error(`[${agent.name}] git pull failed — skipping tick`);
    return;
  }
  for (const channelGuid of channels) {
    await tickChannel({ config, agent, channelGuid, transportPath, systemPrompt, gitIdentity });
  }
}

async function startAgent(config: RuntimeConfig, agent: AgentConfig): Promise<void> {
  const transportPath = resolve(config.transport);
  const systemPrompt = await resolveSystemPrompt(transportPath, agent);
  const gitIdentity = await resolveGitIdentity(transportPath, agent);

  // Resolve channel list: explicit override or discover all channels in transport
  const allChannels = await discoverChannels(transportPath, config.channelsDir);
  const channels = agent.channels?.length
    ? agent.channels.filter(g => allChannels.includes(g))
    : allChannels;

  if (channels.length === 0) {
    console.warn(`[${agent.name}] no channels found in ${join(transportPath, config.channelsDir)} — waiting`);
  }

  const interval = agent.interval ?? config.interval;
  console.log(`[${agent.name}] starting — channels=${channels.length} interval=${interval}s git="${gitIdentity.name}"`);

  const run = () => tick(config, agent, channels, systemPrompt, gitIdentity).catch(err => {
    console.error(`[${agent.name}] tick error:`, err);
  });

  await run();
  setInterval(run, interval * 1000);
}

async function main(): Promise<void> {
  const config = loadConfig(CONFIG_PATH);
  console.log(`crosstalk runtime v2 — transport=${config.transport} agents=${config.agents.length}`);
  await Promise.all(config.agents.map(agent => startAgent(config, agent)));
}

main().catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});
