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

  // Build a redacted/safe view. v1.6.0-alpha.2+ — surfaces every config
  // field the loader honors, including v1.3 operator, v1.4 bootstrap.coordinator-
  // address, and v1.6 [agent-environment]. Critical for operator debuggability:
  // when a feature "doesn't work", first question is "did config load it?".
  const safe = {
    transport:                  config.transport,
    operator:                   config.operator ?? null,             // v1.3+
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
      pollIntervalSeconds: config.relay.pollIntervalSeconds,         // v1.2+
    },
    bootstrap: {                                                      // v0.7+, extended v1.4
      timeoutMs:            config.bootstrap.timeoutMs,
      deferOnNoCoordinator: config.bootstrap.deferOnNoCoordinator,
      decayCheckIntervalMs: config.bootstrap.decayCheckIntervalMs,
      coordinatorAddress:   config.bootstrap.coordinatorAddress ?? null,  // v1.4+
    },
    agents:   config.agents,
    agentEnv: redactAgentEnv(config.agentEnv, opts.showSecrets),     // v1.6+
  }

  if (opts.json) {
    console.log(JSON.stringify(safe, null, 2))
    return
  }

  // TOML-shaped pretty print
  console.log(`transport = "${safe.transport}"`)
  if (safe.operator) console.log(`operator = "${safe.operator}"`)
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
  if (safe.relay.mode === 'disabled') {
    console.log(`poll-interval-seconds = ${safe.relay.pollIntervalSeconds}`)
  }
  // Bootstrap section — print non-default values so output stays tight
  // for ordinary configs but reveals operator overrides.
  const bs = safe.bootstrap
  const hasBootstrapOverrides = bs.timeoutMs !== 300_000
    || bs.deferOnNoCoordinator !== false
    || bs.decayCheckIntervalMs !== 60_000
    || bs.coordinatorAddress !== null
  if (hasBootstrapOverrides) {
    console.log(``)
    console.log(`[bootstrap]`)
    if (bs.timeoutMs !== 300_000)                console.log(`timeout-ms = ${bs.timeoutMs}`)
    if (bs.deferOnNoCoordinator !== false)       console.log(`defer-on-no-coordinator = ${bs.deferOnNoCoordinator}`)
    if (bs.decayCheckIntervalMs !== 60_000)      console.log(`decay-check-interval-ms = ${bs.decayCheckIntervalMs}`)
    if (bs.coordinatorAddress)                   console.log(`coordinator-address = "${bs.coordinatorAddress}"`)
  }
  // Operator-defined [agents.X] entries (alpha.6+). Built-in defaults
  // (claude/gemini/codex/qwen/opencode) live in code, not config —
  // this section only shows what the operator explicitly added.
  for (const [name, def] of Object.entries(safe.agents)) {
    console.log(``)
    console.log(`[agents.${name}]`)
    console.log(`spawn = ${JSON.stringify(def.spawn)}`)
  }
  // [agent-environment] (v1.6.0-alpha.1+) — env vars forwarded to spawned
  // agent children. Values likely to look like secrets (anything with KEY
  // or TOKEN in the name) get redacted unless --show-secrets is set.
  const env = safe.agentEnv
  if (env && Object.keys(env).length > 0) {
    console.log(``)
    console.log(`[agent-environment]`)
    for (const [key, value] of Object.entries(env)) {
      console.log(`${key} = "${value}"`)
    }
  }
}

const SECRET_KEY_PATTERN = /key|token|secret|password/i

function redactAgentEnv(env: Record<string, string>, showSecrets?: boolean): Record<string, string> {
  if (showSecrets) return env
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    out[k] = SECRET_KEY_PATTERN.test(k) ? '<redacted>' : v
  }
  return out
}
