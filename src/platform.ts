import { join } from 'path';
import { existsSync } from 'fs';
import { execSync } from 'child_process';

export type PlatformId = 'linux' | 'macos' | 'wsl';

export interface PlatformPaths {
  configDir: string;        // /etc/crosstalk
  dataDir: string;          // /var/lib/crosstalk
  transportsDir: string;    // /var/lib/crosstalk/transports — all transports, named owner/repo
  workspacesDir: string;    // /var/lib/crosstalk/workspaces — all workspaces, named owner/repo
  sshDir: string;           // /var/lib/crosstalk/.ssh
  configFile: string;       // /etc/crosstalk/config.yaml
}

export interface PlatformInfo {
  id: PlatformId;
  paths: PlatformPaths;
  serviceUser: string;
  serviceManager: 'systemd' | 'launchd' | 'none';
  hasSystemd: boolean;
}

function isWSL(): boolean {
  if (process.platform !== 'linux') return false;
  return existsSync('/proc/sys/fs/binfmt_misc/WSLInterop') || !!process.env.WSL_DISTRO_NAME;
}

function hasSystemd(): boolean {
  try {
    execSync('systemctl --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function unixPaths(): PlatformPaths {
  const configDir     = '/etc/crosstalk';
  const dataDir       = '/var/lib/crosstalk';
  const transportsDir = join(dataDir, 'transports');
  const workspacesDir = join(dataDir, 'workspaces');
  const sshDir        = join(dataDir, '.ssh');
  const configFile    = join(configDir, 'config.yaml');
  return { configDir, dataDir, transportsDir, workspacesDir, sshDir, configFile };
}

export function detectPlatform(): PlatformInfo {
  if (process.platform === 'win32') {
    throw new Error(
      'Windows is not supported. Run crosstalk inside WSL2:\n' +
      '  wsl --install   (one-time setup, then reboot)\n' +
      '  wsl             (open a WSL shell, then run the Linux installer)'
    );
  }

  if (process.platform === 'darwin') {
    return {
      id: 'macos',
      paths: unixPaths(),
      serviceUser: '_crosstalk',
      serviceManager: 'launchd',
      hasSystemd: false,
    };
  }

  // Linux or WSL2
  const wsl = isWSL();
  const sd  = hasSystemd();
  return {
    id: wsl ? 'wsl' : 'linux',
    paths: unixPaths(),
    serviceUser: 'crosstalk',
    serviceManager: sd ? 'systemd' : 'none',
    hasSystemd: sd,
  };
}

export function isRoot(): boolean {
  return process.getuid?.() === 0;
}
