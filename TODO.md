# TODO

This is the runtime-specific backlog. The protocol-level design backlog (ROE spec, channel/actor model, governance, etc.) lives in [cordfuse/crosstalk TODO.md](https://github.com/cordfuse/crosstalk/blob/main/TODO.md).

---

## Needs Steve's input

These are gates I cannot resolve autonomously. Each shows what's in flight, what I recommend, and what specifically needs your call.

### Gate A — versioning for v1.0-prep work pushed 2026-05-14

`cordfuse/crosstalk-runtime` main currently has commit `5ebae5a` (systemd/launchd templates + `crosstalk service install/uninstall/template` command) **pushed but not tagged.** Three options:

- **v0.8.3 patch** — additive, doesn't claim v1.0
- **v0.9.0-alpha.1** — start of v1.0 prep alpha series (matches v0.7/v0.8 pattern)
- **Hold for v1.0** — bake in main until all v1.0 ROADMAP items ready

**My read:** v0.9.0-alpha.1.

### Gate B — was "respond-in-kind" the right default for dispatch outbound encryption?

Shipped in v0.8.2 with this semantic: encrypted inbound → response encrypted to the same recipient set + original sender + responding actor. Plaintext inbound → plaintext response. Easy to flip if you want different semantics:

- **Alt A** — forced encrypt under `encryption-mode: required` regardless of inbound state
- **Alt B** — respond-to-asker only (point-to-point, not group)
- **Alt C** — response always plaintext (encryption strictly operator-driven)

**My read:** keep current (respond-in-kind). Most natural default.

### Gate C — v0.8.3 patch: PTY-mode decrypt-on-read for `channel-join`

Real protocol gap discovered during the v0.8.2 CROSSTALK.md audit. `channel-join` (interactive PTY client) doesn't decrypt inbound — agents in PTY mode see ciphertext. Daemon mode decrypts via `maybeDecryptInbound`; PTY mode is missing the equivalent.

Workaround documented in CROSSTALK.md (use `crosstalk channel show --as <actor>` in another terminal). Fix is small (port the decrypt pattern from dispatch.ts) but needs a design call:

- Pass `--as <actor>` at `channel join` time so the runtime knows which identity to use? (operator-side flag, simple)
- Or have the runtime infer from the registry based on the joining agent? (cleaner UX, more code)

**My read:** start with `--as <actor>` flag. Trivial implementation, lets us learn from operator feedback before committing to inference logic.

---

## v1.0 — Production Ready (per cordfuse/crosstalk ROADMAP)

These need your scope/timing calls (see framework TODO.md "Needs Steve's input" for the architectural decisions). Runtime-side implementation work that's queued:

- [x] systemd user unit (Linux) + launchd plist (macOS) templates — **shipped 2026-05-14, untagged pending Gate A**
- [ ] `crosstalk init` integrates `service install` (offers to install + activate the unit at end of init flow)
- [ ] Optional Docker deploy path: `crosstalk init` offers bare metal or Docker, generates systemd unit or `docker-compose.yml` accordingly — **gated on your call (Docker yes/no for v1.0; see framework TODO Gate 2a)**
- [ ] Multi-user isolation documented and tested — **gated on your call about what "supported" means (see framework TODO Gate 2b)**
- [ ] Field validation: multi-machine swarm proven in operator hands
- [ ] Protocol versioning fully wired — `manifest/protocol/VERSION` in transport, startup check per transport against runtime's `supports-protocol` range (currently CROSSTALK.md step 2 references this aspirationally)

## v0.8.x candidates (independent of v1.0)

- [ ] Gate C resolution — PTY-mode decrypt-on-read for channel-join

---

## Deferred — post-v1.0

- [ ] Standalone single-file binary distribution. Gated on PTY-layer rewrite as `bun:ffi` (replacing `@homebridge/node-pty-prebuilt-multiarch`'s native module). Until then, npm tarball is the canonical distribution.
- [ ] Homebrew formula for `crosstalk-runtime`. Gated on the standalone-binary path returning.
- [ ] Native Windows support (currently WSL-only). Gated on macOS + Linux being stable in operator hands first.
- [ ] GitHub event routing — `repository.created` → channel, `issues.opened` → message, `pull_request` → dispatch, etc. Originally on the v0.3.1+ list; deferred when v0.5/v0.6/v0.7/v0.8 took priority. Worth a separate evaluation post-v1.0 informed by what operators actually want.

---

## Shipped (recent)

- v0.8.2 — `channel tail` decrypt-on-read + dispatch outbound encryption (response-in-kind) + dispatch.ts stdout-consumption bug fix (closes both v0.8.x deferrals)
- v0.8.0 → v0.8.1 — Privacy minor end-to-end (7-alpha autonomous run + CI test bump)
- v0.7.0 — Governance minor end-to-end (7 runtime alphas + final cut)
- v0.6.0 — Interactive Client minor (8 alphas, PTY-wrapped agent CLI for live message injection)
- v0.5.x — Operator UX (`init`, `post`, `channel`, `actor`, `roe`, `ls`, `config`, `version`, `watch`)
- v0.4.0 — Public relay live at `relay.crosstalk.sh`

Authoritative changelog: [cordfuse/crosstalk WHATSNEW.md](https://github.com/cordfuse/crosstalk/blob/main/WHATSNEW.md).

---

The runtime backlog stays slim deliberately — most of the unshipped work is design questions answered in the framework's TODO.md. When a runtime-only task surfaces (a CI improvement, a refactor, a new subcommand) that's genuinely independent of protocol design, add it here.
