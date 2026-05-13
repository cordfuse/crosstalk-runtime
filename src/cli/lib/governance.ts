/**
 * Governance message helpers — used by `crosstalk roe audit` + `crosstalk
 * roe validate`. Implements the Crosstalk v0.7 framework spec from
 * `manifest/framework/protocol/AMENDMENT.md`, `DEADLOCK.md`, and
 * `BOOTSTRAP.md`.
 *
 * Scope of this module:
 * - Recognise governance message types (the `roe-*` family + `session-open`
 *   / `bootstrap-conflict`)
 * - Filter/group governance messages from a channel's history
 * - Validate them against the AMENDMENT.md syntactic rules:
 *     - proposal-id uniqueness within a channel
 *     - vote-related messages reference a live proposal
 *     - vote-window honoured (votes posted after window expiry → warning)
 *     - vote.vote field is yes|no|abstain
 *     - from: is in the actor registry (when registry available)
 *     - second.seconds field references a live proposal
 *
 * Out of scope (per AMENDMENT.md): per-template SEMANTIC enforcement —
 * "only members can vote in Parliamentary," "PO+SM consent for Scrum
 * role-change amendments," etc. Those require parsing the active ROE
 * file; alpha.5+ refinement.
 */
import type { RenderedMessage } from './channel.js'

export const ROE_MESSAGE_TYPES = [
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
] as const

export type RoeMessageType = typeof ROE_MESSAGE_TYPES[number]

const ROE_TYPE_SET: ReadonlySet<string> = new Set(ROE_MESSAGE_TYPES)

export function isRoeMessage(type: string): type is RoeMessageType {
  return ROE_TYPE_SET.has(type)
}

/** Vote-anchoring types — i.e. messages whose `on:` field MUST reference a
 * live proposal/motion in channel history. */
const VOTE_ANCHORED_TYPES: ReadonlySet<string> = new Set([
  'roe-vote',
  'roe-vote-open',
  'roe-vote-close',
  'roe-vote-result',
  'roe-ratified',
  'roe-deadlock-resolution',
])

export interface GovernanceMessage extends RenderedMessage {
  type: RoeMessageType
}

export interface ValidationIssue {
  severity: 'error' | 'warn'
  path:     string
  type:     string
  message:  string
}

/** Filter a channel's full message stream down to governance messages only. */
export function filterGovernanceMessages(messages: RenderedMessage[]): GovernanceMessage[] {
  const out: GovernanceMessage[] = []
  for (const m of messages) {
    if (isRoeMessage(m.type)) out.push(m as GovernanceMessage)
  }
  return out
}

/** Extract the proposal/motion id this message anchors to. Returns null if
 * the message has no anchoring id (e.g. session-open, bootstrap-conflict,
 * a malformed message that's missing the field). */
export function extractAnchorId(m: GovernanceMessage): string | null {
  const d = m.data
  // Message types that DEFINE a new proposal/motion
  if (m.type === 'roe-amendment-proposal' && typeof d['proposal-id'] === 'string') {
    return d['proposal-id'] as string
  }
  if (m.type === 'roe-motion' && typeof d['motion-id'] === 'string') {
    return d['motion-id'] as string
  }
  // Message types that REFERENCE an existing proposal/motion
  if (typeof d.on === 'string' && d.on.trim()) return d.on as string
  if (typeof d.seconds === 'string' && d.seconds.trim()) return d.seconds as string
  return null
}

/** Group governance messages by their proposal/motion anchor id. Messages
 * with no anchor go into the special '__unanchored__' bucket. */
export function groupByAnchor(messages: GovernanceMessage[]): Map<string, GovernanceMessage[]> {
  const groups = new Map<string, GovernanceMessage[]>()
  for (const m of messages) {
    const id = extractAnchorId(m) ?? '__unanchored__'
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id)!.push(m)
  }
  return groups
}

/** Validate governance messages against the AMENDMENT.md spec.
 *
 * `knownActors` is the merged actor registry (framework + custom + local).
 * Pass an empty Set to skip `from:` actor-registry checks (useful when the
 * caller hasn't loaded the registry).
 */
