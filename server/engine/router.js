// The API every engine document gets: /api/v1/d/:doctype and the shared record features.
import { Readable } from 'node:stream';
import express, { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { authenticate, requirePerm } from '../middleware/index.js';
import { allTypes, getType, metaOf } from './registry.js';
import { accessFor, allRoles, assertLinksInScope, clearAccessCache, scopeFilter } from './access.js';
import { cancelDoc, connections, createDoc, deleteDoc, resolveLinks, runWorkflow, setSelectField, submitDoc, updateDoc, workflowOptions } from './documents.js';
import { runBuilder, runReport, reportsMeta } from './reports.js';
import { reportBlocked } from '../services/policyService.js';
import { exportCsv, importCsv } from './importExport.js';
import { withTxn } from '../utils/txn.js';
import { badRequest, forbidden, notFound, rule } from '../utils/errors.js';
import { audit } from '../services/auditService.js';
import { AuditLog, User } from '../models/core.js';
import { Attachment, Comment, CustomField, EmailQueue, JobState, Notification, RolePermission, SavedReport, Todo } from '../models/platform.js';
import { notify } from '../services/notifyService.js';
import { searchCore } from '../services/homeService.js';

const ok = (res, data, status = 200, meta) => res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const parseOr400 = (error) => {
  if (error instanceof z.ZodError) {
    const fields = {};
    for (const issue of error.issues) fields[issue.path.join('.') || '_'] = issue.message;
    return badRequest('Please check the form.', { fields });
  }
  return error;
};
const guard = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (error) {
    throw parseOr400(error);
  }
};

const needs = (action) => async (req, _res, next) => {
  const type = getType(req.params.doctype);
  if (!type) throw notFound('That document type');
  const access = await accessFor(type.name, req.user.role);
  if (!access[action]) throw forbidden();
  req.docType = type;
  req.access = access;
  next();
};

function listFilter(req, type) {
  const filter = {};
  const known = new Map(type.fields.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value !== 'string' || value === '') continue;
    const field = known.get(key);
    if (field) {
      if (field.type === 'check') filter[key] = value === 'true';
      else if (['int', 'money', 'smoney', 'qty', 'sqty', 'pct', 'fx'].includes(field.type)) filter[key] = Number(value);
      else filter[key] = value;
    } else if (key === 'status' && type.submittable) {
      filter.status = value;
    } else if (key === 'from' || key === 'to') {
      const dateField = type.submittable ? 'postingDate' : type.dateField;
      if (dateField) {
        filter[dateField] = filter[dateField] ?? {};
        filter[dateField][key === 'from' ? '$gte' : '$lte'] = value;
      }
    }
  }
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q) {
    const pattern = new RegExp(escapeRegex(q), 'i');
    filter.$or = type.searchFields.map((field) => ({ [field]: pattern }));
  }
  return filter;
}

const withScope = async (req, type, filter) => {
  const scope = await scopeFilter(req.user, type);
  return scope ? { $and: [filter, scope] } : filter;
};

// Refuses a saved document whose link points somewhere this person is not allowed.
const linksAllowed = async (req, _res, next) => {
  const type = getType(req.params.doctype);
  const problem = type ? await assertLinksInScope(req.user, type, req.body) : null;
  if (problem) throw forbidden();
  next();
};

