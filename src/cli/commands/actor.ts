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

  // Always build the full merged registry — needed for parent-chain cycle
  // detection even when validating only one layer.
  const allEntries = scanAllLayers(config.transport)
  const registry = new Map<string, ActorEntry>()
  for (const e of allEntries) registry.set(e.name, e)

  let entries: ActorEntry[]
  if (layer === 'all') {
    entries = allEntries
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

  // name field must equal the filename-derived name
  const declaredName = e.data.name == null ? '' : String(e.data.name)
  if (!declaredName) {
    out.push(issue('error', `missing 'name' field — must equal filename '${e.name}'`))
  } else if (declaredName !== e.name) {
    out.push(issue('error', `name mismatch — frontmatter says 'name: ${declaredName}' but filename is '${e.name}.md'`))
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

// ── helpers ─────────────────────────────────────────────────────────────

function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - s.length))
}
