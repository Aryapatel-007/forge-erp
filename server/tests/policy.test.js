// The maintainer's switches: parts of Forge turned off, what each role sees, and the
// shop-floor operator role. Hidden means refused by the server too, not only not shown.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { call, ok, startApi, stopApi } from './helpers/http.js';
import { clearPolicy } from '../services/policyService.js';

before(startApi);
after(stopApi);

const me = (role) => ok(role, 'GET', '/auth/me');
const meta = (role) => ok(role, 'GET', '/meta');
const features = (disabled) => ok('ADMIN', 'PUT', '/maintainer/features', { disabled });

test('only the maintainer changes switches', async () => {
  assert.equal((await call('MANAGEMENT', 'GET', '/maintainer/features')).status, 403);
  assert.equal((await call('ENGINEERING', 'PUT', '/maintainer/role-screens/SALES', { hidden: [] })).status, 403);
  const list = await ok('ADMIN', 'GET', '/maintainer/features');
  assert.ok(list.every((f) => f.enabled));
  assert.ok(list.some((f) => f.key === 'vault'));
  assert.equal((await call('ADMIN', 'PUT', '/maintainer/features', { disabled: ['no-such-thing'] })).status, 400);
});

test('a feature switched off disappears and is refused, for everyone, and comes back', async () => {
  await features(['crm', 'quality', 'portal']);
  // Engine document types and reports in its modules leave the screens and the API.
  assert.ok(!(await meta('SALES')).doctypes.some((d) => d.name === 'Lead'));
  assert.ok(!(await meta('ADMIN')).doctypes.some((d) => d.name === 'Lead'), 'even the maintainer, while it is off');
  assert.equal((await call('SALES', 'GET', '/d/Lead')).status, 403);
  // Core screens lose their permission, so the screens hide them.
  const quality = await me('QUALITY');
  assert.ok(!quality.permissions.includes('ncrs.read'));
  assert.deepEqual(quality.policy.disabledFeatures.sort(), ['crm', 'portal', 'quality']);
  const refusal = await call('QUALITY', 'GET', '/ncrs');
  assert.equal(refusal.status, 403);
  assert.equal(refusal.body.error.code, 'FEATURE_OFF');
  // Paths without a permission of their own.
  assert.equal((await call('PORTAL', 'GET', '/portal/me')).body.error.code, 'FEATURE_OFF');
  // Everything else still works.
  assert.equal((await call('SALES', 'GET', '/quotations')).status, 200);

  await features([]);
  assert.ok((await meta('SALES')).doctypes.some((d) => d.name === 'Lead'));
  assert.equal((await call('QUALITY', 'GET', '/ncrs')).status, 200);
});

test('role screens: what the maintainer hides from a role, that role cannot use', async () => {
  const before = await me('STORES');
  assert.ok(before.permissions.includes('stock.read'));
  await ok('ADMIN', 'PUT', '/maintainer/role-screens/STORES', {
    hidden: ['Batch', '#batch-expiry', 'jobWork'],
    added: ['#stock-below-reorder'],
    deniedPerms: ['jobWork.read', 'jobWork.write'],
    deniedDoctypes: ['Batch'],
    deniedReports: ['batch-expiry'],
  });
  const after = await me('STORES');
  assert.ok(!after.permissions.includes('jobWork.read'));
  assert.deepEqual(after.policy.hidden, ['Batch', '#batch-expiry', 'jobWork']);
  assert.deepEqual(after.policy.added, ['#stock-below-reorder']);
  assert.equal((await call('STORES', 'GET', '/job-work')).status, 403);
  assert.ok(!(await meta('STORES')).doctypes.some((d) => d.name === 'Batch'));
  assert.equal((await call('STORES', 'GET', '/d/Batch')).status, 403);
  assert.ok(!(await meta('STORES')).reports.some((r) => r.key === 'batch-expiry'));
  assert.equal((await call('STORES', 'GET', '/r/batch-expiry')).status, 403);
  // Other roles and the maintainer are not touched.
  assert.ok((await me('PURCHASE')).permissions.includes('jobWork.read'));
  assert.equal((await call('ADMIN', 'GET', '/d/Batch')).status, 200);

  assert.equal((await call('ADMIN', 'PUT', '/maintainer/role-screens/ADMIN', { hidden: [] })).status, 400, 'the maintainer is never limited');
  assert.equal((await call('ADMIN', 'PUT', '/maintainer/role-screens/STORES', { deniedPerms: ['settings.read'] })).status, 400);
  assert.equal((await call('ADMIN', 'PUT', '/maintainer/role-screens/STORES', { deniedDoctypes: ['NoSuchType'] })).status, 400);

  await ok('ADMIN', 'DELETE', '/maintainer/role-screens/STORES');
  clearPolicy();
  assert.equal((await call('STORES', 'GET', '/job-work')).status, 200);
  const roles = await ok('ADMIN', 'GET', '/maintainer/roles');
  assert.ok(roles.some((r) => r.role === 'OPERATOR'));
});

test('the shop-floor operator sees how things are made, not money, customers or people', async () => {
  const operator = await me('OPERATOR');
  assert.ok(operator.permissions.includes('time.write'));
  assert.ok(operator.permissions.includes('ncrs.write'));
  assert.ok(!operator.permissions.includes('parties.read'));
  assert.ok(!operator.permissions.includes('salesInvoices.read'));
  const types = new Set((await meta('OPERATOR')).doctypes.map((d) => d.name));
  assert.ok(types.has('JobCard') && types.has('WorkOrder'));
  assert.ok(!types.has('Lead') && !types.has('Employee') && !types.has('SalarySlip') && !types.has('PurchaseOrder'));
  assert.equal((await call('OPERATOR', 'GET', '/parties')).status, 403);
  assert.equal((await call('OPERATOR', 'GET', '/d/Employee')).status, 403);
  assert.equal((await call('OPERATOR', 'GET', '/d/JobCard')).status, 200);
});
