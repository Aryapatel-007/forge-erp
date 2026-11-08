// The lifecycle every engine document shares. Routes, hooks, imports and scheduled jobs
// all come through here, so the rules apply whichever way a record arrives.
import { z } from 'zod';
import { getType, linkTarget, linksTo, modelOf } from './registry.js';
import { User } from '../models/core.js';
import { notify, queueEmail } from '../services/notifyService.js';
import { CustomField } from '../models/platform.js';
import { badRequest, conflict, notFound, rule } from '../utils/errors.js';
import { isDateString, todayIst } from '../utils/dates.js';
import { audit } from '../services/auditService.js';
import { reverseGl } from '../services/ledgerService.js';
import { reverseStock } from '../services/stockService.js';
import { nextDocNo } from '../services/numberService.js';
import { assertPostingDate, getSettings } from '../services/settingsService.js';

const labelOf = (row, labelFields) => labelFields.map((key) => row[key]).filter((v) => v !== null && v !== undefined && v !== '').join(' · ');

// Checks that every link points at something real, and freezes its label on the record,
// so a list never has to look it up and an old record keeps the name it was made with.
export async function resolveLinks(session, type, data) {
  const wanted = new Map();
  const note = (field, value) => {
    if (value === null || value === undefined || value === '') return;
    if (!wanted.has(field.link)) wanted.set(field.link, new Set());
    wanted.get(field.link).add(String(value));
  };
  for (const field of type.fields) if (field.link) note(field, data[field.key]);
  for (const table of type.tables) {
    for (const row of data[table.key] ?? []) for (const field of table.fields) if (field.link) note(field, row[field.key]);
  }

  const found = new Map();
  const rowsByValue = new Map();
  for (const [name, values] of wanted) {
    const target = linkTarget(name);
    const key = target.valueKey ?? '_id';
    const rows = await target.Model.find({ [key]: { $in: [...values] } }).session(session).lean().catch(() => {
      throw badRequest(`A value for ${name} is not valid.`);
    });
    for (const value of values) {
      const row = rows.find((r) => String(r[key]) === value);
      if (!row) throw rule(`That ${name} does not exist.`, 'LINK_NOT_FOUND', { doctype: name, value });
      rowsByValue.set(`${name}|${value}`, row);
      found.set(`${name}|${value}`, labelOf(row, target.labelFields));
    }
  }

  // A link limited to, say, suppliers really is limited, not only in the picker.
  const assertFilter = (field, value) => {
    for (const [key, wantedValue] of Object.entries(field.linkFilter ?? {})) {
      const row = rowsByValue.get(`${field.link}|${value}`);
      if (String(row?.[key]) !== wantedValue) throw rule(`${field.label}: that ${field.link} is not allowed here.`, 'LINK_NOT_ALLOWED');
    }
  };
  const labels = {};
  for (const field of type.fields) {
    const value = data[field.key];
    if (field.link && value) {
      assertFilter(field, value);
      labels[field.key] = found.get(`${field.link}|${value}`);
    }
  }
  data._labels = labels;
  for (const table of type.tables) {
    for (const row of data[table.key] ?? []) {
      const rowLabels = {};
      for (const field of table.fields) {
        if (field.link && row[field.key]) {
          assertFilter(field, row[field.key]);
          rowLabels[field.key] = found.get(`${field.link}|${row[field.key]}`);
        }
      }
      row._labels = rowLabels;
    }
  }
  return data;
}

async function validateCustom(session, type, data) {
  const defs = await CustomField.find({ doctype: type.name }).session(session).lean();
  if (defs.length === 0) {
    delete data.custom;
    return;
  }
  const input = data.custom ?? {};
  const output = {};
  for (const def of defs) {
    const value = input[def.key];
    if (value === undefined || value === null || value === '') {
      if (def.required) throw badRequest(`${def.label} is required.`);
      continue;
    }
    const schema = {
      text: z.string().max(500),
      long: z.string().max(20000),
      int: z.number().int(),
      money: z.number().int(),
      qty: z.number().int(),
      check: z.boolean(),
      date: z.string(),
      select: z.enum(def.options?.length ? def.options : ['']),
    }[def.type];
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw badRequest(`${def.label} is not valid.`);
    output[def.key] = parsed.data;
  }
  data.custom = output;
}

const dropNulls = (row) => {
  const out = { ...row };
  for (const [key, value] of Object.entries(out)) if (value === null) delete out[key];
  return out;
};

