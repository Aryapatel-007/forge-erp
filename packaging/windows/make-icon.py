"""Draws the Forge icon, an orange diamond on a dark tile, and writes it as a Windows .ico.

Uses only the standard library. Each size is drawn at four times the size and averaged down,
so the edges are smooth.  Usage: python3 make-icon.py out.ico
"""
import struct
import sys

DARK = (0x17, 0x1C, 0x1B)
SPARK = (0xE4, 0x60, 0x1A)


def pixel(x, y, size):
    """Colour and coverage at a point, in a square of side 1."""
    radius = 0.18
    # Rounded tile
    cx = min(max(x, radius), 1 - radius)
    cy = min(max(y, radius), 1 - radius)
    if (x - cx) ** 2 + (y - cy) ** 2 > radius ** 2:
        return None
    # Diamond
    if abs(x - 0.5) + abs(y - 0.5) <= 0.27:
        return SPARK
    return DARK


def render(size):
    scale = 4
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            red = green = blue = alpha = 0
            for sy in range(scale):
                for sx in range(scale):
                    colour = pixel((x + (sx + 0.5) / scale) / size, (y + (sy + 0.5) / scale) / size, size)
                    if colour:
                        red += colour[0]
                        green += colour[1]
                        blue += colour[2]
                        alpha += 255
            samples = scale * scale
            covered = alpha // 255
            if covered:
                row.append((red // covered, green // covered, blue // covered, alpha // samples))
            else:
                row.append((0, 0, 0, 0))
        rows.append(row)
    return rows


def bitmap(size):
    """A 32-bit image with an alpha channel, as an icon stores it: bottom row first."""
    rows = render(size)
    header = struct.pack('<IiiHHIIiiII', 40, size, size * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    pixels = b''.join(bytes((b, g, r, a)) for row in reversed(rows) for (r, g, b, a) in row)
    mask_row = ((size + 31) // 32) * 4
    mask = b'\x00' * (mask_row * size)
    return header + pixels + mask


def main(path):
    sizes = [16, 24, 32, 48, 256]
    images = [bitmap(size) for size in sizes]
    out = struct.pack('<HHH', 0, 1, len(sizes))
    offset = 6 + 16 * len(sizes)
    for size, data in zip(sizes, images):
        out += struct.pack('<BBBBHHII', size % 256, size % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    out += b''.join(images)
    with open(path, 'wb') as handle:
        handle.write(out)


if __name__ == '__main__':
    main(sys.argv[1])
