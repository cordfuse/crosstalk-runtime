/**
 * Runtime-side governance logic — runtime enforcement of v0.7.0 framework
 * specs (`AMENDMENT.md`, `DEADLOCK.md`, `BOOTSTRAP.md`).
 *
 * Distinct from `src/cli/lib/governance.ts` (which is operator-tools-side,
 * powering `crosstalk roe audit/validate`). This module powers daemon-side
 * decisions: pending-amendment detection during bootstrap, inconsistency
 * detection for `bootstrap-conflict` routing, time-decay automation per
 * DEADLOCK.md.
 *
 * Module owns:
 * - Walking channel history for governance messages
 * - Finding pending amendments (proposals/motions without `roe-vote-result`)
 * - Finding inconsistencies (multiple conflicting `roe-vote-result` for same
 *   anchor; `roe-ratified` referencing a commit SHA that doesn't resolve)
 * - Finding expired vote-windows (for time-decay auto-resolution)
 * - Reading the deadlock-pattern config from active ROE
 * - Writing `roe-deadlock-resolution` for time-decay auto-resolutions
 * - Writing `bootstrap-conflict` messages when bootstrap pass detects
 *   inconsistent state
 * - The periodic decay-check loop (`startDecayChecker`)
 *
 * Module does NOT own:
 * - Bootstrap state machine ('open'/'deferred'/'conflict') — that's `bootstrap.ts`
 * - The watcher dispatch hot path — that's `watcher.ts`
 * - Per-template semantic enforcement — that's alpha.6+ work
 */
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { mkdir, writeFile } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { parseFrontmatter } from './frontmatter.js'
import { hasRemote, pushWithRetry } from './git.js'
import { messageFilename, messageDatePath, MESSAGE_FILE_RE } from './filenames.js'

const execFileP = promisify(execFile)

const YEAR_RE = /^\d{4}$/
const DD_RE   = /^\d{2}$/

// ── Types (local to runtime layer) ────────────────────────────────────────

export const ROE_TYPE_SET: ReadonlySet<string> = new Set([
  'roe-amendment-proposal',
  'roe-second',
  'roe-motion',
  'roe-vote',
  'roe-vote-open',
  'roe-vote-close',
  'roe-vote-result',
  'roe-ratified',
  'roe-amendment-notice',
  'roe-monarch-transfer',
  'roe-conductor-transfer',
  'roe-speaker-handoff',
  'roe-deadlock-resolution',
  'session-open',
  'session-open-deferred',
  'bootstrap-conflict',
])

export interface GovernanceMessage {
  timestamp: string
  from:      string
  to:        string
  type:      string
  data:      Record<string, unknown>
  body:      string
  path:      string  // relative to channel dir (or _system/, etc.)
}

// ── Channel-history walking ──────────────────────────────────────────────

/** Walk a channel directory and return all governance messages (the `roe-*`
 * family + session-open + bootstrap-conflict), in chronological order. */
export function walkGovernanceMessages(channelDir: string): GovernanceMessage[] {
  const out: GovernanceMessage[] = []
  if (!existsSync(channelDir)) return out

  let years: string[] = []
  try { years = readdirSync(channelDir).filter(e => YEAR_RE.test(e)).sort() } catch { return out }

  for (const y of years) {
    let months: string[] = []
    try { months = readdirSync(join(channelDir, y)).filter(e => DD_RE.test(e)).sort() } catch { continue }
    for (const m of months) {
      let days: string[] = []
      try { days = readdirSync(join(channelDir, y, m)).filter(e => DD_RE.test(e)).sort() } catch { continue }
      for (const d of days) {
        let files: string[] = []
        try { files = readdirSync(join(channelDir, y, m, d)).filter(e => MESSAGE_FILE_RE.test(e)).sort() } catch { continue }
        for (const f of files) {
          const path = join(y, m, d, f)
          let content: string
          try { content = readFileSync(join(channelDir, path), 'utf-8') } catch { continue }
          let parsed: { data: Record<string, unknown>; body: string }
          try { parsed = parseFrontmatter(content) } catch { continue }
          const type = String(parsed.data.type ?? '')
          if (!ROE_TYPE_SET.has(type)) continue
          // ISO from filename (HHMMSSsss prefix at chars 0-8)
          const t = f.slice(0, 9)
          const iso = String(parsed.data.timestamp ?? `${y}-${m}-${d}T${t.slice(0,2)}:${t.slice(2,4)}:${t.slice(4,6)}.${t.slice(6,9)}Z`)
          out.push({
            timestamp: iso,
            from:      String(parsed.data.from ?? '?'),
            to:        String(parsed.data.to ?? '?'),
            type,
            data:      parsed.data,
            body:      parsed.body.trim(),
            path,
          })
        }
      }
    }
  }
  return out
}

