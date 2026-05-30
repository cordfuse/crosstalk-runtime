import { ToknClient } from '@cordfuse/tokn/client';

export interface ToknConfig {
  url: string;
  channel: string;
  apiKey: string;
}

const clients = new Map<string, ToknClient>();

function getClient(config: ToknConfig): ToknClient {
  const key = `${config.url}|${config.apiKey}`;
  let client = clients.get(key);
  if (!client) {
    client = new ToknClient(config.url, { apiKey: config.apiKey });
    clients.set(key, client);
  }
  return client;
}

export async function ensureChannel(config: ToknConfig): Promise<void> {
  await getClient(config).createChannel(config.channel, { leaseMs: 120_000 });
}

export async function withTokn<T>(config: ToknConfig, fn: () => Promise<T>): Promise<T> {
  return getClient(config).withTurn<T>(config.channel, () => fn());
}
