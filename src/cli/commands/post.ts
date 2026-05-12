/**
 * `crosstalk post` — write a message to a channel without hand-editing files.
 *
 * Replaces the README's Option B (hand-write YAML frontmatter, generate the
 * timestamped filename, mkdir -p the date path, git add/commit/push). Does
 * all of that in one command.
 *
 *   crosstalk post --channel <name-or-guid> --to <actor[,actor]> --body "..."
 *
 * Channel resolution:
 *   - GUID input (`4afe70e7-...`) accepted as-is if the directory exists
 *   - Friendly name (from <channel>/_header.md `name:` field) resolved to its GUID
 *   - Substring match if exact name not found and exactly one channel matches
 *   - Ambiguous / no-match → error with the candidate list
 *
 * Target validation:
 *   - --to all → no validation
 *   - Otherwise: every comma-separated target must be in the actor registry
 *     (manifest/framework/actors/, manifest/custom/actors/, ~/.crosstalk/actors/)
 *   - --allow-unknown-targets bypasses (useful for spawn-announce flows where
 *     the target actor doesn't exist in the registry yet)
 *
 * Identity:
 *   - --from <actor> wins
 *   - Otherwise reads default-human-actor from ~/.crosstalk/config.toml
 *   - If neither set: error (no automatic guess — identity is too important
 *     to default silently)
 *
 * Atomic file write + git add + git commit + git push (in the operator's
 * transport clone). --no-push leaves the commit local.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { Command } from 'commander'

import { loadConfig } from '../../config.js'
import { loadRegistry } from '../../registry.js'
import { parseFrontmatter } from '../../frontmatter.js'

interface PostOptions {
  channel:               string
  to:                    string
  body:                  string
  from?:                 string
  type?:                 string
  push?:                 boolean   // commander inverts --no-push to push: false
  allowUnknownTargets?:  boolean
}

export function registerPostCommand(program: Command): void {
  program
    .command('post')
    .description('post a message to a channel — writes the file with proper frontmatter, commits, and pushes')
    .requiredOption('-c, --channel <name-or-guid>',  'channel to post into (friendly name from _header.md, or full GUID)')
    .requiredOption('-t, --to <actor[,actor]>',      'comma-separated targets, or "all"')
    .requiredOption('-b, --body <text>',             'message body text')
    .option('-f, --from <actor>',                    'sender identity (defaults to default-human-actor in config.toml)')
    .option('--type <type>',                         'message type: text (attachment-ref support lands in a later alpha)', 'text')
    .option('--no-push',                             'commit but do not push (leaves the commit local)')
    .option('--allow-unknown-targets',               'do not error when --to actors are missing from the registry')
    .action(async (options: PostOptions) => {
      await runPost(options)
    })
}

async function runPost(opts: PostOptions): Promise<void> {
  if (opts.type !== 'text') {
    console.error(`✗ --type ${opts.type} not yet supported. Only "text" works in v0.5.0-alpha.3.`)
    console.error(`  Attachment-ref support lands in a later alpha (TODO #17 follow-up).`)
    process.exit(1)
  }

  const config = await loadConfig()

  // Resolve channel name → GUID
  const channelGuid = resolveChannel(config.transport, opts.channel)

  // Load registry, validate targets
  const registry = await loadRegistry(config.transport)
  const targetsRaw = opts.to.trim()
  const targets: 'all' | string[] = targetsRaw === 'all'
    ? 'all'
    : targetsRaw.split(',').map(t => t.trim()).filter(Boolean)

  if (targets !== 'all' && !opts.allowUnknownTargets) {
    const unknown = (targets as string[]).filter(t => !registry.has(t))
    if (unknown.length > 0) {
      const known = [...registry.keys()].sort().join(', ')
      console.error(`✗ Unknown actor target(s): ${unknown.join(', ')}`)
      console.error(`  Known actors: ${known || '(none)'}`)
      console.error(`  Use --allow-unknown-targets to bypass this check.`)
      process.exit(1)
    }
  }

  // Resolve sender
  const from = opts.from ?? config.defaultHumanActor
  if (!from) {
    console.error(`✗ --from is required.`)
    console.error(`  Either pass --from <actor>, or set default-human-actor in ~/.crosstalk/config.toml.`)
    process.exit(1)
  }

  // Compose message
  const now = new Date()
  const filename  = formatTimestampFilename(now)
  const datePath  = formatDatePath(now)
  const targetDir = join(config.transport, 'channels', channelGuid, datePath)
  const targetFile = join(targetDir, filename)
  const toField   = targets === 'all' ? 'all' : (targets as string[]).join(', ')
  const messageContent = composeMessage({
    from,
    to:        toField,
    timestamp: now.toISOString(),
    type:      'text',
    body:      opts.body,
  })

  // Atomic write — temp in same directory as target so rename never crosses fs
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true })
  const tmpFile = join(targetDir, `.${filename}.tmp.${process.pid}`)
  writeFileSync(tmpFile, messageContent)
  renameSync(tmpFile, targetFile)
  console.log(`✓ Wrote channels/${channelGuid}/${datePath}/${filename}`)

  // Git operations
  const relPath = `channels/${channelGuid}/${datePath}/${filename}`
  if (!gitCmd(config.transport, ['add', relPath]))                        process.exit(1)

  const commitMsg = `msg: ${from} → ${toField}`
  if (!gitCmd(config.transport, ['commit', '-m', commitMsg]))             process.exit(1)
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

// ── Channel resolution ──────────────────────────────────────────────────────

function resolveChannel(transport: string, query: string): string {
  const channelsDir = join(transport, 'channels')
  if (!existsSync(channelsDir)) {
    console.error(`✗ Transport has no channels/ directory: ${transport}`)
    process.exit(1)
  }

  // GUID-shaped input: accept directly if the directory exists
  const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (guidPattern.test(query)) {
    if (existsSync(join(channelsDir, query))) return query
    console.error(`✗ Channel GUID not found: ${query}`)
    process.exit(1)
  }

  // Friendly-name lookup via _header.md scan
  const candidates: { guid: string; name: string }[] = []
  for (const entry of readdirSync(channelsDir)) {
    if (entry.startsWith('.') || entry.startsWith('_')) continue
    const headerPath = join(channelsDir, entry, '_header.md')
    if (!existsSync(headerPath)) continue
    try {
      const content = readFileSync(headerPath, 'utf-8')
      const { data } = parseFrontmatter(content)
      const name = String(data.name ?? '').trim()
      if (name) candidates.push({ guid: entry, name })
    } catch {
      // ignore unreadable headers
    }
  }

  // Exact match
  const exact = candidates.find(c => c.name === query)
  if (exact) return exact.guid

  // Single substring match (case-insensitive)
  const partial = candidates.filter(c =>
    c.name.toLowerCase().includes(query.toLowerCase())
  )
  if (partial.length === 1) return partial[0]!.guid
  if (partial.length > 1) {
    console.error(`✗ Ambiguous channel name '${query}'. Matches:`)
    for (const p of partial) console.error(`    ${p.name}  (${p.guid})`)
    process.exit(1)
  }

  // No match
  console.error(`✗ No channel matches '${query}'`)
  if (candidates.length === 0) {
    console.error(`  No channels with _header.md exist yet. Use \`crosstalk channel new\` (lands in alpha.4).`)
  } else {
    console.error(`  Available channels:`)
    for (const c of candidates) console.error(`    ${c.name}  (${c.guid.slice(0, 8)}...)`)
  }
  process.exit(1)
}

// ── Helpers ──────────────────────────────────────────────────────────────

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

interface MessageInputs {
  from:      string
  to:        string
  timestamp: string
  type:      string
  body:      string
}

function composeMessage(m: MessageInputs): string {
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
