/**
 * Bootstrap Coordinator implementation — runtime enforcement of the v0.7.0
 * `manifest/framework/protocol/BOOTSTRAP.md` spec.
 *
 * Inserts a synchronisation point at watcher startup so no daemon processes
 * work messages until the designated coordinator has posted a `type:
 * session-open` for the current session. Prevents the multi-actor startup
 * race that BOOTSTRAP exists to solve (two daemons coming online
 * simultaneously each posting a `roe-vote-result` based on different views
 * of in-flight governance state).
 *
 * Architecture:
 *
 * 1. `isChannelBootstrapped` — pure, read-only history walk. Determines
 *    'open' or 'deferred' for a single channel by comparing the most
 *    recent `type: session-open` in the channel against the most recent
 *    session-boundary marker (`type: system, reason: offline` from a
 *    coordinator-eligible actor in `_system/`).
 *
 * 2. `BootstrapStateCache` — wraps `isChannelBootstrapped` with a 60-second
 *    TTL + explicit invalidation hooks. Required because the watcher
 *    dispatch hot path can call `get(channelGuid)` per message; without a
 *    cache, that's an O(history-walk) read every dispatch. Cache is
 *    invalidated explicitly when a triggering message type is seen
 *    (`session-open`, `bootstrap-conflict`); TTL bounds staleness for the
 *    case where we miss a remote-machine offline event (which arrives via
 *    the relay → pull path, not via our local file watcher).
 *
 * 3. `shouldRunBootstrapPass` — coordinator selection. Reads the active
 *    ROE (`manifest/custom/protocol/ROE.md` falling through to
 *    `manifest/framework/protocol/ROE.md`) for a `coordinator:` field; if
 *    found and resolves to one of our registry's actors, we coordinate.
 *    Otherwise falls back to first-actor-by-joined-at (alpha.2 permissive
 *    layer; per-template semantic coordinator selection is alpha.5+).
 *
 * 4. `buildBootstrapSummary` + `postSessionOpen` — MVP bootstrap-pass
 *    content (online actors + offline-flagged + ROE version) + atomic
 *    write/commit/push via existing `pushWithRetry`.
 *
 * Always-pass message types (handled in watcher.ts, listed here as
 * documentation): `system`, `session-open`, `session-open-deferred`,
 * `bootstrap-conflict`. All other message types — including all `roe-*`
 * governance messages — defer until `session-open` lands. This is
 * deliberate: letting `roe-*` pass during deferred state defeats the
 * synchronisation purpose (a `roe-vote-result` from another actor could
 * land + dispatch before our daemon has surfaced the underlying proposal).
 *
 * What this module does NOT do (deferred to later v0.7.x runtime alphas):
 *
 * - Per-template semantic coordinator selection (Speaker for Parliamentary,
 *   SM for Scrum, etc.) — requires parsing the ROE template structure;
 *   alpha.5+
 * - Full bootstrap-pass content (outstanding amendment processing,
 *   deadlock resolution, vote-window expiry handling) — alpha.4 alongside
 *   `bootstrap-conflict` surface routing
 * - `session-open-deferred` yield-to-senior on multi-coordinator races —
 *   alpha.5+; alpha.2 lets the first session-open win, subsequent ones
 *   are idempotent (cache shows 'open' regardless)
 * - Time-decay automation per DEADLOCK.md — alpha.3
 */
