// Who may do what to an engine document. A module has default roles, a document type can
// override them in code, and an admin can override them per role at runtime.
import { RolePermission } from '../models/platform.js';
import { STAFF_ROLES } from '../config/permissions.js';
import { getType, modelOf } from './registry.js';

const OFFICE = ['ADMIN', 'MANAGEMENT'];
const MODULE_WRITERS = {
  setup: OFFICE,
  crm: [...OFFICE, 'SALES'],
  selling: [...OFFICE, 'SALES', 'ACCOUNTS'],
  buying: [...OFFICE, 'PURCHASE'],
  stock: [...OFFICE, 'STORES', 'PURCHASE'],
  manufacturing: [...OFFICE, 'PRODUCTION', 'ENGINEERING'],
  subcontracting: [...OFFICE, 'PURCHASE', 'PRODUCTION'],
  accounts: [...OFFICE, 'ACCOUNTS'],
  assets: [...OFFICE, 'ACCOUNTS'],
  projects: [...OFFICE, 'PRODUCTION', 'ENGINEERING', 'SERVICE', 'SALES'],
  quality: [...OFFICE, 'QUALITY'],
  support: [...OFFICE, 'SERVICE'],
  maintenance: [...OFFICE, 'SERVICE', 'PRODUCTION'],
  hr: [...OFFICE, 'HR'],
  payroll: [...OFFICE, 'HR'],
  pos: [...OFFICE, 'ACCOUNTS', 'SALES'],
  platform: OFFICE,
};
// Everyone can read these modules' records except where pay, money or people are private.
const PRIVATE_MODULES = new Set(['accounts', 'hr', 'payroll', 'assets', 'pos']);
const PRIVATE_READERS = { accounts: ['ACCOUNTS'], assets: ['ACCOUNTS', 'STORES', 'PRODUCTION'], hr: ['HR'], payroll: ['HR', 'ACCOUNTS'], pos: ['ACCOUNTS', 'SALES'] };

let overrides = null;
let loadedAt = 0;
const CACHE_MS = 15000;

export function clearAccessCache() {
  overrides = null;
}

async function loadOverrides() {
  if (overrides && Date.now() - loadedAt < CACHE_MS) return overrides;
  const rows = await RolePermission.find().lean();
  overrides = new Map(rows.map((row) => [`${row.doctype}|${row.role}`, row]));
  loadedAt = Date.now();
  return overrides;
}

function defaults(type, role) {
  const writers = type.writers ?? MODULE_WRITERS[type.module] ?? OFFICE;
  const canWrite = writers.includes(role);
  let canRead = canWrite;
  if (type.readers) canRead = canRead || type.readers.includes(role) || type.readers === 'all';
  else if (PRIVATE_MODULES.has(type.module)) canRead = canRead || (PRIVATE_READERS[type.module] ?? []).includes(role) || OFFICE.includes(role);
  else canRead = true;
  return { read: canRead, write: canWrite, submit: canWrite, cancel: canWrite };
}

export async function accessFor(doctype, role) {
  const type = getType(doctype);
  if (!type || role === 'PORTAL') return { read: false, write: false, submit: false, cancel: false };
  if (role === 'ADMIN') return { read: true, write: true, submit: true, cancel: true };
  const map = await loadOverrides();
  const row = map.get(`${doctype}|${role}`);
  if (row) return { read: row.read, write: row.write, submit: row.submit, cancel: row.cancel };
  return defaults(type, role);
}

export const allRoles = () => STAFF_ROLES;

/* ---------- Per-record permissions ---------- */

const SCOPE_CACHE_MS = 15000;
let scopeCache = new Map();

export function clearScopeCache() {
  scopeCache = new Map();
}

// What this person is limited to, as target type -> allowed ids. Empty means no limits.
async function limitsFor(user) {
  if (user.role === 'ADMIN' || !user.id) return new Map();
  const key = String(user.id);
  const cached = scopeCache.get(key);
  if (cached && Date.now() - cached.at < SCOPE_CACHE_MS) return cached.limits;
  const rows = await modelOf('UserPermission').find({ userId: key }).lean();
  const limits = new Map();
  for (const row of rows) {
    if (!limits.has(row.targetDoctype)) limits.set(row.targetDoctype, []);
    limits.get(row.targetDoctype).push(row.valueId);
  }
  scopeCache.set(key, { at: Date.now(), limits });
  return limits;
}

// A filter narrowing a document type to what this person may see, or null if nothing does.
// A document that leaves the linked field blank stays visible, as it belongs to no one place.
export async function scopeFilter(user, type) {
  const limits = await limitsFor(user);
  if (limits.size === 0) return null;
  const and = [];
  for (const [target, ids] of limits) {
    if (type.name === target) and.push({ _id: { $in: ids } });
    for (const field of type.fields) {
      if (field.link === target) and.push({ [field.key]: { $in: [...ids, null] } });
    }
  }
  return and.length ? { $and: and } : null;
}

export async function isLimited(user) {
  if (!user) return false;
  return (await limitsFor(user)).size > 0;
}

// Where each kind of record is named on the hand-written core documents.
const CORE_LINK_PATHS = {
  Party: ['partyId'],
  Warehouse: ['warehouseId', 'fromWarehouseId', 'toWarehouseId', 'lines.warehouseId', 'lines.fromWarehouseId', 'lines.toWarehouseId'],
  MachineBuild: ['buildId', 'lines.buildId'],
  Item: ['itemId', 'lines.itemId'],
  SalesOrder: ['salesOrderId'],
  PurchaseOrder: ['purchaseOrderId'],
  Bom: ['bomId'],
};

const hasPath = (schema, path) => {
  if (schema.path(path)) return true;
  const [head, ...rest] = path.split('.');
  const array = rest.length ? schema.path(head) : null;
  return Boolean(array?.schema?.path(rest.join('.')));
};

// The same limits, for a hand-written model. A line-level limit shows a document if any of
// its lines is allowed, as one document can touch several warehouses.
export async function scopeFilterForModel(user, Model) {
  const limits = await limitsFor(user);
  if (limits.size === 0) return null;
  const and = [];
  for (const [target, ids] of limits) {
    if (Model.modelName === target) and.push({ _id: { $in: ids } });
    for (const path of CORE_LINK_PATHS[target] ?? []) {
      if (hasPath(Model.schema, path)) and.push({ [path]: { $in: [...ids, null] } });
    }
  }
  return and.length ? { $and: and } : null;
}

// A core document's body may not name a record this person is not allowed.
export async function coreBodyInScope(user, body) {
  const limits = await limitsFor(user);
  for (const [target, ids] of limits) {
    for (const path of CORE_LINK_PATHS[target] ?? []) {
      const [head, tail] = path.split('.');
      const values = tail ? (Array.isArray(body?.[head]) ? body[head].map((row) => row?.[tail]) : []) : [body?.[head]];
      if (values.some((value) => value && !ids.includes(String(value)))) return false;
    }
  }
  return true;
}

// Refuses saving a document that points at a record this person is not allowed.
export async function assertLinksInScope(user, type, input) {
  const limits = await limitsFor(user);
  if (limits.size === 0) return null;
  for (const field of type.fields) {
    const allowed = field.link ? limits.get(field.link) : null;
    const value = input?.[field.key];
    if (allowed && value && !allowed.includes(String(value))) return { field: field.key };
  }
  return null;
}

