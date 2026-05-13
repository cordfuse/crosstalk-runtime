# crosstalk-runtime — Execution Plan

## What this is

The runtime is a Node.js process that bridges the Crosstalk transport (a git repo full of markdown files) and the actor processes (claude, gemini, qwen, opencode, or custom CLIs). One source tree, three runtime modes — daemon / relay-server / interactive client — selected at startup.

Protocol spec, framework actors, and operator docs are in [cordfuse/crosstalk](https://github.com/cordfuse/crosstalk). This repo contains only the daemon/server/CLI source. Changelog and roadmap live in the framework repo.

---

## Current state

Tracking framework versions; runtime ships its own alpha series within each shared minor.

- **v0.3.0** ✓ — multi-provider dispatch (Claude, Gemini, Qwen, OpenCode/Ollama), cursor-based startup catch-up, per-actor git identity, three-layer actor registry
- **v0.4.0** ✓ — repo split from `cordfuse/crosstalk`; relay-based dispatch (`src/relay.ts` outbound WebSocket client + `RELAY_MODE=server` for the relay itself); direct-webhook server removed; config moved from `~/.crosstalk/config.md` (legacy YAML) to `~/.crosstalk/config.toml` (smol-toml)
- **v0.5.0** ✓ — full operator CLI: `init`, `post`, `channel new/list/show/tail`, `ls`, `actor list/validate`, `config show`, `version`, `watch start/stop/status/logs`. Plus framework PROFILES.md spec + AGENTS.md operator-AI guide
- **v0.5.1** ✓ — human-actor profile spec; framework `system` actor type
- **v0.6.0** ✓ — interactive client: `crosstalk channel join` with PTY plumbing (`@homebridge/node-pty-prebuilt-multiarch`), `--backfill N`, config-driven `[agents.X]` registry, live message injection (`to:`-targeting filter + prompt-ready clustering). Distribution pivoted to Node npm tarball at alpha.4
- **v0.7.0-alpha.1** ✓ ← current — `crosstalk roe audit` + `crosstalk roe validate` operator subcommands. Begins runtime enforcement of the framework v0.7.0 governance specs (AMENDMENT.md / DEADLOCK.md / BOOTSTRAP.md)

The full per-alpha changelog (covering both repos) is at [cordfuse/crosstalk WHATSNEW.md](https://github.com/cordfuse/crosstalk/blob/main/WHATSNEW.md).

---

## Module responsibilities

| Module | Owns |
|--------|------|
| `index.ts` | Boot dispatch — daemon / `RELAY_MODE=server` / `crosstalk <subcommand>` mode selection; graceful shutdown |
| `config.ts` | Load and validate `~/.crosstalk/config.toml`; environment-variable overrides for server mode |
| `registry.ts` | Three-layer actor loader; hot-reload via `fs.watch` on `~/.crosstalk/actors/` |
| `watcher.ts` | `fs.watch` loop on transport; dedup window (2s), cursor guard, `to:` targeting |
| `dispatch.ts` | Process lifecycle — spawn agent CLI, capture stdout, commit response, push with rebase-and-retry |
| `git.ts` | All git I/O — per-actor clone, pull, push/rebase/retry, actor identity, no other module touches git |
| `cursor.ts` | Per-channel cursor I/O at `~/.crosstalk/sessions/<MACHINE_ID>/cursors/<channel-guid>` |
| `system.ts` | `MACHINE_ID` derivation, `SESSION_ID`, `type: system` event writing (online/offline/timeout) |
| `relay.ts` | WebSocket relay client (daemon mode) + relay server (`RELAY_MODE=server`); same file, two entry points |
| `frontmatter.ts` | YAML frontmatter parser (`yaml` package) — used by registry, watcher, startup scan, validators |
| `cli/index.ts` | `commander` subcommand dispatcher |
| `cli/commands/*.ts` | One file per subcommand (`init`, `post`, `channel`, `channel-join`, `ls`, `actor`, `config`, `version`, `watch`, `roe`) |
| `cli/lib/actors.ts` | Per-layer actor scanning + parent-chain cycle detection (used by `actor list/validate`) |
| `cli/lib/channel.ts` | Channel listing, GUID resolution, message reading (used by all `channel *` subcommands + `roe audit/validate`) |
| `cli/lib/governance.ts` | Governance message recognition + AMENDMENT.md syntactic validation (used by `roe audit/validate`) |

---

## v0.7.x runtime roadmap (in progress)

Runtime enforcement of the framework v0.7.0 governance specs lands incrementally:

- **alpha.1** ✓ — `crosstalk roe audit` + `crosstalk roe validate`. Operator tools that read channel history, identify governance messages (the `roe-*` family + `session-open` / `bootstrap-conflict`), render the amendment trail per anchor id, and apply AMENDMENT.md syntactic validation (proposal-id uniqueness, vote-on references live proposal, vote.vote ∈ {yes,no,abstain}, vote-window honoured, from in registry, second.seconds references live proposal). Self-testable on a synthetic transport; no Mac UAT blocker.
- **alpha.2** — watcher integration: `type: session-open` detection per BOOTSTRAP.md + per-actor work-message gating. Riskier (touches dispatch path); needs cross-machine UAT to prove the multi-actor startup race-condition fix actually works.
- **alpha.3** — time-decay automation per DEADLOCK.md: when active ROE specifies time-decay pattern + decay timer elapses with no resolution, runtime auto-posts `roe-deadlock-resolution` message.
- **alpha.4** — bootstrap-conflict surface routing per BOOTSTRAP.md edge cases: when bootstrap pass detects inconsistent state (two `roe-vote-result` disagreeing on same proposal, `roe-ratified` referencing nonexistent commit SHA, etc.), runtime posts `type: bootstrap-conflict` and degrades the session pending human resolution.
- **alpha.5+** — per-template semantic enforcement (Parliamentary member-only voting, Scrum role-change PO+SM consent, Conductor/Orchestra no-vote, etc.). Requires runtime to parse and interpret the active ROE file. Bigger scope; potentially multiple alphas. Can stay deferred indefinitely if syntactic validation + bootstrap infrastructure prove sufficient.
- **v0.7.0 runtime final** when stable.

After v0.7.x stabilises: **v0.8 = Privacy** (`age`-based per-actor keypair encryption, ephemeral messages, ROE encryption modes) per the framework ROADMAP.

---

## Open items (runtime-side, beyond v0.7.x)

- **Standalone single-file binary distribution** — deferred to post-v1.0 once the PTY layer is rewritten as `bun:ffi` (eliminating the native-module bundling complexity that drove the bun-compile → npm pivot in v0.6.0-alpha.4)
- **Daemon installer** — systemd user unit (Linux) + launchd plist (macOS) templates. Targeted at v1.0 hardening.
- **Optional Docker deploy** — `crosstalk init` offers bare metal or Docker, generates systemd unit or `docker-compose.yml` accordingly. Solves multi-runtime-version isolation on a single machine. Targeted at v1.0.
- **Native Windows support** — currently WSL only; native Windows replaces systemd with Windows Service / NSSM, resolves path-separator assumptions, tests `fs.watch` behaviour under Windows. Targeted at v1.x.
