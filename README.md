# crosstalk-runtime

System daemon that watches Crosstalk transport repos, dispatches messages to AI agent CLIs (Claude, Gemini, agy, etc.), and commits replies back.

**Haven't set up a transport yet?** Start there first → [cordfuse/crosstalk](https://github.com/cordfuse/crosstalk)

---

## Install

**One-line installer (all platforms):**

```sh
curl -fsSL https://github.com/cordfuse/crosstalk-runtime/releases/latest/download/install.sh | bash
```

Detects your OS and package manager, downloads the right package, and installs it.

**Manual:**

| Platform | Command |
|---|---|
| Arch / CachyOS | `sudo pacman -U crosstalk-runtime-bin-<version>-1-x86_64.pkg.tar.zst` |
| Debian / Ubuntu | `sudo apt install ./crosstalk-runtime_<version>_amd64.deb` |
| Fedora / RHEL | `sudo dnf install ./crosstalk-runtime-<version>-1.x86_64.rpm` |
| macOS (Homebrew) | `brew install cordfuse/tap/crosstalk-runtime` |
| Windows | Run `crosstalk-runtime-setup-<version>-x64.exe` as Administrator |

All packages are on the [releases page](https://github.com/cordfuse/crosstalk-runtime/releases).

---

## Quickstart

```sh
# 1. Install the daemon and clone your transport (requires sudo)
sudo crosstalk install https://github.com/you/your-transport.git

# 2. Add a project repo as a workspace
crosstalk add-workspace https://github.com/you/your-project.git

# 3. Open an interactive session with your concierge agent
crosstalk open
```

The daemon runs as a system service (`crosstalk.service`) and starts automatically on boot.

---

## Commands

### Setup (requires sudo)

```
sudo crosstalk install <git-url>          Clone primary transport, install binary, register service
sudo crosstalk uninstall [--purge]        Stop and remove the service (--purge wipes /var/lib/crosstalk)
```

### Operator day-to-day (no sudo needed)

```
crosstalk add-transport <git-url> [--name <alias>]         Register an additional transport
crosstalk remove-transport <name>                          Unregister a transport

crosstalk add-workspace <git-url> [--transport <name>]     Clone and register a project repo
crosstalk remove-workspace <name> [--transport <name>]     Unregister a workspace

crosstalk open [--transport <name>] [--workspace <name>] [--agent <name>] [--actor <name>]
                                                           Open an interactive agent session
crosstalk status                                           Show daemon state, transports, and workspaces
```

### `crosstalk open` flags

| Flag | Description |
|---|---|
| `--transport <name>` | Which transport to use (required if multiple registered) |
| `--workspace <name>` | Which workspace to open in (required if multiple in the transport) |
| `--agent <name>` | Agent tier to invoke (e.g. `claude`, `agy`) |
| `--actor <name>` | Actor to address (default: `concierge`) |

---

## Multi-transport

Each transport is an independent Crosstalk channel repo. Register as many as you like:

```sh
sudo crosstalk install https://github.com/you/transport-a.git
crosstalk add-transport https://github.com/you/transport-b.git --name work

crosstalk add-workspace https://github.com/you/project.git --transport work
crosstalk open --transport work --workspace project
```

The daemon polls all registered transports concurrently.

---

## Service management

```sh
sudo systemctl start crosstalk
sudo systemctl stop crosstalk
sudo systemctl status crosstalk
journalctl -u crosstalk -f
```

---

## SSH / Git auth

`crosstalk install` generates an SSH key at `/var/lib/crosstalk/.ssh/id_ed25519` and prints the public key. Add it to GitHub as a **user-level SSH key** (Settings → SSH and GPG keys) — one key covers all repos, no per-repo deploy keys needed.

---

## Host file

The daemon reads your machine's actor config from `manifest/hosts/<alias>.md` in the transport:

```markdown
---
alias: my-machine
hostname: my-hostname
actors:
  concierge:
    claude: claude --model claude-sonnet-4-6 --print
  engineer:
    haiku:
      cli: claude --model claude-haiku-4-5 --print
      count: 3
    gemini: gemini --model gemini-2.5-flash -p
---
```

- `alias` — human-readable name; used in `actor@host` message addressing
- `hostname` — must match `os.hostname()` on this machine
- Tier names (`claude`, `haiku`, `gemini`) are your labels mapping to CLI commands
- `count` sets parallel workers per tier; omit for a single worker

---

## Requirements

- A Crosstalk v2 transport → [cordfuse/crosstalk](https://github.com/cordfuse/crosstalk)
- At least one agent CLI installed and authenticated (`claude`, `gemini`, `agy`, etc.)
- Linux (x64/arm64), macOS (x64/arm64), or Windows x64

---

## License

MIT
