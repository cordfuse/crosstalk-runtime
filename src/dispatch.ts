import { join } from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { parseFrontmatter } from './frontmatter.js';
import { messageFilename, messageDatePath } from './filenames.js';
import type { AgentConfig } from './config.js';

interface ParsedMessage {
  relPath: string;
  from: string;
  to: string | string[];
  type: string;
  timestamp: string;
  body: string;
  delivery?: 'any' | 'all';
}

async function parseMessage(channelDir: string, relPath: string): Promise<ParsedMessage | null> {
  try {
    const raw = await readFile(join(channelDir, relPath), 'utf-8');
    const { data, body } = parseFrontmatter(raw);
    const deliveryRaw = String(data.delivery ?? '');
    const delivery: 'any' | 'all' | undefined =
      deliveryRaw === 'any' ? 'any' : deliveryRaw === 'all' ? 'all' : undefined;
    return {
      relPath,
      from: String(data.from ?? ''),
      to: data.to as string | string[],
      type: String(data.type ?? 'text'),
      timestamp: String(data.timestamp ?? ''),
      body: body.trim(),
      delivery,
    };
  } catch {
    return null;
  }
}

// Hash-based claim for pool delivery: any. Returns the chosen member name.
// roster MUST be the full pool roster (this operator's view), sorted ascending.
function choosePoolMember(roster: string[], msgRelPath: string): string | null {
  if (roster.length === 0) return null;
  const sorted = [...roster].sort();
  const hex = createHash('sha256').update(msgRelPath).digest('hex');
  // First 8 hex chars → 32-bit unsigned int → mod roster size.
  const idx = parseInt(hex.slice(0, 8), 16) % sorted.length;
  return sorted[idx];
}

function matchesTarget(
  target: string,
  agentName: string,
  agentPool: string | undefined,
  poolRoster: string[],
  msg: ParsedMessage,
): boolean {
  if (target === 'all') return true;
  if (target === agentName) return true;
  if (target.startsWith('pool:')) {
    const poolName = target.slice(5);
    if (!agentPool || agentPool !== poolName) return false;
    // Default delivery for pool addressing is 'any'.
    const delivery = msg.delivery ?? 'any';
    if (delivery === 'all') return true;
    // delivery: any → hash-based claim. Dispatch only if we are chosen.
    return choosePoolMember(poolRoster, msg.relPath) === agentName;
  }
  return false;
}

function isAddressedTo(
  msg: ParsedMessage,
  agentName: string,
  agentPool: string | undefined,
  poolRoster: string[],
): boolean {
  if (msg.from === agentName) return false;
  const targets = Array.isArray(msg.to) ? msg.to : [msg.to];
  for (const target of targets) {
    if (matchesTarget(target, agentName, agentPool, poolRoster, msg)) return true;
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

export async function dispatchTick(opts: {
  transportPath: string;
  channelsDir: string;    // relative to transport, e.g. "data/channels"
  channelGuid: string;
  allRelPaths: string[];  // all messages in channel, sorted asc
  unreadRelPaths: string[];
  agent: AgentConfig;
  systemPrompt?: string;  // pre-loaded system prompt text (if configured)
  agentPool?: string;     // resolved pool name (config.pool || metadata.pool)
  poolRoster?: string[];  // sorted roster of pool members (this operator's view); includes self
}): Promise<DispatchResult> {
  const { transportPath, channelsDir, channelGuid, allRelPaths, unreadRelPaths, agent, systemPrompt, agentPool, poolRoster } = opts;
  const channelDir = join(transportPath, channelsDir, channelGuid);
  const channelBase = `${channelsDir}/${channelGuid}`;
  const stagedFiles: string[] = [];
  let lastProcessed: string | null = null;
  const roster = poolRoster ?? [];

  for (const relPath of unreadRelPaths) {
    const msg = await parseMessage(channelDir, relPath);
    if (!msg) continue;
    if (msg.type !== 'text') { lastProcessed = relPath; continue; }
    if (!isAddressedTo(msg, agent.name, agentPool, roster)) { lastProcessed = relPath; continue; }

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
    let reply: string;
    try {
      reply = await spawnCli(agent.cli, stdin, spawnCwd);
    } catch (err) {
      console.error(`[${agent.name}] dispatch failed for ${relPath}:`, err);
      continue;
    }

    if (!reply) {
      console.warn(`[${agent.name}] empty reply for ${relPath} — advancing cursor without filing reply`);
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

    lastProcessed = relPath;
  }

  return { stagedFiles, lastProcessed };
}
