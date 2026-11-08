// GST and the accountant's month. Amounts are worked out by hand in the comments. The
// treatment follows the law as generally described, and a CA must still confirm it.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { booksAreClean, ok, post, refused, startApi, stopApi } from './helpers/http.js';
import { A } from '../config/accounts.js';
import { GlEntry } from '../models/index.js';
import { computeTax, gstSetOff, SUPPLY, supplyTypeFor } from '../utils/tax.js';
import { addDays, todayIst } from '../utils/dates.js';

const today = todayIst();
const monthStart = `${today.slice(0, 7)}-01`;
const refs = {};
const gl = async (code, filter = {}) => {
  const rows = await GlEntry.find({ accountCode: code, ...filter }).lean();
  return rows.reduce((sum, r) => sum + r.debitPaise - r.creditPaise, 0);
};
const service = (partyId, no, rate, extra = {}, lineExtra = {}) => ({ partyId, supplierInvoiceNo: no, supplierInvoiceDate: today, ...extra, lines: [{ kind: 'SERVICE', description: 'Work', expenseAccountCode: A.EXPENSES, qtyMilli: 1000, ratePaise: rate, gstRateBps: 1800, ...lineExtra }] });
const sale = (partyId, rate, extra = {}, item = refs.work.id) => ({ partyId, ...extra, lines: [{ kind: 'SERVICE', itemId: item, qtyMilli: 1000, rateMinor: rate }] });

before(async () => {
  await startApi();
  await ok('ADMIN', 'PATCH', '/admin/settings', { stateCode: '24', lutNumber: 'LUT-9' });
  for (const [key, row] of Object.entries({
    stores: { code: 'STORES', name: 'Stores', kind: 'STORES' },
    hold: { code: 'HOLD', name: 'Hold', kind: 'QUARANTINE' },
    reject: { code: 'REJECT', name: 'Reject', kind: 'REJECT' },
  })) refs[key] = await ok('ADMIN', 'POST', '/warehouses', row);
  for (const [key, row] of Object.entries({
    local: { code: 'C1', name: 'Local unregistered', isCustomer: true, stateCode: '24' },
    far: { code: 'C2', name: 'Far unregistered', isCustomer: true, stateCode: '27' },
    registered: { code: 'C3', name: 'Registered', isCustomer: true, stateCode: '27', gstin: '27AAPFU0939F1ZV' },
    sez: { code: 'C4', name: 'SEZ unit', isCustomer: true, stateCode: '27', isSez: true, gstin: '27AAPFU0939F1ZV' },
    abroad: { code: 'C5', name: 'Overseas buyer', isCustomer: true, isExport: true, currency: 'USD', email: 'x@y.example' },
    supplier: { code: 'S1', name: 'Local supplier', isSupplier: true, stateCode: '24', gstin: '24AAACD1234E1ZF' },
    farSupplier: { code: 'S2', name: 'Far supplier', isSupplier: true, stateCode: '27', gstin: '27AAPFU0939F1ZV' },
    foreign: { code: 'S3', name: 'German supplier', isSupplier: true, isExport: true, country: 'Germany' },
  })) refs[key] = await ok('ADMIN', 'POST', '/parties', row);
  refs.work = await ok('ADMIN', 'POST', '/items', { code: 'WORK', name: 'Service work', type: 'SERVICE', hsn: '998719', gstRateBps: 1800 });
  refs.exempt = await ok('ADMIN', 'POST', '/items', { code: 'FREE', name: 'Exempt service', type: 'SERVICE', hsn: '999293', gstRateBps: 1800, gstTreatment: 'EXEMPT' });
  refs.nongst = await ok('ADMIN', 'POST', '/items', { code: 'NONGST', name: 'Non-GST item', type: 'SERVICE', hsn: '271019', gstTreatment: 'NON_GST' });
  refs.part = await ok('ADMIN', 'POST', '/items', { code: 'PART', name: 'Imported part', type: 'BOUGHT_OUT', hsn: '853710', gstRateBps: 1800 });
});
after(stopApi);

test('set-off: the order of credit, with the least left to pay in cash', () => {
  // IGST credit clears IGST first.
  let plan = gstSetOff({ igst: 100, cgst: 0, sgst: 0 }, { igst: 150, cgst: 0, sgst: 0 });
  assert.deepEqual([plan.used.igst, plan.cash.igst, plan.creditLeft.igst], [100, 0, 50]);

  // IGST left goes where own credit falls short: here SGST, or cash would be wasted.
  plan = gstSetOff({ igst: 0, cgst: 100, sgst: 100 }, { igst: 100, cgst: 100, sgst: 0 });
  assert.deepEqual(plan.cash, { igst: 0, cgst: 0, sgst: 0 });
  assert.deepEqual(plan.used, { igst: 100, cgst: 100, sgst: 0 });

  // CGST credit never pays SGST, nor the other way round.
  plan = gstSetOff({ igst: 0, cgst: 0, sgst: 100 }, { igst: 0, cgst: 100, sgst: 0 });
  assert.deepEqual([plan.cash.sgst, plan.used.cgst, plan.creditLeft.cgst], [100, 0, 100]);

  // CGST and SGST credit can pay IGST, after their own head.
  plan = gstSetOff({ igst: 100, cgst: 30, sgst: 0 }, { igst: 0, cgst: 80, sgst: 40 });
  assert.deepEqual(plan.cash, { igst: 10, cgst: 0, sgst: 0 });
  assert.deepEqual(plan.used, { igst: 0, cgst: 80, sgst: 40 });

  // Everything adds up: settled plus cash is what was owed; used plus left is what was held.
  plan = gstSetOff({ igst: 7, cgst: 11, sgst: 13 }, { igst: 5, cgst: 3, sgst: 17 });
  for (const head of ['igst', 'cgst', 'sgst']) assert.equal(plan.used[head] + plan.creditLeft[head], { igst: 5, cgst: 3, sgst: 17 }[head]);
  assert.deepEqual(plan.settled, { igst: 7 - plan.cash.igst, cgst: 11 - plan.cash.cgst, sgst: 13 - plan.cash.sgst });
});

