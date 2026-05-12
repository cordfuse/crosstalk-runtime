/**
 * `crosstalk version` — print runtime version + framework version (when
 * a transport is configured and accessible).
 *
 * Reads VERSION (framework) and CROSSTALK-VERSION (protocol) from the
 * configured transport when present. Silently degrades when no transport
 * is configured — `crosstalk version` should never fail just because
 * `crosstalk init` hasn't been run.
 */
import type { Command } from 'commander'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import pkg from '../../../package.json' with { type: 'json' }

export function registerVersionCommand(program: Command): void {
  program
    .command('version')
    .description('print runtime + framework + protocol versions')
    .action(async () => {
      console.log(`crosstalk runtime  v${pkg.version}`)

      // Framework + protocol versions: read from the configured transport
      // if loadConfig() succeeds. Don't fail otherwise — version should
      // always work, even on a bare install.
      try {
        await tryPrintTransportVersions()
      } catch {
        // silently ignore — version should never fail on a bare install
      }
    })
}

async function tryPrintTransportVersions(): Promise<void> {
  // Lazy import so version subcommand stays fast on a bare install where
  // ~/.crosstalk/config.toml doesn't exist yet.
  const { loadConfig } = await import('../../config.js')
  let config: Awaited<ReturnType<typeof loadConfig>>
  try {
    config = await loadConfig()
  } catch {
    return  // no config, nothing to print
  }

  const versionPath          = join(config.transport, 'VERSION')
  const crosstalkVersionPath = join(config.transport, 'CROSSTALK-VERSION')

  if (existsSync(versionPath)) {
    try {
      const v = readFileSync(versionPath, 'utf-8').trim()
      if (v) console.log(`framework          v${v}`)
    } catch { /* ignore */ }
  }

  if (existsSync(crosstalkVersionPath)) {
    try {
      const v = readFileSync(crosstalkVersionPath, 'utf-8').trim()
      if (v) console.log(`protocol           v${v}`)
    } catch { /* ignore */ }
  }
}
