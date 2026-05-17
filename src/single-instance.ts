import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

/** Path to the daemon's PID lock file. One file per OS user — `~/.crosstalk/`
 * is already per-user, so two users on the same machine each get their own
 * lock (and their own daemon). */
const PID_FILE = join(homedir(), '.crosstalk', 'daemon.pid');

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM = process exists but belongs to a different user. Treat as
    // alive — we can't kill it from here anyway.
    if (code === 'EPERM') return true;
    return false;
  }
}

/** Linux-only sanity check: is this PID actually a node process? Guards
 * against the (rare) case where the PID file is stale and the OS recycled
 * the PID to some unrelated long-running daemon. On non-Linux platforms
 * we don't have `/proc` — return true and accept the rare false positive
 * (operator can delete the PID file manually). */
function looksLikeNodeProcess(pid: number): boolean {
  if (process.platform !== 'linux') return true;
  try {
    const comm = readFileSync(`/proc/${pid}/comm`, 'utf-8').trim();
    return comm === 'node' || comm.startsWith('node');
  } catch {
    return false;
  }
}

let lockReleased = false;

function releaseLock(): void {
  if (lockReleased) return;
  lockReleased = true;
  try { unlinkSync(PID_FILE); } catch { /* already gone */ }
}

/** Refuse to start if another crosstalk daemon owned by this OS user is
 * already running. Writes our PID to ~/.crosstalk/daemon.pid and registers
 * cleanup on process exit. Call once at daemon startup, before any other
 * stateful work.
 *
 * Stale-PID detection: if the file exists but the recorded PID is not
 * alive (or, on Linux, is alive but not a node process), the file is
 * silently overwritten — covers SIGKILL'd daemons and crashes that didn't
 * run the exit handler.
 *
 * SIGKILL on us doesn't fire the exit handler either, so the next startup
 * cleans up the stale file via the same path.
 *
 * v1.0.4+ — added after the Monte Carlo π dogfood test surfaced an entire
 * bug class caused by a stale yesterday-daemon coexisting with a fresh
 * one: both dispatched the same fan-out, doubling commits and inflating
 * push contention. Single-instance per OS user is the correct invariant. */
export function acquireSingleInstanceLock(): void {
  if (existsSync(PID_FILE)) {
    let raw = '';
    try { raw = readFileSync(PID_FILE, 'utf-8').trim(); } catch { /* unreadable */ }
    const existingPid = parseInt(raw, 10);
    if (Number.isFinite(existingPid) && existingPid > 0
        && isProcessAlive(existingPid) && looksLikeNodeProcess(existingPid)) {
      console.error(`[crosstalk] ✗ daemon already running (PID ${existingPid})`);
      console.error(`[crosstalk]   Only one crosstalk daemon may run per user.`);
      console.error(`[crosstalk]   To replace it:  kill ${existingPid}  (then restart crosstalk)`);
      process.exit(1);
    }
    const why = Number.isFinite(existingPid) && existingPid > 0 && isProcessAlive(existingPid)
      ? `PID ${existingPid} is not a crosstalk daemon`
      : `PID ${raw || '?'} not running`;
    console.warn(`[crosstalk] stale PID file at ${PID_FILE} (${why}) — replacing`);
  }

  // Ensure ~/.crosstalk/ exists. Other startup code paths also create it,
  // but the lock is now the *first* thing we touch — own the directory create.
  mkdirSync(dirname(PID_FILE), { recursive: true });
  writeFileSync(PID_FILE, String(process.pid));

  // Best-effort cleanup. The existing SIGINT/SIGTERM handlers in index.ts
  // call process.exit() after their shutdown work, which fires 'exit' →
  // releaseLock. SIGKILL bypasses this; stale-PID detection covers it on
  // the next startup.
  process.on('exit', releaseLock);
}