test('supply types: SEZ is zero-rated, imports carry no tax on the invoice', () => {
  assert.equal(supplyTypeFor({ companyState: '24', partyState: '24', isSez: true }), SUPPLY.SEZ_LUT);
  assert.equal(supplyTypeFor({ companyState: '24', partyState: '27', isSez: true, exportUnderLut: false }), SUPPLY.SEZ_IGST);
  assert.equal(computeTax([{ taxablePaise: 100000, gstRateBps: 1800 }], SUPPLY.SEZ_LUT).taxPaise, 0);
  assert.equal(computeTax([{ taxablePaise: 100000, gstRateBps: 1800 }], SUPPLY.SEZ_IGST).igstPaise, 18000);
  assert.equal(computeTax([{ taxablePaise: 100000, gstRateBps: 1800 }], SUPPLY.IMPORT).taxPaise, 0);
});

test('place of supply decides the tax, not where the buyer sits', async () => {
  const normal = await ok('ACCOUNTS', 'POST', '/sales-invoices', sale(refs.far.id, 100000));
  assert.deepEqual([normal.supplyType, normal.igstPaise, normal.placeOfSupply], ['INTER', 18000, '27']);
  // The goods are delivered inside Gujarat, so it is CGST and SGST.
  const shipped = await ok('ACCOUNTS', 'POST', '/sales-invoices', sale(refs.far.id, 100000, { placeOfSupplyState: '24' }));
  assert.deepEqual([shipped.supplyType, shipped.cgstPaise, shipped.sgstPaise, shipped.igstPaise, shipped.placeOfSupply], ['INTRA', 9000, 9000, 0, '24']);
  await ok('ACCOUNTS', 'DELETE', `/sales-invoices/${normal.id}`);
  await ok('ACCOUNTS', 'DELETE', `/sales-invoices/${shipped.id}`);
});

test('reverse charge: the supplier gets the bare amount, we owe the tax, and may claim it', async () => {
  const bill = await post('ACCOUNTS', '/purchase-invoices', service(refs.supplier.id, 'RC-1', 100000, { isReverseCharge: true }));
  // Rs 1,000 at 18%, in the same state.
  assert.deepEqual([bill.taxablePaise, bill.cgstPaise, bill.sgstPaise, bill.totalPaise], [100000, 9000, 9000, 100000]);
  assert.equal(await gl(A.CREDITORS, { partyId: bill.partyId }), -100000, 'the supplier is owed no tax');
  assert.equal(await gl(A.RCM_CGST), -9000);
  assert.equal(await gl(A.RCM_SGST), -9000);
  assert.equal(await gl(A.INPUT_CGST), 9000);
  assert.equal(await gl(A.OUTPUT_CGST), 0, 'not mixed with ordinary output tax');
  await booksAreClean('reverse charge');

  const note = await post('ACCOUNTS', '/notes', { kind: 'DEBIT', invoiceId: bill.id, reason: 'Overcharged', lines: [{ invoiceLineId: bill.lines[0].id, taxableMinor: 50000 }] });
  assert.deepEqual([note.totalPaise, note.cgstPaise], [50000, 4500]);
  assert.equal(await gl(A.RCM_CGST), -4500);
  assert.equal(await gl(A.INPUT_CGST), 4500);
  await booksAreClean('a debit note on reverse charge');
  await ok('ACCOUNTS', 'POST', `/notes/${note.id}/cancel`, { reason: 'Mistake' });
  await ok('ACCOUNTS', 'POST', `/purchase-invoices/${bill.id}/cancel`, { reason: 'Mistake' });
  assert.equal(await gl(A.RCM_CGST), 0);
  await booksAreClean('reversing reverse charge');
});

