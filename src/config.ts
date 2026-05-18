import { join } from 'path';
import { homedir } from 'os';
import { readFile } from 'fs/promises';
import { parse } from 'smol-toml';

/** Resolve the config file path. Honors `CROSSTALK_CONFIG` env var (set
 * directly OR forwarded from the `--config` / `-c` CLI flag); falls back to
 * `~/.crosstalk/config.toml`. Lazy so env changes mid-process are observable
 * (useful for tests).
 *
 * v1.0.5+ — env override added to unblock multi-transport-per-user
 * operation (one daemon per transport, each pointed at its own config).
 * Replaces the previous hardcoded path. */
function resolveConfigPath(): string {
  return process.env.CROSSTALK_CONFIG ?? join(homedir(), '.crosstalk', 'config.toml');
}

export interface RelayConfig {
  // 'client'   — connect outbound to a relay (default; URL = wss://relay.crosstalk.sh unless overridden)
  // 'server'   — host the relay; accept inbound from runtimes + GitHub webhook
  // 'disabled' — no relay involvement; runtime polls the transport (v1.2.0+,
  //              see `pollIntervalSeconds`). Suitable for fully-offline
  //              operators, transports synced via non-git mechanisms
  //              (rsync, NAS), or anyone who wants no third-party in the
  //              webhook path.
  mode: 'client' | 'server' | 'disabled';
  url: string;
  secret: string;
  webhookSecret?: string;  // server mode only — GitHub → relay HMAC
  port: number;            // server mode only
  /** v1.2.0+ — polling interval when `mode = "disabled"`. Daemon calls
   * `transport.sync()` every N seconds to pick up commits from other
   * machines / PR merges / external pushes. Default 30s (cheap, fine for
   * batch workloads). Lower (5–10s) for interactive multi-actor use;
   * higher (60–300s) for daily-async coordination. Ignored when `mode`
   * is `"client"` or `"server"` (real-time notifications cover sync). */
  pollIntervalSeconds: number;
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
  /** How often the time-decay checker walks channels for past-decay-timer
   * pending amendments (v0.7.0-alpha.5+). Per DEADLOCK.md time-decay
   * pattern — when active ROE specifies it, expired-vote-window proposals
   * past their decay timer get auto-resolved via `roe-deadlock-resolution`
   * messages. Default 60s; lower for testing, higher (300-600s) for
   * production-scale transports. */
  decayCheckIntervalMs: number;
  /** v1.4.0-alpha.2+ — designated bootstrap coordinator address. When set,
   * ONLY the daemon whose operator handle (machine address) or
   * default-human-actor (human address) matches will run the bootstrap
   * pass. All other daemons sharing the transport skip their bootstrap
   * pass entirely. Solves the UAT-discovered push-contention storm where
   * two daemons racing to post `session-open` for the same channel caused
   * 20+ git-push retry loops on each daemon.
   *
   * Accepts the v1.3 address grammar: `alice@steve` (machine, operator
   * match required), `steve` (human, default-human-actor match required).
   * When unset, the daemon falls back to the v1.3 resolution: ROE
   * coordinator field → first-by-joined-at → first-by-name. */
  coordinatorAddress?: string;
}

