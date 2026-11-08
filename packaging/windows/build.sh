#!/usr/bin/env bash
# Builds the Windows setup program: packaging/windows/out/ForgeERP-Setup-<version>-x64.exe
# Needs makensis (apt install nsis), node, npm and python3. Runs on Linux or macOS.
#   FORGE_VERSION=1.0.1 packaging/windows/build.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
version=${FORGE_VERSION:-1.0.0}
build="$here/build"
stage="$build/stage"
out="$here/out/ForgeERP-Setup-$version-x64.exe"

WINSW_URL=https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW.NET461.exe
WINSW_SHA256=b5066b7bbdfba1293e5d15cda3caaea88fbeab35bd5b38c41c913d492aadfc4f
WINSW_LICENSE_URL=https://raw.githubusercontent.com/winsw/winsw/v2.12.0/LICENSE.txt

echo "Building Forge ERP $version setup"
rm -rf "$stage"
mkdir -p "$stage/app/server" "$stage/app/client" "$here/out"

echo "1. Screens"
(cd "$root" && npm run build > /dev/null)

echo "2. Program files, without tests or anyone's local settings"
tar -C "$root/server" --exclude=./tests --exclude=./node_modules --exclude='./.env*' -cf - . | tar -C "$stage/app/server" -xf -
cp -r "$root/client/dist" "$stage/app/client/dist"
cp "$root/client/package.json" "$stage/app/client/"
cp "$root/package.json" "$root/package-lock.json" "$stage/app/"

echo "3. Packages the server needs, at the versions in the lockfile. Nothing is compiled."
(cd "$stage/app" && npm ci --omit=dev --workspace=server --ignore-scripts --prefer-offline --no-audit --no-fund > /dev/null)
# npm links the workspaces into node_modules. The setup would copy them a second time.
find "$stage/app/node_modules" -maxdepth 1 -type l -name 'forge-erp-*' -delete
# bcrypt ships a ready Windows build. The builds for other systems are not needed.
find "$stage/app/node_modules/bcrypt/prebuilds" -mindepth 1 -maxdepth 1 ! -name win32-x64 -exec rm -rf {} +
test -f "$stage/app/node_modules/bcrypt/prebuilds/win32-x64/bcrypt.node"

echo "4. Service wrapper, checked against its known hash"
[ -f "$build/WinSW.NET461.exe" ] || curl -sfL -o "$build/WinSW.NET461.exe" "$WINSW_URL"
echo "$WINSW_SHA256  $build/WinSW.NET461.exe" | sha256sum -c --quiet
[ -f "$build/WinSW-LICENSE.txt" ] || curl -sfL -o "$build/WinSW-LICENSE.txt" "$WINSW_LICENSE_URL"
cp "$build/WinSW.NET461.exe" "$build/WinSW-LICENSE.txt" "$stage/"

echo "5. Icon"
python3 -I "$here/make-icon.py" "$build/forge.ico"

echo "6. Setup program"
(cd "$here" && makensis -V2 -DVERSION="$version" -DSTAGE="$stage" -DBUILD="$build" -DOUT="$out" forge.nsi)
sha256sum "$out" | tee "$out.sha256"
ls -la "$out"
