// Shop floor depth, shared screens, the portal, backups and the logic added to record types.
// Amounts are worked out by hand in the comments.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import mongoose from 'mongoose';
import { booksAreClean, call, ok, post, refused, startApi, stopApi, users } from './helpers/http.js';
import { A } from '../config/accounts.js';
import { GlEntry } from '../models/index.js';
import { backupPath, restoreBackup } from '../services/backupService.js';
import { addDays, todayIst } from '../utils/dates.js';

const today = todayIst();
const refs = {};
const gl = async (code, filter = {}) => {
  const rows = await GlEntry.find({ accountCode: code, ...filter }).lean();
  return rows.reduce((sum, r) => sum + r.debitPaise - r.creditPaise, 0);
};
const bucket = async (itemId, warehouseId) => {
  const { rows } = await ok('ADMIN', 'GET', `/reports/stock-balance?itemId=${itemId}${warehouseId ? `&warehouseId=${warehouseId}` : ''}`);
  return rows.reduce((t, r) => ({ qty: t.qty + r.qtyMilli, value: t.value + r.valuePaise }), { qty: 0, value: 0 });
};
const opening = (lines) => post('STORES', '/stock-moves', { kind: 'OPENING', reason: 'Opening', lines });
const makeOrder = (qtyMilli, extra = {}, item = refs.product, bom = refs.bom) => post('PRODUCTION', '/d/WorkOrder', { itemId: item.id, bomId: bom.id, qtyMilli, targetWarehouseId: refs.stores.id, ...extra });
const act = (id, action, body = {}, role = 'PRODUCTION') => ok(role, 'POST', `/d/WorkOrder/${id}/a/${action}`, body);

before(async () => {
  await startApi();
  await ok('ADMIN', 'PATCH', '/admin/settings', { stateCode: '24' });
  for (const [key, row] of Object.entries({
    stores: { code: 'STORES', name: 'Stores', kind: 'STORES' },
    hold: { code: 'HOLD', name: 'Hold', kind: 'QUARANTINE' },
    reject: { code: 'REJECT', name: 'Reject', kind: 'REJECT' },
    jw: { code: 'JW', name: 'Job work', kind: 'JOBWORK' },
    fg: { code: 'FG', name: 'Finished', kind: 'FG' },
  })) refs[key] = await ok('ADMIN', 'POST', '/warehouses', row);
  for (const [key, row] of Object.entries({
    customer: { code: 'C1', name: 'Customer One', isCustomer: true, stateCode: '24' },
    rival: { code: 'C2', name: 'Customer Two', isCustomer: true, stateCode: '24' },
    supplier: { code: 'S1', name: 'Supplier One', isSupplier: true, stateCode: '24', gstin: '24AAACD1234E1ZF' },
    worker: { code: 'JW1', name: 'Job Worker', isJobWorker: true, isSupplier: true, stateCode: '24' },
  })) refs[key] = await ok('ADMIN', 'POST', '/parties', row);
  for (const [key, row] of Object.entries({
    m1: { code: 'M1', name: 'Material one', type: 'RAW', hsn: '7318', gstRateBps: 1800 },
    m2: { code: 'M2', name: 'Material two', type: 'RAW', hsn: '7219', gstRateBps: 1800 },
    alt: { code: 'ALT', name: 'Alternative', type: 'RAW', hsn: '7219', gstRateBps: 1800 },
    scrap: { code: 'SCRAP', name: 'Scrap', type: 'RAW', hsn: '7204', gstRateBps: 1800 },
    product: { code: 'P1', name: 'Product', type: 'ASSEMBLY', hsn: '8422', gstRateBps: 1800 },
    serial: { code: 'P2', name: 'Serial product', type: 'ASSEMBLY', hsn: '8422', gstRateBps: 1800, hasSerialNo: true },
    top: { code: 'TOP', name: 'Top assembly', type: 'ASSEMBLY', hsn: '8422', gstRateBps: 1800 },
    sub: { code: 'SUB', name: 'Sub assembly', type: 'ASSEMBLY', hsn: '8422', gstRateBps: 1800 },
    x: { code: 'X', name: 'Part X', type: 'RAW', hsn: '7318', gstRateBps: 1800 },
    y: { code: 'Y', name: 'Part Y', type: 'RAW', hsn: '7318', gstRateBps: 1800, leadTimeDays: 7 },
  })) refs[key] = await ok('ADMIN', 'POST', '/items', row);
  await opening([
    { itemId: refs.m1.id, qtyMilli: 100000, toWarehouseId: refs.stores.id, ratePaise: 1000 },
    { itemId: refs.m2.id, qtyMilli: 100000, toWarehouseId: refs.stores.id, ratePaise: 2000 },
    { itemId: refs.alt.id, qtyMilli: 10000, toWarehouseId: refs.stores.id, ratePaise: 2500 },
  ]);
  // One product: 2 of M1 at Rs 10, and 1 of M2 at Rs 20, so Rs 40 of materials.
  refs.bom = await ok('ENGINEERING', 'POST', '/boms', { itemId: refs.product.id, lines: [{ itemId: refs.m1.id, qtyMilli: 2000 }, { itemId: refs.m2.id, qtyMilli: 1000 }] });
  await ok('ENGINEERING', 'POST', `/boms/${refs.bom.id}/release`);
  refs.serialBom = await ok('ENGINEERING', 'POST', '/boms', { itemId: refs.serial.id, lines: [{ itemId: refs.m1.id, qtyMilli: 1000 }] });
  await ok('ENGINEERING', 'POST', `/boms/${refs.serialBom.id}/release`);
  refs.subBom = await ok('ENGINEERING', 'POST', '/boms', { itemId: refs.sub.id, lines: [{ itemId: refs.y.id, qtyMilli: 3000 }] });
  await ok('ENGINEERING', 'POST', `/boms/${refs.subBom.id}/release`);
  refs.topBom = await ok('ENGINEERING', 'POST', '/boms', { itemId: refs.top.id, lines: [{ itemId: refs.sub.id, qtyMilli: 1000 }, { itemId: refs.x.id, qtyMilli: 2000 }] });
  await ok('ENGINEERING', 'POST', `/boms/${refs.topBom.id}/release`);
});
after(stopApi);

/* ---------- Work orders ---------- */

test('part issue, return, and closing short: the rest of the cost is written off, not lost', async () => {
  const order = await makeOrder(10000);
  await refused('PRODUCTION', 'POST', `/d/WorkOrder/${order.id}/a/issuePart`, { itemId: refs.m1.id, qtyMilli: 20001 }, 'OVER_ISSUED', 422);
  await refused('PRODUCTION', 'POST', `/d/WorkOrder/${order.id}/a/issuePart`, { itemId: refs.x.id, qtyMilli: 1 }, 'NOT_ON_ORDER', 422);
  // 5 of M1 at Rs 10 is Rs 50.
  const issued = await act(order.id, 'issuePart', { itemId: refs.m1.id, qtyMilli: 5000 });
  assert.deepEqual([issued.wipPaise, issued.state], [5000, 'IN_PROCESS']);
  assert.equal(await gl(A.WIP_WORK_ORDERS), 5000);
  await refused('PRODUCTION', 'POST', `/d/WorkOrder/${order.id}/a/returnMaterial`, { itemId: refs.m1.id, qtyMilli: 5001, warehouseId: refs.stores.id }, 'OVER_RETURNED', 422);
  // 1 back at what it cost leaves Rs 40 in WIP.
  const returned = await act(order.id, 'returnMaterial', { itemId: refs.m1.id, qtyMilli: 1000, warehouseId: refs.stores.id });
  assert.equal(returned.wipPaise, 4000);
  assert.equal((await bucket(refs.m1.id)).qty, 96000);
  await refused('PRODUCTION', 'POST', `/d/WorkOrder/${order.id}/a/stop`, {}, 'WORK_ORDER_HAS_WIP', 422);
  const closed = await act(order.id, 'closeShort', { reason: 'Customer cancelled' });
  assert.deepEqual([closed.state, closed.wipPaise, closed.varianceValuePaise, closed.closeReason], ['CLOSED', 0, 4000, 'Customer cancelled']);
  assert.equal(await gl(A.WIP_WORK_ORDERS), 0);
  assert.equal(await gl(A.MFG_VARIANCE), 4000);
  await refused('PRODUCTION', 'POST', `/d/WorkOrder/${order.id}/a/issuePart`, { itemId: refs.m1.id, qtyMilli: 1 }, 'ACTION_NOT_AVAILABLE', 422);
  await booksAreClean('closing short');
});

test('backflush costs each batch with its own materials, and a loss falls on the good pieces', async () => {
  const order = await makeOrder(4000, { backflush: true });
  await refused('PRODUCTION', 'POST', `/d/WorkOrder/${order.id}/a/produce`, { qtyMilli: 1000 }, 'ACTION_NOT_AVAILABLE', 422);
  await act(order.id, 'start');
  const before_ = await bucket(refs.product.id);
  // One piece uses 2 of M1 and 1 of M2: Rs 40.
  const first = await act(order.id, 'produce', { qtyMilli: 1000 });
  assert.deepEqual([first.producedValuePaise, first.wipPaise], [4000, 0]);
  assert.deepEqual(first.materials.map((m) => m.issuedMilli).sort((a, b) => a - b), [1000, 2000]);
  // One spoiled. Two good pieces left to make, carrying materials for three: Rs 120.
  await refused('PRODUCTION', 'POST', `/d/WorkOrder/${order.id}/a/reportLoss`, { qtyMilli: 3001, reason: 'x' }, 'OVER_LOSS', 422);
  const lost = await act(order.id, 'reportLoss', { qtyMilli: 1000, reason: 'Spoiled in press' });
  assert.equal(lost.processLossMilli, 1000);
  assert.equal(lost.state, 'IN_PROCESS');
  const done = await act(order.id, 'produce', { qtyMilli: 2000 });
  assert.deepEqual([done.state, done.producedMilli, done.producedValuePaise, done.wipPaise, done.completedOn], ['COMPLETED', 3000, 16000, 0, today]);
  const after_ = await bucket(refs.product.id);
  assert.deepEqual([after_.qty - before_.qty, after_.value - before_.value], [3000, 16000]);
  assert.equal((await ok('PRODUCTION', 'GET', '/r/process-loss')).rows[0].reason, 'Spoiled in press');
  await booksAreClean('backflush and loss');
});

test('over-production is only allowed up to the allowance, and costs nothing extra', async () => {
  const order = await makeOrder(2000, { allowOverBps: 1000 });
  await act(order.id, 'issue');
  await refused('PRODUCTION', 'POST', `/d/WorkOrder/${order.id}/a/produce`, { qtyMilli: 2201 }, 'OVER_PRODUCED', 422);
  const done = await act(order.id, 'produce', { qtyMilli: 2200 });
  assert.deepEqual([done.state, done.producedMilli, done.producedValuePaise, done.wipPaise], ['COMPLETED', 2200, 8000, 0]);
  await booksAreClean('over-production');
});

