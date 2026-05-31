#!/usr/bin/env bash
set -euo pipefail

# Usage: ./build-deb.sh <binary-path> <version> <arch>
# arch: amd64 | arm64
# Example: ./build-deb.sh ./crosstalk-linux-x64 3.0.0 amd64

BINARY="$1"
VERSION="$2"
ARCH="$3"

WORKDIR="$(mktemp -d)"
PKGDIR="$WORKDIR/crosstalk-runtime_${VERSION}_${ARCH}"

cp -r "$(dirname "$0")/deb" "$PKGDIR"

# Inject binary
cp "$BINARY" "$PKGDIR/usr/bin/crosstalk"
chmod 755 "$PKGDIR/usr/bin/crosstalk"

# Inject version and arch into control
sed -i "s/VERSION_PLACEHOLDER/$VERSION/" "$PKGDIR/DEBIAN/control"
sed -i "s/ARCH_PLACEHOLDER/$ARCH/" "$PKGDIR/DEBIAN/control"

# Make maintainer scripts executable
chmod 755 "$PKGDIR/DEBIAN/postinst" "$PKGDIR/DEBIAN/prerm"

# Build
dpkg-deb --build "$PKGDIR" "crosstalk-runtime_${VERSION}_${ARCH}.deb"
rm -rf "$WORKDIR"

echo "Built: crosstalk-runtime_${VERSION}_${ARCH}.deb"
