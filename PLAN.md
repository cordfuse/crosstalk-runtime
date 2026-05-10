# crosstalk-runtime — Execution Plan

## What this is

The runtime daemon is the process that bridges the Crosstalk transport (a git repo full of markdown files) and the actor CLIs (claude, gemini, qwen, opencode, or custom). It is a persistent Bun process. One instance per machine.

Protocol spec and framework actors are in [cordfuse/crosstalk](https://github.com/cordfuse/crosstalk). This repo contains only the daemon source.

---

## Current State — v0.3.0

### What is implemented

**Transport watching**
- `fs.watch` on `<transport>/channels/` — recursive, event-driven, zero polling
- Dedup window (2s) — prevents double-dispatch from duplicate inotify events
- Cursor check — drops any message at or before the channel cursor; prevents git rebase re-fire on startup

**Actor registry**
- Three-layer resolution: `framework/` → `custom/` → `~/.crosstalk/actors/`; last wins
- Kebab-case enforcement on actor filenames
- Hot-reload — `fs.watch` on `~/.crosstalk/actors/`; registry reloads without restart
- Silently skips actor files that have no `agent` or `command` field (e.g. `runtime.md`)

**Dispatch**
- Routes by `agent` field: `claude`, `gemini`, `qwen`, `opencode`, or custom
- Spawns agent CLI as a child process, captures stdout, commits response to transport
- Per-actor git identity: `<name>@<actor-email-suffix>` or explicit `git-email` override
- Per-actor transport clone: `~/.crosstalk/actor-clones/<namespace>/<name>/` — eliminates git index lock contention on concurrent dispatch
- Actor timeout: kills process and posts `type: system, reason: timeout` to `_system/` if heartbeat-interval exceeded
- Custom actor guard: throws descriptive error if `command` is undefined rather than passing undefined to spawn

**Startup scan**
- On boot, reads all channels, compares against cursor, dispatches any messages missed while daemon was down
- MACHINE_ID (`sha256(hostname).hex[:16]`) is stable across restarts — cursors survive reboots

**System announcements**
- `type: system, reason: online` — posted to `_system/` on startup, includes actor list, protocol version, machine hash
- `type: system, reason: offline` — posted on SIGINT/SIGTERM
- `type: system, reason: timeout` — posted when actor process exceeds heartbeat-interval

**Multi-provider dispatch (v0.3.0)**
- `agent: claude` — Claude Code CLI, `--print` headless mode
- `agent: gemini` — Gemini CLI, personality baked into prompt body
- `agent: qwen` — Qwen Code CLI, `--system-prompt` supported
- `agent: opencode` — OpenCode CLI, `--format json` JSONL output parsed
- Custom — `command`/`args` with `{variable}` substitution

**Webhook server (v0.1.3, deprecated in v0.4)**
- Bun HTTP server on configurable port
- HMAC-SHA256 verification of GitHub push events (`x-hub-signature-256`)
- On verified push: calls `pullTransport` → `fs.watch` picks up new files naturally

---

## v0.4.0 Plan — Relay-based dispatch

### Problem with current webhook model

Each machine must expose a public HTTP endpoint and register it with the Git host separately. Requires a public IP or tunnel (Tailscale Funnel, Cloudflare Tunnel, ngrok, etc.) on every machine. Not scalable to a multi-machine swarm where operators may be behind NAT.

Polling `git ls-remote` as an alternative hits API rate limits at scale.

### Solution: relay + WebSocket

A relay server sits between the Git host and the runtimes:

```
Git host → webhook → relay → WebSocket → all connected runtimes
```

- Runtime connects **outbound** to the relay via WebSocket on startup — works behind NAT, no inbound port required
- Git host fires one webhook to the relay
- Relay pushes a minimal notification `{ repo, event, sha }` to all connected runtimes
- Each runtime pulls the transport and dispatches locally
- Relay carries no message content — only the ping. Content stays in the git transport.

### Runtime changes for v0.4.0

1. **New: `src/relay.ts`** — WebSocket client that connects to `relay-url` on startup, reconnects on disconnect, handles incoming notifications by calling `pullTransport`
2. **Remove: direct webhook server** — `src/webhook.ts` deleted (or kept behind deprecated config flag for one release)
3. **Config additions:**
   ```yaml
   relay-url: wss://relay.crosstalk.dev
   relay-secret: <secret>
   ```
4. **Auth:** relay sends HMAC of `{ repo, sha }` signed with `relay-secret` — runtime verifies before pulling

### Relay server (separate repo: `cordfuse/crosstalk-relay`)

Lightweight stateless service:
- Accepts webhook POST from Git hosts (verified via HMAC)
- Maintains WebSocket connections from runtimes
- On webhook: broadcasts `{ repo, event, sha }` to all connected runtimes
- No storage, no message routing, no state beyond open connections
- Cordfuse operates `relay.crosstalk.dev` as a free public instance
- Self-hostable for private deployments

---

## Module Responsibilities

| Module | Owns |
|--------|------|
| `index.ts` | Boot sequence, wiring, graceful shutdown |
| `config.ts` | Config loading and validation — one authoritative parse |
| `registry.ts` | Actor definitions — loading, merging, hot-reload |
| `watcher.ts` | Filesystem event routing — dedup, cursor guard, targeting |
| `dispatch.ts` | Process lifecycle — spawn, timeout, stdout capture, commit |
| `git.ts` | All git I/O — nothing else touches git |
| `cursor.ts` | All cursor I/O — nothing else touches cursor files |
| `system.ts` | Identity (MACHINE_ID, SESSION_ID) and system event writing |
| `webhook.ts` | HTTP webhook server — deprecated in v0.4 |
| `relay.ts` | (v0.4) WebSocket relay client |
| `frontmatter.ts` | YAML frontmatter parsing — used by registry, watcher, startup scan |

---

## Open Items

- Relay implementation (v0.4.0) — see above
- Webhook deprecation path — keep behind `webhook-port` config flag for v0.4, remove in v0.5
- `crosstalk` binary (`bun build --compile`) — one-file distribution, no Bun runtime dep on target machine. Targeted for v1.0.
- Full CLI (`crosstalk watch start/stop/status`, `crosstalk actor list`, etc.) — v1.0
- GitHub event routing (v0.3.1+) — translate push/PR/issue events into channel messages. Currently the webhook only triggers a pull; the event-to-message translation is not implemented.
