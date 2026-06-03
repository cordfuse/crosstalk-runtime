#!/usr/bin/env bash
# Crosstalk Runtime installer
# Usage: curl -fsSL https://github.com/cordfuse/crosstalk-runtime/releases/latest/download/install.sh | bash
set -euo pipefail

REPO="cordfuse/crosstalk-runtime"
TMPDIR_CT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_CT"' EXIT

# ── Output helpers ─────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { printf "${GREEN}[crosstalk]${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}[crosstalk]${NC} %s\n" "$*"; }
die()   { printf "${RED}[crosstalk]${NC} %s\n" "$*" >&2; exit 1; }

# ── Platform detection ─────────────────────────────────────────────────────
OS=$(uname -s)
ARCH_RAW=$(uname -m)

case "$ARCH_RAW" in
  x86_64|amd64)  ARCH="x64"   ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) die "Unsupported architecture: $ARCH_RAW" ;;
esac

# ── Downloader ─────────────────────────────────────────────────────────────
if command -v curl >/dev/null 2>&1; then
  fetch()    { curl -fsSL "$1"; }
  download() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch()    { wget -qO- "$1"; }
  download() { wget -q "$1" -O "$2"; }
else
  die "curl or wget is required"
fi

# ── Latest version ─────────────────────────────────────────────────────────
info "Fetching latest release..."
VERSION=$(fetch "https://api.github.com/repos/$REPO/releases/latest" \
  | grep '"tag_name"' | sed 's/.*"v\([^"]*\)".*/\1/')
[ -z "$VERSION" ] && die "Could not determine latest version (GitHub API rate limit?)"
info "Installing v$VERSION"

BASE_URL="https://github.com/$REPO/releases/download/v$VERSION"

# ── sudo wrapper ───────────────────────────────────────────────────────────
SUDO=""
[ "$(id -u)" != "0" ] && SUDO="sudo"

# ── Raw binary fallback ────────────────────────────────────────────────────
install_binary() {
  local os_lower="$1"
  local bin="crosstalk-${os_lower}-${ARCH}"
  info "Downloading binary $bin..."
  download "$BASE_URL/$bin" "$TMPDIR_CT/crosstalk"
  chmod +x "$TMPDIR_CT/crosstalk"
  $SUDO install -m755 "$TMPDIR_CT/crosstalk" /usr/local/bin/crosstalk
  info "Installed to /usr/local/bin/crosstalk (no service management)"
  warn "For service management, install via a package manager."
}

# ── macOS ──────────────────────────────────────────────────────────────────
if [ "$OS" = "Darwin" ]; then
  if command -v brew >/dev/null 2>&1; then
    info "Installing via Homebrew..."
    brew install cordfuse/tap/crosstalk-runtime
  else
    warn "Homebrew not found — installing raw binary"
    install_binary "darwin"
  fi

# ── Linux ──────────────────────────────────────────────────────────────────
elif [ "$OS" = "Linux" ]; then

  if command -v pacman >/dev/null 2>&1; then
    PACMAN_ARCH=$([ "$ARCH" = "x64" ] && echo "x86_64" || echo "aarch64")
    PKG="crosstalk-runtime-bin-${VERSION}-1-${PACMAN_ARCH}.pkg.tar.zst"
    info "Downloading $PKG..."
    download "$BASE_URL/$PKG" "$TMPDIR_CT/$PKG"
    $SUDO pacman -U --noconfirm "$TMPDIR_CT/$PKG"

  elif command -v apt-get >/dev/null 2>&1; then
    DEB_ARCH=$([ "$ARCH" = "x64" ] && echo "amd64" || echo "arm64")
    PKG="crosstalk-runtime_${VERSION}_${DEB_ARCH}.deb"
    info "Downloading $PKG..."
    download "$BASE_URL/$PKG" "$TMPDIR_CT/$PKG"
    $SUDO apt-get install -y "$TMPDIR_CT/$PKG"

  elif command -v dnf >/dev/null 2>&1; then
    RPM_ARCH=$([ "$ARCH" = "x64" ] && echo "x86_64" || echo "aarch64")
    PKG="crosstalk-runtime-${VERSION}-1.${RPM_ARCH}.rpm"
    info "Downloading $PKG..."
    download "$BASE_URL/$PKG" "$TMPDIR_CT/$PKG"
    $SUDO dnf install -y "$TMPDIR_CT/$PKG"

  elif command -v rpm >/dev/null 2>&1; then
    RPM_ARCH=$([ "$ARCH" = "x64" ] && echo "x86_64" || echo "aarch64")
    PKG="crosstalk-runtime-${VERSION}-1.${RPM_ARCH}.rpm"
    info "Downloading $PKG..."
    download "$BASE_URL/$PKG" "$TMPDIR_CT/$PKG"
    $SUDO rpm -i "$TMPDIR_CT/$PKG"

  elif command -v brew >/dev/null 2>&1; then
    info "Installing via Linuxbrew..."
    brew install cordfuse/tap/crosstalk-runtime

  else
    warn "No supported package manager found — installing raw binary"
    install_binary "linux"
  fi

else
  die "Unsupported OS: $OS (Windows users: see GitHub Releases for manual install)"
fi

# ── Post-install instructions ──────────────────────────────────────────────
printf "\n"
info "Done! Next steps:"
printf "  1. Generate your SSH deploy key:\n"
printf "       sudo crosstalk keygen\n"
printf "  2. Add the printed key to your transport repo on GitHub:\n"
printf "       repo Settings -> Deploy keys -> Add deploy key (allow write access)\n"
printf "  3. Install the daemon with your transport repo:\n"
printf "       sudo crosstalk install <git-url>\n"
printf "  4. (Optional) Add a workspace repo for agents to work in:\n"
printf "       crosstalk add-workspace <git-url>\n"
printf "  5. Open a session:\n"
printf "       crosstalk open\n\n"
