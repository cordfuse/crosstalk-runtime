import { join } from 'path';
import { homedir } from 'os';
import { parse } from 'smol-toml';

const CONFIG_PATH = join(homedir(), '.crosstalk', 'config.toml');

export interface RelayConfig {
  mode: 'client' | 'server';
  url: string;
  secret: string;
  webhookSecret?: string;  // server mode only — GitHub → relay HMAC
  port: number;            // server mode only
}

export interface Config {
  transport: string;
  actorEmailSuffix: string;
  defaultHeartbeatInterval: number;
  relay: RelayConfig;
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
    };
  }

  let raw: string;
  try {
    raw = await Bun.file(CONFIG_PATH).text();
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

  return { transport, actorEmailSuffix, defaultHeartbeatInterval, relay };
}
