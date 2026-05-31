import { join } from 'path';
import { existsSync } from 'fs';
import { execSync } from 'child_process';

export type PlatformId = 'linux' | 'macos' | 'wsl' | 'windows';

export interface PlatformPaths {
  configDir: string;       // /etc/crosstalk
  dataDir: string;         // /var/lib/crosstalk
  transportsDir: string;   // /var/lib/crosstalk/transports
  sshDir: string;          // /var/lib/crosstalk/.ssh
  configFile: string;      // /etc/crosstalk/config.yaml
}

export interface PlatformInfo {
  id: PlatformId;
  paths: PlatformPaths;
  serviceUser: string;
  serviceManager: 'systemd' | 'launchd' | 'windows-scm' | 'none';
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
  const sshDir        = join(dataDir, '.ssh');
  const configFile    = join(configDir, 'config.yaml');
  return { configDir, dataDir, transportsDir, sshDir, configFile };
}

function windowsPaths(): PlatformPaths {
  const base          = join(process.env.PROGRAMDATA ?? 'C:\\ProgramData', 'crosstalk');
  const transportsDir = join(base, 'transports');
  const sshDir        = join(base, '.ssh');
  const configFile    = join(base, 'config.yaml');
  return { configDir: base, dataDir: base, transportsDir, sshDir, configFile };
}

export function detectPlatform(): PlatformInfo {
  if (process.platform === 'win32') {
    return {
      id: 'windows',
      paths: windowsPaths(),
      serviceUser: 'NT SERVICE\\crosstalk',
      serviceManager: 'windows-scm',
      hasSystemd: false,
    };
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
  if (process.platform === 'win32') {
    try {
      execSync('net session', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  return process.getuid?.() === 0;
}