test('a foreign service is reverse charge at IGST, foreign goods carry no tax', async () => {
  const consultancy = await post('ACCOUNTS', '/purchase-invoices', service(refs.foreign.id, 'DE-1', 1000000, { isReverseCharge: true }));
  assert.deepEqual([consultancy.supplyType, consultancy.igstPaise, consultancy.totalPaise], ['INTER', 180000, 1000000]);
  assert.equal(await gl(A.RCM_IGST), -180000);
  await ok('ACCOUNTS', 'POST', `/purchase-invoices/${consultancy.id}/cancel`, { reason: 'Test' });

  const po = await post('PURCHASE', '/purchase-orders', { partyId: refs.foreign.id, lines: [{ itemId: refs.part.id, qtyMilli: 1000, ratePaise: 5000000 }] });
  assert.deepEqual([po.supplyType, po.taxPaise, po.totalPaise], ['IMPORT', 0, 5000000]);
  const receipt = await post('STORES', '/grns', { purchaseOrderId: po.id, lines: [{ poLineId: po.lines[0].id, qtyMilli: 1000 }] });
  const bill = await post('ACCOUNTS', '/purchase-invoices', { partyId: refs.foreign.id, supplierInvoiceNo: 'DE-2', supplierInvoiceDate: today, lines: [{ kind: 'GOODS', grnId: receipt.id, grnLineId: receipt.lines[0].id, qtyMilli: 1000, ratePaise: 5000000 }] });
  assert.deepEqual([bill.supplyType, bill.taxPaise, bill.totalPaise], ['IMPORT', 0, 5000000]);
  refs.importReceipt = receipt;
  await booksAreClean('imports');
});

test('bill of entry: IGST can be claimed, duty waits for landed cost, and lands on the goods', async () => {
  const before_ = await gl(A.INPUT_IGST);
  const entry = await post('ACCOUNTS', '/d/BillOfEntry', { boeNo: 'BE-778', boeDate: today, portCode: 'INMUN1', grnId: refs.importReceipt.id, assessablePaise: 5000000, customsDutyPaise: 500000, igstPaise: 990000, bankAccountCode: A.BANK });
  assert.equal(entry.totalPaise, 1490000);
  assert.equal(await gl(A.INPUT_IGST), before_ + 990000);
  assert.equal(await gl(A.LANDED_COST_CLEARING), 500000);
  await refused('ACCOUNTS', 'POST', '/d/BillOfEntry', { boeNo: 'BE-778', boeDate: today, assessablePaise: 1, igstPaise: 1, bankAccountCode: A.BANK }, 'DUPLICATE', 409);
  const voucher = await post('ACCOUNTS', '/d/LandedCostVoucher', { grnId: refs.importReceipt.id, charges: [{ description: 'Customs duty', amountPaise: 500000 }] });
  assert.equal(voucher.capitalisedPaise, 500000);
  assert.equal(await gl(A.LANDED_COST_CLEARING), 0, 'the duty is now in the cost of the goods');
  const stock = await ok('STORES', 'GET', `/reports/stock-balance?itemId=${refs.part.id}`);
  assert.equal(stock.rows[0].valuePaise, 5500000);
  await booksAreClean('the bill of entry');
});

test('blocked credit is a cost, not a claim, and a debit note takes it back the same way', async () => {
  const input = await gl(A.INPUT_CGST);
  const bill = await post('ACCOUNTS', '/purchase-invoices', service(refs.supplier.id, 'BL-1', 100000, {}, { itcBlocked: true }));
  assert.deepEqual([bill.totalPaise, bill.blockedTaxPaise], [118000, 18000]);
  assert.equal(await gl(A.INPUT_CGST), input, 'no credit taken');
  assert.equal(await gl(A.GST_NOT_CLAIMABLE), 18000);
  await booksAreClean('blocked credit');
  const note = await post('ACCOUNTS', '/notes', { kind: 'DEBIT', invoiceId: bill.id, reason: 'Returned', lines: [{ invoiceLineId: bill.lines[0].id, taxableMinor: 100000 }] });
  assert.equal(note.totalPaise, 118000);
  assert.equal(await gl(A.GST_NOT_CLAIMABLE), 0);
  assert.equal(await gl(A.INPUT_CGST), input);
  await booksAreClean('a debit note on blocked credit');
});

test('exempt and non-GST items carry no tax, whatever rate is typed', async () => {
  const exempt = await ok('ACCOUNTS', 'POST', '/sales-invoices', { partyId: refs.local.id, lines: [{ kind: 'SERVICE', itemId: refs.exempt.id, qtyMilli: 1000, rateMinor: 100000, gstRateBps: 1800 }] });
  assert.deepEqual([exempt.taxPaise, exempt.lines[0].gstRateBps, exempt.lines[0].gstTreatment], [0, 0, 'EXEMPT']);
  await ok('ACCOUNTS', 'DELETE', `/sales-invoices/${exempt.id}`);
});

test('SEZ under LUT needs the LUT, and is zero-rated', async () => {
  const invoice = await post('ACCOUNTS', '/sales-invoices', sale(refs.sez.id, 100000));
  assert.deepEqual([invoice.supplyType, invoice.taxPaise, invoice.lutNumber], ['SEZ_LUT', 0, 'LUT-9']);
  const withTax = await post('ACCOUNTS', '/sales-invoices', sale(refs.sez.id, 100000, { exportUnderLut: false }));
  assert.deepEqual([withTax.supplyType, withTax.igstPaise], ['SEZ_IGST', 18000]);
  refs.sezInvoice = invoice;
  await booksAreClean('SEZ supplies');
});

