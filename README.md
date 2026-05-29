# @cordfuse/crosstalk-runtime

The scheduler for Crosstalk. It watches a transport repo, finds unread messages, sends them to the right agent CLI (Claude, Gemini, agy, etc.), and commits replies back.

**Haven't set up a transport yet?** Start there first → [cordfuse/crosstalk](https://github.com/cordfuse/crosstalk)

---

## Install

```sh
npm install -g @cordfuse/crosstalk-runtime
```

Puts `crosstalk` (and the alias `ct`) on your PATH.

---

## Quickstart

Run this inside your cloned transport repo:

```sh
crosstalk init
```

This creates a channel, commits it to the transport, and writes a starter config to `~/.crosstalk/<repo-name>/config.yaml`. Edit the config to set your agents, then:

```sh
crosstalk --config ~/.crosstalk/<repo-name>/config.yaml
```

---

## Two ways to run it

### Config Mode (recommended)

Point it at a YAML file:

```sh
crosstalk --config path/to/config.yaml
```

### Flag Mode (quick test, no config file needed)

```sh
crosstalk --transport ./my-transport --agent "concierge:claude --print" --agent "engineer:agy --print"
```

---

## config.yaml reference

### Minimal config

The only required fields are `transport` and at least one agent with a `name` and `cli`.

```yaml
transport: ../my-transport

agents:
  - name: concierge
    cli: claude --print

  - name: engineer
    cli: claude --print
```

With this config the runtime will:
- Discover all channels in the transport automatically
- Load each agent's system prompt from `manifest/custom/actors/<name>.md`
- Set the git commit identity from the actor file's alias (falls back to `<name>@crosstalk.local`)
- Poll every 60 seconds per agent
- Include the last 20 messages as context

### Full config reference

```yaml
# ── Required ──────────────────────────────────────────────────────────────────

transport: <string>
# Path to the transport repo. Absolute or relative to this config file.

# ── Top-level options (all optional) ──────────────────────────────────────────

channelsDir: data/channels
# Where to look for channels, relative to the transport root.
# Default: "data/channels"

interval: 60
# How often each agent polls for new messages, in seconds.
# Default: 60

jitter: 5000
# Max milliseconds to wait before pushing a commit.
# Used when tokn is not configured.
# Default: 5000

tokn:
  # Optional. Enables tokn for push serialization instead of jitter.
  # API key is read from the TOKN_API_KEY environment variable.
  url: <string>
  channel: <string>

# ── agents ────────────────────────────────────────────────────────────────────

agents:
  - name: <string>
    # Required. Must match the `to:` field in incoming messages.

    cli: <string>
    # Required. The shell command used to invoke this agent.
    # The runtime pipes the conversation to stdin and reads the reply from stdout.

    interval: <integer>
    # Override the top-level poll interval for this agent only.

    channels:
      - <guid>
    # Restrict this agent to specific channel GUIDs.
    # Omit to let it see all channels.

    systemPromptFile: <string>
    # Path to the system prompt file, relative to the transport root.
    # Default: manifest/custom/actors/<name>.md

    contextWindow: <integer>
    # How many prior messages to include as context.
    # Default: 20

    git:
      name: <string>
      email: <string>
    # Set an explicit git commit identity for this agent.
    # Overrides the actor file's alias.

    spawnCwd: <string>
    # Working directory for the agent CLI subprocess.
    # Default: transport root (so the agent boots inside the repo and can read/write files directly)
```

---

## Instance groups

Multiple agents sharing the same `name:` form an **instance group**. The runtime dispatches each incoming message to exactly one instance, chosen by `sha256(message_path).first_32_bits mod group_size`. Use this when you want N parallel workers under one logical actor — load balancing without a coordinator.

```yaml
agents:
  - name: junior-developer
    cli: claude --model claude-haiku-4-5 --print
    systemPromptFile: manifest/custom/actors/junior-developer.md
  - name: junior-developer
    cli: claude --model claude-haiku-4-5 --print
    systemPromptFile: manifest/custom/actors/junior-developer.md
  - name: junior-developer
    cli: claude --model claude-haiku-4-5 --print
    systemPromptFile: manifest/custom/actors/junior-developer.md
```

Three entries with the same `name:` form an instance group of size 3.

**Properties:**