test('inspection holds finished goods in quarantine until someone passes or rejects them', async () => {
  const order = await makeOrder(2000, { requiresInspection: true, targetWarehouseId: refs.fg.id });
  await act(order.id, 'issue');
  const inventory = await gl(A.INVENTORY);
  const finished = await gl(A.FINISHED_GOODS);
  const made = await act(order.id, 'produce', { qtyMilli: 2000 });
  assert.equal(made.inspectionPendingMilli, 2000);
  assert.equal((await bucket(refs.product.id, refs.hold.id)).qty, 2000);
  assert.equal(await gl(A.FINISHED_GOODS), finished, 'not finished goods until it passes');
  assert.equal(await gl(A.INVENTORY), inventory + 8000);
  await refused('PRODUCTION', 'POST', `/d/WorkOrder/${order.id}/a/releaseInspected`, { qtyMilli: 2001 }, 'NOT_WAITING', 422);
  // One passes at Rs 40, and moves from inventory to finished goods.
  await act(order.id, 'releaseInspected', { qtyMilli: 1000, passed: true });
  assert.equal((await bucket(refs.product.id, refs.fg.id)).qty, 1000);
  assert.equal(await gl(A.FINISHED_GOODS), finished + 4000);
  assert.equal(await gl(A.INVENTORY), inventory + 4000);
  const rejected = await act(order.id, 'releaseInspected', { qtyMilli: 1000, passed: false, remarks: 'Burrs' });
  assert.deepEqual([rejected.inspectionPendingMilli, rejected.rejectedMilli], [0, 1000]);
  assert.equal((await bucket(refs.product.id, refs.reject.id)).qty, 1000);
  await booksAreClean('inspection');
});

test('by-products take their value out of WIP, and alternatives replace only what is unissued', async () => {
  await ok('STORES', 'POST', '/d/ItemAlternative', { itemId: refs.m2.id, alternativeItemId: refs.alt.id });
  const order = await makeOrder(2000);
  await refused('PRODUCTION', 'POST', `/d/WorkOrder/${order.id}/a/substitute`, { itemId: refs.m1.id, alternativeItemId: refs.alt.id }, 'NOT_AN_ALTERNATIVE', 422);
  await act(order.id, 'issuePart', { itemId: refs.m2.id, qtyMilli: 500 });
  const swapped = await act(order.id, 'substitute', { itemId: refs.m2.id, alternativeItemId: refs.alt.id });
  const rowFor = (doc, itemId) => doc.materials.find((m) => String(m.itemId) === itemId);
  assert.equal(rowFor(swapped, refs.m2.id).requiredMilli, 500, 'what was issued stays');
  assert.equal(rowFor(swapped, refs.alt.id).requiredMilli, 1500);
  // M1: 4 at Rs 10. M2: 0.5 at Rs 20. Alternative: 1.5 at Rs 25. That is 40 + 10 + 37.50.
  const issued = await act(order.id, 'issue');
  assert.equal(issued.wipPaise, 8750);
  await refused('PRODUCTION', 'POST', `/d/WorkOrder/${order.id}/a/recordByProduct`, { itemId: refs.scrap.id, qtyMilli: 1000, valuePaise: 8751, warehouseId: refs.stores.id }, 'OVER_WIP', 422);
  const byProduct = await act(order.id, 'recordByProduct', { itemId: refs.scrap.id, qtyMilli: 1000, valuePaise: 750, warehouseId: refs.stores.id });
  assert.deepEqual([byProduct.wipPaise, byProduct.byProductValuePaise], [8000, 750]);
  assert.equal((await bucket(refs.scrap.id)).value, 750);
  const done = await act(order.id, 'produce', { qtyMilli: 2000 });
  assert.equal(done.producedValuePaise, 8000);
  await booksAreClean('by-product');
});

test('batches and serial numbers are created when goods are finished', async () => {
  const lotted = await makeOrder(1000, { lot: 'LOT-77' });
  await act(lotted.id, 'issue');
  await act(lotted.id, 'produce', { qtyMilli: 1000 });
  const batches = await ok('ADMIN', 'GET', '/d/Batch?q=LOT-77');
  assert.equal(batches.length, 1);
  assert.equal(batches[0].manufacturedOn, today);

  const order = await makeOrder(2000, {}, refs.serial, refs.serialBom);
  await act(order.id, 'issue');
  await refused('PRODUCTION', 'POST', `/d/WorkOrder/${order.id}/a/produce`, { qtyMilli: 2000, serialNos: 'S-1' }, 'SERIAL_COUNT', 422);
  await act(order.id, 'produce', { qtyMilli: 2000, serialNos: 'S-1, S-2' });
  const serials = await ok('ADMIN', 'GET', `/d/SerialNo?itemId=${refs.serial.id}`);
  assert.deepEqual(serials.map((s) => s.serialNo).sort(), ['S-1', 'S-2']);
  assert.equal(serials[0].state, 'IN_STOCK');
  await booksAreClean('batches and serials');
});

test('job cards follow the routing, a person is not in two places, and hours come from the logs', async () => {
  const station = await ok('PRODUCTION', 'POST', '/d/Workstation', { name: 'Lathe', hourRatePaise: 60000 });
  const cut = await ok('PRODUCTION', 'POST', '/d/Operation', { name: 'Cut', workstationId: station.id });
  const weld = await ok('PRODUCTION', 'POST', '/d/Operation', { name: 'Weld', workstationId: station.id });
  const routing = await ok('PRODUCTION', 'POST', '/d/Routing', { name: 'Route A', steps: [{ operationId: cut.id, workstationId: station.id, hoursMilli: 1000 }, { operationId: weld.id, workstationId: station.id, hoursMilli: 500 }] });
  const order = await makeOrder(2000, { routingId: routing.id });
  const made = await ok('PRODUCTION', 'POST', `/d/WorkOrder/${order.id}/a/makeJobCards`, {});
  assert.equal(made.status, 'DRAFT');
  const cards = await ok('PRODUCTION', 'GET', `/d/JobCard?workOrderId=${order.id}`);
  assert.equal(cards.length, 2);
  await refused('PRODUCTION', 'POST', `/d/WorkOrder/${order.id}/a/makeJobCards`, {}, 'ALREADY_MADE', 422);
  const cutCard = cards.find((c) => c.operationId === cut.id);
  const weldCard = cards.find((c) => c.operationId === weld.id);

  // Welding two pieces before any were cut is out of order.
  await ok('PRODUCTION', 'PATCH', `/d/JobCard/${weldCard.id}`, { workOrderId: order.id, operationId: weld.id, workstationId: station.id, hoursMilli: 1000, completedMilli: 2000 });
  await refused('PRODUCTION', 'POST', `/d/JobCard/${weldCard.id}/submit`, {}, 'OUT_OF_SEQUENCE', 422);

  const person = await ok('HR', 'POST', '/d/Employee', { fullName: 'Asha', joiningDate: '2020-01-01' });
  const log = (from, to) => ({ fromTime: `${today}T${from}:00+05:30`, toTime: `${today}T${to}:00+05:30`, employeeId: person.id });
  // 90 minutes is 1.5 hours, at Rs 600 an hour is Rs 900.
  await ok('PRODUCTION', 'PATCH', `/d/JobCard/${cutCard.id}`, { workOrderId: order.id, operationId: cut.id, workstationId: station.id, completedMilli: 2000, timeLogs: [log('09:00', '10:30')] });
  const posted = await ok('PRODUCTION', 'POST', `/d/JobCard/${cutCard.id}/submit`, {});
  assert.deepEqual([posted.hoursMilli, posted.valuePaise], [1500, 90000]);
  await ok('PRODUCTION', 'PATCH', `/d/JobCard/${weldCard.id}`, { workOrderId: order.id, operationId: weld.id, workstationId: station.id, completedMilli: 2000, timeLogs: [log('10:00', '11:00')] });
  await refused('PRODUCTION', 'POST', `/d/JobCard/${weldCard.id}/submit`, {}, 'EMPLOYEE_BUSY', 422);
  await ok('PRODUCTION', 'PATCH', `/d/JobCard/${weldCard.id}`, { workOrderId: order.id, operationId: weld.id, workstationId: station.id, completedMilli: 2000, timeLogs: [log('10:30', '11:00')] });
  const welded = await ok('PRODUCTION', 'POST', `/d/JobCard/${weldCard.id}/submit`, {});
  assert.deepEqual([welded.hoursMilli, welded.valuePaise], [500, 30000]);
  const live = await ok('PRODUCTION', 'GET', `/d/WorkOrder/${order.id}`);
  assert.equal(live.operations[0].completedMilli, 2000);
  assert.equal(live.wipPaise, 120000);

  // Cutting's card cannot go while welding has used its pieces.
  await refused('PRODUCTION', 'POST', `/d/JobCard/${cutCard.id}/cancel`, { reason: 'x' }, 'LATER_STEP_DONE', 409);
  // The order's labour would be stranded if the order alone were cancelled.
  await refused('PRODUCTION', 'POST', `/d/WorkOrder/${order.id}/cancel`, { reason: 'x' }, 'HAS_JOB_CARDS', 409);
  await ok('PRODUCTION', 'POST', `/d/JobCard/${weldCard.id}/cancel`, { reason: 'Mistake' });
  await ok('PRODUCTION', 'POST', `/d/JobCard/${cutCard.id}/cancel`, { reason: 'Mistake' });
  await ok('PRODUCTION', 'POST', `/d/WorkOrder/${order.id}/cancel`, { reason: 'Mistake' });
  await booksAreClean('job cards');
});

