import type { RelayConfig } from './config.js';
import { pullTransport } from './git.js';

// ─── shared types ────────────────────────────────────────────────────────────

interface NotifyMessage {
  type: 'notify';
  repo: string;
  event: string;
  sha: string;
}

interface AuthMessage {
  type: 'auth';
  secret: string;
}

interface ReadyMessage {
  type: 'ready';
}

interface ErrorMessage {
  type: 'error';
  message: string;
}

type RelayMessage = NotifyMessage | AuthMessage | ReadyMessage | ErrorMessage;

// ─── server mode ─────────────────────────────────────────────────────────────

// authenticated WebSocket clients
const clients = new Set<import('bun').ServerWebSocket<{ authenticated: boolean }>>();

async function verifyGitHubSignature(body: string, signature: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const computed = 'sha256=' + Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return computed === signature;
}

function broadcast(msg: NotifyMessage): void {
  const payload = JSON.stringify(msg);
  let count = 0;
  for (const ws of clients) {
    if (ws.data.authenticated) {
      ws.send(payload);
      count++;
    }
  }
  console.log(`[relay] broadcast repo=${msg.repo} sha=${msg.sha.slice(0, 7)} to ${count} client(s)`);
}

export function startRelayServer(config: RelayConfig): void {
  const { port, secret, webhookSecret } = config;

  if (!secret) {
    console.error('[relay] server mode requires relay.secret in config');
    process.exit(1);
  }

  Bun.serve<{ authenticated: boolean }>({
    port,
    fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade
      if (url.pathname === '/ws') {
        const upgraded = server.upgrade(req, { data: { authenticated: false } });
        if (upgraded) return undefined;
        return new Response('WebSocket upgrade failed', { status: 400 });
      }

      // GitHub webhook
      if (req.method === 'POST' && url.pathname === '/webhook') {
        return handleWebhook(req, webhookSecret);
      }

      // health check
      if (url.pathname === '/health') {
        return new Response(JSON.stringify({ status: 'ok', clients: clients.size }), {
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response('Not found', { status: 404 });
    },
    websocket: {
      open(ws) {
        console.log(`[relay] client connected (${clients.size + 1} total)`);
        // require auth within 10s
        setTimeout(() => {
          if (!ws.data.authenticated) {
            ws.send(JSON.stringify({ type: 'error', message: 'auth timeout' }));
            ws.close();
          }
        }, 10_000);
      },
      message(ws, raw) {
        let msg: RelayMessage;
        try {
          msg = JSON.parse(String(raw)) as RelayMessage;
        } catch {
          return;
        }

        if (!ws.data.authenticated) {
          if (msg.type === 'auth') {
            if (msg.secret === secret) {
              ws.data.authenticated = true;
              clients.add(ws);
              ws.send(JSON.stringify({ type: 'ready' } satisfies ReadyMessage));
              console.log(`[relay] client authenticated (${clients.size} connected)`);
            } else {
              ws.send(JSON.stringify({ type: 'error', message: 'invalid secret' } satisfies ErrorMessage));
              ws.close();
            }
          }
        }
      },
      close(ws) {
        clients.delete(ws);
        console.log(`[relay] client disconnected (${clients.size} remaining)`);
      },
    },
  });

  console.log(`[relay] server listening on port ${port}`);
}

async function handleWebhook(req: Request, webhookSecret?: string): Promise<Response> {
  const body = await req.text();

  if (webhookSecret) {
    const sig = req.headers.get('x-hub-signature-256') ?? '';
    const valid = await verifyGitHubSignature(body, sig, webhookSecret);
    if (!valid) {
      console.error('[relay] webhook signature invalid — rejected');
      return new Response('Forbidden', { status: 403 });
    }
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  const repo = (payload.repository as Record<string, unknown>)?.full_name as string ?? 'unknown';
  const sha = (payload.after as string) ?? (payload.head_commit as Record<string, unknown>)?.id as string ?? 'unknown';
  const event = req.headers.get('x-github-event') ?? 'push';

  broadcast({ type: 'notify', repo, event, sha });

  return new Response('OK');
}

// ─── client mode ─────────────────────────────────────────────────────────────

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

export function startRelayClient(config: RelayConfig, transportRoot: string): void {
  const { url, secret } = config;

  if (!secret) {
    console.warn('[relay] no relay.secret configured — connecting unauthenticated');
  }

  let attempt = 0;

  function connect(): void {
    console.log(`[relay] connecting to ${url}`);
    const ws = new WebSocket(url + '/ws');

    ws.onopen = () => {
      attempt = 0;
      console.log('[relay] connected — authenticating');
      ws.send(JSON.stringify({ type: 'auth', secret } satisfies AuthMessage));
    };

    ws.onmessage = async (event) => {
      let msg: RelayMessage;
      try {
        msg = JSON.parse(String(event.data)) as RelayMessage;
      } catch {
        return;
      }

      if (msg.type === 'ready') {
        console.log('[relay] authenticated — listening for notifications');
        return;
      }

      if (msg.type === 'error') {
        console.error(`[relay] server error: ${msg.message}`);
        return;
      }

      if (msg.type === 'notify') {
        console.log(`[relay] notify repo=${msg.repo} sha=${msg.sha.slice(0, 7)} — pulling transport`);
        try {
          await pullTransport(transportRoot);
        } catch (err) {
          console.error(`[relay] pull failed: ${err}`);
        }
      }
    };

    ws.onerror = (err) => {
      console.error(`[relay] WebSocket error: ${err}`);
    };

    ws.onclose = () => {
      attempt++;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt + Math.random() * 1000, RECONNECT_MAX_MS);
      console.log(`[relay] disconnected — reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempt})`);
      setTimeout(connect, delay);
    };
  }

  connect();
}
