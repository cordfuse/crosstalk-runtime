/**
 * System messages (presence + watcher events). Builds the frontmatter +
 * body for online/offline/timeout events; delegates persistence to the
 * injected {@link Transport}.
 *
 * v1.1.0 — refactored to use Transport.postMessage instead of the legacy
 * writeFile + commitWatcherMessage pair. Frontmatter / body construction
 * stays here (protocol concern); file paths + commits + pushes move into
 * `GitTransport`.
 */
import { join } from 'path';
import { createHash, randomUUID } from 'crypto';
import { hostname } from 'os';
import { readFile } from 'fs/promises';
import type { Transport } from './transport.js';
import { SYSTEM_CHANNEL } from './transport.js';

// Per-boot UUID — used in announcements to identify this specific startup
export const SESSION_ID = randomUUID();

// Stable across restarts — used for cursor tracking so processed messages
// are not re-dispatched after a restart
export const MACHINE_ID = createHash('sha256').update(hostname()).digest('hex').slice(0, 16);

const MACHINE_HASH = MACHINE_ID.slice(0, 8);

export const WATCHER_IDENTITY = { name: 'watcher', email: 'watcher@crosstalk.noreply' };

async function readProtocolVersion(transportRoot: string): Promise<string> {
  try {
    return (await readFile(join(transportRoot, 'CROSSTALK-VERSION'), 'utf-8')).trim();
  } catch {
    return 'unknown';
  }
}

function buildSystemMessage(
  reason: string,
  extra: Record<string, string>,
  body: string,
): string {
  const iso = new Date().toISOString();
  const extraLines = Object.entries(extra).map(([k, v]) => `${k}: ${v}`).join('\n');
  return `---\nfrom: watcher\nto: all\ntimestamp: ${iso}\ntype: system\nreason: ${reason}\nsession-id: ${SESSION_ID}\nmachine: ${MACHINE_HASH}\n${extraLines}\n---\n\n${body}\n`;
}

export async function announceOnline(
  transport: Transport,
  transportRoot: string,
  actorNames: string[],
): Promise<void> {
  const version = await readProtocolVersion(transportRoot);
  const transportLabel = transportRoot.split('/').slice(-2).join('/');
  const body =
    `watcher online — ${actorNames.length} actors registered, watching ${transportLabel}\n\n` +
    `protocol-version: ${version}\n` +
    `actors:\n${actorNames.map(a => `  - ${a}`).join('\n')}`;

  const content = buildSystemMessage('online', {}, body);
  await transport.postMessage(SYSTEM_CHANNEL, WATCHER_IDENTITY, content);
}

export async function announceOffline(transport: Transport): Promise<void> {
  const content = buildSystemMessage('offline', {}, 'watcher offline — graceful shutdown');
  await transport.postMessage(SYSTEM_CHANNEL, WATCHER_IDENTITY, content);
}

export async function announceTimeout(
  transport: Transport,
  actorName: string,
  channelGuid: string,
): Promise<void> {
  const content = buildSystemMessage(
    'timeout',
    { actor: actorName, channel: channelGuid },
    `actor timeout — ${actorName} did not respond in time\n\nchannel: ${channelGuid}`,
  );
  await transport.postMessage(SYSTEM_CHANNEL, WATCHER_IDENTITY, content);
}
