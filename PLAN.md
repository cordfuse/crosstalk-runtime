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
- **v0.7.0** ✓ — Governance minor: 5 ROE templates (Parliamentary / Scrum / Casual / Monarchy / Conductor-Orchestra) with per-template semantic enforcement, time-decay deadlock automation, vote-tally auto-fire on window expiry, AMENDMENT.md + BOOTSTRAP.md spec, cursor migration SESSION_ID → MACHINE_ID
- **v0.8.0** ✓ — Privacy minor: `age`-based per-actor encryption, ROE encryption modes (none/optional/required), `crosstalk post --encrypt`, transparent dispatch in/outbound encryption (response-in-kind), decrypt-on-read in `channel show/tail`, ephemeral whisper messages with auto-tombstoning
- **v0.9.0-alpha.1 … alpha.3** ✓ — v1.0 prep alphas (never cut as v0.9.0 stable; promoted directly to v1.0.0). Daemon installation templates (systemd + launchd) + `crosstalk service install/uninstall/template`; `init` ↔ service integration; `[relay] mode = "disabled"`; PTY-mode decrypt-on-read for `channel join`; protocol version handshake at daemon startup
- **v1.0.0** ✓ ← current — Production Ready. Protocol bumped 0.3 → 0.4 to capture v0.7 + v0.8 wire-format additions. Honest scope: single-operator supported; multi-operator + Docker + native Windows + standalone-binary all post-v1.0. npm `@cordfuse/crosstalk-runtime`, `latest` dist-tag

The full per-version changelog (covering both repos) is at [cordfuse/crosstalk WHATSNEW.md](https://github.com/cordfuse/crosstalk/blob/main/WHATSNEW.md).

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

## v1.x roadmap (post-v1.0)

v1.0 ships the v0.7 governance + v0.8 privacy + v0.9.x v1.0-prep work fully validated. Open items targeted for v1.x or post-v1.0:

- **Multi-operator collaboration** — multiple humans sharing one transport with proper coordination. v1.0 supports single-operator only (one human, possibly across their own multiple machines via per-machine cursors). Multi-operator design questions are unresolved: actor ownership across machines (which daemon picks up alice when alice is registered on two operators' machines?), identity attribution (no protocol-level rule preventing two humans from both writing `from: steve`), key rotation propagation (when alice rotates on her machine, bob's machine still has the old pubkey until pull+commit), bootstrap coordinator collisions. Targeted at v1.x once the design pass lands.
- **Optional Docker deploy** — `crosstalk init` offers bare metal or Docker, generates systemd unit or `docker-compose.yml` accordingly. Solves multi-runtime-version isolation on a single machine. Deferred from v1.0 — npm-only covers everyone using Crosstalk today; Docker adds maintenance surface. Re-evaluate when operator demand surfaces.
- **Native Windows support** — currently WSL only; native Windows replaces systemd with Windows Service / NSSM, resolves path-separator assumptions, tests `fs.watch` behaviour under Windows. Targeted at v1.x once macOS + Linux are stable in the field.
- **Standalone single-file binary distribution** — deferred to post-v1.0 once the PTY layer is rewritten as `bun:ffi` (eliminating the native-module bundling complexity that drove the bun-compile → npm pivot in v0.6.0-alpha.4).
- **Actor swarms** — N parallel workers per actor profile (fan-out + work-queue flavors). Today single-instance-per-actor. Post-v1.0 design pass; see [framework TODO #33](https://github.com/cordfuse/crosstalk/blob/main/TODO.md).
- **Politik bindings** — actual integration code once Politik exists (currently PLAN phase per `STRATEGY.md`). v1.0 ships only the spec seam in `manifest/framework/protocol/POLITIK.md`.
