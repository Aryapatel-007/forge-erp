// Reports, declared. Most are one aggregation over frozen values. A few need real logic.
import { defineReport } from '../engine/reports.js';
import { modelOf } from '../engine/registry.js';
import { Bin, GlEntry, StockEntry } from '../models/ledgers.js';
import { Account, Item, Party, Warehouse } from '../models/masters.js';
import { Gauge, Grn, MachineBuild, Ncr, PurchaseInvoice, PurchaseOrder, SalesInvoice, SalesOrder } from '../models/documents.js';
import { mulDivRound, sumInts } from '../utils/money.js';
import { addDays, daysBetween, todayIst } from '../utils/dates.js';
import { rule } from '../utils/errors.js';

const OFFICE = ['ADMIN', 'MANAGEMENT'];
const FINANCE = [...OFFICE, 'ACCOUNTS'];
const SALES = [...OFFICE, 'SALES', 'ACCOUNTS'];
const BUYING = [...OFFICE, 'PURCHASE', 'ACCOUNTS'];
const STOCK = [...OFFICE, 'STORES', 'PURCHASE', 'PRODUCTION', 'ACCOUNTS'];
const MAKE = [...OFFICE, 'PRODUCTION', 'ENGINEERING', 'ACCOUNTS'];
const HR = [...OFFICE, 'HR'];
const PAY = [...OFFICE, 'HR', 'ACCOUNTS'];
const CARE = [...OFFICE, 'SERVICE', 'QUALITY', 'SALES'];
const QA = [...OFFICE, 'QUALITY', 'PRODUCTION'];
const DATES = 'from:date to:date';

const live = { status: 'SUBMITTED' };
const liveSale = { status: 'SUBMITTED', isOpening: { $ne: true } };

/* ---------- Accounts ---------- */

defineReport({ key: 'sales-register', module: 'accounts', title: 'Sales register', roles: FINANCE, source: 'SalesInvoice', filters: `${DATES} partyId:link(Party)`, dateField: 'postingDate', match: liveSale, sort: { postingDate: 1, docNo: 1 }, project: { docNo: 'docNo', postingDate: 'postingDate', partyName: 'partyName', partyGstin: 'partyGstin', taxablePaise: 'taxablePaise', cgstPaise: 'cgstPaise', sgstPaise: 'sgstPaise', igstPaise: 'igstPaise', totalPaise: 'totalPaise', paidPaise: 'paidPaise' }, columns: 'docNo postingDate:date partyName partyGstin:text:GSTIN taxablePaise:money cgstPaise:money:CGST sgstPaise:money:SGST igstPaise:money:IGST totalPaise:money paidPaise:money', totals: 'taxablePaise cgstPaise sgstPaise igstPaise totalPaise paidPaise' });
defineReport({ key: 'purchase-register', module: 'accounts', title: 'Purchase register', roles: FINANCE, source: 'PurchaseInvoice', filters: `${DATES} partyId:link(Party)`, dateField: 'postingDate', match: liveSale, sort: { postingDate: 1, docNo: 1 }, project: { docNo: 'docNo', postingDate: 'postingDate', partyName: 'partyName', supplierInvoiceNo: 'supplierInvoiceNo', taxablePaise: 'taxablePaise', cgstPaise: 'cgstPaise', sgstPaise: 'sgstPaise', igstPaise: 'igstPaise', totalPaise: 'totalPaise', paidPaise: 'paidPaise' }, columns: 'docNo postingDate:date partyName supplierInvoiceNo:text:Their_invoice taxablePaise:money cgstPaise:money:CGST sgstPaise:money:SGST igstPaise:money:IGST totalPaise:money paidPaise:money', totals: 'taxablePaise cgstPaise sgstPaise igstPaise totalPaise paidPaise' });
defineReport({ key: 'itemwise-sales', module: 'accounts', title: 'Item-wise sales register', roles: SALES, source: 'SalesInvoice', filters: DATES, dateField: 'postingDate', match: liveSale, unwind: 'lines', groupBy: { itemCode: 'lines.itemCode', itemName: 'lines.itemName', hsn: 'lines.hsn' }, sums: { qtyMilli: 'lines.qtyMilli', taxablePaise: 'lines.taxablePaise', costPaise: 'lines.costPaise' }, sort: { taxablePaise: -1 }, columns: 'itemCode itemName hsn:text:HSN qtyMilli:qty taxablePaise:money costPaise:money', totals: 'taxablePaise costPaise' });
defineReport({ key: 'itemwise-purchases', module: 'accounts', title: 'Item-wise purchase register', roles: BUYING, source: 'PurchaseInvoice', filters: DATES, dateField: 'postingDate', match: liveSale, unwind: 'lines', groupBy: { itemCode: 'lines.itemCode', itemName: 'lines.itemName' }, sums: { qtyMilli: 'lines.qtyMilli', taxablePaise: 'lines.taxablePaise' }, sort: { taxablePaise: -1 }, columns: 'itemCode itemName qtyMilli:qty taxablePaise:money', totals: 'taxablePaise' });
defineReport({ key: 'customer-summary', module: 'accounts', title: 'Customer ledger summary', roles: FINANCE, source: 'SalesInvoice', filters: DATES, dateField: 'postingDate', match: liveSale, groupBy: { partyName: 'partyName' }, sums: { invoices: 1, totalPaise: 'totalPaise', paidPaise: 'paidPaise', creditedPaise: 'creditedPaise' }, sort: { totalPaise: -1 }, columns: 'partyName invoices:int totalPaise:money paidPaise:money creditedPaise:money', totals: 'invoices totalPaise paidPaise creditedPaise' });
defineReport({ key: 'supplier-summary', module: 'accounts', title: 'Supplier ledger summary', roles: FINANCE, source: 'PurchaseInvoice', filters: DATES, dateField: 'postingDate', match: liveSale, groupBy: { partyName: 'partyName' }, sums: { invoices: 1, totalPaise: 'totalPaise', paidPaise: 'paidPaise', creditedPaise: 'creditedPaise' }, sort: { totalPaise: -1 }, columns: 'partyName invoices:int totalPaise:money paidPaise:money creditedPaise:money', totals: 'invoices totalPaise paidPaise creditedPaise' });

