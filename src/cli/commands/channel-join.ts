/**
 * `crosstalk channel join <name-or-guid> --agent <name>` — interactive join
 * (skeleton — v0.6.0-alpha.1).
 *
 * The killer human-experience layer of v0.6: the human's preferred AI agent
 * CLI runs as a child process, and (in later alphas) the runtime injects new
 * channel messages into the agent's context in real time. To the human it
 * looks like they're chatting natively with their agent; in reality the
 * runtime owns stdio.
 *
 * **alpha.1 scope:** lifecycle only.
 *   - Resolve channel + agent + identity
 *   - Post `type: system, reason: join, from: <actor>` to the channel
 *   - Spawn the agent CLI with stdio: 'inherit' (NO PTY yet — that's alpha.2)
 *   - Wait for the agent to exit (Ctrl-C from the user reaches the agent
 *     directly via terminal foreground process group, agent exits, control
 *     returns)
 *   - Post `type: system, reason: leave, from: <actor>`
 *   - Exit with the agent's status code
 *
 * What this proves:
 *   - The third runtime mode CLI surface (interactive client, distinct from
 *     daemon and server)
 *   - Channel resolution + identity flow + system message types (join/leave)
 *   - Agent spawn + clean exit semantics
 *
 * What this does NOT do (deferred to later alphas):
 *   - PTY plumbing (alpha.2) — runtime doesn't own stdio yet, so the agent
 *     just runs natively in the parent terminal
 *   - Backfill (alpha.3) — no `--backfill N` flag yet
 *   - Config-driven agent invocation registry (alpha.4) — agent spawn cmds
 *     are hardcoded below; operator overrides via `[agents.X]` in
 *     ~/.crosstalk/config.toml come later
 *   - Live message injection (alpha.5+) — no watcher, no inject-on-prompt-
 *     ready logic
 *   - `to:` filter rules (alpha.6) — n/a yet
 *
 * See cordfuse/crosstalk TODO #21 for the full v0.6 design.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { Command } from 'commander'

import { loadConfig } from '../../config.js'
import { scanAllLayers } from '../lib/actors.js'
import { resolveChannel } from '../lib/channel.js'

interface JoinOptions {
  agent: string
  as?:   string
  push?: boolean   // commander inverts --no-push to push: false
}

/** Hardcoded agent invocation map for alpha.1.
 *
 * alpha.4 lifts this into operator-overridable [agents.X] config entries,
 * but for the skeleton these defaults cover every agent the dispatch path
 * already knows about (Claude, Gemini, Qwen, OpenCode) plus Codex (which
 * the dispatch path doesn't yet handle but is a common operator agent). */
const SPAWN_MAP: Record<string, string[]> = {
  claude:   ['claude'],
  gemini:   ['gemini', '-i'],
  codex:    ['codex'],
  qwen:     ['qwen'],
  opencode: ['opencode'],
}

export function registerChannelJoin(parent: Command): void {
  parent
    .command('join <name-or-guid>')
    .description('join a channel interactively — wraps an AI agent CLI as a child process (PTY + injection in later alphas)')
    .requiredOption('-a, --agent <name>',  `AI agent CLI to wrap (one of: ${Object.keys(SPAWN_MAP).sort().join(', ')})`)
    .option('--as <actor>',                'identity to post join/leave under (defaults to default-human-actor in config.toml)')
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

  // 3. Resolve agent. Hardcoded map for alpha.1.
  const agentName = opts.agent.toLowerCase()
  const spawnCmd = SPAWN_MAP[agentName]
  if (!spawnCmd) {
    const known = Object.keys(SPAWN_MAP).sort().join(', ')
    console.error(`✗ Unknown agent '${opts.agent}'.`)
    console.error(`  Supported in alpha.1: ${known}`)
    console.error(`  Operator-defined agents land in alpha.4.`)
    process.exit(1)
  }

  // Verify the agent's CLI is on PATH before posting join (no orphaned
  // join message if the binary is missing)
  const agentBin = Bun.which(spawnCmd[0]!)
  if (!agentBin) {
    console.error(`✗ Agent CLI '${spawnCmd[0]}' not found on PATH.`)
    console.error(`  Install ${spawnCmd[0]} and retry.`)
    process.exit(1)
  }

  // 4. Post join system message
  const joinBody = `Joined as ${fromActor} via ${agentName} (v0.6.0-alpha.1 skeleton — no PTY, no injection yet).`
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
  console.log(`  Spawning ${agentBin} (${spawnCmd.join(' ')}) — Ctrl-D or quit the agent to leave.`)
  console.log(`  ──────────────────────────────────────────────────────`)

  // 5. Spawn agent. stdio: 'inherit' so the agent owns the terminal directly.
  // SIGINT from the user reaches the agent via the terminal's foreground
  // process group; we wait for the agent to exit on any cause.
  let agentStatus = 0
  try {
    const result = spawnSync(spawnCmd[0]!, spawnCmd.slice(1), { stdio: 'inherit' })
    agentStatus = result.status ?? 0
  } catch (err) {
    console.error(`✗ Agent spawn failed: ${err instanceof Error ? err.message : err}`)
    agentStatus = 1
  }

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