function clean(type, data) {
  const out = { ...data };
  for (const [key, value] of Object.entries(out)) if (value === null) out[key] = undefined;
  for (const table of type.tables) if (out[table.key]) out[table.key] = out[table.key].map(dropNulls);
  return out;
}

// A row that came back from an edit keeps its id, so anything pointing at it stays true.
const keepRowIds = (rows) => rows.map(({ id, ...row }) => ({ ...dropNulls(row), ...(id ? { _id: id } : {}) }));

// A rule tells everyone in a role that something happened to a document.
async function fireRules(session, type, doc, event) {
  if (['NotificationRule', 'Workflow'].includes(type.name)) return;
  const rules = await modelOf('NotificationRule').find({ doctypeName: type.name, event, isActive: true }).session(session).lean();
  for (const row of rules) {
    const users = await User.find({ role: row.role, isActive: true }, { email: 1 }).session(session).lean();
    const title = `${type.label ?? type.name} ${doc.docNo ?? ''} ${event.toLowerCase()}`.replace(/\s+/g, ' ');
    for (const user of users) {
      await notify(session, user._id, title, `/${type.name}/${doc._id}`);
      if (row.sendEmail) await queueEmail(session, { to: user.email, subject: title, body: title });
    }
  }
}

async function activeWorkflow(session, type) {
  return modelOf('Workflow').findOne({ doctypeName: type.name, isActive: true }).session(session).lean();
}

async function assertWorkflowAllowsSubmit(session, type, doc) {
  const flow = await activeWorkflow(session, type);
  if (flow && (doc.workflowState ?? flow.startState) !== flow.approvedState) {
    throw rule(`This must reach "${flow.approvedState}" before it can be submitted. It is at "${doc.workflowState ?? flow.startState}".`, 'WORKFLOW_NOT_APPROVED');
  }
}

export async function runWorkflow(session, typeName, id, action, actor) {
  const type = getType(typeName);
  const doc = await type.Model.findById(id).session(session);
  if (!doc) throw notFound(type.name);
  const flow = await activeWorkflow(session, type);
  if (!flow) throw rule('This document has no workflow.', 'NO_WORKFLOW');
  const state = doc.workflowState ?? flow.startState;
  const step = flow.transitions.find((t) => t.fromState === state && t.action === action);
  if (!step) throw rule(`"${action}" is not available from "${state}".`, 'BAD_TRANSITION');
  if (actor.role !== 'ADMIN' && step.role !== actor.role) throw rule(`Only ${step.role} can do this.`, 'WRONG_ROLE');
  if (doc.createdBy && String(doc.createdBy) === String(actor.id) && step.toState === flow.approvedState && actor.role !== 'ADMIN') {
    throw rule('Whoever made a document cannot give it the final approval.', 'SELF_APPROVAL');
  }
  doc.workflowState = step.toState;
  await doc.save({ session });
  await audit(session, { actor, action: 'WORKFLOW_STEP', entityType: type.name, entityId: doc._id, entityNo: doc.docNo ?? null, data: { from: state, action, to: step.toState } });
  return doc;
}

export async function workflowOptions(typeName, doc, role) {
  const flow = await modelOf('Workflow').findOne({ doctypeName: typeName, isActive: true }).lean();
  if (!flow) return null;
  const state = doc.workflowState ?? flow.startState;
  return { state, approvedState: flow.approvedState, actions: flow.transitions.filter((t) => t.fromState === state && (role === 'ADMIN' || t.role === role)).map((t) => t.action) };
}

export async function createDoc(session, typeName, input, actor, { skipHooks = false } = {}) {
  const type = getType(typeName);
  const parsed = type.schemaFor.parse(input);
  let data = { ...parsed };
  if (type.submittable && !data.postingDate) data.postingDate = todayIst();
  await validateCustom(session, type, data);
  if (type.prepare && !skipHooks) data = await type.prepare(session, data, { actor, type, isNew: true });
  await resolveLinks(session, type, data);
  if (type.series && !type.submittable) data.docNo = await nextDocNo(session, type.series, todayIst());
  const [doc] = await type.Model.create([{ ...clean(type, data), createdBy: actor?.id ?? null, createdByName: actor?.name ?? 'System' }], { session });
  if (type.afterCreate && !skipHooks) await type.afterCreate(session, doc, { actor, type });
  if (!type.submittable) {
    await audit(session, { actor, action: `${type.name.toUpperCase()}_CREATED`, entityType: type.name, entityId: doc._id, entityNo: doc.docNo ?? labelOf(doc, type.labelFields) });
  }
  await fireRules(session, type, doc, 'CREATED');
  return doc;
}

const AUDIT_SKIP = new Set(['_labels', 'updatedAt']);

