/**
 * Message-filename construction + the regex shape that reads them back.
 *
 * Filename format (v0.7.x+, per `cordfuse/crosstalk/PLAN.md` message-files
 * section): `HHMMSSsssZ-<hex8>.md` where:
 *   - HHMMSSsss is the millisecond-precision UTC time prefix (positions 0–8)
 *   - <hex8> is the first 8 chars of a fresh `randomUUID()` per message
 *   - the date is encoded in the folder path (channels/<guid>/YYYY/MM/DD/),
 *     not the filename — no redundancy
 *
 * The tag is opaque to readers — it carries no semantic meaning. It exists
 * solely to eliminate filename collisions when two writers hit the same
 * millisecond in the same channel. 32 bits of CSPRNG entropy → birthday-
 * paradox 50% collision at ~77k messages in the same millisecond, well
 * past any realistic deployment.
 *
 * Backwards compatibility: pre-v0.7.x files (`HHMMSSsssZ.md`, no tag)
 * remain valid. The {@link MESSAGE_FILE_RE} regex accepts both forms.
 * ISO-timestamp reconstruction from filename is unaffected — the time
 * prefix stays at position 0–8 in both forms, so existing `f.slice(0, 9)`
 * call sites continue to work without change.
 */
import { randomUUID } from 'node:crypto';

/**
 * Build the per-message filename for a given timestamp.
 *
 * The 8-char tag is a fresh UUIDv4 prefix per call — DO NOT cache or reuse.
 * Two calls with the same timestamp produce different filenames; that's the
 * collision-resistance property.
 */
export function messageFilename(timestamp: Date): string {
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  const hh = p(timestamp.getUTCHours());
  const mm = p(timestamp.getUTCMinutes());
  const ss = p(timestamp.getUTCSeconds());
  const ms = p(timestamp.getUTCMilliseconds(), 3);
  const tag = randomUUID().slice(0, 8);
  return `${hh}${mm}${ss}${ms}Z-${tag}.md`;
}

/**
 * Build the date-folder path for a given timestamp: `YYYY/MM/DD`.
 *
 * Co-located with {@link messageFilename} since the two are always used
 * together when constructing a message file path. Pulling both into one
 * module also gives us one place to evolve the filesystem layout in
 * future protocol versions.
 */
export function messageDatePath(timestamp: Date): string {
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  const yyyy = timestamp.getUTCFullYear();
  const mm = p(timestamp.getUTCMonth() + 1);
  const dd = p(timestamp.getUTCDate());
  return `${yyyy}/${mm}/${dd}`;
}

/**
 * Regex accepting both legacy (`HHMMSSsssZ.md`) and tagged
 * (`HHMMSSsssZ-<hex8>.md`) message filename forms.
 *
 * Use this as the canonical reader regex everywhere a message filename
 * is matched. The optional `(-[a-f0-9]{8})?` group makes the tag
 * non-mandatory so pre-v0.7.x transports continue to parse.
 */
export const MESSAGE_FILE_RE = /^\d{9}Z(-[a-f0-9]{8})?\.md$/;

/**
 * Regex for the full nested message path: `YYYY/MM/DD/<filename>`.
 *
 * Used by watcher hot path on fs.watch events where the path-from-channel-root
 * needs to be validated end-to-end (date folders + filename).
 */
export const MESSAGE_PATH_RE = /^\d{4}\/\d{2}\/\d{2}\/\d{9}Z(-[a-f0-9]{8})?\.md$/;
