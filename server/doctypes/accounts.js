// Accounts beyond invoices and payments: cost centres, budgets, banking, closing,
// revaluation, withholding tax, subscriptions, deferred income, shareholders.
import { define, modelOf } from '../engine/registry.js';
import { A } from '../config/accounts.js';
import { Settings } from '../models/core.js';
import { GlEntry } from '../models/ledgers.js';
import { Account } from '../models/masters.js';
import { PurchaseInvoice, SalesInvoice } from '../models/documents.js';
import { postGl } from '../services/ledgerService.js';
import { applyBps, allocate, mulDivRound, sumInts, toBasePaise } from '../utils/money.js';
import { addMonths, daysBetween, todayIst } from '../utils/dates.js';
import { conflict, rule } from '../utils/errors.js';

const m = (name, fields, extra = {}) => define({ name, module: 'accounts', fields, ...extra });
const tree = (name, fields, extra = {}) => m(name, `${fields} parentId:link(${name}) isGroup:check`, { tree: true, ...extra });

tree('CostCenter', 'name!* code', { readers: 'all' });
m('CostCenterAllocation', 'mainCostCenterId!:link(CostCenter) validFrom!:date', { tables: { shares: 'costCenterId!:link(CostCenter) percentBps!:pct' }, labelFields: ['mainCostCenterId'] });
m('FinanceBook', 'name!* description');
m('ModeOfPayment', 'name!* kind:select(CASH,BANK,CHEQUE,UPI,CARD,GENERAL)=BANK accountCode:link(Account;isCashOrBank=true) isActive:check=true', { readers: 'all' });
m('PaymentTerm', 'name!* creditDays:int discountBps:pct description');
m('PaymentTermsTemplate', 'name!*', { tables: { terms: 'termId!:link(PaymentTerm) portionBps!:pct creditDays:int' }, readers: 'all' });
m('TaxCategory', 'name!* description', { readers: 'all' });
m('SalesTaxTemplate', 'name!* taxCategoryId:link(TaxCategory) isDefault:check', { tables: { rows: 'accountCode!:link(Account) rateBps!:pct description' }, readers: 'all' });
m('PurchaseTaxTemplate', 'name!* taxCategoryId:link(TaxCategory) isDefault:check', { tables: { rows: 'accountCode!:link(Account) rateBps!:pct description' }, readers: 'all' });
m('ItemTaxTemplate', 'name!* gstRateBps!:pct hsn', { readers: 'all' });
m('TaxRule', 'name!* forSales:check=true partyId:link(Party) taxCategoryId:link(TaxCategory) stateCode templateName priority:int=1', { readers: 'all' });
m('MonthlyDistribution', 'name!* fiscalYearId:link(FiscalYear)', { tables: { months: 'month! percentBps!:pct' } });
m('DunningType', 'name!* interestBps:pct feePaise:money letterText:long');
m('JournalTemplate', 'name!* narration', { tables: { lines: 'accountCode!:link(Account)' } });
m('ChequePrintTemplate', 'name!* bankId:link(Bank) widthMilli:qty heightMilli:qty');
m('Bank', 'name!* swift website', { readers: 'all' });
m('ShareType', 'name!* description');
m('Shareholder', 'name!* folioNo pan email:email');
m('ShareTransfer', 'kind:select(ISSUE,PURCHASE,TRANSFER)=ISSUE onDate!:date fromId:link(Shareholder) toId:link(Shareholder) shareTypeId!:link(ShareType) count!:int ratePaise!:money', { series: 'SHT', dateField: 'onDate', labelFields: ['docNo'], list: 'docNo kind onDate fromId toId count ratePaise' });
m('BankGuarantee', 'kind:select(RECEIVING,PROVIDING)=RECEIVING partyId!:link(Party) bankId!:link(Bank) guaranteeNo! amountPaise!:money startDate!:date endDate!:date salesOrderId:link(SalesOrder) status:select(ACTIVE,RELEASED,INVOKED)=ACTIVE', { list: 'guaranteeNo kind partyId amountPaise endDate status', dateField: 'endDate' });
m('BankAccount', 'name!* bankId:link(Bank) accountNo ifsc accountCode!:link(Account;isCashOrBank=true) isDefault:check', { list: 'name bankId accountNo accountCode' });

