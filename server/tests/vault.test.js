// The drawing vault: pictures from CAD files, versions, check-out, release, folders read by
// themselves, and the sync program on a designer's PC.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { call, ok, refused, startApi, stopApi, users } from './helpers/http.js';
import { dwgThumbnail, dxfToSvg, solidworksPreview } from '../services/cadPreview.js';
import { nextRevision, vaultPathOf } from '../services/vaultService.js';
import { VaultFile } from '../models/vault.js';

const refs = {};
let tmp;

// A real, tiny PNG, optionally padded with a text chunk to make it larger.
function png(padding = 0) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from('89504E470D0A1A0A', 'hex'), chunk('IHDR', ihdr),
    ...(padding ? [chunk('tEXt', Buffer.alloc(padding, 0x41))] : []),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0]))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dxf = (extra = '') => Buffer.from([
  '0', 'SECTION', '2', 'BLOCKS',
  '0', 'BLOCK', '2', 'BOLT', '10', '0', '20', '0',
  '0', 'CIRCLE', '10', '0', '20', '0', '40', '2',
  '0', 'ENDBLK',
  '0', 'ENDSEC',
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'LINE', '10', '0', '20', '0', '11', '100', '21', '50',
  '0', 'ARC', '10', '50', '20', '25', '40', '10', '50', '0', '51', '180',
  '0', 'LWPOLYLINE', '90', '3', '70', '1', '10', '0', '20', '0', '10', '20', '20', '0', '10', '20', '20', '10',
  '0', 'TEXT', '10', '5', '20', '40', '40', '3', '1', `FILLER <PLATE> ${extra}`,
  '0', 'INSERT', '2', 'BOLT', '10', '80', '20', '10', '41', '2', '42', '2',
  '0', 'ENDSEC', '0', 'EOF', '',
].join('\r\n'));

