#!/usr/bin/env node
import { loadConfig } from './config.js';
import { loadRegistry, watchRegistry } from './registry.js';
import { startWatcher } from './watcher.js';
import { startRelayServer, startRelayClient } from './relay.js';
import { announceOnline, announceOffline, SESSION_ID, MACHINE_ID } from './system.js';
import { readCursor, listMessages, messagesAfterCursor } from './cursor.js';
import { dispatch } from './dispatch.js';
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

  let registry = await loadRegistry(config.transport);
  console.log(`[crosstalk] actors: ${[...registry.keys()].join(', ') || 'none'}`);

  watchRegistry(config.transport, async () => {
    registry = await loadRegistry(config.transport);
    console.log(`[crosstalk] registry reloaded: ${[...registry.keys()].join(', ') || 'none'}`);
  });

  startRelayClient(config.relay, config.transport);

  // MACHINE_ID is stable across restarts — cursors persist so messages are not re-dispatched
  // SESSION_ID is per-boot — used only in announcements
  startWatcher(config.transport, () => registry, config.actorEmailSuffix, MACHINE_ID, config.defaultHeartbeatInterval);

  // Startup scan — dispatch any messages missed while daemon was down
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
        if (registry.has(from)) continue;
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
