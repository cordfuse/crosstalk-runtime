import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';

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
}

export interface RuntimeConfig {
  transport: string;      // path to transport repo (absolute or relative to config file)
  channelsDir: string;    // channels dir relative to transport; default: data/channels
  interval: number;       // default tick interval seconds; default: 60
  jitter: number;         // max ms sleep before push; default: 5000
  agents: AgentConfig[];
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

  return {
    transport: data.transport,
    channelsDir: data.channelsDir ?? 'data/channels',
    interval: data.interval ?? 60,
    jitter: data.jitter ?? 5000,
    agents: data.agents as AgentConfig[],
  };
}
