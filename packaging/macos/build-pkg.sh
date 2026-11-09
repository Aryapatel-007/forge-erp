#!/usr/bin/env bash
# Builds the Mac installer: packaging/macos/out/ForgeERP-<version>.pkg
# Needs node, npm and python3 only. Runs on Linux or macOS.
#   FORGE_VERSION=1.0.1 packaging/macos/build-pkg.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
version=${FORGE_VERSION:-1.0.0}
build="$here/build"
stage="$build/stage"
out="$here/out/ForgeERP-$version.pkg"

echo "Building Forge ERP $version for Mac"
rm -rf "$stage"
mkdir -p "$stage/program/app/server" "$stage/program/app/client" "$stage/program/setup" "$stage/applications" "$stage/scripts" "$stage/resources" "$here/out"

echo "1. Screens"
(cd "$root" && npm run build > /dev/null)

echo "2. Program files, without tests or anyone's local settings"
tar -C "$root/server" --exclude=./tests --exclude=./node_modules --exclude='./.env*' -cf - . | tar -C "$stage/program/app/server" -xf -
cp -r "$root/client/dist" "$stage/program/app/client/dist"
cp "$root/client/package.json" "$stage/program/app/client/"
cp "$root/package.json" "$root/package-lock.json" "$stage/program/app/"
install -m 0755 "$here/uninstall.sh" "$stage/program/setup/uninstall.sh"

echo "3. Packages the server needs, at the versions in the lockfile. Nothing is compiled."
(cd "$stage/program/app" && npm ci --omit=dev --workspace=server --ignore-scripts --prefer-offline --no-audit --no-fund > /dev/null)
find "$stage/program/app/node_modules" -maxdepth 1 -type l -name 'forge-erp-*' -delete
rm -rf "$stage/program/app/node_modules/.bin"
# bcrypt ships ready builds for both kinds of Mac. The others are not needed.
find "$stage/program/app/node_modules/bcrypt/prebuilds" -mindepth 1 -maxdepth 1 ! -name 'darwin-*' -exec rm -rf {} +
test -f "$stage/program/app/node_modules/bcrypt/prebuilds/darwin-arm64/bcrypt.node"
test -f "$stage/program/app/node_modules/bcrypt/prebuilds/darwin-x64/bcrypt.node"

echo "4. The app in Applications, and its icon"
python3 -I "$here/make-app.py" "$stage/applications" "$version"

echo "5. Install scripts and what they unpack, owned by root"
COPYFILE_DISABLE=1 tar --owner=0 --group=0 -C "$stage/program" -czf "$stage/scripts/forge-program.tgz" app setup
COPYFILE_DISABLE=1 tar --owner=0 --group=0 -C "$stage/applications" -czf "$stage/scripts/forge-app.tgz" "Forge ERP.app"
install -m 0755 "$here/preinstall" "$stage/scripts/preinstall"
install -m 0755 "$here/postinstall" "$stage/scripts/postinstall"
bash -n "$stage/scripts/preinstall"
bash -n "$stage/scripts/postinstall"

echo "6. Installer pages"
cp "$here/welcome.html" "$here/conclusion.html" "$stage/resources/"
{ cat "$root/LICENSE"; echo; cat "$here/third-party.txt"; } > "$stage/resources/license.txt"

echo "7. Package"
python3 -I "$here/make-pkg.py" "$stage" "$version" "$out"
sha256sum "$out" | tee "$out.sha256"
ls -la "$out"
