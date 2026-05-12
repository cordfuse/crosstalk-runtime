/**
 * Shared channel helpers — used by post, channel new/list/show/tail, and ls.
 *
 * Channel resolution: friendly name → GUID via _header.md scan, with
 * substring + ambiguity handling.
 *
 * Channel listing: scan all channel directories, derive lastActivity and
 * messageCount from filenames (zero-padded so lex sort = chrono sort,
 * no need to git log or stat files).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter } from '../../frontmatter.js'

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MESSAGE_FILE = /^\d{9}Z\.md$/   // HHMMSSsssZ.md
const DATE_DIR     = /^\d{2}$/        // MM or DD
const YEAR_DIR     = /^\d{4}$/

export interface ChannelInfo {
  guid:          string
  name:          string
  description?:  string
  /** ISO timestamp of the latest message file in this channel, or null if empty. */
  lastActivity:  string | null
  messageCount:  number
}

/** Walk channels/ directory and produce a ChannelInfo per channel that has
 * an _header.md. System channels (`_system/`) and dotted entries are skipped
 * unless includeSystem is true. */
export function listChannels(
  transport: string,
  opts: { includeSystem?: boolean } = {}
): ChannelInfo[] {
  const channelsDir = join(transport, 'channels')
  if (!existsSync(channelsDir)) return []

  const out: ChannelInfo[] = []
  for (const entry of readdirSync(channelsDir)) {
    if (entry.startsWith('.')) continue
    if (entry.startsWith('_') && !opts.includeSystem) continue

    const channelDir = join(channelsDir, entry)
    if (!statSync(channelDir).isDirectory()) continue

    const headerPath = join(channelDir, '_header.md')
    let name = entry
    let description: string | undefined
    if (existsSync(headerPath)) {
      try {
        const content = readFileSync(headerPath, 'utf-8')
        const { data, body } = parseFrontmatter(content)
        if (typeof data.name === 'string' && data.name.trim()) name = data.name.trim()
        if (typeof data.description === 'string') description = data.description.trim()
        else if (body && body.trim()) description = body.trim().split('\n')[0]?.slice(0, 80)
      } catch {
        // ignore unreadable
      }
    }

    const { lastActivity, messageCount } = scanChannelMessages(channelDir)
    out.push({ guid: entry, name, description, lastActivity, messageCount })
  }
  return out
}

/** Walk YYYY/MM/DD/HHMMSSsssZ.md tree under a channel dir.
 * Returns latest message's reconstructed ISO timestamp + total count. */
function scanChannelMessages(channelDir: string): { lastActivity: string | null; messageCount: number } {
  let count = 0
  let latest: { y: string; m: string; d: string; t: string } | null = null

  let years: string[] = []
  try { years = readdirSync(channelDir).filter(e => YEAR_DIR.test(e)).sort() } catch { return { lastActivity: null, messageCount: 0 } }

  for (const y of years) {
    let months: string[] = []
    try { months = readdirSync(join(channelDir, y)).filter(e => DATE_DIR.test(e)).sort() } catch { continue }
    for (const m of months) {
      let days: string[] = []
      try { days = readdirSync(join(channelDir, y, m)).filter(e => DATE_DIR.test(e)).sort() } catch { continue }
      for (const d of days) {
        let files: string[] = []
        try { files = readdirSync(join(channelDir, y, m, d)).filter(e => MESSAGE_FILE.test(e)).sort() } catch { continue }
        count += files.length
        if (files.length > 0) {
          const last = files[files.length - 1]!
          if (!latest || compareLatest(latest, { y, m, d, t: last }) < 0) {
            latest = { y, m, d, t: last }
          }
        }
      }
    }
  }

  if (!latest) return { lastActivity: null, messageCount: count }
  // filename: HHMMSSsssZ.md — reconstruct full ISO
  const t = latest.t.slice(0, 9) // HHMMSSsss (drop "Z.md")
  const iso = `${latest.y}-${latest.m}-${latest.d}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}.${t.slice(6, 9)}Z`
  return { lastActivity: iso, messageCount: count }
}

function compareLatest(a: { y: string; m: string; d: string; t: string }, b: { y: string; m: string; d: string; t: string }): number {
  return (a.y + a.m + a.d + a.t).localeCompare(b.y + b.m + b.d + b.t)
}

/** Resolve a user-supplied channel reference (GUID, exact friendly name, or
 * single-substring match) into a GUID. Calls process.exit(1) with a helpful
 * error on no-match or ambiguity. */
export function resolveChannel(transport: string, query: string): string {
  const channelsDir = join(transport, 'channels')
  if (!existsSync(channelsDir)) {
    console.error(`✗ Transport has no channels/ directory: ${transport}`)
    process.exit(1)
  }

  if (GUID_PATTERN.test(query)) {
    if (existsSync(join(channelsDir, query))) return query
    console.error(`✗ Channel GUID not found: ${query}`)
    process.exit(1)
  }

  const candidates = listChannels(transport).map(c => ({ guid: c.guid, name: c.name }))

  const exact = candidates.find(c => c.name === query)
  if (exact) return exact.guid

  const partial = candidates.filter(c => c.name.toLowerCase().includes(query.toLowerCase()))
  if (partial.length === 1) return partial[0]!.guid
  if (partial.length > 1) {
    console.error(`✗ Ambiguous channel name '${query}'. Matches:`)
    for (const p of partial) console.error(`    ${p.name}  (${p.guid})`)
    process.exit(1)
  }

  console.error(`✗ No channel matches '${query}'`)
  if (candidates.length === 0) {
    console.error(`  No channels exist yet. Use \`crosstalk channel new\` to create one.`)
  } else {
    console.error(`  Available channels:`)
    for (const c of candidates) console.error(`    ${c.name}  (${c.guid.slice(0, 8)}...)`)
  }
  process.exit(1)
}

/** Compact relative-time formatter — "2m ago", "1h ago", "3d ago", "2026-05-10". */
export function formatRelativeTime(iso: string | null): string {
  if (!iso) return '(empty)'
  const then = new Date(iso).getTime()
  const now  = Date.now()
  const diffSec = Math.max(0, Math.floor((now - then) / 1000))
  if (diffSec < 60)        return `${diffSec}s ago`
  if (diffSec < 3600)      return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86_400)    return `${Math.floor(diffSec / 3600)}h ago`
  if (diffSec < 7 * 86_400) return `${Math.floor(diffSec / 86_400)}d ago`
  return iso.slice(0, 10) // YYYY-MM-DD
}
