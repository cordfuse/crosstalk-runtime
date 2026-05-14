/**
 * `crosstalk service` — install / uninstall / inspect platform service units.
 *
 * v0.8.3+ (per v1.0 ROADMAP requirement):
 *
 *   crosstalk service install     Install user-level service unit for the
 *                                 current platform (systemd user unit on
 *                                 Linux, launchd LaunchAgent on macOS).
 *   crosstalk service uninstall   Remove the installed unit.
 *   crosstalk service template    Print the platform-appropriate template
 *                                 to stdout (substituted with this machine's
 *                                 paths) without writing to disk.
 *
 * No system-level (root) install. User-level only — matches the npm-global
 * install model where the binary lives in ~/.local/bin or similar without
 * sudo. Cross-machine consistency: same activation surface (`launchctl load`
 * on Mac, `systemctl --user enable --now` on Linux).
 *
 * Templates ship in ../templates/ relative to this file's package root.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, platform } from 'node:os'
import { spawnSync } from 'node:child_process'
import type { Command } from 'commander'

type SupportedPlatform = 'linux' | 'darwin'

interface PlatformConfig {
  platform: SupportedPlatform
  templateRel: string
  destPath: string
  activateInstructions: string[]
  deactivateInstructions: string[]
}

function detectPlatform(): SupportedPlatform {
  const p = platform()
  if (p === 'linux') return 'linux'
  if (p === 'darwin') return 'darwin'
  console.error(`✗ Unsupported platform: ${p}. service install supports linux (systemd user unit) and darwin (launchd LaunchAgent) only.`)
  console.error(`  Native Windows service support is planned for v1.x — see ROADMAP.md.`)
  process.exit(1)
}

function getPlatformConfig(p: SupportedPlatform): PlatformConfig {
  const home = homedir()
  if (p === 'linux') {
    return {
      platform: 'linux',
      templateRel: 'templates/systemd/crosstalk.service',
      destPath: join(home, '.config', 'systemd', 'user', 'crosstalk.service'),
      activateInstructions: [
        'systemctl --user daemon-reload',
        'systemctl --user enable --now crosstalk',
        '',
        '# tail logs:',
        'journalctl --user -u crosstalk -f',
      ],
      deactivateInstructions: [
        'systemctl --user disable --now crosstalk',
        'systemctl --user daemon-reload',
      ],
    }
  }
  return {
    platform: 'darwin',
    templateRel: 'templates/launchd/sh.crosstalk.daemon.plist',
    destPath: join(home, 'Library', 'LaunchAgents', 'sh.crosstalk.daemon.plist'),
    activateInstructions: [
      'launchctl load ~/Library/LaunchAgents/sh.crosstalk.daemon.plist',
      '',
      '# tail logs:',
      'tail -f ~/Library/Logs/crosstalk.log',
    ],
    deactivateInstructions: [
      'launchctl unload ~/Library/LaunchAgents/sh.crosstalk.daemon.plist',
    ],
  }
}

/** Resolve the path to the `crosstalk` binary on this machine. Prefer `which
 * crosstalk` so the unit invokes the same binary the operator just typed.
 * Falls back to process.argv[1] if which fails (e.g. local dev build). */
function resolveCrosstalkBin(): string {
  try {
    const result = spawnSync('which', ['crosstalk'], { encoding: 'utf-8' })
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim()
  } catch {
    // fall through
  }
  // Fallback: the entry script that's currently running this code
  return process.argv[1] ?? 'crosstalk'
}

/** Resolve templates/ directory inside the package. When run from npm-installed
 * dist/, this file lives at <pkg>/dist/cli/commands/service.js — templates are
 * three levels up at <pkg>/templates/. */
function resolveTemplatesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // dist/cli/commands → ../../.. = pkg root
  return join(here, '..', '..', '..', 'templates')
}

function loadTemplate(templateRel: string): string {
  const templatesDir = resolveTemplatesDir()
  const templatePath = join(templatesDir, templateRel.replace('templates/', ''))
  if (!existsSync(templatePath)) {
    console.error(`✗ Template not found: ${templatePath}`)
    console.error(`  This shouldn't happen on an npm-installed runtime. If you're running from source, build with \`npm run build\` first.`)
    process.exit(1)
  }
  return readFileSync(templatePath, 'utf-8')
}

function substituteTemplate(template: string): string {
  const bin = resolveCrosstalkBin()
  return template
    .replaceAll('__CROSSTALK_BIN__', bin)
    .replaceAll('__USER_PATH__', process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin')
    .replaceAll('__HOME__', homedir())
}

function runInstall(): void {
  const cfg = getPlatformConfig(detectPlatform())
  const tmpl = loadTemplate(cfg.templateRel)
  const filled = substituteTemplate(tmpl)
  const destDir = dirname(cfg.destPath)
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
  writeFileSync(cfg.destPath, filled)
  console.log(`✓ Installed: ${cfg.destPath}`)
  console.log(``)
  console.log(`Activate with:`)
  for (const line of cfg.activateInstructions) console.log(line ? `  ${line}` : '')
}

function runUninstall(): void {
  const cfg = getPlatformConfig(detectPlatform())
  if (!existsSync(cfg.destPath)) {
    console.log(`(nothing to uninstall — ${cfg.destPath} doesn't exist)`)
    return
  }
  console.log(`Stopping service first if running:`)
  for (const line of cfg.deactivateInstructions) console.log(line ? `  ${line}` : '')
  console.log(``)
  console.log(`Remove the unit file:`)
  unlinkSync(cfg.destPath)
  console.log(`  ✓ Deleted: ${cfg.destPath}`)
}

function runTemplate(): void {
  const cfg = getPlatformConfig(detectPlatform())
  const tmpl = loadTemplate(cfg.templateRel)
  const filled = substituteTemplate(tmpl)
  process.stdout.write(filled)
}

export function registerServiceCommand(program: Command): void {
  const service = program
    .command('service')
    .description('install/uninstall/inspect a user-level service unit (systemd user / launchd LaunchAgent)')

  service
    .command('install')
    .description(`install the user-level unit for this platform (writes to ${platform() === 'darwin' ? '~/Library/LaunchAgents/' : '~/.config/systemd/user/'})`)
    .action(() => runInstall())

  service
    .command('uninstall')
    .description('remove the user-level unit (does NOT stop a running service — use the printed activate/deactivate commands)')
    .action(() => runUninstall())

  service
    .command('template')
    .description('print the substituted template to stdout without writing to disk (for inspection or piping to a custom location)')
    .action(() => runTemplate())
}
