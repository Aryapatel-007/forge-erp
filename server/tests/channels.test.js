// Limits on core documents, planning, the website, and everything that talks to the outside.
// Outside services are local stand-ins here, so this proves our side only.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { booksAreClean, call, ok, post, refused, startApi, stopApi, users } from './helpers/http.js';
import { A } from '../config/accounts.js';
import { GlEntry } from '../models/index.js';
import { fetchExchangeRates, flushSms, parseEmail, readMailbox } from '../services/channelsService.js';
import { Pop3Client } from '../services/pop3Client.js';
import { statementDate } from '../doctypes/channels.js';
import { addDays, todayIst } from '../utils/dates.js';

const today = todayIst();
const refs = {};
const gl = async (code) => {
  const rows = await GlEntry.find({ accountCode: code }).lean();
  return rows.reduce((sum, r) => sum + r.debitPaise - r.creditPaise, 0);
};
const opening = (lines) => post('STORES', '/stock-moves', { kind: 'OPENING', reason: 'Opening', lines });
const milestone = [{ no: 1, name: 'All', trigger: 'ORDER', pctBps: 10000 }];

before(async () => {
  await startApi();
  await ok('ADMIN', 'PATCH', '/admin/settings', { stateCode: '24' });
  for (const [key, row] of Object.entries({
    stores: { code: 'STORES', name: 'Stores', kind: 'STORES' },
    other: { code: 'STORE2', name: 'Other stores', kind: 'STORES' },
    hold: { code: 'HOLD', name: 'Hold', kind: 'QUARANTINE' },
    reject: { code: 'REJECT', name: 'Reject', kind: 'REJECT' },
    fg: { code: 'FG', name: 'Finished', kind: 'FG' },
  })) refs[key] = await ok('ADMIN', 'POST', '/warehouses', row);
  for (const [key, row] of Object.entries({
    mine: { code: 'C1', name: 'Allowed customer', isCustomer: true, stateCode: '24', email: 'buyer@one.example', phone: '9876543210' },
    theirs: { code: 'C2', name: 'Other customer', isCustomer: true, stateCode: '24', phone: 'not a phone' },
    supplier: { code: 'S1', name: 'Supplier', isSupplier: true, stateCode: '24' },
  })) refs[key] = await ok('ADMIN', 'POST', '/parties', row);
  for (const [key, row] of Object.entries({
    m1: { code: 'M1', name: 'Material one', type: 'RAW', hsn: '7318', gstRateBps: 1800, standardCostPaise: 1000 },
    m2: { code: 'M2', name: 'Material two', type: 'RAW', hsn: '7219', gstRateBps: 1800, standardCostPaise: 2000 },
    product: { code: 'P1', name: 'Product', type: 'ASSEMBLY', hsn: '8422', gstRateBps: 1800 },
    planned: { code: 'P2', name: 'Planned product', type: 'ASSEMBLY', hsn: '8422', gstRateBps: 1800 },
    part: { code: 'PART', name: 'Bought part', type: 'RAW', hsn: '7318', gstRateBps: 1800 },
    shown: { code: 'SHOWN', name: 'Tablet press', type: 'MACHINE', hsn: '8422', gstRateBps: 1800, salePricePaise: 50000000, standardCostPaise: 123, showOnWebsite: true, webDescription: 'Fast and clean' },
    hidden: { code: 'HIDDEN', name: 'Secret part', type: 'RAW', hsn: '7318', gstRateBps: 1800 },
  })) refs[key] = await ok('ADMIN', 'POST', '/items', row);
  await opening([
    { itemId: refs.m1.id, qtyMilli: 100000, toWarehouseId: refs.stores.id, ratePaise: 1000 },
    { itemId: refs.m2.id, qtyMilli: 100000, toWarehouseId: refs.stores.id, ratePaise: 2000 },
  ]);
  refs.bom = await ok('ENGINEERING', 'POST', '/boms', { itemId: refs.product.id, lines: [{ itemId: refs.m1.id, qtyMilli: 2000 }, { itemId: refs.m2.id, qtyMilli: 1000 }] });
  await ok('ENGINEERING', 'POST', `/boms/${refs.bom.id}/release`);
  refs.plannedBom = await ok('ENGINEERING', 'POST', '/boms', { itemId: refs.planned.id, lines: [{ itemId: refs.part.id, qtyMilli: 1000 }] });
  await ok('ENGINEERING', 'POST', `/boms/${refs.plannedBom.id}/release`);
});
after(stopApi);

/* ---------- Limits ---------- */

