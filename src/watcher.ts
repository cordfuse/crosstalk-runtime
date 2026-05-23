import { join } from 'path';
import { readdir, readFile } from 'fs/promises';
import { parse as parseYaml } from 'yaml';
import { parseFrontmatter } from './frontmatter.js';
import { dispatch, isDuplicate } from './dispatch.js';
import { readCursor, listMessages, messagesAfterCursor } from './cursor.js';
import type { Transport, MessageEvent } from './transport.js';
import type { ActorConfig, Registry } from './registry.js';
import { resolveAddress } from './registry.js';
import {
  ALWAYS_PASS_TYPES, CACHE_INVALIDATING_TYPES, type BootstrapStateCache,
} from './bootstrap.js';
import { verifyMessage } from './signing.js';
import { applyDispatchPolicy, parseDispatchPolicy } from './dispatch-policy.js';
import { QuorumTracker, emitPoolQuorumReached, emitPoolQuorumFailed } from './quorum-tracker.js';
import { WATCHER_IDENTITY } from './system.js';
import { createThreadState, recordThreadResponse, buildSynthesisRequest, markSynthesisSent } from './orchestration.js';

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
  /** v1.6.0-alpha.1+ — env layer forwarded to spawned agent children
   * (sourced from config.agentEnv / `[agent-environment]` TOML table).
   * Default undefined = agents inherit the daemon's env unchanged. */
  agentEnv?: Record<string, string>,
  /** v1.9.0-alpha.3+ — signature verification mode. 'strict' rejects
   * any non-valid verdict; 'permissive' (default) only rejects
   * signature-mismatch (tampering). Sourced from config.signatureMode. */
  signatureMode: 'permissive' | 'strict' = 'permissive',
): { rescanAll: () => Promise<void> } {
  console.log(`[watcher] subscribing to transport events`);

  // v1.7.0-alpha.1+ — broadcast-with-quorum runtime tracker. One per
  // daemon process; state lives in memory and is lost on restart (real
  // pool responses remain durable in the transport). Construct here so
  // it's shared between the live processInbound path and replayDeferred.
  // v1.10.0-alpha.1+ — onExpired callback emits pool-quorum-failed when
  // the sweep purges an entry that never reached K. Symmetric with the
  // success path (pool-quorum-reached fires inline on K-th responder).
  const quorumTracker = new QuorumTracker({
    onExpired: (state) => {
      emitPoolQuorumFailed(transport, transportRoot, state, WATCHER_IDENTITY).catch(err => {
        console.error(`[watcher] failed to emit pool-quorum-failed for ${state.originRelPath}: ${err}`);
      });
      console.log(`[watcher] pool-quorum-failed emitted for ${state.poolAddress} (${state.responders.size}/${state.k})`);
    },
  });

  // v1.9.0-alpha.1+ — in-flight dispatch tracking. Per-message Set keyed
  // on `${channel}/${relPath}`. Added BEFORE dispatch fires; removed when
  // ALL targets for that message resolve their dispatch promise (which
  // now includes the cursor write since v1.9 made dispatch await its own
  // completion). Catches the rescan double-fire case bombproof: while a
  // dispatch is in-flight, the rescan/fs.watch re-fire skips the message
  // entirely, regardless of how long the agent takes. v1.8.1 papered
  // over this with a 10-minute DEDUP_WINDOW_MS in dispatch.ts; this
  // replaces that workaround (window restored to 2s).
  const inFlight = new Set<string>();

  const processInbound = async (event: MessageEvent): Promise<void> => {
    const { channel: guid, relPath, content } = event;

    // v1.9.0-alpha.1+ — in-flight check FIRST (before any await). Both
    // the check and the add must be in the same synchronous block —
    // earlier draft placed the check + add far apart, around several
    // awaits, allowing two concurrent processInbound calls (one from
    // fs.watch, one from rescan) to both pass the check before either
    // added the key. JavaScript's single-threaded execution guarantees
    // these two Set operations are atomic when no await separates them.
    // Removal happens in the finally at the bottom.
    const inFlightKey = `${guid}/${relPath}`;
    if (inFlight.has(inFlightKey)) {
      console.log(`[watcher] skip (in-flight) ${relPath}`);
      return;
    }
    inFlight.add(inFlightKey);

    try {

    const dedupKey = `${guid}/${relPath}`;
    if (isDuplicate(dedupKey)) return;

    // Skip messages at or before the cursor — re-fires can happen when a
    // git pull rebase rewrites working-tree files, or just from inotify
    // event coalescing.
    const cursor = await readCursor(sessionId, guid);
    if (cursor && relPath <= cursor) return;

    const { data, body } = parseFrontmatter(content);
    const from = String(data.from ?? '');
    const to = String(data.to ?? '');
    const type = String(data.type ?? 'text');

    // v1.3.0-alpha.2+ — signature verification. v1.9.0-alpha.3+ — honors
    // the operator-configured signature mode.
    //   permissive (default): only signature-mismatch (tampering)
    //     rejects; unsigned + missing-pubkey pass through. v1.3 behavior.
    //   strict: any non-valid verdict rejects. Operators opt in via
    //     `signature-mode = "strict"` in config.toml.
    if (from) {
      const verdict = verifyMessage(content, from, transportRoot);
      if (!verdict.valid) {
        if (verdict.reason === 'signature-mismatch') {
          console.error(`[watcher] REJECT ${relPath} — signature mismatch on from: ${from}. Tampered message or wrong key.`);
          return;
        }
        if (signatureMode === 'strict') {
          console.error(`[watcher] REJECT ${relPath} — strict mode rejects from: ${from} (reason: ${verdict.reason}). Either publish a signing pubkey for this actor or switch to permissive mode.`);
          return;
        }
        // permissive: no-signature + no-public-key pass through
      }
    }

    const registry = getRegistry();

    // v1.7.0-alpha.1+ — quorum response tracking must run BEFORE the
    // self-loop skip. Pool member responses (`from: worker-N@steve`)
    // ARE in our local registry, so the self-loop check would early-
    // exit and the QuorumTracker would never count them. Record FIRST
    // — bookkeeping is distinct from re-dispatch.
    //
    // v1.18.0-alpha.2+ — thread response tracking runs here for the same
    // reason: spawn child responses come FROM local actors (in the registry),
    // so tracking must happen before the self-loop check.
    {
      const inReplyTo = typeof data['in-reply-to'] === 'string' ? data['in-reply-to'] : null;
      if (inReplyTo && from) {
        const verdict = quorumTracker.recordResponse(guid, inReplyTo, from);
        if (verdict.action === 'reached') {
          emitPoolQuorumReached(transport, transportRoot, verdict.state, WATCHER_IDENTITY).catch(err => {
            console.error(`[watcher] failed to emit pool-quorum-reached for ${inReplyTo}: ${err}`);
          });
          quorumTracker.close(guid, inReplyTo);
          console.log(`[watcher] pool-quorum-reached emitted for ${verdict.state.poolAddress} (${verdict.state.responders.size}/${verdict.state.k})`);
        } else if (verdict.action === 'all-responded') {
          quorumTracker.close(guid, inReplyTo);
        }
      }

      // v1.18.0-alpha.2+ — thread response tracking.
      // v1.18.0-alpha.3+ — synthesizer invocation on join.
      const threadIdField = typeof data['thread-id'] === 'string' ? data['thread-id'] : null;
      if (threadIdField && from && type !== 'spawn') {
        recordThreadResponse(transport, transportRoot, guid, threadIdField, relPath, from)
          .then(async result => {
            if (!result) return;
            if (result.joined) {
              console.log(
                `[thread] join: thread ${threadIdField} complete` +
                ` (${result.state.responses.length}/${result.state.expects} responses)` +
                (result.state.synthesizer ? ` — synthesizer: ${result.state.synthesizer}` : ''),
              );
              // v1.18.0-alpha.3+ — post synthesis-request and let the normal
              // watcher dispatch pipeline deliver it. Posting here rather than
              // dispatching manually avoids a double-dispatch race (the watcher
              // would see the new message via fs.watch/rescan and dispatch it
              // again if we also called dispatch() here). Cross-operator:
              // if the synthesizer is on another daemon, their watcher picks it
              // up via sync — nothing special needed.
              if (result.state.synthesizer) {
                // Guard: if synthesis-request was already posted (restart or
                // multi-daemon), skip re-posting. synthesisRelPath is set
                // immediately after posting via markSynthesisSent so this is
                // durable across restarts for both GitTransport and
                // FilesystemTransport.
                if (result.state.synthesisRelPath) {
                  console.log(`[thread] synthesis already sent at ${result.state.synthesisRelPath} — skipping`);
                } else {
                  try {
                    const synthContent = await buildSynthesisRequest(transport, guid, result.state);
                    const synthRelPath = await transport.postMessage(guid, WATCHER_IDENTITY, synthContent);
                    console.log(`[thread] synthesis-request → ${result.state.synthesizer} at ${synthRelPath}`);
                    await markSynthesisSent(transport, transportRoot, guid, threadIdField, synthRelPath);
                  } catch (err) {
                    console.error(`[thread] synthesizer invocation failed for thread ${threadIdField}: ${err}`);
                  }
                }
              }
            } else {
              console.log(
                `[thread] response ${result.state.responses.length}/${result.state.expects}` +
                ` on thread ${threadIdField} from ${from}`,
              );
            }
          })
          .catch(err => console.error(`[thread] response tracking failed: ${err}`));
      }
    }

    // v1.18.0-alpha.1+ — spawn messages from local actors must still be
    // processed (watcher consumes them, not actors). All other own-actor
    // messages skip as before to prevent dispatch loops.
    if (registry.has(from) && type !== 'spawn') {
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
        replayDeferredMessages(transport, transportRoot, guid, getRegistry, actorEmailSuffix, sessionId, defaultHeartbeatInterval, bootstrapCache, agentEnv).catch(err => {
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
    } else {
      // v1.3.0-alpha.7+ — governance message types (session-open,
      // session-open-deferred, bootstrap-conflict, system) are for the
      // bootstrap cache + watcher, not for actor dispatch. Pre-v1.3 the
      // single-operator self-loop check happened to filter these out
      // because the from: name matched the local registry. In multi-op,
      // a session-open posted by alice@bob carries `from: alice@bob`
      // which doesn't match steve's registry (alice@steve), so steve's
      // actors would dispatch on bob's bootstrap message — a feedback
      // loop bombing both daemons with cross-op responses. Skip dispatch
      // explicitly for governance types so the behavior is intentional
      // rather than accidental.
      return;
    }

    // v1.18.0-alpha.1+ — orchestration: spawn messages are watcher-handled
    // meta-instructions, not actor work. The watcher parses the task list and
    // posts each child as a new message in the same channel. Children carry
    // no `from:` field (posted by watcher) so they are never self-loop-skipped
    // by any daemon. Thread state tracking deferred to alpha.2.
    if (type === 'spawn') {
      await handleSpawn(transport, transportRoot, guid, relPath, data, body);
      return;
    }

    let targets = resolveTargets(registry, to);

    if (targets.length === 0) return;

    // v1.5.0-alpha.1+ — sender-side dispatch policy. The message frontmatter
    // can carry `dispatch: <policy>`; we apply it AFTER resolveTargets so
    // it operates on the expanded pool instances. Default is fanout (v1.4
    // back-compat). Unknown policies fall back to fanout with a warning.
    const dispatchRaw = typeof data.dispatch === 'string' ? data.dispatch : undefined;
    const policy = parseDispatchPolicy(dispatchRaw);
    if (policy === null) {
      console.warn(`[watcher] unknown dispatch policy "${dispatchRaw}" on ${guid.slice(0, 8)}/${relPath} — falling back to fanout`);
    } else if (policy !== 'fanout') {
      // Only apply when the message addresses a single pool — multi-address CSV
      // semantics for non-fanout policies aren't defined in alpha.1.
      const toAddresses = to.split(',').map(s => s.trim()).filter(Boolean);
      if (toAddresses.length === 1) {
        targets = await applyDispatchPolicy(targets, policy, sessionId, guid, toAddresses[0]);
      } else {
        console.warn(`[watcher] dispatch policy "${policy}" with multi-address \`to:\` (${toAddresses.length} addresses) — applying fanout for the union; per-pool policy lands later`);
      }
    }

    if (targets.length === 0) return;

    // v1.7.0-alpha.1+ — if this inbound IS a broadcast-with-quorum
    // request, register a tracker entry BEFORE dispatching the pool.
    // The pool size is `targets.length` (the n in K-of-N). Pool responses
    // carrying `in-reply-to: <this-relPath>` will count down toward K.
    if (policy === 'broadcast-with-quorum') {
      const k = parseInt(String(data.quorum ?? ''), 10);
      if (Number.isFinite(k) && k >= 1) {
        if (k > targets.length) {
          console.warn(`[watcher] quorum K=${k} exceeds pool size ${targets.length} for ${guid.slice(0, 8)}/${relPath} — pool-quorum-reached can never fire; check the message`);
        }
        const toAddresses = to.split(',').map(s => s.trim()).filter(Boolean);
        const poolAddress = toAddresses[0] ?? to;
        quorumTracker.register(guid, relPath, poolAddress, k, targets.length);
      } else {
        console.warn(`[watcher] broadcast-with-quorum on ${guid.slice(0, 8)}/${relPath} missing valid 'quorum: <K>' field — no tracker entry registered`);
      }
    }

    // Response recording moved earlier in the function (before the
    // self-loop check); see the v1.7.0-alpha.1+ block above. Keeping
    // this anchor comment so the dispatch order stays clear.

    // v1.9.0-alpha.1+ — parallel fanout via Promise.all (was sequential
    // await loop; the change matters now that dispatch awaits its own
    // completion, otherwise N pool members would dispatch serially).
    // In-flight removal happens in the outer finally.
    await Promise.all(
      targets.map(actor =>
        dispatch(actor, transport, transportRoot, guid, relPath, actorEmailSuffix, sessionId, defaultHeartbeatInterval, agentEnv)
      ),
    );

    } finally {
      // v1.9.0-alpha.1+ — paired with the in-flight add at the top of
      // processInbound. Removed AFTER every code path: early-return
      // (cursor / self-loop / governance / deferred / empty-targets) and
      // dispatch-complete. Without removal here those skip paths would
      // leak inFlight entries until daemon restart.
      inFlight.delete(inFlightKey);
    }
  };

  // Subscribe fs.watch path through processInbound.
  transport.watchMessages(processInbound);

  // v1.3.0-alpha.7+ — rescan helper for the polling loop.
  // Linux's fs.watch({recursive:true}) does NOT auto-watch newly-created
  // subdirectories — so when `transport.sync()` pulls a fresh channel dir
  // (or a fresh YYYY/MM/DD subdir), messages inside it never trigger the
  // watcher callback. This walks every channel directory and feeds any
  // file past the cursor through the same processInbound pipeline that
  // fs.watch would have used. Idempotent: the per-message cursor + dedup
  // checks inside processInbound filter out already-processed files.
  const rescanAll = async (): Promise<void> => {
    const channelsDir = join(transportRoot, 'channels');
    let channelGuids: string[];
    try {
      channelGuids = await readdir(channelsDir);
    } catch {
      return;  // channels/ doesn't exist yet
    }
    for (const guid of channelGuids) {
      const channelDir = join(channelsDir, guid);
      let messages: string[];
      try {
        messages = await listMessages(channelDir);
      } catch {
        continue;
      }
      for (const relPath of messages) {
        let content: string;
        try {
          content = await (await import('fs/promises')).readFile(join(channelDir, relPath), 'utf-8');
        } catch {
          continue;
        }
        // processInbound's own cursor + dedup checks will skip already-dispatched
        // messages. No need to filter here.
        await processInbound({ channel: guid, relPath, content });
      }
    }
  };

  return { rescanAll };
}

// ── v1.18.0-alpha.1+ — orchestration ─────────────────────────────────────

/** v1.18.0-alpha.1+ fire-and-forget spawn handler (thread state added alpha.2).
 * Parses the spawn body (YAML task list), posts each child as a new message
 * in the same channel, then persists a thread state file for join tracking.
 *
 * Children have no `from:` field so they are never self-loop-skipped on any
 * daemon. `spawn-from:` carries the original sender for actor context.
 *
 * Spawn body format (YAML list):
 *
 *   - to: actor-name
 *     body: |
 *       Task content here.
 *   - to: other-actor
 *     type: text        # optional; defaults to "text"
 *     body: |
 *       Another task.
 *
 * Supported frontmatter on the spawn message:
 *   thread-id: <string>    optional — derived from relPath if omitted
 *   expects: <N>           optional — default: number of children posted
 *   synthesizer: <actor>   optional — invoked on join (alpha.3)
 */
async function handleSpawn(
  transport: Transport,
  transportRoot: string,
  channel: string,
  relPath: string,
  data: Record<string, unknown>,
  body: string,
): Promise<void> {
  let tasks: unknown;
  try {
    tasks = parseYaml(body);
  } catch (err) {
    console.error(`[spawn] parse error in ${channel.slice(0, 8)}/${relPath}: ${err}`);
    return;
  }

  if (!Array.isArray(tasks) || tasks.length === 0) {
    console.warn(`[spawn] body must be a non-empty YAML list — ${channel.slice(0, 8)}/${relPath}`);
    return;
  }

  // Derive thread-id from frontmatter; fall back to a slug of the relPath.
  const threadId = (typeof data['thread-id'] === 'string' && data['thread-id'])
    ? data['thread-id']
    : relPath.replace(/\//g, '-').replace(/\.md$/, '');

  const spawnFrom = typeof data.from === 'string' ? data.from : '';
  const synthesizer = typeof data.synthesizer === 'string' ? data.synthesizer : undefined;

  console.log(`[spawn] ${channel.slice(0, 8)}/${relPath} — thread ${threadId} — ${tasks.length} task(s)`);

  const childRelPaths: string[] = [];

  for (const task of tasks) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) continue;
    const t = task as Record<string, unknown>;
    const taskTo   = typeof t.to   === 'string' ? t.to.trim()  : '';
    const taskBody = typeof t.body === 'string' ? t.body        : '';
    const taskType = typeof t.type === 'string' ? t.type.trim() : 'text';

    if (!taskTo) {
      console.warn(`[spawn] task missing 'to' in thread ${threadId} — skipping`);
      continue;
    }

    const fm = [
      '---',
      ...(spawnFrom ? [`spawn-from: ${spawnFrom}`] : []),
      `to: ${taskTo}`,
      `type: ${taskType}`,
      `thread-id: ${threadId}`,
      `in-reply-to: ${relPath}`,
      '---',
    ].join('\n');
    const childContent = `${fm}\n${taskBody}`;

    try {
      const childRelPath = await transport.postMessage(channel, WATCHER_IDENTITY, childContent);
      childRelPaths.push(childRelPath);
      console.log(`[spawn] → ${taskTo} at ${childRelPath}`);
    } catch (err) {
      console.error(`[spawn] failed to post child → ${taskTo}: ${err}`);
    }
  }

  if (childRelPaths.length === 0) return;

  // v1.18.0-alpha.2+ — persist thread state for join tracking.
  const expectsRaw = data.expects;
  const expects = (typeof expectsRaw === 'number' && Number.isFinite(expectsRaw) && expectsRaw >= 1)
    ? Math.floor(expectsRaw)
    : childRelPaths.length;
  try {
    await createThreadState(transport, transportRoot, channel, threadId, relPath, expects, childRelPaths, synthesizer);
    console.log(`[spawn] thread ${threadId} created — expects ${expects}/${childRelPaths.length} response(s)`);
  } catch (err) {
    console.error(`[spawn] thread state write failed for ${threadId}: ${err}`);
  }
}

/** Expand a message's `to:` field to the actor instances on THIS daemon
 * that should be dispatched. v1.3.0-alpha.4+ — was previously a CSV-split
 * + `registry.has(t)` filter that only matched bare names against bare
 * registry keys. Now uses {@link resolveAddress} so:
 *
 *  - `to: all`            → every actor in the local registry (unchanged)
 *  - `to: alice`          → bare-name lookup (single-op compat)
 *  - `to: alice@steve`    → exact qualified-address match
 *  - `to: dart-thrower@steve` → all pool instances of role dart-thrower
 *  - `to: alice@bob`      → empty on a daemon whose operator != bob
 *    (bob's daemon will process; this one correctly skips)
 *  - `to: alice@steve, carol@steve` → both, deduplicated by address
 *
 * Cross-operator routing falls out for free: each daemon's registry only
 * contains actors registered to its own operator handle, so addresses
 * pointing at another operator's actors resolve to empty and get skipped. */
export function resolveTargets(registry: Registry, to: string): ActorConfig[] {
  if (to === 'all') return [...registry.values()];

  const addresses = to.split(',').map(s => s.trim()).filter(Boolean);
  const matched: ActorConfig[] = [];
  const seen = new Set<string>();
  for (const addr of addresses) {
    for (const actor of resolveAddress(registry, addr)) {
      if (seen.has(actor.address)) continue;
      seen.add(actor.address);
      matched.push(actor);
    }
  }
  return matched;
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
  agentEnv?: Record<string, string>,
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

    // v1.3.0-alpha.7+ — same governance-type dispatch skip as the live
    // watcher path. Governance messages flow through to the bootstrap
    // cache, never to actor dispatch.
    if (ALWAYS_PASS_TYPES.has(type)) continue;

    if (!ALWAYS_PASS_TYPES.has(type)) {
      const state = bootstrapCache.get(channelGuid);
      if (state === 'deferred') {
        console.log(`[watcher] replay aborted (re-deferred) at ${channelGuid.slice(0, 8)}/${relPath}`);
        return;
      }
    }

    const targets = resolveTargets(registry, to);

    // v1.9.0-alpha.1+ — parallel fanout via Promise.all (matches the
    // live-watcher path's switch from sequential await). Same agentEnv
    // propagation as the live path.
    await Promise.all(
      targets.map(actor =>
        dispatch(actor, transport, transportRoot, channelGuid, relPath, actorEmailSuffix, sessionId, defaultHeartbeatInterval, agentEnv)
      ),
    );
  }
}
