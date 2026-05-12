/**
 * `crosstalk init` — interactive setup wizard.
 *
 * Walks new operators through writing ~/.crosstalk/config.toml without
 * needing to know the TOML schema. Replaces the manual file-editing step
 * in the README quickstart with a guided flow:
 *
 *   1. Pick or create a transport (existing local, clone URL, or template
 *      a fresh one from cordfuse/crosstalk via gh CLI)
 *   2. Pick a relay (Cordfuse public or self-hosted)
 *   3. Pick an actor email suffix (defaults from git config user.email)
 *   4. Pick a heartbeat interval
 *   5. Smoke-test the relay (fetch /version)
 *   6. Atomically write the config
 *   7. Print next-step hints (GitHub webhook, daemon start)
 *
 * Non-interactive mode: pass --transport / --relay-url / etc. flags for
 * scripting or CI use.
 */
import { input, select, confirm, password } from '@inquirer/prompts'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import type { Command } from 'commander'

const CONFIG_PATH = join(homedir(), '.crosstalk', 'config.toml')
const PUBLIC_RELAY = 'wss://relay.crosstalk.sh'
const TEMPLATE_REPO = 'cordfuse/crosstalk'

interface InitOptions {
  force?:                boolean
  transport?:            string
  relayUrl?:             string
  relaySecret?:          string
  actorEmailSuffix?:     string
  heartbeatInterval?:    string
  skipSmoke?:            boolean
}

interface ResolvedConfig {
  transport:           string
  relayUrl:            string
  relaySecret?:        string
  actorEmailSuffix:    string
  heartbeatInterval:   number
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('interactive setup wizard — writes ~/.crosstalk/config.toml and validates the relay')
    .option('--force',                            'overwrite existing ~/.crosstalk/config.toml')
    .option('--transport <path>',                 'non-interactive: path to local transport clone')
    .option('--relay-url <url>',                  'non-interactive: relay URL (default ' + PUBLIC_RELAY + ')')
    .option('--relay-secret <secret>',            'non-interactive: relay secret (omit for open mode)')
    .option('--actor-email-suffix <domain>',      'non-interactive: actor email suffix')
    .option('--heartbeat-interval <seconds>',     'non-interactive: heartbeat interval (default 120)')
    .option('--skip-smoke',                       'skip the post-config relay smoke test')
    .action(async (options: InitOptions) => {
      await runInit(options)
    })
}

async function runInit(options: InitOptions): Promise<void> {
  // Refuse to overwrite an existing config without --force.
  if (existsSync(CONFIG_PATH) && !options.force) {
    console.error(`✗ ${CONFIG_PATH} already exists.`)
    console.error(`  Re-run with --force to overwrite, or edit the file by hand.`)
    process.exit(1)
  }

  const interactive = !options.transport && !options.relayUrl

  const config = interactive
    ? await runInteractive()
    : runNonInteractive(options)

  if (!options.skipSmoke) {
    await smokeRelay(config.relayUrl)
  }

  writeConfigAtomic(config)
  printNextSteps(config)
}

// ── Interactive wizard ──────────────────────────────────────────────────────

async function runInteractive(): Promise<ResolvedConfig> {
  console.log('Welcome to Crosstalk. Let\'s get you set up.\n')

  const transport          = await pickTransport()
  const { relayUrl, relaySecret } = await pickRelay()
  const actorEmailSuffix   = await pickActorEmailSuffix()
  const heartbeatInterval  = await pickHeartbeatInterval()

  return { transport, relayUrl, relaySecret, actorEmailSuffix, heartbeatInterval }
}