test('per-record limits now reach core documents, search, reports and dashboards', async () => {
  const order = (party) => post('MANAGEMENT', '/sales-orders', { partyId: party.id, lines: [{ itemId: refs.m1.id, qtyMilli: 1000, rateMinor: 100 }], milestones: milestone });
  const mine = await order(refs.mine);
  const theirs = await order(refs.theirs);
  const proformaMine = await ok('MANAGEMENT', 'POST', '/d/ProformaInvoice', { partyId: refs.mine.id, lines: [{ itemId: refs.m1.id, qtyMilli: 1000, ratePaise: 100 }] });
  const proformaTheirs = await ok('MANAGEMENT', 'POST', '/d/ProformaInvoice', { partyId: refs.theirs.id, lines: [{ itemId: refs.m1.id, qtyMilli: 1000, ratePaise: 100 }] });

  await refused('ADMIN', 'POST', '/d/UserPermission', { userId: String(users.SALES._id), targetDoctype: 'Nonsense', valueId: 'x' }, 'BAD_TARGET', 422);
  await refused('ADMIN', 'POST', '/d/UserPermission', { userId: String(users.SALES._id), targetDoctype: 'Party', valueId: '0123456789abcdef01234567' }, 'LINK_NOT_FOUND', 422);
  const limit = await ok('ADMIN', 'POST', '/d/UserPermission', { userId: String(users.SALES._id), targetDoctype: 'Party', valueId: refs.mine.id });

  // Core documents: lists, single records, and saving.
  const list = await ok('SALES', 'GET', '/sales-orders?limit=200');
  assert.deepEqual(list.map((o) => o.id), [mine.id]);
  assert.equal((await call('SALES', 'GET', `/sales-orders/${theirs.id}`)).status, 404);
  assert.equal((await call('SALES', 'POST', `/sales-orders/${theirs.id}/cancel`, { reason: 'x' })).status, 404);
  assert.equal((await call('SALES', 'POST', '/sales-orders', { partyId: refs.theirs.id, lines: [{ itemId: refs.m1.id, qtyMilli: 1000, rateMinor: 100 }], milestones: milestone })).status, 403);
  const parties = await ok('SALES', 'GET', '/parties?limit=200');
  assert.deepEqual(parties.map((p) => p.id), [refs.mine.id]);

  // Reports that add up everything are refused. Ones that can be narrowed are narrowed.
  await refused('SALES', 'GET', '/reports/ageing?kind=RECEIVABLE', undefined, 'NOT_FOR_LIMITED_USERS', 403);
  await refused('SALES', 'GET', '/r/sales-by-month', undefined, 'NOT_FOR_LIMITED_USERS', 403);
  const open = await ok('SALES', 'GET', '/r/proforma-open');
  assert.deepEqual(open.rows.map((r) => r.docNo), [proformaMine.docNo]);
  assert.equal((await ok('MANAGEMENT', 'GET', '/r/proforma-open')).rows.length, 2);

  // Search, the report builder, and comments on a hidden record.
  const found = await ok('SALES', 'GET', `/search?q=${encodeURIComponent(proformaTheirs.docNo)}`);
  assert.equal(found.length, 0);
  const built = await ok('SALES', 'POST', '/report-builder', { doctype: 'ProformaInvoice', columns: ['docNo'] });
  assert.deepEqual(built.rows.map((r) => r.docNo), [proformaMine.docNo]);
  assert.equal((await call('SALES', 'GET', `/comments?entityType=ProformaInvoice&entityId=${proformaTheirs.id}`)).status, 404);
  assert.equal((await call('SALES', 'GET', `/comments?entityType=ProformaInvoice&entityId=${proformaMine.id}`)).status, 200);

  // Dashboards count only what this person may see.
  const card = await ok('ADMIN', 'POST', '/d/NumberCard', { label: 'Proformas', doctypeName: 'ProformaInvoice', measure: 'COUNT' });
  const dash = await ok('ADMIN', 'POST', '/d/Dashboard', { name: 'Limits', cards: [{ cardId: card.id }] });
  assert.equal((await ok('SALES', 'GET', `/views/dashboards/${dash.id}`)).cards[0].value, 1);
  assert.equal((await ok('ADMIN', 'GET', `/views/dashboards/${dash.id}`)).cards[0].value, 2);

  // Removing the limit takes effect at once.
  await ok('ADMIN', 'DELETE', `/d/UserPermission/${limit.id}`);
  assert.equal((await ok('SALES', 'GET', '/sales-orders?limit=200')).length, 2);
  assert.ok(Array.isArray((await ok('SALES', 'GET', '/r/sales-by-month')).rows));
});

/* ---------- Planning ---------- */

test('scheduling back from a due date, and saying so when it cannot be done', async () => {
  const station = await ok('PRODUCTION', 'POST', '/d/Workstation', { name: 'Back mill', hourRatePaise: 100 });
  const operation = await ok('PRODUCTION', 'POST', '/d/Operation', { name: 'Milling', workstationId: station.id });
  const routing = await ok('PRODUCTION', 'POST', '/d/Routing', { name: 'Back route', steps: [{ operationId: operation.id, workstationId: station.id, hoursMilli: 10000 }] });
  const order = await post('PRODUCTION', '/d/WorkOrder', { itemId: refs.product.id, bomId: refs.bom.id, routingId: routing.id, qtyMilli: 1000, targetWarehouseId: refs.stores.id });
  // Due Wednesday 16 Jan 2030. 10 hours at 8 a day: 8 on Wednesday, then 2 on Tuesday.
  const scheduled = await ok('PRODUCTION', 'POST', `/d/WorkOrder/${order.id}/a/scheduleBack`, { dueDate: '2030-01-16' });
  assert.deepEqual([scheduled.scheduledStart, scheduled.scheduledEnd, scheduled.plannedEnd], ['2030-01-15', '2030-01-16', '2030-01-16']);
  const bookings = await ok('ADMIN', 'GET', `/d/CapacityBooking?workOrderId=${order.id}`);
  assert.deepEqual(bookings.map((b) => [b.onDate, b.hoursMilli]).sort(), [['2030-01-15', 2000], ['2030-01-16', 8000]]);

  // 1,000 hours by tomorrow is impossible, and a refusal leaves the old bookings in place.
  const big = await ok('PRODUCTION', 'POST', '/d/Routing', { name: 'Big route', steps: [{ operationId: operation.id, workstationId: station.id, hoursMilli: 1000000 }] });
  const huge = await post('PRODUCTION', '/d/WorkOrder', { itemId: refs.product.id, bomId: refs.bom.id, routingId: big.id, qtyMilli: 1000, targetWarehouseId: refs.stores.id });
  await refused('PRODUCTION', 'POST', `/d/WorkOrder/${huge.id}/a/scheduleBack`, { dueDate: addDays(today, 1) }, 'CANNOT_MAKE_DATE', 422);
  assert.equal((await ok('ADMIN', 'GET', `/d/CapacityBooking?workOrderId=${huge.id}`)).length, 0);
});

test('MRP does not count supply that arrives after the need', async () => {
  const needBy = addDays(today, 10);
  await post('PURCHASE', '/purchase-orders', { partyId: refs.supplier.id, expectedDate: addDays(today, 5), lines: [{ itemId: refs.part.id, qtyMilli: 2000, ratePaise: 100 }] });
  await post('PURCHASE', '/purchase-orders', { partyId: refs.supplier.id, expectedDate: addDays(today, 40), lines: [{ itemId: refs.part.id, qtyMilli: 3000, ratePaise: 100 }] });
  const plan = await ok('PRODUCTION', 'POST', '/d/ProductionPlan', { planDate: today, items: [{ itemId: refs.planned.id, qtyMilli: 10000, requiredBy: needBy }] });
  const planned = await ok('PRODUCTION', 'POST', `/d/ProductionPlan/${plan.id}/a/explode`, {});
  const part = planned.requirements.find((r) => r.itemId === refs.part.id);
  // Needs 10. 2 arrive in time, and 3 too late, so 8 are short.
  assert.deepEqual([part.requiredMilli, part.onOrderMilli, part.lateSupplyMilli, part.shortMilli], [10000, 2000, 3000, 8000]);
});

