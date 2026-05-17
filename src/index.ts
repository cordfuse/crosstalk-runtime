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
import { acquireSingleInstanceLock } from './single-instance.js';
import { GitTransport } from './transports/git.js';

// v1.0.5+ — extract `--config <path>` / `-c <path>` from argv. Works for
// both daemon mode AND CLI subcommands (so e.g. `crosstalk --config foo`
// runs the daemon against foo, and `crosstalk -c foo channel show ...`
// runs the CLI against foo). Forwarded to loadConfig() via env var so
// nested code paths pick it up without plumbing. CROSSTALK_CONFIG env
// (set externally) is also honored if --config isn't passed.
{
  const args = process.argv;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--config' || args[i] === '-c') {
      if (i + 1 >= args.length) {
        console.error('[crosstalk] --config requires a path argument');
        process.exit(1);
      }
      process.env.CROSSTALK_CONFIG = args[i + 1];
      args.splice(i, 2);
      i--;
    }
  }
}

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

// Single-instance enforcement (v1.0.4+, made per-transport in v1.0.5).
// Refuses to start if another live daemon is already watching the SAME
// transport. Different transports → different lock files → coexist fine,
// which unblocks multi-workspace operation for a single user. Relay-server
// mode is skipped — kernel port-bind enforces single-instance there.
if (config.relay.mode !== 'server') {
  acquireSingleInstanceLock(config.transport);
}

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

  // v0.9.0-alpha.3+ — protocol version handshake. Read transport's
  // CROSSTALK-VERSION, compare against the runtime's declared support.
  // Major mismatch → refuse to start (wire format incompatible). Minor
  // mismatch / missing / malformed → WARN + proceed.
  const { validateTransportProtocol } = await import('./protocol-version.js');
  const verdict = validateTransportProtocol(config.transport);
  switch (verdict.kind) {
    case 'major-mismatch':
      console.error(`[crosstalk] [protocol] ERROR: ${verdict.message}`);
      process.exit(2);
    case 'minor-mismatch':
    case 'transport-missing':
    case 'transport-malformed':
      console.warn(`[crosstalk] [protocol] WARN: ${verdict.message}`);
      break;
    case 'match':
    case 'patch-mismatch':
      console.log(`[crosstalk] [protocol] ${verdict.message}`);
      break;
  }

  // v1.1.0+ — instantiate the Transport before any other transport-touching
  // work. GitTransport encapsulates all the v1.0.x git-management fixes
  // (push queue, pre-pull-rebase, retry budget, actor clone routing, etc.)
  // behind a clean interface.
  const transport = new GitTransport({ root: config.transport });
  await transport.init();

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

  if (config.relay.mode === 'disabled') {
    console.log('[crosstalk] relay: disabled (offline mode — no real-time dispatch; transport sync is your responsibility)');
  } else {
    startRelayClient(config.relay, transport);
  }

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
  startWatcher(transport, config.transport, () => registry, config.actorEmailSuffix, MACHINE_ID, config.defaultHeartbeatInterval, bootstrapCache, config.bootstrap.deferOnNoCoordinator);

  // Bootstrap pass — if we host the coordinator, run the opening governance
  // pass: walk each channel for inconsistencies, post `bootstrap-conflict` if
  // any are found, else post `session-open` for any channel currently
  // 'deferred'. This unblocks our own dispatch + signals other daemons
  // watching the same transport to unblock theirs too.
  const decision = shouldRunBootstrapPass(config.transport, registry);
  console.log(`[bootstrap] coordinator decision: ${decision.reason}`);
  if (decision.should && decision.coordinatorActor) {
    try {
      const channelsDirForBootstrap = join(config.transport, 'channels');
      const { readdir: readdirFn } = await import('fs/promises');
      const guidsForBootstrap = await readdirFn(channelsDirForBootstrap).catch(() => []);
      const eligible = guidsForBootstrap.filter(g => !g.startsWith('.') && !g.startsWith('_'));

      const { walkGovernanceMessages, findInconsistencies, postBootstrapConflict } = await import('./governance.js');

      for (const guid of eligible) {
        const channelDir = join(config.transport, 'channels', guid);
        const govMessages = walkGovernanceMessages(channelDir);
        const inconsistencies = findInconsistencies(govMessages);
        if (inconsistencies.length > 0) {
          console.log(`[bootstrap] channel ${guid.slice(0, 8)} has ${inconsistencies.length} inconsistency(ies) — posting bootstrap-conflict`);
          await postBootstrapConflict(transport, guid, decision.coordinatorActor, inconsistencies, config.actorEmailSuffix);
          bootstrapCache.invalidate(guid);
          continue;  // don't post session-open over a conflict
        }
        const state = bootstrapCache.get(guid);
        if (state === 'deferred') {
          console.log(`[bootstrap] posting session-open for ${guid.slice(0, 8)} (coordinator: ${decision.coordinatorActor})`);
          const summary = await buildBootstrapSummary(transport, config.transport, registry, channelDir);
          await postSessionOpen(transport, guid, decision.coordinatorActor, summary, config.actorEmailSuffix);
          bootstrapCache.invalidate(guid);
        }
      }
    } catch (err) {
      console.error(`[bootstrap] pass failed: ${err}`);
    }
  }

  // Start time-decay + auto-tally automation. No-op if active ROE doesn't
  // require them OR we don't host the coordinator. Decay handles time-
  // decay deadlock pattern per DEADLOCK.md; auto-tally handles
  // Parliamentary/Scrum/Casual proposals where vote-window expired
  // without a role-holder posting roe-vote-result.
  const { startDecayChecker, startAutoTallyChecker, startEphemeralExpirationChecker } = await import('./governance.js');
  const decayChecker = startDecayChecker(
    transport,
    config.transport,
    config.bootstrap.decayCheckIntervalMs,
    () => decision.should ? (decision.coordinatorActor ?? null) : null,
    config.actorEmailSuffix,
  );
  const autoTallyChecker = startAutoTallyChecker(
    transport,
    config.transport,
    config.bootstrap.decayCheckIntervalMs,
    () => decision.should ? (decision.coordinatorActor ?? null) : null,
    config.actorEmailSuffix,
  );
  // v0.8.0-alpha.1+ — auto-expire ephemerals past their expires-at (per
  // EPHEMERAL.md). Independent of decay/auto-tally; ephemeral expiration
  // is a separate semantic.
  const ephemeralExpirationChecker = startEphemeralExpirationChecker(
    transport,
    config.transport,
    config.bootstrap.decayCheckIntervalMs,
    () => decision.should ? (decision.coordinatorActor ?? null) : null,
    config.actorEmailSuffix,
  );

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
        // 'deferred' state. In 'conflict' state, only roe-* defer; work
        // continues. Cursor is NOT advanced for deferred messages — they
        // get re-evaluated on next startup or on watcher pickup once the
        // state transitions back to 'open'.
        if (!ALWAYS_PASS_TYPES.has(type)) {
          const state = bootstrapCache.get(guid);
          if (state === 'deferred') {
            console.log(`[crosstalk] startup scan defer (bootstrap pending) ${guid.slice(0,8)}/${relPath} (type=${type})`);
            break;  // stop processing this channel — preserve order, retry after session-open
          }
          if (state === 'conflict' && type.startsWith('roe-')) {
            console.log(`[crosstalk] startup scan defer (bootstrap-conflict, governance only) ${guid.slice(0,8)}/${relPath} (type=${type})`);
            continue;  // skip THIS message but keep walking — work in same channel still dispatches
          }
        }

        const targets = to === 'all'
          ? [...registry.values()]
          : to.split(',').map(t => t.trim()).filter(t => registry.has(t)).map(t => registry.get(t)!);
        for (const actor of targets) {
          await dispatch(actor, transport, config.transport, guid, relPath, config.actorEmailSuffix, MACHINE_ID, config.defaultHeartbeatInterval);
        }
      }
    }
  } catch {
    // channels dir may not exist yet
  }

  await announceOnline(transport, config.transport, [...registry.keys()]);

  const shutdown = async () => {
    console.log('[crosstalk] shutting down');
    decayChecker.stop();
    autoTallyChecker.stop();
    ephemeralExpirationChecker.stop();
    await announceOffline(transport);
    await transport.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('[crosstalk] ready');
}
