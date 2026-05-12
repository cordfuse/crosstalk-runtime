/**
 * `crosstalk channel join <name-or-guid> --agent <name>` — interactive join.
 *
 * The killer human-experience layer of v0.6: the human's preferred AI agent
 * CLI runs as a PTY-wrapped child process, and (in later alphas) the runtime
 * injects new channel messages into the agent's context in real time. To the
 * human it looks like they're chatting natively with their agent; in reality
 * the runtime owns stdio.
 *
 * **alpha.3 (this file) scope:** PTY plumbing on top of alpha.1's lifecycle.
 *   - Same lifecycle: resolve channel + agent + identity, post join, spawn
 *     agent, wait for exit, post leave, exit with agent's status
 *   - The runtime now owns stdio via @homebridge/node-pty-prebuilt-multiarch:
 *     - User keystrokes → forwarded to agent's PTY input (raw mode capture)
 *     - Agent's PTY output → forwarded to terminal display
 *     - SIGWINCH → propagated to PTY (resize cols/rows)
 *     - Terminal restored on agent exit (raw mode off, stdin paused)
 *
 * What this proves on top of alpha.1:
 *   - The runtime can wrap an arbitrary AI CLI as a PTY child without losing
 *     terminal fidelity (colors, cursor control, line editing all work)
 *   - The architecture supports the alpha.5+ injection multiplexer — once
 *     the runtime owns stdio, mid-session injects become a write to the PTY
 *
 * What this still does NOT do (deferred to later alphas):
 *   - alpha.4: backfill (--backfill N flag)
 *   - alpha.5: config-driven agent invocation registry ([agents.X] config
 *     entries override the hardcoded SPAWN_MAP below)
 *   - alpha.6+: live message injection (watcher hook + inject-on-prompt-ready)
 *   - alpha.7: `to:` filter rules
 *
 * See cordfuse/crosstalk TODO #21 for the full v0.6 design.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import * as pty from '@homebridge/node-pty-prebuilt-multiarch'
import which from 'which'
import type { Command } from 'commander'

import { loadConfig } from '../../config.js'
import { scanAllLayers } from '../lib/actors.js'
import { resolveChannel, readChannelMessages, printMessage } from '../lib/channel.js'

interface JoinOptions {
  agent:     string
  as?:       string
  backfill?: string  // string per commander; we parseInt
  push?:     boolean // commander inverts --no-push to push: false
}

/** Built-in default agent invocation map.
 *
 * Operators extend or override these via `[agents.X]` tables in
 * `~/.crosstalk/config.toml` (loaded by config.ts as `config.agents`).
 * Operator entries win on name collision and operator-only names extend
 * the map. Resolution happens at use site via {@link resolveAgentMap}. */
const DEFAULT_AGENTS: Record<string, string[]> = {
  claude:   ['claude'],
  gemini:   ['gemini', '-i'],
  codex:    ['codex'],
  qwen:     ['qwen'],
  opencode: ['opencode'],
}

/** Merge built-in defaults with operator-defined `[agents.X]` config entries.
 * Operator entries override built-ins on name collision. */
function resolveAgentMap(operatorAgents: Record<string, { spawn: string[] }>): Record<string, string[]> {
  const merged: Record<string, string[]> = { ...DEFAULT_AGENTS }
  for (const [name, def] of Object.entries(operatorAgents)) {
    merged[name] = def.spawn
  }
  return merged
}

export function registerChannelJoin(parent: Command): void {
  parent
    .command('join <name-or-guid>')
    .description('join a channel interactively — wraps an AI agent CLI as a child process (PTY-wrapped; live message injection in later alphas)')
    .requiredOption('-a, --agent <name>',  `AI agent CLI to wrap (built-in: ${Object.keys(DEFAULT_AGENTS).sort().join(', ')}; operator-defined extras live in [agents.X] of config.toml)`)
    .option('--as <actor>',                'identity to post join/leave under (defaults to default-human-actor in config.toml)')
    .option('--backfill <n>',              'print last N channel messages before spawning the agent (default: 10; 0 to skip)')
    .option('--no-push',                   'commit join/leave locally without pushing')
    .action(async (channelArg: string, opts: JoinOptions) => {
      await runJoin(channelArg, opts)
    })
}