import { existsSync, readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { parseFrontmatter } from './frontmatter.js'
import type { Transport, ActorIdentity } from './transport.js'
import { MESSAGE_FILE_RE } from './filenames.js'
import type { Registry } from './registry.js'
import { MACHINE_ID } from './system.js'
import { machineGitEmail } from './transports/git.js'
import { parseAddress, isAddressError } from './address.js'

const YEAR_RE = /^\d{4}$/
const DD_RE = /^\d{2}$/
// Accepts both legacy HHMMSSsssZ.md + v0.7.x+ tagged HHMMSSsssZ-<hex8>.md
const MSG_RE = MESSAGE_FILE_RE

// ── State + types ─────────────────────────────────────────────────────────

export type BootstrapState = 'open' | 'deferred' | 'conflict'

export interface BootstrapOpts {
  /** Bootstrap timeout in ms — if no `session-open` lands within this window
   * after a session-boundary, the watcher logs + treats the channel as
   * 'open' (degraded mode). Per BOOTSTRAP.md "Coordinator crashes mid-
   * bootstrap" edge case (default 5 min). */
  timeoutMs: number
}

/** Always-pass types — these are never gated by the bootstrap state. Listed
 * here for cross-reference; the actual gate logic lives in watcher.ts +
 * the startup-scan loop in index.ts. */
export const ALWAYS_PASS_TYPES: ReadonlySet<string> = new Set([
  'system',
  'session-open',
  'session-open-deferred',
  'bootstrap-conflict',
])

/** Message types that should invalidate the bootstrap cache for their channel
 * when seen by the watcher. `session-open` is the unblock signal;
 * `bootstrap-conflict` indicates degraded state that needs re-evaluation. */
export const CACHE_INVALIDATING_TYPES: ReadonlySet<string> = new Set([
  'session-open',
  'bootstrap-conflict',
])

// ── Pure history-walk state computation ───────────────────────────────────

interface TimedEvent {
  iso: string
  path: string
}

/** Walk a channel's history and return the most recent `type: session-open`
 * message, or null if none exists. */
export function findLastSessionOpen(channelDir: string): TimedEvent | null {
  return findLastMessageMatching(channelDir, (data) => String(data.type ?? '') === 'session-open')
}

/** Walk a channel's history and return the most recent `type: bootstrap-conflict`
 * message, or null if none. Used by `isChannelBootstrapped` to detect the
 * conflict-state degraded mode. */
export function findLastBootstrapConflict(channelDir: string): TimedEvent | null {
  return findLastMessageMatching(channelDir, (data) => String(data.type ?? '') === 'bootstrap-conflict')
}

/** Walk `_system/` and return the most recent `type: system, reason: offline`
 * message authored by a coordinator-eligible actor (currently any actor in
 * the merged registry — alpha.5+ refines this to per-template coordinator
 * eligibility). The `from:` field on watcher-emitted system messages is
 * always literally "watcher", so we treat any offline event as a session
 * boundary in alpha.2. */
export function findLastSessionBoundary(systemDir: string, _registry: Registry): TimedEvent | null {
  return findLastMessageMatching(systemDir, (data) => {
    return String(data.type ?? '') === 'system' && String(data.reason ?? '') === 'offline'
  })
}

/** Generic backwards-walk helper — walks YYYY/MM/DD/HHMMSSsssZ.md tree under
 * a directory, newest first, returns the first message whose frontmatter
 * matches the predicate. Returns null if none. */
function findLastMessageMatching(
  baseDir: string,
  predicate: (data: Record<string, unknown>) => boolean,
): TimedEvent | null {
  if (!existsSync(baseDir)) return null

  let years: string[] = []
  try {
    years = readdirSync(baseDir).filter(e => YEAR_RE.test(e)).sort().reverse()
  } catch {
    return null
  }

  for (const y of years) {
    let months: string[] = []
    try {
      months = readdirSync(join(baseDir, y)).filter(e => DD_RE.test(e)).sort().reverse()
    } catch { continue }

    for (const m of months) {
      let days: string[] = []
      try {
        days = readdirSync(join(baseDir, y, m)).filter(e => DD_RE.test(e)).sort().reverse()
      } catch { continue }

      for (const d of days) {
        let files: string[] = []
        try {
          files = readdirSync(join(baseDir, y, m, d)).filter(e => MSG_RE.test(e)).sort().reverse()
        } catch { continue }

        for (const f of files) {
          const path = join(y, m, d, f)
          const fullPath = join(baseDir, path)
          let content: string
          try {
            content = readFileSync(fullPath, 'utf-8')
          } catch { continue }

          let data: Record<string, unknown>
          try {
            data = parseFrontmatter(content).data
          } catch { continue }

          if (predicate(data)) {
            const t = f.slice(0, 9)
            const iso = String(data.timestamp ?? `${y}-${m}-${d}T${t.slice(0,2)}:${t.slice(2,4)}:${t.slice(4,6)}.${t.slice(6,9)}Z`)
            return { iso, path }
          }
        }
      }
    }
  }
  return null
}

/** Pure read-only state computation. Walks both the channel's message history
 * and `_system/` to determine whether the channel is currently bootstrapped.
 *
 * Decision table:
 *   no session-open ever, no boundary ever → deferred (first-ever session;
 *     waiting for coordinator to post session-open)
 *   no session-open, boundary exists, within timeout → deferred (waiting for
 *     coordinator to post session-open)
 *   no session-open, boundary exists, past timeout → open (degraded mode)
 *   session-open exists, no boundary → open (session was opened; never closed)
 *   session-open exists, boundary exists, session-open is more recent → open
 *     (current session)
 *   session-open exists, boundary exists, boundary is more recent, within
 *     timeout → deferred (waiting for next session-open)
 *   session-open exists, boundary exists, boundary is more recent, past
 *     timeout → open (degraded mode)
 */
export function isChannelBootstrapped(
  channelDir: string,
  systemDir: string,
  registry: Registry,
  opts: BootstrapOpts,
  now: number = Date.now(),
): BootstrapState {
  // First compute baseline open/deferred state.
  const baseline = computeBaselineState(channelDir, systemDir, registry, opts, now)

  // Then check for conflict state — bootstrap-conflict messages override
  // open/deferred if no session-open has been posted after the conflict.
  // Operators resolve conflict by amending/removing conflicting messages,
  // then posting a new session-open which lands AFTER the conflict and
  // clears it.
  const lastConflict = findLastBootstrapConflict(channelDir)
  if (!lastConflict) return baseline

  const lastOpen = findLastSessionOpen(channelDir)
  if (!lastOpen) return 'conflict'

  const conflictTime = Date.parse(lastConflict.iso)
  const openTime     = Date.parse(lastOpen.iso)
  if (!Number.isFinite(conflictTime) || !Number.isFinite(openTime)) return 'conflict'

  // If session-open is more recent than conflict, conflict is cleared
  return openTime > conflictTime ? baseline : 'conflict'
}

function computeBaselineState(
  channelDir: string,
  systemDir: string,
  registry: Registry,
  opts: BootstrapOpts,
  now: number,
): 'open' | 'deferred' {
  const lastOpen = findLastSessionOpen(channelDir)
  const lastBoundary = findLastSessionBoundary(systemDir, registry)

  if (!lastOpen && !lastBoundary) return 'deferred'

  if (!lastOpen) {
    const boundaryTime = Date.parse(lastBoundary!.iso)
    if (!Number.isFinite(boundaryTime)) return 'deferred'
    return now - boundaryTime > opts.timeoutMs ? 'open' : 'deferred'
  }

  if (!lastBoundary) return 'open'

  const openTime = Date.parse(lastOpen.iso)
  const boundaryTime = Date.parse(lastBoundary.iso)
  if (!Number.isFinite(openTime) || !Number.isFinite(boundaryTime)) return 'open'

  if (openTime > boundaryTime) return 'open'
  return now - boundaryTime > opts.timeoutMs ? 'open' : 'deferred'
}

// ── Stateful cache wrapper ────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000  // 60s — bounds staleness for missed remote-offline events

interface CacheEntry {
  state: BootstrapState
  computedAt: number
}

/** Wraps `isChannelBootstrapped` with a 60-second TTL + explicit invalidation
 * hooks. The watcher holds one instance for the daemon's lifetime; the
 * dispatch hot path calls `get(channelGuid)` per message. Steady-state-open
 * cost is one Map lookup + Date.now() compare. Cache misses (TTL expiry,
 * explicit invalidation, never-seen channel) trigger a history walk per the
 * pure function above. */
export class BootstrapStateCache {
  private cache = new Map<string, CacheEntry>()

  constructor(
    private readonly transportRoot: string,
    private readonly getRegistry: () => Registry,
    private readonly opts: BootstrapOpts,
  ) {}

  get(channelGuid: string): BootstrapState {
    const entry = this.cache.get(channelGuid)
    const now = Date.now()
    if (entry && now - entry.computedAt < CACHE_TTL_MS) return entry.state

    const channelDir = join(this.transportRoot, 'channels', channelGuid)
    const systemDir = join(this.transportRoot, '_system')
    const state = isChannelBootstrapped(channelDir, systemDir, this.getRegistry(), this.opts, now)
    this.cache.set(channelGuid, { state, computedAt: now })
    return state
  }

  invalidate(channelGuid: string): void {
    this.cache.delete(channelGuid)
  }

  invalidateAll(): void {
    this.cache.clear()
  }
}

// ── All-actors set (governance lens, not dispatch lens) ──────────────────

/** Walk the three actor layers (framework + custom + local) and return ALL
 * actor profiles regardless of dispatchability. The dispatch registry filters
 * out actors without `agent`/`command` (humans, by definition), but for
 * governance purposes — coordinator selection, presence-tracking — we need
 * to see every actor profile this machine knows about, including humans.
 *
 * Last-wins on name collision (matches the registry's three-layer ordering). */
export function listAllActorProfiles(
  transportRoot: string,
  /** v1.3.0-alpha.7+ — when this daemon runs in multi-operator mode
   * (operator handle set in config), machine actors are qualified to
   * canonical addresses (`alice` → `alice@steve`) and humans stay
   * bare. This keeps governance (coordinator selection, presence
   * tracking) using the same address identity as dispatch, signing,
   * and message `from:` fields — so a session-open posted by the
   * bootstrap pass carries `from: alice@steve` not `from: alice`,
   * and the receiving daemon's self-loop check works correctly. */
  operator?: string,
): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>()
  const dirs = [
    join(transportRoot, 'manifest', 'framework', 'actors'),
    join(transportRoot, 'manifest', 'custom', 'actors'),
  ]
  // v1.4.0-alpha.1+ — operator-scoped layer. Only consulted when this
  // daemon has an operator handle, matching the same gating as
  // registry.ts loadRegistry so the governance lens stays in sync with
  // the dispatch lens.
  if (operator) {
    dirs.push(join(transportRoot, 'manifest', 'operators', operator, 'actors'))
  }
  dirs.push(join(homedir(), '.crosstalk', 'actors'))
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    let files: string[] = []
    try { files = readdirSync(dir) } catch { continue }
    for (const f of files) {
      if (!f.endsWith('.md') || f.startsWith('_')) continue
      const name = f.slice(0, -3)
      let content: string
      try { content = readFileSync(join(dir, f), 'utf-8') } catch { continue }
      try {
        const { data } = parseFrontmatter(content)
        const isHuman = String(data.type ?? '') === 'human'
        // Machine actors get @operator qualification in multi-op mode;
        // humans always stay bare; single-op mode (no operator) keeps
        // every name bare (v1.2 behavior).
        const key = operator && !isHuman ? `${name}@${operator}` : name
        out.set(key, data)
      } catch { /* skip */ }
    }
  }
  return out
}