/** Get the proposal/motion id this message anchors to, or null. */
function anchorId(m: GovernanceMessage): string | null {
  const d = m.data
  if (m.type === 'roe-amendment-proposal' && typeof d['proposal-id'] === 'string') return d['proposal-id'] as string
  if (m.type === 'roe-motion' && typeof d['motion-id'] === 'string')               return d['motion-id'] as string
  if (typeof d.on === 'string' && d.on.trim())                                     return d.on as string
  if (typeof d.seconds === 'string' && d.seconds.trim())                           return d.seconds as string
  return null
}

// ── Vote tally (template-aware) ──────────────────────────────────────────

export interface VoteTally {
  yes:              number
  no:               number
  abstain:          number
  totalCast:        number
  ineligibleVotes:  number  // vote messages from non-members (per template)
  expiredVotes:     number  // votes after vote-window expiry
  quorumMet:        boolean | null  // null when template doesn't specify quorum
  ratified:         'passed' | 'failed' | 'tied' | 'quorum-failed'
  threshold:        'simple-majority' | 'two-thirds' | 'consensus' | null
  reason:           string
}

/** Compute the result of voting on a proposal/motion, applying template-
 * specific rules (member-only voting for Parliamentary, two-thirds
 * threshold for amendments, quorum check, vote-window expiry). Used both
 * by `crosstalk roe validate` to surface semantic issues and by future
 * auto-tally logic when a vote-window expires and no roe-vote-result
 * has been posted.
 *
 * `templateConfig` may be null — then this is a permissive tally with
 * no eligibility check (everyone counts) and simple-majority threshold.
 *
 * `isAmendment` controls which threshold applies: true → amendment
 * threshold (typically two-thirds for Parliamentary); false → motion
 * threshold (typically simple-majority).
 */
