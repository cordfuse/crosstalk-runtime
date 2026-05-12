/**
 * `crosstalk channel <subcommand>` — channel management.
 *
 *   crosstalk channel new "<topic>" [--from <actor>] [--first-message "..."]
 *   crosstalk channel list [--include-system] [--json]
 *   crosstalk channel show <name-or-guid> [--last N]
 *   crosstalk channel tail <name-or-guid>
 *   crosstalk channel join <name-or-guid> --agent <name> [--as <actor>]
 *
 * The top-level `crosstalk ls` is a friendly shortcut for `channel list`
 * (registered separately in src/cli/commands/ls.ts).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import type { Command } from 'commander'

import { loadConfig } from '../../config.js'
import { parseFrontmatter } from '../../frontmatter.js'
import { listChannels, resolveChannel, formatRelativeTime } from '../lib/channel.js'
import { registerChannelJoin } from './channel-join.js'

export function registerChannelCommand(program: Command): void {
  const channel = program
    .command('channel')
    .description('manage channels (subcommands: new, list, show, tail, join)')

  registerChannelNew(channel)
  registerChannelList(channel)
  registerChannelShow(channel)
  registerChannelTail(channel)
  registerChannelJoin(channel)
}

// ── channel new ─────────────────────────────────────────────────────────

interface ChannelNewOptions {
  from?:           string
  firstMessage?:   string
  description?:    string
  push?:           boolean
}

function registerChannelNew(parent: Command): void {
  parent
    .command('new <topic>')
    .description('create a new channel — generates GUID, writes _header.md, optionally posts a first message')
    .option('-f, --from <actor>',                   'creator identity (defaults to default-human-actor in config.toml)')
    .option('--first-message <text>',               'post a first message in the new channel (uses --from as sender)')
    .option('--description <text>',                 'short channel description (saved as description: in _header.md body)')
    .option('--no-push',                            'commit but do not push')
    .action(async (topic: string, opts: ChannelNewOptions) => {
      await runChannelNew(topic, opts)
    })
}

async function runChannelNew(topic: string, opts: ChannelNewOptions): Promise<void> {
  const config = await loadConfig()
  const from = opts.from ?? config.defaultHumanActor
  if (!from) {
    console.error(`✗ --from is required (or set default-human-actor in ~/.crosstalk/config.toml).`)
    process.exit(1)
  }

  // Reject duplicates
  const existing = listChannels(config.transport).find(c => c.name === topic)
  if (existing) {
    console.error(`✗ A channel named '${topic}' already exists (${existing.guid}).`)
    console.error(`  Pick a different name, or use \`crosstalk channel show ${topic}\` to inspect it.`)
    process.exit(1)
  }

  const guid = randomUUID()
  const now  = new Date()
  const channelDir = join(config.transport, 'channels', guid)
  const headerPath = join(channelDir, '_header.md')

  // Build _header.md matching the existing convention
  const headerLines = [
    `---`,
    `id: ${guid}`,
    `name: ${topic}`,
    `created: ${now.toISOString()}`,
    `created-by: ${from}`,
    `---`,
    ``,
  ]
  if (opts.description) {
    headerLines.push(opts.description, '')
  }
  const headerContent = headerLines.join('\n')

  mkdirSync(channelDir, { recursive: true })
  // Atomic write — temp in same dir as target
  const tmpHeader = join(channelDir, `._header.md.tmp.${process.pid}`)
  writeFileSync(tmpHeader, headerContent)
  renameSync(tmpHeader, headerPath)

  console.log(`✓ Created channel '${topic}' (${guid.slice(0, 8)}...)`)

  // Optional first message
  let firstMessageRel: string | null = null
  if (opts.firstMessage) {
    const filename  = formatTimestampFilename(now)
    const datePath  = formatDatePath(now)
    const targetDir = join(channelDir, datePath)
    mkdirSync(targetDir, { recursive: true })
    const targetFile = join(targetDir, filename)
    const messageContent = composeMessage({
      from,
      to: 'all',
      timestamp: now.toISOString(),
      type: 'text',
      body: opts.firstMessage,
    })
    const tmpMsg = join(targetDir, `.${filename}.tmp.${process.pid}`)
    writeFileSync(tmpMsg, messageContent)
    renameSync(tmpMsg, targetFile)
    firstMessageRel = `channels/${guid}/${datePath}/${filename}`
    console.log(`✓ Posted first message: ${firstMessageRel}`)
  }

  // Stage everything in this channel (header + optional first message)
  if (!gitCmd(config.transport, ['add', `channels/${guid}/`])) process.exit(1)

  const commitMsg = opts.firstMessage
    ? `channel: new ${topic} + first message from ${from}`
    : `channel: new ${topic} created by ${from}`
  if (!gitCmd(config.transport, ['commit', '-m', commitMsg])) process.exit(1)
  console.log(`✓ Committed: ${commitMsg}`)

  if (opts.push !== false) {
    if (!gitCmd(config.transport, ['push'])) {
      console.error(`✗ Push failed — commit is local. Run \`git -C ${config.transport} push\` to retry.`)
      process.exit(1)
    }
    console.log(`✓ Pushed`)
  } else {
    console.log(`  (skipped push — --no-push)`)
  }
}

// ── channel list ────────────────────────────────────────────────────────

interface ChannelListOptions {
  includeSystem?: boolean
  json?:          boolean
  grep?:          string
}

function registerChannelList(parent: Command): void {
  parent
    .command('list')
    .description('list channels — sorted by last activity, descending')
    .option('--include-system', 'include _system channels (hidden by default)')
    .option('--json',           'machine-readable JSON output')
    .option('--grep <pattern>', 'substring filter on channel name (case-insensitive)')
    .action(async (opts: ChannelListOptions) => {
      await runChannelList(opts)
    })
}

export async function runChannelList(opts: ChannelListOptions, glob?: string): Promise<void> {
  const config = await loadConfig()
  let channels = listChannels(config.transport, { includeSystem: !!opts.includeSystem })

  // Glob filter (positional from `ls` shortcut)
  if (glob) {
    channels = channels.filter(c => globMatch(c.name, glob))
  }

  // Substring filter
  if (opts.grep) {
    const q = opts.grep.toLowerCase()
    channels = channels.filter(c => c.name.toLowerCase().includes(q))
  }

  // Sort: last-active desc, empty channels last
  channels.sort((a, b) => {
    if (!a.lastActivity && !b.lastActivity) return a.name.localeCompare(b.name)
    if (!a.lastActivity) return 1
    if (!b.lastActivity) return -1
    return b.lastActivity.localeCompare(a.lastActivity)
  })

  if (opts.json) {
    console.log(JSON.stringify(channels, null, 2))
    return
  }

  if (channels.length === 0) {
    console.log('(no channels)')
    return
  }

  // Pretty table
  const nameW = Math.max(7, ...channels.map(c => c.name.length))
  const lastW = Math.max(4, ...channels.map(c => formatRelativeTime(c.lastActivity).length))
  console.log(`${pad('CHANNEL', nameW)}  ${pad('LAST', lastW)}  MSGS`)
  for (const c of channels) {
    console.log(`${pad(c.name, nameW)}  ${pad(formatRelativeTime(c.lastActivity), lastW)}  ${c.messageCount}`)
  }
}

// ── channel show ────────────────────────────────────────────────────────

interface ChannelShowOptions {
  last?: string
  json?: boolean
}

function registerChannelShow(parent: Command): void {
  parent
    .command('show <name-or-guid>')
    .description('print messages in a channel chronologically')
    .option('--last <n>',     'limit to the last N messages (default: all)')
    .option('--json',         'machine-readable JSON output')
    .action(async (query: string, opts: ChannelShowOptions) => {
      await runChannelShow(query, opts)
    })
}

interface RenderedMessage {
  timestamp: string
  from:      string
  to:        string
  type:      string
  body:      string
  path:      string
}

async function runChannelShow(query: string, opts: ChannelShowOptions): Promise<void> {
  const config = await loadConfig()
  const guid = resolveChannel(config.transport, query)
  const channelDir = join(config.transport, 'channels', guid)

  let messages = readChannelMessages(channelDir)
  const limit = opts.last ? parseInt(opts.last, 10) : undefined
  if (limit && limit > 0 && messages.length > limit) {
    messages = messages.slice(-limit)
  }

  if (opts.json) {
    console.log(JSON.stringify(messages, null, 2))
    return
  }

  if (messages.length === 0) {
    console.log('(channel has no messages)')
    return
  }

  for (const m of messages) {
    printMessage(m)
  }
}

function readChannelMessages(channelDir: string): RenderedMessage[] {
  const out: RenderedMessage[] = []
  const YEAR = /^\d{4}$/
  const DD   = /^\d{2}$/
  const MSG  = /^\d{9}Z\.md$/

  let years: string[] = []
  try { years = readdirSync(channelDir).filter(e => YEAR.test(e)).sort() } catch { return out }
  for (const y of years) {
    let months: string[] = []
    try { months = readdirSync(join(channelDir, y)).filter(e => DD.test(e)).sort() } catch { continue }
    for (const m of months) {
      let days: string[] = []
      try { days = readdirSync(join(channelDir, y, m)).filter(e => DD.test(e)).sort() } catch { continue }
      for (const d of days) {
        let files: string[] = []
        try { files = readdirSync(join(channelDir, y, m, d)).filter(e => MSG.test(e)).sort() } catch { continue }
        for (const f of files) {
          const path = join(y, m, d, f)
          try {
            const content = readFileSync(join(channelDir, path), 'utf-8')
            const { data, body } = parseFrontmatter(content)
            const t = f.slice(0, 9)
            const iso = `${y}-${m}-${d}T${t.slice(0,2)}:${t.slice(2,4)}:${t.slice(4,6)}.${t.slice(6,9)}Z`
            out.push({
              timestamp: String(data.timestamp ?? iso),
              from:      String(data.from ?? '?'),
              to:        String(data.to ?? '?'),
              type:      String(data.type ?? 'text'),
              body:      body.trim(),
              path,
            })
          } catch {
            // skip unreadable
          }
        }
      }
    }
  }
  return out
}

function printMessage(m: RenderedMessage): void {
  const t = m.timestamp.slice(11, 19) // hh:mm:ss
  const header = `[${t}] ${m.from} → ${m.to}` + (m.type !== 'text' ? `  (${m.type})` : '')
  console.log(header)
  // Indent body 2 spaces
  for (const line of m.body.split('\n')) {
    console.log(`  ${line}`)
  }
  console.log('')
}

// ── channel tail ────────────────────────────────────────────────────────

function registerChannelTail(parent: Command): void {
  parent
    .command('tail <name-or-guid>')
    .description('follow a channel in real time — prints new messages as they arrive')
    .option('--backfill <n>', 'print last N messages before tailing (default 10)')
    .action(async (query: string, opts: { backfill?: string }) => {
      await runChannelTail(query, opts)
    })
}

async function runChannelTail(query: string, opts: { backfill?: string }): Promise<void> {
  const config = await loadConfig()
  const guid = resolveChannel(config.transport, query)
  const channelDir = join(config.transport, 'channels', guid)

  // Backfill
  const backfillN = opts.backfill ? parseInt(opts.backfill, 10) : 10
  const existing = readChannelMessages(channelDir)
  const backfill = backfillN > 0 ? existing.slice(-backfillN) : []
  for (const m of backfill) printMessage(m)
  if (backfill.length > 0) console.log(`── tailing channel (${backfill.length} backfilled, Ctrl-C to stop) ──\n`)
  else                     console.log(`── tailing channel (no messages yet, Ctrl-C to stop) ──\n`)

  // Track which paths we've already printed (covers backfill + everything seen
  // in subsequent polls). Polling every 500ms avoids the Linux inotify
  // gotcha where fs.watch recursive doesn't auto-watch newly-created
  // subdirectories — important for first-message-of-a-new-day cases when
  // <channel>/YYYY/MM/DD/ doesn't exist when tail starts.
  const seen = new Set(existing.map(m => m.path))

  process.on('SIGINT', () => { process.exit(0) })

  while (true) {
    await new Promise(resolve => setTimeout(resolve, 500))
    const current = readChannelMessages(channelDir)
    for (const m of current) {
      if (seen.has(m.path)) continue
      seen.add(m.path)
      printMessage(m)
    }
  }
}

// ── shared helpers ──────────────────────────────────────────────────────

function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - s.length))
}

function globMatch(name: string, pattern: string): boolean {
  // Simple glob: * matches anything, ? matches one char
  const re = new RegExp(
    '^' + pattern
      .split('')
      .map(c => c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
      .join('') + '$',
    'i'
  )
  return re.test(name)
}

function formatTimestampFilename(d: Date): string {
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  const ss = String(d.getUTCSeconds()).padStart(2, '0')
  const ms = String(d.getUTCMilliseconds()).padStart(3, '0')
  return `${hh}${mm}${ss}${ms}Z.md`
}

function formatDatePath(d: Date): string {
  const yyyy = d.getUTCFullYear()
  const mm   = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd   = String(d.getUTCDate()).padStart(2, '0')
  return `${yyyy}/${mm}/${dd}`
}

function composeMessage(m: { from: string; to: string; timestamp: string; type: string; body: string }): string {
  return [
    `---`,
    `from: ${m.from}`,
    `to: ${m.to}`,
    `timestamp: ${m.timestamp}`,
    `type: ${m.type}`,
    `---`,
    ``,
    m.body,
    ``,
  ].join('\n')
}

function gitCmd(cwd: string, args: string[]): boolean {
  const result = spawnSync('git', args, { cwd, stdio: 'inherit' })
  return result.status === 0
}