async function runJoin(channelArg: string, opts: JoinOptions): Promise<void> {
  const config = await loadConfig()

  // 1. Resolve channel name → GUID (errors out if unresolvable)
  const channelGuid = resolveChannel(config.transport, channelArg)

  // 2. Resolve identity. --as wins, then default-human-actor, else error.
  const fromActor = opts.as ?? config.defaultHumanActor
  if (!fromActor) {
    console.error(`✗ --as is required.`)
    console.error(`  Either pass --as <actor>, or set default-human-actor in ~/.crosstalk/config.toml.`)
    process.exit(1)
  }

  // Validate the actor exists across all profile layers — joining as a
  // non-registered actor would post an unattributable system message.
  //
  // We use scanAllLayers (framework + custom + ~/.crosstalk/actors) rather
  // than loadRegistry, because loadRegistry filters to dispatchable actors
  // (agent or command set) and humans are spec-forbidden from carrying
  // those fields — so loadRegistry never sees them.
  const profiles = scanAllLayers(config.transport)
  const profile  = profiles.find(p => p.name === fromActor)
  if (!profile) {
    const known = profiles.map(p => `${p.name} (${p.data.type ?? '?'})`).sort().join(', ')
    console.error(`✗ Actor '${fromActor}' is not defined in any profile layer.`)
    console.error(`  Known actors: ${known || '(none)'}`)
    process.exit(1)
  }
  if (profile.data.type !== 'human') {
    console.error(`✗ Actor '${fromActor}' has type='${profile.data.type ?? '?'}'.`)
    console.error(`  --as must reference a human actor; machines aren't operators joining a channel.`)
    process.exit(1)
  }

  // 3. Resolve agent against the merged built-in + operator map.
  // Built-ins (claude/gemini/codex/qwen/opencode) live in DEFAULT_AGENTS;
  // operator extras come from [agents.X] tables in ~/.crosstalk/config.toml
  // (config.ts loads them into config.agents). Operator entries win on
  // name collision so they can override built-in defaults (e.g. point
  // 'claude' at a wrapper script).
  const agentMap = resolveAgentMap(config.agents)
  const agentName = opts.agent.toLowerCase()
  const spawnCmd = agentMap[agentName]
  if (!spawnCmd) {
    const builtIns = Object.keys(DEFAULT_AGENTS).sort()
    const operator = Object.keys(config.agents).sort()
    console.error(`✗ Unknown agent '${opts.agent}'.`)
    console.error(`  Built-in: ${builtIns.join(', ')}`)
    if (operator.length > 0) {
      console.error(`  Operator-defined (config.toml): ${operator.join(', ')}`)
    } else {
      console.error(`  Define operator agents in ~/.crosstalk/config.toml:`)
      console.error(`    [agents.my-bot]`)
      console.error(`    spawn = ["python3", "/path/to/my-bot.py", "--interactive"]`)
    }
    process.exit(1)
  }

  // Verify the agent's CLI is on PATH before posting join (no orphaned
  // join message if the binary is missing)
  const agentBin = which.sync(spawnCmd[0]!, { nothrow: true })
  if (!agentBin) {
    console.error(`✗ Agent CLI '${spawnCmd[0]}' not found on PATH.`)
    console.error(`  Install ${spawnCmd[0]} and retry.`)
    process.exit(1)
  }

  // 4. Refuse early if stdin/stdout aren't a TTY — interactive PTY session
  // needs a real terminal. Better to refuse before posting join than to
  // post + immediately fail.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(`✗ stdin and stdout must both be TTYs — interactive join requires a real terminal.`)
    console.error(`  (Detected: stdin.isTTY=${process.stdin.isTTY}, stdout.isTTY=${process.stdout.isTTY})`)
    process.exit(1)
  }

  // 5. Post join system message
  const joinBody = `Joined as ${fromActor} via ${agentName} (v0.6.0-alpha.5 — PTY-wrapped + backfill, no injection yet).`
  if (!postSystemMessage({
    transport:    config.transport,
    channelGuid,
    fromActor,
    reason:       'join',
    body:         joinBody,
    push:         opts.push !== false,
  })) {
    process.exit(1)
  }

  console.log(`✓ Joined channel ${channelGuid} as ${fromActor}`)

  // 6. Backfill: print last N channel messages so the operator (and the
  // agent, via terminal scrollback) sees recent context before going live.
  // Default 10. --backfill 0 skips. Same display format as `crosstalk
  // channel show / tail` so the operator gets a consistent view.
  const backfillN = opts.backfill !== undefined ? parseInt(opts.backfill, 10) : 10
  if (Number.isNaN(backfillN) || backfillN < 0) {
    console.error(`✗ --backfill must be a non-negative integer (got '${opts.backfill}')`)
    process.exit(1)
  }
  if (backfillN > 0) {
    const channelDir = join(config.transport, 'channels', channelGuid)
    const all = readChannelMessages(channelDir)
    const tail = all.slice(-backfillN)
    if (tail.length > 0) {
      console.log(`  ── last ${tail.length} message${tail.length === 1 ? '' : 's'} (backfill) ──\n`)
      for (const m of tail) printMessage(m)
    } else {
      console.log(`  (channel has no prior messages)`)
    }
  }

  console.log(`  Spawning ${agentBin} (${spawnCmd.join(' ')}) under PTY — Ctrl-D or quit the agent to leave.`)
  console.log(`  ──────────────────────────────────────────────────────`)

  // 7. Spawn agent under PTY. The runtime now owns stdio: forwards user
  // keystrokes to agent input, agent output to terminal, propagates resize.
  const agentStatus = await runAgentInPty(spawnCmd)

  // 6. Post leave message — always, even on agent error/crash
  console.log(`  ──────────────────────────────────────────────────────`)
  const leaveBody = `Left channel (agent exit ${agentStatus}).`
  postSystemMessage({
    transport:    config.transport,
    channelGuid,
    fromActor,
    reason:       'leave',
    body:         leaveBody,
    push:         opts.push !== false,
  })
  console.log(`✓ Left channel ${channelGuid}`)

  process.exit(agentStatus)
}

