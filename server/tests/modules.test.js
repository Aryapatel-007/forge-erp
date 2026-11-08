// Every module that moves money or stock, with amounts worked out by hand.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { booksAreClean, call, ok, post, refused, startApi, stopApi } from './helpers/http.js';
import { A } from '../config/accounts.js';
import { GlEntry } from '../models/index.js';
import { reportsMeta, runReport } from '../engine/reports.js';
import { runJobNow, listJobs } from '../engine/scheduler.js';
import { depreciationPlan } from '../doctypes/assets.js';
import { annualTax } from '../doctypes/payroll.js';
import { addDays, addMonths, todayIst } from '../utils/dates.js';
import { sumInts } from '../utils/money.js';

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

before(async () => {
  await startApi();
  await ok('ADMIN', 'PATCH', '/admin/settings', { stateCode: '24', lutNumber: 'LUT-1', labourRatePaise: 50000 });
  for (const [key, row] of Object.entries({
    stores: { code: 'STORES', name: 'Stores', kind: 'STORES' },
    hold: { code: 'HOLD', name: 'Hold', kind: 'QUARANTINE' },
    reject: { code: 'REJECT', name: 'Reject', kind: 'REJECT' },
    jw: { code: 'JW', name: 'Job work', kind: 'JOBWORK' },
    fg: { code: 'FG', name: 'Finished', kind: 'FG' },
  })) refs[key] = await ok('ADMIN', 'POST', '/warehouses', row);
  for (const [key, row] of Object.entries({
    customer: { code: 'C1', name: 'Local Customer', isCustomer: true, stateCode: '24', gstin: '24AAACD1234E1ZF' },
    foreign: { code: 'C2', name: 'Foreign Customer', isCustomer: true, isExport: true, currency: 'USD' },
    supplier: { code: 'S1', name: 'Local Supplier', isSupplier: true, stateCode: '24' },
    other: { code: 'S2', name: 'Other Supplier', isSupplier: true, stateCode: '24' },
  })) refs[key] = await ok('ADMIN', 'POST', '/parties', row);
  for (const [key, row] of Object.entries({
    bolt: { code: 'BOLT', name: 'Bolt', type: 'RAW', hsn: '7318', gstRateBps: 1800 },
    plate: { code: 'PLATE', name: 'Plate', type: 'RAW', hsn: '7219', gstRateBps: 1800 },
    widget: { code: 'WIDGET', name: 'Widget', type: 'SPARE', hsn: '8422', gstRateBps: 1800, salePricePaise: 100000 },
    cover: { code: 'COVER', name: 'Machine cover', type: 'ASSEMBLY', hsn: '8422', gstRateBps: 1800 },
    amc: { code: 'AMC', name: 'AMC service', type: 'SERVICE', hsn: '998719', gstRateBps: 1800 },
  })) refs[key] = await ok('ADMIN', 'POST', '/items', row);
  refs.fy = await ok('ADMIN', 'POST', '/d/FiscalYear', { name: 'FY now', startDate: `${today.slice(0, 4)}-01-01`, endDate: `${today.slice(0, 4)}-12-31` });
});
after(stopApi);

test('pricing: item price, price list, customer price, and the best rule on top', async () => {
  const url = (partyId, qty = 1000) => `/pricing/quote?itemId=${refs.widget.id}${partyId ? `&partyId=${partyId}` : ''}&qtyMilli=${qty}`;
  assert.equal((await ok('SALES', 'GET', url())).ratePaise, 100000);

  const list = await ok('SALES', 'POST', '/d/PriceList', { name: 'Standard' });
  await ok('SALES', 'POST', '/d/ItemPrice', { itemId: refs.widget.id, priceListId: list.id, ratePaise: 90000 });
  assert.equal((await ok('SALES', 'GET', url())).source, 'PRICE_LIST');
  await ok('SALES', 'POST', '/d/ItemPrice', { itemId: refs.widget.id, priceListId: list.id, ratePaise: 80000, partyId: refs.customer.id });
  const forCustomer = await ok('SALES', 'GET', url(refs.customer.id));
  assert.deepEqual([forCustomer.ratePaise, forCustomer.source], [80000, 'PARTY_PRICE']);

  await ok('SALES', 'POST', '/d/PricingRule', { title: 'Bulk 10%', kind: 'DISCOUNT_PERCENT', discountBps: 1000, itemId: refs.widget.id, minQtyMilli: 10000 });
  assert.equal((await ok('SALES', 'GET', url(refs.customer.id, 9000))).ratePaise, 80000, 'below the minimum quantity');
  const bulk = await ok('SALES', 'GET', url(refs.customer.id, 10000));
  assert.deepEqual([bulk.ratePaise, bulk.ruleTitle], [72000, 'Bulk 10%']);

  await ok('SALES', 'POST', '/d/PricingRule', { title: 'Expired', kind: 'FIXED_RATE', ratePaise: 1, itemId: refs.widget.id, priority: 9, validUpto: addDays(today, -1) });
  assert.equal((await ok('SALES', 'GET', url(refs.customer.id, 10000))).ruleTitle, 'Bulk 10%', 'an expired rule does not apply');
  await ok('SALES', 'POST', '/d/PricingRule', { title: 'Top', kind: 'FIXED_RATE', ratePaise: 50000, itemId: refs.widget.id, priority: 5 });
  assert.equal((await ok('SALES', 'GET', url(refs.customer.id, 10000))).ratePaise, 50000, 'the highest priority wins');
});

test('material request to purchase order, and RFQ to supplier quote to order', async () => {
  const request = await post('PURCHASE', '/d/MaterialRequest', { purpose: 'PURCHASE', requiredBy: today, lines: [{ itemId: refs.bolt.id, qtyMilli: 5000, ratePaise: 1000 }] });
  await refused('PURCHASE', 'POST', `/d/MaterialRequest/${request.id}/a/makePo`, {}, 'VALIDATION_FAILED', 400);
  const po = await ok('PURCHASE', 'POST', `/d/MaterialRequest/${request.id}/a/makePo`, { partyId: refs.supplier.id });
  assert.equal(po.status, 'DRAFT');
  assert.equal(po.lines[0].qtyMilli, 5000);
  await refused('PURCHASE', 'POST', `/d/MaterialRequest/${request.id}/a/makePo`, { partyId: refs.supplier.id }, 'ACTION_NOT_AVAILABLE', 422);

  const rfq = await post('PURCHASE', '/d/RequestForQuotation', { replyBy: today, lines: [{ itemId: refs.plate.id, qtyMilli: 1000 }], suppliers: [{ partyId: refs.supplier.id }, { partyId: refs.other.id }] });
  const a = await post('PURCHASE', '/d/SupplierQuotation', { partyId: refs.supplier.id, rfqId: rfq.id, lines: [{ itemId: refs.plate.id, qtyMilli: 1000, ratePaise: 5000 }] });
  await post('PURCHASE', '/d/SupplierQuotation', { partyId: refs.other.id, rfqId: rfq.id, lines: [{ itemId: refs.plate.id, qtyMilli: 1000, ratePaise: 4000 }] });
  assert.equal(a.totalPaise, 5000);
  assert.equal((await ok('PURCHASE', 'GET', `/d/RequestForQuotation/${rfq.id}`)).suppliers.every((s) => s.hasReplied), true);
  const comparison = await ok('PURCHASE', 'GET', `/r/quotation-comparison?rfqId=${rfq.id}`);
  assert.equal(comparison.rows.find((r) => r.isLowest).ratePaise, 4000);
  const fromQuote = await ok('PURCHASE', 'POST', `/d/SupplierQuotation/${a.id}/a/makePo`, {});
  assert.equal(fromQuote.partyName, 'Local Supplier');
});

test('supplier scorecard is worked out from real receipts', async () => {
  const po = await post('PURCHASE', '/purchase-orders', { partyId: refs.other.id, expectedDate: today, lines: [{ itemId: refs.bolt.id, qtyMilli: 10000, ratePaise: 1000 }] });
  await post('STORES', '/grns', { purchaseOrderId: po.id, lines: [{ poLineId: po.lines[0].id, qtyMilli: 10000 }] });
  const card = await ok('PURCHASE', 'POST', '/d/SupplierScorecard', { partyId: refs.other.id, fromDate: addDays(today, -1), toDate: today });
  const scored = await ok('PURCHASE', 'POST', `/d/SupplierScorecard/${card.id}/a/evaluate`, {});
  assert.deepEqual([scored.onTimeBps, scored.acceptedBps, scored.scoreBps, scored.standing], [10000, 10000, 10000, 'EXCELLENT']);
  await booksAreClean('the scorecard');
});

