import { join } from 'path';
import { homedir } from 'os';
import { mkdir, writeFile } from 'fs/promises';

const ACTOR_CLONES_DIR = join(homedir(), '.crosstalk', 'actor-clones');

function deriveNamespace(transportRoot: string, remoteUrl: string | null): string {
  if (remoteUrl) {
    const match = remoteUrl.match(/\/([^/]+?)(?:\.git)?$/);
    if (match) return match[1];
  }
  return transportRoot.split('/').at(-1) ?? 'default';
}

async function runGit(cwd: string, args: string[], env?: Record<string, string>): Promise<number> {
  const proc = Bun.spawn({
    cmd: ['git', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
  return proc.exited;
}

async function getRemoteUrl(repoPath: string): Promise<string | null> {
  const proc = Bun.spawn({
    cmd: ['git', 'remote', 'get-url', 'origin'],
    cwd: repoPath,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  const code = await proc.exited;
  if (code !== 0) return null;
  const url = await new Response(proc.stdout).text();
  return url.trim() || null;
}

async function hasRemote(repoPath: string): Promise<boolean> {
  return (await getRemoteUrl(repoPath)) !== null;
}

async function pushWithRetry(repoPath: string, maxAttempts = 5): Promise<void> {
  if (!await hasRemote(repoPath)) return;
  for (let i = 0; i < maxAttempts; i++) {
    const code = await runGit(repoPath, ['push']);
    if (code === 0) return;
    console.log(`[git] push rejected, rebasing (attempt ${i + 1}/${maxAttempts})`);
    await runGit(repoPath, ['pull', '--rebase']);
    await Bun.sleep(1000 + Math.random() * 4000);
  }
  console.error('[git] push failed after max retries');
}

// Returns the path to an actor's own clone of the transport.
// If the transport has a remote, creates/updates a clone at ~/.crosstalk/actor-clones/<name>/.
// Falls back to the shared transport path for local-only (no remote) transports.
export async function ensureActorClone(
  transportRoot: string,
  actorName: string,
): Promise<string> {
  const remoteUrl = await getRemoteUrl(transportRoot);
  if (!remoteUrl) return transportRoot; // local-only — shared path, no isolation possible

  const namespace = deriveNamespace(transportRoot, remoteUrl);
  const clonePath = join(ACTOR_CLONES_DIR, namespace, actorName);

  try {
    await Bun.file(join(clonePath, '.git', 'HEAD')).text();
    // Clone exists — sync before dispatch so actor sees the triggering message
    const code = await runGit(clonePath, ['pull', '--rebase', '--autostash']);
    if (code !== 0) console.warn(`[git] pull failed for ${actorName} — proceeding with stale clone`);
  } catch {
    // First time — clone the transport for this actor
    const namespaceDir = join(ACTOR_CLONES_DIR, namespace);
    await mkdir(namespaceDir, { recursive: true });
    console.log(`[git] initialising clone for ${namespace}/${actorName}`);
    const code = await runGit(namespaceDir, ['clone', remoteUrl, actorName]);
    if (code !== 0) {
      console.error(`[git] clone failed for ${actorName} — falling back to shared transport`);
      return transportRoot;
    }
  }

  return clonePath;
}

export async function commitActorMessage(
  repoPath: string,
  channelGuid: string,
  actorName: string,
  gitEmail: string,
): Promise<void> {
  const channelPath = join('channels', channelGuid);
  const env = {
    GIT_AUTHOR_NAME: actorName,
    GIT_AUTHOR_EMAIL: gitEmail,
    GIT_COMMITTER_NAME: actorName,
    GIT_COMMITTER_EMAIL: gitEmail,
  };

  const addCode = await runGit(repoPath, ['add', channelPath], env);
  if (addCode !== 0) {
    console.error(`[git] add failed for ${channelPath}`);
    return;
  }

  const commitCode = await runGit(
    repoPath,
    ['commit', '-m', `msg: ${actorName} → ${channelGuid.slice(0, 8)}`],
    env,
  );

  if (commitCode === 1) return; // nothing to commit

  if (commitCode !== 0) {
    console.error(`[git] commit failed (code ${commitCode})`);
    return;
  }

  await pushWithRetry(repoPath);
}

export async function writeResponseMessage(
  repoPath: string,
  channelGuid: string,
  actorName: string,
  gitEmail: string,
  body: string,
  agent?: string,
  model?: string,
): Promise<void> {
  const now = new Date();
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  const datePath = `${now.getUTCFullYear()}/${p(now.getUTCMonth() + 1)}/${p(now.getUTCDate())}`;
  const filename = `${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}${p(now.getUTCMilliseconds(), 3)}Z.md`;
  const dir = join(repoPath, 'channels', channelGuid, datePath);
  await mkdir(dir, { recursive: true });

  const agentLine = agent ? `agent: ${agent}\n` : '';
  const modelLine = model ? `model: ${model}\n` : '';
  const content = `---\nfrom: ${actorName}\nto: all\ntimestamp: ${now.toISOString()}\ntype: text\n${agentLine}${modelLine}---\n\n${body}\n`;

  await writeFile(join(dir, filename), content, 'utf8');
  await commitActorMessage(repoPath, channelGuid, actorName, gitEmail);
}

export async function commitWatcherMessage(
  transportRoot: string,
  relPath: string,
  label: string,
): Promise<void> {
  const env = {
    GIT_AUTHOR_NAME: 'watcher',
    GIT_AUTHOR_EMAIL: 'watcher@crosstalk.noreply',
    GIT_COMMITTER_NAME: 'watcher',
    GIT_COMMITTER_EMAIL: 'watcher@crosstalk.noreply',
  };

  const addCode = await runGit(transportRoot, ['add', '_system'], env);
  if (addCode !== 0) {
    console.error('[git] add failed for _system');
    return;
  }

  const commitCode = await runGit(
    transportRoot,
    ['commit', '-m', `sys: watcher/${label} → ${relPath}`],
    env,
  );

  if (commitCode === 1) return;
  if (commitCode !== 0) {
    console.error(`[git] commit failed for system message (${label})`);
    return;
  }

  await pushWithRetry(transportRoot);
}

export async function pullTransport(transportRoot: string): Promise<void> {
  const code = await runGit(transportRoot, ['pull', '--rebase']);
  if (code !== 0) console.error('[git] pull failed after webhook trigger');
}

// Derives the canonical machine actor email from name + transport suffix.
// Humans set git-email explicitly in their actor profile — this is for machines only.
export function machineGitEmail(actorName: string, suffix: string): string {
  return `${actorName}@${suffix}`;
}
