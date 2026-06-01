#!/usr/bin/env bash
set -euo pipefail

# Usage: ./build-rpm.sh <binary-path> <version> <arch>
# arch: x86_64 | aarch64
# Example: ./build-rpm.sh ./crosstalk-linux-x64 3.0.0 x86_64

BINARY="$1"
VERSION="$2"
ARCH="$3"

RPMBUILD="$HOME/rpmbuild"
mkdir -p "$RPMBUILD"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}

# Stage binary and service file as sources
cp "$BINARY" "$RPMBUILD/SOURCES/crosstalk-linux-$ARCH"
cp "$(dirname "$0")/deb/usr/lib/systemd/system/crosstalk.service" "$RPMBUILD/SOURCES/crosstalk.service"

# Inject version and arch into spec
sed \
  -e "s/%{version_placeholder}/$VERSION/g" \
  -e "s/%{arch_placeholder}/$ARCH/g" \
  "$(dirname "$0")/crosstalk-runtime.spec" > "$RPMBUILD/SPECS/crosstalk-runtime.spec"

rpmbuild -bb \
  --target "$ARCH" \
  --define "_topdir $RPMBUILD" \
  "$RPMBUILD/SPECS/crosstalk-runtime.spec"

OUTFILE=$(find "$RPMBUILD/RPMS" -name "*.rpm" | head -1)
cp "$OUTFILE" "./crosstalk-runtime-${VERSION}-1.${ARCH}.rpm"
echo "Built: crosstalk-runtime-${VERSION}-1.${ARCH}.rpm"
