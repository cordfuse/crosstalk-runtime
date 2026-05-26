import { resolve, join } from 'path';
import { readFile } from 'fs/promises';
import { loadConfig, type AgentConfig, type RuntimeConfig } from './config.js';
import { readCursor, writeCursor, listMessages, messagesAfterCursor } from './cursor.js';
import { pull, commitAndPush } from './git.js';
import { dispatchTick } from './dispatch.js';

const CONFIG_PATH = process.argv.find((_, i, a) => a[i - 1] === '--config') ?? 'config.yaml';

async function loadSystemPrompt(transportPath: string, agent: AgentConfig): Promise<string | undefined> {
  if (!agent.systemPromptFile) return undefined;
  try {
    return await readFile(join(transportPath, agent.systemPromptFile), 'utf-8');
  } catch {
    console.warn(`[${agent.name}] systemPromptFile not found: ${agent.systemPromptFile}`);
    return undefined;
  }
}

async function tick(config: RuntimeConfig, agent: AgentConfig, systemPrompt: string | undefined): Promise<void> {
  const transportPath = resolve(config.transport);

  try {
    await pull(transportPath);
  } catch {
    console.error(`[${agent.name}] git pull failed — skipping tick`);
    return;
  }

  const channelDir = join(transportPath, config.channelsDir, agent.channel);
  const allRelPaths = await listMessages(channelDir);
  const cursor = await readCursor(transportPath, agent.name);
  const unread = messagesAfterCursor(allRelPaths, cursor);

  if (unread.length === 0) return;

  const { stagedFiles, lastProcessed } = await dispatchTick({
    transportPath,
    channelsDir: config.channelsDir,
    channelGuid: agent.channel,
    allRelPaths,
    unreadRelPaths: unread,
    agent,
    systemPrompt,
  });

  if (stagedFiles.length === 0) {
    // Advance cursor even when there was nothing to reply to
    const advance = lastProcessed ?? unread[unread.length - 1];
    await writeCursor(transportPath, agent.name, advance);
    return;
  }

  const now = new Date();
  const label = `${now.toISOString().slice(0, 16).replace('T', ' ')}Z`;
  const ok = await commitAndPush({
    transportPath,
    files: stagedFiles,
    message: `crosstalk: ${agent.name} ${label}`,
    identity: agent.git,
    jitterMs: config.jitter,
  });

  if (ok && lastProcessed) {
    await writeCursor(transportPath, agent.name, lastProcessed);
  } else if (!ok) {
    console.error(`[${agent.name}] push failed after retries — cursor not advanced, will retry next tick`);
  }
}

async function startAgent(config: RuntimeConfig, agent: AgentConfig): Promise<void> {
  const systemPrompt = await loadSystemPrompt(resolve(config.transport), agent);
  console.log(`[${agent.name}] starting — channel=${agent.channel} interval=${agent.interval}s`);

  const run = () => tick(config, agent, systemPrompt).catch(err => {
    console.error(`[${agent.name}] tick error:`, err);
  });

  await run(); // first tick immediately on start
  setInterval(run, agent.interval * 1000);
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
