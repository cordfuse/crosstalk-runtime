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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, platform } from 'node:os'
import { spawnSync } from 'node:child_process'
import type { Command } from 'commander'

// v1.16.1+ — honor CROSSTALK_CONFIG env var / --config flag (set in index.ts
// argv pre-processing before CLI dispatch). Previously a module-level constant
// caused init to always write ~/.crosstalk/config.toml regardless of the env var.
function getConfigPath(): string {
  return process.env.CROSSTALK_CONFIG ?? join(homedir(), '.crosstalk', 'config.toml')
}

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
  operator?:             string
}

interface ResolvedConfig {
  transport:           string
  relayMode:           'client' | 'disabled'  // v0.9.0-alpha.2+ — server mode is daemon-internal, not an init-time choice
  relayUrl:            string  // ignored when relayMode === 'disabled'
  relaySecret?:        string
  actorEmailSuffix:    string
  heartbeatInterval:   number
  operator:            string
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
    .option('--operator <handle>',                'non-interactive: operator handle (kebab-case, e.g. "steve")')
    .action(async (options: InitOptions) => {
      await runInit(options)
    })
}

async function runInit(options: InitOptions): Promise<void> {
  // Refuse to overwrite an existing config without --force.
  const configPath = getConfigPath()
  if (existsSync(configPath) && !options.force) {
    console.error(`✗ ${configPath} already exists.`)
    console.error(`  Re-run with --force to overwrite, or edit the file by hand.`)
    process.exit(1)
  }

  const interactive = !options.transport && !options.relayUrl

  const config = interactive
    ? await runInteractive()
    : runNonInteractive(options)

  // v0.9.0-alpha.2+: skip relay smoke when relay is disabled — there's
  // nothing to ping, and a network call would mislead operators who
  // explicitly chose offline mode.
  if (!options.skipSmoke && config.relayMode !== 'disabled') {
    await smokeRelay(config.relayUrl)
  }

  writeConfigAtomic(config)
  await generateOperatorSigningKey(config)
  printNextSteps(config)

  // v0.9.0-alpha.2+: offer to install the user-level service unit (systemd
  // user / launchd LaunchAgent) so the daemon starts at login. Interactive
  // only — non-interactive runs (CI, scripted setup) skip this since they
  // can call `crosstalk service install` themselves explicitly.
  if (interactive) {
    await maybeOfferServiceInstall()
  }
}

// ── Interactive wizard ──────────────────────────────────────────────────────

async function runInteractive(): Promise<ResolvedConfig> {
  console.log('Welcome to Crosstalk. Let\'s get you set up.\n')

  const transport          = await pickTransport()
  const { relayMode, relayUrl, relaySecret } = await pickRelay()
  const operator           = await pickOperatorHandle()
  const actorEmailSuffix   = await pickActorEmailSuffix()
  const heartbeatInterval  = await pickHeartbeatInterval()

  return { transport, relayMode, relayUrl, relaySecret, operator, actorEmailSuffix, heartbeatInterval }
}

