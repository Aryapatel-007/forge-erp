// The books an accountant expects: day book, cash and bank books, party statements,
// invoice-wise dues, month by month profit, a cash flow that proves itself, GST registers.
import { defineReport } from '../engine/reports.js';
import { modelOf } from '../engine/registry.js';
import { A } from '../config/accounts.js';
import { GlEntry } from '../models/ledgers.js';
import { Account, Party } from '../models/masters.js';
import { Payment, PurchaseInvoice, SalesInvoice } from '../models/documents.js';
import { sumInts } from '../utils/money.js';
import { daysBetween, todayIst } from '../utils/dates.js';
import { rule } from '../utils/errors.js';
import mongoose from 'mongoose';

const OFFICE = ['ADMIN', 'MANAGEMENT'];
const FINANCE = [...OFFICE, 'ACCOUNTS'];
const DATES = 'from:date to:date';
const range = (from, to) => (from || to ? { postingDate: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } } : {});
const notOpening = { status: 'SUBMITTED', isOpening: { $ne: true } };

const accountNames = async () => new Map((await Account.find({}, { code: 1, name: 1 }).lean()).map((a) => [a.code, a.name]));

defineReport({
  key: 'day-book', module: 'accounts', title: 'Day book', roles: FINANCE, filters: DATES,
  columns: 'postingDate:date voucherNo voucherType accountName narration debitPaise:money creditPaise:money', totals: 'debitPaise creditPaise',
  async run({ from, to }) {
    const today = todayIst();
    const names = await accountNames();
    const rows = await GlEntry.find(range(from ?? today, to ?? today)).sort({ postingDate: 1, _id: 1 }).limit(5000).lean();
    return rows.map((r) => ({ postingDate: r.postingDate, voucherNo: r.voucherNo, voucherType: r.voucherType, accountName: names.get(r.accountCode), narration: r.narration, debitPaise: r.debitPaise, creditPaise: r.creditPaise }));
  },
});

// One ledger with a running balance. Cash book, bank book and party statements are this.
async function ledgerRows(match, from, to) {
  const [before] = from
    ? await GlEntry.aggregate([{ $match: { ...match, postingDate: { $lt: from } } }, { $group: { _id: null, net: { $sum: { $subtract: ['$debitPaise', '$creditPaise'] } } } }])
    : [];
  let running = before?.net ?? 0;
  const rows = [{ postingDate: from ?? '', voucherNo: '', narration: 'Opening balance', debitPaise: 0, creditPaise: 0, balancePaise: running }];
  const entries = await GlEntry.find({ ...match, ...range(from, to) }).sort({ postingDate: 1, _id: 1 }).limit(5000).lean();
  for (const entry of entries) {
    running += entry.debitPaise - entry.creditPaise;
    rows.push({ postingDate: entry.postingDate, voucherNo: entry.voucherNo, narration: entry.narration, debitPaise: entry.debitPaise, creditPaise: entry.creditPaise, balancePaise: running });
  }
  return rows;
}
const LEDGER_COLUMNS = 'postingDate:date voucherNo narration debitPaise:money creditPaise:money balancePaise:smoney:Balance';

for (const [key, title, code] of [['cash-book', 'Cash book', A.CASH], ['bank-book', 'Bank book', A.BANK]]) {
  defineReport({
    key, module: 'accounts', title, roles: FINANCE, filters: `${DATES} accountCode:link(Account;isCashOrBank=true)`,
    columns: LEDGER_COLUMNS,
    run: ({ from, to, accountCode }) => ledgerRows({ accountCode: accountCode ?? code }, from, to),
  });
}

defineReport({
  key: 'general-ledger', module: 'accounts', title: 'General ledger', roles: FINANCE, filters: `accountCode!:link(Account) ${DATES} partyId:link(Party) costCenterId:link(CostCenter) projectId:link(Project) voucherNo`,
  columns: LEDGER_COLUMNS,
  run({ from, to, accountCode, partyId, costCenterId, projectId, voucherNo }) {
    if (!accountCode) throw rule('Choose an account.', 'ACCOUNT_REQUIRED');
    const match = { accountCode };
    if (partyId) match.partyId = new mongoose.Types.ObjectId(partyId);
    if (costCenterId) match.costCenterId = costCenterId;
    if (projectId) match.projectId = projectId;
    if (voucherNo) match.voucherNo = voucherNo;
    return ledgerRows(match, from, to);
  },
});

