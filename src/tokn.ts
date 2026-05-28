import { randomUUID } from 'crypto';

export interface ToknConfig {
  url: string;
  channel: string;
  apiKey: string;
}

export async function ensureChannel(config: ToknConfig): Promise<void> {
  const res = await fetch(`${config.url}/channels`, {
    method: 'POST',
    headers: headers(config),
    body: JSON.stringify({ name: config.channel, leaseMs: 120_000 }),
  });
  if (!res.ok && res.status !== 409) {
    const body = await res.text();
    throw new Error(`tokn: failed to ensure channel "${config.channel}": ${res.status} ${body}`);
  }
}

export async function withTokn<T>(config: ToknConfig, fn: () => Promise<T>): Promise<T> {
  const clientId = randomUUID();

  const enqRes = await fetch(`${config.url}/channels/${config.channel}/enqueue`, {
    method: 'POST',
    headers: headers(config),
    body: JSON.stringify({ clientId }),
  });
  if (!enqRes.ok) {
    const body = await enqRes.text();
    throw new Error(`tokn: enqueue failed: ${enqRes.status} ${body}`);
  }
  const { requestId } = await enqRes.json() as { requestId: string; position: number };

  await waitForTurn(config, clientId, requestId);

  let success = true;
  let error: string | undefined;
  try {
    return await fn();
  } catch (err) {
    success = false;
    error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    await fetch(`${config.url}/channels/${config.channel}/release`, {
      method: 'POST',
      headers: headers(config),
      body: JSON.stringify({ clientId, requestId, result: { success, error } }),
    }).catch(() => {});
  }
}

function headers(config: ToknConfig): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-api-key': config.apiKey };
}

async function waitForTurn(config: ToknConfig, clientId: string, requestId: string): Promise<void> {
  const url = `${config.url}/channels/${encodeURIComponent(config.channel)}/subscribe` +
    `?clientId=${encodeURIComponent(clientId)}&requestId=${encodeURIComponent(requestId)}`;

  const res = await fetch(url, { headers: headers(config) });
  if (!res.ok || !res.body) throw new Error(`tokn: subscribe failed: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) throw new Error('tokn: subscribe stream ended before your-turn');
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:') && currentEvent) {
        if (currentEvent === 'your-turn') { reader.cancel(); return; }
        if (currentEvent === 'timeout') throw new Error('tokn: lease expired waiting for turn');
        currentEvent = '';
      }
    }
  }
}