test('delivery note then invoice: goods leave once, cost books once, over-billing refused', async () => {
  await opening([{ itemId: refs.widget.id, qtyMilli: 20000, toWarehouseId: refs.stores.id, ratePaise: 30000 }]);
  const cogsBefore = await gl(A.COGS);
  const note = await post('STORES', '/d/DeliveryNote', { partyId: refs.customer.id, lines: [{ itemId: refs.widget.id, qtyMilli: 4000 }] });
  assert.equal(note.totalCostPaise, 120000);
  assert.equal((await bucket(refs.widget.id)).qty, 16000);
  assert.equal(await gl(A.COGS), cogsBefore + 120000);

  const invoice = await ok('ACCOUNTS', 'POST', '/sales-invoices', { partyId: refs.customer.id, lines: [{ kind: 'GOODS', itemId: refs.widget.id, qtyMilli: 4000, rateMinor: 100000, deliveryNoteId: note.id }] });
  const posted = await ok('ACCOUNTS', 'POST', `/sales-invoices/${invoice.id}/submit`, {});
  assert.equal((await bucket(refs.widget.id)).qty, 16000, 'the invoice does not take the stock a second time');
  assert.equal(await gl(A.COGS), cogsBefore + 120000, 'nor its cost');
  assert.equal(posted.costPaise, 0);
  assert.equal((await ok('STORES', 'GET', `/d/DeliveryNote/${note.id}`)).isBilled, true);
  await refused('STORES', 'POST', `/d/DeliveryNote/${note.id}/cancel`, { reason: 'x' }, 'DELIVERY_BILLED', 422);

  const twice = await ok('ACCOUNTS', 'POST', '/sales-invoices', { partyId: refs.customer.id, lines: [{ kind: 'GOODS', itemId: refs.widget.id, qtyMilli: 1000, rateMinor: 100000, deliveryNoteId: note.id }] });
  await refused('ACCOUNTS', 'POST', `/sales-invoices/${twice.id}/submit`, {}, 'OVER_BILLED', 422);
  await ok('ACCOUNTS', 'DELETE', `/sales-invoices/${twice.id}`);
  await ok('ACCOUNTS', 'POST', `/sales-invoices/${invoice.id}/cancel`, { reason: 'Wrong' });
  assert.equal((await ok('STORES', 'GET', `/d/DeliveryNote/${note.id}`)).isBilled, false, 'cancelling the invoice frees the delivery');
  await ok('STORES', 'POST', `/d/DeliveryNote/${note.id}/cancel`, { reason: 'Came back' });
  assert.deepEqual(await bucket(refs.widget.id), { qty: 20000, value: 600000 });
  await booksAreClean('delivery notes');
});

test('credit limit and hold', async () => {
  const party = await ok('ADMIN', 'POST', '/parties', { code: 'C9', name: 'Limited', isCustomer: true, stateCode: '24', creditLimitPaise: 100000 });
  const small = await post('ACCOUNTS', '/sales-invoices', { partyId: party.id, lines: [{ kind: 'SERVICE', itemId: refs.amc.id, qtyMilli: 1000, rateMinor: 50000 }] });
  assert.equal(small.totalPaise, 59000);
  const big = await ok('ACCOUNTS', 'POST', '/sales-invoices', { partyId: party.id, lines: [{ kind: 'SERVICE', itemId: refs.amc.id, qtyMilli: 1000, rateMinor: 50000 }] });
  await refused('ACCOUNTS', 'POST', `/sales-invoices/${big.id}/submit`, {}, 'CREDIT_LIMIT_EXCEEDED', 422);
  await refused('ACCOUNTS', 'POST', `/sales-invoices/${big.id}/submit`, { creditOverrideReason: 'Please' }, 'FORBIDDEN', 403);
  const allowed = await ok('MANAGEMENT', 'POST', `/sales-invoices/${big.id}/submit`, { creditOverrideReason: 'Long-standing customer' });
  assert.equal(allowed.status, 'SUBMITTED');
  await ok('ADMIN', 'PATCH', `/parties/${party.id}`, { isOnHold: true });
  const held = await ok('ACCOUNTS', 'POST', '/sales-invoices', { partyId: party.id, lines: [{ kind: 'SERVICE', itemId: refs.amc.id, qtyMilli: 1000, rateMinor: 100 }] });
  await refused('ACCOUNTS', 'POST', `/sales-invoices/${held.id}/submit`, {}, 'PARTY_ON_HOLD', 422);
  await ok('ACCOUNTS', 'DELETE', `/sales-invoices/${held.id}`);
});

test('stock count: gains and losses post to adjustment, at the right cost', async () => {
  await opening([{ itemId: refs.plate.id, qtyMilli: 10000, toWarehouseId: refs.stores.id, ratePaise: 20000 }]);
  const before = await gl(A.INVENTORY);
  const short = await post('STORES', '/d/StockReconciliation', { reason: 'Year-end count', lines: [{ itemId: refs.plate.id, warehouseId: refs.stores.id, countedMilli: 7000 }] });
  assert.equal(short.differencePaise, -60000);
  assert.equal(short.lines[0].bookMilli, 10000);
  assert.equal(await gl(A.INVENTORY), before - 60000);
  const over = await post('STORES', '/d/StockReconciliation', { reason: 'Found some', lines: [{ itemId: refs.plate.id, warehouseId: refs.stores.id, countedMilli: 8000 }] });
  assert.equal(over.differencePaise, 20000, 'at the current average when no rate is given');
  const same = await post('STORES', '/d/StockReconciliation', { reason: 'Same', lines: [{ itemId: refs.plate.id, warehouseId: refs.stores.id, countedMilli: 8000 }] });
  assert.equal(same.differencePaise, 0);
  await refused('STORES', 'POST', `/d/StockReconciliation/${(await ok('STORES', 'POST', '/d/StockReconciliation', { lines: [{ itemId: refs.plate.id, warehouseId: refs.hold.id, countedMilli: 1 }] })).id}/submit`, {}, 'BAD_WAREHOUSE', 422);
  await ok('STORES', 'POST', `/d/StockReconciliation/${over.id}/cancel`, { reason: 'Miscount' });
  assert.equal((await bucket(refs.plate.id)).qty, 7000);
  await booksAreClean('stock counts');
});

test('landed cost: on hand takes its share, what has left goes to variance, to the paisa', async () => {
  const item = await ok('ADMIN', 'POST', '/items', { code: 'IMPORT', name: 'Imported part', type: 'RAW', gstRateBps: 1800 });
  const other = await ok('ADMIN', 'POST', '/items', { code: 'IMPORT2', name: 'Other part', type: 'RAW', gstRateBps: 1800 });
  const po = await post('PURCHASE', '/purchase-orders', { partyId: refs.supplier.id, lines: [{ itemId: item.id, qtyMilli: 10000, ratePaise: 10000 }, { itemId: other.id, qtyMilli: 10000, ratePaise: 30000 }] });
  const receipt = await post('STORES', '/grns', { purchaseOrderId: po.id, lines: po.lines.map((l) => ({ poLineId: l.id, qtyMilli: l.qtyMilli })) });
  // Half of the first item has already gone.
  await post('STORES', '/stock-moves', { kind: 'ADJUST_OUT', reason: 'Used', lines: [{ itemId: item.id, qtyMilli: 5000, fromWarehouseId: refs.stores.id }] });

  const inventory = await gl(A.INVENTORY);
  const variance = await gl(A.PRICE_VARIANCE);
  const voucher = await post('PURCHASE', '/d/LandedCostVoucher', { grnId: receipt.id, distributeBy: 'VALUE', charges: [{ description: 'Freight', amountPaise: 300000 }, { description: 'Duty', amountPaise: 100001 }] });
  // 4,00,001 paise split 1:3. First item 1,00,000 (half stays, half to variance), second 3,00,001.
  assert.equal(voucher.totalPaise, 400001);
  assert.equal(voucher.capitalisedPaise + voucher.expensedPaise, 400001);
  assert.equal(voucher.expensedPaise, 50000);
  assert.equal((await bucket(other.id)).value, 300000 + 300001);
  assert.equal(await gl(A.INVENTORY), inventory + 350001);
  assert.equal(await gl(A.PRICE_VARIANCE), variance + 50000);
  assert.equal(await gl(A.LANDED_COST_CLEARING), -400001);
  await booksAreClean('landed cost');
  await ok('PURCHASE', 'POST', `/d/LandedCostVoucher/${voucher.id}/cancel`, { reason: 'Wrong receipt' });
  assert.equal(await gl(A.LANDED_COST_CLEARING), 0);
  assert.equal((await bucket(other.id)).value, 300000);
  await booksAreClean('reversing landed cost');
});

