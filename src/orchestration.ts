/**
 * Orchestration — thread state for v1.18+ spawn/synthesizer flow.
 *
 * Thread state is persisted in `channels/<guid>/_threads/<thread-id>.json`
 * inside the transport directory. JSON (not TOML) because it's internal
 * daemon state, not operator-facing config.
 *
 * Files in `_threads/` are intentionally invisible to the message pipeline:
 *  - `walkChannelMessages` only descends into `YYYY/` dirs (4-digit names)
 *  - `watchMessages` ignores non-`.md` files
 *  - `listMessages` in cursor.ts does the same walk, so cursors are unaffected
 *
 * Multi-daemon dedup for thread writes is deferred to alpha.4 (GitTransport
 * first-commit-wins). For alpha.2, single-daemon operation is assumed.
 */
import { join } from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { parseFrontmatter } from './frontmatter.js';
import type { Transport } from './transport.js';

// ── Types ─────────────────────────────────────────────────────────────────

export interface ThreadState {
  threadId: string;
  channel: string;
  spawnRelPath: string;
  synthesizer?: string;
  expects: number;
  children: string[];
  responses: string[];
  respondents: string[];
  state: 'pending' | 'complete';
  createdAt: string;
  completedAt?: string;
}

// ── Path helpers ──────────────────────────────────────────────────────────

function threadsDir(transportRoot: string, channel: string): string {
  return join(transportRoot, 'channels', channel, '_threads');
}

/** Path relative to the transport root — used as the git relPath for
 * `transport.commitFile`. Must match the absolute path produced by
 * `threadFile` when prefixed with `transportRoot`. */
export function threadFileRelPath(channel: string, threadId: string): string {
  const safeId = threadId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `channels/${channel}/_threads/${safeId}.json`;
}

function threadFile(transportRoot: string, channel: string, threadId: string): string {
  const safeId = threadId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(threadsDir(transportRoot, channel), `${safeId}.json`);
}

// ── Read / write ──────────────────────────────────────────────────────────

export async function readThreadState(
  transportRoot: string,
  channel: string,
  threadId: string,
): Promise<ThreadState | null> {
  try {
    const raw = await readFile(threadFile(transportRoot, channel, threadId), 'utf-8');
    return JSON.parse(raw) as ThreadState;
  } catch {
    return null;
  }
}

async function writeThreadState(
  transport: Transport,
  transportRoot: string,
  state: ThreadState,
  commitMessage: string,
): Promise<void> {
  const dir = threadsDir(transportRoot, state.channel);
  await mkdir(dir, { recursive: true });
  await writeFile(
    threadFile(transportRoot, state.channel, state.threadId),
    JSON.stringify(state, null, 2),
    'utf-8',
  );
  const relPath = threadFileRelPath(state.channel, state.threadId);
  await transport.commitFile(relPath, commitMessage);
}

// ── Public API ────────────────────────────────────────────────────────────

/** Create and persist a new thread state when a spawn message is processed.
 * `expects` defaults to `children.length` if not provided (all must respond). */
export async function createThreadState(
  transport: Transport,
  transportRoot: string,
  channel: string,
  threadId: string,
  spawnRelPath: string,
  expects: number,
  children: string[],
  synthesizer?: string,
): Promise<ThreadState> {
  const state: ThreadState = {
    threadId,
    channel,
    spawnRelPath,
    ...(synthesizer ? { synthesizer } : {}),
    expects,
    children,
    responses: [],
    respondents: [],
    state: 'pending',
    createdAt: new Date().toISOString(),
  };
  await writeThreadState(transport, transportRoot, state, `thread: create ${threadId}`);
  return state;
}

/** Record a response against an open thread. Idempotent — duplicate
 * relPaths are ignored. Returns the updated state and whether this
 * response completed the thread (`joined: true`), or null if the thread
 * doesn't exist / is already complete. */
export async function recordThreadResponse(
  transport: Transport,
  transportRoot: string,
  channel: string,
  threadId: string,
  responseRelPath: string,
  respondent: string,
): Promise<{ state: ThreadState; joined: boolean } | null> {
  const state = await readThreadState(transportRoot, channel, threadId);
  if (!state || state.state === 'complete') return null;

  if (state.responses.includes(responseRelPath)) {
    return { state, joined: false };
  }

  state.responses.push(responseRelPath);
  if (!state.respondents.includes(respondent)) {
    state.respondents.push(respondent);
  }

  const joined = state.responses.length >= state.expects;
  if (joined) {
    state.state = 'complete';
    state.completedAt = new Date().toISOString();
  }

  const msg = joined
    ? `thread: join ${threadId} (${state.responses.length}/${state.expects})`
    : `thread: response ${state.responses.length}/${state.expects} on ${threadId}`;
  await writeThreadState(transport, transportRoot, state, msg);
  return { state, joined };
}

// ── Synthesis ─────────────────────────────────────────────────────────────

/** Build the full content (frontmatter + body) of a synthesis-request
 * message. Reads the original spawn and all recorded response messages from
 * the transport, strips their frontmatter, and assembles a context document
 * that a synthesizer actor can act on directly.
 *
 * The returned string is ready to pass to `transport.postMessage`. The
 * synthesizer is identified by `state.synthesizer`; callers must ensure
 * the field is set before calling.
 *
 * Cross-operator note: if the synthesizer lives on a different daemon, the
 * message will be posted and picked up by that daemon's watcher via the
 * normal sync path — no special dispatch needed here. */
export async function buildSynthesisRequest(
  transport: Transport,
  channel: string,
  state: ThreadState,
): Promise<string> {
  // Read spawn message body
  let spawnBody = '';
  try {
    const raw = await transport.readMessage({ channel, relPath: state.spawnRelPath });
    spawnBody = parseFrontmatter(raw).body.trim();
  } catch {
    spawnBody = '[spawn message could not be read]';
  }

  // Read each response body
  const responseSections: string[] = [];
  for (let i = 0; i < state.responses.length; i++) {
    const relPath  = state.responses[i]!;
    const respondent = state.respondents[i] ?? 'unknown';
    let respBody = '';
    try {
      const raw = await transport.readMessage({ channel, relPath });
      respBody = parseFrontmatter(raw).body.trim();
    } catch {
      respBody = '[response could not be read]';
    }
    responseSections.push(`### Response ${i + 1} — from: ${respondent}\n\n${respBody}`);
  }

  const bodyLines = [
    `# Synthesis Request — thread: ${state.threadId}`,
    '',
    '## Original Task',
    '',
    spawnBody,
    '',
    '---',
    '',
    `## Responses (${state.responses.length} of ${state.expects})`,
    '',
    responseSections.join('\n\n---\n\n'),
  ];

  const fm = [
    '---',
    `to: ${state.synthesizer}`,
    `type: synthesis-request`,
    `thread-id: ${state.threadId}`,
    `in-reply-to: ${state.spawnRelPath}`,
    '---',
  ].join('\n');

  return `${fm}\n${bodyLines.join('\n')}\n`;
}
