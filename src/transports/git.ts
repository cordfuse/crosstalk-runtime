/**
 * GitTransport — git-backed implementation of the {@link Transport}
 * interface. Owns ALL git semantics: clone-per-actor for write isolation,
 * pre-pull-rebase + per-remote push queue + retry loop, push/pull/commit
 * orchestration, fs.watch on the channels directory.
 *
 * v1.1.0 — extracted from the legacy `src/git.ts` (which itself accumulated
 * fixes through v1.0.1 → v1.0.5 as the dogfood Monte Carlo π fan-out test
 * surfaced concurrency bugs). All those fixes are preserved here:
 *
 *  - v1.0.1: pushWithRetry default maxAttempts 5 → 20
 *  - v1.0.2: per-remote push queue (serializes same-daemon pushes)
 *  - v1.0.3: pre-pull-rebase INSIDE the queue critical section
 *  - v1.0.4 / v1.0.5: single-instance lock (lives outside transport,
 *    in src/single-instance.ts — keyed on transport realpath)
 *
 * The push queue is a static class property so multiple GitTransport
 * instances sharing a remote URL (rare but possible) coordinate
 * correctly. Keyed on remote URL, not transport root, because that's
 * where the actual contention is.
 */
import { join } from 'path'
import { homedir } from 'os'
import { mkdir, readFile, readdir, writeFile } from 'fs/promises'
import { watch as fsWatch, mkdirSync } from 'fs'
import { spawn, execFile } from 'child_process'
import { promisify } from 'util'
import { messageFilename, messageDatePath, MESSAGE_PATH_RE } from '../filenames.js'
import {
  type Transport, type ActorIdentity, type MessageRef, type MessageEvent,
  SYSTEM_CHANNEL,
} from '../transport.js'
import { loadPrivateSigningKey, signAndEmbed } from '../signing.js'

const execFileP = promisify(execFile)

const ACTOR_CLONES_DIR = join(homedir(), '.crosstalk', 'actor-clones')

// ── git invocation helper ─────────────────────────────────────────────────

function runGit(cwd: string, args: string[], env?: Record<string, string>): Promise<number> {
  return new Promise<number>((resolve) => {
    const proc = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })
    proc.on('exit', code => resolve(code ?? 0))
    proc.on('error', () => resolve(127))
  })
}

function getRemoteUrl(repoPath: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const proc = spawn('git', ['remote', 'get-url', 'origin'], {
      cwd: repoPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    let stdout = ''
    proc.stdout?.on('data', chunk => { stdout += chunk.toString('utf-8') })
    proc.on('exit', code => {
      if (code !== 0) return resolve(null)
      resolve(stdout.trim() || null)
    })
    proc.on('error', () => resolve(null))
  })
}

// ── push-retry-with-queue (the v1.0.1 → v1.0.3 fixes, preserved) ─────────

/** Per-remote push serialization queue. Static so multiple GitTransport
 * instances (and the legacy `git.ts` shim) share state.
 *
 * v1.0.2+ — eliminates same-daemon push contention. v1.0.3+ — pre-pull
 * BEFORE the first push attempt drops retry rate from ~150% to ~1.7%.
 *
 * Map keyed by remote URL (NOT repoPath), since all actor clones for one
 * transport share a remote, and that's where the contention lives. */
const transportPushQueues = new Map<string, Promise<void>>()

async function pushWithRetryRaw(repoPath: string, maxAttempts: number): Promise<boolean> {
  // Pre-pull: catch up to whatever the previous queued push just landed.
  await runGit(repoPath, ['pull', '--rebase'])
  for (let i = 0; i < maxAttempts; i++) {
    const code = await runGit(repoPath, ['push'])
    if (code === 0) return true
    console.log(`[git] push rejected, rebasing (attempt ${i + 1}/${maxAttempts})`)
    await runGit(repoPath, ['pull', '--rebase'])
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 4000))
  }
  console.error('[git] push failed after max retries')
  return false
}

/** Outcome of a push attempt. v1.13+ — explicit `no-remote` distinguishes
 * the "succeeded because nothing to do" case from a real network push, so
 * callers can avoid emitting `✓ Pushed` on a transport with no `origin`
 * (which was the v1.10 UAT false-positive on offline/local setups). */
export type PushResult = 'pushed' | 'no-remote' | 'failed'

/** Push with rebase-and-retry, serialized per remote URL. Exported as a
 * module-level function so the legacy `src/git.ts` shim can re-export it
 * for the one remaining CLI caller (channel-join). */
