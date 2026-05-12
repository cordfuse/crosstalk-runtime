import type { RelayConfig } from './config.js';
import { pullTransport } from './git.js';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { createHmac, timingSafeEqual } from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Resolve package.json at runtime — works both for dev (node --watch src/)
// and for installed packages (dist/relay.js → ../package.json).
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as { version: string };

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

// Per-connection auth state stored on the WebSocket instance itself.
type AuthedWebSocket = WebSocket & { authenticated?: boolean };

// ─── server mode ─────────────────────────────────────────────────────────────
//
// Server mode runs in the Docker deployment of the relay. Built on node's
// http.createServer + the ws npm package's WebSocketServer. Pure node — no
// bun dependency. Same code paths work under node and under bun (since bun
// is mostly node-compatible), but the canonical runtime is node.

// authenticated WebSocket clients
const clients = new Set<AuthedWebSocket>();

function verifyGitHubSignature(body: string, signature: string, secret: string): boolean {
  if (!signature.startsWith('sha256=')) return false;
  const hmac = createHmac('sha256', secret);
  hmac.update(body);
  const computed = 'sha256=' + hmac.digest('hex');
  if (computed.length !== signature.length) return false;
  try {
    return timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
  } catch {
    return false;
  }
}

function broadcast(msg: NotifyMessage): void {
  const payload = JSON.stringify(msg);
  let count = 0;
  for (const ws of clients) {
    if (ws.authenticated) {
      ws.send(payload);
      count++;
    }
  }
  console.log(`[relay] broadcast repo=${msg.repo} sha=${msg.sha.slice(0, 7)} to ${count} client(s)`);
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString('utf-8'); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export function startRelayServer(config: RelayConfig): void {
  const { port, secret, webhookSecret } = config;
  const requireAuth = !!secret;

  if (!requireAuth) {
    console.log('[relay] server running in open mode (no secret set)');
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // GitHub webhook
    if (req.method === 'POST' && url.pathname === '/webhook') {
      const body = await readRequestBody(req);

      if (webhookSecret) {
        const sig = (req.headers['x-hub-signature-256'] as string | undefined) ?? '';
        if (!verifyGitHubSignature(body, sig, webhookSecret)) {
          console.error('[relay] webhook signature invalid — rejected');
          res.writeHead(403); res.end('Forbidden');
          return;
        }
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(body) as Record<string, unknown>;
      } catch {
        res.writeHead(400); res.end('Bad request');
        return;
      }

      const repo = (payload.repository as Record<string, unknown>)?.full_name as string ?? 'unknown';
      const sha = (payload.after as string) ?? (payload.head_commit as Record<string, unknown>)?.id as string ?? 'unknown';
      const event = (req.headers['x-github-event'] as string | undefined) ?? 'push';

      broadcast({ type: 'notify', repo, event, sha });
      res.writeHead(200); res.end('OK');
      return;
    }

    // health check
    if (url.pathname === '/health') {
      sendJson(res, 200, { status: 'ok', clients: clients.size });
      return;
    }

    // service identity at root — distinguishes "alive but wrong path" from "down"
    if (url.pathname === '/') {
      sendJson(res, 200, {
        service: 'crosstalk-relay',
        version: pkg.version,
        endpoints: ['/health', '/version', '/webhook', '/ws'],
      });
      return;
    }

    // version-only endpoint — useful for polling deploy completion
    if (url.pathname === '/version') {
      sendJson(res, 200, { version: pkg.version });
      return;
    }

    res.writeHead(404); res.end('Not found');
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (rawWs) => {
      const ws = rawWs as AuthedWebSocket;
      ws.authenticated = !requireAuth;

      if (!requireAuth) {
        clients.add(ws);
        ws.send(JSON.stringify({ type: 'ready' } satisfies ReadyMessage));
      }
      console.log(`[relay] client connected (${clients.size} total)`);

      if (requireAuth) {
        setTimeout(() => {
          if (!ws.authenticated) {
            ws.send(JSON.stringify({ type: 'error', message: 'auth timeout' } satisfies ErrorMessage));
            ws.close();
          }
        }, 10_000);
      }

      ws.on('message', (raw) => {
        let msg: RelayMessage;
        try {
          msg = JSON.parse(raw.toString()) as RelayMessage;
        } catch {
          return;
        }

        if (!ws.authenticated && msg.type === 'auth') {
          if (msg.secret === secret) {
            ws.authenticated = true;
            clients.add(ws);
            ws.send(JSON.stringify({ type: 'ready' } satisfies ReadyMessage));
            console.log(`[relay] client authenticated (${clients.size} connected)`);
          } else {
            ws.send(JSON.stringify({ type: 'error', message: 'invalid secret' } satisfies ErrorMessage));
            ws.close();
          }
        }
      });

      ws.on('close', () => {
        clients.delete(ws);
        console.log(`[relay] client disconnected (${clients.size} remaining)`);
      });
    });
  });

  server.listen(port, () => {
    console.log(`[relay] server listening on port ${port}`);
  });
}

// ─── client mode ─────────────────────────────────────────────────────────────

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

export function startRelayClient(config: RelayConfig, transportRoot: string): void {
  const { url, secret } = config;

  let attempt = 0;

  function connect(): void {
    console.log(`[relay] connecting to ${url}`);
    const ws = new WebSocket(url + '/ws');

    ws.on('open', () => {
      attempt = 0;
      if (secret) {
        console.log('[relay] connected — authenticating');
        ws.send(JSON.stringify({ type: 'auth', secret } satisfies AuthMessage));
      } else {
        console.log('[relay] connected — no secret, skipping auth');
      }
    });

    ws.on('message', async (data) => {
      let msg: RelayMessage;
      try {
        msg = JSON.parse(data.toString()) as RelayMessage;
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
    });

    ws.on('error', (err) => {
      console.error(`[relay] WebSocket error: ${err}`);
    });

    ws.on('close', () => {
      attempt++;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt + Math.random() * 1000, RECONNECT_MAX_MS);
      console.log(`[relay] disconnected — reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempt})`);
      setTimeout(connect, delay);
    });
  }

  connect();
}