test('scheduling books real hours, skips days off, and the next order fits round the first', async () => {
  const station = await ok('PRODUCTION', 'POST', '/d/Workstation', { name: 'Mill', hourRatePaise: 1000 });
  const operation = await ok('PRODUCTION', 'POST', '/d/Operation', { name: 'Milling', workstationId: station.id });
  const routing = await ok('PRODUCTION', 'POST', '/d/Routing', { name: 'Mill route', steps: [{ operationId: operation.id, workstationId: station.id, hoursMilli: 10000 }] });
  const first = await makeOrder(2000, { routingId: routing.id });
  // 20 hours at 8 a day from Saturday 12 Jan 2030: Sat 8, Sunday off, Mon 8, Tue 4.
  const scheduled = await act(first.id, 'schedule', { startDate: '2030-01-12' });
  assert.deepEqual([scheduled.scheduledStart, scheduled.scheduledEnd], ['2030-01-12', '2030-01-15']);
  const bookings = await ok('ADMIN', 'GET', `/d/CapacityBooking?workOrderId=${first.id}`);
  assert.deepEqual(bookings.map((b) => [b.onDate, b.hoursMilli]).sort(), [['2030-01-12', 8000], ['2030-01-14', 8000], ['2030-01-15', 4000]]);

  // 6 hours from the same Tuesday: 4 are free that day, so 2 go on Wednesday.
  const small = await ok('PRODUCTION', 'POST', '/d/Routing', { name: 'Small route', steps: [{ operationId: operation.id, workstationId: station.id, hoursMilli: 6000 }] });
  const second = await makeOrder(1000, { routingId: small.id });
  const fitted = await act(second.id, 'schedule', { startDate: '2030-01-15' });
  assert.deepEqual([fitted.scheduledStart, fitted.scheduledEnd], ['2030-01-15', '2030-01-16']);

  const load = await ok('PRODUCTION', 'GET', `/r/capacity-load?from=2030-01-15&to=2030-01-16&workstationId=${station.id}`);
  assert.deepEqual(load.rows.map((r) => [r.onDate, r.bookedMilli, r.freeMilli, r.loadBps]), [['2030-01-15', 8000, 0, 10000], ['2030-01-16', 2000, 6000, 2500]]);

  // Rescheduling replaces the bookings, and stopping the order gives the time back.
  await act(first.id, 'schedule', { startDate: '2030-02-04' });
  assert.equal((await ok('ADMIN', 'GET', `/d/CapacityBooking?workOrderId=${first.id}`)).every((b) => b.onDate >= '2030-02-04'), true);
  await act(first.id, 'stop');
  assert.equal((await ok('ADMIN', 'GET', `/d/CapacityBooking?workOrderId=${first.id}`)).length, 0);
});

/* ---------- MRP ---------- */

test('MRP nets level by level: a sub-assembly in stock stops its parts being bought', async () => {
  // Make 10 TOP. It takes 10 SUB and 20 X. 4 SUB are in stock, so 6 are made, taking 18 Y.
  // 5 Y are in stock, so 13 are short. 5 X are on order, so 15 X are short.
  await opening([
    { itemId: refs.sub.id, qtyMilli: 4000, toWarehouseId: refs.stores.id, ratePaise: 100 },
    { itemId: refs.y.id, qtyMilli: 5000, toWarehouseId: refs.stores.id, ratePaise: 100 },
  ]);
  await post('PURCHASE', '/purchase-orders', { partyId: refs.supplier.id, lines: [{ itemId: refs.x.id, qtyMilli: 5000, ratePaise: 100 }] });
  const needBy = addDays(today, 30);
  const plan = await ok('PRODUCTION', 'POST', '/d/ProductionPlan', { planDate: today, items: [{ itemId: refs.top.id, qtyMilli: 10000, requiredBy: needBy }] });
  const planned = await ok('PRODUCTION', 'POST', `/d/ProductionPlan/${plan.id}/a/explode`, {});
  const row = (item) => planned.requirements.find((r) => r.itemId === item.id);
  assert.deepEqual([row(refs.top).supply, row(refs.top).shortMilli, row(refs.top).level], ['MAKE', 10000, 0]);
  assert.deepEqual([row(refs.sub).supply, row(refs.sub).requiredMilli, row(refs.sub).onHandMilli, row(refs.sub).shortMilli], ['MAKE', 10000, 4000, 6000]);
  assert.deepEqual([row(refs.y).supply, row(refs.y).requiredMilli, row(refs.y).onHandMilli, row(refs.y).shortMilli], ['BUY', 18000, 5000, 13000]);
  assert.deepEqual([row(refs.x).supply, row(refs.x).requiredMilli, row(refs.x).onOrderMilli, row(refs.x).shortMilli], ['BUY', 20000, 5000, 15000]);
  // Y takes 7 days to come, so it must be ordered a week before it is needed.
  assert.equal(row(refs.y).orderBy, addDays(needBy, -7));
  assert.equal(row(refs.y).isLate, false);

  const request = await ok('PRODUCTION', 'POST', `/d/ProductionPlan/${plan.id}/a/makeRequest`, {});
  assert.deepEqual(request.lines.map((l) => l.qtyMilli).sort((a, b) => a - b), [13000, 15000], 'only what is bought');

  await ok('PRODUCTION', 'POST', `/d/ProductionPlan/${plan.id}/a/makeWorkOrders`, { targetWarehouseId: refs.stores.id });
  const orders = await ok('PRODUCTION', 'GET', `/d/WorkOrder?productionPlanId=${plan.id}`);
  assert.deepEqual(orders.map((o) => o.qtyMilli).sort((a, b) => a - b), [6000, 10000]);
  const topOrder = orders.find((o) => o.itemId === refs.top.id);
  assert.deepEqual(topOrder.materials.map((m) => m.requiredMilli).sort((a, b) => a - b), [10000, 20000], 'its sub-assembly comes from stock, not its parts');
  await refused('PRODUCTION', 'POST', `/d/ProductionPlan/${plan.id}/a/makeWorkOrders`, { targetWarehouseId: refs.stores.id }, 'ACTION_NOT_AVAILABLE', 422);

  // Once those orders are live they claim the materials, so a second plan sees less free.
  for (const row of orders) await ok('PRODUCTION', 'POST', `/d/WorkOrder/${row.id}/submit`, {});
  const next = await ok('PRODUCTION', 'POST', '/d/ProductionPlan', { planDate: today, items: [{ itemId: refs.sub.id, qtyMilli: 1000 }] });
  const nextPlanned = await ok('PRODUCTION', 'POST', `/d/ProductionPlan/${next.id}/a/explode`, {});
  const y = nextPlanned.requirements.find((r) => r.itemId === refs.y.id);
  assert.equal(y.allocatedMilli, 18000);
  assert.equal(y.shortMilli, 3000 + 18000 - 5000, 'wanted plus claimed, less on hand');
});

test('plans pull in open sales orders once, and the schedule can be filled from a forecast', async () => {
  const order = await post('SALES', '/sales-orders', { partyId: refs.customer.id, deliveryDate: addDays(today, 20), lines: [{ itemId: refs.product.id, qtyMilli: 3000, rateMinor: 100000 }], milestones: [{ no: 1, name: 'On order', trigger: 'ORDER', pctBps: 10000 }] });
  const plan = await ok('PRODUCTION', 'POST', '/d/ProductionPlan', { planDate: today });
  const pulled = await ok('PRODUCTION', 'POST', `/d/ProductionPlan/${plan.id}/a/pullDemand`, { includeSchedule: false });
  const fromOrder = pulled.items.find((i) => i.salesOrderId === order.id);
  assert.ok(fromOrder, 'the order came in');
  assert.equal(fromOrder.source, order.docNo);
  await refused('PRODUCTION', 'POST', `/d/ProductionPlan/${plan.id}/a/pullDemand`, { includeSchedule: false }, 'NO_DEMAND', 422);

  const year = today.slice(0, 4);
  const forecast = await ok('PRODUCTION', 'POST', '/d/SalesForecast', { name: 'FC', lines: [{ itemId: refs.product.id, forMonth: `${year}-06`, qtyMilli: 5000 }, { itemId: refs.product.id, forMonth: `${Number(year) + 3}-01`, qtyMilli: 9000 }] });
  const schedule = await ok('PRODUCTION', 'POST', '/d/MasterProductionSchedule', { name: 'MPS', fromDate: `${year}-01-01`, toDate: `${year}-12-31` });
  const filled = await ok('PRODUCTION', 'POST', `/d/MasterProductionSchedule/${schedule.id}/a/fromForecast`, { forecastId: forecast.id });
  assert.deepEqual(filled.lines.map((l) => [l.onDate, l.qtyMilli]), [[`${year}-06-01`, 5000]], 'only what falls in its dates');
});

test('reports: BOM cost rolls up, where-used climbs, compare spots changes, WIP ties to the ledger', async () => {
  // At today's stock value TOP is SUB (3 Y at Rs 1 = Rs 3) plus 2 X with no stock or standard cost.
  const cost = await ok('PRODUCTION', 'GET', `/r/bom-cost?itemId=${refs.top.id}`);
  const sub = cost.rows.find((r) => r.code === 'SUB');
  assert.equal(sub.rollupPaise, 300);
  assert.equal(cost.rows.find((r) => r.code === 'Y').level, 1);
  await refused('PRODUCTION', 'GET', '/r/bom-cost', undefined, 'ITEM_REQUIRED', 422);

  const used = await ok('PRODUCTION', 'GET', `/r/bom-where-used?itemId=${refs.y.id}`);
  assert.deepEqual(used.rows.map((r) => [r.level, r.code]), [[0, 'SUB'], [1, 'TOP']]);

  const revision = await ok('ENGINEERING', 'POST', '/boms', { itemId: refs.product.id, changeNote: 'Stronger', lines: [{ itemId: refs.m1.id, qtyMilli: 3000 }, { itemId: refs.alt.id, qtyMilli: 1000 }] });
  const compare = await ok('PRODUCTION', 'GET', `/r/bom-compare?firstBomId=${refs.bom.id}&secondBomId=${revision.id}`);
  assert.deepEqual(compare.rows.map((r) => [r.code, r.changeMilli, r.note]), [['ALT', 1000, 'Added'], ['M1', 1000, 'Quantity changed'], ['M2', -1000, 'Removed']]);

  const wip = await ok('PRODUCTION', 'GET', '/r/wip-work-orders');
  assert.equal(wip.totals.wipPaise, await gl(A.WIP_WORK_ORDERS));
  const variance = await ok('ACCOUNTS', 'GET', '/r/work-order-variance');
  assert.equal(variance.totals.varianceValuePaise, await gl(A.MFG_VARIANCE));
  assert.ok((await ok('PRODUCTION', 'GET', '/r/workstation-utilisation')).rows.length >= 1);
});

/* ---------- Subcontracting ---------- */