// Push like git: a message first, then each file with the version it was changed from.
async function push(role, filePath, body, base, extra = '') {
  const { pushId } = await ok(role, 'POST', '/vault/pushes', { message: `Test push of ${filePath}` });
  return call(role, 'POST', `/vault/push?pushId=${pushId}&path=${encodeURIComponent(filePath)}${base === undefined ? '' : `&base=${base}`}${extra}`, body);
}
async function pushed(role, filePath, body, base, extra) {
  const res = await push(role, filePath, body, base, extra);
  assert.ok(res.status < 300, `push ${filePath} -> ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
}

before(async () => {
  await startApi();
  // The maintainer's rules: engineering pushes everywhere, the office and the floor pull.
  await ok('ADMIN', 'POST', '/vault/rules', { role: 'ENGINEERING', level: 'PUSH' });
  await ok('ADMIN', 'POST', '/vault/rules', { role: 'MANAGEMENT', level: 'PULL' });
  await ok('ADMIN', 'POST', '/vault/rules', { role: 'SALES', folder: 'Projects', level: 'PULL' });
  await ok('ADMIN', 'POST', '/vault/rules', { role: 'PRODUCTION', folder: 'Projects', level: 'PULL' });
  refs.item = await ok('ADMIN', 'POST', '/items', { code: 'FM60-0012', name: 'Filler plate', type: 'RAW', hsn: '7219', gstRateBps: 1800, drawingNo: 'FM60-0012' });
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-vault-'));
});
after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
  await stopApi();
});

test('file paths: kept inside the vault, CAD types only, temporary files refused', () => {
  assert.equal(vaultPathOf('Projects\\FM-60\\FM60-0012.SLDPRT').path, 'Projects/FM-60/FM60-0012.SLDPRT');
  assert.equal(vaultPathOf('a/b.SLDPRT').kind, 'PART');
  assert.equal(vaultPathOf('a/b.dwg').number, 'b');
  assert.throws(() => vaultPathOf('../etc/passwd.dwg'), /up a folder/);
  assert.throws(() => vaultPathOf('a/run.exe'), /not kept/);
  assert.throws(() => vaultPathOf('a/~$FM60.SLDPRT'), /temporary/);
  assert.deepEqual(['', 'A', 'H', 'Z'].map(nextRevision), ['A', 'B', 'J', 'AA']);
});

test('pictures: DXF drawn as SVG, text escaped, blocks placed', () => {
  const svg = dxfToSvg(dxf()).data.toString();
  assert.match(svg, /^<svg /);
  assert.match(svg, /FILLER &lt;PLATE&gt;/);
  assert.ok(!svg.includes('<PLATE>'));
  assert.ok((svg.match(/<polyline/g) ?? []).length >= 4, 'line, arc, polyline and the inserted circle');
  // The inserted circle sits at 80,10 with radius 4, so the drawing reaches x = 84.
  const [minX, , width] = svg.match(/viewBox="([^"]+)"/)[1].split(' ').map(Number);
  assert.ok(minX + width >= 84);
});

test('pictures: the thumbnail inside a DWG, as PNG or as a bitmap', () => {
  const picture = png();
  const make = (code, data) => {
    const head = Buffer.alloc(0x20);
    head.write('AC1027', 0, 'latin1');
    const seeker = 0x20;
    head.writeUInt32LE(seeker, 0x0d);
    const table = Buffer.alloc(21 + 9);
    Buffer.from('1F256D07D43628289D57CA3F9D44102B', 'hex').copy(table, 0);
    table[20] = 1;
    table[21] = code;
    table.writeUInt32LE(seeker + table.length, 22);
    table.writeUInt32LE(data.length, 26);
    return Buffer.concat([head, table, data]);
  };
  const fromPng = dwgThumbnail(make(6, picture));
  assert.equal(fromPng.type, 'image/png');
  assert.ok(fromPng.data.equals(picture));
  const dib = Buffer.alloc(40 + 4); dib.writeUInt32LE(40, 0); dib.writeInt32LE(1, 4); dib.writeInt32LE(1, 8); dib.writeUInt16LE(1, 12); dib.writeUInt16LE(24, 14);
  const fromBmp = dwgThumbnail(make(2, dib));
  assert.equal(fromBmp.type, 'image/bmp');
  assert.equal(fromBmp.data.toString('latin1', 0, 2), 'BM');
  assert.equal(fromBmp.data.readUInt32LE(10), 54);
  assert.equal(dwgThumbnail(Buffer.from('AC1009 an old drawing with no picture')), null);
});

test('pictures: the SOLIDWORKS preview, from a compound file even when split across sectors', () => {
  const picture = png(5000); // over 4096 bytes, so it lives in normal sectors
  const sectors = Math.ceil(picture.length / 512);
  // Sector 0 is the FAT, 1 the directory, then the picture's sectors in shuffled order.
  const order = Array.from({ length: sectors }, (_, i) => i).reverse(); // chunk i goes in sector order[i] + 2
  const data = Buffer.alloc(sectors * 512);
  order.forEach((slot, i) => picture.copy(data, slot * 512, i * 512, Math.min((i + 1) * 512, picture.length)));
  const fat = Buffer.alloc(512, 0xff);
  fat.writeUInt32LE(0xfffffffd, 0);
  fat.writeUInt32LE(0xfffffffe, 4);
  order.forEach((slot, i) => fat.writeUInt32LE(i + 1 < sectors ? order[i + 1] + 2 : 0xfffffffe, (slot + 2) * 4));
  const dir = Buffer.alloc(512);
  const entry = (at, name, type, start, size) => {
    dir.write(name, at, 'utf16le');
    dir.writeUInt16LE((name.length + 1) * 2, at + 0x40);
    dir[at + 0x42] = type;
    dir.writeUInt32LE(start, at + 0x74);
    dir.writeUInt32LE(size, at + 0x78);
  };
  entry(0, 'Root Entry', 5, 0xfffffffe, 0);
  entry(128, 'PreviewPNG', 2, order[0] + 2, picture.length);
  const header = Buffer.alloc(512, 0);
  Buffer.from('D0CF11E0A1B11AE1', 'hex').copy(header, 0);
  header.writeUInt16LE(0x3e, 0x18); header.writeUInt16LE(3, 0x1a); header.writeUInt16LE(0xfffe, 0x1c);
  header.writeUInt16LE(9, 0x1e); header.writeUInt16LE(6, 0x20);
  header.writeUInt32LE(1, 0x2c); header.writeUInt32LE(1, 0x30); header.writeUInt32LE(4096, 0x38);
  header.writeUInt32LE(0xfffffffe, 0x3c); header.writeUInt32LE(0xfffffffe, 0x44);
  for (let i = 0; i < 109; i += 1) header.writeUInt32LE(i === 0 ? 0 : 0xffffffff, 0x4c + i * 4);
  const file = Buffer.concat([header, fat, dir, data]);
  const found = solidworksPreview(file);
  assert.ok(found?.data.equals(picture), 'read through the sector chain');
  // A newer file: the PNG is found by its signature, and a broken one is not accepted.
  assert.ok(solidworksPreview(Buffer.concat([Buffer.alloc(300, 7), picture, Buffer.alloc(50)])).data.equals(picture));
  const broken = Buffer.from(picture); broken[40] ^= 0xff;
  assert.equal(solidworksPreview(Buffer.concat([Buffer.alloc(300, 7), broken])), null);
});

test('push: versions only when the bytes change, a picture, linked to the item, and never over someone else', async () => {
  const first = await pushed('ENGINEERING', 'Projects/FM-60/FM60-0012.dxf', dxf('v1'));
  assert.equal(first.status, 'ADDED');
  assert.equal(first.file.version, 1);
  assert.equal(first.file.kind, 'DXF');
  assert.equal(first.file.hasPreview, true);
  assert.equal(first.file.itemCode, 'FM60-0012');
  refs.dxf = first.file.id;
  assert.equal((await pushed('ENGINEERING', 'projects/fm-60/FM60-0012.DXF', dxf('v1'), 1)).status, 'UNCHANGED');
  const second = await pushed('ENGINEERING', 'Projects/FM-60/FM60-0012.dxf', dxf('v2'), 1);
  assert.equal(second.status, 'CHANGED');
  assert.equal(second.file.version, 2);
  // Someone who pulled version 1 cannot push over version 2: pull first.
  const behind = await push('ENGINEERING', 'Projects/FM-60/FM60-0012.dxf', dxf('stale'), 1);
  assert.equal(behind.status, 409);
  assert.equal(behind.body.error.code, 'BEHIND');
  assert.match(behind.body.error.message, /Pull it first/);
  const noBase = await push('ENGINEERING', 'Projects/FM-60/FM60-0012.dxf', dxf('x'));
  assert.equal(noBase.status, 400);
  assert.match(noBase.body.error.message, /Pull it first/);

  const picture = await call('SALES', 'GET', `/vault/files/${refs.dxf}/preview`);
  assert.equal(picture.status, 200);
  assert.equal(picture.headers.get('content-type'), 'image/svg+xml');
  assert.match(picture.headers.get('content-security-policy'), /sandbox/);
  const old = await call('SALES', 'GET', `/vault/files/${refs.dxf}/download?version=1`);
  assert.ok(old.body.equals(dxf('v1')), 'the first version is still there, unchanged');
  assert.match(old.headers.get('content-disposition'), /^attachment/);
  assert.equal(old.headers.get('x-forge-version'), '1');

  assert.equal((await ok('PRODUCTION', 'GET', '/vault/files?q=fm60')).total, 1);
  const pushes = await ok('PRODUCTION', 'GET', '/vault/pushes');
  assert.ok(pushes.some((p) => p.files.some((f) => f.version === 2)), 'push history, like commits');
  assert.equal((await call('SALES', 'POST', '/vault/pushes', { message: 'x' })).status, 403, 'sales has no push permission');
  assert.equal((await push('ENGINEERING', 'x.exe', Buffer.from('MZ'))).status, 400);
  assert.equal((await push('ENGINEERING', 'empty.dxf', Buffer.alloc(0))).status, 400);
});

test('access: the maintainer decides who pulls and who pushes, and tasks open push for a while', async () => {
  // No rule, no files.
  assert.equal((await ok('PURCHASE', 'GET', '/vault/files')).total, 0);
  assert.equal((await call('PURCHASE', 'GET', `/vault/files/${refs.dxf}`)).status, 404);
  assert.equal((await call('PURCHASE', 'GET', `/vault/files/${refs.dxf}/download`)).status, 404);
  const rule = await ok('ADMIN', 'POST', '/vault/rules', { userId: users.PURCHASE.id, folder: 'Projects/FM-60', level: 'PULL' });
  assert.equal((await ok('PURCHASE', 'GET', '/vault/files')).total, 1);
  await ok('ADMIN', 'DELETE', `/vault/rules/${rule.id}`);
  assert.equal((await ok('PURCHASE', 'GET', '/vault/files')).total, 0);
  assert.equal((await call('ENGINEERING', 'POST', '/vault/rules', { role: 'SALES', level: 'PUSH' })).status, 403, 'only the maintainer makes rules');

  // Management may pull everything but push nothing, until given a task.
  const refusedPush = await push('MANAGEMENT', 'Projects/FM-60/FM60-0012.dxf', dxf('md'), 2);
  assert.equal(refusedPush.status, 403);
  assert.match(refusedPush.body.error.message, /not push/);
  const task = await ok('ADMIN', 'POST', '/vault/tasks', { title: 'Mark up the filler plate', assigneeId: users.MANAGEMENT.id, paths: ['Projects/FM-60'], dueDate: '2026-12-01' });
  assert.equal((await pushed('MANAGEMENT', 'Projects/FM-60/FM60-0012.dxf', dxf('md'), 2)).file.version, 3);
  assert.equal((await push('MANAGEMENT', 'Other/elsewhere.dxf', dxf('no'))).status, 403, 'only where the task says');
  assert.equal((await ok('MANAGEMENT', 'GET', '/vault/tasks')).length, 1);
  await ok('MANAGEMENT', 'PATCH', `/vault/tasks/${task.id}`, { status: 'SUBMITTED', answer: 'Done' });
  assert.equal((await push('MANAGEMENT', 'Projects/FM-60/FM60-0012.dxf', dxf('md again'), 3)).status, 403, 'handing in ends the push right');
  assert.equal((await call('MANAGEMENT', 'PATCH', `/vault/tasks/${task.id}`, { status: 'DONE' })).status, 403);
  await ok('ADMIN', 'PATCH', `/vault/tasks/${task.id}`, { status: 'DONE' });
});

test('lock: one person at a time, unlocked by pushing', async () => {
  await ok('ENGINEERING', 'POST', `/vault/files/${refs.dxf}/lock`);
  await refused('ADMIN', 'POST', `/vault/files/${refs.dxf}/lock`, undefined, 'CHECKED_OUT', 409);
  const blocked = await push('ADMIN', 'Projects/FM-60/FM60-0012.dxf', dxf('admin'), 3);
  assert.equal(blocked.body.error.code, 'CHECKED_OUT');
  const done = await pushed('ENGINEERING', 'Projects/FM-60/FM60-0012.dxf', dxf('chamfer'), 3, '&unlock=true');
  assert.equal(done.file.version, 4);
  assert.equal(done.file.checkedOut.byId, null);
  await refused('PRODUCTION', 'POST', `/vault/files/${refs.dxf}/lock`, undefined, 'FORBIDDEN', 403);
});

test('release: review first, revision letters, the item follows, a released file cannot change', async () => {
  await refused('ENGINEERING', 'POST', `/vault/files/${refs.dxf}/release`, {}, 'BUSINESS_RULE_VIOLATED', 422);
  await ok('ENGINEERING', 'POST', `/vault/files/${refs.dxf}/submit`, { note: 'Ready' });
  await refused('ENGINEERING', 'POST', `/vault/files/${refs.dxf}/reject`, {}, 'VALIDATION_FAILED', 400);
  await refused('SALES', 'POST', `/vault/files/${refs.dxf}/release`, {}, 'FORBIDDEN', 403);
  const released = await ok('MANAGEMENT', 'POST', `/vault/files/${refs.dxf}/release`, { note: 'For FM-60 build' });
  assert.equal(released.state, 'RELEASED');
  assert.equal(released.revision, 'A');
  assert.equal((await ok('ADMIN', 'GET', `/items/${refs.item.id}`)).drawingRev, 'A');

  const blocked = await push('ENGINEERING', 'Projects/FM-60/FM60-0012.dxf', dxf('sneaky'), 4);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'RELEASED');
  await refused('ENGINEERING', 'POST', `/vault/files/${refs.dxf}/lock`, undefined, 'BUSINESS_RULE_VIOLATED', 422);

  await ok('ENGINEERING', 'POST', `/vault/files/${refs.dxf}/new-revision`, { note: 'ECN-7' });
  assert.equal((await pushed('ENGINEERING', 'Projects/FM-60/FM60-0012.dxf', dxf('rev b'), 4)).file.version, 5);
  await ok('ENGINEERING', 'POST', `/vault/files/${refs.dxf}/submit`, {});
  assert.equal((await ok('ENGINEERING', 'POST', `/vault/files/${refs.dxf}/release`, {})).revision, 'B');
  const detail = await ok('SALES', 'GET', `/vault/files/${refs.dxf}`);
  assert.equal(detail.level, 'PULL');
  assert.equal(detail.versions[0].revision, 'B');
  assert.equal(detail.versions.find((v) => v.version === 4).revision, 'A');
});

test('watched folder: picked up by itself, unchanged files skipped, released files locked on disk', async () => {
  const dir = path.join(tmp, 'share');
  await fs.mkdir(path.join(dir, 'FM-60', 'Frame'), { recursive: true });
  const part = path.join(dir, 'FM-60', 'Frame', 'FM60-0100.SLDPRT');
  const old = new Date(Date.now() - 60000);
  await fs.writeFile(part, Buffer.concat([Buffer.alloc(100, 1), png()]));
  await fs.writeFile(path.join(dir, 'FM-60', '~$FM60-0100.SLDPRT'), 'lock');
  await fs.writeFile(path.join(dir, 'FM-60', 'notes.exe'), 'skip');
  for (const f of [part]) await fs.utimes(f, old, old);

  await refused('ENGINEERING', 'POST', '/vault/watches', { name: 'x', dir }, 'FORBIDDEN', 403);
  await refused('ADMIN', 'POST', '/vault/watches', { name: 'Gone', dir: path.join(tmp, 'nope') }, 'VALIDATION_FAILED', 400);
  const watch = await ok('ADMIN', 'POST', '/vault/watches', { name: 'Design share', dir, vaultFolder: 'Projects' });
  let scan = await ok('ADMIN', 'POST', `/vault/watches/${watch.id}/scan`);
  assert.equal(scan.added, 1, JSON.stringify(scan));
  const file = await VaultFile.findOne({ pathKey: 'projects/fm-60/frame/fm60-0100.sldprt' }).lean();
  assert.ok(file, 'kept under the vault folder');
  assert.equal(file.kind, 'PART');
  assert.equal(file.hasPreview, true);
  scan = await ok('ADMIN', 'POST', `/vault/watches/${watch.id}/scan`);
  assert.equal(scan.unchanged, 1);
  assert.equal(scan.added + scan.changed, 0);

  // A file still being saved waits for the next scan.
  await fs.writeFile(part, Buffer.concat([Buffer.alloc(200, 2), png()]));
  scan = await ok('ADMIN', 'POST', `/vault/watches/${watch.id}/scan`);
  assert.equal(scan.changed, 0);
  assert.equal(scan.complete, false);
  await fs.utimes(part, old, old);
  scan = await ok('ADMIN', 'POST', `/vault/watches/${watch.id}/scan`);
  assert.equal(scan.changed, 1);

  const id = String(file._id);
  await ok('ENGINEERING', 'POST', `/vault/files/${id}/submit`, {});
  await ok('ENGINEERING', 'POST', `/vault/files/${id}/release`, {});
  assert.equal((await fs.stat(part)).mode & 0o222, 0, 'read-only on disk once released');
  await ok('ENGINEERING', 'POST', `/vault/files/${id}/new-revision`, {});
  assert.notEqual((await fs.stat(part)).mode & 0o200, 0, 'writable again for the new revision');

  await fs.rm(part);
  await ok('ADMIN', 'POST', `/vault/watches/${watch.id}/scan`);
  assert.equal((await VaultFile.findById(id).lean()).missingOnDisk, true);
  assert.equal((await VaultFile.findById(id).lean()).version, 2, 'nothing is lost from the vault');
});

test('designer PC: pulls and pushes as its person, with that person\'s access', async () => {
  assert.equal((await call('ADMIN', 'POST', '/vault/agents', { name: 'Nobody PC', pcFolder: 'C:\\Forge Vault', serverUrl: 'http://forge.local:4100' })).status, 400, 'a PC needs a person');
  const make = async (name, user) => {
    const made = await ok('ADMIN', 'POST', '/vault/agents', { name, userId: user.id, pcFolder: 'C:\\Forge Vault', serverUrl: 'http://forge.local:4100' });
    assert.ok(!/__[A-Z_]+__/.test(made.script), 'every blank in the template is filled');
    assert.match(made.script, /\$IconB64 {2}= 'AAABAA/, 'the folder icon is inside');
    refs[`agent-${name}`] = made.agent.id;
    return made.script.match(/\$AgentKey = '(fva_[^']+)'/)[1];
  };
  const pc = await make('Design PC', users.ENGINEERING);
  const salesPc = await make('Sales PC', users.SALES);
  const as = (key) => ({ 'x-forge-agent-key': key });
  const pcPush = async (key, rel, body, base, extra = '') => {
    const start = await call(null, 'POST', '/vault-agent/pushes', { message: `From PC: ${rel}` }, as(key));
    if (start.status >= 300) return start;
    return call(null, 'POST', `/vault-agent/push?pushId=${start.body.data.pushId}&path=${encodeURIComponent(rel)}${base === undefined ? '' : `&base=${base}`}${extra}`, body, as(key));
  };

  const mine = (await call(null, 'GET', '/vault-agent/manifest', undefined, as(pc))).body.data.files;
  const plate = mine.find((f) => f.path === 'Projects/FM-60/FM60-0012.dxf');
  assert.equal(plate.level, 'PUSH');
  const theirs = (await call(null, 'GET', '/vault-agent/manifest', undefined, as(salesPc))).body.data.files;
  assert.ok(theirs.every((f) => f.path.startsWith('Projects/')), 'sales pulls only Projects');
  assert.equal(theirs.find((f) => f.id === plate.id).level, 'PULL');
  const down = await call(null, 'GET', `/vault-agent/files/${plate.id}/download`, undefined, as(salesPc));
  assert.equal(down.headers.get('x-forge-sha256'), plate.sha256);

  const sent = await pcPush(pc, 'Shared/BRK-01.dxf', dxf('bracket'));
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.data.status, 'ADDED');
  const id = sent.body.data.id;
  assert.equal((await ok('ADMIN', 'GET', `/vault/files/${id}`)).file.lastChangedBy, users.ENGINEERING.name, 'pushed as the person, not the PC');
  assert.equal((await call(null, 'GET', `/vault-agent/files/${id}/download`, undefined, as(salesPc))).status, 404, 'outside what sales may pull');
  assert.equal((await pcPush(salesPc, 'Projects/x.dxf', dxf('s'))).status, 403, 'sales cannot push');
  const locked = await call(null, 'POST', `/vault-agent/files/${id}/lock`, {}, as(pc));
  assert.equal(locked.body.data.checkedOutBy, users.ENGINEERING.name);
  assert.equal((await call(null, 'GET', '/vault-agent/status?path=Shared/BRK-01.dxf', undefined, as(pc))).body.data.mine, true);
  assert.equal((await pcPush(pc, 'Shared/BRK-01.dxf', dxf('bracket v2'), 0)).body.error.code, 'BEHIND');
  const v2 = await pcPush(pc, 'Shared/BRK-01.dxf', dxf('bracket v2'), 1, '&unlock=true');
  assert.equal(v2.body.data.version, 2);
  assert.equal((await call(null, 'GET', '/vault-agent/status?path=Shared/BRK-01.dxf', undefined, as(pc))).body.data.mine, false);

  assert.equal((await call(null, 'GET', '/vault-agent/manifest', undefined, as('fva_wrong'))).status, 401);
  assert.equal((await call(null, 'GET', '/vault/files', undefined, as(pc))).status, 401, 'the PC key is not a sign-in');
  await ok('ADMIN', 'PATCH', `/vault/agents/${refs['agent-Sales PC']}`, { isActive: false });
  assert.equal((await call(null, 'GET', '/vault-agent/manifest', undefined, as(salesPc))).status, 401, 'a switched-off PC is refused');
});

test('summary, folders and the PC kit', async () => {
  const summary = await ok('ENGINEERING', 'GET', '/vault/summary');
  assert.ok(summary.total >= 3);
  assert.ok(summary.states.RELEASED >= 1);
  assert.equal((await ok('SALES', 'GET', '/vault/folders')).every((f) => f.folder.startsWith('Projects')), true);
  const kit = await call('PRODUCTION', 'GET', '/vault/pc-kit');
  assert.equal(kit.status, 200);
  assert.equal(kit.body.subarray(0, 2).toString(), 'PK');
});