test('work order: materials, job card, part finish, full finish, every paisa into stock', async () => {
  await opening([{ itemId: refs.bolt.id, qtyMilli: 100000, toWarehouseId: refs.stores.id, ratePaise: 1000 }]);
  const bom = await ok('ENGINEERING', 'POST', '/boms', { itemId: refs.cover.id, lines: [{ itemId: refs.bolt.id, qtyMilli: 3000 }, { itemId: refs.plate.id, qtyMilli: 1000 }] });
  await refused('PRODUCTION', 'POST', '/d/WorkOrder', { itemId: refs.cover.id, bomId: bom.id, qtyMilli: 2000, targetWarehouseId: refs.stores.id }, 'BOM_NOT_RELEASED', 422);
  await ok('ENGINEERING', 'POST', `/boms/${bom.id}/release`);
  await refused('PRODUCTION', 'POST', '/d/WorkOrder', { itemId: refs.widget.id, bomId: bom.id, qtyMilli: 2000, targetWarehouseId: refs.stores.id }, 'BOM_OTHER_ITEM', 422);

  const station = await ok('PRODUCTION', 'POST', '/d/Workstation', { name: 'Press', hourRatePaise: 60000 });
  const operation = await ok('PRODUCTION', 'POST', '/d/Operation', { name: 'Pressing', workstationId: station.id });
  const routing = await ok('PRODUCTION', 'POST', '/d/Routing', { name: 'Cover route', steps: [{ operationId: operation.id, workstationId: station.id, hoursMilli: 500 }] });

  const order = await post('PRODUCTION', '/d/WorkOrder', { itemId: refs.cover.id, bomId: bom.id, routingId: routing.id, qtyMilli: 3000, targetWarehouseId: refs.stores.id });
  assert.deepEqual(order.materials.map((m) => m.requiredMilli).sort((a, b) => a - b), [3000, 9000]);
  assert.equal(order.operations[0].plannedHoursMilli, 1500);
  assert.equal(order.state, 'NOT_STARTED');
  await refused('PRODUCTION', 'POST', `/d/WorkOrder/${order.id}/a/produce`, { qtyMilli: 1000 }, 'ACTION_NOT_AVAILABLE', 422);

  const issued = await ok('PRODUCTION', 'POST', `/d/WorkOrder/${order.id}/a/issue`, {});
  // 9 bolts at Rs 10 = Rs 90. 3 plates at Rs 200 = Rs 600.
  assert.equal(issued.wipPaise, 69000);
  assert.equal(issued.state, 'IN_PROCESS');
  assert.equal(await gl(A.WIP_WORK_ORDERS), 69000);

  const card = await post('PRODUCTION', '/d/JobCard', { workOrderId: order.id, operationId: operation.id, workstationId: station.id, hoursMilli: 1000 });
  assert.equal(card.valuePaise, 60000, 'one hour at the press rate');
  assert.equal((await ok('PRODUCTION', 'GET', `/d/WorkOrder/${order.id}`)).wipPaise, 129000);

  await refused('PRODUCTION', 'POST', `/d/WorkOrder/${order.id}/a/produce`, { qtyMilli: 3001 }, 'OVER_PRODUCED', 422);
  const before = (await bucket(refs.cover.id)).value;
  const part = await ok('PRODUCTION', 'POST', `/d/WorkOrder/${order.id}/a/produce`, { qtyMilli: 1000 });
  assert.equal(part.producedValuePaise, 43000, 'a third of the cost');
  assert.equal(part.wipPaise, 86000);
  await refused('PRODUCTION', 'POST', `/d/WorkOrder/${order.id}/cancel`, { reason: 'x' }, 'WORK_ORDER_PRODUCED', 422);
  await refused('PRODUCTION', 'POST', `/d/JobCard/${card.id}/cancel`, { reason: 'x' }, 'COST_ALREADY_MOVED', 409);

  const done = await ok('PRODUCTION', 'POST', `/d/WorkOrder/${order.id}/a/produce`, { qtyMilli: 2000 });
  assert.equal(done.state, 'COMPLETED');
  assert.equal(done.wipPaise, 0);
  assert.equal(done.producedValuePaise, 129000);
  assert.equal((await bucket(refs.cover.id)).value, before + 129000);
  assert.equal(await gl(A.WIP_WORK_ORDERS), 0);
  await booksAreClean('the work order');
});

test('MRP: requirements against stock, shortages become a material request', async () => {
  const plan = await ok('PRODUCTION', 'POST', '/d/ProductionPlan', { planDate: today, items: [{ itemId: refs.cover.id, qtyMilli: 100000 }] });
  const planned = await ok('PRODUCTION', 'POST', `/d/ProductionPlan/${plan.id}/a/explode`, {});
  const bolts = planned.requirements.find((r) => r.itemId === refs.bolt.id);
  assert.equal(bolts.requiredMilli, 300000);
  assert.equal(bolts.shortMilli, 300000 - bolts.onHandMilli);
  assert.ok(bolts.shortMilli > 0);
  const request = await ok('PRODUCTION', 'POST', `/d/ProductionPlan/${plan.id}/a/makeRequest`, {});
  assert.equal(request.lines.length, 2);
  assert.equal(request.status, 'DRAFT');
  await refused('PRODUCTION', 'POST', `/d/ProductionPlan/${plan.id}/a/makeRequest`, {}, 'ACTION_NOT_AVAILABLE', 422);
});

test('BOM update tool raises new draft revisions, and leaves released ones alone', async () => {
  const newBolt = await ok('ADMIN', 'POST', '/items', { code: 'BOLT2', name: 'Better bolt', type: 'RAW' });
  const tool = await ok('ENGINEERING', 'POST', '/d/BomUpdateTool', { currentItemId: refs.bolt.id, newItemId: newBolt.id, changeNote: 'New bolt' });
  const done = await ok('ENGINEERING', 'POST', `/d/BomUpdateTool/${tool.id}/a/replace`, {});
  assert.equal(done.revisionsCreated, 1);
  const boms = await ok('ENGINEERING', 'GET', '/boms?itemCode=COVER&limit=10');
  const cover = boms.filter((b) => b.itemCode === 'COVER');
  assert.equal(cover.find((b) => b.status === 'DRAFT').lines.some((l) => l.itemCode === 'BOLT2'), true);
  assert.equal(cover.find((b) => b.status === 'RELEASED').lines.some((l) => l.itemCode === 'BOLT'), true);
});

test('budget: a STOP budget refuses the voucher that goes over it', async () => {
  const center = await ok('ACCOUNTS', 'POST', '/d/CostCenter', { name: 'Marketing' });
  await ok('ACCOUNTS', 'POST', '/d/Budget', { costCenterId: center.id, accountCode: A.RENT, fiscalYearId: refs.fy.id, amountPaise: 100000 });
  const line = (amount) => ({ narration: 'Rent', lines: [{ accountCode: A.RENT, debitPaise: amount, costCenterId: center.id }, { accountCode: A.BANK, creditPaise: amount }] });
  await post('ACCOUNTS', '/journals', line(60000));
  await post('ACCOUNTS', '/journals', line(40000));
  const over = await ok('ACCOUNTS', 'POST', '/journals', line(1));
  await refused('ACCOUNTS', 'POST', `/journals/${over.id}/submit`, undefined, 'BUDGET_EXCEEDED', 422);
  await ok('ACCOUNTS', 'DELETE', `/journals/${over.id}`);
  const report = await ok('ACCOUNTS', 'GET', `/r/budget-variance?fiscalYearId=${refs.fy.id}`);
  assert.deepEqual([report.rows[0].budgetPaise, report.rows[0].actualPaise, report.rows[0].variancePaise], [100000, 100000, 0]);
});

test('bank reconciliation: only a matching voucher ties up, once', async () => {
  const bank = await ok('ACCOUNTS', 'POST', '/d/BankAccount', { name: 'Current account', accountCode: A.BANK });
  const receipt = await post('ACCOUNTS', '/payments', { kind: 'RECEIPT', partyId: refs.customer.id, bankAccountCode: A.BANK, amountMinor: 250000, reference: 'NEFT9' });
  const line = await ok('ACCOUNTS', 'POST', '/d/BankTransaction', { bankAccountId: bank.id, onDate: today, depositPaise: 250000, reference: 'NEFT9' });
  await refused('ACCOUNTS', 'POST', `/d/BankTransaction/${line.id}/a/reconcile`, { voucherNo: 'NOPE' }, 'VOUCHER_NOT_FOUND', 422);
  const wrong = await ok('ACCOUNTS', 'POST', '/d/BankTransaction', { bankAccountId: bank.id, onDate: today, depositPaise: 1, reference: 'X' });
  await refused('ACCOUNTS', 'POST', `/d/BankTransaction/${wrong.id}/a/reconcile`, { voucherNo: receipt.docNo }, 'AMOUNT_MISMATCH', 422);
  const tied = await ok('ACCOUNTS', 'POST', `/d/BankTransaction/${line.id}/a/reconcile`, { voucherNo: receipt.docNo });
  assert.equal(tied.state, 'RECONCILED');
  const same = await ok('ACCOUNTS', 'POST', '/d/BankTransaction', { bankAccountId: bank.id, onDate: today, depositPaise: 250000, reference: 'DUP' });
  await refused('ACCOUNTS', 'POST', `/d/BankTransaction/${same.id}/a/reconcile`, { voucherNo: receipt.docNo }, 'VOUCHER_ALREADY_MATCHED', 409);
  await refused('ACCOUNTS', 'POST', `/d/BankTransaction/${line.id}/a/reconcile`, { voucherNo: receipt.docNo }, 'ACTION_NOT_AVAILABLE', 422);
  const statement = await ok('ACCOUNTS', 'GET', `/r/bank-reconciliation?bankAccountId=${bank.id}`);
  assert.match(statement.rows[3].heading, /not matched \(2\)/);
  await refused('ACCOUNTS', 'GET', '/r/bank-reconciliation', undefined, 'BANK_REQUIRED', 422);
});

test('TDS: threshold, one deduction per invoice, and it reduces what we owe', async () => {
  const category = await ok('ACCOUNTS', 'POST', '/d/TaxWithholdingCategory', { name: '194C', section: '194C', rateBps: 200, singleThresholdPaise: 3000000 });
  const service = (no, rate) => ({ partyId: refs.other.id, supplierInvoiceNo: no, supplierInvoiceDate: today, lines: [{ kind: 'SERVICE', description: 'Contract work', expenseAccountCode: A.EXPENSES, qtyMilli: 1000, ratePaise: rate, gstRateBps: 1800 }] });
  const small = await post('ACCOUNTS', '/purchase-invoices', service('T1', 100000));
  const tds = await ok('ACCOUNTS', 'POST', '/d/TdsDeduction', { purchaseInvoiceId: small.id, categoryId: category.id });
  await refused('ACCOUNTS', 'POST', `/d/TdsDeduction/${tds.id}/submit`, {}, 'UNDER_TDS_THRESHOLD', 422);
  await ok('ACCOUNTS', 'DELETE', `/d/TdsDeduction/${tds.id}`);

  const big = await post('ACCOUNTS', '/purchase-invoices', service('T2', 5000000));
  const posted = await post('ACCOUNTS', '/d/TdsDeduction', { purchaseInvoiceId: big.id, categoryId: category.id });
  assert.equal(posted.tdsPaise, 100000, '2% of Rs 50,000');
  assert.equal(await gl(A.TDS_PAYABLE), -100000);
  assert.equal((await ok('ACCOUNTS', 'GET', `/purchase-invoices/${big.id}`)).creditedPaise, 100000);
  await refused('ACCOUNTS', 'POST', `/d/TdsDeduction/${(await ok('ACCOUNTS', 'POST', '/d/TdsDeduction', { purchaseInvoiceId: big.id, categoryId: category.id })).id}/submit`, {}, 'TDS_ALREADY_DEDUCTED', 409);
  await ok('ACCOUNTS', 'POST', `/d/TdsDeduction/${posted.id}/cancel`, { reason: 'Wrong section' });
  assert.equal((await ok('ACCOUNTS', 'GET', `/purchase-invoices/${big.id}`)).creditedPaise, 0);
  assert.equal(await gl(A.TDS_PAYABLE), 0);
  await booksAreClean('TDS');
});

