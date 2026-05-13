# TODO

This is the runtime-specific backlog. The protocol-level design backlog (ROE spec, channel/actor model, governance, etc.) lives in [cordfuse/crosstalk TODO.md](https://github.com/cordfuse/crosstalk/blob/main/TODO.md).

## In progress — v0.7.x runtime enforcement of governance

Framework v0.7.0 shipped the spec (5 ROE templates + AMENDMENT.md + DEADLOCK.md + BOOTSTRAP.md). Runtime enforcement is being implemented incrementally:

- [x] **alpha.1** — `crosstalk roe audit` + `crosstalk roe validate` operator subcommands. Syntactic enforcement of AMENDMENT.md rules: proposal-id uniqueness, vote-on references live proposal, vote.vote ∈ {yes,no,abstain}, vote-window honoured, from in registry, second.seconds references live proposal. Self-testable; no Mac UAT blocker. **Shipped 2026-05-12.**
- [ ] **alpha.2** — watcher integration: `type: session-open` detection per BOOTSTRAP.md + per-actor work-message gating. Touches dispatch path; needs cross-machine UAT.
- [ ] **alpha.3** — time-decay automation per DEADLOCK.md: when active ROE specifies time-decay pattern + decay timer elapses with no resolution, runtime auto-posts `roe-deadlock-resolution`.
- [ ] **alpha.4** — bootstrap-conflict surface routing per BOOTSTRAP.md edge cases: when bootstrap pass detects inconsistent state, runtime posts `type: bootstrap-conflict` and degrades the session pending human resolution.
- [ ] **alpha.5+** — per-template semantic enforcement (Parliamentary member-only voting, Scrum role-change PO+SM consent, Conductor/Orchestra no-vote, etc.). Requires runtime to parse and interpret the active ROE file. Bigger scope; can stay deferred indefinitely if syntactic + bootstrap layers prove sufficient.
- [ ] **v0.7.0 runtime final** when stable.

## Planned — v0.8 Privacy

Framework + runtime work for the v0.8 Privacy milestone (per [cordfuse/crosstalk ROADMAP.md](https://github.com/cordfuse/crosstalk/blob/main/ROADMAP.md)):

- [ ] `age`-based per-actor keypair encryption (transport stores public keys at `manifest/framework/actors/<name>.pub`; private keys machine-local at `~/.crosstalk/keys/<name>.key`)
- [ ] Ephemeral messages (`type: ephemeral`) — encrypted in transit, deleted on confirmed delivery
- [ ] ROE encryption modes: `none` / `optional` / `required`
- [ ] Runtime-side: encryption/decryption hooks in `dispatch.ts` + `crosstalk post`; per-actor key handling

## Planned — v1.0 hardening

- [ ] systemd user unit (Linux) + launchd plist (macOS) templates for daemon installation
- [ ] Optional Docker deploy path: `crosstalk init` offers bare metal or Docker, generates systemd unit or `docker-compose.yml` accordingly
- [ ] Multi-user isolation documented and tested
- [ ] Field validation: multi-machine swarm proven in operator hands

## Deferred — post-v1.0

- [ ] Standalone single-file binary distribution. Gated on PTY-layer rewrite as `bun:ffi` (replacing `@homebridge/node-pty-prebuilt-multiarch`'s native module). Until then, npm tarball is the canonical distribution.
- [ ] Homebrew formula for `crosstalk-runtime`. Gated on the standalone-binary path returning.
- [ ] Native Windows support (currently WSL-only). Gated on macOS + Linux being stable in operator hands first.
- [ ] GitHub event routing — `repository.created` → channel, `issues.opened` → message, `pull_request` → dispatch, etc. Originally on the v0.3.1+ list; deferred when v0.5/v0.6/v0.7 took priority. Worth a separate evaluation post-v1.0 informed by what operators actually want.

---

The runtime backlog stays slim deliberately — most of the unshipped work is design questions answered in the framework's TODO.md. When a runtime-only task surfaces (a CI improvement, a refactor, a new subcommand) that's genuinely independent of protocol design, add it here.
