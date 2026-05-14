/**
 * Protocol version handshake (v0.9.0-alpha.3+).
 *
 * Crosstalk has two version concepts on the transport side:
 *
 *   - `VERSION`            — framework spec version (markdown bundle)
 *   - `CROSSTALK-VERSION`  — protocol wire-format version
 *
 * They are decoupled by design: the framework markdown can iterate
 * (clarifications, new templates, doc improvements) without bumping the
 * wire-format. The wire-format only bumps when message types, frontmatter
 * fields, or filename conventions change in a way that affects how
 * runtimes parse messages.
 *
 * This module owns the runtime side of the handshake:
 *
 *   1. The runtime declares which protocol versions it supports via
 *      {@link SUPPORTS_PROTOCOL_MAJOR_MINOR}. Currently a single
 *      "MAJOR.MINOR" string — every patch under that minor is supported,
 *      newer minors warn, different majors error.
 *
 *   2. {@link validateTransportProtocol} reads the transport's
 *      `CROSSTALK-VERSION`, compares against the runtime's support, and
 *      returns a {@link Verdict} the daemon startup path acts on.
 *
 * Closes the v1.0 ROADMAP "Protocol versioning fully wired" item AND the
 * aspirational CROSSTALK.md step 2 ("Check protocol version against latest
 * release tag — notify human if a newer version exists").
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Major.minor of the protocol versions this runtime supports. Patch
 * differences within a minor are silently tolerated.
 *
 * Bump policy:
 * - PATCH bump on transport (e.g. 0.3.0 → 0.3.1) → silent
 * - MINOR bump on transport (e.g. 0.3.0 → 0.4.0) → WARN, runtime keeps starting
 * - MAJOR bump on transport (e.g. 0.3.0 → 1.0.0) → ERROR, runtime refuses to start
 *
 * Runtime-side bumps to this constant happen when the runtime adds support
 * for a new protocol minor/major (e.g. shipping new message-type handlers).
 *
 * Currently "0.3" — matches the existing CROSSTALK-VERSION on
 * cordfuse/crosstalk-demo and the framework template (added in
 * v0.9.0-alpha.3). Future bump candidate: "0.4" once the v0.7 governance
 * additions (roe-amendment, vote, second, deadlock-resolution) and v0.8
 * privacy additions (encryption: age, encrypted-to:, type: ephemeral et al)
 * get a deliberate protocol-version review pass.
 */
export const SUPPORTS_PROTOCOL_MAJOR_MINOR = '0.3';

export type VerdictKind =
  | 'match'              // transport version matches runtime support — silent
  | 'patch-mismatch'     // same major.minor, different patch — silent (allowed by semver)
  | 'minor-mismatch'     // same major, different minor — WARN
  | 'major-mismatch'     // different major — ERROR, refuse to start
  | 'transport-missing'  // no CROSSTALK-VERSION file — lenient WARN (legacy transport)
  | 'transport-malformed'; // file exists but not parseable — strict WARN

export interface Verdict {
  kind:        VerdictKind;
  transport:   string | null;  // raw value read from transport, or null
  supports:    string;         // runtime's SUPPORTS_PROTOCOL_MAJOR_MINOR
  shouldStart: boolean;        // false only on major-mismatch
  message:     string;         // human-readable verdict line for logging
}

/** Parse "MAJOR.MINOR.PATCH" or "MAJOR.MINOR" into [major, minor]. Returns
 * null if the string doesn't match the expected shape. Tolerant of leading
 * 'v' (e.g. "v0.3.0"). */
function parseMajorMinor(s: string): [number, number] | null {
  const cleaned = s.trim().replace(/^v/, '');
  const m = cleaned.match(/^(\d+)\.(\d+)(?:\.\d+)?(?:[-+].*)?$/);
  if (!m) return null;
  return [parseInt(m[1]!, 10), parseInt(m[2]!, 10)];
}