test('exchange revaluation restates foreign receivables, and cancelling reverses it', async () => {
  const invoice = await post('ACCOUNTS', '/sales-invoices', { partyId: refs.foreign.id, currency: 'USD', fxRate4: 830000, lines: [{ kind: 'SERVICE', itemId: refs.amc.id, qtyMilli: 1000, rateMinor: 100000 }] });
  assert.equal(invoice.totalPaise, 8300000);
  const before = await gl(A.DEBTORS, { partyId: invoice.partyId });
  const reval = await post('ACCOUNTS', '/d/ExchangeRateRevaluation', { currency: 'USD', rateFx4: 850000 });
  assert.equal(reval.gainPaise, 200000, 'USD 1,000 up by Rs 2');
  assert.equal(await gl(A.UNREALISED_FOREX), -200000);
  assert.equal(await gl(A.DEBTORS, { partyId: invoice.partyId }), before + 200000);
  await ok('ACCOUNTS', 'POST', `/d/ExchangeRateRevaluation/${reval.id}/cancel`, { reason: 'New period' });
  assert.equal(await gl(A.UNREALISED_FOREX), 0);
  await refused('ACCOUNTS', 'POST', `/d/ExchangeRateRevaluation/${(await ok('ACCOUNTS', 'POST', '/d/ExchangeRateRevaluation', { currency: 'EUR', rateFx4: 900000 })).id}/submit`, {}, 'NOTHING_TO_REVALUE', 422);
  await booksAreClean('revaluation');
});

test('deferred income releases monthly by job, once each, ending at exactly the total', async () => {
  const start = addMonths(today, -2);
  const doc = await post('ACCOUNTS', '/d/DeferredSchedule', { kind: 'INCOME', sourceAccountCode: A.SALES_SERVICE, amountPaise: 100000, startDate: start, months: 3, reference: 'AMC' });
  assert.equal(sumInts(doc.rows.map((r) => r.amountPaise)), 100000);
  assert.deepEqual(doc.rows.map((r) => r.amountPaise), [33334, 33333, 33333]);
  assert.equal(await gl(A.DEFERRED_INCOME), -100000);
  const { releaseDeferred } = await import('../doctypes/jobs.js');
  assert.equal(await releaseDeferred(today), 3);
  assert.equal(await gl(A.DEFERRED_INCOME), 0);
  assert.equal(await releaseDeferred(today), 0, 'running it again does nothing');
  await refused('ACCOUNTS', 'POST', `/d/DeferredSchedule/${doc.id}/cancel`, { reason: 'x' }, 'ALREADY_RELEASED', 422);
  await booksAreClean('deferred income');
});

test('subscriptions raise a draft invoice when due, and then move on', async () => {
  const plan = await ok('ACCOUNTS', 'POST', '/d/SubscriptionPlan', { name: 'AMC monthly', itemId: refs.amc.id, ratePaise: 500000, intervalMonths: 1 });
  const sub = await ok('ACCOUNTS', 'POST', '/d/Subscription', { partyId: refs.customer.id, planId: plan.id, startDate: today });
  const { raiseSubscriptionInvoices } = await import('../doctypes/jobs.js');
  assert.equal(await raiseSubscriptionInvoices(today), 1);
  assert.equal(await raiseSubscriptionInvoices(today), 0, 'not due again until next month');
  const after = await ok('ACCOUNTS', 'GET', `/d/Subscription/${sub.id}`);
  assert.equal(after.invoicesRaised, 1);
  assert.equal(after.nextInvoiceOn, addMonths(today, 1));
  const invoice = await ok('ACCOUNTS', 'GET', `/sales-invoices/${after.lastInvoiceId}`);
  assert.equal(invoice.status, 'DRAFT');
  assert.equal(invoice.totalPaise, 590000);
});

test('auto repeat makes a fresh draft, and SLA flags a late issue', async () => {
  const source = await ok('SALES', 'POST', '/d/Contract', { title: 'Yearly', partyId: refs.customer.id, startDate: today });
  await ok('ADMIN', 'POST', '/d/AutoRepeat', { name: 'Contract repeat', doctypeName: 'Contract', sourceId: source.id, frequency: 'MONTHLY', startDate: today });
  const { runAutoRepeat, flagSlaBreaches } = await import('../doctypes/jobs.js');
  assert.equal(await runAutoRepeat(today), 1);
  assert.equal(await runAutoRepeat(today), 0);
  assert.equal((await ok('SALES', 'GET', '/d/Contract?q=Yearly')).length, 2, 'the original and one fresh draft');

  const priority = await ok('SERVICE', 'POST', '/d/IssuePriority', { name: 'Urgent' });
  await ok('SERVICE', 'POST', '/d/ServiceLevelAgreement', { name: 'Standard', isDefault: true, priorities: [{ priorityId: priority.id, responseHours: 1, resolutionHours: 4 }] });
  const issue = await ok('SERVICE', 'POST', '/d/Issue', { subject: 'Line down', priorityId: priority.id, partyId: refs.customer.id });
  assert.ok(issue.resolveBy, 'the SLA set its deadline');
  assert.equal(await flagSlaBreaches(new Date()), 0);
  assert.equal(await flagSlaBreaches(new Date(Date.now() + 5 * 3600000)), 1);
  assert.equal((await ok('SERVICE', 'GET', `/d/Issue/${issue.id}`)).isSlaBreached, true);
  assert.equal(await flagSlaBreaches(new Date(Date.now() + 5 * 3600000)), 0);
  await refused('SERVICE', 'PATCH', `/d/Issue/${issue.id}`, { subject: 'Line down', status: 'RESOLVED' }, 'RESOLUTION_REQUIRED', 422);
  const fixed = await ok('SERVICE', 'PATCH', `/d/Issue/${issue.id}`, { subject: 'Line down', status: 'RESOLVED', resolution: 'Reset' });
  assert.ok(fixed.resolvedAt);
});

test('reorder job raises one request for what is short, and not twice', async () => {
  const low = await ok('ADMIN', 'POST', '/items', { code: 'LOW', name: 'Low part', type: 'RAW', reorderLevelMilli: 5000 });
  const { raiseReorders } = await import('../doctypes/jobs.js');
  assert.ok(await raiseReorders() >= 1);
  const open = await ok('PURCHASE', 'GET', '/d/MaterialRequest?status=DRAFT');
  assert.ok(open.some((r) => r.lines.some((l) => l.itemId === low.id && l.qtyMilli === 10000)));
  assert.equal(await raiseReorders(), 0, 'what is on request counts as coming');
});

test('depreciation plans end exactly at salvage, either method', () => {
  const slm = depreciationPlan({ grossPaise: 1000000, salvagePaise: 100001, method: 'STRAIGHT_LINE', lifeMonths: 7, startOn: '2026-01-15' });
  assert.equal(slm.length, 7);
  assert.equal(sumInts(slm.map((r) => r.amountPaise)), 899999);
  assert.equal(slm[0].onDate, '2026-02-15');
  const wdv = depreciationPlan({ grossPaise: 1000000, salvagePaise: 50000, method: 'WRITTEN_DOWN', lifeMonths: 36, wdvRateBps: 2500, startOn: '2026-01-01' });
  assert.equal(sumInts(wdv.map((r) => r.amountPaise)), 950000, 'whatever the rate, it lands on salvage');
  assert.throws(() => depreciationPlan({ grossPaise: 100, salvagePaise: 0, method: 'WRITTEN_DOWN', lifeMonths: 12, startOn: '2026-01-01' }), /needs a rate/);
  assert.deepEqual(depreciationPlan({ grossPaise: 100, salvagePaise: 100, method: 'STRAIGHT_LINE', lifeMonths: 12, startOn: '2026-01-01' }), []);
});

