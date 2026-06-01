# TODO — Crosstalk Runtime v3.x

## Current release: v3.3.0

v3.x is the system daemon generation. Ships as native packages (deb/rpm/pkg/Homebrew/Windows exe), installs via a one-line pipe installer, and runs as a system service.

---

## Shipped in v3.x

- [x] System daemon — platform paths, systemd/launchd/Windows service registration
- [x] Native packaging — `.deb`, `.rpm`, `.pkg.tar.zst`, Homebrew formula, Inno Setup `.exe`
- [x] Pipe installers — `install.sh` (Linux/macOS), `install.ps1` (Windows)
- [x] `sudo crosstalk install <git-url>` — clones transport, installs binary, registers service, generates SSH key
- [x] `crosstalk open` — interactive agent session in a registered workspace
- [x] `crosstalk init` — interactive host file scaffold
- [x] `crosstalk add-workspace` / `remove-workspace` / `status`
- [x] `crosstalk add-transport` / `remove-transport`
- [x] Host files (`manifest/hosts/<alias>.md`) — actor + tier config in the transport
- [x] Multi-transport — daemon polls all registered transports concurrently
- [x] v2 legacy `agents:` array compatibility

---

## Open

- [ ] **Tests** — unit tests for `cursor.ts`, `frontmatter.ts`, `filenames.ts`, `dispatch.ts`
- [ ] **Windows FFI** — turnq uses `libc.so.6` (POSIX only); Windows smoke test skipped in CI. Port to `LockFileEx` when Windows operator support is a real requirement.
- [ ] **`config.example.yaml`** — keep in sync with README config reference as v3 thin-config format stabilises

---

## Deferred (v4.x)

- **Relay mode** — client/server split; `--relay` flag on the daemon exposes an HTTP endpoint for sub-second message delivery; turnq baked in as the commit serializer. Currently git round-trip is the only delivery path (~1–3s per cycle).
- **On-demand worker spawning** — job-queue model where the coordinator spawns workers per message and winds them down after; eliminates fixed polling loops for dynamic parallelism.
