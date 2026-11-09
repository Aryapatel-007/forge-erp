// Pictures of CAD files, made without any CAD software.
//
//   DWG              the thumbnail AutoCAD saves inside every drawing (BMP or PNG)
//   DXF              drawn here as an SVG: lines, circles, arcs, polylines, text and blocks
//   SLDPRT/ASM/DRW   the PNG preview SOLIDWORKS saves inside the file
//   PNG/JPG/WEBP     the image itself
//
// Every reader is best effort and bounded: a file it cannot read simply has no picture. Text
// from a DXF is escaped, and the SVG is served with a sandbox, so a drawing cannot run code.
import zlib from 'node:zlib';

const MAX_SCAN = 64 * 1024 * 1024;

export function makePreview(ext, buffer) {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
    if (ext === 'dwg') return dwgThumbnail(buffer);
    if (ext === 'dxf') return dxfToSvg(buffer);
    if (['sldprt', 'sldasm', 'slddrw'].includes(ext)) return solidworksPreview(buffer);
    if (ext === 'png' && buffer.length < 10e6) return { type: 'image/png', data: buffer };
    if ((ext === 'jpg' || ext === 'jpeg') && buffer.length < 10e6) return { type: 'image/jpeg', data: buffer };
    if (ext === 'webp' && buffer.length < 10e6) return { type: 'image/webp', data: buffer };
  } catch {
    // A damaged or unusual file has no picture. The file itself is still kept.
  }
  return null;
}

// ---------- DWG ----------
const DWG_SENTINEL = Buffer.from('1F256D07D43628289D57CA3F9D44102B', 'hex');

export function dwgThumbnail(buffer) {
  const version = buffer.subarray(0, 6).toString('latin1');
  if (!/^AC10(1[2-9]|[2-3]\d)$/.test(version)) return null; // R13 and later
  const seeker = buffer.readUInt32LE(0x0d);
  if (seeker <= 0 || seeker + 21 > buffer.length) return null;
  if (!buffer.subarray(seeker, seeker + 16).equals(DWG_SENTINEL)) return null;
  const count = buffer[seeker + 20];
  let pos = seeker + 21;
  let bmp = null;
  let png = null;
  for (let i = 0; i < count && pos + 9 <= buffer.length; i += 1, pos += 9) {
    const code = buffer[pos];
    const start = buffer.readUInt32LE(pos + 1);
    const size = buffer.readUInt32LE(pos + 5);
    if (size === 0 || start + size > buffer.length) continue;
    if (code === 2) bmp = buffer.subarray(start, start + size);
    if (code === 6) png = buffer.subarray(start, start + size);
  }
  if (png && validPng(png, 0) === png.length) return { type: 'image/png', data: Buffer.from(png) };
  if (bmp) return dibToBmp(bmp);
  return null;
}

// A DIB as stored in the drawing has no file header. Browsers need one.
function dibToBmp(dib) {
  if (dib.length < 40) return null;
  const headerSize = dib.readUInt32LE(0);
  if (headerSize < 40 || headerSize > dib.length) return null;
  const bitCount = dib.readUInt16LE(14);
  const used = dib.readUInt32LE(32);
  const paletteEntries = used || (bitCount <= 8 ? 2 ** bitCount : 0);
  const file = Buffer.alloc(14);
  file.write('BM', 0, 'latin1');
  file.writeUInt32LE(14 + dib.length, 2);
  file.writeUInt32LE(14 + headerSize + paletteEntries * 4, 10);
  return { type: 'image/bmp', data: Buffer.concat([file, dib]) };
}

// ---------- SOLIDWORKS ----------
// Older files are OLE compound documents with a "PreviewPNG" stream. For newer ones, the
// PNG is found by its signature and accepted only if every chunk checksum is right.
export function solidworksPreview(buffer) {
  const fromStream = isCompoundFile(buffer) ? readCompoundStream(buffer, /^previewpng$/i) : null;
  if (fromStream && validPng(fromStream, 0) > 0) return { type: 'image/png', data: fromStream };
  const found = findPng(buffer);
  return found ? { type: 'image/png', data: found } : null;
}

const PNG_SIGNATURE = Buffer.from('89504E470D0A1A0A', 'hex');

// Returns the length of a whole, valid PNG starting at `start`, or 0.
function validPng(buffer, start) {
  if (!buffer.subarray(start, start + 8).equals(PNG_SIGNATURE)) return 0;
  let pos = start + 8;
  for (let chunks = 0; chunks < 100000 && pos + 12 <= buffer.length; chunks += 1) {
    const length = buffer.readUInt32BE(pos);
    const end = pos + 12 + length;
    if (end > buffer.length) return 0;
    const type = buffer.subarray(pos + 4, pos + 8);
    const crc = buffer.readUInt32BE(pos + 8 + length);
    if (zlib.crc32(buffer.subarray(pos + 4, pos + 8 + length)) !== crc) return 0;
    pos = end;
    if (type.toString('latin1') === 'IEND') return pos - start;
  }
  return 0;
}

