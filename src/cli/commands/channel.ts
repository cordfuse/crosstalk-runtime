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
import { messageDatePath, messageFilename } from '../../filenames.js'
import { parseFrontmatter } from '../../frontmatter.js'
import { listChannels, resolveChannel, formatRelativeTime, readChannelMessages, printMessage } from '../lib/channel.js'
import { registerChannelJoin } from './channel-join.js'
import { pushWithRetry } from '../../git.js'

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
    const filename  = messageFilename(now)
    const datePath  = messageDatePath(now)
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
    // v1.10.0-alpha.2+ — pushWithRetry handles CLI/daemon push contention.
    const pushed = await pushWithRetry(config.transport, 5)
    if (!pushed) {
      console.error(`✗ Push failed after retries — commit is local. Run \`git -C ${config.transport} pull --rebase && git push\` to recover.`)
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
  as?:   string  // v0.8.0-alpha.7+ — actor identity to use for decryption
  /** v0.8.0-alpha.7+ — commander inverts --no-decrypt to decrypt: false.
   * Default true (decryption attempted with --as identity). */
  decrypt?: boolean
}

function registerChannelShow(parent: Command): void {
  parent
    .command('show <name-or-guid>')
    .description('print messages in a channel chronologically (v0.8+: encrypted bodies decrypted with --as identity)')
    .option('--last <n>',     'limit to the last N messages (default: all)')
    .option('--json',         'machine-readable JSON output')
    .option('--as <actor>',   'identity to attempt decryption with (defaults to default-human-actor in config; v0.8+)')
    .option('--no-decrypt',   'show encrypted bodies as opaque ciphertext (default: attempt decrypt with --as identity; v0.8+)')
    .action(async (query: string, opts: ChannelShowOptions) => {
      await runChannelShow(query, opts)
    })
}

