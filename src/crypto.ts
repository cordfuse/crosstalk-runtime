/**
 * Crypto foundation for v0.8 Privacy. Wraps the `age-encryption` library
 * (FiloSottile's TypeScript implementation of the age file encryption format)
 * with a small, opinionated API matching how Crosstalk uses it.
 *
 * Library choice — `age-encryption` v0.3.0 by FiloSottile (creator of age):
 * - Pure TypeScript implementation, no native bindings, no external binary
 * - Depends only on the `@noble/*` audited cryptography libraries (curves,
 *   ciphers, hashes, post-quantum) that `age-encryption` co-author Paul
 *   Miller maintains
 * - Uses Web Crypto API where available; falls back to noble JS otherwise
 * - BSD-3-Clause; mature (v0.3.0 published 2025-12-29)
 * - ES2023, Node 20+ compatible (matches our `engines.node >=18` — but we'll
 *   target Node 20 as a soft requirement for the encryption code path)
 *
 * Design choices for this wrapper:
 *
 * 1. **ASCII armor on output.** Encrypted bodies live inside markdown files,
 *    which need text-safe content. We always armor (PEM-like format) on
 *    encrypt + de-armor on decrypt. The body that lands in a message file
 *    is the armored form, wrapped in our fenced ```age block.
 *
 * 2. **Multi-recipient via repeated addRecipient.** Per PRIVACY.md spec,
 *    encrypting to multiple `to:` actors uses `age`'s native multi-recipient
 *    mode — the body is encrypted once with a per-message symmetric key,
 *    and that key is wrapped to each recipient's pubkey separately. Any
 *    one recipient can decrypt with their own private key.
 *
 * 3. **Throw on errors with descriptive messages.** Encryption/decryption
 *    failures should never silently degrade to plaintext or accept garbage.
 *    Caller catches + handles per its own policy (validator surfaces, dispatch
 *    skips actor + logs, etc.).
 *
 * 4. **No file I/O in this module.** Pure functions over strings/bytes.
 *    The key-file storage convention from PRIVACY.md (`~/.crosstalk/keys/
 *    <actor>.key` private + `manifest/{custom,framework}/keys/<actor>.pub`
 *    transport-shipped) is implemented in subsequent PRs (key generate CLI,
 *    dispatch encrypt-outbound hooks, etc.).
 *
 * 5. **No streaming.** age-encryption supports streaming encryption for
 *    large files; Crosstalk message bodies are small enough (typically <
 *    16KB) that the in-memory API is fine. If we ever need streaming for
 *    attachment encryption, that's a separate concern handled in the
 *    attachment-protocol layer.
 *
 * What this module does NOT do (deferred to subsequent v0.8 alpha PRs):
 * - Key generation/rotation CLI (`crosstalk actor key generate`) — PR-2
 * - Dispatch encrypt-outbound hooks — PR-3
 * - Post --encrypt flag — PR-4
 * - Validator extensions for `encryption-mode: required` — PR-5
 * - Decrypt-on-read in `crosstalk channel show` — PR-6
 *
 * Each subsequent PR uses this module's API surface and lands incrementally
 * under Steve's review per the v0.8 PR-by-PR review model.
 */
import * as age from 'age-encryption'

// ── Types ─────────────────────────────────────────────────────────────────

/** An age recipient — the public key counterpart, safe to share. Format
 * is the standard age `age1...` text representation. */
export type AgeRecipient = string

/** An age identity — the private key counterpart. Format is the standard
 * age `AGE-SECRET-KEY-1...` text representation. NEVER write to a transport
 * file or commit to git. */
export type AgeIdentity = string

/** Result of `generateKeypair()` — pair of recipient (public) + identity (private). */
export interface AgeKeypair {
  recipient: AgeRecipient
  identity:  AgeIdentity
}

// ── Generation ────────────────────────────────────────────────────────────

/** Generate a fresh X25519 age keypair. Returns both halves; caller is
 * responsible for storing them (recipient → transport, identity → machine-
 * local with 0600 perms). */
export async function generateKeypair(): Promise<AgeKeypair> {
  const identity  = await age.generateIdentity()
  const recipient = await age.identityToRecipient(identity)
  return { recipient, identity }
}

// ── Encryption ────────────────────────────────────────────────────────────

/** Encrypt a plaintext string to one or more recipients using age's native
 * multi-recipient mode. Output is ASCII-armored (PEM-like text format)
 * suitable for embedding in markdown files inside a fenced ```age block.
 *
 * Throws if no recipients given or if any recipient string is malformed. */
export async function encrypt(plaintext: string, recipients: AgeRecipient[]): Promise<string> {
  if (recipients.length === 0) {
    throw new Error('encrypt: at least one recipient required')
  }
  const e = new age.Encrypter()
  for (const r of recipients) {
    try {
      e.addRecipient(r)
    } catch (err) {
      throw new Error(`encrypt: invalid age recipient '${r.slice(0, 32)}...': ${err}`)
    }
  }
  const ciphertext = await e.encrypt(plaintext)
  return age.armor.encode(ciphertext)
}

// ── Decryption ────────────────────────────────────────────────────────────

/** Decrypt an ASCII-armored age ciphertext using the given identity (private
 * key). Returns plaintext string.
 *
 * Throws if the armored input is malformed, the identity is invalid, or the
 * ciphertext was not encrypted to this identity (decryption fails — no key
 * in the recipient envelope matches). */
export async function decrypt(armoredCiphertext: string, identity: AgeIdentity): Promise<string> {
  let ciphertext: Uint8Array
  try {
    ciphertext = age.armor.decode(armoredCiphertext)
  } catch (err) {
    throw new Error(`decrypt: failed to decode armored ciphertext: ${err}`)
  }
  const d = new age.Decrypter()
  try {
    d.addIdentity(identity)
  } catch (err) {
    throw new Error(`decrypt: invalid age identity: ${err}`)
  }
  try {
    return await d.decrypt(ciphertext, 'text')
  } catch (err) {
    throw new Error(`decrypt: decryption failed (this identity may not be a recipient of this ciphertext): ${err}`)
  }
}

// ── Body wrapping (Crosstalk-specific) ────────────────────────────────────

/** Wrap an armored ciphertext in the Crosstalk message-body format —
 * a fenced ```age block. This matches PRIVACY.md's wire format spec.
 *
 * Output looks like:
 *
 *     ```age
 *     -----BEGIN AGE ENCRYPTED FILE-----
 *     <base64 payload>
 *     -----END AGE ENCRYPTED FILE-----
 *     ```
 *
 * The fenced block is the entire body of the message file (after the
 * frontmatter). Readers detect the block by looking for the language
 * tag `age`.
 */
export function wrapForMessageBody(armoredCiphertext: string): string {
  return '```age\n' + armoredCiphertext.trim() + '\n```\n'
}

/** Extract the armored ciphertext from a Crosstalk message body. Returns
 * null if the body is not in the encrypted format (no fenced ```age block
 * found at the start of the body).
 *
 * Tolerates leading/trailing whitespace; rejects bodies with content
 * outside the fenced block (which would be a spec violation per PRIVACY.md
 * — the body of an encrypted message is JUST the fenced block, no other
 * content). */
export function unwrapFromMessageBody(body: string): string | null {
  const trimmed = body.trim()
  const match = trimmed.match(/^```age\r?\n([\s\S]+?)\r?\n```\s*$/)
  if (!match) return null
  return match[1].trim()
}
