/**
 * Per-layer actor scanning — used by `crosstalk actor list/validate`.
 *
 * The runtime's loadRegistry() merges all three layers into a deduplicated
 * Registry with last-wins semantics. For the CLI we want to SHOW the layer
 * each actor came from, and we want to handle each layer separately for the
 * --registry flag. So this lib walks each layer independently.
 *
 * Three layers (framework wins last, custom wins over framework, local wins
 * over both):
 *   1. <transport>/manifest/framework/actors/
 *   2. <transport>/manifest/custom/actors/
 *   3. ~/.crosstalk/actors/
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { parseFrontmatter } from '../../frontmatter.js'
import { isKebabCase } from '../../registry.js'

export type ActorLayer = 'framework' | 'custom' | 'local'

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

const LAYER_PATHS: Record<ActorLayer, (transport: string) => string> = {
  framework: (t) => join(t, 'manifest', 'framework', 'actors'),
  custom:    (t) => join(t, 'manifest', 'custom', 'actors'),
  local:     (_) => join(homedir(), '.crosstalk', 'actors'),
}

export function scanActorLayer(transport: string, layer: ActorLayer): ActorEntry[] {
  const dir = LAYER_PATHS[layer](transport)
  if (!existsSync(dir)) return []

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

/** Merge all three layers with last-wins semantics, but track where each
 * winning entry came from. Returns a flat array of effective entries. */
export function scanAllLayers(transport: string): ActorEntry[] {
  const merged = new Map<string, ActorEntry>()
  for (const layer of ['framework', 'custom', 'local'] as ActorLayer[]) {
    for (const e of scanActorLayer(transport, layer)) {
      merged.set(e.name, e)  // last wins
    }
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
}