export async function pushWithRetryQueued(repoPath: string, maxAttempts = 20): Promise<PushResult> {
  const remoteUrl = await getRemoteUrl(repoPath)
  if (!remoteUrl) return 'no-remote'

  const prev = transportPushQueues.get(remoteUrl) ?? Promise.resolve()
  let ok = false
  const next = prev
    .then(async () => { ok = await pushWithRetryRaw(repoPath, maxAttempts) })
    .catch(() => { ok = false })

  transportPushQueues.set(remoteUrl, next)
  await next

  if (transportPushQueues.get(remoteUrl) === next) {
    transportPushQueues.delete(remoteUrl)
  }
  return ok ? 'pushed' : 'failed'
}

// ── GitTransport ──────────────────────────────────────────────────────────

export interface GitTransportOptions {
  /** Absolute path to the transport repository's working tree. */
  root: string
}

export class GitTransport implements Transport {
  private readonly root: string
  private namespace: string | null = null
  private hasRemoteCached: boolean | null = null

  constructor(opts: GitTransportOptions) {
    this.root = opts.root
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async init(): Promise<void> {
    // Ensure channels/ exists so fs.watch doesn't ENOENT on first message.
    mkdirSync(join(this.root, 'channels'), { recursive: true })
    mkdirSync(join(this.root, SYSTEM_CHANNEL), { recursive: true })
    this.namespace = await this.deriveNamespace()
    this.hasRemoteCached = (await getRemoteUrl(this.root)) !== null
  }

  async close(): Promise<void> {
    // No persistent connections — git is per-call. Nothing to flush;
    // pending pushes are awaited at their caller.
  }

  // ── Sync ───────────────────────────────────────────────────────────────

  async sync(): Promise<void> {
    if (this.hasRemoteCached === false) return  // local-only transport
    const code = await runGit(this.root, ['pull', '--rebase'])
    if (code !== 0) console.error('[git] pull failed after webhook trigger')
  }

  // ── Messages ───────────────────────────────────────────────────────────

  async postMessage(channel: string, actor: ActorIdentity, body: string): Promise<string> {
    const isSystem = channel === SYSTEM_CHANNEL
    const writePath = isSystem ? this.root : await this.ensureActorClone(actor.name)

    const now = new Date()
    const datePath = messageDatePath(now)
    const filename = messageFilename(now)
    const relPath = `${datePath}/${filename}`

    // v1.3.0-alpha.2+ — sign the body with the actor's ed25519 signing key
    // if one exists locally. Opt-in: actors without a generated signing key
    // continue to post unsigned (backward compat with v1.2 transports).
    // The verifier (watcher.ts) treats missing signatures permissively but
    // rejects tampered ones — so opting INTO signing is strictly safer for
    // an actor than opting out.
    let signedBody = body
    try {
      if (loadPrivateSigningKey(actor.name) !== null) {
        signedBody = signAndEmbed(body, actor.name)
      }
    } catch (err) {
      // Signing failures shouldn't break message posting — log and continue
      // with unsigned message. The downstream verifier will surface this
      // as no-signature, which is permissive in alpha.2.
      console.warn(`[git] signing failed for ${actor.name}, posting unsigned: ${err}`)
    }

    const dir = isSystem
      ? join(writePath, SYSTEM_CHANNEL, datePath)
      : join(writePath, 'channels', channel, datePath)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, filename), signedBody, 'utf8')

    const repoRelPath = isSystem
      ? `${SYSTEM_CHANNEL}/${relPath}`
      : `channels/${channel}/${relPath}`
    const commitLabel = isSystem
      ? `sys: ${actor.name}/${relPath}`
      : `msg: ${actor.name} → ${channel.slice(0, 8)}`

