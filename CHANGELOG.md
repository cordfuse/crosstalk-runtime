# Changelog

All notable changes to `@cordfuse/crosstalk-runtime`.

## v3.9.1 — 2026-06-02

**Fix: path separator bugs on Windows** — `open.ts` and `install.ts` used `split('/')` and `endsWith('/' + name)` to extract and match the last path component. Both break on Windows (backslash separators). Replaced with `path.basename()` throughout. Also replaced the equivalent logic in `runAddTransport`, `runAddWorkspace`, and `runStatus` in install.ts.

**CI: Windows smoke test is now mandatory** — removed `continue-on-error: true` and the stale turnq FFI comment. `@cordfuse/turnq` uses an in-process JS mutex (`coordinator-node.js`) with no POSIX FFI dependency; the Windows binary passes `--version` and `--help` cleanly.

## v3.9.0 — 2026-06-02

**Windows compatibility** — the daemon and all operator commands now run on Windows.

- **Wake signal**: Unix domain socket (`/tmp/crosstalk.wake`) replaced with a named pipe (`\\.\pipe\crosstalk-wake`) on Windows; `unlinkSync`/`chmodSync` skipped on Windows (named pipes don't need them)
- **Install**: `GIT_SSH_COMMAND` is now passed via the `env` option to `execSync` instead of as a shell variable prefix (the shell prefix syntax doesn't work in Windows cmd); `cp` → `fs.copyFileSync`; `which` → `where` on Windows; `rm -rf` → `fs.rmSync({ recursive: true, force: true })` for `--purge`; `chmodSync` on the binary skipped on Windows
- **`crosstalk auth`**: prints a clear error on Windows explaining that CLI authentication must be done manually (uid/gid/chown not available)
- **`crosstalk agent`**: `requireSudo` now uses `isRoot()` (via `net session`) on Windows; uid/gid are omitted from `spawnSync` on Windows (service runs as current elevated user); `rm -f` → `unlinkSync`; curl-based installs (agy) print an error with the installer URL on Windows
- **Note**: `@cordfuse/turnq` coordinator uses an in-process JS mutex — no POSIX FFI involved; the Windows FFI note in TODO was stale and has been removed

## v3.8.1 — 2026-06-02

**Fix: cursor files gitignored** — `.cursor/` was not in the transport `.gitignore`. Cursor files were committed on each write and then reset by `git reset --hard origin/main` on the next pull cycle, causing the daemon to re-scan already-processed messages every cycle (`hadWork: true` spin with no dispatches). Fix: add `.cursor/` to `.gitignore`, untrack committed cursor files with `git rm -r --cached .cursor/`.

## v3.8.0 — 2026-06-02

**`crosstalk send` + Unix wake socket** — sub-second inbound delivery on a single host.

- Daemon opens a Unix socket at `/tmp/crosstalk.wake` on startup (chmod 0666 — any local user can signal it)
- Poll sleep is now interruptible: a write to the socket cancels the current idle wait and triggers an immediate cycle
- `crosstalk send --to <actor> [--from <name>] [--channel <uuid>] [--transport <path>] <message>` — writes a message file, commits, pushes, then signals the wake socket
- `crosstalk wake` — standalone signal for when you push manually and want instant pickup
- Multi-host note: wake socket only wakes the local daemon; remote hosts still poll at their configured interval

## v3.7.0 — 2026-06-02

**Pull strategy: `fetch + reset --hard`** — replaced `git pull --rebase --autostash` with `git fetch` + `git reset --hard origin/main`. The daemon transport has no legitimate local tracked-file changes; `--autostash` caused stash-pop conflicts when a host file changed upstream at the same time as local state was stashed. `reset --hard` is predictable, conflict-free, and correct for a daemon whose transport should always mirror the remote.

**Host file hot-reload** — actor configuration is now reloaded after every pull. Adding or changing actors, CLI commands, or tier counts takes effect on the next poll cycle without restarting the daemon. A `host_file_reloaded` log event is emitted when the actor list or host alias changes.

## v3.6.0 — 2026-06-02

**Dead Letter Queue** — failed dispatches are no longer silently dropped.

- `DispatchError` thrown on CLI failure; runner catches and writes a JSON entry to `/var/lib/crosstalk/dlq/`
- Each entry records: actor, channel, messageRelPath, CLI command, error message, attempt count
- `crosstalk dlq list` — show all pending entries
- `crosstalk dlq retry <id>` — re-dispatch immediately; drops entry on success, increments attempts on failure
- `crosstalk dlq drop <id>` — discard entry
- `crosstalk dlq drop --all` — clear queue
- Cursor still advances on failure so the daemon doesn't retry endlessly

## v3.5.0 — 2026-06-02

**Structured JSON logging** — all dispatch events now emit JSON lines to stdout (journald) and `/var/lib/crosstalk/logs/crosstalk.log`.

Events: `dispatch_start`, `dispatch_complete`, `dispatch_failed`, `dispatch_skipped`, `pull_failed`, `push_complete`, `push_failed`, `poll_cycle`.

Each dispatch event carries a deterministic `trace` field (sha256 of the message path, first 8 chars) for cross-event correlation. Example:

```json
{"ts":"2026-06-02T12:39:51Z","level":"info","event":"dispatch_start","actor":"junior-developer","channel":"a3e6e4c1","trace":"d81dfe9c","cli":"claude","msg":"2026/06/02/mc4-01.md"}
{"ts":"2026-06-02T12:39:54Z","level":"info","event":"dispatch_complete","actor":"junior-developer","channel":"a3e6e4c1","trace":"d81dfe9c","durationMs":2841}
```

## v3.4.1 — 2026-06-01

**`git pull --autostash`** — pull now passes `--autostash` so unstaged local changes (cursor files, temp state) no longer silently block the poll cycle. Previously the daemon appeared to start but never dispatched after accumulating any local writes.

## v3.4.0 — 2026-06-01

**`crosstalk agent install/upgrade/uninstall/list`** — manages agent CLIs in the daemon user home so the daemon is fully self-contained.

```sh
sudo crosstalk agent install claude    # npm install -g @anthropic-ai/claude-code → /var/lib/crosstalk/.local/bin/
sudo crosstalk agent install agy       # curl installer → same bin dir
sudo crosstalk agent upgrade claude    # re-installs latest
sudo crosstalk agent uninstall claude  # removes from daemon home
crosstalk agent list                   # shows installed/missing for all known agents
```

Supported agents: `claude`, `agy`, `gemini`, `codex`, `qwen`, `opencode`.

**`crosstalk auth` fix** — `mkdirSync` runs as root; any credential subdirs it created were root-owned and unreadable by the daemon user. Auth now chowns `$HOME/.claude`, `.config`, `.gemini`, `.local`, and `.npm` to the daemon user before spawning the CLI.

**Headless permission flags** — all CLIs require a skip-permissions flag when running headless. Quick reference:

| CLI | Flag |
|---|---|
| `claude` / `agy` | `--dangerously-skip-permissions` |
| `gemini` / `qwen` | `--yolo` |
| `codex` | `-s danger-full-access` |
| `opencode` | *(none)* |

## v3.3.0 — 2026-06-01

**`crosstalk auth <cli>`** — authenticates an agent CLI as the daemon user so the daemon can invoke it without manual credential setup.

Runs the specified CLI (e.g. `claude`, `gemini`, `agy`) as the daemon service user with `HOME` set to the daemon data directory. The operator completes whatever login flow the CLI presents — OAuth browser prompt, device code, API key entry — then exits. Credentials land in the daemon user's home and are found automatically on the next dispatch.

```sh
sudo crosstalk auth claude   # complete OAuth, then exit Claude Code
sudo crosstalk auth gemini
sudo systemctl restart crosstalk
```

Requires sudo. No API key needed for CLIs with OAuth flows.

## v3.2.0 — 2026-06-01

**Adaptive polling** — the coordinator re-polls after 1 second when a cycle dispatched work, falling back to the full quiet interval only when the transport has nothing new. During active conversations the daemon picks up follow-up messages nearly immediately instead of waiting for the next tick.

Default interval reduced from 60s → 30s. Operators running high-throughput workloads can set `interval: 5` in their local config.

## v3.1.1 — 2026-06-01

Reverts the marching orders feature (v3.1.0) — the use case for persistent per-actor directives stored in the transport does not exist yet. `crosstalk open` is the marching orders mechanism: the message you send at session open is the directive. No protocol change; README updated to make this explicit.

## v3.1.0 — 2026-06-01

*(Reverted in v3.1.1)* Marching orders CLI — `crosstalk orders set/show/clear <actor>` stored operational directives in `manifest/orders/<actor>.md` and injected them at dispatch between standing orders and conversation context.

## v3.0.6 — 2026-06-01

Windows one-liner installer (`install.ps1`) — elevation check, fetches latest release from GitHub API, downloads and silently runs the Inno Setup `.exe`, prints next steps. README install section split by platform: Linux/macOS `curl` vs Windows `iex (irm ...)`. Prompt-driven orchestration framing added to README.

## v3.0.5 — 2026-06-01

**Fix: npm publish** — `continue-on-error: true` on the publish step so a missing token does not fail the release workflow.

## v3.0.4 — 2026-06-01

**Fix: CI** — gate npm publish on `env.NPM_TOKEN` (not `secrets.NPM_TOKEN` — secrets context is invalid in step `if` conditions).

## v3.0.3 — 2026-06-01

**Fix: CI** — disable RPM strip/debuginfo hooks that corrupt the cross-architecture Bun binary during `.rpm` packaging.

## v3.0.2 — 2026-06-01

**Fix: CI** — `mkdir -p usr/bin` in `build-deb.sh`; skip Windows smoke test (turnq FFI requires `libc.so.6`, absent on Windows runners).

## v3.0.1 — 2026-06-01

**Fix: legacy config path** — resolve `config.transport` → `config.transports[0].path` in `startAgent` for operators migrating from v2 single-transport configs. Windows Inno Setup installer added to CI (package-windows job).

## v3.0.0 — 2026-06-01

**System daemon rewrite.** Crosstalk Runtime v3 installs as a native system service and ships as platform packages instead of an npm global.

- **Install wizard** (`sudo crosstalk install <git-url>`) — clones transport, installs binary, registers systemd/launchd/Windows service, generates SSH key
- **Native packages** — `.deb` (Debian/Ubuntu), `.rpm` (Fedora/RHEL), `.pkg.tar.zst` (Arch/CachyOS), Homebrew formula (macOS), Inno Setup `.exe` (Windows); pipe installer (`install.sh` / `install.ps1`) detects platform and installs the right package
- **Operator commands** — `add-workspace`, `remove-workspace`, `status`, `open`, `init`, `uninstall`
- **`crosstalk open`** — opens an interactive session with the concierge (or any actor/tier) in the context of a registered workspace; strips headless flags so the agent CLI runs interactively
- **Multi-transport** — `add-transport` / `remove-transport`; daemon polls all registered transports concurrently
- **Host files** — actor and tier configuration lives in `manifest/hosts/<alias>.md` in the transport (shared, visible to all operators); local config shrinks to transport path + host alias
- **`crosstalk init`** — interactive scaffold: prompts for host alias, actor name, CLI command; writes host file to transport, commits, pushes
- **v2 legacy compatibility** — `agents:` array in local config still works; daemon prints `[v2 legacy]` banner

## v2.4.3 — 2026-05-31

**Fix: CI packaging** — switch `@cordfuse/turnq` dependency from `file:../turnq` to the npm-published `^0.3.3`. The local path reference caused CI builds to fail (sibling directory absent in the runner), which prevented 2.3.0–2.4.2 from publishing to npm. First npm-published release since v2.2.0.

## v2.4.2 — 2026-05-31

**Fix: JobQueue duplicate detection missed in-flight jobs** — `enqueue()` now checks both pending and in-flight sets before accepting a job. `complete()` signature changed to accept the full `Job` object so the in-flight key can be released correctly.

## v2.4.1 — 2026-05-31

**Multi-user host support** — host file auto-detection now considers `username` alongside `hostname`:

- `HostFile` interface gains optional `username` field (`os.userInfo().username`)
- `findHostFile()` matches `username + hostname` before falling back to bare `hostname`; explicit `host:` override still takes precedence
- `crosstalk init` writes `username:` into the generated host file and uses OS username as the default alias suggestion
- Single-user hosts with no `username:` field continue to work unchanged

## v2.4.0 — 2026-05-31

**v3 coordinator runtime** — host-file mode now uses a single job-queue coordinator instead of N per-agent polling loops:

- `JobQueue` class: per-actor pending + in-flight tracking; `drain()` returns up to `totalCount` concurrent jobs; `complete()` decrements on finish
- `dispatchSingle()`: processes one message without outer loop or hash-based instance selection — queue guarantees exactly-once delivery
- Coordinator loop: pulls git once per cycle, scans all channels × actors, enqueues unread messages, dispatches concurrently up to each actor's tier sum, awaits all in-flight jobs before sleeping
- Workers are ephemeral — spawned per message, not long-running pollers
- Legacy `agents:` list mode still runs the v2 per-agent `setInterval` path (backward-compatible)
- Version banner distinguishes `[v3]` vs `[v2 legacy]`

## v2.3.0 — 2026-05-31

**Interactive `crosstalk init`** — init now scaffolds a host file instead of generating a legacy `agents:` config:

- Prompts for host alias (default: `os.hostname()`), actor name (default: `concierge`), and CLI command (default: `claude --print`)
- Creates `manifest/hosts/<alias>.md` with the declared actor and tier, commits it to the transport, and pushes
- Writes a thin local config (`transport:` + `host:`) instead of the old `agents:` array
- Closes the onboarding gap where operators had to create host files manually after init

## v2.2.0 — 2026-05-29

**Host file support** — the runtime now reads actor configuration from `manifest/hosts/<alias>.md` in the transport instead of requiring an `agents:` list in the local config:

- Host file reader: scans `manifest/hosts/`, parses `alias`/`hostname`/`actors` frontmatter
- Auto-detection: matches `os.hostname()` against `hostname:` fields; explicit `host:` in local config overrides
- Tier expansion: each tier × `count` becomes one polling worker. Shorthand (bare CLI string) = `count: 1`
- `actor@host` addressing: runtime skips messages targeted at a different host alias
- Git commit email now includes host alias: `actor@hostalias.crosstalk.local`
- Startup failure mode: if no host file is found, logs clearly and idles without crashing
- Legacy `agents:` array in config.yaml still works for single-machine setups and flag mode

Protocol: [cordfuse/crosstalk v2.2.0](https://github.com/cordfuse/crosstalk/releases/tag/v2.2.0)

## v2.1.2 — 2026-05-29

Docs-only patch. Added instance groups section to README.

## v2.1.1 — 2026-05-29

Instance groups: shared-name dispatch via `sha256(message_path) mod group_size`. Replaced pool routing.

## v2.1.0 — 2026-05-29

Pool routing (deprecated — replaced by v2.1.1 before any operator adopted it).

## v2.0.9 — 2026-05-28

Bug fixes: persona alias in git identity, CLI arg quoting, stderr capture, empty reply warning.
