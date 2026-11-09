"""Writes a macOS installer package (.pkg) using only the Python standard library.

A product archive is a xar file holding a Distribution file, the installer's pages, and one
component package. The component carries no payload of its own: its install script unpacks
Forge from archives kept beside it in Scripts. A package with no payload needs no Bom, the
file list that otherwise only Apple's tools or a separate program can write.

Usage: python3 make-pkg.py <stage> <version> <out.pkg>
  <stage>/scripts    preinstall, postinstall, and the archives they unpack
  <stage>/resources  welcome.html, license.txt, conclusion.html
"""
import gzip
import hashlib
import os
import struct
import sys
import time
import zlib
from xml.sax.saxutils import escape

IDENTIFIER = 'com.forge-erp.pkg'


def cpio_odc(root):
    """An odc cpio archive of a folder, with paths starting ./ and everything owned by root."""
    out = bytearray()
    inode = 1

    def entry(name, mode, data=b''):
        nonlocal inode
        name_bytes = name.encode() + b'\0'
        out.extend(b'070707')
        out.extend(b'%06o%06o%06o%06o%06o%06o%06o%011o%06o%011o' % (0, inode, mode, 0, 0, 1, 0, int(time.time()), len(name_bytes), len(data)))
        out.extend(name_bytes)
        out.extend(data)
        inode += 1

    entry('.', 0o040755)
    for folder, dirs, files in os.walk(root):
        dirs.sort()
        relative = os.path.relpath(folder, root)
        for name in sorted(dirs):
            entry(f'./{os.path.normpath(os.path.join(relative, name))}', 0o040755)
        for name in sorted(files):
            path = os.path.join(folder, name)
            mode = 0o100755 if os.access(path, os.X_OK) else 0o100644
            with open(path, 'rb') as handle:
                entry(f'./{os.path.normpath(os.path.join(relative, name))}', mode, handle.read())
    out.extend(b'070707' + b'%06o%06o%06o%06o%06o%06o%06o%011o%06o%011o' % (0, 0, 0, 0, 0, 1, 0, 0, 11, 0) + b'TRAILER!!!\0')
    return bytes(out)


def xar(entries):
    """A xar archive. entries maps a path like 'forge.pkg/Scripts' to its bytes. No compression,
    as installer packages are stored, and every file carries a SHA-1 checksum."""
    heap = bytearray(b'\0' * 20)
    tree = {}
    for path, data in entries.items():
        node = tree
        parts = path.split('/')
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        node[parts[-1]] = data

    next_id = [1]

    def render(node, depth):
        xml = []
        pad = '  ' * depth
        for name in sorted(node):
            value = node[name]
            file_id = next_id[0]
            next_id[0] += 1
            if isinstance(value, dict):
                xml.append(f'{pad}<file id="{file_id}"><name>{escape(name)}</name><type>directory</type><mode>0755</mode><uid>0</uid><gid>0</gid><user>root</user><group>wheel</group>')
                xml.append(render(value, depth + 1))
                xml.append(f'{pad}</file>')
            else:
                offset = len(heap)
                heap.extend(value)
                digest = hashlib.sha1(value).hexdigest()
                xml.append(
                    f'{pad}<file id="{file_id}"><name>{escape(name)}</name><type>file</type><mode>0644</mode><uid>0</uid><gid>0</gid><user>root</user><group>wheel</group>'
                    f'<data><length>{len(value)}</length><offset>{offset}</offset><size>{len(value)}</size>'
                    f'<encoding style="application/octet-stream"/>'
                    f'<extracted-checksum style="sha1">{digest}</extracted-checksum>'
                    f'<archived-checksum style="sha1">{digest}</archived-checksum></data></file>'
                )
        return '\n'.join(xml)

    body = render(tree, 2)
    stamp = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    toc = (
        '<?xml version="1.0" encoding="UTF-8"?>\n<xar>\n <toc>\n'
        '  <checksum style="sha1"><offset>0</offset><size>20</size></checksum>\n'
        f'  <creation-time>{stamp}</creation-time>\n{body}\n </toc>\n</xar>\n'
    ).encode()
    packed = zlib.compress(toc, 9)
    heap[0:20] = hashlib.sha1(packed).digest()
    header = struct.pack('>4sHHQQI', b'xar!', 28, 1, len(packed), len(toc), 1)
    return header + packed + bytes(heap)


def main(stage, version, out):
    scripts = gzip.compress(cpio_odc(os.path.join(stage, 'scripts')), 9)
    package_info = (
        f'<?xml version="1.0" encoding="utf-8"?>\n'
        f'<pkg-info format-version="2" identifier="{IDENTIFIER}" version="{version}" install-location="/" auth="root">\n'
        f'  <scripts>\n    <preinstall file="./preinstall"/>\n    <postinstall file="./postinstall"/>\n  </scripts>\n'
        f'</pkg-info>\n'
    ).encode()
    distribution = (
        f'<?xml version="1.0" encoding="utf-8"?>\n'
        f'<installer-gui-script minSpecVersion="2">\n'
        f'  <title>Forge ERP</title>\n'
        f'  <welcome file="welcome.html" mime-type="text/html"/>\n'
        f'  <license file="license.txt" mime-type="text/plain"/>\n'
        f'  <conclusion file="conclusion.html" mime-type="text/html"/>\n'
        f'  <options customize="never" require-scripts="true" rootVolumeOnly="true" hostArchitectures="arm64,x86_64"/>\n'
        f'  <domains enable_localSystem="true" enable_anywhere="false" enable_currentUserHome="false"/>\n'
        f'  <volume-check><allowed-os-versions><os-version min="11.0"/></allowed-os-versions></volume-check>\n'
        f'  <choices-outline><line choice="default"><line choice="{IDENTIFIER}"/></line></choices-outline>\n'
        f'  <choice id="default"/>\n'
        f'  <choice id="{IDENTIFIER}" visible="false"><pkg-ref id="{IDENTIFIER}"/></choice>\n'
        f'  <pkg-ref id="{IDENTIFIER}" version="{version}" onConclusion="none">#forge.pkg</pkg-ref>\n'
        f'</installer-gui-script>\n'
    ).encode()
    entries = {
        'Distribution': distribution,
        'forge.pkg/PackageInfo': package_info,
        'forge.pkg/Scripts': scripts,
    }
    resources = os.path.join(stage, 'resources')
    for name in sorted(os.listdir(resources)):
        with open(os.path.join(resources, name), 'rb') as handle:
            entries[f'Resources/en.lproj/{name}'] = handle.read()
    with open(out, 'wb') as handle:
        handle.write(xar(entries))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3])
