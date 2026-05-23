/**
 * `crosstalk thread <subcommand>` — orchestration thread inspection.
 *
 *   crosstalk thread show <thread-id> [--channel <guid>]
 *   crosstalk thread list [--channel <guid>]
 *
 * Thread state files live at channels/<guid>/_threads/<thread-id>.json.
 * Commands here are read-only — they never modify thread state.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Command } from 'commander'
import { loadConfig } from '../../config.js'
import type { ThreadState } from '../../orchestration.js'

// ── helpers ───────────────────────────────────────────────────────────────

function loadThread(transportRoot: string, channel: string, threadId: string): ThreadState | null {
  const safeId = threadId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const p = join(transportRoot, 'channels', channel, '_threads', `${safeId}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as ThreadState;
  } catch {
    return null;
  }
}

function listThreadsInChannel(transportRoot: string, channel: string): ThreadState[] {
  const dir = join(transportRoot, 'channels', channel, '_threads');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .flatMap(f => {
        try {
          return [JSON.parse(readFileSync(join(dir, f), 'utf-8')) as ThreadState];
        } catch { return []; }
      });
  } catch { return []; }
}

function resolveChannels(transportRoot: string, channelOpt: string | undefined): string[] {
  if (channelOpt) return [channelOpt];
  const channelsDir = join(transportRoot, 'channels');
  if (!existsSync(channelsDir)) return [];
  return readdirSync(channelsDir).filter(e => !e.startsWith('.') && !e.startsWith('_'));
}

function printThread(state: ThreadState): void {
  const statusIcon = state.state === 'complete' ? '[DONE]' : '[...]';
  console.log(`${statusIcon} thread: ${state.threadId}`);
  console.log(`  channel:    ${state.channel}`);
  console.log(`  spawn:      ${state.spawnRelPath}`);
  if (state.synthesizer) {
    console.log(`  synthesizer: ${state.synthesizer}`);
  }
  console.log(`  expects:    ${state.expects}`);
  console.log(`  children:   ${state.children.length}`);
  console.log(`  responses:  ${state.responses.length}/${state.expects}`);
  if (state.respondents.length > 0) {
    console.log(`  respondents: ${state.respondents.join(', ')}`);
  }
  if (state.synthesisRelPath) {
    console.log(`  synthesis:  ${state.synthesisRelPath}`);
  }
  console.log(`  created:    ${state.createdAt}`);
  if (state.completedAt) {
    console.log(`  completed:  ${state.completedAt}`);
  }
  if (state.responses.length > 0) {
    console.log('  response paths:');
    for (const r of state.responses) {
      console.log(`    ${r}`);
    }
  }
}

// ── command registration ───────────────────────────────────────────────────

export function registerThreadCommand(program: Command): void {
  const thread = program
    .command('thread')
    .description('inspect orchestration threads (subcommands: show, list)')

  // thread show <thread-id> [--channel <guid>]
  thread
    .command('show <thread-id>')
    .description('display state of a specific thread')
    .option('-c, --channel <guid>', 'channel GUID (auto-detected if only one channel exists)')
    .action(async (threadId: string, opts: { channel?: string }) => {
      const config = await loadConfig();
      const channels = resolveChannels(config.transport, opts.channel);

      if (channels.length === 0) {
        console.error('[thread] no channels found in transport');
        process.exit(1);
      }

      for (const channel of channels) {
        const state = loadThread(config.transport, channel, threadId);
        if (state) {
          printThread(state);
          return;
        }
      }

      console.error(`[thread] thread '${threadId}' not found`);
      process.exit(1);
    });

  // thread list [--channel <guid>]
  thread
    .command('list')
    .description('list all threads across channels (or within a specific channel)')
    .option('-c, --channel <guid>', 'channel GUID (lists all channels if omitted)')
    .action(async (opts: { channel?: string }) => {
      const config = await loadConfig();
      const channels = resolveChannels(config.transport, opts.channel);

      if (channels.length === 0) {
        console.error('[thread] no channels found in transport');
        process.exit(1);
      }

      let total = 0;
      for (const channel of channels) {
        const threads = listThreadsInChannel(config.transport, channel);
        for (const state of threads) {
          printThread(state);
          console.log('');
          total++;
        }
      }

      if (total === 0) {
        console.log('[thread] no threads found');
      } else {
        console.log(`${total} thread(s)`);
      }
    });
}
