// The maintainer's controls: which parts of Forge are on, and what each role sees.
// Accounts for people are made under /admin/users. All of it is the ADMIN role, shown in the
// screens as Maintainer.
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePerm } from '../middleware/index.js';
import { PERMISSIONS, STAFF_ROLES } from '../config/permissions.js';
import { FEATURES, FEATURE_KEYS } from '../config/features.js';
import { getType } from '../engine/registry.js';
import { User } from '../models/core.js';
import { auditNow } from '../services/auditService.js';
import { clearPolicy, Policy, policy } from '../services/policyService.js';
import { badRequest } from '../utils/errors.js';

const ok = (res, data) => res.json({ success: true, data });
const tokens = z.array(z.string().trim().min(1).max(120)).max(500).default([]);

export function maintainerRoutes() {
  const r = Router();
  r.use(authenticate, requirePerm('settings.write'));

  r.get('/features', async (_req, res) => {
    const p = await policy();
    ok(res, FEATURES.map(({ key, group, label, blurb }) => ({ key, group, label, blurb, enabled: !p.disabled.has(key) })));
  });
  r.put('/features', async (req, res) => {
    const { disabled } = z.object({ disabled: z.array(z.enum(FEATURE_KEYS)).max(FEATURE_KEYS.length) }).strict().parse(req.body ?? {});
    const before = (await Policy.findById('company').lean())?.disabledFeatures ?? [];
    await Policy.updateOne({ _id: 'company' }, { $set: { disabledFeatures: [...new Set(disabled)] } }, { upsert: true });
    clearPolicy();
    await auditNow({ actor: req.user, action: 'FEATURES_CHANGED', entityType: 'Policy', entityId: 'company', data: { before, after: disabled } });
    ok(res, { disabled });
  });

  r.get('/roles', async (_req, res) => {
    const counts = await User.aggregate([{ $match: { isActive: true } }, { $group: { _id: '$role', count: { $sum: 1 } } }]);
    const byRole = Object.fromEntries(counts.map((c) => [c._id, c.count]));
    const p = await policy();
    ok(res, STAFF_ROLES.map((role) => ({ role, people: byRole[role] ?? 0, screen: p.screens[role] ?? null })));
  });

  r.put('/role-screens/:role', async (req, res) => {
    const role = z.enum(STAFF_ROLES.filter((x) => x !== 'ADMIN')).parse(req.params.role);
    const body = z.object({ hidden: tokens, added: tokens, deniedPerms: tokens, deniedDoctypes: tokens, deniedReports: tokens }).strict().parse(req.body ?? {});
    const unknownPerm = body.deniedPerms.find((perm) => !PERMISSIONS[perm]);
    if (unknownPerm) throw badRequest(`Unknown permission ${unknownPerm}.`);
    if (body.deniedPerms.includes('settings.read')) throw badRequest('Every role needs the company settings to work.');
    const unknownType = body.deniedDoctypes.find((name) => !getType(name));
    if (unknownType) throw badRequest(`Unknown document type ${unknownType}.`);
    const before = (await Policy.findById('company').lean())?.roleScreens?.[role] ?? null;
    await Policy.updateOne({ _id: 'company' }, { $set: { [`roleScreens.${role}`]: body } }, { upsert: true });
    clearPolicy();
    await auditNow({ actor: req.user, action: 'ROLE_SCREEN_CHANGED', entityType: 'Policy', entityId: role, data: { before, after: body } });
    ok(res, body);
  });
  r.delete('/role-screens/:role', async (req, res) => {
    const role = z.enum(STAFF_ROLES).parse(req.params.role);
    await Policy.updateOne({ _id: 'company' }, { $unset: { [`roleScreens.${role}`]: '' } }, { upsert: true });
    clearPolicy();
    await auditNow({ actor: req.user, action: 'ROLE_SCREEN_RESET', entityType: 'Policy', entityId: role });
    ok(res, { reset: true });
  });
  return r;
}
