import { watch, mkdirSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { parseFrontmatter } from './frontmatter.js';
import { dispatch, isDuplicate } from './dispatch.js';
import { readCursor, listMessages, messagesAfterCursor } from './cursor.js';
import { MESSAGE_PATH_RE } from './filenames.js';
import type { Registry } from './registry.js';
import {
  ALWAYS_PASS_TYPES, CACHE_INVALIDATING_TYPES, type BootstrapStateCache,
} from './bootstrap.js';

// Matches: YYYY/MM/DD/HHMMSSsssZ.md (legacy) or YYYY/MM/DD/HHMMSSsssZ-<hex8>.md (v0.7.x+)
const MESSAGE_RE = MESSAGE_PATH_RE;

export function startWatcher(
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
  const channelsDir = join(transportRoot, 'channels');

  // First-time setup: transport may exist with no channels/ yet. Without this,
  // watch() throws ENOENT and crashes the daemon before the first message lands.
  mkdirSync(channelsDir, { recursive: true });

  console.log(`[watcher] watching ${channelsDir}`);

  watch(channelsDir, { recursive: true }, async (event, filename) => {
    if (!filename || !filename.endsWith('.md')) return;

    // Expected shape: <guid>/YYYY/MM/DD/HHMMSSsssZ.md  (5 segments)
    const parts = filename.split('/');
    if (parts.length !== 5) return;

    const [guid, year, month, day, file] = parts;
    const relPath = `${year}/${month}/${day}/${file}`;

    if (!MESSAGE_RE.test(relPath)) return;

    const dedupKey = `${guid}/${relPath}`;
    if (isDuplicate(dedupKey)) return;

    // Skip messages at or before the cursor — git rebase during push-retry can
    // rewrite existing working-tree files and re-fire inotify events for them
    const cursor = await readCursor(sessionId, guid);
    if (cursor && relPath <= cursor) return;

    const fullPath = join(channelsDir, filename);

    let content: string;
    try {
      content = await readFile(fullPath, 'utf-8');
    } catch {
      return;
    }

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
        // Replay deferred messages — runs out-of-band, doesn't block this handler.
        replayDeferredMessages(transportRoot, guid, getRegistry, actorEmailSuffix, sessionId, defaultHeartbeatInterval, bootstrapCache).catch(err => {
          console.error(`[watcher] replay failed for ${guid.slice(0, 8)}: ${err}`);
        });
      }
    }

    if (!ALWAYS_PASS_TYPES.has(type)) {
      const state = bootstrapCache.get(guid);
      if (state === 'deferred') {
        console.log(`[watcher] defer (bootstrap pending) ${guid.slice(0, 8)}/${relPath} (type=${type})`);
        // Critical: do NOT advance cursor. The message stays pending until
        // session-open lands; it'll be picked up on the next watcher event
        // for this channel or on the next startup scan.
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
      await dispatch(actor, transportRoot, guid, relPath, actorEmailSuffix, sessionId, defaultHeartbeatInterval);
    }
  });
}

/** Fired when a channel transitions from 'deferred' → 'open' via session-open
 * (or bootstrap-conflict). Walks the channel's messages past the current
 * cursor and dispatches anything that's been waiting. fs.watch alone doesn't
 * re-fire for files that already existed when first deferred. */
async function replayDeferredMessages(
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

    // Re-check bootstrap state per-message — it could have flipped back to
    // 'deferred' if a fresh boundary lands mid-replay. Cheap (cached).
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
      await dispatch(actor, transportRoot, channelGuid, relPath, actorEmailSuffix, sessionId, defaultHeartbeatInterval);
    }
  }
}
