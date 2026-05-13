/**
 * `crosstalk roe <subcommand>` — operator tools for inspecting + validating
 * Crosstalk governance activity.
 *
 *   crosstalk roe audit    [--channel <ref>] [--proposal <id>] [--all] [--json]
 *   crosstalk roe validate [--channel <ref>] [--all] [--json]
 *
 * Both subcommands operate on channel history. They consume the wire-format
 * spec defined in:
 *   manifest/framework/protocol/AMENDMENT.md
 *   manifest/framework/protocol/DEADLOCK.md
 *   manifest/framework/protocol/BOOTSTRAP.md
 *
 * Audit prints the amendment trail per proposal-id (or per motion-id);
 * validate enforces the syntactic rules from AMENDMENT.md "Validation rules"
 * section. Per-template SEMANTIC enforcement (Parliamentary member-only
 * voting, Scrum role-change consent, etc.) is alpha.5+ refinement and not
 * implemented here.
 */
import type { Command } from 'commander'
import { join } from 'node:path'

import { loadConfig } from '../../config.js'
import { listChannels, resolveChannel, readChannelMessages, type ChannelInfo } from '../lib/channel.js'
import { scanAllLayers } from '../lib/actors.js'
import {
  filterGovernanceMessages,
  groupByAnchor,
  validateGovernance,
  extractAnchorId,
  type GovernanceMessage,
  type ValidationIssue,
} from '../lib/governance.js'

export function registerRoeCommand(program: Command): void {
  const roe = program
    .command('roe')
    .description('inspect + validate Rules of Engagement governance activity (subcommands: audit, validate)')

  registerRoeAudit(roe)
  registerRoeValidate(roe)
}

// ── roe audit ───────────────────────────────────────────────────────────

interface RoeAuditOptions {
  channel?:  string
  proposal?: string
  all?:      boolean
  json?:     boolean
}

function registerRoeAudit(parent: Command): void {
  parent
    .command('audit')
    .description('print the amendment trail per proposal/motion in channel history')
    .option('--channel <ref>',  'channel name or GUID')
    .option('--proposal <id>',  'restrict to a single proposal-id or motion-id')
    .option('--all',            'audit across all channels in the transport')
    .option('--json',           'machine-readable JSON output')
    .action(async (opts: RoeAuditOptions) => {
      await runRoeAudit(opts)
    })
}

async function runRoeAudit(opts: RoeAuditOptions): Promise<void> {
  const config = await loadConfig()
  const targets = pickChannels(config.transport, opts.channel, !!opts.all)

  // For each channel, gather governance messages + group by anchor id.
  interface AuditEntry {
    channel:      string
    channelGuid:  string
    anchorId:     string
    messages:     GovernanceMessage[]
  }
  const entries: AuditEntry[] = []
  for (const t of targets) {
    const channelDir = join(config.transport, 'channels', t.guid)
    const all = readChannelMessages(channelDir)
    const gov = filterGovernanceMessages(all)
    if (gov.length === 0) continue
    const groups = groupByAnchor(gov)
    for (const [anchorId, messages] of groups) {
      if (opts.proposal && anchorId !== opts.proposal) continue
      entries.push({ channel: t.name, channelGuid: t.guid, anchorId, messages })
    }
  }

  if (entries.length === 0) {
    if (opts.json) {
      console.log('[]')
    } else if (opts.proposal) {
      console.log(`(no governance activity for proposal/motion '${opts.proposal}'${opts.channel ? ` in channel ${opts.channel}` : ''})`)
    } else {
      console.log(`(no governance activity in ${opts.all ? 'any channel' : `channel '${opts.channel ?? targets[0]?.name ?? ''}'`})`)
    }
    return
  }

  if (opts.json) {
    console.log(JSON.stringify(entries.map(asAuditJson), null, 2))
    return
  }

  for (const e of entries) {
    const header = e.anchorId === '__unanchored__'
      ? `\n# ${e.channel}  (unanchored governance messages)`
      : `\n# ${e.channel}  ${e.anchorId}`
    console.log(header)
    console.log(`  ${'-'.repeat(Math.max(20, header.length - 4))}`)
    for (const m of e.messages) {
      const t = m.timestamp.slice(11, 19)
      const summary = summariseGovernanceMessage(m)
      console.log(`  [${t}] ${m.from.padEnd(20)} ${m.type.padEnd(24)} ${summary}`)
    }
    const status = inferStatus(e.messages)
    console.log(`  status: ${status}`)
  }
}