// An expense budget per cost centre. postGl reads this, so a STOP budget cannot be beaten
// by posting another way.
m('Budget', 'costCenterId!:link(CostCenter) accountCode!:link(Account) fiscalYearId!:link(FiscalYear) amountPaise!:money onExceed:select(STOP,WARN,IGNORE)=STOP', {
  labelFields: ['costCenterId', 'accountCode'],
  list: 'costCenterId accountCode fiscalYearId amountPaise onExceed',
  index: [{ costCenterId: 1, accountCode: 1 }],
});

/* ---------- Banking ---------- */

// A line on the bank's statement. Reconciling ties it to a posted voucher on that account.
m('BankTransaction', 'bankAccountId!:link(BankAccount) onDate!:date depositPaise:money withdrawalPaise:money reference description state~:select(UNRECONCILED,RECONCILED)=UNRECONCILED voucherNo~ clearedOn~:date', {
  list: 'bankAccountId onDate depositPaise withdrawalPaise reference state',
  labelFields: ['reference', 'onDate'],
  dateField: 'onDate',
  deletable: false,
  searchFields: ['reference', 'description', 'voucherNo'],
  actions: [
    {
      key: 'reconcile',
      label: 'Match to a voucher',
      primary: true,
      when: { state: ['UNRECONCILED'] },
      fields: 'voucherNo!',
      async run(session, doc, body) {
        if (!body.voucherNo) throw rule('Enter the voucher number.', 'VOUCHER_REQUIRED');
        const bank = await modelOf('BankAccount').findById(doc.bankAccountId).session(session).lean();
        const rows = await GlEntry.find({ accountCode: bank.accountCode, voucherNo: body.voucherNo, isReversal: false }).session(session).lean();
        const net = rows.reduce((sum, r) => sum + r.debitPaise - r.creditPaise, 0);
        if (rows.length === 0) throw rule('No such voucher on this bank account.', 'VOUCHER_NOT_FOUND');
        if (net !== doc.depositPaise - doc.withdrawalPaise) throw rule(`That voucher moved ${net / 100}, and this statement line is ${(doc.depositPaise - doc.withdrawalPaise) / 100}.`, 'AMOUNT_MISMATCH');
        const used = await modelOf('BankTransaction').countDocuments({ _id: { $ne: doc._id }, bankAccountId: doc.bankAccountId, voucherNo: body.voucherNo }).session(session);
        if (used > 0) throw conflict('That voucher is already matched to another statement line.', 'VOUCHER_ALREADY_MATCHED');
        doc.voucherNo = body.voucherNo;
        doc.state = 'RECONCILED';
        doc.clearedOn = doc.onDate;
        await doc.save({ session });
        return doc;
      },
    },
    {
      key: 'unreconcile',
      label: 'Undo match',
      when: { state: ['RECONCILED'] },
      fields: '',
      async run(session, doc) {
        doc.voucherNo = '';
        doc.state = 'UNRECONCILED';
        doc.clearedOn = null;
        await doc.save({ session });
        return doc;
      },
    },
  ],
});