function docRoutes() {
  const r = Router({ mergeParams: true });
  // A person limited to some records gets "not found" for the rest, on every /:id route.
  r.use('/:doctype/:id', async (req, _res, next) => {
    const type = getType(req.params.doctype);
    if (!type || !mongoose.isValidObjectId(req.params.id)) return next();
    const scope = await scopeFilter(req.user, type);
    if (scope && !(await type.Model.exists({ $and: [{ _id: req.params.id }, scope] }))) throw notFound(type.name);
    return next();
  });
  r.get('/:doctype', needs('read'), async (req, res) => {
    const type = req.docType;
    const filter = await withScope(req, type, listFilter(req, type));
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const sortField = type.fields.some((f) => f.key === req.query.sort) ? req.query.sort : 'createdAt';
    const [rows, total] = await Promise.all([
      type.Model.find(filter).sort({ [sortField]: req.query.dir === 'asc' ? 1 : -1 }).skip((page - 1) * limit).limit(limit),
      type.Model.countDocuments(filter),
    ]);
    ok(res, rows, 200, { page, limit, total });
  });
  r.get('/:doctype/export', needs('read'), async (req, res) => {
    const csv = await exportCsv(req.docType, await withScope(req, req.docType, listFilter(req, req.docType)));
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${req.docType.name}.csv"`);
    res.send(csv);
  });
  r.post('/:doctype/import', needs('write'), guard(async (req, res) => {
    const body = z.strictObject({ csv: z.string().min(1), dryRun: z.boolean().optional() }).parse(req.body);
    ok(res, await importCsv(req.docType, body.csv, { dryRun: body.dryRun ?? true, actor: req.user }));
  }));
  r.get('/:doctype/:id', needs('read'), async (req, res) => {
    requireId(req.params.id);
    const row = await req.docType.Model.findById(req.params.id);
    if (!row) throw notFound(req.docType.name);
    ok(res, row);
  });
  r.get('/:doctype/:id/connections', needs('read'), async (req, res) => {
    requireId(req.params.id);
    ok(res, await connections(req.docType.name, req.params.id));
  });
  r.post('/:doctype', needs('write'), linksAllowed, guard(async (req, res) => {
    ok(res, await withTxn((s) => createDoc(s, req.docType.name, req.body, req.user)), 201);
  }));
  // One job applied to many, each in its own transaction, so one failure does not stop the rest.
  r.post('/:doctype/bulk', guard(async (req, res) => {
    const type = getType(req.params.doctype);
    if (!type) throw notFound('That document type');
    const body = z.strictObject({ action: z.enum(['submit', 'cancel', 'delete']), ids: z.array(z.string().regex(/^[0-9a-f]{24}$/)).min(1).max(200), reason: z.string().trim().min(1).max(500).optional() }).parse(req.body);
    const access = await accessFor(type.name, req.user.role);
    if (!access[body.action === 'delete' ? 'write' : body.action]) throw forbidden();
    if (body.action === 'cancel' && !body.reason) throw badRequest('Say why.');
    const scope = await scopeFilter(req.user, type);
    const results = [];
    for (const id of body.ids) {
      try {
        if (scope && !(await type.Model.exists({ $and: [{ _id: id }, scope] }))) throw notFound(type.name);
        const doc = await withTxn(async (s) => {
          if (body.action === 'submit') return submitDoc(s, type.name, id, req.user);
          if (body.action === 'cancel') return cancelDoc(s, type.name, id, body.reason, req.user);
          await deleteDoc(s, type.name, id, req.user);
          return null;
        });
        results.push({ id, ok: true, docNo: doc?.docNo ?? null });
      } catch (error) {
        const known = error.status && error.status < 500;
        results.push({ id, ok: false, message: known ? error.message : 'Something went wrong on our side.', code: known ? error.code : 'INTERNAL_ERROR' });
      }
    }
    ok(res, { done: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results });
  }));
  r.post('/:doctype/:id/set', needs('write'), linksAllowed, guard(async (req, res) => {
    requireId(req.params.id);
    const body = z.strictObject({ field: z.string().min(1).max(60), value: z.string().max(200) }).parse(req.body);
    ok(res, await withTxn((s) => setSelectField(s, req.docType.name, req.params.id, body.field, body.value, req.user)));
  }));
  r.patch('/:doctype/:id', needs('write'), linksAllowed, guard(async (req, res) => {
    requireId(req.params.id);
    ok(res, await withTxn((s) => updateDoc(s, req.docType.name, req.params.id, req.body, req.user)));
  }));
  r.delete('/:doctype/:id', needs('write'), async (req, res) => {
    requireId(req.params.id);
    await withTxn((s) => deleteDoc(s, req.docType.name, req.params.id, req.user));
    ok(res, { deleted: true });
  });
  r.post('/:doctype/:id/submit', needs('submit'), guard(async (req, res) => {
    requireId(req.params.id);
    ok(res, await withTxn((s) => submitDoc(s, req.docType.name, req.params.id, req.user, req.body)));
  }));
  r.post('/:doctype/:id/cancel', needs('cancel'), guard(async (req, res) => {
    requireId(req.params.id);
    const { reason } = z.strictObject({ reason: z.string().trim().min(1, 'Say why').max(500) }).parse(req.body);
    ok(res, await withTxn((s) => cancelDoc(s, req.docType.name, req.params.id, reason, req.user)));
  }));
  r.get('/:doctype/:id/workflow', needs('read'), async (req, res) => {
    requireId(req.params.id);
    const doc = await req.docType.Model.findById(req.params.id).lean();
    if (!doc) throw notFound(req.docType.name);
    ok(res, await workflowOptions(req.docType.name, doc, req.user.role));
  });
  r.post('/:doctype/:id/workflow', needs('read'), guard(async (req, res) => {
    requireId(req.params.id);
    const { action } = z.strictObject({ action: z.string().min(1).max(60) }).parse(req.body);
    ok(res, await withTxn((s) => runWorkflow(s, req.docType.name, req.params.id, action, req.user)));
  }));
  r.post('/:doctype/:id/a/:action', needs('write'), guard(async (req, res) => {
    requireId(req.params.id);
    const action = (req.docType.actions ?? []).find((a) => a.key === req.params.action);
    if (!action) throw notFound('That action');
    const access = action.perm ? await accessFor(req.docType.name, req.user.role) : null;
    if (action.perm && !access[action.perm]) throw forbidden();
    const result = await withTxn(async (session) => {
      const doc = await req.docType.Model.findById(req.params.id).session(session);
      if (!doc) throw notFound(req.docType.name);
      // The screen hides an action that does not apply, and the server refuses it anyway.
      for (const [key, allowed] of Object.entries(action.when ?? {})) {
        const value = doc.get(key) ?? null;
        if (!allowed.includes(value)) throw rule(`${action.label} is not available now.`, 'ACTION_NOT_AVAILABLE');
      }
      const input = action.schema.parse(req.body ?? {});
      await resolveLinks(session, { name: req.docType.name, fields: action.fieldDefs, tables: [] }, input);
      delete input._labels;
      const out = await action.run(session, doc, input, { actor: req.user, type: req.docType });
      await audit(session, { actor: req.user, action: `${req.docType.name.toUpperCase()}_${action.key.toUpperCase()}`, entityType: req.docType.name, entityId: doc._id, entityNo: doc.docNo ?? null, data: { input: req.body ?? {} } });
      return out ?? doc;
    });
    ok(res, result);
  }));
  return r;
}

