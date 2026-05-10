import { join } from 'path';
import { createHash } from 'crypto';
import { hostname } from 'os';
import { mkdir } from 'fs/promises';
import { randomUUID } from 'crypto';
import { commitWatcherMessage } from './git.js';

// Per-boot UUID — used in announcements to identify this specific startup
export const SESSION_ID = randomUUID();

// Stable across restarts — used for cursor tracking so processed messages
// are not re-dispatched after a restart
export const MACHINE_ID = createHash('sha256').update(hostname()).digest('hex').slice(0, 16);

const MACHINE_HASH = MACHINE_ID.slice(0, 8);

function nowParts() {
  const d = new Date();
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return {
    date: `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`,
    file: `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}${p(d.getUTCMilliseconds(), 3)}Z.md`,
    iso: d.toISOString(),
  };
}

async function readProtocolVersion(transportRoot: string): Promise<string> {
  try {
    return (await Bun.file(join(transportRoot, 'CROSSTALK-VERSION')).text()).trim();
  } catch {
    return 'unknown';
  }
}

async function writeSystemMessage(
  transportRoot: string,
  reason: string,
  extra: Record<string, string>,
  body: string,
): Promise<string> {
  const { date, file, iso } = nowParts();
  const dir = join(transportRoot, '_system', date);
  await mkdir(dir, { recursive: true });

  const extraLines = Object.entries(extra).map(([k, v]) => `${k}: ${v}`).join('\n');
  const content =
    `---\nfrom: watcher\nto: all\ntimestamp: ${iso}\ntype: system\nreason: ${reason}\nsession-id: ${SESSION_ID}\nmachine: ${MACHINE_HASH}\n${extraLines}\n---\n\n${body}\n`;

  const relPath = `${date}/${file}`;
  await Bun.write(join(transportRoot, '_system', relPath), content);
  return relPath;
}

export async function announceOnline(
  transportRoot: string,
  actorNames: string[],
): Promise<void> {
  const version = await readProtocolVersion(transportRoot);
  const transportLabel = transportRoot.split('/').slice(-2).join('/');
  const body =
    `watcher online — ${actorNames.length} actors registered, watching ${transportLabel}\n\n` +
    `protocol-version: ${version}\n` +
    `actors:\n${actorNames.map(a => `  - ${a}`).join('\n')}`;

  const relPath = await writeSystemMessage(transportRoot, 'online', {}, body);
  await commitWatcherMessage(transportRoot, relPath, 'online');
}

export async function announceOffline(transportRoot: string): Promise<void> {
  const relPath = await writeSystemMessage(
    transportRoot,
    'offline',
    {},
    'watcher offline — graceful shutdown',
  );
  await commitWatcherMessage(transportRoot, relPath, 'offline');
}

export async function announceTimeout(
  transportRoot: string,
  actorName: string,
  channelGuid: string,
): Promise<void> {
  const relPath = await writeSystemMessage(
    transportRoot,
    'timeout',
    { actor: actorName, channel: channelGuid },
    `actor timeout — ${actorName} did not respond in time\n\nchannel: ${channelGuid}`,
  );
  await commitWatcherMessage(transportRoot, relPath, `timeout:${actorName}`);
}
