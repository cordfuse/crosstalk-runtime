/**
 * `crosstalk channel join <name-or-guid> --agent <name>` — interactive join.
 *
 * The killer human-experience layer of v0.6: the human's preferred AI agent
 * CLI runs as a PTY-wrapped child process, and the runtime injects new
 * channel messages into the agent's context in real time. To the human it
 * looks like they're chatting natively with their agent; in reality the
 * runtime owns stdio and watches the channel for inbound traffic.
 *
 * **Capabilities accumulated through the v0.6 alpha series:**
 *   - alpha.1: lifecycle skeleton (post join → spawn agent → wait for exit
 *     → post leave). No PTY (stdio: 'inherit'), no injection.
 *   - alpha.2: validator type:system spec fix (framework-side; not in this
 *     file).
 *   - alpha.3: PTY plumbing via @homebridge/node-pty-prebuilt-multiarch.
 *     User keystrokes → agent PTY input; agent PTY output → terminal
 *     display; SIGWINCH propagation; raw-mode setup + cleanup invariant.
 *   - alpha.4: distribution pivot to node npm package (not in this file).
 *   - alpha.5: --backfill N flag — print last N channel messages before
 *     spawning the agent so operator + agent see recent context via
 *     terminal scrollback.
 *   - alpha.6: config-driven agent invocation registry. [agents.X] tables
 *     in ~/.crosstalk/config.toml extend or override DEFAULT_AGENTS. Plus
 *     pushWithRetry for join/leave system messages (rebase-and-retry on
 *     push rejection — fixes the alpha.6-era one-shot push fragility).
 *   - alpha.7: live message injection. Watcher polls the channel dir
 *     every 500ms; new messages from other actors get formatted as
 *     [crosstalk inbound] blocks and written to the agent's PTY stdin so
 *     the agent processes them as inline conversational input.
 *   - alpha.8 (THIS): inject refinements. (1) `to:`-targeting filter:
 *     skip messages not addressed to <self> (or "all" broadcast);
 *     `--inject-all` flag bypasses. (2) Prompt-ready clustering: buffer
 *     injects in a queue while agent stdout is active; flush only when
 *     stdout has been silent for `--quiet-ms` (default 750). Avoids
 *     visual mid-response mixing.
 *
 * v0.6.0 final cuts after alpha.8 stabilises in operator usage.
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
import { pushWithRetry } from '../../git.js'
import { messageDatePath, messageFilename } from '../../filenames.js'
import { scanAllLayers } from '../lib/actors.js'
import { resolveChannel, readChannelMessages, printMessage } from '../lib/channel.js'
import { decryptForDisplay } from './channel.js'

interface JoinOptions {
  agent:      string
  as?:        string
  backfill?:  string  // string per commander; we parseInt
  push?:      boolean // commander inverts --no-push to push: false
  injectAll?: boolean // alpha.8: bypass `to:`-targeting filter
  quietMs?:   string  // alpha.8: prompt-ready threshold in ms; we parseInt
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
    .option('--inject-all',                'inject every new channel message (default: only inject messages where to: includes <self> or "all")')
    .option('--quiet-ms <n>',              'prompt-ready threshold — inject only after agent stdout has been silent for N ms (default: 750)')
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
  const profiles = scanAllLayers(config.transport, config.operator)
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
  const joinBody = `Joined as ${fromActor} via ${agentName} (v0.6.0-alpha.8 — PTY-wrapped + backfill + operator agent registry + live injection with to:-filter + prompt-ready clustering).`
  if (!await postSystemMessage({
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

  // 6. Backfill display + seen-set initialisation. Read channel messages
  // ONCE here (used both for backfill display and as the seen-set baseline
  // for live injection — anything already in the channel before the
  // session started doesn't get re-injected, even if --backfill 0 hides
  // it from display).
  const backfillN = opts.backfill !== undefined ? parseInt(opts.backfill, 10) : 10
  if (Number.isNaN(backfillN) || backfillN < 0) {
    console.error(`✗ --backfill must be a non-negative integer (got '${opts.backfill}')`)
    process.exit(1)
  }
  const channelDir = join(config.transport, 'channels', channelGuid)
  const allExisting = readChannelMessages(channelDir)
  if (backfillN > 0) {
    const tail = allExisting.slice(-backfillN)
    if (tail.length > 0) {
      console.log(`  ── last ${tail.length} message${tail.length === 1 ? '' : 's'} (backfill) ──\n`)
      // v0.9.0+ — decrypt backfill via the joining actor's identity, same
      // helper that channel show uses. Closes the v0.8.x PTY-mode decrypt
      // gap (Mac UAT finding 2026-05-14: channel-join printed ciphertext
      // because it called printMessage on raw RenderedMessage).
      const decrypted = await Promise.all(tail.map(m => decryptForDisplay(m, fromActor)))
      for (const m of decrypted) printMessage(m)
    } else {
      console.log(`  (channel has no prior messages)`)
    }
  }

  // alpha.8: parse + validate inject knobs
  const injectAll = opts.injectAll === true
  const quietMs = opts.quietMs !== undefined ? parseInt(opts.quietMs, 10) : 750
  if (Number.isNaN(quietMs) || quietMs < 0) {
    console.error(`✗ --quiet-ms must be a non-negative integer (got '${opts.quietMs}')`)
    process.exit(1)
  }

  console.log(`  Spawning ${agentBin} (${spawnCmd.join(' ')}) under PTY — Ctrl-D or quit the agent to leave.`)
  if (injectAll) {
    console.log(`  Live injection ON (--inject-all): EVERY new channel message (except your own) injects as [crosstalk inbound]. Quiet threshold ${quietMs}ms.`)
  } else {
    console.log(`  Live injection ON: messages where to: includes ${fromActor} or "all" inject as [crosstalk inbound]. Quiet threshold ${quietMs}ms. (--inject-all to bypass filter.)`)
  }
  console.log(`  ──────────────────────────────────────────────────────`)

  // 7. Spawn agent under PTY + live-inject watcher. The runtime owns stdio
  // and polls the channel dir every 500ms. Filtered messages enqueue;
  // queue flushes when agent stdout has been silent for `quietMs`.
  const agentStatus = await runAgentInPty(spawnCmd, {
    channelDir,
    fromActor,
    seen: new Set(allExisting.map(m => m.path)),
    injectAll,
    quietMs,
  })

  // 6. Post leave message — always, even on agent error/crash
  console.log(`  ──────────────────────────────────────────────────────`)
  const leaveBody = `Left channel (agent exit ${agentStatus}).`
  await postSystemMessage({
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
/** Context for the live-injection watcher (alpha.7+). The PTY session polls
 * the channel directory for new messages and writes them to the agent's
 * stdin so the agent processes them as inline conversational input.
 *
 * alpha.8 additions:
 *   - injectAll: bypass the `to:`-targeting filter (default: only inject
 *     messages where `to:` includes `<self>` or is `all`)
 *   - quietMs: prompt-ready threshold. Injects buffer in a queue while
 *     agent is producing stdout; queue flushes once stdout has been
 *     silent for this many ms. Default 750.
 */
