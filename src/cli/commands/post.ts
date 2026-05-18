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
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { Command } from 'commander'

import { loadConfig } from '../../config.js'
import { messageDatePath, messageFilename } from '../../filenames.js'
import { resolveChannel } from '../lib/channel.js'
import { scanAllLayers, type ActorEntry } from '../lib/actors.js'
import { parseAddress, isAddressError } from '../../address.js'

interface PostOptions {
  channel:               string
  to:                    string
  body:                  string
  from?:                 string
  type?:                 string
  push?:                 boolean   // commander inverts --no-push to push: false
  allowUnknownTargets?:  boolean
  encrypt?:              boolean   // v0.8.0-alpha.5+ — encrypt body to recipients' age pubkeys
  dispatch?:             string    // v1.5.0-alpha.1+ — pool dispatch policy (fanout|round-robin)
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
    .option('--encrypt',                             'encrypt body to each --to actor\'s age pubkey (v0.8+; requires recipients to have keys in manifest/{custom,framework}/keys/<actor>.pub)')
    .option('--dispatch <policy>',                   'pool dispatch policy: fanout (default — all instances) | round-robin (one instance, rotating) — v1.5+')
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

  // Validate targets against the FULL actor profile set, not the dispatch
  // registry. v0.9.0+ fix: previously used loadRegistry() which filters to
  // dispatchable actors (agent or command set). Humans are spec-forbidden from
  // carrying those fields — so loadRegistry never sees them, and `post --to
  // <human>` would be rejected with "Unknown actor target(s)" even though
  // `crosstalk actor list` shows the human fine. Same root cause + fix as the
  // channel-join PR #11 patch. See src/cli/commands/channel-join.ts:117-125
  // for the parallel comment.
  //
  // v1.3.0-alpha.5+ — address-aware validation. Accepts qualified addresses
  // (`alice@steve`, `dart-thrower@steve`, `dart-thrower-2@steve`) and pool
  // names. Cross-operator targets (`alice@bob` from a daemon whose operator
  // is `steve`) are accepted blindly — we have no view of the remote
  // operator's registry, so we trust the user.
  const profiles = scanAllLayers(config.transport, config.operator)
  const targetsRaw = opts.to.trim()
  const targets: 'all' | string[] = targetsRaw === 'all'
    ? 'all'
    : targetsRaw.split(',').map(t => t.trim()).filter(Boolean)

