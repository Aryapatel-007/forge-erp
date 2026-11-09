// What the maintainer has decided: which parts of Forge are switched off, and what each role
// sees. Read on every request from a short cache, so a change applies within seconds.
//
// Hiding something from a role is enforced, not only hidden: a hidden document type cannot
// be read or written by that role, a hidden report cannot be run, and a hidden screen's
// permissions are taken away. The maintainer (ADMIN) is never limited by role screens.
import mongoose from 'mongoose';
import { can, PERMISSIONS } from '../config/permissions.js';
import { FEATURE_OF_MODULE, FEATURE_OF_PERM, FEATURE_PATHS } from '../config/features.js';
import { AppError } from '../utils/errors.js';

const { Schema } = mongoose;
const policySchema = new Schema({
  _id: { type: String, default: 'company' },
  disabledFeatures: { type: [String], default: [] },
  // role -> { hidden: [tokens], added: [tokens], deniedPerms: [permissions], deniedDoctypes: [names], deniedReports: [keys] }
  roleScreens: { type: Schema.Types.Mixed, default: {} },
}, { timestamps: true, minimize: false });
export const Policy = mongoose.models.Policy ?? mongoose.model('Policy', policySchema);

const CACHE_MS = 5000;
let cached = null;
let loadedAt = 0;

function shape(doc) {
  const screens = doc?.roleScreens ?? {};
  const deny = (key) => new Map(Object.entries(screens).map(([role, s]) => [role, new Set(s?.[key] ?? [])]));
  return {
    disabled: new Set(doc?.disabledFeatures ?? []),
    screens,
    deniedPerms: deny('deniedPerms'),
    deniedDoctypes: deny('deniedDoctypes'),
    deniedReports: deny('deniedReports'),
  };
}

export async function policy() {
  if (cached && Date.now() - loadedAt < CACHE_MS) return cached;
  cached = shape(await Policy.findById('company').lean());
  loadedAt = Date.now();
  return cached;
}

export function clearPolicy() {
  cached = null;
}

export const featureOff = (p, feature) => Boolean(feature) && p.disabled.has(feature);
const roleDenies = (p, role, kind, name) => role !== 'ADMIN' && Boolean(p[kind].get(role)?.has(name));

export async function allowed(role, permission) {
  if (!can(role, permission)) return false;
  const p = await policy();
  if (featureOff(p, FEATURE_OF_PERM.get(permission))) return false;
  return !roleDenies(p, role, 'deniedPerms', permission);
}

// The permissions a person really has, for the screens to show only what works.
export async function effectivePermissions(role) {
  const p = await policy();
  return Object.keys(PERMISSIONS).filter((perm) => PERMISSIONS[perm].includes(role)
    && !featureOff(p, FEATURE_OF_PERM.get(perm))
    && !roleDenies(p, role, 'deniedPerms', perm));
}

export async function doctypeBlocked(type, role) {
  const p = await policy();
  return featureOff(p, FEATURE_OF_MODULE.get(type.module)) || roleDenies(p, role, 'deniedDoctypes', type.name);
}

export async function reportBlocked(def, role) {
  const p = await policy();
  return featureOff(p, FEATURE_OF_MODULE.get(def.module)) || roleDenies(p, role, 'deniedReports', def.key);
}

// For the screens: what is off, and this role's own screen choices.
export async function policyFor(role) {
  const p = await policy();
  const screen = p.screens[role] ?? {};
  return { disabledFeatures: [...p.disabled], hidden: screen.hidden ?? [], added: screen.added ?? [] };
}

export const featureOffError = () => new AppError(403, 'FEATURE_OFF', 'This part of Forge is switched off. The maintainer can switch it on under Maintainer > Features.');

// Paths with no permission of their own: the portal, the public website, the PC sync.
export async function featureGate(req, _res, next) {
  const hit = FEATURE_PATHS.find(([prefix]) => req.path === prefix || req.path.startsWith(`${prefix}/`));
  if (hit && (await policy()).disabled.has(hit[1])) throw featureOffError();
  next();
}
