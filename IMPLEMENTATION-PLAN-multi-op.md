# Multi-operator + Actor Identity — Implementation Plan

**Branch:** `feat/multi-operator-identity` (this branch — both `crosstalk-runtime` and `crosstalk` framework repos have parallel branches)

**Locked design spec:** `cordfuse/crosstalk/TODO.md` item #34 (filed 2026-05-17).
Read that first if you're picking this branch up cold — it defines the address
grammar, operator namespacing, signing layer, pool semantics, and the
hyphen-integer reservation rule.

This file is the **implementation plan** — what gets built, in what phases,
in what order. The design is locked; this is execution.

---

## Phasing rationale

Seven phases. Each phase is a coherent, mergeable-on-its-own chunk that
makes mainline meaningfully closer to feature-complete WITHOUT being a
broken half-state. Each phase has a green-light criterion (the test that
proves it works); only when green do we move to the next phase.

The branch stays alive until all phases land. Mainline (`main`) is not
touched until the full feature is merged at the end.

### Phase 1 — Address grammar parser (foundation)

**Scope.** Pure-TypeScript parser. Takes an address string, returns a
structured `ParsedAddress` (or an error). No I/O, no network, no crypto.

```ts
type ParsedAddress =
  | { kind: 'human', name: string }
  | { kind: 'machine', role: string, operator: string, instance?: { kind: 'index', n: number } | { kind: 'tag', tag: string } }
```

Inputs to handle:
- `steve` → `{ kind: 'human', name: 'steve' }`
- `alice@steve` → `{ kind: 'machine', role: 'alice', operator: 'steve' }`
- `alice-7@steve` → `{ kind: 'machine', role: 'alice', operator: 'steve', instance: { kind: 'index', n: 7 } }`
- `alice@steve/cachy` → `{ kind: 'machine', role: 'alice', operator: 'steve', instance: { kind: 'tag', tag: 'cachy' } }`
- `dart-thrower-1@steve` → `{ kind: 'machine', role: 'dart-thrower', operator: 'steve', instance: { kind: 'index', n: 1 } }`
- `steve@steve` (redundant explicit human form) → equivalent to `steve`

Errors to raise:
- Role name ending in `-<integer>` declared as standalone (no `@`) — hyphen-integer reservation rule
- Empty operator, malformed instance suffix, etc.

