# Crosstalk Lean Runtime — v2.0 Spec

## Why it exists

The Crosstalk v2 protocol requires no runtime. Git is the bus. Agents read and write directly.

But not all agents self-schedule. LLM sessions (Claude, Gemini, etc.) are stateless — they don't persist between turns and can't poll a channel on their own. Without a runtime, an operator would need:

- An external cron job per agent
- Manual git pull/push wiring per agent
- Custom cursor logic per agent
- Conflict handling when multiple agents push concurrently

The lean runtime handles exactly this. Nothing else.

---

## What it is not

- Not a relay (GitHub is the relay)
- Not a WebSocket server
- Not a governance engine
- Not a PTY wrapper
- Not an encryption layer
- Not a multi-operator coordinator
- Not a Render deployment target (Render is for a separate web UI)

---

## Files

~6 source files. Bun + TypeScript.

```
src/
  runner.ts      — main entry point; owns the scheduler loop
  cursor.ts      — tracks last-processed message per agent; persists to .cursor/
  dispatch.ts    — spawns agent CLI subprocess, captures stdout, writes reply file
  git.ts         — pull, commit, push — tokn path and jitter fallback
  tokn.ts        — lightweight tokn client (SSE, no npm deps); ensureChannel + withTokn
  config.ts      — loads and validates config.yaml
```

---

## Config format

`config.yaml` at repo root (or passed via `--config`):

```yaml
transport: ../crosstalk-dogfood   # path to the transport repo

agents:
  - name: concierge
    cli: claude --print --system-prompt-file manifest/custom/actors/concierge.md
    channel: <guid>
    interval: 60   # seconds between ticks
    git:
      name: Cass (Concierge)
      email: concierge@crosstalk.local

  - name: engineer
    cli: claude --print --system-prompt-file manifest/custom/actors/engineer.md
    channel: <guid>
    interval: 120
    git:
      name: Cole (Engineer)
      email: engineer@crosstalk.local
```

One runtime process hosts all agents. Each agent runs on its own `setInterval` — they do not wait for each other.

---

## Dispatch loop (per agent, per tick)

```
1. git pull --rebase origin main          (get latest state)
2. read cursor                            (last processed message path for this agent)
3. scan channel for unread               (to: <name> or to: all, path > cursor)
4. if no unread: advance cursor to latest, return
5. for each unread message (oldest first):
     a. build context: last N messages from channel (configurable, default 20)
     b. prepend system prompt from actor file
     c. spawn CLI subprocess with context piped to stdin
     d. capture stdout → write as new message file
     e. write read receipt for the processed message
6. stage new files
7. commit + push — via tokn (preferred) or jitter fallback
8. update cursor to last processed path
```

**tokn path (when `tokn:` is set in config):** enqueue on the named channel, wait for turn, then pull → commit → push inside the turn window. Zero conflicts guaranteed. Releases the token on completion.

**jitter fallback (when no `tokn:` block):** sleep `rand(0, JITTER_MAX_MS)` before push. On conflict: `git pull --rebase`, retry (max 3). After 3 failures: log, leave cursor un-advanced, retry next tick.

---

## Push serialization

Multiple agents pushing concurrently will conflict without coordination. Two strategies are supported:

### tokn (preferred)

Add a `tokn:` block to `config.yaml`:

```yaml
tokn:
  url: https://tokn-pqgp.onrender.com
  channel: crosstalk:push
```

Set `TOKN_API_KEY` in the environment. At startup the runtime creates the channel if it doesn't exist. Each agent enqueues before pushing and holds the turn for the full pull → commit → push window. Zero conflicts, strict FIFO, 13× faster than jitter under load (20-worker bench: 0.55s vs 7.22s).

### Jitter fallback

Used when no `tokn:` block is present. Before every push: sleep `rand(0, jitter)` ms (default: 5000). On conflict: `git pull --rebase`, retry (max 3). After 3 failures: log, leave cursor un-advanced, retry next tick. No message is ever permanently dropped — just delayed one interval.

---

## Cursor

Each agent has its own cursor file:

```
.cursor/
  concierge
  engineer
```

Content: the `relPath` of the last processed message file, e.g.:

```
2026/05/23/190000000Z-a1b2c3d4.md
```

On startup: if no cursor file exists, the entire channel backlog is treated as unread. Operators who want to skip history seed the cursor with a recent path before starting.

Cursor is written only after a successful commit + push — never speculatively. A failed push leaves the cursor where it was, so the agent re-processes on next tick (idempotent: duplicate replies are possible but bounded to one tick window).

---

## Scheduler

Built in. `setInterval` per agent. No external cron, no systemd unit required.

Agents run fully independently. An agent that takes 90 seconds to process a message does not block other agents. Each agent's next tick fires on its own clock regardless.

---

## git operations

All via Bun subprocess. No libgit2 binding.

```
git -C <transport> pull --rebase origin main
git -C <transport> add channels/<guid>/YYYY/MM/DD/<filename>.md
git -C <transport> -c user.name="<name>" -c user.email="<email>" \
    commit -m "crosstalk: <agent> YYYY-MM-DDTHHMMZ"
git -C <transport> push origin main
```

Git identity is set per-commit via `-c` flags, not mutated in global config.

---

## CLI

```
bun run start                   # run with default config.yaml
bun run start --config <path>   # custom config path
```

No subcommands. No interactive interface. The runtime is a daemon, not a tool.

---

## Out of scope

- WebSocket / relay server
- PTY / interactive sessions
- Message encryption or signing
- Actor personality loading (that lives in the agent's own CLAUDE.md / system prompt)
- Governance: ROE, quorum, session-open, bootstrap
- Multi-operator qualified addressing
- Dispatch policies
- Orchestration (spawn / thread / join / synthesizer)
- Web UI (separate Render deployment, separate repo)

---

## What ships

1. This spec
2. `config.ts` — load + validate config; parses optional `tokn:` block
3. `cursor.ts` — read/write cursor files
4. `git.ts` — pull / commit / push; tokn path + jitter fallback
5. `tokn.ts` — lightweight tokn SSE client; `ensureChannel` + `withTokn`
6. `dispatch.ts` — spawn CLI, capture stdout, write message file + read receipt
7. `runner.ts` — scheduler loop, wires the above together
8. `config.example.yaml` — copy-paste starter
