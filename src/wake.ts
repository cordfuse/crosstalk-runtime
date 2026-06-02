import { createServer, createConnection } from 'net';
import { unlinkSync, chmodSync } from 'fs';
import { log } from './log.js';

export const WAKE_SOCKET = '/tmp/crosstalk.wake';

export function initWakeSocket(onWake: () => void): void {
  try { unlinkSync(WAKE_SOCKET); } catch { /* not present */ }

  const server = createServer(conn => {
    conn.on('data', () => { conn.destroy(); onWake(); });
    conn.on('error', () => conn.destroy());
  });

  server.listen(WAKE_SOCKET, () => {
    try { chmodSync(WAKE_SOCKET, 0o666); } catch { /* best effort */ }
    log.info('wake_socket_ready', { path: WAKE_SOCKET });
  });

  server.on('error', err => log.warn('wake_socket_error', { error: String(err) }));
}

export function sendWake(): void {
  const conn = createConnection(WAKE_SOCKET);
  conn.on('connect', () => { conn.write('w'); conn.end(); });
  conn.on('error', () => { /* daemon not running or socket absent — ignore */ });
}