// ── Coordinator selection ─────────────────────────────────────────────────

export interface CoordinatorDecision {
  should: boolean
  coordinatorActor?: string
  reason: string
}

/** Decide whether this daemon hosts the coordinator. Resolution order:
 * 1. **v1.4.0-alpha.2+** — config-designated `bootstrap.coordinator-address`.
 *    Wins over everything else. This daemon coordinates iff:
 *    - machine address (alice@steve): our operator handle matches the
 *      operator part
 *    - human address (steve): our default-human-actor matches the name
 *    Built for the multi-op case where two daemons race to post
 *    session-open and storm git push contention. Setting this on each
 *    daemon's config gives one authoritative coordinator and lets the
 *    others skip bootstrap entirely.
 * 2. Active ROE has `coordinator: <name>` field → if `<name>` is in our
 *    all-actors set (governance lens, not dispatch registry), we coordinate.
 *    If `<name>` is named but not in our all-actors set, we don't coordinate
 *    (the other machine does).
 * 3. No ROE coordinator field: permissive fallback to first-actor-by-
 *    `joined-at`. Multi-coordinator races are possible if both machines
 *    have the same actor, but `session-open` is idempotent at the channel
 *    level (cache shows 'open' once any lands).
 * 4. No actors with `joined-at` field: alphabetic name order as last resort.
 *
 * NOTE: uses the all-actors set, not the dispatch registry. The dispatch
 * registry filters out actors without `agent`/`command` (humans), but
 * coordinators in real templates are typically humans (Monarch, Speaker,
 * Scrum Master, Conductor). Using the dispatch registry would never let a
 * human coordinate, which contradicts the entire BOOTSTRAP.md spec.
 */