test('asset: capitalise, depreciate by job, sell at a gain, books agree throughout', async () => {
  const category = await ok('ACCOUNTS', 'POST', '/d/AssetCategory', { name: 'Machinery', method: 'STRAIGHT_LINE', lifeMonths: 10 });
  const asset = await post('ACCOUNTS', '/d/Asset', { assetName: 'CNC lathe', categoryId: category.id, purchasedOn: addMonths(today, -3), grossPaise: 1000000, salvagePaise: 0, depreciationStartOn: addMonths(today, -3) });
  assert.equal(asset.state, 'IN_USE');
  assert.equal(asset.schedule.length, 10);
  assert.equal(await gl(A.FIXED_ASSETS), 1000000);
  assert.equal(await gl(A.ASSET_CLEARING), -1000000);

  await runJobNow('depreciation');
  assert.equal(await gl(A.ACCUM_DEPRECIATION), -300000, 'three months at Rs 1,000');
  assert.equal(await gl(A.DEPRECIATION), 300000);
  await runJobNow('depreciation');
  assert.equal(await gl(A.ACCUM_DEPRECIATION), -300000, 'a month posts only once');
  await refused('ACCOUNTS', 'POST', `/d/Asset/${asset.id}/cancel`, { reason: 'x' }, 'ASSET_DEPRECIATED', 422);

  await refused('ACCOUNTS', 'POST', `/d/Asset/${asset.id}/a/sell`, { proceedsPaise: 0, bankAccountCode: A.BANK }, 'PRICE_REQUIRED', 422);
  const sold = await ok('ACCOUNTS', 'POST', `/d/Asset/${asset.id}/a/sell`, { proceedsPaise: 800000, bankAccountCode: A.BANK });
  assert.equal(sold.state, 'SOLD');
  assert.equal(sold.disposalGainPaise, 100000, 'book value Rs 7,000, sold for Rs 8,000');
  assert.equal(await gl(A.FIXED_ASSETS), 0);
  assert.equal(await gl(A.ACCUM_DEPRECIATION), 0);
  assert.equal(await gl(A.ASSET_GAIN), -100000);
  await refused('ACCOUNTS', 'POST', `/d/Asset/${asset.id}/a/scrap`, {}, 'ACTION_NOT_AVAILABLE', 422);
  await runJobNow('depreciation');
  assert.equal(await gl(A.DEPRECIATION), 300000, 'nothing more after it is sold');

  const second = await post('ACCOUNTS', '/d/Asset', { assetName: 'Old press', categoryId: category.id, purchasedOn: today, grossPaise: 200000, depreciationStartOn: today });
  const adjust = await post('ACCOUNTS', '/d/AssetValueAdjustment', { assetId: second.id, onDate: today, differencePaise: -50000, reason: 'Impairment' });
  assert.equal(adjust.differencePaise, -50000);
  assert.equal(await gl(A.ASSET_LOSS), 50000);
  const scrapped = await ok('ACCOUNTS', 'POST', `/d/Asset/${second.id}/a/scrap`, {});
  assert.equal(scrapped.disposalGainPaise, -150000);
  assert.equal(await gl(A.FIXED_ASSETS), 0);
  await booksAreClean('assets');
});

test('POS: till opens once, payment must match, close finds the difference', async () => {
  const profile = await ok('ACCOUNTS', 'POST', '/d/PosProfile', { name: 'Counter', cashAccountCode: A.CASH });
  const { users } = await import('./helpers/http.js');
  const opening_ = await post('ACCOUNTS', '/d/PosOpening', { profileId: profile.id, cashierId: String(users.SALES._id), openingCashPaise: 100000 });
  await refused('ACCOUNTS', 'POST', `/d/PosOpening/${(await ok('ACCOUNTS', 'POST', '/d/PosOpening', { profileId: profile.id, cashierId: String(users.SALES._id) })).id}/submit`, {}, 'TILL_ALREADY_OPEN', 409);
  const line = { itemId: refs.widget.id, qtyMilli: 1000, ratePaise: 99999 };
  const wrong = await ok('ACCOUNTS', 'POST', '/d/PosInvoice', { openingId: opening_.id, customerName: 'Walk-in', cashPaise: 1, lines: [line] });
  // Rs 999.99 + 18% (Rs 180.00) = Rs 1,179.99, rounds up to Rs 1,180.
  assert.equal(wrong.totalPaise, 118000);
  assert.equal(wrong.roundOffPaise, 1);
  await refused('ACCOUNTS', 'POST', `/d/PosInvoice/${wrong.id}/submit`, {}, 'PAYMENT_MISMATCH', 422);
  await ok('ACCOUNTS', 'DELETE', `/d/PosInvoice/${wrong.id}`);
  const stockBefore = (await bucket(refs.widget.id)).qty;
  const sale = await post('ACCOUNTS', '/d/PosInvoice', { openingId: opening_.id, customerName: 'Walk-in', cashPaise: 118000, lines: [line] });
  assert.equal(sale.status, 'SUBMITTED');
  assert.equal((await bucket(refs.widget.id)).qty, stockBefore - 1000);
  await booksAreClean('a counter sale');

  const closing = await post('ACCOUNTS', '/d/PosClosing', { openingId: opening_.id, countedCashPaise: 217000 });
  assert.equal(closing.expectedCashPaise, 218000);
  assert.equal(closing.differencePaise, -1000);
  assert.equal(await gl(A.CASH_DIFFERENCE), 1000);
  await refused('ACCOUNTS', 'POST', `/d/PosInvoice/${sale.id}/cancel`, { reason: 'x' }, 'TILL_CLOSED', 422);
  await refused('ACCOUNTS', 'POST', `/d/PosClosing/${(await ok('ACCOUNTS', 'POST', '/d/PosClosing', { openingId: opening_.id, countedCashPaise: 1 })).id}/submit`, {}, 'TILL_NOT_OPEN', 422);
  await booksAreClean('closing the till');
});

test('attendance and leave: one mark a day, balance enforced, holidays skipped, overlap refused', async () => {
  const holidays = await ok('HR', 'POST', '/d/HolidayList', { name: 'Year list', fromDate: '2026-01-01', toDate: '2026-12-31', weeklyOff: 'NONE', holidays: [{ onDate: addDays(today, -2), description: 'Festival' }] });
  refs.employee = await ok('HR', 'POST', '/d/Employee', { fullName: 'Asha Patel', joiningDate: '2024-01-01', holidayListId: holidays.id });
  const emp = refs.employee.id;
  await ok('HR', 'POST', '/d/Attendance', { employeeId: emp, onDate: addDays(today, -20) });
  await refused('HR', 'POST', '/d/Attendance', { employeeId: emp, onDate: addDays(today, -20) }, 'ATTENDANCE_EXISTS', 409);
  await refused('HR', 'POST', '/d/Attendance', { employeeId: emp, onDate: addDays(today, 5) }, 'FUTURE_DATE', 422);

  const paid = await ok('HR', 'POST', '/d/LeaveType', { name: 'Casual' });
  const period = await ok('HR', 'POST', '/d/LeavePeriod', { name: 'Year', fromDate: `${today.slice(0, 4)}-01-01`, toDate: `${today.slice(0, 4)}-12-31` });
  const ask = (fromDate, toDate, extra = {}) => ({ employeeId: emp, leaveTypeId: paid.id, fromDate, toDate, ...extra });
  await refused('HR', 'POST', `/d/LeaveApplication/${(await ok('HR', 'POST', '/d/LeaveApplication', ask(addDays(today, -3), addDays(today, -3)))).id}/submit`, {}, 'INSUFFICIENT_LEAVE', 422);
  await post('HR', '/d/LeaveAllocation', { employeeId: emp, leaveTypeId: paid.id, periodId: period.id, halfDays: 8 });

  await refused('HR', 'POST', '/d/LeaveApplication', ask(addDays(today, -2), addDays(today, -2)), 'ALL_HOLIDAYS', 422);
  await refused('HR', 'POST', '/d/LeaveApplication', ask(today, addDays(today, -1)), 'BAD_DATE', 422);
  const three = await post('HR', '/d/LeaveApplication', ask(addDays(today, -4), addDays(today, -2)));
  assert.equal(three.halfDays, 4, 'three days less the holiday is two days, four half days');
  const marked = await ok('HR', 'GET', `/d/Attendance?employeeId=${emp}&state=ON_LEAVE`);
  assert.equal(marked.length, 2);
  await refused('HR', 'POST', `/d/LeaveApplication/${(await ok('HR', 'POST', '/d/LeaveApplication', ask(addDays(today, -4), addDays(today, -4)))).id}/submit`, {}, 'LEAVE_OVERLAP', 409);
  const half = await post('HR', '/d/LeaveApplication', ask(addDays(today, -6), addDays(today, -6), { isHalfDay: true }));
  assert.equal(half.halfDays, 1);
  await refused('HR', 'POST', `/d/LeaveApplication/${(await ok('HR', 'POST', '/d/LeaveApplication', ask(addDays(today, -10), addDays(today, -8)))).id}/submit`, {}, 'INSUFFICIENT_LEAVE', 422);
  await ok('HR', 'POST', `/d/LeaveApplication/${three.id}/cancel`, { reason: 'Came to work' });
  assert.equal((await ok('HR', 'GET', `/d/Attendance?employeeId=${emp}&state=ON_LEAVE`)).length, 0, 'cancelling leave clears attendance');
  const balance = await ok('HR', 'GET', `/r/leave-balance?periodId=${period.id}`);
  assert.deepEqual([balance.rows[0].allocatedDaysHalf, balance.rows[0].takenDaysHalf, balance.rows[0].balanceDaysHalf], [8, 1, 7]);
});

test('check-ins become attendance: hours, half days and lateness', async () => {
  const shift = await ok('HR', 'POST', '/d/ShiftType', { name: 'General', startTime: '09:00', endTime: '18:00', graceMinutes: 10 });
  const worker = await ok('HR', 'POST', '/d/Employee', { fullName: 'Late Lal', joiningDate: '2024-01-01', shiftTypeId: shift.id });
  const day = addDays(today, -1);
  await ok('HR', 'POST', '/d/EmployeeCheckin', { employeeId: worker.id, atTime: `${day}T09:30:00+05:30`, logType: 'IN' });
  await ok('HR', 'POST', '/d/EmployeeCheckin', { employeeId: worker.id, atTime: `${day}T12:30:00+05:30`, logType: 'OUT' });
  const { buildAttendance } = await import('../doctypes/jobs.js');
  assert.equal(await buildAttendance(day), 1);
  assert.equal(await buildAttendance(day), 0);
  const [row] = await ok('HR', 'GET', `/d/Attendance?employeeId=${worker.id}`);
  assert.deepEqual([row.state, row.workingHoursMilli, row.lateEntry, row.source], ['HALF_DAY', 3000, true, 'CHECKIN']);
});