const requireId = (value) => {
  if (!mongoose.isValidObjectId(value)) throw badRequest('That id is not valid.');
};

const SAFE_TYPES = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', csv: 'text/csv', txt: 'text/plain',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  dwg: 'application/acad', dxf: 'application/dxf', step: 'application/step', stp: 'application/step', zip: 'application/zip',
};
const MAX_UPLOAD = 15 * 1024 * 1024;
const entityQuery = z.object({ entityType: z.string().min(1).max(60), entityId: z.string().min(1).max(60) });

// A record's shared features use the read or write access of its own type. Hand-written
// documents fall back to any signed-in user being able to comment and attach.
async function assertEntity(req, action) {
  const type = getType(req.body?.entityType ?? req.query.entityType);
  if (!type) return;
  const access = await accessFor(type.name, req.user.role);
  if (!access[action]) throw forbidden();
  // Comments and files of a record someone cannot see are hidden along with the record.
  const entityId = req.body?.entityId ?? req.query.entityId;
  const scope = entityId ? await scopeFilter(req.user, type) : null;
  if (scope && mongoose.isValidObjectId(entityId) && !(await type.Model.exists({ $and: [{ _id: entityId }, scope] }))) throw notFound(type.name);
}

function recordRoutes() {
  const r = Router();
  r.use(authenticate);

  r.get('/meta', async (req, res) => {
    const out = [];
    for (const type of allTypes()) {
      const access = await accessFor(type.name, req.user.role);
      if (access.read) out.push(metaOf(type, access));
    }
    const custom = await CustomField.find().lean();
    const reports = [];
    for (const report of reportsMeta(req.user.role)) if (!(await reportBlocked(report, req.user.role))) reports.push(report);
    ok(res, { doctypes: out, reports, custom: custom.map(({ _id, ...rest }) => rest) });
  });

  r.get('/lookup/User', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const filter = { isActive: true, ...(q ? { name: new RegExp(escapeRegex(q), 'i') } : {}) };
    const rows = await User.find(filter, { name: 1, email: 1 }).sort({ name: 1 }).limit(25);
    ok(res, rows);
  });
  r.get('/lookup/User/:id', async (req, res) => {
    requireId(req.params.id);
    const row = await User.findById(req.params.id, { name: 1, email: 1 });
    if (!row) throw notFound('User');
    ok(res, row);
  });

  r.get('/search', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length < 2) return ok(res, []);
    const pattern = new RegExp(escapeRegex(q), 'i');
    // The documents people look for most come first.
    const hits = await searchCore(req.user, pattern);
    for (const type of allTypes()) {
      if (hits.length >= 40) break;
      const access = await accessFor(type.name, req.user.role);
      if (!access.read || type.searchFields.length === 0) continue;
      const scope = await scopeFilter(req.user, type);
      const found = { $or: type.searchFields.map((f) => ({ [f]: pattern })) };
      const rows = await type.Model.find(scope ? { $and: [found, scope] } : found).limit(5).lean();
      for (const row of rows) hits.push({ doctype: type.name, id: String(row._id), label: type.labelFields.map((k) => row[k]).filter(Boolean).join(' · ') });
    }
    return ok(res, hits);
  });

  r.use('/d', docRoutes());

  // Comments
  r.get('/comments', async (req, res) => {
    const { entityType, entityId } = entityQuery.parse(req.query);
    await assertEntity(req, 'read');
    ok(res, await Comment.find({ entityType, entityId }).sort({ createdAt: -1 }).limit(200));
  });
  r.post('/comments', guard(async (req, res) => {
    const body = entityQuery.extend({ body: z.string().trim().min(1).max(5000) }).strict().parse(req.body);
    await assertEntity(req, 'read');
    ok(res, await Comment.create({ ...body, byId: req.user.id, byName: req.user.name }), 201);
  }));

  // Timeline: who changed what, read from the audit chain.
  r.get('/timeline', async (req, res) => {
    const { entityType, entityId } = entityQuery.parse(req.query);
    await assertEntity(req, 'read');
    ok(res, await AuditLog.find({ entityType, entityId }).sort({ seq: -1 }).limit(100));
  });

  // Files live in GridFS. Only known safe types, and always downloaded rather than shown,
  // so an uploaded file can never run as a page on this site.
  r.get('/files', async (req, res) => {
    const { entityType, entityId } = entityQuery.parse(req.query);
    await assertEntity(req, 'read');
    ok(res, await Attachment.find({ entityType, entityId }).sort({ createdAt: -1 }));
  });
  r.post('/files', express.raw({ type: '*/*', limit: MAX_UPLOAD }), guard(async (req, res) => {
    const { entityType, entityId } = entityQuery.parse(req.query);
    await assertEntity(req, 'write');
    const filename = String(req.query.filename ?? '').replace(/[^\w.\- ]/g, '_').slice(0, 120);
    const extension = filename.split('.').pop().toLowerCase();
    const contentType = SAFE_TYPES[extension];
    if (!contentType) throw badRequest(`Files of type .${extension} cannot be attached.`);
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw badRequest('That file is empty.');
    const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'files' });
    const upload = bucket.openUploadStream(filename, { metadata: { entityType, entityId } });
    await new Promise((resolve, reject) => {
      Readable.from(req.body).pipe(upload).on('finish', resolve).on('error', reject);
    });
    const row = await withTxn(async (session) => {
      const [created] = await Attachment.create([{ entityType, entityId, fileId: upload.id, filename, contentType, sizeBytes: req.body.length, byId: req.user.id, byName: req.user.name }], { session });
      await audit(session, { actor: req.user, action: 'FILE_ATTACHED', entityType, entityId, data: { filename, sizeBytes: req.body.length } });
      return created;
    });
    ok(res, row, 201);
  }));
  r.get('/files/:id/download', async (req, res) => {
    requireId(req.params.id);
    const row = await Attachment.findById(req.params.id);
    if (!row) throw notFound('File');
    req.query.entityType = row.entityType;
    req.query.entityId = String(row.entityId);
    await assertEntity(req, 'read');
    res.setHeader('content-type', row.contentType);
    res.setHeader('content-disposition', `attachment; filename="${row.filename}"`);
    res.setHeader('x-content-type-options', 'nosniff');
    new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'files' }).openDownloadStream(row.fileId).pipe(res);
  });
  r.delete('/files/:id', async (req, res) => {
    requireId(req.params.id);
    const row = await Attachment.findById(req.params.id);
    if (!row) throw notFound('File');
    req.query.entityType = row.entityType;
    await assertEntity(req, 'write');
    await new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'files' }).delete(row.fileId);
    await withTxn(async (session) => {
      await Attachment.deleteOne({ _id: row._id }, { session });
      await audit(session, { actor: req.user, action: 'FILE_REMOVED', entityType: row.entityType, entityId: row.entityId, data: { filename: row.filename } });
    });
    ok(res, { deleted: true });
  });

  // Assignments
  r.get('/todos', async (req, res) => {
    const filter = req.query.entityId
      ? { entityType: String(req.query.entityType), entityId: String(req.query.entityId) }
      : { assignedTo: req.user.id, isDone: false };
    ok(res, await Todo.find(filter).sort({ isDone: 1, dueOn: 1, createdAt: -1 }).limit(200));
  });
  r.post('/todos', guard(async (req, res) => {
    const body = entityQuery.extend({
      entityLabel: z.string().max(200).optional(),
      assignedTo: z.string().refine(mongoose.isValidObjectId),
      note: z.string().trim().max(1000).optional(),
      dueOn: z.string().nullable().optional(),
    }).strict().parse(req.body);
    await assertEntity(req, 'read');
    const person = await User.findById(body.assignedTo);
    if (!person) throw notFound('User');
    const todo = await withTxn(async (session) => {
      const [created] = await Todo.create([{ ...body, assignedToName: person.name, assignedByName: req.user.name }], { session });
      await notify(session, person._id, `${req.user.name} assigned you ${body.entityLabel || body.entityType}`, `/${body.entityType}/${body.entityId}`);
      return created;
    });
    ok(res, todo, 201);
  }));
  r.patch('/todos/:id', async (req, res) => {
    requireId(req.params.id);
    const todo = await Todo.findById(req.params.id);
    if (!todo) throw notFound('Assignment');
    todo.isDone = req.body?.isDone === true;
    todo.doneAt = todo.isDone ? new Date() : null;
    await todo.save();
    ok(res, todo);
  });

  // Notifications
  r.get('/notifications', async (req, res) => {
    const [rows, unread] = await Promise.all([
      Notification.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(50),
      Notification.countDocuments({ userId: req.user.id, readAt: null }),
    ]);
    ok(res, rows, 200, { unread });
  });
  r.post('/notifications/read', async (req, res) => {
    await Notification.updateMany({ userId: req.user.id, readAt: null }, { readAt: new Date() });
    ok(res, { read: true });
  });

  // Report builder and declared reports
  r.post('/report-builder', guard(async (req, res) => {
    const body = z.strictObject({
      doctype: z.string(),
      columns: z.array(z.string()).max(40).optional(),
      groupBy: z.string().nullable().optional(),
      sums: z.array(z.string()).max(20).optional(),
      filters: z.record(z.string(), z.any()).optional(),
      limit: z.number().int().positive().max(5000).optional(),
    }).parse(req.body);
    const access = await accessFor(body.doctype, req.user.role);
    if (!access.read) throw forbidden();
    ok(res, await runBuilder(body, req.user));
  }));
  r.get('/saved-reports', async (req, res) => {
    ok(res, await SavedReport.find({ $or: [{ isShared: true }, { byId: req.user.id }] }).sort({ name: 1 }));
  });
  r.post('/saved-reports', guard(async (req, res) => {
    const body = z.strictObject({ name: z.string().trim().min(1).max(100), doctype: z.string(), columns: z.array(z.string()).optional(), groupBy: z.string().nullable().optional(), sums: z.array(z.string()).optional(), filters: z.record(z.string(), z.any()).optional(), isShared: z.boolean().optional() }).parse(req.body);
    ok(res, await SavedReport.create({ ...body, byId: req.user.id }), 201);
  }));
  r.get('/r/:report', async (req, res) => {
    ok(res, await runReport(req.params.report, req.query, req.user));
  });

  // Admin: custom fields, role permissions, jobs, email queue
  r.get('/admin/custom-fields', requirePerm('settings.write'), async (_req, res) => ok(res, await CustomField.find().sort({ doctype: 1, key: 1 })));
  r.post('/admin/custom-fields', requirePerm('settings.write'), guard(async (req, res) => {
    const body = z.strictObject({
      doctype: z.string().refine((name) => Boolean(getType(name)), 'Unknown document type'),
      key: z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/, 'Letters and digits, starting with a small letter'),
      label: z.string().trim().min(1).max(80),
      type: z.enum(['text', 'long', 'int', 'check', 'date', 'select', 'money', 'qty']),
      options: z.array(z.string().trim().min(1)).optional(),
      required: z.boolean().optional(),
    }).parse(req.body);
    const row = await withTxn(async (session) => {
      const [created] = await CustomField.create([body], { session });
      await audit(session, { actor: req.user, action: 'CUSTOM_FIELD_ADDED', entityType: 'CustomField', entityId: created._id, data: body });
      return created;
    });
    ok(res, row, 201);
  }));
  r.delete('/admin/custom-fields/:id', requirePerm('settings.write'), async (req, res) => {
    requireId(req.params.id);
    await withTxn(async (session) => {
      const row = await CustomField.findById(req.params.id).session(session);
      if (!row) throw notFound('Custom field');
      await CustomField.deleteOne({ _id: row._id }, { session });
      await audit(session, { actor: req.user, action: 'CUSTOM_FIELD_REMOVED', entityType: 'CustomField', entityId: row._id, data: { doctype: row.doctype, key: row.key } });
    });
    ok(res, { deleted: true });
  });
  r.get('/admin/role-permissions', requirePerm('users.manage'), async (req, res) => {
    const doctype = String(req.query.doctype ?? '');
    if (!getType(doctype)) throw notFound('That document type');
    const rows = [];
    for (const role of allRoles()) rows.push({ role, ...(await accessFor(doctype, role)) });
    ok(res, rows);
  });
  r.post('/admin/role-permissions', requirePerm('users.manage'), guard(async (req, res) => {
    const body = z.strictObject({ doctype: z.string(), role: z.string(), read: z.boolean(), write: z.boolean(), submit: z.boolean(), cancel: z.boolean() }).parse(req.body);
    if (!getType(body.doctype)) throw notFound('That document type');
    await withTxn(async (session) => {
      await RolePermission.findOneAndUpdate({ doctype: body.doctype, role: body.role }, body, { upsert: true, session, setDefaultsOnInsert: true });
      await audit(session, { actor: req.user, action: 'ROLE_PERMISSION_CHANGED', entityType: 'RolePermission', entityNo: body.doctype, data: body });
    });
    clearAccessCache();
    ok(res, body);
  }));
  r.get('/admin/jobs', requirePerm('settings.write'), async (_req, res) => ok(res, await JobState.find().sort({ _id: 1 })));
  r.get('/admin/email-queue', requirePerm('settings.write'), async (_req, res) => ok(res, await EmailQueue.find().sort({ createdAt: -1 }).limit(100)));

  return r;
}

export const engineRouter = recordRoutes;
