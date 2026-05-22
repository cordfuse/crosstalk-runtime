/**
 * FilesystemTransport — plain local-FS implementation of the Transport interface.
 *
 * Works with any directory that has the Crosstalk layout (channels/, _system/,
 * manifest/) — no git, no GitHub account, no relay required. Intended for:
 *
 *   - "I just want a local AI swarm on one box"
 *   - NFS / SMB / sshfs mounts shared between machines
 *   - Rapid local experimentation before committing to a git-backed transport
 *
 * Compared to GitTransport:
 *   - No commits, pushes, or per-actor clones — writes go directly to the root
 *   - sync() is a no-op (local FS is always current)
 *   - manifestFileVersion() uses a content SHA-256 prefix instead of git SHA
 *   - watchMessages() is identical (same fs.watch mechanism)
 *
 * The on-disk layout is identical to GitTransport, so a FilesystemTransport
 * directory can be converted to a GitTransport by running `git init && git add
 * -A && git commit -m "initial"` — no message reformatting needed.
 */
import { join } from 'path'
import { mkdir, readFile, readdir, writeFile } from 'fs/promises'
import { watch as fsWatch, mkdirSync } from 'fs'
import { createHash } from 'crypto'
import { messageFilename, messageDatePath, MESSAGE_PATH_RE } from '../filenames.js'
import {
  type Transport, type ActorIdentity, type MessageRef, type MessageEvent,
  SYSTEM_CHANNEL,
} from '../transport.js'
import { loadPrivateSigningKey, signAndEmbed } from '../signing.js'
import { walkChannelMessages } from './git.js'

export interface FilesystemTransportOptions {
  root: string
}

export class FilesystemTransport implements Transport {
  private readonly root: string

  constructor(opts: FilesystemTransportOptions) {
    this.root = opts.root
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async init(): Promise<void> {
    await mkdir(join(this.root, 'channels'), { recursive: true })
    await mkdir(join(this.root, SYSTEM_CHANNEL), { recursive: true })
    await mkdir(join(this.root, 'manifest', 'framework', 'actors'), { recursive: true })
    await mkdir(join(this.root, 'manifest', 'custom', 'actors'), { recursive: true })
  }

  async close(): Promise<void> {}

  // ── Sync ───────────────────────────────────────────────────────────────

  async sync(): Promise<void> {}  // local FS is always current

  // ── Messages ───────────────────────────────────────────────────────────

  async postMessage(channel: string, actor: ActorIdentity, body: string): Promise<string> {
    const isSystem = channel === SYSTEM_CHANNEL
    const now = new Date()
    const datePath = messageDatePath(now)
    const filename = messageFilename(now)
    const relPath = `${datePath}/${filename}`

    let signedBody = body
    try {
      if (loadPrivateSigningKey(actor.name) !== null) {
        signedBody = signAndEmbed(body, actor.name)
      }
    } catch (err) {
      console.warn(`[fs] signing failed for ${actor.name}, posting unsigned: ${err}`)
    }

    const dir = isSystem
      ? join(this.root, SYSTEM_CHANNEL, datePath)
      : join(this.root, 'channels', channel, datePath)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, filename), signedBody, 'utf8')
    return relPath
  }

  async listMessages(channel: string): Promise<string[]> {
    const channelDir = channel === SYSTEM_CHANNEL
      ? join(this.root, SYSTEM_CHANNEL)
      : join(this.root, 'channels', channel)
    return walkChannelMessages(channelDir)
  }

  async listChannels(): Promise<string[]> {
    const channelsDir = join(this.root, 'channels')
    try {
      const entries = await readdir(channelsDir)
      return entries.filter(e => !e.startsWith('.') && !e.startsWith('_'))
    } catch {
      return []
    }
  }

  async readMessage(ref: MessageRef): Promise<string> {
    const base = ref.channel === SYSTEM_CHANNEL
      ? join(this.root, SYSTEM_CHANNEL)
      : join(this.root, 'channels', ref.channel)
    return readFile(join(base, ref.relPath), 'utf-8')
  }

  watchMessages(onMessage: (event: MessageEvent) => void): () => void {
    const channelsDir = join(this.root, 'channels')
    mkdirSync(channelsDir, { recursive: true })

    const watcher = fsWatch(channelsDir, { recursive: true }, async (_event, filename) => {
      if (!filename || !filename.endsWith('.md')) return
      const parts = filename.split('/')
      if (parts.length !== 5) return
      const [channel, year, month, day, file] = parts
      const relPath = `${year}/${month}/${day}/${file}`
      if (!MESSAGE_PATH_RE.test(relPath)) return

      let content: string
      try {
        content = await readFile(join(channelsDir, filename), 'utf-8')
      } catch {
        return
      }
      onMessage({ channel: channel!, relPath, content })
    })

    return () => { try { watcher.close() } catch { /* already closed */ } }
  }

  // ── Manifest ──────────────────────────────────────────────────────────

  async readManifestFile(relPath: string): Promise<string | null> {
    try {
      return await readFile(join(this.root, relPath), 'utf-8')
    } catch {
      return null
    }
  }

  async listManifestDirectory(relDir: string): Promise<string[]> {
    try {
      return await readdir(join(this.root, relDir))
    } catch {
      return []
    }
  }

  async manifestFileVersion(relPath: string): Promise<string> {
    try {
      const content = await readFile(join(this.root, relPath), 'utf-8')
      return createHash('sha256').update(content).digest('hex').slice(0, 12)
    } catch {
      return 'unknown'
    }
  }
}
