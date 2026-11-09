// The drawing vault's addresses. /vault for people in the browser, /vault-agent for the Forge
// Vault program on a designer's PC, which signs in with its own key and acts as its person.
//
// Nothing moves by itself: people pull (download) and push (send new versions), like git.
// The maintainer decides who may pull and push where.
import { createReadStream, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authenticate, requireObjectId, requirePerm } from '../middleware/index.js';
import { STAFF_ROLES } from '../config/permissions.js';
import { vaultAgentScript } from '../config/vaultAgentScript.js';
import { User } from '../models/core.js';
import { VaultAgent, VaultRule, VaultWatch } from '../models/vault.js';
import { allowed } from '../services/policyService.js';
import * as vault from '../services/vaultService.js';
import { badRequest, forbidden, notFound, unauthenticated } from '../utils/errors.js';

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const note = z.object({ note: z.string().trim().max(2000).optional().default('') }).strict();
const isTest = process.env.NODE_ENV === 'test';
const PC_KIT = fileURLToPath(new URL('../assets/ForgeVault-PC-Kit.zip', import.meta.url));
const objectId = z.string().regex(/^[a-f\d]{24}$/i);
const pushQuery = z.object({
  pushId: objectId,
  path: z.string().min(1).max(400),
  base: z.coerce.number().int().min(0).optional(),
  unlock: z.enum(['true', 'false']).optional(),
});

// Downloads are always attachments and pictures are sandboxed: nothing from the vault can
// run as a page on this site.
function sendGrid(res, gridId, { filename, contentType, inline }) {
  res.set({
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'cache-control': 'private, max-age=300',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename.replace(/[^\w.\- ]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  });
  const stream = vault.openGrid(gridId);
  stream.on('error', () => (res.headersSent ? res.destroy() : res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'That file is missing from storage.' } })));
  stream.pipe(res);
}

const uploadOf = (req) => {
  const length = Number(req.get('content-length'));
  if (Number.isFinite(length) && length > vault.MAX_FILE_BYTES) throw badRequest('Files over 500 MB are not kept in the vault.');
  return req;
};

const sendVersion = (res, file, version) => {
  res.set('x-forge-version', String(version.version));
  res.set('x-forge-sha256', version.sha256);
  sendGrid(res, version.gridId, { filename: file.name, contentType: 'application/octet-stream', inline: false });
};