async function pickOperatorHandle(): Promise<string> {
  return await input({
    message: 'Operator handle (your identity on this transport — kebab-case, e.g. "steve"):',
    default: guessOperatorHandleFromGitConfig(),
    validate: (v) => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(v)
      ? true
      : 'Use lowercase letters, numbers, and hyphens only (kebab-case)',
  })
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

async function pickRelay(): Promise<{ relayMode: 'client' | 'disabled'; relayUrl: string; relaySecret?: string }> {
  const choice = await select({
    message: 'Which relay should runtimes connect to?',
    choices: [
      { name: `Cordfuse public — ${PUBLIC_RELAY} (free, no auth required)`,  value: 'public' },
      { name: 'Self-hosted (you provide URL + optional secret)',              value: 'self' },
      { name: 'Disabled — offline mode (you sync the transport via git/rsync/NAS yourself; no real-time dispatch)', value: 'disabled' },
    ],
  })

  if (choice === 'disabled') {
    return { relayMode: 'disabled', relayUrl: PUBLIC_RELAY }  // url is recorded but unused at runtime
  }

  if (choice === 'public') {
    return { relayMode: 'client', relayUrl: PUBLIC_RELAY }
  }

  const relayUrl = await input({
    message: 'Relay URL (e.g. wss://relay.your-domain.example):',
    validate: (v) => v.startsWith('ws://') || v.startsWith('wss://') ? true : 'URL must start with ws:// or wss://',
  })
  const wantsAuth = await confirm({ message: 'Does this relay require authentication?', default: false })
  if (!wantsAuth) {
    return { relayMode: 'client', relayUrl }
  }
  const relaySecret = await password({ message: 'Relay secret (will not echo):' })
  return { relayMode: 'client', relayUrl, relaySecret }
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
  const operator = options.operator ?? guessOperatorHandleFromGitConfig()
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(operator)) {
    console.error(`✗ Invalid operator handle "${operator}" — use kebab-case (e.g. "steve"). Pass --operator <handle> to set it.`)
    process.exit(1)
  }
  return {
    transport,
    relayMode:          'client',  // non-interactive defaults to client; explicit --relay-mode flag would override (not yet wired)
    relayUrl:           options.relayUrl ?? PUBLIC_RELAY,
    relaySecret:        options.relaySecret,
    operator,
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
  // v1.16.1+ — preserve fields that init doesn't manage (default-human-actor,
  // default-channel) when overwriting an existing config with --force. Without
  // this, --force silently drops any field not in the init flag surface.
  const configPath = getConfigPath()
  let preservedHumanActor: string | undefined
  let preservedDefaultChannel: string | undefined
  if (existsSync(configPath)) {
    for (const line of readFileSync(configPath, 'utf-8').split('\n')) {
      const m = line.match(/^(default-human-actor|default-channel)\s*=\s*"(.+)"/)
      if (!m) continue
      if (m[1] === 'default-human-actor') preservedHumanActor = m[2]
      if (m[1] === 'default-channel')      preservedDefaultChannel = m[2]
    }
  }

  const lines: string[] = [
    `transport = "${config.transport}"`,
    `operator = "${config.operator}"`,
    `actor-email-suffix = "${config.actorEmailSuffix}"`,
    `default-heartbeat-interval = ${config.heartbeatInterval}`,
  ]
  if (preservedHumanActor)    lines.push(`default-human-actor = "${preservedHumanActor}"`)
  if (preservedDefaultChannel) lines.push(`default-channel = "${preservedDefaultChannel}"`)
  lines.push(``, `[relay]`, `mode = "${config.relayMode}"`)
  if (config.relayMode === 'disabled') {
    lines.push(`# Offline mode — daemon does not connect to a relay.`)
    lines.push(`# You're responsible for transport sync (git pull, rsync, NAS, etc.).`)
    lines.push(`# To re-enable real-time dispatch later, change mode to "client" + set url.`)
  } else {
    lines.push(`url = "${config.relayUrl}"`)
    if (config.relaySecret) {
      lines.push(`secret = "${config.relaySecret}"`)
    } else {
      lines.push(`# Public Cordfuse relay is open mode — no secret required.`)
      lines.push(`# Set this only if pointing at a self-hosted relay with RELAY_SECRET configured.`)
    }
  }
  const content = lines.join('\n') + '\n'

  // Atomic write: temp file in the SAME directory as the destination, then
  // rename. Cross-filesystem rename() throws EXDEV on Linux (e.g. when /tmp
  // is tmpfs and $HOME is on disk), so the temp must live next to the target.
  const configDir = join(homedir(), '.crosstalk')
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })

  const tmpFile = join(configDir, `.config.toml.tmp.${process.pid}`)
  writeFileSync(tmpFile, content)
  renameSync(tmpFile, configPath)
}