// ── PTY-wrapped agent runner ─────────────────────────────────────────────

/** Spawn the agent CLI under a PTY; multiplex parent stdio against it.
 *
 *   parent stdin (raw)  → PTY input
 *   PTY output          → parent stdout
 *   SIGWINCH on parent  → PTY resize
 *
 * Returns a Promise resolving to the agent's exit code. Callers must have
 * already verified isTTY on stdin/stdout — this function assumes a real
 * terminal and will be wrong-looking output otherwise.
 *
 * Cleanup invariant: regardless of how the agent exits (clean / crash /
 * external signal), parent stdin's raw mode is restored and stdin is paused
 * before resolving. Listeners on parent stdin and SIGWINCH are removed so
 * the surrounding lifecycle (post leave + exit) operates against a normal
 * terminal.
 */
async function runAgentInPty(spawnCmd: string[]): Promise<number> {
  const cols = process.stdout.columns ?? 80
  const rows = process.stdout.rows   ?? 24

  return new Promise<number>((resolve) => {
    let term: pty.IPty
    try {
      term = pty.spawn(spawnCmd[0]!, spawnCmd.slice(1), {
        name: 'xterm-256color',
        cols,
        rows,
        cwd:  process.cwd(),
        env:  process.env as Record<string, string>,
      })
    } catch (err) {
      console.error(`✗ PTY spawn failed: ${err instanceof Error ? err.message : err}`)
      resolve(1)
      return
    }

    // PTY → terminal display (transparent passthrough)
    const onPtyData = (data: string) => process.stdout.write(data)
    term.onData(onPtyData)

    // Terminal stdin → PTY input (raw mode captures every byte including
    // Ctrl-C, arrow keys, function keys — agent receives them as it would
    // in a normal terminal session)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    const onStdinData = (data: Buffer) => term.write(data.toString('utf-8'))
    process.stdin.on('data', onStdinData)

    // Terminal resize → PTY resize. Without this, the agent's view of the
    // terminal stays at initial cols/rows even when the user resizes the
    // window — line-wrapping breaks, fullscreen UIs (vim, less) get confused.
    const onResize = () => {
      try {
        term.resize(process.stdout.columns ?? cols, process.stdout.rows ?? rows)
      } catch {
        // Resize after PTY exit is harmless to ignore.
      }
    }
    process.on('SIGWINCH', onResize)

    // Cleanup invariant: restore terminal state before resolving so the
    // surrounding lifecycle (post leave + exit) sees a normal terminal.
    const cleanup = () => {
      try { process.stdin.setRawMode(false) } catch { /* not a TTY anymore */ }
      process.stdin.pause()
      process.stdin.removeListener('data', onStdinData)
      process.removeListener('SIGWINCH', onResize)
    }

    term.onExit(({ exitCode }) => {
      cleanup()
      resolve(exitCode ?? 0)
    })
  })
}