export function computeTally(
  proposalAnchorId: string,
  messages: GovernanceMessage[],
  templateConfig: import('./templates.js').TemplateConfig,
  isAmendment: boolean = false,
  asOf: number = Date.now(),
): VoteTally {
  // Find the defining proposal/motion
  const definingMessage = messages.find(m =>
    (m.type === 'roe-amendment-proposal' || m.type === 'roe-motion') &&
    (m.data['proposal-id'] === proposalAnchorId || m.data['motion-id'] === proposalAnchorId)
  )

  // Determine eligible-voter set per template
  let eligibleVoters: Set<string> | null = null
  if (templateConfig) {
    if (templateConfig.template === 'parliamentary') eligibleVoters = new Set(templateConfig.members)
    if (templateConfig.template === 'scrum')         eligibleVoters = new Set(templateConfig.team)
    if (templateConfig.template === 'casual')        eligibleVoters = new Set(templateConfig.humans)
    // Monarchy + Conductor-Orchestra don't vote — eligibleVoters stays null (or empty)
    if (templateConfig.template === 'monarchy' || templateConfig.template === 'conductor-orchestra') {
      eligibleVoters = new Set()
    }
  }

  // Determine vote-window expiry
  let voteWindowMs: number | null = null
  let proposalTimeMs: number | null = null
  if (definingMessage) {
    const window = typeof definingMessage.data['vote-window'] === 'string' ? definingMessage.data['vote-window'] as string : null
    if (window) voteWindowMs = parseIsoDuration(window)
    const t = Date.parse(definingMessage.timestamp)
    if (Number.isFinite(t)) proposalTimeMs = t
  }

  // Detect Scrum role-change (per Scrum template spec — alpha.7+)
  const isScrumRoleChange = templateConfig?.template === 'scrum' && definingMessage &&
    isRoleChangeTarget(String(definingMessage.data.target ?? ''))

  // Track latest vote per voter to compute role-change consent correctly
  // (a voter's most-recent vote wins; per AMENDMENT.md votes are append-only
  // but operators may post a corrective vote — most recent counts).
  const latestVoteByVoter = new Map<string, 'yes' | 'no' | 'abstain'>()

  // Tally
  const tally = { yes: 0, no: 0, abstain: 0, totalCast: 0, ineligibleVotes: 0, expiredVotes: 0 }
  for (const m of messages) {
    if (m.type !== 'roe-vote') continue
    if (m.data.on !== proposalAnchorId) continue

    // Eligibility check
    if (eligibleVoters && !eligibleVoters.has(m.from)) {
      tally.ineligibleVotes++
      continue
    }

    // Vote-window check (votes after expiry are excluded from tally)
    if (voteWindowMs !== null && proposalTimeMs !== null) {
      const voteTime = Date.parse(m.timestamp)
      if (Number.isFinite(voteTime) && voteTime > proposalTimeMs + voteWindowMs) {
        tally.expiredVotes++
        continue
      }
    }

    const v = String(m.data.vote ?? '')
    if (v === 'yes' || v === 'no' || v === 'abstain') {
      latestVoteByVoter.set(m.from, v as 'yes' | 'no' | 'abstain')
    }
    if (v === 'yes')     { tally.yes++;     tally.totalCast++ }
    if (v === 'no')      { tally.no++;      tally.totalCast++ }
    if (v === 'abstain') { tally.abstain++; tally.totalCast++ }
  }

  // Threshold
  let threshold: VoteTally['threshold'] = null
  if (templateConfig?.template === 'parliamentary') {
    threshold = isAmendment ? (templateConfig.amendmentThreshold ?? 'two-thirds') : 'simple-majority'
  } else if (templateConfig?.template === 'casual') {
    threshold = 'consensus'
  } else if (templateConfig?.template === 'scrum') {
    threshold = 'simple-majority'  // for non-role-change votes; role-change requires PO+SM consent (separate path)
  }

  // Quorum
  let quorum: number | null = null
  let quorumMet: boolean | null = null
  if (templateConfig?.template === 'parliamentary') {
    quorum = templateConfig.quorum
    if (quorum !== null) {
      const nonAbstain = tally.yes + tally.no
      quorumMet = nonAbstain >= quorum
    }
  } else if (templateConfig?.template === 'casual') {
    // Consensus = N% of humans must affirmatively vote yes (no quorum gate; we
    // just check the ratio).
    quorumMet = true  // no quorum requirement; consensus checked at threshold step
  }

  // Scrum role-change consent: BOTH PO and SM must have voted yes
  // (per Scrum template spec). Override threshold path with this check.
  if (isScrumRoleChange && templateConfig?.template === 'scrum') {
    const po = templateConfig.productOwner
    const sm = templateConfig.scrumMaster
    const poVote = po ? latestVoteByVoter.get(po) : null
    const smVote = sm ? latestVoteByVoter.get(sm) : null
    const poConsented = poVote === 'yes'
    const smConsented = smVote === 'yes'
    if (poConsented && smConsented) {
      return {
        ...tally, quorumMet: true, ratified: 'passed', threshold: 'consensus',
        reason: `Scrum role-change: PO (${po}) + SM (${sm}) both consented`,
      }
    }
    return {
      ...tally, quorumMet: null, ratified: 'failed', threshold: 'consensus',
      reason: `Scrum role-change requires PO + SM both consent (yes-vote). PO=${po}:${poVote ?? 'missing'}, SM=${sm}:${smVote ?? 'missing'}`,
    }
  }

  // Ratification decision
  const nonAbstain = tally.yes + tally.no
  let ratified: VoteTally['ratified'] = 'failed'
  let reason = ''

  if (quorumMet === false) {
    ratified = 'quorum-failed'
    reason = `quorum not met: ${nonAbstain} non-abstain vote(s), need ${quorum}`
  } else if (threshold === 'simple-majority') {
    if (tally.yes > tally.no)      { ratified = 'passed'; reason = 'simple majority' }
    else if (tally.yes < tally.no) { ratified = 'failed'; reason = 'simple majority against' }
    else                            { ratified = 'tied';   reason = 'tied vote' }
  } else if (threshold === 'two-thirds') {
    if (nonAbstain === 0) { ratified = 'failed'; reason = 'no non-abstain votes' }
    else if (tally.yes / nonAbstain >= 2 / 3) { ratified = 'passed'; reason = `${tally.yes}/${nonAbstain} >= 2/3` }
    else                                      { ratified = 'failed'; reason = `${tally.yes}/${nonAbstain} < 2/3` }
  } else if (threshold === 'consensus') {
    const total = templateConfig?.template === 'casual' ? (templateConfig.humans.length || 1) : (nonAbstain || 1)
    const ratio = tally.yes / total
    const consensusThreshold = templateConfig?.template === 'casual' ? templateConfig.consensusThreshold : 0.51
    if (ratio >= consensusThreshold) { ratified = 'passed'; reason = `${(ratio*100).toFixed(0)}% >= consensus threshold ${(consensusThreshold*100).toFixed(0)}%` }
    else                              { ratified = 'failed'; reason = `${(ratio*100).toFixed(0)}% < consensus threshold ${(consensusThreshold*100).toFixed(0)}%` }
  } else {
    // No template → permissive simple-majority
    if (tally.yes > tally.no)      { ratified = 'passed'; reason = 'simple majority (no template)' }
    else if (tally.yes < tally.no) { ratified = 'failed'; reason = 'simple majority against (no template)' }
    else                            { ratified = 'tied';   reason = 'tied vote (no template)' }
  }

  return { ...tally, quorumMet, ratified, threshold, reason }
}

