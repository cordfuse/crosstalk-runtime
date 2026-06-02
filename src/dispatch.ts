import { join } from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { parseFrontmatter } from './frontmatter.js';
import { messageFilename, messageDatePath } from './filenames.js';
import type { AgentConfig } from './config.js';
import { log, traceId } from './log.js';

export class DispatchError extends Error {
  constructor(message: string, public readonly cli: string) {
    super(message);
    this.name = 'DispatchError';
  }
}

interface ParsedMessage {
  relPath: string;
  from: string;
  to: string | string[];
  type: string;
  timestamp: string;
  body: string;
}

async function parseMessage(channelDir: string, relPath: string): Promise<ParsedMessage | null> {
  try {
    const raw = await readFile(join(channelDir, relPath), 'utf-8');
    const { data, body } = parseFrontmatter(raw);
    return {
      relPath,
      from: String(data.from ?? ''),
      to: data.to as string | string[],
      type: String(data.type ?? 'text'),
      timestamp: String(data.timestamp ?? ''),
      body: body.trim(),
    };
  } catch {
    return null;
  }
}

// Instance groups (see CROSSTALK.md): when multiple agents share a name,
// exactly one dispatches per message. sha256(relPath) mod group-size selects
// by position in the group's local ordering.
function chosenInstanceIndex(msgRelPath: string, groupSize: number): number {
  const hex = createHash('sha256').update(msgRelPath).digest('hex');
  return parseInt(hex.slice(0, 8), 16) % groupSize;
}

// Parse actor@host syntax. Bare names return host=undefined (matches any host).
function parseTarget(target: string): { actor: string; host?: string } {
  const at = target.lastIndexOf('@');
  if (at === -1) return { actor: target };
  return { actor: target.slice(0, at), host: target.slice(at + 1) };
}

function isAddressedTo(
  msg: ParsedMessage,
  agentName: string,
  hostAlias: string | undefined, // this runtime's host alias; undefined in legacy/flag mode
  instanceIndex: number,         // this agent's position within its same-name group (0 if name is unique)
  groupSize: number,             // count of agents sharing this name in config (1 if unique)
): boolean {
  if (msg.from === agentName) return false;
  const targets = Array.isArray(msg.to) ? msg.to : [msg.to];
  for (const target of targets) {
    if (target === 'all') {
      // broadcast — no host filter
    } else {
      const { actor, host } = parseTarget(target);
      if (actor !== agentName) continue;
      // host-targeted: skip if host doesn't match ours
      if (host && hostAlias && host !== hostAlias) continue;
    }
    if (groupSize <= 1) return true;
    return chosenInstanceIndex(msg.relPath, groupSize) === instanceIndex;
  }
  return false;
}

function renderMessage(msg: ParsedMessage): string {
  const to = Array.isArray(msg.to) ? msg.to.join(', ') : msg.to;
  return `[${msg.from} → ${to}, ${msg.timestamp}]\n${msg.body}`;
}

function renderContext(context: ParsedMessage[], target: ParsedMessage): string {
  const lines: string[] = [];
  if (context.length > 0) {
    lines.push('--- conversation context ---', '');
    lines.push(context.map(renderMessage).join('\n\n'));
    lines.push('');
  }
  lines.push('--- respond to this ---', '');
  lines.push(renderMessage(target));
  return lines.join('\n');
}

function spawnCli(cliCommand: string, stdin: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // shell: true delegates parsing to /bin/sh so quoted args (e.g.
    // --model "claude-haiku-4-5") are preserved correctly. Naive
    // whitespace split corrupted any flag value containing spaces.
    const proc = spawn(cliCommand, {
      cwd,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.stdin.write(stdin, 'utf-8');
    proc.stdin.end();
    proc.on('exit', code => {
      if (code !== 0) {
        const tail = stderr.trim() || '(no stderr)';
        reject(new Error(`cli exited ${code}: ${tail}`));
      } else {
        resolve(stdout.trim());
      }
    });
    proc.on('error', reject);
  });
}

function messageFile(agentName: string, replyTo: string, now: Date, body: string): string {
  return [
    '---',
    `from: ${agentName}`,
    `to: ${replyTo}`,
    `type: text`,
    `timestamp: ${now.toISOString()}`,
    '---',
    '',
    body,
  ].join('\n');
}

function readReceiptFile(agentName: string, replyTo: string, ref: string, now: Date): string {
  return [
    '---',
    `from: ${agentName}`,
    `to: ${replyTo}`,
    `type: read`,
    `timestamp: ${now.toISOString()}`,
    `ref: ${ref}`,
    '---',
  ].join('\n');
}

