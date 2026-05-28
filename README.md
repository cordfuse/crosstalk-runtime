# @cordfuse/crosstalk-runtime

The Crosstalk v2 runtime. A lean scheduler that dispatches agent CLIs (Claude, Gemini, agy, etc.) on a shared git transport.

---

## Install

```sh
npm install -g @cordfuse/crosstalk-runtime
```

Puts `crosstalk` (and the alias `ct`) on your PATH.

---

## Quickstart

```sh
# 1. Create a config file
cp config.example.yaml config.yaml

# 2. Set the transport path and add your agents (see below)
# 3. Run
crosstalk --config config.yaml
```

---

## Usage

The runtime supports two modes: **Config Mode** (YAML) and **Flag Mode** (CLI-only).

### Config Mode (Recommended)
```sh
crosstalk --config path/to/config.yaml
```

### Flag Mode (Zero-config)
```sh
crosstalk --transport ./my-repo --agent "concierge:claude --print" --agent "engineer:agy --print"
```

---

## config.yaml Reference

### Minimal config

Two required fields per agent. Everything else is auto-discovered or defaulted.

```yaml
transport: ../my-transport

agents:
  - name: concierge
    cli: claude --print

  - name: engineer
    cli: claude --print
```

The runtime will:
- Discover all channels in the transport automatically.
- Load the system prompt from `manifest/custom/actors/<name>.md`.
- Derive the git identity from the actor file's `metadata.alias`.
- Use `/tmp` as the CLI working directory.
- Poll every 60 seconds per agent.

### Full config reference

```yaml
# ── Required ────────────────────────────────────────────────────────────────

transport: <string>
# Path to the transport repo. Absolute or relative to config.yaml.

# ── Top-level options (all optional) ────────────────────────────────────────

channelsDir: data/channels
# Path to the channels directory, relative to the transport root.
# Default: "data/channels"

interval: 60
# How often each agent polls for new messages, in seconds.
# Default: 60

jitter: 5000
# Maximum milliseconds to sleep before pushing a commit.
# Used as fallback when no tokn: block is set.
# Default: 5000

tokn:
  url: <string>
  channel: <string>
  # Optional. When set, push serialization uses tokn instead of jitter.
  # apiKey is read from the TOKN_API_KEY environment variable.

# ── agents (required, non-empty array) ───────────────────────────────────────

agents:
  - name: <string>
    # Required. Participant name (must match `to:` in messages).

    cli: <string>
    # Required. The shell command used to invoke the agent.
    # The runtime pipes the conversation context to stdin and reads the reply from stdout.

    interval: <integer>
    # Optional. Override the top-level interval for this agent.

    channels:
      - <guid>
    # Optional. Restrict this agent to specific channel GUIDs.

    systemPromptFile: <string>
    # Optional. Path to system prompt, relative to transport root.
    # Default: manifest/custom/actors/<name>.md

    contextWindow: <integer>
    # Optional. Number of prior messages to include as context.
    # Default: 20

    git:
      name: <string>
      email: <string>
    # Optional. Explicit git commit identity.

    spawnCwd: <string>
    # Optional. Working directory for the CLI subprocess.
    # Default: /tmp
```

---

## CLI Flags

```
--config <path>         Load config from YAML file (default: config.yaml)
--transport <path>      Path to transport repo (Flag Mode)
--agent "name:cli"      Agent definition; repeat for multiple agents
--tokn-url <url>        tokn server URL for push serialization
--tokn-channel <name>   tokn channel name (default: crosstalk:push)
--interval <seconds>    Tick interval per agent (default: 60)
--jitter <ms>           Max jitter ms for fallback push (default: 5000)
--channels-dir <path>   Channels dir relative to transport (default: data/channels)
```

---

## Requirements

- **Node.js >= 18**
- A **Crosstalk v2** transport repo ([cordfuse/crosstalk](https://github.com/cordfuse/crosstalk))
- At least one **agent CLI** installed and authenticated (`claude`, `agy`, etc.)

---

## License

MIT