defineReport({
  key: 'party-statement', module: 'accounts', title: 'Statement of account', roles: [...FINANCE, 'SALES', 'PURCHASE'], filters: `partyId!:link(Party) ${DATES}`,
  columns: LEDGER_COLUMNS,
  async run({ partyId, from, to }) {
    if (!partyId) throw rule('Choose a party.', 'PARTY_REQUIRED');
    return ledgerRows({ partyId: new mongoose.Types.ObjectId(partyId), accountCode: { $in: [A.DEBTORS, A.CREDITORS] } }, from, to);
  },
});

defineReport({
  key: 'party-trial-balance', module: 'accounts', title: 'Trial balance by party', roles: FINANCE, filters: DATES,
  columns: 'code name openingPaise:smoney debitPaise:money creditPaise:money closingPaise:smoney', totals: 'openingPaise debitPaise creditPaise closingPaise',
  async run({ from, to }) {
    const base = { accountCode: { $in: [A.DEBTORS, A.CREDITORS] }, partyId: { $ne: null } };
    const opening = from ? await GlEntry.aggregate([{ $match: { ...base, postingDate: { $lt: from } } }, { $group: { _id: '$partyId', net: { $sum: { $subtract: ['$debitPaise', '$creditPaise'] } } } }]) : [];
    const moves = await GlEntry.aggregate([{ $match: { ...base, ...range(from, to) } }, { $group: { _id: '$partyId', debit: { $sum: '$debitPaise' }, credit: { $sum: '$creditPaise' } } }]);
    const ids = [...new Set([...opening, ...moves].map((r) => String(r._id)))];
    const parties = await Party.find({ _id: { $in: ids } }, { code: 1, name: 1 }).lean();
    return parties.map((party) => {
      const open = opening.find((r) => String(r._id) === String(party._id))?.net ?? 0;
      const move = moves.find((r) => String(r._id) === String(party._id)) ?? { debit: 0, credit: 0 };
      return { code: party.code, name: party.name, openingPaise: open, debitPaise: move.debit, creditPaise: move.credit, closingPaise: open + move.debit - move.credit };
    }).sort((a, b) => a.code.localeCompare(b.code));
  },
});

// Every unpaid invoice with its age, the view a person chasing money wants.
for (const [key, title, Model] of [['receivable-detail', 'Unpaid invoices: customers', SalesInvoice], ['payable-detail', 'Unpaid invoices: suppliers', PurchaseInvoice]]) {
  defineReport({
    key, module: 'accounts', title, roles: FINANCE, filters: 'partyId:link(Party)',
    columns: 'docNo partyName postingDate:date dueDate:date overdueDays:int totalPaise:money outstandingPaise:money', totals: 'totalPaise outstandingPaise',
    async run({ partyId }) {
      const today = todayIst();
      const filter = { status: 'SUBMITTED', ...(partyId ? { partyId } : {}) };
      const invoices = await Model.find(filter).sort({ dueDate: 1 }).lean();
      return invoices
        .map((i) => ({ docNo: i.docNo, partyName: i.partyName, postingDate: i.postingDate, dueDate: i.dueDate, overdueDays: i.dueDate ? Math.max(0, daysBetween(i.dueDate, today)) : 0, totalPaise: i.totalPaise, outstandingPaise: i.totalPaise - i.paidPaise - i.creditedPaise }))
        .filter((r) => r.outstandingPaise > 0);
    },
  });
}