export interface DispatchResult {
  // Paths relative to transportPath, ready for `git add`
  stagedFiles: string[];
  // relPath of the last message processed (to advance cursor after push)
  lastProcessed: string | null;
}

// v3: dispatch a single known message. No outer loop, no instance selection —
// the job queue guarantees exactly-once delivery.
// Returns staged file paths on success, or empty array if message was skipped
// (wrong addressee, non-text type, etc.) or dispatch failed.
export async function dispatchSingle(opts: {
  transportPath: string;
  channelsDir: string;
  channelGuid: string;
  allRelPaths: string[];   // all messages in channel (for context window)
  messageRelPath: string;  // the specific message to process
  actorName: string;
  hostAlias?: string;
  systemPrompt?: string;
  cli: string;
  contextWindow?: number;
  spawnCwd?: string;
}): Promise<string[]> {
  const {
    transportPath, channelsDir, channelGuid, allRelPaths, messageRelPath,
    actorName, hostAlias, systemPrompt, cli,
  } = opts;
  const contextWindow = opts.contextWindow ?? 20;
  const channelDir  = join(transportPath, channelsDir, channelGuid);
  const channelBase = `${channelsDir}/${channelGuid}`;

  const msg = await parseMessage(channelDir, messageRelPath);
  if (!msg) return [];
  if (msg.type !== 'text') return [];

  // Check addressee — pass instanceIndex=0 / groupSize=1: queue handles uniqueness
  if (!isAddressedTo(msg, actorName, hostAlias, 0, 1)) return [];

  // Build context
  const idx = allRelPaths.indexOf(messageRelPath);
  const priorPaths = allRelPaths.slice(Math.max(0, idx - contextWindow), idx);
  const contextMessages: ParsedMessage[] = [];
  for (const p of priorPaths) {
    const m = await parseMessage(channelDir, p);
    if (m && m.type === 'text') contextMessages.push(m);
  }

  const context  = renderContext(contextMessages, msg);
  const identity = `Your agent name is ${actorName}.`;
  const stdin    = systemPrompt ? `${systemPrompt}\n\n${identity}\n\n${context}` : `${identity}\n\n${context}`;
  const spawnCwd = opts.spawnCwd ?? transportPath;

  const trace = traceId(messageRelPath);
  const cliName = cli.split(' ')[0];
  log.info('dispatch_start', { actor: actorName, channel: channelGuid.slice(0, 8), trace, cli: cliName, msg: messageRelPath });
  const t0 = Date.now();

  let reply: string;
  try {
    reply = await spawnCli(cli, stdin, spawnCwd);
  } catch (err) {
    const durationMs = Date.now() - t0;
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error('dispatch_failed', { actor: actorName, channel: channelGuid.slice(0, 8), trace, durationMs, error: errMsg.slice(0, 200) });
    throw new DispatchError(errMsg, cli);
  }

  if (!reply) {
    const durationMs = Date.now() - t0;
    log.warn('dispatch_skipped', { actor: actorName, channel: channelGuid.slice(0, 8), trace, durationMs, reason: 'empty_reply' });
    return [];
  }

  const stagedFiles: string[] = [];
  const replyNow       = new Date();
  const replyDatePath  = messageDatePath(replyNow);
  const replyFilename  = messageFilename(replyNow);
  const replyRelPath   = `${replyDatePath}/${replyFilename}`;
  await mkdir(join(channelDir, replyDatePath), { recursive: true });
  await writeFile(join(channelDir, replyRelPath), messageFile(actorName, msg.from, replyNow, reply), 'utf-8');
  stagedFiles.push(`${channelBase}/${replyRelPath}`);

  const receiptNow      = new Date(replyNow.getTime() + 1);
  const receiptDatePath = messageDatePath(receiptNow);
  const receiptFilename = messageFilename(receiptNow);
  const receiptRelPath  = `${receiptDatePath}/${receiptFilename}`;
  await mkdir(join(channelDir, receiptDatePath), { recursive: true });
  await writeFile(join(channelDir, receiptRelPath), readReceiptFile(actorName, msg.from, messageRelPath, receiptNow), 'utf-8');
  stagedFiles.push(`${channelBase}/${receiptRelPath}`);

  log.info('dispatch_complete', { actor: actorName, channel: channelGuid.slice(0, 8), trace, durationMs: Date.now() - t0 });
  return stagedFiles;
}

