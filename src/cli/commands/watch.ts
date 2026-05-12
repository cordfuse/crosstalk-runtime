/**
 * `crosstalk watch <subcommand>` — daemon lifecycle.
 *
 *   crosstalk watch start [--foreground]
 *   crosstalk watch stop  [--force]
 *   crosstalk watch restart
 *   crosstalk watch status
 *   crosstalk watch logs  [--tail N] [--follow]
 *
 * For operators not running the daemon via systemd / launchd / pm2 — gives
 * them a portable lifecycle wrapper. Stores PID at ~/.crosstalk/crosstalk.pid
 * and logs at ~/.crosstalk/logs/daemon.log.
 *
 * Detection: spawns the same binary that's currently running (process.execPath)
 * with no args, which routes back to the daemon path. In dev (bun run src/index.ts),
 * walks back to find index.ts and spawns `bun run <index.ts>` instead.
 */
import { existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import type { Command } from 'commander'

const VYZR_DIR  = join(homedir(), '.crosstalk')
const LOG_DIR   = join(VYZR_DIR, 'logs')
const LOG_PATH  = join(LOG_DIR, 'daemon.log')
const PID_PATH  = join(VYZR_DIR, 'crosstalk.pid')

export function registerWatchCommand(program: Command): void {
  const watch = program
    .command('watch')
    .description('daemon lifecycle (subcommands: start, stop, restart, status, logs)')

  watch.command('start')
    .description('start the daemon as a detached background process')
    .option('-F, --foreground', 'run in foreground (current terminal)')
    .action(async (opts: { foreground?: boolean }) => {
      await runWatchStart(opts)
    })

  watch.command('stop')
    .description('stop the daemon (SIGTERM, then SIGKILL after timeout if --force)')
    .option('--force', 'SIGKILL if SIGTERM doesn\'t exit within 3s')
    .action(async (opts: { force?: boolean }) => {
      await runWatchStop(opts)
    })

  watch.command('restart')
    .description('stop then start')
    .action(async () => {
      await runWatchStop({})
      await new Promise(r => setTimeout(r, 500))
      await runWatchStart({})
    })

  watch.command('status')
    .description('print daemon pid, uptime, and log path')
    .option('--json', 'machine-readable JSON output')
    .action((opts: { json?: boolean }) => {
      runWatchStatus(opts)
    })

  watch.command('logs')
    .description('tail the daemon log')
    .option('-n, --tail <n>', 'show last N lines (default 50)', '50')
    .option('-f, --follow',   'stream new lines as they\'re written (Ctrl-C to stop)')
    .action(async (opts: { tail?: string; follow?: boolean }) => {
      await runWatchLogs(opts)
    })
}

// ── start ──────────────────────────────────────────────────────────────

async function runWatchStart(opts: { foreground?: boolean }): Promise<void> {
  if (opts.foreground) {
    // Foreground = just exec the daemon path inline. Caller can Ctrl-C.
    // Lazy-import the daemon module so a normal CLI run doesn't pay for it.
    console.log(`[watch] running daemon in foreground (Ctrl-C to stop)`)
    // The daemon is the no-args path of this same binary. Re-spawn ourselves
    // attached so we share stdio.
    const cmd = getDaemonSpawnCmd()
    const child = spawn(cmd[0]!, cmd.slice(1), { stdio: 'inherit' })
    child.on('exit', (code) => process.exit(code ?? 0))
    return
  }

  // Already running?
  const existing = readPid()
  if (existing && processAlive(existing)) {
    console.error(`✗ Daemon is already running (pid ${existing}). Use \`crosstalk watch stop\` first.`)
    process.exit(1)
  }
  if (existing && !processAlive(existing)) {
    console.warn(`⚠ Stale pid file at ${PID_PATH} (process ${existing} is dead) — overwriting.`)
    try { unlinkSync(PID_PATH) } catch { /* ignore */ }
  }

  // Ensure log dir exists
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })

  // Open log file in append mode for both stdout and stderr
  const out = openSync(LOG_PATH, 'a')
  const err = openSync(LOG_PATH, 'a')

  const cmd = getDaemonSpawnCmd()
  const child = spawn(cmd[0]!, cmd.slice(1), {
    detached: true,
    stdio:    ['ignore', out, err],
  })
  child.unref()

  if (child.pid === undefined) {
    console.error(`✗ Failed to spawn daemon (no pid)`)
    process.exit(1)
  }

  writeFileSync(PID_PATH, String(child.pid))
  console.log(`✓ Daemon started (pid ${child.pid})`)
  console.log(`  log: ${LOG_PATH}`)
  console.log(`  pid: ${PID_PATH}`)
  console.log(`  status:  crosstalk watch status`)
  console.log(`  follow:  crosstalk watch logs --follow`)
  console.log(`  stop:    crosstalk watch stop`)
}

// ── stop ───────────────────────────────────────────────────────────────

