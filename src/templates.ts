/**
 * Per-template ROE config parser — runtime + CLI shared.
 *
 * Reads structured key-value lines from `manifest/custom/protocol/ROE.md`
 * (falling through to `manifest/framework/protocol/ROE.md`) and surfaces
 * a typed `TemplateConfig` per active template. Used by:
 *
 * - `crosstalk roe validate` to enforce per-template semantic rules
 *   (Parliamentary member-only voting, Scrum role-change PO+SM consent,
 *   etc.)
 * - Runtime `governance.ts` to compute correct vote tallies (member-
 *   only counts, threshold checks)
 * - `crosstalk roe audit` to surface template-context in audit output
 *
 * Convention: operators add structured fields ANYWHERE in their ROE.md
 * (frontmatter or body). The parser uses regex per field — same pattern
 * as the existing `coordinator: alice` field that v0.7.0-alpha.2's
 * bootstrap.ts already reads.
 *
 * Template detection priority:
 * 1. `template: <name>` field if present (operator-set)
 * 2. Frontmatter `template:` field
 * 3. null (no template detected; semantic enforcement is a no-op)
 *
 * Per-template structured fields (alpha.6+):
 *
 *   Parliamentary:
 *     template: parliamentary
 *     members: alice, bob, carol, dave    # comma-separated, kebab-case actor names
 *     speaker: alice
 *     quorum: 3                            # int; minimum non-abstain votes for valid result
 *     amendment-threshold: two-thirds      # simple-majority | two-thirds
 *     amendment-vote-window: PT72H         # ISO duration; required for amendments specifically
 *
 *   Scrum:
 *     template: scrum
 *     product-owner: alice
 *     scrum-master: bob
 *     team: alice, bob, carol, dave
 *     sprint-length: P2W                    # ISO duration
 *
 *   Casual:
 *     template: casual
 *     humans: alice, bob, carol             # all-humans list (consensus calculator)
 *     consensus-threshold: 0.66             # fraction; default majority
 *
 *   Monarchy:
 *     template: monarchy
 *     monarch: alice
 *
 *   Conductor-Orchestra:
 *     template: conductor-orchestra
 *     conductor: alice
 *     orchestra: nova, codex, gemini
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export type TemplateName = 'parliamentary' | 'scrum' | 'casual' | 'monarchy' | 'conductor-orchestra'

export interface ParliamentaryConfig {
  template: 'parliamentary'
  members: string[]
  speaker: string | null
  quorum: number | null
  amendmentThreshold: 'simple-majority' | 'two-thirds' | null
  amendmentVoteWindow: string | null
}

export interface ScrumConfig {
  template: 'scrum'
  productOwner: string | null
  scrumMaster: string | null
  team: string[]
  sprintLength: string | null
}

export interface CasualConfig {
  template: 'casual'
  humans: string[]
  consensusThreshold: number  // 0..1
}

export interface MonarchyConfig {
  template: 'monarchy'
  monarch: string | null
}

export interface ConductorOrchestraConfig {
  template: 'conductor-orchestra'
  conductor: string | null
  orchestra: string[]
}

export type TemplateConfig =
  | ParliamentaryConfig
  | ScrumConfig
  | CasualConfig
  | MonarchyConfig
  | ConductorOrchestraConfig
  | null

/** Load and parse the active template config. Returns null if no template
 * is detected or no ROE.md exists. Operators with no governance setup get
 * the no-op behavior (semantic enforcement skipped). */
export function loadTemplateConfig(transportRoot: string): TemplateConfig {
  const content = readActiveROE(transportRoot)
  if (!content) return null

  const template = matchString(content, 'template')
  if (!template) return null

  const t = template.toLowerCase() as TemplateName
  switch (t) {
    case 'parliamentary': return {
      template: 'parliamentary',
      members: matchList(content, 'members'),
      speaker: matchString(content, 'speaker'),
      quorum: matchInt(content, 'quorum'),
      amendmentThreshold: matchAmendmentThreshold(content),
      amendmentVoteWindow: matchString(content, 'amendment-vote-window'),
    }
    case 'scrum': return {
      template: 'scrum',
      productOwner: matchString(content, 'product-owner'),
      scrumMaster: matchString(content, 'scrum-master'),
      team: matchList(content, 'team'),
      sprintLength: matchString(content, 'sprint-length'),
    }
    case 'casual': return {
      template: 'casual',
      humans: matchList(content, 'humans'),
      consensusThreshold: matchFloat(content, 'consensus-threshold') ?? 0.51,
    }
    case 'monarchy': return {
      template: 'monarchy',
      monarch: matchString(content, 'monarch'),
    }
    case 'conductor-orchestra': return {
      template: 'conductor-orchestra',
      conductor: matchString(content, 'conductor'),
      orchestra: matchList(content, 'orchestra'),
    }
    default: return null
  }
}

function readActiveROE(transportRoot: string): string | null {
  for (const layer of ['custom', 'framework']) {
    const p = join(transportRoot, 'manifest', layer, 'protocol', 'ROE.md')
    if (!existsSync(p)) continue
    try { return readFileSync(p, 'utf-8') } catch { continue }
  }
  return null
}

function matchString(content: string, key: string): string | null {
  const re = new RegExp(`^\\s*${escapeKey(key)}:\\s*(\\S+(?:[ \\t]+\\S+)*)\\s*$`, 'mi')
  const m = content.match(re)
  if (!m) return null
  const val = m[1].trim()
  // Skip operator placeholders like [SOMETHING-PLACEHOLDER]
  if (/^\[.*\]$/.test(val)) return null
  // Skip values containing spaces (likely prose like "alice (human)") unless it's a known no-spaces field
  if (val.includes(' ') && !val.startsWith('PT') && !val.startsWith('P')) return null
  return val
}

function matchList(content: string, key: string): string[] {
  // Lists are comma-separated kebab-case names: "alice, bob, carol"
  const re = new RegExp(`^\\s*${escapeKey(key)}:\\s*([a-z][a-z0-9-]*(?:\\s*,\\s*[a-z][a-z0-9-]*)*)\\s*$`, 'mi')
  const m = content.match(re)
  if (!m) return []
  return m[1].split(',').map(s => s.trim()).filter(s => s.length > 0)
}

function matchInt(content: string, key: string): number | null {
  const re = new RegExp(`^\\s*${escapeKey(key)}:\\s*(\\d+)\\s*$`, 'mi')
  const m = content.match(re)
  return m ? parseInt(m[1], 10) : null
}

function matchFloat(content: string, key: string): number | null {
  const re = new RegExp(`^\\s*${escapeKey(key)}:\\s*(\\d+(?:\\.\\d+)?)\\s*$`, 'mi')
  const m = content.match(re)
  return m ? parseFloat(m[1]) : null
}

function matchAmendmentThreshold(content: string): 'simple-majority' | 'two-thirds' | null {
  const v = matchString(content, 'amendment-threshold')
  if (v === 'two-thirds' || v === 'simple-majority') return v
  return null
}

function escapeKey(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