// ── Pending amendments + inconsistencies ─────────────────────────────────

export interface PendingAmendment {
  anchorId:        string
  definingMessage: GovernanceMessage  // the roe-amendment-proposal or roe-motion
  voteWindowMs:    number | null      // parsed vote-window in ms
  votes:           { yes: number; no: number; abstain: number; total: number }
  expiredAsOf:     boolean | null     // null if vote-window unparseable; otherwise true if asOf is past expiry
  ratified:        boolean
  resolvedBy:      'roe-vote-result' | 'roe-ratified' | 'roe-deadlock-resolution' | null
}

/** Find proposals/motions in this channel that DON'T yet have a resolution
 * (no roe-vote-result, no roe-ratified, no roe-deadlock-resolution).
 * Used by bootstrap-pass content + time-decay automation. */
export function findPendingAmendments(messages: GovernanceMessage[], asOf: number = Date.now()): PendingAmendment[] {
  // Group by anchor
  const byAnchor = new Map<string, GovernanceMessage[]>()
  for (const m of messages) {
    const id = anchorId(m)
    if (!id) continue
    if (!byAnchor.has(id)) byAnchor.set(id, [])
    byAnchor.get(id)!.push(m)
  }

  const pending: PendingAmendment[] = []
  for (const [id, group] of byAnchor) {
    const definingMessage = group.find(m => m.type === 'roe-amendment-proposal' || m.type === 'roe-motion')
    if (!definingMessage) continue  // no defining message in this channel — orphan vote/second/etc.

    const result = group.find(m => m.type === 'roe-vote-result')
    const ratified = group.some(m => m.type === 'roe-ratified')
    const deadlockResolved = group.some(m => m.type === 'roe-deadlock-resolution')

    const resolvedBy: PendingAmendment['resolvedBy'] = ratified
      ? 'roe-ratified'
      : (result ? 'roe-vote-result' : (deadlockResolved ? 'roe-deadlock-resolution' : null))

    if (resolvedBy) continue  // resolved → not pending

    const votes = { yes: 0, no: 0, abstain: 0, total: 0 }
    for (const m of group) {
      if (m.type !== 'roe-vote') continue
      const v = String(m.data.vote ?? '')
      if (v === 'yes')     votes.yes++
      if (v === 'no')      votes.no++
      if (v === 'abstain') votes.abstain++
      votes.total++
    }

    const voteWindowStr = typeof definingMessage.data['vote-window'] === 'string' ? definingMessage.data['vote-window'] as string : null
    const voteWindowMs = voteWindowStr ? parseIsoDuration(voteWindowStr) : null
    let expiredAsOf: boolean | null = null
    if (voteWindowMs !== null) {
      const proposalTime = Date.parse(definingMessage.timestamp)
      if (Number.isFinite(proposalTime)) {
        expiredAsOf = asOf > proposalTime + voteWindowMs
      }
    }

    pending.push({ anchorId: id, definingMessage, voteWindowMs, votes, expiredAsOf, ratified: false, resolvedBy: null })
  }
  return pending
}

export interface Inconsistency {
  kind:       'conflicting-vote-result' | 'orphan-vote' | 'duplicate-anchor-id'
  anchorId:   string
  details:    string
  paths:      string[]
}

/** Find inconsistencies in channel governance state. Used by bootstrap pass
 * to decide whether to post `bootstrap-conflict`. */
