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
import type { TemplateConfig, EncryptionMode } from '../../templates.js'

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
  // v0.8.0-alpha.1+ — ephemeral message types per EPHEMERAL.md
  'ephemeral',
  'ephemeral-consumed',
  'ephemeral-expired',
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
 *
 * `templateConfig` (v0.7.0-alpha.6+) is the parsed active ROE template
 * config. When provided, semantic-enforcement rules apply:
 * - Parliamentary: `roe-vote` from non-members → ERROR
 * - Scrum: `roe-vote` on role-change amendment from non-PO/SM → WARN
 * - Casual: no per-message check (consensus is at result-tally time)
 * - Monarchy / Conductor-Orchestra: any `roe-vote` → WARN (unilateral
 *   templates don't vote; informational only)
 *
 * Pass null to skip semantic enforcement (alpha.5-and-prior behavior).
 */
export function validateGovernance(
  messages: GovernanceMessage[],
  knownActors: ReadonlySet<string>,
  templateConfig: TemplateConfig = null,
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

      // Per-template semantic enforcement (v0.7.0-alpha.6+)
      if (templateConfig?.template === 'parliamentary') {
        if (!templateConfig.members.includes(m.from)) {
          issues.push(issue('error', m,
            `Parliamentary: only members may vote. '${m.from}' is not in members list [${templateConfig.members.join(', ')}]`))
        }
      } else if (templateConfig?.template === 'scrum') {
        if (!templateConfig.team.includes(m.from)) {
          issues.push(issue('warn', m,
            `Scrum: voter '${m.from}' is not on the team [${templateConfig.team.join(', ')}]; vote will not count toward sprint consensus`))
        }
      } else if (templateConfig?.template === 'monarchy' || templateConfig?.template === 'conductor-orchestra') {
        issues.push(issue('warn', m,
          `${templateConfig.template}: votes are informational, not authoritative. The ${templateConfig.template === 'monarchy' ? 'monarch' : 'conductor'} decides unilaterally.`))
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

    // Rule (v0.8+ EPHEMERAL.md): type: ephemeral must:
    //   - have to: != 'all'
    //   - have encryption: age
    //   - have ephemeral-id
    if (m.type === 'ephemeral') {
      if (m.to === 'all' || m.to.toLowerCase() === 'all') {
        issues.push(issue('error', m, `type: ephemeral with to: all is forbidden per EPHEMERAL.md (defeats the privacy purpose; encrypting to every actor is equivalent to no encryption). Use targeted to: alice, bob instead.`))
      }
      const enc = String(m.data.encryption ?? '')
      if (enc !== 'age') {
        issues.push(issue('error', m, `type: ephemeral requires 'encryption: age' per EPHEMERAL.md (plaintext ephemerals are nonsense — defeats the deletion-on-acknowledgment purpose). Got encryption='${enc}'.`))
      }
      const eid = m.data['ephemeral-id']
      if (typeof eid !== 'string' || !eid.trim()) {
        issues.push(issue('error', m, `type: ephemeral missing required 'ephemeral-id' per EPHEMERAL.md (kebab-case operator-chosen identifier; needed so ephemeral-consumed tombstones can reference it).`))
      }
    }

    // Rule (v0.8+ EPHEMERAL.md): type: ephemeral-consumed must reference a live ephemeral-id
    if (m.type === 'ephemeral-consumed') {
      const onId = m.data.on
      if (typeof onId !== 'string' || !onId.trim()) {
        issues.push(issue('error', m, `type: ephemeral-consumed missing required 'on:' field (the ephemeral-id being acknowledged).`))
      }
      // Live-reference check happens in a second pass below — we need to know
      // all ephemeral-ids in the channel first.
    }
  }

  // Second pass for ephemeral-consumed liveness + duplicate detection.
  // Doing this in a second pass means we have the complete ephemeral-id index
  // regardless of message ordering (an ephemeral-consumed posted before the
  // ephemeral itself is impossible per timestamps but the validator shouldn't
  // depend on that).
  const ephemeralIds = new Set<string>()
  for (const m of messages) {
    if (m.type === 'ephemeral') {
      const id = String(m.data['ephemeral-id'] ?? '').trim()
      if (id) ephemeralIds.add(id)
    }
  }
  const consumedIds = new Map<string, GovernanceMessage>()
  for (const m of messages) {
    if (m.type !== 'ephemeral-consumed') continue
    const onId = String(m.data.on ?? '').trim()
    if (!onId) continue  // already errored above
    if (!ephemeralIds.has(onId)) {
      issues.push({ severity: 'error', path: m.path, type: m.type,
        message: `references ephemeral-id:'${onId}' but no type: ephemeral with that id exists in channel history (orphan tombstone).` })
    }
    if (consumedIds.has(onId)) {
      const first = consumedIds.get(onId)!
      issues.push({ severity: 'warn', path: m.path, type: m.type,
        message: `duplicate ephemeral-consumed for id '${onId}' (first occurrence: ${first.path}). Per EPHEMERAL.md: first tombstone wins; subsequent ones are no-ops.` })
    } else {
      consumedIds.set(onId, m)
    }
  }

  return issues
}

// ── Encryption-mode enforcement (v0.8.0-alpha.6+) ────────────────────────

/** System + governance message types that are ALWAYS plaintext per PRIVACY.md
 * regardless of encryption-mode. Auditability of these is load-bearing for
 * operators verifying governance happened correctly. */
const ALWAYS_PLAINTEXT_TYPES: ReadonlySet<string> = new Set([
  'system',
  // All ROE governance + bootstrap + ephemeral-tombstone types are plaintext;
  // only the ephemeral message ITSELF is encrypted (handled by separate ephemeral
  // wire-format rules in validateGovernance above).
  'session-open',
  'session-open-deferred',
  'bootstrap-conflict',
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
  'ephemeral-consumed',
  'ephemeral-expired',
])

/** Validate channel messages against the ROE's `encryption-mode:` policy.
 *
 * Rules applied:
 * - `none`: no checks (encryption not permitted, but if operator posted
 *   an encrypted message, it's not actively rejected — it just lives there)
 * - `optional`: no checks (operator chooses per-message)
 * - `required`: work messages MUST have `encryption: age`; plaintext
 *   work messages → ERROR. System + governance + ephemeral-tombstone types
 *   bypass this rule (always plaintext per PRIVACY.md).
 *
 * Takes the FULL channel message stream (not just governance) since
 * encryption-mode applies to all message types. Returns ValidationIssues
 * for any violations.
 */
export function validateEncryptionMode(
  messages: RenderedMessage[],
  mode: EncryptionMode,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (mode !== 'required') return issues

  for (const m of messages) {
    if (ALWAYS_PLAINTEXT_TYPES.has(m.type)) continue
    const enc = String(m.data.encryption ?? '')
    if (enc === 'age') continue  // properly encrypted, OK

    issues.push({
      severity: 'error',
      path: m.path,
      type: m.type,
      message: `encryption-mode is 'required' per active ROE, but this work message has no \`encryption: age\` frontmatter. Plaintext work messages are forbidden under required mode (system + governance + ephemeral-tombstone types are exempt; this is type='${m.type}').`,
    })
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