test('IRN: recorded once, blocks cancelling, and can only be undone within 24 hours', async () => {
  const invoice = await post('ACCOUNTS', '/sales-invoices', sale(refs.registered.id, 100000));
  const irn = 'a'.repeat(64);
  await refused('ACCOUNTS', 'POST', `/sales-invoices/${invoice.id}/irn`, { irn: 'short', ackNo: '1', ackAt: new Date().toISOString() }, 'VALIDATION_FAILED', 400);
  const recorded = await ok('ACCOUNTS', 'POST', `/sales-invoices/${invoice.id}/irn`, { irn, ackNo: '112', ackAt: new Date().toISOString() });
  assert.equal(recorded.irn, irn);
  await refused('ACCOUNTS', 'POST', `/sales-invoices/${invoice.id}/irn`, { irn: 'b'.repeat(64), ackNo: '2', ackAt: new Date().toISOString() }, 'IRN_EXISTS', 409);
  await refused('ACCOUNTS', 'POST', `/sales-invoices/${invoice.id}/cancel`, { reason: 'x' }, 'CANCEL_IRN_FIRST', 422);

  const other = await post('ACCOUNTS', '/sales-invoices', sale(refs.registered.id, 100000));
  await refused('ACCOUNTS', 'POST', `/sales-invoices/${other.id}/irn`, { irn, ackNo: '3', ackAt: new Date().toISOString() }, 'DUPLICATE', 409);
  const stale = await ok('ACCOUNTS', 'POST', `/sales-invoices/${other.id}/irn`, { irn: 'c'.repeat(64), ackNo: '4', ackAt: new Date(Date.now() - 25 * 3600000).toISOString() });
  assert.ok(stale.irn);
  await refused('ACCOUNTS', 'POST', `/sales-invoices/${other.id}/irn-cancelled`, { reason: 'Too late' }, 'IRN_CANCEL_WINDOW_OVER', 422);

  await ok('ACCOUNTS', 'POST', `/sales-invoices/${invoice.id}/irn-cancelled`, { reason: 'Wrong buyer' });
  await ok('ACCOUNTS', 'POST', `/sales-invoices/${invoice.id}/cancel`, { reason: 'Wrong buyer' });
  await booksAreClean('IRN handling');
});

test('e-invoice reporting limit refuses an invoice the portal would refuse', async () => {
  await ok('ADMIN', 'PATCH', '/admin/settings', { einvoiceRequired: true, einvoiceReportDays: 30 });
  const old = await ok('ACCOUNTS', 'POST', '/sales-invoices', sale(refs.registered.id, 1000, { postingDate: addDays(today, -40) }));
  await refused('ACCOUNTS', 'POST', `/sales-invoices/${old.id}/submit`, {}, 'TOO_OLD_FOR_IRN', 422);
  await ok('ADMIN', 'PATCH', '/admin/settings', { einvoiceRequired: false, einvoiceReportDays: 0 });
  await ok('ACCOUNTS', 'DELETE', `/sales-invoices/${old.id}`);
});

test('payment deductions: TDS kept by the customer clears the invoice in full', async () => {
  const invoice = await post('ACCOUNTS', '/sales-invoices', sale(refs.local.id, 1000000));
  assert.equal(invoice.totalPaise, 1180000);
  const debtors = await gl(A.DEBTORS, { partyId: invoice.partyId });
  // The customer keeps Rs 200 of TDS and pays the rest.
  await refused('ACCOUNTS', 'POST', '/payments', { kind: 'RECEIPT', partyId: invoice.partyId, bankAccountCode: A.BANK, amountMinor: 1, deductions: [{ accountCode: A.DEBTORS, amountPaise: 1 }] }, 'CONTROL_ACCOUNT', 422);
  const paid = await post('ACCOUNTS', '/payments', {
    kind: 'RECEIPT', partyId: invoice.partyId, bankAccountCode: A.BANK, amountMinor: 1160000, reference: 'NEFT-1',
    deductions: [{ accountCode: A.EXPENSES, amountPaise: 20000, description: 'TDS by customer' }],
    allocations: [{ docId: invoice.id, amountMinor: 1180000 }],
  });
  assert.deepEqual([paid.amountPaise, paid.deductionsPaise, paid.allocatedMinor], [1160000, 20000, 1180000]);
  assert.equal(await gl(A.DEBTORS, { partyId: invoice.partyId }), debtors - 1180000);
  const after_ = await ok('ACCOUNTS', 'GET', `/sales-invoices/${invoice.id}`);
  assert.equal(after_.paidPaise, after_.totalPaise);
  await booksAreClean('a deduction on a receipt');

  // Paying a supplier, keeping TDS: they are cleared in full, and less leaves the bank.
  const bill = await post('ACCOUNTS', '/purchase-invoices', service(refs.supplier.id, 'DED-1', 100000));
  const bank = await gl(A.BANK);
  await post('ACCOUNTS', '/payments', { kind: 'PAYMENT', partyId: bill.partyId, bankAccountCode: A.BANK, amountMinor: 116000, deductions: [{ accountCode: A.TDS_PAYABLE, amountPaise: 2000, description: 'TDS 194C' }], allocations: [{ docId: bill.id, amountMinor: 118000 }] });
  assert.equal(await gl(A.BANK), bank - 116000);
  assert.equal(await gl(A.TDS_PAYABLE), -2000);
  await refused('ACCOUNTS', 'POST', '/payments', { kind: 'RECEIPT', partyId: refs.abroad.id, bankAccountCode: A.BANK, currency: 'USD', fxRate4: 830000, amountMinor: 1, deductions: [{ accountCode: A.EXPENSES, amountPaise: 1 }] }, 'DEDUCTIONS_INR_ONLY', 422);
  await booksAreClean('a deduction on a payment');
});

