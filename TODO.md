# TODO

This is the runtime-specific backlog. The protocol-level design backlog (ROE spec, channel/actor model, governance, etc.) lives in [cordfuse/crosstalk TODO.md](https://github.com/cordfuse/crosstalk/blob/main/TODO.md).

---

## Needs Steve's input

These are gates I cannot resolve autonomously. Each shows what's in flight, what I recommend, and what specifically needs your call.

### ~~Gate A — versioning for v1.0-prep work~~ ✓ resolved 2026-05-14

Bundled into v0.9.0-alpha.1 along with the Mac UAT v0.8.2 follow-up fixes. Cut + shipped to npm + GitHub. Pre-release published under `next` dist-tag (manual fix this round; CI auto-handles future alphas).

### ~~Gate B — was "respond-in-kind" the right default~~ ⏸ implicitly accepted

No flip requested. v0.8.2's response-in-kind semantic stays.

### ~~Gate C — v0.8.3 patch: PTY-mode decrypt-on-read~~ ✓ resolved 2026-05-14

Bundled into v0.9.0-alpha.1. Used `--as <actor>` flag (which channel-join already had). Both backfill and live-injection paths now route through `decryptForDisplay()`. Mac will validate the live behavior in a follow-up UAT.

---

(All previously-open runtime gates are now closed. The active gates moved entirely to the framework TODO since they're architectural.)

---

## v0.9.x — v1.0 Prep (in flight)

- [x] systemd user unit (Linux) + launchd plist (macOS) templates — **shipped v0.9.0-alpha.1**
- [x] PTY-mode decrypt-on-read for channel-join — **shipped v0.9.0-alpha.1**
- [x] post --to <human> registry filter fix — **shipped v0.9.0-alpha.1**
- [x] relay mode = "disabled" — **shipped v0.9.0-alpha.1**
- [ ] `crosstalk init` integrates `service install` (offers to install + activate the unit at end of init flow)
- [ ] Optional Docker deploy path: `crosstalk init` offers bare metal or Docker, generates systemd unit or `docker-compose.yml` accordingly — **gated on framework TODO Gate 2a**
- [ ] Multi-user isolation documented and tested — **gated on framework TODO Gate 2b**
- [ ] Protocol versioning fully wired — `manifest/protocol/VERSION` in transport, startup check per transport against runtime's `supports-protocol` range
- [ ] Field validation: multi-machine swarm proven in operator hands

---

## Deferred — post-v1.0

- [ ] Standalone single-file binary distribution. Gated on PTY-layer rewrite as `bun:ffi` (replacing `@homebridge/node-pty-prebuilt-multiarch`'s native module). Until then, npm tarball is the canonical distribution.
- [ ] Homebrew formula for `crosstalk-runtime`. Gated on the standalone-binary path returning.
- [ ] Native Windows support (currently WSL-only). Gated on macOS + Linux being stable in operator hands first.
- [ ] GitHub event routing — `repository.created` → channel, `issues.opened` → message, `pull_request` → dispatch, etc. Originally on the v0.3.1+ list; deferred when v0.5/v0.6/v0.7/v0.8 took priority. Worth a separate evaluation post-v1.0 informed by what operators actually want.

---

## Shipped (recent)

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
