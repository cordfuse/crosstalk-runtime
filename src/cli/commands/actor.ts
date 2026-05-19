/**
 * `crosstalk actor <subcommand>` — actor introspection.
 *
 *   crosstalk actor list [--registry framework|custom|local|all] [--json]
 *   crosstalk actor validate [<name>] [--registry ...]
 *
 * `actor list` shows what actors are available for dispatch + which layer
 * each came from. Useful for "wait, why isn't my custom override winning?"
 * debugging.
 *
 * `actor validate` checks each actor profile against the framework spec
 * (manifest/framework/PROFILES.md). Exits non-zero if any actor fails.
 *
 * Strict per PROFILES.md (locked in TODO #23, shipped in v0.5 alpha.9):
 *   - kebab-case name matching the filename
 *   - frontmatter `name:` matches filename
 *   - required: name, type, role, parent
 *   - type ∈ {machine, human}
 *   - machine: agent OR command required (model defaulted if missing → warn)
 *   - human: agent/model warn (humans never headlessly dispatched)
 *   - parent: missing field → ERROR (catches typos like `paren:`); blank
 *     value → top-of-chain; self-parent → ERROR; chain cycles → ERROR;
 *     parent not in registry → WARN (degrades gracefully)
 */
import type { Command } from 'commander'

import { loadConfig } from '../../config.js'
import { scanActorLayer, scanAllLayers, type ActorEntry, type ActorLayer } from '../lib/actors.js'

export function registerActorCommand(program: Command): void {
  const actor = program
    .command('actor')
    .description('inspect and validate actor profiles + manage age keypairs (subcommands: list, validate, key)')

  registerActorList(actor)
  registerActorValidate(actor)
  registerActorKey(actor)
}

// ── actor list ──────────────────────────────────────────────────────────

interface ActorListOptions {
  registry?: string  // framework | custom | local | all
  json?:     boolean
}

function registerActorList(parent: Command): void {
  parent
    .command('list')
    .description('list actors — by default merged across framework + custom + local layers')
    .option('--registry <layer>', 'framework | custom | operator | local | all (default: all, merged with last-wins; "operator" = v1.4+ per-operator layer at manifest/operators/<handle>/actors/)', 'all')
    .option('--json',             'machine-readable JSON output')
    .action(async (opts: ActorListOptions) => {
      await runActorList(opts)
    })
}

async function runActorList(opts: ActorListOptions): Promise<void> {
  const config = await loadConfig()
  const layer = opts.registry ?? 'all'

  let entries: ActorEntry[]
  if (layer === 'all') {
    entries = scanAllLayers(config.transport, config.operator)
  } else if (layer === 'framework' || layer === 'custom' || layer === 'operator' || layer === 'local') {
    entries = scanActorLayer(config.transport, layer as ActorLayer, config.operator)
  } else {
    console.error(`✗ Unknown --registry value: ${layer}`)
    console.error(`  Valid: framework, custom, local, all`)
    process.exit(1)
  }

  if (opts.json) {
    console.log(JSON.stringify(entries.map(e => asListJson(e, config.operator)), null, 2))
    return
  }

  if (entries.length === 0) {
    console.log(layer === 'all'
      ? '(no actors registered)'
      : `(no actors in ${layer} layer)`)
    return
  }

  // v1.4.0-alpha.3+ — header line indicates operator mode so operators
  // can see at a glance which daemon they're inspecting. Single-op
  // mode is highlighted because cross-op addresses behave differently
  // (UAT showed operators getting confused which mode they were in).
  if (config.operator) {
    console.log(`Operator handle: ${config.operator}  (multi-operator mode)`)
  } else {
    console.log(`Operator handle: (unset)  (single-operator mode — set \`operator = "<handle>"\` in config.toml for multi-op)`)
  }
  console.log('')

  // Pretty table. v1.3.0-alpha.8+ — ADDRESS column added so operators in
  // multi-op mode can see at a glance which actor is `alice@steve` vs
  // `alice@bob` rather than only the filename-derived bare name. In
  // single-op mode (no operator handle) address == name and the column
  // is informationally redundant; we still show it for consistency.
  const addressFor = (e: ActorEntry): string => {
    const isHuman = String(e.data.type ?? '') === 'human'
    return config.operator && !isHuman ? `${e.name}@${config.operator}` : e.name
  }
  const nameW    = Math.max(4, ...entries.map(e => e.name.length))
  const addressW = Math.max(7, ...entries.map(e => addressFor(e).length))
  const layerW   = Math.max(5, ...entries.map(e => e.layer.length))
  const typeW    = Math.max(4, ...entries.map(e => String(e.data.type ?? '?').length))
  const agentW   = Math.max(5, ...entries.map(e => String(e.data.agent ?? '').length))
  console.log(`${pad('NAME', nameW)}  ${pad('ADDRESS', addressW)}  ${pad('LAYER', layerW)}  ${pad('TYPE', typeW)}  ${pad('AGENT', agentW)}  MODEL`)
  for (const e of entries) {
    const type  = String(e.data.type  ?? '?')
    const agent = String(e.data.agent ?? '')
    const model = String(e.data.model ?? '')
    console.log(`${pad(e.name, nameW)}  ${pad(addressFor(e), addressW)}  ${pad(e.layer, layerW)}  ${pad(type, typeW)}  ${pad(agent, agentW)}  ${model}`)
  }
}

