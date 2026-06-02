import { join, resolve } from 'path';
import { mkdirSync, writeFileSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { hostname } from 'os';
import { messageFilename, messageDatePath } from './filenames.js';
import { sendWake } from './wake.js';
import { loadPlatformConfig } from './config.js';

function usage(): never {
  console.error(
    'usage: crosstalk send --to <actor> [--from <name>] [--channel <uuid>]\n' +
    '                      [--transport <path>] <message>'
  );
  process.exit(1);
}

function get(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

function discoverChannel(transportPath: string, channelsDir: string): string | undefined {
  try {
    const entries = readdirSync(join(transportPath, channelsDir), { withFileTypes: true });
    return entries.find(e => e.isDirectory())?.name;
  } catch { return undefined; }
}

export async function runSend(args: string[]): Promise<void> {
  const to           = get(args, '--to');
  const from         = get(args, '--from') ?? hostname().split('.')[0];
  const channelArg   = get(args, '--channel');
  const transportArg = get(args, '--transport');

  if (!to) usage();

  // Message body: everything after flags and their values
  const flagsWithValues = new Set(['--to', '--from', '--channel', '--transport']);
  const bodyTokens: string[] = [];
  let skip = false;
  for (const token of args) {
    if (skip) { skip = false; continue; }
    if (flagsWithValues.has(token)) { skip = true; continue; }
    if (token.startsWith('--')) continue;
    bodyTokens.push(token);
  }
  const body = bodyTokens.join(' ').trim();
  if (!body) { console.error('error: message body is required'); usage(); }

  // Resolve transport path
  let transportPath: string;
  if (transportArg) {
    transportPath = resolve(transportArg);
  } else {
    const config = loadPlatformConfig();
    if (!config || config.transports.length === 0) {
      console.error('error: could not determine transport path — use --transport <path>');
      process.exit(1);
    }
    transportPath = resolve(config.transports[0].path);
  }

  const channelsDir = 'data/channels';
  const channelGuid = channelArg ?? discoverChannel(transportPath, channelsDir);
  if (!channelGuid) {
    console.error(`error: no channels found in ${join(transportPath, channelsDir)}`);
    process.exit(1);
  }

  const now          = new Date();
  const datePath     = messageDatePath(now);
  const filename     = messageFilename(now);
  const channelDir   = join(transportPath, channelsDir, channelGuid, datePath);
  const filePath     = join(channelDir, filename);
  const relPath      = `${channelsDir}/${channelGuid}/${datePath}/${filename}`;

  const content = [
    '---',
    `from: ${from}`,
    `to: ${to}`,
    'type: text',
    `timestamp: ${now.toISOString()}`,
    '---',
    '',
    body,
  ].join('\n');

  mkdirSync(channelDir, { recursive: true });
  writeFileSync(filePath, content, 'utf-8');

  try {
    execSync(`git -C "${transportPath}" add "${relPath}"`, { stdio: 'pipe' });
    execSync(
      `git -C "${transportPath}" -c user.name="${from}" -c user.email="${from}@crosstalk.local" commit -m "msg: ${from} → ${to}"`,
      { stdio: 'pipe' }
    );
    execSync(`git -C "${transportPath}" push origin main`, { stdio: 'pipe' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`error: git operation failed — ${msg}`);
    process.exit(1);
  }

  sendWake();
  console.log(`sent → ${to} (channel: ${channelGuid.slice(0, 8)})`);
}
