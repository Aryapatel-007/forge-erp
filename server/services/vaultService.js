// The drawing vault. Files come in three ways, all ending in ingest():
//
//   WATCH   the server reads folders it has been told about, every minute
//   AGENT   the sync script on a designer's PC sends what was saved
//   UPLOAD  someone picks a file in the browser
//
// A file whose bytes have not changed makes no new version. A released file cannot change:
// a new copy of it is turned away and noted, until someone starts a new revision. Files are
// never deleted from the vault, only marked obsolete.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import mongoose from 'mongoose';
import { VaultAgent, VaultFile, VaultPush, VaultRule, VaultTask, VaultVersion, VaultWatch } from '../models/vault.js';
import { Item } from '../models/masters.js';
import { User } from '../models/core.js';
import { Bom } from '../models/documents.js';
import { auditNow } from './auditService.js';
import { makePreview } from './cadPreview.js';
import { AppError, badRequest, conflict, forbidden, notFound, rule } from '../utils/errors.js';

export const MAX_FILE_BYTES = 500 * 1024 * 1024;
const PREVIEW_READ_LIMIT = 80 * 1024 * 1024; // bigger files keep no picture
const SETTLE_MS = 5000; // a file changed in the last few seconds may still be saving
const SCAN_FILE_LIMIT = 20000;
const SCAN_INGEST_LIMIT = 300; // the rest wait for the next minute

export const EXTENSIONS = {
  sldprt: 'PART', prt: 'PART', ipt: 'PART',
  sldasm: 'ASSEMBLY', asm: 'ASSEMBLY', iam: 'ASSEMBLY',
  slddrw: 'DRAWING', drw: 'DRAWING', idw: 'DRAWING',
  dwg: 'DWG', dxf: 'DXF', pdf: 'PDF',
  step: 'MODEL', stp: 'MODEL', igs: 'MODEL', iges: 'MODEL', x_t: 'MODEL', x_b: 'MODEL', stl: 'MODEL', sat: 'MODEL',
  edrw: 'MODEL', eprt: 'MODEL', easm: 'MODEL',
  png: 'IMAGE', jpg: 'IMAGE', jpeg: 'IMAGE', webp: 'IMAGE',
  xlsx: 'OTHER', docx: 'OTHER', csv: 'OTHER', txt: 'OTHER', zip: 'OTHER',
};

// Temporary and lock files that CAD programs leave next to the real ones.
const isScratch = (name) => name.startsWith('~$') || name.startsWith('.') || name.startsWith('~')
  || /\.(bak|sv\$|dwl2?|tmp|swp|ac\$|lck)$/i.test(name);

export function vaultPathOf(raw) {
  const parts = String(raw ?? '').replace(/\\/g, '/').split('/')
    .map((part) => part.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim())
    .filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..')) throw badRequest('A file path cannot go up a folder.');
  if (parts.length === 0) throw badRequest('Give the file a name.');
  const full = parts.join('/');
  if (full.length > 400) throw badRequest('That file path is too long.');
  const name = parts[parts.length - 1];
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const kind = EXTENSIONS[ext];
  if (!kind) throw badRequest(`Files of type .${ext || '(none)'} are not kept in the vault.`);
  if (isScratch(name)) throw badRequest('That is a temporary file.');
  return { path: full, pathKey: full.toLowerCase(), folder: parts.slice(0, -1).join('/'), name, ext, kind, number: name.slice(0, dot) };
}

export const joinVault = (...parts) => parts.filter(Boolean).join('/').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');

const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'vault' });

// Streams into GridFS while hashing. Keeps the bytes in memory only when small enough to
// make a picture from.
async function store(readable, filename) {
  const hash = createHash('sha256');
  const kept = [];
  let size = 0;
  let keep = true;
  const upload = bucket().openUploadStream(filename);
  const meter = new Transform({
    transform(chunk, _enc, done) {
      size += chunk.length;
      if (size > MAX_FILE_BYTES) return done(new AppError(413, 'TOO_LARGE', 'Files over 500 MB are not kept in the vault.'));
      hash.update(chunk);
      if (keep) {
        if (size <= PREVIEW_READ_LIMIT) kept.push(chunk);
        else { keep = false; kept.length = 0; }
      }
      return done(null, chunk);
    },
  });
  try {
    await pipeline(readable, meter, upload);
  } catch (error) {
    await bucket().delete(upload.id).catch(() => {});
    throw error;
  }
  if (size === 0) {
    await bucket().delete(upload.id).catch(() => {});
    throw badRequest('That file is empty.');
  }
  return { gridId: upload.id, sizeBytes: size, sha256: hash.digest('hex'), bytes: keep ? Buffer.concat(kept) : null };
}