**Green light:** All test cases pass. Lives in `src/address.ts` with `src/address.test.ts` (or wherever the runtime's tests go — confirm test conventions before writing).

**Files touched:** new `src/address.ts`, new test file.
**Estimated effort:** half a day.

### Phase 2 — Identity layer (ed25519 keys + signing + verification)

**Scope.** Extend the existing v0.8 actor key infrastructure (which today
generates age encryption keys) with parallel ed25519 signing keys.

- Key gen: `~/.crosstalk/keys/<addr>.sign` (private, mode 600)
- Public key publish: `manifest/identities/<addr>.pub` in transport
- Address-form file naming: `steve.sign` for humans, `alice@steve.sign` for machine actors
- Sign on every `Transport.postMessage` (in `GitTransport` per the v1.1 interface)
- Verify on every receive in `watcher.ts` — reject unsigned or invalid (or downgrade per ROE setting; default reject for v1.x)

**Crypto library:** node's built-in `crypto` module has ed25519 support
since Node 12 (`crypto.sign('ed25519', ...)`). No new dependency.

**Green light:** post a message from one identity, verify another daemon
accepts it. Post a message tampered with mid-flight → daemon rejects.

**Files touched:** new `src/identity.ts` for key gen + sign/verify; modify
`src/transports/git.ts` to call sign on post + verify on read; modify
`src/watcher.ts` to reject invalid signatures.
**Estimated effort:** 2-3 days.

### Phase 3 — Registry refactor (operator handle + pool semantics)

**Scope.** Operator handle config (derive from signing key fingerprint OR
explicit operator setting in `~/.crosstalk/config.toml`). Registry parses
actor profiles into role/operator/instance form. Multiple actor files with
the same role-name register as POOL INSTANCES (same role, monotonically
assigned instance index). Auto-migrate `dart-thrower-N` style names into
single pool of N instances.

Stable monotonic instance ID assignment:
- Indices monotonically increase per `(operator, role)` pair
- Track assigned indices persistently in `~/.crosstalk/state/instance-ids.json`
- Never reuse retired indices

**Green light:**
- Register actor file `alice.md` → operator's alice pool has 1 instance
- Add second actor file `alice.md` (impossible — same filename collision) → use `alice-1.md`, `alice-2.md`
- Wait actually: how does an operator declare "give me a pool of N alices"?
  - Option A: one `alice.md` per instance, system auto-indexes
  - Option B: `alice.md` with `replicas: 3` field
  - **Pick at implementation time; document choice in this file once decided**
- Existing dart-thrower-1.md through dart-thrower-20.md auto-collapse into a single dart-thrower pool of 20 instances

**Files touched:** `src/registry.ts` (parsing), new `src/operator.ts` (handle
derivation), `src/config.ts` (operator config field).
**Estimated effort:** 2-3 days.

### Phase 4 — Dispatch refactor (address-aware routing + cross-operator)

**Scope.** Resolve `to:` addresses through the Phase 1 parser. Match against
local registry. Cross-operator routing (daemons see addresses for actors they
don't own; ignore unless they own a matching entry). Pool dispatch semantics
declared per role profile or per template (`fanout`, `load-balance`,
`broadcast-with-quorum`). SEND-time stable identity capture (the address
resolves to a fingerprint of the signing key; that fingerprint goes into
the message frontmatter so dispatch-time resolution is unambiguous). Bounce
/ fail-with-error when addressed instance has left pool (NEVER silent
misdelivery to a different actor).

**Green light:**
- Post `to: alice@steve` from Bob's daemon → only Steve's alice dispatches
- Post `to: dart-thrower@steve` → Steve's pool fans out per declared semantic
- Post `to: alice-7@steve` where alice-7 has left pool → bounce-back error,
  no silent misdelivery

**Files touched:** `src/dispatch.ts`, `src/watcher.ts`, possibly minor in
`src/transports/git.ts`.
**Estimated effort:** 2-3 days.

### Phase 5 — CLI integration

**Scope.**
- `crosstalk post --to alice@bob` parses address-form correctly
- `crosstalk actor key generate <addr>` extends existing v0.8 cmd to take
  address-form
- `crosstalk channel show` renders messages with operator-aware `from:`
  display
- `crosstalk actor list` groups by operator

**Green light:** all CLI subcommands accept and display addresses correctly.

**Files touched:** `src/cli/commands/post.ts`, `src/cli/commands/actor.ts`,
`src/cli/commands/channel.ts`.
**Estimated effort:** 1-2 days.

### Phase 6 — Framework spec + WHATSNEW + migration docs

**Scope.** Update `cordfuse/crosstalk` (framework repo, parallel branch)
with the new address grammar spec — formal docs, examples, migration
notes. CHANGELOG entries on both repos. SETUP-GUIDE.md additions for
multi-operator setup. Single-operator users see no behavioral change
(operator namespace is optional when there's only one operator).

**Files touched:** in `cordfuse/crosstalk`: probably `manifest/framework/protocol/`
(several files); on runtime: WHATSNEW.md, TODO.md item update.
**Estimated effort:** 1-2 days.

### Phase 7 — End-to-end test (Steve as virtual second operator)

**Scope.** Set up two operator identities on the `cordfuse-demo` transport
(Steve runs both — one is the existing setup, second is a temporary alt
identity for testing). Verify:

1. Address `alice@bob` and `alice@steve` routes to distinct registries
2. Cross-operator open-channel message: `bob` posts `to: alice@steve`, Steve's alice responds
3. Cross-operator whisper: `bob` posts `to: alice@steve --encrypt`, age envelope only alice@steve can decrypt
4. Pool fanout: `bob` posts `to: dart-thrower@steve`, all of Steve's dart-thrower pool fan out
5. Signature verification: tampered message rejected
6. Authorization rule: bob can't rotate alice@steve's keys (returns error)
7. Migration: existing `dart-thrower-1.md` through `dart-thrower-20.md` registered as a single pool of 20

**Green light:** all 7 scenarios pass.

**Then:** merge `feat/multi-operator-identity` → `main`. Cut as v1.x release
(probably v1.3.0 or v1.5.0 depending on what else has shipped in between).

---

## Multi-session resumability

If this branch is picked up by a future session:

1. Read this file first (you're here)
2. Read `cordfuse/crosstalk/TODO.md` item #34 (the locked design spec)
3. Check `git log` on this branch to see what phases have landed
4. Check the Task list (Phase 1-7 numbered task entries) for progress
5. Resume from the next unstarted phase

Each phase commits independently. No phase depends on a later phase being
done; you can pause between any two phases and resume cleanly.

---

## Out-of-scope (deferred to v2.x per design spec)

- Trust-model refinements (allow-all vs opt-in cross-op messaging)
- Spam/abuse mitigations (block lists, rate limits)
- Key rotation / revocation ceremony
- Default pool dispatch semantic for bare `alice@steve` when no template
  default exists (currently: error if undeclared)
- Cross-pool wildcard addressing (`alice@*`)

These are real but not in this branch's scope. File as follow-ups when
the v1.x feature lands and we have user signal.
