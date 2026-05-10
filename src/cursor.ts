import { join } from 'path';
import { homedir } from 'os';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { readdir } from 'fs/promises';

const SESSIONS_DIR = join(homedir(), '.crosstalk', 'sessions');

function cursorPath(sessionId: string, channelGuid: string): string {
  return join(SESSIONS_DIR, sessionId, 'cursors', channelGuid);
}

export async function readCursor(sessionId: string, channelGuid: string): Promise<string | null> {
  try {
    const content = await readFile(cursorPath(sessionId, channelGuid), 'utf8');
    return content.trim() || null;
  } catch {
    return null;
  }
}

export async function writeCursor(sessionId: string, channelGuid: string, relPath: string): Promise<void> {
  const p = cursorPath(sessionId, channelGuid);
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, relPath, 'utf8');
}

// Returns all message relative paths in a channel directory, sorted ascending.
export async function listMessages(channelDir: string): Promise<string[]> {
  const paths: string[] = [];
  try {
    const years = await readdir(channelDir);
    for (const year of years.filter(y => /^\d{4}$/.test(y)).sort()) {
      const months = await readdir(join(channelDir, year));
      for (const month of months.filter(m => /^\d{2}$/.test(m)).sort()) {
        const days = await readdir(join(channelDir, year, month));
        for (const day of days.filter(d => /^\d{2}$/.test(d)).sort()) {
          const files = await readdir(join(channelDir, year, month, day));
          for (const file of files.filter(f => f.endsWith('.md')).sort()) {
            paths.push(`${year}/${month}/${day}/${file}`);
          }
        }
      }
    }
  } catch {
    // channel dir may not exist yet
  }
  return paths;
}

// Returns messages after the cursor (exclusive). If cursor is null, returns all.
export function messagesAfterCursor(all: string[], cursor: string | null): string[] {
  if (!cursor) return all;
  const idx = all.indexOf(cursor);
  return idx === -1 ? all : all.slice(idx + 1);
}