export function shouldRunBootstrapPass(
  transportRoot: string,
  _dispatchRegistry: Registry,  // accepted but ignored — see NOTE above
  /** v1.3.0-alpha.7+ — daemon's operator handle (config.operator). Passed
   * through to listAllActorProfiles so coordinator selection sees
   * canonical addresses (alice@steve) rather than filename-bare names
   * in multi-op mode. session-open then posts `from: <canonical>`
   * which lets the receiving daemon's self-loop check work. */
  operator?: string,
  /** v1.4.0-alpha.2+ — config.bootstrap.coordinatorAddress. When set,
   * resolution is fully deterministic: this daemon coordinates iff it
   * owns the address. */
  coordinatorAddress?: string,
  /** v1.4.0-alpha.2+ — config.defaultHumanActor. Used to decide
   * coordination when `coordinatorAddress` is a bare human name —
   * the daemon's local human identity must match. */
  defaultHumanActor?: string,
): CoordinatorDecision {
  // v1.4.0-alpha.2+ — config-designated coordinator wins. Authoritative
  // when set; no race, no fallback.
  if (coordinatorAddress) {
    const parsed = parseAddress(coordinatorAddress)
    if (isAddressError(parsed)) {
      return { should: false, reason: `bootstrap.coordinator-address "${coordinatorAddress}" is malformed: ${parsed.message}` }
    }
    if (parsed.kind === 'human') {
      if (defaultHumanActor === parsed.name) {
        return { should: true, coordinatorActor: parsed.name, reason: `config bootstrap.coordinator-address designates human '${parsed.name}' and this daemon's default-human-actor matches` }
      }
      return { should: false, reason: `config bootstrap.coordinator-address designates human '${parsed.name}'; this daemon's default-human-actor (${defaultHumanActor ?? 'unset'}) does not match — another machine coordinates` }
    }
    // machine address — operator part must match
    if (parsed.operator === operator) {
      return { should: true, coordinatorActor: coordinatorAddress, reason: `config bootstrap.coordinator-address designates '${coordinatorAddress}' and this daemon's operator handle matches` }
    }
    return { should: false, reason: `config bootstrap.coordinator-address designates '${coordinatorAddress}'; this daemon's operator ('${operator ?? 'unset'}') does not match — another machine coordinates` }
  }

  const allActors = listAllActorProfiles(transportRoot, operator)
  const fromROE = readCoordinatorFromROE(transportRoot)
  if (fromROE) {
    if (allActors.has(fromROE)) {
      return { should: true, coordinatorActor: fromROE, reason: `ROE coordinator field designates '${fromROE}'` }
    }
    return { should: false, reason: `ROE designates '${fromROE}' as coordinator; not in our actor profiles — another machine coordinates` }
  }

  // Permissive fallback: first-actor-by-joined-at across the all-actors set
  const withJoinedAt = [...allActors.entries()]
    .filter(([, data]) => typeof data['joined-at'] === 'string')
    .sort((a, b) => String(a[1]['joined-at']).localeCompare(String(b[1]['joined-at'])))
  if (withJoinedAt.length > 0) {
    return { should: true, coordinatorActor: withJoinedAt[0][0], reason: 'first-actor-by-joined-at fallback (no ROE coordinator field)' }
  }

  const namesByName = [...allActors.keys()].sort()
  if (namesByName.length > 0) {
    return { should: true, coordinatorActor: namesByName[0], reason: 'first-actor-by-name fallback (no joined-at on any actor)' }
  }

  return { should: false, reason: 'no actor profiles found in framework/custom/local layers' }
}

