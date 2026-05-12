<!-- parent: librarian -->
# Contributing to crosstalk-runtime

This file is for contributors working on the Crosstalk runtime — humans and AI clients alike. The runtime is the Bun/TypeScript daemon that watches a transport for new channel messages and dispatches them to actor processes. The protocol spec, framework actors, and operator-facing docs live in [cordfuse/crosstalk](https://github.com/cordfuse/crosstalk).

**Contributor repo only.** Users who want to run Crosstalk do not clone this repo — they install the released binary or `bunx @crosstalk/runtime`.

This file is intentionally agent-neutral: it does not auto-load into any specific AI client. The framework and runtime are agent-agnostic, and so is this contributor doc.

---

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point — loads config, registry, starts watcher, webhook server, startup scan |
| `src/watcher.ts` | `fs.watch` loop — detects new message files, dedup, cursor check, routes to dispatch |
| `src/dispatch.ts` | Spawns actor processes — routes by `agent` field, handles all providers, captures stdout, commits response |
| `src/registry.ts` | Loads actor definitions from three layers, hot-reloads on filesystem change |
| `src/git.ts` | All git operations — per-actor clone, pull, commit, push, actor email identity |
| `src/cursor.ts` | Read position tracking — per channel per session, survives daemon restarts |
| `src/config.ts` | Loads `~/.crosstalk/config.md` |
| `src/system.ts` | MACHINE_ID derivation, SESSION_ID, online/offline/timeout announcements |
| `src/frontmatter.ts` | YAML frontmatter parser |
| `src/webhook.ts` | HTTP server for GitHub push webhook — triggers `pullTransport` on push event |
| `VERSION` | Current runtime version (semver, single line) |

---

## Module Architecture

```
index.ts
  ├── config.ts        load ~/.crosstalk/config.md
  ├── registry.ts      load actors from three layers; hot-reload on change
  ├── system.ts        MACHINE_ID (sha256(hostname)[:16]), SESSION_ID (per-boot UUID), announcements
  ├── watcher.ts       fs.watch on transport/channels/; dedup; cursor check; route to dispatch
  │     └── dispatch.ts  spawn actor process; capture stdout; commit response to transport
  │           └── git.ts   per-actor clone; pull; push/rebase/retry; actor git identity
  ├── webhook.ts       GitHub push webhook → pullTransport()
  └── cursor.ts        read/write ~/.crosstalk/sessions/<MACHINE_ID>/cursors/<channel-guid>
```

---

## Native Invocation Contracts

Each `agent` value maps to a specific spawner in `dispatch.ts`. Exact CLI contracts:

- **`agent: claude`**
  `claude --print --dangerously-skip-permissions --model <model> --no-session-persistence --system-prompt <personality> <prompt>`

- **`agent: gemini`**
  `gemini -m <model> -p "<personality>\n\n---\n\n<prompt>" -y --output-format text`
  No `--system-prompt` flag in Gemini CLI. Personality baked into prompt body, separated from the message by `---`.

- **`agent: qwen`**
  `qwen <prompt> --system-prompt <personality> --model <model> -y --output-format text --no-chat-recording`

- **`agent: opencode`**
  `opencode run "<personality>\n\n---\n\n<prompt>" -m <model> --dangerously-skip-permissions --format json`
  Output is JSONL. Extract all `{"type":"text","part":{"type":"text","text":"..."}}` events and concatenate. Model format: `ollama/<name>:<tag>` for local models via Ollama.

- **No `agent` field + `command` set** → custom dispatch:
  `<command> <args...>` with `{variable}` substitution. Available variables: `transport_root`, `channel`, `message_path`, `session_id`, `actor_name`.

---

## Config Reference

`~/.crosstalk/config.md`:
```yaml
---
transport: ~/path/to/transport-repo
webhook-port: 3456         # optional — enables GitHub push webhook (deprecated in v0.4)
webhook-secret: <secret>   # required if webhook-port is set
default-heartbeat-interval: 120   # fallback timeout if actor omits heartbeat-interval; default 30s
---
```

v0.4 will add:
```yaml
relay-url: wss://relay.crosstalk.sh    # relay WebSocket endpoint (public, Cordfuse-operated)
relay-secret: <secret>                 # HMAC auth between relay and runtime
```

**Local development on steve-cachyos.** The relay server runs as a container on `proxy_net`, listening on **port 3003**, reverse-proxied by Caddy at `https://crosstalk-relay.linux.internal`. Two equivalent ways to point a local runtime at it:

```yaml
# Through Caddy (TLS internal — requires trusted local CA, AdGuard DNS resolves the hostname):
relay-url: wss://crosstalk-relay.linux.internal

# Direct to container host port (plain ws, no CA setup — fastest for iteration):
relay-url: ws://localhost:3003
```

---

## Actor Registry Format

Three layers loaded in order — last definition wins on name collision:

1. `<transport>/manifest/framework/actors/` — framework-shipped actors
2. `<transport>/manifest/custom/actors/` — operator actors
3. `~/.crosstalk/actors/` — machine-local actors

Runtime-owned frontmatter fields:

```yaml
---
agent: claude         # claude | gemini | qwen | opencode | (omit for custom command)
model: claude-sonnet-4-6
heartbeat-interval: 120          # seconds; default 30
git-email: actor@example.com     # optional; default: <name>@<actor-email-suffix>
command: /path/to/script         # custom dispatch only
args: ['{message_path}']         # custom dispatch only
---
```

Fields prefixed `x-` are operator-owned and ignored by the runtime entirely.

---

## Dev

```sh
bun install
bun run src/index.ts
```

---

## Versioning

- Version string in `VERSION` (semver, single line)
- Tags: `vX.Y.Z` — triggers the GitHub Actions release workflow
- No tag prefix in this repo (runtime was `runtime/vX.Y.Z` in the old monorepo; standalone repo uses plain tags)

---

## Development Rules

- **Protocol spec lives in `cordfuse/crosstalk`** — if it's a protocol question, it goes there
- **WHATSNEW.md lives in `cordfuse/crosstalk`** — runtime changes are documented there, not here
- **No personal information** — no names, machine hostnames, emails, or account details in committed files
- **One commit per fix or feature** — never batch unrelated changes
- **No Python** — TypeScript/Bun only