export function findInconsistencies(messages: GovernanceMessage[]): Inconsistency[] {
  const out: Inconsistency[] = []
  const byAnchor = new Map<string, GovernanceMessage[]>()
  for (const m of messages) {
    const id = anchorId(m)
    if (!id) continue
    if (!byAnchor.has(id)) byAnchor.set(id, [])
    byAnchor.get(id)!.push(m)
  }

  // Detect conflicting vote-results for the same anchor
  for (const [id, group] of byAnchor) {
    const results = group.filter(m => m.type === 'roe-vote-result')
    if (results.length > 1) {
      const outcomes = new Set(results.map(r => String(r.data.result ?? '?')))
      if (outcomes.size > 1) {
        out.push({
          kind: 'conflicting-vote-result',
          anchorId: id,
          details: `multiple roe-vote-result with different outcomes: ${[...outcomes].join(', ')}`,
          paths: results.map(r => r.path),
        })
      }
    }

    // Detect orphan votes: roe-vote without a corresponding roe-amendment-proposal/roe-motion
    const definingMessage = group.find(m => m.type === 'roe-amendment-proposal' || m.type === 'roe-motion')
    if (!definingMessage) {
      const orphans = group.filter(m => m.type === 'roe-vote' || m.type === 'roe-second' || m.type === 'roe-vote-result')
      if (orphans.length > 0) {
        out.push({
          kind: 'orphan-vote',
          anchorId: id,
          details: `${orphans.length} message(s) reference '${id}' but no defining proposal/motion exists in channel`,
          paths: orphans.map(o => o.path),
        })
      }
    }
  }

  // Duplicate proposal-id detection (same id defined twice)
  const definingByAnchor = new Map<string, GovernanceMessage[]>()
  for (const m of messages) {
    if (m.type !== 'roe-amendment-proposal' && m.type !== 'roe-motion') continue
    const id = anchorId(m)
    if (!id) continue
    if (!definingByAnchor.has(id)) definingByAnchor.set(id, [])
    definingByAnchor.get(id)!.push(m)
  }
  for (const [id, defs] of definingByAnchor) {
    if (defs.length > 1) {
      out.push({
        kind: 'duplicate-anchor-id',
        anchorId: id,
        details: `${defs.length} defining messages with the same anchor id`,
        paths: defs.map(d => d.path),
      })
    }
  }

  return out
}

// ── Deadlock config + time-decay automation ──────────────────────────────

export interface DeadlockConfig {
  /** Pattern from active ROE: 'time-decay' | 'status-quo-wins' | 'designated-escalator' | 'seniority' | null */
  pattern: string | null
  /** Decay timer beyond vote-window — only meaningful for time-decay pattern. */
  decayAfterMs: number | null
  /** Default outcome when decay fires: 'status-quo-wins' | 'failed' | 'passed' (operator choice). */
  defaultOutcome: string | null
}

/** Read deadlock config from the active ROE (`manifest/custom/protocol/ROE.md`
 * falling through to framework). Returns nulls for any field not present. */
export function readDeadlockConfig(transportRoot: string): DeadlockConfig {
  for (const layer of ['custom', 'framework']) {
    const p = join(transportRoot, 'manifest', layer, 'protocol', 'ROE.md')
    if (!existsSync(p)) continue
    let content: string
    try { content = readFileSync(p, 'utf-8') } catch { continue }
    const pattern = matchKeyValue(content, 'deadlock-pattern')
    const decayAfter = matchKeyValue(content, 'deadlock-decay-after')
    const defaultOutcome = matchKeyValue(content, 'deadlock-default')
    return {
      pattern,
      decayAfterMs: decayAfter ? parseIsoDuration(decayAfter) : null,
      defaultOutcome,
    }
  }
  return { pattern: null, decayAfterMs: null, defaultOutcome: null }
}

function matchKeyValue(content: string, key: string): string | null {
  const re = new RegExp(`^\\s*${key}:\\s*(\\S+)\\s*$`, 'mi')
  const m = content.match(re)
  return m ? m[1] : null
}

/** Atomic write + commit + push of a `type: roe-deadlock-resolution` message. */
export async function postDeadlockResolution(
  transportRoot: string,
  channelGuid: string,
  fromActor: string,
  anchorId: string,
  resolution: 'passed' | 'failed',
  basis: 'time-decay' | 'seniority' | 'designated-escalator' | 'other',
  rationale: string,
  actorEmailSuffix: string,
): Promise<void> {
  const d = new Date()
  const datePath = messageDatePath(d)
  const fileName = messageFilename(d)
  const iso = d.toISOString()

  const body =
    `---\n` +
    `from: ${fromActor}\n` +
    `to: all\n` +
    `timestamp: ${iso}\n` +
    `type: roe-deadlock-resolution\n` +
    `on: ${anchorId}\n` +
    `resolution: ${resolution}\n` +
    `basis: ${basis}\n` +
    `---\n\n` +
    `${rationale}\n`

  const channelDir = join(transportRoot, 'channels', channelGuid, datePath)
  await mkdir(channelDir, { recursive: true })
  const fullPath = join(channelDir, fileName)
  await writeFile(fullPath, body)

  const relPath = `channels/${channelGuid}/${datePath}/${fileName}`
  const gitEmail = `${fromActor}@${actorEmailSuffix}`
  try {
    await execFileP('git', ['-c', `user.name=${fromActor}`, '-c', `user.email=${gitEmail}`,
      'add', relPath], { cwd: transportRoot })
    await execFileP('git', ['-c', `user.name=${fromActor}`, '-c', `user.email=${gitEmail}`,
      'commit', '-m', `roe-deadlock-resolution: ${anchorId} → ${resolution} (${basis})`], { cwd: transportRoot })
    if (await hasRemote(transportRoot)) await pushWithRetry(transportRoot)
  } catch (err) {
    console.error(`[governance] failed to commit/push roe-deadlock-resolution: ${err}`)
    throw err
  }
}

