# crosstalk-runtime

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

The Crosstalk runtime — Node.js / TypeScript source, CI, and npm-package release artifacts.

**This is the contributor repo.** If you want to run Crosstalk, you want [cordfuse/crosstalk](https://github.com/cordfuse/crosstalk) — the operator-facing repo with framework actors, protocol spec, and setup instructions.

---

## What it does

The runtime is a Node.js process that ships in three modes, all compiled from the same source:

| Mode | How invoked | What it does |
|------|-------------|--------------|
| **Daemon** | `crosstalk` (no args) | Watches a transport (`channels/`) for new message files via `fs.watch`, reads each `to:` field, dispatches to the matching local actor(s), captures their stdout, commits the response under the actor's git identity, advances the cursor. One instance per machine. |
| **Relay server** | `RELAY_MODE=server crosstalk` | Stateless WebSocket fan-out: accepts GitHub push webhooks, broadcasts a minimal `{repo, event, sha}` notification to every connected runtime daemon. Carries no message content. Cordfuse operates a public instance at `relay.crosstalk.sh`; self-hostable for private deployments. |
| **Interactive client** | `crosstalk channel join <name> --agent <name>` | PTY-wraps the operator's preferred AI agent CLI (Claude Code, Gemini, Antigravity, Qwen, OpenCode, Codex, custom). New channel messages addressed to the joining human (or to `all`) get injected into the agent's context in real time as `[crosstalk inbound]` blocks. |

Plus the operator CLI surface: `init`, `post`, `channel new/list/show/tail/join`, `actor list/validate`, `roe audit/validate`, `ls`, `config show`, `version`, `watch start/stop/status/logs`.

---

## Supported agent providers

| Provider | CLI binary | Native flags | Model format |
|----------|-----------|--------------|--------------|
| Claude | `claude` | `--print --dangerously-skip-permissions --model <m> --system-prompt <p> --no-session-persistence` | `claude-sonnet-4-6`, etc. |
| Gemini | `gemini` | `-m <model> -y --output-format text` | `gemini-2.5-flash`, etc. Personality baked into prompt body (no `--system-prompt` flag in Gemini CLI). Headless `-p` works on either an authenticated Google account (`gemini` login completed once on this machine) or a `GEMINI_API_KEY` in env. **⚠ The OAuth/Google-One unpaid tier sunsets 2026-06-18** — paid `GEMINI_API_KEY`/Vertex operators are unaffected, but operators on free Google login should migrate to the `antigravity` agent below before that date. Existing actor configs continue to dispatch via `gemini` for both auth modes until the cutover. |
| Antigravity | `agy` | `--print "<personality>\n\n---\n\n<prompt>" --dangerously-skip-permissions` | Google's official Gemini CLI successor ([repo](https://github.com/google-antigravity/antigravity-cli)). Built in Go; shared agent engine with the Antigravity 2.0 desktop app. **Native dispatch landed in v1.14.0** — `agent: antigravity` is a supported actor type with the same canonicalization, pool, and quorum semantics as every other built-in. Model is backend-selected per the user's Google account configuration (no `-m <model>` flag on the CLI). Auth is Google Sign-In stored in the system keyring on first interactive `agy` run; the daemon inherits the operator's env and reaches the keyring on spawned children. Personality folds into the prompt body (no `--system-prompt` flag), same shape as gemini and opencode. |
| Qwen Code | `qwen` | `--system-prompt <p> --model <m> -y --output-format text --no-chat-recording` | `qwen-plus`, etc. |
| OpenCode | `opencode` | `run "<p>" -m <model> --dangerously-skip-permissions --format json` | `ollama/<name>:<tag>` for local models via Ollama. JSONL output parsed. |
| Custom (`command` set, no `agent`) | any binary | `command` + `args` array with `{variable}` substitution | — |

**Operator-extensible.** Operators can register additional agents (or override the built-in invocation) for `crosstalk channel join` via `[agents.X]` tables in `~/.crosstalk/config.toml`:

```toml
[agents.my-bot]
spawn = ["python3", "/path/to/my-bot.py", "--interactive"]

[agents.claude]
spawn = ["claude", "--dangerously-skip-permissions"]   # override built-in
```

Operator entries win over built-ins on collision.

---

## Module map

```
src/
  index.ts             Boot dispatch — daemon / server / CLI mode selection + graceful shutdown
  config.ts            ~/.crosstalk/config.toml loader (smol-toml)
  registry.ts          Three-layer actor loader; hot-reload via fs.watch on ~/.crosstalk/actors/
  watcher.ts           fs.watch loop — dedup window, cursor check, actor targeting
  dispatch.ts          Process lifecycle — spawn, timeout, stdout capture, commit
  git.ts               All git I/O — per-actor clone, push/rebase/retry, actor identity
  cursor.ts            Per-channel cursor tracking; survives daemon restarts
  system.ts            MACHINE_ID derivation, SESSION_ID, online/offline/timeout announcements
  relay.ts             WebSocket relay client (daemon mode) + relay server (RELAY_MODE=server)
  frontmatter.ts       YAML frontmatter parser (yaml package)

  cli/
    index.ts           Subcommand dispatcher (commander)
    commands/
      init.ts          crosstalk init — interactive setup wizard
      post.ts          crosstalk post — message composition + git commit/push
      channel.ts       crosstalk channel new/list/show/tail
      channel-join.ts  crosstalk channel join — PTY-wrapped agent session + live injection
      ls.ts            crosstalk ls — channel list shortcut
      actor.ts         crosstalk actor list/validate
      config.ts        crosstalk config show
      version.ts       crosstalk version
      watch.ts         crosstalk watch start/stop/status/logs
      roe.ts           crosstalk roe audit/validate (governance enforcement)
    lib/
      actors.ts        Per-layer actor scanning, cycle-checking parent chains
      channel.ts       Channel listing, GUID resolution, message reading
      governance.ts    Governance message types + validation per AMENDMENT.md
```

---

## What's supported today

| Capability | Status |
|---|---|
| One operator, N machines | ✓ Supported — one operator runs daemons across as many machines as they like |
| Multiple operators on one transport | ✓ Supported (v1.15+) — each operator has a handle (`alice@steve`, `bob@alice`), messages are ed25519-signed, attribution is verifiable |
| Actor presence (away/back/online/offline) | ✓ Supported (v1.16+) — `crosstalk actor away/back`, daemon announces on startup/shutdown/registry change |
| Docker sandboxing | Not yet — Docker deploy path is post-v1.x |
| Native Windows | Not yet — WSL works; native Win32 support is post-v1.x |
| Standalone binary (no npm) | Not yet — gated on PTY-layer rewrite; npm tarball is the canonical distribution |

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
      → push with rebase-and-retry on remote contention
  → advance cursor
```

Actor timeout: if the process exceeds `heartbeat-interval`, it is killed and a `type: system, reason: timeout` message is posted to `_system/`.

---

## Requirements

- **Node.js ≥ 18** (LTS line). v18 covers `fetch`, `AbortController`, modern `fs.promises`. No Bun runtime dependency.
- A Crosstalk transport repo cloned locally (see [cordfuse/crosstalk](https://github.com/cordfuse/crosstalk))
- `~/.crosstalk/config.toml` pointing at the transport (or run `crosstalk init` to generate it)

For source builds of `@homebridge/node-pty-prebuilt-multiarch` on platforms without a prebuild: Xcode Command Line Tools (`xcode-select --install`) on macOS; `build-essential` + `python3` on Linux.

---

## Install

End users install from npm — see [cordfuse/crosstalk README Quickstart](https://github.com/cordfuse/crosstalk#3-install-the-runtime). The short version:

```sh
npm install -g @cordfuse/crosstalk-runtime
```

Puts `crosstalk` and the alias `ct` on PATH.

**Pre-release channel** for early-access alphas (`@next` dist-tag):

```sh
npm install -g @cordfuse/crosstalk-runtime@next
```

**Pinned-version fallback** (also useful behind firewalls that block npm but allow GitHub):

```sh
# Replace v1.0.0 with the desired tag from the releases page
npm install -g https://github.com/cordfuse/crosstalk-runtime/releases/download/v1.0.0/cordfuse-crosstalk-runtime-1.0.0.tgz
```

---

## Dev

For local development on the runtime source:

```sh
npm install                         # runs prepare → tsc → dist/, plus native PTY build
node dist/index.js version          # smoke-test the CLI

# Watch-mode for live source iteration (Node 22+, --watch + --experimental-strip-types):
npm run dev
```

`npm install` builds `@homebridge/node-pty-prebuilt-multiarch`'s native module from source on platforms without a prebuild (most macOS configurations need this).

---

## Current release

**v1.0.0 — Production Ready** (npm: `@cordfuse/crosstalk-runtime`, dist-tag `latest`; protocol: `SUPPORTS_PROTOCOL_MAJOR_MINOR = "0.4"`).

The full release history lives in [cordfuse/crosstalk WHATSNEW.md](https://github.com/cordfuse/crosstalk/blob/main/WHATSNEW.md) — single source of truth for both repos.

What v1.0 ships across the cumulative minors:

- **v1.0.0 (Production Ready)** — protocol bumped 0.3 → 0.4; CROSSTALK-VERSION file shipped in framework template; honest scope statement (single-operator supported; multi-operator + Docker + native Windows + standalone-binary all post-v1.0). See [framework ROADMAP.md](https://github.com/cordfuse/crosstalk/blob/main/ROADMAP.md) v1.0 section.
- **v0.9.x (v1.0 prep — alphas only, never cut as v0.9.0 stable)** — daemon installation templates (systemd + launchd) + `crosstalk service install/uninstall/template` CLI; `init` ↔ service integration; `[relay] mode = "disabled"` for offline operators; PTY-mode decrypt-on-read for `channel join`; protocol version handshake at startup.
- **v0.8.0 (Privacy)** — `age`-based per-actor encryption, ROE encryption modes (none/optional/required), CLI `--encrypt`, transparent dispatch in/outbound encryption (response-in-kind), decrypt-on-read in `channel show/tail`, ephemeral whisper messages with auto-tombstoning.
- **v0.7.0 (Governance)** — five ROE templates with per-template semantic enforcement (Parliamentary member-only voting, Scrum role-change PO+SM consent, etc.), time-decay deadlock automation, vote-tally auto-fire on window expiry.
- **v0.6.0 (Interactive Client)** — `crosstalk channel join` with PTY plumbing, three-mode runtime (daemon / server / interactive), config-driven `[agents.X]` registry, live message injection.
- **v0.5.0 (Operator UX)** — full operator CLI surface: `init`, `post`, `channel new/list/show/tail`, `actor list/validate`, `ls`, `config show`, `version`, `watch start/stop/status/logs`.
- **v0.4.0 (Infrastructure)** — repo split from monorepo, relay-based real-time dispatch (`relay.crosstalk.sh` live), `~/.crosstalk/config.toml`.
- **v0.3.0 (Multi-Provider)** — native dispatch for Claude / Gemini / Qwen / OpenCode (Ollama), custom `command`/`args` adapter, cursor-based startup catch-up.

---

## Versioning

Tagged as `vX.Y.Z` (or `vX.Y.Z-alpha.N` / `vX.Y.Z-rc.N` for pre-releases). Each tag push triggers `.github/workflows/release-runtime.yml`, which runs `npm install` + `npm run build` + `npm pack`, publishes the tarball as a GitHub Release asset, AND publishes to npm — pre-releases (semver tag with `-` after the patch number) auto-publish under the `next` dist-tag, stable releases under `latest`. `package.json` is the version-of-record.

---

## History

Runtime source lived in `cordfuse/crosstalk` through `v0.3.0` (commit `2cda1c20`). Moved here at the start of `v0.4.0` to separate contributor and operator concerns. Distribution pivoted from `bun build --compile` per-platform binaries to a Node npm tarball in `v0.6.0-alpha.4` (PR #14) — the bun bundler's native-module discovery couldn't reliably embed `@homebridge/node-pty-prebuilt-multiarch`'s prebuilds across linux-x64 / linux-arm64 / darwin-arm64 without per-platform CI mirrors and the maintenance cost wasn't worth it; every Crosstalk user already has Node installed (claude / gemini / qwen / opencode are all Node CLIs).
