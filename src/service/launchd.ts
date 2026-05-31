import { writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import type { PlatformPaths } from '../platform.js';

const PLIST_PATH = '/Library/LaunchDaemons/ai.cordfuse.crosstalk.plist';
const LABEL      = 'ai.cordfuse.crosstalk';

export function generatePlist(paths: PlatformPaths, binaryPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binaryPath}</string>
    <string>--config</string>
    <string>${paths.configFile}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>UserName</key>
  <string>_crosstalk</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${paths.dataDir}</string>
    <key>GIT_SSH_COMMAND</key>
    <string>ssh -i ${paths.sshDir}/id_ed25519 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${paths.sshDir}/known_hosts</string>
  </dict>
  <key>StandardOutPath</key>
  <string>/var/log/crosstalk.log</string>
  <key>StandardErrorPath</key>
  <string>/var/log/crosstalk.log</string>
</dict>
</plist>
`;
}

export function install(paths: PlatformPaths, binaryPath: string): void {
  const plist = generatePlist(paths, binaryPath);
  writeFileSync(PLIST_PATH, plist, { mode: 0o644 });
  execSync(`chown root:wheel ${PLIST_PATH}`);
  console.log(`[launchd] plist installed at ${PLIST_PATH}`);
}

export function start(): void {
  execSync(`launchctl load -w ${PLIST_PATH}`);
  console.log('[launchd] ai.cordfuse.crosstalk loaded');
}

export function stop(): void {
  try { execSync(`launchctl unload ${PLIST_PATH}`); } catch {}
}

export function uninstall(): void {
  stop();
  if (existsSync(PLIST_PATH)) execSync(`rm ${PLIST_PATH}`);
  console.log('[launchd] ai.cordfuse.crosstalk removed');
}

export function status(): string {
  try {
    return execSync(`launchctl list ${LABEL}`, { encoding: 'utf-8' });
  } catch {
    return 'not loaded';
  }
}