    await this.commitAndPush(writePath, repoRelPath, actor, commitLabel)
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
      onMessage({ channel, relPath, content })
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
      const { stdout } = await execFileP('git', ['log', '-1', '--format=%H', '--', relPath], {
        cwd: this.root,
      })
      return stdout.trim() || 'uncommitted'
    } catch {
      return 'unknown'
    }
  }

  // ── git-specific internals (private) ──────────────────────────────────

  /** Derive a namespace label for this transport's actor-clones directory.
   * Uses the remote URL repo name when available, else the basename of
   * the local path. */
  private async deriveNamespace(): Promise<string> {
    const remoteUrl = await getRemoteUrl(this.root)
    if (remoteUrl) {
      const match = remoteUrl.match(/\/([^/]+?)(?:\.git)?$/)
      if (match) return match[1]
    }
    return this.root.split('/').at(-1) ?? 'default'
  }

  /** Returns the path to an actor's own clone of the transport. First
   * call for an actor clones the repo; subsequent calls pull to sync.
   * For local-only transports (no remote), falls back to the shared
   * transport path — clone-per-actor only makes sense when there's a
   * remote to coordinate through. */
  private async ensureActorClone(actorName: string): Promise<string> {
    if (this.hasRemoteCached === null) {
      this.hasRemoteCached = (await getRemoteUrl(this.root)) !== null
    }
    if (!this.hasRemoteCached) return this.root

    if (!this.namespace) this.namespace = await this.deriveNamespace()
    const clonePath = join(ACTOR_CLONES_DIR, this.namespace, actorName)
    const remoteUrl = await getRemoteUrl(this.root)
    if (!remoteUrl) return this.root  // race-safe re-check

    try {
      await readFile(join(clonePath, '.git', 'HEAD'), 'utf-8')
      // Clone exists — sync before dispatch so actor sees triggering message
      const code = await runGit(clonePath, ['pull', '--rebase', '--autostash'])
      if (code !== 0) {
        console.warn(`[git] pull failed for ${actorName} — proceeding with stale clone`)
      }
    } catch {
      // First time — clone the transport for this actor
      const namespaceDir = join(ACTOR_CLONES_DIR, this.namespace)
      await mkdir(namespaceDir, { recursive: true })
      console.log(`[git] initialising clone for ${this.namespace}/${actorName}`)
      const code = await runGit(namespaceDir, ['clone', remoteUrl, actorName])
      if (code !== 0) {
        console.error(`[git] clone failed for ${actorName} — falling back to shared transport`)
        return this.root
      }
    }
    return clonePath
  }

  private async commitAndPush(
    repoPath: string,
    repoRelPath: string,
    actor: ActorIdentity,
    commitMessage: string,
  ): Promise<void> {
    const env = {
      GIT_AUTHOR_NAME: actor.name,
      GIT_AUTHOR_EMAIL: actor.email,
      GIT_COMMITTER_NAME: actor.name,
      GIT_COMMITTER_EMAIL: actor.email,
    }

    const addCode = await runGit(repoPath, ['add', repoRelPath], env)
    if (addCode !== 0) {
      console.error(`[git] add failed for ${repoRelPath}`)
      return
    }

    const commitCode = await runGit(repoPath, ['commit', '-m', commitMessage], env)
    if (commitCode === 1) return  // nothing to commit (rare race)
    if (commitCode !== 0) {
      console.error(`[git] commit failed (code ${commitCode})`)
      return
    }

    await pushWithRetryQueued(repoPath)
  }
}

// ── Channel-history walker (shared utility) ───────────────────────────────

/** Walk a channel directory and return all message relPaths sorted ascending.
 * Used by listMessages on both GitTransport and (when it lands) FilesystemTransport. */
async function walkChannelMessages(channelDir: string): Promise<string[]> {
  const paths: string[] = []
  try {
    const years = await readdir(channelDir)
    for (const year of years.filter(y => /^\d{4}$/.test(y)).sort()) {
      const months = await readdir(join(channelDir, year))
      for (const month of months.filter(m => /^\d{2}$/.test(m)).sort()) {
        const days = await readdir(join(channelDir, year, month))
        for (const day of days.filter(d => /^\d{2}$/.test(d)).sort()) {
          const files = await readdir(join(channelDir, year, month, day))
          for (const file of files.filter(f => f.endsWith('.md')).sort()) {
            paths.push(`${year}/${month}/${day}/${file}`)
          }
        }
      }
    }
  } catch { /* dir may not exist yet */ }
  return paths
}

/** Convenience derivation: actor email from name + suffix. Pure utility;
 * not transport-specific but kept here since `commitAndPush` is the
 * primary consumer.
 *
 * v1.3.0-alpha.6+ — sanitises `@` in addresses to `.` so qualified
 * multi-operator addresses (`alice@steve`) produce legal email local
 * parts (`alice.steve@<suffix>`). Without this, the natural string
 * interpolation builds `alice@steve@<suffix>` which is malformed and
 * gets git CLI rejection on commit. Bare names (single-op) pass
 * through unchanged. */
export function machineGitEmail(actorName: string, suffix: string): string {
  const localPart = actorName.includes('@') ? actorName.replace('@', '.') : actorName
  return `${localPart}@${suffix}`
}

/** Existence check — does this transport's working tree look like a git
 * repo with a remote? Public so callers (e.g. bootstrap.ts deciding
 * whether session-open should push) can branch on it without round-
 * tripping through `postMessage`. */
export async function gitHasRemote(transportRoot: string): Promise<boolean> {
  return (await getRemoteUrl(transportRoot)) !== null
}
