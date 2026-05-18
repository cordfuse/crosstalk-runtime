/**
 * Per-layer actor scanning — used by `crosstalk actor list/validate`.
 *
 * The runtime's loadRegistry() merges all four layers (v1.4.0-alpha.1+)
 * into a deduplicated Registry with last-wins semantics. For the CLI we
 * want to SHOW the layer each actor came from, and we want to handle each
 * layer separately for the --registry flag.
 *
 * Four layers (later wins on collision):
 *   1. <transport>/manifest/framework/actors/
 *   2. <transport>/manifest/custom/actors/
 *   3. <transport>/manifest/operators/<handle>/actors/   (v1.4.0-alpha.1+; only loaded when operator handle is set)
 *   4. ~/.crosstalk/actors/
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { parseFrontmatter } from '../../frontmatter.js'
import { isKebabCase } from '../../registry.js'

export type ActorLayer = 'framework' | 'custom' | 'operator' | 'local'

export interface ActorEntry {
  name:           string
  layer:          ActorLayer
  file:           string  // absolute path to the .md file
  /** Whether this entry's name was derived from a kebab-case filename. */
  validKebabName: boolean
  /** Raw frontmatter data from the .md file. */
  data:           Record<string, unknown>
  /** Parse error if the .md file couldn't be loaded. */
  parseError?:    string
}

function layerDir(transport: string, layer: ActorLayer, operator?: string): string | null {
  switch (layer) {
    case 'framework': return join(transport, 'manifest', 'framework', 'actors')
    case 'custom':    return join(transport, 'manifest', 'custom', 'actors')
    case 'operator':  return operator ? join(transport, 'manifest', 'operators', operator, 'actors') : null
    case 'local':     return join(homedir(), '.crosstalk', 'actors')
  }
}

export function scanActorLayer(transport: string, layer: ActorLayer, operator?: string): ActorEntry[] {
  const dir = layerDir(transport, layer, operator)
  if (!dir || !existsSync(dir)) return []

  const out: ActorEntry[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue
    const name = file.slice(0, -3)
    const fullPath = join(dir, file)
    const entry: ActorEntry = {
      name,
      layer,
      file: fullPath,
      validKebabName: isKebabCase(name),
      data: {},
    }
    try {
      const content = readFileSync(fullPath, 'utf-8')
      const { data } = parseFrontmatter(content)
      entry.data = data
    } catch (err) {
      entry.parseError = err instanceof Error ? err.message : String(err)
    }
    out.push(entry)
  }
  return out
}

/** Merge all layers with last-wins semantics, but track where each
 * winning entry came from. Returns a flat array of effective entries.
 *
 * Pass `operator` to include the operator-scoped layer (v1.4.0-alpha.1+);
 * omit it (or pass undefined) and the operator layer is skipped — matching
 * single-op back-compat where there's no `<handle>` to scope by. */
export function scanAllLayers(transport: string, operator?: string): ActorEntry[] {
  const merged = new Map<string, ActorEntry>()
  for (const layer of ['framework', 'custom', 'operator', 'local'] as ActorLayer[]) {
    for (const e of scanActorLayer(transport, layer, operator)) {
      merged.set(e.name, e)  // last wins
    }
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
}
