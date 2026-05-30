import { spawn } from 'child_process';
import { createCoordinator, type Coordinator, type CoordinatorOptions } from '@cordfuse/turnq/coordinator';

interface GitResult {
  code: number;
  stderr: string;
}

function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise(resolve => {
    const proc = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stderr = '';
    proc.stderr?.on('data', chunk => { stderr += String(chunk); });
    proc.on('exit', code => resolve({ code: code ?? 0, stderr }));
    proc.on('error', () => resolve({ code: 127, stderr: 'spawn error' }));
  });
}

export async function pull(transportPath: string): Promise<void> {
  await git(transportPath, ['pull', '--rebase', 'origin', 'main']);
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
    if (code !== 0) throw new Error(`git push failed: ${stderr}`);
    return true;
  });
}