test('OEE and standard cost are worked out from what actually happened', async () => {
  const station = await ok('PRODUCTION', 'POST', '/d/Workstation', { name: 'OEE press', hourRatePaise: 1000 });
  const operation = await ok('PRODUCTION', 'POST', '/d/Operation', { name: 'Pressing', workstationId: station.id, minutes: 30 });
  const routing = await ok('PRODUCTION', 'POST', '/d/Routing', { name: 'OEE route', steps: [{ operationId: operation.id, workstationId: station.id, hoursMilli: 500 }] });
  const order = await post('PRODUCTION', '/d/WorkOrder', { itemId: refs.product.id, bomId: refs.bom.id, routingId: routing.id, qtyMilli: 4000, targetWarehouseId: refs.stores.id });
  await ok('PRODUCTION', 'POST', `/d/WorkOrder/${order.id}/a/issue`, {});
  await post('PRODUCTION', '/d/JobCard', { workOrderId: order.id, operationId: operation.id, workstationId: station.id, hoursMilli: 3000, completedMilli: 4000 });
  await ok('PRODUCTION', 'POST', `/d/WorkOrder/${order.id}/a/reportLoss`, { qtyMilli: 1000, reason: 'Cracked' });
  await ok('PRODUCTION', 'POST', `/d/WorkOrder/${order.id}/a/produce`, { qtyMilli: 3000 });
  await ok('PRODUCTION', 'POST', '/d/DowntimeEntry', { workstationId: station.id, fromTime: `${today}T09:00:00+05:30`, toTime: `${today}T11:00:00+05:30`, reason: 'POWER' });

  // Seven days with a Sunday off is 6 x 8 = 48 hours, less 2 down: 46/48 = 95.83%.
  // 4 pieces at 30 minutes is 2 standard hours, in 3 run hours: 66.67%.
  // 3 good of 4 made: 75%. All three together: 47.92%.
  const report = await ok('PRODUCTION', 'GET', `/r/oee?from=${addDays(today, -6)}&to=${today}`);
  const row = report.rows.find((r) => r.workstation === 'OEE press');
  assert.deepEqual([row.availabilityBps, row.performanceBps, row.qualityBps, row.oeeBps], [9583, 6667, 7500, 4792]);

  // Product is 2 of M1 at Rs 10 and 1 of M2 at Rs 20, so Rs 40 standard.
  const rollup = await ok('PRODUCTION', 'POST', '/d/StandardCostRollup', { includeLabour: false });
  const ran = await ok('PRODUCTION', 'POST', `/d/StandardCostRollup/${rollup.id}/a/run`, {});
  assert.equal(ran.changes.find((c) => c.code === 'P1').newPaise, 4000);
  assert.equal((await ok('ADMIN', 'GET', `/items/${refs.product.id}`)).standardCostPaise, 4000);
  const again = await ok('PRODUCTION', 'POST', '/d/StandardCostRollup', { includeLabour: false });
  await refused('PRODUCTION', 'POST', `/d/StandardCostRollup/${again.id}/a/run`, {}, 'NOTHING_CHANGED', 422);

  // 3 good at Rs 40 is Rs 120 standard. Materials for 4 are Rs 160, plus 3 hours at Rs 10: Rs 190.
  const variance = await ok('PRODUCTION', 'GET', '/r/standard-cost-variance');
  const line = variance.rows.find((r) => r.docNo === order.docNo);
  assert.deepEqual([line.standardPaise, line.actualPaise, line.variancePaise], [12000, 19000, 7000]);
  await booksAreClean('OEE and standard cost');
});

test('a blanket order gets its balance back when a call-off is removed', async () => {
  const blanket = await ok('SALES', 'POST', '/d/BlanketOrder', { title: 'Deal', partyId: refs.mine.id, fromDate: today, toDate: addDays(today, 30), lines: [{ itemId: refs.m1.id, qtyMilli: 5000, ratePaise: 900 }] });
  const first = await ok('SALES', 'POST', `/d/BlanketOrder/${blanket.id}/a/callOff`, { itemId: refs.m1.id, qtyMilli: 4000 });
  await refused('SALES', 'POST', `/d/BlanketOrder/${blanket.id}/a/callOff`, { itemId: refs.m1.id, qtyMilli: 2000 }, 'OVER_BLANKET', 422);
  await ok('SALES', 'DELETE', `/sales-orders/${first.id}`);
  const second = await ok('SALES', 'POST', `/d/BlanketOrder/${blanket.id}/a/callOff`, { itemId: refs.m1.id, qtyMilli: 5000 });
  assert.equal(second.blanketOrderId, blanket.id);
  await ok('SALES', 'POST', `/sales-orders/${second.id}/submit`, {});
  await ok('SALES', 'POST', `/sales-orders/${second.id}/cancel`, { reason: 'Changed mind' });
  const balance = await ok('SALES', 'GET', '/r/blanket-order-balance');
  assert.equal(balance.rows.find((r) => r.docNo === blanket.docNo).leftMilli, 5000);
  await ok('SALES', 'POST', `/d/BlanketOrder/${blanket.id}/a/callOff`, { itemId: refs.m1.id, qtyMilli: 5000 });
});

/* ---------- Doing many at once ---------- */

