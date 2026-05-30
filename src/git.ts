import { spawn } from 'child_process';
import { withTurnq, type TurnqConfig } from './turnq.js';

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

// Serializes pull + commit + push through a turnq channel (local or distributed).
// Returns true on success or no-op, throws on push failure.
export async function commitAndPush(opts: {
  transportPath: string;
  files: string[];
  message: string;
  identity: { name: string; email: string };
  turnq?: TurnqConfig;
}): Promise<boolean> {
  const { transportPath, files, message, identity, turnq } = opts;
  return withTurnq(turnq, async () => {
    await git(transportPath, ['pull', '--rebase', 'origin', 'main']);
    await git(transportPath, ['add', '--', ...files]);
    const { code: commitCode } = await git(transportPath, [
      '-c', `user.name=${identity.name}`,
      '-c', `user.email=${identity.email}`,
      'commit', '-m', message,
    ]);
    if (commitCode !== 0) return true; // nothing to commit
    const { code, stderr } = await git(transportPath, ['push', 'origin', 'main']);
    if (code !== 0) throw new Error(`git push failed: ${stderr}`);
    return true;
  });
}