function printNextSteps(config: ResolvedConfig): void {
  console.log(`\n✓ Wrote ${getConfigPath()}`)
  console.log('')
  console.log('Next steps:')
  if (config.relayMode === 'client') {
    const webhookUrl = config.relayUrl.replace(/^ws/, 'http') + '/webhook'
    console.log(`  • Configure your transport repo's GitHub webhook:`)
    console.log(`      URL:          ${webhookUrl}`)
    console.log(`      Content type: application/json`)
    console.log(`      Events:       Just the push event`)
    console.log(`      Secret:       ${config.relaySecret ? '(use the same secret you configured here)' : '(leave blank — open-mode relay accepts unsigned)'}`)
  } else {
    console.log(`  • Sync the transport yourself — \`git pull\` on a cron, rsync, NAS sync, etc.`)
    console.log(`    The daemon's fs watcher will pick up changes once they land in the transport dir.`)
  }
  console.log(`  • Commit your signing public key so other operators can verify your messages:`)
  console.log(`      cd ${config.transport} && git add manifest/identities/${config.operator}.pub && git commit -m "identity: publish signing key for ${config.operator}" && git push`)
  console.log(`  • Run \`crosstalk\` to start the daemon (or accept the next prompt to install it as a user-level service)`)
  console.log('')
  console.log('Full setup walkthrough: https://github.com/cordfuse/crosstalk#quickstart')
}

async function generateOperatorSigningKey(config: ResolvedConfig): Promise<void> {
  const { generateSigningKey, publishPublicKey } = await import('../../signing.js')
  const addr = config.operator
  try {
    const { publicKeyPem } = generateSigningKey(addr)
    publishPublicKey(config.transport, addr, publicKeyPem)
    console.log(`\n✓ Generated ed25519 signing key for "${addr}"`)
    console.log(`  Private: ~/.crosstalk/keys/${addr}.sign  (machine-local, never committed)`)
    console.log(`  Public:  ${config.transport}/manifest/identities/${addr}.pub  (commit + push this)`)
  } catch (err: unknown) {
    // Key already exists — skip silently; operator re-ran init after initial setup.
    if (err instanceof Error && err.message.includes('refusing to overwrite')) {
      console.log(`\n  (signing key for "${addr}" already exists — skipped)`)
      return
    }
    console.warn(`\n⚠ Could not generate signing key for "${addr}": ${err instanceof Error ? err.message : String(err)}`)
    console.warn(`  Run 'crosstalk actor key generate-signing ${addr}' manually to set it up.`)
  }
}

function guessOperatorHandleFromGitConfig(): string {
  try {
    const result = spawnSync('git', ['config', '--get', 'user.name'], { encoding: 'utf-8' })
    if (result.status === 0 && result.stdout.trim()) {
      // Slugify: lowercase, replace spaces/underscores with hyphens, strip non-alphanumeric
      const slug = result.stdout.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '')
      if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug)) return slug
    }
  } catch {
    // fall through
  }
  return 'operator'
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

// ── v0.9.0-alpha.2+: post-init service install offer ────────────────────────

/** After the config write, offer to install a user-level service unit so the
 * daemon starts at login. Skipped on unsupported platforms (anything other
 * than linux/darwin) so non-blocking. Failures during install print an
 * actionable error but don't fail init overall — the config is already
 * written, the operator can re-run `crosstalk service install` later. */
async function maybeOfferServiceInstall(): Promise<void> {
  const p = platform()
  if (p !== 'linux' && p !== 'darwin') {
    // Windows / unsupported — skip silently. The init flow finished successfully;
    // service-install is purely additive and not available on this platform anyway.
    return
  }

  const platformLabel = p === 'linux' ? 'systemd user unit' : 'launchd LaunchAgent'
  const wantsInstall = await confirm({
    message: `Install ${platformLabel} now so the daemon starts at login?`,
    default: false,
  })
  if (!wantsInstall) {
    console.log(`  (skipped — run \`crosstalk service install\` later if you change your mind)`)
    return
  }

  // Defer-import so the service module isn't loaded on non-interactive init or
  // when the operator declines (avoids paying the import cost on the cold path).
  try {
    const { runInstall } = await import('./service.js')
    runInstall()
  } catch (err) {
    console.error(`✗ service install failed: ${err instanceof Error ? err.message : String(err)}`)
    console.error(`  Init succeeded; you can re-run \`crosstalk service install\` to retry.`)
  }
}