function asListJson(e: ActorEntry, operator?: string): Record<string, unknown> {
  const isHuman = String(e.data.type ?? '') === 'human'
  const address = operator && !isHuman ? `${e.name}@${operator}` : e.name
  return {
    name:    e.name,
    address,
    layer:   e.layer,
    type:    e.data.type ?? null,
    agent:   e.data.agent ?? null,
    model:   e.data.model ?? null,
    role:    e.data.role ?? null,
    parent:  e.data.parent ?? null,
    file:    e.file,
  }
}

// ── actor validate ──────────────────────────────────────────────────────

interface ActorValidateOptions {
  registry?: string
}

interface ValidationIssue {
  actor:    string
  layer:    ActorLayer
  severity: 'error' | 'warn'
  message:  string
}

function registerActorValidate(parent: Command): void {
  parent
    .command('validate [name]')
    .description('validate actor profile(s) against the framework spec — exits non-zero on any error')
    .option('--registry <layer>', 'framework | custom | operator | local | all (default: all)', 'all')
    .action(async (name: string | undefined, opts: ActorValidateOptions) => {
      await runActorValidate(name, opts)
    })
}

async function runActorValidate(name: string | undefined, opts: ActorValidateOptions): Promise<void> {
  const config = await loadConfig()
  const layer = opts.registry ?? 'all'

  // Always build the full merged registry — needed for parent-chain cycle
  // detection even when validating only one layer.
  const allEntries = scanAllLayers(config.transport, config.operator)
  const registry = new Map<string, ActorEntry>()
  for (const e of allEntries) registry.set(e.name, e)

  let entries: ActorEntry[]
  if (layer === 'all') {
    entries = allEntries
  } else if (layer === 'framework' || layer === 'custom' || layer === 'operator' || layer === 'local') {
    entries = scanActorLayer(config.transport, layer as ActorLayer, config.operator)
  } else {
    console.error(`✗ Unknown --registry value: ${layer}`)
    process.exit(1)
  }

  if (name) {
    entries = entries.filter(e => e.name === name)
    if (entries.length === 0) {
      console.error(`✗ No actor named '${name}' in ${layer} layer(s)`)
      process.exit(1)
    }
  }

  const issues: ValidationIssue[] = []
  for (const e of entries) {
    issues.push(...validateActor(e, registry))
  }

  if (issues.length === 0) {
    console.log(`✓ ${entries.length} actor(s) validated, no issues`)
    return
  }

  // Group by actor
  const byActor = new Map<string, ValidationIssue[]>()
  for (const i of issues) {
    if (!byActor.has(i.actor)) byActor.set(i.actor, [])
    byActor.get(i.actor)!.push(i)
  }

  let errorCount = 0
  let warnCount  = 0
  for (const [actor, list] of [...byActor.entries()].sort()) {
    console.log(`\n${actor}:`)
    for (const i of list) {
      const tag = i.severity === 'error' ? '✗' : '⚠'
      console.log(`  ${tag} [${i.layer}] ${i.message}`)
      if (i.severity === 'error') errorCount++
      else                        warnCount++
    }
  }

  console.log(`\n${entries.length} actor(s) checked: ${errorCount} error(s), ${warnCount} warning(s)`)
  if (errorCount > 0) process.exit(1)
}

