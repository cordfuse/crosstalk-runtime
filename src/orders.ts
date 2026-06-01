import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { parse as parseYaml } from 'yaml';
import { detectPlatform } from './platform.js';

// ── Transport resolution (same pattern as install.ts) ──────────────────────

function resolveTransport(transportFlag?: string): string {
  const platform = detectPlatform();
  if (!existsSync(platform.paths.configFile)) {
    console.error('[orders] no config found — run: sudo crosstalk install <git-url>');
    process.exit(1);
  }
  const raw = parseYaml(readFileSync(platform.paths.configFile, 'utf-8')) as Record<string, unknown>;
  const transports = (Array.isArray(raw.transports) ? raw.transports : []) as Array<{ path: string }>;
  if (transports.length === 0) {
    console.error('[orders] no transports registered — run: sudo crosstalk install <git-url>');
    process.exit(1);
  }
  if (transportFlag) {
    const entry = transports.find(t => t.path === transportFlag || t.path.endsWith('/' + transportFlag));
    if (!entry) {
      const names = transports.map(t => t.path.split('/').pop()).join(', ');
      console.error(`[orders] transport "${transportFlag}" not found. Registered: ${names}`);
      process.exit(1);
    }
    return entry.path;
  }
  if (transports.length > 1) {
    const names = transports.map(t => t.path.split('/').pop()).join(', ');
    console.error(`[orders] multiple transports registered — specify one with --transport <name>\nAvailable: ${names}`);
    process.exit(1);
  }
  return transports[0].path;
}

// ── File path ──────────────────────────────────────────────────────────────

function ordersPath(transportPath: string, actor: string): string {
  return join(transportPath, 'manifest', 'orders', `${actor}.md`);
}

// ── Public loader (used by dispatch.ts) ───────────────────────────────────

export function loadMarchingOrders(transportPath: string, actor: string): string | null {
  const file = ordersPath(transportPath, actor);
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, 'utf-8').trim();
  return raw || null;
}

// ── CLI command ────────────────────────────────────────────────────────────

export async function runOrders(argv: string[]): Promise<void> {
  const actor        = argv.find(a => !a.startsWith('-'));
  const transportIdx = argv.indexOf('--transport');
  const transportFlag = transportIdx !== -1 ? argv[transportIdx + 1] : undefined;
  const isClear      = argv.includes('--clear');

  if (!actor) {
    console.error('usage: crosstalk orders <actor> [message] [--transport <name>] [--clear]');
    process.exit(1);
  }

  const transportPath = resolveTransport(transportFlag);
  const file          = ordersPath(transportPath, actor);

  // -- show current orders --
  if (!isClear && argv.filter(a => !a.startsWith('-')).length === 1) {
    if (!existsSync(file)) {
      console.log(`[orders] no marching orders set for ${actor}`);
    } else {
      console.log(`=== marching orders: ${actor} ===\n`);
      console.log(readFileSync(file, 'utf-8').trim());
    }
    return;
  }

  // -- clear orders --
  if (isClear) {
    if (!existsSync(file)) {
      console.log(`[orders] nothing to clear for ${actor}`);
      return;
    }
    execSync(`git -C ${transportPath} rm -f manifest/orders/${actor}.md`, { stdio: 'inherit' });
    execSync(`git -C ${transportPath} commit -m "orders: clear marching orders for ${actor}"`, { stdio: 'inherit' });
    execSync(`git -C ${transportPath} push`, { stdio: 'inherit' });
    console.log(`[orders] marching orders cleared for ${actor}`);
    return;
  }

  // -- set orders --
  const messageArgs = argv.filter(a => !a.startsWith('-') && a !== actor);
  let message = messageArgs.join(' ').trim();

  // fall back to stdin if no inline message
  if (!message) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    message = Buffer.concat(chunks).toString('utf-8').trim();
  }

  if (!message) {
    console.error('[orders] no message provided — pass inline or pipe via stdin');
    process.exit(1);
  }

  mkdirSync(join(transportPath, 'manifest', 'orders'), { recursive: true });
  writeFileSync(file, message + '\n', 'utf-8');

  execSync(`git -C ${transportPath} add manifest/orders/${actor}.md`, { stdio: 'inherit' });
  execSync(`git -C ${transportPath} commit -m "orders: set marching orders for ${actor}"`, { stdio: 'inherit' });
  execSync(`git -C ${transportPath} push`, { stdio: 'inherit' });

  console.log(`\n[orders] marching orders set for ${actor}:\n`);
  console.log(message);
}