function findPng(buffer) {
  let best = null;
  const limit = Math.min(buffer.length, MAX_SCAN);
  for (let at = buffer.indexOf(PNG_SIGNATURE, 0); at !== -1 && at < limit; at = buffer.indexOf(PNG_SIGNATURE, at + 8)) {
    const length = validPng(buffer, at);
    if (length > 0 && (!best || length > best.length)) best = buffer.subarray(at, at + length);
  }
  return best ? Buffer.from(best) : null;
}

const CFB_SIGNATURE = Buffer.from('D0CF11E0A1B11AE1', 'hex');
const isCompoundFile = (buffer) => buffer.length > 512 && buffer.subarray(0, 8).equals(CFB_SIGNATURE);
const END_OF_CHAIN = 0xfffffffe;

// Just enough of the compound file format to read one named stream.
export function readCompoundStream(buffer, namePattern) {
  const sectorSize = 1 << buffer.readUInt16LE(0x1e);
  const miniSectorSize = 1 << buffer.readUInt16LE(0x20);
  if (sectorSize !== 512 && sectorSize !== 4096) return null;
  const sectorAt = (sid) => (sid + 1) * sectorSize;
  const fatSectors = [];
  for (let i = 0; i < 109; i += 1) {
    const sid = buffer.readUInt32LE(0x4c + i * 4);
    if (sid < END_OF_CHAIN) fatSectors.push(sid);
  }
  let difat = buffer.readUInt32LE(0x44);
  for (let guard = 0; difat < END_OF_CHAIN && guard < 10000; guard += 1) {
    const base = sectorAt(difat);
    if (base + sectorSize > buffer.length) break;
    for (let i = 0; i < sectorSize / 4 - 1; i += 1) {
      const sid = buffer.readUInt32LE(base + i * 4);
      if (sid < END_OF_CHAIN) fatSectors.push(sid);
    }
    difat = buffer.readUInt32LE(base + sectorSize - 4);
  }
  const fat = [];
  for (const sid of fatSectors) {
    const base = sectorAt(sid);
    if (base + sectorSize > buffer.length) return null;
    for (let i = 0; i < sectorSize / 4; i += 1) fat.push(buffer.readUInt32LE(base + i * 4));
  }
  const chain = (start, table) => {
    const out = [];
    for (let sid = start; sid < END_OF_CHAIN && out.length <= table.length; sid = table[sid]) {
      if (sid >= table.length) break;
      out.push(sid);
    }
    return out;
  };
  const readChain = (start, size) => {
    const parts = chain(start, fat).map((sid) => buffer.subarray(sectorAt(sid), sectorAt(sid) + sectorSize));
    const all = Buffer.concat(parts);
    return size == null ? all : all.subarray(0, size);
  };

  const dir = readChain(buffer.readUInt32LE(0x30));
  const entries = [];
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const nameLength = dir.readUInt16LE(off + 0x40);
    if (nameLength < 2 || nameLength > 64) continue;
    entries.push({
      name: dir.subarray(off, off + nameLength - 2).toString('utf16le'),
      type: dir[off + 0x42],
      start: dir.readUInt32LE(off + 0x74),
      size: dir.readUInt32LE(off + 0x78),
    });
  }
  const root = entries.find((e) => e.type === 5);
  const wanted = entries.find((e) => e.type === 2 && namePattern.test(e.name));
  if (!wanted || wanted.size > MAX_SCAN) return null;
  const cutoff = buffer.readUInt32LE(0x38);
  if (wanted.size >= cutoff) return readChain(wanted.start, wanted.size);

  // Small streams live in the mini stream, chained through the mini FAT.
  if (!root) return null;
  const miniStream = readChain(root.start, root.size);
  const miniFatBytes = readChain(buffer.readUInt32LE(0x3c));
  const miniFat = [];
  for (let i = 0; i + 4 <= miniFatBytes.length; i += 4) miniFat.push(miniFatBytes.readUInt32LE(i));
  const parts = chain(wanted.start, miniFat).map((sid) => miniStream.subarray(sid * miniSectorSize, (sid + 1) * miniSectorSize));
  return Buffer.concat(parts).subarray(0, wanted.size);
}

// ---------- DXF ----------
const MAX_ENTITIES = 150000;
const escapeXml = (text) => String(text).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]);
const n = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0);

