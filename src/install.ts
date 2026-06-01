import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { detectPlatform, isRoot, type PlatformInfo } from './platform.js';
import * as systemd  from './service/systemd.js';
import * as launchd  from './service/launchd.js';
import * as winSvc   from './service/windows.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function requireRoot(platform: PlatformInfo): void {
  if (!isRoot()) {
    const cmd = platform.id === 'windows'
      ? 'Run this command in an elevated (Administrator) terminal.'
      : `Re-run with sudo:\n\n  sudo crosstalk ${process.argv[2]} ${process.argv.slice(3).join(' ')}`.trimEnd();
    console.error(`[install] root/admin privileges required.\n${cmd}`);
    process.exit(1);
  }
}

function createDirs(paths: PlatformInfo['paths']): void {
  for (const dir of [paths.configDir, paths.dataDir, paths.transportDir, paths.workspacesDir, paths.sshDir]) {
    mkdirSync(dir, { recursive: true });
  }
  console.log('[install] directories created');
}

function createSystemUser(platform: PlatformInfo): void {
  const user = platform.serviceUser;

  if (platform.id === 'linux' || platform.id === 'wsl') {
    if (execSync(`id -u ${user} 2>/dev/null; true`, { encoding: 'utf-8' }).trim()) return;
    execSync(`useradd --system --no-create-home --shell /usr/sbin/nologin --home-dir ${platform.paths.dataDir} ${user}`);
    console.log(`[install] system user '${user}' created`);
  }

  if (platform.id === 'macos') {
    try { execSync(`dscl . -read /Users/${user} 2>/dev/null`); return; } catch {}
    const uid = 499;
    execSync(`dscl . -create /Users/${user}`);
    execSync(`dscl . -create /Users/${user} UserShell /usr/bin/false`);
    execSync(`dscl . -create /Users/${user} UniqueID ${uid}`);
    execSync(`dscl . -create /Users/${user} PrimaryGroupID 80`);
    execSync(`dscl . -create /Users/${user} NFSHomeDirectory ${platform.paths.dataDir}`);
    console.log(`[install] system user '${user}' created`);
  }
  // Windows: NT SERVICE\<name> is a virtual account — no creation needed
}

function setOwnership(platform: PlatformInfo): void {
  if (platform.id === 'windows') return;
  const { dataDir, sshDir } = platform.paths;
  const user = platform.serviceUser;
  execSync(`chown -R ${user} ${dataDir}`);
  chmodSync(sshDir, 0o700);
  console.log(`[install] ownership set to '${user}'`);
}

function generateSshKey(platform: PlatformInfo): string {
  const keyPath = join(platform.paths.sshDir, 'id_ed25519');
  if (existsSync(keyPath)) {
    console.log('[install] SSH key already exists — skipping generation');
  } else {
    execSync(`ssh-keygen -t ed25519 -C "crosstalk@${platform.id}" -N "" -f ${keyPath}`);
    if (platform.id !== 'windows') {
      const user = platform.serviceUser;
      execSync(`chown ${user} ${keyPath} ${keyPath}.pub`);
      chmodSync(keyPath, 0o600);
    }
    console.log(`[install] SSH key generated at ${keyPath}`);
  }
  return readFileSync(`${keyPath}.pub`, 'utf-8').trim();
}

function cloneTransport(platform: PlatformInfo, gitUrl: string): string {
  const dest   = platform.paths.transportDir;
  const sshKey     = join(platform.paths.sshDir, 'id_ed25519');
  const knownHosts = join(platform.paths.sshDir, 'known_hosts');
  const gitSsh     = `ssh -i ${sshKey} -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${knownHosts}`;

  if (existsSync(join(dest, '.git'))) {
    console.log(`[install] transport already cloned at ${dest} — skipping`);
    return dest;
  }

  console.log(`[install] cloning transport ${gitUrl} → ${dest}`);
  execSync(`GIT_SSH_COMMAND="${gitSsh}" git clone ${gitUrl} ${dest}`, { stdio: 'inherit' });

  if (platform.id !== 'windows') {
    execSync(`chown -R ${platform.serviceUser} ${dest}`);
  }
  console.log('[install] transport cloned');
  return dest;
}

