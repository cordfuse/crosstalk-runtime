import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';

export interface AgentConfig {
  name: string;
  cli: string;
  channel: string;
  interval: number;       // seconds between ticks
  contextWindow: number;  // how many prior messages to include per dispatch
  systemPromptFile?: string; // path relative to transport dir; prepended to stdin
  git: {
    name: string;
    email: string;
  };
}

export interface RuntimeConfig {
  transport: string;      // absolute or relative path to transport repo
  agents: AgentConfig[];
  jitter: number;         // max ms to sleep before push (default 5000)
}

export function loadConfig(path: string): RuntimeConfig {
  const raw = readFileSync(path, 'utf-8');
  const data = parseYaml(raw) as Partial<RuntimeConfig>;

  if (!data.transport) throw new Error('config: transport is required');
  if (!Array.isArray(data.agents) || data.agents.length === 0)
    throw new Error('config: agents must be a non-empty array');

  for (const agent of data.agents as Partial<AgentConfig>[]) {
    if (!agent.name) throw new Error('config: every agent needs a name');
    if (!agent.cli) throw new Error(`config: agent ${agent.name} missing cli`);
    if (!agent.channel) throw new Error(`config: agent ${agent.name} missing channel`);
    if (!agent.git?.name || !agent.git?.email)
      throw new Error(`config: agent ${agent.name} missing git.name / git.email`);
    agent.interval ??= 60;
    agent.contextWindow ??= 20;
  }

  return {
    transport: data.transport,
    agents: data.agents as AgentConfig[],
    jitter: data.jitter ?? 5000,
  };
}