function readCoordinatorFromROE(transportRoot: string): string | null {
  for (const layer of ['custom', 'framework']) {
    const path = join(transportRoot, 'manifest', layer, 'protocol', 'ROE.md')
    if (!existsSync(path)) continue
    let content: string
    try {
      content = readFileSync(path, 'utf-8')
    } catch { continue }
    // Look for `coordinator: <name>` (kebab-case) — case-insensitive match on
    // the field name; the value must be kebab-case to match an actor name.
    // Bracketed placeholders like `[SPEAKER-ACTOR-NAME]` are deliberately
    // skipped (operator hasn't filled the field in).
    const m = content.match(/coordinator:\s*([a-z][a-z0-9]*(?:-[a-z0-9]+)*)/i)
    if (m) return m[1]
  }
  return null
}

// ── Bootstrap-pass content + posting ──────────────────────────────────────

export interface BootstrapSummary {
  onlineActors: string[]
  flaggedOffline: Array<{ name: string; lastSeen: string | null }>
  roeVersion: string
  roeLayer: 'custom' | 'framework' | 'none'
  /** Pending amendments in this channel (proposals/motions without a
   * roe-vote-result, roe-ratified, or roe-deadlock-resolution). v0.7.0-
   * alpha.5+ — empty when channelDir is omitted (back-compat). */
  pendingAmendments?: Array<{
    anchorId: string
    fromActor: string
    target: string
    voteWindow: string | null
    expired: boolean | null
    votes: { yes: number; no: number; abstain: number; total: number }
  }>
}

