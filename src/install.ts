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
      : `Re-run with sudo:\n\n  sudo crosstalk install`;
    console.error(`[install] root/admin privileges required.\n${cmd}`);
    process.exit(1);
  }
}

function createDirs(paths: PlatformInfo['paths']): void {
  for (const dir of [paths.configDir, paths.dataDir, paths.transportsDir, paths.workspacesDir, paths.sshDir]) {
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
    // Find a free UID in the system range (< 500 on macOS)
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

function writeInitialConfig(platform: PlatformInfo): void {
  if (existsSync(platform.paths.configFile)) {
    console.log('[install] config already exists — skipping');
    return;
  }
  const config = { transports: [] as string[], workspaces: [] as string[] };
  // 644: config contains only paths/settings (no secrets); needs to be readable by non-root users for `crosstalk with`
  writeFileSync(platform.paths.configFile, stringifyYaml(config), { mode: 0o644 });
  if (platform.id !== 'windows') {
    execSync(`chown root:${platform.serviceUser} ${platform.paths.configFile}`);
  }
  console.log(`[install] config written to ${platform.paths.configFile}`);
}

function resolveBinaryPath(): string {
  // The running binary path
  const bin = process.execPath;
  // If running via node/bun (not compiled), use the script path
  if (bin.includes('node') || bin.includes('bun')) {
    // Find the installed crosstalk binary on PATH
    try {
      const which = execSync('which crosstalk 2>/dev/null || where crosstalk 2>nul', { encoding: 'utf-8' }).trim();
      if (which) return which;
    } catch {}
  }
  return bin;
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function runInstall(argv: string[]): Promise<void> {
  const platform = detectPlatform();
  requireRoot(platform);

  console.log(`[install] platform=${platform.id} service-manager=${platform.serviceManager}`);

  createDirs(platform.paths);
  createSystemUser(platform);
  setOwnership(platform);
  const pubKey = generateSshKey(platform);
  writeInitialConfig(platform);

  const binaryPath = resolveBinaryPath();

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
  console.log('Next step — add this SSH public key as a deploy key (read/write) on your transport repo(s):');
  console.log('\n' + pubKey + '\n');
  console.log('Then add a transport:');
  console.log('  sudo crosstalk add-transport <git-url>\n');
  if (platform.serviceManager === 'systemd') console.log('  sudo systemctl start crosstalk');
  if (platform.serviceManager === 'launchd')  console.log('  sudo launchctl load -w /Library/LaunchDaemons/ai.cordfuse.crosstalk.plist');
}

export async function runUninstall(argv: string[]): Promise<void> {
  const platform = detectPlatform();
  requireRoot(platform);

  if (platform.serviceManager === 'systemd')    systemd.uninstall();
  else if (platform.serviceManager === 'launchd') launchd.uninstall();
  else if (platform.serviceManager === 'windows-scm') winSvc.uninstall();

  const wipeData = argv.includes('--purge');
  if (wipeData) {
    execSync(`rm -rf ${platform.paths.dataDir}`);
    execSync(`rm -rf ${platform.paths.configDir}`);
    console.log('[uninstall] data and config removed');
  } else {
    console.log(`[uninstall] data preserved at ${platform.paths.dataDir} — run with --purge to remove`);
  }
}

export async function runAddTransport(argv: string[]): Promise<void> {
  const platform = detectPlatform();
  requireRoot(platform);

  const gitUrl = argv[0];
  if (!gitUrl) {
    console.error('usage: crosstalk add-transport <git-url>');
    process.exit(1);
  }

  // Derive a local directory name from the URL
  const slug = gitUrl.replace(/\.git$/, '').split(/[/:]/).slice(-2).join('-');
  const dest  = join(platform.paths.transportsDir, slug);

  if (existsSync(dest)) {
    console.error(`[add-transport] already exists: ${dest}`);
    process.exit(1);
  }

  const sshKey  = join(platform.paths.sshDir, 'id_ed25519');
  const knownHosts = join(platform.paths.sshDir, 'known_hosts');
  const gitSsh  = `ssh -i ${sshKey} -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${knownHosts}`;

  console.log(`[add-transport] cloning ${gitUrl} → ${dest}`);
  execSync(`GIT_SSH_COMMAND="${gitSsh}" git clone ${gitUrl} ${dest}`, { stdio: 'inherit' });

  if (platform.id !== 'windows') {
    execSync(`chown -R ${platform.serviceUser} ${dest}`);
  }

  // Append to config
  const raw     = existsSync(platform.paths.configFile) ? readFileSync(platform.paths.configFile, 'utf-8') : '';
  const config  = raw ? parseYaml(raw) : {};
  const transports: string[] = config.transports ?? (config.transport ? [config.transport] : []);
  delete config.transport;
  config.transports = [...transports, dest];
  writeFileSync(platform.paths.configFile, stringifyYaml(config));

  console.log(`[add-transport] registered. Restart the daemon to pick it up.`);
  if (platform.serviceManager === 'systemd')    console.log('  sudo systemctl restart crosstalk');
  if (platform.serviceManager === 'launchd')    console.log('  sudo launchctl kickstart -k system/ai.cordfuse.crosstalk');
  if (platform.serviceManager === 'windows-scm') console.log('  sc.exe stop crosstalk && sc.exe start crosstalk');
}

export async function runRemoveTransport(argv: string[]): Promise<void> {
  const platform = detectPlatform();
  requireRoot(platform);

  const name = argv[0];
  if (!name) {
    console.error('usage: crosstalk remove-transport <name-or-path>');
    process.exit(1);
  }

  const raw    = readFileSync(platform.paths.configFile, 'utf-8');
  const config = parseYaml(raw);
  const before: string[] = config.transports ?? (config.transport ? [config.transport] : []);
  const after  = before.filter(t => !t.includes(name));

  if (before.length === after.length) {
    console.error(`[remove-transport] no transport matching "${name}" found`);
    process.exit(1);
  }

  config.transports = after;
  delete config.transport;
  writeFileSync(platform.paths.configFile, stringifyYaml(config));
  console.log(`[remove-transport] removed from config. Data at ${join(platform.paths.transportsDir, name)} is preserved.`);
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
  console.log(`\nOpen a session:\n  crosstalk with --workspace ${repoName}\n`);
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
  const after  = before.filter(w => !w.includes(name));

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
  console.log(`transports-dir:   ${platform.paths.transportsDir}`);
  console.log(`workspaces-dir:   ${platform.paths.workspacesDir}`);

  const raw    = existsSync(platform.paths.configFile) ? readFileSync(platform.paths.configFile, 'utf-8') : '';
  const config = raw ? parseYaml(raw) : {};
  const transports: string[] = config.transports ?? (config.transport ? [config.transport] : []);
  const workspaces: string[] = config.workspaces ?? [];

  console.log('');
  if (transports.length === 0) {
    console.log('transports:       (none)');
  } else {
    console.log('transports:');
    for (const t of transports) console.log(`  ${t}`);
  }

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
