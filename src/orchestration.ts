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

function threadFile(transportRoot: string, channel: string, threadId: string): string {
  // Sanitise for use as a filename: allow alphanum, dot, dash, underscore.
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
  transportRoot: string,
  state: ThreadState,
): Promise<void> {
  const dir = threadsDir(transportRoot, state.channel);
  await mkdir(dir, { recursive: true });
  await writeFile(
    threadFile(transportRoot, state.channel, state.threadId),
    JSON.stringify(state, null, 2),
    'utf-8',
  );
}

// ── Public API ────────────────────────────────────────────────────────────

/** Create and persist a new thread state when a spawn message is processed.
 * `expects` defaults to `children.length` if not provided (all must respond). */
export async function createThreadState(
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
  await writeThreadState(transportRoot, state);
  return state;
}

/** Record a response against an open thread. Idempotent — duplicate
 * relPaths are ignored. Returns the updated state and whether this
 * response completed the thread (`joined: true`), or null if the thread
 * doesn't exist / is already complete. */
export async function recordThreadResponse(
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

  await writeThreadState(transportRoot, state);
  return { state, joined };
}
