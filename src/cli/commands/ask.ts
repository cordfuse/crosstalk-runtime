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
 *
 * Realistic timing (v1.13+ note): a single `ask` round-trip is typically
 * 30–60 seconds — the concierge personality has to read the full tool
 * manifest, pick a tool, and run a CLI subprocess on top of the normal
 * agent latency. This is structurally heavier than a plain agent reply
 * (which is closer to 5–15s). The default heartbeat-interval on the
 * framework concierge.md is sized for this; if you swap in a custom
 * concierge under manifest/custom/actors/, keep heartbeat-interval at
 * 90+ seconds so a slower-than-average run doesn't get SIGTERM'd.
 */
import type { Command } from 'commander'
import { loadConfig } from '../../config.js'
import { listChannels } from '../lib/channel.js'
import { runPost, type PostOptions } from './post.js'

interface AskOptions {
  channel?: string  // v1.8.1+ — optional when config.defaultChannel is set
  from?:    string
  push?:    boolean   // commander inverts --no-push to push: false
}

export function registerAskCommand(program: Command): void {
  program
    .command('ask <text>')
    .description('shortcut: post a natural-language request to the concierge actor — equivalent to `crosstalk post --to concierge[@<op>] --body "<text>"`')
    .option('-c, --channel <name-or-guid>', 'channel to post into (friendly name from _header.md, or full GUID; v1.8.1+ — optional when `default-channel` is set in config.toml)')
    .option('-f, --from <actor>',           'sender identity (defaults to default-human-actor in config.toml)')
    .option('--no-push',                    'commit but do not push (leaves the commit local)')
    .action(async (text: string, opts: AskOptions) => {
      const config = await loadConfig()
      const conciergeAddress = config.operator ? `concierge@${config.operator}` : 'concierge'

      // v1.8.1+ — `default-channel` config supplies the channel when
      // `--channel` is omitted. v1.16.1+ — also auto-detects when exactly
      // one non-system channel exists.
      let channel = opts.channel ?? config.defaultChannel
      if (!channel) {
        const available = listChannels(config.transport)
        if (available.length === 1) {
          channel = available[0]!.name
          console.log(`  (using channel "${channel}" — set default-channel = "${channel}" in config.toml to suppress this hint)`)
        } else if (available.length === 0) {
          console.error(`✗ No channels found in transport. Create one with: crosstalk channel new <name>`)
          process.exit(1)
        } else {
          console.error(`✗ --channel is required when multiple channels exist.`)
          console.error(`  Available: ${available.map(c => c.name).join(', ')}`)
          console.error(`  Or set default-channel = "<name>" in ~/.crosstalk/config.toml.`)
          process.exit(1)
        }
      }

      const postOpts: PostOptions = {
        channel,
        to:   conciergeAddress,
        from: opts.from,
        body: text,
        type: 'text',
        push: opts.push,
      }
      await runPost(postOpts)
    })
}
