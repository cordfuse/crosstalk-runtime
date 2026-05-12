/**
 * Crosstalk CLI dispatcher.
 *
 * Entered when `crosstalk <subcommand> ...` is invoked. The daemon path
 * (no-args) and the relay-server mode (`RELAY_MODE=server`) bypass this
 * module entirely — see src/index.ts for the dispatch.
 *
 * Subcommands are added one per file in src/cli/commands/ and registered
 * here. Each subcommand owns its own option parsing + handler. Keep this
 * router thin.
 */
import { Command } from 'commander'
import pkg from '../../package.json' with { type: 'json' }
import { registerVersionCommand } from './commands/version.js'
import { registerInitCommand } from './commands/init.js'

export async function runCLI(argv: string[]): Promise<void> {
  const program = new Command()

  program
    .name('crosstalk')
    .description(
      'Crosstalk runtime — daemon, relay server, and operator CLI. Run with no\n' +
      'arguments to start the daemon (the original behavior). Use the subcommands\n' +
      'below to interact with the swarm without writing files by hand.'
    )
    .version(pkg.version, '-v, --version', 'print runtime version')
    .helpOption('-h, --help', 'show help')

  registerVersionCommand(program)
  registerInitCommand(program)

  await program.parseAsync(argv)
}