// The DXF as a list of entities, each a map from group code to values, grouped by section.
function readDxf(text) {
  const lines = text.split(/\r?\n/);
  const sections = { ENTITIES: [], BLOCKS: [] };
  let section = null;
  let current = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number.parseInt(lines[i], 10);
    const value = lines[i + 1].trim();
    if (!Number.isFinite(code)) continue;
    if (code === 0) {
      if (value === 'SECTION') { section = 'pending'; current = null; continue; }
      if (value === 'ENDSEC') { section = null; current = null; continue; }
      if (section in sections) {
        current = { type: value, codes: [] };
        sections[section].push(current);
        if (sections[section].length > MAX_ENTITIES) break;
      }
      continue;
    }
    if (section === 'pending' && code === 2) { section = value; continue; }
    if (current) current.codes.push([code, value]);
  }
  return sections;
}

const first = (entity, code, fallback = 0) => {
  const hit = entity.codes.find(([c]) => c === code);
  if (!hit) return fallback;
  const v = Number.parseFloat(hit[1]);
  return Number.isFinite(v) ? v : hit[1];
};
const text = (entity, code) => entity.codes.find(([c]) => c === code)?.[1] ?? '';

// Groups block entities under their block, ending at ENDBLK.
function readBlocks(list) {
  const blocks = new Map();
  let open = null;
  for (const entity of list) {
    if (entity.type === 'BLOCK') {
      open = { base: [first(entity, 10), first(entity, 20)], entities: [] };
      blocks.set(text(entity, 2), open);
    } else if (entity.type === 'ENDBLK') {
      open = null;
    } else if (open) {
      open.entities.push(entity);
    }
  }
  return blocks;
}