function writeConfig(platform: PlatformInfo, transportPath: string): void {
  const existing = existsSync(platform.paths.configFile)
    ? parseYaml(readFileSync(platform.paths.configFile, 'utf-8'))
    : {};

  existing.transport  = transportPath;
  existing.workspaces = existing.workspaces ?? [];

  // 644: config has no secrets (SSH keys live in .ssh/); must be readable by non-root for `crosstalk with`
  writeFileSync(platform.paths.configFile, stringifyYaml(existing), { mode: 0o644 });
  if (platform.id !== 'windows') {
    execSync(`chown root:${platform.serviceUser} ${platform.paths.configFile}`);
  }
  console.log(`[install] config written to ${platform.paths.configFile}`);
}

function installBinary(platform: PlatformInfo): string {
  const dest = platform.id === 'windows'
    ? 'C:\\Program Files\\crosstalk\\crosstalk.exe'
    : '/usr/local/bin/crosstalk';

  let src = process.execPath;

  // Running under interpreter (dev mode) — locate the compiled binary via which
  if (src.includes('node') || src.includes('bun')) {
    try {
      const which = execSync('which crosstalk 2>/dev/null', { encoding: 'utf-8' }).trim();
      if (which) src = which;
    } catch {}
  }

  if (src !== dest) {
    mkdirSync(join(dest, '..'), { recursive: true });
    execSync(`cp ${src} ${dest}`);
    chmodSync(dest, 0o755);
    console.log(`[install] binary installed to ${dest}`);
  }

  return dest;
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function runInstall(argv: string[]): Promise<void> {
  const gitUrl = argv[0];
  if (!gitUrl || gitUrl.startsWith('-')) {
    console.error('usage: sudo crosstalk install <git-url>');
    console.error('       git-url: SSH URL of your Crosstalk transport repo');
    process.exit(1);
  }

  const platform = detectPlatform();
  requireRoot(platform);

  console.log(`[install] platform=${platform.id} service-manager=${platform.serviceManager}`);

  createDirs(platform.paths);
  createSystemUser(platform);
  setOwnership(platform);
  const pubKey = generateSshKey(platform);
  const transportPath = cloneTransport(platform, gitUrl);
  writeConfig(platform, transportPath);

  const binaryPath = installBinary(platform);

  if (platform.serviceManager === 'systemd') {
    systemd.install(platform.paths, binaryPath);
  } else if (platform.serviceManager === 'launchd') {
    launchd.install(platform.paths, binaryPath);
  } else if (platform.serviceManager === 'windows-scm') {
    winSvc.install(platform.paths, binaryPath);
  } else {
    console.warn('[install] no supported service manager detected (WSL without systemd?)');
    console.warn('[install] start the daemon manually: crosstalk --config /etc/crosstalk/config.yaml');
  }

  console.log('\n[install] done.\n');
  console.log('Add this SSH public key as a deploy key (read/write) on your transport repo:');
  console.log('\n' + pubKey + '\n');
  console.log('Then add a workspace and start:');
  console.log('  sudo crosstalk add-workspace <git-url>');
  if (platform.serviceManager === 'systemd') console.log('  sudo systemctl start crosstalk');
  if (platform.serviceManager === 'launchd') console.log('  sudo launchctl load -w /Library/LaunchDaemons/ai.cordfuse.crosstalk.plist');
}

export async function runUninstall(argv: string[]): Promise<void> {
  const platform = detectPlatform();
  requireRoot(platform);

  if (platform.serviceManager === 'systemd')          systemd.uninstall();
  else if (platform.serviceManager === 'launchd')     launchd.uninstall();
  else if (platform.serviceManager === 'windows-scm') winSvc.uninstall();

  // Remove system user
  if (platform.id === 'linux' || platform.id === 'wsl') {
    try { execSync(`userdel ${platform.serviceUser}`); console.log(`[uninstall] user '${platform.serviceUser}' removed`); } catch {}
  } else if (platform.id === 'macos') {
    try { execSync(`dscl . -delete /Users/${platform.serviceUser}`); console.log(`[uninstall] user '${platform.serviceUser}' removed`); } catch {}
  }

  const wipeData = argv.includes('--purge');
  if (wipeData) {
    execSync(`rm -rf ${platform.paths.dataDir}`);
    execSync(`rm -rf ${platform.paths.configDir}`);
    console.log('[uninstall] data and config removed');
  } else {
    console.log(`[uninstall] data preserved at ${platform.paths.dataDir} — run with --purge to remove`);
  }
}

export async function runAddWorkspace(argv: string[]): Promise<void> {
  const platform = detectPlatform();
  requireRoot(platform);

  const gitUrl = argv[0];
  if (!gitUrl) {
    console.error('usage: crosstalk add-workspace <git-url>');
    process.exit(1);
  }

  const repoName = gitUrl.replace(/\.git$/, '').split(/[/:]/).at(-1)!;
  const dest     = join(platform.paths.workspacesDir, repoName);

  if (existsSync(dest)) {
    console.error(`[add-workspace] already exists: ${dest}`);
    process.exit(1);
  }

  const sshKey     = join(platform.paths.sshDir, 'id_ed25519');
  const knownHosts = join(platform.paths.sshDir, 'known_hosts');
  const gitSsh     = `ssh -i ${sshKey} -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${knownHosts}`;

  console.log(`[add-workspace] cloning ${gitUrl} → ${dest}`);
  execSync(`GIT_SSH_COMMAND="${gitSsh}" git clone ${gitUrl} ${dest}`, { stdio: 'inherit' });

  if (platform.id !== 'windows') {
    execSync(`chown -R ${platform.serviceUser} ${dest}`);
  }

  const raw        = existsSync(platform.paths.configFile) ? readFileSync(platform.paths.configFile, 'utf-8') : '';
  const config     = raw ? parseYaml(raw) : {};
  const workspaces: string[] = config.workspaces ?? [];
  config.workspaces = [...workspaces, dest];
  writeFileSync(platform.paths.configFile, stringifyYaml(config));

  console.log(`[add-workspace] registered: ${dest}`);
  console.log(`\nOpen a session:\n  crosstalk open --workspace ${repoName}\n`);
}

export async function runRemoveWorkspace(argv: string[]): Promise<void> {
  const platform = detectPlatform();
  requireRoot(platform);

  const name = argv[0];
  if (!name) {
    console.error('usage: crosstalk remove-workspace <name-or-path>');
    process.exit(1);
  }

  const raw    = readFileSync(platform.paths.configFile, 'utf-8');
  const config = parseYaml(raw);
  const before: string[] = config.workspaces ?? [];
  const after  = before.filter((w: string) => !w.includes(name));

  if (before.length === after.length) {
    console.error(`[remove-workspace] no workspace matching "${name}" found`);
    process.exit(1);
  }

  config.workspaces = after;
  writeFileSync(platform.paths.configFile, stringifyYaml(config));
  console.log(`[remove-workspace] removed from config. Data at ${join(platform.paths.workspacesDir, name)} is preserved.`);
}

export async function runStatus(): Promise<void> {
  const platform = detectPlatform();
  let svcStatus  = '';

  if (platform.serviceManager === 'systemd')          svcStatus = systemd.status();
  else if (platform.serviceManager === 'launchd')     svcStatus = launchd.status();
  else if (platform.serviceManager === 'windows-scm') svcStatus = winSvc.status();
  else svcStatus = 'no supported service manager';

  console.log(`platform:         ${platform.id}`);
  console.log(`service-manager:  ${platform.serviceManager}`);
  console.log(`config:           ${platform.paths.configFile}`);

  const raw    = existsSync(platform.paths.configFile) ? readFileSync(platform.paths.configFile, 'utf-8') : '';
  const config = raw ? parseYaml(raw) : {};
  const transport: string  = config.transport ?? '(none)';
  const workspaces: string[] = config.workspaces ?? [];

  console.log(`transport:        ${transport}`);
  console.log('');
  if (workspaces.length === 0) {
    console.log('workspaces:       (none)');
  } else {
    console.log('workspaces:');
    for (const w of workspaces) console.log(`  ${w}`);
  }

  console.log('');
  console.log(svcStatus);
}
