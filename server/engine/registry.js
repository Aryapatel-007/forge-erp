// Every document type in the system lives here. Defining one gives it a model and
// validation; the router gives it an API; the client draws its screens from the meta.
import mongoose from 'mongoose';
import { z } from 'zod';
import { baseOptions } from '../models/plugins.js';
import { isDateString } from '../utils/dates.js';
import { parseFields } from './dsl.js';

const { Schema } = mongoose;
const INT_MAX = 1e15;

const types = new Map();
const externals = new Map();

// Hand-written models other documents can link to.
export function registerExternal(name, { Model, endpoint, labelFields, valueKey = '_id', searchFields }) {
  externals.set(name, { name, Model, endpoint, labelFields, valueKey, searchFields: searchFields ?? labelFields });
}

const intValidator = { validator: Number.isSafeInteger, message: '{PATH} must be a whole number' };
const dateValidator = { validator: (v) => v === null || v === '' || isDateString(v), message: '{PATH} is not a real date' };

function mongooseField(field) {
  const base = {};
  if (field.default !== undefined) base.default = field.default;
  switch (field.type) {
    case 'check': return { type: Boolean, default: field.default ?? false };
    case 'int': case 'sqty': case 'smoney': return { type: Number, default: field.default ?? 0, validate: intValidator };
    case 'money': case 'qty': case 'pct': case 'fx': return { type: Number, min: 0, default: field.default ?? 0, validate: intValidator };
    case 'date': return { type: String, default: field.default ?? null, validate: dateValidator };
    case 'datetime': return { type: Date, default: null };
    case 'select': return { type: String, enum: [...field.options, null, ''], default: field.default ?? null };
    case 'link': return { type: Schema.Types.Mixed, default: null };
    default: return { type: String, default: field.default ?? '' };
  }
}

function zodField(field) {
  let schema;
  switch (field.type) {
    case 'check': schema = z.boolean(); break;
    case 'int': schema = z.number().int().min(-INT_MAX).max(INT_MAX); break;
    case 'sqty': case 'smoney': schema = z.number().int().min(-INT_MAX).max(INT_MAX); break;
    case 'money': case 'qty': case 'pct': case 'fx': schema = z.number().int().min(0).max(INT_MAX); break;
    case 'date': schema = z.string().refine(isDateString, 'Not a real date'); break;
    case 'datetime': schema = z.iso.datetime({ offset: true }); break;
    case 'select': schema = z.enum(field.options); break;
    case 'link': schema = z.string().min(1).max(60); break;
    case 'email': schema = z.union([z.literal(''), z.string().trim().email()]); break;
    case 'long': schema = z.string().trim().max(20000); break;
    case 'bigtext': schema = z.string().max(2000000); break;
    default: schema = z.string().trim().max(500);
  }
  if (field.required) {
    if (field.type === 'bigtext') schema = z.string().min(1, 'Required').max(2000000);
    else if (['text', 'long', 'email', 'phone'].includes(field.type)) schema = z.string().trim().min(1, 'Required').max(field.type === 'long' ? 20000 : 500);
    return field.default !== undefined ? schema.optional() : schema;
  }
  return schema.nullable().optional();
}

const extensions = new Map();

// Adds fields, tables, hooks or actions to a type defined elsewhere. Must run first.
export function extend(name, extension) {
  if (types.has(name)) throw new Error(`${name} is already defined, so it can no longer be extended`);
  extensions.set(name, [...(extensions.get(name) ?? []), extension]);
}

