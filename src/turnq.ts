import { TurnqClient } from '@cordfuse/turnq/client';

export interface TurnqConfig {
  url: string;
  channel: string;
  apiKey: string;
}

const clients = new Map<string, TurnqClient>();

function getClient(config: TurnqConfig): TurnqClient {
  const key = `${config.url}|${config.apiKey}`;
  let client = clients.get(key);
  if (!client) {
    client = new TurnqClient(config.url, { apiKey: config.apiKey });
    clients.set(key, client);
  }
  return client;
}

export async function ensureChannel(config: TurnqConfig): Promise<void> {
  await getClient(config).createChannel(config.channel, { leaseMs: 120_000 });
}

export async function withTurnq<T>(config: TurnqConfig, fn: () => Promise<T>): Promise<T> {
  return getClient(config).withTurn<T>(config.channel, () => fn());
}