function validateActor(e: ActorEntry, registry: Map<string, ActorEntry>): ValidationIssue[] {
  const out: ValidationIssue[] = []
  const issue = (severity: 'error' | 'warn', message: string): ValidationIssue =>
    ({ actor: e.name, layer: e.layer, severity, message })

  if (e.parseError) {
    out.push(issue('error', `frontmatter parse error: ${e.parseError}`))
    return out
  }

  if (!e.validKebabName) {
    out.push(issue('error', `name '${e.name}' is not kebab-case (must match /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)`))
  }

  // v1.11.0-alpha.1+ — frontmatter `name:` is authoritative. Pre-v1.11
  // the validator required frontmatter `name:` to MATCH the filename
  // (and rejected on absence). Now:
  //   - frontmatter name present + valid → that's the authoritative name;
  //     filename is cosmetic. Different filename is fine.
  //   - frontmatter name absent → filename used as fallback (must be valid
  //     kebab — same as the v1.0 baseline behavior).
  //   - frontmatter name present but invalid kebab → error.
  // The `e.name` field (set in scanActorLayer) already follows the
  // authoritative rule, so we mostly validate the EXPLICIT `data.name`
  // string here (the actual frontmatter content the operator wrote).
  const declaredName = e.data.name == null ? '' : String(e.data.name).trim()
  if (declaredName && !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(declaredName)) {
    out.push(issue('error', `frontmatter 'name: ${declaredName}' is not kebab-case (must match /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)`))
  }
  // No declared name + filename invalid? — the entry will have failed
  // validKebabName above; this branch just adds a hint about the fix.
  if (!declaredName && !e.validKebabName) {
    out.push(issue('error', `no valid name source — add \`name: <kebab-case>\` to frontmatter (filename "${e.file.split('/').pop()}" is not kebab-case)`))
  }

  // role required (short Title-Case label per PROFILES.md)
  if (e.data.role == null || String(e.data.role).trim() === '') {
    out.push(issue('error', `missing 'role' field — short label required by PROFILES.md (e.g. 'Code Reviewer')`))
  }

  // type required + valid (human | machine | system per PROFILES.md v0.5.1)
  const type = String(e.data.type ?? '')
  if (!type) {
    out.push(issue('error', `missing 'type' field — must be 'human', 'machine', or 'system'`))
  } else if (type !== 'machine' && type !== 'human' && type !== 'system') {
    out.push(issue('error', `invalid type '${type}' — must be 'human', 'machine', or 'system'`))
  }

  const agent = String(e.data.agent ?? '')
  const model = String(e.data.model ?? '')
  const command = String(e.data.command ?? '')

  if (type === 'machine') {
    if (!agent && !command) {
      out.push(issue('error', `machine actor missing 'agent' (claude|gemini|qwen|opencode) or 'command' (custom)`))
    }
    if (agent && !model) {
      out.push(issue('warn', `'agent: ${agent}' set but no 'model' — runtime will use the agent's default`))
    }
  } else if (type === 'human') {
    if (agent || model) {
      out.push(issue('warn', `human actor has 'agent'/'model' set — these are ignored for humans (runtime never headlessly dispatches a human)`))
    }
  } else if (type === 'system') {
    // system actors (PROFILES.md v0.5.1) are framework-reserved labels — the
    // runtime/watcher writes under them but never spawns a process. agent/
    // model/command/args are not required and not warned about.
    // No additional checks here; the universal name/role/parent checks above
    // still apply.
  }

  // parent: required field per PROFILES.md.
  //   missing field           → ERROR (catches typos like `paren:`)
  //   empty value (null/'')   → valid, top-of-chain
  //   self-reference          → ERROR (cycle of length 1)
  //   chain cycle             → ERROR
  //   parent not in registry  → WARN (degrades gracefully across operators)
  if (!('parent' in e.data)) {
    out.push(issue('error', `missing 'parent' field — required by PROFILES.md (use 'parent:' blank for top-of-chain, 'parent: <name>' otherwise; absence cannot be distinguished from typos like 'paren:')`))
  } else {
    const parentValue = e.data.parent
    const hasParent = parentValue !== null && parentValue !== undefined && String(parentValue).trim() !== ''
    if (hasParent) {
      const parentName = String(parentValue).trim()
      if (parentName === e.name) {
        out.push(issue('error', `self-parent — 'parent: ${parentName}' on the actor's own profile is a cycle of length 1`))
      } else {
        // Walk the chain. Stop on cycle (error), missing parent (warn), or top-of-chain (ok).
        const visited = new Set<string>([e.name])
        let cursorName: string | undefined = parentName
        while (cursorName) {
          if (visited.has(cursorName)) {
            out.push(issue('error', `parent chain cycle detected — chain returns to '${cursorName}'`))
            break
          }
          visited.add(cursorName)
          const next: ActorEntry | undefined = registry.get(cursorName)
          if (!next) {
            out.push(issue('warn', `parent '${cursorName}' is not in the actor registry — chain ends here (may be defined on another operator's machine-local layer)`))
            break
          }
          const nextParent = next.data.parent
          if (nextParent === null || nextParent === undefined || String(nextParent).trim() === '') {
            break  // reached top-of-chain, no cycle
          }
          cursorName = String(nextParent).trim()
        }
      }
    }
  }

  return out
}

