import { spawnSync, execSync } from 'child_process';
import { mkdirSync } from 'fs';
import { detectPlatform } from './platform.js';

function lookupUid(username: string): number {
  return parseInt(execSync(`id -u ${username}`, { encoding: 'utf-8' }).trim());
}

function lookupGid(username: string): number {
  return parseInt(execSync(`id -g ${username}`, { encoding: 'utf-8' }).trim());
}

export async function runAuth(argv: string[]): Promise<void> {
  const cli = argv[0];

  if (!cli) {
    console.error([
      'Usage: sudo crosstalk auth <cli>',
      '',
      'Runs the agent CLI as the daemon user so it can authenticate.',
      'Complete the login flow, then exit the CLI to return here.',
      '',
      'Examples:',
      '  sudo crosstalk auth claude',
      '  sudo crosstalk auth gemini',
      '  sudo crosstalk auth agy',
    ].join('\n'));
    process.exit(1);
  }

  if (process.getuid?.() !== 0) {
    console.error('crosstalk auth requires sudo — credentials are written to the daemon user home');
    process.exit(1);
  }

  const platform = detectPlatform();
  const user = platform.serviceUser;
  let uid: number, gid: number;

  try {
    uid = lookupUid(user);
    gid = lookupGid(user);
  } catch {
    console.error(`[auth] daemon user '${user}' not found — run: sudo crosstalk install <git-url>`);
    process.exit(1);
  }

  // Ensure daemon home exists with correct ownership
  mkdirSync(platform.paths.dataDir, { recursive: true });

  console.log(`[auth] running ${cli} as ${user} (uid=${uid}) — complete the login flow, then exit`);
  console.log(`[auth] credentials will be stored in ${platform.paths.dataDir}`);

  const result = spawnSync(cli, [], {
    stdio: 'inherit',
    uid,
    gid,
    env: {
      HOME:  platform.paths.dataDir,
      PATH:  process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      TERM:  process.env.TERM  ?? 'xterm-256color',
      LANG:  process.env.LANG  ?? 'en_US.UTF-8',
      ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
    },
  });

  if (result.error) {
    console.error(`[auth] failed to run '${cli}': ${result.error.message}`);
    process.exit(1);
  }

  console.log(`\n[auth] done — restart the daemon to apply: sudo systemctl restart crosstalk`);
  process.exit(result.status ?? 0);
}