function asAuditJson(e: { channel: string; channelGuid: string; anchorId: string; messages: GovernanceMessage[] }): Record<string, unknown> {
  return {
    channel:     e.channel,
    channelGuid: e.channelGuid,
    anchorId:    e.anchorId,
    status:      inferStatus(e.messages),
    messages:    e.messages.map(m => ({
      timestamp: m.timestamp,
      from:      m.from,
      type:      m.type,
      data:      m.data,
      path:      m.path,
    })),
  }
}

/** One-line summary of a single governance message for the audit table. */
function summariseGovernanceMessage(m: GovernanceMessage): string {
  const d = m.data
  switch (m.type) {
    case 'roe-amendment-proposal':
      return `target=${String(d.target ?? '?')} window=${String(d['vote-window'] ?? '?')}`
    case 'roe-motion':
      return `class=${String(d['motion-class'] ?? '?')} window=${String(d['vote-window'] ?? '?')}`
    case 'roe-second':
      return `seconds=${String(d.seconds ?? '?')}`
    case 'roe-vote':
      return `vote=${String(d.vote ?? '?')}`
    case 'roe-vote-open':
    case 'roe-vote-close':
      return ''
    case 'roe-vote-result':
      return `result=${String(d.result ?? '?')} y=${String(d['yes-count'] ?? 0)} n=${String(d['no-count'] ?? 0)} a=${String(d['abstain-count'] ?? 0)}`
    case 'roe-ratified':
      return `commit=${String(d.commit ?? '?').slice(0, 8)}`
    case 'roe-amendment-notice':
      return `commit=${String(d.commit ?? '?').slice(0, 8)} reason=${String(d.reason ?? '?')}`
    case 'roe-monarch-transfer':
    case 'roe-conductor-transfer':
    case 'roe-speaker-handoff':
      return `incoming=${String(d.incoming ?? '?')} effective=${String(d.effective ?? '?')}`
    case 'roe-deadlock-resolution':
      return `resolution=${String(d.resolution ?? '?')} basis=${String(d.basis ?? '?')}`
    case 'session-open':
      return `roe=${String(d['roe-version'] ?? '?').slice(0, 8)}`
    case 'session-open-deferred':
      return `yielding-to=${String(d['yielding-to'] ?? '?')}`
    case 'bootstrap-conflict':
      return `conflict=${(m.body.split('\n')[0] ?? '').slice(0, 50)}`
  }
}

/** Infer the lifecycle status of an anchor group from its message stream. */
function inferStatus(messages: GovernanceMessage[]): string {
  // Latest meaningful state wins. Walk in chronological order, track outcome.
  let status = 'in-progress'
  for (const m of messages) {
    if (m.type === 'roe-vote-result') {
      const result = String(m.data.result ?? '?')
      status = `vote-${result}`
    } else if (m.type === 'roe-ratified') {
      status = 'ratified'
    } else if (m.type === 'roe-amendment-notice') {
      status = 'unilateral-amendment'
    } else if (m.type === 'roe-deadlock-resolution') {
      const res = String(m.data.resolution ?? '?')
      status = `deadlock-resolved-${res}`
    } else if (m.type === 'roe-monarch-transfer' || m.type === 'roe-conductor-transfer' || m.type === 'roe-speaker-handoff') {
      status = 'role-transferred'
    } else if (m.type === 'session-open') {
      status = 'session-opened'
    } else if (m.type === 'bootstrap-conflict') {
      status = 'bootstrap-conflict'
    }
  }
  return status
}

