/**
 * ed25519 signing layer for v1.3.0 multi-operator + actor identity.
 *
 * Per the locked design (cordfuse/crosstalk TODO.md #34, 2026-05-17), every
 * message posted by an actor carries an ed25519 signature so recipients can
 * verify "this was authored by an actor whose private key matches the
 * published public key for <addr>". Without verified identity, the
 * multi-operator namespace (`alice@steve` vs `alice@bob`) is decorative —
 * anyone could post `from: alice@steve` and forge attribution.
 *
 * Storage conventions:
 *   Private key:  `~/.crosstalk/keys/<addr>.sign` (mode 600, machine-local)
 *   Public key:   `<transport>/manifest/identities/<addr>.pub` (committed to transport)
 *
 * Address forms (from src/address.ts):
 *   Human:        `steve` → `steve.sign` / `steve.pub`
 *   Machine:      `alice@steve` → `alice@steve.sign` / `alice@steve.pub`
 *
 * Pure crypto primitives + key I/O + sign/verify. NO transport-layer
 * integration; that lands in src/transports/git.ts (postMessage signs,
 * watcher.ts verify on incoming). This module is the foundation those
 * consumers call into.
 *
 * Distinct from `src/crypto.ts` (age encryption, for the v0.8 Privacy
 * minor) and `src/keys.ts` (age key I/O). Different algorithm, different
 * purpose, different key paths. Both can coexist on one actor — an actor
 * can have both an age key (for encryption) and a signing key (for
 * provenance).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { generateKeyPairSync, sign, verify, createPublicKey, createPrivateKey } from 'node:crypto'
import { parseAddress, isAddressError, formatAddress } from './address.js'

const LOCAL_KEYS_DIR = join(homedir(), '.crosstalk', 'keys')

/** Returns the file path where an actor's private signing key is stored
 * locally. Always machine-local; never published to the transport. */
function privateKeyPath(addr: string): string {
  return join(LOCAL_KEYS_DIR, `${addr}.sign`)
}

/** Returns the path within the transport where an actor's public signing
 * key is published. Read by other daemons to verify incoming messages. */
function publicKeyPath(transportRoot: string, addr: string): string {
  return join(transportRoot, 'manifest', 'identities', `${addr}.pub`)
}

/** Validate that an address string is a well-formed actor address. Throws
 * with a descriptive message if not — callers shouldn't be passing
 * unvalidated addresses to crypto operations. */
function requireValidAddress(addr: string): void {
  const parsed = parseAddress(addr)
  if (isAddressError(parsed)) {
    throw new Error(`signing: invalid address "${addr}" — ${parsed.message}`)
  }
  // Round-trip to canonical form (e.g. `steve@steve` → `steve`)
  const canonical = formatAddress(parsed)
  if (canonical !== addr) {
    throw new Error(`signing: address "${addr}" is not canonical (use "${canonical}")`)
  }
}

/** Generate a fresh ed25519 keypair for an actor. Writes the private key
 * to `~/.crosstalk/keys/<addr>.sign` (mode 600) and returns the PEM-encoded
 * public key so the caller can publish it to the transport.
 *
 * Refuses to overwrite an existing private key (call `rotateSigningKey`
 * for that path — separate code to make rotation explicit, not accidental).
 * Throws if the file already exists. */
export function generateSigningKey(addr: string): { publicKeyPem: string } {
  requireValidAddress(addr)
  mkdirSync(LOCAL_KEYS_DIR, { recursive: true })

  const path = privateKeyPath(addr)
  if (existsSync(path)) {
    throw new Error(`signing: private key already exists at ${path} — refusing to overwrite. Use rotateSigningKey() if intentional.`)
  }

  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string
  const publicPem = publicKey.export({ format: 'pem', type: 'spki' }) as string

  writeFileSync(path, privatePem, { mode: 0o600 })

  return { publicKeyPem: publicPem }
}

/** Load the private signing key for an actor from local storage. Returns
 * null if no key exists (typical: the actor is hosted on a different
 * machine, or the key hasn't been generated yet — operator action needed).
 *
 * Permission-paranoid: warns if the file mode isn't 0600 or 0400. Doesn't
 * refuse to load (mirrors the v0.8 age key handling for consistency). */
export function loadPrivateSigningKey(addr: string): import('node:crypto').KeyObject | null {
  requireValidAddress(addr)
  const path = privateKeyPath(addr)
  if (!existsSync(path)) return null

  try {
    const mode = statSync(path).mode & 0o777
    if (mode !== 0o600 && mode !== 0o400) {
      console.warn(`[signing] WARN: ${path} has mode ${mode.toString(8)}; expected 600 or 400. Run 'chmod 600 ${path}' to harden.`)
    }
  } catch { /* skip perm check on error */ }

  try {
    const pem = readFileSync(path, 'utf-8')
    return createPrivateKey(pem)
  } catch (err) {
    throw new Error(`signing: failed to read private key at ${path}: ${err}`)
  }
}

/** Publish an actor's public key to the transport at the canonical path.
 * Creates the `manifest/identities/` directory if it doesn't exist. Caller
 * is responsible for committing + pushing the published key (per the
 * Transport interface — postMessage handles that, but for key publish it's
 * typically a CLI subcommand step). */
