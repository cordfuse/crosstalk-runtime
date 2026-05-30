import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { hostname as osHostname } from 'os';
import { parse as parseYaml } from 'yaml';
import { parseFrontmatter } from './frontmatter.js';

export interface TurnqConfig {
  url: string;
  channel: string;
  apiKey: string;
}

export interface AgentConfig {
  name: string;
  cli: string;
  tier?: string;             // tier name from host file (e.g. "haiku", "flash")
  // All fields below are optional — auto-discovered or defaulted
  interval?: number;         // seconds between ticks; inherits top-level or 60
  channels?: string[];       // restrict to specific GUIDs; default: all channels in transport
  systemPromptFile?: string; // relative to transport; default: manifest/custom/actors/<name>.md
  contextWindow?: number;    // prior messages to include per dispatch; default: 20
  git?: { name: string; email: string }; // default: derived from actor file + <name>@<host>.crosstalk.local
  spawnCwd?: string;         // CLI subprocess working dir; default: transport root
}

export interface RuntimeConfig {
  transport: string;      // path to transport repo (absolute or relative to config file)
  channelsDir: string;    // channels dir relative to transport; default: data/channels
  interval: number;       // default tick interval seconds; default: 60
  turnq?: TurnqConfig;    // distributed coordinator URL; omit to use local file lock
  agents: AgentConfig[];  // expanded from host file or declared directly
  hostAlias?: string;     // resolved alias from manifest/hosts/<alias>.md; undefined in flag/legacy mode
}

// ── Host file types ───────────────────────────────────────────────────────────

// A tier entry: bare CLI string (count=1) or explicit object
type TierValue = string | { cli: string; count?: number };

interface HostFileActors {
  [actorName: string]: { [tierName: string]: TierValue };
}

export interface HostFile {
  alias: string;
  hostname?: string;
  actors: HostFileActors;
}

// Expand a host file into a flat AgentConfig list.
// Each tier × count becomes one AgentConfig entry.
export function expandHostFile(hostFile: HostFile): AgentConfig[] {
  const agents: AgentConfig[] = [];
  for (const [actorName, tiers] of Object.entries(hostFile.actors ?? {})) {
    for (const [tierName, tierValue] of Object.entries(tiers)) {
      const cli   = typeof tierValue === 'string' ? tierValue : tierValue.cli;
      const count = typeof tierValue === 'string' ? 1 : (tierValue.count ?? 1);
      for (let i = 0; i < count; i++) {
        agents.push({ name: actorName, cli, tier: tierName });
      }
    }
  }
  return agents;
}

// Scan manifest/hosts/ and return the HostFile matching the given alias or
// the machine's OS hostname. Returns null if not found (caller handles idle).
export function findHostFile(transportPath: string, hostOverride?: string): HostFile | null {
  const hostsDir = join(transportPath, 'manifest', 'hosts');
  if (!existsSync(hostsDir)) return null;

  let machineHostname = '';
  try { machineHostname = osHostname(); } catch { /* ignore */ }

  let files: string[];
  try {
    files = readdirSync(hostsDir).filter(f => f.endsWith('.md') && f !== '.gitkeep');
  } catch {
    return null;
  }

  for (const file of files) {
    try {
      const raw = readFileSync(join(hostsDir, file), 'utf-8');
      const { data } = parseFrontmatter(raw);
      const hf = data as Partial<HostFile>;
      if (!hf.alias) continue;

      const aliasMatch    = hostOverride && hf.alias === hostOverride;
      const hostnameMatch = !hostOverride && hf.hostname && hf.hostname === machineHostname;

      if (aliasMatch || hostnameMatch) {
        return {
          alias:    hf.alias,
          hostname: hf.hostname,
          actors:   (hf.actors as HostFileActors) ?? {},
        };
      }
    } catch { /* skip malformed files */ }
  }
  return null;
}

// ── Config loading ────────────────────────────────────────────────────────────

// Build config entirely from CLI flags — no YAML file required.
// Usage: --transport <path> --agent "name:cli" [--agent ...] [--turnq-url <url>]
//        [--turnq-channel <ch>] [--interval <s>] [--jitter <ms>]
export function configFromFlags(argv: string[]): RuntimeConfig {
  const get    = (flag: string) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1]; };
  const getAll = (flag: string) => argv.reduce<string[]>((acc, v, i, a) => {
    if (a[i - 1] === flag) acc.push(v);
    return acc;
  }, []);

  const transport = get('--transport');
  if (!transport) throw new Error('--transport <path> is required');

  const agentFlags = getAll('--agent');
  if (agentFlags.length === 0) throw new Error('at least one --agent "name:cli" is required');

  const agents: AgentConfig[] = agentFlags.map(flag => {
    const colon = flag.indexOf(':');
    if (colon === -1) throw new Error(`--agent "${flag}" must be in "name:cli" format`);
    return { name: flag.slice(0, colon).trim(), cli: flag.slice(colon + 1).trim() };
  });

  const turnqUrl = get('--turnq-url');
  const turnq: TurnqConfig | undefined = turnqUrl
    ? { url: turnqUrl, channel: get('--turnq-channel') ?? 'crosstalk:push', apiKey: process.env.TURNQ_API_KEY ?? '' }
    : undefined;

  return {
    transport,
    channelsDir: get('--channels-dir') ?? 'data/channels',
    interval:    Number(get('--interval') ?? 60),
    turnq,
    agents,
  };
}

export function loadConfig(path: string): RuntimeConfig {
  const raw  = readFileSync(path, 'utf-8');
  const data = parseYaml(raw) as Record<string, unknown>;

  if (!data.transport) throw new Error('config: transport is required');

  const turnqYaml = data.turnq as { url?: string; channel?: string } | undefined;
  const turnq: TurnqConfig | undefined = turnqYaml?.url
    ? { url: turnqYaml?.url, channel: turnqYaml.channel ?? 'crosstalk:push', apiKey: process.env.TURNQ_API_KEY ?? '' }
    : undefined;

  const base: Omit<RuntimeConfig, 'agents'> = {
    transport:   String(data.transport),
    channelsDir: String(data.channelsDir ?? 'data/channels'),
    interval:    Number(data.interval ?? 60),
    turnq,
    hostAlias:   data.host ? String(data.host) : undefined,
  };

  // Legacy path: agents declared directly in config.yaml
  if (Array.isArray(data.agents) && data.agents.length > 0) {
    const agents = data.agents as Partial<AgentConfig>[];
    for (const agent of agents) {
      if (!agent.name) throw new Error('config: every agent needs a name');
      if (!agent.cli)  throw new Error(`config: agent "${agent.name}" missing cli`);
    }
    return { ...base, agents: agents as AgentConfig[] };
  }

  // Host file path: agents derived at runtime startup (transport path needed first).
  // Return empty agents array; runner.ts resolves the host file after resolving transport.
  return { ...base, agents: [] };
}