const forget = (gridId) => bucket().delete(gridId).catch(() => {});

async function storePreview(ext, bytes, name) {
  const preview = bytes ? makePreview(ext, bytes) : null;
  if (!preview) return { previewGridId: null, previewType: '' };
  const upload = bucket().openUploadStream(`preview-${name}`);
  await pipeline(Readable.from(preview.data), upload);
  return { previewGridId: upload.id, previewType: preview.type };
}

async function linkedItem(number) {
  const exact = new RegExp(`^${number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  return Item.findOne({ $or: [{ drawingNo: exact }, { code: exact }] }, { _id: 1, code: 1 }).lean();
}

const who = (user) => ({ byId: user?.id ?? null, byName: user?.name ?? '' });
const entry = (action, user, note = '') => ({ at: new Date(), action, ...who(user), note });

/**
 * Brings one file into the vault.
 * @returns {{status: 'ADDED'|'CHANGED'|'UNCHANGED'|'BLOCKED', file}}
 */
export async function ingest({ vaultPath, readable, source, user, note = '', disk = null }) {
  const where = vaultPathOf(vaultPath);
  const existing = await VaultFile.findOne({ pathKey: where.pathKey });
  // A person (in the browser, or through their PC) cannot save over someone else's check-out.
  // A watched folder has no person behind it, so it is not held to this.
  if (existing && source !== 'WATCH' && user?.id && existing.checkedOut?.byId && String(existing.checkedOut.byId) !== String(user.id)) {
    readable.resume?.();
    throw conflict(`${existing.checkedOut.byName} has this file checked out.`, 'CHECKED_OUT');
  }
  const saved = await store(readable, where.name);
  const diskFields = disk ? { watchId: disk.watchId ?? null, diskPath: disk.diskPath ?? '', diskSize: disk.size, diskMtimeMs: disk.mtimeMs, missingOnDisk: false } : {};

  if (existing && existing.sha256 === saved.sha256) {
    await forget(saved.gridId);
    if (disk) await VaultFile.updateOne({ _id: existing._id }, { $set: diskFields });
    return { status: 'UNCHANGED', file: existing };
  }
  if (existing && existing.state !== 'WIP') {
    await forget(saved.gridId);
    const blockedChange = { at: new Date(), source, byName: user?.name ?? '', sha256: saved.sha256 };
    const repeat = existing.blockedChange?.sha256 === saved.sha256;
    await VaultFile.updateOne({ _id: existing._id }, {
      $set: { ...diskFields, blockedChange },
      ...(repeat ? {} : { $push: { history: entry('Change turned away', user, `The file is ${existing.state.toLowerCase()}. Start a new revision to change it.`) } }),
    });
    return { status: 'BLOCKED', file: existing };
  }

  const version = (existing?.version ?? 0) + 1;
  const item = await linkedItem(where.number);
  const previews = await storePreview(where.ext, saved.bytes, where.name);
  const fileId = existing?._id ?? new mongoose.Types.ObjectId();
  let created;
  try {
    created = await VaultVersion.create({
      fileId, version, revision: existing?.revision ?? '', gridId: saved.gridId, sizeBytes: saved.sizeBytes, sha256: saved.sha256,
      source, ...who(user), note, diskMtimeMs: disk?.mtimeMs ?? null, ...previews,
    });
  } catch (error) {
    await forget(saved.gridId);
    if (previews.previewGridId) await forget(previews.previewGridId);
    if (error?.code === 11000) throw conflict('Someone saved this file at the same moment. Try again.', 'BUSY');
    throw error;
  }
  const fields = {
    path: where.path, folder: where.folder, name: where.name, ext: where.ext, kind: where.kind, number: where.number,
    version, latestVersionId: created._id, sizeBytes: saved.sizeBytes, sha256: saved.sha256, hasPreview: Boolean(previews.previewGridId),
    itemId: item?._id ?? null, itemCode: item?.code ?? '', lastChangedAt: new Date(), lastChangedBy: user?.name ?? '', ...diskFields,
  };
  const action = existing ? `Version ${version} saved` : 'Added to the vault';
  const how = { WATCH: 'picked up from a watched folder', AGENT: `sent by ${user?.name ?? 'a PC'}`, UPLOAD: 'uploaded' }[source];
  const file = await VaultFile.findOneAndUpdate(
    { pathKey: where.pathKey },
    { $set: fields, $setOnInsert: { _id: fileId, pathKey: where.pathKey }, $push: { history: entry(action, user, note || how) } },
    { upsert: true, new: true },
  );
  return { status: existing ? 'CHANGED' : 'ADDED', file };
}

// ---------- Revisions and states ----------
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // I and O are skipped: they read as 1 and 0

export function nextRevision(current) {
  if (!current) return 'A';
  const digits = [...current].map((c) => LETTERS.indexOf(c));
  if (digits.some((d) => d < 0)) return 'A';
  let i = digits.length - 1;
  while (i >= 0 && digits[i] === LETTERS.length - 1) { digits[i] = 0; i -= 1; }
  if (i < 0) digits.unshift(0); else digits[i] += 1;
  return digits.map((d) => LETTERS[d]).join('');
}

async function load(id) {
  if (!mongoose.isValidObjectId(id)) throw badRequest('That id is not valid.');
  const file = await VaultFile.findById(id);
  if (!file) throw notFound('File');
  return file;
}

// On disk, a released file is made read-only so it cannot be saved over by mistake.
async function setDiskReadOnly(file, readOnly) {
  if (!file.diskPath) return;
  try {
    const stat = await fs.stat(file.diskPath);
    const mode = readOnly ? stat.mode & ~0o222 : stat.mode | 0o200;
    await fs.chmod(file.diskPath, mode);
    const after = await fs.stat(file.diskPath);
    await VaultFile.updateOne({ _id: file._id }, { $set: { diskMtimeMs: after.mtimeMs, diskSize: after.size } });
  } catch {
    // The share may be offline or not allow it. The vault copy is protected either way.
  }
}

async function record(file, user, action, note, extra = {}) {
  file.history.push(entry(action, user, note));
  Object.assign(file, extra);
  await file.save();
  await auditNow({ actor: user, action: `VAULT_${action.toUpperCase().replace(/[^A-Z]+/g, '_')}`, entityType: 'VaultFile', entityId: file._id, entityNo: file.path, reason: note || null, data: { state: file.state, revision: file.revision, version: file.version } });
  return file;
}

const holderIsSomeoneElse = (file, user) => file.checkedOut?.byId && String(file.checkedOut.byId) !== String(user.id);
const noCheckout = { checkedOut: { byId: null, byName: '', at: null } };
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Lean rows keep Mongo's _id. Screens everywhere else in Forge expect id.
const withId = (rows) => rows.map(({ _id, __v, ...rest }) => ({ id: String(_id), ...rest }));

// ---------- Who may pull and push ----------
// The maintainer (the ADMIN role) may do everything and decides for everyone else: rules
// for a person or a role on a folder, and tasks that let someone push while they are open.
export const isMaintainer = (user) => user?.role === 'ADMIN';

export async function accessOf(user) {
  if (!user?.id) return { all: null, grants: [] };
  if (isMaintainer(user)) return { all: 'PUSH', grants: [] };
  const [rules, tasks] = await Promise.all([
    VaultRule.find({ $or: [{ userId: user.id }, { role: user.role }] }).lean(),
    VaultTask.find({ assigneeId: user.id, status: 'OPEN' }).lean(),
  ]);
  return {
    all: null,
    grants: [
      ...rules.map((r) => ({ prefix: r.folder.toLowerCase(), folder: r.folder, level: r.level })),
      ...tasks.flatMap((t) => t.paths.map((p) => ({ prefix: p.toLowerCase(), folder: p, level: 'PUSH', task: t.title }))),
    ],
  };
}

const covers = (prefix, pathKey) => !prefix || pathKey === prefix || pathKey.startsWith(`${prefix}/`);

export function levelFor(access, pathKey) {
  if (access.all) return access.all;
  let level = null;
  for (const grant of access.grants) {
    if (!covers(grant.prefix, pathKey)) continue;
    if (grant.level === 'PUSH') return 'PUSH';
    level = 'PULL';
  }
  return level;
}

// A Mongo filter for the files this access may pull.
export function pullFilter(access) {
  if (access.all || access.grants.some((g) => !g.prefix)) return {};
  if (access.grants.length === 0) return { _id: null };
  return { $or: access.grants.map((g) => ({ pathKey: new RegExp(`^${escapeRegex(g.prefix)}(/|$)`) })) };
}

async function need(user, file, wanted) {
  const level = levelFor(await accessOf(user), file.pathKey);
  if (wanted === 'PULL' && !level) throw notFound('File');
  if (wanted === 'PUSH' && level !== 'PUSH') throw forbidden('You can pull this file but not push to it. The maintainer decides who can push.');
  return level;
}

async function loadFor(id, user, wanted) {
  const file = await load(id);
  if (user) await need(user, file, wanted);
  return file;
}

// ---------- Locks and states ----------
export async function checkOut(id, user) {
  const file = await loadFor(id, user, 'PUSH');
  if (file.state !== 'WIP') throw rule(file.state === 'RELEASED' ? 'This file is released. Start a new revision first.' : `A file that is ${file.state.toLowerCase()} cannot be locked.`);
  if (holderIsSomeoneElse(file, user)) throw conflict(`${file.checkedOut.byName} already has it locked.`, 'CHECKED_OUT');
  return record(file, user, 'Locked', '', { checkedOut: { byId: user.id, byName: user.name, at: new Date() } });
}

export async function undoCheckOut(id, user, isAdmin) {
  const file = await loadFor(id, user, 'PULL');
  if (!file.checkedOut?.byId) throw rule('This file is not locked.');
  if (holderIsSomeoneElse(file, user) && !isAdmin) throw forbidden(`Only ${file.checkedOut.byName} or the maintainer can unlock it.`);
  return record(file, user, 'Unlocked', holderIsSomeoneElse(file, user) ? `Was locked by ${file.checkedOut.byName}` : '', noCheckout);
}

export async function submitForReview(id, user, note = '') {
  const file = await loadFor(id, user, 'PUSH');
  if (file.state !== 'WIP') throw rule('Only a file being worked on can go for review.');
  if (holderIsSomeoneElse(file, user)) throw conflict(`${file.checkedOut.byName} still has it locked.`, 'CHECKED_OUT');
  return record(file, user, 'Sent for review', note, { state: 'REVIEW', ...noCheckout });
}

export async function reject(id, user, note) {
  if (!note?.trim()) throw badRequest('Say what needs changing.');
  const file = await loadFor(id, user, 'PULL');
  if (file.state !== 'REVIEW') throw rule('Only a file in review can be sent back.');
  return record(file, user, 'Sent back', note, { state: 'WIP' });
}

export async function release(id, user, note = '') {
  const file = await loadFor(id, user, 'PULL');
  if (file.state !== 'REVIEW') throw rule('A file is released after review. Send it for review first.');
  const revision = nextRevision(file.revision);
  await VaultVersion.updateOne({ _id: file.latestVersionId }, { $set: { revision } });
  // The item that this drawing describes now shows the released revision.
  if (file.itemId) await Item.updateOne({ _id: file.itemId }, { $set: { drawingRev: revision, drawingNo: file.number } });
  const saved = await record(file, user, `Released as revision ${revision}`, note, { state: 'RELEASED', revision, blockedChange: { at: null, source: '', byName: '', sha256: '' } });
  await setDiskReadOnly(saved, true);
  return saved;
}

export async function newRevision(id, user, note = '') {
  const file = await loadFor(id, user, 'PULL');
  if (file.state !== 'RELEASED') throw rule('A new revision starts from a released file.');
  // Forget what was last seen on disk, so a change waiting there is picked up next scan.
  const saved = await record(file, user, `Revision ${nextRevision(file.revision)} started`, note, { state: 'WIP', diskMtimeMs: null, blockedChange: { at: null, source: '', byName: '', sha256: '' } });
  await setDiskReadOnly(saved, false);
  return VaultFile.updateOne({ _id: saved._id }, { $set: { diskMtimeMs: null } }).then(() => load(id));
}

export async function makeObsolete(id, user, note) {
  if (!note?.trim()) throw badRequest('Say why it is no longer used.');
  const file = await loadFor(id, user, 'PULL');
  if (file.state === 'OBSOLETE') throw rule('This file is already obsolete.');
  const saved = await record(file, user, 'Made obsolete', note, { state: 'OBSOLETE', ...noCheckout });
  await setDiskReadOnly(saved, true);
  return saved;
}

export async function setTitle(id, user, title) {
  const file = await loadFor(id, user, 'PUSH');
  return record(file, user, 'Description changed', '', { title: String(title ?? '').trim().slice(0, 200) });
}

// ---------- Push ----------
// Like git: a push names the version it started from. If someone pushed after that, it is
// turned away and the person pulls first, so nobody overwrites anybody without knowing.
export async function startPush(user, message, via) {
  if (!message?.trim()) throw badRequest('Write what this push changes.');
  const push = await VaultPush.create({ byId: user.id, byName: user.name, message: message.trim().slice(0, 2000), via, files: [] });
  return { pushId: String(push._id) };
}

export async function pushFile({ user, vaultPath, readable, base, pushId, unlock = false, via }) {
  const drain = () => readable.resume?.();
  const where = vaultPathOf(vaultPath);
  const push = mongoose.isValidObjectId(pushId) ? await VaultPush.findById(pushId) : null;
  if (!push || String(push.byId) !== String(user.id)) { drain(); throw badRequest('Start the push with a message first.'); }
  const level = levelFor(await accessOf(user), where.pathKey);
  if (level !== 'PUSH') { drain(); throw forbidden(level ? `You can pull ${where.folder || 'this folder'} but not push to it. The maintainer decides who can push.` : 'You have no access to this folder.'); }
  const existing = await VaultFile.findOne({ pathKey: where.pathKey });
  if (existing) {
    if (existing.state !== 'WIP') { drain(); throw conflict(`${where.name} is ${existing.state === 'RELEASED' ? `released as revision ${existing.revision}` : existing.state.toLowerCase()}. A new revision must be started before it can change.`, 'RELEASED'); }
    if (base === undefined || base === null || base === '') { drain(); throw badRequest(`${where.name} is already in the vault. Pull it first, so Forge knows which version you changed.`); }
    if (Number(base) !== existing.version) {
      drain();
      throw conflict(`${where.name}: ${existing.lastChangedBy || 'someone'} pushed version ${existing.version} after you pulled version ${base}. Pull it first, then make your change again.`, 'BEHIND', { current: existing.version, by: existing.lastChangedBy });
    }
  }
  const result = await ingest({ vaultPath, readable, source: via === 'PC' ? 'AGENT' : 'UPLOAD', user, note: push.message });
  await VaultPush.updateOne({ _id: push._id }, { $push: { files: { fileId: result.file._id, path: result.file.path, version: result.file.version, status: result.status } } });
  let file = result.file;
  if (unlock && file.checkedOut?.byId && String(file.checkedOut.byId) === String(user.id)) {
    file = await record(await load(file._id), user, 'Unlocked', 'After push', noCheckout);
  }
  return { status: result.status, file };
}

export async function listPushes(user, limit = 50) {
  const access = await accessOf(user);
  const rows = await VaultPush.find({ 'files.0': { $exists: true } }).sort({ createdAt: -1 }).limit(Math.min(limit, 200)).lean();
  return withId(rows.map((push) => ({ ...push, files: push.files.filter((f) => levelFor(access, f.path.toLowerCase())) })))
    .filter((push) => push.files.length > 0);
}

// ---------- Rules and tasks (the maintainer) ----------
export const listRules = () => VaultRule.find().sort({ folder: 1, role: 1, userName: 1 });

export async function addRule({ userId = null, role = '', folder = '', level }, by) {
  if (!userId === !role) throw badRequest('Choose one person or one role.');
  let userName = '';
  if (userId) {
    const person = await User.findOne({ _id: userId, isActive: true }, { name: 1 }).lean();
    if (!person) throw badRequest('Choose someone who can sign in.');
    userName = person.name;
  }
  const clean = folder ? vaultPathOfFolder(folder) : '';
  const same = await VaultRule.findOne({ userId: userId || null, role: role || '', folder: new RegExp(`^${escapeRegex(clean)}$`, 'i') });
  if (same) {
    same.level = level;
    return same.save();
  }
  return VaultRule.create({ userId: userId || null, userName, role: role || '', folder: clean, level, createdByName: by.name });
}

export async function listTasks(user) {
  const filter = isMaintainer(user) ? {} : { assigneeId: user.id };
  return VaultTask.find(filter).sort({ status: 1, createdAt: -1 }).limit(300);
}

export async function addTask({ title, note = '', assigneeId, paths = [], dueDate = '' }, by) {
  const person = await User.findOne({ _id: assigneeId, isActive: true }, { name: 1 }).lean();
  if (!person) throw badRequest('Choose someone who can sign in.');
  const clean = paths.map((p) => vaultPathOfFolder(p)).filter(Boolean);
  if (clean.length === 0) throw badRequest('Name at least one folder or file the task covers.');
  return VaultTask.create({ title, note, assigneeId, assigneeName: person.name, paths: clean, dueDate, createdByName: by.name });
}

// The person hands it in; the maintainer closes, reopens or cancels it.
export async function moveTask(id, user, status, answer = '') {
  const task = await VaultTask.findById(id);
  if (!task) throw notFound('Task');
  const own = String(task.assigneeId) === String(user.id);
  if (!isMaintainer(user)) {
    if (!own || status !== 'SUBMITTED' || task.status !== 'OPEN') throw forbidden('Only the maintainer can change this task.');
  }
  task.status = status;
  if (answer) task.answer = answer.slice(0, 2000);
  return task.save();
}

// ---------- Reading ----------
export async function listFiles({ q = '', kind = '', state = '', folder = '', mine = false, user, page = 1, limit = 60 }) {
  const filter = { $and: [pullFilter(await accessOf(user))] };
  if (q.trim()) {
    const words = q.trim().split(/\s+/).slice(0, 5).map((w) => new RegExp(escapeRegex(w), 'i'));
    filter.$and.push(...words.map((w) => ({ $or: [{ path: w }, { title: w }, { itemCode: w }] })));
  }
  if (kind === 'CAD') filter.kind = { $in: ['PART', 'ASSEMBLY', 'DRAWING'] };
  else if (kind === 'AUTOCAD') filter.kind = { $in: ['DWG', 'DXF'] };
  else if (kind) filter.kind = kind;
  if (state) filter.state = state;
  if (folder) filter.folder = new RegExp(`^${escapeRegex(folder)}(/|$)`, 'i');
  if (mine) filter['checkedOut.byId'] = user.id;
  const size = Math.min(Math.max(Number(limit) || 60, 1), 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * size;
  const [rows, total] = await Promise.all([
    VaultFile.find(filter, { history: 0 }).sort({ lastChangedAt: -1 }).skip(skip).limit(size).lean(),
    VaultFile.countDocuments(filter),
  ]);
  return { rows: withId(rows), total, page: Math.max(Number(page) || 1, 1), limit: size };
}

export async function folderTree(user) {
  const rows = await VaultFile.aggregate([{ $match: pullFilter(await accessOf(user)) }, { $group: { _id: '$folder', count: { $sum: 1 } } }, { $sort: { _id: 1 } }]);
  return rows.map((r) => ({ folder: r._id, count: r.count }));
}

export async function summary(user) {
  const access = await accessOf(user);
  const mine = pullFilter(access);
  const [byState, locked, blocked, total, tasks] = await Promise.all([
    VaultFile.aggregate([{ $match: mine }, { $group: { _id: '$state', count: { $sum: 1 } } }]),
    VaultFile.countDocuments({ 'checkedOut.byId': user.id }),
    VaultFile.countDocuments({ $and: [mine, { 'blockedChange.at': { $ne: null } }] }),
    VaultFile.countDocuments(mine),
    VaultTask.countDocuments({ assigneeId: user.id, status: 'OPEN' }),
  ]);
  return {
    total, mine: locked, blocked, openTasks: tasks, maintainer: isMaintainer(user),
    access: access.all ? [{ prefix: '', level: access.all }] : access.grants,
    states: Object.fromEntries(byState.map((r) => [r._id, r.count])),
  };
}

export async function fileDetail(id, user = null) {
  const file = await load(id);
  const level = user ? await need(user, file, 'PULL') : 'PUSH';
  const access = user ? await accessOf(user) : { all: 'PUSH', grants: [] };
  const [versions, boms] = await Promise.all([
    VaultVersion.find({ fileId: file._id }).sort({ version: -1 }).limit(200).lean(),
    Bom.find({ 'lines.drawingNo': new RegExp(`^${escapeRegex(file.number)}$`, 'i') }, { itemCode: 1, itemName: 1, revision: 1, status: 1 }).limit(50).lean(),
  ]);
  // Files that share its number: the part, its drawing, its PDF and DXF.
  const family = (await VaultFile.find({ number: new RegExp(`^${escapeRegex(file.number)}$`, 'i'), _id: { $ne: file._id } }, { history: 0 }).limit(20).lean())
    .filter((f) => levelFor(access, f.pathKey));
  return { file: file.toJSON(), level, versions: withId(versions), usedIn: boms.map((b) => ({ id: String(b._id), itemCode: b.itemCode, itemName: b.itemName, revision: b.revision, status: b.status })), family: withId(family) };
}

export async function versionOf(id, versionNo, user = null) {
  const file = await loadFor(id, user, 'PULL');
  const version = versionNo ? await VaultVersion.findOne({ fileId: file._id, version: Number(versionNo) }).lean() : await VaultVersion.findById(file.latestVersionId).lean();
  if (!version) throw notFound('Version');
  return { file, version };
}

export const openGrid = (gridId) => bucket().openDownloadStream(gridId);

// ---------- Watched folders ----------
async function* walk(root, limit) {
  const stack = [''];
  let seen = 0;
  while (stack.length) {
    const rel = stack.pop();
    let dir;
    try {
      dir = await fs.opendir(path.join(root, rel));
    } catch (error) {
      if (rel === '') throw error;
      continue;
    }
    for await (const dirent of dir) {
      if (dirent.name.startsWith('.') || dirent.name.startsWith('~')) continue;
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        if (childRel.split('/').length < 20) stack.push(childRel);
      } else if (dirent.isFile()) {
        if ((seen += 1) > limit) return;
        yield childRel;
      }
    }
  }
}

export async function scanWatch(watch, now = Date.now()) {
  const result = { added: 0, changed: 0, unchanged: 0, blocked: 0, errors: [] };
  const seen = [];
  let ingested = 0;
  let complete = true;
  try {
    const rootStat = await fs.stat(watch.dir);
    if (!rootStat.isDirectory()) throw new Error('not a folder');
    for await (const rel of walk(watch.dir, SCAN_FILE_LIMIT)) {
      const name = rel.split('/').pop();
      const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
      if (!EXTENSIONS[ext] || isScratch(name)) continue;
      const vaultPath = joinVault(watch.vaultFolder, rel);
      const pathKey = vaultPath.toLowerCase();
      seen.push(pathKey);
      const full = path.join(watch.dir, rel);
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      const known = await VaultFile.findOne({ pathKey }, { diskSize: 1, diskMtimeMs: 1, missingOnDisk: 1 }).lean();
      if (known && known.diskSize === stat.size && known.diskMtimeMs === stat.mtimeMs) {
        result.unchanged += 1;
        if (known.missingOnDisk) await VaultFile.updateOne({ _id: known._id }, { $set: { missingOnDisk: false } });
        continue;
      }
      if (now - stat.mtimeMs < SETTLE_MS) { complete = false; continue; }
      if (stat.size > MAX_FILE_BYTES) {
        if (result.errors.length < 20) result.errors.push(`${rel}: over 500 MB, skipped`);
        continue;
      }
      if (ingested >= SCAN_INGEST_LIMIT) { complete = false; continue; }
      ingested += 1;
      try {
        const { status } = await ingest({
          vaultPath, readable: createReadStream(full), source: 'WATCH', user: { id: null, name: watch.name },
          disk: { watchId: watch._id, diskPath: full, size: stat.size, mtimeMs: stat.mtimeMs },
        });
        result[{ ADDED: 'added', CHANGED: 'changed', UNCHANGED: 'unchanged', BLOCKED: 'blocked' }[status]] += 1;
      } catch (error) {
        if (result.errors.length < 20) result.errors.push(`${rel}: ${error.message}`);
      }
    }
    // Only a full, successful walk can say a file has gone. An offline share proves nothing.
    await VaultFile.updateMany({ watchId: watch._id, pathKey: { $nin: seen }, missingOnDisk: false }, { $set: { missingOnDisk: true } });
  } catch (error) {
    complete = false;
    result.errors.push(error.code === 'ENOENT' ? `The folder ${watch.dir} cannot be found. Is the drive connected?` : `Could not read ${watch.dir}: ${error.message}`);
  }
  await VaultWatch.updateOne({ _id: watch._id }, { $set: { lastScanAt: new Date(now), lastResult: result } });
  return { ...result, complete };
}

export async function scanAllWatches(now = Date.now()) {
  // Only folders the maintainer set to be read by themselves. The rest wait for Read now.
  const watches = await VaultWatch.find({ isActive: true, auto: true }).lean();
  const results = [];
  for (const watch of watches) results.push({ watch: watch.name, ...(await scanWatch(watch, now)) });
  return results;
}

export async function addWatch({ name, dir, vaultFolder = '' }) {
  const folder = vaultFolder ? vaultPathOfFolder(vaultFolder) : '';
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) throw badRequest('That is a file, not a folder.');
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw badRequest(`The server cannot open ${dir}. Check the path, and that the drive is connected to the server.`);
  }
  return VaultWatch.create({ name, dir: path.resolve(dir), vaultFolder: folder });
}

export function vaultPathOfFolder(raw) {
  const parts = String(raw).replace(/\\/g, '/').split('/').map((p) => p.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim()).filter((p) => p && p !== '.');
  if (parts.includes('..')) throw badRequest('A folder cannot go up a level.');
  return parts.join('/');
}

// ---------- Designer PCs ----------
const hashKey = (key) => createHash('sha256').update(String(key)).digest('hex');

export async function createAgent({ name, vaultFolder = '', userId }, user) {
  const key = `fva_${randomBytes(24).toString('base64url')}`;
  // A PC pulls and pushes as one person, with that person's access. No person, no PC.
  const person = userId ? await User.findOne({ _id: userId, isActive: true }, { name: 1 }).lean() : null;
  if (!person) throw badRequest('Choose who uses this PC. It pulls and pushes as that person.');
  const agent = await VaultAgent.create({
    name, vaultFolder: vaultFolder ? vaultPathOfFolder(vaultFolder) : '', keyHash: hashKey(key), keyHint: key.slice(-4),
    userId: person._id, userName: person.name,
    createdById: user.id, createdByName: user.name,
  });
  return { agent: agent.toJSON(), key };
}

export async function agentForKey(key) {
  if (typeof key !== 'string' || !key.startsWith('fva_')) return null;
  const agent = await VaultAgent.findOne({ keyHash: hashKey(key), isActive: true });
  if (agent) await VaultAgent.updateOne({ _id: agent._id }, { $set: { lastSeenAt: new Date() } });
  return agent;
}

// The person a PC belongs to, read fresh: a role change or a switched-off account applies at once.
export async function agentPerson(agent) {
  if (!agent.userId) return null;
  const user = await User.findById(agent.userId, { name: 1, role: 1, isActive: 1 }).lean();
  return user?.isActive ? { id: user._id, name: user.name, role: user.role } : null;
}

// What the PC's person may pull under the PC's folder, with what they may do to each file.
export async function manifestFor(agent, person) {
  if (!person) return [];
  const access = await accessOf(person);
  const prefix = agent.vaultFolder ? `${agent.vaultFolder.toLowerCase()}/` : '';
  const filter = { $and: [pullFilter(access), prefix ? { pathKey: new RegExp(`^${escapeRegex(prefix)}`) } : {}] };
  const rows = await VaultFile.find(filter, { path: 1, pathKey: 1, version: 1, sha256: 1, sizeBytes: 1, state: 1, revision: 1, checkedOut: 1, title: 1, lastChangedBy: 1 }).limit(50000).lean();
  const me = String(person.id);
  return rows.map((r) => ({
    id: String(r._id),
    path: r.path.slice(prefix.length),
    version: r.version,
    sha256: r.sha256,
    size: r.sizeBytes,
    state: r.state,
    revision: r.revision,
    title: r.title,
    level: levelFor(access, r.pathKey),
    lastChangedBy: r.lastChangedBy,
    checkedOutBy: r.checkedOut?.byName || '',
    mine: Boolean(r.checkedOut?.byId && String(r.checkedOut.byId) === me),
  }));
}

// The file must sit under the PC's folder, and its person must be allowed to pull it.
export async function fileForAgent(agent, id, person) {
  const file = await load(id);
  const prefix = agent.vaultFolder ? `${agent.vaultFolder.toLowerCase()}/` : '';
  if (prefix && !file.pathKey.startsWith(prefix)) throw notFound('File');
  if (!person) throw notFound('File');
  await need(person, file, 'PULL');
  return file;
}

export async function fileByAgentPath(agent, rel, person) {
  const where = vaultPathOf(joinVault(agent.vaultFolder, rel));
  const file = await VaultFile.findOne({ pathKey: where.pathKey });
  if (!file || !person) throw notFound('File');
  const level = await need(person, file, 'PULL');
  return { file, level };
}
