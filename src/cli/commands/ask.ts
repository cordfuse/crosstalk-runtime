/**
 * `crosstalk ask` — natural-language shortcut to the concierge actor.
 *
 * v1.8.0-alpha.1+. Delegates to `crosstalk post` with the `--to` field
 * prefilled as the concierge address for this daemon's operator mode:
 *
 *   single-op    → --to concierge
 *   multi-op     → --to concierge@<config.operator>
 *
 * The concierge actor itself lives in the framework spec
 * (cordfuse/crosstalk: manifest/framework/actors/concierge.md). It reads
 * the tool manifests under manifest/framework/tools/ + manifest/custom/
 * tools/, picks a tool that matches the request, and executes it (with
 * the confirmation loop for mutating tools defined in TOOL-CALL.md).
 *
 * The runtime work for this command is small — concierge is just an
 * actor, the runtime primitives that make it useful (multi-op routing,
 * pool dispatch, agent credential isolation, signing) all landed in
 * v1.3-v1.7. `ask` is the ergonomic seam: operators stop typing
 * `crosstalk post --to concierge@steve --from steve -b "..."` every
 * time and just type `crosstalk ask "..."`.
 *
 * What `ask` doesn't do:
 *   - Pick a channel for you. `--channel` is required (alpha.1 scope).
 *     A future alpha could remember the last-touched channel or use a
 *     `default-channel` config field.
 *   - Verify the concierge actor exists. If it's not in your transport,
 *     the post still lands and the message just sits unanswered. (The
 *     usual post-validation surfaces this via "unknown target" unless
 *     --allow-unknown-targets — see the resolve flow in post.ts.)
 */
import type { Command } from 'commander'
import { loadConfig } from '../../config.js'
import { runPost, type PostOptions } from './post.js'

interface AskOptions {
  channel:  string
  from?:    string
  push?:    boolean   // commander inverts --no-push to push: false
}

export function registerAskCommand(program: Command): void {
  program
    .command('ask <text>')
    .description('shortcut: post a natural-language request to the concierge actor — equivalent to `crosstalk post --to concierge[@<op>] --body "<text>"`')
    .requiredOption('-c, --channel <name-or-guid>', 'channel to post into (friendly name from _header.md, or full GUID)')
    .option('-f, --from <actor>',                   'sender identity (defaults to default-human-actor in config.toml)')
    .option('--no-push',                            'commit but do not push (leaves the commit local)')
    .action(async (text: string, opts: AskOptions) => {
      const config = await loadConfig()
      const conciergeAddress = config.operator ? `concierge@${config.operator}` : 'concierge'

      const postOpts: PostOptions = {
        channel: opts.channel,
        to:      conciergeAddress,
        from:    opts.from,
        body:    text,
        type:    'text',
        push:    opts.push,
        // No dispatch policy override — concierge is typically a singleton
        // (not a pool). If operators stage concierge as a pool they can
        // use `crosstalk post --dispatch round-robin` directly.
      }
      await runPost(postOpts)
    })
}