// ── actor key (v0.8.0-alpha.3+) ─────────────────────────────────────────

interface ActorKeyGenerateOptions {
  rotate?: boolean
  print?:  boolean
}

function registerActorKey(parent: Command): void {
  const key = parent
    .command('key')
    .description('manage per-actor keypairs (subcommands: generate [age encryption], generate-signing [ed25519 identity, v1.3+])')

  key
    .command('generate [name]')
    .description('generate a new age keypair for an actor; writes ~/.crosstalk/keys/<name>.{key,pub}')
    .option('--rotate', 'archive existing private key before generating new one (required if keypair already exists)')
    .option('--print',  'print the new public key to stdout after generating (so operators can copy it to the transport)')
    .action(async (name: string | undefined, opts: ActorKeyGenerateOptions) => {
      await runActorKeyGenerate(name, opts)
    })

  key
    .command('generate-signing [address]')
    .description('generate an ed25519 signing keypair for an actor address; private at ~/.crosstalk/keys/<addr>.sign, public published into the transport (v1.3+)')
    .option('--rotate', 'overwrite an existing signing key (forfeits old identity — incoming messages signed with the old key will fail verification on other daemons until they pull the new pubkey)')
    .option('--print',  'print the new public key (PEM) after generating')
    .action(async (address: string | undefined, opts: ActorKeyGenerateOptions) => {
      await runActorKeyGenerateSigning(address, opts)
    })
}

async function runActorKeyGenerate(name: string | undefined, opts: ActorKeyGenerateOptions): Promise<void> {
  // Resolve actor name: arg > config.defaultHumanActor > error
  const { loadConfig } = await import('../../config.js')
  const config = await loadConfig()
  const actorName = name ?? config.defaultHumanActor
  if (!actorName) {
    console.error('✗ No actor name provided and no `default-human-actor` set in ~/.crosstalk/config.toml')
    console.error('  Usage: crosstalk actor key generate <name> [--rotate] [--print]')
    process.exit(1)
  }
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(actorName)) {
    console.error(`✗ Actor name '${actorName}' is not kebab-case (must match /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)`)
    process.exit(1)
  }

  const { homedir } = await import('os')
  const { join } = await import('path')
  const { existsSync, mkdirSync, writeFileSync, renameSync, readFileSync, chmodSync } = await import('fs')

  const keysDir    = join(homedir(), '.crosstalk', 'keys')
  const archiveDir = join(keysDir, 'archive')
  const privPath   = join(keysDir, `${actorName}.key`)
  const pubPath    = join(keysDir, `${actorName}.pub`)

  // Existing keypair guard
  const privExists = existsSync(privPath)
  const pubExists  = existsSync(pubPath)
  if ((privExists || pubExists) && !opts.rotate) {
    console.error(`✗ Keypair already exists for '${actorName}':`)
    if (privExists) console.error(`    ${privPath}`)
    if (pubExists)  console.error(`    ${pubPath}`)
    console.error(`  Pass --rotate to archive the existing private key + generate a fresh keypair.`)
    process.exit(1)
  }

  // Rotate path: archive existing private key (NOT the public — pubkey rotates publicly via transport git history)
  if (opts.rotate && privExists) {
    mkdirSync(archiveDir, { recursive: true })
    chmodSync(archiveDir, 0o700)
    const iso = new Date().toISOString().replace(/[:.]/g, '-')
    const archivedPath = join(archiveDir, `${actorName}-${iso}.key`)
    renameSync(privPath, archivedPath)
    chmodSync(archivedPath, 0o600)
    console.log(`✓ Archived old private key → ${archivedPath}`)
  }

  // Generate fresh keypair
  const { generateKeypair } = await import('../../crypto.js')
  const { recipient, identity } = await generateKeypair()

  // Write new keypair
  mkdirSync(keysDir, { recursive: true })
  chmodSync(keysDir, 0o700)
  writeFileSync(privPath, identity + '\n', { mode: 0o600 })
  chmodSync(privPath, 0o600)  // belt-and-suspenders; some umasks override mode arg
  writeFileSync(pubPath, recipient + '\n', { mode: 0o644 })

  console.log(`✓ Generated keypair for '${actorName}':`)
  console.log(`    private: ${privPath}`)
  console.log(`    public:  ${pubPath}`)
  console.log(``)
  console.log(`Next step: copy the public key into the transport so other actors can encrypt to you.`)
  console.log(`  cp ${pubPath} <transport>/manifest/custom/keys/${actorName}.pub`)
  console.log(`  cd <transport> && git add manifest/custom/keys/${actorName}.pub && git commit -m 'keys: add ${actorName} pubkey' && git push`)

  if (opts.print) {
    console.log(``)
    console.log(`Public key (for copy-paste):`)
    console.log(readFileSync(pubPath, 'utf-8').trim())
  }
}