test('bank transfer moves money between accounts, with charges as a cost', async () => {
  const bank = await gl(A.BANK);
  const cash = await gl(A.CASH);
  await refused('ACCOUNTS', 'POST', `/d/BankTransfer/${(await ok('ACCOUNTS', 'POST', '/d/BankTransfer', { fromAccountCode: A.BANK, toAccountCode: A.BANK, amountPaise: 1 })).id}/submit`, {}, 'SAME_ACCOUNT', 422);
  await refused('ACCOUNTS', 'POST', '/d/BankTransfer', { fromAccountCode: A.RENT, toAccountCode: A.BANK, amountPaise: 1 }, 'LINK_NOT_ALLOWED', 422);
  await post('ACCOUNTS', '/d/BankTransfer', { fromAccountCode: A.BANK, toAccountCode: A.CASH, amountPaise: 500000, chargesPaise: 500, reference: 'Petty cash' });
  assert.equal(await gl(A.BANK), bank - 500500);
  assert.equal(await gl(A.CASH), cash + 500000);
  await booksAreClean('a transfer');
});

test('opening invoices age and allocate like real ones, and stay out of the returns', async () => {
  const sales = await post('ACCOUNTS', '/d/OpeningInvoice', { kind: 'SALES', partyId: refs.local.id, invoiceNo: 'OLD/778', invoiceDate: addDays(today, -100), dueDate: addDays(today, -70), amountMinor: 500000 });
  assert.equal(sales.totalPaise, 500000);
  const buying = await post('ACCOUNTS', '/d/OpeningInvoice', { kind: 'PURCHASE', partyId: refs.supplier.id, invoiceNo: 'THEIRS/9', invoiceDate: addDays(today, -10), amountMinor: 200000 });
  assert.equal(await gl(A.OPENING), -500000 + 200000);
  await refused('ACCOUNTS', 'POST', `/d/OpeningInvoice/${(await ok('ACCOUNTS', 'POST', '/d/OpeningInvoice', { kind: 'SALES', partyId: refs.supplier.id, invoiceNo: 'X', invoiceDate: today, amountMinor: 1 })).id}/submit`, {}, 'UNKNOWN_PARTY', 422);

  const ageing = await ok('ACCOUNTS', 'GET', '/reports/ageing?kind=RECEIVABLE');
  const row = ageing.rows.find((r) => r.partyName === 'Local unregistered');
  assert.equal(row.d61to90Paise, 500000, 'overdue by 70 days');

  await post('ACCOUNTS', '/payments', { kind: 'RECEIPT', partyId: refs.local.id, bankAccountCode: A.BANK, amountMinor: 300000, allocations: [{ docId: sales.createdInvoiceId, amountMinor: 300000 }] });
  const detail = await ok('ACCOUNTS', 'GET', `/r/receivable-detail?partyId=${refs.local.id}`);
  assert.equal(detail.rows.find((r) => r.docNo === 'OP-OLD/778').outstandingPaise, 200000);
  await refused('ACCOUNTS', 'POST', `/d/OpeningInvoice/${sales.id}/cancel`, { reason: 'x' }, 'INVOICE_HAS_PAYMENTS', 409);

  const returns = await ok('ACCOUNTS', 'GET', `/reports/gstr1?from=${addDays(today, -200)}&to=${today}`);
  assert.equal(JSON.stringify(returns).includes('OP-OLD/778'), false, 'not a sale');
  await refused('ACCOUNTS', 'GET', `/sales-invoices/${sales.createdInvoiceId}/einvoice.json`, undefined, 'OPENING_INVOICE', 422);
  await refused('ACCOUNTS', 'POST', `/sales-invoices/${sales.createdInvoiceId}/irn`, { irn: 'd'.repeat(64), ackNo: '5', ackAt: new Date().toISOString() }, 'OPENING_INVOICE', 422);
  await ok('ACCOUNTS', 'POST', `/d/OpeningInvoice/${buying.id}/cancel`, { reason: 'Paid already' });
  assert.equal(await gl(A.OPENING), -500000);
  await booksAreClean('opening invoices');
});

