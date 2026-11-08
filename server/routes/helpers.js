// Shared route builders: a CRUD router for masters and a lifecycle router for documents.
import { Router } from 'express';
import { authenticate, requireObjectId, requirePerm, validate } from '../middleware/index.js';
import { withTxn } from '../utils/txn.js';
import { conflict, forbidden, notFound, rule } from '../utils/errors.js';
import { coreBodyInScope, scopeFilterForModel } from '../engine/access.js';
import { audit } from '../services/auditService.js';
import { assertPostingDate, getSettings } from '../services/settingsService.js';
import { todayIst } from '../utils/dates.js';
import { reasonSchema } from '../validators/schemas.js';
import { assertAuthorized } from '../engine/documents.js';
import { parseCsv, scaledInt } from '../engine/importExport.js';

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function ok(res, data, status = 200, meta) {
  res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });
}

// Builds a filter from the query string, allowing only named fields. Every value is
// forced to a string, so an operator object can never reach the database.
export function listQuery(req, { searchFields = [], filterFields = [] }) {
  const filter = {};
  for (const field of filterFields) {
    const value = req.query[field];
    if (typeof value === 'string' && value !== '') {
      if (value === 'true' || value === 'false') filter[field] = value === 'true';
      else filter[field] = value;
    }
  }
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q && searchFields.length) {
    const pattern = new RegExp(escapeRegex(q), 'i');
    filter.$or = searchFields.map((field) => ({ [field]: pattern }));
  }
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
  return { filter, page, limit };
}

// Adds a person's per-record limits to a list query.
export async function scopedList(req, Model, query) {
  const scope = await scopeFilterForModel(req.user, Model);
  return scope ? { ...query, filter: { $and: [query.filter, scope] } } : query;
}

// A limited person gets "not found" for any other record, on every route under /:id.
export const scopeParam = (Model, label) => async (req, _res, next, id) => {
  const scope = await scopeFilterForModel(req.user, Model);
  if (scope && !(await Model.exists({ $and: [{ _id: id }, scope] }))) throw notFound(label);
  next();
};

const bodyInScope = async (req, _res, next) => {
  if (!(await coreBodyInScope(req.user, req.body))) throw forbidden();
  next();
};

async function sendList(res, Model, { filter, page, limit }, sort) {
  const [rows, total] = await Promise.all([
    Model.find(filter).sort(sort).skip((page - 1) * limit).limit(limit),
    Model.countDocuments(filter),
  ]);
  ok(res, rows, 200, { page, limit, total });
}

// A person's spreadsheet holds 12.50 rupees and 1.5 kg, and the API holds whole numbers.
function importValue(key, text) {
  if (/(Paise|Minor|Bps)$/.test(key)) return scaledInt(text, 2);
  if (/Milli$/.test(key)) return scaledInt(text, 3);
  if (/(Days|Count)$/.test(key)) return scaledInt(text, 0);
  if (/^(is|has|requires)[A-Z]/.test(key)) return ['1', 'true', 'yes', 'y'].includes(text.toLowerCase());
  return text;
}

export function masterRouter({ Model, label, read, write, createSchema, updateSchema, searchFields, filterFields = [], sort = { code: 1 } }) {
  const router = Router();
  router.use(authenticate);
  router.param('id', requireObjectId);
  router.param('id', scopeParam(Model, label));

  router.get('/', requirePerm(read), async (req, res) => {
    await sendList(res, Model, await scopedList(req, Model, listQuery(req, { searchFields, filterFields })), sort);
  });

  router.get('/:id', requirePerm(read), async (req, res) => {
    const row = await Model.findById(req.params.id);
    if (!row) throw notFound(label);
    ok(res, row);
  });

  // Rows go through the same check as a typed record. A dry run checks and saves nothing.
  router.post('/import', requirePerm(write), async (req, res) => {
    const csv = typeof req.body?.csv === 'string' ? req.body.csv : '';
    const dryRun = req.body?.dryRun !== false;
    const rows = parseCsv(csv);
    if (rows.length < 2) throw rule('The file needs a heading row and at least one row of data.', 'EMPTY_FILE');
    if (rows.length > 5001) throw rule('A file can hold at most 5000 rows.', 'TOO_MANY_ROWS');
    const header = rows[0].map((h) => h.trim());
    const errors = [];
    let saved = 0;
    for (let index = 1; index < rows.length; index += 1) {
      try {
        const input = {};
        header.forEach((key, c) => {
          const value = (rows[index][c] ?? '').trim();
          if (value !== '' && key) input[key] = importValue(key, value);
        });
        const parsed = createSchema.parse(input);
        if (!dryRun) {
          await withTxn(async (session) => {
            const [created] = await Model.create([parsed], { session });
            await audit(session, { actor: req.user, action: `${label.toUpperCase()}_IMPORTED`, entityType: Model.modelName, entityId: created._id });
          });
        }
        saved += 1;
      } catch (error) {
        const message = error.issues ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') : error.message;
        errors.push({ row: index + 1, message: error.code === 11000 ? 'This one already exists.' : message });
      }
    }
    ok(res, { dryRun, total: rows.length - 1, ok: saved, errors: errors.slice(0, 200), errorCount: errors.length });
  });

  router.post('/', requirePerm(write), validate(createSchema), async (req, res) => {
    const row = await withTxn(async (session) => {
      const [created] = await Model.create([req.body], { session });
      await audit(session, { actor: req.user, action: `${label.toUpperCase()}_CREATED`, entityType: Model.modelName, entityId: created._id, entityNo: created.code ?? null });
      return created;
    });
    ok(res, row, 201);
  });

  router.patch('/:id', requirePerm(write), validate(updateSchema), bodyInScope, async (req, res) => {
    const row = await withTxn(async (session) => {
      const found = await Model.findById(req.params.id).session(session);
      if (!found) throw notFound(label);
      const before = {};
      for (const key of Object.keys(req.body)) before[key] = found.get(key);
      found.set(req.body);
      await found.save({ session });
      await audit(session, { actor: req.user, action: `${label.toUpperCase()}_UPDATED`, entityType: Model.modelName, entityId: found._id, entityNo: found.code ?? null, data: { before, after: req.body } });
      return found;
    });
    ok(res, row);
  });
  return router;
}

