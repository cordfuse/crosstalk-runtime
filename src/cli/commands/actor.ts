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
 * (kebab-case name, required fields per type, parent chain consistency).
 * Exits non-zero if any actor fails. Forward-compat with TODO #23 — human-
 * actor strict validation comes when that spec lands.
 */
import type { Command } from 'commander'

import { loadConfig } from '../../config.js'
import { scanActorLayer, scanAllLayers, type ActorEntry, type ActorLayer } from '../lib/actors.js'

export function registerActorCommand(program: Command): void {
  const actor = program
    .command('actor')
    .description('inspect and validate actor profiles (subcommands: list, validate)')

  registerActorList(actor)
  registerActorValidate(actor)
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
    .option('--registry <layer>', 'framework | custom | local | all (default: all, merged with last-wins)', 'all')
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
    entries = scanAllLayers(config.transport)
  } else if (layer === 'framework' || layer === 'custom' || layer === 'local') {
    entries = scanActorLayer(config.transport, layer as ActorLayer)
  } else {
    console.error(`✗ Unknown --registry value: ${layer}`)
    console.error(`  Valid: framework, custom, local, all`)
    process.exit(1)
  }

  if (opts.json) {
    console.log(JSON.stringify(entries.map(asListJson), null, 2))
    return
  }

  if (entries.length === 0) {
    console.log(layer === 'all'
      ? '(no actors registered)'
      : `(no actors in ${layer} layer)`)
    return
  }

  // Pretty table
  const nameW  = Math.max(4, ...entries.map(e => e.name.length))
  const layerW = Math.max(5, ...entries.map(e => e.layer.length))
  const typeW  = Math.max(4, ...entries.map(e => String(e.data.type ?? '?').length))
  const agentW = Math.max(5, ...entries.map(e => String(e.data.agent ?? '').length))
  console.log(`${pad('NAME', nameW)}  ${pad('LAYER', layerW)}  ${pad('TYPE', typeW)}  ${pad('AGENT', agentW)}  MODEL`)
  for (const e of entries) {
    const type  = String(e.data.type  ?? '?')
    const agent = String(e.data.agent ?? '')
    const model = String(e.data.model ?? '')
    console.log(`${pad(e.name, nameW)}  ${pad(e.layer, layerW)}  ${pad(type, typeW)}  ${pad(agent, agentW)}  ${model}`)
  }
}

function asListJson(e: ActorEntry): Record<string, unknown> {
  return {
    name:  e.name,
    layer: e.layer,
    type:  e.data.type ?? null,
    agent: e.data.agent ?? null,
    model: e.data.model ?? null,
    role:  e.data.role ?? null,
    parent: e.data.parent ?? null,
    file:  e.file,
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
    .option('--registry <layer>', 'framework | custom | local | all (default: all)', 'all')
    .action(async (name: string | undefined, opts: ActorValidateOptions) => {
      await runActorValidate(name, opts)
    })
}

async function runActorValidate(name: string | undefined, opts: ActorValidateOptions): Promise<void> {
  const config = await loadConfig()
  const layer = opts.registry ?? 'all'

  let entries: ActorEntry[]
  if (layer === 'all') {
    entries = scanAllLayers(config.transport)
  } else if (layer === 'framework' || layer === 'custom' || layer === 'local') {
    entries = scanActorLayer(config.transport, layer as ActorLayer)
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
    issues.push(...validateActor(e))
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

function validateActor(e: ActorEntry): ValidationIssue[] {
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

  const type = String(e.data.type ?? '')
  if (!type) {
    out.push(issue('warn', `missing 'type' field — should be 'machine' or 'human'`))
  } else if (type !== 'machine' && type !== 'human') {
    out.push(issue('error', `invalid type '${type}' — must be 'machine' or 'human'`))
  }

  const agent = String(e.data.agent ?? '')
  const model = String(e.data.model ?? '')
  const command = String(e.data.command ?? '')

  if (type === 'machine' || (!type && agent)) {
    // Machine actors need either (agent + model) for native dispatch or `command` for custom
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
  }

  // parent: TODO #23 will require this. For now, warn if missing entirely.
  if (!('parent' in e.data)) {
    out.push(issue('warn', `missing 'parent' field — TODO #23 will require this. Use 'parent:' (blank) for top-of-chain, 'parent: <name>' otherwise`))
  }

  return out
}

// ── helpers ─────────────────────────────────────────────────────────────

function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - s.length))
}
