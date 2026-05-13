#!/usr/bin/env node
import { loadConfig } from './config.js';
import { loadRegistry, watchRegistry } from './registry.js';
import { startWatcher } from './watcher.js';
import { startRelayServer, startRelayClient } from './relay.js';
import { announceOnline, announceOffline, SESSION_ID, MACHINE_ID } from './system.js';
import { readCursor, listMessages, messagesAfterCursor, migrateCursorsIfNeeded } from './cursor.js';
import { dispatch } from './dispatch.js';
import {
  BootstrapStateCache, shouldRunBootstrapPass, buildBootstrapSummary, postSessionOpen,
  ALWAYS_PASS_TYPES,
} from './bootstrap.js';
import { join } from 'path';
import { readFile } from 'fs/promises';
import { parseFrontmatter } from './frontmatter.js';

// CLI dispatch — if a subcommand is passed, route to the CLI module and exit.
// No-args invocation (and `RELAY_MODE=server`) falls through to the daemon
// path below, preserving back-compat for everyone scripting `crosstalk`
// today as a daemon launcher.
if (process.argv.length > 2 && process.env.RELAY_MODE !== 'server') {
  const { runCLI } = await import('./cli/index.js');
  await runCLI(process.argv);
  process.exit(0);
}

console.log('[crosstalk] starting');

const config = await loadConfig();

// Server mode: relay only. No transport, no actors, no watcher. Same image
// runs locally (docker-compose) and on Render — `RELAY_MODE=server` is the
// only switch needed.
if (config.relay.mode === 'server') {
  startRelayServer(config.relay);
  const shutdown = () => {
    console.log('[crosstalk] shutting down');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  console.log('[crosstalk] ready');
} else {
  console.log(`[crosstalk] transport: ${config.transport}`);
  console.log(`[crosstalk] actor-email-suffix: ${config.actorEmailSuffix}`);

  // One-shot cursor migration: if this is the first run after upgrading past
  // the SESSION_ID → MACHINE_ID cursor-key change, migrate forward the
  // most-advanced cursor per channel from legacy session dirs. No-op for
  // genuinely-fresh installs and steady-state operation.
  await migrateCursorsIfNeeded(MACHINE_ID);

  let registry = await loadRegistry(config.transport);
  console.log(`[crosstalk] actors: ${[...registry.keys()].join(', ') || 'none'}`);

  watchRegistry(config.transport, async () => {
    registry = await loadRegistry(config.transport);
    console.log(`[crosstalk] registry reloaded: ${[...registry.keys()].join(', ') || 'none'}`);
  });

  startRelayClient(config.relay, config.transport);

  // Bootstrap Coordinator (v0.7.0-alpha.2+). Cache is shared across the
  // startup-scan loop AND the live watcher so both gating paths read the
  // same state.
  const bootstrapCache = new BootstrapStateCache(
    config.transport,
    () => registry,
    config.bootstrap,
  );

  // MACHINE_ID is stable across restarts — cursors persist so messages are not re-dispatched
  // SESSION_ID is per-boot — used only in announcements
  startWatcher(config.transport, () => registry, config.actorEmailSuffix, MACHINE_ID, config.defaultHeartbeatInterval, bootstrapCache, config.bootstrap.deferOnNoCoordinator);

  // Bootstrap pass — if we host the coordinator, post `session-open` for any
  // channel that's currently 'deferred', BEFORE the startup-scan touches them.
  // This unblocks our own dispatch + signals other daemons watching the same
  // transport to unblock theirs too.
  const decision = shouldRunBootstrapPass(config.transport, registry);
  console.log(`[bootstrap] coordinator decision: ${decision.reason}`);
  if (decision.should && decision.coordinatorActor) {
    try {
      const channelsDirForBootstrap = join(config.transport, 'channels');
      const { readdir: readdirFn } = await import('fs/promises');
      const guidsForBootstrap = await readdirFn(channelsDirForBootstrap).catch(() => []);
      const eligible = guidsForBootstrap.filter(g => !g.startsWith('.') && !g.startsWith('_'));
      const summary = await buildBootstrapSummary(config.transport, registry);
      for (const guid of eligible) {
        const state = bootstrapCache.get(guid);
        if (state === 'deferred') {
          console.log(`[bootstrap] posting session-open for ${guid.slice(0, 8)} (coordinator: ${decision.coordinatorActor})`);
          await postSessionOpen(config.transport, guid, decision.coordinatorActor, summary, config.actorEmailSuffix);
          bootstrapCache.invalidate(guid);
        }
      }
    } catch (err) {
      console.error(`[bootstrap] pass failed: ${err}`);
    }
  }

  // Startup scan — dispatch any messages missed while daemon was down.
  // Bootstrap-deferred channels skip non-always-pass message types per
  // BOOTSTRAP.md; cursor stays in place so deferred messages are picked up
  // when the channel transitions to 'open'.
  const { readdir } = await import('fs/promises');
  try {
    const channelsDir = join(config.transport, 'channels');
    const guids = await readdir(channelsDir);
    for (const guid of guids) {
      if (guid.startsWith('.') || guid.startsWith('_')) continue;
      const cursor = await readCursor(MACHINE_ID, guid);
      const all = await listMessages(join(channelsDir, guid));
      const missed = messagesAfterCursor(all, cursor);
      if (missed.length === 0) continue;
      console.log(`[crosstalk] startup scan: ${missed.length} missed message(s) in ${guid.slice(0, 8)}`);
      for (const relPath of missed) {
        const fullPath = join(channelsDir, guid, relPath);
        let content: string;
        try { content = await readFile(fullPath, 'utf-8'); } catch { continue; }
        const { data } = parseFrontmatter(content);
        const from = String(data.from ?? '');
        const to = String(data.to ?? '');
        const type = String(data.type ?? 'text');
        if (registry.has(from)) continue;

        // Bootstrap gate: defer non-always-pass types when channel is in
        // 'deferred' state. Cursor is NOT advanced for deferred messages —
        // they get re-evaluated on next startup or on watcher pickup once
        // session-open lands.
        if (!ALWAYS_PASS_TYPES.has(type)) {
          const state = bootstrapCache.get(guid);
          if (state === 'deferred') {
            console.log(`[crosstalk] startup scan defer (bootstrap pending) ${guid.slice(0,8)}/${relPath} (type=${type})`);
            break;  // stop processing this channel — preserve order, retry after session-open
          }
        }

        const targets = to === 'all'
          ? [...registry.values()]
          : to.split(',').map(t => t.trim()).filter(t => registry.has(t)).map(t => registry.get(t)!);
        for (const actor of targets) {
          await dispatch(actor, config.transport, guid, relPath, config.actorEmailSuffix, MACHINE_ID, config.defaultHeartbeatInterval);
        }
      }
    }
  } catch {
    // channels dir may not exist yet
  }

  await announceOnline(config.transport, [...registry.keys()]);

  const shutdown = async () => {
    console.log('[crosstalk] shutting down');
    await announceOffline(config.transport);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('[crosstalk] ready');
}