test('finished goods back from a job worker carry the materials sent, plus the charge', async () => {
  const order = await post('PURCHASE', '/d/SubcontractingOrder', { partyId: refs.worker.id, finishedItemId: refs.scrap.id, qtyMilli: 2000, serviceRatePaise: 50000, supplied: [{ itemId: refs.m1.id, qtyMilli: 4000, fromWarehouseId: refs.stores.id }] });
  await refused('PURCHASE', 'POST', `/d/SubcontractingOrder/${order.id}/a/receive`, { outputMilli: 1000, warehouseId: refs.stores.id }, 'NO_CHALLAN', 422);
  const challan = await ok('PURCHASE', 'POST', `/d/SubcontractingOrder/${order.id}/a/makeChallan`, {});
  await refused('PURCHASE', 'POST', `/d/SubcontractingOrder/${order.id}/a/receive`, { outputMilli: 1000, warehouseId: refs.stores.id }, 'CHALLAN_NOT_OPEN', 422);
  await ok('STORES', 'POST', `/job-work/${challan.id}/submit`, {});
  await refused('PURCHASE', 'POST', `/d/SubcontractingOrder/${order.id}/a/receive`, { outputMilli: 2001, warehouseId: refs.stores.id }, 'OVER_RECEIVED', 422);
  const inventory = await gl(A.INVENTORY);
  const before_ = await bucket(refs.scrap.id);
  // One back: 2 of M1 consumed at Rs 10 is Rs 20, plus a charge of Rs 500.
  const first = await ok('PURCHASE', 'POST', `/d/SubcontractingOrder/${order.id}/a/receive`, { outputMilli: 1000, warehouseId: refs.stores.id, supplierChallanNo: 'THEIR-1' });
  assert.deepEqual([first.receivedMilli, first.materialValuePaise, first.serviceValuePaise], [1000, 2000, 50000]);
  const after_ = await bucket(refs.scrap.id);
  assert.deepEqual([after_.qty - before_.qty, after_.value - before_.value], [1000, 52000]);
  assert.equal(await gl(A.INVENTORY), inventory + 50000, 'materials already were inventory, so only the charge adds');
  assert.equal(await gl(A.JOB_WORK_UNBILLED), -50000);
  await booksAreClean('first receipt');

  const second = await ok('PURCHASE', 'POST', `/d/SubcontractingOrder/${order.id}/a/receive`, { outputMilli: 1000, warehouseId: refs.stores.id });
  assert.equal(second.receivedMilli, 2000);
  const closed = await ok('STORES', 'GET', `/job-work/${challan.id}`);
  assert.equal(closed.status, 'RETURNED');
  assert.equal(closed.lines[0].consumedMilli, 4000);
  assert.equal((await bucket(refs.m1.id, refs.jw.id)).qty, 0);
  await refused('PURCHASE', 'POST', `/d/SubcontractingOrder/${order.id}/cancel`, { reason: 'x' }, 'ALREADY_RECEIVED', 422);

  // The job worker's bill clears the charge.
  await post('ACCOUNTS', '/purchase-invoices', { partyId: refs.worker.id, supplierInvoiceNo: 'JW-BILL', supplierInvoiceDate: today, lines: [{ kind: 'SERVICE', description: 'Labour', expenseAccountCode: A.JOB_WORK_UNBILLED, qtyMilli: 2000, ratePaise: 50000, gstRateBps: 0 }] });
  assert.equal(await gl(A.JOB_WORK_UNBILLED), 0);
  await booksAreClean('subcontracting');
});

/* ---------- Access ---------- */

test('per-record limits: someone limited to one warehouse sees and saves only that', async () => {
  const mine = await ok('ADMIN', 'POST', '/d/Plant', { name: 'Plant A' });
  const theirs = await ok('ADMIN', 'POST', '/d/Plant', { name: 'Plant B' });
  const stationMine = await ok('ADMIN', 'POST', '/d/Workstation', { name: 'Ours', plantId: mine.id });
  const stationTheirs = await ok('ADMIN', 'POST', '/d/Workstation', { name: 'Theirs', plantId: theirs.id });
  await ok('ADMIN', 'POST', '/d/UserPermission', { userId: String(users.PRODUCTION._id), targetDoctype: 'Plant', valueId: mine.id });

  const list = await ok('PRODUCTION', 'GET', '/d/Workstation?limit=200');
  assert.ok(list.some((s) => s.id === stationMine.id));
  assert.equal(list.some((s) => s.id === stationTheirs.id), false);
  const refusedGet = await call('PRODUCTION', 'GET', `/d/Workstation/${stationTheirs.id}`);
  assert.equal(refusedGet.status, 404, 'it does not admit the record exists');
  const refusedSave = await call('PRODUCTION', 'POST', '/d/Workstation', { name: 'Sneaky', plantId: theirs.id });
  assert.equal(refusedSave.status, 403);
  const refusedEdit = await call('PRODUCTION', 'PATCH', `/d/Workstation/${stationMine.id}`, { name: 'Ours', plantId: theirs.id });
  assert.equal(refusedEdit.status, 403);
  // The admin is not limited, nor is anyone else.
  assert.ok((await ok('ADMIN', 'GET', '/d/Workstation?limit=200')).some((s) => s.id === stationTheirs.id));
  assert.ok((await ok('ENGINEERING', 'GET', '/d/Workstation?limit=200')).some((s) => s.id === stationTheirs.id));
  const rows = await ok('ADMIN', 'GET', `/d/UserPermission?userId=${users.PRODUCTION._id}`);
  await ok('ADMIN', 'DELETE', `/d/UserPermission/${rows[0].id}`);
});

test('a portal sign-in sees only its own party, and every staff route is shut', async () => {
  await refused('PORTAL', 'GET', '/portal/me', undefined, 'NO_PARTY', 422);
  await ok('ADMIN', 'PATCH', `/admin/users/${users.PORTAL._id}`, { partyId: refs.customer.id });

  for (const path of ['/items', '/parties', '/sales-invoices', '/d/Lead', '/d/Employee', '/r/day-book', '/reports/trial-balance', '/search?q=abc', '/notifications', '/views/dashboards', '/views/backups', '/admin/settings', '/comments']) {
    const result = await call('PORTAL', 'GET', path);
    assert.equal(result.status, 403, `${path} must be shut, got ${result.status}`);
  }
  const meta = await ok('PORTAL', 'GET', '/meta');
  assert.equal(meta.doctypes.length, 0);
  assert.equal(meta.reports.length, 0);

  const sale = (partyId) => post('ACCOUNTS', '/sales-invoices', { partyId, lines: [{ kind: 'SERVICE', itemId: refs.m1.id, qtyMilli: 1000, rateMinor: 100000 }] });
  const mine = await sale(refs.customer.id);
  const theirs = await sale(refs.rival.id);
  const invoices = await ok('PORTAL', 'GET', '/portal/invoices');
  assert.deepEqual(invoices.map((i) => i.docNo), [mine.docNo]);
  assert.equal(invoices[0].outstandingPaise, 118000);
  assert.equal(JSON.stringify(invoices).includes(theirs.docNo), false);
  assert.equal('costPaise' in invoices[0], false);
  const me = await ok('PORTAL', 'GET', '/portal/me');
  assert.deepEqual([me.name, me.youOwePaise], ['Customer One', 118000]);

  const ticket = await ok('PORTAL', 'POST', '/portal/tickets', { subject: 'Machine stopped', description: 'Alarm 12' });
  const tickets = await ok('PORTAL', 'GET', '/portal/tickets');
  assert.deepEqual(tickets.map((t) => t.id), [ticket.id]);
  const issue = await ok('SERVICE', 'GET', `/d/Issue/${ticket.id}`);
  assert.equal(issue.partyId, refs.customer.id, 'the party is forced, not taken from the request');
  const forged = await call('PORTAL', 'POST', '/portal/tickets', { subject: 'x', partyId: refs.rival.id });
  assert.equal(forged.status, 400);

  assert.equal((await call('ADMIN', 'GET', '/portal/me')).status, 403);
});

test('public web forms take only the listed fields, and nothing when unpublished', async () => {
  await refused('ADMIN', 'POST', '/d/WebForm', { title: 'Bad', slug: 'BAD SLUG', doctypeName: 'Lead', formFields: [] }, 'BAD_SLUG', 422);
  const leadFields = await ok('ADMIN', 'GET', '/meta').then((m) => m.doctypes.find((d) => d.name === 'Lead').fields);
  const required = leadFields.filter((f) => f.required && !f.computed).map((f) => f.key);
  await refused('ADMIN', 'POST', '/d/WebForm', { title: 'Short', slug: 'short', doctypeName: 'Lead', formFields: [] }, 'FORM_MISSING_REQUIRED', 422);
  const link = leadFields.find((f) => f.type === 'link' && !f.computed);
  await refused('ADMIN', 'POST', '/d/WebForm', { title: 'Link', slug: 'link', doctypeName: 'Lead', formFields: [...required.map((fieldKey) => ({ fieldKey })), { fieldKey: link.key }] }, 'BAD_FORM_FIELD', 422);

  const form = await ok('ADMIN', 'POST', '/d/WebForm', { title: 'Enquire', slug: 'enquire', doctypeName: 'Lead', isPublished: false, successMessage: 'Thanks', formFields: required.map((fieldKey) => ({ fieldKey })) });
  const closed = await call(null, 'GET', '/public/forms/enquire');
  assert.equal(closed.status, 404);
  await ok('ADMIN', 'PATCH', `/d/WebForm/${form.id}`, { title: 'Enquire', slug: 'enquire', doctypeName: 'Lead', isPublished: true, successMessage: 'Thanks', formFields: required.map((fieldKey) => ({ fieldKey })) });

  const open = await call(null, 'GET', '/public/forms/enquire');
  assert.equal(open.status, 200);
  assert.deepEqual(open.body.data.fields.map((f) => f.key), required);

  const countBefore = (await ok('SALES', 'GET', '/d/Lead?limit=200')).length;
  const missing = await call(null, 'POST', '/public/forms/enquire', {});
  assert.equal(missing.status, 400);
  const values = Object.fromEntries(required.map((key) => [key, 'Web visitor']));
  // A field not on the form is ignored, whatever is sent.
  const sent = await call(null, 'POST', '/public/forms/enquire', { ...values, ownerId: 'evil', status: 'CONVERTED' });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.data.message, 'Thanks');
  const leads = await ok('SALES', 'GET', '/d/Lead?limit=200');
  assert.equal(leads.length, countBefore + 1);
  const newest = leads.find((l) => required.every((key) => l[key] === 'Web visitor'));
  assert.ok(newest);
  assert.equal(newest.ownerId ?? null, null);
  // A bot fills the hidden field: it is thanked, and nothing is saved.
  await call(null, 'POST', '/public/forms/enquire', { ...values, website: 'http://spam.example' });
  assert.equal((await ok('SALES', 'GET', '/d/Lead?limit=200')).length, countBefore + 1);
});

test('backup and restore: every record comes back, damage is caught, and live data is not overwritten', async () => {
  const backup = await ok('ADMIN', 'POST', '/views/backups');
  assert.ok(backup.bytes > 0);
  const listed = await ok('ADMIN', 'GET', '/views/backups');
  assert.equal(listed[0].name, backup.name);
  await refused('STORES', 'GET', '/views/backups', undefined, 'FORBIDDEN', 403);

  const scratch = mongoose.connection.useDb('forge-erp-restore-test', { useCache: false });
  await scratch.db.dropDatabase();
  try {
    const file = backupPath(backup.name);
    const restored = await restoreBackup({ file, db: scratch.db });
    assert.equal(restored.documents, listed[0].documents);
    const live = mongoose.connection.db;
    assert.equal(await scratch.db.collection('glentries').countDocuments(), await live.collection('glentries').countDocuments());
    const entry = await live.collection('glentries').findOne({});
    const copy = await scratch.db.collection('glentries').findOne({ _id: entry._id });
    assert.deepEqual(copy, entry, 'types such as ids and dates survive exactly');
    const indexes = await scratch.db.collection('auditlogs').indexes();
    assert.ok(indexes.some((i) => i.unique && i.key.seq === 1), 'unique indexes come back too');

    await assert.rejects(restoreBackup({ file, db: scratch.db }), /not empty/);

    const bytes = await fs.readFile(file);
    const damaged = `${file}.damaged.jsonl.gz`;
    const flipped = Buffer.from(bytes);
    flipped[flipped.length - 20] ^= 0xff;
    await fs.writeFile(damaged, flipped);
    await fs.copyFile(file.replace('.jsonl.gz', '.json'), damaged.replace('.jsonl.gz', '.json'));
    await assert.rejects(restoreBackup({ file: damaged, db: scratch.db, replace: true }), /checksum/);
    await fs.rm(damaged);
    await fs.rm(damaged.replace('.jsonl.gz', '.json'));
  } finally {
    await scratch.db.dropDatabase();
  }
});

