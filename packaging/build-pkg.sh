#!/usr/bin/env bash
set -euo pipefail

# Usage: ./build-pkg.sh <binary-path> <version> <arch>
# arch: x86_64 | aarch64
# Example: ./build-pkg.sh ./crosstalk-linux-x64 3.0.0 x86_64

BINARY=$(realpath "$1")
VERSION="$2"
ARCH="$3"

BINARY_NAME=$(basename "$BINARY")
SHA256_BIN=$(sha256sum "$BINARY" | cut -d' ' -f1)
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cp "$BINARY" "$WORK/$BINARY_NAME"
cp "$SCRIPT_DIR/crosstalk-runtime.install" "$WORK/"
cp "$SCRIPT_DIR/deb/usr/lib/systemd/system/crosstalk.service" "$WORK/"

SHA256_SVC=$(sha256sum "$WORK/crosstalk.service" | cut -d' ' -f1)

cat > "$WORK/PKGBUILD" << PKGEOF
pkgname=crosstalk-runtime-bin
pkgver=${VERSION}
pkgrel=1
pkgdesc="AI agent messaging daemon for Crosstalk transports"
arch=('${ARCH}')
url="https://github.com/cordfuse/crosstalk-runtime"
license=('MIT')
depends=('git' 'openssh')
install=crosstalk-runtime.install

source=("${BINARY_NAME}" "crosstalk.service")
sha256sums=('${SHA256_BIN}' '${SHA256_SVC}')

package() {
    install -Dm755 "\${srcdir}/${BINARY_NAME}" "\${pkgdir}/usr/bin/crosstalk"
    install -Dm644 "\${srcdir}/crosstalk.service" "\${pkgdir}/usr/lib/systemd/system/crosstalk.service"
    install -dm755 "\${pkgdir}/etc/crosstalk"
    install -dm750 "\${pkgdir}/var/lib/crosstalk"
}
PKGEOF

if [ "$(id -u)" = "0" ]; then
    useradd -m builder 2>/dev/null || true
    chown -R builder "$WORK"
    runuser -u builder -- bash -c "cd '$WORK' && PKGEXT='.pkg.tar.zst' makepkg --noconfirm --nodeps --ignorearch"
else
    cd "$WORK"
    PKGEXT='.pkg.tar.zst' makepkg --noconfirm --nodeps --ignorearch
fi

OUTFILE=$(find "$WORK" -name "*.pkg.tar.zst" | head -1)
OUTNAME="crosstalk-runtime-bin-${VERSION}-1-${ARCH}.pkg.tar.zst"
cp "$OUTFILE" "./${OUTNAME}"
echo "Built: ${OUTNAME}"