// Draft -> submit -> cancel for any document with a service of
// { Model, prepare(session, data), submit(session, doc, ctx), cancel(session, doc, ctx) }.
export function documentRouter({ service, label, read, write, createSchema, submitSchema, searchFields = ['docNo', 'partyName'], filterFields = ['status'], extend, submitPerm, cancelPerm }) {
  const { Model } = service;
  const router = Router();
  router.use(authenticate);
  router.param('id', requireObjectId);
  router.param('id', scopeParam(Model, label));

  router.get('/', requirePerm(read), async (req, res) => {
    await sendList(res, Model, await scopedList(req, Model, listQuery(req, { searchFields, filterFields })), { createdAt: -1 });
  });

  router.get('/:id', requirePerm(read), async (req, res) => {
    const row = await Model.findById(req.params.id);
    if (!row) throw notFound(label);
    ok(res, row);
  });

  router.post('/', requirePerm(write), validate(createSchema), bodyInScope, async (req, res) => {
    const row = await withTxn(async (session) => {
      const data = await service.prepare(session, { postingDate: todayIst(), ...req.body });
      const [created] = await Model.create([{ ...data, createdBy: req.user.id }], { session });
      return created;
    });
    ok(res, row, 201);
  });

  router.patch('/:id', requirePerm(write), validate(createSchema), bodyInScope, async (req, res) => {
    const row = await withTxn(async (session) => {
      const found = await Model.findById(req.params.id).session(session);
      if (!found) throw notFound(label);
      if (found.status !== 'DRAFT') throw conflict('Only a draft can be edited.', 'NOT_DRAFT');
      const data = await service.prepare(session, { postingDate: found.postingDate, ...req.body });
      found.set(data);
      await found.save({ session });
      return found;
    });
    ok(res, row);
  });

  // A draft is disposable: it has no number and has touched no ledger.
  router.delete('/:id', requirePerm(write), async (req, res) => {
    await withTxn(async (session) => {
      const found = await Model.findById(req.params.id).session(session);
      if (!found) throw notFound(label);
      if (found.status !== 'DRAFT') throw conflict('Only a draft can be deleted. Cancel it instead.', 'NOT_DRAFT');
      await Model.deleteOne({ _id: found._id }, { session });
    });
    ok(res, { deleted: true });
  });

  const submitChain = [requirePerm(submitPerm ?? write)];
  if (submitSchema) submitChain.push(validate(submitSchema));
  router.post('/:id/submit', ...submitChain, async (req, res) => {
    const row = await withTxn(async (session) => {
      const found = await Model.findById(req.params.id).session(session);
      if (!found) throw notFound(label);
      await assertAuthorized(session, Model.modelName, found, req.user);
      const settings = await getSettings(session);
      assertPostingDate(found.postingDate, settings);
      found.submittedBy = req.user.id;
      found.submittedAt = new Date();
      const result = await service.submit(session, found, { actor: req.user, body: req.body, settings });
      await found.save({ session });
      await audit(session, { actor: req.user, action: result.action, entityType: Model.modelName, entityId: found._id, entityNo: found.docNo, reason: result.reason, data: result.data });
      return found;
    });
    ok(res, row);
  });

  if (service.cancel) {
    router.post('/:id/cancel', requirePerm(cancelPerm ?? write), validate(reasonSchema), async (req, res) => {
      const row = await withTxn(async (session) => {
        const found = await Model.findById(req.params.id).session(session);
        if (!found) throw notFound(label);
        if (found.status === 'DRAFT') throw rule('A draft is deleted, not cancelled.', 'IS_DRAFT');
        if (found.status === 'CANCELLED') throw conflict('This is already cancelled.', 'ALREADY_CANCELLED');
        const postingDate = todayIst();
        const settings = await getSettings(session);
        assertPostingDate(postingDate, settings);
        await service.cancel(session, found, { actor: req.user, postingDate, reason: req.body.reason });
        found.cancelledBy = req.user.id;
        found.cancelledAt = new Date();
        found.cancelReason = req.body.reason;
        await found.save({ session });
        await audit(session, { actor: req.user, action: `${Model.modelName.toUpperCase()}_CANCELLED`, entityType: Model.modelName, entityId: found._id, entityNo: found.docNo, reason: req.body.reason });
        return found;
      });
      ok(res, row);
    });
  }

  if (extend) extend(router);
  return router;
}
