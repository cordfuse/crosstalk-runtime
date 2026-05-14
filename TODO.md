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

## v1.x candidates (post-v1.0)

- [ ] Multi-operator collaboration — design pass for actor ownership / identity / key rotation propagation across operators sharing a transport. The biggest v1.x deliverable.
- [ ] Optional Docker deploy path: `crosstalk init` offers bare metal or Docker, generates systemd unit or `docker-compose.yml` accordingly — re-evaluate on operator demand
- [ ] Native Windows support (currently WSL-only) — gated on macOS + Linux being stable in operator hands first
- [ ] Field validation: multi-machine swarm proven in operator hands beyond Steve's setup
- [ ] `crosstalk init` integrates Docker deploy path (when Docker landed)

---

## Deferred — post-v1.0

- [ ] Standalone single-file binary distribution. Gated on PTY-layer rewrite as `bun:ffi` (replacing `@homebridge/node-pty-prebuilt-multiarch`'s native module). Until then, npm tarball is the canonical distribution.
- [ ] Homebrew formula for `crosstalk-runtime`. Gated on the standalone-binary path returning.
- [ ] Native Windows support (currently WSL-only). Gated on macOS + Linux being stable in operator hands first.
- [ ] GitHub event routing — `repository.created` → channel, `issues.opened` → message, `pull_request` → dispatch, etc. Originally on the v0.3.1+ list; deferred when v0.5/v0.6/v0.7/v0.8 took priority. Worth a separate evaluation post-v1.0 informed by what operators actually want.

---

## Shipped (recent)

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
