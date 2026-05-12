import { watch, mkdirSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { parseFrontmatter } from './frontmatter.js';
import { dispatch, isDuplicate } from './dispatch.js';
import { readCursor } from './cursor.js';
import type { Registry } from './registry.js';

// Matches: YYYY/MM/DD/HHMMSSsssZ.md
const MESSAGE_RE = /^\d{4}\/\d{2}\/\d{2}\/\d{9}Z\.md$/;

export function startWatcher(
  transportRoot: string,
  getRegistry: () => Registry,
  actorEmailSuffix: string,
  sessionId: string,
  defaultHeartbeatInterval?: number,
): void {
  const channelsDir = join(transportRoot, 'channels');

  // First-time setup: transport may exist with no channels/ yet. Without this,
  // watch() throws ENOENT and crashes the daemon before the first message lands.
  mkdirSync(channelsDir, { recursive: true });

  console.log(`[watcher] watching ${channelsDir}`);

  watch(channelsDir, { recursive: true }, async (event, filename) => {
    if (!filename || !filename.endsWith('.md')) return;

    // Expected shape: <guid>/YYYY/MM/DD/HHMMSSsssZ.md  (5 segments)
    const parts = filename.split('/');
    if (parts.length !== 5) return;

    const [guid, year, month, day, file] = parts;
    const relPath = `${year}/${month}/${day}/${file}`;

    if (!MESSAGE_RE.test(relPath)) return;

    const dedupKey = `${guid}/${relPath}`;
    if (isDuplicate(dedupKey)) return;

    // Skip messages at or before the cursor — git rebase during push-retry can
    // rewrite existing working-tree files and re-fire inotify events for them
    const cursor = await readCursor(sessionId, guid);
    if (cursor && relPath <= cursor) return;

    const fullPath = join(channelsDir, filename);

    let content: string;
    try {
      content = await readFile(fullPath, 'utf-8');
    } catch {
      return;
    }

    const { data } = parseFrontmatter(content);
    const from = String(data.from ?? '');
    const to = String(data.to ?? '');

    const registry = getRegistry();

    if (registry.has(from)) {
      console.log(`[watcher] skip (own) ${relPath}`);
      return;
    }

    const targets = to === 'all'
      ? [...registry.values()]
      : to.split(',')
          .map(t => t.trim())
          .filter(t => registry.has(t))
          .map(t => registry.get(t)!);

    if (targets.length === 0) return;

    for (const actor of targets) {
      await dispatch(actor, transportRoot, guid, relPath, actorEmailSuffix, sessionId, defaultHeartbeatInterval);
    }
  });
}