defineReport({
  key: 'profit-by-month', module: 'accounts', title: 'Profit by month', roles: FINANCE, filters: DATES,
  columns: 'month incomePaise:money expensePaise:money profitPaise:smoney', totals: 'incomePaise expensePaise profitPaise',
  async run({ from, to }) {
    const accounts = await Account.find({ type: { $in: ['INCOME', 'EXPENSE'] } }, { code: 1, type: 1 }).lean();
    const types = new Map(accounts.map((a) => [a.code, a.type]));
    const rows = await GlEntry.aggregate([
      { $match: { accountCode: { $in: [...types.keys()] }, voucherType: { $ne: 'PeriodClosingVoucher' }, ...range(from, to) } },
      { $group: { _id: { month: { $substrCP: ['$postingDate', 0, 7] }, code: '$accountCode' }, net: { $sum: { $subtract: ['$debitPaise', '$creditPaise'] } } } },
    ]);
    const months = new Map();
    for (const row of rows) {
      const month = months.get(row._id.month) ?? { month: row._id.month, incomePaise: 0, expensePaise: 0 };
      if (types.get(row._id.code) === 'INCOME') month.incomePaise -= row.net;
      else month.expensePaise += row.net;
      months.set(row._id.month, month);
    }
    return [...months.values()].sort((a, b) => a.month.localeCompare(b.month)).map((m) => ({ ...m, profitPaise: m.incomePaise - m.expensePaise }));
  },
});

// Indirect method. The last row checks itself: the movements must equal the change in cash.
defineReport({
  key: 'cash-flow-statement', module: 'accounts', title: 'Cash flow statement', roles: FINANCE, filters: DATES,
  columns: 'section heading amountPaise:smoney',
  async run({ from, to }) {
    const accounts = await Account.find().lean();
    const rows = await GlEntry.aggregate([{ $match: range(from, to) }, { $group: { _id: '$accountCode', net: { $sum: { $subtract: ['$debitPaise', '$creditPaise'] } } } }]);
    const net = new Map(rows.map((r) => [r._id, r.net]));
    const sumWhere = (test) => sumInts(accounts.filter(test).map((a) => net.get(a.code) ?? 0));
    const isCash = (a) => a.isCashOrBank;
    const profit = -sumWhere((a) => ['INCOME', 'EXPENSE'].includes(a.type) || a.code === A.RETAINED);
    const depreciation = -(net.get(A.ACCUM_DEPRECIATION) ?? 0);
    const investing = -(net.get(A.FIXED_ASSETS) ?? 0);
    const isFinancing = (a) => (a.type === 'EQUITY' && a.code !== A.RETAINED) || a.group === 'Loans' || /loan/i.test(a.name);
    const financing = -sumWhere(isFinancing);
    const skip = (a) => isCash(a) || ['INCOME', 'EXPENSE', 'EQUITY'].includes(a.type) || isFinancing(a) || [A.FIXED_ASSETS, A.ACCUM_DEPRECIATION].includes(a.code);
    const groups = new Map();
    for (const account of accounts) {
      if (skip(account) || !net.get(account.code)) continue;
      groups.set(account.group, (groups.get(account.group) ?? 0) - net.get(account.code));
    }
    const workingCapital = sumInts([...groups.values()]);
    const operating = profit + depreciation + workingCapital;
    const change = sumWhere(isCash);
    return [
      { section: 'Operating', heading: 'Profit', amountPaise: profit },
      { section: 'Operating', heading: 'Add back depreciation', amountPaise: depreciation },
      ...[...groups.entries()].map(([heading, amountPaise]) => ({ section: 'Operating', heading: `Change in ${heading.toLowerCase()}`, amountPaise })),
      { section: 'Operating', heading: 'Cash from operations', amountPaise: operating },
      { section: 'Investing', heading: 'Fixed assets', amountPaise: investing },
      { section: 'Financing', heading: 'Capital, opening balances and loans', amountPaise: financing },
      { section: 'Net', heading: 'Net change in cash', amountPaise: operating + investing + financing },
      { section: 'Check', heading: 'Change in cash and bank accounts', amountPaise: change },
      { section: 'Check', heading: 'Difference, which must be nil', amountPaise: operating + investing + financing - change },
    ];
  },
});