defineReport({
  key: 'gross-profit', module: 'accounts', title: 'Gross profit', roles: FINANCE, filters: DATES,
  columns: 'docNo postingDate:date partyName sellingPaise:money costPaise:money profitPaise:money marginBps:pct', totals: 'sellingPaise costPaise profitPaise',
  async run({ from, to }) {
    const filter = { ...liveSale };
    if (from || to) filter.postingDate = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
    const invoices = await SalesInvoice.find(filter).sort({ postingDate: 1 }).lean();
    return invoices.map((i) => ({
      docNo: i.docNo, postingDate: i.postingDate, partyName: i.partyName, sellingPaise: i.taxablePaise, costPaise: i.costPaise, profitPaise: i.taxablePaise - i.costPaise,
      marginBps: i.taxablePaise ? mulDivRound(i.taxablePaise - i.costPaise, 10000, i.taxablePaise) : 0,
    }));
  },
});

defineReport({
  key: 'cash-flow', module: 'accounts', title: 'Cash flow', roles: FINANCE, filters: DATES,
  columns: 'accountName inflowPaise:money outflowPaise:money netPaise:money', totals: 'inflowPaise outflowPaise netPaise',
  async run({ from, to }) {
    const cash = await Account.find({ isCashOrBank: true }, { code: 1, name: 1 }).lean();
    const match = { accountCode: { $in: cash.map((a) => a.code) } };
    if (from || to) match.postingDate = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
    const rows = await GlEntry.aggregate([{ $match: match }, { $group: { _id: '$accountCode', inflowPaise: { $sum: '$debitPaise' }, outflowPaise: { $sum: '$creditPaise' } } }]);
    return rows.map((r) => ({ accountName: cash.find((a) => a.code === r._id)?.name, inflowPaise: r.inflowPaise, outflowPaise: r.outflowPaise, netPaise: r.inflowPaise - r.outflowPaise }));
  },
});

defineReport({
  key: 'bank-reconciliation', module: 'accounts', title: 'Bank reconciliation statement', roles: FINANCE, filters: 'bankAccountId!:link(BankAccount)',
  columns: 'heading amountPaise:money',
  async run({ bankAccountId }) {
    if (!bankAccountId) throw rule('Choose a bank account.', 'BANK_REQUIRED');
    const bank = await modelOf('BankAccount').findById(bankAccountId).lean();
    const [gl] = await GlEntry.aggregate([{ $match: { accountCode: bank.accountCode } }, { $group: { _id: null, net: { $sum: { $subtract: ['$debitPaise', '$creditPaise'] } } } }]);
    const statement = await modelOf('BankTransaction').find({ bankAccountId: String(bankAccountId) }).lean();
    const statementNet = sumInts(statement.map((t) => t.depositPaise - t.withdrawalPaise));
    const unmatched = statement.filter((t) => t.state === 'UNRECONCILED');
    return [
      { heading: 'Balance in the books', amountPaise: gl?.net ?? 0 },
      { heading: 'Balance on the statement', amountPaise: statementNet },
      { heading: 'Difference', amountPaise: (gl?.net ?? 0) - statementNet },
      { heading: `Statement lines not matched (${unmatched.length})`, amountPaise: sumInts(unmatched.map((t) => t.depositPaise - t.withdrawalPaise)) },
    ];
  },
});

defineReport({
  key: 'budget-variance', module: 'accounts', title: 'Budget against actual', roles: FINANCE, filters: 'fiscalYearId!:link(FiscalYear)',
  columns: 'costCenter accountCode budgetPaise:money actualPaise:money variancePaise:money', totals: 'budgetPaise actualPaise variancePaise',
  async run({ fiscalYearId }) {
    if (!fiscalYearId) throw rule('Choose a fiscal year.', 'YEAR_REQUIRED');
    const year = await modelOf('FiscalYear').findById(fiscalYearId).lean();
    const budgets = await modelOf('Budget').find({ fiscalYearId: String(fiscalYearId) }).lean();
    const rows = [];
    for (const budget of budgets) {
      const [spent] = await GlEntry.aggregate([{ $match: { costCenterId: String(budget.costCenterId), accountCode: budget.accountCode, postingDate: { $gte: year.startDate, $lte: year.endDate } } }, { $group: { _id: null, net: { $sum: { $subtract: ['$debitPaise', '$creditPaise'] } } } }]);
      rows.push({ costCenter: budget._labels?.costCenterId, accountCode: budget.accountCode, budgetPaise: budget.amountPaise, actualPaise: spent?.net ?? 0, variancePaise: budget.amountPaise - (spent?.net ?? 0) });
    }
    return rows;
  },
});

defineReport({ key: 'cost-center-pnl', module: 'accounts', title: 'Cost centre expense', roles: FINANCE, source: 'GlEntry', filters: DATES, dateField: 'postingDate', match: { costCenterId: { $ne: null } }, groupBy: { costCenterId: 'costCenterId', accountCode: 'accountCode' }, sums: { debitPaise: 'debitPaise', creditPaise: 'creditPaise' }, sort: { costCenterId: 1, accountCode: 1 }, columns: 'costCenterId:text:Cost_centre accountCode debitPaise:money creditPaise:money', totals: 'debitPaise creditPaise' });
defineReport({ key: 'tds-register', module: 'accounts', title: 'TDS deducted', roles: FINANCE, source: 'TdsDeduction', filters: DATES, dateField: 'postingDate', match: live, project: { docNo: 'docNo', postingDate: 'postingDate', invoice: '_labels.purchaseInvoiceId', category: '_labels.categoryId', basePaise: 'basePaise', tdsPaise: 'tdsPaise' }, sort: { postingDate: 1 }, columns: 'docNo postingDate:date invoice category basePaise:money tdsPaise:money:TDS', totals: 'basePaise tdsPaise' });

