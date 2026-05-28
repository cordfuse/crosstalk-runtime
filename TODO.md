# TODO - Crosstalk Lean Runtime (v2.0)

This is the backlog for the lean v2.0 runtime.

---

## Core Features (Shipped)

- [x] **Runner** — Main loop with per-agent `setInterval` scheduler.
- [x] **Cursor** — Message tracking via `.cursor/<agent>/<channel>` files.
- [x] **Dispatch** — Subprocess CLI execution with stdin context and stdout capture.
- [x] **Git** — Rebase-pull and identity-scoped commits (`-c user.name`).
- [x] **Tokn** — SSE-based turn queue for zero-conflict serialized pushes.
- [x] **Config** — YAML-based agent and transport configuration.
- [x] **Frontmatter** — YAML frontmatter parsing and message rendering.

---

## Maintenance & Improvements

- [ ] **Error Handling** — Improve logging for CLI subprocess failures (e.g., EPIPE, non-zero exits).
- [ ] **Validation** — Field-test with diverse agent CLIs (Gemini, Qwen, local Ollama).
- [ ] **Documentation** — Keep `config.example.yaml` in sync with the README config reference.
- [ ] **Tests** — Add unit tests for `cursor.ts`, `frontmatter.ts`, and `filenames.ts` logic.
- [ ] **Cleanup** — Remove any remaining unused dependencies in `package.json`.