/* ---------- CSV ---------- */

test('importing: masters from a spreadsheet, and documents with their lines', async () => {
  const items = 'code,name,type,hsn,gstRateBps,reorderLevelMilli\nCSV1,First CSV item,RAW,7318,18,12.5\nCSV2,Second CSV item,RAW,7318,18,\nCSV1,Duplicate,RAW,7318,18,';
  const dry = await ok('ADMIN', 'POST', '/items/import', { csv: items });
  assert.equal(dry.dryRun, true);
  assert.equal((await call('ADMIN', 'GET', '/items?q=CSV1')).body.data.length, 0, 'a dry run saves nothing');
  const real = await ok('ADMIN', 'POST', '/items/import', { csv: items, dryRun: false });
  assert.deepEqual([real.ok, real.errorCount, real.errors[0].row, real.errors[0].message], [2, 1, 4, 'This one already exists.']);
  const first = (await ok('ADMIN', 'GET', '/items?q=CSV1'))[0];
  assert.deepEqual([first.reorderLevelMilli, first.gstRateBps], [12500, 1800]);
  await refused('STORES', 'POST', '/parties/import', { csv: 'code,name\nZ,Z' }, 'FORBIDDEN', 403);
  const parties = await ok('ADMIN', 'POST', '/parties/import', { csv: 'code,name,isCustomer,stateCode\nCSVP,CSV party,yes,24', dryRun: false });
  assert.equal(parties.ok, 1);

  // Rows with the same _key are one document. Links can be written by code.
  const csv = [
    '_key,title,partyId,fromDate,toDate,lines.itemId,lines.qtyMilli,lines.ratePaise',
    `A,First,C1,${today},${addDays(today, 30)},M1,5,12.50`,
    `A,First,C1,${today},${addDays(today, 30)},M2,2,20`,
    `B,Second,C2,${today},${addDays(today, 30)},M1,1,10`,
  ].join('\n');
  const check = await ok('SALES', 'POST', '/d/BlanketOrder/import', { csv });
  assert.deepEqual([check.total, check.ok, check.errorCount], [2, 2, 0]);
  await ok('SALES', 'POST', '/d/BlanketOrder/import', { csv, dryRun: false });
  const rows = await ok('SALES', 'GET', '/d/BlanketOrder?q=First');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].lines.map((l) => [l.qtyMilli, l.ratePaise]), [[5000, 1250], [2000, 2000]]);
  await refused('SALES', 'POST', '/d/BlanketOrder/import', { csv: 'title,lines.qtyMilli\nX,1' }, 'VALIDATION_FAILED', 400);
});

/* ---------- Shared screens ---------- */

test('board moves, history shows what changed, dashboards and print formats', async () => {
  const task = await ok('ENGINEERING', 'POST', '/d/Task', { subject: 'Check drawing', status: 'OPEN' });
  const moved = await ok('ENGINEERING', 'POST', `/d/Task/${task.id}/set`, { field: 'status', value: 'WORKING' });
  assert.equal(moved.status, 'WORKING');
  await refused('ENGINEERING', 'POST', `/d/Task/${task.id}/set`, { field: 'status', value: 'NONSENSE' }, 'BAD_CHOICE', 422);
  await refused('ENGINEERING', 'POST', `/d/Task/${task.id}/set`, { field: 'subject', value: 'Other' }, 'NOT_SETTABLE', 422);
  await refused('ENGINEERING', 'POST', `/d/Task/${task.id}/set`, { field: 'actualHoursMilli', value: '5' }, 'NOT_SETTABLE', 422);

  await ok('ENGINEERING', 'PATCH', `/d/Task/${task.id}`, { subject: 'Check the drawing', status: 'WORKING' });
  const history = await ok('ENGINEERING', 'GET', `/timeline?entityType=Task&entityId=${task.id}`);
  const edit = history.find((row) => row.data?.after?.subject);
  assert.deepEqual([edit.data.before.subject, edit.data.after.subject], ['Check drawing', 'Check the drawing']);
  assert.equal('status' in edit.data.after, false, 'only what actually changed');

  const openTasks = await ok('ADMIN', 'POST', '/d/NumberCard', { label: 'Tasks in progress', doctypeName: 'Task', measure: 'COUNT', filters: [{ fieldKey: 'status', value: 'WORKING' }] });
  const stock = await ok('ADMIN', 'POST', '/d/NumberCard', { label: 'WIP', source: 'REPORT', reportKey: 'wip-work-orders', reportColumn: 'wipPaise', format: 'MONEY' });
  const secret = await ok('ADMIN', 'POST', '/d/NumberCard', { label: 'Pay', doctypeName: 'SalarySlip', measure: 'COUNT' });
  const bad = await ok('ADMIN', 'POST', '/d/NumberCard', { label: 'Broken', doctypeName: 'Task', measure: 'SUM', sumField: 'subject' });
  const chart = await ok('ADMIN', 'POST', '/d/DashboardChart', { title: 'Tasks by status', doctypeName: 'Task', groupByField: 'status' });
  const dash = await ok('ADMIN', 'POST', '/d/Dashboard', { name: 'Works', cards: [openTasks, stock, secret, bad].map((c) => ({ cardId: c.id })), charts: [{ chartId: chart.id }] });
  const asAdmin = await ok('ADMIN', 'GET', `/views/dashboards/${dash.id}`);
  const card = (data, label) => data.cards.find((c) => c.label === label);
  assert.equal(card(asAdmin, 'Tasks in progress').value, 1);
  assert.equal(card(asAdmin, 'WIP').value, await gl(A.WIP_WORK_ORDERS));
  assert.ok(card(asAdmin, 'Broken').error, 'one bad tile explains itself and does not stop the rest');
  assert.deepEqual(asAdmin.charts[0].points.find((p) => p.label === 'WORKING').value, 1);
  // Someone without access to pay sees the rest of the dashboard, but not that figure.
  const asStores = await ok('STORES', 'GET', `/views/dashboards/${dash.id}`);
  assert.equal(card(asStores, 'Pay').value, undefined);
  assert.match(card(asStores, 'Pay').error, /permission/);

  await ok('ADMIN', 'POST', '/d/LetterHead', { name: 'Main', headerText: 'Works address', isDefault: true });
  await ok('ADMIN', 'POST', '/d/PrintFormat', { name: 'Short invoice', doctypeName: 'salesInvoices', isDefault: true, blocks: [{ kind: 'HEADING', text: 'Tax invoice {{docNo}}' }, { kind: 'FIELDS', fields: 'partyName,dueDate' }, { kind: 'LINES' }] });
  const formats = await ok('STORES', 'GET', '/views/print-formats/salesInvoices');
  assert.equal(formats.formats[0].blocks[0].text, 'Tax invoice {{docNo}}');
  assert.equal(formats.letterHeads[0].headerText, 'Works address');

  const steps = await ok('ADMIN', 'GET', '/views/setup-status');
  assert.ok(steps.steps.find((s) => s.key === 'items').done);
  assert.equal(steps.steps.find((s) => s.key === 'ca').done, false);
  await refused('STORES', 'GET', '/views/setup-status', undefined, 'FORBIDDEN', 403);
});

/* ---------- Rules in the books ---------- */