export function dxfToSvg(buffer) {
  const head = buffer.subarray(0, 22).toString('latin1');
  if (head.startsWith('AutoCAD Binary DXF')) return null;
  const { ENTITIES, BLOCKS } = readDxf(buffer.toString('utf8'));
  const blocks = readBlocks(BLOCKS);
  const out = [];
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const grow = ([x, y]) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    box.minX = Math.min(box.minX, x); box.maxX = Math.max(box.maxX, x);
    box.minY = Math.min(box.minY, y); box.maxY = Math.max(box.maxY, y);
  };
  let budget = MAX_ENTITIES;

  // Draws a list of entities through a transform t: [a, b, c, d, e, f] as in SVG matrices.
  const draw = (entities, t, depth) => {
    const at = (x, y) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
    const scale = Math.sqrt(Math.abs(t[0] * t[3] - t[1] * t[2])) || 1;
    const poly = (points, closed) => {
      if (points.length < 2) return;
      const p = points.map(([x, y]) => at(x, y));
      p.forEach(grow);
      out.push(`<polyline points="${p.map(([x, y]) => `${n(x)},${n(-y)}`).join(' ')}${closed ? ` ${n(p[0][0])},${n(-p[0][1])}` : ''}"/>`);
    };
    const arcPoints = (cx, cy, r, a1, a2, rx = r, ry = r, rot = 0) => {
      let sweep = a2 - a1;
      while (sweep <= 0) sweep += Math.PI * 2;
      const steps = Math.max(8, Math.min(96, Math.ceil(sweep / (Math.PI / 24))));
      const pts = [];
      for (let i = 0; i <= steps; i += 1) {
        const a = a1 + (sweep * i) / steps;
        const x = rx * Math.cos(a);
        const y = ry * Math.sin(a);
        pts.push([cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)]);
      }
      return pts;
    };
    for (const e of entities) {
      if ((budget -= 1) < 0) return;
      switch (e.type) {
        case 'LINE':
          poly([[first(e, 10), first(e, 20)], [first(e, 11), first(e, 21)]], false);
          break;
        case 'CIRCLE':
          poly(arcPoints(first(e, 10), first(e, 20), first(e, 40), 0, Math.PI * 2), true);
          break;
        case 'ARC': {
          const rad = Math.PI / 180;
          poly(arcPoints(first(e, 10), first(e, 20), first(e, 40), first(e, 50) * rad, first(e, 51) * rad), false);
          break;
        }
        case 'ELLIPSE': {
          const mx = first(e, 11);
          const my = first(e, 21);
          const major = Math.hypot(mx, my);
          const start = first(e, 41, 0);
          let end = first(e, 42, Math.PI * 2);
          if (end <= start) end += Math.PI * 2;
          poly(arcPoints(first(e, 10), first(e, 20), major, start, end, major, major * first(e, 40, 1), Math.atan2(my, mx)), false);
          break;
        }
        case 'LWPOLYLINE': {
          const pts = [];
          let x = null;
          for (const [code, value] of e.codes) {
            if (code === 10) x = Number.parseFloat(value);
            if (code === 20 && x !== null) { pts.push([x, Number.parseFloat(value)]); x = null; }
          }
          poly(pts, (first(e, 70) & 1) === 1);
          break;
        }
        case 'SPLINE': {
          // The fit points if there are any, else the control points: close enough to recognise.
          const fit = [];
          const control = [];
          let fx = null;
          let cx = null;
          for (const [code, value] of e.codes) {
            if (code === 10) cx = Number.parseFloat(value);
            if (code === 20 && cx !== null) { control.push([cx, Number.parseFloat(value)]); cx = null; }
            if (code === 11) fx = Number.parseFloat(value);
            if (code === 21 && fx !== null) { fit.push([fx, Number.parseFloat(value)]); fx = null; }
          }
          poly(fit.length > 1 ? fit : control, false);
          break;
        }
        case 'POLYLINE':
          e.vertices = [];
          e.closed = (first(e, 70) & 1) === 1;
          draw.lastPolyline = e;
          break;
        case 'VERTEX':
          draw.lastPolyline?.vertices.push([first(e, 10), first(e, 20)]);
          break;
        case 'SEQEND':
          if (draw.lastPolyline) poly(draw.lastPolyline.vertices, draw.lastPolyline.closed);
          draw.lastPolyline = null;
          break;
        case 'TEXT':
        case 'MTEXT': {
          const raw = e.type === 'MTEXT'
            ? e.codes.filter(([c]) => c === 3 || c === 1).map(([, v]) => v).join('')
            : text(e, 1);
          const clean = raw.replace(/\\[A-Za-z][^;\\]*;/g, '').replace(/\\P/g, ' ').replace(/[{}]/g, '').replace(/%%[cCdDpP]/g, '').slice(0, 200);
          if (!clean.trim()) break;
          const [x, y] = at(first(e, 10), first(e, 20));
          const height = first(e, 40, 2.5) * scale;
          grow([x, y]);
          grow([x + clean.length * height * 0.6, y + height]);
          const angle = -(first(e, 50, 0) + (Math.atan2(t[1], t[0]) * 180) / Math.PI);
          out.push(`<text x="${n(x)}" y="${n(-y)}" font-size="${n(height)}"${angle ? ` transform="rotate(${n(angle)} ${n(x)} ${n(-y)})"` : ''}>${escapeXml(clean)}</text>`);
          break;
        }
        case 'INSERT':
        case 'DIMENSION': {
          if (depth > 6) break;
          const block = blocks.get(text(e, 2));
          if (!block) break;
          const isDim = e.type === 'DIMENSION';
          const sx = isDim ? 1 : first(e, 41, 1);
          const sy = isDim ? 1 : first(e, 42, 1);
          const rot = isDim ? 0 : (first(e, 50, 0) * Math.PI) / 180;
          const px = isDim ? 0 : first(e, 10);
          const py = isDim ? 0 : first(e, 20);
          // Insert: move the block base to the origin, scale, rotate, place, then apply t.
          const cos = Math.cos(rot);
          const sin = Math.sin(rot);
          const local = [sx * cos, sx * sin, -sy * sin, sy * cos, 0, 0];
          local[4] = px - (local[0] * block.base[0] + local[2] * block.base[1]);
          local[5] = py - (local[1] * block.base[0] + local[3] * block.base[1]);
          const combined = [
            t[0] * local[0] + t[2] * local[1], t[1] * local[0] + t[3] * local[1],
            t[0] * local[2] + t[2] * local[3], t[1] * local[2] + t[3] * local[3],
            t[0] * local[4] + t[2] * local[5] + t[4], t[1] * local[4] + t[3] * local[5] + t[5],
          ];
          draw(block.entities, combined, depth + 1);
          break;
        }
        default:
          break;
      }
    }
  };
  draw(ENTITIES, [1, 0, 0, 1, 0, 0], 0);
  if (out.length === 0 || !Number.isFinite(box.minX)) return null;
  const width = Math.max(box.maxX - box.minX, 1e-6);
  const height = Math.max(box.maxY - box.minY, 1e-6);
  const pad = Math.max(width, height) * 0.03;
  const viewBox = [box.minX - pad, -box.maxY - pad, width + pad * 2, height + pad * 2].map(n).join(' ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet">`
    + `<rect x="${n(box.minX - pad)}" y="${n(-box.maxY - pad)}" width="${n(width + pad * 2)}" height="${n(height + pad * 2)}" fill="#fff"/>`
    + '<style>polyline{vector-effect:non-scaling-stroke}</style>'
    + '<g fill="none" stroke="#1d2433" stroke-width="1" stroke-linejoin="round">'
    + out.filter((s) => !s.startsWith('<text')).join('')
    + '</g><g fill="#1d2433" font-family="Arial, sans-serif">'
    + out.filter((s) => s.startsWith('<text')).join('')
    + '</g></svg>';
  return { type: 'image/svg+xml', data: Buffer.from(svg) };
}