  if (targets !== 'all' && !opts.allowUnknownTargets) {
    const unknown: string[] = []
    const invalid: { target: string; reason: string }[] = []
    for (const t of targets as string[]) {
      const verdict = validateTarget(t, profiles, config.operator)
      if (verdict.ok === false) {
        if (verdict.kind === 'invalid')        invalid.push({ target: t, reason: verdict.reason })
        else if (verdict.kind === 'unknown')   unknown.push(t)
      }
    }
    if (invalid.length > 0) {
      for (const i of invalid) console.error(`✗ Invalid address "${i.target}" — ${i.reason}`)
      process.exit(1)
    }
    if (unknown.length > 0) {
      const known = profiles.map(p => `${p.name} (${p.data.type ?? '?'})`).sort().join(', ')
      console.error(`✗ Unknown actor target(s): ${unknown.join(', ')}`)
      console.error(`  Known actors on this daemon: ${known || '(none)'}`)
      if (config.operator) {
        console.error(`  This daemon's operator handle is "${config.operator}" — use \`<role>@${config.operator}\` for local actors,`)
        console.error(`  \`<role>@<other-op>\` for cross-operator targets, or --allow-unknown-targets to bypass.`)
      } else {
        console.error(`  Use --allow-unknown-targets to bypass this check.`)
      }
      process.exit(1)
    }

    // v1.4.0-alpha.3+ — warn on cross-operator addresses in single-op mode.
    // The message will land on the transport but no other daemon is configured
    // to receive it (since the operator handle is unset on this daemon and no
    // other handles are coordinating). This was a UAT-discovered silent failure
    // — operators trying multi-op out for the first time would post `--to
    // alice@bob` with no `operator` field set in config, get a successful
    // commit, and wonder why alice@bob never responded.
    if (config.operator === undefined) {
      const crossOp: string[] = []
      for (const t of targets as string[]) {
        const parsed = parseAddress(t)
        if (!isAddressError(parsed) && parsed.kind === 'machine' && parsed.operator !== undefined) {
          crossOp.push(t)
        }
      }
      if (crossOp.length > 0) {
        console.warn(`⚠ Cross-operator target(s) on a single-operator daemon: ${crossOp.join(', ')}`)
        console.warn(`  This daemon has no \`operator =\` field in config.toml, so no daemon will`)
        console.warn(`  recognise these messages as ours OR theirs. The message will be written`)
        console.warn(`  but is unlikely to be processed. Set \`operator = "<handle>"\` in config`)
        console.warn(`  if you mean to run this daemon in multi-operator mode.`)
      }
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
  const filename  = messageFilename(now)
  const datePath  = messageDatePath(now)
  const targetDir = join(config.transport, 'channels', channelGuid, datePath)
  const targetFile = join(targetDir, filename)
  const toField   = targets === 'all' ? 'all' : (targets as string[]).join(', ')

  // v0.8.0-alpha.5+ encryption path
  let body = opts.body
  let encryptionFields: { encryption?: string; 'encrypted-to'?: string } = {}
  if (opts.encrypt) {
    if (targets === 'all') {
      console.error(`✗ --encrypt with --to all is forbidden (encrypting to every actor defeats the privacy purpose).`)
      console.error(`  Use --to <actor[,actor]> with specific targets instead.`)
      process.exit(1)
    }
    const recipientNames = targets as string[]
    const { loadActorRecipients } = await import('../../keys.js')
    const recipientMap = loadActorRecipients(config.transport, recipientNames)
    const missing = recipientNames.filter(n => !recipientMap.has(n))
    if (missing.length === recipientNames.length) {
      console.error(`✗ --encrypt: NO recipients have public keys in the transport.`)
      console.error(`  Recipients without pubkey: ${missing.join(', ')}`)
      console.error(`  Each recipient needs to run \`crosstalk actor key generate <name>\` and commit their .pub file to manifest/custom/keys/.`)
      process.exit(1)
    }
    if (missing.length > 0) {
      console.warn(`⚠ --encrypt: ${missing.length} recipient(s) without pubkey will see encrypted body but cannot decrypt: ${missing.join(', ')}`)
    }
    const recipients = [...recipientMap.values()]
    const encryptedToNames = [...recipientMap.keys()]
    const { encrypt, wrapForMessageBody } = await import('../../crypto.js')
    const armored = await encrypt(opts.body, recipients)
    body = wrapForMessageBody(armored).trimEnd()  // trim — composeMessage adds its own trailing \n
    encryptionFields = { encryption: 'age', 'encrypted-to': encryptedToNames.join(', ') }
    console.log(`✓ Encrypted to ${recipientMap.size} recipient(s): ${encryptedToNames.join(', ')}`)
  }

  // v1.5.0-alpha.1+ — sender-side dispatch policy carried as frontmatter.
  // Validated at parse time on the receiving daemon (parseDispatchPolicy);
  // we surface obvious typos here so the user finds out before posting.
  const extraFrontmatter: Record<string, string> = { ...encryptionFields }
  if (opts.dispatch) {
    const v = opts.dispatch.trim().toLowerCase()
    if (v !== 'fanout' && v !== 'round-robin') {
      console.error(`✗ Unknown --dispatch policy "${opts.dispatch}". Valid: fanout, round-robin.`)
      process.exit(1)
    }
    if (v !== 'fanout') extraFrontmatter.dispatch = v  // skip the field when it'd just restate the default
  }

  let messageContent = composeMessage({
    from,
    to:        toField,
    timestamp: now.toISOString(),
    type:      'text',
    body,
    extraFrontmatter,
  })

  // v1.3.0-alpha.8+ — sign the message with --from's ed25519 key if one
  // exists locally. Closes the UAT-discovered gap where CLI-posted messages
  // bypassed the signing layer entirely (since this command writes the file
  // directly instead of going through Transport.postMessage). Without this,
  // any operator could post `from: alice@steve` via CLI without holding
  // alice@steve's signing key — defeats the whole point of Phase 2 identity.
  // Permissive: no key = post unsigned (same as the daemon dispatch path).
  try {
    const { loadPrivateSigningKey, signAndEmbed } = await import('../../signing.js')
    if (loadPrivateSigningKey(from) !== null) {
      messageContent = signAndEmbed(messageContent, from)
    }
  } catch (err) {
    console.warn(`⚠ signing failed for ${from}, posting unsigned: ${err}`)
  }

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

// ── Helpers ──────────────────────────────────────────────────────────────

// Filename + datePath helpers extracted to src/filenames.ts in v0.7.x
// scaffolding pass — see `messageFilename` / `messageDatePath` import.

interface MessageInputs {
  from:      string
  to:        string
  timestamp: string
  type:      string
  body:      string
  /** v0.8.0-alpha.5+ — extra frontmatter fields (e.g. encryption: age,
   * encrypted-to: alice, bob) appended after the canonical four. Order
   * preserved per-call; absent/empty when not encrypting. */
  extraFrontmatter?: Record<string, string>
}

function composeMessage(m: MessageInputs): string {
  const extraLines = m.extraFrontmatter
    ? Object.entries(m.extraFrontmatter).map(([k, v]) => `${k}: ${v}`)
    : []
  return [
    `---`,
    `from: ${m.from}`,
    `to: ${m.to}`,
    `timestamp: ${m.timestamp}`,
    `type: ${m.type}`,
    ...extraLines,
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

/** Validate a single `--to` target against the local profile set + this
 * daemon's operator handle. Returns:
 *   - `{ ok: true }` if the target is acceptable to post
 *   - `{ ok: false, kind: 'invalid', reason }` if the address grammar is broken
 *   - `{ ok: false, kind: 'unknown' }` if grammar is fine but no local match
 *
 * Acceptance rules (v1.3.0-alpha.5+):
 *   - Cross-operator address (`alice@bob` from a `steve` daemon) → always OK;
 *     we can't see the remote registry, so we trust the user
 *   - Local machine address (`alice@steve` from a `steve` daemon) → matched
 *     against profile filenames (`alice`, or for pool instances `alice-1`)
 *   - Pool address (`dart-thrower@steve`, no instance) → OK if AT LEAST
 *     one instance of that role exists locally
 *   - Bare name in multi-op mode → must match a human profile (machine
 *     actors require qualification in multi-op)
 *   - Bare name in single-op mode → must match ANY profile (no operator
 *     namespacing; v1.2 behavior preserved)
 */
export type ValidateResult =
  | { ok: true }
  | { ok: false; kind: 'invalid'; reason: string }
  | { ok: false; kind: 'unknown' }

export function validateTarget(target: string, profiles: ActorEntry[], myOperator: string | undefined): ValidateResult {
  const parsed = parseAddress(target)
  if (isAddressError(parsed)) {
    return { ok: false, kind: 'invalid', reason: parsed.message }
  }

  // Cross-operator machine address — accept blindly. The remote operator's
  // daemon will see the same message land on the transport and process it
  // from there; we have no visibility into their registry to validate.
  if (parsed.kind === 'machine' && parsed.operator !== undefined && parsed.operator !== myOperator) {
    return { ok: true }
  }

  if (parsed.kind === 'machine') {
    // Local machine address. The `instance` field is a discriminated union:
    //   undefined            → pool address, OK if at least one instance exists
    //   {kind:'index', n}    → specific pool instance `<role>-<n>.md`
    //   {kind:'tag', tag}    → tag-form instance (alice@steve/cachy) — not
    //                          yet a first-class profile lookup, treat as unknown
    if (parsed.instance === undefined) {
      const hasInstance = profiles.some(p => {
        if (p.name === parsed.role) return true
        const m = p.name.match(/^(.+)-(\d+)$/)
        return m !== null && m[1] === parsed.role
      })
      return hasInstance ? { ok: true } : { ok: false, kind: 'unknown' }
    }
    if (parsed.instance.kind === 'index') {
      const expected = `${parsed.role}-${parsed.instance.n}`
      return profiles.some(p => p.name === expected) ? { ok: true } : { ok: false, kind: 'unknown' }
    }
    // Tag form — Steve's locked design uses hyphen-integer; tags still parse
    // for forward-compat but aren't a profile-lookup target. Accept blindly
    // (treat like a cross-operator address — the resolver decides at dispatch).
    return { ok: true }
  }

  // Bare name (parsed as human by the grammar — could be a human profile or,
  // in single-op mode, also a machine profile with that name).
  if (myOperator === undefined) {
    // Single-op back-compat: bare name matches any profile by filename.
    return profiles.some(p => p.name === parsed.name) ? { ok: true } : { ok: false, kind: 'unknown' }
  }
  // Multi-op: bare name must be a human profile; machines must be qualified.
  const isHuman = profiles.some(p => p.name === parsed.name && String(p.data.type) === 'human')
  return isHuman ? { ok: true } : { ok: false, kind: 'unknown' }
}
