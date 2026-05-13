import { join } from 'path';
import { homedir } from 'os';
import { readFile } from 'fs/promises';
import { parse } from 'smol-toml';

const CONFIG_PATH = join(homedir(), '.crosstalk', 'config.toml');

export interface RelayConfig {
  mode: 'client' | 'server';
  url: string;
  secret: string;
  webhookSecret?: string;  // server mode only — GitHub → relay HMAC
  port: number;            // server mode only
}

export interface AgentSpawn {
  /** argv array — first element is the binary, rest are args.
   * Example: `["claude"]`, `["gemini", "-i"]`, `["python3", "/path/to/bot.py"]`. */
  spawn: string[];
}

export interface BootstrapConfig {
  /** Bootstrap timeout in ms — if no `session-open` lands within this window
   * after a session-boundary, the watcher logs + treats the channel as
   * 'open' (degraded mode). Per BOOTSTRAP.md "Coordinator crashes mid-
   * bootstrap" edge case (default 5 min). */
  timeoutMs: number;
  /** When the daemon's startup-scan determines no coordinator exists in our
   * registry AND the active ROE doesn't designate one for another machine
   * to take, defer dispatch (true) or operate without bootstrap
   * synchronisation (false, default — degrades to current pre-alpha.2
   * behaviour for transports that don't use governance). */
  deferOnNoCoordinator: boolean;
}

export interface Config {
  transport: string;
  actorEmailSuffix: string;
  defaultHeartbeatInterval: number;
  /** Default identity for `crosstalk post`/`channel join` when --as/--from
   * is omitted. Optional — operators with multiple human profiles must
   * pass --from explicitly. Forward-compat with TODO #23 (human-actor spec). */
  defaultHumanActor?: string;
  relay: RelayConfig;
  /** Operator-defined agent invocation map for `crosstalk channel join --agent <name>`.
   * Loaded from `[agents.X]` tables in config.toml. Merged with the built-in
   * defaults (claude/gemini/codex/qwen/opencode) at use site — operator
   * entries win on name collision, and operator-only names extend the map. */
  agents: Record<string, AgentSpawn>;
  /** Bootstrap Coordinator settings (v0.7.0-alpha.2+). Loaded from the
   * optional `[bootstrap]` table in config.toml. */
  bootstrap: BootstrapConfig;
}

const DEFAULTS = {
  actorEmailSuffix: 'crosstalk.noreply',
  defaultHeartbeatInterval: 30,
  relay: {
    mode: 'client' as const,
    url: 'wss://relay.crosstalk.sh',
    secret: '',
    port: 3003,
  },
  bootstrap: {
    timeoutMs: 300_000,         // 5 min per BOOTSTRAP.md
    deferOnNoCoordinator: false, // safe default — no governance = no gating
  },
};

function envInt(key: string): number | undefined {
  const v = process.env[key];
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return isNaN(n) ? undefined : n;
}

export async function loadConfig(): Promise<Config> {
  // Server mode via env vars — no config.toml required (Docker / Render)
  if (process.env.RELAY_MODE === 'server') {
    return {
      transport: '',
      actorEmailSuffix: DEFAULTS.actorEmailSuffix,
      defaultHeartbeatInterval: DEFAULTS.defaultHeartbeatInterval,
      relay: {
        mode: 'server',
        url: '',
        secret: process.env.RELAY_SECRET ?? '',
        port: envInt('PORT') ?? DEFAULTS.relay.port,
        ...(process.env.WEBHOOK_SECRET ? { webhookSecret: process.env.WEBHOOK_SECRET } : {}),
      },
      agents: {},
      bootstrap: { ...DEFAULTS.bootstrap },
    };
  }

  let raw: string;
  try {
    raw = await readFile(CONFIG_PATH, 'utf-8');
  } catch {
    throw new Error(
      `~/.crosstalk/config.toml not found. Create it with:\n\n` +
      `transport = "/path/to/transport"\n\n` +
      `[relay]\nmode = "client"\nurl = "wss://relay.crosstalk.sh"\nsecret = "your-relay-secret"`
    );
  }

  let data: Record<string, unknown>;
  try {
    data = parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`~/.crosstalk/config.toml parse error: ${err}`);
  }

  if (!data.transport || typeof data.transport !== 'string') {
    throw new Error(`~/.crosstalk/config.toml is missing the 'transport' field`);
  }

  const transport = (data.transport as string).replace(/^~/, homedir());

  const actorEmailSuffix = typeof data['actor-email-suffix'] === 'string'
    ? data['actor-email-suffix'] as string
    : DEFAULTS.actorEmailSuffix;

  const defaultHeartbeatInterval = typeof data['default-heartbeat-interval'] === 'number'
    ? data['default-heartbeat-interval'] as number
    : DEFAULTS.defaultHeartbeatInterval;

  const relayData = (data.relay ?? {}) as Record<string, unknown>;

  const relay: RelayConfig = {
    mode: relayData.mode === 'server' ? 'server' : 'client',
    url: typeof relayData.url === 'string' ? relayData.url : DEFAULTS.relay.url,
    secret: typeof relayData.secret === 'string' ? relayData.secret : DEFAULTS.relay.secret,
    port: envInt('PORT') ?? (typeof relayData.port === 'number' ? relayData.port as number : DEFAULTS.relay.port),
    ...(typeof relayData['webhook-secret'] === 'string'
      ? { webhookSecret: relayData['webhook-secret'] as string }
      : {}),
  };

  const defaultHumanActor = typeof data['default-human-actor'] === 'string'
    ? data['default-human-actor'] as string
    : undefined;

  // [agents.X] tables — operator-defined invocation registry.
  // Each table must have `spawn = ["binary", "arg", ...]` (string array, ≥1 elem).
  // Skipped (with warning) if malformed; that lets the rest of the config
  // load even if one agent entry is broken.
  const agents: Record<string, AgentSpawn> = {};
  const agentsTable = data.agents;
  if (typeof agentsTable === 'object' && agentsTable !== null && !Array.isArray(agentsTable)) {
    for (const [name, raw] of Object.entries(agentsTable)) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        console.warn(`[config] [agents.${name}] is not a table — skipping`);
        continue;
      }
      const spawnRaw = (raw as Record<string, unknown>).spawn;
      if (!Array.isArray(spawnRaw) || spawnRaw.length === 0 || !spawnRaw.every(s => typeof s === 'string')) {
        console.warn(`[config] [agents.${name}].spawn must be a non-empty array of strings — skipping`);
        continue;
      }
      agents[name] = { spawn: spawnRaw as string[] };
    }
  }

  // [bootstrap] table — optional. Operators who don't use governance can
  // omit it entirely; defaults preserve pre-v0.7.0-alpha.2 behaviour.
  const bootstrapTable = (data.bootstrap ?? {}) as Record<string, unknown>;
  const bootstrap: BootstrapConfig = {
    timeoutMs: typeof bootstrapTable['timeout-ms'] === 'number'
      ? bootstrapTable['timeout-ms'] as number
      : DEFAULTS.bootstrap.timeoutMs,
    deferOnNoCoordinator: typeof bootstrapTable['defer-on-no-coordinator'] === 'boolean'
      ? bootstrapTable['defer-on-no-coordinator'] as boolean
      : DEFAULTS.bootstrap.deferOnNoCoordinator,
  };

  return { transport, actorEmailSuffix, defaultHeartbeatInterval, defaultHumanActor, relay, agents, bootstrap };
}