test('approval limits, closed periods, dimension rules and expired batches are enforced', async () => {
  // Approval limits. Over Rs 1,000 needs management.
  await ok('ADMIN', 'POST', '/d/AuthorizationRule', { name: 'Big proforma orders', doctypeName: 'SalesOrder', basedOn: 'GRAND_TOTAL', approvingRole: 'MANAGEMENT', limitPaise: 100000 });
  const big = await ok('SALES', 'POST', '/sales-orders', { partyId: refs.customer.id, lines: [{ itemId: refs.m1.id, qtyMilli: 1000, rateMinor: 100001 }], milestones: [{ no: 1, name: 'All', trigger: 'ORDER', pctBps: 10000 }] });
  const error = await refused('SALES', 'POST', `/sales-orders/${big.id}/submit`, {}, 'NEEDS_AUTHORITY', 422);
  assert.equal(error.details?.role ?? 'MANAGEMENT', 'MANAGEMENT');
  await ok('MANAGEMENT', 'POST', `/sales-orders/${big.id}/submit`, {});

  // Closed periods stop any posting in them, whoever raises it.
  const month = addDays(today, -400).slice(0, 7);
  const period = await ok('ADMIN', 'POST', '/d/AccountingPeriod', { name: 'Old month', startDate: `${month}-01`, endDate: `${month}-28`, isClosed: true });
  await refused('ADMIN', 'POST', '/d/AccountingPeriod', { name: 'Clash', startDate: `${month}-10`, endDate: `${month}-20` }, 'PERIOD_OVERLAP', 422);
  const journal = (onDate, lines) => post('ACCOUNTS', '/journals', { postingDate: onDate, narration: 'Test', lines });
  const dated = `${month}-15`;
  const two = [{ accountCode: A.RENT, debitPaise: 100 }, { accountCode: A.BANK, creditPaise: 100 }];
  const closedTry = await ok('ACCOUNTS', 'POST', '/journals', { postingDate: dated, narration: 'Test', lines: two });
  await refused('ACCOUNTS', 'POST', `/journals/${closedTry.id}/submit`, {}, 'PERIOD_CLOSED', 422);
  await ok('ACCOUNTS', 'DELETE', `/journals/${closedTry.id}`);
  await ok('ADMIN', 'PATCH', `/d/AccountingPeriod/${period.id}`, { name: 'Old month', startDate: `${month}-01`, endDate: `${month}-28`, isClosed: false });

  // Dimension rules. Rent must name a cost centre, and only an allowed one.
  const centre = await ok('ACCOUNTS', 'POST', '/d/CostCenter', { name: 'Works' });
  const other = await ok('ACCOUNTS', 'POST', '/d/CostCenter', { name: 'Office' });
  await ok('ACCOUNTS', 'POST', '/d/AccountingDimensionFilter', { accountCode: A.RENT, dimension: 'COST_CENTER', isMandatory: true, allowed: [{ valueId: centre.id }] });
  const noCentre = await ok('ACCOUNTS', 'POST', '/journals', { narration: 'Rent', lines: two });
  await refused('ACCOUNTS', 'POST', `/journals/${noCentre.id}/submit`, {}, 'DIMENSION_REQUIRED', 422);
  const wrong = await ok('ACCOUNTS', 'POST', '/journals', { narration: 'Rent', lines: [{ accountCode: A.RENT, debitPaise: 100, costCenterId: other.id }, { accountCode: A.BANK, creditPaise: 100 }] });
  await refused('ACCOUNTS', 'POST', `/journals/${wrong.id}/submit`, {}, 'DIMENSION_NOT_ALLOWED', 422);
  await journal(today, [{ accountCode: A.RENT, debitPaise: 100, costCenterId: centre.id }, { accountCode: A.BANK, creditPaise: 100 }]);

  // Expired batches are not picked, unless the setting is switched off.
  const item = await ok('ADMIN', 'POST', '/items', { code: 'CHEM', name: 'Chemical', type: 'RAW', hsn: '2800', gstRateBps: 1800 });
  await ok('STORES', 'POST', '/d/Batch', { batchNo: 'OLD-1', itemId: item.id, expiresOn: addDays(today, -1) });
  await ok('STORES', 'POST', '/d/Batch', { batchNo: 'NEW-1', itemId: item.id, expiresOn: addDays(today, 100) });
  await opening([{ itemId: item.id, qtyMilli: 2000, toWarehouseId: refs.stores.id, ratePaise: 100, lot: 'OLD-1' }, { itemId: item.id, qtyMilli: 1000, toWarehouseId: refs.stores.id, ratePaise: 100, lot: 'NEW-1' }]);
  const made = await ok('ADMIN', 'POST', '/items', { code: 'MIX', name: 'Mixture', type: 'ASSEMBLY', hsn: '2800', gstRateBps: 1800 });
  const bom = await ok('ENGINEERING', 'POST', '/boms', { itemId: made.id, lines: [{ itemId: item.id, qtyMilli: 1000 }] });
  await ok('ENGINEERING', 'POST', `/boms/${bom.id}/release`);
  const order = await post('PRODUCTION', '/d/WorkOrder', { itemId: made.id, bomId: bom.id, qtyMilli: 2000, targetWarehouseId: refs.stores.id });
  const blocked = await refused('PRODUCTION', 'POST', `/d/WorkOrder/${order.id}/a/issue`, {}, 'INSUFFICIENT_STOCK', 422);
  assert.match(blocked.message, /OLD-1/);
  const report = await ok('STORES', 'GET', '/r/batch-expiry?withinDays=30');
  assert.deepEqual(report.rows.map((r) => [r.batchNo, r.qtyMilli]), [['OLD-1', 2000]]);
  const small = await post('PRODUCTION', '/d/WorkOrder', { itemId: made.id, bomId: bom.id, qtyMilli: 1000, targetWarehouseId: refs.stores.id });
  await act(small.id, 'issue');
  assert.equal((await ok('STORES', 'GET', `/reports/stock-balance?itemId=${item.id}`)).rows.find((r) => r.lot === 'NEW-1')?.qtyMilli ?? 0, 0);
  await ok('ADMIN', 'PATCH', '/admin/settings', { blockExpiredBatches: false });
  await act(order.id, 'issue');
  await ok('ADMIN', 'PATCH', '/admin/settings', { blockExpiredBatches: true });
  await booksAreClean('rules');
});

test('payment matching sets unallocated money against the oldest bills', async () => {
  const party = await ok('ADMIN', 'POST', '/parties', { code: 'MATCH', name: 'Matching customer', isCustomer: true, stateCode: '24' });
  const sale = (rate, due) => post('ACCOUNTS', '/sales-invoices', { partyId: party.id, dueDate: due, lines: [{ kind: 'SERVICE', itemId: refs.m1.id, qtyMilli: 1000, rateMinor: rate, gstRateBps: 0 }] });
  const older = await sale(100000, addDays(today, 1));
  const newer = await sale(100000, addDays(today, 40));
  await post('ACCOUNTS', '/payments', { kind: 'RECEIPT', partyId: party.id, bankAccountCode: A.BANK, amountMinor: 150000 });
  const run = await ok('ACCOUNTS', 'POST', '/d/PaymentReconciliation', { partyId: party.id, kind: 'RECEIPT' });
  const done = await ok('ACCOUNTS', 'POST', `/d/PaymentReconciliation/${run.id}/a/match`, {});
  assert.deepEqual(done.matches.map((m) => [m.invoiceNo, m.amountPaise]), [[older.docNo, older.totalPaise], [newer.docNo, 150000 - older.totalPaise]]);
  assert.equal((await ok('ACCOUNTS', 'GET', `/sales-invoices/${older.id}`)).paidPaise, older.totalPaise);
  await refused('ACCOUNTS', 'POST', `/d/PaymentReconciliation/${run.id}/a/match`, {}, 'ACTION_NOT_AVAILABLE', 422);
  const again = await ok('ACCOUNTS', 'POST', '/d/PaymentReconciliation', { partyId: party.id, kind: 'RECEIPT' });
  await refused('ACCOUNTS', 'POST', `/d/PaymentReconciliation/${again.id}/a/match`, {}, 'NOTHING_TO_MATCH', 422);
  await booksAreClean('payment matching');
});

/* ---------- People ---------- */

test('recruitment: interview clash, majority result, offer, employee, onboarding', async () => {
  const designation = await ok('HR', 'POST', '/d/Designation', { name: 'Fitter' });
  await ok('HR', 'POST', '/d/StaffingPlan', { name: 'Plan', fromDate: addDays(today, -5), toDate: addDays(today, 5), rows: [{ designationId: designation.id, vacancies: 2 }] });
  await refused('HR', 'POST', '/d/JobOpening', { title: 'Too many', designationId: designation.id, vacancies: 3 }, 'OVER_STAFFING_PLAN', 422);
  const opening_ = await ok('HR', 'POST', '/d/JobOpening', { title: 'Fitter', designationId: designation.id, vacancies: 2 });
  const applicant = await ok('HR', 'POST', '/d/JobApplicant', { applicantName: 'Ravi', email: 'ravi@example.com', jobOpeningId: opening_.id });

  const panel = [{ userId: String(users.HR._id) }, { userId: String(users.MANAGEMENT._id) }, { userId: String(users.PRODUCTION._id) }];
  const interview = await ok('HR', 'POST', '/d/Interview', { applicantId: applicant.id, onDate: today, fromTime: '10:00', toTime: '11:00', interviewers: panel });
  await refused('HR', 'POST', '/d/Interview', { applicantId: applicant.id, onDate: today, fromTime: '10:30', toTime: '11:30', interviewers: [panel[0]] }, 'INTERVIEWER_BUSY', 422);
  await refused('HR', 'POST', '/d/InterviewFeedback', { interviewId: interview.id, interviewerId: String(users.ACCOUNTS._id), result: 'CLEARED' }, 'NOT_AN_INTERVIEWER', 422);
  const give = (who, result) => ok('HR', 'POST', '/d/InterviewFeedback', { interviewId: interview.id, interviewerId: String(users[who]._id), result });
  await give('HR', 'CLEARED');
  await refused('HR', 'POST', '/d/InterviewFeedback', { interviewId: interview.id, interviewerId: String(users.HR._id), result: 'REJECTED' }, 'FEEDBACK_EXISTS', 409);
  await give('MANAGEMENT', 'REJECTED');
  assert.equal((await ok('HR', 'GET', `/d/Interview/${interview.id}`)).state, 'PENDING', 'not until everyone has spoken');
  await give('PRODUCTION', 'CLEARED');
  assert.equal((await ok('HR', 'GET', `/d/Interview/${interview.id}`)).state, 'CLEARED', 'two against one');

  const offer = await post('HR', '/d/JobOffer', { applicantId: applicant.id, designationId: designation.id, offerDate: today, monthlyCtcPaise: 3000000 });
  await refused('HR', 'POST', `/d/JobOffer/${offer.id}/a/makeEmployee`, { joiningDate: today }, 'ACTION_NOT_AVAILABLE', 422);
  await ok('HR', 'POST', `/d/JobOffer/${offer.id}/a/accepted`, {});
  const template = await ok('HR', 'POST', '/d/EmployeeOnboardingTemplate', { name: 'Standard', activities: [{ activity: 'Safety induction' }, { activity: 'Issue PPE' }] });
  const employee = await ok('HR', 'POST', `/d/JobOffer/${offer.id}/a/makeEmployee`, { joiningDate: today, onboardingTemplateId: template.id });
  assert.equal(employee.fullName, 'Ravi');
  assert.equal(employee.email, 'ravi@example.com');
  const onboarding = (await ok('HR', 'GET', `/d/EmployeeOnboarding?employeeId=${employee.id}`))[0];
  assert.equal(onboarding.activities.length, 2);
  assert.equal(onboarding.state, 'PENDING');
  const half = await ok('HR', 'PATCH', `/d/EmployeeOnboarding/${onboarding.id}`, { employeeId: employee.id, startDate: today, activities: [{ activity: 'Safety induction', isDone: true }, { activity: 'Issue PPE' }] });
  assert.equal(half.state, 'IN_PROGRESS');
  assert.equal((await ok('HR', 'GET', `/d/JobOpening/${opening_.id}`)).hiredCount, 1);
});