defineReport({
  key: 'payment-period', module: 'accounts', title: 'How long customers take to pay', roles: FINANCE, filters: DATES,
  columns: 'partyName payments:int averageDays:int slowestDays:int',
  async run({ from, to }) {
    const payments = await Payment.find({ kind: 'RECEIPT', status: 'SUBMITTED', ...range(from, to) }).lean();
    const invoices = await SalesInvoice.find({ _id: { $in: payments.flatMap((p) => p.allocations.map((a) => a.docId)) } }, { postingDate: 1 }).lean();
    const parties = new Map();
    for (const payment of payments) {
      for (const allocation of payment.allocations) {
        const invoice = invoices.find((i) => String(i._id) === String(allocation.docId));
        if (!invoice) continue;
        const days = Math.max(0, daysBetween(invoice.postingDate, allocation.allocatedOn));
        const row = parties.get(payment.partyName) ?? { partyName: payment.partyName, payments: 0, total: 0, slowestDays: 0 };
        row.payments += 1;
        row.total += days;
        row.slowestDays = Math.max(row.slowestDays, days);
        parties.set(payment.partyName, row);
      }
    }
    return [...parties.values()].map(({ total, ...row }) => ({ ...row, averageDays: Math.round(total / row.payments) })).sort((a, b) => b.averageDays - a.averageDays);
  },
});

/* ---------- GST registers ---------- */

defineReport({ key: 'itc-register', module: 'accounts', title: 'Input tax credit register', roles: FINANCE, source: 'PurchaseInvoice', filters: DATES, dateField: 'postingDate', match: notOpening, unwind: 'lines', lineMatch: { 'lines.gstRateBps': { $gt: 0 } }, sort: { postingDate: 1, docNo: 1 }, project: { docNo: 'docNo', postingDate: 'postingDate', partyName: 'partyName', supplierGstin: 'supplierGstin', supplierInvoiceNo: 'supplierInvoiceNo', hsn: 'lines.hsn', taxablePaise: 'lines.taxablePaise', cgstPaise: 'lines.cgstPaise', sgstPaise: 'lines.sgstPaise', igstPaise: 'lines.igstPaise', itcBlocked: 'lines.itcBlocked', isReverseCharge: 'isReverseCharge' }, columns: 'docNo postingDate:date partyName supplierGstin:text:GSTIN supplierInvoiceNo:text:Their_invoice hsn:text:HSN taxablePaise:money cgstPaise:money:CGST sgstPaise:money:SGST igstPaise:money:IGST itcBlocked:check:Blocked isReverseCharge:check:Reverse_charge', totals: 'taxablePaise cgstPaise sgstPaise igstPaise' });
defineReport({ key: 'rcm-register', module: 'accounts', title: 'Reverse charge register', roles: FINANCE, source: 'PurchaseInvoice', filters: DATES, dateField: 'postingDate', match: { ...notOpening, isReverseCharge: true }, sort: { postingDate: 1 }, project: { docNo: 'docNo', postingDate: 'postingDate', partyName: 'partyName', supplierInvoiceNo: 'supplierInvoiceNo', taxablePaise: 'taxablePaise', cgstPaise: 'cgstPaise', sgstPaise: 'sgstPaise', igstPaise: 'igstPaise' }, columns: 'docNo postingDate:date partyName supplierInvoiceNo:text:Their_invoice taxablePaise:money cgstPaise:money:CGST sgstPaise:money:SGST igstPaise:money:IGST', totals: 'taxablePaise cgstPaise sgstPaise igstPaise' });
defineReport({ key: 'hsn-purchases', module: 'accounts', title: 'HSN summary: purchases', roles: FINANCE, source: 'PurchaseInvoice', filters: DATES, dateField: 'postingDate', match: notOpening, unwind: 'lines', groupBy: { hsn: 'lines.hsn', gstRateBps: 'lines.gstRateBps' }, sums: { qtyMilli: 'lines.qtyMilli', taxablePaise: 'lines.taxablePaise', cgstPaise: 'lines.cgstPaise', sgstPaise: 'lines.sgstPaise', igstPaise: 'lines.igstPaise' }, sort: { hsn: 1 }, columns: 'hsn:text:HSN gstRateBps:pct:Rate qtyMilli:qty taxablePaise:money cgstPaise:money:CGST sgstPaise:money:SGST igstPaise:money:IGST', totals: 'taxablePaise cgstPaise sgstPaise igstPaise' });
defineReport({ key: 'bills-of-entry', module: 'accounts', title: 'Bills of entry', roles: FINANCE, source: 'BillOfEntry', filters: DATES, dateField: 'boeDate', match: { status: 'SUBMITTED' }, sort: { boeDate: 1 }, project: { docNo: 'docNo', boeNo: 'boeNo', boeDate: 'boeDate', portCode: 'portCode', assessablePaise: 'assessablePaise', customsDutyPaise: 'customsDutyPaise', igstPaise: 'igstPaise' }, columns: 'docNo boeNo boeDate:date portCode assessablePaise:money customsDutyPaise:money igstPaise:money:IGST', totals: 'assessablePaise customsDutyPaise igstPaise' });

