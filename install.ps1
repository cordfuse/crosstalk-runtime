# Crosstalk Runtime installer for Windows
# Usage (elevated PowerShell):
#   iex (irm https://github.com/cordfuse/crosstalk-runtime/releases/latest/download/install.ps1)
#
# Requires: PowerShell 5.1+ and an elevated (Administrator) session.
# Downloads and silently runs the Inno Setup installer, then prints next steps.

#Requires -Version 5.1

$ErrorActionPreference = 'Stop'
$Repo = 'cordfuse/crosstalk-runtime'

function Write-Step($msg) { Write-Host "[crosstalk] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[crosstalk] $msg" -ForegroundColor Yellow }

# ── Elevation check ────────────────────────────────────────────────────────
$currentPrincipal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "Run this script from an elevated (Administrator) PowerShell session."
}

# ── Latest version ─────────────────────────────────────────────────────────
Write-Step "Fetching latest release..."
$release  = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
$version  = $release.tag_name -replace '^v', ''
Write-Step "Installing v$version"

# ── Detect architecture ────────────────────────────────────────────────────
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
Write-Step "Detected architecture: $arch"

# ── Download installer ─────────────────────────────────────────────────────
$installerName = "crosstalk-runtime-setup-$version-$arch.exe"
$url           = "https://github.com/$Repo/releases/download/v$version/$installerName"
$tmp           = Join-Path $env:TEMP $installerName

Write-Step "Downloading $installerName..."
Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing

# ── Silent install ─────────────────────────────────────────────────────────
Write-Step "Running installer (silent)..."
$proc = Start-Process -FilePath $tmp -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait -PassThru
if ($proc.ExitCode -ne 0) {
    Write-Error "Installer exited with code $($proc.ExitCode)"
}
Remove-Item $tmp -ErrorAction SilentlyContinue

# ── Post-install instructions ──────────────────────────────────────────────
Write-Host ""
Write-Step "Done! Next steps (run in an elevated terminal):"
Write-Host "  1. Set up the daemon with your transport repo:"
Write-Host "       crosstalk install <git-url>"
Write-Host "  2. Add the printed SSH key to GitHub (Settings -> SSH and GPG keys)"
Write-Host "  3. Add a workspace:"
Write-Host "       crosstalk add-workspace <git-url>"
Write-Host "  4. Open a session:"
Write-Host "       crosstalk open"
Write-Host ""
