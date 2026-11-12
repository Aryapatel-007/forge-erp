// A machine order's journey: steps that tick themselves from the records, steps each
// department ticks, what waits on whom, and dates planned to meet the delivery date.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { ok, refused, startApi, stopApi } from './helpers/http.js';
import { addDays, todayIst } from '../utils/dates.js';

const refs = {};
const today = todayIst();

before(async () => {
  await startApi();
  await ok('ADMIN', 'PATCH', '/admin/settings', { stateCode: '24' });
  refs.customer = await ok('ADMIN', 'POST', '/parties', { code: 'C1', name: 'Sunrise Healthcare', isCustomer: true, stateCode: '24' });
  refs.part = await ok('ADMIN', 'POST', '/items', { code: 'SS', name: 'SS 316L sheet', type: 'RAW', hsn: '7219', gstRateBps: 1800, standardCostPaise: 1000 });
  refs.machine = await ok('ADMIN', 'POST', '/items', { code: 'LF4', name: '4 head liquid filler', type: 'MACHINE', hsn: '8422', gstRateBps: 1800 });
  const bom = await ok('ENGINEERING', 'POST', '/boms', { itemId: refs.machine.id, lines: [{ itemId: refs.part.id, qtyMilli: 2000 }] });
  await ok('ENGINEERING', 'POST', `/boms/${bom.id}/release`);
  const order = await ok('SALES', 'POST', '/sales-orders', {
    partyId: refs.customer.id, deliveryDate: addDays(today, 190),
    lines: [{ itemId: refs.machine.id, qtyMilli: 1000, rateMinor: 100000000 }],
    milestones: [{ no: 1, name: 'Advance', trigger: 'ORDER', pctBps: 3000 }, { no: 2, name: 'Before dispatch', trigger: 'BEFORE_DISPATCH', pctBps: 6000 }, { no: 3, name: 'After installation', trigger: 'AFTER_INSTALLATION', pctBps: 1000 }],
  });
  refs.order = await ok('SALES', 'POST', `/sales-orders/${order.id}/submit`);
  refs.build = (await ok('PRODUCTION', 'GET', `/builds?salesOrderId=${refs.order.id}`))[0];
});
after(stopApi);

test('a new order gets its journey, with the records already ticking what has happened', async () => {
  const j = await ok('PROJECTS', 'GET', `/journey/${refs.build.id}`);
  assert.equal(j.total, 22);
  const step = (key) => j.steps.find((s) => s.key === key);
  assert.equal(step('order-confirmed').status, 'DONE');
  assert.equal(step('order-confirmed').auto, true);
  assert.equal(step('design-released').status, 'DONE', 'the BOM was released');
  assert.notEqual(step('advance').status, 'DONE', 'no money yet');
  assert.equal(j.current.key, 'kickoff-internal');
  // Planned to meet the delivery date: dispatch lands on it.
  assert.equal(step('dispatched').plannedDate, addDays(today, 190));
  assert.equal(j.phases.length, 7);
  assert.equal(j.phases[0].key, 'order');
});

test('each department ticks its own steps; projects can tick any; others cannot', async () => {
  await refused('SALES', 'POST', `/journey/${refs.build.id}/steps/ga-sent`, { action: 'done' }, 'FORBIDDEN', 403);
  let j = await ok('ENGINEERING', 'POST', `/journey/${refs.build.id}/steps/ga-sent`, { action: 'done', note: 'GA rev 0 mailed' });
  assert.equal(j.steps.find((s) => s.key === 'ga-sent').doneByName, 'ENGINEERING person');
  j = await ok('PROJECTS', 'POST', `/journey/${refs.build.id}/steps/kickoff-internal`, { action: 'done' });
  await refused('PROJECTS', 'POST', `/journey/${refs.build.id}/steps/kickoff-internal`, { action: 'done' }, 'BUSINESS_RULE_VIOLATED', 422);
  await refused('PROJECTS', 'POST', `/journey/${refs.build.id}/steps/order-confirmed`, { action: 'undo' }, 'BUSINESS_RULE_VIOLATED', 422);
  await refused('PROJECTS', 'POST', `/journey/${refs.build.id}/steps/sat-iq-oq`, { action: 'skip' }, 'VALIDATION_FAILED', 400);
  j = await ok('VALIDATION', 'POST', `/journey/${refs.build.id}/steps/sat-iq-oq`, { action: 'skip', note: 'Customer does its own qualification' });
  assert.equal(j.steps.find((s) => s.key === 'sat-iq-oq').status, 'SKIPPED');
  j = await ok('PROJECTS', 'POST', `/journey/${refs.build.id}/steps/ga-approved`, { action: 'plan', plannedDate: addDays(today, -2) });
  assert.equal(j.steps.find((s) => s.key === 'ga-approved').status, 'LATE');
  assert.ok(j.late >= 1);
  await ok('ENGINEERING', 'POST', `/journey/${refs.build.id}/steps/ga-sent`, { action: 'undo' });
  await ok('PROJECTS', 'POST', `/journey/${refs.build.id}/steps/ga-sent`, { action: 'plan', plannedDate: addDays(today, 3) });
});

test('what is waiting on whom', async () => {
  const projects = await ok('PROJECTS', 'GET', '/journey/mine');
  assert.ok(projects.some((s) => s.key === 'ga-approved' && s.status === 'LATE'), 'projects sees everything due');
  const engineering = await ok('ENGINEERING', 'GET', '/journey/mine');
  assert.ok(engineering.every((s) => s.role === 'ENGINEERING'));
  assert.ok(engineering.some((s) => s.key === 'ga-sent'));
  const accounts = await ok('ACCOUNTS', 'GET', '/journey/mine');
  assert.ok(!accounts.some((s) => s.key === 'advance'), 'steps that tick themselves are not listed as work');
});

test('records move the journey: stages, FAT, payments', async () => {
  await ok('PRODUCTION', 'POST', `/builds/${refs.build.id}/stage`, { stage: 'PROCUREMENT' });
  await ok('PRODUCTION', 'POST', `/builds/${refs.build.id}/stage`, { stage: 'FABRICATION' });
  await ok('PRODUCTION', 'POST', `/builds/${refs.build.id}/stage`, { stage: 'ASSEMBLY' });
  const j = await ok('PRODUCTION', 'GET', `/journey/${refs.build.id}`);
  assert.equal(j.steps.find((s) => s.key === 'fabrication').status, 'DONE');
  assert.notEqual(j.steps.find((s) => s.key === 'assembly').status, 'DONE');
  const boardRows = await ok('MANAGEMENT', 'GET', '/journey/board');
  assert.equal(boardRows.length, 1);
  assert.equal(boardRows[0].build.serialNo, refs.build.serialNo);
  assert.ok(boardRows[0].done >= 4);
});

test('the new roles: projects and validation', async () => {
  const projects = await ok('PROJECTS', 'GET', '/auth/me');
  assert.ok(projects.permissions.includes('builds.write') && projects.permissions.includes('salesOrders.read'));
  assert.ok(!projects.permissions.includes('salesInvoices.write'));
  const validation = await ok('VALIDATION', 'GET', '/auth/me');
  assert.ok(validation.permissions.includes('fat.write') && validation.permissions.includes('vault.write'));
  assert.ok(!validation.permissions.includes('purchaseOrders.write'));
});
