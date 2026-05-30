import { TurnqClient } from '@cordfuse/turnq/client';
import { LocalTurnqClient } from '@cordfuse/turnq/local';

export interface TurnqConfig {
  url: string;
  channel: string;
  apiKey: string;
}

interface Coordinator {
  createChannel(name: string, opts?: { leaseMs?: number }): Promise<void>;
  withTurn<T>(channel: string, fn: () => Promise<T>): Promise<T>;
  close(): void;
}

const DEFAULT_CHANNEL = 'crosstalk:push';

let _coordinator: Coordinator | null = null;

async function resolve(config?: TurnqConfig): Promise<Coordinator> {
  if (_coordinator) return _coordinator;

  if (config?.url && config.apiKey) {
    try {
      const res = await fetch(`${config.url}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        console.log(`[turnq] distributed — ${config.url}`);
        _coordinator = new TurnqClient(config.url, { apiKey: config.apiKey });
        return _coordinator;
      }
    } catch {}
    console.warn(`[turnq] ${config.url} unreachable — falling back to local file lock`);
  } else if (config?.url || config?.apiKey) {
    console.warn('[turnq] URL or API key missing — using local file lock');
  } else {
    console.log('[turnq] local file lock mode');
  }

  const local = new LocalTurnqClient();
  _coordinator = local;
  return local;
}

export async function ensureChannel(config?: TurnqConfig): Promise<void> {
  const c = await resolve(config);
  await c.createChannel(config?.channel ?? DEFAULT_CHANNEL, { leaseMs: 120_000 });
}

export async function withTurnq<T>(config: TurnqConfig | undefined, fn: () => Promise<T>): Promise<T> {
  const c = await resolve(config);
  return c.withTurn<T>(config?.channel ?? DEFAULT_CHANNEL, fn);
}