defineReport({
  key: 'overdue-invoices', module: 'accounts', title: 'Overdue invoices', roles: FINANCE, filters: '',
  columns: 'docNo partyName dueDate:date overdueDays:int outstandingPaise:money', totals: 'outstandingPaise',
  async run() {
    const today = todayIst();
    const invoices = await SalesInvoice.find({ ...live, dueDate: { $lt: today } }).sort({ dueDate: 1 }).lean();
    return invoices
      .map((i) => ({ docNo: i.docNo, partyName: i.partyName, dueDate: i.dueDate, overdueDays: daysBetween(i.dueDate, today), outstandingPaise: i.totalPaise - i.paidPaise - i.creditedPaise }))
      .filter((r) => r.outstandingPaise > 0);
  },
});

defineReport({ key: 'payment-register', module: 'accounts', title: 'Receipts and payments register', roles: FINANCE, source: 'Payment', filters: DATES, dateField: 'postingDate', match: live, sort: { postingDate: 1 }, project: { docNo: 'docNo', postingDate: 'postingDate', kind: 'kind', partyName: 'partyName', reference: 'reference', bankAccountCode: 'bankAccountCode', amountPaise: 'amountPaise' }, columns: 'docNo postingDate:date kind partyName reference bankAccountCode:text:Account amountPaise:money', totals: 'amountPaise' });
defineReport({ key: 'deferred-schedule', module: 'accounts', title: 'Deferred schedule', roles: FINANCE, source: 'DeferredSchedule', filters: '', match: live, unwind: 'rows', sort: { 'rows.onDate': 1 }, project: { docNo: 'docNo', kind: 'kind', onDate: 'rows.onDate', amountPaise: 'rows.amountPaise', isPosted: 'rows.isPosted', voucherNo: 'rows.voucherNo' }, columns: 'docNo kind onDate:date amountPaise:money isPosted:check voucherNo', totals: 'amountPaise' });

/* ---------- Assets ---------- */

defineReport({
  key: 'asset-register', module: 'assets', title: 'Fixed asset register', roles: FINANCE, filters: '',
  columns: 'docNo assetName category state grossPaise:money accumulatedPaise:money bookPaise:money', totals: 'grossPaise accumulatedPaise bookPaise',
  async run() {
    const assets = await modelOf('Asset').find({ status: 'SUBMITTED' }).lean();
    return assets.map((a) => {
      const accumulated = sumInts(a.schedule.filter((r) => r.isPosted).map((r) => r.amountPaise));
      const gross = a.grossPaise + a.adjustedPaise;
      return { docNo: a.docNo, assetName: a.assetName, category: a._labels?.categoryId, state: a.state, grossPaise: gross, accumulatedPaise: accumulated, bookPaise: a.state === 'IN_USE' ? gross - accumulated : 0 };
    });
  },
});
defineReport({ key: 'depreciation-ledger', module: 'assets', title: 'Depreciation ledger', roles: FINANCE, source: 'Asset', filters: '', match: { status: 'SUBMITTED' }, unwind: 'schedule', sort: { 'schedule.onDate': 1 }, project: { docNo: 'docNo', assetName: 'assetName', onDate: 'schedule.onDate', amountPaise: 'schedule.amountPaise', isPosted: 'schedule.isPosted', voucherNo: 'schedule.voucherNo' }, columns: 'docNo assetName onDate:date amountPaise:money isPosted:check voucherNo', totals: 'amountPaise' });
defineReport({ key: 'asset-maintenance-due', module: 'assets', title: 'Asset maintenance due', roles: [...FINANCE, 'PRODUCTION'], source: 'AssetMaintenance', filters: '', sort: { nextDueOn: 1 }, project: { asset: '_labels.assetId', frequency: 'frequency', nextDueOn: 'nextDueOn' }, columns: 'asset frequency nextDueOn:date' });

/* ---------- Selling and CRM ---------- */

const MONTH = { $substrCP: ['$postingDate', 0, 7] };
const analytics = (key, title, source, roles, field) => defineReport({
  key, module: source === 'SalesInvoice' ? 'selling' : 'buying', title, roles, filters: DATES,
  columns: `month ${field ? 'partyName ' : ''}documents:int taxablePaise:money totalPaise:money`, totals: 'documents taxablePaise totalPaise',
  async run({ from, to }) {
    const Model = source === 'SalesInvoice' ? SalesInvoice : PurchaseInvoice;
    const match = { ...liveSale };
    if (from || to) match.postingDate = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
    const id = field ? { month: MONTH, partyName: '$partyName' } : { month: MONTH };
    const rows = await Model.aggregate([{ $match: match }, { $group: { _id: id, documents: { $sum: 1 }, taxablePaise: { $sum: '$taxablePaise' }, totalPaise: { $sum: '$totalPaise' } } }, { $sort: { '_id.month': 1 } }]);
    return rows.map((r) => ({ ...r._id, documents: r.documents, taxablePaise: r.taxablePaise, totalPaise: r.totalPaise }));
  },
});
analytics('sales-by-month', 'Sales by month', 'SalesInvoice', SALES, false);
analytics('sales-by-customer-month', 'Sales by customer and month', 'SalesInvoice', SALES, true);
analytics('purchases-by-month', 'Purchases by month', 'PurchaseInvoice', BUYING, false);
analytics('purchases-by-supplier-month', 'Purchases by supplier and month', 'PurchaseInvoice', BUYING, true);

defineReport({ key: 'quotation-trends', module: 'selling', title: 'Quotations by status', roles: SALES, source: 'Quotation', filters: DATES, dateField: 'postingDate', groupBy: { status: 'status' }, sums: { count: 1, valueMinor: 'subtotalMinor' }, sort: { count: -1 }, columns: 'status count:int valueMinor:money:Value', totals: 'count' });
defineReport({ key: 'open-sales-orders', module: 'selling', title: 'Sales orders still open', roles: SALES, source: 'SalesOrder', filters: '', match: { status: 'CONFIRMED' }, sort: { deliveryDate: 1 }, project: { docNo: 'docNo', partyName: 'partyName', customerPoNo: 'customerPoNo', deliveryDate: 'deliveryDate', currency: 'currency', subtotalMinor: 'subtotalMinor' }, columns: 'docNo partyName customerPoNo deliveryDate:date currency subtotalMinor:money:Value' });

