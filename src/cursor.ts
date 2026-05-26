import { join } from 'path';
import { mkdir, readFile, readdir, writeFile } from 'fs/promises';

// Cursor files live inside the transport repo under .cursor/<agent-name>.
// They are git-ignored (operator adds .cursor/ to .gitignore).
// Written only after a successful push — never speculatively.

function cursorPath(transportPath: string, agentName: string): string {
  return join(transportPath, '.cursor', agentName);
}

export async function readCursor(transportPath: string, agentName: string): Promise<string | null> {
  try {
    const content = await readFile(cursorPath(transportPath, agentName), 'utf-8');
    return content.trim() || null;
  } catch {
    return null;
  }
}

export async function writeCursor(transportPath: string, agentName: string, relPath: string): Promise<void> {
  const p = cursorPath(transportPath, agentName);
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, relPath, 'utf-8');
}

export async function listMessages(channelDir: string): Promise<string[]> {
  const paths: string[] = [];
  try {
    const years = (await readdir(channelDir)).filter(y => /^\d{4}$/.test(y)).sort();
    for (const year of years) {
      const months = (await readdir(join(channelDir, year))).filter(m => /^\d{2}$/.test(m)).sort();
      for (const month of months) {
        const days = (await readdir(join(channelDir, year, month))).filter(d => /^\d{2}$/.test(d)).sort();
        for (const day of days) {
          const files = (await readdir(join(channelDir, year, month, day)))
            .filter(f => f.endsWith('.md'))
            .sort();
          for (const file of files) {
            paths.push(`${year}/${month}/${day}/${file}`);
          }
        }
      }
    }
  } catch {
    // channel dir may not exist yet — return empty
  }
  return paths;
}

// Returns relPaths after the cursor (exclusive). If cursor is null, returns all.
export function messagesAfterCursor(all: string[], cursor: string | null): string[] {
  if (!cursor) return all;
  const idx = all.indexOf(cursor);
  return idx === -1 ? all : all.slice(idx + 1);
}