/** Atomic write + commit + push of a `type: bootstrap-conflict` message. */
export async function postBootstrapConflict(
  transportRoot: string,
  channelGuid: string,
  fromActor: string,
  inconsistencies: Inconsistency[],
  actorEmailSuffix: string,
): Promise<void> {
  const d = new Date()
  const datePath = messageDatePath(d)
  const fileName = messageFilename(d)
  const iso = d.toISOString()

  const detailsList = inconsistencies.map(i =>
    `- **${i.kind}** on \`${i.anchorId}\`: ${i.details}\n  paths:\n${i.paths.map(p => `    - \`${p}\``).join('\n')}`
  ).join('\n')

  const body =
    `---\n` +
    `from: ${fromActor}\n` +
    `to: all\n` +
    `timestamp: ${iso}\n` +
    `type: bootstrap-conflict\n` +
    `inconsistency-count: ${inconsistencies.length}\n` +
    `---\n\n` +
    `## Bootstrap detected inconsistent governance state\n\n` +
    `${detailsList}\n\n` +
    `_The swarm is in a degraded state per BOOTSTRAP.md "bootstrap finds inconsistent state". Work messages continue to dispatch normally; \`roe-*\` governance messages are gated until a human resolves manually (typically by amending or removing the conflicting messages, then posting a new \`session-open\`)._\n`

  const channelDir = join(transportRoot, 'channels', channelGuid, datePath)
  await mkdir(channelDir, { recursive: true })
  const fullPath = join(channelDir, fileName)
  await writeFile(fullPath, body)

  const relPath = `channels/${channelGuid}/${datePath}/${fileName}`
  const gitEmail = `${fromActor}@${actorEmailSuffix}`
  try {
    await execFileP('git', ['-c', `user.name=${fromActor}`, '-c', `user.email=${gitEmail}`,
      'add', relPath], { cwd: transportRoot })
    await execFileP('git', ['-c', `user.name=${fromActor}`, '-c', `user.email=${gitEmail}`,
      'commit', '-m', `bootstrap-conflict: ${inconsistencies.length} inconsistency(ies) on ${channelGuid.slice(0, 8)}`], { cwd: transportRoot })
    if (await hasRemote(transportRoot)) await pushWithRetry(transportRoot)
  } catch (err) {
    console.error(`[governance] failed to commit/push bootstrap-conflict: ${err}`)
    throw err
  }
}

// ── Time-decay periodic check ────────────────────────────────────────────

export interface DecayCheckerHandle {
  stop(): void
}

/** Start the periodic time-decay checker. Walks every channel, finds
 * pending amendments past their vote-window + decay timer, posts
 * `roe-deadlock-resolution` messages.
 *
 * Only fires when the active ROE specifies `deadlock-pattern: time-decay`.
 * For other patterns, the checker is a no-op (it still walks, but never
 * acts).
 *
 * The local daemon posts the resolution under the coordinator's identity
 * (per BOOTSTRAP.md the coordinator drives governance ops). If we don't
 * host the coordinator, we skip — the other machine handles it.
 */
