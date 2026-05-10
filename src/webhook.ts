import { createHmac, timingSafeEqual } from 'crypto';

function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

export function startWebhookServer(
  port: number,
  secret: string,
  onPush: () => void,
): void {
  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== 'POST' || url.pathname !== '/webhook') {
        return new Response('not found', { status: 404 });
      }

      const sig = req.headers.get('x-hub-signature-256') ?? '';
      const body = await req.text();

      if (!verifySignature(body, sig, secret)) {
        console.warn('[webhook] invalid signature — rejected');
        return new Response('unauthorized', { status: 401 });
      }

      const event = req.headers.get('x-github-event');
      if (event === 'push') {
        console.log('[webhook] push event — pulling transport');
        onPush();
      }

      return new Response('ok');
    },
  });

  console.log(`[webhook] listening on port ${port}`);
}