defineReport({
  key: 'milestones-due', module: 'selling', title: 'Payment milestones due', roles: SALES, filters: '',
  columns: 'docNo partyName milestone trigger currency dueMinor:money receivedMinor:money balanceMinor:money',
  async run() {
    const orders = await SalesOrder.find({ status: 'CONFIRMED' }).lean();
    return orders.flatMap((o) => o.milestones.filter((m) => m.amountMinor > m.receivedMinor).map((m) => ({ docNo: o.docNo, partyName: o.partyName, milestone: m.name, trigger: m.trigger, currency: o.currency, dueMinor: m.amountMinor, receivedMinor: m.receivedMinor, balanceMinor: m.amountMinor - m.receivedMinor })));
  },
});

defineReport({
  key: 'inactive-customers', module: 'selling', title: 'Customers with no recent sale', roles: SALES, filters: 'days:int',
  columns: 'code name lastSaleOn:date daysSince:int',
  async run({ days }) {
    const limit = Number(days) || 180;
    const today = todayIst();
    const customers = await Party.find({ isCustomer: true, isActive: true }, { code: 1, name: 1 }).lean();
    const last = await SalesInvoice.aggregate([{ $match: live }, { $group: { _id: '$partyId', lastSaleOn: { $max: '$postingDate' } } }]);
    return customers.map((c) => {
      const lastSaleOn = last.find((l) => String(l._id) === String(c._id))?.lastSaleOn ?? null;
      return { code: c.code, name: c.name, lastSaleOn, daysSince: lastSaleOn ? daysBetween(lastSaleOn, today) : null };
    }).filter((r) => r.daysSince === null || r.daysSince >= limit);
  },
});

const crmRoles = [...OFFICE, 'SALES'];
defineReport({ key: 'lead-by-status', module: 'crm', title: 'Leads by status', roles: crmRoles, source: 'Lead', filters: '', groupBy: { status: 'status' }, sums: { count: 1 }, sort: { count: -1 }, columns: 'status count:int', totals: 'count' });
defineReport({ key: 'lead-by-source', module: 'crm', title: 'Leads by source', roles: crmRoles, source: 'Lead', filters: '', groupBy: { source: '_labels.sourceId' }, sums: { count: 1 }, sort: { count: -1 }, columns: 'source count:int', totals: 'count' });
defineReport({ key: 'opportunity-pipeline', module: 'crm', title: 'Opportunity pipeline', roles: crmRoles, source: 'Opportunity', filters: '', match: { status: { $in: ['OPEN', 'QUOTATION'] } }, groupBy: { stage: '_labels.stageId' }, sums: { count: 1, amountPaise: 'amountPaise' }, sort: { amountPaise: -1 }, columns: 'stage count:int amountPaise:money', totals: 'count amountPaise' });
defineReport({ key: 'lost-opportunities', module: 'crm', title: 'Lost opportunities', roles: crmRoles, source: 'Opportunity', filters: '', match: { status: 'LOST' }, groupBy: { reason: '_labels.lostReasonId', competitor: '_labels.competitorId' }, sums: { count: 1, amountPaise: 'amountPaise' }, sort: { amountPaise: -1 }, columns: 'reason competitor count:int amountPaise:money', totals: 'count amountPaise' });
defineReport({
  key: 'lead-conversion', module: 'crm', title: 'Lead conversion', roles: crmRoles, filters: '',
  columns: 'heading value:int',
  async run() {
    const Lead = modelOf('Lead');
    const Opportunity = modelOf('Opportunity');
    const [total, converted, lost, opportunities, won] = await Promise.all([Lead.countDocuments(), Lead.countDocuments({ status: 'CONVERTED' }), Lead.countDocuments({ status: 'LOST' }), Opportunity.countDocuments(), Opportunity.countDocuments({ status: 'WON' })]);
    return [{ heading: 'Leads', value: total }, { heading: 'Converted', value: converted }, { heading: 'Lost', value: lost }, { heading: 'Opportunities', value: opportunities }, { heading: 'Opportunities won', value: won }];
  },
});

/* ---------- Buying ---------- */

defineReport({
  key: 'pending-po-items', module: 'buying', title: 'Purchase order items still to receive', roles: [...BUYING, 'STORES'], filters: '',
  columns: 'docNo partyName itemCode itemName expectedDate:date orderedMilli:qty receivedMilli:qty pendingMilli:qty',
  async run() {
    const orders = await PurchaseOrder.find({ status: 'APPROVED' }).sort({ expectedDate: 1 }).lean();
    return orders.flatMap((o) => o.lines.filter((l) => l.receivedMilli < l.qtyMilli).map((l) => ({ docNo: o.docNo, partyName: o.partyName, itemCode: l.itemCode, itemName: l.itemName, expectedDate: o.expectedDate, orderedMilli: l.qtyMilli, receivedMilli: l.receivedMilli, pendingMilli: l.qtyMilli - l.receivedMilli })));
  },
});
defineReport({
  key: 'received-not-billed', module: 'buying', title: 'Received but not billed', roles: BUYING, filters: '',
  columns: 'docNo partyName itemCode receivedMilli:qty billedMilli:qty unbilledMilli:qty valuePaise:money', totals: 'valuePaise',
  async run() {
    const receipts = await Grn.find(live).lean();
    return receipts.flatMap((g) => g.lines.filter((l) => l.billedMilli < l.qtyMilli).map((l) => ({ docNo: g.docNo, partyName: g.partyName, itemCode: l.itemCode, receivedMilli: l.qtyMilli, billedMilli: l.billedMilli, unbilledMilli: l.qtyMilli - l.billedMilli, valuePaise: mulDivRound(l.valuePaise, l.qtyMilli - l.billedMilli, l.qtyMilli) })));
  },
});
defineReport({ key: 'rejected-materials', module: 'buying', title: 'Rejected materials by supplier', roles: [...BUYING, 'QUALITY'], source: 'Grn', filters: DATES, dateField: 'postingDate', match: live, unwind: 'lines', lineMatch: { 'lines.rejectedMilli': { $gt: 0 } }, groupBy: { partyName: 'partyName', itemCode: 'lines.itemCode' }, sums: { receivedMilli: 'lines.qtyMilli', rejectedMilli: 'lines.rejectedMilli' }, sort: { rejectedMilli: -1 }, columns: 'partyName itemCode receivedMilli:qty rejectedMilli:qty' });
defineReport({
  key: 'quotation-comparison', module: 'buying', title: 'Supplier quotation comparison', roles: BUYING, filters: 'rfqId!:link(RequestForQuotation)',
  columns: 'item supplier ratePaise:money leadTimeDays:int isLowest:check',
  async run({ rfqId }) {
    if (!rfqId) throw rule('Choose a request for quotation.', 'RFQ_REQUIRED');
    const quotes = await modelOf('SupplierQuotation').find({ rfqId: String(rfqId), status: 'SUBMITTED' }).lean();
    const rows = quotes.flatMap((q) => q.lines.map((l) => ({ item: l._labels?.itemId, itemId: String(l.itemId), supplier: q._labels?.partyId, ratePaise: l.ratePaise, leadTimeDays: l.leadTimeDays })));
    return rows.map((row) => ({ ...row, isLowest: row.ratePaise === Math.min(...rows.filter((r) => r.itemId === row.itemId).map((r) => r.ratePaise)) })).sort((a, b) => String(a.item).localeCompare(String(b.item)) || a.ratePaise - b.ratePaise);
  },
});

