# TODO

This is the runtime-specific backlog. The protocol-level design backlog (ROE spec, channel/actor model, governance, etc.) lives in [cordfuse/crosstalk TODO.md](https://github.com/cordfuse/crosstalk/blob/main/TODO.md).

---

## Runtime gates — all resolved at v1.0.0

All previously-open runtime gates closed by v1.0.0 (2026-05-14). Active v1.x gates live entirely in [framework TODO.md](https://github.com/cordfuse/crosstalk/blob/main/TODO.md) since they're architectural / cross-cutting.

---

## v0.9.x — v1.0 Prep (cumulatively shipped, never cut as v0.9.0 stable)

All v0.9.x alphas promoted directly into v1.0.0 — v0.9.0 stable was skipped to avoid wasteful churn.

- [x] systemd user unit (Linux) + launchd plist (macOS) templates — shipped v0.9.0-alpha.1
- [x] PTY-mode decrypt-on-read for channel-join — shipped v0.9.0-alpha.1
- [x] post --to <human> registry filter fix — shipped v0.9.0-alpha.1
- [x] relay mode = "disabled" — shipped v0.9.0-alpha.1
- [x] `crosstalk init` integrates `service install` + relay disabled mode in init wizard — shipped v0.9.0-alpha.2
- [x] Protocol versioning wired — startup handshake reads `<transport>/CROSSTALK-VERSION` — shipped v0.9.0-alpha.3
- [x] CROSSTALK-VERSION bumped 0.3 → 0.4 to reflect v0.7 governance + v0.8 privacy wire-format additions — shipped v1.0.0

## Public-announcement readiness

Crosstalk-runtime is at v1.2.0 and labeled "Production Ready" since v1.0.0
(2026-05-14). Technically launchable. Two open questions for an actual
announcement push:

### Solo-launch (crosstalk alone, technical audience: HN, dev-tools twitter)

- [ ] **Honest scope statement** in README — "single-operator supported"
      gap should be explicit on the front page so first-comment readers
      don't have to dig. Spell out: works for one operator running daemons
      across N machines; multi-operator (multiple humans collaborating on
      one transport) needs the actor-identity work below.
- [ ] **Dependabot pass** across runtime + framework repos.
- [ ] **FilesystemTransport** (v1.x candidate below) — would dramatically
      widen the audience to "I just want a local AI swarm on one box, no
      git, no GitHub" which is the largest segment of dev-tool users.
      Without it, every operator needs GitHub-as-transport setup to try
      it, which is a non-trivial onboarding step.
- [ ] **At least one external operator** has run the setup end-to-end
      successfully. Field-validation gate per TODO line below — the
      multi-machine swarm has only been proven on Steve's setup.

### Joint-launch (crosstalk + vyzr together, broader "Cordfuse OSS" push)

- [ ] All ship gates from
      [vyzr ROADMAP — v1.0 section](https://github.com/cordfuse/vyzr/blob/main/ROADMAP.md)
- [ ] All announce gates from same — joint narrative ("Cordfuse OSS:
      desktop GUI + multi-machine coordination") makes a tighter pitch
      than either alone

### Explicitly gated separately

- **Politik** — STRATEGY.md mandates "announce both [Crosstalk + Politik]
  together," but Politik is still markdown-only (21 commits, no runnable
  code). Politik's announce is gated on Politik having a reference
  implementation, NOT on crosstalk's readiness. Treat as a separate,
  later push.

Target window for solo or joint launch: **late June 2026** (conservative
— assumes 2-3 focused weeks from v1.2.0 / vyzr v0.9.1). See vyzr ROADMAP
for the shared timeline.

---

## v1.x candidates (post-v1.0)

- [x] **Push contention at N>10 concurrent dispatch.** Three-stage fix landed 2026-05-17:
  - v1.0.1 — retry budget bumped 5 → 20 (symptom-level patch). 18/20 actors, 0 push failures, up to 9 retries per actor.
  - v1.0.2 — structural fix: per-remote push queue in `src/git.ts`, serializes same-daemon pushes by remote URL. 20/20, 0 failures, but ~1.5 retries/actor (each clone rebases reactively after rejection).
  - v1.0.3 — finished the fix: pre-pull-rebase **inside** the queue critical section before the first push. Retry rate dropped from 150% → 1.7% across a 60-dispatch re-validation (1 retry total). Same-daemon contention structurally solved; cross-daemon contention still uses the retry budget (much rarer in practice).
- [x] **Heartbeat-interval timeout doesn't kill opencode subprocesses.** Shipped v1.0.1: `detached: true` on every spawn + `process.kill(-pid, 'SIGTERM')` to signal the entire process group (3s grace → SIGKILL escalation). The fix is mechanically correct but **not yet field-validated against a real slow-task** — all v1.0.x Monte Carlo dispatches completed in 10-15s, well under the 60s heartbeat. Re-run the 56-min hung-dispatch case to confirm.
- [x] **Single-daemon-per-transport enforcement** (v1.0.4 → v1.0.5):
  - v1.0.4 — initial PID lock at `~/.crosstalk/daemon.pid`, per-user. Closed the bug class that caused yesterday-daemon + today-daemon to both dispatch the same fan-out during v1.0.2 testing. But too broad — also blocked the legitimate multi-transport-per-user case (one operator running one daemon per workspace).
  - v1.0.5 — per-transport lock at `~/.crosstalk/locks/<sha256-of-realpath>.pid`. Refusal scoped to "same transport as an existing daemon" instead of "any daemon for this user". Different transports = different lock files = coexist. Includes v1.0.4-migration check that refuses startup if a live v1.0.4 daemon still holds the legacy lock.
- [x] **`--config` / `CROSSTALK_CONFIG` env override** (v1.0.5). Shipped as a pair with the per-transport lock — multi-transport-per-user is only useful if you can point each daemon at its own config file. `--config <path>` flag extracted from argv before CLI dispatch (works for daemon + all subcommands); `CROSSTALK_CONFIG` env honored when flag absent. Defaults to `~/.crosstalk/config.toml`. Unblocks "one daemon per workspace" without HOME-juggling.
- [ ] **Doc note — local transport can briefly lag GitHub after concurrent push burst.** Observed in 20-way test: daemon's local transport showed 9 responses immediately after dispatch completion, then 18 after explicit `git pull`. The daemon DOES pull on relay notifications, but there's a small window between push-completion at GitHub and the daemon's pull-on-notify catching up. Tools that read the channels/ dir directly (CLI, scripts, operators) can see stale state for a few seconds. **Mitigation:** document in SETUP-GUIDE that aggregation/audit tools should `git pull` first. No code change needed — operator awareness is sufficient. Could also add a `crosstalk channel show --refresh` flag that pulls before reading.
- [ ] Multi-operator collaboration — design pass for actor ownership / identity / key rotation propagation across operators sharing a transport. The biggest v1.x deliverable.
- [ ] Optional Docker deploy path: `crosstalk init` offers bare metal or Docker, generates systemd unit or `docker-compose.yml` accordingly — re-evaluate on operator demand
- [ ] Native Windows support (currently WSL-only) — gated on macOS + Linux being stable in operator hands first
- [ ] Field validation: multi-machine swarm proven in operator hands beyond Steve's setup
- [ ] `crosstalk init` integrates Docker deploy path (when Docker landed)
- [ ] `spawnCodex` (Mac flagged) — codex is wired for `channel join` but falls to `spawnCustom` for daemon dispatch. Mirror `spawnGemini`/`spawnQwen`. Optional quality tier; not the fallback answer (that's opencode+OpenRouter).
- [ ] **v1.x — CLI subcommand migration to Transport.** Daemon-core moved to the `Transport` interface in v1.1.0; CLI subcommands still call `git.ts`'s legacy `pushWithRetry` shim. Migrate `post`, `channel`, `channel-join`, `actor`, `watch`, `init` to consume `Transport` directly, then delete `src/git.ts` entirely. Same refactor pattern as v1.1.0 — well-bounded, all-internal, no operator-visible change.
- [ ] **v1.x — FilesystemTransport.** ~150 LOC. Implements the same `Transport` interface for plain local FS, NFS/SMB mounts, sshfs, etc. Unblocks "local AI swarm on one machine with no git, no GitHub account, no relay" — a clear operator win.
- [ ] **v1.x — SftpTransport.** ~250 LOC. For multi-machine without a kernel mount. Polling-based `watchMessages` (no native push from SFTP).

---

## Deferred — post-v1.0

- [ ] Standalone single-file binary distribution. Gated on PTY-layer rewrite as `bun:ffi` (replacing `@homebridge/node-pty-prebuilt-multiarch`'s native module). Until then, npm tarball is the canonical distribution.
- [ ] Homebrew formula for `crosstalk-runtime`. Gated on the standalone-binary path returning.
- [ ] Native Windows support (currently WSL-only). Gated on macOS + Linux being stable in operator hands first.
- [ ] GitHub event routing — `repository.created` → channel, `issues.opened` → message, `pull_request` → dispatch, etc. Originally on the v0.3.1+ list; deferred when v0.5/v0.6/v0.7/v0.8 took priority. Worth a separate evaluation post-v1.0 informed by what operators actually want.

---

## Shipped (recent)

- **v1.2.0 — Polling fallback for relay=disabled** (2026-05-17) — when `relay.mode = "disabled"`, the daemon now calls `transport.sync()` every N seconds (default 30s; configurable via `[relay].poll-interval-seconds`) instead of never syncing remote commits. Closes the previous gap where disabled mode silently missed all remote-side commits. Opens the door to retiring the hosted relay for operators who don't need sub-second sync latency.
- **v1.1.0 — Transport interface** (2026-05-17) — internal refactor: `src/transport.ts` defines a 12-method `Transport` interface; `src/transports/git.ts` is the first implementation (`GitTransport`); all daemon-core consumers (index, watcher, dispatch, bootstrap, system, relay, governance) refactored to use Transport methods instead of direct git calls. ~46% of the runtime that previously existed to manage git semantics is now concentrated behind one bounded interface. Same operator-visible behavior; same v1.0.x bug fixes preserved. CLI subcommands still use the legacy `git.ts` shim (one `pushWithRetry` re-export remaining) — v1.2.0 migrates them.
- **v1.0.5** (2026-05-17) — per-transport PID lock (replaces v1.0.4's per-user); `--config` / `CROSSTALK_CONFIG` env override; v1.0.4-migration safety check
- **v1.0.4** (2026-05-17) — single-daemon-per-OS-user PID lock (`~/.crosstalk/daemon.pid`); stale-PID auto-recovery (superseded by v1.0.5's per-transport scheme)
- **v1.0.3** (2026-05-17) — pre-pull-rebase inside push queue critical section; retry rate 150% → 1.7%
- **v1.0.2** (2026-05-17) — per-remote push queue serializes same-daemon pushes
- **v1.0.1** (2026-05-17) — pushWithRetry budget 5 → 20; heartbeat-timeout kills process group via `detached: true` + `kill(-pid, 'SIGTERM')`
- **v1.0.0 — Production Ready** (2026-05-14) — protocol bumped 0.3 → 0.4; cumulative v0.7 + v0.8 + v0.9.x surface; honest scope statement (single-operator supported)
- v0.9.0-alpha.3 — protocol version handshake at daemon startup; CROSSTALK-VERSION added to framework template
- v0.9.0-alpha.2 — `init` ↔ `service install` integration; relay disabled mode discoverable in init wizard
- v0.9.0-alpha.1 — first v1.0 prep alpha; templates + service command + PTY decrypt + post-human fix + relay disabled mode + CI dist-tag auto-detect
- v0.8.2 — `channel tail` decrypt-on-read + dispatch outbound encryption (response-in-kind) + dispatch.ts stdout-consumption bug fix (closes both v0.8.x deferrals)
- v0.8.0 → v0.8.1 — Privacy minor end-to-end (7-alpha autonomous run + CI test bump)
- v0.7.0 — Governance minor end-to-end (7 runtime alphas + final cut)
- v0.6.0 — Interactive Client minor (8 alphas, PTY-wrapped agent CLI for live message injection)
- v0.5.x — Operator UX (`init`, `post`, `channel`, `actor`, `roe`, `ls`, `config`, `version`, `watch`)
- v0.4.0 — Public relay live at `relay.crosstalk.sh`

Authoritative changelog: [cordfuse/crosstalk WHATSNEW.md](https://github.com/cordfuse/crosstalk/blob/main/WHATSNEW.md).

---

The runtime backlog stays slim deliberately — most of the unshipped work is design questions answered in the framework's TODO.md. When a runtime-only task surfaces (a CI improvement, a refactor, a new subcommand) that's genuinely independent of protocol design, add it here.
