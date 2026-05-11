# crosstalk-runtime

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

The Crosstalk runtime daemon — Bun/TypeScript source, CI, and binary builds.

**This is the contributor repo.** If you want to run Crosstalk, you want [cordfuse/crosstalk](https://github.com/cordfuse/crosstalk) — the operator-facing repo with framework actors, protocol spec, and setup instructions.

---

## What it does

The runtime is a persistent Bun process — one instance per machine. It:

1. Watches a Crosstalk transport (`channels/`) for new message files via `fs.watch`
2. Reads each message's `to:` field and routes to the matching actor(s)
3. Spawns the actor's CLI (Claude, Gemini, Qwen, OpenCode, or custom), passing the message content
4. Captures stdout, commits the response to the transport under the actor's git identity
5. Advances the channel cursor so the message is never re-dispatched

On startup it scans for messages missed while the daemon was down and catches up before watching for new ones.

---

## Supported agent providers

| Provider | CLI | Model format | Notes |
|----------|-----|-------------|-------|
| Claude | `claude` | `claude-sonnet-4-6` etc. | `--dangerously-skip-permissions --print` |
| Gemini | `gemini` | `gemini-2.5-flash` etc. | Personality baked into prompt — no `--system-prompt` flag |
| Qwen Code | `qwen` | `qwen-plus` etc. | `--system-prompt` supported |
| OpenCode | `opencode` | `ollama/<name>:<tag>` | Local models via Ollama; JSONL output parsed |
| Custom | any | — | `command` + `args` with `{variable}` substitution |

---

## Module map

```
src/
  index.ts       Entry point — boot, wiring, graceful shutdown
  watcher.ts     fs.watch loop — dedup, cursor check, actor targeting
  dispatch.ts    Process lifecycle — spawn, timeout, stdout capture, commit
  registry.ts    Actor definitions — three-layer load, hot-reload
  git.ts         All git I/O — clone, pull, push/rebase/retry, actor identity
  cursor.ts      Read position tracking per channel per session
  config.ts      ~/.crosstalk/config.md loader
  system.ts      MACHINE_ID, SESSION_ID, system announcements
  webhook.ts     GitHub push webhook server (deprecated in v0.4)
  frontmatter.ts YAML frontmatter parser
```

---

## Dispatch flow

```
fs.watch event
  → dedup check (2s window)
  → cursor check (drop if already processed)
  → parse frontmatter → read to: field
  → match actors from registry
  → spawn agent CLI
      → capture stdout
      → commit response to transport (actor git identity)
  → advance cursor
```

Actor timeout: if the process exceeds `heartbeat-interval`, it is killed and a `type: system, reason: timeout` message is posted to `_system/`.

---

## Requirements

- [Bun](https://bun.sh) >= 1.0
- A Crosstalk transport repo cloned locally (see [cordfuse/crosstalk](https://github.com/cordfuse/crosstalk))
- `~/.crosstalk/config.md` pointing at the transport

---

## Dev

```sh
bun install
bun run src/index.ts
```

---

## Current release: v0.3.0

- Multi-provider dispatch (Claude, Gemini, Qwen, OpenCode/Ollama)
- Cursor-based startup catch-up and restart safety
- Per-actor git identity and per-actor transport clones
- Webhook-triggered Git pull (relay-based dispatch planned for v0.4)

See [PLAN.md](PLAN.md) for architecture detail and v0.4 relay design. See [cordfuse/crosstalk WHATSNEW.md](https://github.com/cordfuse/crosstalk/blob/main/WHATSNEW.md) for full changelog.

---

## Versioning

Tagged as `vX.Y.Z`. GitHub Actions builds and publishes releases on tag push.

---

## History

Runtime source lived in `cordfuse/crosstalk` through `v0.3.0` (commit `2cda1c20`). Moved here at the start of `v0.4.0` to separate contributor and operator concerns.