/** Build the bootstrap summary content. Walks `_system/` + (optionally)
 * the channel for pending amendments. Posted as the body of `session-open`.
 *
 * v0.7.0-alpha.5+ adds per-channel pending-amendment surfacing — pass
 * `channelDir` to include it. Without it, falls back to the alpha.2 MVP
 * shape (actors + ROE version only).
 *
 * v1.1.0+ — ROE version now sourced via `Transport.manifestFileVersion`
 * instead of direct `git log` execution.
 */
export async function buildBootstrapSummary(
  transport: Transport,
  transportRoot: string,
  _registry: Registry,  // accepted for backward compat; uses all-actors set internally
  channelDir?: string,
  /** v1.3.0-alpha.7+ — see listAllActorProfiles for the rationale.
   * Surfaced as `Online actors` in the session-open body using canonical
   * addresses in multi-op mode. */
  operator?: string,
): Promise<BootstrapSummary> {
  // Use the governance lens (all actor profiles), not the dispatch registry.
  // Humans are the typical coordinators in real templates and need to be
  // surfaced in the bootstrap summary.
  const allActors = listAllActorProfiles(transportRoot, operator)
  const onlineActors = [...allActors.keys()].sort()

  // alpha.2 MVP: don't try to track per-actor lastSeen — the existing
  // system.ts event format doesn't write per-actor online messages, so we
  // can't infer per-actor presence from history.
  const flaggedOffline: Array<{ name: string; lastSeen: string | null }> = []

  const roe = locateActiveROE(transportRoot)
  const roeVersion = roe ? await transport.manifestFileVersion(roe.relativePath) : 'unknown'

  // alpha.5+: surface pending amendments per channel
  let pendingAmendments: BootstrapSummary['pendingAmendments'] | undefined
  if (channelDir) {
    try {
      const { walkGovernanceMessages, findPendingAmendments } = await import('./governance.js')
      const govMessages = walkGovernanceMessages(channelDir)
      const pending = findPendingAmendments(govMessages)
      pendingAmendments = pending.map(p => ({
        anchorId: p.anchorId,
        fromActor: p.definingMessage.from,
        target: String(p.definingMessage.data.target ?? p.definingMessage.data['motion-class'] ?? '?'),
        voteWindow: typeof p.definingMessage.data['vote-window'] === 'string' ? p.definingMessage.data['vote-window'] as string : null,
        expired: p.expiredAsOf,
        votes: p.votes,
      }))
    } catch (err) {
      console.error(`[bootstrap] failed to surface pending amendments: ${err}`)
    }
  }

  return {
    onlineActors,
    flaggedOffline,
    roeVersion,
    roeLayer: roe ? roe.layer : 'none',
    pendingAmendments,
  }
}

