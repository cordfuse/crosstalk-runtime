import { join } from 'path';
import { mkdir, readFile, readdir, writeFile, access } from 'fs/promises';

// Cursor files: .cursor/<agent-name>/<channel-guid>
// Stored inside the transport repo. Git-ignored via .gitignore entry.
// Written only after a successful push — never speculatively.

function cursorPath(transportPath: string, agentName: string, channelGuid: string): string {
  return join(transportPath, '.cursor', agentName, channelGuid);
}

export async function readCursor(transportPath: string, agentName: string, channelGuid: string): Promise<string | null> {
  try {
    const content = await readFile(cursorPath(transportPath, agentName, channelGuid), 'utf-8');
    return content.trim() || null;
  } catch {
    return null;
  }
}

// Returns true if a cursor file exists for this agent+channel.
export async function cursorExists(transportPath: string, agentName: string, channelGuid: string): Promise<boolean> {
  try {
    await access(cursorPath(transportPath, agentName, channelGuid));
    return true;
  } catch {
    return false;
  }
}

export async function writeCursor(transportPath: string, agentName: string, channelGuid: string, relPath: string): Promise<void> {
  const p = cursorPath(transportPath, agentName, channelGuid);
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
    // channel dir may not exist yet
  }
  return paths;
}

// Returns relPaths after the cursor (exclusive).
// If cursor is null (first time this agent has seen this channel),
// initialize to the current tip so the agent only reads new messages.
export function messagesAfterCursor(all: string[], cursor: string | null): string[] {
  if (!cursor) return [];
  const idx = all.indexOf(cursor);
  return idx === -1 ? all : all.slice(idx + 1);
}

// Returns the current tip (last message), or null if channel is empty.
// Used to initialize the cursor for new agents.
export function currentTip(all: string[]): string | null {
  return all.length > 0 ? all[all.length - 1] : null;
}

// Lists all channel GUIDs found in <transport>/<channelsDir>/
export async function discoverChannels(transportPath: string, channelsDir: string): Promise<string[]> {
  try {
    const dir = join(transportPath, channelsDir);
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
}
