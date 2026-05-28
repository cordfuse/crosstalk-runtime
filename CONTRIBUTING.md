# Contributing to @cordfuse/crosstalk-runtime (v2.0)

This file provides guidance for contributors working on the lean v2.0 runtime.

## Core Philosophy

The v2.0 runtime is designed to be **lean and focused**. It handles the essential bridge between git-based transports and stateless agent CLIs. All complex features (governance, encryption, relays) were removed in v2.0 to prioritize stability and simplicity.

---

## Key Files

| File | Purpose |
|------|---------|
| `src/runner.ts` | Main entry point; manages the polling scheduler for all agents. |
| `src/config.ts` | Handles YAML configuration and CLI flag parsing. |
| `src/dispatch.ts` | Spawns agent subprocesses, manages stdin/stdout, and writes reply files. |
| `src/git.ts` | Logic for git pull, commit, and push (including Tokn and Jitter paths). |
| `src/tokn.ts` | A lightweight client for the [Tokn](https://github.com/cordfuse/tokn) push serialization service. |
| `src/cursor.ts` | Tracks the last processed message per agent to ensure idempotent processing. |
| `src/filenames.ts` | Constructs Crosstalk-compliant message filenames (`HHMMSSsssZ-hex.md`). |
| `src/frontmatter.ts` | Simple YAML frontmatter parser using the `yaml` package. |

---

## Local Development

### Prerequisites
- **Node.js >= 18**
- **npm** or **bun** (for running scripts)

### Setup
```sh
npm install
npm run build
```

### Running for Testing
```sh
# Run with a local config
node dist/runner.js --config config.yaml

# Run in dev mode (requires Bun for watch mode)
npm run dev
```

---

## Coding Standards

- **TypeScript Only**: Use modern TypeScript and standard Node/Web APIs.
- **Node.js Compatibility**: Ensure compatibility with Node.js 18+. Avoid Bun-specific APIs in the core source (though Bun can be used for dev tooling).
- **Minimal Dependencies**: Only add dependencies if they are strictly necessary and well-maintained.
- **Atomic Commits**: Follow the rule of one fix or feature per commit.

---

## Protocol Reference

The definitive protocol specification lives in the [cordfuse/crosstalk](https://github.com/cordfuse/crosstalk) repository. The runtime must always remain a faithful implementation of that spec.