/* ---------- Stock ---------- */

defineReport({
  key: 'low-stock', module: 'stock', title: 'Below reorder level', roles: STOCK, filters: '',
  columns: 'code name uom reorderLevelMilli:qty onHandMilli:qty shortMilli:qty',
  async run() {
    const items = await Item.find({ reorderLevelMilli: { $gt: 0 }, isActive: true }).lean();
    const stock = await Bin.aggregate([{ $group: { _id: '$itemId', qty: { $sum: '$qtyMilli' } } }]);
    return items.map((item) => {
      const onHand = stock.find((s) => String(s._id) === String(item._id))?.qty ?? 0;
      return { code: item.code, name: item.name, uom: item.uom, reorderLevelMilli: item.reorderLevelMilli, onHandMilli: onHand, shortMilli: item.reorderLevelMilli - onHand };
    }).filter((r) => r.shortMilli > 0);
  },
});
defineReport({
  key: 'stock-by-warehouse', module: 'stock', title: 'Stock value by warehouse', roles: STOCK, filters: '',
  columns: 'warehouse kind valuePaise:money buckets:int', totals: 'valuePaise',
  async run() {
    const rows = await Bin.aggregate([{ $match: { qtyMilli: { $gt: 0 } } }, { $group: { _id: '$warehouseId', valuePaise: { $sum: '$valuePaise' }, buckets: { $sum: 1 } } }]);
    const warehouses = await Warehouse.find().lean();
    return rows.map((r) => {
      const w = warehouses.find((x) => String(x._id) === String(r._id));
      return { warehouse: w?.name, kind: w?.kind, valuePaise: r.valuePaise, buckets: r.buckets };
    });
  },
});
defineReport({
  key: 'stock-ageing', module: 'stock', title: 'Stock ageing', roles: STOCK, filters: '',
  columns: 'itemCode itemName lastReceivedOn:date ageDays:int qtyMilli:qty valuePaise:money', totals: 'valuePaise',
  async run() {
    const today = todayIst();
    const bins = await Bin.aggregate([{ $match: { qtyMilli: { $gt: 0 } } }, { $group: { _id: '$itemId', qtyMilli: { $sum: '$qtyMilli' }, valuePaise: { $sum: '$valuePaise' } } }]);
    const lastIn = await StockEntry.aggregate([{ $match: { qtyMilli: { $gt: 0 }, isReversal: false } }, { $group: { _id: '$itemId', last: { $max: '$postingDate' } } }]);
    const items = await Item.find({ _id: { $in: bins.map((b) => b._id) } }, { code: 1, name: 1 }).lean();
    return bins.map((bin) => {
      const item = items.find((i) => String(i._id) === String(bin._id));
      const last = lastIn.find((l) => String(l._id) === String(bin._id))?.last ?? null;
      return { itemCode: item?.code, itemName: item?.name, lastReceivedOn: last, ageDays: last ? daysBetween(last, today) : null, qtyMilli: bin.qtyMilli, valuePaise: bin.valuePaise };
    }).sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0));
  },
});
defineReport({
  key: 'expiring-batches', module: 'stock', title: 'Batches expiring soon', roles: STOCK, filters: 'days:int',
  columns: 'batchNo item expiresOn:date daysLeft:int',
  async run({ days }) {
    const today = todayIst();
    const horizon = addDays(today, Number(days) || 90);
    const batches = await modelOf('Batch').find({ isActive: true, expiresOn: { $ne: null, $lte: horizon } }).sort({ expiresOn: 1 }).lean();
    return batches.map((b) => ({ batchNo: b.batchNo, item: b._labels?.itemId, expiresOn: b.expiresOn, daysLeft: daysBetween(today, b.expiresOn) }));
  },
});
defineReport({ key: 'serial-status', module: 'stock', title: 'Serial numbers by state', roles: STOCK, source: 'SerialNo', filters: '', groupBy: { item: '_labels.itemId', state: 'state' }, sums: { count: 1 }, sort: { item: 1 }, columns: 'item state count:int', totals: 'count' });
defineReport({ key: 'material-requests-open', module: 'stock', title: 'Material requests still open', roles: STOCK, source: 'MaterialRequest', filters: '', match: { status: 'SUBMITTED', state: 'OPEN' }, unwind: 'lines', project: { docNo: 'docNo', requiredBy: 'requiredBy', item: 'lines._labels.itemId', qtyMilli: 'lines.qtyMilli', orderedMilli: 'lines.orderedMilli' }, sort: { requiredBy: 1 }, columns: 'docNo requiredBy:date item qtyMilli:qty orderedMilli:qty' });
defineReport({ key: 'delivery-notes-unbilled', module: 'stock', title: 'Delivered but not invoiced', roles: [...STOCK, 'SALES'], source: 'DeliveryNote', filters: '', match: { status: 'SUBMITTED', isBilled: false }, project: { docNo: 'docNo', postingDate: 'postingDate', party: '_labels.partyId', totalCostPaise: 'totalCostPaise' }, sort: { postingDate: 1 }, columns: 'docNo postingDate:date party totalCostPaise:money', totals: 'totalCostPaise' });
defineReport({ key: 'item-prices', module: 'stock', title: 'Item prices', roles: 'ADMIN MANAGEMENT SALES PURCHASE ACCOUNTS STORES'.split(' '), source: 'ItemPrice', filters: '', project: { item: '_labels.itemId', priceList: '_labels.priceListId', ratePaise: 'ratePaise', validFrom: 'validFrom', validUpto: 'validUpto' }, sort: { item: 1 }, columns: 'item priceList ratePaise:money validFrom:date validUpto:date' });

