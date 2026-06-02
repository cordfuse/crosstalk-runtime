import { spawnSync, execSync } from 'child_process';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { detectPlatform, isRoot } from './platform.js';

function lookupUid(username: string): number {
  return parseInt(execSync(`id -u ${username}`, { encoding: 'utf-8' }).trim());
}

function lookupGid(username: string): number {
  return parseInt(execSync(`id -g ${username}`, { encoding: 'utf-8' }).trim());
}

interface AgentDef {
  bin: string;
  npm?: string;
  curl?: string;
}

const AGENTS: Record<string, AgentDef> = {
  claude:   { bin: 'claude',    npm: '@anthropic-ai/claude-code' },
  gemini:   { bin: 'gemini',    npm: '@google/gemini-cli' },
  codex:    { bin: 'codex',     npm: '@openai/codex' },
  qwen:     { bin: 'qwen',      npm: '@qwen-code/qwen-code' },
  opencode: { bin: 'opencode',  npm: 'opencode-ai' },
  agy:      { bin: 'agy',       curl: 'https://antigravity.google/cli/install.sh' },
};

const AGENT_NAMES = Object.keys(AGENTS).join(', ');

function requireElevated(): void {
  const elevated = process.platform === 'win32' ? isRoot() : process.getuid?.() === 0;
  if (!elevated) {
    const hint = process.platform === 'win32'
      ? 'Run this command in an elevated (Administrator) terminal.'
      : `Re-run with sudo:\n\n  sudo crosstalk agent ${process.argv.slice(3).join(' ')}`.trimEnd();
    console.error(`[agent] elevated privileges required.\n${hint}`);
    process.exit(1);
  }
}

function resolveUser(): { uid: number | undefined; gid: number | undefined; user: string; localBin: string } {
  const platform = detectPlatform();
  const user = platform.serviceUser;
  const localBin = join(platform.paths.dataDir, '.local', 'bin');

  if (process.platform === 'win32') {
    return { uid: undefined, gid: undefined, user, localBin };
  }

  try {
    const uid = lookupUid(user);
    const gid = lookupGid(user);
    return { uid, gid, user, localBin };
  } catch {
    console.error(`[agent] daemon user '${user}' not found — run: sudo crosstalk install <git-url>`);
    process.exit(1);
  }
}

function spawnAs(uid: number | undefined, gid: number | undefined, dataDir: string, args: string[]): number {
  const opts: Parameters<typeof spawnSync>[2] = {
    stdio: 'inherit',
    env: {
      HOME:              dataDir,
      PATH:              process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      TERM:              process.env.TERM  ?? 'xterm-256color',
      LANG:              process.env.LANG  ?? 'en_US.UTF-8',
      npm_config_cache:  join(dataDir, '.npm'),
      npm_config_prefix: join(dataDir, '.local'),
    },
  };
  if (uid !== undefined) opts.uid = uid;
  if (gid !== undefined) opts.gid = gid;

  const result = spawnSync(args[0], args.slice(1), opts);
  if (result.error) {
    console.error(`[agent] failed to run: ${result.error.message}`);
    process.exit(1);
  }
  return result.status ?? 0;
}

function installNpm(uid: number | undefined, gid: number | undefined, dataDir: string, pkg: string): void {
  console.log(`[agent] npm install -g ${pkg}`);
  const code = spawnAs(uid, gid, dataDir, ['npm', 'install', '-g', '--prefix', join(dataDir, '.local'), pkg]);
  process.exit(code);
}

function installCurl(uid: number | undefined, gid: number | undefined, dataDir: string, url: string): void {
  if (process.platform === 'win32') {
    console.error(`[agent] curl-based install not supported on Windows.\nInstall manually from: ${url}`);
    process.exit(1);
  }
  console.log(`[agent] curl install from ${url}`);
  const code = spawnAs(uid, gid, dataDir, ['bash', '-c', `curl -fsSL ${url} | bash`]);
  process.exit(code);
}

