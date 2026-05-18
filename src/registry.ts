import { join } from 'path';
import { homedir } from 'os';
import { readdir, readFile } from 'fs/promises';
import { watch } from 'fs';
import { parseFrontmatter } from './frontmatter.js';
import { parseAddress, isAddressError, formatAddress, validateBareRoleName } from './address.js';

const LOCAL_ACTORS_DIR = join(homedir(), '.crosstalk', 'actors');
const FRAMEWORK_ACTORS_SUBPATH = join('manifest', 'framework', 'actors');
const CUSTOM_ACTORS_SUBPATH = join('manifest', 'custom', 'actors');
/** v1.4.0-alpha.1+ — operator-scoped profiles. Path template:
 *   `<transport>/manifest/operators/<operator-handle>/actors/<name>.md`
 * Profiles here are only loaded by the daemon whose `operator = "<handle>"`
 * matches; other operators sharing the same transport ignore them. Solves
 * the UAT-surfaced issue where pushing `dart-thrower-3.md` to the shared
 * `manifest/custom/actors/` caused it to register on EVERY operator's
 * daemon as `dart-thrower-3@<that-operator>`. With the operators/ layer,
 * steve can stage actors only steve's daemon sees, bob only bob's. */
function operatorActorsSubpath(operator: string): string {
  return join('manifest', 'operators', operator, 'actors');
}

const KEBAB_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const FRAMEWORK_FIELDS = new Set([
  'name', 'type', 'role', 'parent',
  'command', 'args', 'agent', 'model', 'git-email',
  'heartbeat-interval', 'docker', 'volumes',
]);

function warnUnprefixedCustomFields(name: string, data: Record<string, unknown>): void {
  for (const key of Object.keys(data)) {
    if (FRAMEWORK_FIELDS.has(key)) continue;
    if (key.startsWith('x-')) continue;
    console.warn(`[registry] "${name}": custom field "${key}" should be prefixed "x-${key}" — framework upgrades may overwrite unprefixed fields`);
  }
}

export function isKebabCase(name: string): boolean {
  return KEBAB_RE.test(name);
}

/** Per-actor configuration, extended in v1.3.0-alpha.3 with address-form
 * fields (`role`, `operator?`, `instance?`) for the multi-operator + pool
 * design. Existing fields preserved for backward compatibility — all
 * callers that read `name` continue to work.
 *
 * In single-operator mode (no operator handle configured), `operator` is
 * undefined and the actor's canonical address is just the bare `name`.
 * With operator handle set, the canonical address is `<role>@<operator>`
 * (or `<role>-<n>@<operator>` for pool instances). */
export interface ActorConfig {
  name: string;
  command?: string;
  args: string[];
  agent?: string;
  model?: string;
  personality?: string;
  gitEmail?: string;
  heartbeatInterval?: number;
  docker?: string;
  volumes?: string[];
  // ── v1.3.0-alpha.3+ — address-form fields ─────────────────────────────
  /** The actor's role name (the pool name when instance is set). For
   * singletons, equals `name`. */
  role: string;
  /** The operator handle this actor belongs to, when multi-operator mode
   * is active. Undefined in single-operator mode for backward compat. */
  operator?: string;
  /** When this actor is part of a pool, the instance discriminator. For
   * filename-derived instances, this is the trailing `-<int>` parsed off
   * the filename (e.g. `dart-thrower-7.md` → instance=7). Undefined for
   * singletons. */
  instance?: number;
  /** The canonical address string for this actor (bare name in
   * single-operator mode, `<role>@<operator>` or `<role>-<n>@<operator>`
   * with operator set). Always present; used as the registry's primary
   * lookup key. */
  address: string;
}

/** Registry shape preserved as `Map<string, ActorConfig>` for backward
 * compat with existing dispatch/watcher code. Map keys are canonical
 * addresses — bare names in single-operator mode, qualified addresses
 * (`<role>@<operator>`) when operator handle is configured.
 *
 * Pool-aware accessors (find all instances of a role, etc.) are
 * standalone functions below, not methods, to avoid changing the Map
 * type. */
export type Registry = Map<string, ActorConfig>;

function extractBody(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}

