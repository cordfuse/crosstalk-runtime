import { mkdirSync, writeFileSync, readdirSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { detectPlatform } from './platform.js';
import { dispatchSingle } from './dispatch.js';
import { commitAndPush } from './git.js';
import { listMessages } from './cursor.js';
import { log } from './log.js';

export interface DlqEntry {
  id: string;
  ts: string;
  actor: string;
  channel: string;
  messageRelPath: string;
  transportPath: string;
  channelsDir: string;
  cli: string;
  systemPrompt?: string;
  error: string;
  attempts: number;
}

function dlqDir(): string {
  return join(detectPlatform().paths.dataDir, 'dlq');
}

export function writeDlqEntry(entry: Omit<DlqEntry, 'id' | 'ts' | 'attempts'>): string {
  const dir = dlqDir();
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString();
  const slug = entry.messageRelPath.split('/').pop()?.slice(0, 16) ?? 'msg';
  const id = `${ts.slice(0, 19).replace(/[:T]/g, '-')}-${entry.actor}-${slug}`;
  const full: DlqEntry = { id, ts, attempts: 1, ...entry };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(full, null, 2));
  return id;
}

export function listDlq(): DlqEntry[] {
  try {
    return readdirSync(dlqDir())
      .filter(f => f.endsWith('.json'))
      .sort()
      .map(f => JSON.parse(readFileSync(join(dlqDir(), f), 'utf-8')) as DlqEntry);
  } catch {
    return [];
  }
}

export function dropDlqEntry(id: string): boolean {
  try { unlinkSync(join(dlqDir(), `${id}.json`)); return true; }
  catch { return false; }
}

export async function retryDlqEntry(id: string): Promise<void> {
  const path = join(dlqDir(), `${id}.json`);
  const entry: DlqEntry = JSON.parse(readFileSync(path, 'utf-8'));

  const channelDir = join(entry.transportPath, entry.channelsDir, entry.channel);
  const allRelPaths = await listMessages(channelDir);

  const stagedFiles = await dispatchSingle({
    transportPath: entry.transportPath,
    channelsDir: entry.channelsDir,
    channelGuid: entry.channel,
    allRelPaths,
    messageRelPath: entry.messageRelPath,
    actorName: entry.actor,
    cli: entry.cli,
    systemPrompt: entry.systemPrompt,
  });

  if (stagedFiles.length > 0) {
    await commitAndPush({
      transportPath: entry.transportPath,
      files: stagedFiles,
      message: `crosstalk: ${entry.actor} dlq-retry`,
      identity: { name: entry.actor, email: `${entry.actor}@crosstalk.local` },
    });
    dropDlqEntry(id);
    log.info('dlq_retry_ok', { id, actor: entry.actor });
    console.log(`dlq: retry ok — ${id}`);
  } else {
    entry.attempts += 1;
    writeFileSync(path, JSON.stringify(entry, null, 2));
    log.warn('dlq_retry_failed', { id, actor: entry.actor, attempts: entry.attempts });
    console.error(`dlq: retry failed — ${id} (attempts: ${entry.attempts})`);
  }
}

export async function runDlq(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';

  if (sub === 'list') {
    const entries = listDlq();
    if (entries.length === 0) { console.log('dlq: empty'); return; }
    console.log(`${'ID'.padEnd(55)} ${'ACTOR'.padEnd(22)} ATT  ERROR`);
    for (const e of entries) {
      console.log(`${e.id.padEnd(55)} ${e.actor.padEnd(22)} ${String(e.attempts).padEnd(5)}${e.error.slice(0, 60)}`);
    }
    return;
  }

  if (sub === 'retry') {
    const id = args[1];
    if (!id) { console.error('usage: crosstalk dlq retry <id>'); process.exit(1); }
    await retryDlqEntry(id);
    return;
  }

  if (sub === 'drop') {
    const id = args[1];
    if (!id) { console.error('usage: crosstalk dlq drop <id>|--all'); process.exit(1); }
    if (id === '--all') {
      const entries = listDlq();
      for (const e of entries) dropDlqEntry(e.id);
      console.log(`dlq: dropped ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`);
      return;
    }
    if (dropDlqEntry(id)) console.log(`dlq: dropped ${id}`);
    else { console.error(`dlq: not found: ${id}`); process.exit(1); }
    return;
  }

  console.error('usage: crosstalk dlq [list|retry <id>|drop <id>|drop --all]');
  process.exit(1);
}
