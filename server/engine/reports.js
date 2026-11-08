// Three ways to get a report:
//   1. defineReport with an aggregation: source doc, filters, group, sums. Most reports.
//   2. defineReport with run(): anything needing real logic.
//   3. runBuilder: a person picks fields on a screen, and can save the result.
import mongoose from 'mongoose';
import { getType } from './registry.js';
import { parseFields } from './dsl.js';
import { AppError, badRequest, forbidden, notFound } from '../utils/errors.js';
import { isLimited, scopeFilter, scopeFilterForModel } from './access.js';

const reports = new Map();

// columns: 'key:type[:Label]' separated by spaces, with _ for spaces in labels.
function parseColumns(spec) {
  return spec.trim().split(/\s+/).map((token) => {
    const [key, type = 'text', label] = token.split(':');
    return { key, type, label: label ? label.replace(/_/g, ' ') : key.replace(/(Paise|Milli|Bps|Id)$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^\w/, (c) => c.toUpperCase()) };
  });
}

export function defineReport(def) {
  if (reports.has(def.key)) throw new Error(`Report ${def.key} defined twice`);
  reports.set(def.key, {
    ...def,
    filterFields: parseFields(def.filters ?? ''),
    columnList: parseColumns(def.columns),
    totalKeys: def.totals ? def.totals.split(/\s+/) : [],
  });
}

function modelFor(source) {
  const type = getType(source);
  if (type) return { Model: type.Model, isEngine: true };
  const Model = mongoose.models[source];
  if (!Model) throw new Error(`Report source ${source} does not exist`);
  return { Model, isEngine: false };
}

// source + match + optional unwind + groupBy + sums, in a single pipeline.
async function runAggregation(def, filters, user) {
  const { Model, isEngine } = modelFor(def.source);
  const match = { ...(def.match ?? {}) };
  const scope = user ? (isEngine ? await scopeFilter(user, getType(def.source)) : await scopeFilterForModel(user, Model)) : null;
  if (scope) match.$and = [...(match.$and ?? []), ...scope.$and];
  if (def.dateField) {
    const range = {};
    if (filters.from) range.$gte = filters.from;
    if (filters.to) range.$lte = filters.to;
    if (Object.keys(range).length) match[def.dateField] = range;
  }
  for (const field of def.filterFields) {
    if (['from', 'to'].includes(field.key)) continue;
    const value = filters[field.key];
    if (value === undefined || value === '') continue;
    const path = def.filterPaths?.[field.key] ?? field.key;
    match[path] = field.type === 'link' && !isEngine && mongoose.isValidObjectId(value) ? new mongoose.Types.ObjectId(value) : value;
  }
  const pipeline = [{ $match: match }];
  if (def.unwind) pipeline.push({ $unwind: `$${def.unwind}` });
  if (def.lineMatch) pipeline.push({ $match: def.lineMatch });
  if (def.groupBy) {
    const groupId = Object.fromEntries(Object.entries(def.groupBy).map(([k, path]) => [k, `$${path}`]));
    const group = { _id: groupId };
    for (const [key, path] of Object.entries(def.sums ?? {})) group[key] = typeof path === 'number' ? { $sum: path } : { $sum: `$${path}` };
    pipeline.push({ $group: group });
    pipeline.push({ $replaceRoot: { newRoot: { $mergeObjects: ['$_id', '$$ROOT'] } } });
    pipeline.push({ $project: { _id: 0 } });
  } else if (def.project) {
    pipeline.push({ $project: { _id: 0, ...Object.fromEntries(Object.entries(def.project).map(([k, path]) => [k, `$${path}`])) } });
  }
  if (def.sort) pipeline.splice(def.sortFirst || def.project ? pipeline.findIndex((stage) => stage.$project) : pipeline.length, 0, { $sort: def.sort });
  pipeline.push({ $limit: def.limit ?? 5000 });
  return Model.aggregate(pipeline);
}

