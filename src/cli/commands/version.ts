/**
 * `crosstalk version` — print runtime version.
 *
 * Future: when the daemon is config-aware (post-`crosstalk init`), also
 * print the framework version from the configured transport's framework
 * VERSION file. Today it prints the runtime version only — the framework
 * lookup lands in a follow-up alpha alongside `crosstalk config show`.
 */
import type { Command } from 'commander'
import pkg from '../../../package.json' with { type: 'json' }

export function registerVersionCommand(program: Command): void {
  program
    .command('version')
    .description('print runtime version (and framework version when transport is configured)')
    .action(() => {
      console.log(`crosstalk runtime v${pkg.version}`)
      // TODO(alpha.N+): if ~/.crosstalk/config.toml exists and points at a
      // transport, also read <transport>/VERSION and print framework version.
      // Skipped here — config loader assumes transport is set in client mode,
      // and we don't want `crosstalk version` to fail on an unconfigured machine.
    })
}