function locateActiveROE(transportRoot: string): { relativePath: string; layer: 'custom' | 'framework' } | null {
  const candidates: Array<{ relativePath: string; layer: 'custom' | 'framework' }> = [
    { relativePath: 'manifest/custom/protocol/ROE.md', layer: 'custom' },
    { relativePath: 'manifest/framework/protocol/ROE.md', layer: 'framework' },
  ]
  for (const c of candidates) {
    if (existsSync(join(transportRoot, c.relativePath))) return c
  }
  return null
}

/** Post a `type: session-open` message via Transport.postMessage. The
 * transport handles the file write + commit + push (with all the v1.0.x
 * concurrency fixes wrapped inside). Bootstrap just builds the content. */
export async function postSessionOpen(
  transport: Transport,
  channelGuid: string,
  coordinatorActor: string,
  summary: BootstrapSummary,
  actorEmailSuffix: string,
): Promise<void> {
  const iso = new Date().toISOString()
  const sessionId = `${MACHINE_ID}-${iso}`

  const offlineSection = summary.flaggedOffline.length === 0
    ? '- (none)'
    : summary.flaggedOffline.map(f => `- ${f.name}${f.lastSeen ? ` (last seen ${f.lastSeen})` : ''}`).join('\n')

  const pendingSection = !summary.pendingAmendments || summary.pendingAmendments.length === 0
    ? '- (none)'
    : summary.pendingAmendments.map(p =>
        `- \`${p.anchorId}\` from ${p.fromActor} (target: ${p.target}, vote-window: ${p.voteWindow ?? 'none'}, ` +
        `${p.expired === true ? 'EXPIRED' : p.expired === false ? 'within window' : 'unknown'}, ` +
        `votes: y=${p.votes.yes}/n=${p.votes.no}/a=${p.votes.abstain})`
      ).join('\n')

  const body =
    `---\n` +
    `from: ${coordinatorActor}\n` +
    `to: all\n` +
    `timestamp: ${iso}\n` +
    `type: session-open\n` +
    `session-id: ${sessionId}\n` +
    `roe-version: ${summary.roeVersion}\n` +
    `opened-at: ${iso}\n` +
    `---\n\n` +
    `## Bootstrap summary\n\n` +
    `- Active ROE layer: ${summary.roeLayer}\n` +
    `- Active ROE version: ${summary.roeVersion}\n` +
    `- Online actors: ${summary.onlineActors.join(', ') || '(none)'}\n` +
    `- Offline actors flagged:\n  ${offlineSection.split('\n').join('\n  ')}\n\n` +
    `## Pending amendments\n\n` +
    `${pendingSection}\n`

  // v1.3.0-alpha.6+ — `coordinatorActor` may be a qualified multi-operator
  // address (`alice@steve`) when the daemon is in multi-op mode and the
  // ROE coordinator field designates a qualified actor. machineGitEmail
  // sanitises the `@` to `.` for the email local part; the ActorIdentity
  // name stays as the canonical address.
  const identity: ActorIdentity = {
    name: coordinatorActor,
    email: machineGitEmail(coordinatorActor, actorEmailSuffix),
  }

  try {
    await transport.postMessage(channelGuid, identity, body)
  } catch (err) {
    console.error(`[bootstrap] failed to post session-open: ${err}`)
    throw err
  }
}