test('GSTR-1: each invoice lands in the right table, and notes reduce it', async () => {
  await ok('ADMIN', 'PATCH', '/admin/settings', { gstB2clLimitPaise: 10000000 });
  const small = await post('ACCOUNTS', '/sales-invoices', sale(refs.far.id, 5000000));
  const large = await post('ACCOUNTS', '/sales-invoices', sale(refs.far.id, 20000000));
  const local = await post('ACCOUNTS', '/sales-invoices', sale(refs.local.id, 1000000));
  const b2b = await post('ACCOUNTS', '/sales-invoices', sale(refs.registered.id, 3000000));
  const exported = await post('ACCOUNTS', '/sales-invoices', sale(refs.abroad.id, 100000, { currency: 'USD', fxRate4: 830000, shippingBillNo: 'SB-1' }));
  const exemptSale = await post('ACCOUNTS', '/sales-invoices', { partyId: refs.local.id, lines: [{ kind: 'SERVICE', itemId: refs.exempt.id, qtyMilli: 1000, rateMinor: 40000 }, { kind: 'SERVICE', itemId: refs.nongst.id, qtyMilli: 1000, rateMinor: 60000 }] });
  // Credit note on a small sale reduces the B2CS figure. On B2B it is its own row.
  await post('ACCOUNTS', '/notes', { kind: 'CREDIT', invoiceId: small.id, reason: 'Discount', lines: [{ invoiceLineId: small.lines[0].id, taxableMinor: 1000000 }] });
  const b2bNote = await post('ACCOUNTS', '/notes', { kind: 'CREDIT', invoiceId: b2b.id, reason: 'Return', lines: [{ invoiceLineId: b2b.lines[0].id, taxableMinor: 500000 }] });

  const r = await ok('ACCOUNTS', 'GET', `/reports/gstr1?from=${monthStart}&to=${today}`);
  assert.ok(r.b2b.some((x) => x.docNo === b2b.docNo));
  assert.ok(r.b2cl.some((x) => x.docNo === large.docNo), 'over the limit, inter-state, unregistered');
  assert.equal(r.b2cl.some((x) => x.docNo === small.docNo), false);
  assert.equal(r.b2cl.some((x) => x.docNo === local.docNo), false);
  assert.ok(r.exports.some((x) => x.docNo === exported.docNo && x.withPayment === false && x.shippingBillNo === 'SB-1'));
  assert.ok(r.sez.some((x) => x.docNo === refs.sezInvoice.docNo));
  // B2CS for state 27 at 18%: Rs 50,000 less the note of Rs 10,000.
  const small27 = r.b2cs.find((x) => x.placeOfSupply === '27' && x.gstRateBps === 1800);
  assert.deepEqual([small27.taxablePaise, small27.igstPaise], [4000000, 720000]);
  assert.ok(r.cdnr.some((x) => x.docNo === b2bNote.docNo));
  const nil = r.nil.find((x) => x.heading === 'Intra-state to unregistered');
  assert.ok(nil.exemptPaise >= 40000);
  assert.ok(nil.nonGstPaise >= 60000);
  assert.ok(r.hsnB2b.length > 0);
  assert.ok(r.hsnB2c.length > 0);
  const hsnTotal = (rows) => rows.reduce((s, x) => s + x.taxablePaise, 0);
  assert.equal(hsnTotal(r.hsnSummary), hsnTotal(r.hsnB2b) + hsnTotal(r.hsnB2c), 'the split adds up to the whole');
  assert.ok(r.documents.issued >= 7);
  assert.equal(r.creditNoteDocuments.issued, 2);
  assert.ok(exemptSale.docNo);

  // Lowering the limit moves an invoice into B2CL. The limit is data, not code.
  await ok('ADMIN', 'PATCH', '/admin/settings', { gstB2clLimitPaise: 100000 });
  const lowered = await ok('ACCOUNTS', 'GET', `/reports/gstr1?from=${monthStart}&to=${today}`);
  assert.ok(lowered.b2cl.some((x) => x.docNo === small.docNo));
  await ok('ADMIN', 'PATCH', '/admin/settings', { gstB2clLimitPaise: 10000000 });
});

test('GSTR-3B agrees with the ledger, table by table', async () => {
  const r = await ok('ACCOUNTS', 'GET', `/reports/gstr3b?from=${monthStart}&to=${today}`);
  assert.equal(r.outward.cgstPaise, -(await gl(A.OUTPUT_CGST)));
  assert.equal(r.outward.sgstPaise, -(await gl(A.OUTPUT_SGST)));
  assert.equal(r.outward.igstPaise + r.zeroRated.igstPaise, -(await gl(A.OUTPUT_IGST)));
  assert.equal(r.itc.cgstPaise, await gl(A.INPUT_CGST));
  assert.equal(r.itc.igstPaise, await gl(A.INPUT_IGST));
  assert.ok(r.itcImports.igstPaise >= 990000);
  assert.ok(r.nilExemptPaise >= 40000);
  assert.ok(r.nonGstPaise >= 60000);
  assert.ok(r.zeroRated.taxablePaise > 0);
  assert.ok(r.unregisteredByState.some((x) => x.placeOfSupply === '27'));
  const plan = r.setOff;
  assert.equal(plan.settled.igst + plan.cash.igst, r.outward.igstPaise + r.zeroRated.igstPaise);
});

test('RCM and blocked credit show in their own 3B tables', async () => {
  const before_ = await ok('ACCOUNTS', 'GET', `/reports/gstr3b?from=${monthStart}&to=${today}`);
  await post('ACCOUNTS', '/purchase-invoices', service(refs.farSupplier.id, 'RC-9', 100000, { isReverseCharge: true }));
  await post('ACCOUNTS', '/purchase-invoices', service(refs.supplier.id, 'BL-9', 100000, {}, { itcBlocked: true }));
  const after_ = await ok('ACCOUNTS', 'GET', `/reports/gstr3b?from=${monthStart}&to=${today}`);
  assert.equal(after_.reverseCharge.igstPaise - before_.reverseCharge.igstPaise, 18000, '3.1(d)');
  assert.equal(after_.itcReverseCharge.igstPaise - before_.itcReverseCharge.igstPaise, 18000, '4(A)(3)');
  assert.equal(after_.itcBlocked.cgstPaise - before_.itcBlocked.cgstPaise, 9000, '4(B)(1)');
  assert.equal(after_.itc.cgstPaise, before_.itc.cgstPaise, 'blocked credit does not add to what can be used');
});

