import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, copyFileSync, rmSync } from 'fs';
import { execSync } from 'child_process';
import { join, basename } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { detectPlatform, isRoot, type PlatformInfo } from './platform.js';
import * as systemd  from './service/systemd.js';
import * as launchd  from './service/launchd.js';
import * as winSvc   from './service/windows.js';

// ── Helpers ────────────────────────────────────────────────────────────────

// Extract "owner/repo" from any git URL or local path.
//   git@github.com:owner/repo.git  →  owner/repo
//   https://github.com/owner/repo  →  owner/repo
//   /some/local/owner/repo         →  owner/repo
function ownerRepo(gitUrl: string): string {
  const clean = gitUrl.replace(/\.git$/, '');
  const sshMatch = clean.match(/:([^/]+\/[^/]+)$/);
  if (sshMatch) return sshMatch[1];
  const parts = clean.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

// Return the "owner/repo" label for a full filesystem path.
function transportLabel(fullPath: string): string {
  const parts = fullPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

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
  const { dataDir, sshDir, transportsDir, workspacesDir } = platform.paths;
  const user = platform.serviceUser;
  execSync(`chown -R ${user}:${user} ${dataDir}`);
  chmodSync(sshDir, 0o700);

  // Make transports + workspaces group-writable so the operator can write without sudo
  for (const dir of [transportsDir, workspacesDir]) {
    if (existsSync(dir)) {
      execSync(`chmod -R g+w ${dir}`);
      execSync(`find ${dir} -type d -exec chmod g+s {} +`); // setgid — new files inherit group
    }
  }

  // Add the invoking operator to the service group
  const operator = process.env['SUDO_USER'];
  if (operator) {
    try {
      execSync(`usermod -aG ${user} ${operator}`);
      console.log(`[install] user '${operator}' added to '${user}' group — re-login to activate`);
    } catch {}
  }

  console.log(`[install] ownership set to '${user}', transport + workspaces group-writable`);
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

function cloneRepo(platform: PlatformInfo, gitUrl: string, dest: string): void {
  const sshKey     = join(platform.paths.sshDir, 'id_ed25519');
  const knownHosts = join(platform.paths.sshDir, 'known_hosts');
  const gitSsh     = `ssh -i ${sshKey} -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${knownHosts}`;

  console.log(`[install] cloning ${gitUrl} → ${dest}`);
  execSync(`git clone ${gitUrl} ${dest}`, {
    stdio: 'inherit',
    env: { ...process.env, GIT_SSH_COMMAND: gitSsh },
  });

  if (platform.id !== 'windows') {
    execSync(`chown -R ${platform.serviceUser}:${platform.serviceUser} ${dest}`);
    execSync(`chmod -R g+w ${dest}`);
    execSync(`find ${dest} -type d -exec chmod g+s {} +`);
  }
}

// Read config as raw object, normalising old single-transport format to new array format.
function readRawConfig(configFile: string): Record<string, unknown> {
  if (!existsSync(configFile)) return { transports: [] };
  const raw = parseYaml(readFileSync(configFile, 'utf-8')) as Record<string, unknown>;
  // Migrate old format
  if (raw.transport && !raw.transports) {
    const oldWorkspaces = Array.isArray(raw.workspaces) ? raw.workspaces : [];
    raw.transports = [{ path: raw.transport, workspaces: oldWorkspaces }];
    delete raw.transport;
    delete raw.workspaces;
  }
  if (!Array.isArray(raw.transports)) raw.transports = [];
  return raw;
}

function saveConfig(platform: PlatformInfo, config: Record<string, unknown>): void {
  // 664 root:crosstalk — group members (operator) can update without sudo
  writeFileSync(platform.paths.configFile, stringifyYaml(config), { mode: 0o664 });
  if (platform.id !== 'windows') {
    execSync(`chown root:${platform.serviceUser} ${platform.paths.configFile}`);
  }
}

function installBinary(platform: PlatformInfo): string {
  const dest = platform.id === 'windows'
    ? 'C:\\Program Files\\crosstalk\\crosstalk.exe'
    : '/usr/local/bin/crosstalk';

  let src = process.execPath;

  // Running under interpreter (dev mode) — locate the compiled binary
  if (src.includes('node') || src.includes('bun')) {
    try {
      const whichCmd = platform.id === 'windows' ? 'where crosstalk' : 'which crosstalk 2>/dev/null';
      const found = execSync(whichCmd, { encoding: 'utf-8' }).trim().split('\n')[0].trim();
      if (found) src = found;
    } catch {}
  }

  if (src !== dest) {
    mkdirSync(join(dest, '..'), { recursive: true });
    copyFileSync(src, dest);
    if (platform.id !== 'windows') chmodSync(dest, 0o755);
    console.log(`[install] binary installed to ${dest}`);
  }

  return dest;
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function runKeygen(): Promise<void> {
  const platform = detectPlatform();
  requireRoot(platform);

  mkdirSync(platform.paths.sshDir, { recursive: true });
  const pubKey = generateSshKey(platform);

  console.log('\nAdd this SSH public key as a deploy key on your transport repo');
  console.log('(GitHub → repo Settings → Deploy keys → Add deploy key, allow write access):\n');
  console.log(pubKey);
  console.log('\nThen run:');
  console.log('  sudo crosstalk install <git-url>');
}

export async function runInstall(argv: string[]): Promise<void> {
  const gitUrl = argv[0];
  if (!gitUrl || gitUrl.startsWith('-')) {
    console.error('usage: sudo crosstalk install <git-url>');
    console.error('       Run "sudo crosstalk keygen" first to generate and register the SSH deploy key.');
    process.exit(1);
  }

  const platform = detectPlatform();
  requireRoot(platform);

  const keyPath = join(platform.paths.sshDir, 'id_ed25519');
  if (!existsSync(keyPath)) {
    console.error('[install] no SSH key found. Generate one first:\n');
    console.error('  sudo crosstalk keygen');
    console.error('\nAdd the printed key as a deploy key on your transport repo, then re-run install.');
    process.exit(1);
  }

  console.log(`[install] platform=${platform.id} service-manager=${platform.serviceManager}`);

  createDirs(platform.paths);
  createSystemUser(platform);
  setOwnership(platform);

  const transportPath = join(platform.paths.transportsDir, ...ownerRepo(gitUrl).split('/'));
  mkdirSync(join(transportPath, '..'), { recursive: true });
  if (!existsSync(join(transportPath, '.git'))) {
    cloneRepo(platform, gitUrl, transportPath);
  } else {
    console.log(`[install] transport already cloned at ${transportPath} — skipping`);
  }

  const config = readRawConfig(platform.paths.configFile);
  const transports = config.transports as Array<{ path: string; workspaces: string[] }>;
  if (!transports.some(t => t.path === transportPath)) {
    transports.push({ path: transportPath, workspaces: [] });
  }
  saveConfig(platform, config);
  console.log(`[install] config written to ${platform.paths.configFile}`);

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

  console.log('\n[install] done.');
  console.log('\nAdd a workspace and start the daemon:');
  console.log('  crosstalk add-workspace <git-url>');
  if (platform.serviceManager === 'systemd') console.log('  sudo systemctl start crosstalk');
  if (platform.serviceManager === 'launchd') console.log('  sudo launchctl load -w /Library/LaunchDaemons/ai.cordfuse.crosstalk.plist');
  if (platform.serviceManager === 'windows-scm') console.log('  sc.exe start crosstalk');
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
    rmSync(platform.paths.dataDir, { recursive: true, force: true });
    if (platform.paths.configDir !== platform.paths.dataDir) {
      rmSync(platform.paths.configDir, { recursive: true, force: true });
    }
    console.log('[uninstall] data and config removed');
  } else {
    console.log(`[uninstall] data preserved at ${platform.paths.dataDir} — run with --purge to remove`);
  }
}

export async function runAddTransport(argv: string[]): Promise<void> {
  const platform = detectPlatform();

  const gitUrl = argv[0];
  if (!gitUrl || gitUrl.startsWith('-')) {
    console.error('usage: crosstalk add-transport <git-url> [--name <alias>]');
    process.exit(1);
  }

  const nameFlag  = argv[argv.indexOf('--name') + 1];
  const label     = nameFlag ?? ownerRepo(gitUrl);
  const dest      = join(platform.paths.transportsDir, ...label.split('/'));

  if (existsSync(join(dest, '.git'))) {
    console.error(`[add-transport] already exists: ${dest}`);
    process.exit(1);
  }

  mkdirSync(join(dest, '..'), { recursive: true });
  cloneRepo(platform, gitUrl, dest);

  const config = readRawConfig(platform.paths.configFile);
  const transports = config.transports as Array<{ path: string; workspaces: string[] }>;
  transports.push({ path: dest, workspaces: [] });
  saveConfig(platform, config);

  console.log(`[add-transport] registered: ${dest}`);
  console.log(`\nOpen a session:\n  crosstalk open --transport ${label}\n`);
}

export async function runRemoveTransport(argv: string[]): Promise<void> {
  const platform = detectPlatform();

  const name = argv[0];
  if (!name) {
    console.error('usage: crosstalk remove-transport <name-or-path>');
    process.exit(1);
  }

  const config = readRawConfig(platform.paths.configFile);
  const before  = config.transports as Array<{ path: string; workspaces: string[] }>;
  const matches = before.filter(t =>
    t.path === name || transportLabel(t.path) === name || basename(t.path) === name
  );

  if (matches.length === 0) {
    console.error(`[remove-transport] no transport matching "${name}" found`);
    process.exit(1);
  }
  if (matches.length > 1) {
    const labels = matches.map(t => transportLabel(t.path)).join(', ');
    console.error(`[remove-transport] "${name}" is ambiguous — specify owner/repo:\n  ${labels}`);
    process.exit(1);
  }

  config.transports = before.filter(t => t !== matches[0]);
  saveConfig(platform, config);
  console.log(`[remove-transport] removed from config. Data preserved — delete manually if needed.`);
}

export async function runAddWorkspace(argv: string[]): Promise<void> {
  const platform = detectPlatform();

  const gitUrl = argv.find(a => !a.startsWith('-'));
  if (!gitUrl) {
    console.error('usage: crosstalk add-workspace <git-url> [--transport <name>]');
    process.exit(1);
  }

  const transportFlag = argv[argv.indexOf('--transport') + 1] as string | undefined;

  const config    = readRawConfig(platform.paths.configFile);
  const transports = config.transports as Array<{ path: string; workspaces: string[] }>;

  if (transports.length === 0) {
    console.error('[add-workspace] no transports registered. Run: sudo crosstalk install <git-url>');
    process.exit(1);
  }

  let transportEntry: { path: string; workspaces: string[] } | undefined;
  if (transportFlag) {
    transportEntry = transports.find(t => t.path === transportFlag || basename(t.path) === transportFlag);
    if (!transportEntry) {
      const names = transports.map(t => basename(t.path)).join(', ');
      console.error(`[add-workspace] transport "${transportFlag}" not found. Registered: ${names}`);
      process.exit(1);
    }
  } else if (transports.length === 1) {
    transportEntry = transports[0];
  } else {
    const names = transports.map(t => basename(t.path)).join(', ');
    console.error(`[add-workspace] multiple transports registered — specify one:\n  crosstalk add-workspace <git-url> --transport <name>\nAvailable: ${names}`);
    process.exit(1);
  }

  const label = ownerRepo(gitUrl);
  const dest  = join(platform.paths.workspacesDir, ...label.split('/'));

  if (existsSync(dest)) {
    console.error(`[add-workspace] already exists: ${dest}`);
    process.exit(1);
  }

  mkdirSync(join(dest, '..'), { recursive: true });
  cloneRepo(platform, gitUrl, dest);
  transportEntry.workspaces = [...(transportEntry.workspaces ?? []), dest];
  saveConfig(platform, config);

  console.log(`[add-workspace] registered: ${dest}`);
  const transportArg = transports.length > 1 ? ` --transport ${transportLabel(transportEntry.path)}` : '';
  console.log(`\nOpen a session:\n  crosstalk open --workspace ${label}${transportArg}\n`);
}

export async function runRemoveWorkspace(argv: string[]): Promise<void> {
  const platform = detectPlatform();

  const name = argv.find(a => !a.startsWith('-'));
  if (!name) {
    console.error('usage: crosstalk remove-workspace <name-or-path> [--transport <name>]');
    process.exit(1);
  }

  const config     = readRawConfig(platform.paths.configFile);
  const transports = config.transports as Array<{ path: string; workspaces: string[] }>;

  let removed = false;
  for (const t of transports) {
    const before   = t.workspaces ?? [];
    const matches  = before.filter((w: string) =>
      w === name || transportLabel(w) === name || basename(w) === name
    );
    if (matches.length > 1) {
      const labels = matches.map(transportLabel).join(', ');
      console.error(`[remove-workspace] "${name}" is ambiguous — specify owner/repo:\n  ${labels}`);
      process.exit(1);
    }
    if (matches.length === 1) { t.workspaces = before.filter((w: string) => w !== matches[0]); removed = true; }
  }

  if (!removed) {
    console.error(`[remove-workspace] no workspace matching "${name}" found`);
    process.exit(1);
  }

  saveConfig(platform, config);
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
  console.log('');

  const config     = readRawConfig(platform.paths.configFile);
  const transports = config.transports as Array<{ path: string; workspaces: string[] }>;

  if (transports.length === 0) {
    console.log('transports:       (none)');
  } else {
    for (const t of transports) {
      const name = basename(t.path);
      console.log(`transport:        ${t.path}`);
      const ws = t.workspaces ?? [];
      if (ws.length === 0) {
        console.log(`  workspaces:     (none)`);
      } else {
        for (const w of ws) console.log(`  workspace:      ${w}`);
      }
    }
  }

  console.log('');
  console.log(svcStatus);
}
