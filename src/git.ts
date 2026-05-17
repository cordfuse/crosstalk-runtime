import { join } from 'path';
import { homedir } from 'os';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { spawn } from 'child_process';
import { messageFilename, messageDatePath } from './filenames.js';

const ACTOR_CLONES_DIR = join(homedir(), '.crosstalk', 'actor-clones');

function deriveNamespace(transportRoot: string, remoteUrl: string | null): string {
  if (remoteUrl) {
    const match = remoteUrl.match(/\/([^/]+?)(?:\.git)?$/);
    if (match) return match[1];
  }
  return transportRoot.split('/').at(-1) ?? 'default';
}

function runGit(cwd: string, args: string[], env?: Record<string, string>): Promise<number> {
  return new Promise<number>((resolve) => {
    const proc = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    proc.on('exit', code => resolve(code ?? 0));
    proc.on('error', () => resolve(127));
  });
}

function getRemoteUrl(repoPath: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const proc = spawn('git', ['remote', 'get-url', 'origin'], {
      cwd: repoPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    proc.stdout?.on('data', chunk => { stdout += chunk.toString('utf-8'); });
    proc.on('exit', code => {
      if (code !== 0) return resolve(null);
      resolve(stdout.trim() || null);
    });
    proc.on('error', () => resolve(null));
  });
}

export async function hasRemote(repoPath: string): Promise<boolean> {
  return (await getRemoteUrl(repoPath)) !== null;
}

/** Per-remote push serialization queue.
 *
 * v1.0.2+ — structural fix for the push contention bug surfaced by Monte
 * Carlo π dogfood (2026-05-16). All actor clones for a given transport
 * push to the SAME remote (e.g. `git@github.com:cordfuse/crosstalk-demo`);
 * concurrent pushes to one remote contend on git's HEAD-advance semantics.
 * v1.0.1 papered over the symptom by bumping retry count 5 → 20; this
 * queue eliminates same-daemon contention entirely by serializing pushes
 * per remote URL inside the daemon.
 *
 * Cross-daemon contention (multiple machines pushing to one remote) still
 * exists but is much rarer in practice — the retry budget still covers it.
 *
 * Map keyed by remote URL (NOT repoPath), since all actor clones share
 * one remote and that's where the contention lives. Value is the
 * tail-of-queue promise — new pushes chain onto it via .then(). */
const transportPushQueues = new Map<string, Promise<void>>();

/** Inner push-with-retry (the actual git interaction). Kept as a separate
 * function so the queued public {@link pushWithRetry} can wrap it without
 * mixing serialization concerns into the retry loop.
 *
 * v1.0.3+ — proactive pull-rebase BEFORE the first push attempt. Each
 * actor clone is independent, so when N clones queue pushes to the same
 * remote, each clone's local state is N pushes behind by the time its
 * turn comes up in the queue. Without the pre-pull, every push after the
 * first one fails with non-fast-forward → triggers the retry loop's
 * pull-rebase → retries → succeeds. With the pre-pull, the first push
 * attempt almost always succeeds and the retry loop is dead code under
 * normal operation. Retries drop from ~1.5/actor to ~0/actor. */
async function pushWithRetryRaw(repoPath: string, maxAttempts: number): Promise<boolean> {
  // Pre-pull: catch up to whatever the previous queued push just landed.
  // Quiet failure mode (network issues, etc.) — the retry loop will catch
  // those if they bite.
  await runGit(repoPath, ['pull', '--rebase']);
  for (let i = 0; i < maxAttempts; i++) {
    const code = await runGit(repoPath, ['push']);
    if (code === 0) return true;
    console.log(`[git] push rejected, rebasing (attempt ${i + 1}/${maxAttempts})`);
    await runGit(repoPath, ['pull', '--rebase']);
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 4000));
  }
  console.error('[git] push failed after max retries');
  return false;
}

/** Push with rebase-and-retry on rejection, serialized per-remote-URL.
 *
 * Standard pattern for any commit landing in a transport that may have
 * concurrent activity. Exported so non-dispatch code paths (channel-join's
 * join/leave system messages, operator-side commits) can use the same
 * serialization + retry logic instead of one-shot push + bail.
 *
 * Returns true on successful push (or no-remote no-op), false if all
 * retries exhausted. Caller branches on the result for whatever recovery
 * semantics make sense. Existing await-and-ignore callers stay correct
 * (the boolean just becomes discarded).
 *
 * v1.0.1: default maxAttempts bumped 5 → 20 after Monte Carlo π dogfood
 * test (2026-05-16) showed 11 of 20 concurrent fan-out dispatches hitting
 * "push failed after max retries" under thundering-herd contention.
 *
 * v1.0.2: structural fix — per-remote push queue. Pushes to the same
 * remote URL are now serialized daemon-side, eliminating same-daemon
 * contention. Each call waits its turn behind any pending pushes to its
 * remote, then runs the retry loop. Cross-daemon contention (multi-machine
 * pushes to one remote) still possible — retry budget covers it. */
export async function pushWithRetry(repoPath: string, maxAttempts = 20): Promise<boolean> {
  const remoteUrl = await getRemoteUrl(repoPath);
  if (!remoteUrl) return true;  // local-only repo — no remote to push to

  // Chain onto the tail of this remote's push queue. New pushes for the
  // same remote will queue behind ours. The .catch() swallow ensures one
  // failed push doesn't poison the chain for subsequent ones.
  const prev = transportPushQueues.get(remoteUrl) ?? Promise.resolve();
  let result = false;
  const next = prev
    .then(async () => { result = await pushWithRetryRaw(repoPath, maxAttempts); })
    .catch(() => { result = false; });

  transportPushQueues.set(remoteUrl, next);
  await next;

  // Tail-cleanup: if no one queued behind us, drop the map entry so the
  // map doesn't grow unbounded over the daemon's lifetime. Subsequent
  // pushes for this remote start a fresh chain from Promise.resolve().
  if (transportPushQueues.get(remoteUrl) === next) {
    transportPushQueues.delete(remoteUrl);
  }

  return result;
}