export function vaultRoutes() {
  const r = Router();
  r.param('id', requireObjectId);
  r.use(authenticate, requirePerm('vault.read'));
  const maintainer = requirePerm('vault.admin');

  r.get('/summary', async (req, res) => ok(res, await vault.summary(req.user)));
  r.get('/folders', async (req, res) => ok(res, await vault.folderTree(req.user)));
  r.get('/files', async (req, res) => {
    const q = z.object({
      q: z.string().max(200).optional(), kind: z.string().max(20).optional(), state: z.enum(['', 'WIP', 'REVIEW', 'RELEASED', 'OBSOLETE']).optional(),
      folder: z.string().max(400).optional(), mine: z.enum(['true', 'false']).optional(), page: z.coerce.number().int().min(1).max(10000).optional(),
    }).parse(req.query);
    ok(res, await vault.listFiles({ ...q, mine: q.mine === 'true', user: req.user }));
  });
  r.get('/files/:id', async (req, res) => ok(res, await vault.fileDetail(req.params.id, req.user)));
  // Pull: the latest version, or any older one.
  r.get('/files/:id/download', async (req, res) => {
    const { file, version } = await vault.versionOf(req.params.id, req.query.version, req.user);
    sendVersion(res, file, version);
  });
  r.get('/files/:id/preview', async (req, res) => {
    const { file, version } = await vault.versionOf(req.params.id, req.query.version, req.user);
    if (!version.previewGridId) throw notFound('Picture');
    sendGrid(res, version.previewGridId, { filename: `${file.number}-preview`, contentType: version.previewType, inline: true });
  });

  // Push: start with a message, then send each file with the version it was changed from.
  r.get('/pushes', async (req, res) => ok(res, await vault.listPushes(req.user)));
  r.post('/pushes', requirePerm('vault.write'), async (req, res) => {
    const { message } = z.object({ message: z.string().trim().min(1).max(2000) }).strict().parse(req.body ?? {});
    ok(res, await vault.startPush(req.user, message, 'BROWSER'), 201);
  });
  r.post('/push', requirePerm('vault.write'), async (req, res) => {
    const q = pushQuery.parse(req.query);
    const result = await vault.pushFile({ user: req.user, vaultPath: q.path, readable: uploadOf(req), base: q.base, pushId: q.pushId, unlock: q.unlock === 'true', via: 'BROWSER' });
    ok(res, { status: result.status, file: result.file }, result.status === 'ADDED' ? 201 : 200);
  });

  const act = (path, perm, run) => r.post(`/files/:id/${path}`, requirePerm(perm), async (req, res) => ok(res, await run(req)));
  act('lock', 'vault.write', (req) => vault.checkOut(req.params.id, req.user));
  act('unlock', 'vault.write', (req) => vault.undoCheckOut(req.params.id, req.user, vault.isMaintainer(req.user)));
  act('submit', 'vault.write', (req) => vault.submitForReview(req.params.id, req.user, note.parse(req.body ?? {}).note));
  act('reject', 'vault.release', (req) => vault.reject(req.params.id, req.user, note.parse(req.body ?? {}).note));
  act('release', 'vault.release', (req) => vault.release(req.params.id, req.user, note.parse(req.body ?? {}).note));
  act('new-revision', 'vault.release', (req) => vault.newRevision(req.params.id, req.user, note.parse(req.body ?? {}).note));
  act('obsolete', 'vault.release', (req) => vault.makeObsolete(req.params.id, req.user, note.parse(req.body ?? {}).note));
  r.patch('/files/:id', requirePerm('vault.write'), async (req, res) => {
    const body = z.object({ title: z.string().max(200) }).strict().parse(req.body ?? {});
    ok(res, await vault.setTitle(req.params.id, req.user, body.title));
  });

  // ---------- Tasks: the maintainer gives work, the person hands it in ----------
  r.get('/tasks', async (req, res) => ok(res, await vault.listTasks(req.user)));
  r.post('/tasks', maintainer, async (req, res) => {
    const body = z.object({
      title: z.string().trim().min(1).max(200), note: z.string().trim().max(2000).optional(), assigneeId: objectId,
      paths: z.array(z.string().trim().min(1).max(400)).min(1).max(50), dueDate: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/).optional(),
    }).strict().parse(req.body ?? {});
    ok(res, await vault.addTask(body, req.user), 201);
  });
  r.patch('/tasks/:id', async (req, res) => {
    const body = z.object({ status: z.enum(['OPEN', 'SUBMITTED', 'DONE', 'CANCELLED']), answer: z.string().trim().max(2000).optional() }).strict().parse(req.body ?? {});
    ok(res, await vault.moveTask(req.params.id, req.user, body.status, body.answer));
  });

  // ---------- The maintainer: access rules, folders read on the server, PCs ----------
  r.get('/rules', maintainer, async (_req, res) => ok(res, await vault.listRules()));
  r.post('/rules', maintainer, async (req, res) => {
    const body = z.object({
      userId: objectId.optional(), role: z.enum(STAFF_ROLES.filter((x) => x !== 'ADMIN')).optional(),
      folder: z.string().trim().max(400).optional(), level: z.enum(['PULL', 'PUSH']),
    }).strict().parse(req.body ?? {});
    ok(res, await vault.addRule(body, req.user), 201);
  });
  r.delete('/rules/:id', maintainer, async (req, res) => {
    if (!(await VaultRule.findByIdAndDelete(req.params.id))) throw notFound('Rule');
    ok(res, { removed: true });
  });
  r.get('/people', maintainer, async (_req, res) => ok(res, (await User.find({ isActive: true, role: { $ne: 'PORTAL' } }, { name: 1, role: 1 }).sort({ name: 1 }).lean()).map((u) => ({ id: String(u._id), name: u.name, role: u.role }))));

  r.get('/watches', maintainer, async (_req, res) => ok(res, await VaultWatch.find().sort({ name: 1 })));
  r.post('/watches', maintainer, async (req, res) => {
    const body = z.object({ name: z.string().trim().min(1).max(80), dir: z.string().trim().min(1).max(500), vaultFolder: z.string().trim().max(200).optional() }).strict().parse(req.body ?? {});
    ok(res, await vault.addWatch(body), 201);
  });
  r.patch('/watches/:id', maintainer, async (req, res) => {
    const body = z.object({ isActive: z.boolean().optional(), auto: z.boolean().optional() }).strict().parse(req.body ?? {});
    const watch = await VaultWatch.findByIdAndUpdate(req.params.id, { $set: body }, { new: true });
    if (!watch) throw notFound('Folder');
    ok(res, watch);
  });
  r.delete('/watches/:id', maintainer, async (req, res) => {
    if (!(await VaultWatch.findByIdAndDelete(req.params.id))) throw notFound('Folder');
    ok(res, { removed: true });
  });
  r.post('/watches/:id/scan', maintainer, async (req, res) => {
    const watch = await VaultWatch.findById(req.params.id).lean();
    if (!watch) throw notFound('Folder');
    ok(res, await vault.scanWatch(watch));
  });

  // The PC kit: Explorer badges and the SOLIDWORKS add-in, built on the PC itself.
  r.get('/pc-kit', async (_req, res) => {
    if (!existsSync(PC_KIT)) throw notFound('The PC kit');
    res.set({ 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="ForgeVault-PC-Kit.zip"', 'x-content-type-options': 'nosniff' });
    createReadStream(PC_KIT).pipe(res);
  });
  r.get('/agents', maintainer, async (_req, res) => ok(res, await VaultAgent.find({}, { keyHash: 0 }).sort({ name: 1 })));
  r.post('/agents', maintainer, async (req, res) => {
    const body = z.object({
      name: z.string().trim().min(1).max(80),
      userId: objectId,
      pcFolder: z.string().trim().min(2).max(300),
      vaultFolder: z.string().trim().max(200).optional(),
      serverUrl: z.string().trim().url().max(300).refine((u) => /^https?:\/\//.test(u), 'Use an http or https address.'),
    }).strict().parse(req.body ?? {});
    const { agent, key } = await vault.createAgent(body, req.user);
    const script = vaultAgentScript({ serverUrl: body.serverUrl, key, pcFolder: body.pcFolder, name: body.name, extensions: Object.keys(vault.EXTENSIONS) });
    ok(res, { agent, script }, 201);
  });
  r.patch('/agents/:id', maintainer, async (req, res) => {
    const body = z.object({ isActive: z.boolean() }).strict().parse(req.body ?? {});
    const agent = await VaultAgent.findByIdAndUpdate(req.params.id, { $set: body }, { new: true, projection: { keyHash: 0 } });
    if (!agent) throw notFound('PC');
    ok(res, agent);
  });
  return r;
}

// The Forge Vault program on a PC. Everything is done as the PC's person, with that
// person's role permissions and vault access, read fresh each time.
export function vaultAgentRoutes() {
  const r = Router();
  r.param('id', requireObjectId);
  r.use(rateLimit({ windowMs: 60000, limit: 1200, skip: () => isTest, standardHeaders: true, legacyHeaders: false }));
  r.use(async (req, _res, next) => {
    const agent = await vault.agentForKey(req.get('x-forge-agent-key'));
    if (!agent) throw unauthenticated('This PC is not allowed into the vault.');
    const person = await vault.agentPerson(agent);
    if (!person) throw forbidden('The person this PC belongs to can no longer sign in.');
    if (!(await allowed(person.role, 'vault.read'))) throw forbidden('The drawing vault is not open to this person.');
    req.agent = agent;
    req.person = person;
    next();
  });
  const may = async (req, perm) => {
    if (!(await allowed(req.person.role, perm))) throw forbidden();
  };

  r.get('/hello', (req, res) => ok(res, { name: req.agent.name, vaultFolder: req.agent.vaultFolder, userName: req.person.name, role: req.person.role }));
  r.get('/manifest', async (req, res) => ok(res, { files: await vault.manifestFor(req.agent, req.person), userName: req.person.name }));
  r.get('/status', async (req, res) => {
    const q = z.object({ path: z.string().min(1).max(400) }).parse(req.query);
    const { file, level } = await vault.fileByAgentPath(req.agent, q.path, req.person);
    const { versions } = await vault.fileDetail(file._id);
    ok(res, {
      id: String(file._id), path: file.path, name: file.name, number: file.number, title: file.title, state: file.state, revision: file.revision,
      version: file.version, sha256: file.sha256, itemCode: file.itemCode, level, checkedOutBy: file.checkedOut?.byName || '',
      mine: Boolean(file.checkedOut?.byId && String(file.checkedOut.byId) === String(req.person.id)),
      lastChangedAt: file.lastChangedAt, lastChangedBy: file.lastChangedBy,
      versions: versions.slice(0, 20).map((v) => ({ version: v.version, revision: v.revision, at: v.createdAt, by: v.byName, note: v.note })),
      history: file.history.slice(-8).reverse().map((h) => ({ at: h.at, action: h.action, by: h.byName, note: h.note })),
    });
  });
  r.get('/files/:id/download', async (req, res) => {
    const file = await vault.fileForAgent(req.agent, req.params.id, req.person);
    const { version } = await vault.versionOf(file._id, req.query.version);
    sendVersion(res, file, version);
  });
  r.get('/tasks', async (req, res) => ok(res, await vault.listTasks(req.person)));

  r.post('/pushes', async (req, res) => {
    await may(req, 'vault.write');
    const { message } = z.object({ message: z.string().trim().min(1).max(2000) }).strict().parse(req.body ?? {});
    ok(res, await vault.startPush(req.person, message, 'PC'), 201);
  });
  r.post('/push', async (req, res) => {
    await may(req, 'vault.write');
    const q = pushQuery.parse(req.query);
    const result = await vault.pushFile({
      user: req.person, vaultPath: vault.joinVault(req.agent.vaultFolder, q.path), readable: uploadOf(req), base: q.base, pushId: q.pushId, unlock: q.unlock === 'true', via: 'PC',
    });
    if (result.status === 'ADDED' || result.status === 'CHANGED') await VaultAgent.updateOne({ _id: req.agent._id }, { $inc: { filesSent: 1 } });
    ok(res, { status: result.status, id: String(result.file._id), version: result.file.version, state: result.file.state, sha256: result.file.sha256 });
  });

  const agentAct = (path, perm, run) => r.post(`/files/:id/${path}`, async (req, res) => {
    await may(req, perm);
    const file = await vault.fileForAgent(req.agent, req.params.id, req.person);
    const saved = await run(file._id, req.person, note.parse(req.is('application/json') ? (req.body ?? {}) : {}).note);
    ok(res, { id: String(saved._id), state: saved.state, revision: saved.revision, version: saved.version, checkedOutBy: saved.checkedOut?.byName || '' });
  });
  agentAct('lock', 'vault.write', (id, user) => vault.checkOut(id, user));
  agentAct('unlock', 'vault.write', (id, user) => vault.undoCheckOut(id, user, vault.isMaintainer(user)));
  agentAct('submit', 'vault.write', (id, user, text) => vault.submitForReview(id, user, text));
  agentAct('reject', 'vault.release', (id, user, text) => vault.reject(id, user, text));
  agentAct('release', 'vault.release', (id, user, text) => vault.release(id, user, text));
  agentAct('new-revision', 'vault.release', (id, user, text) => vault.newRevision(id, user, text));
  return r;
}