export async function runReport(key, query, user) {
  const def = reports.get(key);
  if (!def) throw notFound('That report');
  if (!def.roles.includes(user.role) && user.role !== 'ADMIN') throw forbidden();
  const filters = {};
  for (const field of def.filterFields) {
    const value = query[field.key];
    if (typeof value === 'string' && value !== '') filters[field.key] = value;
  }
  // A report with its own code adds up everything, so a limited person cannot have it.
  if (def.run && await isLimited(user)) throw new AppError(403, 'NOT_FOR_LIMITED_USERS', 'Your access is limited to some records, and this report covers everything.');
  let rows = def.run ? await def.run(filters, user) : await runAggregation(def, filters, user);
  if (def.after) rows = def.after(rows, filters);
  const totals = {};
  for (const totalKey of def.totalKeys) totals[totalKey] = rows.reduce((sum, row) => sum + (row[totalKey] ?? 0), 0);
  return { key, title: def.title, columns: def.columnList, rows, totals };
}

export function reportsMeta(role) {
  return [...reports.values()]
    .filter((def) => role === 'ADMIN' || def.roles.includes(role))
    .map((def) => ({ key: def.key, title: def.title, module: def.module, filters: def.filterFields, columns: def.columnList, chart: def.chart ?? null, totals: def.totalKeys }));
}

export const reportCount = () => reports.size;

/* ---------- Report builder ---------- */

const NUMERIC = new Set(['int', 'money', 'smoney', 'qty', 'sqty', 'pct']);

export async function runBuilder({ doctype, columns = [], groupBy = null, sums = [], filters = {}, limit = 2000 }, user = null) {
  const type = getType(doctype);
  if (!type) throw notFound('That document type');
  const scope = user ? await scopeFilter(user, type) : null;
  const fields = new Map(type.fields.map((f) => [f.key, f]));
  const extra = type.submittable ? ['status', 'postingDate', 'docNo'] : (type.series ? ['docNo'] : []);
  const allowed = (key) => fields.has(key) || extra.includes(key) || key === 'createdAt';
  const match = {};
  for (const [key, value] of Object.entries(filters)) {
    if (!allowed(key)) throw badRequest(`${key} is not a field of ${doctype}.`);
    if (typeof value !== 'string' && typeof value !== 'boolean' && typeof value !== 'number') throw badRequest('A filter must be a plain value.');
    match[key] = value;
  }
  if (groupBy) {
    if (!allowed(groupBy)) throw badRequest(`${groupBy} is not a field of ${doctype}.`);
    const group = { _id: `$${groupBy}`, count: { $sum: 1 } };
    for (const key of sums) {
      if (!NUMERIC.has(fields.get(key)?.type)) throw badRequest(`${key} cannot be added up.`);
      group[key] = { $sum: `$${key}` };
    }
    const labelsKey = fields.get(groupBy)?.type === 'link' ? `_labels.${groupBy}` : null;
    if (labelsKey) group.label = { $first: `$${labelsKey}` };
    const rows = await type.Model.aggregate([{ $match: scope ? { $and: [match, scope] } : match }, { $group: group }, { $sort: { count: -1 } }, { $limit: limit }]);
    return {
      columns: [{ key: 'group', label: fields.get(groupBy)?.label ?? groupBy, type: 'text' }, { key: 'count', label: 'Count', type: 'int' }, ...sums.map((key) => ({ key, label: fields.get(key).label, type: fields.get(key).type }))],
      rows: rows.map((row) => ({ ...row, group: row.label ?? (row._id === null ? '(blank)' : String(row._id)) })),
    };
  }
  const chosen = (columns.length ? columns : type.list).filter(allowed);
  const rows = await type.Model.find(scope ? { $and: [match, scope] } : match, Object.fromEntries([...chosen, '_labels'].map((k) => [k, 1]))).sort({ createdAt: -1 }).limit(limit).lean();
  return {
    columns: chosen.map((key) => ({ key, label: fields.get(key)?.label ?? key, type: fields.get(key)?.type ?? 'text' })),
    rows: rows.map((row) => {
      const out = { id: String(row._id) };
      for (const key of chosen) out[key] = row._labels?.[key] ?? row[key];
      return out;
    }),
  };
}