export function validateGovernance(
  messages: GovernanceMessage[],
  knownActors: ReadonlySet<string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  // anchor-id → defining message (proposal or motion). Used for uniqueness
  // + reference-validity + vote-window enforcement.
  const definitions = new Map<string, GovernanceMessage>()

  const issue = (severity: 'error' | 'warn', m: GovernanceMessage, message: string): ValidationIssue =>
    ({ severity, path: m.path, type: m.type, message })

  for (const m of messages) {
    // Rule: from: must match an actor in the merged registry (when registry
    // is available — empty set = skip this check).
    if (knownActors.size > 0 && !knownActors.has(m.from)) {
      issues.push(issue('error', m, `from:'${m.from}' is not in the actor registry`))
    }

    // Rule: proposal/motion definition messages need an id + uniqueness
    if (m.type === 'roe-amendment-proposal' || m.type === 'roe-motion') {
      const idField = m.type === 'roe-amendment-proposal' ? 'proposal-id' : 'motion-id'
      const id = m.data[idField]
      if (typeof id !== 'string' || !id.trim()) {
        issues.push(issue('error', m, `missing required ${idField}`))
      } else if (definitions.has(id)) {
        const first = definitions.get(id)!
        issues.push(issue('error', m, `${idField}:'${id}' is duplicated (first occurrence: ${first.path})`))
      } else {
        definitions.set(id, m)
      }
    }

    // Rule: vote-anchored messages must reference a live proposal/motion
    if (VOTE_ANCHORED_TYPES.has(m.type)) {
      const on = m.data.on
      if (typeof on !== 'string' || !on.trim()) {
        issues.push(issue('error', m, `missing required on:`))
      } else if (!definitions.has(on)) {
        issues.push(issue('error', m, `references on:'${on}' but no proposal/motion with that id exists in channel history`))
      }
    }

    // Rule: roe-vote.vote must be yes|no|abstain
    if (m.type === 'roe-vote') {
      const v = m.data.vote
      if (v !== 'yes' && v !== 'no' && v !== 'abstain') {
        issues.push(issue('error', m, `vote: must be yes|no|abstain, got '${String(v)}'`))
      }

      // Rule: roe-vote posted after the proposal's vote-window expired
      // → warning + excluded from tally (per AMENDMENT.md). Validator
      // surfaces the warning; tally enforcement is alpha.2+ runtime work.
      const anchorId = typeof m.data.on === 'string' ? m.data.on as string : null
      if (anchorId) {
        const def = definitions.get(anchorId)
        if (def && typeof def.data['vote-window'] === 'string') {
          const window = def.data['vote-window'] as string
          const proposalTime = Date.parse(def.timestamp)
          const voteTime     = Date.parse(m.timestamp)
          const windowMs     = parseIsoDuration(window)
          if (windowMs !== null && Number.isFinite(proposalTime) && Number.isFinite(voteTime)
              && voteTime > proposalTime + windowMs) {
            issues.push(issue('warn', m,
              `posted after vote-window expired (proposal ${def.path}, window ${window}); vote will be excluded from tally per AMENDMENT.md`))
          }
        }
      }
    }

    // Rule: roe-second.seconds must reference a live proposal/motion
    if (m.type === 'roe-second') {
      const s = m.data.seconds
      if (typeof s !== 'string' || !s.trim()) {
        issues.push(issue('error', m, `missing required seconds:`))
      } else if (!definitions.has(s)) {
        issues.push(issue('error', m, `references seconds:'${s}' but no proposal/motion with that id exists in channel history`))
      }
    }
  }

  return issues
}

// ── helpers ─────────────────────────────────────────────────────────────

/** Parse a tiny subset of ISO-8601 durations into milliseconds. Supports:
 *   PT<n>H, PT<n>M, PT<n>H<n>M, P<n>D, P<n>DT<n>H, etc.
 * Returns null if the input doesn't match the supported subset. AMENDMENT.md
 * examples use PT48H / PT72H — we don't need full ISO-8601 coverage. */
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