export function publishPublicKey(transportRoot: string, addr: string, publicKeyPem: string): void {
  requireValidAddress(addr)
  const path = publicKeyPath(transportRoot, addr)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, publicKeyPem, 'utf-8')
}

/** Load an actor's published public key from the transport. Used by
 * recipients to verify incoming messages.
 *
 * Returns null if the public key isn't published — caller decides how to
 * handle (typically: log a warning, treat the message as unsigned, fall
 * back to ROE policy for unsigned messages). */
export function loadPublicKey(transportRoot: string, addr: string): import('node:crypto').KeyObject | null {
  requireValidAddress(addr)
  const path = publicKeyPath(transportRoot, addr)
  if (!existsSync(path)) return null
  try {
    const pem = readFileSync(path, 'utf-8')
    return createPublicKey(pem)
  } catch (err) {
    throw new Error(`signing: failed to read public key at ${path}: ${err}`)
  }
}

/** Strip the `signature:` frontmatter line from a message file so the
 * remainder can be canonically hashed for signing/verification. Returns
 * the canonical bytes that BOTH sign and verify operate on.
 *
 * Why strip the signature line: it's circular — the signature value can't
 * be part of what it signs over. Stripping the entire line (not just the
 * value) avoids ambiguity about exactly which bytes are signed. */
export function canonicalize(messageContent: string): string {
  // Match the signature line anywhere in the frontmatter block. Strict:
  // must be `signature: <value>\n` at the start of a line. We delete the
  // entire line including its trailing newline so the canonical form is
  // exactly what the message would look like before the signature was
  // computed and inserted.
  return messageContent.replace(/^signature:[^\n]*\n/m, '')
}

/** Sign a message with the actor's private key. Returns the base64-encoded
 * signature. Caller is responsible for inserting `signature: <returned>`
 * into the message frontmatter.
 *
 * Throws if the private key doesn't exist locally. */
export function signMessage(messageContent: string, addr: string): string {
  const key = loadPrivateSigningKey(addr)
  if (!key) {
    throw new Error(`signing: no private signing key for "${addr}" at ${privateKeyPath(addr)}. Generate with crosstalk actor key generate.`)
  }
  const canonical = canonicalize(messageContent)
  const signature = sign(null, Buffer.from(canonical, 'utf-8'), key)
  return signature.toString('base64')
}

/** Verify a message's signature against the actor's published public key.
 *
 * Returns:
 *   - `{ valid: true }` if signature checks out
 *   - `{ valid: false, reason: 'no-signature' }` if message has no signature line
 *   - `{ valid: false, reason: 'no-public-key' }` if address has no published .pub
 *   - `{ valid: false, reason: 'signature-mismatch' }` if cryptographically invalid
 *
 * Distinguishes between "couldn't verify" and "verified as tampered" because
 * callers handle them differently (unsigned might be allowed under
 * permissive ROE; tampered should always be rejected). */
export type VerifyResult =
  | { valid: true }
  | { valid: false; reason: 'no-signature' | 'no-public-key' | 'signature-mismatch'; detail?: string }

export function verifyMessage(
  messageContent: string,
  addr: string,
  transportRoot: string,
): VerifyResult {
  // Extract the signature from frontmatter (if present)
  const sigMatch = messageContent.match(/^signature:\s*([A-Za-z0-9+/=]+)\s*$/m)
  if (!sigMatch) {
    return { valid: false, reason: 'no-signature' }
  }
  const signatureB64 = sigMatch[1]

  const publicKey = loadPublicKey(transportRoot, addr)
  if (!publicKey) {
    return { valid: false, reason: 'no-public-key' }
  }

  const canonical = canonicalize(messageContent)
  let valid: boolean
  try {
    valid = verify(
      null,
      Buffer.from(canonical, 'utf-8'),
      publicKey,
      Buffer.from(signatureB64, 'base64'),
    )
  } catch (err) {
    return { valid: false, reason: 'signature-mismatch', detail: String(err) }
  }

  return valid ? { valid: true } : { valid: false, reason: 'signature-mismatch' }
}

/** Embed a signature into a message file's frontmatter. Inserts a
 * `signature: <base64>` line immediately before the closing `---` of the
 * frontmatter block. Convenience helper for callers; doesn't sign or verify.
 *
 * Throws if the message has no closing `---` (malformed frontmatter). */
export function embedSignature(messageContent: string, signatureB64: string): string {
  // Find the second `---` (closing of frontmatter)
  const lines = messageContent.split('\n')
  let openIdx = -1
  let closeIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '---') {
      if (openIdx < 0) openIdx = i
      else { closeIdx = i; break }
    }
  }
  if (openIdx < 0 || closeIdx < 0) {
    throw new Error('signing: message has no complete frontmatter block (missing --- delimiters)')
  }
  lines.splice(closeIdx, 0, `signature: ${signatureB64}`)
  return lines.join('\n')
}

/** Convenience: sign a message AND embed the signature in one call.
 * The typical postMessage flow. */
export function signAndEmbed(messageContent: string, addr: string): string {
  const signature = signMessage(messageContent, addr)
  return embedSignature(messageContent, signature)
}