test('pay items reach the slip through additional salary, and cancelling takes them back', async () => {
  const person = await ok('HR', 'POST', '/d/Employee', { fullName: 'Meena', joiningDate: '2020-01-01' });
  const incentive = await post('HR', '/d/EmployeeIncentive', { employeeId: person.id, amountPaise: 500000, forMonth: today, reason: 'Good month' });
  const extra = await ok('HR', 'GET', `/d/AdditionalSalary/${incentive.additionalSalaryId}`);
  assert.deepEqual([extra.status, extra.amountPaise, extra.employeeId], ['SUBMITTED', 500000, person.id]);
  await ok('HR', 'POST', `/d/EmployeeIncentive/${incentive.id}/cancel`, { reason: 'Mistake' });
  assert.equal((await ok('HR', 'GET', `/d/AdditionalSalary/${incentive.additionalSalaryId}`)).status, 'CANCELLED');

  const period = await ok('HR', 'POST', '/d/LeavePeriod', { name: 'This year', fromDate: `${today.slice(0, 4)}-01-01`, toDate: `${today.slice(0, 4)}-12-31` });
  const annual = await ok('HR', 'POST', '/d/LeaveType', { name: 'Annual', annualAllocationHalfDays: 0 });
  const allocation = await post('HR', '/d/LeaveAllocation', { employeeId: person.id, leaveTypeId: annual.id, periodId: period.id, halfDays: 10 });
  assert.ok(allocation.docNo);
  await refused('HR', 'POST', `/d/LeaveEncashment/${(await ok('HR', 'POST', '/d/LeaveEncashment', { employeeId: person.id, leaveTypeId: annual.id, halfDays: 11, amountPaise: 1000 })).id}/submit`, {}, 'NOT_ENOUGH_LEAVE', 422);
  // Encash 3 days of the 5, and 2 are left.
  const cash = await post('HR', '/d/LeaveEncashment', { employeeId: person.id, leaveTypeId: annual.id, halfDays: 6, amountPaise: 300000 });
  assert.ok(cash.additionalSalaryId);
  await refused('HR', 'POST', `/d/LeaveEncashment/${(await ok('HR', 'POST', '/d/LeaveEncashment', { employeeId: person.id, leaveTypeId: annual.id, halfDays: 5, amountPaise: 1000 })).id}/submit`, {}, 'NOT_ENOUGH_LEAVE', 422);

  const comp = await ok('HR', 'POST', '/d/LeaveType', { name: 'Comp off', isCompensatory: true });
  const compRequest = await ok('HR', 'POST', '/d/CompensatoryLeaveRequest', { employeeId: person.id, leaveTypeId: comp.id, workedOn: today });
  await refused('HR', 'POST', `/d/CompensatoryLeaveRequest/${compRequest.id}/submit`, {}, 'NO_ATTENDANCE', 422);
  await ok('HR', 'POST', '/d/Attendance', { employeeId: person.id, onDate: today, state: 'PRESENT' });
  const given = await ok('HR', 'POST', `/d/CompensatoryLeaveRequest/${compRequest.id}/submit`, {});
  assert.equal((await ok('HR', 'GET', `/d/LeaveAllocation/${given.allocationId}`)).halfDays, 2);

  await ok('HR', 'POST', '/d/ShiftType', { name: 'Day', startTime: '09:00', endTime: '17:00' }).then(async (shift) => {
    await ok('HR', 'POST', '/d/ShiftAssignment', { employeeId: person.id, shiftTypeId: shift.id, startDate: today, endDate: addDays(today, 5), isActive: true });
    await refused('HR', 'POST', '/d/ShiftAssignment', { employeeId: person.id, shiftTypeId: shift.id, startDate: addDays(today, 5), isActive: true }, 'SHIFT_OVERLAP', 422);
    const request = await post('HR', '/d/ShiftRequest', { employeeId: person.id, shiftTypeId: shift.id, fromDate: addDays(today, 6), toDate: addDays(today, 7) });
    assert.ok(request.assignmentId);
    await ok('HR', 'POST', `/d/ShiftRequest/${request.id}/cancel`, { reason: 'No need' });
    assert.equal((await ok('HR', 'GET', `/d/ShiftAssignment/${request.assignmentId}`)).isActive, false);
  });
});

test('bulk tools mark whoever is due, and leave alone whoever already has it', async () => {
  const department = await ok('HR', 'POST', '/d/Department', { name: 'Press shop' });
  const one = await ok('HR', 'POST', '/d/Employee', { fullName: 'A', joiningDate: '2020-01-01', departmentId: department.id });
  const two = await ok('HR', 'POST', '/d/Employee', { fullName: 'B', joiningDate: '2020-01-01', departmentId: department.id });
  await ok('HR', 'POST', '/d/Attendance', { employeeId: one.id, onDate: today, state: 'ON_LEAVE' });
  const tool = await ok('HR', 'POST', '/d/EmployeeAttendanceTool', { onDate: today, state: 'PRESENT', departmentId: department.id });
  const applied = await ok('HR', 'POST', `/d/EmployeeAttendanceTool/${tool.id}/a/apply`, {});
  assert.deepEqual([applied.done, applied.skipped], [1, 1]);
  const marks = await ok('HR', 'GET', `/d/Attendance?onDate=${today}&limit=200`);
  assert.equal(marks.find((m) => m.employeeId === one.id).state, 'ON_LEAVE', 'leave is not overwritten');
  assert.equal(marks.find((m) => m.employeeId === two.id).state, 'PRESENT');

  const empty = await ok('HR', 'POST', '/d/Department', { name: 'Empty' });
  const none = await ok('HR', 'POST', '/d/EmployeeAttendanceTool', { onDate: today, departmentId: empty.id });
  await refused('HR', 'POST', `/d/EmployeeAttendanceTool/${none.id}/a/apply`, {}, 'NOBODY', 422);

  const period = (await ok('HR', 'GET', '/d/LeavePeriod'))[0];
  const type = await ok('HR', 'POST', '/d/LeaveType', { name: 'Sick' });
  const panel = await ok('HR', 'POST', '/d/LeaveControlPanel', { periodId: period.id, leaveTypeId: type.id, halfDays: 8, departmentId: department.id });
  const given = await ok('HR', 'POST', `/d/LeaveControlPanel/${panel.id}/a/apply`, {});
  assert.deepEqual([given.done, given.skipped], [2, 0]);
  const panelAgain = await ok('HR', 'POST', '/d/LeaveControlPanel', { periodId: period.id, leaveTypeId: type.id, halfDays: 8, departmentId: department.id });
  const second = await ok('HR', 'POST', `/d/LeaveControlPanel/${panelAgain.id}/a/apply`, {});
  assert.deepEqual([second.done, second.skipped], [0, 2], 'running it twice gives nobody double');
});

/* ---------- Selling, buying, quality and the rest ---------- */

test('selling: proforma prices like an invoice, blanket orders limit call-offs, packing limits weight', async () => {
  // Rs 1,000 at 18% in the same state.
  const proforma = await ok('SALES', 'POST', '/d/ProformaInvoice', { partyId: refs.customer.id, lines: [{ itemId: refs.m1.id, qtyMilli: 1000, ratePaise: 100000, gstRateBps: 1800 }] });
  assert.deepEqual([proforma.taxablePaise, proforma.taxPaise, proforma.totalPaise], [100000, 18000, 118000]);
  const order = await ok('SALES', 'POST', `/d/ProformaInvoice/${proforma.id}/a/makeSalesOrder`, {});
  assert.equal(order.status, 'DRAFT');
  await refused('SALES', 'POST', `/d/ProformaInvoice/${proforma.id}/a/makeSalesOrder`, {}, 'ACTION_NOT_AVAILABLE', 422);

  await refused('SALES', 'POST', '/d/BlanketOrder', { title: 'Backwards', partyId: refs.customer.id, fromDate: today, toDate: addDays(today, -1), lines: [{ itemId: refs.m1.id, qtyMilli: 1000, ratePaise: 100 }] }, 'BAD_DATES', 422);
  const blanket = await ok('SALES', 'POST', '/d/BlanketOrder', { title: 'Year deal', partyId: refs.customer.id, fromDate: today, toDate: addDays(today, 30), lines: [{ itemId: refs.m1.id, qtyMilli: 5000, ratePaise: 900 }] });
  await refused('SALES', 'POST', `/d/BlanketOrder/${blanket.id}/a/callOff`, { itemId: refs.m1.id, qtyMilli: 5001 }, 'OVER_BLANKET', 422);
  const called = await ok('SALES', 'POST', `/d/BlanketOrder/${blanket.id}/a/callOff`, { itemId: refs.m1.id, qtyMilli: 3000 });
  assert.equal(called.lines[0].rateMinor, 900, 'at the agreed rate');
  assert.equal((await ok('SALES', 'GET', `/d/BlanketOrder/${blanket.id}`)).lines[0].orderedMilli, 3000);
  await refused('SALES', 'POST', `/d/BlanketOrder/${blanket.id}/a/callOff`, { itemId: refs.m1.id, qtyMilli: 2001 }, 'OVER_BLANKET', 422);
  await refused('SALES', 'POST', `/d/BlanketOrder/${blanket.id}/a/callOff`, { itemId: refs.m2.id, qtyMilli: 1 }, 'NOT_ON_ORDER', 422);

  const note = await post('STORES', '/d/DeliveryNote', { partyId: refs.customer.id, lines: [{ itemId: refs.m1.id, qtyMilli: 2000 }] });
  await refused('STORES', 'POST', '/d/PackingSlip', { deliveryNoteId: note.id, netWeightMilli: 2, grossWeightMilli: 1, lines: [{ itemId: refs.m1.id, qtyMilli: 1 }] }, 'BAD_WEIGHT', 422);
  await ok('STORES', 'POST', '/d/PackingSlip', { deliveryNoteId: note.id, lines: [{ itemId: refs.m1.id, qtyMilli: 1500 }] });
  await refused('STORES', 'POST', '/d/PackingSlip', { deliveryNoteId: note.id, lines: [{ itemId: refs.m1.id, qtyMilli: 501 }] }, 'OVER_PACKED', 422);

  const list = await ok('STORES', 'POST', '/d/PickList', { purpose: 'DELIVERY', deliveryNoteId: note.id });
  const generated = await ok('STORES', 'POST', `/d/PickList/${list.id}/a/generate`, {});
  assert.ok(generated.lines.length >= 1);
  assert.equal(generated.lines.reduce((sum, l) => sum + l.qtyMilli, 0), 2000);
  const picked = await ok('STORES', 'POST', `/d/PickList/${list.id}/a/confirm`, {});
  assert.equal(picked.state, 'PICKED');

  const shipment = await ok('STORES', 'POST', '/d/Shipment', { partyId: refs.customer.id, parcels: [{ weightMilli: 2500, count: 2 }, { weightMilli: 1000, count: 1 }] });
  assert.deepEqual([shipment.totalWeightMilli, shipment.parcelCount], [6000, 3]);
  await refused('STORES', 'POST', `/d/Shipment/${shipment.id}/a/delivered`, { deliveredOn: today }, 'ACTION_NOT_AVAILABLE', 422);
  await ok('STORES', 'POST', `/d/Shipment/${shipment.id}/a/dispatch`, { awbNo: 'AWB-1' });
  assert.equal((await ok('STORES', 'POST', `/d/Shipment/${shipment.id}/a/delivered`, { deliveredOn: today })).state, 'DELIVERED');
  await booksAreClean('selling');
});