export function startDecayChecker(
  transportRoot: string,
  intervalMs: number,
  getCoordinator: () => string | null,
  actorEmailSuffix: string,
): DecayCheckerHandle {
  const handle = setInterval(async () => {
    try {
      const config = readDeadlockConfig(transportRoot)
      if (config.pattern !== 'time-decay' || !config.decayAfterMs) return

      const coordinator = getCoordinator()
      if (!coordinator) return  // we don't host coordinator → skip

      const channelsDir = join(transportRoot, 'channels')
      if (!existsSync(channelsDir)) return

      let guids: string[] = []
      try { guids = readdirSync(channelsDir) } catch { return }

      const now = Date.now()
      for (const guid of guids) {
        if (guid.startsWith('.') || guid.startsWith('_')) continue
        const channelDir = join(channelsDir, guid)
        const messages = walkGovernanceMessages(channelDir)
        const pending = findPendingAmendments(messages, now)

        for (const p of pending) {
          if (!p.expiredAsOf || !p.voteWindowMs) continue
          const proposalTime = Date.parse(p.definingMessage.timestamp)
          if (!Number.isFinite(proposalTime)) continue
          const decayElapsedAt = proposalTime + p.voteWindowMs + config.decayAfterMs
          if (now < decayElapsedAt) continue

          // Decay timer fired — post resolution
          const outcome = config.defaultOutcome === 'status-quo-wins' || config.defaultOutcome === 'failed'
            ? 'failed'
            : 'passed'
          const rationale =
            `Time-decay auto-resolution per active ROE.\n\n` +
            `- Vote window: ${p.voteWindowMs / 1000}s elapsed at ${new Date(proposalTime + p.voteWindowMs).toISOString()}\n` +
            `- Decay timer (${config.decayAfterMs / 1000}s) elapsed at ${new Date(decayElapsedAt).toISOString()}\n` +
            `- Default outcome: \`${config.defaultOutcome}\` → resolution: \`${outcome}\`\n` +
            `- Tally at decay: yes=${p.votes.yes}, no=${p.votes.no}, abstain=${p.votes.abstain} (insufficient for quorum-based resolution)\n`

          try {
            await postDeadlockResolution(transportRoot, guid, coordinator, p.anchorId, outcome as 'passed' | 'failed', 'time-decay', rationale, actorEmailSuffix)
            console.log(`[governance] time-decay auto-resolved ${guid.slice(0, 8)}/${p.anchorId} → ${outcome}`)
          } catch (err) {
            console.error(`[governance] failed to auto-resolve ${guid.slice(0, 8)}/${p.anchorId}: ${err}`)
          }
        }
      }
    } catch (err) {
      console.error(`[governance] decay checker error: ${err}`)
    }
  }, intervalMs)

  return { stop: () => clearInterval(handle) }
}

// ── Auto-tally on vote-window expiry (alpha.7+) ──────────────────────────

/** Detect whether a Scrum amendment target indicates a role change. Used by
 * `computeTally` to apply the Scrum PO+SM consent rule. Heuristic substring
 * match — role changes typically target sections named "Roles", "Members",
 * "Team", or specifically reference PO/SM/team. Operators with novel section
 * names can amend this heuristic in a future alpha; for MVP a name match is
 * acceptable. */
function isRoleChangeTarget(target: string): boolean {
  const t = target.toLowerCase()
  return /role|member|team|product[- ]?owner|scrum[- ]?master|\bpo\b|\bsm\b/.test(t)
}

/** Atomic write + commit + push of a `type: roe-vote-result` message. Used
 * by the auto-tally path when a vote-window expires without a Speaker/SM
 * posting the result. */
export async function postVoteResult(
  transportRoot: string,
  channelGuid: string,
  fromActor: string,
  anchorId: string,
  tally: VoteTally,
  actorEmailSuffix: string,
): Promise<void> {
  const d = new Date()
  const datePath = messageDatePath(d)
  const fileName = messageFilename(d)
  const iso = d.toISOString()

  const body =
    `---\n` +
    `from: ${fromActor}\n` +
    `to: all\n` +
    `timestamp: ${iso}\n` +
    `type: roe-vote-result\n` +
    `on: ${anchorId}\n` +
    `result: ${tally.ratified}\n` +
    `yes-count: ${tally.yes}\n` +
    `no-count: ${tally.no}\n` +
    `abstain-count: ${tally.abstain}\n` +
    `---\n\n` +
    `## Auto-tally (vote-window expired without ${fromActor === 'speaker' ? 'Speaker' : 'role-holder'}-posted result)\n\n` +
    `- Threshold: ${tally.threshold ?? 'permissive'}\n` +
    `- Reason: ${tally.reason}\n` +
    `${tally.quorumMet === false ? '- ⚠ Quorum not met\n' : ''}` +
    `${tally.ineligibleVotes > 0 ? `- ${tally.ineligibleVotes} ineligible vote(s) excluded\n` : ''}` +
    `${tally.expiredVotes > 0 ? `- ${tally.expiredVotes} expired vote(s) excluded\n` : ''}` +
    `\n_Auto-posted by runtime when vote-window elapsed and no role-holder posted the result. This message is the formal outcome._\n`

  const channelDir = join(transportRoot, 'channels', channelGuid, datePath)
  await mkdir(channelDir, { recursive: true })
  await writeFile(join(channelDir, fileName), body)

  const relPath = `channels/${channelGuid}/${datePath}/${fileName}`
  const gitEmail = `${fromActor}@${actorEmailSuffix}`
  try {
    await execFileP('git', ['-c', `user.name=${fromActor}`, '-c', `user.email=${gitEmail}`,
      'add', relPath], { cwd: transportRoot })
    await execFileP('git', ['-c', `user.name=${fromActor}`, '-c', `user.email=${gitEmail}`,
      'commit', '-m', `roe-vote-result (auto-tally): ${anchorId} → ${tally.ratified}`], { cwd: transportRoot })
    if (await hasRemote(transportRoot)) await pushWithRetry(transportRoot)
  } catch (err) {
    console.error(`[governance] failed to commit/push roe-vote-result: ${err}`)
    throw err
  }
}