defineReport({
  key: 'irn-pending', module: 'accounts', title: 'Invoices still needing an IRN', roles: FINANCE, filters: '',
  columns: 'docNo partyName partyGstin:text:GSTIN postingDate:date ageDays:int totalPaise:money', totals: 'totalPaise',
  async run() {
    const today = todayIst();
    const rows = await SalesInvoice.find({ ...notOpening, $and: [{ $or: [{ partyGstin: { $ne: '' } }, { isExport: true }, { supplyType: { $in: ['SEZ_LUT', 'SEZ_IGST'] } }] }, { $or: [{ irn: null }, { irnCancelledAt: { $ne: null } }] }] }).sort({ postingDate: 1 }).lean();
    return rows.map((i) => ({ docNo: i.docNo, partyName: i.partyName, partyGstin: i.partyGstin, postingDate: i.postingDate, ageDays: daysBetween(i.postingDate, today), totalPaise: i.totalPaise }));
  },
});

defineReport({
  key: 'tds-by-section', module: 'accounts', title: 'TDS by section and supplier', roles: FINANCE, filters: DATES,
  columns: 'section partyName pan basePaise:money tdsPaise:money:TDS', totals: 'basePaise tdsPaise',
  async run({ from, to }) {
    const rows = await modelOf('TdsDeduction').find({ status: 'SUBMITTED', ...range(from, to) }).lean();
    const invoices = await PurchaseInvoice.find({ _id: { $in: rows.map((r) => r.purchaseInvoiceId) } }, { partyId: 1, partyName: 1 }).lean();
    const parties = await Party.find({ _id: { $in: invoices.map((i) => i.partyId) } }, { pan: 1 }).lean();
    const categories = await modelOf('TaxWithholdingCategory').find({ _id: { $in: rows.map((r) => r.categoryId) } }, { section: 1 }).lean();
    const grouped = new Map();
    for (const row of rows) {
      const invoice = invoices.find((i) => String(i._id) === String(row.purchaseInvoiceId));
      const section = categories.find((c) => String(c._id) === String(row.categoryId))?.section ?? '';
      const key = `${section}|${invoice.partyId}`;
      const entry = grouped.get(key) ?? { section, partyName: invoice.partyName, pan: parties.find((p) => String(p._id) === String(invoice.partyId))?.pan ?? '', basePaise: 0, tdsPaise: 0 };
      entry.basePaise += row.basePaise;
      entry.tdsPaise += row.tdsPaise;
      grouped.set(key, entry);
    }
    return [...grouped.values()].sort((a, b) => a.section.localeCompare(b.section));
  },
});

// Every day's debits and credits, to find the day the books stopped balancing.
defineReport({
  key: 'ledger-by-day', module: 'accounts', title: 'Find the day the ledger went out', roles: FINANCE, filters: DATES,
  columns: 'postingDate:date debitPaise:money creditPaise:money differencePaise:smoney runningPaise:smoney:Running_difference', totals: 'debitPaise creditPaise differencePaise',
  async run({ from, to }) {
    const rows = await GlEntry.aggregate([
      { $match: range(from, to) },
      { $group: { _id: '$postingDate', debitPaise: { $sum: '$debitPaise' }, creditPaise: { $sum: '$creditPaise' } } },
      { $sort: { _id: 1 } },
    ]);
    let running = 0;
    return rows.map((row) => {
      const differencePaise = row.debitPaise - row.creditPaise;
      running += differencePaise;
      return { postingDate: row._id, debitPaise: row.debitPaise, creditPaise: row.creditPaise, differencePaise, runningPaise: running };
    });
  },
});