async function pickTransport(): Promise<string> {
  const choice = await select({
    message: 'Where is your transport repo?',
    choices: [
      { name: 'I have an existing local clone',                                     value: 'local' },
      { name: 'Clone an existing repo from a URL',                                  value: 'clone' },
      { name: `Create a new transport from ${TEMPLATE_REPO} template (uses gh CLI)`, value: 'template' },
    ],
  })

  if (choice === 'local') {
    return await input({
      message: 'Path to your cloned transport:',
      validate: validateTransportPath,
    })
  }

  if (choice === 'clone') {
    const url = await input({
      message: 'Repo URL to clone:',
      validate: (v) => v.length > 0 ? true : 'URL required',
    })
    const target = await input({
      message: 'Local path to clone into:',
      default: join(homedir(), 'crosstalk-transport'),
    })
    runOrExit(['git', 'clone', url, target], `Cloning ${url} → ${target}`)
    return target
  }

  // template
  if (spawnSync('gh', ['--version'], { stdio: 'pipe' }).status !== 0) {
    console.error('✗ `gh` CLI not found. Install from https://cli.github.com/ and run `gh auth login`,')
    console.error('  then re-run `crosstalk init`. Or pick a different transport option above.')
    process.exit(1)
  }

  const repoName = await input({
    message: 'Name for your new transport repo (lowercase letters, numbers, dashes):',
    validate: (v) => /^[a-z0-9][a-z0-9-]*$/.test(v) ? true : 'Use lowercase letters, numbers, and dashes only',
  })
  const isPrivate = await confirm({ message: 'Create as private repo?', default: true })
  const target = await input({
    message: 'Local path to clone into:',
    default: join(homedir(), repoName),
  })

  runOrExit([
    'gh', 'repo', 'create', repoName,
    '--template', TEMPLATE_REPO,
    isPrivate ? '--private' : '--public',
    '--clone', target,
  ], `Creating ${repoName} from ${TEMPLATE_REPO} template`)

  return target
}

async function pickRelay(): Promise<{ relayUrl: string; relaySecret?: string }> {
  const choice = await select({
    message: 'Which relay should runtimes connect to?',
    choices: [
      { name: `Cordfuse public — ${PUBLIC_RELAY} (free, no auth required)`,  value: 'public' },
      { name: 'Self-hosted (you provide URL + optional secret)',              value: 'self' },
    ],
  })

  if (choice === 'public') {
    return { relayUrl: PUBLIC_RELAY }
  }

  const relayUrl = await input({
    message: 'Relay URL (e.g. wss://relay.your-domain.example):',
    validate: (v) => v.startsWith('ws://') || v.startsWith('wss://') ? true : 'URL must start with ws:// or wss://',
  })
  const wantsAuth = await confirm({ message: 'Does this relay require authentication?', default: false })
  if (!wantsAuth) {
    return { relayUrl }
  }
  const relaySecret = await password({ message: 'Relay secret (will not echo):' })
  return { relayUrl, relaySecret }
}

async function pickActorEmailSuffix(): Promise<string> {
  return await input({
    message: 'Actor email suffix (used for machine actor git commits):',
    default: guessEmailSuffixFromGitConfig(),
  })
}

async function pickHeartbeatInterval(): Promise<number> {
  const str = await input({
    message: 'Heartbeat interval in seconds (actor dispatch timeout):',
    default: '120',
    validate: (v) => /^\d+$/.test(v) && parseInt(v) > 0 ? true : 'Positive integer required',
  })
  return parseInt(str)
}

// ── Non-interactive mode ────────────────────────────────────────────────────

function runNonInteractive(options: InitOptions): ResolvedConfig {
  const transport = options.transport
  if (!transport) {
    console.error('✗ --transport is required in non-interactive mode')
    process.exit(1)
  }
  const validation = validateTransportPath(transport)
  if (validation !== true) {
    console.error(`✗ ${validation}`)
    process.exit(1)
  }
  return {
    transport,
    relayUrl:           options.relayUrl ?? PUBLIC_RELAY,
    relaySecret:        options.relaySecret,
    actorEmailSuffix:   options.actorEmailSuffix ?? guessEmailSuffixFromGitConfig(),
    heartbeatInterval:  options.heartbeatInterval ? parseInt(options.heartbeatInterval) : 120,
  }
}

// ── Validation, smoke, write, helpers ───────────────────────────────────────