m('PaymentRequest', 'kind:select(INWARD,OUTWARD)=INWARD partyId!:link(Party) salesInvoiceId:link(SalesInvoice) purchaseInvoiceId:link(PurchaseInvoice) amountPaise!:money email:email message:long state~:select(DRAFT,SENT,PAID,CANCELLED)=DRAFT', {
  series: 'PQ',
  labelFields: ['docNo'],
  list: 'docNo kind partyId amountPaise state',
  actions: [{
    key: 'send',
    label: 'Email request',
    primary: true,
    when: { state: ['DRAFT'] },
    fields: '',
    async run(session, doc) {
      if (!doc.email) throw rule('Enter an email address first.', 'EMAIL_REQUIRED');
      const { queueEmail } = await import('../services/notifyService.js');
      await queueEmail(session, { to: doc.email, subject: `Payment request ${doc.docNo}`, body: `${doc.message || 'Please arrange payment.'}\n\nAmount: Rs ${doc.amountPaise / 100}` });
      doc.state = 'SENT';
      await doc.save({ session });
      return doc;
    },
  }],
});
m('PaymentOrder', 'bankAccountId!:link(BankAccount) onDate!:date totalPaise~:money', {
  series: 'PA',
  labelFields: ['docNo'],
  dateField: 'onDate',
  tables: { lines: 'partyId!:link(Party) amountPaise!:money reference' },
  list: 'docNo bankAccountId onDate totalPaise',
  prepare: (_s, data) => ({ ...data, totalPaise: sumInts((data.lines ?? []).map((l) => l.amountPaise)) }),
});

/* ---------- Collections ---------- */

m('Dunning', 'partyId!:link(Party) typeId:link(DunningType) onDate!:date totalPaise~:money feePaise~:money interestPaise~:money letter:long', {
  series: 'DU',
  labelFields: ['docNo'],
  dateField: 'onDate',
  tables: { 'invoices~': 'salesInvoiceId:link(SalesInvoice) dueDate:date overdueDays:int outstandingPaise:money' },
  list: 'docNo partyId onDate totalPaise',
  actions: [{
    key: 'fetchOverdue',
    label: 'Fetch overdue invoices',
    primary: true,
    when: {},
    fields: '',
    async run(session, doc) {
      const invoices = await SalesInvoice.find({ partyId: doc.partyId, status: 'SUBMITTED', dueDate: { $lt: doc.onDate } }).session(session).lean();
      const open = invoices.filter((i) => i.totalPaise - i.paidPaise - i.creditedPaise > 0);
      if (open.length === 0) throw rule('Nothing is overdue from this party.', 'NOTHING_OVERDUE');
      const type = doc.typeId ? await modelOf('DunningType').findById(doc.typeId).session(session).lean() : null;
      doc.invoices = open.map((i) => ({ salesInvoiceId: String(i._id), dueDate: i.dueDate, overdueDays: daysBetween(i.dueDate, doc.onDate), outstandingPaise: i.totalPaise - i.paidPaise - i.creditedPaise, _labels: { salesInvoiceId: i.docNo } }));
      const total = sumInts(doc.invoices.map((row) => row.outstandingPaise));
      doc.interestPaise = type?.interestBps ? sumInts(doc.invoices.map((row) => mulDivRound(applyBps(row.outstandingPaise, type.interestBps), row.overdueDays, 365))) : 0;
      doc.feePaise = type?.feePaise ?? 0;
      doc.totalPaise = total + doc.interestPaise + doc.feePaise;
      doc.letter = type?.letterText ?? doc.letter;
      await doc.save({ session });
      return doc;
    },
  }],
});

/* ---------- Withholding tax ---------- */

m('TaxWithholdingCategory', 'name!* section rateBps!:pct singleThresholdPaise:money annualThresholdPaise:money payableAccountCode:link(Account)', { list: 'name section rateBps annualThresholdPaise' });

