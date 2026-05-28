# @cordfuse/crosstalk-runtime

The Crosstalk v2 runtime. Watches a git-backed transport for new messages and dispatches them to agent CLIs on a schedule.

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

## config.yaml reference

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
- Discover all channels in the transport automatically
- Load the system prompt from `manifest/custom/actors/<name>.md` in the transport
- Derive the git commit identity from the actor file's `metadata.alias` field
- Use `/tmp` as the CLI working directory (prevents CLAUDE.md interference)
- Poll every 60 seconds per agent

---

### Full config reference

```yaml
# ── Required ────────────────────────────────────────────────────────────────

transport: <string>
# Path to the transport repo. Absolute or relative to config.yaml.
# The transport is a git repo that follows the Crosstalk v2 layout:
#   data/channels/<guid>/YYYY/MM/DD/<filename>.md

# ── Top-level options (all optional) ────────────────────────────────────────

channelsDir: data/channels
# Path to the channels directory, relative to the transport root.
# Default: "data/channels"
# Change this only if your transport uses a non-standard layout.

interval: 60
# How often each agent polls for new messages, in seconds.
# Default: 60
# Can be overridden per agent.

jitter: 5000
# Maximum milliseconds to sleep before pushing a commit.
# Used as fallback when no tokn: block is set.
# The actual sleep is a random value between 0 and this number.
# Default: 5000 (5 seconds)

tokn:
  url: <string>
  channel: <string>
  # Optional. When set, push serialization uses tokn instead of jitter.
  # url:     the tokn server URL (e.g. https://tokn-pqgp.onrender.com)
  # channel: the named turn channel shared across all agents (e.g. crosstalk:push)
  # apiKey is read from the TOKN_API_KEY environment variable.
  #
  # With tokn: zero push conflicts, strict FIFO, 13× faster than jitter under load.
  # Without tokn: falls back to jitter (random sleep + rebase-retry).

# ── agents (required, non-empty array) ───────────────────────────────────────

agents:
  - name: <string>
    # Required. The agent's participant name — must match the `to:` field in
    # messages addressed to this agent. Also used to locate the actor file and
    # derive the git commit identity.

    cli: <string>
    # Required. The shell command used to invoke the agent.
    # The runtime pipes the rendered conversation context to stdin and reads
    # the reply from stdout.
    #
    # Examples:
    #   cli: claude --print
    #   cli: agy --print
    #   cli: gemini -p
    #
    # The command is split on whitespace. Arguments with spaces are not
    # currently supported — use a wrapper script if needed.

    interval: <integer>
    # Optional. Override the top-level interval for this agent only.
    # Default: inherits top-level interval (60 if not set there either).

    channels:
      - <guid>
      - <guid>
    # Optional. Restrict this agent to specific channel GUIDs.
    # Default: the agent watches ALL channels found in channelsDir.
    #
    # Use this when you have multiple channels in one transport and want
    # specific agents to only respond in certain channels.
    #
    # Channel GUIDs are the directory names under channelsDir, e.g.:
    #   adfe0356-0f71-49a9-80a0-fb76883cd974

    systemPromptFile: <string>
    # Optional. Path to the actor's system prompt file, relative to the
    # transport root.
    # Default: manifest/custom/actors/<name>.md
    #
    # The file content is prepended to stdin before the conversation context.
    # If the file is not found, the agent runs without a system prompt (warning
    # is logged).

    contextWindow: <integer>
    # Optional. Number of prior messages to include as context for each dispatch.
    # Default: 20
    #
    # Higher values give the agent more conversational history but increase
    # the size of each CLI invocation.

    git:
      name: <string>
      email: <string>
    # Optional. Git commit identity for this agent's replies.
    # Default: derived from the actor file's metadata.alias field.
    #   - name:  "<alias> (<agent-name>)"  e.g. "Cass (concierge)"
    #   - email: "<agent-name>@crosstalk.local"
    # If no actor file exists, falls back to just the agent name and default email.
    #
    # Use this to override the derived identity, e.g. for a real email address
    # or a display name that differs from the actor file.

    spawnCwd: <string>
    # Optional. Working directory for the CLI subprocess.
    # Default: /tmp
    #
    # The default of /tmp prevents the CLI from picking up CLAUDE.md files
    # in your project directories. Only change this if your CLI requires a
    # specific working directory (e.g. a custom binary that reads relative paths).
```

---

### Full example

```yaml
transport: /home/alice/repos/my-transport
channelsDir: data/channels
interval: 60
jitter: 3000

tokn:
  url: https://tokn-pqgp.onrender.com
  channel: crosstalk:push

agents:
  - name: concierge
    cli: claude --print
    interval: 30

  - name: engineer
    cli: claude --print
    interval: 120
    channels:
      - adfe0356-0f71-49a9-80a0-fb76883cd974

  - name: ops-bot
    cli: agy --print
    systemPromptFile: prompts/ops.md
    git:
      name: Ops Bot
      email: ops@mycompany.com
    spawnCwd: /home/alice/repos/my-transport
```

---

## How auto-discovery works

### Channels

On startup, the runtime lists all subdirectories of `<transport>/<channelsDir>/`. Each subdirectory is a channel. Agents watch all discovered channels unless `channels:` is set.

New channels created after the runtime starts are not picked up until restart.

### System prompt

The runtime looks for `<transport>/manifest/custom/actors/<name>.md`. If found, the full file content is prepended to the stdin of every CLI invocation for that agent.

This follows the Crosstalk transport layout convention. Actor files use YAML frontmatter:

```markdown
---
name: concierge
metadata:
  alias: Cass
  author: cordfuse
  domain: general
  type: actor
---

## System Prompt
You are Cass. You are the general-purpose worker...
```

### Git identity

If `git:` is not set in the config, the runtime reads the actor file and uses:
- `name`: `<alias> (<agent-name>)` — e.g. `Cass (concierge)`
- `email`: `<agent-name>@crosstalk.local`

If no actor file exists, it falls back to the agent name and default email.

---

## Dispatch loop

Per agent, per tick:

```
1. git pull --rebase origin main
2. For each channel:
   a. List all message files in YYYY/MM/DD order
   b. Read cursor — skip messages already processed
   c. For each unread message:
      - Skip if type != text
      - Skip if not addressed to this agent (to: <name> or to: all)
      - Build context: last N messages rendered as plain text
      - Pipe system prompt + context to CLI stdin
      - Capture stdout → write as reply message file
      - Write read receipt
   d. Stage all new files
   e. Commit + push:
      — tokn: enqueue, wait for turn, pull → commit → push, release (zero conflicts)
      — jitter fallback: sleep random(0, jitter) ms, push, rebase-retry on conflict
   f. Advance cursor on successful push
```

---

## Cursor files

The runtime tracks progress in `.cursor/<agent-name>/<channel-guid>` inside the transport repo. These files are git-ignored and store the relPath of the last processed message.

If no cursor exists (first run), all existing messages are treated as unread. To skip the backlog, seed the cursor manually:

```sh
mkdir -p .cursor/concierge
echo "2026/05/26/150000000Z-abcdef01.md" > .cursor/concierge/adfe0356-0f71-49a9-80a0-fb76883cd974
```

---

## CLI flags

```
crosstalk --config <path>    Config file to load (default: config.yaml)
```

---

## Requirements

- Node.js >= 18
- A Crosstalk v2 transport repo (see [cordfuse/crosstalk](https://github.com/cordfuse/crosstalk))
- At least one agent CLI installed and authenticated (`claude`, `agy`, etc.)

---

## License

MIT