/** Parse an actor profile filename (sans `.md`) into role + optional
 * instance index, per the hyphen-integer reservation rule from the v1.3
 * design. Examples:
 *   `alice`           → role=alice,        instance=undefined
 *   `dart-thrower-1`  → role=dart-thrower, instance=1
 *   `dart-thrower-20` → role=dart-thrower, instance=20
 * Returns null if the filename isn't a valid actor name. */
function parseActorFilename(name: string): { role: string; instance?: number } | null {
  if (!isKebabCase(name)) return null;

  // Try to strip trailing -<int>. If present, that's the instance suffix.
  const match = name.match(/^(.+)-(\d+)$/);
  if (match) {
    const role = match[1];
    const instance = parseInt(match[2], 10);
    if (!isKebabCase(role)) return null;
    return { role, instance };
  }
  return { role: name };
}

async function loadActorsFromDir(
  dir: string,
  registry: Registry,
  operator: string | undefined,
): Promise<void> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return;
  }

  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const name = file.slice(0, -3);

    const parsed = parseActorFilename(name);
    if (!parsed) {
      console.error(`[registry] "${name}" is not a valid actor name — actor skipped. Rename the file to use kebab-case alphanumeric.`);
      continue;
    }

    const content = await readFile(join(dir, file), 'utf-8');
    const { data } = parseFrontmatter(content);

    const agent = typeof data.agent === 'string' ? data.agent : undefined;
    const command = typeof data.command === 'string' ? data.command : undefined;

    // Must have either agent (native invocation) or command (custom adapter)
    if (!agent && !command) continue;

    warnUnprefixedCustomFields(name, data);

    // Canonical address derivation:
    //   - Single-operator mode (no operator handle): bare name, e.g. "alice" or "dart-thrower-1"
    //   - Multi-operator mode (operator handle set): qualified, e.g. "alice@steve" or "dart-thrower-1@steve"
    const address = operator
      ? (parsed.instance !== undefined
          ? `${parsed.role}-${parsed.instance}@${operator}`
          : `${parsed.role}@${operator}`)
      : name;

    const actor: ActorConfig = {
      name,
      address,
      role: parsed.role,
      ...(operator ? { operator } : {}),
      ...(parsed.instance !== undefined ? { instance: parsed.instance } : {}),
      command,
      args: Array.isArray(data.args) ? (data.args as string[]) : [],
      agent,
      model: typeof data.model === 'string' ? data.model : undefined,
      personality: agent ? extractBody(content) : undefined,
      gitEmail: typeof data['git-email'] === 'string' ? data['git-email'] : undefined,
      heartbeatInterval: typeof data['heartbeat-interval'] === 'number'
        ? (data['heartbeat-interval'] as number)
        : undefined,
      docker: typeof data.docker === 'string' ? data.docker : undefined,
      volumes: Array.isArray(data.volumes) ? (data.volumes as string[]) : undefined,
    };
    registry.set(address, actor);
  }
}

/** Load all actors visible to this daemon. Reads from three layers (later
 * layers win on address collision):
 *   1. `<transportRoot>/manifest/framework/actors/` — framework-shipped (base)
 *   2. `<transportRoot>/manifest/custom/actors/` — operator-defined
 *   3. `~/.crosstalk/actors/` — machine-local overrides
 *
 * The `operator` parameter (v1.3.0-alpha.3+) is the daemon's operator
 * handle from config. When set, all actor addresses are qualified (e.g.
 * `alice@steve`). When undefined (default), addresses are bare names —
 * preserving the v1.2 single-operator behavior.
 *
 * Pool semantics: multiple actor files sharing a role-name (e.g.
 * `dart-thrower-1.md` ... `dart-thrower-20.md`) register as separate
 * instances. Each has its own ActorConfig entry; the pool is implicit
 * from sharing the same `role` field. Use `getPoolInstances()` to
 * enumerate. */