export async function updateDoc(session, typeName, id, input, actor) {
  const type = getType(typeName);
  const doc = await type.Model.findById(id).session(session);
  if (!doc) throw notFound(type.name);
  if (type.submittable && doc.status !== 'DRAFT') throw conflict('Only a draft can be edited.', 'NOT_DRAFT');
  if (type.lockedWhen?.(doc)) throw conflict('This record can no longer be edited.', 'LOCKED');
  const parsed = type.schemaFor.parse(input);
  let data = { ...parsed };
  await validateCustom(session, type, data);
  if (type.prepare) data = await type.prepare(session, { ...doc.toObject(), ...data }, { actor, type, isNew: false, existing: doc });
  await resolveLinks(session, type, data);

  const before = {};
  const allowed = [...type.fields.map((f) => f.key), ...type.tables.map((t) => t.key), 'custom', 'tags', '_labels', 'postingDate'];
  for (const key of allowed) {
    if (!(key in data)) continue;
    if (data[key] === null) {
      const field = type.fields.find((f) => f.key === key);
      if (field?.required) throw badRequest(`${field.label} is required.`);
      const schemaPath = type.Model.schema.path(key);
      const fallback = schemaPath?.defaultValue;
      if (!AUDIT_SKIP.has(key)) before[key] = doc.get(key);
      doc.set(key, typeof fallback === 'function' ? fallback() : fallback ?? null);
    } else {
      const isTable = type.tables.some((t) => t.key === key);
      if (!AUDIT_SKIP.has(key) && !isTable) before[key] = doc.get(key);
      doc.set(key, isTable ? keepRowIds(data[key]) : data[key]);
    }
  }
  await doc.save({ session });
  if (type.afterUpdate) await type.afterUpdate(session, doc, { actor, type });
  if (!type.submittable) {
    const changedBefore = {};
    const changedAfter = {};
    for (const [key, value] of Object.entries(before)) {
      const next = doc.get(key);
      if (JSON.stringify(value ?? null) !== JSON.stringify(next ?? null)) {
        changedBefore[key] = value ?? null;
        changedAfter[key] = next ?? null;
      }
    }
    await audit(session, { actor, action: `${type.name.toUpperCase()}_UPDATED`, entityType: type.name, entityId: doc._id, entityNo: doc.docNo ?? labelOf(doc, type.labelFields), data: { before: changedBefore, after: changedAfter } });
  }
  return doc;
}

// One select field on its own, for a Kanban board. Only what a person could type in a form.
export async function setSelectField(session, typeName, id, key, value, actor) {
  const type = getType(typeName);
  const doc = await type.Model.findById(id).session(session);
  if (!doc) throw notFound(type.name);
  const field = type.fields.find((f) => f.key === key);
  if (!field || !['select', 'date'].includes(field.type) || field.computed) throw rule('That field cannot be set here.', 'NOT_SETTABLE');
  if (field.type === 'select' && !field.options.includes(value)) throw rule('That is not one of the choices.', 'BAD_CHOICE');
  if (field.type === 'date' && !isDateString(value)) throw rule('That is not a real date.', 'INVALID_DATE');
  if (type.submittable && doc.status !== 'DRAFT') throw conflict('Only a draft can be edited.', 'NOT_DRAFT');
  if (type.lockedWhen?.(doc)) throw conflict('This record can no longer be edited.', 'LOCKED');
  if (type.prepare) await type.prepare(session, { ...doc.toObject(), [key]: value }, { actor, type, isNew: false, existing: doc });
  const before = doc.get(key);
  doc.set(key, value);
  await doc.save({ session });
  await audit(session, { actor, action: `${type.name.toUpperCase()}_UPDATED`, entityType: type.name, entityId: doc._id, entityNo: doc.docNo ?? labelOf(doc, type.labelFields), data: { before: { [key]: before }, after: { [key]: value } } });
  return doc;
}

// A role that is not named on a rule cannot submit a document over that rule's limit.
export async function assertAuthorized(session, typeName, doc, actor) {
  if (!actor || actor.role === 'ADMIN') return;
  const rules = await modelOf('AuthorizationRule').find({ doctypeName: typeName }).session(session).lean();
  for (const row of rules) {
    if (row.approvingRole === actor.role) continue;
    if (row.basedOn === 'DISCOUNT_PERCENT') {
      const highest = Math.max(0, ...(doc.lines ?? []).map((line) => line.discountBps ?? 0));
      // The limit is held in the same two-decimal field, so 10.00 means 10 percent.
      if (highest > row.limitPaise) throw rule(`A discount over ${row.limitPaise / 100}% needs ${row.approvingRole} to submit it.`, 'NEEDS_AUTHORITY', { role: row.approvingRole });
    } else {
      const total = doc.totalPaise ?? doc.subtotalMinor ?? 0;
      if (total > row.limitPaise) throw rule(`Over ${row.limitPaise / 100} needs ${row.approvingRole} to submit it.`, 'NEEDS_AUTHORITY', { role: row.approvingRole });
    }
  }
}

