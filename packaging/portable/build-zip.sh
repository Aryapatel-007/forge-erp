#!/usr/bin/env bash
# Builds a portable zip that runs on Windows and Mac with no installer:
#   packaging/portable/out/ForgeERP-<version>-portable.zip
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
version=${FORGE_VERSION:-1.0.0}
stage="$here/build/Forge ERP"
out="$here/out/ForgeERP-$version-portable.zip"

rm -rf "$here/build"
mkdir -p "$stage/app/server" "$stage/app/client" "$stage/app/launcher" "$here/out"
(cd "$root" && npm run build > /dev/null)
tar -C "$root/server" --exclude=./tests --exclude=./node_modules --exclude='./.env*' -cf - . | tar -C "$stage/app/server" -xf -
cp -r "$root/client/dist" "$stage/app/client/dist"
cp "$root/client/package.json" "$stage/app/client/"
cp "$root/package.json" "$root/package-lock.json" "$stage/app/"
(cd "$stage/app" && npm ci --omit=dev --workspace=server --ignore-scripts --prefer-offline --no-audit --no-fund > /dev/null)
find "$stage/app/node_modules" -maxdepth 1 -type l -name 'forge-erp-*' -delete
rm -rf "$stage/app/node_modules/.bin"
find "$stage/app/node_modules/bcrypt/prebuilds" -mindepth 1 -maxdepth 1 ! -name win32-x64 ! -name 'darwin-*' -exec rm -rf {} +

install -m 0755 "$here/start-mac.sh" "$stage/app/launcher/start-mac.sh"
cp "$here/start-windows.ps1" "$stage/app/launcher/"
printf '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%%~dp0app\\launcher\\start-windows.ps1"\r\n' > "$stage/Start Forge (Windows).bat"
printf '#!/bin/bash\nexec "$(dirname "$0")/app/launcher/start-mac.sh"\n' > "$stage/Start Forge (Mac).command"
chmod 0755 "$stage/Start Forge (Mac).command"
cp "$here/README.txt" "$stage/README.txt"
cp "$root/LICENSE" "$stage/LICENSE.txt"

# Python keeps the Unix permissions in the zip, so the Mac start file stays runnable.
python3 -I - "$here/build" "$out" <<'PY'
import os, sys, zipfile
base, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for folder, dirs, files in os.walk(base):
        dirs.sort()
        for name in sorted(files):
            path = os.path.join(folder, name)
            info = zipfile.ZipInfo.from_file(path, os.path.relpath(path, base))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = (0o100755 if os.access(path, os.X_OK) else 0o100644) << 16
            with open(path, 'rb') as handle:
                z.writestr(info, handle.read())
PY
sha256sum "$out" | tee "$out.sha256"
ls -la "$out"
