# Crosstalk Runtime — Windows is not supported.
#
# Crosstalk runs on Linux and macOS. Windows users must use WSL2.
#
# ONE-TIME SETUP (run once in an elevated PowerShell):
#   wsl --install
#   # Reboot when prompted, then open a WSL terminal and run:
#   curl -fsSL https://github.com/cordfuse/crosstalk-runtime/releases/latest/download/install.sh | bash

Write-Host ""
Write-Host "Crosstalk does not support native Windows." -ForegroundColor Red
Write-Host ""
Write-Host "Use WSL2 instead — it takes two steps:" -ForegroundColor Yellow
Write-Host ""
Write-Host "  1. Install WSL2 (elevated PowerShell, one time):" -ForegroundColor White
Write-Host "       wsl --install" -ForegroundColor Cyan
Write-Host "       # Reboot when prompted" -ForegroundColor Gray
Write-Host ""
Write-Host "  2. Open a WSL terminal and run the Linux installer:" -ForegroundColor White
Write-Host "       curl -fsSL https://github.com/cordfuse/crosstalk-runtime/releases/latest/download/install.sh | bash" -ForegroundColor Cyan
Write-Host ""
Write-Host "WSL2 gives you full Linux systemd, SSH, and service management." -ForegroundColor Gray
Write-Host "The daemon runs as a Linux process; Claude Code and other agent CLIs" -ForegroundColor Gray
Write-Host "work identically to a native Linux install." -ForegroundColor Gray
Write-Host ""
