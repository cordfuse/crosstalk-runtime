import {
  existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, realpathSync,
} from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';

const LOCK_DIR = join(homedir(), '.crosstalk', 'locks');

/** Derive a stable lock-file path from the transport. Each (user, transport)
 * pair gets its own lock so a single user can run several daemons across
 * different transports — but two daemons on the SAME transport are refused.
 *
 * The hash is over the realpath (symlinks resolved) so two configs pointing
 * at the same underlying transport via different symlinks still collide
 * correctly. Hash is truncated to 16 hex chars (64 bits) — plenty of
 * collision-resistance for a per-user lock directory. */
function lockPathForTransport(transportPath: string): string {
  let resolved: string;
  try { resolved = realpathSync(transportPath); } catch { resolved = transportPath; }
  const hash = createHash('sha256').update(resolved).digest('hex').slice(0, 16);
  return join(LOCK_DIR, `${hash}.pid`);
}

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
 * (operator can delete the lock file manually). */
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
let acquiredPath: string | null = null;

function releaseLock(): void {
  if (lockReleased || !acquiredPath) return;
  lockReleased = true;
  try { unlinkSync(acquiredPath); } catch { /* already gone */ }
}

/** Migration handler for the v1.0.4 per-user lock file (`~/.crosstalk/daemon.pid`),
 * superseded by per-transport locks in v1.0.5.
 *
 * If the legacy PID file points to a live node process, that's a v1.0.4
 * daemon still running — refuse to start until the operator kills it.
 * The new per-transport scheme can't safely coexist with a v1.0.4 daemon
 * (which thinks it has exclusive lock-file ownership). If the file is
 * stale (process dead, or not a node process), silently remove it. */
function cleanupLegacyLock(): void {
  const legacyPath = join(homedir(), '.crosstalk', 'daemon.pid');
  if (!existsSync(legacyPath)) return;

  let pid = 0;
  try { pid = parseInt(readFileSync(legacyPath, 'utf-8').trim(), 10); } catch { /* unreadable */ }

  if (Number.isFinite(pid) && pid > 0 && isProcessAlive(pid) && looksLikeNodeProcess(pid)) {
    console.error(`[crosstalk] ✗ a v1.0.4 daemon is still running (PID ${pid})`);
    console.error(`[crosstalk]   v1.0.5 changed the lock scheme to per-transport. Kill the old daemon first:`);
    console.error(`[crosstalk]     kill ${pid}  (then restart crosstalk)`);
    process.exit(1);
  }

  try { unlinkSync(legacyPath); } catch { /* fine */ }
}

/** Refuse to start if another crosstalk daemon owned by this OS user is
 * already watching this transport. Writes our PID to
 * `~/.crosstalk/locks/<hash-of-transport>.pid` and registers cleanup on
 * process exit. Call once at daemon startup, after `loadConfig()` resolves
 * the transport path but before any other stateful work.
 *
 * Stale-PID detection: if the file exists but the recorded PID is not
 * alive (or, on Linux, is alive but not a node process), the file is
 * silently overwritten — covers SIGKILL'd daemons and crashes that didn't
 * run the exit handler.
 *
 * SIGKILL on us doesn't fire the exit handler either, so the next startup
 * cleans up the stale file via the same path.
 *
 * v1.0.4 — initial implementation, per-user lock. Surfaced an over-broad
 * invariant: blocked the legitimate multi-transport-per-user case.
 * v1.0.5 — per-(user, transport) lock. Different transports = different
 * lock files = multiple daemons coexist. Same transport = still refused. */
export function acquireSingleInstanceLock(transportPath: string): void {
  cleanupLegacyLock();

  const PID_FILE = lockPathForTransport(transportPath);

  if (existsSync(PID_FILE)) {
    let raw = '';
    try { raw = readFileSync(PID_FILE, 'utf-8').trim(); } catch { /* unreadable */ }
    const existingPid = parseInt(raw, 10);
    if (Number.isFinite(existingPid) && existingPid > 0
        && isProcessAlive(existingPid) && looksLikeNodeProcess(existingPid)) {
      console.error(`[crosstalk] ✗ daemon already running for this transport (PID ${existingPid})`);
      console.error(`[crosstalk]   transport: ${transportPath}`);
      console.error(`[crosstalk]   One daemon per transport per user. To replace it:`);
      console.error(`[crosstalk]     kill ${existingPid}  (then restart crosstalk)`);
      process.exit(1);
    }
    const why = Number.isFinite(existingPid) && existingPid > 0 && isProcessAlive(existingPid)
      ? `PID ${existingPid} is not a crosstalk daemon`
      : `PID ${raw || '?'} not running`;
    console.warn(`[crosstalk] stale lock file at ${PID_FILE} (${why}) — replacing`);
  }

  // Ensure ~/.crosstalk/locks/ exists. Recursive — handles both the
  // .crosstalk dir and the locks subdir in one call.
  mkdirSync(dirname(PID_FILE), { recursive: true });
  writeFileSync(PID_FILE, String(process.pid));
  acquiredPath = PID_FILE;

  // Best-effort cleanup. Existing SIGINT/SIGTERM handlers in index.ts
  // call process.exit() after their shutdown work, which fires 'exit' →
  // releaseLock. SIGKILL bypasses this; stale-PID detection covers it on
  // the next startup.
  process.on('exit', releaseLock);
}
