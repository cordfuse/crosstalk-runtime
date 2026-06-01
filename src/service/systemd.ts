import { writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import type { PlatformPaths } from '../platform.js';

const UNIT_PATH = '/etc/systemd/system/crosstalk.service';

export function generateUnit(paths: PlatformPaths, binaryPath: string): string {
  return `[Unit]
Description=Crosstalk Runtime — AI agent messaging daemon
After=network.target

[Service]
Type=simple
User=crosstalk
ExecStart=${binaryPath} --config ${paths.configFile}
Restart=always
RestartSec=10
Environment=HOME=${paths.dataDir}
Environment=GIT_SSH_COMMAND=ssh -i ${paths.sshDir}/id_ed25519 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${paths.sshDir}/known_hosts

[Install]
WantedBy=multi-user.target
`;
}

export function install(paths: PlatformPaths, binaryPath: string): void {
  const unit = generateUnit(paths, binaryPath);
  writeFileSync(UNIT_PATH, unit, { mode: 0o644 });
  execSync('systemctl daemon-reload');
  execSync('systemctl enable crosstalk');
  console.log(`[systemd] unit installed at ${UNIT_PATH}`);
}

export function start(): void {
  execSync('systemctl start crosstalk');
  console.log('[systemd] crosstalk.service started');
}

export function stop(): void {
  try { execSync('systemctl stop crosstalk'); } catch {}
}

export function uninstall(): void {
  stop();
  try { execSync('systemctl disable crosstalk'); } catch {}
  if (existsSync(UNIT_PATH)) {
    execSync(`rm ${UNIT_PATH}`);
    execSync('systemctl daemon-reload');
  }
  console.log('[systemd] crosstalk.service removed');
}

export function status(): string {
  try {
    return execSync('systemctl status crosstalk --no-pager', { encoding: 'utf-8' });
  } catch (e: any) {
    return e.stdout ?? 'not installed';
  }
}
