/**
 * Pool dispatch policies — v1.5.0-alpha.1+.
 *
 * Today (v1.4 and earlier) every pool address fans out to all instances.
 * That's the right default for jury patterns (one fanout = all jurists
 * respond, ready for cross-check). It's the wrong default for routine
 * work distribution (one fanout to a 20-instance dart-thrower pool =
 * 20 simultaneous Monte Carlo invocations chewing 20× the API tokens
 * for a job that only needs ONE worker).
 *
 * This module adds **sender-side** dispatch policy. The sender's message
 * frontmatter declares `dispatch: <policy>`; the watcher applies it
 * AFTER resolveTargets() expands the pool. Default stays fanout, so
 * v1.4 transports work unchanged.
 *
 * Why sender-side (not pool-side):
 *   - Same pool can serve different patterns from different senders
 *     (jury at one channel, work-queue at another).
 *   - No new manifest file format needed (would otherwise require a
 *     pool-config file alongside instance profiles, since pools today
 *     are implicit from filename grouping).
 *   - Pool authors don't have to predict every workflow.
 *
 * Limitation (alpha.1): policy applies to the FULL resolved target set.
 * If the message has CSV `to:` (`alice@steve, bob@steve`) AND a policy
 * other than fanout, the policy applies across the union, not per-pool.
 * Operators wanting per-pool policies should post separate messages.
 * Per-pool policy on CSV `to:` is later work.
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { ActorConfig } from './registry.js'

/** Recognized dispatch policies. `fanout` is the default and matches
 * v1.4 behavior — every instance receives the message. Other policies
 * subset/aggregate the target list before dispatch fires.
 *
 * v1.5.0-alpha.2+ adds `random` and `broadcast-with-quorum`. The
 * `broadcast-with-quorum` policy is fanout-like at the dispatch
 * layer (every instance gets the message); the K-of-N quorum-tracker
 * that emits `pool-quorum-reached` events lands in v1.6 — alpha.2
 * just locks the address-grammar shape so operators can start
 * writing quorum-aware actors today (the `quorum:` frontmatter
 * field is preserved end-to-end). */
export type DispatchPolicy =
  | 'fanout'                  // default: every pool instance gets the message (v1.4 behavior)
  | 'round-robin'             // pick one instance per message, rotating across the pool
  | 'random'                  // pick one instance per message at random (no state, mild load-balancing)
  | 'broadcast-with-quorum'   // fanout dispatch; runtime quorum tracker is v1.6 follow-up

/** Parse a `dispatch` frontmatter string. Returns the policy on a valid
 * known value, or `null` when the string is unrecognized. Caller decides
 * the fallback (typically default to 'fanout' with a warning). Unknown
 * vs absent are intentionally different — absent is the silent default,
 * unknown is an operator typo worth surfacing. */
export function parseDispatchPolicy(raw: string | undefined): DispatchPolicy | null {
  if (!raw) return 'fanout'
  const v = raw.trim().toLowerCase()
  if (v === 'fanout' || v === 'round-robin' || v === 'random' || v === 'broadcast-with-quorum') return v
  return null
}

/** Where round-robin (and future stateful policies) persist per-channel
 * per-pool rotation cursors. Lives under the daemon's session dir so
 * cursors survive restarts (operator expectation: rotation continues
 * from where it left off, no double-pick on bounce).
 *
 * `stateRoot` defaults to `~/.crosstalk/` but accepts an override for
 * test isolation. The override is critical because `os.homedir()`
 * snapshots at process start and IGNORES runtime `HOME` env changes
 * — without an explicit override, tests that point HOME at a tmpdir
 * still end up writing to the user's real `~/.crosstalk/sessions/`. */
function cursorDir(sessionId: string, stateRoot?: string): string {
  return join(stateRoot ?? join(homedir(), '.crosstalk'), 'sessions', sessionId, 'pool-cursors')
}

