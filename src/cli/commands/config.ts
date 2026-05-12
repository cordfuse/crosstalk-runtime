/**
 * `crosstalk config show [--json] [--show-secrets]` — print effective config.
 *
 * Reads ~/.crosstalk/config.toml via the same loadConfig() the daemon uses,
 * so what you see here is exactly what the daemon will load. Secrets are
 * masked by default (relay.secret → "<redacted>"); --show-secrets prints raw.
 */
import type { Command } from 'commander'
import { loadConfig } from '../../config.js'

interface ConfigShowOptions {
  json?:        boolean
  showSecrets?: boolean
}

export function registerConfigCommand(program: Command): void {
  const cfg = program
    .command('config')
    .description('inspect runtime config (subcommand: show)')

  cfg
    .command('show')
    .description('print effective config (~/.crosstalk/config.toml as parsed by the daemon)')
    .option('--json',          'machine-readable JSON output')
    .option('--show-secrets',  'print relay.secret in cleartext (default: redacted)')
    .action(async (opts: ConfigShowOptions) => {
      await runConfigShow(opts)
    })
}

async function runConfigShow(opts: ConfigShowOptions): Promise<void> {
  let config: Awaited<ReturnType<typeof loadConfig>>
  try {
    config = await loadConfig()
  } catch (err) {
    console.error(`✗ Could not load config: ${err instanceof Error ? err.message : err}`)
    console.error(`  Run \`crosstalk init\` to create one.`)
    process.exit(1)
  }

  // Build a redacted/safe view
  const safe = {
    transport:                  config.transport,
    actorEmailSuffix:           config.actorEmailSuffix,
    defaultHeartbeatInterval:   config.defaultHeartbeatInterval,
    defaultHumanActor:          config.defaultHumanActor ?? null,
    relay: {
      mode:   config.relay.mode,
      url:    config.relay.url,
      secret: config.relay.secret
        ? (opts.showSecrets ? config.relay.secret : '<redacted>')
        : null,
      port:   config.relay.port,
    },
    agents: config.agents,
  }

  if (opts.json) {
    console.log(JSON.stringify(safe, null, 2))
    return
  }

  // TOML-shaped pretty print
  console.log(`transport = "${safe.transport}"`)
  console.log(`actor-email-suffix = "${safe.actorEmailSuffix}"`)
  console.log(`default-heartbeat-interval = ${safe.defaultHeartbeatInterval}`)
  if (safe.defaultHumanActor) {
    console.log(`default-human-actor = "${safe.defaultHumanActor}"`)
  }
  console.log(``)
  console.log(`[relay]`)
  console.log(`mode = "${safe.relay.mode}"`)
  console.log(`url = "${safe.relay.url}"`)
  if (safe.relay.secret) {
    console.log(`secret = "${safe.relay.secret}"`)
  }
  // Operator-defined [agents.X] entries (alpha.6+). Built-in defaults
  // (claude/gemini/codex/qwen/opencode) live in code, not config —
  // this section only shows what the operator explicitly added.
  for (const [name, def] of Object.entries(safe.agents)) {
    console.log(``)
    console.log(`[agents.${name}]`)
    console.log(`spawn = ${JSON.stringify(def.spawn)}`)
  }
}
