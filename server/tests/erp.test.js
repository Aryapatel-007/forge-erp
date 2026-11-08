// The whole business over real HTTP, against a real replica set: the normal path, every
// refusal that protects the books, cancellations, and deliberate tampering.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb, rawCollection, resetDb } from './helpers/db.js';
import { createApp } from '../server.js';
import { AuditLog, Bin, Counter, GlEntry, MachineBuild, Settings, StockEntry, User, Warehouse, Ncr } from '../models/index.js';
import { issueAccessToken } from '../services/authService.js';
import { integrity } from '../services/reportService.js';
import { addDays, todayIst } from '../utils/dates.js';
import { A } from '../config/accounts.js';
import { ROLES } from '../config/permissions.js';

const today = todayIst();
let server;
let base;
const users = {};
const tokens = {};
const refs = {};

async function call(role, method, path, body, headers = {}) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(role ? { authorization: `Bearer ${tokens[role]}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => null);
  return { status: response.status, body: parsed, headers: response.headers };
}

async function ok(role, method, path, body) {
  const result = await call(role, method, path, body);
  assert.ok(result.status < 300, `${method} ${path} -> ${result.status} ${JSON.stringify(result.body)}`);
  return result.body.data;
}

async function refused(role, method, path, body, code, status) {
  const result = await call(role, method, path, body);
  assert.equal(result.body?.error?.code, code, `${method} ${path} -> ${result.status} ${JSON.stringify(result.body)}`);
  if (status) assert.equal(result.status, status);
  return result.body.error;
}

// Create a draft and submit it.
async function post(role, path, body, submitBody = {}) {
  const draft = await ok(role, 'POST', path, body);
  return ok(role, 'POST', `${path}/${draft.id}/submit`, submitBody);
}

async function booksAreClean(label) {
  const report = await integrity();
  const failed = report.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.message}`);
  assert.deepEqual(failed, [], `Books are wrong after ${label}`);
}

const glSum = async (code, filter = {}) => {
  const rows = await GlEntry.find({ accountCode: code, ...filter }).lean();
  return rows.reduce((sum, r) => sum + r.debitPaise - r.creditPaise, 0);
};

before(async () => {
  await connectTestDb();
  await resetDb();
  const app = createApp({ serveClient: false });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  const passwordHash = await bcrypt.hash('correct-horse-battery', 4);
  for (const role of ROLES) {
    users[role] = await User.create({ name: `${role} person`, email: `${role.toLowerCase()}@t.test`, role, passwordHash });
    tokens[role] = issueAccessToken(users[role]);
  }
  await User.create({ name: 'Second QA', email: 'qa2@t.test', role: 'QUALITY', passwordHash });
  tokens.QUALITY2 = issueAccessToken(await User.findOne({ email: 'qa2@t.test' }));

  await ok('ADMIN', 'PATCH', '/admin/settings', { stateCode: '24', gstin: '', lutNumber: 'LUT-TEST-1', poApprovalLimitPaise: 100000000, labourRatePaise: 50000, warrantyMonths: 12 });

  for (const [key, row] of Object.entries({
    stores: { code: 'STORES', name: 'Stores', kind: 'STORES' },
    hold: { code: 'HOLD', name: 'Hold', kind: 'QUARANTINE' },
    reject: { code: 'REJECT', name: 'Reject', kind: 'REJECT' },
    jw: { code: 'JW', name: 'Job work', kind: 'JOBWORK' },
    fg: { code: 'FG', name: 'Finished', kind: 'FG' },
  })) refs[key] = await ok('ADMIN', 'POST', '/warehouses', row);

  for (const [key, row] of Object.entries({
    inter: { code: 'C1', name: 'Mumbai Customer', isCustomer: true, stateCode: '27', gstin: '27AAPFU0939F1ZV' },
    intra: { code: 'C2', name: 'Local Customer', isCustomer: true, stateCode: '24' },
    foreign: { code: 'C3', name: 'Cairo Customer', isCustomer: true, isExport: true, currency: 'USD', country: 'Egypt' },
    supplier: { code: 'S1', name: 'Steel Supplier', isSupplier: true, stateCode: '24', paymentTermsDays: 30 },
    far: { code: 'S2', name: 'Delhi Supplier', isSupplier: true, stateCode: '07' },
    worker: { code: 'J1', name: 'Laser Works', isSupplier: true, isJobWorker: true, stateCode: '24' },
  })) refs[key] = await ok('ADMIN', 'POST', '/parties', row);

  for (const [key, row] of Object.entries({
    steel: { code: 'STEEL', name: 'SS 316L sheet', type: 'RAW', uom: 'KG', hsn: '72193300', gstRateBps: 1800, trackLot: true, requiresInspection: true },
    plc: { code: 'PLC', name: 'PLC', type: 'BOUGHT_OUT', hsn: '85371000', gstRateBps: 1800 },
    frame: { code: 'FRAME', name: 'Frame', type: 'FABRICATED', hsn: '84229090', gstRateBps: 1800 },
    head: { code: 'HEAD', name: 'Filling head', type: 'ASSEMBLY', hsn: '84229090', gstRateBps: 1800 },
    pump: { code: 'PUMP', name: 'Pump', type: 'BOUGHT_OUT', hsn: '84135090', gstRateBps: 1800 },
    machine: { code: 'VF', name: 'Vial filler', type: 'MACHINE', hsn: '84223000', gstRateBps: 1800 },
    spare: { code: 'NOZ', name: 'Nozzle', type: 'SPARE', hsn: '84229090', gstRateBps: 1800 },
    install: { code: 'INST', name: 'Installation', type: 'SERVICE', hsn: '998719', gstRateBps: 1800 },
  })) refs[key] = await ok('ADMIN', 'POST', '/items', row);

  refs.gauge = await ok('QUALITY', 'POST', '/gauges', { code: 'G1', name: 'Balance', dueOn: addDays(today, 100) });
  refs.oldGauge = await ok('QUALITY', 'POST', '/gauges', { code: 'G2', name: 'Old', dueOn: addDays(today, -1) });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await disconnectTestDb();
});

test('security: no token, wrong role, unknown fields, operator injection, hidden hash', async () => {
  assert.equal((await call(null, 'GET', '/builds')).status, 401);
  assert.equal((await call(null, 'GET', '/reports/trial-balance')).status, 401);
  await refused('SALES', 'GET', '/reports/trial-balance', undefined, 'FORBIDDEN', 403);
  await refused('STORES', 'POST', '/purchase-orders', {}, 'FORBIDDEN', 403);
  await refused('ACCOUNTS', 'GET', '/admin/users', undefined, 'FORBIDDEN', 403);
  await refused('ADMIN', 'POST', '/items', { code: 'X', name: 'X', type: 'RAW', isAdmin: true }, 'VALIDATION_FAILED', 400);
  await refused('ADMIN', 'POST', '/items', { code: 'X', name: 'X', type: 'RAW', gstRateBps: 18.5 }, 'VALIDATION_FAILED', 400);
  await refused('ADMIN', 'POST', '/parties', { code: 'Y', name: 'Y', gstin: '27AAPFU0939F1ZW' }, 'VALIDATION_FAILED', 400);
  await refused('ADMIN', 'POST', '/parties', { code: 'Y', name: 'Y', gstin: '27AAPFU0939F1ZV', stateCode: '24' }, 'VALIDATION_FAILED', 400);
  await refused('ADMIN', 'POST', '/items', { code: 'STEEL', name: 'Again', type: 'RAW' }, 'DUPLICATE', 409);

  const injected = await call('ADMIN', 'GET', '/items?type[$ne]=RAW&q=.*');
  assert.equal(injected.status, 200);
  assert.equal(injected.body.data.length, 0, 'a search for .* is a literal search');
  assert.equal((await call('ADMIN', 'GET', '/items?type=NOPE')).body.data.length, 0);
  assert.equal((await call('ADMIN', 'GET', '/items/not-an-id')).status, 400);

  const list = await ok('ADMIN', 'GET', '/admin/users');
  assert.ok(list.every((u) => u.passwordHash === undefined));
  const created = await ok('ADMIN', 'POST', '/admin/users', { name: 'New', email: 'new@t.test', role: 'SALES', password: 'long-enough-password' });
  assert.equal(created.passwordHash, undefined);
  await refused('ADMIN', 'PATCH', `/admin/users/${users.ADMIN._id}`, { role: 'SALES' }, 'SELF_CHANGE', 422);
});

