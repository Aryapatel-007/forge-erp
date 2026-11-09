"""Builds 'Forge ERP.app', the icon in Applications that opens Forge in the browser.

Forge itself runs in the background as a service, so the app only opens the page, or says
Forge is still starting. The icon is the same diamond as on Windows, as an .icns file.
Usage: python3 make-app.py <out folder> <version>
"""
import importlib.util
import os
import struct
import sys
import zlib

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('forge_icon', os.path.join(here, '..', 'windows', 'make-icon.py'))
forge_icon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(forge_icon)


def png(size):
    rows = forge_icon.render(size)
    raw = b''.join(b'\x00' + b''.join(bytes(px) for px in row) for row in rows)

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF)

    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')


def icns():
    parts = b''.join(kind + struct.pack('>I', len(data) + 8) + data for kind, data in [(b'ic07', png(128)), (b'ic08', png(256)), (b'ic09', png(512))])
    return b'icns' + struct.pack('>I', len(parts) + 8) + parts


INFO = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Forge ERP</string>
  <key>CFBundleDisplayName</key><string>Forge ERP</string>
  <key>CFBundleIdentifier</key><string>com.forge-erp.opener</string>
  <key>CFBundleExecutable</key><string>forge-erp</string>
  <key>CFBundleIconFile</key><string>forge</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>{version}</string>
  <key>CFBundleVersion</key><string>{version}</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
"""

OPENER = """#!/bin/sh
# Opens Forge ERP in the browser. Forge itself runs in the background.
URL="http://localhost:4100/"
if curl -sf -o /dev/null "${URL}api/v1/health"; then
  open "$URL"
else
  osascript -e 'display dialog "Forge ERP is starting, or is not running. Try again in a minute. If it still does not open, its log is in /Library/Application Support/Forge ERP/data/logs." buttons {"OK"} default button "OK" with title "Forge ERP"'
fi
"""


def main(out, version):
    app = os.path.join(out, 'Forge ERP.app', 'Contents')
    os.makedirs(os.path.join(app, 'MacOS'), exist_ok=True)
    os.makedirs(os.path.join(app, 'Resources'), exist_ok=True)
    with open(os.path.join(app, 'Info.plist'), 'w') as handle:
        handle.write(INFO.format(version=version))
    opener = os.path.join(app, 'MacOS', 'forge-erp')
    with open(opener, 'w') as handle:
        handle.write(OPENER)
    os.chmod(opener, 0o755)
    with open(os.path.join(app, 'Resources', 'forge.icns'), 'wb') as handle:
        handle.write(icns())


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