test('bulk submit does what it can, and says what it could not', async () => {
  const person = await ok('HR', 'POST', '/d/Employee', { fullName: 'Asha', joiningDate: '2020-01-01' });
  const good = await ok('HR', 'POST', '/d/TravelRequest', { employeeId: person.id, purpose: 'Visit', fromDate: today, toDate: today });
  const bad = await ok('HR', 'POST', '/d/TravelRequest', { employeeId: person.id, purpose: 'Backwards', fromDate: today, toDate: addDays(today, -1) });
  const done = await ok('HR', 'POST', '/d/TravelRequest/bulk', { action: 'submit', ids: [good.id, bad.id, '0123456789abcdef01234567'] });
  assert.deepEqual([done.done, done.failed], [1, 2]);
  assert.ok(done.results[0].docNo);
  assert.equal(done.results[1].code, 'BAD_DATES');
  assert.equal((await ok('HR', 'GET', `/d/TravelRequest/${good.id}`)).status, 'SUBMITTED');
  assert.equal((await ok('HR', 'GET', `/d/TravelRequest/${bad.id}`)).status, 'DRAFT', 'one failure leaves only itself undone');
  await refused('STORES', 'POST', '/d/TravelRequest/bulk', { action: 'submit', ids: [bad.id] }, 'FORBIDDEN', 403);
  await refused('HR', 'POST', '/d/TravelRequest/bulk', { action: 'cancel', ids: [good.id] }, 'VALIDATION_FAILED', 400);
  const cancelled = await ok('HR', 'POST', '/d/TravelRequest/bulk', { action: 'cancel', ids: [good.id], reason: 'Off' });
  assert.equal(cancelled.done, 1);
  assert.equal((await ok('HR', 'POST', '/d/TravelRequest/bulk', { action: 'delete', ids: [bad.id] })).done, 1);
});

test('dates can be moved one at a time, through the type\'s own checks', async () => {
  const task = await ok('ENGINEERING', 'POST', '/d/Task', { subject: 'Move me', status: 'OPEN', startDate: today, dueDate: addDays(today, 2) });
  const moved = await ok('ENGINEERING', 'POST', `/d/Task/${task.id}/set`, { field: 'dueDate', value: addDays(today, 9) });
  assert.equal(moved.dueDate, addDays(today, 9));
  await refused('ENGINEERING', 'POST', `/d/Task/${task.id}/set`, { field: 'dueDate', value: 'soon' }, 'INVALID_DATE', 422);
  const plan = await ok('HR', 'POST', '/d/ShiftType', { name: 'Day', startTime: '09:00', endTime: '17:00' });
  const person = await ok('HR', 'POST', '/d/Employee', { fullName: 'Bina', joiningDate: '2020-01-01' });
  const shift = await ok('HR', 'POST', '/d/ShiftAssignment', { employeeId: person.id, shiftTypeId: plan.id, startDate: today, endDate: addDays(today, 5), isActive: true });
  await refused('HR', 'POST', `/d/ShiftAssignment/${shift.id}/set`, { field: 'endDate', value: addDays(today, -1) }, 'BAD_DATES', 422);
});

/* ---------- The website ---------- */

test('the website shows only what is published, and never an item\'s cost', async () => {
  await refused('ADMIN', 'POST', '/d/WebPage', { title: 'Bad', slug: 'Not Valid' }, 'BAD_SLUG', 422);
  const page = await ok('ADMIN', 'POST', '/d/WebPage', { title: 'Welcome', slug: 'home', isPublished: false, blocks: [{ kind: 'HEADING', text: 'We make machines' }, { kind: 'CATALOGUE' }] });
  assert.equal((await call(null, 'GET', '/public/pages/home')).status, 404);
  await ok('ADMIN', 'PATCH', `/d/WebPage/${page.id}`, { title: 'Welcome', slug: 'home', isPublished: true, blocks: [{ kind: 'HEADING', text: 'We make machines' }, { kind: 'CATALOGUE' }] });
  const open = await call(null, 'GET', '/public/pages/home');
  assert.deepEqual(open.body.data.blocks.map((b) => b.kind), ['HEADING', 'CATALOGUE']);
  assert.equal(JSON.stringify(open.body.data).includes('_labels'), false);
  const site = await call(null, 'GET', '/public/site');
  assert.deepEqual(site.body.data.menu.map((m) => m.slug), ['home']);

  const catalogue = (await call(null, 'GET', '/public/catalogue')).body.data;
  assert.deepEqual(catalogue.map((i) => i.code), ['SHOWN']);
  assert.deepEqual(Object.keys(catalogue[0]).sort(), ['code', 'description', 'name'], 'no cost, no stock, and no price unless switched on');
  await ok('ADMIN', 'PATCH', '/admin/settings', { siteShowPrices: true });
  assert.equal((await call(null, 'GET', '/public/catalogue')).body.data[0].pricePaise, 50000000);
  await ok('ADMIN', 'PATCH', '/admin/settings', { siteShowPrices: false });
  assert.equal((await call(null, 'GET', '/public/catalogue?q=.*')).body.data.length, 0, 'a search is plain text, not a pattern');
  assert.equal((await call(null, 'GET', '/public/catalogue/HIDDEN/image')).status, 404);
  assert.equal((await call(null, 'GET', '/public/catalogue/SHOWN/image')).status, 404, 'no picture yet');

  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const upload = await call('ADMIN', 'POST', `/files?entityType=items&entityId=${refs.shown.id}&filename=press.png`, png, { 'content-type': 'image/png' });
  assert.ok(upload.status < 300, JSON.stringify(upload.body));
  const image = await call(null, 'GET', '/public/catalogue/SHOWN/image');
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');

  const before_ = (await ok('SALES', 'GET', '/d/Lead?limit=200')).length;
  const enquiry = { name: 'Ravi', company: 'Pharma Ltd', email: 'ravi@pharma.example', phone: '9000000000', message: 'Need a quote', items: [{ code: 'shown', qty: 2 }] };
  assert.equal((await call(null, 'POST', '/public/enquiry', { ...enquiry, items: [{ code: 'HIDDEN', qty: 1 }] })).status, 400, 'only what is on show');
  assert.equal((await call(null, 'POST', '/public/enquiry', { ...enquiry, email: 'nope' })).status, 400);
  assert.equal((await call(null, 'POST', '/public/enquiry', enquiry)).status, 201);
  const leads = await ok('SALES', 'GET', '/d/Lead?limit=200');
  assert.equal(leads.length, before_ + 1);
  const lead = leads.find((l) => l.email === 'ravi@pharma.example');
  assert.match(lead.requirement, /2 x Tablet press \(SHOWN\)/);
  await call(null, 'POST', '/public/enquiry', { ...enquiry, website: 'http://spam.example' });
  assert.equal((await ok('SALES', 'GET', '/d/Lead?limit=200')).length, before_ + 1, 'a bot is thanked and ignored');
});

