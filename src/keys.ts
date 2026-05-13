/**
 * Key file I/O for v0.8 Privacy. Reads private keys from machine-local
 * `~/.crosstalk/keys/<actor>.key` (per `PRIVACY.md` storage convention)
 * and public keys from `manifest/{custom,framework}/keys/<actor>.pub`
 * (transport-shipped).
 *
 * Distinct from `src/crypto.ts` (which is the pure age-library wrapper).
 * This module owns file paths, permission expectations, and key-presence
 * checks. It does NOT generate keys (that's `crosstalk actor key generate`)
 * and does NOT encrypt/decrypt (that's crypto.ts).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { AgeIdentity, AgeRecipient } from './crypto.js'

const LOCAL_KEYS_DIR  = join(homedir(), '.crosstalk', 'keys')
const ARCHIVE_DIR     = join(LOCAL_KEYS_DIR, 'archive')

/** Read the private key (age identity) for an actor from the machine-local
 * keys directory. Returns null if the actor has no private key on this
 * machine — meaning the actor is hosted on a different machine OR no key
 * has been generated yet (operator should run `crosstalk actor key generate
 * <name>`).
 *
 * Permission-paranoid: warns to stderr if the .key file's mode is not 0600.
 * Doesn't refuse to read it (operator may have legitimately set 0400 etc.),
 * just surfaces the deviation. */
export function loadActorIdentity(actorName: string): AgeIdentity | null {
  const path = join(LOCAL_KEYS_DIR, `${actorName}.key`)
  if (!existsSync(path)) return null

  // Permission check — warn if not 0600 (or stricter — 0400 is OK)
  try {
    const mode = statSync(path).mode & 0o777
    if (mode !== 0o600 && mode !== 0o400) {
      console.warn(`[keys] WARN: ${path} has mode ${mode.toString(8)}; expected 600 (or 400). ` +
        `Run 'chmod 600 ${path}' to harden.`)
    }
  } catch { /* skip perm check on error */ }

  let raw: string
  try {
    raw = readFileSync(path, 'utf-8').trim()
  } catch (err) {
    console.error(`[keys] failed to read ${path}: ${err}`)
    return null
  }
  if (!raw.startsWith('AGE-SECRET-KEY-1')) {
    console.error(`[keys] ${path} does not look like an age secret key (does not start with 'AGE-SECRET-KEY-1')`)
    return null
  }
  return raw
}

/** Read all archived private keys for an actor — used when decrypting
 * historical messages encrypted to a previous (rotated-out) keypair. Returns
 * an array of identities sorted newest-first by archive-timestamp filename.
 *
 * Archive filenames are `<actor>-<iso-utc-with-dashes>.key` per the
 * `crosstalk actor key generate --rotate` writer.
 *
 * Returns empty array if no archive directory exists or no archived keys
 * for this actor. */
export function loadActorIdentityArchive(actorName: string): AgeIdentity[] {
  if (!existsSync(ARCHIVE_DIR)) return []

  let entries: string[] = []
  try { entries = readdirSync(ARCHIVE_DIR) } catch { return [] }

  const prefix = `${actorName}-`
  const matches = entries.filter((e: string) => e.startsWith(prefix) && e.endsWith('.key')).sort().reverse()

  const identities: AgeIdentity[] = []
  for (const f of matches) {
    try {
      const raw = readFileSync(join(ARCHIVE_DIR, f), 'utf-8').trim()
      if (raw.startsWith('AGE-SECRET-KEY-1')) identities.push(raw)
    } catch { /* skip unreadable */ }
  }
  return identities
}

/** Read an actor's public key (recipient) from the transport. Tries
 * `manifest/custom/keys/<name>.pub` first, falling through to
 * `manifest/framework/keys/<name>.pub`. Returns null if not found. */
export function loadActorRecipient(transportRoot: string, actorName: string): AgeRecipient | null {
  for (const layer of ['custom', 'framework']) {
    const path = join(transportRoot, 'manifest', layer, 'keys', `${actorName}.pub`)
    if (!existsSync(path)) continue
    try {
      const raw = readFileSync(path, 'utf-8').trim()
      if (!raw.startsWith('age1')) {
        console.error(`[keys] ${path} does not look like an age recipient (does not start with 'age1')`)
        continue
      }
      return raw
    } catch { /* try next layer */ }
  }
  return null
}

/** Read public keys for multiple actors in a single pass. Returns a Map
 * from actor name to recipient string for those that resolve. Actors
 * without a public key are silently omitted from the result — the caller
 * should compare the result map's keys against the requested list to
 * detect which actors don't have keys yet. */
export function loadActorRecipients(transportRoot: string, actorNames: string[]): Map<string, AgeRecipient> {
  const out = new Map<string, AgeRecipient>()
  for (const name of actorNames) {
    const r = loadActorRecipient(transportRoot, name)
    if (r) out.set(name, r)
  }
  return out
}