interface InjectCtx {
  channelDir: string
  fromActor:  string  // skip messages from this identity (no echo of self)
  seen:       Set<string>  // message paths already injected/backfilled
  injectAll:  boolean
  quietMs:    number
}

/** Returns true when the message's `to:` field targets `self` (either
 * directly by name, or via the `all` broadcast keyword). Comma-list
 * tolerant. Case-insensitive. */
function isMessageForSelf(toField: string, self: string): boolean {
  const targets = toField.split(',').map(t => t.trim().toLowerCase())
  return targets.includes('all') || targets.includes(self.toLowerCase())
}

async function runAgentInPty(spawnCmd: string[], inject: InjectCtx): Promise<number> {
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

    // PTY → terminal display (transparent passthrough). Also tracks
    // lastStdoutMs for the prompt-ready clustering heuristic (alpha.8):
    // injects buffer in a queue while agent is producing stdout; queue
    // flushes once stdout has been silent for inject.quietMs.
    let lastStdoutMs = Date.now()
    const onPtyData = (data: string) => {
      lastStdoutMs = Date.now()
      process.stdout.write(data)
    }
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

    // Live-injection watcher (alpha.7 + alpha.8 refinements). Polls the
    // channel dir every 500ms.
    //
    // alpha.7 baseline: for each new message NOT from <self>, write a
    // [crosstalk inbound] block to the agent's PTY stdin.
    //
    // alpha.8 additions:
    //   - to:-targeting filter: skip messages not addressed to <self>
    //     (and not the `all` broadcast). --inject-all bypasses.
    //   - prompt-ready clustering: buffer injects in a queue while agent
    //     stdout is active; flush only when stdout has been silent for
    //     inject.quietMs. Avoids visual mid-response mixing.
    //
    // Same poll loop also handles the queue flush check, so we don't
    // need a second interval. Latency-to-flush is bounded by the 500ms
    // poll cadence (good enough — operators won't notice).
    const queue: Array<{ from: string; timestamp: string; body: string }> = []
    const pollInterval = setInterval(async () => {
      // Stage 1: scan for new messages, filter, decrypt, enqueue.
      // v0.9.0+ — decrypt before pushing to PTY queue. Closes the v0.8.x
      // PTY-mode decrypt gap for live injection (Mac UAT finding
      // 2026-05-14: encrypted bodies were going straight to the agent's
      // stdin as opaque ciphertext). decryptForDisplay returns a placeholder
      // string for failure cases (no identity / not a recipient / etc.) —
      // those render to the agent as informative text, not silent failures.
      const current = readChannelMessages(inject.channelDir)
      const enqueueWork: Array<typeof current[0]> = []
      for (const m of current) {
        if (inject.seen.has(m.path)) continue
        inject.seen.add(m.path)
        if (m.from === inject.fromActor) continue       // skip own messages — no echo
        if (!inject.injectAll && !isMessageForSelf(m.to, inject.fromActor)) continue   // skip not-for-me unless --inject-all
        enqueueWork.push(m)
      }
      if (enqueueWork.length > 0) {
        const decrypted = await Promise.all(enqueueWork.map(m => decryptForDisplay(m, inject.fromActor)))
        for (const dm of decrypted) queue.push({ from: dm.from, timestamp: dm.timestamp, body: dm.body })
      }

      // Stage 2: flush queue if agent stdout has been quiet long enough
      // (prompt-ready heuristic). Don't fire mid-response.
      if (queue.length > 0 && (Date.now() - lastStdoutMs) > inject.quietMs) {
        for (const m of queue) {
          const block = formatInbound(m)
          try { term.write(block) } catch { /* term exited mid-poll, harmless */ }
        }
        queue.length = 0
        lastStdoutMs = Date.now()  // injects count as "agent activity" so back-to-back injects don't all fire at once
      }
    }, 500)

    // Cleanup invariant: restore terminal state + stop watcher before
    // resolving so the surrounding lifecycle (post leave + exit) sees a
    // normal terminal and no orphan timers.
    const cleanup = () => {
      clearInterval(pollInterval)
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

/** Format a channel message as a [crosstalk inbound] block to write into
 * the agent's PTY stdin. Distinguishable from real user input via the
 * sentinel — agents like Claude Code can recognise the convention and
 * respond appropriately. Newline at start to push past whatever cursor
 * position the agent's prompt may be at. */
function formatInbound(m: { from: string; timestamp: string; body: string }): string {
  const t = m.timestamp.slice(11, 19) // hh:mm:ss
  return `\n[crosstalk inbound from ${m.from} at ${t}]\n${m.body}\n[end inbound]\n`
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
async function postSystemMessage(args: PostSystemArgs): Promise<boolean> {
  const now       = new Date()
  const filename  = messageFilename(now)
  const datePath  = messageDatePath(now)
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

  // Use the canonical pushWithRetry (rebase-and-retry on rejection).
  // Bug surfaced in alpha.6 Mac UAT: one-shot `git push` reliably bricks
  // when crosstalk-demo has commits on remote that local doesn't, and the
  // runtime hard-bails mid-lifecycle leaving an orphan join commit.
  // pushWithRetry is the same battle-tested pattern dispatch.ts uses for
  // actor-response commits.
  if (args.push) {
    const ok = await pushWithRetry(args.transport)
    if (!ok) {
      console.error(`✗ Push failed for ${args.reason} message after retries — commit is local. Run \`git -C ${args.transport} pull --rebase && git push\` to recover.`)
      return false
    }
  }
  return true
}

// Filename + datePath helpers extracted to src/filenames.ts in v0.7.x
// scaffolding pass (PLAN.md "Message files" section adds the per-message
// UUID tag for collision resistance). Import via `messageFilename` and
// `messageDatePath` from there.

function gitCmd(cwd: string, args: string[]): boolean {
  const result = spawnSync('git', args, { cwd, stdio: 'inherit' })
  return result.status === 0
}