export async function submitDoc(session, typeName, id, actor, body = {}) {
  const type = getType(typeName);
  if (!type.submittable) throw rule('This record has no submit step.');
  const doc = await type.Model.findById(id).session(session);
  if (!doc) throw notFound(type.name);
  if (doc.status !== 'DRAFT') throw conflict('Only a draft can be submitted.', 'NOT_DRAFT');
  await assertWorkflowAllowsSubmit(session, type, doc);
  await assertAuthorized(session, type.name, doc, actor);
  const settings = await getSettings(session);
  assertPostingDate(doc.postingDate, settings);
  if (type.series) doc.docNo = await nextDocNo(session, type.series, doc.postingDate);
  doc.status = type.submittedStatus ?? 'SUBMITTED';
  doc.submittedBy = actor?.id ?? null;
  doc.submittedAt = new Date();
  const result = type.onSubmit ? await type.onSubmit(session, doc, { actor, body, settings, type }) : null;
  await doc.save({ session });
  await audit(session, { actor, action: result?.action ?? `${type.name.toUpperCase()}_SUBMITTED`, entityType: type.name, entityId: doc._id, entityNo: doc.docNo, reason: result?.reason, data: result?.data });
  await fireRules(session, type, doc, 'SUBMITTED');
  return doc;
}

export async function cancelDoc(session, typeName, id, reason, actor) {
  const type = getType(typeName);
  if (!type.submittable) throw rule('This record has no cancel step.');
  const doc = await type.Model.findById(id).session(session);
  if (!doc) throw notFound(type.name);
  if (doc.status === 'DRAFT') throw rule('A draft is deleted, not cancelled.', 'IS_DRAFT');
  if (doc.status === 'CANCELLED') throw conflict('This is already cancelled.', 'ALREADY_CANCELLED');
  const postingDate = todayIst();
  assertPostingDate(postingDate, await getSettings(session));
  const voucher = { voucherType: type.name, voucherId: doc._id, voucherNo: doc.docNo ?? String(doc._id), postingDate };
  if (type.onCancel) await type.onCancel(session, doc, { actor, postingDate, reason, voucher, type });
  await reverseStock(session, voucher);
  await reverseGl(session, voucher);
  doc.status = 'CANCELLED';
  doc.cancelledBy = actor?.id ?? null;
  doc.cancelledAt = new Date();
  doc.cancelReason = reason;
  await doc.save({ session });
  await audit(session, { actor, action: `${type.name.toUpperCase()}_CANCELLED`, entityType: type.name, entityId: doc._id, entityNo: doc.docNo, reason });
  await fireRules(session, type, doc, 'CANCELLED');
  return doc;
}

// Drafts always, and types marked deletable if nothing points at them.
export async function deleteDoc(session, typeName, id, actor) {
  const type = getType(typeName);
  const doc = await type.Model.findById(id).session(session);
  if (!doc) throw notFound(type.name);
  const isDraft = type.submittable && doc.status === 'DRAFT';
  if (!isDraft && !type.deletable) throw conflict('This cannot be deleted. Cancel it or switch it off instead.', 'NOT_DELETABLE');
  for (const link of linksTo(type.name)) {
    const count = await link.Model.countDocuments({ [link.path]: String(doc._id) }).session(session);
    if (count > 0) throw conflict(`${link.doctype} records still point at this.`, 'STILL_LINKED', { doctype: link.doctype, count });
  }
  await type.Model.deleteOne({ _id: doc._id }, { session });
  if (type.afterDelete) await type.afterDelete(session, doc);
  await audit(session, { actor, action: `${type.name.toUpperCase()}_DELETED`, entityType: type.name, entityId: doc._id, entityNo: doc.docNo ?? labelOf(doc, type.labelFields) });
}

export async function connections(typeName, id, session = null) {
  const out = [];
  for (const link of linksTo(typeName)) {
    const count = await link.Model.countDocuments({ [link.path]: String(id) }).session(session);
    if (count > 0) out.push({ doctype: link.doctype, field: link.path, count });
  }
  return out;
}
