import { writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import type { PlatformPaths } from '../platform.js';

const SERVICE_NAME = 'crosstalk';
const DISPLAY_NAME = 'Crosstalk Runtime';
const DESCRIPTION  = 'AI agent messaging daemon';

export function install(paths: PlatformPaths, binaryPath: string): void {
  // Remove existing service first so install is idempotent.
  try {
    execSync(`sc.exe query ${SERVICE_NAME}`, { stdio: 'ignore' });
    try { execSync(`sc.exe stop ${SERVICE_NAME}`, { stdio: 'ignore' }); } catch {}
    execSync(`sc.exe delete ${SERVICE_NAME}`, { stdio: 'ignore' });
    console.log(`[windows-scm] existing ${SERVICE_NAME} service removed`);
  } catch { /* service did not exist — nothing to remove */ }

  // sc.exe requires a native binary. bun build --compile produces one.
  execSync(
    `sc.exe create ${SERVICE_NAME} ` +
    `binPath= "${binaryPath} --config ${paths.configFile}" ` +
    `DisplayName= "${DISPLAY_NAME}" ` +
    `start= auto`,
    { stdio: 'inherit' }
  );
  execSync(
    `sc.exe description ${SERVICE_NAME} "${DESCRIPTION}"`,
    { stdio: 'inherit' }
  );
  // Grant the service account access to the data dir
  execSync(
    `icacls "${paths.dataDir}" /grant "NT SERVICE\\${SERVICE_NAME}:(OI)(CI)F"`,
    { stdio: 'inherit' }
  );
  console.log(`[windows-scm] ${SERVICE_NAME} service installed`);
}

export function start(): void {
  execSync(`sc.exe start ${SERVICE_NAME}`, { stdio: 'inherit' });
  console.log(`[windows-scm] ${SERVICE_NAME} started`);
}

export function stop(): void {
  try { execSync(`sc.exe stop ${SERVICE_NAME}`, { stdio: 'ignore' }); } catch {}
}

export function uninstall(): void {
  stop();
  try { execSync(`sc.exe delete ${SERVICE_NAME}`, { stdio: 'inherit' }); } catch {}
  console.log(`[windows-scm] ${SERVICE_NAME} removed`);
}

export function status(): string {
  try {
    return execSync(`sc.exe query ${SERVICE_NAME}`, { encoding: 'utf-8' });
  } catch {
    return 'not installed';
  }
}

// Generate a wrapper script for environments where the binary isn't compiled.
// Requires Node.js on PATH. Only used as a fallback.
export function generateWrapperScript(paths: PlatformPaths, scriptPath: string): string {
  const wrapper = join(paths.dataDir, 'crosstalk-service.js');
  writeFileSync(wrapper, `require('child_process').spawn(
  process.execPath,
  [${JSON.stringify(scriptPath)}, '--config', ${JSON.stringify(paths.configFile)}],
  { stdio: 'inherit', env: { ...process.env, HOME: ${JSON.stringify(paths.dataDir)} } }
).on('exit', code => process.exit(code ?? 0));\n`);
  return wrapper;
}