/* ---------- Manufacturing ---------- */

defineReport({ key: 'work-order-summary', module: 'manufacturing', title: 'Work orders', roles: MAKE, source: 'WorkOrder', filters: DATES, dateField: 'postingDate', match: { status: 'SUBMITTED' }, project: { docNo: 'docNo', item: '_labels.itemId', state: 'state', qtyMilli: 'qtyMilli', producedMilli: 'producedMilli', wipPaise: 'wipPaise', producedValuePaise: 'producedValuePaise', plannedEnd: 'plannedEnd' }, sort: { plannedEnd: 1 }, columns: 'docNo item state qtyMilli:qty producedMilli:qty wipPaise:money producedValuePaise:money plannedEnd:date', totals: 'wipPaise producedValuePaise' });
defineReport({ key: 'job-card-summary', module: 'manufacturing', title: 'Job cards by workstation', roles: MAKE, source: 'JobCard', filters: DATES, dateField: 'postingDate', match: live, groupBy: { workstation: '_labels.workstationId', operation: '_labels.operationId' }, sums: { cards: 1, hoursMilli: 'hoursMilli', valuePaise: 'valuePaise' }, sort: { hoursMilli: -1 }, columns: 'workstation operation cards:int hoursMilli:qty:Hours valuePaise:money', totals: 'cards hoursMilli valuePaise' });
defineReport({
  key: 'downtime-analysis', module: 'manufacturing', title: 'Downtime', roles: MAKE, filters: '',
  columns: 'workstation reason events:int hoursMilli:qty:Hours', totals: 'events hoursMilli',
  async run() {
    const rows = await modelOf('DowntimeEntry').find({ toTime: { $ne: null } }).lean();
    const grouped = new Map();
    for (const row of rows) {
      const key = `${row._labels?.workstationId}|${row.reason}`;
      const entry = grouped.get(key) ?? { workstation: row._labels?.workstationId, reason: row.reason, events: 0, hoursMilli: 0 };
      entry.events += 1;
      entry.hoursMilli += Math.round((row.toTime - row.fromTime) / 3600);
      grouped.set(key, entry);
    }
    return [...grouped.values()].sort((a, b) => b.hoursMilli - a.hoursMilli);
  },
});
defineReport({
  key: 'bom-stock', module: 'manufacturing', title: 'Can we build it? BOM against stock', roles: MAKE, filters: 'bomId!:link(Bom) qty:int',
  columns: 'itemCode itemName requiredMilli:qty onHandMilli:qty shortMilli:qty',
  async run({ bomId, qty }) {
    if (!bomId) throw rule('Choose a BOM.', 'BOM_REQUIRED');
    const { Bom } = await import('../models/documents.js');
    const { explodeBom } = await import('../services/buildService.js');
    const bom = await Bom.findById(bomId).lean();
    const parts = await explodeBom(null, bom, (Number(qty) || 1) * 1000);
    const stores = await Warehouse.find({ kind: 'STORES' }, { _id: 1 }).lean();
    const stock = await Bin.aggregate([{ $match: { warehouseId: { $in: stores.map((w) => w._id) }, itemId: { $in: parts.map((p) => p.itemId) } } }, { $group: { _id: '$itemId', qty: { $sum: '$qtyMilli' } } }]);
    return parts.map((part) => {
      const onHand = stock.find((s) => String(s._id) === String(part.itemId))?.qty ?? 0;
      return { itemCode: part.itemCode, itemName: part.itemName, requiredMilli: part.requiredMilli, onHandMilli: onHand, shortMilli: Math.max(0, part.requiredMilli - onHand) };
    });
  },
});
defineReport({ key: 'build-costs', module: 'manufacturing', title: 'Machine cost against order value', roles: FINANCE, source: 'MachineBuild', filters: '', match: { stage: { $ne: 'CANCELLED' } }, project: { serialNo: 'serialNo', itemName: 'itemName', partyName: 'partyName', stage: 'stage', budgetPaise: 'budgetPaise', materialCostPaise: 'materialCostPaise', labourCostPaise: 'labourCostPaise', otherCostPaise: 'otherCostPaise' }, sort: { serialNo: 1 }, columns: 'serialNo itemName partyName stage budgetPaise:money materialCostPaise:money labourCostPaise:money otherCostPaise:money marginPaise:money', totals: 'budgetPaise materialCostPaise labourCostPaise otherCostPaise marginPaise', after: (rows) => rows.map((r) => ({ ...r, marginPaise: r.budgetPaise - r.materialCostPaise - r.labourCostPaise - r.otherCostPaise })) });
defineReport({
  key: 'late-builds', module: 'manufacturing', title: 'Machines past their date', roles: [...MAKE, 'SALES'], filters: '',
  columns: 'serialNo itemName partyName stage targetDate:date daysLate:int',
  async run() {
    const today = todayIst();
    const rows = await MachineBuild.find({ stage: { $in: ['PLANNED', 'PROCUREMENT', 'FABRICATION', 'ASSEMBLY', 'FAT', 'READY'] }, targetDate: { $ne: null, $lt: today } }).sort({ targetDate: 1 }).lean();
    return rows.map((b) => ({ serialNo: b.serialNo, itemName: b.itemName, partyName: b.partyName, stage: b.stage, targetDate: b.targetDate, daysLate: daysBetween(b.targetDate, today) }));
  },
});

/* ---------- Projects ---------- */

