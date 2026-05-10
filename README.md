# crosstalk-runtime

The Crosstalk runtime daemon — Bun/TypeScript source, CI, and binary builds.

**This is the contributor repo.** If you want to run Crosstalk, you want [cordfuse/crosstalk](https://github.com/cordfuse/crosstalk) — the operator-facing repo with framework actors, protocol spec, and setup instructions.

---

## What this is

The runtime daemon watches a Crosstalk transport for new channel messages and dispatches them to the correct actors. It handles:

- Actor registry loading and hot-reload
- Multi-provider dispatch (`claude`, `gemini`, `qwen`, `opencode`, custom)
- Per-actor git identity and transport clones
- Cursor-based dedup and startup catch-up
- Bootstrap announcements (online / offline / timeout)
- Webhook-triggered Git pull (relay-based dispatch planned for v0.4)

## History

Runtime source lived in `cordfuse/crosstalk` through `v0.3.0` (commit `2cda1c20c12d87d9914edb1941b4efa70f1e6c2a`). Moved here at the start of `v0.4.0` development to separate contributor and operator concerns.

## Requirements

- [Bun](https://bun.sh) >= 1.0

## Dev

```sh
bun install
bun run src/index.ts
```

## Versioning

Tagged as `vX.Y.Z`. Releases are built and published via GitHub Actions.
