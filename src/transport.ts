/**
 * Transport interface — the abstraction that lets the daemon talk to its
 * underlying storage without caring whether it's git, a plain filesystem,
 * NAS, SFTP, or anything else in the "append-only file-tree" family.
 *
 * Introduced in v1.1.0. Before this, the daemon called git operations
 * directly throughout. The transport-complexity audit (see TODO.md and
 * SESSION_LOG.md 2026-05-17) found ~46% of the codebase existed to manage
 * git semantics — this interface concentrates that surface into one place.
 *
 * What's deliberately NOT here:
 *  - Push/pull/commit/rebase — those are git-specific implementation details
 *    hidden inside `GitTransport`. The interface uses `sync()` and
 *    `postMessage()`.
 *  - Actor clones — also git-specific. `postMessage()` internally routes
 *    through the right working tree.
 *  - Cursors — daemon state (~/.crosstalk/sessions/), not transport state.
 *  - Bootstrap state — protocol-layer concern computed from transport reads.
 *
 * Scope statement: this interface is shaped for the file-tree transport
 * family (git, plain filesystem, NAS/NFS/SMB, SFTP, etc.). It does NOT
 * claim to cover server-mediated relay-as-source-of-truth or P2P transports
 * — those have fundamentally different consistency models and would either
 * contort to fit or ship as their own daemons consuming protocol code as
 * a library. That decision is deferred until/unless such a transport is
 * actually wanted.
 */

/** Who's writing a message. Different transports use this differently:
 * git transports set author name + email; future signing-based transports
 * would derive verification material from `name`. */
export interface ActorIdentity {
  name: string
  email: string
}

/** Reference to a specific message in a specific channel.
 *
 * `channel` is normally a channel GUID. The string `'_system'` is reserved
 * for system messages (presence events, watcher notices, session-open).
 *
 * `relPath` follows the canonical message-file pattern
 * `YYYY/MM/DD/HHMMSSsssZ-<hex>.md` and is used as the cursor key, so
 * lexicographic ordering matches chronological ordering. */
export interface MessageRef {
  channel: string
  relPath: string
}

/** A new-message event delivered to subscribers of `watchMessages`. The
 * full file content is inlined so subscribers don't need a follow-up read
 * for every event. */
export interface MessageEvent extends MessageRef {
  content: string
}

/** Conventional channel name for system messages (presence, watcher
 * notices, session-open). Pass this as `channel` to `postMessage` for
 * system writes. */
export const SYSTEM_CHANNEL = '_system'

export interface Transport {
  // ── Lifecycle ──────────────────────────────────────────────────────

  /** One-time setup at daemon startup. May create directories, open
   * connections, validate config. Called once before any other method. */
  init(): Promise<void>

  /** Graceful shutdown — flush pending writes, close connections.
   * Idempotent; safe to call from signal handlers. */
  close(): Promise<void>

  // ── Sync ───────────────────────────────────────────────────────────

  /** Bring local state up to date with the source of truth. For
   * `GitTransport`: `git pull --rebase`. For server-mediated transports:
   * noop or stream-replay. For pure local file transports: noop.
   * Idempotent — safe to call repeatedly. */
  sync(): Promise<void>

  // ── Messages ───────────────────────────────────────────────────────

  /** Post a message to a channel. `body` is the complete file content
   * including frontmatter (the caller is responsible for formatting).
   * For system messages (presence, bootstrap, watcher notices), pass
   * channel `SYSTEM_CHANNEL`. Returns the `relPath` under which the
   * message was stored — useful for callers that want to advance their
   * own cursor or log what they wrote. */
  postMessage(channel: string, actor: ActorIdentity, body: string): Promise<string>

  /** List all message `relPath`s in a channel, sorted ascending
   * (chronological). Used by cursor walks and bootstrap history reads. */
  listMessages(channel: string): Promise<string[]>

  /** List all channel GUIDs visible in this transport. Excludes
   * `SYSTEM_CHANNEL` and dot-prefixed entries. Used by startup scan
   * and channel-listing CLI subcommands. */
  listChannels(): Promise<string[]>

  /** Read the full content of a specific message. Throws on not-found. */
  readMessage(ref: MessageRef): Promise<string>

  /** Subscribe to new messages as they arrive. Callback fires once per
   * new message after subscription, in arrival order. Returns an
   * unsubscribe function (idempotent). Implementations are responsible
   * for not double-firing the same message (e.g., suppressing the
   * caller's own writes if the underlying mechanism re-reports them). */
  watchMessages(onMessage: (event: MessageEvent) => void): () => void

  // ── Manifest (operator-managed, shared, infrequent reads) ─────────

  /** Read a manifest file (e.g. `manifest/framework/protocol/ROE.md`).
   * Manifest files are operator-managed config shared across all
   * participants — distinct from per-channel messages. Returns `null`
   * if the file is not present. */
  readManifestFile(relPath: string): Promise<string | null>

  /** List entries (basenames, not full paths) under a manifest directory.
   * Used by the actor registry to enumerate `manifest/.../actors/`. */
  listManifestDirectory(relDir: string): Promise<string[]>

  /** Stable version identifier for a manifest file's current content.
   * For `GitTransport`: latest commit SHA touching the file. For other
   * transports: a content hash or monotonic version. Used to stamp
   * `roe-version:` in session-open frontmatter so participants can
   * verify they're booting against the same ROE. */
  manifestFileVersion(relPath: string): Promise<string>
}
