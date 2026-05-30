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

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export async function pull(transportPath: string): Promise<void> {
  await git(transportPath, ['pull', '--rebase', 'origin', 'main']);
}

// Serializes pull + commit + push through a turnq channel.
// Holds the token only for the critical section — pull/commit/push.
// Returns true on success or no-op, throws on push failure.
export async function commitAndPushWithTurnq(opts: {
  transportPath: string;
  files: string[];
  message: string;
  identity: { name: string; email: string };
  turnq: TurnqConfig;
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

// Stages files, commits under the given identity, then pushes with JITTER.
// Returns true on successful push, false if all retries failed (caller defers to next tick).
export async function commitAndPush(opts: {
  transportPath: string;
  files: string[];          // paths relative to transportPath
  message: string;
  identity: { name: string; email: string };
  jitterMs: number;
  maxRetries?: number;
}): Promise<boolean> {
  const { transportPath, files, message, identity, jitterMs, maxRetries = 3 } = opts;

  await git(transportPath, ['add', '--', ...files]);

  const { code: commitCode } = await git(transportPath, [
    '-c', `user.name=${identity.name}`,
    '-c', `user.email=${identity.email}`,
    'commit', '-m', message,
  ]);

  if (commitCode !== 0) {
    // Nothing staged or commit error — treat as success (no-op tick)
    return true;
  }

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    await sleep(Math.floor(Math.random() * jitterMs));
    const { code } = await git(transportPath, ['push', 'origin', 'main']);
    if (code === 0) return true;
    // Non-fast-forward — pull and retry
    await git(transportPath, ['pull', '--rebase', 'origin', 'main']);
  }

  return false;
}
