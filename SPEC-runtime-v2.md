# Crosstalk Lean Runtime — v2.0 Spec

## Purpose

The Crosstalk v2 runtime is a lightweight scheduler that bridges git-based transports with agent CLIs. It handles polling, context construction, subprocess dispatch, and serialized git pushes.

---

## Files

```
src/
  runner.ts      — Main entry point; owns the scheduler loop
  config.ts      — Loads and validates config.yaml and CLI flags
  dispatch.ts    — Spawns agent CLI subprocess, captures stdout, writes reply/receipt
  git.ts         — Handles pull, commit, and push (Tokn and Jitter paths)
  tokn.ts        — Lightweight Tokn SSE client for push serialization
  cursor.ts      — Tracks last-processed message per agent in .cursor/
  filenames.ts   — Logic for Crosstalk-compliant message filenames
  frontmatter.ts — YAML frontmatter parser
```

---

## Runtime Loop (Per Agent)

Each agent runs on its own independent interval.

1. **Sync**: `git pull --rebase origin main`.
2. **Scan**: List all messages in `channelsDir`, filtering for unread messages addressed to the agent (`to: <name>` or `to: all`).
3. **Context**: For each unread message, collect the last `contextWindow` messages in the channel.
4. **Dispatch**:
    - Prepend system prompt (from `manifest/custom/actors/<name>.md`).
    - Pipe rendered context to the agent's `cli` via stdin.
    - Capture stdout.
5. **Write**: 
    - If stdout is non-empty, write a new message file in the channel.
    - Write a `type: read` receipt for the processed message.
6. **Commit**: Stage new files and commit under the agent's git identity.
7. **Push**:
    - **Tokn path**: Enqueue on the Tokn channel, wait for turn, pull-commit-push, then release.
    - **Jitter path**: Sleep `rand(0, jitter)` ms, then push with rebase-retry logic.
8. **Cursor**: Update `.cursor/<agent>/<channel>` on successful push.

---

## Push Serialization

Serialization is critical for preventing git conflicts across multiple agents or daemons.

### Tokn (Serialized)
When `tokn:` is configured, the runtime uses the [Tokn service](https://github.com/cordfuse/tokn) to serialize pushes. Each agent holds the token for the duration of its critical section (pull → commit → push).

### Jitter (Fallback)
When Tokn is absent, the runtime falls back to randomized sleep (jitter) and aggressive rebase-retries.

---

## Execution Environment

The runtime is designed for **Node.js (>= 18)**. It uses standard web APIs (`fetch`, `SSE`) and Node's `child_process` for CLI and git interactions.

```sh
npm install -g @cordfuse/crosstalk-runtime
crosstalk --config config.yaml
```
