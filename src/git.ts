/**
 * v1.1.0 — legacy facade. The full git implementation moved to
 * `src/transports/git.ts` as the `GitTransport` class behind the
 * {@link import('./transport.js').Transport} interface.
 *
 * This file remains only to re-export `pushWithRetry` for the one CLI
 * consumer (`src/cli/commands/channel-join.ts`) that still posts directly
 * to git without going through the transport abstraction. Slated for
 * removal in v1.2.0 once the CLI subcommands also migrate.
 *
 * No other code should import from this file. Daemon-core consumers
 * (bootstrap, dispatch, watcher, system, relay, registry, index) all use
 * `Transport` instead.
 */
import { pushWithRetryQueued, type PushResult } from './transports/git.js'

export type { PushResult } from './transports/git.js'

/** @deprecated v1.1.0+ — use `Transport.postMessage()` instead. Kept as a
 * compatibility shim for `crosstalk channel join` which still commits
 * directly. Will be removed in v1.2.0 when CLI subcommands migrate to
 * the Transport interface. v1.13+ returns the tri-state `PushResult`
 * ('pushed' | 'no-remote' | 'failed') so callers can avoid printing
 * `✓ Pushed` on a transport with no `origin`. */
export async function pushWithRetry(repoPath: string, maxAttempts = 20): Promise<PushResult> {
  return pushWithRetryQueued(repoPath, maxAttempts)
}
