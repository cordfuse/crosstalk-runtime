# Crosstalk v2 — Back to Basics

## What went wrong

Crosstalk started as a clean idea: a git repo as a shared, append-only message bus
that humans and AI agents can both read and write. 10 source files. ~900 lines.

Over 18 versions it accumulated a governance coordination layer (bootstrap, ROE,
session-open, quorum, decay), multi-operator qualified addressing, cryptographic
signing, a WebSocket relay infrastructure, a Transport abstraction layer, pool
actors, dispatch policies, actor personality frameworks, and an orchestration
engine with thread state persistence.

None of that was in the original plan. Most of it belongs in Politik, not here.

v2 removes it all.

---

## What Crosstalk actually is

A protocol. A shared file format over git that lets humans and agents communicate
asynchronously. No special software required to participate beyond git itself.

The spec is the product.

---

## Core decisions

**Git is the only transport.**
The git repo is the bus. Append-only, conflict-resistant, every participant has a
full copy, history is auditable. No abstraction layer. No filesystem-only mode —
`git init` costs nothing.

**No daemon. No relay. No runtime.**
There is nothing to run. Agents read the channel on their own schedule. Humans
post messages via chat or directly. If polling is needed, a cron job or git hook
is sufficient — that is not Crosstalk's concern.

**No CLI.**
Anything a CLI can do, a chat session with an agent can do better. The agent
reads the spec, writes the frontmatter, commits, pushes. The spec is the
interface.

**No actor personalities or framework actors.**
Who an actor is, what they know, how they respond — that belongs to the operator's
agent configuration (CLAUDE.md, system prompts, etc.). Crosstalk does not model it.

**No governance, no Politik concepts.**
ROE, session-open, bootstrap, quorum, decay, voting — none of that is here.
That layer belongs in Politik, sitting above Crosstalk if and when it exists.

**Names, not taxonomy.**
Participants are identified by free-form names chosen by the operator. `alice`,
`concierge`, `ops-bot`. No species, no roles, no hierarchy. `to: all` is the
only reserved value.

**Git identity is the identity.**
Each participant commits under their own git config (`user.name`, `user.email`).
The `from:` frontmatter field and the commit author match. Tamper evidence is
free — git already tracks it. No signing infrastructure needed.

---

## The spec

### Channel layout

```
<transport>/
  channels/
    <guid>/
      YYYY/
        MM/
          DD/
            HHMMSSsssZ-<hex>.md
  CROSSTALK-VERSION
```

### Message format

Every message is a markdown file with YAML frontmatter:

Single recipient:

```
---
from: alice
to: concierge
type: text
timestamp: 2026-05-23T19:00:00.000Z
---

Message body here.
```

Multiple recipients (YAML list, inline or block form both valid):

```
---
from: alice
to: [concierge, ops-bot]
type: text
timestamp: 2026-05-23T19:00:00.000Z
---

Message body here.
```

Broadcast:

```
---
from: alice
to: all
type: text
timestamp: 2026-05-23T19:00:00.000Z
---

Message body here.
```

### Frontmatter fields

| Field | Required | Values | Notes |
|---|---|---|---|
| `from` | yes | free-form name | must match git commit author |
| `to` | yes | name, list of names, or `all` | `all` = every participant; single name and list are equivalent for one entry |
| `type` | yes | `text`, `read` | see Message types |
| `timestamp` | yes | ISO 8601 UTC | |
| `ref` | conditional | relPath of original message | required when `type: read` |

That's it. No other fields are part of the spec.

### Message types

**`type: text`** — a normal message. Body is the message content.

**`type: read`** — a read receipt. Posted by a participant to acknowledge they have
consumed a specific message. Body is empty or omitted. The `ref` field contains the
`relPath` of the message being acknowledged (`YYYY/MM/DD/HHMMSSsssZ-<hex>.md`).

```
---
from: concierge
to: alice
type: read
timestamp: 2026-05-23T19:01:00.000Z
ref: 2026/05/23/190000000Z-a1b2c3d4.md
---
```

Read receipts are optional. Senders cannot require them. Participants who do not post
them are not violating the protocol. Readers who want acknowledgment visibility scan
the channel for `type: read` messages whose `ref` matches the message they care about.

### Privacy model

`to` is a routing hint, not an access control boundary. Every message in the channel
is visible to anyone with read access to the git repository. Crosstalk provides no
confidentiality guarantees.

Participants are expected to ignore messages not addressed to them. That is a
convention, not enforcement — the protocol does not and cannot prevent a participant
from reading messages addressed to others.

There are no whisper or ephemeral message types. Operators who require confidentiality
must secure the repository itself (private repo, access controls) or encrypt message
bodies outside the protocol.

### `to` field rules

- A single string value targets one participant: `to: concierge`
- A YAML list targets multiple: `to: [concierge, ops-bot]` or block form
- The string `all` targets every participant in the channel
- Readers filter: a message is relevant to you if your name appears in `to`, or if `to` is `all`
- `from` is never implicitly included in `to` — senders do not receive their own messages

### Reserved values

- `to: all` — addressed to every participant in the channel
- `CROSSTALK-VERSION` — semver string, declares protocol version

### Git identity

Each participant configures their own git identity before writing to the transport.
Machine actors use synthetic identities (`concierge@crosstalk.local` or operator-
defined). The operator sets these up once. How is outside the spec.

### CROSSTALK-VERSION

A plain text file at the transport root containing a semver string. This is a hard
version boundary — readers encountering a version other than `2.0` must not process
messages and should surface an incompatibility error. Writers must set it to `2.0`
when initialising a transport.

Current version: `2.0`

---

## What is explicitly out of scope

- Daemon / persistent watcher
- Relay server / WebSocket
- Actor dispatch
- Actor personalities / system prompts / skill assignments
- Governance (ROE, quorum, voting, bootstrap coordination)
- Multi-operator qualified addressing
- Dispatch policies
- Cryptographic signing
- Pool actors
- Orchestration (spawn / thread / join / synthesizer)
- CLI tooling

Operators who need any of the above build it themselves on top of the protocol,
or wait for Politik.

---

## What v2 ships

1. This document (the spec)
2. An example transport with one channel and a few messages
3. `CROSSTALK-VERSION` set to `2.0`
4. A one-page README that explains the whole thing

No code. No package. No runtime.

---

## Migration from v1

v1 transports are not compatible. The governance message types (`session-open`,
`bootstrap-conflict`, `roe-*`) have no meaning in v2. The actor manifest
directories are ignored.

If you have a v1 transport you want to preserve, the message files themselves
(`channels/<guid>/YYYY/MM/DD/*.md`) are valid v2 messages as long as their
frontmatter contains `from`, `to`, `type`, and `timestamp`. Everything else in
the frontmatter is operator-defined and Crosstalk v2 does not care about it.

---

## Decisions

- **Repo:** v2 lives in `cordfuse/crosstalk` (the original spec repo). This runtime
  repo (`cordfuse/crosstalk-runtime`) will be archived once the v2 spec lands there.
- **`_system/`:** removed. No daemon means no presence events. The directory had no
  purpose in a spec-only protocol.
- **Version leniency:** hard break. Readers encountering any version other than `2.0`
  must not process messages.
