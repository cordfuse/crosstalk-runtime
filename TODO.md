# TODO — Crosstalk Runtime v3.x

## Current release: v3.9.0

v3.x is the system daemon generation. Ships as native packages (deb/rpm/pkg/Homebrew), installs via a one-line pipe installer, and runs as a system service. **Linux and macOS only — Windows users run inside WSL2 (treated as Linux).**

---

## Shipped in v3.x

- [x] System daemon — platform paths, systemd/launchd service registration
- [x] Native packaging — `.deb`, `.rpm`, `.pkg.tar.zst`, Homebrew formula
- [x] Pipe installer — `install.sh` (Linux/macOS); `install.ps1` is a WSL2 redirect stub
- [x] `sudo crosstalk install <git-url>` — clones transport, installs binary, registers service, generates SSH key
- [x] `crosstalk open` — interactive agent session in a registered workspace
- [x] `crosstalk init` — interactive host file scaffold
- [x] `crosstalk add-workspace` / `remove-workspace` / `status`
- [x] `crosstalk add-transport` / `remove-transport`
- [x] Host files (`manifest/hosts/<alias>.md`) — actor + tier config in the transport
- [x] Multi-transport — daemon polls all registered transports concurrently
- [x] v2 legacy `agents:` array compatibility
- [x] Windows support dropped — `detectPlatform()` hard-stops `win32` with a WSL2 pointer; WSL is treated as Linux (see CHANGELOG v3.11.0)
- [x] `crosstalk agent install/upgrade/uninstall/list` — daemon-local CLI management
- [x] `crosstalk auth` ownership fix — chown credential dirs to daemon user
- [x] Headless skip-permissions flags documented (claude/agy/gemini/qwen/codex)

---

## Open

- [ ] **Tests** — unit tests for `cursor.ts`, `frontmatter.ts`, `filenames.ts`, `dispatch.ts`
- [ ] **`config.example.yaml`** — keep in sync with README config reference as v3 thin-config format stabilises

---

## Deferred (v4.x)

- **Relay mode** — client/server split; `--relay` flag on the daemon exposes an HTTP endpoint for sub-second message delivery; turnq baked in as the commit serializer. Currently git round-trip is the only delivery path (~1–3s per cycle).
- **On-demand worker spawning** — job-queue model where the coordinator spawns workers per message and winds them down after; eliminates fixed polling loops for dynamic parallelism.