// ── system message writer ────────────────────────────────────────────────

interface PostSystemArgs {
  transport:   string
  channelGuid: string
  fromActor:   string
  reason:      'join' | 'leave'
  body:        string
  push:        boolean
}

/** Atomic write + git add/commit/push for a `type: system` message.
 *
 * Mirrors the pattern in commands/post.ts (composeMessage / atomic
 * write / gitCmd) — copy-pasted here to keep alpha.1 narrow. The
 * shared helpers belong in a lib module; that refactor lands later
 * (probably alpha.5 when watcher integration shares the same path). */
function postSystemMessage(args: PostSystemArgs): boolean {
  const now       = new Date()
  const filename  = formatTimestampFilename(now)
  const datePath  = formatDatePath(now)
  const targetDir = join(args.transport, 'channels', args.channelGuid, datePath)
  const targetFile = join(targetDir, filename)

  const content = [
    `---`,
    `from: ${args.fromActor}`,
    `to: all`,
    `timestamp: ${now.toISOString()}`,
    `type: system`,
    `reason: ${args.reason}`,
    `---`,
    ``,
    args.body,
    ``,
  ].join('\n')

  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true })
  const tmpFile = join(targetDir, `.${filename}.tmp.${process.pid}`)
  writeFileSync(tmpFile, content)
  renameSync(tmpFile, targetFile)

  const relPath = `channels/${args.channelGuid}/${datePath}/${filename}`
  if (!gitCmd(args.transport, ['add', relPath]))                         return false

  const commitMsg = `system: ${args.fromActor} ${args.reason}`
  if (!gitCmd(args.transport, ['commit', '-m', commitMsg]))              return false

  if (args.push) {
    if (!gitCmd(args.transport, ['push'])) {
      console.error(`✗ Push failed for ${args.reason} message — commit is local. Run \`git -C ${args.transport} push\` to retry.`)
      return false
    }
  }
  return true
}

function formatTimestampFilename(d: Date): string {
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  const ss = String(d.getUTCSeconds()).padStart(2, '0')
  const ms = String(d.getUTCMilliseconds()).padStart(3, '0')
  return `${hh}${mm}${ss}${ms}Z.md`
}

function formatDatePath(d: Date): string {
  const yyyy = d.getUTCFullYear()
  const mm   = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd   = String(d.getUTCDate()).padStart(2, '0')
  return `${yyyy}/${mm}/${dd}`
}

function gitCmd(cwd: string, args: string[]): boolean {
  const result = spawnSync('git', args, { cwd, stdio: 'inherit' })
  return result.status === 0
}