test('buying: RFQ goes out by email, replies are tracked, suppliers are scored from the books', async () => {
  const rfq = await ok('PURCHASE', 'POST', '/d/RequestForQuotation', { message: 'Please quote', lines: [{ itemId: refs.m1.id, qtyMilli: 1000 }], suppliers: [{ partyId: refs.supplier.id, email: 'sales@supplier.example' }, { partyId: refs.worker.id }] });
  await ok('PURCHASE', 'POST', `/d/RequestForQuotation/${rfq.id}/submit`, {});
  const queue = await ok('ADMIN', 'GET', '/admin/email-queue');
  assert.ok(queue.some((e) => e.to === 'sales@supplier.example' && e.body.includes('M1')));
  await refused('PURCHASE', 'POST', `/d/RequestForQuotation/${rfq.id}/a/makeQuotation`, { partyId: refs.rival.id }, 'LINK_NOT_ALLOWED', 422);
  const quote = await ok('PURCHASE', 'POST', `/d/RequestForQuotation/${rfq.id}/a/makeQuotation`, { partyId: refs.supplier.id });
  await ok('PURCHASE', 'PATCH', `/d/SupplierQuotation/${quote.id}`, { partyId: refs.supplier.id, rfqId: rfq.id, lines: [{ itemId: refs.m1.id, qtyMilli: 1000, ratePaise: 900 }] });
  await ok('PURCHASE', 'POST', `/d/SupplierQuotation/${quote.id}/submit`, {});
  const updated = await ok('PURCHASE', 'GET', `/d/RequestForQuotation/${rfq.id}`);
  assert.equal(updated.suppliers.find((s) => s.partyId === refs.supplier.id).hasReplied, true);
  assert.equal(updated.suppliers.find((s) => s.partyId === refs.worker.id).hasReplied, false);

  // One receipt on time, one late, so 50% on time. All accepted, so 100%. Score is 75%.
  const buy = async (expectedDate) => {
    const po = await post('PURCHASE', '/purchase-orders', { partyId: refs.supplier.id, expectedDate, lines: [{ itemId: refs.m1.id, qtyMilli: 1000, ratePaise: 100 }] });
    return post('STORES', '/grns', { purchaseOrderId: po.id, lines: [{ poLineId: po.lines[0].id, qtyMilli: 1000 }] });
  };
  await buy(addDays(today, 5));
  await buy(addDays(today, -5));
  const card = await ok('PURCHASE', 'POST', '/d/SupplierScorecardPeriod', { partyId: refs.supplier.id, fromDate: today, toDate: today });
  const scored = await ok('PURCHASE', 'POST', `/d/SupplierScorecardPeriod/${card.id}/a/score`, {});
  assert.ok(scored.receiptsChecked >= 2);
  assert.ok(scored.onTimeBps < 10000, 'a late delivery lowers it');
  assert.equal(scored.scoreBps, Math.round((scored.onTimeBps + scored.acceptedBps) / 2));
});

test('CRM, service, quality, assets and shares do what their records promise', async () => {
  const campaign = await ok('SALES', 'POST', '/d/Campaign', { name: 'Expo' });
  const bad = await ok('SALES', 'POST', '/d/EmailCampaign', { name: 'Bad', campaignId: campaign.id, subject: 'Hi', body: 'Hello', recipients: 'a@b.example, not-an-email' });
  await refused('SALES', 'POST', `/d/EmailCampaign/${bad.id}/a/send`, {}, 'BAD_EMAIL', 422);
  const mail = await ok('SALES', 'POST', '/d/EmailCampaign', { name: 'Good', campaignId: campaign.id, subject: 'Hi', body: 'Hello', recipients: 'a@b.example, c@d.example; a@b.example' });
  const sent = await ok('SALES', 'POST', `/d/EmailCampaign/${mail.id}/a/send`, {});
  assert.deepEqual([sent.status, sent.sentCount], ['SENT', 2]);
  await refused('SALES', 'POST', `/d/EmailCampaign/${mail.id}/a/send`, {}, 'ACTION_NOT_AVAILABLE', 422);

  const when = { subject: 'Visit', onDate: today, atTime: '10:00', ownerId: String(users.SALES._id) };
  await ok('SALES', 'POST', '/d/Appointment', when);
  await refused('SALES', 'POST', '/d/Appointment', { ...when, subject: 'Other' }, 'APPOINTMENT_CLASH', 422);

  const template = await ok('SALES', 'POST', '/d/ContractTemplate', { name: 'AMC', terms: 'Standard terms', requiresFulfilment: true, fulfilmentTerms: [{ requirement: 'Visit twice a year' }] });
  const contract = await post('SALES', '/d/Contract', { title: 'AMC 1', partyId: refs.customer.id, templateId: template.id, startDate: today });
  assert.equal(contract.terms, 'Standard terms');
  assert.equal(contract.fulfilment[0].requirement, 'Visit twice a year');
  assert.equal((await ok('SALES', 'POST', `/d/Contract/${contract.id}/a/sign`, { signedBy: 'Mr Shah', signedOn: today })).signedBy, 'Mr Shah');
  assert.equal((await ok('SALES', 'POST', `/d/Contract/${contract.id}/a/fulfil`, {})).isFulfilled, true);

  // An in-process inspection cannot be passed by hand while a reading has failed.
  const inspection = await ok('QUALITY', 'POST', '/d/InProcessInspection', { onDate: today, itemId: refs.product.id, status: 'PASS', readings: [{ parameter: 'Diameter', acceptance: '10±0.1', observed: '10.4', result: 'FAIL' }, { parameter: 'Finish', result: 'PASS' }] });
  assert.equal(inspection.status, 'FAIL');
  const ncr = await ok('QUALITY', 'POST', `/d/InProcessInspection/${inspection.id}/a/raiseNcr`, {});
  assert.match(ncr.description, /Diameter: 10.4/);
  assert.equal(ncr.source, 'IN_PROCESS');
  await refused('QUALITY', 'POST', `/d/InProcessInspection/${inspection.id}/a/raiseNcr`, {}, 'ACTION_NOT_AVAILABLE', 422);
  const passed = await ok('QUALITY', 'POST', '/d/InProcessInspection', { onDate: today, readings: [{ parameter: 'Finish', result: 'PASS' }] });
  assert.equal(passed.status, 'PASS');

  const template2 = await ok('QUALITY', 'POST', '/d/QualityFeedbackTemplate', { name: 'After install' });
  const feedback = await ok('QUALITY', 'POST', '/d/QualityFeedback', { templateId: template2.id, ratings: [{ parameter: 'Support', rating: 5 }, { parameter: 'Quality', rating: 4 }] });
  assert.equal(feedback.averageRatingMilli, 4500);
  await refused('QUALITY', 'POST', '/d/QualityFeedback', { templateId: template2.id, ratings: [{ parameter: 'X', rating: 6 }] }, 'BAD_RATING', 422);

  await ok('ACCOUNTS', 'POST', '/d/PaymentTerm', { name: 'Advance' }).then(async (term) => {
    await refused('ACCOUNTS', 'POST', '/d/PaymentTermsTemplate', { name: 'Bad', terms: [{ termId: term.id, portionBps: 5000 }] }, 'BAD_TERMS', 422);
    await ok('ACCOUNTS', 'POST', '/d/PaymentTermsTemplate', { name: 'Half half', terms: [{ termId: term.id, portionBps: 5000 }, { termId: term.id, portionBps: 5000, creditDays: 30 }] });
  });

  const holder = await ok('ACCOUNTS', 'POST', '/d/Shareholder', { name: 'Founder' });
  const buyer = await ok('ACCOUNTS', 'POST', '/d/Shareholder', { name: 'Investor' });
  const type = await ok('ACCOUNTS', 'POST', '/d/ShareType', { name: 'Equity' });
  const issue = await ok('ACCOUNTS', 'POST', '/d/ShareTransfer', { kind: 'ISSUE', onDate: today, toId: holder.id, shareTypeId: type.id, count: 100, ratePaise: 1000 });
  await refused('ACCOUNTS', 'POST', '/d/ShareTransfer', { kind: 'TRANSFER', onDate: today, fromId: holder.id, toId: buyer.id, shareTypeId: type.id, count: 101, ratePaise: 1000 }, 'NOT_ENOUGH_SHARES', 422);
  await ok('ACCOUNTS', 'POST', '/d/ShareTransfer', { kind: 'TRANSFER', onDate: today, fromId: holder.id, toId: buyer.id, shareTypeId: type.id, count: 40, ratePaise: 1000 });
  const ledger = await ok('ACCOUNTS', 'GET', '/r/share-ledger');
  assert.deepEqual(ledger.rows.map((r) => [r.shareholder, r.held]), [['Founder', 60], ['Investor', 40]]);
  const edit = await call('ACCOUNTS', 'PATCH', `/d/ShareTransfer/${issue.id}`, { kind: 'ISSUE', onDate: today, toId: holder.id, shareTypeId: type.id, count: 1000, ratePaise: 1000 });
  assert.equal(edit.body.error.code, 'LOCKED', 'a transfer is permanent');

  const guaranteeBank = await ok('ACCOUNTS', 'POST', '/d/Bank', { name: 'SBI' });
  const guarantee = await ok('ACCOUNTS', 'POST', '/d/BankGuarantee', { partyId: refs.customer.id, bankId: guaranteeBank.id, guaranteeNo: 'BG1', amountPaise: 100, startDate: today, endDate: addDays(today, 1), status: 'ACTIVE' });
  assert.equal((await ok('ACCOUNTS', 'POST', `/d/BankGuarantee/${guarantee.id}/a/release`, {})).status, 'RELEASED');

  const inward = await ok('PRODUCTION', 'POST', '/d/SubcontractingInwardOrder', { partyId: refs.customer.id, itemId: refs.m1.id, qtyMilli: 2000, ratePaise: 100 });
  await refused('PRODUCTION', 'POST', `/d/SubcontractingInwardOrder/${inward.id}/a/receive`, { qtyMilli: 2001 }, 'OVER_RECEIVED', 422);
  await ok('PRODUCTION', 'POST', `/d/SubcontractingInwardOrder/${inward.id}/a/receive`, { qtyMilli: 1000 });
  await refused('PRODUCTION', 'POST', `/d/SubcontractingInwardOrder/${inward.id}/a/deliver`, { qtyMilli: 1001 }, 'OVER_DELIVERED', 422);
  await booksAreClean('the rest');
});

test('every new report runs for the roles allowed, and the books are clean after all of it', async () => {
  for (const key of ['stock-below-reorder', 'pending-sales-orders', 'pending-purchase-orders', 'customer-acquisition', 'proforma-open', 'blanket-order-balance', 'contracts-expiring', 'campaign-summary', 'supplier-scores', 'rfq-replies', 'bank-guarantees', 'employee-anniversaries', 'recruitment-pipeline', 'interview-results', 'goal-progress', 'training-results', 'vehicle-running', 'salary-held', 'warranty-claims', 'in-process-failures', 'customer-feedback', 'work-order-materials', 'work-order-delays', 'production-shortages', 'downtime-by-reason', 'job-card-time', 'subcontract-status', 'build-pipeline']) {
    const result = await ok('ADMIN', 'GET', `/r/${key}`);
    assert.ok(Array.isArray(result.rows), key);
  }
  const sheet = await ok('ACCOUNTS', 'GET', '/reports/balance-sheet');
  assert.equal(sheet.balanced, true);
  await booksAreClean('everything in this file');
});
