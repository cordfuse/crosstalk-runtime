import { readFileSync, existsSync } from 'fs';
import { resolve, basename } from 'path';

function transportLabel(fullPath: string): string {
  const parts = fullPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}
import { spawnSync } from 'child_process';
import { parse as parseYaml } from 'yaml';
import { detectPlatform } from './platform.js';
import { findHostFile } from './config.js';

function die(msg: string): never {
  console.error(msg);
  process.exit(1) as never;
  throw new Error(msg); // unreachable — satisfies tsc without @types/node
}

export async function runOpen(argv: string[]): Promise<void> {
  const get = (flag: string) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1]; };

  const agentFlag     = get('--agent');
  const workspaceFlag = get('--workspace');
  const transportFlag = get('--transport');
  const actorFlag     = get('--actor') ?? 'concierge';

  const platform = detectPlatform();

  if (!existsSync(platform.paths.configFile))
    die('[open] crosstalk is not installed. Run: sudo crosstalk install');

  const raw    = readFileSync(platform.paths.configFile, 'utf-8');
  const rawConfig = parseYaml(raw) as Record<string, unknown>;

  // Normalise old single-transport format
  type TransportEntry = { path: string; workspaces: string[] };
  let transports: TransportEntry[];
  if (rawConfig.transport && !rawConfig.transports) {
    const oldWorkspaces = Array.isArray(rawConfig.workspaces) ? rawConfig.workspaces as string[] : [];
    transports = [{ path: String(rawConfig.transport), workspaces: oldWorkspaces }];
  } else {
    transports = (rawConfig.transports as TransportEntry[] | undefined) ?? [];
  }

  if (transports.length === 0)
    die('[open] no transports registered. Run: sudo crosstalk install <git-url>');

  let transportEntry: TransportEntry;
  if (transportFlag) {
    const match = transports.find(t =>
      t.path === transportFlag ||
      transportLabel(t.path) === transportFlag ||
      basename(t.path) === transportFlag
    );
    if (!match) {
      const names = transports.map(t => transportLabel(t.path)).join(', ');
      die(`[open] transport "${transportFlag}" not found. Registered: ${names}`);
    }
    transportEntry = match;
  } else if (transports.length === 1) {
    transportEntry = transports[0];
  } else {
    const names = transports.map(t => transportLabel(t.path)).join(', ');
    die(`[open] multiple transports registered — specify one:\n  crosstalk open --transport <owner/repo>\nAvailable: ${names}`);
  }

  const transportPath = resolve(transportEntry.path);
  const workspaces    = transportEntry.workspaces ?? [];
  const hostFile      = findHostFile(transportPath);
  if (!hostFile)
    die(`[open] no host file found for this machine in ${transportPath}/manifest/hosts/`);

  const actorEntry = hostFile.actors[actorFlag];
  if (!actorEntry)
    die(`[open] actor "${actorFlag}" not found in host file. Available: ${Object.keys(hostFile.actors).join(', ')}`);

  // Pick CLI: --agent selects by tier name, default is first tier
  let cliRaw: string;
  if (agentFlag) {
    const tierEntry = actorEntry[agentFlag];
    if (!tierEntry)
      die(`[open] agent "${agentFlag}" not configured for actor "${actorFlag}". Available: ${Object.keys(actorEntry).join(', ')}`);
    cliRaw = typeof tierEntry === 'string' ? tierEntry : (tierEntry as { cli: string }).cli;
  } else {
    const firstTier = Object.values(actorEntry)[0];
    cliRaw = typeof firstTier === 'string' ? firstTier : (firstTier as { cli: string }).cli;
  }

  // Strip headless flags — --print is the Claude Code headless flag
  const cliParts = cliRaw.split(/\s+/).filter(t => t !== '--print');
  const [bin, ...args] = cliParts;

  // Resolve workspace dir: explicit flag > single registered workspace > transport
  let cwd: string;
  if (workspaceFlag) {
    const match = workspaces.find(w =>
      w === workspaceFlag ||
      transportLabel(w) === workspaceFlag ||
      basename(w) === workspaceFlag
    );
    if (!match) {
      const names = workspaces.map(transportLabel).join(', ');
      die(workspaces.length === 0
        ? `[open] no workspaces registered. Run: crosstalk add-workspace <git-url>`
        : `[open] workspace "${workspaceFlag}" not found. Registered: ${names}`);
    }
    cwd = match;
  } else if (workspaces.length === 1) {
    cwd = workspaces[0];
  } else if (workspaces.length > 1) {
    const names = workspaces.map(transportLabel).join(', ');
    die(`[open] multiple workspaces registered — specify one:\n  crosstalk open --workspace <owner/repo>\nAvailable: ${names}`);
  } else {
    cwd = transportPath;
  }

  if (!existsSync(cwd))
    die(`[open] workspace directory not found: ${cwd}`);

  console.log(`[open] ${actorFlag}${agentFlag ? ` (${agentFlag})` : ''} → ${cwd}`);

  const result = spawnSync(bin, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });

  process.exit(result.status ?? 0);
}