- **Deterministic** — every instance computes the same chosen index for the same message, so exactly one ever dispatches. No double-handling.
- **Retry-stable** — the same message always selects the same instance, so re-ticks after a failed dispatch hit the same dispatcher.
- **Per-instance state** — each instance has its own cursor file at `<transport>/.cursor/<name>#<index>/<channel>/`, so internal read state never collides. Cursors are tracked by position in `agents:`.
- **Transport-visible identity** — all instances sign messages and commits as the shared `name`. The group is one actor on the wire.

### Picking the model

Model selection lives in each entry's `cli:` string. Every supported AI CLI takes a model flag:

| Provider | Example |
|---|---|
| Claude Code | `claude --model claude-haiku-4-5 --print` |
| Codex CLI | `codex exec --model gpt-5-turbo --skip-confirmations` |
| Gemini CLI | `gemini --model gemini-2.5-pro -p` |
| OpenCode | `opencode --model llama3:70b -r` |
| Qwen Code | `qwen --model qwen-coder-3 -i` |
| Antigravity (`agy`) | `agy --model agy-pro --print` |

Mix model tiers in one group by varying `cli:` per entry. The hash distributes messages evenly across all entries; mix ratio = entry-count ratio.

### Limitations

- **Single-operator only.** Multi-operator groups (instances spread across operators on the same transport) see disjoint rosters and would double-dispatch. Deferred.
- **Avoid reordering or deleting middle entries while the daemon is running.** Cursor state is keyed by position; reorder shifts every cursor's meaning. Stop, edit, restart.
- **Hot-reload across instance-count changes** initialises new positions at the channel tip — anything between the old cursor and the tip is skipped for that slot. Prefer a clean restart for instance-count changes.

For the operator-facing walkthrough, see [cordfuse/crosstalk GUIDE.md — Part 4](https://github.com/cordfuse/crosstalk/blob/main/GUIDE.md#part-4--running-multiple-instances-of-an-actor-optional).

---

## Push coordination with tokn

When multiple agents commit to the same transport at the same time, git push conflicts can occur. The runtime handles this with jitter by default — each agent waits a random amount of time before pushing, which reduces collisions but does not eliminate them under load.

[cordfuse/tokn](https://github.com/cordfuse/tokn) solves this properly. It is a lightweight turn coordinator: agents queue up, take turns pushing one at a time, and release. Zero conflicts by design.

tokn is opt-in. If you only run one agent, jitter is fine. If you run multiple agents or have a busy transport, tokn is worth setting up.

### Deploy your own tokn instance

tokn is designed to be self-hosted. Each operator runs their own instance — your instance, your key, your channels. Do not share an instance with other operators.

**On Render (recommended, free tier works):**

1. Fork [github.com/cordfuse/tokn](https://github.com/cordfuse/tokn) to your own GitHub account
2. Go to [render.com](https://render.com) and create a new **Web Service**, connecting your fork
3. Render will detect the `render.yaml` automatically and pre-fill the settings
4. Add one environment variable in the Render dashboard:
   ```
   TOKN_API_KEY = <a secret you generate>
   ```
   Generate a good one: `openssl rand -hex 32`
5. Deploy. Render gives you a URL like `https://your-service.onrender.com`

That is your tokn instance. Only you have the API key.

### Configure the runtime to use it

Add a `tokn:` block to your `config.yaml`:

```yaml
transport: ../my-transport

tokn:
  url: https://your-service.onrender.com
  channel: crosstalk:push

agents:
  - name: concierge
    cli: claude --print
```

Set your API key as an environment variable before running the runtime:

```sh
export TOKN_API_KEY=your-secret-key
crosstalk --config config.yaml
```

The runtime reads `TOKN_API_KEY` automatically — no need to put it in the config file.

---

## CLI flags

```
--config <path>         Load config from a YAML file (default: config.yaml)
--transport <path>      Path to the transport repo
--agent "name:cli"      Agent definition — repeat for multiple agents
--tokn-url <url>        tokn server URL for push serialization
--tokn-channel <name>   tokn channel name (default: crosstalk:push)
--interval <seconds>    Tick interval per agent (default: 60)
--jitter <ms>           Max jitter for fallback push, in ms (default: 5000)
--channels-dir <path>   Channels directory, relative to transport (default: data/channels)
```

---

## Requirements

- Node.js >= 18
- A Crosstalk v2 transport → [cordfuse/crosstalk](https://github.com/cordfuse/crosstalk)
- At least one agent CLI installed and authenticated (`claude`, `agy`, etc.)

---

## License

MIT