export async function dispatchTick(opts: {
  transportPath: string;
  channelsDir: string;    // relative to transport, e.g. "data/channels"
  channelGuid: string;
  allRelPaths: string[];  // all messages in channel, sorted asc
  unreadRelPaths: string[];
  agent: AgentConfig;
  hostAlias?: string;     // this runtime's host alias for actor@host filtering
  systemPrompt?: string;  // pre-loaded system prompt text (if configured)
  instanceIndex?: number; // 0-based position within same-name group; default 0
  groupSize?: number;     // count of agents sharing this name in config; default 1
}): Promise<DispatchResult> {
  const { transportPath, channelsDir, channelGuid, allRelPaths, unreadRelPaths, agent, systemPrompt } = opts;
  const hostAlias     = opts.hostAlias;
  const instanceIndex = opts.instanceIndex ?? 0;
  const groupSize     = opts.groupSize ?? 1;
  const channelDir = join(transportPath, channelsDir, channelGuid);
  const channelBase = `${channelsDir}/${channelGuid}`;
  const stagedFiles: string[] = [];
  let lastProcessed: string | null = null;

  for (const relPath of unreadRelPaths) {
    const msg = await parseMessage(channelDir, relPath);
    if (!msg) continue;
    if (msg.type !== 'text') { lastProcessed = relPath; continue; }
    if (!isAddressedTo(msg, agent.name, hostAlias, instanceIndex, groupSize)) { lastProcessed = relPath; continue; }

    // Context: up to contextWindow text messages before this one
    const idx = allRelPaths.indexOf(relPath);
    const priorPaths = allRelPaths.slice(Math.max(0, idx - (agent.contextWindow ?? 20)), idx);
    const contextMessages: ParsedMessage[] = [];
    for (const p of priorPaths) {
      const m = await parseMessage(channelDir, p);
      if (m && m.type === 'text') contextMessages.push(m);
    }

    const context = renderContext(contextMessages, msg);
    const identity = `Your agent name is ${agent.name}.`;
    const stdin = systemPrompt
      ? `${systemPrompt}\n\n${identity}\n\n${context}`
      : `${identity}\n\n${context}`;

    const spawnCwd = agent.spawnCwd ?? transportPath;
    const trace = traceId(relPath);
    const cliName = agent.cli.split(' ')[0];
    log.info('dispatch_start', { actor: agent.name, channel: channelGuid.slice(0, 8), trace, cli: cliName, msg: relPath });
    const t0 = Date.now();

    let reply: string;
    try {
      reply = await spawnCli(agent.cli, stdin, spawnCwd);
    } catch (err) {
      const durationMs = Date.now() - t0;
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error('dispatch_failed', { actor: agent.name, channel: channelGuid.slice(0, 8), trace, durationMs, error: errMsg.slice(0, 200) });
      continue;
    }

    if (!reply) {
      const durationMs = Date.now() - t0;
      log.warn('dispatch_skipped', { actor: agent.name, channel: channelGuid.slice(0, 8), trace, durationMs, reason: 'empty_reply' });
      lastProcessed = relPath;
      continue;
    }

    // Write reply
    const replyNow = new Date();
    const replyDatePath = messageDatePath(replyNow);
    const replyFilename = messageFilename(replyNow);
    const replyRelPath = `${replyDatePath}/${replyFilename}`;
    await mkdir(join(channelDir, replyDatePath), { recursive: true });
    await writeFile(join(channelDir, replyRelPath), messageFile(agent.name, msg.from, replyNow, reply), 'utf-8');
    stagedFiles.push(`${channelBase}/${replyRelPath}`);

    // Write read receipt (slight offset to ensure unique filename)
    const receiptNow = new Date(replyNow.getTime() + 1);
    const receiptDatePath = messageDatePath(receiptNow);
    const receiptFilename = messageFilename(receiptNow);
    const receiptRelPath = `${receiptDatePath}/${receiptFilename}`;
    await mkdir(join(channelDir, receiptDatePath), { recursive: true });
    await writeFile(join(channelDir, receiptRelPath), readReceiptFile(agent.name, msg.from, relPath, receiptNow), 'utf-8');
    stagedFiles.push(`${channelBase}/${receiptRelPath}`);
    log.info('dispatch_complete', { actor: agent.name, channel: channelGuid.slice(0, 8), trace, durationMs: Date.now() - t0 });
    lastProcessed = relPath;
  }

  return { stagedFiles, lastProcessed };
}