export async function loadRegistry(
  transportRoot: string,
  operator?: string,
  /** Override for the local actors directory. Defaults to `~/.crosstalk/actors/`.
   * Primarily for testing — production code should always use the default. */
  localActorsDir?: string,
): Promise<Registry> {
  const registry = new Map<string, ActorConfig>();
  await loadActorsFromDir(join(transportRoot, FRAMEWORK_ACTORS_SUBPATH), registry, operator);
  await loadActorsFromDir(join(transportRoot, CUSTOM_ACTORS_SUBPATH), registry, operator);
  // v1.4.0-alpha.1+ — operator-scoped layer. Only loaded when an operator
  // handle is configured; otherwise there's no `<handle>` to scope by.
  // Loaded AFTER custom but BEFORE local: operator-scoped profiles win
  // over shared `custom/`, but a machine-local entry in ~/.crosstalk/
  // actors/ still overrides everything (matches the existing local-wins
  // override semantics from v1.2).
  if (operator) {
    await loadActorsFromDir(join(transportRoot, operatorActorsSubpath(operator)), registry, operator);
  }
  await loadActorsFromDir(localActorsDir ?? LOCAL_ACTORS_DIR, registry, operator);
  return registry;
}

/** Return all actor instances belonging to a given role (and optional
 * operator). For singleton actors, returns a single-element array. For
 * pools (multiple instances of the same role), returns all instances
 * in instance-index order.
 *
 * Pool-aware helper that complements the address-form Map lookup. Use
 * `registry.get(address)` for direct-address lookups; use this for "give
 * me all alices belonging to Steve". */
export function getPoolInstances(
  registry: Registry,
  role: string,
  operator?: string,
): ActorConfig[] {
  const matches: ActorConfig[] = [];
  for (const actor of registry.values()) {
    if (actor.role !== role) continue;
    if (operator !== undefined && actor.operator !== operator) continue;
    matches.push(actor);
  }
  // Sort: singletons first (instance undefined), then by instance index ascending
  matches.sort((a, b) => {
    if (a.instance === undefined && b.instance === undefined) return 0;
    if (a.instance === undefined) return -1;
    if (b.instance === undefined) return 1;
    return a.instance - b.instance;
  });
  return matches;
}

/** Return all distinct roles in the registry (deduplicated). Useful for
 * pool enumeration: roles with multiple entries are pools, roles with
 * one entry are singletons. */
export function listRoles(registry: Registry): string[] {
  const roles = new Set<string>();
  for (const actor of registry.values()) {
    roles.add(actor.role);
  }
  return [...roles].sort();
}

/** Resolve an address (parsed or string) to the actor instances it
 * matches in the registry. Returns:
 *   - bare role / `role@operator` → all instances of that pool (or single)
 *   - `role-N@operator` / `role-N` → the specific instance (or empty if not found)
 *   - bare human name / `human@human` → the single human actor (or empty)
 *
 * Pool dispatch semantics (fanout, load-balance, etc.) are NOT applied
 * here — this function returns what's available; the dispatch layer
 * (Phase 4) decides what to do with the returned set. */
export function resolveAddress(
  registry: Registry,
  address: string,
): ActorConfig[] {
  const parsed = parseAddress(address);
  if (isAddressError(parsed)) return [];

  if (parsed.kind === 'human') {
    // Bare human name: look up by canonical address (which might be the
    // bare name in single-op mode, or `<name>@<name>` in multi-op — but
    // humans canonicalise to bare even with @).
    const direct = registry.get(parsed.name);
    return direct ? [direct] : [];
  }

  // Machine address: role@operator or role-N@operator
  const { role, operator, instance } = parsed;
  if (instance !== undefined) {
    // Specific instance — direct lookup
    const direct = registry.get(formatAddress(parsed));
    return direct ? [direct] : [];
  }
  // Pool address — return all matching instances
  return getPoolInstances(registry, role, operator);
}

export function watchRegistry(transportRoot: string, onChange: () => void, operator?: string): void {
  const dirs = [
    join(transportRoot, FRAMEWORK_ACTORS_SUBPATH),
    join(transportRoot, CUSTOM_ACTORS_SUBPATH),
    LOCAL_ACTORS_DIR,
  ];
  if (operator) {
    dirs.push(join(transportRoot, operatorActorsSubpath(operator)));
  }
  for (const dir of dirs) {
    try {
      watch(dir, { recursive: false }, onChange);
    } catch {
      // dir may not exist yet
    }
  }
}

/** Re-export for use by adjacent modules (dispatch, etc.) that need to
 * validate role names without re-importing address.ts. */
export { validateBareRoleName };
