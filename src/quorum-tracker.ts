/**
 * Broadcast-with-quorum runtime tracker — v1.7.0-alpha.1+.
 *
 * v1.5.0-alpha.2 locked the address-grammar shape for the
 * `broadcast-with-quorum` dispatch policy: sender posts with
 * `dispatch: broadcast-with-quorum, quorum: K`, message fanouts to
 * every pool instance, K-of-N response threshold is what matters.
 * That alpha just made the policy recognized — the K-of-N tracker that
 * actually emits a `pool-quorum-reached` event when the threshold's
 * met was the deferred runtime work. This module IS that work.
 *
 * Lifecycle of a quorum request:
 *   1. Sender posts message with `dispatch: broadcast-with-quorum, quorum: K`
 *      addressed to a pool (`to: alice@steve`).
 *   2. Watcher resolves the pool to N instances, dispatches all N.
 *   3. Watcher calls `register(channel, originRelPath, K, N)` here.
 *   4. As pool member responses arrive carrying
 *      `in-reply-to: <originRelPath>`, watcher calls `recordResponse`.
 *   5. On K-th DISTINCT responder: emit `pool-quorum-reached` system
 *      message, mark state as `reached`, stop tracking responses.
 *   6. On N-th responder (all instances replied): close state silently.
 *      (Reaching N without K means K > N — operator misconfig — but
 *      we'd have caught that at register time.)
 *
 * Storage: in-memory Map keyed by `${channel}/${originRelPath}`.
 * Daemon restart loses in-flight quorums. Acceptable for v1.7 since
 * pool-quorum-reached is a runtime event — pool responses themselves
 * remain durable in the transport. A rebuild-from-history mode is
 * possible later (walk channels at startup, restore tracker entries
 * from messages with `dispatch: broadcast-with-quorum`).
 *
 * Out of scope for alpha.1:
 *   - Timeout handling. If K is never reached AND not all N reply,
 *     the entry leaks until daemon restart. Real-world workloads
 *     terminate quickly enough that this is rarely an issue; v1.7
 *     follow-up could add a configurable per-entry TTL + GC sweep.
 *   - Quorum-failed emit. When all N respond without K, we close
 *     silently rather than emit a "failed" event. Operator can detect
 *     by absence of pool-quorum-reached if they care.
 *   - Persistence across restarts.
 */
import type { Transport, ActorIdentity } from './transport.js'
import { SYSTEM_CHANNEL } from './transport.js'
import { messageDatePath, messageFilename } from './filenames.js'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'

/** Per-quorum-request state held in memory. `responders` is a Set of
 * canonical actor addresses (e.g. `alice-1@steve`) — dedup by address
 * so a single instance posting two responses still counts as one. */
interface QuorumState {
  channel: string
  originRelPath: string
  poolAddress: string         // `alice@steve` etc. — surfaced in pool-quorum-reached
  k: number                   // threshold
  n: number                   // pool size at dispatch time
  responders: Set<string>     // canonical addresses that have replied
  reached: boolean            // true once we've emitted pool-quorum-reached
  registeredAt: number        // Date.now() at register time — for any later TTL/GC
}

function key(channel: string, originRelPath: string): string {
  return `${channel}/${originRelPath}`
}

/** The tracker is a class so callers can keep one instance per daemon
 * (or one per test) — module-level singleton would mix state between
 * unit tests and prevent isolation. The watcher constructs this once
 * at startup and passes it into processInbound. */
export class QuorumTracker {
  private states = new Map<string, QuorumState>()

  /** Register a new quorum request. Called from the watcher right after
   * resolveTargets returns N pool instances and dispatch fires.
   *
   * Validation:
   *   - K must be ≥ 1
   *   - K > N is a misconfig; we still register so responses still
   *     correlate, but emit fires only at K (which never happens) —
   *     so really the entry just leaks. Caller (watcher) should
   *     surface a warning in this case.
   *
   * Idempotent on (channel, originRelPath) — re-register is a no-op
   * if state already exists, so cursor re-fires / replay don't
   * double-register. */
  register(channel: string, originRelPath: string, poolAddress: string, k: number, n: number): void {
    const id = key(channel, originRelPath)
    if (this.states.has(id)) return
    this.states.set(id, {
      channel,
      originRelPath,
      poolAddress,
      k,
      n,
      responders: new Set(),
      reached: false,
      registeredAt: Date.now(),
    })
  }