defineReport({ key: 'project-summary', module: 'projects', title: 'Projects', roles: [...OFFICE, 'PRODUCTION', 'ENGINEERING', 'SERVICE', 'SALES'], source: 'Project', filters: '', project: { docNo: 'docNo', name: 'name', party: '_labels.partyId', status: 'status', endDate: 'endDate', progressBps: 'progressBps', budgetPaise: 'budgetPaise', costPaise: 'costPaise' }, sort: { endDate: 1 }, columns: 'docNo name party status endDate:date progressBps:pct:Progress budgetPaise:money costPaise:money', totals: 'budgetPaise costPaise' });
defineReport({
  key: 'delayed-tasks', module: 'projects', title: 'Tasks past their date', roles: [...OFFICE, 'PRODUCTION', 'ENGINEERING', 'SERVICE', 'SALES'], filters: '',
  columns: 'docNo subject project assignedTo dueDate:date daysLate:int',
  async run() {
    const today = todayIst();
    const rows = await modelOf('Task').find({ status: { $nin: ['DONE', 'CANCELLED'] }, dueDate: { $ne: null, $lt: today } }).sort({ dueDate: 1 }).lean();
    return rows.map((t) => ({ docNo: t.docNo, subject: t.subject, project: t._labels?.projectId, assignedTo: t._labels?.assignedTo, dueDate: t.dueDate, daysLate: daysBetween(t.dueDate, today) }));
  },
});
defineReport({ key: 'timesheet-hours', module: 'projects', title: 'Hours by person and project', roles: [...OFFICE, 'PRODUCTION', 'ENGINEERING', 'ACCOUNTS', 'HR'], source: 'Timesheet', filters: DATES, dateField: 'postingDate', match: live, groupBy: { employee: '_labels.employeeId', project: '_labels.projectId' }, sums: { hoursMilli: 'totalHoursMilli', costPaise: 'totalCostPaise' }, sort: { hoursMilli: -1 }, columns: 'employee project hoursMilli:qty:Hours costPaise:money', totals: 'hoursMilli costPaise' });

/* ---------- Quality, support, service ---------- */

defineReport({ key: 'ncr-summary', module: 'quality', title: 'Non-conformance by source', roles: QA, source: 'Ncr', filters: DATES, dateField: 'postingDate', groupBy: { source: 'source', status: 'status' }, sums: { count: 1 }, sort: { count: -1 }, columns: 'source status count:int', totals: 'count' });
defineReport({ key: 'fat-results', module: 'quality', title: 'FAT results', roles: QA, source: 'FatProtocol', filters: DATES, dateField: 'postingDate', match: { status: { $in: ['PASSED', 'FAILED'] } }, project: { docNo: 'docNo', postingDate: 'postingDate', serialNo: 'serialNo', attempt: 'attempt', witnessName: 'witnessName', status: 'status' }, sort: { postingDate: 1 }, columns: 'docNo postingDate:date serialNo attempt:int witnessName status' });
defineReport({
  key: 'calibration-due', module: 'quality', title: 'Calibration due', roles: QA, filters: 'days:int',
  columns: 'code name dueOn:date daysLeft:int certRef',
  async run({ days }) {
    const today = todayIst();
    const horizon = addDays(today, Number(days) || 30);
    const rows = await Gauge.find({ isActive: true, dueOn: { $ne: null, $lte: horizon } }).sort({ dueOn: 1 }).lean();
    return rows.map((g) => ({ code: g.code, name: g.name, dueOn: g.dueOn, daysLeft: daysBetween(today, g.dueOn), certRef: g.certRef }));
  },
});
defineReport({
  key: 'open-ncr-age', module: 'quality', title: 'Open non-conformances by age', roles: QA, filters: '',
  columns: 'docNo source serialNo description raisedOn:date ageDays:int',
  async run() {
    const today = todayIst();
    const rows = await Ncr.find({ status: 'OPEN' }).sort({ postingDate: 1 }).lean();
    return rows.map((n) => ({ docNo: n.docNo, source: n.source, serialNo: n.serialNo, description: n.description, raisedOn: n.postingDate, ageDays: daysBetween(n.postingDate, today) }));
  },
});
defineReport({ key: 'issue-analytics', module: 'support', title: 'Issues by status and priority', roles: CARE, source: 'Issue', filters: '', groupBy: { status: 'status', priority: '_labels.priorityId' }, sums: { count: 1 }, sort: { count: -1 }, columns: 'status priority count:int', totals: 'count' });
defineReport({ key: 'sla-breaches', module: 'support', title: 'SLA breaches', roles: CARE, source: 'Issue', filters: '', match: { isSlaBreached: true }, project: { docNo: 'docNo', subject: 'subject', party: '_labels.partyId', status: 'status', resolveBy: 'resolveBy' }, sort: { resolveBy: -1 }, columns: 'docNo subject party status resolveBy:datetime' });
defineReport({
  key: 'warranty-status', module: 'support', title: 'Machines by warranty and AMC', roles: CARE, filters: '',
  columns: 'serialNo itemName partyName installedOn:date warrantyUntil:date cover',
  async run() {
    const today = todayIst();
    const rows = await MachineBuild.find({ stage: { $in: ['INSTALLED', 'CLOSED'] } }).lean();
    const { AmcContract } = await import('../models/documents.js');
    const amc = await AmcContract.find({ status: 'ACTIVE', endDate: { $gte: today } }, { buildId: 1 }).lean();
    return rows.map((b) => ({ serialNo: b.serialNo, itemName: b.itemName, partyName: b.partyName, installedOn: b.installedOn, warrantyUntil: b.warrantyUntil, cover: b.warrantyUntil >= today ? 'Warranty' : amc.some((a) => String(a.buildId) === String(b._id)) ? 'AMC' : 'None' }));
  },
});
defineReport({
  key: 'amc-expiring', module: 'support', title: 'AMC contracts expiring', roles: CARE, filters: 'days:int',
  columns: 'docNo serialNo partyName endDate:date daysLeft:int valuePaise:money',
  async run({ days }) {
    const { AmcContract } = await import('../models/documents.js');
    const today = todayIst();
    const rows = await AmcContract.find({ status: 'ACTIVE', endDate: { $gte: today, $lte: addDays(today, Number(days) || 60) } }).sort({ endDate: 1 }).lean();
    return rows.map((a) => ({ docNo: a.docNo, serialNo: a.serialNo, partyName: a.partyName, endDate: a.endDate, daysLeft: daysBetween(today, a.endDate), valuePaise: a.valuePaise }));
  },
});
defineReport({ key: 'maintenance-due', module: 'maintenance', title: 'Maintenance visits due', roles: CARE, source: 'MaintenanceSchedule', filters: '', match: { status: 'ACTIVE' }, unwind: 'slots', lineMatch: { 'slots.isDone': false }, project: { docNo: 'docNo', party: '_labels.partyId', machine: '_labels.buildId', onDate: 'slots.onDate', engineer: 'slots.engineer' }, sort: { 'slots.onDate': 1 }, columns: 'docNo party machine onDate:date engineer' });

