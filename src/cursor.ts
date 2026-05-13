import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { mkdir, readFile, readdir, writeFile, stat } from 'fs/promises';

const SESSIONS_DIR = join(homedir(), '.crosstalk', 'sessions');

function cursorPath(sessionId: string, channelGuid: string): string {
  return join(SESSIONS_DIR, sessionId, 'cursors', channelGuid);
}

/** Migrate cursors from legacy session directories into the current
 * `machineId` directory on first run.
 *
 * Background: the daemon historically keyed cursor files under a per-boot
 * SESSION_ID (UUID). At some point the key switched to MACHINE_ID
 * (`sha256(hostname).slice(0,16)`) for cursor persistence across restarts.
 * Operators upgrading past that change find their MACHINE_ID directory
 * empty and the daemon re-dispatches every channel's full history on
 * first run — a real bug surfaced in v0.7.0-alpha.2 UAT on cachy where
 * an unrelated demo channel re-dispatched 51 messages before being killed.
 *
 * This migration runs once per machineId. If the machineId cursor dir
 * already has cursors (steady-state operation), it's a no-op. If empty
 * (first run after upgrade, OR genuinely fresh install with no prior
 * sessions), it walks every other session directory and copies forward
 * the lexicographically-max cursor value per channel-guid — which equals
 * the chronologically-latest cursor since the relPath format is
 * `YYYY/MM/DD/HHMMSSsssZ[-uuid].md`.
 *
 * Genuinely fresh installs (no prior sessions at all) see no migration —
 * the function silently finds nothing to copy. So this is safe to invoke
 * unconditionally at daemon startup.
 */
export async function migrateCursorsIfNeeded(machineId: string): Promise<void> {
  const targetCursorsDir = join(SESSIONS_DIR, machineId, 'cursors');

  // Already have cursors in the machineId dir → migration already happened (or
  // operator already running steady-state). Skip.
  if (existsSync(targetCursorsDir)) {
    let existing: string[] = [];
    try { existing = await readdir(targetCursorsDir); } catch { /* keep empty */ }
    if (existing.length > 0) return;
  }

  // SESSIONS_DIR may not exist yet on a truly fresh install
  if (!existsSync(SESSIONS_DIR)) return;

  let sessionDirs: string[] = [];
  try { sessionDirs = await readdir(SESSIONS_DIR); } catch { return; }

  // Build channelGuid → max-cursor-value across all non-machineId session dirs
  const maxCursorByChannel = new Map<string, string>();

  for (const sid of sessionDirs) {
    if (sid === machineId) continue;  // skip our own dir
    const sourceCursorsDir = join(SESSIONS_DIR, sid, 'cursors');
    let entries: string[] = [];
    try {
      const st = await stat(sourceCursorsDir);
      if (!st.isDirectory()) continue;
      entries = await readdir(sourceCursorsDir);
    } catch { continue; }

    for (const channelGuid of entries) {
      let value: string;
      try {
        value = (await readFile(join(sourceCursorsDir, channelGuid), 'utf8')).trim();
      } catch { continue; }
      if (!value) continue;
      const existing = maxCursorByChannel.get(channelGuid);
      if (!existing || value > existing) {
        maxCursorByChannel.set(channelGuid, value);
      }
    }
  }

  if (maxCursorByChannel.size === 0) return;

  // Write the migrated cursors
  await mkdir(targetCursorsDir, { recursive: true });
  for (const [channelGuid, value] of maxCursorByChannel) {
    await writeFile(join(targetCursorsDir, channelGuid), value);
  }

  console.log(`[cursor] migrated ${maxCursorByChannel.size} cursor(s) from legacy session dirs to machineId=${machineId} on first run`);
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