function agentInstall(cli: string): void {
  requireElevated();
  const def = AGENTS[cli];
  if (!def) {
    console.error(`[agent] unknown agent '${cli}'\nKnown agents: ${AGENT_NAMES}`);
    process.exit(1);
  }
  const platform = detectPlatform();
  const { uid, gid } = resolveUser();
  console.log(`[agent] installing '${cli}' into daemon home ${platform.paths.dataDir}`);
  if (def.npm)  installNpm(uid, gid, platform.paths.dataDir, def.npm);
  if (def.curl) installCurl(uid, gid, platform.paths.dataDir, def.curl);
}

function agentUpgrade(cli: string): void {
  requireElevated();
  const def = AGENTS[cli];
  if (!def) {
    console.error(`[agent] unknown agent '${cli}'\nKnown agents: ${AGENT_NAMES}`);
    process.exit(1);
  }
  const platform = detectPlatform();
  const { uid, gid } = resolveUser();
  console.log(`[agent] upgrading '${cli}' in daemon home ${platform.paths.dataDir}`);
  // upgrade = re-run install (npm install -g upgrades, curl re-runs installer)
  if (def.npm)  installNpm(uid, gid, platform.paths.dataDir, def.npm);
  if (def.curl) installCurl(uid, gid, platform.paths.dataDir, def.curl);
}

function agentUninstall(cli: string): void {
  requireElevated();
  const def = AGENTS[cli];
  if (!def) {
    console.error(`[agent] unknown agent '${cli}'\nKnown agents: ${AGENT_NAMES}`);
    process.exit(1);
  }
  const platform = detectPlatform();
  const { uid, gid } = resolveUser();
  console.log(`[agent] uninstalling '${cli}' from daemon home ${platform.paths.dataDir}`);
  const bin = join(platform.paths.dataDir, '.local', 'bin', def.bin);
  if (def.npm) {
    // run npm uninstall for clean package db, then remove binary directly
    // (handles manually-copied binaries that npm doesn't track)
    spawnAs(uid, gid, platform.paths.dataDir, [
      'npm', 'uninstall', '-g', '--prefix', join(platform.paths.dataDir, '.local'), def.npm,
    ]);
  }
  if (existsSync(bin)) {
    unlinkSync(bin);
    console.log(`[agent] removed ${bin}`);
  } else {
    console.log(`[agent] '${cli}' not found at ${bin} — nothing to remove`);
  }
  process.exit(0);
}

function agentList(): void {
  const platform = detectPlatform();
  const { localBin } = resolveUser();
  console.log(`Daemon agent CLIs (${localBin}):\n`);
  for (const [name, def] of Object.entries(AGENTS)) {
    const bin = join(localBin, def.bin);
    const installed = existsSync(bin);
    const source = def.npm ? `npm:${def.npm}` : `curl:${def.curl}`;
    console.log(`  ${installed ? '[installed]' : '[missing]  '} ${name.padEnd(10)} ${source}`);
  }
}

export async function runAgent(argv: string[]): Promise<void> {
  const sub = argv[0];

  if (!sub || sub === '--help' || sub === 'help') {
    console.log([
      'Usage: crosstalk agent <subcommand> [cli]',
      '',
      'Subcommands:',
      '  install <cli>    Install an agent CLI into the daemon user home (requires sudo)',
      '  upgrade <cli>    Upgrade an installed agent CLI (requires sudo)',
      '  uninstall <cli>  Remove an agent CLI from the daemon user home (requires sudo)',
      '  list             List known agent CLIs and installation status',
      '',
      `Known agents: ${AGENT_NAMES}`,
      '',
      'Headless permission flags (add to cli: in your host file):',
      '  claude    --dangerously-skip-permissions',
      '  agy       --dangerously-skip-permissions',
      '  gemini    --yolo',
      '  qwen      --yolo',
      '  codex     -s danger-full-access',
      '  opencode  (none required)',
    ].join('\n'));
    process.exit(0);
  }

  const cli = argv[1];

  if (sub === 'install')   { agentInstall(cli ?? ''); return; }
  if (sub === 'upgrade')   { agentUpgrade(cli ?? ''); return; }
  if (sub === 'uninstall') { agentUninstall(cli ?? ''); return; }
  if (sub === 'list')      { agentList(); return; }

  console.error(`[agent] unknown subcommand '${sub}' — run: crosstalk agent --help`);
  process.exit(1);
}