async function runWatchStop(opts: { force?: boolean }): Promise<void> {
  const pid = readPid()
  if (!pid) {
    console.log(`(no pid file at ${PID_PATH} — daemon doesn't appear to be running)`)
    return
  }
  if (!processAlive(pid)) {
    console.warn(`⚠ Stale pid file (${pid} is not running). Removing.`)
    try { unlinkSync(PID_PATH) } catch { /* ignore */ }
    return
  }

  console.log(`Sending SIGTERM to ${pid}...`)
  try {
    process.kill(pid, 'SIGTERM')
  } catch (err) {
    console.error(`✗ kill failed: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }

  // Wait up to 3s for clean exit
  const startMs = Date.now()
  while (Date.now() - startMs < 3000) {
    await new Promise(r => setTimeout(r, 100))
    if (!processAlive(pid)) {
      try { unlinkSync(PID_PATH) } catch { /* ignore */ }
      console.log(`✓ Daemon stopped`)
      return
    }
  }

  if (opts.force) {
    console.warn(`⚠ Daemon didn't exit on SIGTERM after 3s. Sending SIGKILL.`)
    try { process.kill(pid, 'SIGKILL') } catch { /* ignore */ }
    await new Promise(r => setTimeout(r, 200))
    try { unlinkSync(PID_PATH) } catch { /* ignore */ }
    console.log(`✓ Daemon killed`)
    return
  }

  console.error(`✗ Daemon didn't exit on SIGTERM after 3s. Re-run with --force to SIGKILL.`)
  process.exit(1)
}

// ── status ─────────────────────────────────────────────────────────────

interface StatusInfo {
  running:    boolean
  pid:        number | null
  uptime?:    string
  pidFile:    string
  logFile:    string
  logExists:  boolean
}

function runWatchStatus(opts: { json?: boolean }): void {
  const pid = readPid()
  const info: StatusInfo = {
    running:   pid !== null && processAlive(pid),
    pid:       pid,
    pidFile:   PID_PATH,
    logFile:   LOG_PATH,
    logExists: existsSync(LOG_PATH),
  }

  if (info.running && existsSync(PID_PATH)) {
    try {
      const start = statSync(PID_PATH).mtimeMs
      info.uptime = formatUptime(Date.now() - start)
    } catch { /* ignore */ }
  }

  if (opts.json) {
    console.log(JSON.stringify(info, null, 2))
    process.exit(info.running ? 0 : 1)
  }

  if (info.running) {
    console.log(`✓ Daemon running (pid ${info.pid}${info.uptime ? `, uptime ${info.uptime}` : ''})`)
    console.log(`  pid file:  ${info.pidFile}`)
    console.log(`  log file:  ${info.logFile}${info.logExists ? '' : ' (does not exist yet)'}`)
    process.exit(0)
  } else {
    if (pid) {
      console.log(`✗ Daemon NOT running (stale pid ${pid} in ${PID_PATH})`)
    } else {
      console.log(`✗ Daemon NOT running (no pid file)`)
    }
    process.exit(1)
  }
}

// ── logs ───────────────────────────────────────────────────────────────

async function runWatchLogs(opts: { tail?: string; follow?: boolean }): Promise<void> {
  if (!existsSync(LOG_PATH)) {
    console.error(`✗ No log file at ${LOG_PATH}`)
    console.error(`  Has the daemon ever started? Try \`crosstalk watch start\`.`)
    process.exit(1)
  }

  const tailN = opts.tail ? parseInt(opts.tail, 10) : 50
  const content = readFileSync(LOG_PATH, 'utf-8')
  const lines = content.split('\n')
  // Last N (skip trailing empty line from final \n)
  const trimmed = lines.length > 0 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
  const start = Math.max(0, trimmed.length - tailN)
  for (const line of trimmed.slice(start)) {
    console.log(line)
  }

  if (!opts.follow) return

  // Follow mode: poll file size every 200ms, print new bytes
  let position = statSync(LOG_PATH).size
  process.on('SIGINT', () => process.exit(0))

  while (true) {
    await new Promise(r => setTimeout(r, 200))
    let size = position
    try { size = statSync(LOG_PATH).size } catch { continue }
    if (size <= position) continue

    // Read new bytes
    const fd = await import('node:fs/promises').then(m => m.open(LOG_PATH, 'r'))
    try {
      const buf = Buffer.alloc(size - position)
      await fd.read(buf, 0, buf.length, position)
      process.stdout.write(buf.toString('utf-8'))
      position = size
    } finally {
      await fd.close()
    }
  }
}

// ── helpers ────────────────────────────────────────────────────────────

function readPid(): number | null {
  if (!existsSync(PID_PATH)) return null
  try {
    const raw = readFileSync(PID_PATH, 'utf-8').trim()
    const pid = parseInt(raw, 10)
    return isNaN(pid) ? null : pid
  } catch {
    return null
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)  // signal 0 = check existence
    return true
  } catch {
    return false
  }
}

function formatUptime(ms: number): string {
  const sec = Math.floor(ms / 1000)
  if (sec < 60)        return `${sec}s`
  if (sec < 3600)      return `${Math.floor(sec / 60)}m ${sec % 60}s`
  if (sec < 86_400)    return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
  return `${Math.floor(sec / 86_400)}d ${Math.floor((sec % 86_400) / 3600)}h`
}

/** Determine the command to spawn the daemon path of this same code.
 * In compiled binary mode (process.execPath = the binary), spawn it with
 * no args. In dev (bun run src/index.ts), spawn `bun run <index.ts>`. */
function getDaemonSpawnCmd(): string[] {
  const execPath = process.execPath
  // Bun's execPath ends in 'bun' on Linux/macOS, 'bun.exe' on Windows.
  if (execPath.endsWith('/bun') || execPath.endsWith('\\bun.exe')) {
    // Walk back from this file (src/cli/commands/watch.ts) to src/index.ts
    const indexTs = resolve(import.meta.dir, '..', '..', 'index.ts')
    return [execPath, 'run', indexTs]
  }
  // Compiled binary — just exec path with no args
  return [execPath]
}