test('GST set-off posts credit against tax, the balance is paid by challan, and accounts clear', async () => {
  const doc = await ok('ACCOUNTS', 'POST', '/d/GstSetOff', { periodEnd: today });
  const done = await ok('ACCOUNTS', 'POST', `/d/GstSetOff/${doc.id}/submit`, {});
  assert.ok(done.creditUsedPaise > 0);
  await booksAreClean('set-off');
  assert.equal(await gl(A.OUTPUT_CGST), -done.cashCgstPaise);
  assert.equal(await gl(A.OUTPUT_SGST), -done.cashSgstPaise);
  assert.equal(await gl(A.OUTPUT_IGST), -done.cashIgstPaise);
  assert.equal(done.rcmIgstPaise, -(await gl(A.RCM_IGST)), 'reverse charge stays for cash');
  await refused('ACCOUNTS', 'POST', `/d/GstSetOff/${doc.id}/a/payCash`, { bankAccountCode: A.BANK }, 'VALIDATION_FAILED', 400);
  await refused('ACCOUNTS', 'POST', `/d/GstSetOff/${doc.id}/a/payCash`, { bankAccountCode: A.RENT, challanNo: 'X' }, 'LINK_NOT_ALLOWED', 422);
  const paid = await ok('ACCOUNTS', 'POST', `/d/GstSetOff/${doc.id}/a/payCash`, { bankAccountCode: A.BANK, challanNo: 'CPIN-123' });
  assert.equal(paid.isPaid, true);
  for (const code of [A.OUTPUT_CGST, A.OUTPUT_SGST, A.OUTPUT_IGST, A.RCM_CGST, A.RCM_SGST, A.RCM_IGST]) assert.equal(await gl(code), 0, `${code} is clear`);
  await refused('ACCOUNTS', 'POST', `/d/GstSetOff/${doc.id}/a/payCash`, { bankAccountCode: A.BANK, challanNo: 'X' }, 'ACTION_NOT_AVAILABLE', 422);
  const again = await ok('ACCOUNTS', 'POST', '/d/GstSetOff', { periodEnd: today });
  await refused('ACCOUNTS', 'POST', `/d/GstSetOff/${again.id}/submit`, {}, 'NOTHING_TO_SET_OFF', 422);
  await ok('ACCOUNTS', 'DELETE', `/d/GstSetOff/${again.id}`);
  const future = await ok('ACCOUNTS', 'POST', '/d/GstSetOff', { periodEnd: addDays(today, 5) });
  await refused('ACCOUNTS', 'POST', `/d/GstSetOff/${future.id}/submit`, {}, 'FUTURE_DATE', 422);
  await ok('ACCOUNTS', 'DELETE', `/d/GstSetOff/${future.id}`);
  await booksAreClean('paying GST');
});

test('an unpaid set-off blocks the next one, so tax cannot be paid twice, and cancel undoes it all', async () => {
  // Far more tax than the credit left over, so there is a balance to pay in cash.
  await post('ACCOUNTS', '/sales-invoices', sale(refs.local.id, 100000000));
  const outputBefore = await gl(A.OUTPUT_CGST);
  const inputBefore = await gl(A.INPUT_CGST);
  const bankBefore = await gl(A.BANK);

  const first = await post('ACCOUNTS', '/d/GstSetOff', { periodEnd: today });
  assert.ok(first.cashTotalPaise > 0);
  const second = await ok('ACCOUNTS', 'POST', '/d/GstSetOff', { periodEnd: today });
  await refused('ACCOUNTS', 'POST', `/d/GstSetOff/${second.id}/submit`, {}, 'EARLIER_SET_OFF_OPEN', 422);

  await ok('ACCOUNTS', 'POST', `/d/GstSetOff/${first.id}/a/payCash`, { bankAccountCode: A.BANK, challanNo: 'CPIN-7' });
  assert.equal(await gl(A.OUTPUT_CGST), 0);
  assert.equal(await gl(A.BANK), bankBefore - first.cashTotalPaise);

  // An earlier date than a set-off already done would work from the wrong balances.
  const backdated = await ok('ACCOUNTS', 'POST', '/d/GstSetOff', { periodEnd: addDays(today, -1) });
  await refused('ACCOUNTS', 'POST', `/d/GstSetOff/${backdated.id}/submit`, {}, 'EARLIER_SET_OFF_OPEN', 422);
  await ok('ACCOUNTS', 'DELETE', `/d/GstSetOff/${backdated.id}`);
  await ok('ACCOUNTS', 'DELETE', `/d/GstSetOff/${second.id}`);

  // Cancelling reverses both the set-off and the challan, back to the starting balances.
  await ok('ACCOUNTS', 'POST', `/d/GstSetOff/${first.id}/cancel`, { reason: 'Wrong month' });
  assert.equal(await gl(A.OUTPUT_CGST), outputBefore);
  assert.equal(await gl(A.INPUT_CGST), inputBefore);
  assert.equal(await gl(A.BANK), bankBefore);
  await booksAreClean('cancelling a paid set-off');
});