test('expenses: advance, claim using it, pay the rest, everything clears to zero', async () => {
  const type = await ok('HR', 'POST', '/d/ExpenseClaimType', { name: 'Travel', accountCode: A.EXPENSES });
  const emp = refs.employee.id;
  const advance = await post('HR', '/d/EmployeeAdvance', { employeeId: emp, amountPaise: 300000, bankAccountCode: A.BANK, purpose: 'Site visit' });
  assert.equal(await gl(A.EMPLOYEE_ADVANCES), 300000);
  await refused('HR', 'POST', '/d/ExpenseClaim', { employeeId: emp, advanceUsedPaise: 999999, lines: [{ typeId: type.id, onDate: today, amountPaise: 1000 }] }, 'ADVANCE_TOO_LARGE', 422);
  const claim = await post('HR', '/d/ExpenseClaim', { employeeId: emp, advanceId: advance.id, advanceUsedPaise: 300000, lines: [{ typeId: type.id, onDate: today, amountPaise: 500000 }] });
  assert.equal(claim.payablePaise, 200000);
  assert.equal(await gl(A.EMPLOYEE_ADVANCES), 0);
  assert.equal(await gl(A.EMPLOYEE_PAYABLE), -200000);
  await refused('HR', 'POST', `/d/EmployeeAdvance/${advance.id}/cancel`, { reason: 'x' }, 'ADVANCE_SETTLED', 422);
  const paid = await ok('HR', 'POST', `/d/ExpenseClaim/${claim.id}/a/pay`, { bankAccountCode: A.BANK });
  assert.equal(paid.paidPaise, 200000);
  assert.equal(await gl(A.EMPLOYEE_PAYABLE), 0);
  await refused('HR', 'POST', `/d/ExpenseClaim/${claim.id}/a/pay`, { bankAccountCode: A.BANK }, 'CLAIM_PAID', 422);
  await refused('HR', 'POST', `/d/ExpenseClaim/${claim.id}/cancel`, { reason: 'x' }, 'CLAIM_PAID', 422);
  await booksAreClean('expenses');
});

test('income tax by slab, with cess and rebate', () => {
  const slab = { standardDeductionPaise: 5000000, cessBps: 400, rebateUptoPaise: 0, slabs: [{ fromPaise: 0, toPaise: 30000000, rateBps: 0 }, { fromPaise: 30000000, toPaise: 60000000, rateBps: 500 }, { fromPaise: 60000000, toPaise: 0, rateBps: 2000 }] };
  // Income Rs 10,00,000 less Rs 50,000 = Rs 9,50,000. 5% of 3L = 15,000, 20% of 3.5L = 70,000. Plus 4% cess.
  assert.equal(annualTax(100000000, slab), 8840000);
  assert.equal(annualTax(30000000, slab), 0, 'below the first slab');
  assert.equal(annualTax(100000000, { ...slab, rebateUptoPaise: 100000000 }), 0, 'fully rebated');
});

test('payroll: exact slip with PF, ESI, PT and TDS, absence proration, and the whole run', async () => {
  const start = addMonths(`${today.slice(0, 7)}-01`, -1);
  const end = addDays(`${today.slice(0, 7)}-01`, -1);
  const days = Number(end.slice(8));
  await ok('HR', 'POST', '/d/PayrollStatutory', { name: 'Rates', professionalTax: [{ fromGrossPaise: 1200000, toGrossPaise: 0, amountPaise: 20000 }] });
  const hra = await ok('HR', 'POST', '/d/SalaryComponent', { name: 'HRA', abbreviation: 'HRA', kind: 'EARNING' });
  const structure = await ok('HR', 'POST', '/d/SalaryStructure', { name: 'Staff', basicBps: 5000, rows: [{ componentId: hra.id, basis: 'PERCENT_OF_BASIC', rateBps: 4000 }] });
  const dept = await ok('HR', 'POST', '/d/Department', { name: 'Payroll test' });
  const person = await ok('HR', 'POST', '/d/Employee', { fullName: 'Salaried Shah', joiningDate: '2024-01-01', departmentId: dept.id });
  const low = await ok('HR', 'POST', '/d/Employee', { fullName: 'Lower Paid', joiningDate: '2024-01-01', departmentId: dept.id });
  await refused('HR', 'POST', '/d/SalarySlip', { employeeId: person.id, startDate: start, endDate: end }, 'NO_SALARY_STRUCTURE', 422);
  await post('HR', '/d/SalaryStructureAssignment', { employeeId: person.id, structureId: structure.id, monthlyCtcPaise: 5000000, fromDate: '2024-01-01' });
  await post('HR', '/d/SalaryStructureAssignment', { employeeId: low.id, structureId: structure.id, monthlyCtcPaise: 2000000, fromDate: '2024-01-01' });

  const slip = await ok('HR', 'POST', '/d/SalarySlip', { employeeId: person.id, startDate: start, endDate: end });
  // CTC Rs 50,000: basic 25,000, HRA 10,000, special 15,000. PF 12% of the Rs 15,000 ceiling = 1,800.
  // Gross over Rs 21,000, so no ESI. PT Rs 200. No tax slab, so no TDS. Net 50,000 - 2,000.
  assert.equal(slip.grossPaise, 5000000);
  assert.deepEqual(slip.earnings.map((e) => [e.name, e.amountPaise]), [['Basic', 2500000], ['HRA', 1000000], ['Special allowance', 1500000]]);
  assert.equal(slip.pfEmployeePaise, 180000);
  assert.equal(slip.esiEmployeePaise, 0);
  assert.equal(slip.professionalTaxPaise, 20000);
  assert.equal(slip.netPaise, 4800000);
  await ok('HR', 'DELETE', `/d/SalarySlip/${slip.id}`);

  const lowSlip = await ok('HR', 'POST', '/d/SalarySlip', { employeeId: low.id, startDate: start, endDate: end });
  // CTC Rs 20,000: under the ESI ceiling, 0.75% = Rs 150. Basic Rs 10,000, PF Rs 1,200. PT Rs 200.
  assert.equal(lowSlip.esiEmployeePaise, 15000);
  assert.equal(lowSlip.pfEmployeePaise, 120000);
  assert.equal(lowSlip.netPaise, 2000000 - 15000 - 120000 - 20000);
  await ok('HR', 'DELETE', `/d/SalarySlip/${lowSlip.id}`);

  // One day absent cuts pay by exactly one day.
  await ok('HR', 'POST', '/d/Attendance', { employeeId: person.id, onDate: start, state: 'ABSENT' });
  const docked = await ok('HR', 'POST', '/d/SalarySlip', { employeeId: person.id, startDate: start, endDate: end });
  const expected = Math.round((5000000 * (days - 1)) / days);
  assert.ok(Math.abs(docked.grossPaise - expected) <= 2, `${docked.grossPaise} against ${expected}`);
  assert.equal(docked.paidHalfDays, (days - 1) * 2);
  await ok('HR', 'DELETE', `/d/SalarySlip/${docked.id}`);

  const run = await ok('HR', 'POST', '/d/PayrollEntry', { startDate: start, endDate: end, departmentId: dept.id });
  const made = await ok('HR', 'POST', `/d/PayrollEntry/${run.id}/a/makeSlips`, {});
  assert.equal(made.slipCount, 2);
  await refused('HR', 'POST', `/d/PayrollEntry/${run.id}/a/makeSlips`, {}, 'ACTION_NOT_AVAILABLE', 422);
  await ok('HR', 'POST', `/d/PayrollEntry/${run.id}/a/postSlips`, {});
  const gross = 5000000 + 2000000 - (5000000 - docked.grossPaise);
  assert.equal(await gl(A.SALARIES), gross);
  assert.ok(await gl(A.PF_PAYABLE) < 0);
  assert.ok(await gl(A.ESI_PAYABLE) < 0);
  assert.equal(await gl(A.PT_PAYABLE), -40000);
  assert.ok(await gl(A.SALARY_PAYABLE) < 0);
  await booksAreClean('posting payroll');

  const dupe = await ok('HR', 'POST', '/d/SalarySlip', { employeeId: person.id, startDate: start, endDate: end });
  await refused('HR', 'POST', `/d/SalarySlip/${dupe.id}/submit`, {}, 'SLIP_EXISTS', 422);
  await ok('HR', 'DELETE', `/d/SalarySlip/${dupe.id}`);

  const paid = await ok('HR', 'POST', `/d/PayrollEntry/${run.id}/a/pay`, { bankAccountCode: A.BANK });
  assert.equal(paid.state, 'PAID');
  assert.equal(await gl(A.SALARY_PAYABLE), 0, 'net pay clears exactly');
  const [paidSlip] = await ok('HR', 'GET', `/d/SalarySlip?employeeId=${low.id}&status=SUBMITTED`);
  await refused('HR', 'POST', `/d/SalarySlip/${paidSlip.id}/cancel`, { reason: 'x' }, 'SLIP_PAID', 422);
  const register = await ok('HR', 'GET', `/r/salary-register?from=${start}&to=${end}`);
  assert.equal(register.rows.length, 2);
  assert.equal(register.totals.grossPaise, gross);
  await refused('STORES', 'GET', '/r/salary-register', undefined, 'FORBIDDEN', 403);
  await booksAreClean('paying salaries');
});

