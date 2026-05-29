import { readFileSync, existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import type { ToknConfig } from './tokn.js';

export type { ToknConfig };

export interface AgentConfig {
  name: string;
  cli: string;
  // All fields below are optional — auto-discovered or defaulted
  interval?: number;         // seconds between ticks; inherits top-level or 60
  channels?: string[];       // restrict to specific GUIDs; default: all channels in transport
  systemPromptFile?: string; // relative to transport; default: manifest/custom/actors/<name>.md
  contextWindow?: number;    // prior messages to include per dispatch; default: 20
  git?: { name: string; email: string }; // default: derived from actor file + <name>@crosstalk.local
  spawnCwd?: string;         // CLI subprocess working dir; default: /tmp
  pool?: string;             // pool name this agent is a member of (see CROSSTALK.md Pools).
                             // Overrides metadata.pool from the resolved actor file.
}

export interface RuntimeConfig {
  transport: string;      // path to transport repo (absolute or relative to config file)
  channelsDir: string;    // channels dir relative to transport; default: data/channels
  interval: number;       // default tick interval seconds; default: 60
  jitter: number;         // max ms sleep before push; default: 5000 (ignored when tokn is set)
  tokn?: ToknConfig;      // if set, use tokn for push serialization instead of jitter
  agents: AgentConfig[];
}

// Build config entirely from CLI flags — no YAML file required.
// Usage: --transport <path> --agent "name:cli" [--agent ...] [--tokn-url <url>]
//        [--tokn-channel <ch>] [--interval <s>] [--jitter <ms>]
export function configFromFlags(argv: string[]): RuntimeConfig {
  const get  = (flag: string) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1]; };
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

  const toknUrl = get('--tokn-url');
  const tokn: ToknConfig | undefined = toknUrl
    ? { url: toknUrl, channel: get('--tokn-channel') ?? 'crosstalk:push', apiKey: process.env.TOKN_API_KEY ?? '' }
    : undefined;

  return {
    transport,
    channelsDir: get('--channels-dir') ?? 'data/channels',
    interval:    Number(get('--interval')    ?? 60),
    jitter:      Number(get('--jitter')      ?? 5000),
    tokn,
    agents,
  };
}

export function loadConfig(path: string): RuntimeConfig {
  const raw = readFileSync(path, 'utf-8');
  const data = parseYaml(raw) as Partial<RuntimeConfig & { agents: Partial<AgentConfig>[] }>;

  if (!data.transport) throw new Error('config: transport is required');
  if (!Array.isArray(data.agents) || data.agents.length === 0)
    throw new Error('config: agents must be a non-empty array');

  for (const agent of data.agents) {
    if (!agent.name) throw new Error('config: every agent needs a name');
    if (!agent.cli) throw new Error(`config: agent "${agent.name}" missing cli`);
  }

  const toknYaml = (data as any).tokn as { url?: string; channel?: string } | undefined;
  const tokn: ToknConfig | undefined = toknYaml?.url
    ? {
        url: toknYaml.url,
        channel: toknYaml.channel ?? 'crosstalk:push',
        apiKey: process.env.TOKN_API_KEY ?? '',
      }
    : undefined;

  return {
    transport: data.transport,
    channelsDir: data.channelsDir ?? 'data/channels',
    interval: data.interval ?? 60,
    jitter: data.jitter ?? 5000,
    tokn,
    agents: data.agents as AgentConfig[],
  };
}