test('GSTR-2B reconciliation finds matches, differences, and what each side is missing', async () => {
  await post('ACCOUNTS', '/purchase-invoices', service(refs.supplier.id, 'GB/1', 100000));
  await post('ACCOUNTS', '/purchase-invoices', service(refs.supplier.id, 'GB/2', 100000));
  await post('ACCOUNTS', '/purchase-invoices', service(refs.supplier.id, 'GB/3', 100000));
  const doc = await ok('ACCOUNTS', 'POST', '/d/Gstr2bReconciliation', { fromDate: monthStart, toDate: today });
  const gstin = refs.supplier.gstin;
  const csv = [
    'gstin,invoice_no,invoice_date,taxable,cgst,sgst,igst',
    `${gstin}, gb/1 ,${today},1000.00,90,90,0`,
    `${gstin},GB/2,${today},1000.00,95,95,0`,
    `${gstin},NOT-BOOKED,${today},500,45,45,0`,
  ].join('\n');
  const done = await ok('ACCOUNTS', 'POST', `/d/Gstr2bReconciliation/${doc.id}/a/load`, { csv });
  assert.deepEqual([done.matched, done.mismatched, done.missingInBooks], [1, 1, 1]);
  assert.ok(done.onlyInBooks.some((r) => r.invoiceNo === 'GB/3'), 'booked but the supplier has not filed it');
  const wrong = done.rows.find((r) => r.result === 'MISMATCH');
  assert.equal(wrong.differencePaise, 1000);
  await refused('ACCOUNTS', 'POST', `/d/Gstr2bReconciliation/${doc.id}/a/load`, { csv: 'gstin,invoice_no\nA,B\n' }, 'BAD_COLUMNS', 422);
  await refused('ACCOUNTS', 'POST', `/d/Gstr2bReconciliation/${doc.id}/a/load`, { csv: 'gstin,invoice_no,invoice_date,taxable,cgst,sgst,igst\nA,B,C,D,notmoney,0,0\n' }, 'BAD_AMOUNT', 422);
});

test('the books: day book, cash and bank, statements, and a cash flow that proves itself', async () => {
  const day = await ok('ACCOUNTS', 'GET', '/r/day-book');
  assert.equal(day.totals.debitPaise, day.totals.creditPaise, 'a day book balances');
  assert.ok(day.rows.length > 0);

  const bank = await ok('ACCOUNTS', 'GET', '/r/bank-book');
  assert.equal(bank.rows.at(-1).balancePaise, await gl(A.BANK));
  assert.equal(bank.rows[0].narration, 'Opening balance');

  const statement = await ok('SALES', 'GET', `/r/party-statement?partyId=${refs.local.id}`);
  const net = await gl(A.DEBTORS, { partyId: refs.local.id }) + await gl(A.CREDITORS, { partyId: refs.local.id });
  assert.equal(statement.rows.at(-1).balancePaise, net);
  const fromTomorrow = await ok('ACCOUNTS', 'GET', `/r/party-statement?partyId=${refs.local.id}&from=${addDays(today, 1)}`);
  assert.equal(fromTomorrow.rows[0].balancePaise, net, 'the opening balance carries forward');
  await refused('ACCOUNTS', 'GET', '/r/party-statement', undefined, 'PARTY_REQUIRED', 422);
  await refused('ACCOUNTS', 'GET', '/r/general-ledger', undefined, 'ACCOUNT_REQUIRED', 422);
  assert.equal((await ok('ACCOUNTS', 'GET', `/r/general-ledger?accountCode=${A.BANK}`)).rows.at(-1).balancePaise, await gl(A.BANK));

  const parties = await ok('ACCOUNTS', 'GET', '/r/party-trial-balance');
  assert.equal(parties.totals.closingPaise, await gl(A.DEBTORS) + await gl(A.CREDITORS));

  const months = await ok('ACCOUNTS', 'GET', '/r/profit-by-month');
  const pnl = await ok('ACCOUNTS', 'GET', '/reports/profit-and-loss?from=2000-01-01&to=2999-01-01');
  assert.equal(months.totals.profitPaise, pnl.profitPaise);

  const flow = await ok('ACCOUNTS', 'GET', '/r/cash-flow-statement');
  const row = (heading) => flow.rows.find((r) => r.heading === heading).amountPaise;
  assert.equal(row('Difference, which must be nil'), 0, 'the movements explain the cash exactly');
  assert.equal(row('Net change in cash'), await gl(A.CASH) + await gl(A.BANK));

  const itc = await ok('ACCOUNTS', 'GET', `/r/itc-register?from=${monthStart}&to=${today}`);
  assert.ok(itc.rows.some((r) => r.itcBlocked === true));
  assert.ok(itc.rows.some((r) => r.isReverseCharge === true));
  assert.ok((await ok('ACCOUNTS', 'GET', '/r/rcm-register')).rows.length >= 1);
  assert.ok((await ok('ACCOUNTS', 'GET', '/r/hsn-purchases')).rows.length >= 1);
  assert.equal((await ok('ACCOUNTS', 'GET', '/r/bills-of-entry')).totals.igstPaise, 990000);
  assert.ok((await ok('ACCOUNTS', 'GET', '/r/irn-pending')).rows.length >= 1);
  await refused('STORES', 'GET', '/r/day-book', undefined, 'FORBIDDEN', 403);
  await booksAreClean('the whole month');
  const sheet = await ok('ACCOUNTS', 'GET', '/reports/balance-sheet');
  assert.equal(sheet.balanced, true);
});