test('translations come from the glossary, and a record overrides it', async () => {
  const gujarati = await call(null, 'GET', '/public/translations/gu');
  assert.equal(gujarati.body.data.Save, 'સાચવો');
  assert.equal((await call(null, 'GET', '/public/translations/xx')).status, 404);
  await ok('ADMIN', 'POST', '/d/Translation', { language: 'gu', sourceText: 'Save', translatedText: 'સેવ કરો' });
  assert.equal((await call(null, 'GET', '/public/translations/gu')).body.data.Save, 'સેવ કરો');
  await refused('ADMIN', 'POST', '/d/Translation', { language: 'gu', sourceText: 'Save', translatedText: 'x' }, 'DUPLICATE', 422);
  assert.equal((await call(null, 'GET', '/public/translations/hi')).body.data.Save, 'सहेजें', 'other languages are untouched');
});

/* ---------- Mail ---------- */

test('reading an email: encodings, multipart, and markup stripped', () => {
  const simple = parseEmail('From: "Mr Shah" <Shah@Buyer.example>\r\nSubject: =?UTF-8?B?4KSo4KSu4KS44KWN4KSk4KWH?= order\r\nDate: Mon, 2 Nov 2026 10:00:00 +0530\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nPrice is =E2=82=B9100=\r\n only');
  assert.deepEqual([simple.fromAddress, simple.fromName, simple.subject, simple.body], ['shah@buyer.example', 'Mr Shah', 'नमस्ते order', 'Price is ₹100 only']);
  assert.ok(simple.sentAt instanceof Date);

  const mixed = parseEmail([
    'From: a@b.example', 'Subject: Hi', 'Content-Type: multipart/mixed; boundary="X1"', '',
    '--X1', 'Content-Type: multipart/alternative; boundary="X2"', '',
    '--X2', 'Content-Type: text/html', '', '<p>Hello <b>there</b></p><script>alert(1)</script>',
    '--X2--', '--X1', 'Content-Type: text/plain', 'Content-Disposition: attachment; filename="a.txt"', '', 'NOT THE BODY',
    '--X1--',
  ].join('\r\n'));
  assert.equal(mixed.body, 'Hello there');
  assert.equal(mixed.sentAt, null);
});

