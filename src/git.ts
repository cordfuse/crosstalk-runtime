import { spawn } from 'child_process';
import { join } from 'path';
import { createCoordinator, type Coordinator, type CoordinatorOptions } from '@cordfuse/turnq/coordinator';
import { log } from './log.js';
import { detectPlatform } from './platform.js';

interface GitResult {
  code: number;
  stderr: string;
}

// Build GIT_SSH_COMMAND pointing to the crosstalk deploy key so that git
// operations work when the daemon runs as a system service account
// (Linux/macOS) that has no SSH agent or user-level credentials configured.
function sshEnv(): Record<string, string> {
  const { paths } = detectPlatform();
  const key        = join(paths.sshDir, 'id_ed25519');
  const knownHosts = join(paths.sshDir, 'known_hosts');
  return {
    GIT_SSH_COMMAND: `ssh -i "${key}" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="${knownHosts}"`,
  };
}

function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise(resolve => {
    const proc = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...sshEnv() },
    });
    let stderr = '';
    proc.stderr?.on('data', chunk => { stderr += String(chunk); });
    proc.on('exit', code => resolve({ code: code ?? 0, stderr }));
    proc.on('error', () => resolve({ code: 127, stderr: 'spawn error' }));
  });
}

export async function pull(transportPath: string): Promise<void> {
  // fetch + reset --hard is used instead of pull --rebase --autostash because
  // the daemon never has legitimate unstaged tracked-file changes; reset --hard
  // is predictable and avoids stash-pop conflicts when host files change upstream.
  const fetch = await git(transportPath, ['fetch', 'origin', 'main']);
  if (fetch.code !== 0) {
    log.error('pull_failed', { stderr: fetch.stderr.trim().slice(0, 200) });
    return;
  }
  await git(transportPath, ['reset', '--hard', 'origin/main']);
}

let _coordinator: Coordinator | null = null;
let _channel = 'crosstalk:push';

export async function initCoordinator(opts?: CoordinatorOptions & { channel?: string }): Promise<void> {
  _channel = opts?.channel ?? 'crosstalk:push';
  const c = await createCoordinator(opts);
  await c.createChannel(_channel, { leaseMs: 120_000 });
  _coordinator = c;
}

async function getCoordinator(): Promise<Coordinator> {
  if (!_coordinator) {
    const c = await createCoordinator();
    await c.createChannel(_channel, { leaseMs: 120_000 });
    _coordinator = c;
  }
  return _coordinator;
}

export async function commitAndPush(opts: {
  transportPath: string;
  files: string[];
  message: string;
  identity: { name: string; email: string };
}): Promise<boolean> {
  const { transportPath, files, message, identity } = opts;
  const c = await getCoordinator();
  return c.withTurn(_channel, async () => {
    await git(transportPath, ['pull', '--rebase', 'origin', 'main']);
    await git(transportPath, ['add', '--', ...files]);
    const { code: commitCode } = await git(transportPath, [
      '-c', `user.name=${identity.name}`,
      '-c', `user.email=${identity.email}`,
      'commit', '-m', message,
    ]);
    if (commitCode !== 0) return true;
    const { code, stderr } = await git(transportPath, ['push', 'origin', 'main']);
    if (code !== 0) {
      log.error('push_failed', { stderr: stderr.trim().slice(0, 200) });
      throw new Error(`git push failed: ${stderr}`);
    }
    log.info('push_complete', { files: files.length });
    return true;
  });
}
