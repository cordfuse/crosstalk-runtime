import { join } from 'path';
import { parseFrontmatter } from './frontmatter.js';
import { dispatch, isDuplicate } from './dispatch.js';
import { readCursor, listMessages, messagesAfterCursor } from './cursor.js';
import type { Transport, MessageEvent } from './transport.js';
import type { Registry } from './registry.js';
import {
  ALWAYS_PASS_TYPES, CACHE_INVALIDATING_TYPES, type BootstrapStateCache,
} from './bootstrap.js';
import { readFile } from 'fs/promises';

/**
 * Subscribes to transport events and dispatches messages to actors per
 * the protocol (registry-based routing, anti-self-loop, bootstrap gating).
 *
 * v1.1.0+ — was previously a thin wrapper around `fs.watch` plus the
 * routing logic. Now consumes `Transport.watchMessages` so the same
 * routing works against any transport in the file-tree family. The
 * filesystem-walk parts of replay are still local-FS reads because all
 * file-tree transports share that layout. */
export function startWatcher(
  transport: Transport,
  transportRoot: string,
  getRegistry: () => Registry,
  actorEmailSuffix: string,
  sessionId: string,
  defaultHeartbeatInterval: number | undefined,
  bootstrapCache: BootstrapStateCache,
  /** When true, deferred channels gate ALL non-always-pass message types
   * (work + roe-*). When false, only roe-* messages defer (work continues
   * unaffected). False = the safe default for transports without governance. */
  _deferOnNoCoordinator: boolean,
): void {
  console.log(`[watcher] subscribing to transport events`);

  transport.watchMessages(async (event: MessageEvent) => {
    const { channel: guid, relPath, content } = event;

    const dedupKey = `${guid}/${relPath}`;
    if (isDuplicate(dedupKey)) return;

    // Skip messages at or before the cursor — re-fires can happen when a
    // git pull rebase rewrites working-tree files, or just from inotify
    // event coalescing.
    const cursor = await readCursor(sessionId, guid);
    if (cursor && relPath <= cursor) return;

    const { data } = parseFrontmatter(content);
    const from = String(data.from ?? '');
    const to = String(data.to ?? '');
    const type = String(data.type ?? 'text');

    const registry = getRegistry();

    if (registry.has(from)) {
      console.log(`[watcher] skip (own) ${relPath}`);
      return;
    }

    // Bootstrap gate: defer non-always-pass types if the channel is in
    // 'deferred' state. ALWAYS_PASS_TYPES (system, session-open,
    // session-open-deferred, bootstrap-conflict) and any roe-* messages
    // bypass this only via the explicit allow-list — letting roe-* through
    // would re-introduce the contradicting-`roe-vote-result` race that
    // BOOTSTRAP exists to prevent.
    //
    // Cache invalidation + deferred-replay: when a triggering type lands
    // (session-open, bootstrap-conflict), invalidate so the next get()
    // recomputes from fresh history. If the new state is 'open' and there
    // are messages on disk past the cursor, fire-and-forget a replay scan
    // — fs.watch won't re-fire for files that already existed when they
    // first deferred, so without this the deferred messages would sit
    // until next daemon restart.
    if (CACHE_INVALIDATING_TYPES.has(type)) {
      const wasDeferred = bootstrapCache.get(guid) === 'deferred';
      bootstrapCache.invalidate(guid);
      const newState = bootstrapCache.get(guid);
      if (wasDeferred && newState === 'open') {
        replayDeferredMessages(transport, transportRoot, guid, getRegistry, actorEmailSuffix, sessionId, defaultHeartbeatInterval, bootstrapCache).catch(err => {
          console.error(`[watcher] replay failed for ${guid.slice(0, 8)}: ${err}`);
        });
      }
    }

    if (!ALWAYS_PASS_TYPES.has(type)) {
      const state = bootstrapCache.get(guid);
      if (state === 'deferred') {
        console.log(`[watcher] defer (bootstrap pending) ${guid.slice(0, 8)}/${relPath} (type=${type})`);
        return;
      }
      if (state === 'conflict' && type.startsWith('roe-')) {
        console.log(`[watcher] defer (bootstrap-conflict, governance only) ${guid.slice(0, 8)}/${relPath} (type=${type})`);
        return;
      }
    }

    const targets = to === 'all'
      ? [...registry.values()]
      : to.split(',')
          .map(t => t.trim())
          .filter(t => registry.has(t))
          .map(t => registry.get(t)!);

    if (targets.length === 0) return;

    for (const actor of targets) {
      await dispatch(actor, transport, transportRoot, guid, relPath, actorEmailSuffix, sessionId, defaultHeartbeatInterval);
    }
  });
}

/** Fired when a channel transitions from 'deferred' → 'open' via session-open
 * (or bootstrap-conflict). Walks the channel's messages past the current
 * cursor and dispatches anything that's been waiting. The watch alone
 * doesn't re-fire for files that already existed when first deferred. */
async function replayDeferredMessages(
  transport: Transport,
  transportRoot: string,
  channelGuid: string,
  getRegistry: () => Registry,
  actorEmailSuffix: string,
  sessionId: string,
  defaultHeartbeatInterval: number | undefined,
  bootstrapCache: BootstrapStateCache,
): Promise<void> {
  const channelDir = join(transportRoot, 'channels', channelGuid);
  const cursor = await readCursor(sessionId, channelGuid);
  const all = await listMessages(channelDir);
  const missed = messagesAfterCursor(all, cursor);
  if (missed.length === 0) return;

  console.log(`[watcher] replay-after-bootstrap: ${missed.length} deferred message(s) in ${channelGuid.slice(0, 8)}`);

  const registry = getRegistry();
  for (const relPath of missed) {
    const fullPath = join(channelDir, relPath);
    let content: string;
    try { content = await readFile(fullPath, 'utf-8'); } catch { continue; }
    const { data } = parseFrontmatter(content);
    const from = String(data.from ?? '');
    const to = String(data.to ?? '');
    const type = String(data.type ?? 'text');

    if (registry.has(from)) continue;

    if (!ALWAYS_PASS_TYPES.has(type)) {
      const state = bootstrapCache.get(channelGuid);
      if (state === 'deferred') {
        console.log(`[watcher] replay aborted (re-deferred) at ${channelGuid.slice(0, 8)}/${relPath}`);
        return;
      }
    }

    const targets = to === 'all'
      ? [...registry.values()]
      : to.split(',').map(t => t.trim()).filter(t => registry.has(t)).map(t => registry.get(t)!);

    for (const actor of targets) {
      await dispatch(actor, transport, transportRoot, channelGuid, relPath, actorEmailSuffix, sessionId, defaultHeartbeatInterval);
    }
  }
}