// Returns the path to an actor's own clone of the transport.
// If the transport has a remote, creates/updates a clone at ~/.crosstalk/actor-clones/<name>/.
// Falls back to the shared transport path for local-only (no remote) transports.
export async function ensureActorClone(
  transportRoot: string,
  actorName: string,
): Promise<string> {
  const remoteUrl = await getRemoteUrl(transportRoot);
  if (!remoteUrl) return transportRoot; // local-only — shared path, no isolation possible

  const namespace = deriveNamespace(transportRoot, remoteUrl);
  const clonePath = join(ACTOR_CLONES_DIR, namespace, actorName);

  try {
    await readFile(join(clonePath, '.git', 'HEAD'), 'utf-8');
    // Clone exists — sync before dispatch so actor sees the triggering message
    const code = await runGit(clonePath, ['pull', '--rebase', '--autostash']);
    if (code !== 0) console.warn(`[git] pull failed for ${actorName} — proceeding with stale clone`);
  } catch {
    // First time — clone the transport for this actor
    const namespaceDir = join(ACTOR_CLONES_DIR, namespace);
    await mkdir(namespaceDir, { recursive: true });
    console.log(`[git] initialising clone for ${namespace}/${actorName}`);
    const code = await runGit(namespaceDir, ['clone', remoteUrl, actorName]);
    if (code !== 0) {
      console.error(`[git] clone failed for ${actorName} — falling back to shared transport`);
      return transportRoot;
    }
  }

  return clonePath;
}

export async function commitActorMessage(
  repoPath: string,
  channelGuid: string,
  actorName: string,
  gitEmail: string,
): Promise<void> {
  const channelPath = join('channels', channelGuid);
  const env = {
    GIT_AUTHOR_NAME: actorName,
    GIT_AUTHOR_EMAIL: gitEmail,
    GIT_COMMITTER_NAME: actorName,
    GIT_COMMITTER_EMAIL: gitEmail,
  };

  const addCode = await runGit(repoPath, ['add', channelPath], env);
  if (addCode !== 0) {
    console.error(`[git] add failed for ${channelPath}`);
    return;
  }

  const commitCode = await runGit(
    repoPath,
    ['commit', '-m', `msg: ${actorName} → ${channelGuid.slice(0, 8)}`],
    env,
  );

  if (commitCode === 1) return; // nothing to commit

  if (commitCode !== 0) {
    console.error(`[git] commit failed (code ${commitCode})`);
    return;
  }

  await pushWithRetry(repoPath);
}

export async function writeResponseMessage(
  repoPath: string,
  channelGuid: string,
  actorName: string,
  gitEmail: string,
  body: string,
  agent?: string,
  model?: string,
  /** v0.8.1+ — override the default `to: all`. Used for encrypted responses
   * that route back to the original sender per the response-in-kind semantic. */
  toOverride?: string,
  /** v0.8.1+ — extra frontmatter fields appended after the canonical four
   * (e.g. `encryption: age`, `encrypted-to: alice, bob`). When present,
   * `body` should already be the wrapped age block string. */
  extraFrontmatter?: Record<string, string>,
): Promise<void> {
  const now = new Date();
  const datePath = messageDatePath(now);
  const filename = messageFilename(now);
  const dir = join(repoPath, 'channels', channelGuid, datePath);
  await mkdir(dir, { recursive: true });

  const toField = toOverride ?? 'all';
  const agentLine = agent ? `agent: ${agent}\n` : '';
  const modelLine = model ? `model: ${model}\n` : '';
  const extraLines = extraFrontmatter
    ? Object.entries(extraFrontmatter).map(([k, v]) => `${k}: ${v}\n`).join('')
    : '';
  const content = `---\nfrom: ${actorName}\nto: ${toField}\ntimestamp: ${now.toISOString()}\ntype: text\n${agentLine}${modelLine}${extraLines}---\n\n${body}\n`;

  await writeFile(join(dir, filename), content, 'utf8');
  await commitActorMessage(repoPath, channelGuid, actorName, gitEmail);
}

export async function commitWatcherMessage(
  transportRoot: string,
  relPath: string,
  label: string,
): Promise<void> {
  const env = {
    GIT_AUTHOR_NAME: 'watcher',
    GIT_AUTHOR_EMAIL: 'watcher@crosstalk.noreply',
    GIT_COMMITTER_NAME: 'watcher',
    GIT_COMMITTER_EMAIL: 'watcher@crosstalk.noreply',
  };

  const addCode = await runGit(transportRoot, ['add', '_system'], env);
  if (addCode !== 0) {
    console.error('[git] add failed for _system');
    return;
  }

  const commitCode = await runGit(
    transportRoot,
    ['commit', '-m', `sys: watcher/${label} → ${relPath}`],
    env,
  );

  if (commitCode === 1) return;
  if (commitCode !== 0) {
    console.error(`[git] commit failed for system message (${label})`);
    return;
  }

  await pushWithRetry(transportRoot);
}

export async function pullTransport(transportRoot: string): Promise<void> {
  const code = await runGit(transportRoot, ['pull', '--rebase']);
  if (code !== 0) console.error('[git] pull failed after webhook trigger');
}

// Derives the canonical machine actor email from name + transport suffix.
// Humans set git-email explicitly in their actor profile — this is for machines only.
export function machineGitEmail(actorName: string, suffix: string): string {
  return `${actorName}@${suffix}`;
}