/** Filesystem-safe encoding for an address. `@` is POSIX-safe; we
 * encode anyway for forward-compat with tagged-form addresses that
 * might contain `/`. */
function encodeAddr(addr: string): string {
  return addr.replace(/\//g, '_SLASH_')
}

/** Read the cursor for (channel, pool address). Returns 0 on a fresh
 * pool — first-pick is the lowest-instance actor. Tolerant to missing
 * dir / file / unparseable contents (treat as 0). */
async function readCursor(sessionId: string, channelGuid: string, addr: string, stateRoot?: string): Promise<number> {
  const path = join(cursorDir(sessionId, stateRoot), channelGuid, encodeAddr(addr))
  try {
    const raw = await readFile(path, 'utf-8')
    const n = parseInt(raw.trim(), 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

/** Write the cursor for (channel, pool address). Creates the parent
 * dir as needed. Best-effort: a write failure logs and falls through
 * (next message just re-picks the same instance, which is harmless). */
async function writeCursor(sessionId: string, channelGuid: string, addr: string, value: number, stateRoot?: string): Promise<void> {
  const dir = join(cursorDir(sessionId, stateRoot), channelGuid)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, encodeAddr(addr)), String(value), 'utf-8')
  } catch (err) {
    console.warn(`[dispatch-policy] cursor write failed for ${channelGuid}/${addr}: ${err}`)
  }
}

/** Apply a dispatch policy to a resolved target list. Returns the
 * effective subset that should actually receive the message.
 *
 * For `fanout` (default): pass-through — returns targets unchanged.
 * For `round-robin`: rotates one pick across the pool per (channel,
 *   address) pair. Cursor is incremented on each successful application.
 *
 * Single-target case is a no-op for every policy (you can't rotate a
 * pool of one). Empty targets is a no-op for every policy. */
export async function applyDispatchPolicy(
  targets: ActorConfig[],
  policy: DispatchPolicy,
  sessionId: string,
  channelGuid: string,
  poolAddress: string,
  /** Override for the daemon's state root (defaults to `~/.crosstalk/`).
   * Primarily for testing — production code should pass undefined. */
  stateRoot?: string,
): Promise<ActorConfig[]> {
  if (targets.length <= 1) return targets
  if (policy === 'fanout') return targets

  if (policy === 'round-robin') {
    const cursor = await readCursor(sessionId, channelGuid, poolAddress, stateRoot)
    const idx = cursor % targets.length
    // Targets are sorted by instance index in registry.getPoolInstances
    // (singletons first, then 1..N), so picking by `idx` gives a stable
    // rotation. Cursor advances by 1 regardless of pool size so the
    // modulo handles pool growth/shrinkage naturally.
    await writeCursor(sessionId, channelGuid, poolAddress, cursor + 1, stateRoot)
    return [targets[idx]]
  }

  if (policy === 'random') {
    // No state: just pick one at random. Useful when rotation determinism
    // isn't needed (e.g. operator wants mild load-balancing without the
    // per-channel cursor overhead). Uniform distribution over targets.
    const idx = Math.floor(Math.random() * targets.length)
    return [targets[idx]]
  }

  if (policy === 'broadcast-with-quorum') {
    // v1.5.0-alpha.2+ — fanout at the dispatch layer. The K-of-N quorum
    // tracker that watches for responses and emits a
    // `pool-quorum-reached` system message lands in v1.6 (gated on a
    // design pass for in-reply-to correlation + cursor persistence
    // semantics). For alpha.2, the policy is recognized as a valid
    // value so operators can pin the frontmatter shape today; the
    // `quorum: K` field travels alongside the message untouched and
    // a downstream actor (or v1.6 runtime) can act on it.
    return targets
  }

  // Should be unreachable given parseDispatchPolicy gates known values,
  // but stays safe for any future policy added without an applier branch.
  console.warn(`[dispatch-policy] unknown policy "${policy}" — falling back to fanout`)
  return targets
}