// TDS deducted from a supplier's invoice. It reduces what we owe them, and creates what we
// owe the government. The threshold test counts earlier invoices from them this year.
define({
  name: 'TdsDeduction',
  module: 'accounts',
  series: 'TD',
  submittable: true,
  labelFields: ['docNo'],
  fields: 'purchaseInvoiceId!:link(PurchaseInvoice) categoryId!:link(TaxWithholdingCategory) basePaise~:money ratePaise~:pct tdsPaise~:money',
  list: 'docNo purchaseInvoiceId categoryId basePaise tdsPaise',
  labels: { ratePaise: 'Rate' },
  async onSubmit(session, doc) {
    const invoice = await PurchaseInvoice.findById(doc.purchaseInvoiceId).session(session);
    if (!invoice || invoice.status !== 'SUBMITTED') throw rule('That invoice is not live.', 'INVOICE_NOT_SUBMITTED');
    const already = await modelOf('TdsDeduction').countDocuments({ purchaseInvoiceId: doc.purchaseInvoiceId, status: 'SUBMITTED' }).session(session);
    if (already > 0) throw conflict('TDS has already been deducted on this invoice.', 'TDS_ALREADY_DEDUCTED');
    const category = await modelOf('TaxWithholdingCategory').findById(doc.categoryId).session(session).lean();
    const fy = doc.postingDate.slice(5, 7) >= '04' ? doc.postingDate.slice(0, 4) : String(Number(doc.postingDate.slice(0, 4)) - 1);
    const earlier = await PurchaseInvoice.find({ partyId: invoice.partyId, status: 'SUBMITTED', postingDate: { $gte: `${fy}-04-01`, $lte: doc.postingDate } }, { taxablePaise: 1 }).session(session).lean();
    const yearTotal = sumInts(earlier.map((i) => i.taxablePaise));
    const overSingle = category.singleThresholdPaise > 0 && invoice.taxablePaise > category.singleThresholdPaise;
    const overAnnual = category.annualThresholdPaise > 0 && yearTotal > category.annualThresholdPaise;
    const noThreshold = category.singleThresholdPaise === 0 && category.annualThresholdPaise === 0;
    if (!noThreshold && !overSingle && !overAnnual) throw rule('This supplier is under the threshold, so no TDS is due.', 'UNDER_TDS_THRESHOLD');
    doc.basePaise = invoice.taxablePaise;
    // A certificate from the tax office lowers the rate for this supplier, for its dates.
    const certificate = await modelOf('LowerDeductionCertificate').findOne({ partyId: String(invoice.partyId), categoryId: String(doc.categoryId), validFrom: { $lte: doc.postingDate }, validUpto: { $gte: doc.postingDate } }).session(session).lean();
    const rate = certificate ? certificate.rateBps : category.rateBps;
    doc.ratePaise = rate;
    doc.tdsPaise = applyBps(invoice.taxablePaise, rate);
    if (doc.tdsPaise > invoice.totalPaise - invoice.paidPaise - invoice.creditedPaise) throw rule('Less than the TDS is left unpaid on this invoice.', 'NOTE_TOO_LARGE');
    invoice.creditedPaise += doc.tdsPaise;
    await invoice.save({ session });
    await postGl(session, {
      postingDate: doc.postingDate, voucherType: 'TdsDeduction', voucherId: doc._id, voucherNo: doc.docNo, narration: `TDS on ${invoice.docNo}`,
      lines: [{ accountCode: A.CREDITORS, debitPaise: doc.tdsPaise, partyId: invoice.partyId }, { accountCode: category.payableAccountCode || A.TDS_PAYABLE, creditPaise: doc.tdsPaise }],
    });
    return { action: 'TDS_DEDUCTED', data: { tdsPaise: doc.tdsPaise, invoiceNo: invoice.docNo } };
  },
  async onCancel(session, doc) {
    const invoice = await PurchaseInvoice.findById(doc.purchaseInvoiceId).session(session);
    invoice.creditedPaise -= doc.tdsPaise;
    await invoice.save({ session });
  },
});

/* ---------- Closing and revaluation ---------- */