/** Start the periodic auto-tally checker. Walks every channel, finds
 * pending amendments past their vote-window without a roe-vote-result
 * or roe-deadlock-resolution, computes the tally via template rules,
 * and posts roe-vote-result automatically.
 *
 * Only fires when:
 * - A template is detected (Parliamentary, Scrum, Casual — vote-aware templates)
 * - We host the coordinator (avoids duplicate posts cross-machine)
 *
 * NOT fired when ROE specifies `deadlock-pattern: time-decay` — the
 * time-decay path owns auto-resolution in that case. Otherwise auto-
 * tally is the safety net for Parliamentary's "Speaker should post"
 * (and Scrum's PO+SM consent).
 */
export function startAutoTallyChecker(
  transportRoot: string,
  intervalMs: number,
  getCoordinator: () => string | null,
  actorEmailSuffix: string,
): DecayCheckerHandle {
  const handle = setInterval(async () => {
    try {
      const { loadTemplateConfig } = await import('./templates.js')
      const templateConfig = loadTemplateConfig(transportRoot)
      if (!templateConfig) return

      // Skip if time-decay pattern is set — that path owns auto-resolution
      const deadlockConfig = readDeadlockConfig(transportRoot)
      if (deadlockConfig.pattern === 'time-decay') return

      const coordinator = getCoordinator()
      if (!coordinator) return

      const channelsDir = join(transportRoot, 'channels')
      if (!existsSync(channelsDir)) return

      let guids: string[] = []
      try { guids = readdirSync(channelsDir) } catch { return }

      const now = Date.now()
      for (const guid of guids) {
        if (guid.startsWith('.') || guid.startsWith('_')) continue
        const channelDir = join(channelsDir, guid)
        const messages = walkGovernanceMessages(channelDir)
        const pending = findPendingAmendments(messages, now)

        for (const p of pending) {
          if (!p.expiredAsOf) continue

          // Determine if this is an amendment (vs procedural motion)
          const target = String(p.definingMessage.data.target ?? '')
          const isAmendment = p.definingMessage.type === 'roe-amendment-proposal' || target.length > 0

          const tally = computeTally(p.anchorId, messages, templateConfig, isAmendment, now)
          try {
            await postVoteResult(transportRoot, guid, coordinator, p.anchorId, tally, actorEmailSuffix)
            console.log(`[governance] auto-tally posted ${guid.slice(0, 8)}/${p.anchorId} → ${tally.ratified} (${tally.reason})`)
          } catch (err) {
            console.error(`[governance] failed to auto-tally ${guid.slice(0, 8)}/${p.anchorId}: ${err}`)
          }
        }
      }
    } catch (err) {
      console.error(`[governance] auto-tally checker error: ${err}`)
    }
  }, intervalMs)

  return { stop: () => clearInterval(handle) }
}

// ── helpers ──────────────────────────────────────────────────────────────

/** Tiny ISO-8601 duration parser — same shape as cli/lib/governance.ts.
 * Supports PT<n>H, PT<n>M, PT<n>H<n>M, P<n>D, etc. Returns ms, or null. */
export function parseIsoDuration(s: string): number | null {
  const m = s.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/)
  if (!m) return null
  const days  = parseInt(m[1] ?? '0', 10)
  const hours = parseInt(m[2] ?? '0', 10)
  const mins  = parseInt(m[3] ?? '0', 10)
  const secs  = parseInt(m[4] ?? '0', 10)
  const total = (((days * 24 + hours) * 60) + mins) * 60 + secs
  if (total === 0) return null
  return total * 1000
}
