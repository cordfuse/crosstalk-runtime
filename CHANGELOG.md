# Changelog

All notable changes to `@cordfuse/crosstalk-runtime`.

## v2.4.0 — 2026-05-31

**v3 coordinator runtime** — host-file mode now uses a single job-queue coordinator instead of N per-agent polling loops:

- `JobQueue` class: per-actor pending + in-flight tracking; `drain()` returns up to `totalCount` concurrent jobs; `complete()` decrements on finish
- `dispatchSingle()`: processes one message without outer loop or hash-based instance selection — queue guarantees exactly-once delivery
- Coordinator loop: pulls git once per cycle, scans all channels × actors, enqueues unread messages, dispatches concurrently up to each actor's tier sum, awaits all in-flight jobs before sleeping
- Workers are ephemeral — spawned per message, not long-running pollers
- Legacy `agents:` list mode still runs the v2 per-agent `setInterval` path (backward-compatible)
- Version banner distinguishes `[v3]` vs `[v2 legacy]`

## v2.3.0 — 2026-05-31

**Interactive `crosstalk init`** — init now scaffolds a host file instead of generating a legacy `agents:` config:

- Prompts for host alias (default: `os.hostname()`), actor name (default: `concierge`), and CLI command (default: `claude --print`)
- Creates `manifest/hosts/<alias>.md` with the declared actor and tier, commits it to the transport, and pushes
- Writes a thin local config (`transport:` + `host:`) instead of the old `agents:` array
- Closes the onboarding gap where operators had to create host files manually after init

## v2.2.0 — 2026-05-29

**Host file support** — the runtime now reads actor configuration from `manifest/hosts/<alias>.md` in the transport instead of requiring an `agents:` list in the local config:

- Host file reader: scans `manifest/hosts/`, parses `alias`/`hostname`/`actors` frontmatter
- Auto-detection: matches `os.hostname()` against `hostname:` fields; explicit `host:` in local config overrides
- Tier expansion: each tier × `count` becomes one polling worker. Shorthand (bare CLI string) = `count: 1`
- `actor@host` addressing: runtime skips messages targeted at a different host alias
- Git commit email now includes host alias: `actor@hostalias.crosstalk.local`
- Startup failure mode: if no host file is found, logs clearly and idles without crashing
- Legacy `agents:` array in config.yaml still works for single-machine setups and flag mode

Protocol: [cordfuse/crosstalk v2.2.0](https://github.com/cordfuse/crosstalk/releases/tag/v2.2.0)

## v2.1.2 — 2026-05-29

Docs-only patch. Added instance groups section to README.

## v2.1.1 — 2026-05-29

Instance groups: shared-name dispatch via `sha256(message_path) mod group_size`. Replaced pool routing.

## v2.1.0 — 2026-05-29

Pool routing (deprecated — replaced by v2.1.1 before any operator adopted it).

## v2.0.9 — 2026-05-28

Bug fixes: persona alias in git identity, CLI arg quoting, stderr capture, empty reply warning.