test('projects: progress follows tasks, dependencies hold, timesheet cost adds and reverses', async () => {
  const template = await ok('PRODUCTION', 'POST', '/d/ProjectTemplate', { name: 'Install', tasks: [{ subject: 'Survey', offsetDays: 0, durationDays: 2 }, { subject: 'Commission', offsetDays: 2, durationDays: 3 }] });
  const project = await ok('PRODUCTION', 'POST', '/d/Project', { name: 'Site A', templateId: template.id, startDate: today });
  const tasks = await ok('PRODUCTION', 'GET', `/d/Task?projectId=${project.id}&sort=subject&dir=desc`);
  assert.equal(tasks.length, 2);
  const [survey, commission] = tasks;
  assert.equal(survey.subject, 'Survey');
  const body = (task, extra) => ({ subject: task.subject, projectId: project.id, ...extra });
  await refused('PRODUCTION', 'PATCH', `/d/Task/${commission.id}`, body(commission, { status: 'DONE', dependsOn: [{ taskId: survey.id }] }), 'DEPENDENCY_OPEN', 422);
  await ok('PRODUCTION', 'PATCH', `/d/Task/${survey.id}`, body(survey, { status: 'DONE' }));
  assert.equal((await ok('PRODUCTION', 'GET', `/d/Project/${project.id}`)).progressBps, 5000);
  const emp = refs.employee.id;
  const sheet = await post('PRODUCTION', '/d/Timesheet', { employeeId: emp, projectId: project.id, rows: [{ taskId: survey.id, onDate: today, hoursMilli: 2500, costRatePaise: 40000 }] });
  assert.deepEqual([sheet.totalHoursMilli, sheet.totalCostPaise], [2500, 100000]);
  assert.equal((await ok('PRODUCTION', 'GET', `/d/Project/${project.id}`)).costPaise, 100000);
  assert.equal((await ok('PRODUCTION', 'GET', `/d/Task/${survey.id}`)).actualHoursMilli, 2500);
  await ok('PRODUCTION', 'POST', `/d/Timesheet/${sheet.id}/cancel`, { reason: 'Wrong person' });
  assert.equal((await ok('PRODUCTION', 'GET', `/d/Project/${project.id}`)).costPaise, 0);
});

test('calibration record moves the gauge date; a failed one does not', async () => {
  const gauge = await ok('QUALITY', 'POST', '/gauges', { code: 'CAL1', name: 'Vernier', dueOn: addDays(today, -5) });
  await ok('QUALITY', 'POST', '/d/CalibrationRecord', { gaugeId: gauge.id, calibratedOn: today, dueOn: addDays(today, 365), certificateNo: 'F1', result: 'FAIL' });
  assert.equal((await ok('QUALITY', 'GET', `/gauges/${gauge.id}`)).dueOn, addDays(today, -5));
  await ok('QUALITY', 'POST', '/d/CalibrationRecord', { gaugeId: gauge.id, calibratedOn: today, dueOn: addDays(today, 365), certificateNo: 'C2' });
  const after = await ok('QUALITY', 'GET', `/gauges/${gauge.id}`);
  assert.deepEqual([after.dueOn, after.certRef], [addDays(today, 365), 'C2']);
});

test('item variants are made from an attribute, once', async () => {
  const size = await ok('STORES', 'POST', '/d/ItemAttribute', { name: 'Nozzle size', values: [{ value: '10 mm', abbreviation: '10' }, { value: '20 mm', abbreviation: '20' }] });
  const generator = await ok('STORES', 'POST', '/d/ItemVariantGenerator', { templateItemId: refs.widget.id, attributeId: size.id });
  assert.equal((await ok('STORES', 'POST', `/d/ItemVariantGenerator/${generator.id}/a/generate`, {})).created, 2);
  assert.equal((await ok('STORES', 'POST', `/d/ItemVariantGenerator/${generator.id}/a/generate`, {})).created, 2, 'no duplicates on a second run');
  const items = await ok('STORES', 'GET', '/items?q=WIDGET-');
  assert.deepEqual(items.map((i) => i.code).sort(), ['WIDGET-10', 'WIDGET-20']);
  assert.equal(items[0].variantOfId, refs.widget.id);
});

test('e-invoice and e-way bill files add up, and refuse what is not ready', async () => {
  const invoice = await post('ACCOUNTS', '/sales-invoices', { partyId: refs.customer.id, vehicleNo: 'GJ01AA1111', lines: [{ kind: 'SERVICE', itemId: refs.amc.id, qtyMilli: 1000, rateMinor: 100000 }] });
  await refused('ACCOUNTS', 'GET', `/sales-invoices/${invoice.id}/einvoice.json`, undefined, 'COMPANY_GSTIN_REQUIRED', 422);
  await ok('ADMIN', 'PATCH', '/admin/settings', { gstin: '24AAACD1234E1ZF', legalName: 'Test Co', address: 'Ahmedabad' });
  const json = await ok('ACCOUNTS', 'GET', `/sales-invoices/${invoice.id}/einvoice.json`);
  assert.equal(json.DocDtls.No, invoice.docNo);
  assert.equal(json.ValDtls.AssVal, 1000);
  assert.equal(json.ValDtls.TotInvVal, 1180);
  assert.equal(json.ItemList[0].HsnCd, '998719');
  assert.equal(json.ItemList[0].CgstAmt + json.ItemList[0].SgstAmt, 180);
  const eway = await ok('ACCOUNTS', 'GET', `/sales-invoices/${invoice.id}/eway-bill.json`);
  assert.equal(eway.vehicleNo, 'GJ01AA1111');
  assert.equal(eway.totInvValue, 1180);
  const draft = await ok('ACCOUNTS', 'POST', '/sales-invoices', { partyId: refs.customer.id, lines: [{ kind: 'SERVICE', itemId: refs.amc.id, qtyMilli: 1000, rateMinor: 100 }] });
  await refused('ACCOUNTS', 'GET', `/sales-invoices/${draft.id}/einvoice.json`, undefined, 'INVOICE_NOT_SUBMITTED', 422);
  await refused('STORES', 'GET', `/sales-invoices/${invoice.id}/einvoice.json`, undefined, 'FORBIDDEN', 403);
});

test('asset capitalisation moves stock into the asset, and reverses', async () => {
  const category = await ok('ACCOUNTS', 'POST', '/d/AssetCategory', { name: 'Tools', method: 'STRAIGHT_LINE', lifeMonths: 12 });
  const asset = await post('ACCOUNTS', '/d/Asset', { assetName: 'Fixture', categoryId: category.id, purchasedOn: today, grossPaise: 100000, depreciationStartOn: today });
  const stock = (await bucket(refs.bolt.id)).value;
  const assets = await gl(A.FIXED_ASSETS);
  const doc = await post('ACCOUNTS', '/d/AssetCapitalization', { assetId: asset.id, reason: 'Built in', lines: [{ itemId: refs.bolt.id, qtyMilli: 2000 }] });
  assert.equal(doc.totalPaise, 2000);
  assert.equal((await bucket(refs.bolt.id)).value, stock - 2000);
  assert.equal(await gl(A.FIXED_ASSETS), assets + 2000);
  assert.equal((await ok('ACCOUNTS', 'GET', `/d/Asset/${asset.id}`)).adjustedPaise, 2000);
  await booksAreClean('capitalising stock');
  await ok('ACCOUNTS', 'POST', `/d/AssetCapitalization/${doc.id}/cancel`, { reason: 'Wrong asset' });
  assert.equal((await bucket(refs.bolt.id)).value, stock);
  assert.equal((await ok('ACCOUNTS', 'GET', `/d/Asset/${asset.id}`)).adjustedPaise, 0);
  await booksAreClean('reversing that');
});

test('invoice discounting brings the money in early, with charges as a cost', async () => {
  const invoice = await post('ACCOUNTS', '/sales-invoices', { partyId: refs.customer.id, lines: [{ kind: 'SERVICE', itemId: refs.amc.id, qtyMilli: 1000, rateMinor: 1000000 }] });
  const loan = await ok('ACCOUNTS', 'POST', '/accounts', { code: '2400', name: 'Short-term loan', type: 'LIABILITY' });
  const before = await gl(A.BANK);
  const doc = await post('ACCOUNTS', '/d/InvoiceDiscounting', { bankAccountCode: A.BANK, loanAccountCode: loan.code, chargesAccountCode: A.EXPENSES, chargesPaise: 18000, invoices: [{ salesInvoiceId: invoice.id }] });
  assert.equal(doc.totalPaise, 1180000);
  assert.equal(doc.receivedPaise, 1162000);
  assert.equal(await gl(A.BANK), before + 1162000);
  assert.equal(await gl('2400'), -1180000);
  await booksAreClean('invoice discounting');
});

test('a lower deduction certificate lowers the TDS rate for its dates', async () => {
  const category = await ok('ACCOUNTS', 'POST', '/d/TaxWithholdingCategory', { name: '194J', section: '194J', rateBps: 1000 });
  await ok('ACCOUNTS', 'POST', '/d/LowerDeductionCertificate', { partyId: refs.supplier.id, categoryId: category.id, certificateNo: 'LDC-1', rateBps: 100, validFrom: addDays(today, -30), validUpto: addDays(today, 30) });
  const bill = await post('ACCOUNTS', '/purchase-invoices', { partyId: refs.supplier.id, supplierInvoiceNo: 'LD-1', supplierInvoiceDate: today, lines: [{ kind: 'SERVICE', description: 'Consulting', expenseAccountCode: A.EXPENSES, qtyMilli: 1000, ratePaise: 1000000, gstRateBps: 1800 }] });
  const tds = await post('ACCOUNTS', '/d/TdsDeduction', { purchaseInvoiceId: bill.id, categoryId: category.id });
  assert.equal(tds.tdsPaise, 10000, '1%, not 10%');
});