// Moves the year's income and expense into retained earnings, and locks the year. It is
// final: reversing it dated today would put last year's profit into this year's accounts.
define({
  name: 'PeriodClosingVoucher',
  module: 'accounts',
  series: 'PC',
  submittable: true,
  labelFields: ['docNo'],
  fields: 'fiscalYearId!:link(FiscalYear) profitPaise~:smoney',
  list: 'docNo fiscalYearId profitPaise',
  submitLabel: 'Close the year',
  hint: 'This cannot be undone. The year is locked afterwards.',
  async prepare(session, data) {
    const year = await modelOf('FiscalYear').findById(data.fiscalYearId).session(session).lean();
    if (!year) throw rule('That fiscal year does not exist.', 'LINK_NOT_FOUND');
    return { ...data, postingDate: year.endDate };
  },
  async onSubmit(session, doc) {
    const year = await modelOf('FiscalYear').findById(doc.fiscalYearId).session(session);
    if (year.isClosed) throw conflict('That year is already closed.', 'YEAR_CLOSED');
    if (year.endDate >= todayIst()) throw rule('A year can only be closed after it has ended.', 'YEAR_NOT_ENDED');
    const accounts = await Account.find({ type: { $in: ['INCOME', 'EXPENSE'] } }, { code: 1 }).session(session).lean();
    const balances = await GlEntry.aggregate([
      { $match: { accountCode: { $in: accounts.map((a) => a.code) }, postingDate: { $gte: year.startDate, $lte: year.endDate } } },
      { $group: { _id: '$accountCode', net: { $sum: { $subtract: ['$debitPaise', '$creditPaise'] } } } },
    ]).session(session);
    const lines = [];
    let profit = 0;
    for (const row of balances) {
      if (row.net === 0) continue;
      profit -= row.net;
      lines.push(row.net > 0 ? { accountCode: row._id, creditPaise: row.net } : { accountCode: row._id, debitPaise: -row.net });
    }
    if (lines.length === 0) throw rule('That year has no income or expense to close.', 'NOTHING_TO_CLOSE');
    lines.push(profit >= 0 ? { accountCode: A.RETAINED, creditPaise: profit } : { accountCode: A.RETAINED, debitPaise: -profit });
    doc.profitPaise = profit;
    await postGl(session, { postingDate: doc.postingDate, voucherType: 'PeriodClosingVoucher', voucherId: doc._id, voucherNo: doc.docNo, narration: `Closing ${year.name}`, lines });
    year.isClosed = true;
    await year.save({ session });
    await Settings.updateOne({ _id: 'company' }, { booksLockedUpTo: year.endDate }, { session });
    return { action: 'YEAR_CLOSED', data: { profitPaise: profit, year: year.name } };
  },
  async onCancel() {
    throw rule('A closed year cannot be reopened this way. Speak to your CA and post a journal.', 'CLOSING_IS_FINAL');
  },
});

// Restates what foreign customers owe at today's rate. Cancelling it, typically at the start
// of the next period, reverses the entry, which is the usual treatment.
define({
  name: 'ExchangeRateRevaluation',
  module: 'accounts',
  series: 'XR',
  submittable: true,
  labelFields: ['docNo'],
  fields: 'currency!=USD rateFx4!:fx gainPaise~:smoney',
  tables: { 'lines~': 'salesInvoiceId:link(SalesInvoice) partyId:link(Party) outstandingMinor:money bookPaise:money newPaise:money differencePaise:smoney' },
  list: 'docNo currency rateFx4 gainPaise',
  async onSubmit(session, doc) {
    const invoices = await SalesInvoice.find({ status: 'SUBMITTED', currency: doc.currency }).session(session).lean();
    const lines = [];
    const gl = [];
    let net = 0;
    for (const invoice of invoices) {
      const outstanding = invoice.totalMinor - invoice.paidMinor - invoice.creditedMinor;
      if (outstanding <= 0) continue;
      const book = mulDivRound(invoice.totalPaise, outstanding, invoice.totalMinor);
      const now = toBasePaise(outstanding, doc.rateFx4);
      const difference = now - book;
      lines.push({ salesInvoiceId: String(invoice._id), partyId: String(invoice.partyId), outstandingMinor: outstanding, bookPaise: book, newPaise: now, differencePaise: difference, _labels: { salesInvoiceId: invoice.docNo, partyId: invoice.partyName } });
      if (difference > 0) gl.push({ accountCode: A.DEBTORS, debitPaise: difference, partyId: invoice.partyId });
      if (difference < 0) gl.push({ accountCode: A.DEBTORS, creditPaise: -difference, partyId: invoice.partyId });
      net += difference;
    }
    if (lines.length === 0) throw rule(`No ${doc.currency} invoices are open.`, 'NOTHING_TO_REVALUE');
    if (net > 0) gl.push({ accountCode: A.UNREALISED_FOREX, creditPaise: net });
    if (net < 0) gl.push({ accountCode: A.UNREALISED_FOREX, debitPaise: -net });
    doc.lines = lines;
    doc.gainPaise = net;
    await postGl(session, { postingDate: doc.postingDate, voucherType: 'ExchangeRateRevaluation', voucherId: doc._id, voucherNo: doc.docNo, narration: `Revaluation of ${doc.currency}`, lines: gl });
    return { action: 'CURRENCY_REVALUED', data: { gainPaise: net } };
  },
});