function fakeMailbox(messages) {
  const state = { deleted: [], logins: [] };
  const server = net.createServer((socket) => {
    socket.write('+OK ready\r\n');
    socket.on('error', () => {});
    socket.on('data', (data) => {
      for (const line of data.toString().split('\r\n').filter(Boolean)) {
        const [command, arg] = line.split(' ');
        if (command === 'USER') { state.logins.push(arg); socket.write('+OK\r\n'); } else if (command === 'PASS') {
          socket.write(arg === 'right' ? '+OK\r\n' : '-ERR wrong password\r\n');
        } else if (command === 'UIDL') {
          socket.write(`+OK\r\n${messages.map((m, i) => `${i + 1} ${m.uid}`).join('\r\n')}\r\n.\r\n`);
        } else if (command === 'RETR') {
          const body = messages[Number(arg) - 1].raw.split('\r\n').map((l) => (l.startsWith('.') ? `.${l}` : l)).join('\r\n');
          socket.write(`+OK\r\n${body}\r\n.\r\n`);
        } else if (command === 'DELE') { state.deleted.push(Number(arg)); socket.write('+OK\r\n'); } else if (command === 'QUIT') { socket.write('+OK\r\n'); socket.end(); }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}
const mailClient = (port) => new Pop3Client({ host: '127.0.0.1', connect: async () => net.connect(port, '127.0.0.1') });

test('the mailbox: naming a document files it, the rest waits, and nothing is read twice', async () => {
  const order = await post('SALES', '/sales-orders', { partyId: refs.mine.id, lines: [{ itemId: refs.m1.id, qtyMilli: 1000, rateMinor: 100 }], milestones: milestone });
  const rawMessages = [
    { uid: 'u1', raw: `From: Buyer <buyer@one.example>\r\nSubject: Re: ${order.docNo} delivery\r\n\r\nWhen will it ship?\r\n.hidden line` },
    { uid: 'u2', raw: 'From: New <new@prospect.example>\r\nSubject: Do you make capsule fillers?\r\n\r\nPlease send details.' },
    { uid: 'u3', raw: 'From: Stranger <x@y.example>\r\nSubject: Re: SO/2020-21/99999 mystery\r\n\r\nNo such document.' },
  ];
  const { server, state, port } = await fakeMailbox(rawMessages);
  try {
    const env = { POP3_USER: 'erp', POP3_PASSWORD: 'right' };
    assert.deepEqual(await readMailbox({ client: mailClient(port), env }), { read: 3, filed: 1 });
    assert.deepEqual(state.logins, ['erp']);
    assert.deepEqual(state.deleted, [], 'mail stays unless asked to delete');

    const comments = await ok('SALES', 'GET', `/comments?entityType=salesOrders&entityId=${order.id}`);
    assert.equal(comments.length, 1);
    assert.match(comments[0].body, /When will it ship\?/);
    assert.match(comments[0].body, /\.hidden line/, 'a line starting with a dot survives');

    const inbox = await ok('SERVICE', 'GET', '/d/InboundEmail?limit=50');
    assert.equal(inbox.length, 3);
    assert.equal(inbox.find((m) => m.uid === 'u1').state, 'FILED');
    assert.equal(inbox.find((m) => m.uid === 'u3').state, 'NEW', 'an unknown number is not guessed at');

    assert.deepEqual(await readMailbox({ client: mailClient(port), env }), { read: 0, filed: 0 });
    assert.equal((await ok('SERVICE', 'GET', '/d/InboundEmail?limit=50')).length, 3);

    await readMailbox({ client: mailClient(port), env: { ...env, POP3_DELETE: 'true' } });
    assert.deepEqual(state.deleted, [1, 2, 3]);

    const prospect = inbox.find((m) => m.uid === 'u2');
    const lead = await ok('SALES', 'POST', `/d/InboundEmail/${prospect.id}/a/makeLead`, {});
    assert.deepEqual([lead.email, lead.leadName], ['new@prospect.example', 'New']);
    await refused('SALES', 'POST', `/d/InboundEmail/${prospect.id}/a/makeLead`, {}, 'ACTION_NOT_AVAILABLE', 422);
    const issue = await ok('SERVICE', 'POST', `/d/InboundEmail/${inbox.find((m) => m.uid === 'u3').id}/a/makeIssue`, {});
    assert.match(issue.description, /No such document/);

    await assert.rejects(readMailbox({ client: mailClient(port), env: { POP3_USER: 'erp', POP3_PASSWORD: 'wrong' } }), /wrong password/);
  } finally {
    server.close();
  }
  assert.deepEqual(await readMailbox({ env: {} }), { skipped: 'No mailbox is set up.' });
});

/* ---------- SMS and exchange rates ---------- */

test('SMS waits without a provider, sends with one, and gives up after five tries', async () => {
  await refused('ADMIN', 'POST', '/d/SmsMessage', { toNumber: '12', body: 'x' }, 'BAD_PHONE', 422);
  const blast = await ok('ADMIN', 'POST', '/d/SmsCenter', { title: 'Offer', audience: 'ALL_CUSTOMERS', body: 'Hello' });
  const queued = await ok('ADMIN', 'POST', `/d/SmsCenter/${blast.id}/a/send`, {});
  assert.deepEqual([queued.queued, queued.skipped], [1, 1], 'one customer has no real number');
  assert.equal(await flushSms({ env: {} }), 0);
  const [waiting] = await ok('ADMIN', 'GET', '/d/SmsMessage');
  assert.equal(waiting.status, 'NOT_CONFIGURED');

  const sentTo = [];
  const env = { SMS_URL: 'https://sms.example/send', SMS_TOKEN: 'token-1' };
  const fails = async () => ({ ok: false, status: 500 });
  assert.equal(await flushSms({ env, fetchFn: fails }), 0);
  assert.equal((await ok('ADMIN', 'GET', `/d/SmsMessage/${waiting.id}`)).status, 'QUEUED');
  assert.equal(await flushSms({ env, fetchFn: async (url, options) => { sentTo.push({ url, ...JSON.parse(options.body), auth: options.headers.authorization }); return { ok: true }; } }), 1);
  assert.deepEqual(sentTo, [{ url: 'https://sms.example/send', to: '9876543210', message: 'Hello', auth: 'Bearer token-1' }]);
  assert.equal((await ok('ADMIN', 'GET', `/d/SmsMessage/${waiting.id}`)).status, 'SENT');

  const one = await ok('ADMIN', 'POST', '/d/SmsMessage', { toNumber: '+91 98765 43210', body: 'Doomed' });
  assert.equal(one.toNumber, '+919876543210');
  for (let i = 0; i < 6; i += 1) await flushSms({ env, fetchFn: fails });
  const dead = await ok('ADMIN', 'GET', `/d/SmsMessage/${one.id}`);
  assert.deepEqual([dead.status, dead.attempts], ['FAILED', 5]);
});

test('exchange rates are saved once a day as a guide, and a bad answer changes nothing', async () => {
  assert.deepEqual(await fetchExchangeRates({ env: {} }), { skipped: 'No exchange rate address is set up.' });
  await ok('ADMIN', 'POST', '/d/Currency', { code: 'USD', name: 'US dollar', isActive: true });
  await ok('ADMIN', 'POST', '/d/Currency', { code: 'EUR', name: 'Euro', isActive: true });
  const env = { FX_RATE_URL: 'https://rates.example/latest' };
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(url);
    if (url.includes('base=EUR')) return { ok: true, json: async () => ({ rates: {} }) };
    return { ok: true, json: async () => ({ rates: { INR: 83.12345 } }) };
  };
  const first = await fetchExchangeRates({ env, fetchFn });
  assert.equal(first.saved, 1);
  assert.match(first.problems[0], /EUR: gave no rate/);
  assert.ok(urls.includes('https://rates.example/latest?base=USD&symbols=INR'));
  const rate = await ok('SALES', 'GET', '/views/fx-rate?currency=USD');
  assert.deepEqual([rate.rateFx4, rate.onDate], [831235, today]);
  assert.equal((await fetchExchangeRates({ env, fetchFn })).saved, 0, 'once a day');
  assert.equal(await ok('SALES', 'GET', '/views/fx-rate?currency=EUR'), null);
});

/* ---------- Bank statements ---------- */

test('statement dates are read day first, and nonsense is not', () => {
  assert.equal(statementDate('03/04/2026'), '2026-04-03');
  assert.equal(statementDate('3-4-26'), '2026-04-03');
  assert.equal(statementDate('03 Apr 2026'), '2026-04-03');
  assert.equal(statementDate('03-April-26'), '2026-04-03');
  assert.equal(statementDate('2026-04-03'), '2026-04-03');
  assert.equal(statementDate('31/02/2026'), null);
  assert.equal(statementDate('Closing balance'), null);
});

test('a bank statement loads once, matches only what is certain, and drafts journals for review', async () => {
  const bank = await ok('ACCOUNTS', 'POST', '/d/BankAccount', { name: 'Main', accountCode: A.BANK });
  const stamp = (d) => `${d.slice(8)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
  const receipt = await post('ACCOUNTS', '/payments', { kind: 'RECEIPT', partyId: refs.mine.id, bankAccountCode: A.BANK, amountMinor: 1234500 });
  const twinA = await post('ACCOUNTS', '/payments', { kind: 'RECEIPT', partyId: refs.mine.id, bankAccountCode: A.BANK, amountMinor: 700000 });
  const twinB = await post('ACCOUNTS', '/payments', { kind: 'RECEIPT', partyId: refs.mine.id, bankAccountCode: A.BANK, amountMinor: 700000 });
  const named = await post('ACCOUNTS', '/payments', { kind: 'RECEIPT', partyId: refs.mine.id, bankAccountCode: A.BANK, amountMinor: 900000 });
  await post('ACCOUNTS', '/payments', { kind: 'RECEIPT', partyId: refs.mine.id, bankAccountCode: A.BANK, amountMinor: 900000 });

  const csv = [
    'Main bank statement',
    'Account: 12345',
    '',
    'Txn Date,Narration,Ref No,Debit,Credit',
    `${stamp(today)},NEFT from customer,UTR1,,"12,345.00"`,
    `${stamp(today)},Cheque one,CHQ1,,"7,000.00"`,
    `${stamp(today)},Cheque two,CHQ2,,"7,000.00"`,
    `${stamp(today)},Payment ${named.docNo},UTR3,,"9,000.00"`,
    `${stamp(today)},BANK CHARGES for month,CHG,250.00,`,
    `${stamp(today)},BANK CHARGES for month,CHG,250.00,`,
    'Closing balance,,,,',
  ].join('\n');
  const job = await ok('ACCOUNTS', 'POST', '/d/BankStatementImport', { bankAccountId: bank.id, dateColumn: 'Txn Date', descriptionColumn: 'Narration', referenceColumn: 'Ref No', withdrawalColumn: 'Debit', depositColumn: 'Credit' });
  const loaded = await ok('ACCOUNTS', 'POST', `/d/BankStatementImport/${job.id}/a/load`, { csv });
  assert.deepEqual([loaded.loaded, loaded.duplicates], [6, 0], 'two identical lines in one file are both real');
  const reloaded = await ok('ACCOUNTS', 'POST', `/d/BankStatementImport/${job.id}/a/load`, { csv });
  assert.deepEqual([reloaded.loaded, reloaded.duplicates], [6, 6], 'the same file again adds nothing');
  await refused('ACCOUNTS', 'POST', `/d/BankStatementImport/${job.id}/a/load`, { csv: 'a,b\n1,2' }, 'BAD_COLUMNS', 422);
  await refused('ACCOUNTS', 'POST', `/d/BankStatementImport/${job.id}/a/load`, { csv: 'Txn Date,Narration,Ref No,Debit,Credit\nyesterday,x,y,5,' }, 'BAD_DATE', 422);
  await refused('ACCOUNTS', 'POST', `/d/BankStatementImport/${job.id}/a/load`, { csv: `Txn Date,Narration,Ref No,Debit,Credit\n${stamp(today)},x,y,abc,` }, 'BAD_AMOUNT', 422);

  const matched = await ok('ACCOUNTS', 'POST', `/d/BankStatementImport/${job.id}/a/autoMatch`, {});
  assert.equal(matched.matched, 2, 'the unique amount, and the one naming its voucher');
  const lines = await ok('ACCOUNTS', 'GET', `/d/BankTransaction?bankAccountId=${bank.id}&limit=50`);
  const by = (ref) => lines.find((l) => l.reference === ref);
  assert.deepEqual([by('UTR1').state, by('UTR1').voucherNo], ['RECONCILED', receipt.docNo]);
  assert.deepEqual([by('UTR3').state, by('UTR3').voucherNo], ['RECONCILED', named.docNo]);
  assert.equal(by('CHQ1').state, 'UNRECONCILED', 'two vouchers fit, so a person chooses');
  assert.ok(twinA.docNo && twinB.docNo);

  await ok('ACCOUNTS', 'POST', '/d/BankTransactionRule', { name: 'Bank charges', descriptionContains: 'bank charges', accountCode: A.EXPENSES });
  await ok('ACCOUNTS', 'POST', '/d/BankTransactionRule', { name: 'Control', descriptionContains: 'cheque', accountCode: A.DEBTORS });
  const bankBefore = await gl(A.BANK);
  const drafted = await ok('ACCOUNTS', 'POST', `/d/BankStatementImport/${job.id}/a/draftJournals`, {});
  assert.equal(drafted.journalsDrafted, 2, 'charges only, as a journal cannot touch debtors');
  assert.equal(await gl(A.BANK), bankBefore, 'a draft posts nothing');
  const journals = await ok('ACCOUNTS', 'GET', '/journals?status=DRAFT');
  assert.equal(journals.length, 2);
  assert.equal(journals[0].totalPaise, 25000);
  await ok('ACCOUNTS', 'POST', `/journals/${journals[0].id}/submit`, {});
  assert.equal(await gl(A.BANK), bankBefore - 25000);
  const redraft = await ok('ACCOUNTS', 'POST', `/d/BankStatementImport/${job.id}/a/draftJournals`, {});
  assert.equal(redraft.journalsDrafted, 2, 'not drafted twice');
  await booksAreClean('bank statements');
});

/* ---------- Payment links ---------- */

test('payment links: only a signed event moves money, once, and for the right amount', async () => {
  const invoice = await post('ACCOUNTS', '/sales-invoices', { partyId: refs.mine.id, lines: [{ kind: 'SERVICE', itemId: refs.m1.id, qtyMilli: 1000, rateMinor: 100000, gstRateBps: 0 }] });
  const request = await ok('ACCOUNTS', 'POST', '/d/PaymentRequest', { partyId: refs.mine.id, salesInvoiceId: invoice.id, amountPaise: 100000, email: 'buyer@one.example' });
  await refused('ACCOUNTS', 'POST', `/d/PaymentRequest/${request.id}/a/makeLink`, {}, 'GATEWAY_NOT_CONFIGURED', 422);

  const realFetch = globalThis.fetch;
  const saved = { ...process.env };
  process.env.RAZORPAY_KEY_ID = 'key_1';
  process.env.RAZORPAY_KEY_SECRET = 'secret_1';
  process.env.RAZORPAY_WEBHOOK_SECRET = 'hook_secret';
  const sentToRazorpay = [];
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith('https://api.razorpay.com')) return realFetch(url, options);
    sentToRazorpay.push({ url, auth: options.headers.authorization, body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ id: 'plink_123', short_url: 'https://rzp.io/i/abc' }) };
  };
  try {
    const linked = await ok('ACCOUNTS', 'POST', `/d/PaymentRequest/${request.id}/a/makeLink`, {});
    assert.deepEqual([linked.gatewayLinkId, linked.gatewayUrl], ['plink_123', 'https://rzp.io/i/abc']);
    assert.equal(sentToRazorpay[0].url, 'https://api.razorpay.com/v1/payment_links');
    assert.equal(sentToRazorpay[0].auth, `Basic ${Buffer.from('key_1:secret_1').toString('base64')}`);
    assert.deepEqual([sentToRazorpay[0].body.amount, sentToRazorpay[0].body.currency], [100000, 'INR']);
    await refused('ACCOUNTS', 'POST', `/d/PaymentRequest/${request.id}/a/makeLink`, {}, 'ACTION_NOT_AVAILABLE', 422);

    const event = (amount) => ({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: 'plink_123', amount_paid: amount } }, payment: { entity: { id: 'pay_9' } } } });
    const sign = (body) => createHmac('sha256', 'hook_secret').update(JSON.stringify(body)).digest('hex');
    const send = (body, signature) => call(null, 'POST', '/public/webhooks/razorpay', body, { 'x-razorpay-signature': signature });
    const paid = event(100000);
    const bank = await gl(A.BANK);

    assert.equal((await send(paid, 'bad')).status, 401);
    assert.equal((await send(paid, createHmac('sha256', 'wrong').update(JSON.stringify(paid)).digest('hex'))).status, 401);
    assert.equal((await call(null, 'POST', '/public/webhooks/razorpay', paid)).status, 401);
    assert.equal(await gl(A.BANK), bank, 'nothing moved without a good signature');

    const short = event(99999);
    assert.equal((await send(short, sign(short))).body.error.code, 'GATEWAY_AMOUNT_MISMATCH');
    assert.equal(await gl(A.BANK), bank);

    const other = { event: 'payment_link.expired', payload: {} };
    assert.deepEqual((await send(other, sign(other))).body.data, { ignored: true });

    const accepted = await send(paid, sign(paid));
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.ok(accepted.body.data.paymentId);
    assert.equal(await gl(A.BANK), bank + 100000);
    const after_ = await ok('ACCOUNTS', 'GET', `/d/PaymentRequest/${request.id}`);
    assert.deepEqual([after_.state, after_.gatewayPaymentId], ['PAID', 'pay_9']);
    assert.equal((await ok('ACCOUNTS', 'GET', `/sales-invoices/${invoice.id}`)).paidPaise, 100000);

    // Razorpay can deliver the same event again.
    assert.deepEqual((await send(paid, sign(paid))).body.data, { alreadyDone: true });
    assert.equal(await gl(A.BANK), bank + 100000);
    await booksAreClean('payment links');
  } finally {
    globalThis.fetch = realFetch;
    for (const key of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

/* ---------- Backups and tools ---------- */

test('a backup copies to a second place and checks the copy, and failure is reported, not hidden', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-copy-'));
  const blocker = path.join(dir, 'a-file');
  await fs.writeFile(blocker, 'x');
  const saved = process.env.BACKUP_COPY_DIR;
  try {
    process.env.BACKUP_COPY_DIR = path.join(dir, 'copies');
    const good = await ok('ADMIN', 'POST', '/views/backups');
    assert.equal(good.copiedTo, process.env.BACKUP_COPY_DIR);
    const files = await fs.readdir(process.env.BACKUP_COPY_DIR);
    assert.deepEqual(files.sort(), [`${good.name}.json`, `${good.name}.jsonl.gz`]);

    process.env.BACKUP_COPY_DIR = path.join(blocker, 'cannot-be-here');
    const bad = await ok('ADMIN', 'POST', '/views/backups');
    assert.equal(bad.copiedTo, null);
    assert.ok(bad.copyError);
    assert.ok(bad.name, 'the backup itself still happened');
  } finally {
    if (saved === undefined) delete process.env.BACKUP_COPY_DIR;
    else process.env.BACKUP_COPY_DIR = saved;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('renaming a code keeps old documents as they were, and the ledger finder balances', async () => {
  const order = await post('SALES', '/sales-orders', { partyId: refs.mine.id, lines: [{ itemId: refs.hidden.id, qtyMilli: 1000, rateMinor: 100 }], milestones: milestone });
  const tool = await ok('ADMIN', 'POST', '/d/RenameTool', { target: 'ITEM', oldCode: 'HIDDEN', newCode: 'M1' });
  await refused('ADMIN', 'POST', `/d/RenameTool/${tool.id}/a/rename`, {}, 'DUPLICATE', 422);
  const missing = await ok('ADMIN', 'POST', '/d/RenameTool', { target: 'PARTY', oldCode: 'NOPE', newCode: 'NEW' });
  await refused('ADMIN', 'POST', `/d/RenameTool/${missing.id}/a/rename`, {}, 'LINK_NOT_FOUND', 422);
  const right = await ok('ADMIN', 'POST', '/d/RenameTool', { target: 'ITEM', oldCode: 'hidden', newCode: 'renamed-1' });
  assert.equal((await ok('ADMIN', 'POST', `/d/RenameTool/${right.id}/a/rename`, {})).isDone, true);
  assert.equal((await ok('ADMIN', 'GET', `/items/${refs.hidden.id}`)).code, 'RENAMED-1');
  assert.equal((await ok('SALES', 'GET', `/sales-orders/${order.id}`)).lines[0].itemCode, 'HIDDEN');

  const days = await ok('ACCOUNTS', 'GET', '/r/ledger-by-day');
  assert.ok(days.rows.length > 0);
  assert.ok(days.rows.every((r) => r.differencePaise === 0), 'every day balances');
  assert.equal(days.totals.debitPaise, days.totals.creditPaise);
  await booksAreClean('everything in this file');
});