test('unallocating a payment frees the money and restores the invoice, forex included', async () => {
  const invoice = await post('ACCOUNTS', '/sales-invoices', { partyId: refs.foreign.id, currency: 'USD', fxRate4: 800000, lines: [{ kind: 'SERVICE', itemId: refs.amc.id, qtyMilli: 1000, rateMinor: 10000 }] });
  const gain = await gl(A.FOREX_GAIN);
  const paid = await post('ACCOUNTS', '/payments', { kind: 'RECEIPT', partyId: refs.foreign.id, bankAccountCode: A.BANK, currency: 'USD', fxRate4: 810000, amountMinor: 10000, allocations: [{ docId: invoice.id, amountMinor: 10000 }] });
  assert.equal(await gl(A.FOREX_GAIN), gain - 10000, 'Rs 1 on USD 100');
  const undone = await ok('ACCOUNTS', 'POST', `/payments/${paid.id}/unallocate`, { allocationId: paid.allocations[0].id });
  assert.equal(undone.allocatedMinor, 0);
  assert.equal(await gl(A.FOREX_GAIN), gain);
  const after = await ok('ACCOUNTS', 'GET', `/sales-invoices/${invoice.id}`);
  assert.deepEqual([after.paidMinor, after.paidPaise], [0, 0]);
  await refused('ACCOUNTS', 'POST', `/payments/${paid.id}/unallocate`, { allocationId: paid.allocations[0].id }, 'NOT_FOUND', 404);
  await ok('ACCOUNTS', 'POST', `/payments/${paid.id}/allocate`, { docId: invoice.id, amountMinor: 10000 });
  assert.equal(await gl(A.FOREX_GAIN), gain - 10000, 'allocating again books it again, once');
  await booksAreClean('unallocating');
});

test('overtime lands on the next slip; a leave policy allocates in one step, and adjusts', async () => {
  const component = await ok('HR', 'POST', '/d/SalaryComponent', { name: 'Overtime', abbreviation: 'OT', kind: 'EARNING' });
  const type = await ok('HR', 'POST', '/d/OvertimeType', { name: 'Normal', multiplierBps: 20000, componentId: component.id });
  const person = await ok('HR', 'POST', '/d/Employee', { fullName: 'Overtime Oza', joiningDate: '2024-01-01' });
  // Rs 20,800 a month is Rs 100 an hour. 5 hours at double is Rs 1,000.
  const slip = await post('HR', '/d/OvertimeSlip', { employeeId: person.id, typeId: type.id, forMonth: today, hoursMilli: 5000, monthlyGrossPaise: 2080000 });
  assert.equal(slip.amountPaise, 100000);
  const extra = await ok('HR', 'GET', `/d/AdditionalSalary/${slip.additionalSalaryId}`);
  assert.deepEqual([extra.status, extra.amountPaise], ['SUBMITTED', 100000]);

  const casual = await ok('HR', 'POST', '/d/LeaveType', { name: 'Policy leave' });
  const policy = await ok('HR', 'POST', '/d/LeavePolicy', { name: 'Standard', rows: [{ leaveTypeId: casual.id, halfDays: 24 }] });
  const period = await ok('HR', 'POST', '/d/LeavePeriod', { name: 'Policy year', fromDate: `${today.slice(0, 4)}-01-01`, toDate: `${today.slice(0, 4)}-12-31` });
  const assignment = await ok('HR', 'POST', '/d/LeavePolicyAssignment', { employeeId: person.id, policyId: policy.id, periodId: period.id });
  assert.equal((await ok('HR', 'POST', `/d/LeavePolicyAssignment/${assignment.id}/a/allocate`, {})).isAllocated, true);
  await refused('HR', 'POST', `/d/LeavePolicyAssignment/${assignment.id}/a/allocate`, {}, 'ACTION_NOT_AVAILABLE', 422);
  const adjust = await post('HR', '/d/LeaveAdjustment', { employeeId: person.id, leaveTypeId: casual.id, periodId: period.id, halfDays: 2, reason: 'Worked a holiday' });
  assert.ok(adjust.allocationId);
  const rows = await ok('HR', 'GET', `/d/LeaveAllocation?employeeId=${person.id}&status=SUBMITTED`);
  assert.equal(rows.reduce((sum, r) => sum + r.halfDays, 0), 26);
});

test('statements of account queue an email per customer who owes something', async () => {
  const { EmailQueue } = await import('../models/platform.js');
  const party = await ok('ADMIN', 'POST', '/parties', { code: 'C8', name: 'Owes money', isCustomer: true, stateCode: '24', email: 'owes@customer.example' });
  await post('ACCOUNTS', '/sales-invoices', { partyId: party.id, lines: [{ kind: 'SERVICE', itemId: refs.amc.id, qtyMilli: 1000, rateMinor: 10000 }] });
  const clean = await ok('ADMIN', 'POST', '/parties', { code: 'C7', name: 'Owes nothing', isCustomer: true, stateCode: '24', email: 'clean@customer.example' });
  const before = await EmailQueue.countDocuments();
  const process_ = await ok('ACCOUNTS', 'POST', '/d/ProcessStatementOfAccounts', { name: 'Monthly', parties: [{ partyId: party.id }, { partyId: clean.id }] });
  const sent = await ok('ACCOUNTS', 'POST', `/d/ProcessStatementOfAccounts/${process_.id}/a/send`, {});
  assert.equal(sent.sentCount, 1);
  assert.equal(await EmailQueue.countDocuments(), before + 1);
});

test('every report runs, every job runs, and the books are still clean', async () => {
  const admin = { role: 'ADMIN' };
  const needsInput = new Set(['bank-reconciliation', 'budget-variance', 'quotation-comparison', 'bom-stock', 'leave-balance', 'general-ledger', 'party-statement', 'bom-cost', 'bom-where-used', 'bom-compare', 'putaway-suggestion']);
  const failures = [];
  for (const report of reportsMeta('ADMIN')) {
    if (needsInput.has(report.key)) continue;
    try {
      const result = await runReport(report.key, {}, admin);
      assert.ok(Array.isArray(result.rows));
      for (const key of Object.keys(result.totals)) assert.ok(Number.isSafeInteger(result.totals[key]), `${report.key}.${key}`);
    } catch (error) {
      failures.push(`${report.key}: ${error.message}`);
    }
  }
  assert.deepEqual(failures, []);
  const bom = (await ok('ENGINEERING', 'GET', '/boms?status=RELEASED'))[0];
  const bomStock = await runReport('bom-stock', { bomId: bom.id, qty: '2' }, admin);
  assert.ok(bomStock.rows.length > 0);

  for (const job of listJobs()) await runJobNow(job.name);

  const tb = await ok('ACCOUNTS', 'GET', '/reports/trial-balance');
  assert.equal(tb.balanced, true);
  const sheet = await ok('ACCOUNTS', 'GET', '/reports/balance-sheet');
  assert.equal(sheet.balanced, true);
  await booksAreClean('everything');
});

test('year end: closes into retained earnings, locks, and cannot be undone', async () => {
  const lastYear = Number(today.slice(0, 4)) - 1;
  const year = await ok('ADMIN', 'POST', '/d/FiscalYear', { name: `FY ${lastYear}`, startDate: `${lastYear}-01-01`, endDate: `${lastYear}-12-31` });
  await post('ACCOUNTS', '/journals', { postingDate: `${lastYear}-06-01`, narration: 'Old income', lines: [{ accountCode: A.BANK, debitPaise: 500000 }, { accountCode: A.SALES_SERVICE, creditPaise: 500000 }] });
  await post('ACCOUNTS', '/journals', { postingDate: `${lastYear}-07-01`, narration: 'Old rent', lines: [{ accountCode: A.RENT, debitPaise: 200000 }, { accountCode: A.BANK, creditPaise: 200000 }] });
  const closing = await post('ACCOUNTS', '/d/PeriodClosingVoucher', { fiscalYearId: year.id });
  assert.equal(closing.profitPaise, 300000);
  assert.equal(await gl(A.RETAINED), -300000);
  assert.equal(closing.postingDate, `${lastYear}-12-31`);

  const statement = await ok('ACCOUNTS', 'GET', `/reports/profit-and-loss?from=${lastYear}-01-01&to=${lastYear}-12-31`);
  assert.equal(statement.profitPaise, 300000, 'the closed year still shows what it earned');
  const sheet = await ok('ACCOUNTS', 'GET', `/reports/balance-sheet?asOf=${lastYear}-12-31`);
  assert.equal(sheet.balanced, true);
  assert.equal(sheet.equity.find((r) => r.name === 'Profit to date').amountPaise, 0, 'it has moved to retained earnings');

  await refused('ACCOUNTS', 'POST', '/journals/' + (await ok('ACCOUNTS', 'POST', '/journals', { postingDate: `${lastYear}-08-01`, narration: 'Too late', lines: [{ accountCode: A.RENT, debitPaise: 1 }, { accountCode: A.BANK, creditPaise: 1 }] })).id + '/submit', undefined, 'PERIOD_LOCKED', 422);
  await refused('ACCOUNTS', 'POST', `/d/PeriodClosingVoucher/${closing.id}/cancel`, { reason: 'Undo' }, 'CLOSING_IS_FINAL', 422);
  await refused('ACCOUNTS', 'POST', `/d/PeriodClosingVoucher/${(await ok('ACCOUNTS', 'POST', '/d/PeriodClosingVoucher', { fiscalYearId: refs.fy.id })).id}/submit`, {}, 'FUTURE_DATE', 422);
  await booksAreClean('closing the year');
});