/* ---------- Deferred income and expense ---------- */

// Income billed now but earned over months, like an AMC. Moved out at the start, and a
// monthly job releases it evenly. The last month takes whatever rounding left.
define({
  name: 'DeferredSchedule',
  module: 'accounts',
  series: 'DF',
  submittable: true,
  labelFields: ['docNo'],
  fields: 'kind:select(INCOME,EXPENSE)=INCOME sourceAccountCode!:link(Account) amountPaise!:money startDate!:date months!:int reference',
  tables: { 'rows~': 'onDate:date amountPaise:money isPosted:check voucherNo' },
  list: 'docNo kind sourceAccountCode amountPaise startDate months',
  async onSubmit(session, doc) {
    if (doc.months < 1) throw rule('Spread it over at least one month.', 'BAD_MONTHS');
    const shares = allocate(doc.amountPaise, Array(doc.months).fill(1));
    doc.rows = shares.map((amountPaise, i) => ({ onDate: addMonths(doc.startDate, i), amountPaise }));
    const holding = doc.kind === 'INCOME' ? A.DEFERRED_INCOME : A.PREPAID_EXPENSES;
    await postGl(session, {
      postingDate: doc.postingDate, voucherType: 'DeferredSchedule', voucherId: doc._id, voucherNo: doc.docNo, narration: `Deferred ${doc.reference}`,
      lines: doc.kind === 'INCOME'
        ? [{ accountCode: doc.sourceAccountCode, debitPaise: doc.amountPaise }, { accountCode: holding, creditPaise: doc.amountPaise }]
        : [{ accountCode: holding, debitPaise: doc.amountPaise }, { accountCode: doc.sourceAccountCode, creditPaise: doc.amountPaise }],
    });
    return { action: 'DEFERRAL_STARTED' };
  },
  async onCancel(_session, doc) {
    if (doc.rows.some((r) => r.isPosted)) throw rule('Some of this has been released already.', 'ALREADY_RELEASED');
  },
});

/* ---------- Subscriptions and loyalty ---------- */

m('SubscriptionPlan', 'name!* itemId!:link(Item) ratePaise!:money intervalMonths:int=1 gstRateBps:pct=1800', { list: 'name itemId ratePaise intervalMonths' });
m('Subscription', 'partyId!:link(Party;isCustomer=true) planId!:link(SubscriptionPlan) startDate!:date endDate:date nextInvoiceOn:date state:select(ACTIVE,PAUSED,CANCELLED,ENDED)=ACTIVE lastInvoiceId~:link(SalesInvoice) invoicesRaised~:int', {
  labelFields: ['partyId', 'planId'],
  list: 'partyId planId nextInvoiceOn state invoicesRaised',
  dateField: 'nextInvoiceOn',
  prepare: (_s, data) => ({ ...data, nextInvoiceOn: data.nextInvoiceOn ?? data.startDate }),
});
m('LoyaltyProgram', 'name!* pointsPer100Paise:int=1 valuePerPointPaise:money expiryDays:int customerGroupId:link(CustomerGroup) isActive:check=true', { list: 'name pointsPer100Paise valuePerPointPaise expiryDays', labels: { pointsPer100Paise: 'Points per Rs 100' } });
m('LoyaltyPointEntry', 'partyId!:link(Party) programId!:link(LoyaltyProgram) points!:int onDate!:date expiresOn:date reference', { labelFields: ['partyId'], dateField: 'onDate', list: 'partyId programId points onDate expiresOn reference' });

