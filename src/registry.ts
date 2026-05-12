import { join } from 'path';
import { homedir } from 'os';
import { readdir } from 'fs/promises';
import { watch } from 'fs';
import { parseFrontmatter } from './frontmatter.js';

const LOCAL_ACTORS_DIR = join(homedir(), '.crosstalk', 'actors');
const FRAMEWORK_ACTORS_SUBPATH = join('manifest', 'framework', 'actors');
const CUSTOM_ACTORS_SUBPATH = join('manifest', 'custom', 'actors');

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
}

export type Registry = Map<string, ActorConfig>;

function extractBody(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}

async function loadActorsFromDir(dir: string, registry: Registry): Promise<void> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return;
  }

  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const name = file.slice(0, -3);

    if (!isKebabCase(name)) {
      console.error(`[registry] "${name}" is not kebab-case — actor skipped. Rename the file to ${name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}.md`);
      continue;
    }

    const content = await Bun.file(join(dir, file)).text();
    const { data } = parseFrontmatter(content);

    const agent = typeof data.agent === 'string' ? data.agent : undefined;
    const command = typeof data.command === 'string' ? data.command : undefined;

    // Must have either agent (native invocation) or command (custom adapter)
    if (!agent && !command) continue;

    warnUnprefixedCustomFields(name, data);

    registry.set(name, {
      name,
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
    });
  }
}

// Loads actors from three layers (each layer wins over the previous on name collision):
// 1. <transportRoot>/manifest/framework/actors/ — framework-shipped actors (base)
// 2. <transportRoot>/manifest/custom/actors/ — operator-defined actors
// 3. ~/.crosstalk/actors/ — local machine overrides
export async function loadRegistry(transportRoot: string): Promise<Registry> {
  const registry = new Map<string, ActorConfig>();
  await loadActorsFromDir(join(transportRoot, FRAMEWORK_ACTORS_SUBPATH), registry);
  await loadActorsFromDir(join(transportRoot, CUSTOM_ACTORS_SUBPATH), registry);
  await loadActorsFromDir(LOCAL_ACTORS_DIR, registry);
  return registry;
}

export function watchRegistry(transportRoot: string, onChange: () => void): void {
  for (const dir of [
    join(transportRoot, FRAMEWORK_ACTORS_SUBPATH),
    join(transportRoot, CUSTOM_ACTORS_SUBPATH),
    LOCAL_ACTORS_DIR,
  ]) {
    try {
      watch(dir, { recursive: false }, onChange);
    } catch {
      // dir may not exist yet
    }
  }
}