/* ---------- HR and payroll ---------- */

defineReport({ key: 'employee-directory', module: 'hr', title: 'Employee directory', roles: HR, source: 'Employee', filters: '', match: { state: 'ACTIVE' }, project: { docNo: 'docNo', fullName: 'fullName', department: '_labels.departmentId', designation: '_labels.designationId', joiningDate: 'joiningDate', mobile: 'mobile', email: 'email' }, sort: { fullName: 1 }, columns: 'docNo fullName department designation joiningDate:date mobile email' });
defineReport({ key: 'headcount', module: 'hr', title: 'Headcount by department', roles: HR, source: 'Employee', filters: '', match: { state: 'ACTIVE' }, groupBy: { department: '_labels.departmentId' }, sums: { count: 1 }, sort: { count: -1 }, columns: 'department count:int', totals: 'count' });
defineReport({ key: 'monthly-attendance', module: 'hr', title: 'Attendance summary', roles: HR, source: 'Attendance', filters: DATES, dateField: 'onDate', groupBy: { employee: '_labels.employeeId', state: 'state' }, sums: { days: 1 }, sort: { employee: 1 }, columns: 'employee state days:int' });
defineReport({
  key: 'leave-balance', module: 'hr', title: 'Leave balance', roles: HR, filters: 'periodId!:link(LeavePeriod)',
  columns: 'employee leaveType allocatedDaysHalf:int:Allocated_half_days takenDaysHalf:int:Taken_half_days balanceDaysHalf:int:Left_half_days',
  async run({ periodId }) {
    if (!periodId) throw rule('Choose a leave period.', 'PERIOD_REQUIRED');
    const period = await modelOf('LeavePeriod').findById(periodId).lean();
    const allocations = await modelOf('LeaveAllocation').find({ periodId: String(periodId), status: 'SUBMITTED' }).lean();
    const rows = new Map();
    for (const a of allocations) {
      const key = `${a.employeeId}|${a.leaveTypeId}`;
      const row = rows.get(key) ?? { employee: a._labels?.employeeId, leaveType: a._labels?.leaveTypeId, employeeId: String(a.employeeId), leaveTypeId: String(a.leaveTypeId), allocatedDaysHalf: 0, takenDaysHalf: 0 };
      row.allocatedDaysHalf += a.halfDays;
      rows.set(key, row);
    }
    const taken = await modelOf('LeaveApplication').find({ status: 'SUBMITTED', fromDate: { $gte: period.fromDate }, toDate: { $lte: period.toDate } }).lean();
    for (const t of taken) {
      const row = rows.get(`${t.employeeId}|${t.leaveTypeId}`);
      if (row) row.takenDaysHalf += t.halfDays;
    }
    return [...rows.values()].map((r) => ({ ...r, balanceDaysHalf: r.allocatedDaysHalf - r.takenDaysHalf }));
  },
});
defineReport({ key: 'expense-claims', module: 'hr', title: 'Expense claims', roles: PAY, source: 'ExpenseClaim', filters: DATES, dateField: 'postingDate', match: live, project: { docNo: 'docNo', postingDate: 'postingDate', employee: '_labels.employeeId', totalPaise: 'totalPaise', advanceUsedPaise: 'advanceUsedPaise', payablePaise: 'payablePaise', paidPaise: 'paidPaise' }, sort: { postingDate: 1 }, columns: 'docNo postingDate:date employee totalPaise:money advanceUsedPaise:money payablePaise:money paidPaise:money', totals: 'totalPaise payablePaise paidPaise' });
defineReport({ key: 'recruitment-funnel', module: 'hr', title: 'Recruitment by state', roles: HR, source: 'JobApplicant', filters: '', groupBy: { opening: '_labels.jobOpeningId', state: 'state' }, sums: { count: 1 }, sort: { count: -1 }, columns: 'opening state count:int', totals: 'count' });
defineReport({ key: 'salary-register', module: 'payroll', title: 'Salary register', roles: PAY, source: 'SalarySlip', filters: DATES, dateField: 'startDate', match: live, project: { docNo: 'docNo', employee: '_labels.employeeId', startDate: 'startDate', grossPaise: 'grossPaise', pfEmployeePaise: 'pfEmployeePaise', esiEmployeePaise: 'esiEmployeePaise', professionalTaxPaise: 'professionalTaxPaise', tdsPaise: 'tdsPaise', netPaise: 'netPaise' }, sort: { startDate: 1 }, columns: 'docNo employee startDate:date grossPaise:money pfEmployeePaise:money:PF esiEmployeePaise:money:ESI professionalTaxPaise:money:PT tdsPaise:money:TDS netPaise:money', totals: 'grossPaise pfEmployeePaise esiEmployeePaise professionalTaxPaise tdsPaise netPaise' });
defineReport({ key: 'pf-esi-register', module: 'payroll', title: 'PF and ESI register', roles: PAY, source: 'SalarySlip', filters: DATES, dateField: 'startDate', match: live, groupBy: { month: 'startDate' }, sums: { employees: 1, pfEmployeePaise: 'pfEmployeePaise', pfEmployerPaise: 'pfEmployerPaise', esiEmployeePaise: 'esiEmployeePaise', esiEmployerPaise: 'esiEmployerPaise' }, sort: { month: 1 }, columns: 'month:date employees:int pfEmployeePaise:money pfEmployerPaise:money esiEmployeePaise:money esiEmployerPaise:money', totals: 'pfEmployeePaise pfEmployerPaise esiEmployeePaise esiEmployerPaise' });