function validateTransportPath(value: string): true | string {
  if (!value)                                       return 'Path required'
  if (!existsSync(value))                           return `Path does not exist: ${value}`
  if (!existsSync(join(value, 'channels')))         return `${value} doesn't look like a Crosstalk transport (no channels/ subdirectory)`
  if (!existsSync(join(value, 'manifest')))         return `${value} doesn't look like a Crosstalk transport (no manifest/ subdirectory)`
  return true
}

async function smokeRelay(relayUrl: string): Promise<void> {
  console.log('\nValidating relay...')
  const httpUrl = relayUrl.replace(/^ws/, 'http') + '/version'
  try {
    const res = await fetch(httpUrl, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) {
      console.warn(`  ⚠ ${httpUrl} returned ${res.status} — config will be written anyway`)
      return
    }
    const data = (await res.json()) as { version?: string }
    console.log(`  ✓ Connected to ${relayUrl}`)
    console.log(`  ✓ Relay version: ${data.version ?? 'unknown'}`)
  } catch (err) {
    console.warn(`  ⚠ Could not reach ${relayUrl}: ${err instanceof Error ? err.message : String(err)}`)
    console.warn(`  Config will be written anyway. Verify the relay is reachable before starting the daemon.`)
  }
}

function writeConfigAtomic(config: ResolvedConfig): void {
  const lines: string[] = [
    `transport = "${config.transport}"`,
    `actor-email-suffix = "${config.actorEmailSuffix}"`,
    `default-heartbeat-interval = ${config.heartbeatInterval}`,
    ``,
    `[relay]`,
    `mode = "client"`,
    `url = "${config.relayUrl}"`,
  ]
  if (config.relaySecret) {
    lines.push(`secret = "${config.relaySecret}"`)
  } else {
    lines.push(`# Public Cordfuse relay is open mode — no secret required.`)
    lines.push(`# Set this only if pointing at a self-hosted relay with RELAY_SECRET configured.`)
  }
  const content = lines.join('\n') + '\n'

  // Atomic write: temp file in the SAME directory as the destination, then
  // rename. Cross-filesystem rename() throws EXDEV on Linux (e.g. when /tmp
  // is tmpfs and $HOME is on disk), so the temp must live next to the target.
  const configDir = join(homedir(), '.crosstalk')
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })

  const tmpFile = join(configDir, `.config.toml.tmp.${process.pid}`)
  writeFileSync(tmpFile, content)
  renameSync(tmpFile, CONFIG_PATH)
}

function printNextSteps(config: ResolvedConfig): void {
  const webhookUrl = config.relayUrl.replace(/^ws/, 'http') + '/webhook'
  console.log(`\n✓ Wrote ${CONFIG_PATH}`)
  console.log('')
  console.log('Next steps:')
  console.log(`  • Configure your transport repo's GitHub webhook:`)
  console.log(`      URL:          ${webhookUrl}`)
  console.log(`      Content type: application/json`)
  console.log(`      Events:       Just the push event`)
  console.log(`      Secret:       ${config.relaySecret ? '(use the same secret you configured here)' : '(leave blank — open-mode relay accepts unsigned)'}`)
  console.log(`  • Run \`crosstalk\` to start the daemon`)
  console.log('')
  console.log('Full setup walkthrough: https://github.com/cordfuse/crosstalk#quickstart')
}

function guessEmailSuffixFromGitConfig(): string {
  try {
    const result = spawnSync('git', ['config', '--get', 'user.email'], { encoding: 'utf-8' })
    if (result.status === 0 && result.stdout.trim()) {
      const email = result.stdout.trim()
      const at = email.indexOf('@')
      if (at >= 0) return email.slice(at + 1)
    }
  } catch {
    // fall through to default
  }
  return 'crosstalk.noreply'
}

function runOrExit(cmd: string[], description: string): void {
  console.log(`\n${description}...`)
  const result = spawnSync(cmd[0]!, cmd.slice(1), { stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`✗ Command failed: ${cmd.join(' ')}`)
    process.exit(1)
  }
}