// ── roe validate ────────────────────────────────────────────────────────

interface RoeValidateOptions {
  channel?: string
  all?:     boolean
  json?:    boolean
}

function registerRoeValidate(parent: Command): void {
  parent
    .command('validate')
    .description('check governance messages against the AMENDMENT.md syntactic spec — exits non-zero on any error')
    .option('--channel <ref>', 'channel name or GUID')
    .option('--all',           'validate across all channels in the transport')
    .option('--json',          'machine-readable JSON output')
    .action(async (opts: RoeValidateOptions) => {
      await runRoeValidate(opts)
    })
}

async function runRoeValidate(opts: RoeValidateOptions): Promise<void> {
  const config = await loadConfig()
  const targets = pickChannels(config.transport, opts.channel, !!opts.all)

  // Build the merged actor registry once. validateGovernance() uses it to
  // catch "from: someone-not-in-the-swarm" votes/proposals.
  const registry = new Set<string>(scanAllLayers(config.transport).map(e => e.name))

  interface Result {
    channel:     string
    channelGuid: string
    issues:      ValidationIssue[]
    governanceCount: number
  }
  const results: Result[] = []

  let totalGov = 0
  let totalErrors = 0
  let totalWarns  = 0

  for (const t of targets) {
    const channelDir = join(config.transport, 'channels', t.guid)
    const all = readChannelMessages(channelDir)
    const gov = filterGovernanceMessages(all)
    const issues = validateGovernance(gov, registry)
    results.push({ channel: t.name, channelGuid: t.guid, issues, governanceCount: gov.length })
    totalGov += gov.length
    for (const i of issues) {
      if (i.severity === 'error') totalErrors++
      else                        totalWarns++
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({
      summary: { channels: results.length, governanceMessages: totalGov, errors: totalErrors, warnings: totalWarns },
      results,
    }, null, 2))
    if (totalErrors > 0) process.exit(1)
    return
  }

  for (const r of results) {
    if (r.governanceCount === 0) continue
    console.log(`\n# ${r.channel}  (${r.governanceCount} governance message${r.governanceCount === 1 ? '' : 's'})`)
    if (r.issues.length === 0) {
      console.log('  ✓ all governance messages valid')
      continue
    }
    for (const i of r.issues) {
      const tag = i.severity === 'error' ? '✗' : '⚠'
      console.log(`  ${tag} [${i.path}] (${i.type}) ${i.message}`)
    }
  }

  console.log(`\n${results.length} channel(s) checked: ${totalGov} governance message(s), ${totalErrors} error(s), ${totalWarns} warning(s)`)
  if (totalErrors > 0) process.exit(1)
}

// ── shared helpers ──────────────────────────────────────────────────────

interface ChannelTarget { guid: string; name: string }

/** Resolve --channel / --all / unspecified into a list of channel targets.
 * If neither --channel nor --all is passed AND only one channel exists, auto-pick it.
 * Otherwise error with a hint. */
function pickChannels(transport: string, channelRef: string | undefined, all: boolean): ChannelTarget[] {
  if (all) {
    return listChannels(transport).map(c => ({ guid: c.guid, name: c.name }))
  }
  if (channelRef) {
    const guid = resolveChannel(transport, channelRef)
    const found: ChannelInfo | undefined = listChannels(transport).find(c => c.guid === guid)
    return [{ guid, name: found?.name ?? channelRef }]
  }
  const channels = listChannels(transport)
  if (channels.length === 0) {
    console.error('✗ Transport has no channels.')
    process.exit(1)
  }
  if (channels.length === 1) {
    return [{ guid: channels[0]!.guid, name: channels[0]!.name }]
  }
  console.error('✗ Multiple channels exist. Pass --channel <ref> or --all.')
  console.error('  Available channels:')
  for (const c of channels) console.error(`    ${c.name}  (${c.guid.slice(0, 8)}...)`)
  process.exit(1)
}