async function runChannelShow(query: string, opts: ChannelShowOptions): Promise<void> {
  const config = await loadConfig()
  const guid = resolveChannelOrSystem(config.transport, query)
  const channelDir = join(config.transport, 'channels', guid)

  let messages = readChannelMessages(channelDir)
  const limit = opts.last ? parseInt(opts.last, 10) : undefined
  if (limit && limit > 0 && messages.length > limit) {
    messages = messages.slice(-limit)
  }

  // v0.8.0-alpha.7+ decrypt-on-read. opts.decrypt defaults to true; --no-decrypt sets it to false.
  if (opts.decrypt !== false) {
    const asActor = opts.as ?? config.defaultHumanActor
    if (asActor) {
      messages = await Promise.all(messages.map(m => decryptForDisplay(m, asActor)))
    }
    // else: no identity available; encrypted messages render with placeholder
    // (decryptForDisplay called with empty asActor produces a "no identity"
    // placeholder via the same helper).
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

/** Returns the message with its body replaced by either:
 * - the decrypted plaintext (success)
 * - a placeholder string explaining why decryption didn't happen
 *   (no identity for asActor, identity not a recipient, etc.)
 *
 * Pure: doesn't mutate the input. Returns a new RenderedMessage with
 * cleaned-up frontmatter (encryption fields stripped on success) so
 * downstream renderers can show plaintext naturally. */
export async function decryptForDisplay(m: import('../lib/channel.js').RenderedMessage, asActor: string): Promise<import('../lib/channel.js').RenderedMessage> {
  const enc = String(m.data.encryption ?? '')
  if (enc !== 'age') return m  // not encrypted, pass through

  const encryptedTo = String(m.data['encrypted-to'] ?? '?')

  if (!asActor) {
    return { ...m, body: `[encrypted to: ${encryptedTo}]\n[no decryption identity available — pass --as <actor> or set default-human-actor]` }
  }

  const { unwrapFromMessageBody, decrypt } = await import('../../crypto.js')
  const armored = unwrapFromMessageBody(m.body)
  if (!armored) {
    return { ...m, body: `[encrypted to: ${encryptedTo}]\n[malformed: encryption: age set but no fenced age block in body]` }
  }

  const { loadActorIdentity, loadActorIdentityArchive } = await import('../../keys.js')
  const current = loadActorIdentity(asActor)
  const archived = loadActorIdentityArchive(asActor)
  const candidates = current ? [current, ...archived] : archived

  if (candidates.length === 0) {
    return { ...m, body: `[encrypted to: ${encryptedTo}]\n[no private key for ${asActor} on this machine — run \`crosstalk actor key generate ${asActor}\`]` }
  }

  for (const id of candidates) {
    try {
      const plaintext = await decrypt(armored, id)
      // Strip encryption fields from displayed frontmatter so the printed
      // header doesn't redundantly show encryption: age (the body's already
      // plaintext from the reader's perspective).
      const cleanData = { ...m.data }
      delete cleanData.encryption
      delete cleanData['encrypted-to']
      return { ...m, body: plaintext, data: cleanData }
    } catch {
      continue
    }
  }

  return { ...m, body: `[encrypted to: ${encryptedTo}]\n[${asActor}'s identity is not a recipient — none of ${candidates.length} available identities (current + archive) could decrypt]` }
}

// ── channel tail ────────────────────────────────────────────────────────

interface ChannelTailOptions {
  backfill?: string
  as?:   string  // v0.8.1+ — actor identity to use for decryption
  /** v0.8.1+ — commander inverts --no-decrypt to decrypt: false.
   * Default true (decryption attempted with --as identity). */
  decrypt?: boolean
}

function registerChannelTail(parent: Command): void {
  parent
    .command('tail <name-or-guid>')
    .description('follow a channel in real time — prints new messages as they arrive (v0.8.1+: encrypted bodies decrypted with --as identity)')
    .option('--backfill <n>', 'print last N messages before tailing (default 10)')
    .option('--as <actor>',   'identity to attempt decryption with (defaults to default-human-actor in config; v0.8.1+)')
    .option('--no-decrypt',   'show encrypted bodies as opaque ciphertext (default: attempt decrypt with --as identity; v0.8.1+)')
    .action(async (query: string, opts: ChannelTailOptions) => {
      await runChannelTail(query, opts)
    })
}

async function runChannelTail(query: string, opts: ChannelTailOptions): Promise<void> {
  const config = await loadConfig()
  const guid = resolveChannelOrSystem(config.transport, query)
  const channelDir = join(config.transport, 'channels', guid)

  // v0.8.1+ decrypt-on-read setup. opts.decrypt defaults to true; --no-decrypt sets it to false.
  const shouldDecrypt = opts.decrypt !== false
  const asActor = shouldDecrypt ? (opts.as ?? config.defaultHumanActor ?? '') : ''
  const maybeDecrypt = async (m: import('../lib/channel.js').RenderedMessage) =>
    shouldDecrypt ? await decryptForDisplay(m, asActor) : m

  // Backfill
  const backfillN = opts.backfill ? parseInt(opts.backfill, 10) : 10
  const existing = readChannelMessages(channelDir)
  const backfill = backfillN > 0 ? existing.slice(-backfillN) : []
  for (const m of backfill) printMessage(await maybeDecrypt(m))
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
      printMessage(await maybeDecrypt(m))
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

/**
 * v1.13+ — channel resolver that accepts the reserved `_`-prefixed
 * system channels (`_system`, etc.) as literal directory names.
 *
 * `resolveChannel` (in cli/lib/channel.ts) routes through `listChannels`
 * which hides `_`-prefixed entries by default, so `channel show _system`
 * printed "No channel matches" even though the daemon writes presence,
 * bootstrap, and quorum-failed events there. This wrapper carves out the
 * underscore prefix — reserved per transport.ts SYSTEM_CHANNEL — and
 * passes everything else through unchanged.
 */
function resolveChannelOrSystem(transport: string, query: string): string {
  if (query.startsWith('_')) {
    const systemDir = join(transport, 'channels', query)
    if (!existsSync(systemDir)) {
      console.error(`✗ System channel '${query}' has no directory at ${systemDir}`)
      console.error(`  (Nothing has been written there yet — system channels are created on first write.)`)
      process.exit(1)
    }
    return query
  }
  return resolveChannel(transport, query)
}

// Filename + datePath helpers extracted to src/filenames.ts in v0.7.x
// scaffolding pass — see `messageFilename` / `messageDatePath` import.

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