export interface Config {
  transport: string;
  actorEmailSuffix: string;
  defaultHeartbeatInterval: number;
  /** Default identity for `crosstalk post`/`channel join` when --as/--from
   * is omitted. Optional — operators with multiple human profiles must
   * pass --from explicitly. Forward-compat with TODO #23 (human-actor spec). */
  defaultHumanActor?: string;
  /** v1.8.1+ — default channel for `crosstalk ask` when --channel is
   * omitted. Lets operators set up a permanent "concierge inbox" channel
   * once and just type `crosstalk ask "..."` without channel arg.
   * Other commands (post/show/tail/etc.) still require explicit channel
   * because their typical usage targets specific named channels. */
  defaultChannel?: string;
  /** v1.3.0-alpha.3+ — operator handle for the multi-operator design
   * (TODO.md #34). When set, all actor profiles on this daemon are
   * registered under qualified addresses (e.g. `alice@steve` instead
   * of bare `alice`). When undefined, the daemon operates in
   * single-operator mode and uses bare-name addresses (v1.2 behavior
   * preserved). Pick a kebab-case handle that's unique on the transport;
   * mismatch with your signing-key fingerprint is allowed but discouraged. */
  operator?: string;
  relay: RelayConfig;
  /** Operator-defined agent invocation map for `crosstalk channel join --agent <name>`.
   * Loaded from `[agents.X]` tables in config.toml. Merged with the built-in
   * defaults (claude/gemini/codex/qwen/opencode) at use site — operator
   * entries win on name collision, and operator-only names extend the map. */
  agents: Record<string, AgentSpawn>;
  /** v1.6.0-alpha.1+ — extra environment variables forwarded to agent
   * child processes (claude/gemini/qwen/opencode and custom commands).
   * Loaded from the optional `[agent-environment]` TOML table.
   *
   * Primary use case: multi-operator-on-one-machine deployments where
   * the daemon's HOME is sandboxed (per-operator `~/.crosstalk/` state)
   * but agent CLIs need their auth credentials (`~/.claude/`, `~/.gemini/`)
   * in the operator's real home. Setting `HOME = "/home/<real-user>"`
   * here makes the agent spawns find credentials while the daemon's own
   * state stays partitioned per operator. See TODO #35 for the deeper
   * design discussion.
   *
   * Merged into env AFTER the daemon's `process.env`, so values here
   * override any inherited values. PATH augmentation (the ~/.bun/bin +
   * ~/.local/bin prepend) happens first; if `PATH` is set here it wins
   * over the augmentation. */
  agentEnv: Record<string, string>;
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
    pollIntervalSeconds: 30,  // v1.2.0+ — used only when mode === 'disabled'
  },
  bootstrap: {
    timeoutMs: 300_000,         // 5 min per BOOTSTRAP.md
    deferOnNoCoordinator: false, // safe default — no governance = no gating
    decayCheckIntervalMs: 60_000, // 60s — bounds latency on time-decay auto-resolution
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
        pollIntervalSeconds: DEFAULTS.relay.pollIntervalSeconds,
        ...(process.env.WEBHOOK_SECRET ? { webhookSecret: process.env.WEBHOOK_SECRET } : {}),
      },
      agents: {},
      agentEnv: {},
      bootstrap: { ...DEFAULTS.bootstrap, decayCheckIntervalMs: DEFAULTS.bootstrap.decayCheckIntervalMs },
    };
  }

  const configPath = resolveConfigPath();
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch {
    throw new Error(
      `${configPath} not found. Create it with:\n\n` +
      `transport = "/path/to/transport"\n\n` +
      `[relay]\nmode = "client"\nurl = "wss://relay.crosstalk.sh"\nsecret = "your-relay-secret"`
    );
  }

  let data: Record<string, unknown>;
  try {
    data = parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`${configPath} parse error: ${err}`);
  }

  if (!data.transport || typeof data.transport !== 'string') {
    throw new Error(`${configPath} is missing the 'transport' field`);
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
    mode: relayData.mode === 'server' ? 'server'
        : relayData.mode === 'disabled' ? 'disabled'
        : 'client',
    url: typeof relayData.url === 'string' ? relayData.url : DEFAULTS.relay.url,
    secret: typeof relayData.secret === 'string' ? relayData.secret : DEFAULTS.relay.secret,
    port: envInt('PORT') ?? (typeof relayData.port === 'number' ? relayData.port as number : DEFAULTS.relay.port),
    pollIntervalSeconds: typeof relayData['poll-interval-seconds'] === 'number'
      ? relayData['poll-interval-seconds'] as number
      : DEFAULTS.relay.pollIntervalSeconds,
    ...(typeof relayData['webhook-secret'] === 'string'
      ? { webhookSecret: relayData['webhook-secret'] as string }
      : {}),
  };

  const defaultHumanActor = typeof data['default-human-actor'] === 'string'
    ? data['default-human-actor'] as string
    : undefined;

  // v1.8.1+ — optional default channel for `crosstalk ask`.
  const defaultChannel = typeof data['default-channel'] === 'string'
    ? data['default-channel'] as string
    : undefined;

  // v1.3.0-alpha.3+ — operator handle. Optional. When set, daemon enters
  // multi-operator mode (qualified actor addresses). When undefined, the
  // daemon stays in single-operator mode (bare-name addresses, v1.2 behavior).
  const operator = typeof data.operator === 'string' ? data.operator : undefined;

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

  // [agent-environment] table — optional. v1.6.0-alpha.1+. Plain KEY = "value"
  // entries; all values must be strings (TOML doesn't auto-coerce env vars,
  // and stringly-typed env is what child_process.spawn expects). Non-string
  // entries get skipped with a warning rather than crashing config load.
  const agentEnv: Record<string, string> = {};
  const agentEnvTable = data['agent-environment'];
  if (typeof agentEnvTable === 'object' && agentEnvTable !== null && !Array.isArray(agentEnvTable)) {
    for (const [key, value] of Object.entries(agentEnvTable)) {
      if (typeof value !== 'string') {
        console.warn(`[config] [agent-environment].${key} must be a string (got ${typeof value}) — skipping`);
        continue;
      }
      // Values are taken literally — NO `~` expansion. `homedir()` reads
      // the daemon process's `$HOME` (snapshotted at start), which in
      // sandboxed multi-operator deployments is the OPERATOR'S sandbox,
      // NOT their real home. Expanding `~` would give the wrong path
      // for the primary use case. Operators spell out absolute paths
      // (e.g. `HOME = "/home/stevekrisjanovs"`) so the override is
      // unambiguous.
      agentEnv[key] = value;
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
    decayCheckIntervalMs: typeof bootstrapTable['decay-check-interval-ms'] === 'number'
      ? bootstrapTable['decay-check-interval-ms'] as number
      : DEFAULTS.bootstrap.decayCheckIntervalMs,
    ...(typeof bootstrapTable['coordinator-address'] === 'string'
      ? { coordinatorAddress: bootstrapTable['coordinator-address'] as string }
      : {}),
  };

  return { transport, actorEmailSuffix, defaultHeartbeatInterval, defaultHumanActor, defaultChannel, operator, relay, agents, agentEnv, bootstrap };
}
