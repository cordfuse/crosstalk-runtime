<!-- parent: librarian -->
# Contributing to crosstalk-runtime

This file is for contributors working on the Crosstalk runtime — humans and AI clients alike. The runtime is a Node/TypeScript daemon that watches a transport for new channel messages and dispatches them to actor processes. The protocol spec, framework actors, and operator-facing docs live in [cordfuse/crosstalk](https://github.com/cordfuse/crosstalk).

**Contributor repo only.** Users who want to run Crosstalk do not clone this repo — they install the published npm package (see "Installing for users" below).

This file is intentionally agent-neutral: it does not auto-load into any specific AI client. The framework and runtime are agent-agnostic, and so is this contributor doc.

---

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Boot dispatch — chooses daemon / `RELAY_MODE=server` / `crosstalk <subcommand>` mode at startup |
| `src/watcher.ts` | `fs.watch` loop — detects new message files, dedup, cursor check, routes to dispatch |
| `src/dispatch.ts` | Spawns actor processes — routes by `agent` field, handles all providers, captures stdout, commits response |
| `src/registry.ts` | Loads actor definitions from three layers, hot-reloads on filesystem change |
| `src/git.ts` | All git operations — per-actor clone, pull, commit, push (rebase-and-retry), actor email identity |
| `src/cursor.ts` | Read position tracking — per channel per session, survives daemon restarts |
| `src/config.ts` | Loads `~/.crosstalk/config.toml` (smol-toml) |
| `src/system.ts` | MACHINE_ID derivation, SESSION_ID, online/offline/timeout announcements |
| `src/relay.ts` | WebSocket relay client (daemon mode) + relay server (`RELAY_MODE=server`) |
| `src/frontmatter.ts` | YAML frontmatter parser (`yaml` package) |
| `src/cli/index.ts` | `commander` subcommand dispatcher — invoked when `crosstalk <subcommand>` is run |
| `src/cli/commands/*.ts` | One file per subcommand (`init`, `post`, `channel`, `channel-join`, `ls`, `actor`, `config`, `version`, `watch`, `roe`) |
| `src/cli/lib/*.ts` | Shared CLI helpers (`actors.ts`, `channel.ts`, `governance.ts`) |
| `package.json` | Version-of-record (semver). The historical `VERSION` file from the bun-compile era was deleted in v0.7.0-alpha.1. |

---

## Module Architecture

```
index.ts
  ├── (no args)               → daemon mode
  │   ├── config.ts             load ~/.crosstalk/config.toml
  │   ├── registry.ts           load actors from three layers; hot-reload on change
  │   ├── system.ts             MACHINE_ID (sha256(hostname)[:16]), SESSION_ID (per-boot UUID), announcements
  │   ├── relay.ts              outbound WebSocket client → relay.crosstalk.sh
  │   ├── watcher.ts            fs.watch on transport/channels/; dedup; cursor check; route to dispatch
  │   │     └── dispatch.ts       spawn actor process; capture stdout; commit response to transport
  │   │           └── git.ts        per-actor clone; pull; push/rebase/retry; actor git identity
  │   └── cursor.ts             read/write ~/.crosstalk/sessions/<MACHINE_ID>/cursors/<channel-guid>
  │
  ├── RELAY_MODE=server       → relay-server mode
  │   └── relay.ts              accept GitHub webhooks; broadcast {repo, event, sha} over WebSocket
  │
  └── crosstalk <sub> ...     → CLI mode
      └── cli/index.ts          commander dispatcher
          └── cli/commands/<sub>.ts
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

`~/.crosstalk/config.toml` (TOML, parsed by `smol-toml`):

```toml
transport = "/path/to/transport-repo"
actor-email-suffix = "your-domain.example"
default-heartbeat-interval = 120        # fallback if actor omits heartbeat-interval; default 30s
default-human-actor = "alice"           # optional — used by `crosstalk post` / `channel join` when --as omitted

[relay]
mode = "client"                         # "client" (daemon mode) | "server" (RELAY_MODE=server overrides this)
url = "wss://relay.crosstalk.sh"        # Cordfuse-operated public relay (open mode, no auth required)
# secret = "<relay-secret>"             # Optional — only set when self-hosting an authenticated relay

# Operator-extensible agent registry — extends or overrides the built-in agents map
# used by `crosstalk channel join`. Operator entries win on collision with built-ins.
[agents.my-bot]
spawn = ["python3", "/path/to/my-bot.py", "--interactive"]
```

The legacy `~/.crosstalk/config.md` (YAML) is no longer read. `webhook-port` / `webhook-secret` are removed — direct webhook listening was replaced by the relay model in v0.4.0.

**Local development against the in-repo relay server.** The relay server runs from this same source via `RELAY_MODE=server`. For dev, point a local daemon at a locally-running relay container — use `ws://localhost:3003` for the fastest iteration, or `wss://<your-internal-hostname>` if you have a TLS-terminating reverse proxy in front of the container.

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

## Installing for users

Crosstalk's runtime ships as a Node npm package starting with `v0.6.0-alpha.4`. There is no longer a `bun --compile` single-file binary — the embedding of native PTY modules into a bun-compiled binary was a fight not worth picking when every Crosstalk user already has Node installed (`claude`, `gemini`, `qwen`, `opencode` are all Node CLIs themselves).

Install globally from the GitHub release tarball while the npm scope `@cordfuse` is pending administrative correction:

```sh
npm install -g https://github.com/cordfuse/crosstalk-runtime/releases/download/v0.6.0-alpha.4/crosstalk-runtime-0.6.0-alpha.4.tgz
```

The tarball ships pre-built `dist/` (compiled in CI before `npm pack`), so `npm install` doesn't have to run `tsc` on the user's machine. `@homebridge/node-pty-prebuilt-multiarch`'s install script does build its native PTY module locally for the user's platform.

**Why not `npm install -g cordfuse/crosstalk-runtime#tag` (git URL form)?** npm runs the package's `prepare` lifecycle on git-URL installs BEFORE installing devDependencies in the temp clone — so `tsc` isn't on PATH when prepare fires and the build fails. Stick to the tarball URL; it Just Works.

Once the npm `@cordfuse` scope is live, the install instruction flips to:

```sh
npm install -g @cordfuse/crosstalk-runtime
```

Either way, the user ends up with `crosstalk` and `ct` on PATH.

**Requirements:**
- Node `>=18` (LTS line). v18 covers fetch, AbortController, modern fs.promises.
- For source-build fallback of node-pty on platforms without a prebuild (e.g. macOS): Xcode Command Line Tools (`xcode-select --install`) on Mac; build-essential + python on Linux. Most dev users have these.

---

## Dev

For local development on the runtime source:

```sh
npm install                         # runs `prepare` → tsc → dist/, builds native PTY module
node dist/index.js version          # smoke-test the binary

# Or watch-mode for live source iteration (Node 22+, --watch + --experimental-strip-types):
npm run dev
```

`npm install` runs the install scripts that compile `@homebridge/node-pty-prebuilt-multiarch`'s native module from source on macOS (and platforms without a prebuild). On Mac this needs Xcode CLI tools (`xcode-select --install`); on Alpine/Linux the Dockerfile installs `python3 make g++` for the build.

Bun-flavored dev still works if a contributor prefers it (`bun --watch run src/index.ts`), but bun is not a project prerequisite — the source is pure node and the canonical runtime everywhere is node.

---

## Versioning

- Version in `package.json` (semver)
- Tags: `vX.Y.Z` — triggers the GitHub Actions release workflow (publish/release entry)
- No tag prefix in this repo (runtime was `runtime/vX.Y.Z` in the old monorepo; standalone repo uses plain tags)

---

## Development Rules

- **Protocol spec lives in `cordfuse/crosstalk`** — if it's a protocol question, it goes there
- **WHATSNEW.md lives in `cordfuse/crosstalk`** — runtime changes are documented there, not here
- **No personal information** — no names, machine hostnames, emails, or account details in committed files
- **One commit per fix or feature** — never batch unrelated changes
- **No Python** — TypeScript only. Source is pure node — no Bun-specific APIs anywhere, including the relay server (which uses `node:http` + `ws`, not `Bun.serve`).