test('auth: wrong details look the same, refresh rotates, a replay ends the family', async () => {
  const noUser = await call(null, 'POST', '/auth/login', { email: 'nobody@t.test', password: 'whatever-it-is' });
  const badPass = await call(null, 'POST', '/auth/login', { email: 'admin@t.test', password: 'whatever-it-is' });
  assert.equal(noUser.status, 401);
  assert.deepEqual(noUser.body, badPass.body, 'an unknown email and a wrong password read the same');

  const good = await call(null, 'POST', '/auth/login', { email: 'admin@t.test', password: 'correct-horse-battery' });
  assert.equal(good.status, 200);
  assert.equal(good.body.data.user.permissions.includes('users.manage'), true);
  const cookie = good.headers.get('set-cookie').split(';')[0];
  assert.match(good.headers.get('set-cookie'), /HttpOnly/i);

  const noHeader = await call(null, 'POST', '/auth/refresh', undefined, { cookie });
  assert.equal(noHeader.status, 403, 'the CSRF header is required');

  const csrf = { 'x-requested-with': 'forge' };
  const first = await call(null, 'POST', '/auth/refresh', undefined, { cookie, ...csrf });
  assert.equal(first.status, 200);
  const second = first.headers.get('set-cookie').split(';')[0];
  assert.notEqual(second, cookie);

  const replay = await call(null, 'POST', '/auth/refresh', undefined, { cookie, ...csrf });
  assert.equal(replay.status, 401, 'an old token is refused');
  const after = await call(null, 'POST', '/auth/refresh', undefined, { cookie: second, ...csrf });
  assert.equal(after.status, 401, 'and the newer one dies with it');
});

test('a switched-off user and a token from before a password change stop working', async () => {
  const person = await ok('ADMIN', 'POST', '/admin/users', { name: 'Temp', email: 'temp@t.test', role: 'SALES', password: 'long-enough-password' });
  tokens.TEMP = issueAccessToken({ _id: person.id });
  assert.equal((await call('TEMP', 'GET', '/items')).status, 200);
  await ok('ADMIN', 'PATCH', `/admin/users/${person.id}`, { isActive: false });
  assert.equal((await call('TEMP', 'GET', '/items')).status, 401);
  await ok('ADMIN', 'PATCH', `/admin/users/${person.id}`, { isActive: true });
  await ok('ADMIN', 'PATCH', `/admin/users/${person.id}`, { password: 'another-long-password' });
  assert.equal((await call('TEMP', 'GET', '/items')).status, 401);
});

test('BOM: revisions, one released at a time, assemblies explode, loops refused', async () => {
  const head = await ok('ENGINEERING', 'POST', '/boms', { itemId: refs.head.id, lines: [{ itemId: refs.pump.id, qtyMilli: 4000 }] });
  await ok('ENGINEERING', 'POST', `/boms/${head.id}/release`);

  const v1 = await ok('ENGINEERING', 'POST', '/boms', {
    itemId: refs.machine.id,
    lines: [{ itemId: refs.frame.id, qtyMilli: 1000 }, { itemId: refs.plc.id, qtyMilli: 1000 }, { itemId: refs.head.id, qtyMilli: 1000 }],
    fatChecklist: [
      { parameter: 'Speed', acceptance: '95 to 105', minMilli: 95000, maxMilli: 105000, unit: 'vpm' },
      { parameter: 'Interlock', acceptance: 'Stops', isCritical: true },
      { parameter: 'Paint', acceptance: 'Neat', isCritical: false },
    ],
  });
  await refused('ENGINEERING', 'POST', '/boms', { itemId: refs.machine.id, lines: [{ itemId: refs.plc.id, qtyMilli: 1000 }] }, 'CHANGE_NOTE_REQUIRED', 422);
  await ok('ENGINEERING', 'POST', `/boms/${v1.id}/release`);
  await refused('ENGINEERING', 'PATCH', `/boms/${v1.id}`, { changeNote: 'Sneaky' }, 'BOM_NOT_DRAFT', 422);
  refs.bom = v1;

  const v2 = await ok('ENGINEERING', 'POST', '/boms', { itemId: refs.machine.id, changeNote: 'Second PLC', lines: [{ itemId: refs.plc.id, qtyMilli: 2000 }], fatChecklist: [{ parameter: 'X' }] });
  assert.equal(v2.revision, 2);
  await ok('ENGINEERING', 'POST', `/boms/${v2.id}/release`);
  assert.equal((await ok('ENGINEERING', 'GET', `/boms/${v1.id}`)).status, 'OBSOLETE');

  // Back to a revision for the rest of this file, with the real checklist.
  const v3 = await ok('ENGINEERING', 'POST', '/boms', { itemId: refs.machine.id, changeNote: 'Back to the full design', lines: v1.lines.map((l) => ({ itemId: l.itemId, qtyMilli: l.qtyMilli })), fatChecklist: v1.fatChecklist.map(({ id: _id, ...rest }) => rest) });
  await ok('ENGINEERING', 'POST', `/boms/${v3.id}/release`);

  // The filling head is inside the machine, so the machine cannot go inside the head.
  const loop = await ok('ENGINEERING', 'POST', '/boms', { itemId: refs.head.id, changeNote: 'Loop', lines: [{ itemId: refs.machine.id, qtyMilli: 1000 }] });
  await refused('ENGINEERING', 'POST', `/boms/${loop.id}/release`, undefined, 'BOM_LOOP', 422);
  const direct = await ok('ENGINEERING', 'POST', '/boms', { itemId: refs.head.id, changeNote: 'Direct loop', lines: [{ itemId: refs.head.id, qtyMilli: 1000 }] });
  await refused('ENGINEERING', 'POST', `/boms/${direct.id}/release`, undefined, 'BOM_LOOP', 422);
  assert.equal((await ok('ENGINEERING', 'GET', `/boms/${head.id}`)).status, 'RELEASED', 'the good revision stays released');
});

