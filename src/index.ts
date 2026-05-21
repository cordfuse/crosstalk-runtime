#!/usr/bin/env node
import { loadConfig } from './config.js';
import { loadRegistry, watchRegistry } from './registry.js';
import { startWatcher, resolveTargets } from './watcher.js';
import { startRelayServer, startRelayClient } from './relay.js';
import { announceOnline, announceOffline, announceRegistryReload, SESSION_ID, MACHINE_ID } from './system.js';
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
      // v1.4.0-alpha.3+ — UX hint for the long-standing `-c` collision.
      // `-c` is `--config` at the top level AND `--channel` in the post/
      // channel-show/etc. subcommands. When the value extracted as a
      // config path is followed by a subcommand keyword that ALSO accepts
      // `-c`, surface the ambiguity rather than silently swallowing what
      // the user probably meant as a channel name. The subcommand list
      // here is small enough to enumerate; missing one degrades back to
      // the old silent-swallow which is the pre-existing behaviour, so
      // worst-case no regression.
      const SHORT_CH_SUBCOMMANDS = new Set(['post', 'channel']);
      const value = args[i + 1];
      const rest = args.slice(i + 2);
      const subcommandIdx = rest.findIndex(a => SHORT_CH_SUBCOMMANDS.has(a));
      if (subcommandIdx >= 0 && args[i] === '-c') {
        console.error(`[crosstalk] -c "${value}" was parsed as --config (config-file path), but the subcommand "${rest[subcommandIdx]}" also accepts -c (meaning --channel).`);
        console.error(`           If you meant a channel name, use --channel "${value}" (or move -c <config-path> after the subcommand).`);
        console.error(`           If you really did mean --config, use the long form to silence this check: --config "${value}"`);
        process.exit(1);
      }
      process.env.CROSSTALK_CONFIG = value;
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

  let registry = await loadRegistry(config.transport, config.operator);
  console.log(`[crosstalk] actors: ${[...registry.keys()].join(', ') || 'none'}`);

  watchRegistry(config.transport, async () => {
    registry = await loadRegistry(config.transport, config.operator);
    console.log(`[crosstalk] registry reloaded: ${[...registry.keys()].join(', ') || 'none'}`);
    announceRegistryReload(transport, [...registry.keys()]).catch(err =>
      console.error(`[crosstalk] registry-reload announce failed: ${err}`)
    );
  }, config.operator);

  // v1.2.0+ — polling fallback when no relay. Calls transport.sync() on a
  // timer so commits from other machines / PR merges / external pushes get
  // picked up without operator intervention. Default 30s; configurable via
  // [relay].poll-interval-seconds. The relay client (mode=client/server)
  // gets sub-second sync via webhook; polling fills the gap when relay is
  // off entirely. NOT a backup-when-relay-disconnected — relay client
  // handles its own reconnects.
  let pollTimer: NodeJS.Timeout | null = null;
  if (config.relay.mode === 'disabled') {
    const intervalMs = Math.max(1, config.relay.pollIntervalSeconds) * 1000;
    console.log(`[crosstalk] relay: disabled — polling transport every ${config.relay.pollIntervalSeconds}s`);
    // Immediate initial sync so we don't wait the full interval to catch up.
    transport.sync().catch(err => console.error(`[crosstalk] initial sync failed: ${err}`));
    pollTimer = setInterval(() => {
      transport.sync().catch(err => console.error(`[crosstalk] poll sync failed: ${err}`));
    }, intervalMs);
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
  const watcherHandle = startWatcher(transport, config.transport, () => registry, config.actorEmailSuffix, MACHINE_ID, config.defaultHeartbeatInterval, bootstrapCache, config.bootstrap.deferOnNoCoordinator, config.agentEnv, config.signatureMode);

  // v1.3.0-alpha.7+ — bridge polling-mode sync to the watcher's rescan path.
  // Linux fs.watch.recursive doesn't catch files in subdirectories that
  // didn't exist at watch-start, so after every `transport.sync()` we walk
  // channels and feed any new messages through the same dispatch path
  // fs.watch would have used. Idempotent via cursor + dedup checks inside
  // the watcher. Relay-mode daemons get the same treatment because the
  // relay client also calls transport.sync() — wiring there is the small
  // follow-up; for now the bridge fires only in polling mode where the
  // bug is most visible.
  if (config.relay.mode === 'disabled' && pollTimer) {
    // Re-arm the existing timer to also run rescanAll after sync.
    clearInterval(pollTimer);
    const intervalMs = Math.max(1, config.relay.pollIntervalSeconds) * 1000;
    pollTimer = setInterval(async () => {
      try {
        await transport.sync();
        await watcherHandle.rescanAll();
      } catch (err) {
        console.error(`[crosstalk] poll sync+rescan failed: ${err}`);
      }
    }, intervalMs);
  }

  // v1.9.0-alpha.1+ — single initial rescan for ALL relay modes (was
  // previously only in disabled-polling mode). This is the startup-
  // catch-up path; it replaces the legacy startup-scan block further
  // down that dispatched DIRECTLY (bypassing processInbound's in-flight
  // tracking and causing concurrent double-dispatches during startup).
  // rescanAll goes through processInbound which has the synchronous
  // in-flight check + cursor check + governance-type skip + bootstrap
  // defer — same skip-list as the legacy block, but with proper dedup.
  watcherHandle.rescanAll().catch(err => console.error(`[crosstalk] initial rescan failed: ${err}`));

  // Bootstrap pass — if we host the coordinator, run the opening governance
  // pass: walk each channel for inconsistencies, post `bootstrap-conflict` if
  // any are found, else post `session-open` for any channel currently
  // 'deferred'. This unblocks our own dispatch + signals other daemons
  // watching the same transport to unblock theirs too.
  const decision = shouldRunBootstrapPass(
    config.transport, registry, config.operator,
    config.bootstrap.coordinatorAddress, config.defaultHumanActor,
  );
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
          const summary = await buildBootstrapSummary(transport, config.transport, registry, channelDir, config.operator);
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

  // v1.9.0-alpha.1+ — the legacy startup-scan block that lived here was
  // removed in favor of the single `watcherHandle.rescanAll()` call
  // earlier in this function. The legacy block dispatched directly
  // (bypassing processInbound), so during startup it could double-fire
  // with the live watcher's processInbound on the same messages, which
  // surfaced as duplicate concierge responses in the v1.8 UAT. rescanAll
  // routes through processInbound + its in-flight Set, so dedup is
  // bombproof regardless of how many code paths see the same message.

  await announceOnline(transport, config.transport, [...registry.keys()]);

  const shutdown = async () => {
    console.log('[crosstalk] shutting down');
    decayChecker.stop();
    autoTallyChecker.stop();
    ephemeralExpirationChecker.stop();
    if (pollTimer) clearInterval(pollTimer);
    await announceOffline(transport);
    await transport.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('[crosstalk] ready');
}
