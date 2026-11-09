"""Draws every picture the Forge vault needs on a Windows PC, with the standard library only.

  forge-vault.ico              the blue vault folder, for Explorer's left panel
  overlay-mine.ico             badge: checked out by you (green)
  overlay-locked.ico           badge: checked out by someone else (red lock)
  overlay-released.ico         badge: released (blue tick)
  commands-<size>.png          the SOLIDWORKS Forge tab buttons, one strip per size
  main-<size>.png              the Forge tab's own icon
  taskpane.bmp                 the task pane tab icon, 16 x 18

Usage: python3 make-art.py <out-dir>
"""
import math
import os
import struct
import sys
import zlib

BLUE = (0x1F, 0x5F, 0xA8)
BLUE_LIGHT = (0x4A, 0x8B, 0xD6)
SPARK = (0xE4, 0x60, 0x1A)
GREEN = (0x2C, 0x7A, 0x4B)
RED = (0xC0, 0x2E, 0x2E)
AMBER = (0xC2, 0x84, 0x10)
GREY = (0x5F, 0x6B, 0x7A)
WHITE = (0xFF, 0xFF, 0xFF)


# ---------- shapes, in a unit square, y down ----------
def in_round_rect(x, y, x0, y0, x1, y1, r):
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return x0 <= x <= x1 and y0 <= y <= y1 and (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_circle(x, y, cx, cy, r):
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_polygon(x, y, pts):
    inside = False
    j = len(pts) - 1
    for i in range(len(pts)):
        xi, yi = pts[i]
        xj, yj = pts[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def near_segment(x, y, a, b, w):
    (ax, ay), (bx, by) = a, b
    dx, dy = bx - ax, by - ay
    t = max(0, min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
    return (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= (w / 2) ** 2


def near_arc(x, y, cx, cy, r, w, a0, a1):
    d = math.hypot(x - cx, y - cy)
    if abs(d - r) > w / 2:
        return False
    a = math.degrees(math.atan2(y - cy, x - cx)) % 360
    return a0 <= a <= a1 if a0 <= a1 else a >= a0 or a <= a1


# ---------- glyphs: each returns a colour or None ----------
def folder(x, y):
    if in_round_rect(x, y, 0.06, 0.16, 0.48, 0.36, 0.05):
        return BLUE
    if in_round_rect(x, y, 0.06, 0.26, 0.94, 0.86, 0.07):
        if abs(x - 0.5) + abs(y - 0.58) <= 0.15:
            return SPARK
        return BLUE_LIGHT if y < 0.34 else BLUE
    return None


def badge(colour, mark):
    # Overlays sit in the lower-left corner of the file's own icon.
    def draw(x, y):
        if not in_circle(x, y, 0.25, 0.75, 0.24):
            return None
        if in_circle(x, y, 0.25, 0.75, 0.21):
            return WHITE if mark(x, y) else colour
        return WHITE
    return draw


def tick(cx, cy, s, w):
    return lambda x, y: near_segment(x, y, (cx - 0.5 * s, cy), (cx - 0.15 * s, cy + 0.35 * s), w) or near_segment(x, y, (cx - 0.15 * s, cy + 0.35 * s), (cx + 0.55 * s, cy - 0.4 * s), w)


def lock(cx, cy, s):
    return lambda x, y: in_round_rect(x, y, cx - 0.45 * s, cy - 0.05 * s, cx + 0.45 * s, cy + 0.55 * s, 0.06 * s) or near_arc(x, y, cx, cy - 0.12 * s, 0.28 * s, 0.14 * s, 180, 360)


def pencil(cx, cy, s):
    return lambda x, y: near_segment(x, y, (cx - 0.45 * s, cy + 0.45 * s), (cx + 0.4 * s, cy - 0.4 * s), 0.22 * s)


def tile(colour, mark):
    def draw(x, y):
        if not in_round_rect(x, y, 0.04, 0.04, 0.96, 0.96, 0.18):
            return None
        return WHITE if mark(x, y) else colour
    return draw


def arrow(direction):
    # A thick arrow pointing down (get) or up (send) into a tray.
    def mark(x, y):
        tray = near_segment(x, y, (0.22, 0.8), (0.78, 0.8), 0.09) or near_segment(x, y, (0.22, 0.8), (0.22, 0.66), 0.09) or near_segment(x, y, (0.78, 0.8), (0.78, 0.66), 0.09)
        if direction == 'down':
            shaft = near_segment(x, y, (0.5, 0.16), (0.5, 0.5), 0.12)
            head = in_polygon(x, y, [(0.3, 0.46), (0.7, 0.46), (0.5, 0.68)])
        else:
            shaft = near_segment(x, y, (0.5, 0.36), (0.5, 0.68), 0.12)
            head = in_polygon(x, y, [(0.3, 0.38), (0.7, 0.38), (0.5, 0.16)])
        return tray or shaft or head
    return mark


def undo(x, y):
    return near_arc(x, y, 0.52, 0.56, 0.24, 0.1, 200, 90) or in_polygon(x, y, [(0.16, 0.5), (0.4, 0.5), (0.28, 0.3)])


def eye(x, y):
    outline = abs(((x - 0.5) / 0.36) ** 2 + ((y - 0.5) / 0.22) ** 2 - 1) < 0.28
    return outline or in_circle(x, y, 0.5, 0.5, 0.1)


def plus(x, y):
    return near_segment(x, y, (0.5, 0.24), (0.5, 0.76), 0.13) or near_segment(x, y, (0.24, 0.5), (0.76, 0.5), 0.13)


def diamond(x, y):
    return abs(x - 0.5) + abs(y - 0.5) <= 0.26


def refresh(x, y):
    return near_arc(x, y, 0.5, 0.5, 0.25, 0.1, 30, 300) or in_polygon(x, y, [(0.62, 0.2), (0.82, 0.36), (0.6, 0.44)])


COMMANDS = [  # the order the add-in uses
    tile(GREEN, arrow('down')),        # Pull
    tile(BLUE, arrow('up')),           # Push
    tile(RED, lock(0.5, 0.52, 0.62)),  # Lock
    tile(GREY, undo),                  # Unlock
    tile(AMBER, eye),                  # Send for review
    tile(BLUE, tick(0.5, 0.52, 0.5, 0.12)),  # Release
    tile(GREY, plus),                  # New revision
    tile(SPARK, diamond),              # Open in Forge
    tile(GREY, refresh),               # Refresh
]


def render(draw, size):
    scale = 4
    out = []
    for py in range(size):
        row = []
        for px in range(size):
            r = g = b = a = 0
            for sy in range(scale):
                for sx in range(scale):
                    c = draw((px + (sx + 0.5) / scale) / size, (py + (sy + 0.5) / scale) / size)
                    if c:
                        r += c[0]; g += c[1]; b += c[2]; a += 1
            n = scale * scale
            row.append((r // a, g // a, b // a, a * 255 // n) if a else (0, 0, 0, 0))
        out.append(row)
    return out


# ---------- file writers ----------
def png(rows):
    width, height = len(rows[0]), len(rows)
    raw = b''.join(b'\0' + bytes(v for p in row for v in p) for row in rows)

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')


def ico(draw, sizes=(16, 20, 24, 32, 48, 64, 256)):
    images = [png(render(draw, s)) for s in sizes]
    head = struct.pack('<HHH', 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries = b''
    for size, data in zip(sizes, images):
        entries += struct.pack('<BBBBHHII', size % 256, size % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    return head + entries + b''.join(images)


def strip(draws, size):
    rows = [[] for _ in range(size)]
    for draw in draws:
        for y, row in enumerate(render(draw, size)):
            rows[y].extend(row)
    return png(rows)


def bmp_16x18(draw):
    # 24-bit bitmap; SOLIDWORKS treats pure white as transparent here.
    rows = render(draw, 16)
    pixels = []
    for row in rows + [[(0, 0, 0, 0)] * 16] * 2:
        line = b''
        for r, g, b, a in row:
            k = a / 255
            line += bytes((round(b * k + 255 * (1 - k)), round(g * k + 255 * (1 - k)), round(r * k + 255 * (1 - k))))
        pixels.append(line)
    data = b''.join(reversed(pixels))
    return b'BM' + struct.pack('<IHHI', 54 + len(data), 0, 0, 54) + struct.pack('<IiiHHIIiiII', 40, 16, 18, 1, 24, 0, len(data), 2835, 2835, 0, 0) + data


def main(out):
    os.makedirs(out, exist_ok=True)
    files = {
        'forge-vault.ico': ico(folder),
        'overlay-mine.ico': ico(badge(GREEN, pencil(0.25, 0.75, 0.22))),
        'overlay-locked.ico': ico(badge(RED, lock(0.25, 0.77, 0.24))),
        'overlay-released.ico': ico(badge(BLUE, tick(0.26, 0.76, 0.22, 0.07))),
        'taskpane.bmp': bmp_16x18(folder),
    }
    for size in (20, 32, 40, 64, 96, 128):
        files[f'commands-{size}.png'] = strip(COMMANDS, size)
        files[f'main-{size}.png'] = strip([folder], size)
    for name, data in files.items():
        with open(os.path.join(out, name), 'wb') as f:
            f.write(data)
    print('wrote', len(files), 'files to', out)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'art')
