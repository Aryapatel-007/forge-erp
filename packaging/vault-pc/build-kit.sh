#!/bin/sh
# Builds ForgeVault-PC-Kit.zip: the Explorer badges and SOLIDWORKS add-in, as source with an
# installer that compiles them on the PC. Also refreshes the vault folder icon that Forge
# puts into each PC's sync file.
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
python3 "$here/make-art.py" "$here/art"
cp "$here/art/forge-vault.ico" "$root/server/assets/forge-vault.ico"
stage=$(mktemp -d)
mkdir -p "$stage/ForgeVault-PC-Kit/art"
cp "$here/kit/"* "$stage/ForgeVault-PC-Kit/"
cp "$here/art/"* "$stage/ForgeVault-PC-Kit/art/"
cp "$root/LICENSE" "$stage/ForgeVault-PC-Kit/LICENSE.txt"
rm -f "$root/server/assets/ForgeVault-PC-Kit.zip"
(cd "$stage" && python3 -c "
import os, zipfile
with zipfile.ZipFile('kit.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    for base, _, files in os.walk('ForgeVault-PC-Kit'):
        for f in sorted(files):
            z.write(os.path.join(base, f))
")
mv "$stage/kit.zip" "$root/server/assets/ForgeVault-PC-Kit.zip"
rm -rf "$stage"
echo "Built $root/server/assets/ForgeVault-PC-Kit.zip"
