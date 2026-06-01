import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { spawnSync } from 'child_process';
import { parse as parseYaml } from 'yaml';
import { detectPlatform } from './platform.js';
import { findHostFile } from './config.js';

function die(msg: string): never {
  console.error(msg);
  process.exit(1) as never;
  throw new Error(msg); // unreachable — satisfies tsc without @types/node
}

export async function runWith(argv: string[]): Promise<void> {
  const get = (flag: string) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1]; };

  const agentFlag     = get('--agent');
  const workspaceFlag = get('--workspace');
  const actorFlag     = get('--actor') ?? 'concierge';

  const platform = detectPlatform();

  if (!existsSync(platform.paths.configFile))
    die('[with] crosstalk is not installed. Run: sudo crosstalk install');

  const raw    = readFileSync(platform.paths.configFile, 'utf-8');
  const config = parseYaml(raw) as { transport?: string; workspaces?: string[] };

  const transport: string | undefined = config.transport;
  const workspaces: string[] = config.workspaces ?? [];

  if (!transport)
    die('[with] no transport registered. Run: sudo crosstalk install <git-url>');

  const transportPath = resolve(transport);
  const hostFile = findHostFile(transportPath);
  if (!hostFile)
    die(`[with] no host file found for this machine in ${transportPath}/manifest/hosts/`);

  const actorEntry = hostFile.actors[actorFlag];
  if (!actorEntry)
    die(`[with] actor "${actorFlag}" not found in host file. Available: ${Object.keys(hostFile.actors).join(', ')}`);

  // Pick CLI: --agent selects by tier name, default is first tier
  let cliRaw: string;
  if (agentFlag) {
    const tierEntry = actorEntry[agentFlag];
    if (!tierEntry)
      die(`[with] agent "${agentFlag}" not configured for actor "${actorFlag}". Available: ${Object.keys(actorEntry).join(', ')}`);
    cliRaw = typeof tierEntry === 'string' ? tierEntry : (tierEntry as { cli: string }).cli;
  } else {
    const firstTier = Object.values(actorEntry)[0];
    cliRaw = typeof firstTier === 'string' ? firstTier : (firstTier as { cli: string }).cli;
  }

  // Strip headless flags — --print is the Claude Code headless flag
  const cliParts = cliRaw.split(/\s+/).filter(t => t !== '--print');
  const [bin, ...args] = cliParts;

  // Resolve workspace dir
  let cwd: string;
  if (workspaceFlag) {
    const match = workspaces.find(w => w === workspaceFlag || w.endsWith('/' + workspaceFlag));
    if (!match) {
      const names = workspaces.map(w => w.split('/').pop() ?? w).join(', ');
      die(workspaces.length === 0
        ? `[with] no workspaces registered. Run: sudo crosstalk add-workspace <git-url>`
        : `[with] workspace "${workspaceFlag}" not found. Registered: ${names}`);
    }
    cwd = match;
  } else if (workspaces.length === 1) {
    cwd = workspaces[0];
  } else if (workspaces.length > 1) {
    const names = workspaces.map(w => w.split('/').pop() ?? w).join(', ');
    die(`[with] multiple workspaces registered — specify one:\n  crosstalk with --workspace <name>\nAvailable: ${names}`);
  } else {
    cwd = transportPath;
    console.log(`[with] no workspaces registered — opening in transport: ${cwd}`);
    console.log(`       Add a workspace: sudo crosstalk add-workspace <git-url>`);
  }

  if (!existsSync(cwd))
    die(`[with] workspace directory not found: ${cwd}`);

  console.log(`[with] ${actorFlag}${agentFlag ? ` (${agentFlag})` : ''} → ${cwd}`);

  const result = spawnSync(bin, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });

  process.exit(result.status ?? 0);
}