// ── actor key generate-signing (v1.3.0-alpha.5+) ────────────────────────

/** ed25519 signing key generation — distinct from `generate` (age
 * encryption). Two different keys, two different purposes:
 *
 *   age key (`generate`)            → per-message body encryption (v0.8+)
 *   ed25519 key (`generate-signing`) → per-message provenance signature (v1.3+)
 *
 * A signing address may be bare (single-op mode: `alice`) or qualified
 * (multi-op: `alice@steve`). The address parses through src/address.ts;
 * private goes to ~/.crosstalk/keys/<addr>.sign, public is written
 * directly into <transport>/manifest/identities/<addr>.pub for other
 * daemons to pull on `git pull`. */
async function runActorKeyGenerateSigning(address: string | undefined, opts: ActorKeyGenerateOptions): Promise<void> {
  const { loadConfig } = await import('../../config.js')
  const config = await loadConfig()

  // Resolve address: arg > config.defaultHumanActor (bare in either mode) > error
  const addr = address ?? config.defaultHumanActor
  if (!addr) {
    console.error('✗ No actor address provided and no `default-human-actor` set in ~/.crosstalk/config.toml')
    console.error('  Usage: crosstalk actor key generate-signing <address> [--rotate] [--print]')
    console.error('  Examples:')
    console.error('    crosstalk actor key generate-signing steve            # human, bare name')
    console.error('    crosstalk actor key generate-signing alice@steve      # machine, multi-op')
    process.exit(1)
  }

  const { parseAddress, isAddressError, formatAddress } = await import('../../address.js')
  const parsed = parseAddress(addr)
  if (isAddressError(parsed)) {
    console.error(`✗ Invalid address "${addr}": ${parsed.message}`)
    process.exit(1)
  }
  const canonical = formatAddress(parsed)

  const { homedir } = await import('os')
  const { join } = await import('path')
  const { existsSync } = await import('fs')

  const privPath = join(homedir(), '.crosstalk', 'keys', `${canonical}.sign`)
  if (existsSync(privPath) && !opts.rotate) {
    console.error(`✗ Signing key already exists for '${canonical}':`)
    console.error(`    ${privPath}`)
    console.error(`  Pass --rotate to overwrite (other daemons will need to pull the new pubkey before they can verify your messages).`)
    process.exit(1)
  }

  const { generateSigningKey, publishPublicKey } = await import('../../signing.js')
  const { publicKeyPem } = generateSigningKey(canonical)
  publishPublicKey(config.transport, canonical, publicKeyPem)

  const pubPath = join(config.transport, 'manifest', 'identities', `${canonical}.pub`)
  console.log(`✓ Generated ed25519 signing key for '${canonical}':`)
  console.log(`    private: ${privPath}`)
  console.log(`    public:  ${pubPath}`)
  console.log(``)
  console.log(`Next step: commit + push the public key so other daemons can verify your messages.`)
  console.log(`  cd ${config.transport}`)
  console.log(`  git add manifest/identities/${canonical}.pub`)
  console.log(`  git commit -m 'identities: add ${canonical} signing pubkey'`)
  console.log(`  git push`)

  if (opts.print) {
    console.log(``)
    console.log(`Public key (PEM):`)
    console.log(publicKeyPem)
  }
}

// ── helpers ─────────────────────────────────────────────────────────────

function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - s.length))
}
