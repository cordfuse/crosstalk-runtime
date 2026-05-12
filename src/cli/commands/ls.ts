/**
 * `crosstalk ls [<glob>]` — top-level shortcut for `crosstalk channel list`.
 *
 * Same logic + flags as `channel list`, plus an optional positional glob
 * pattern for friendly-name filtering. Sorted by last activity descending.
 *
 *   crosstalk ls                 # all channels
 *   crosstalk ls 'v0.4*'         # glob filter
 *   crosstalk ls --grep release  # substring filter
 *   crosstalk ls --json          # machine-readable
 *   crosstalk ls --include-system
 */
import type { Command } from 'commander'
import { runChannelList } from './channel.js'

interface LsOptions {
  includeSystem?: boolean
  json?:          boolean
  grep?:          string
}

export function registerLsCommand(program: Command): void {
  program
    .command('ls [glob]')
    .description('list channels — friendly shortcut for `channel list` (sorted by last activity)')
    .option('--include-system', 'include _system channels (hidden by default)')
    .option('--json',           'machine-readable JSON output')
    .option('--grep <pattern>', 'substring filter on channel name (case-insensitive)')
    .action(async (glob: string | undefined, opts: LsOptions) => {
      await runChannelList(opts, glob)
    })
}