/** Read CROSSTALK-VERSION from the transport and decide whether daemon
 * startup should continue.
 *
 * Read order:
 *   1. `<transport>/CROSSTALK-VERSION` (canonical location, matches the
 *      pre-existing convention used by system.ts and the version command)
 *
 * No exceptions thrown — all error paths produce a {@link Verdict} the
 * caller can act on. */
export function validateTransportProtocol(transportRoot: string): Verdict {
  const path = join(transportRoot, 'CROSSTALK-VERSION');

  if (!existsSync(path)) {
    return {
      kind: 'transport-missing',
      transport: null,
      supports: SUPPORTS_PROTOCOL_MAJOR_MINOR,
      shouldStart: true,
      message: `transport has no CROSSTALK-VERSION file (legacy transport — recommend creating one with content "${SUPPORTS_PROTOCOL_MAJOR_MINOR}.0\\n" so future runtime version checks can verify compatibility)`,
    };
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8').trim();
  } catch {
    return {
      kind: 'transport-malformed',
      transport: null,
      supports: SUPPORTS_PROTOCOL_MAJOR_MINOR,
      shouldStart: true,
      message: `transport's CROSSTALK-VERSION exists but couldn't be read — proceeding with no version check`,
    };
  }

  const transportPair = parseMajorMinor(raw);
  if (!transportPair) {
    return {
      kind: 'transport-malformed',
      transport: raw,
      supports: SUPPORTS_PROTOCOL_MAJOR_MINOR,
      shouldStart: true,
      message: `transport's CROSSTALK-VERSION value "${raw}" doesn't parse as semver MAJOR.MINOR(.PATCH) — proceeding with no version check`,
    };
  }

  const supportsPair = parseMajorMinor(SUPPORTS_PROTOCOL_MAJOR_MINOR);
  if (!supportsPair) {
    // Should never happen — SUPPORTS_PROTOCOL_MAJOR_MINOR is hardcoded in
    // this module. If it does, fail loud so a future engineer notices.
    return {
      kind: 'transport-malformed',
      transport: raw,
      supports: SUPPORTS_PROTOCOL_MAJOR_MINOR,
      shouldStart: true,
      message: `runtime's SUPPORTS_PROTOCOL_MAJOR_MINOR ("${SUPPORTS_PROTOCOL_MAJOR_MINOR}") is itself malformed — bug in protocol-version.ts`,
    };
  }

  const [tMajor, tMinor] = transportPair;
  const [sMajor, sMinor] = supportsPair;

  if (tMajor !== sMajor) {
    return {
      kind: 'major-mismatch',
      transport: raw,
      supports: SUPPORTS_PROTOCOL_MAJOR_MINOR,
      shouldStart: false,
      message: `protocol MAJOR mismatch — transport declares ${raw}, runtime supports ${SUPPORTS_PROTOCOL_MAJOR_MINOR}.x. Wire format is incompatible; refusing to start. Upgrade or downgrade the runtime to a version supporting protocol ${tMajor}.x`,
    };
  }

  if (tMinor !== sMinor) {
    const direction = tMinor > sMinor ? 'newer' : 'older';
    return {
      kind: 'minor-mismatch',
      transport: raw,
      supports: SUPPORTS_PROTOCOL_MAJOR_MINOR,
      shouldStart: true,
      message: `protocol MINOR mismatch — transport declares ${raw} (${direction} than runtime's supported ${SUPPORTS_PROTOCOL_MAJOR_MINOR}.x). Backward-compatible per semver, but transport features outside the runtime's known minor may not work as expected`,
    };
  }

  // Same major.minor — patch-level differences are fine
  return {
    kind: raw === `${SUPPORTS_PROTOCOL_MAJOR_MINOR}.0` ? 'match' : 'patch-mismatch',
    transport: raw,
    supports: SUPPORTS_PROTOCOL_MAJOR_MINOR,
    shouldStart: true,
    message: `protocol ${raw} (runtime supports ${SUPPORTS_PROTOCOL_MAJOR_MINOR}.x)`,
  };
}