  /** Record a pool-member response. Returns information about what
   * happened so the caller can decide whether to emit
   * pool-quorum-reached.
   *
   * Returns:
   *   - `{ action: 'no-state' }` — no quorum was registered for this
   *     (channel, originRelPath). Most messages with in-reply-to that
   *     aren't quorum responses will land here; that's normal.
   *   - `{ action: 'recorded' }` — counted the response, threshold
   *     not yet reached. No event to emit.
   *   - `{ action: 'reached', state }` — this response was the K-th
   *     distinct one. Caller should emit pool-quorum-reached using
   *     the returned state, then call `close()` so subsequent
   *     responses don't re-emit.
   *   - `{ action: 'already-reached' }` — quorum was already reached
   *     by an earlier response; this one is past-threshold. No emit.
   *   - `{ action: 'all-responded' }` — all N pool members have now
   *     responded without K being reached (means K > N, operator
   *     misconfig). Caller should close the state silently. */
  recordResponse(channel: string, originRelPath: string, responderAddress: string):
    | { action: 'no-state' }
    | { action: 'recorded' }
    | { action: 'reached'; state: QuorumState }
    | { action: 'already-reached' }
    | { action: 'all-responded' }
  {
    const id = key(channel, originRelPath)
    const state = this.states.get(id)
    if (!state) return { action: 'no-state' }
    if (state.reached) return { action: 'already-reached' }

    // Dedup: same responder posting twice doesn't count twice
    const wasNew = !state.responders.has(responderAddress)
    state.responders.add(responderAddress)

    if (state.responders.size >= state.k && wasNew) {
      // Hit the threshold on this response — caller emits + closes
      state.reached = true
      return { action: 'reached', state }
    }
    if (state.responders.size >= state.n) {
      // All N reported but K never reached (K > N misconfig).
      return { action: 'all-responded' }
    }
    return { action: 'recorded' }
  }

  /** Remove a quorum entry from tracking. Called after a `reached` or
   * `all-responded` outcome so the Map doesn't accumulate. */
  close(channel: string, originRelPath: string): void {
    this.states.delete(key(channel, originRelPath))
  }

  /** Test helper — current entry count. */
  size(): number {
    return this.states.size
  }
}

/** Build the body of a `pool-quorum-reached` system message. Watcher
 * calls this when `recordResponse` returns `action: 'reached'` and
 * passes the body to `transport.postMessage` under SYSTEM_CHANNEL. */
export function buildQuorumReachedMessage(state: QuorumState, watcherIdentity: string): string {
  const now = new Date().toISOString()
  const responders = [...state.responders].sort().join(', ')
  return [
    `---`,
    `from: ${watcherIdentity}`,
    `to: all`,
    `timestamp: ${now}`,
    `type: pool-quorum-reached`,
    `in-reply-to: ${state.originRelPath}`,
    `channel: ${state.channel}`,
    `pool-address: ${state.poolAddress}`,
    `quorum-required: ${state.k}`,
    `responses-received: ${state.responders.size}`,
    `pool-size: ${state.n}`,
    `responders: ${responders}`,
    `---`,
    ``,
    `Pool quorum reached: ${state.responders.size}/${state.k} responses to ${state.poolAddress} in channel ${state.channel.slice(0, 8)}.`,
    ``,
  ].join('\n')
}

/** Helper used by the watcher to actually emit the system message. Kept
 * here (rather than inline in watcher) so the file write is testable in
 * isolation. The transport is passed in by caller so this module stays
 * free of transport-construction concerns. */
export async function emitPoolQuorumReached(
  transport: Transport,
  transportRoot: string,
  state: QuorumState,
  watcherIdentity: ActorIdentity,
): Promise<void> {
  const body = buildQuorumReachedMessage(state, watcherIdentity.name)
  try {
    await transport.postMessage(SYSTEM_CHANNEL, watcherIdentity, body)
  } catch (err) {
    // Fall back to direct filesystem write so the event still lands
    // even if the transport's commit-and-push path is contended.
    // Same defensive pattern as announceTimeout in system.ts.
    console.warn(`[quorum] postMessage failed, falling back to direct write: ${err}`)
    const now = new Date()
    const datePath = messageDatePath(now)
    const filename = messageFilename(now)
    const dir = join(transportRoot, SYSTEM_CHANNEL, datePath)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, filename), body, 'utf-8')
  }
}