test('the machine: quote, order, builds and serial numbers', async () => {
  const quote = await post('SALES', '/quotations', { partyId: refs.inter.id, lines: [{ itemId: refs.machine.id, qtyMilli: 1000, rateMinor: 100000000 }] });
  assert.equal(quote.status, 'SENT');
  assert.match(quote.docNo, /^QT\//);

  const revised = await ok('SALES', 'POST', `/quotations/${quote.id}/revise`);
  assert.equal(revised.revision, 1);
  assert.equal(revised.docNo, null);
  await refused('SALES', 'POST', `/quotations/${quote.id}/to-order`, undefined, 'BUSINESS_RULE_VIOLATED', 422);
  const sent = await ok('SALES', 'POST', `/quotations/${revised.id}/submit`);
  const draft = await ok('SALES', 'POST', `/quotations/${sent.id}/to-order`);
  assert.equal(draft.status, 'DRAFT');
  assert.equal(draft.milestones.length, 3);

  const fraction = await ok('SALES', 'POST', '/sales-orders', { partyId: refs.inter.id, lines: [{ itemId: refs.machine.id, qtyMilli: 1500, rateMinor: 100 }], milestones: [{ no: 1, name: 'All', trigger: 'ORDER', pctBps: 10000 }] });
  await refused('SALES', 'POST', `/sales-orders/${fraction.id}/submit`, undefined, 'WHOLE_MACHINES_ONLY', 422);
  await ok('SALES', 'DELETE', `/sales-orders/${fraction.id}`);

  const badOrder = await ok('SALES', 'POST', '/sales-orders', { partyId: refs.inter.id, lines: [{ itemId: refs.machine.id, qtyMilli: 1000, rateMinor: 100 }], milestones: [{ no: 1, name: 'Half', trigger: 'ORDER', pctBps: 5000 }] });
  await refused('SALES', 'POST', `/sales-orders/${badOrder.id}/submit`, undefined, 'BAD_MILESTONES', 422);
  await ok('SALES', 'DELETE', `/sales-orders/${badOrder.id}`);

  refs.order = await ok('SALES', 'POST', `/sales-orders/${draft.id}/submit`);
  assert.equal(refs.order.status, 'CONFIRMED');
  // Rs 10,00,000 + 18% = Rs 11,80,000. 30 / 60 / 10.
  assert.deepEqual(refs.order.milestones.map((m) => m.amountMinor), [35400000, 70800000, 11800000]);

  const builds = await ok('PRODUCTION', 'GET', `/builds?salesOrderId=${refs.order.id}`);
  assert.equal(builds.length, 1);
  refs.build = builds[0];
  assert.match(refs.build.serialNo, /^VF-\d{4}-0001$/);
  // The filling head exploded into 4 pumps.
  assert.deepEqual(refs.build.materials.map((m) => [m.itemCode, m.requiredMilli]).sort(), [['FRAME', 1000], ['PLC', 1000], ['PUMP', 4000]]);
  await booksAreClean('the order');
});

test('purchase: approval limit, no self approval, over-receipt, lots, quarantine', async () => {
  const shortage = await ok('PURCHASE', 'GET', `/builds/${refs.build.id}/shortages`);
  assert.equal(shortage.shortLines, 3);
  assert.equal(shortage.readyToIssue, false);

  const big = await post('PURCHASE', '/purchase-orders', { partyId: refs.supplier.id, lines: [{ itemId: refs.plc.id, qtyMilli: 1000, ratePaise: 200000000 }] });
  assert.equal(big.status, 'PENDING_APPROVAL');
  await refused('SALES', 'POST', '/grns', { purchaseOrderId: big.id, lines: [{ poLineId: big.lines[0].id, qtyMilli: 1 }] }, 'FORBIDDEN', 403);
  const blockedReceipt = await ok('STORES', 'POST', '/grns', { purchaseOrderId: big.id, lines: [{ poLineId: big.lines[0].id, qtyMilli: 1 }] });
  await refused('STORES', 'POST', `/grns/${blockedReceipt.id}/submit`, undefined, 'PO_NOT_APPROVED', 422);
  await ok('STORES', 'DELETE', `/grns/${blockedReceipt.id}`);
  await refused('PURCHASE', 'POST', `/purchase-orders/${big.id}/approve`, undefined, 'FORBIDDEN', 403);
  await ok('ADMIN', 'POST', `/purchase-orders/${big.id}/cancel`, { reason: 'Too dear' });

  const draftBig = await ok('MANAGEMENT', 'POST', '/purchase-orders', { partyId: refs.supplier.id, lines: [{ itemId: refs.plc.id, qtyMilli: 1000, ratePaise: 200000000 }] });
  const pending = await ok('MANAGEMENT', 'POST', `/purchase-orders/${draftBig.id}/submit`);
  await refused('MANAGEMENT', 'POST', `/purchase-orders/${pending.id}/approve`, undefined, 'SELF_APPROVAL', 422);
  const approved = await ok('ADMIN', 'POST', `/purchase-orders/${pending.id}/approve`);
  assert.equal(approved.status, 'APPROVED');
  await ok('ADMIN', 'POST', `/purchase-orders/${approved.id}/cancel`, { reason: 'Not needed' });

  // Rs 1,000 a kg steel for the frame, set aside for the build. Input tax is CGST + SGST.
  refs.steelPo = await post('PURCHASE', '/purchase-orders', { partyId: refs.supplier.id, lines: [{ itemId: refs.steel.id, qtyMilli: 100000, ratePaise: 100000, buildId: refs.build.id }] });
  assert.equal(refs.steelPo.status, 'APPROVED');
  assert.equal(refs.steelPo.totalPaise, 11800000);

  const line = refs.steelPo.lines[0];
  await refused('STORES', 'POST', `/grns/${(await ok('STORES', 'POST', '/grns', { purchaseOrderId: refs.steelPo.id, lines: [{ poLineId: line.id, qtyMilli: 100001, lot: 'H1' }] })).id}/submit`, undefined, 'OVER_RECEIPT', 422);
  await refused('STORES', 'POST', `/grns/${(await ok('STORES', 'POST', '/grns', { purchaseOrderId: refs.steelPo.id, lines: [{ poLineId: line.id, qtyMilli: 1000 }] })).id}/submit`, undefined, 'LOT_REQUIRED', 422);

  refs.steelGrn = await post('STORES', '/grns', { purchaseOrderId: refs.steelPo.id, supplierChallanNo: 'CH1', lines: [{ poLineId: line.id, qtyMilli: 100000, lot: 'H1', certRef: 'MTC-1' }] });
  assert.equal(refs.steelGrn.totalValuePaise, 10000000);
  const held = await ok('STORES', 'GET', `/reports/stock-balance?itemId=${refs.steel.id}`);
  assert.equal(held.rows[0].warehouseKind, 'QUARANTINE');
  assert.equal(await glSum(A.INVENTORY), 10000000);
  assert.equal(await glSum(A.GRNI), -10000000);
  await booksAreClean('the goods receipt');
});

test('inspection: stock leaves quarantine, a reject raises an NCR and loses its peg', async () => {
  const line = refs.steelGrn.lines[0];
  const tooMuch = await ok('QUALITY', 'POST', '/inspections', { grnId: refs.steelGrn.id, lines: [{ grnLineId: line.id, acceptedMilli: 100000, rejectedMilli: 1 }] });
  await refused('QUALITY', 'POST', `/inspections/${tooMuch.id}/submit`, undefined, 'OVER_INSPECTED', 422);
  await ok('QUALITY', 'DELETE', `/inspections/${tooMuch.id}`);

  await post('QUALITY', '/inspections', { grnId: refs.steelGrn.id, inspectorName: 'QA', lines: [{ grnLineId: line.id, acceptedMilli: 95000, rejectedMilli: 5000, certVerified: true, observations: 'Scratched' }] });
  const stock = (await ok('STORES', 'GET', `/reports/stock-balance?itemId=${refs.steel.id}`)).rows;
  const kinds = Object.fromEntries(stock.map((r) => [r.warehouseKind, r]));
  assert.equal(kinds.STORES.qtyMilli, 95000);
  assert.equal(kinds.STORES.buildId, refs.build.id, 'accepted stock stays set aside');
  assert.equal(kinds.REJECT.qtyMilli, 5000);
  assert.equal(kinds.REJECT.buildId, null);
  assert.equal(kinds.QUARANTINE, undefined);
  assert.equal(await Ncr.countDocuments({ source: 'INCOMING', status: 'OPEN' }), 1);
  await booksAreClean('inspection');
});

test('purchase invoice: three-way match, price variance, over-billing, duplicate number', async () => {
  const line = refs.steelGrn.lines[0];
  const over = await ok('ACCOUNTS', 'POST', '/purchase-invoices', { partyId: refs.supplier.id, supplierInvoiceNo: 'OVER', supplierInvoiceDate: today, lines: [{ kind: 'GOODS', grnId: refs.steelGrn.id, grnLineId: line.id, qtyMilli: 100001, ratePaise: 100000 }] });
  await refused('ACCOUNTS', 'POST', `/purchase-invoices/${over.id}/submit`, undefined, 'OVER_BILLED', 422);
  await ok('ACCOUNTS', 'DELETE', `/purchase-invoices/${over.id}`);

  await refused('ACCOUNTS', 'POST', '/purchase-invoices', { partyId: refs.far.id, supplierInvoiceNo: 'X', supplierInvoiceDate: today, lines: [{ kind: 'GOODS', grnId: refs.steelGrn.id, grnLineId: line.id, qtyMilli: 1000, ratePaise: 1 }] }, 'GRN_OTHER_SUPPLIER', 422);

  // The supplier bills Rs 1,010 a kg against an order at Rs 1,000: Rs 1,000 of variance.
  refs.steelBill = await post('ACCOUNTS', '/purchase-invoices', { partyId: refs.supplier.id, supplierInvoiceNo: 'INV-1', supplierInvoiceDate: today, lines: [{ kind: 'GOODS', grnId: refs.steelGrn.id, grnLineId: line.id, qtyMilli: 100000, ratePaise: 101000 }] });
  assert.equal(refs.steelBill.taxablePaise, 10100000);
  assert.equal(refs.steelBill.cgstPaise, 909000);
  assert.equal(refs.steelBill.sgstPaise, 909000);
  assert.equal(refs.steelBill.totalPaise, 11918000);
  assert.equal(await glSum(A.GRNI), 0, 'the receipt is cleared to the paisa');
  assert.equal(await glSum(A.PRICE_VARIANCE), 100000);
  assert.equal(await glSum(A.CREDITORS), -11918000);

  const dup = await ok('ACCOUNTS', 'POST', '/purchase-invoices', { partyId: refs.supplier.id, supplierInvoiceNo: 'INV-1', supplierInvoiceDate: today, lines: [{ kind: 'SERVICE', description: 'Freight', expenseAccountCode: A.FREIGHT, qtyMilli: 1000, ratePaise: 100, gstRateBps: 1800 }] });
  await refused('ACCOUNTS', 'POST', `/purchase-invoices/${dup.id}/submit`, undefined, 'DUPLICATE', 409);
  await ok('ACCOUNTS', 'DELETE', `/purchase-invoices/${dup.id}`);

  const far = await post('ACCOUNTS', '/purchase-invoices', { partyId: refs.far.id, supplierInvoiceNo: 'DL-1', supplierInvoiceDate: today, lines: [{ kind: 'SERVICE', description: 'Testing', expenseAccountCode: A.EXPENSES, qtyMilli: 1000, ratePaise: 100000, gstRateBps: 1800 }] });
  assert.equal(far.igstPaise, 18000, 'another state is IGST');
  assert.equal(far.cgstPaise, 0);
  await booksAreClean('purchase invoices');
});

test('job work: goods leave with no GL entry, come back converted, value carried, charges to the build', async () => {
  const before = await glSum(A.INVENTORY);
  refs.challan = await post('STORES', '/job-work', { partyId: refs.worker.id, process: 'Laser', buildId: refs.build.id, lines: [{ itemId: refs.steel.id, qtyMilli: 80000, fromWarehouseId: refs.stores.id, lot: 'H1' }] });
  assert.equal(refs.challan.status, 'SENT');
  assert.equal(refs.challan.returnBy, addDays(today, 365), 'inputs must come back within a year');
  assert.equal(await glSum(A.INVENTORY), before, 'the goods are still ours');

  const line = refs.challan.lines[0];
  await refused('STORES', 'POST', `/job-work/${refs.challan.id}/receive`, { lineId: line.id, consumedMilli: 80001, outputItemId: refs.frame.id, outputMilli: 1000 }, 'OVER_CONSUMED', 422);
  const back = await ok('STORES', 'POST', `/job-work/${refs.challan.id}/receive`, { lineId: line.id, consumedMilli: 80000, outputItemId: refs.frame.id, outputMilli: 1000, supplierChallanNo: 'LW-1' });
  assert.equal(back.status, 'RETURNED');
  const frame = (await ok('STORES', 'GET', `/reports/stock-balance?itemId=${refs.frame.id}`)).rows[0];
  assert.equal(frame.qtyMilli, 1000);
  assert.equal(frame.valuePaise, 8000000, '80 kg at Rs 1,000');
  assert.equal(frame.buildId, refs.build.id);
  await refused('STORES', 'POST', `/job-work/${refs.challan.id}/cancel`, { reason: 'x' }, 'CHALLAN_HAS_RECEIPTS', 422);

  await post('ACCOUNTS', '/purchase-invoices', { partyId: refs.worker.id, supplierInvoiceNo: 'LW-INV', supplierInvoiceDate: today, lines: [{ kind: 'SERVICE', description: 'Laser cutting', hsn: '998898', buildId: refs.build.id, qtyMilli: 1000, ratePaise: 2000000, gstRateBps: 1800 }] });
  const build = await ok('PRODUCTION', 'GET', `/builds/${refs.build.id}`);
  assert.equal(build.otherCostPaise, 2000000);
  assert.equal(await glSum(A.WIP), 2000000);
  await booksAreClean('job work');
});

test('issue and labour: picks set-aside stock first, refuses shortages, cost lands on the build', async () => {
  const short = await ok('STORES', 'POST', '/material-issues', { buildId: refs.build.id, lines: [{ itemId: refs.plc.id, qtyMilli: 1000 }] });
  await refused('STORES', 'POST', `/material-issues/${short.id}/submit`, undefined, 'INSUFFICIENT_STOCK', 422);
  await ok('STORES', 'DELETE', `/material-issues/${short.id}`);
  assert.match((await ok('STORES', 'GET', '/material-issues?status=SUBMITTED')).length === 0 ? 'none' : 'some', /none/, 'the refused number was not used');

  // Rest of the parts arrive as free stock, opening balance.
  await post('STORES', '/stock-moves', { kind: 'OPENING', reason: 'Opening', lines: [
    { itemId: refs.plc.id, qtyMilli: 3000, toWarehouseId: refs.stores.id, ratePaise: 15000000 },
    { itemId: refs.pump.id, qtyMilli: 10000, toWarehouseId: refs.stores.id, ratePaise: 1000000 },
    { itemId: refs.spare.id, qtyMilli: 10000, toWarehouseId: refs.stores.id, ratePaise: 100000 },
  ] });
  assert.equal(await glSum(A.OPENING), -(45000000 + 10000000 + 1000000));

  refs.issue = await post('STORES', '/material-issues', { buildId: refs.build.id, lines: [{ itemId: refs.frame.id, qtyMilli: 1000 }, { itemId: refs.plc.id, qtyMilli: 1000 }, { itemId: refs.pump.id, qtyMilli: 4000 }] });
  // Frame Rs 80,000 + PLC Rs 1,50,000 + 4 pumps Rs 40,000
  assert.equal(refs.issue.totalValuePaise, 27000000);

  const ret = await post('STORES', '/material-issues', { buildId: refs.build.id, direction: 'RETURN', lines: [{ itemId: refs.pump.id, qtyMilli: 1000 }] });
  assert.equal(ret.totalValuePaise, 1000000);
  await refused('STORES', 'POST', `/material-issues/${(await ok('STORES', 'POST', '/material-issues', { buildId: refs.build.id, direction: 'RETURN', lines: [{ itemId: refs.pump.id, qtyMilli: 4000 }] })).id}/submit`, undefined, 'RETURN_TOO_MUCH', 422);
  await post('STORES', '/material-issues', { buildId: refs.build.id, lines: [{ itemId: refs.pump.id, qtyMilli: 1000 }] });

  const time = await post('PRODUCTION', '/time-bookings', { buildId: refs.build.id, operation: 'Assembly', employeeName: 'Team A', hoursMilli: 100500 });
  assert.equal(time.valuePaise, 5025000, '100.5 hours at Rs 500');

  const build = await ok('PRODUCTION', 'GET', `/builds/${refs.build.id}`);
  assert.equal(build.materialCostPaise, 27000000);
  assert.equal(build.labourCostPaise, 5025000);
  assert.equal(build.wipPaise, 27000000 + 5025000 + 2000000);
  assert.equal(await glSum(A.WIP), build.wipPaise);
  const sheet = await ok('ACCOUNTS', 'GET', `/builds/${refs.build.id}/cost-sheet`);
  assert.equal(sheet.totalCostPaise, build.wipPaise);
  assert.equal(sheet.marginPaise, 100000000 - build.wipPaise);
  refs.machineCost = build.wipPaise;

  const trace = await ok('QUALITY', 'GET', '/reports/trace-lot?lot=H1');
  assert.equal(trace.receivedFrom[0].certRef, 'MTC-1');
  await booksAreClean('issues and labour');
});

test('FAT: readings checked by the server, calibration enforced, failure blocks finishing', async () => {
  await refused('PRODUCTION', 'POST', `/builds/${refs.build.id}/complete`, {}, 'FAT_NOT_PASSED', 422);

  const fat = await ok('QUALITY', 'POST', `/builds/${refs.build.id}/fat`, { witnessName: '', witnessCompany: 'Mumbai Customer' });
  await refused('QUALITY', 'POST', `/builds/${refs.build.id}/fat`, {}, 'FAT_ALREADY_OPEN', 422);
  const [speed, interlock, paint] = fat.results;

  await refused('QUALITY', 'POST', `/fat/${fat.id}/close`, undefined, 'WITNESS_REQUIRED', 422);
  await ok('QUALITY', 'PATCH', `/fat/${fat.id}`, { witnessName: 'R Nair' });
  await refused('QUALITY', 'POST', `/fat/${fat.id}/close`, undefined, 'GAUGES_REQUIRED', 422);
  await ok('QUALITY', 'PATCH', `/fat/${fat.id}`, { gaugeIds: [refs.oldGauge.id] });
  await refused('QUALITY', 'POST', `/fat/${fat.id}/close`, undefined, 'GAUGE_OUT_OF_CALIBRATION', 422);
  await ok('QUALITY', 'PATCH', `/fat/${fat.id}`, { gaugeIds: [refs.gauge.id] });
  await refused('QUALITY', 'POST', `/fat/${fat.id}/close`, undefined, 'RESULT_MISSING', 422);

  await ok('QUALITY', 'PATCH', `/fat/${fat.id}`, { results: [{ id: speed.id, result: 'PASS', observedMilli: 90000 }, { id: interlock.id, result: 'NA' }, { id: paint.id, result: 'PASS' }] });
  await refused('QUALITY', 'POST', `/fat/${fat.id}/close`, undefined, 'READING_OUT_OF_LIMITS', 422);
  await ok('QUALITY', 'PATCH', `/fat/${fat.id}`, { results: [{ id: speed.id, result: 'FAIL', observedMilli: 90000 }] });
  await refused('QUALITY', 'POST', `/fat/${fat.id}/close`, undefined, 'CRITICAL_NOT_NA', 422);
  await ok('QUALITY', 'PATCH', `/fat/${fat.id}`, { results: [{ id: interlock.id, result: 'PASS' }] });

  const failed = await ok('QUALITY', 'POST', `/fat/${fat.id}/close`);
  assert.equal(failed.status, 'FAILED');
  assert.match(failed.docNo, /^FAT\//);
  await refused('QUALITY', 'PATCH', `/fat/${fat.id}`, { witnessName: 'Changed' }, 'CONFLICT', 409);

  const ncr = (await ok('QUALITY', 'GET', `/ncrs?buildId=${refs.build.id}&status=OPEN`))[0];
  assert.equal(ncr.source, 'FAT');

  const retest = await ok('QUALITY', 'POST', `/builds/${refs.build.id}/fat`, { witnessName: 'R Nair' });
  assert.equal(retest.attempt, 2);
  await ok('QUALITY', 'PATCH', `/fat/${retest.id}`, { gaugeIds: [refs.gauge.id], results: retest.results.map((r) => ({ id: r.id, result: 'PASS', observedMilli: r.minMilli !== null ? 100000 : null })) });
  const passed = await ok('QUALITY', 'POST', `/fat/${retest.id}/close`);
  assert.equal(passed.status, 'PASSED');

  await refused('PRODUCTION', 'POST', `/builds/${refs.build.id}/complete`, {}, 'OPEN_NCR', 422);
  await refused('QUALITY', 'POST', `/ncrs/${ncr.id}/close`, { disposition: 'REWORK', rootCause: 'Belt', correctiveAction: 'Replaced' }, 'SELF_APPROVAL', 422);
  await ok('QUALITY2', 'POST', `/ncrs/${ncr.id}/close`, { disposition: 'REWORK', rootCause: 'Belt', correctiveAction: 'Replaced' });

  const finished = await ok('PRODUCTION', 'POST', `/builds/${refs.build.id}/complete`, {});
  assert.equal(finished.stage, 'READY');
  assert.equal(finished.finishedValuePaise, refs.machineCost);
  assert.equal(finished.wipPaise, 0);
  assert.equal(await glSum(A.WIP), 0);
  assert.equal(await glSum(A.FINISHED_GOODS), refs.machineCost);
  await refused('STORES', 'POST', `/material-issues/${(await ok('STORES', 'POST', '/material-issues', { buildId: refs.build.id, lines: [{ itemId: refs.spare.id, qtyMilli: 1000 }] })).id}/submit`, undefined, 'BUILD_CLOSED_TO_COST', 422);
  await refused('PRODUCTION', 'POST', `/builds/${refs.build.id}/stage`, { stage: 'ASSEMBLY' }, 'STAGE_LOCKED', 422);
  await booksAreClean('finishing the machine');
});

test('dispatch: money before the machine, or management says why', async () => {
  const draft = await ok('ACCOUNTS', 'POST', '/sales-invoices', { partyId: refs.inter.id, salesOrderId: refs.order.id, vehicleNo: 'GJ01', lines: [{ kind: 'MACHINE', buildId: refs.build.id, rateMinor: 100000000 }] });
  // Rs 10,00,000 to another state: IGST 18%.
  assert.equal(draft.supplyType, 'INTER');
  assert.equal(draft.igstPaise, 18000000);
  assert.equal(draft.totalPaise, 118000000);
  assert.equal(draft.docNo, null, 'a draft holds no invoice number');

  await refused('ACCOUNTS', 'POST', `/sales-invoices/${draft.id}/submit`, {}, 'PAYMENT_DUE_BEFORE_DISPATCH', 422);
  await refused('ACCOUNTS', 'POST', `/sales-invoices/${draft.id}/submit`, { milestoneOverrideReason: 'Please' }, 'FORBIDDEN', 403);

  // 30% advance against the order, sitting as an advance.
  refs.advance = await post('ACCOUNTS', '/payments', { kind: 'RECEIPT', partyId: refs.inter.id, bankAccountCode: A.BANK, amountMinor: 35400000, reference: 'NEFT1', salesOrderId: refs.order.id, milestoneNo: 1 });
  assert.equal(refs.advance.allocatedMinor, 0);
  await refused('ACCOUNTS', 'POST', `/sales-invoices/${draft.id}/submit`, {}, 'PAYMENT_DUE_BEFORE_DISPATCH', 422);
  refs.balance = await post('ACCOUNTS', '/payments', { kind: 'RECEIPT', partyId: refs.inter.id, bankAccountCode: A.BANK, amountMinor: 70800000, reference: 'NEFT2', salesOrderId: refs.order.id, milestoneNo: 2 });

  refs.invoice = await ok('ACCOUNTS', 'POST', `/sales-invoices/${draft.id}/submit`, {});
  assert.match(refs.invoice.docNo, /^SI\/\d{4}\/00001$/);
  assert.ok(refs.invoice.docNo.length <= 16);
  assert.equal(refs.invoice.costPaise, refs.machineCost);

  const build = await ok('PRODUCTION', 'GET', `/builds/${refs.build.id}`);
  assert.equal(build.stage, 'DISPATCHED');
  assert.equal(await glSum(A.FINISHED_GOODS), 0);
  assert.equal(await glSum(A.COGS), refs.machineCost);
  assert.equal(await glSum(A.SALES_MACHINES), -100000000);
  assert.equal(await glSum(A.OUTPUT_IGST), -18000000);
  assert.equal(await glSum(A.DEBTORS), 118000000 - 35400000 - 70800000);
  await refused('ACCOUNTS', 'PATCH', `/sales-invoices/${draft.id}`, { partyId: refs.inter.id, lines: [{ kind: 'SERVICE', itemId: refs.install.id, qtyMilli: 1000, rateMinor: 1 }] }, 'NOT_DRAFT', 409);

  const ageing = await ok('ACCOUNTS', 'GET', '/reports/ageing?kind=RECEIVABLE');
  const row = ageing.rows.find((r) => r.partyId === refs.inter.id);
  assert.equal(row.outstandingPaise, 118000000);
  assert.equal(row.advancePaise, 106200000);
  await booksAreClean('dispatch');
});

test('allocation: advances clear the invoice, and over-allocation is refused', async () => {
  await refused('ACCOUNTS', 'POST', `/payments/${refs.advance.id}/allocate`, { docId: refs.invoice.id, amountMinor: 35400001 }, 'OVER_ALLOCATED', 422);
  await ok('ACCOUNTS', 'POST', `/payments/${refs.advance.id}/allocate`, { docId: refs.invoice.id, amountMinor: 35400000 });
  await ok('ACCOUNTS', 'POST', `/payments/${refs.balance.id}/allocate`, { docId: refs.invoice.id, amountMinor: 70800000 });
  refs.final = await post('ACCOUNTS', '/payments', { kind: 'RECEIPT', partyId: refs.inter.id, bankAccountCode: A.BANK, amountMinor: 11800000, reference: 'NEFT3', salesOrderId: refs.order.id, milestoneNo: 3, allocations: [{ docId: refs.invoice.id, amountMinor: 11800000 }] });
  const invoice = await ok('ACCOUNTS', 'GET', `/sales-invoices/${refs.invoice.id}`);
  assert.equal(invoice.paidPaise, invoice.totalPaise);
  assert.equal(await glSum(A.DEBTORS, { partyId: refs.inter.id }), 0);
  await refused('ACCOUNTS', 'POST', '/payments/' + (await ok('ACCOUNTS', 'POST', '/payments', { kind: 'RECEIPT', partyId: refs.inter.id, bankAccountCode: A.BANK, amountMinor: 5, allocations: [{ docId: refs.invoice.id, amountMinor: 5 }] })).id + '/submit', undefined, 'OVER_PAID', 422);
  await refused('ACCOUNTS', 'POST', `/sales-invoices/${refs.invoice.id}/cancel`, { reason: 'x' }, 'INVOICE_HAS_PAYMENTS', 422);
  assert.equal((await ok('ACCOUNTS', 'GET', '/reports/ageing?kind=RECEIVABLE')).rows.some((r) => r.partyId === refs.inter.id && r.outstandingPaise > 0), false);

  await post('ACCOUNTS', '/payments', { kind: 'PAYMENT', partyId: refs.supplier.id, bankAccountCode: A.BANK, amountMinor: refs.steelBill.totalPaise, allocations: [{ docId: refs.steelBill.id, amountMinor: refs.steelBill.totalPaise }] });
  assert.equal(await glSum(A.CREDITORS, { partyId: refs.supplier.id }), 0);
  await booksAreClean('allocation');
});

test('after the sale: installation, warranty, AMC, and tickets that know their cover', async () => {
  await refused('SERVICE', 'POST', '/amc', { buildId: refs.build.id, startDate: today, endDate: addDays(today, 30) }, 'NOT_INSTALLED', 422);
  await refused('SERVICE', 'POST', `/builds/${refs.build.id}/install`, { installedOn: addDays(today, -400), installedBy: 'Sunil' }, 'BAD_DATE', 422);
  const installed = await ok('SERVICE', 'POST', `/builds/${refs.build.id}/install`, { installedOn: today, installedBy: 'Sunil', installationRef: 'SAT-1' });
  assert.equal(installed.stage, 'INSTALLED');
  assert.ok(installed.warrantyUntil > addDays(today, 360));

  const ticket = await ok('SERVICE', 'POST', '/tickets', { buildId: refs.build.id, complaint: 'Nozzle drips', priority: 'HIGH' });
  assert.equal(ticket.coverage, 'WARRANTY');
  await refused('SERVICE', 'PATCH', `/tickets/${ticket.id}`, { status: 'RESOLVED' }, 'RESOLUTION_REQUIRED', 422);
  const solved = await ok('SERVICE', 'PATCH', `/tickets/${ticket.id}`, { status: 'RESOLVED', resolution: 'New nozzle' });
  assert.equal(solved.resolvedOn, today);
  await refused('SERVICE', 'PATCH', `/tickets/${ticket.id}`, { status: 'OPEN' }, 'TICKET_CLOSED', 422);

  await post('SERVICE', '/amc', { buildId: refs.build.id, startDate: today, endDate: addDays(today, 365), valuePaise: 10000000 });
  const overlap = await ok('SERVICE', 'POST', '/amc', { buildId: refs.build.id, startDate: addDays(today, 100), endDate: addDays(today, 200) });
  await refused('SERVICE', 'POST', `/amc/${overlap.id}/submit`, undefined, 'AMC_OVERLAP', 422);
  await booksAreClean('service');
});

test('intra-state spares: CGST + SGST, round-off, stock and cost of goods', async () => {
  const invoice = await post('ACCOUNTS', '/sales-invoices', { partyId: refs.intra.id, lines: [{ kind: 'GOODS', itemId: refs.spare.id, qtyMilli: 3000, rateMinor: 33333 }] });
  // 3 x Rs 333.33 = Rs 999.99. GST 18% = 180.00 (179.9982). Total 1179.99, rounds up to 1180.
  assert.equal(invoice.taxablePaise, 99999);
  assert.equal(invoice.cgstPaise, 9000);
  assert.equal(invoice.sgstPaise, 9000);
  assert.equal(invoice.roundOffPaise, 1);
  assert.equal(invoice.totalPaise, 118000);
  assert.equal(invoice.costPaise, 300000);
  refs.spareInvoice = invoice;
  await booksAreClean('the spares invoice');
});

test('credit note: reduces the invoice, returns goods, and cannot exceed what is left', async () => {
  const line = refs.spareInvoice.lines[0];
  const tooBig = await ok('ACCOUNTS', 'POST', '/notes', { kind: 'CREDIT', invoiceId: refs.spareInvoice.id, reason: 'Too big', lines: [{ invoiceLineId: line.id, taxableMinor: 200000 }] });
  await refused('ACCOUNTS', 'POST', `/notes/${tooBig.id}/submit`, undefined, 'NOTE_TOO_LARGE', 422);
  await ok('ACCOUNTS', 'DELETE', `/notes/${tooBig.id}`);

  const note = await post('ACCOUNTS', '/notes', { kind: 'CREDIT', invoiceId: refs.spareInvoice.id, reason: 'One nozzle returned', lines: [{ invoiceLineId: line.id, taxableMinor: 33333, qtyMilli: 1000, returnGoods: true, warehouseId: refs.stores.id }] });
  assert.match(note.docNo, /^CN\//);
  assert.equal(note.taxablePaise, 33333);
  assert.equal(note.lines[0].stockValuePaise, 100000);
  const invoice = await ok('ACCOUNTS', 'GET', `/sales-invoices/${refs.spareInvoice.id}`);
  assert.equal(invoice.creditedPaise, note.totalPaise);
  await refused('ACCOUNTS', 'POST', `/sales-invoices/${refs.spareInvoice.id}/cancel`, { reason: 'x' }, 'INVOICE_HAS_NOTES', 422);
  await booksAreClean('the credit note');

  await ok('ACCOUNTS', 'POST', `/notes/${note.id}/cancel`, { reason: 'Issued by mistake' });
  assert.equal((await ok('ACCOUNTS', 'GET', `/sales-invoices/${refs.spareInvoice.id}`)).creditedPaise, 0);
  await booksAreClean('cancelling the credit note');
});

test('debit note: rejected goods go back, and the supplier owes the difference', async () => {
  // A second bill, for the rest of the payable to be reduced against.
  const po = await post('PURCHASE', '/purchase-orders', { partyId: refs.supplier.id, lines: [{ itemId: refs.steel.id, qtyMilli: 10000, ratePaise: 100000 }] });
  const receipt = await post('STORES', '/grns', { purchaseOrderId: po.id, lines: [{ poLineId: po.lines[0].id, qtyMilli: 10000, lot: 'H2' }] });
  await post('QUALITY', '/inspections', { grnId: receipt.id, lines: [{ grnLineId: receipt.lines[0].id, acceptedMilli: 8000, rejectedMilli: 2000 }] });
  const bill = await post('ACCOUNTS', '/purchase-invoices', { partyId: refs.supplier.id, supplierInvoiceNo: 'INV-2', supplierInvoiceDate: today, lines: [{ kind: 'GOODS', grnId: receipt.id, grnLineId: receipt.lines[0].id, qtyMilli: 10000, ratePaise: 100000 }] });

  const note = await post('ACCOUNTS', '/notes', { kind: 'DEBIT', invoiceId: bill.id, reason: 'Rejected at inspection', lines: [{ invoiceLineId: bill.lines[0].id, taxableMinor: 200000, qtyMilli: 2000, returnGoods: true, lot: 'H2' }] });
  assert.match(note.docNo, /^DN\//);
  assert.equal(note.cgstPaise + note.sgstPaise, 36000);
  assert.equal(note.lines[0].stockValuePaise, 200000);
  const stock = (await ok('STORES', 'GET', `/reports/stock-balance?itemId=${refs.steel.id}&warehouseId=${refs.reject.id}`)).rows.find((r) => r.lot === 'H2');
  assert.equal(stock, undefined, 'the rejected lot has left');
  const after = await ok('ACCOUNTS', 'GET', `/purchase-invoices/${bill.id}`);
  assert.equal(after.creditedPaise, 236000);
  await booksAreClean('the debit note');
});

test('export: dollars, zero-rated under LUT, and the exchange difference is booked', async () => {
  const draft = await ok('ACCOUNTS', 'POST', '/sales-invoices', { partyId: refs.foreign.id, currency: 'USD', fxRate4: 830000, shippingBillNo: 'SB-1', lines: [{ kind: 'GOODS', itemId: refs.spare.id, qtyMilli: 1000, rateMinor: 100000 }] });
  // USD 1,000.00 at Rs 83 is Rs 83,000. No GST.
  assert.equal(draft.supplyType, 'EXPORT_LUT');
  assert.equal(draft.taxablePaise, 8300000);
  assert.equal(draft.totalPaise, 8300000);
  assert.equal(draft.taxPaise, 0);
  assert.equal(draft.totalMinor, 100000);
  assert.equal(draft.lutNumber, 'LUT-TEST-1');
  const invoice = await ok('ACCOUNTS', 'POST', `/sales-invoices/${draft.id}/submit`, {});

  await refused('ACCOUNTS', 'POST', '/sales-invoices', { partyId: refs.foreign.id, currency: 'USD', lines: [{ kind: 'GOODS', itemId: refs.spare.id, qtyMilli: 1000, rateMinor: 1 }] }, 'FX_REQUIRED', 422);

  // Half arrives at Rs 84, a gain. Half at Rs 82, a loss.
  await post('ACCOUNTS', '/payments', { kind: 'RECEIPT', partyId: refs.foreign.id, bankAccountCode: A.BANK, currency: 'USD', fxRate4: 840000, amountMinor: 50000, allocations: [{ docId: invoice.id, amountMinor: 50000 }] });
  assert.equal(await glSum(A.FOREX_GAIN), -50000, 'Rs 500 gain');
  const lossPayment = await post('ACCOUNTS', '/payments', { kind: 'RECEIPT', partyId: refs.foreign.id, bankAccountCode: A.BANK, currency: 'USD', fxRate4: 820000, amountMinor: 50000, allocations: [{ docId: invoice.id, amountMinor: 50000 }] });
  assert.equal(await glSum(A.FOREX_LOSS), 50000, 'Rs 500 loss');
  assert.equal(await glSum(A.DEBTORS, { partyId: refs.foreign.id }), 0, 'the customer clears to the paisa');
  const paid = await ok('ACCOUNTS', 'GET', `/sales-invoices/${invoice.id}`);
  assert.equal(paid.paidPaise, paid.totalPaise);
  await booksAreClean('the export');

  await ok('ACCOUNTS', 'POST', `/payments/${lossPayment.id}/cancel`, { reason: 'Bounced' });
  assert.equal(await glSum(A.FOREX_LOSS), 0);
  assert.equal((await ok('ACCOUNTS', 'GET', `/sales-invoices/${invoice.id}`)).paidMinor, 50000);
  await booksAreClean('cancelling the export receipt');
});

test('cancel: invoice brings the machine back, order cannot go with cost, receipts must go first', async () => {
  const quoteless = await post('SALES', '/sales-orders', { partyId: refs.intra.id, lines: [{ itemId: refs.machine.id, qtyMilli: 1000, rateMinor: 100000 }], milestones: [{ no: 1, name: 'All', trigger: 'BEFORE_DISPATCH', pctBps: 10000 }] });
  const build = (await ok('PRODUCTION', 'GET', `/builds?salesOrderId=${quoteless.id}`))[0];
  const issue = await post('STORES', '/material-issues', { buildId: build.id, lines: [{ itemId: refs.plc.id, qtyMilli: 1000 }] });
  await refused('SALES', 'POST', `/sales-orders/${quoteless.id}/cancel`, { reason: 'x' }, 'BUILD_HAS_COST', 422);

  // Cancelling the issue takes the cost back off the build, to the paisa.
  await ok('STORES', 'POST', `/material-issues/${issue.id}/cancel`, { reason: 'Wrong build' });
  assert.equal((await ok('PRODUCTION', 'GET', `/builds/${build.id}`)).wipPaise, 0);
  await refused('STORES', 'POST', `/material-issues/${issue.id}/cancel`, { reason: 'again' }, 'ALREADY_CANCELLED', 409);
  await refused('SALES', 'POST', `/sales-orders/${quoteless.id}/cancel`, {}, 'VALIDATION_FAILED', 400);
  await ok('SALES', 'POST', `/sales-orders/${quoteless.id}/cancel`, { reason: 'Customer changed mind' });
  assert.equal((await ok('PRODUCTION', 'GET', `/builds/${build.id}`)).stage, 'CANCELLED');
  await booksAreClean('cancelling the order');

  // An unpaid machine invoice, cancelled: the machine goes back to READY and the money back.
  const next = await post('SALES', '/sales-orders', { partyId: refs.intra.id, lines: [{ itemId: refs.machine.id, qtyMilli: 1000, rateMinor: 100000000 }], milestones: [{ no: 1, name: 'All', trigger: 'AFTER_INSTALLATION', pctBps: 10000 }] });
  const b2 = (await ok('PRODUCTION', 'GET', `/builds?salesOrderId=${next.id}`))[0];
  await post('STORES', '/material-issues', { buildId: b2.id, lines: [{ itemId: refs.plc.id, qtyMilli: 1000 }, { itemId: refs.pump.id, qtyMilli: 4000 }] });
  const fat = await ok('QUALITY', 'POST', `/builds/${b2.id}/fat`, { witnessName: 'W' });
  await ok('QUALITY', 'PATCH', `/fat/${fat.id}`, { gaugeIds: [refs.gauge.id], results: fat.results.map((r) => ({ id: r.id, result: 'PASS', observedMilli: r.minMilli !== null ? 100000 : null })) });
  await ok('QUALITY', 'POST', `/fat/${fat.id}/close`);
  await refused('PRODUCTION', 'POST', `/builds/${b2.id}/complete`, {}, 'MATERIALS_NOT_ISSUED', 422);
  await refused('PRODUCTION', 'POST', `/builds/${b2.id}/complete`, { allowUnissued: true }, 'REASON_REQUIRED', 422);
  await ok('PRODUCTION', 'POST', `/builds/${b2.id}/complete`, { allowUnissued: true, reason: 'Frame supplied by customer' });

  const before = await glSum(A.COGS);
  const sold = await post('ACCOUNTS', '/sales-invoices', { partyId: refs.intra.id, salesOrderId: next.id, lines: [{ kind: 'MACHINE', buildId: b2.id, rateMinor: 100000000 }] });
  assert.equal(sold.cgstPaise, 9000000);
  assert.ok(await glSum(A.COGS) > before);
  await ok('ACCOUNTS', 'POST', `/sales-invoices/${sold.id}/cancel`, { reason: 'Wrong customer' });
  assert.equal(await glSum(A.COGS), before);
  const back = await ok('PRODUCTION', 'GET', `/builds/${b2.id}`);
  assert.equal(back.stage, 'READY');
  assert.equal(back.salesInvoiceId, null);
  await booksAreClean('cancelling the machine invoice');
  refs.readyBuild = back;

  const again = await ok('ACCOUNTS', 'POST', '/sales-invoices', { partyId: refs.inter.id, lines: [{ kind: 'MACHINE', buildId: b2.id, rateMinor: 1 }] });
  await refused('ACCOUNTS', 'POST', `/sales-invoices/${again.id}/submit`, {}, 'BUILD_OTHER_CUSTOMER', 422);
  await ok('ACCOUNTS', 'DELETE', `/sales-invoices/${again.id}`);
});

test('GRN cancel: refused once billed or inspected; adjustments need a reason', async () => {
  await refused('STORES', 'POST', `/grns/${refs.steelGrn.id}/cancel`, { reason: 'x' }, 'GRN_BILLED', 422);
  const po = await post('PURCHASE', '/purchase-orders', { partyId: refs.supplier.id, lines: [{ itemId: refs.plc.id, qtyMilli: 2000, ratePaise: 100000 }] });
  const receipt = await post('STORES', '/grns', { purchaseOrderId: po.id, lines: [{ poLineId: po.lines[0].id, qtyMilli: 2000 }] });
  assert.equal((await ok('PURCHASE', 'GET', `/purchase-orders/${po.id}`)).status, 'CLOSED');
  await ok('STORES', 'POST', `/grns/${receipt.id}/cancel`, { reason: 'Wrong challan' });
  const reopened = await ok('PURCHASE', 'GET', `/purchase-orders/${po.id}`);
  assert.equal(reopened.status, 'APPROVED');
  assert.equal(reopened.lines[0].receivedMilli, 0);
  await refused('PURCHASE', 'POST', `/purchase-orders/${refs.steelPo.id}/cancel`, { reason: 'x' }, 'PO_HAS_RECEIPTS', 422);

  const noReason = await ok('STORES', 'POST', '/stock-moves', { kind: 'ADJUST_OUT', lines: [{ itemId: refs.spare.id, qtyMilli: 1000, fromWarehouseId: refs.stores.id }] });
  await refused('STORES', 'POST', `/stock-moves/${noReason.id}/submit`, undefined, 'REASON_REQUIRED', 422);
  await ok('STORES', 'DELETE', `/stock-moves/${noReason.id}`);
  await post('STORES', '/stock-moves', { kind: 'ADJUST_OUT', reason: 'Lost in count', lines: [{ itemId: refs.spare.id, qtyMilli: 1000, fromWarehouseId: refs.stores.id }] });
  assert.ok(await glSum(A.STOCK_ADJUSTMENT) > 0);

  const locked = await ok('STORES', 'POST', '/stock-moves', { kind: 'TRANSFER', lines: [{ itemId: refs.spare.id, qtyMilli: 1000, fromWarehouseId: refs.stores.id, toWarehouseId: refs.hold.id }] });
  await refused('STORES', 'POST', `/stock-moves/${locked.id}/submit`, undefined, 'WAREHOUSE_LOCKED', 422);
  await ok('STORES', 'DELETE', `/stock-moves/${locked.id}`);
  await booksAreClean('GRN cancel and adjustments');
});

test('journal: balanced, no control accounts, reversal; period lock stops everything', async () => {
  await refused('ACCOUNTS', 'POST', '/journals', { narration: 'Sneak', lines: [{ accountCode: A.DEBTORS, debitPaise: 100 }, { accountCode: A.EXPENSES, creditPaise: 100 }] }, 'CONTROL_ACCOUNT', 422);
  const bad = await ok('ACCOUNTS', 'POST', '/journals', { narration: 'Off by one', lines: [{ accountCode: A.RENT, debitPaise: 100 }, { accountCode: A.BANK, creditPaise: 99 }] });
  await refused('ACCOUNTS', 'POST', `/journals/${bad.id}/submit`, undefined, 'UNBALANCED_VOUCHER', 422);
  await ok('ACCOUNTS', 'DELETE', `/journals/${bad.id}`);
  const rent = await post('ACCOUNTS', '/journals', { narration: 'Rent', lines: [{ accountCode: A.RENT, debitPaise: 5000000 }, { accountCode: A.BANK, creditPaise: 5000000 }] });
  assert.equal(await glSum(A.RENT), 5000000);

  await ok('ADMIN', 'PATCH', '/admin/settings', { booksLockedUpTo: today });
  const draft = await ok('ACCOUNTS', 'POST', '/journals', { narration: 'Too late', lines: [{ accountCode: A.RENT, debitPaise: 1 }, { accountCode: A.BANK, creditPaise: 1 }] });
  await refused('ACCOUNTS', 'POST', `/journals/${draft.id}/submit`, undefined, 'PERIOD_LOCKED', 422);
  await refused('ACCOUNTS', 'POST', `/journals/${rent.id}/cancel`, { reason: 'x' }, 'PERIOD_LOCKED', 422);
  await ok('ADMIN', 'PATCH', '/admin/settings', { booksLockedUpTo: null });
  await ok('ACCOUNTS', 'DELETE', `/journals/${draft.id}`);
  await ok('ACCOUNTS', 'POST', `/journals/${rent.id}/cancel`, { reason: 'Wrong month' });
  assert.equal(await glSum(A.RENT), 0);
  await booksAreClean('journals');
});

test('two people submitting one draft: it posts once', async () => {
  const draft = await ok('ACCOUNTS', 'POST', '/journals', { narration: 'Race', lines: [{ accountCode: A.RENT, debitPaise: 700 }, { accountCode: A.BANK, creditPaise: 700 }] });
  const results = await Promise.all([1, 2, 3].map(() => call('ACCOUNTS', 'POST', `/journals/${draft.id}/submit`)));
  assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results.map((r) => r.status)));
  assert.equal(await glSum(A.RENT), 700);
  await booksAreClean('the race');
});

test('reports add up: trial balance, balance sheet, P&L, GST', async () => {
  const tb = await ok('ACCOUNTS', 'GET', '/reports/trial-balance');
  assert.equal(tb.balanced, true);
  assert.equal(tb.totals.closingDebitPaise, tb.totals.closingCreditPaise);
  const sheet = await ok('ACCOUNTS', 'GET', '/reports/balance-sheet');
  assert.equal(sheet.balanced, true, `${sheet.assetsPaise} != ${sheet.liabilitiesPaise} + ${sheet.equityPaise}`);
  const pnl = await ok('ACCOUNTS', 'GET', '/reports/profit-and-loss');
  assert.equal(sheet.equity.find((r) => r.name === 'Profit to date').amountPaise, pnl.profitPaise);

  const r1 = await ok('ACCOUNTS', 'GET', '/reports/gstr1');
  assert.equal(r1.b2b.length, 1);
  assert.equal(r1.b2b[0].partyGstin, '27AAPFU0939F1ZV');
  assert.equal(r1.exports.length, 1);
  assert.ok(r1.hsnSummary.length >= 2);
  assert.equal(r1.documents.cancelled, 1);
  const r3 = await ok('ACCOUNTS', 'GET', '/reports/gstr3b');
  assert.equal(r3.outward.igstPaise, await glSum(A.OUTPUT_IGST) * -1);
  assert.equal(r3.outward.cgstPaise, await glSum(A.OUTPUT_CGST) * -1);
  assert.equal(r3.itc.cgstPaise, await glSum(A.INPUT_CGST));
  assert.equal(r3.itc.igstPaise, await glSum(A.INPUT_IGST));

  const dash = await ok('STORES', 'GET', '/reports/dashboard');
  assert.ok(dash.overdueGauges >= 1);
  assert.equal((await call('STORES', 'GET', '/reports/integrity')).status, 403);
  const audit = await ok('ADMIN', 'GET', '/admin/audit?limit=5');
  assert.equal(audit.length, 5);
});

// Each check must catch the thing it exists for. Each break is undone before the next.
const failing = async () => (await integrity()).checks.filter((c) => !c.ok).map((c) => c.id);

test('tampering: every integrity check catches what it exists for', async () => {
  assert.deepEqual(await failing(), []);

  const gl = rawCollection(GlEntry);
  const entry = await gl.findOne({ accountCode: A.RENT, debitPaise: { $gt: 0 } });
  await gl.updateOne({ _id: entry._id }, { $inc: { debitPaise: 1 } });
  assert.ok((await failing()).includes('I1'));
  await gl.updateOne({ _id: entry._id }, { $inc: { debitPaise: -1 } });

  const bins = rawCollection(Bin);
  const bin = await bins.findOne({ qtyMilli: { $gt: 0 }, valuePaise: { $gt: 0 } });
  await bins.updateOne({ _id: bin._id }, { $inc: { qtyMilli: 1 } });
  assert.deepEqual(await failing(), ['I2']);
  await bins.updateOne({ _id: bin._id }, { $inc: { qtyMilli: -1 } });

  const stock = rawCollection(StockEntry);
  const line = await stock.findOne({ qtyMilli: { $gt: 0 }, valuePaise: { $gt: 0 } });
  await stock.updateOne({ _id: line._id }, { $inc: { valuePaise: 5 } });
  assert.ok((await failing()).includes('I2'));
  await stock.updateOne({ _id: line._id }, { $inc: { valuePaise: -5 } });

  await bins.updateOne({ _id: bin._id }, { $inc: { valuePaise: 9 } });
  const both = await failing();
  assert.ok(both.includes('I3'), `I3 should catch stock value against the GL, got ${both}`);
  await bins.updateOne({ _id: bin._id }, { $inc: { valuePaise: -9 } });

  const builds = rawCollection(MachineBuild);
  const readyId = new mongoose.Types.ObjectId(refs.readyBuild.id);
  await builds.updateOne({ _id: readyId }, { $inc: { wipPaise: 3 } });
  assert.deepEqual(await failing(), ['I4']);
  await builds.updateOne({ _id: readyId }, { $inc: { wipPaise: -3 } });

  await bins.updateOne({ _id: bin._id }, { $set: { qtyMilli: -1 } });
  assert.ok((await failing()).includes('I5'));
  await bins.updateOne({ _id: bin._id }, { $set: { qtyMilli: bin.qtyMilli } });

  const logs = rawCollection(AuditLog);
  const log = await logs.findOne({ seq: 5 });
  await logs.updateOne({ seq: 5 }, { $set: { actorName: 'Someone else' } });
  assert.deepEqual(await failing(), ['I6']);
  await logs.updateOne({ seq: 5 }, { $set: { actorName: log.actorName } });

  await rawCollection(Counter).updateOne({ _id: /^doc:SI:/ }, { $inc: { seq: 1 } });
  assert.deepEqual(await failing(), ['I7']);
  await rawCollection(Counter).updateOne({ _id: /^doc:SI:/ }, { $inc: { seq: -1 } });

  assert.deepEqual(await failing(), [], 'everything undone, everything clean');
});

test('the ledgers really are append-only over the API too', async () => {
  const before = await GlEntry.countDocuments();
  assert.equal((await call('ADMIN', 'DELETE', '/reports/ledger')).status, 404);
  assert.equal(await GlEntry.countDocuments(), before);
  assert.ok(await Warehouse.countDocuments() >= 5);
  assert.ok((await Settings.findById('company')).booksLockedUpTo === null);
});