function withExtensions(def) {
  let out = def;
  for (const ext of extensions.get(def.name) ?? []) {
    const { fields, tables, actions, prepare, onSubmit, onCancel, afterCreate, afterUpdate, ...rest } = ext;
    const merged = { ...out, ...rest };
    if (fields) merged.fields = `${out.fields ?? ''} ${fields}`;
    if (tables) {
      merged.tables = { ...(out.tables ?? {}) };
      for (const [key, spec] of Object.entries(tables)) merged.tables[key] = merged.tables[key] ? `${merged.tables[key]} ${spec}` : spec;
    }
    if (actions) merged.actions = [...(out.actions ?? []), ...actions];
    if (prepare) {
      const first = out.prepare;
      merged.prepare = first ? async (s, data, ctx) => prepare(s, await first(s, data, ctx), ctx) : prepare;
    }
    for (const [key, hook] of Object.entries({ onSubmit, onCancel, afterCreate, afterUpdate })) {
      if (!hook) continue;
      const first = out[key];
      // The original's result is what gets audited, so it is the one returned.
      merged[key] = first ? async (...args) => { const result = await first(...args); await hook(...args); return result; } : hook;
    }
    out = merged;
  }
  extensions.delete(def.name);
  return out;
}

export function define(rawDef) {
  if (types.has(rawDef.name)) throw new Error(`Doctype ${rawDef.name} is defined twice`);
  const def = withExtensions(rawDef);
  const fields = parseFields(def.fields, def.labels);
  // A table named with a trailing ~ is filled in by the server only.
  const tables = Object.entries(def.tables ?? {}).map(([rawKey, spec]) => {
    const key = rawKey.replace(/~$/, '');
    return {
      key,
      type: 'table',
      computed: rawKey.endsWith('~'),
      label: def.labels?.[key] ?? key.charAt(0).toUpperCase() + key.slice(1),
      fields: parseFields(spec, def.labels),
    };
  });

  const shape = {};
  for (const field of fields) shape[field.key] = mongooseField(field);
  for (const table of tables) {
    const row = {};
    for (const field of table.fields) row[field.key] = mongooseField(field);
    row._labels = { type: Schema.Types.Mixed, default: undefined };
    shape[table.key] = [new Schema(row, { toJSON: baseOptions.toJSON, toObject: baseOptions.toObject })];
  }
  const system = {
    _labels: { type: Schema.Types.Mixed, default: undefined },
    custom: { type: Schema.Types.Mixed, default: undefined },
    tags: { type: [String], default: undefined },
    workflowState: { type: String, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
  };
  if (def.series) system.docNo = { type: String, default: null };
  if (def.submittable) {
    Object.assign(system, {
      status: { type: String, default: 'DRAFT' },
      postingDate: { type: String, required: true },
      submittedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
      submittedAt: { type: Date, default: null },
      cancelledBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
      cancelledAt: { type: Date, default: null },
      cancelReason: { type: String, default: null },
    });
  }
  const schema = new Schema({ ...shape, ...system }, { ...baseOptions, collection: `d_${def.name.toLowerCase()}`, strict: true, minimize: false });
  if (def.series) schema.index({ docNo: 1 }, { unique: true, partialFilterExpression: { docNo: { $type: 'string' } } });
  for (const field of fields) if (field.unique) schema.index({ [field.key]: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
  schema.index({ createdAt: -1 });
  if (def.submittable) schema.index({ status: 1, postingDate: -1 });
  for (const field of fields) if (field.type === 'link') schema.index({ [field.key]: 1 });
  for (const index of def.index ?? []) {
    if (index.keys) schema.index(index.keys, index.options);
    else schema.index(index);
  }

  const Model = mongoose.models[`D${def.name}`] ?? mongoose.model(`D${def.name}`, schema);

  const entry = {
    ...def,
    actions: (def.actions ?? []).map((action) => ({ ...action, schema: actionSchema(action, def), fieldDefs: parseFields(action.fields ?? '', def.labels) })),
    fields,
    tables,
    Model,
    labelFields: def.labelFields ?? [fields.find((f) => f.type === 'text' && f.required)?.key ?? fields[0]?.key, ...(def.series ? ['docNo'] : [])].filter(Boolean),
    searchFields: def.searchFields ?? [...(def.series ? ['docNo'] : []), ...fields.filter((f) => ['text', 'email', 'phone'].includes(f.type)).slice(0, 4).map((f) => f.key)],
    list: def.list ? def.list.split(/\s+/) : fields.filter((f) => f.type !== 'long').slice(0, 6).map((f) => f.key),
  };
  entry.schemaFor = buildZod(entry);
  types.set(def.name, entry);
  return Model;
}

function actionSchema(action, def) {
  const shape = {};
  for (const field of parseFields(action.fields ?? '', def.labels)) shape[field.key] = zodField(field);
  return z.strictObject(shape);
}

function buildZod(def) {
  const shape = {};
  for (const field of def.fields) if (!field.computed) shape[field.key] = zodField(field);
  for (const table of def.tables) {
    if (table.computed) continue;
    const row = { id: z.string().optional() };
    for (const field of table.fields) if (!field.computed) row[field.key] = zodField(field);
    shape[table.key] = z.array(z.strictObject(row)).max(2000).optional();
  }
  shape.custom = z.record(z.string(), z.any()).nullable().optional();
  shape.tags = z.array(z.string().trim().max(40)).max(30).optional();
  if (def.submittable) shape.postingDate = z.string().refine(isDateString, 'Not a real date').optional();
  return z.strictObject(shape);
}

export const getType = (name) => types.get(name);
export const allTypes = () => [...types.values()];
export const modelOf = (name) => {
  const type = types.get(name);
  if (!type) throw new Error(`Unknown doctype ${name}`);
  return type.Model;
};

export function linkTarget(name) {
  const type = types.get(name);
  if (type) return { Model: type.Model, labelFields: type.labelFields, valueKey: '_id', endpoint: `/d/${name}`, isEngine: true };
  const external = externals.get(name);
  if (external) return external;
  throw new Error(`Link target ${name} does not exist`);
}

// Every field anywhere that points at this doctype, for "connections" and delete guards.
export function linksTo(name) {
  const found = [];
  for (const type of types.values()) {
    for (const field of type.fields) if (field.link === name) found.push({ doctype: type.name, path: field.key, Model: type.Model });
    for (const table of type.tables) {
      for (const field of table.fields) if (field.link === name) found.push({ doctype: type.name, path: `${table.key}.${field.key}`, Model: type.Model });
    }
  }
  return found;
}

// Fails at boot, not at 9pm, if a definition points at something that is not there.
export function assertRegistryValid() {
  if (extensions.size > 0) throw new Error(`Extended but never defined: ${[...extensions.keys()].join(', ')}`);
  for (const type of types.values()) {
    const all = [...type.fields, ...type.tables.flatMap((t) => t.fields)];
    for (const field of all) if (field.link) linkTarget(field.link);
  }
}

const metaField = (field) => {
  const out = { key: field.key, type: field.type, label: field.label, required: field.required, computed: field.computed };
  if (field.options) out.options = field.options;
  if (field.default !== undefined) out.default = field.default;
  if (field.link) {
    const target = linkTarget(field.link);
    out.link = { doctype: field.link, endpoint: target.endpoint, labelFields: target.labelFields, valueKey: target.valueKey === '_id' ? 'id' : target.valueKey, params: field.linkFilter };
  }
  return out;
};

export function metaOf(type, allowed) {
  return {
    name: type.name,
    label: type.label ?? type.name.replace(/([a-z0-9])([A-Z])/g, '$1 $2'),
    module: type.module,
    submittable: Boolean(type.submittable),
    series: type.series ?? null,
    isSingle: Boolean(type.single),
    isTree: Boolean(type.tree),
    parentKey: type.fields.find((f) => f.link === type.name)?.key ?? null,
    dateField: type.submittable ? 'postingDate' : type.dateField ?? null,
    fields: type.fields.map(metaField),
    tables: type.tables.map((t) => ({ key: t.key, label: t.label, computed: t.computed, fields: t.fields.map(metaField) })),
    list: type.list,
    labelFields: type.labelFields,
    submitLabel: type.submitLabel ?? null,
    hint: type.hint ?? null,
    actions: (type.actions ?? []).map(({ run: _run, schema: _schema, fieldDefs: _fieldDefs, fields, ...rest }) => ({ ...rest, fields: parseFields(fields, type.labels).map(metaField) })),
    canDelete: Boolean(type.deletable),
    can: allowed,
  };
}
