// GST documents an accountant works with each month, and opening balances for going live.
import { define, modelOf } from '../engine/registry.js';
import { A } from '../config/accounts.js';
import { GlEntry } from '../models/ledgers.js';
import { Party } from '../models/masters.js';
import { PurchaseInvoice, SalesInvoice } from '../models/documents.js';
import { parseCsv, scaledInt } from '../engine/importExport.js';
import { postGl } from '../services/ledgerService.js';
import { conflict, rule } from '../utils/errors.js';
import { toBasePaise } from '../utils/money.js';
import { gstSetOff } from '../utils/tax.js';
import { todayIst } from '../utils/dates.js';

/* ---------- Imports ---------- */

// Customs is paid on the bill of entry, not to the supplier. The IGST can be claimed. The
// duty waits in landed cost clearing, until a landed cost voucher puts it on the goods.
define({
  name: 'BillOfEntry',
  module: 'accounts',
  series: 'BE',
  submittable: true,
  labelFields: ['boeNo'],
  searchFields: ['docNo', 'boeNo', 'portCode'],
  fields: 'boeNo!* boeDate!:date portCode partyId:link(Party) grnId:link(Grn) assessablePaise!:money customsDutyPaise:money igstPaise!:money bankAccountCode!:link(Account;isCashOrBank=true) totalPaise~:money',
  list: 'docNo boeNo boeDate assessablePaise customsDutyPaise igstPaise totalPaise',
  dateField: 'boeDate',
  prepare: (_s, data) => ({ ...data, totalPaise: (data.customsDutyPaise ?? 0) + (data.igstPaise ?? 0) }),
  async onSubmit(session, doc) {
    await postGl(session, {
      postingDate: doc.postingDate,
      voucherType: 'BillOfEntry',
      voucherId: doc._id,
      voucherNo: doc.docNo,
      narration: `Bill of entry ${doc.boeNo}`,
      lines: [
        { accountCode: A.INPUT_IGST, debitPaise: doc.igstPaise },
        { accountCode: A.LANDED_COST_CLEARING, debitPaise: doc.customsDutyPaise },
        { accountCode: doc.bankAccountCode, creditPaise: doc.totalPaise },
      ],
    });
    return { action: 'BILL_OF_ENTRY_POSTED', data: { igstPaise: doc.igstPaise } };
  },
});

/* ---------- Month-end set-off ---------- */

const netOf = async (session, code, upTo) => {
  const [row] = await GlEntry.aggregate([
    { $match: { accountCode: code, postingDate: { $lte: upTo } } },
    { $group: { _id: null, net: { $sum: { $subtract: ['$debitPaise', '$creditPaise'] } } } },
  ]).session(session);
  return row?.net ?? 0;
};

// Uses credit against what is owed, in the order the law sets, for a month that has ended.
// Reverse charge tax cannot be paid with credit, so it stays for cash. A CA must confirm this.
define({
  name: 'GstSetOff',
  module: 'accounts',
  series: 'GS',
  submittable: true,
  labelFields: ['docNo'],
  label: 'GST set-off',
  fields: 'periodEnd!:date creditUsedPaise~:money cashCgstPaise~:money cashSgstPaise~:money cashIgstPaise~:money rcmCgstPaise~:money rcmSgstPaise~:money rcmIgstPaise~:money cashTotalPaise~:money isPaid~:check paidOn~:date',
  list: 'docNo periodEnd creditUsedPaise cashTotalPaise isPaid',
  dateField: 'periodEnd',
  submitLabel: 'Set off',
  hint: 'Uses GST credit against GST owed up to that date. What is left is payable in cash.',
  prepare: (_s, data) => ({ ...data, postingDate: data.periodEnd }),
  async onSubmit(session, doc) {
    const end = doc.periodEnd;
    // An unpaid balance is still in the accounts. A second set-off would count it again, and
    // both could then be paid. One out of date order would work from the wrong balances.
    const blocking = await modelOf('GstSetOff').findOne({
      _id: { $ne: doc._id },
      status: 'SUBMITTED',
      $or: [{ isPaid: { $ne: true }, cashTotalPaise: { $gt: 0 } }, { periodEnd: { $gt: end } }],
    }).session(session).lean();
    if (blocking) {
      throw rule(blocking.periodEnd > end
        ? `${blocking.docNo} already covers up to ${blocking.periodEnd}. Set-offs must run in date order.`
        : `${blocking.docNo} has not been paid yet. Pay or cancel it first.`, 'EARLIER_SET_OFF_OPEN');
    }
    const liability = { cgst: -(await netOf(session, A.OUTPUT_CGST, end)), sgst: -(await netOf(session, A.OUTPUT_SGST, end)), igst: -(await netOf(session, A.OUTPUT_IGST, end)) };
    const credit = { cgst: await netOf(session, A.INPUT_CGST, end), sgst: await netOf(session, A.INPUT_SGST, end), igst: await netOf(session, A.INPUT_IGST, end) };
    for (const head of ['cgst', 'sgst', 'igst']) {
      liability[head] = Math.max(0, liability[head]);
      credit[head] = Math.max(0, credit[head]);
    }
    const plan = gstSetOff(liability, credit);
    const used = plan.used;
    const total = used.igst + used.cgst + used.sgst;
    doc.rcmCgstPaise = Math.max(0, -(await netOf(session, A.RCM_CGST, end)));
    doc.rcmSgstPaise = Math.max(0, -(await netOf(session, A.RCM_SGST, end)));
    doc.rcmIgstPaise = Math.max(0, -(await netOf(session, A.RCM_IGST, end)));
    doc.creditUsedPaise = total;
    doc.cashCgstPaise = plan.cash.cgst;
    doc.cashSgstPaise = plan.cash.sgst;
    doc.cashIgstPaise = plan.cash.igst;
    doc.cashTotalPaise = plan.cash.cgst + plan.cash.sgst + plan.cash.igst + doc.rcmCgstPaise + doc.rcmSgstPaise + doc.rcmIgstPaise;
    if (total === 0 && doc.cashTotalPaise === 0) throw rule('There is nothing to set off.', 'NOTHING_TO_SET_OFF');
    await postGl(session, {
      postingDate: end,
      voucherType: 'GstSetOff',
      voucherId: doc._id,
      voucherNo: doc.docNo,
      narration: `GST set-off to ${end}`,
      lines: [
        { accountCode: A.OUTPUT_CGST, debitPaise: plan.settled.cgst },
        { accountCode: A.OUTPUT_SGST, debitPaise: plan.settled.sgst },
        { accountCode: A.OUTPUT_IGST, debitPaise: plan.settled.igst },
        { accountCode: A.INPUT_CGST, creditPaise: used.cgst },
        { accountCode: A.INPUT_SGST, creditPaise: used.sgst },
        { accountCode: A.INPUT_IGST, creditPaise: used.igst },
      ],
    });
    return { action: 'GST_SET_OFF', data: { creditUsedPaise: total, cashTotalPaise: doc.cashTotalPaise } };
  },
  actions: [{
    key: 'payCash',
    label: 'Pay the balance',
    primary: true,
    when: { status: ['SUBMITTED'], isPaid: [false] },
    fields: 'bankAccountCode!:link(Account;isCashOrBank=true) challanNo!',
    async run(session, doc, body) {
      if (doc.cashTotalPaise === 0) throw rule('Nothing is payable in cash.', 'NOTHING_TO_PAY');
      const onDate = todayIst();
      await postGl(session, {
        postingDate: onDate,
        voucherType: 'GstSetOff',
        voucherId: doc._id,
        voucherNo: doc.docNo,
        narration: `GST paid, challan ${body.challanNo}`,
        lines: [
          { accountCode: A.OUTPUT_CGST, debitPaise: doc.cashCgstPaise },
          { accountCode: A.OUTPUT_SGST, debitPaise: doc.cashSgstPaise },
          { accountCode: A.OUTPUT_IGST, debitPaise: doc.cashIgstPaise },
          { accountCode: A.RCM_CGST, debitPaise: doc.rcmCgstPaise },
          { accountCode: A.RCM_SGST, debitPaise: doc.rcmSgstPaise },
          { accountCode: A.RCM_IGST, debitPaise: doc.rcmIgstPaise },
          { accountCode: body.bankAccountCode, creditPaise: doc.cashTotalPaise },
        ],
      });
      doc.isPaid = true;
      doc.paidOn = onDate;
      await doc.save({ session });
      return doc;
    },
  }],
});

/* ---------- Matching GSTR-2B ---------- */

const invoiceKey = (gstin, no) => `${String(gstin).trim().toUpperCase()}|${String(no).replace(/\s+/g, '').toUpperCase()}`;

// Paste or load the 2B file, and see what the suppliers reported against what was booked.
define({
  name: 'Gstr2bReconciliation',
  module: 'accounts',
  series: 'GB',
  labelFields: ['docNo'],
  label: 'GSTR-2B reconciliation',
  fields: 'fromDate!:date toDate!:date tolerancePaise:money=100 matched~:int mismatched~:int missingInBooks~:int missingIn2b~:int',
  tables: {
    'rows~': 'supplierGstin invoiceNo invoiceDate taxablePaise:money taxPaise:money bookTaxPaise:money differencePaise:smoney result',
    'onlyInBooks~': 'supplierGstin invoiceNo partyName postingDate:date taxPaise:money',
  },
  list: 'docNo fromDate toDate matched mismatched missingInBooks missingIn2b',
  dateField: 'toDate',
  hint: 'Columns: gstin, invoice_no, invoice_date, taxable, cgst, sgst, igst. Amounts in rupees.',
  actions: [{
    key: 'load',
    label: 'Load 2B and match',
    primary: true,
    when: {},
    fields: 'csv!:bigtext',
    async run(session, doc, body) {
      const rows = parseCsv(body.csv);
      if (rows.length < 2) throw rule('The file needs a heading row and at least one invoice.', 'EMPTY_FILE');
      const header = rows[0].map((h) => h.trim().toLowerCase());
      const column = (name) => {
        const index = header.indexOf(name);
        if (index < 0) throw rule(`The file needs a column called ${name}.`, 'BAD_COLUMNS');
        return index;
      };
      const c = { gstin: column('gstin'), no: column('invoice_no'), date: column('invoice_date'), taxable: column('taxable'), cgst: column('cgst'), sgst: column('sgst'), igst: column('igst') };
      const money = (text, line) => {
        try {
          return scaledInt(text === undefined || text === '' ? '0' : text, 2);
        } catch {
          throw rule(`Line ${line}: "${text}" is not an amount.`, 'BAD_AMOUNT');
        }
      };
      const books = await PurchaseInvoice.find({ status: 'SUBMITTED', isOpening: { $ne: true }, supplierGstin: { $ne: '' }, postingDate: { $gte: doc.fromDate, $lte: doc.toDate } }).session(session).lean();
      const byKey = new Map(books.map((b) => [invoiceKey(b.supplierGstin, b.supplierInvoiceNo), b]));
      const seen = new Set();
      const out = [];
      for (let i = 1; i < rows.length; i += 1) {
        const row = rows[i];
        const taxPaise = money(row[c.cgst], i + 1) + money(row[c.sgst], i + 1) + money(row[c.igst], i + 1);
        const key = invoiceKey(row[c.gstin], row[c.no]);
        const book = byKey.get(key);
        seen.add(key);
        const bookTax = book ? book.cgstPaise + book.sgstPaise + book.igstPaise : 0;
        const difference = taxPaise - bookTax;
        let result = 'MISSING_IN_BOOKS';
        if (book) result = Math.abs(difference) <= doc.tolerancePaise ? 'MATCHED' : 'MISMATCH';
        out.push({ supplierGstin: row[c.gstin].trim().toUpperCase(), invoiceNo: row[c.no].trim(), invoiceDate: row[c.date]?.trim() ?? '', taxablePaise: money(row[c.taxable], i + 1), taxPaise, bookTaxPaise: bookTax, differencePaise: difference, result });
      }
      doc.rows = out;
      doc.onlyInBooks = books
        .filter((b) => !seen.has(invoiceKey(b.supplierGstin, b.supplierInvoiceNo)))
        .map((b) => ({ supplierGstin: b.supplierGstin, invoiceNo: b.supplierInvoiceNo, partyName: b.partyName, postingDate: b.postingDate, taxPaise: b.cgstPaise + b.sgstPaise + b.igstPaise }));
      doc.matched = out.filter((r) => r.result === 'MATCHED').length;
      doc.mismatched = out.filter((r) => r.result === 'MISMATCH').length;
      doc.missingInBooks = out.filter((r) => r.result === 'MISSING_IN_BOOKS').length;
      doc.missingIn2b = doc.onlyInBooks.length;
      await doc.save({ session });
      return doc;
    },
  }],
});

/* ---------- Banking ---------- */

define({
  name: 'BankTransfer',
  module: 'accounts',
  series: 'BT',
  submittable: true,
  labelFields: ['docNo'],
  fields: 'fromAccountCode!:link(Account;isCashOrBank=true) toAccountCode!:link(Account;isCashOrBank=true) amountPaise!:money chargesPaise:money reference',
  list: 'docNo fromAccountCode toAccountCode amountPaise chargesPaise reference',
  async onSubmit(session, doc) {
    if (doc.fromAccountCode === doc.toAccountCode) throw rule('Choose two different accounts.', 'SAME_ACCOUNT');
    if (doc.amountPaise <= 0) throw rule('Enter an amount.', 'AMOUNT_REQUIRED');
    await postGl(session, {
      postingDate: doc.postingDate,
      voucherType: 'BankTransfer',
      voucherId: doc._id,
      voucherNo: doc.docNo,
      narration: `Transfer ${doc.reference}`,
      lines: [
        { accountCode: doc.toAccountCode, debitPaise: doc.amountPaise },
        { accountCode: A.EXPENSES, debitPaise: doc.chargesPaise },
        { accountCode: doc.fromAccountCode, creditPaise: doc.amountPaise + doc.chargesPaise },
      ],
    });
    return { action: 'BANK_TRANSFER_POSTED' };
  },
});

/* ---------- Going live ---------- */

// What a party owed on the day the company moved to Forge, invoice by invoice, so ageing and
// allocation work from day one. It is not a sale, so it stays out of the GST returns.
define({
  name: 'OpeningInvoice',
  module: 'accounts',
  series: 'OI',
  submittable: true,
  labelFields: ['docNo', 'invoiceNo'],
  searchFields: ['docNo', 'invoiceNo'],
  fields: 'kind:select(SALES,PURCHASE)=SALES partyId!:link(Party) invoiceNo! invoiceDate!:date dueDate:date currency=INR fxRate4:fx amountMinor!:money totalPaise~:money createdInvoiceId~',
  list: 'docNo kind partyId invoiceNo invoiceDate amountMinor totalPaise',
  labels: { amountMinor: 'Amount still owed' },
  dateField: 'invoiceDate',
  prepare(_s, data) {
    const fx = data.currency === 'INR' || !data.currency ? 10000 : data.fxRate4;
    if (!fx) throw rule('A foreign currency balance needs an exchange rate.', 'FX_REQUIRED');
    return { ...data, fxRate4: fx, totalPaise: toBasePaise(data.amountMinor, fx) };
  },
  async onSubmit(session, doc) {
    const party = await Party.findById(doc.partyId).session(session).lean();
    const base = {
      docNo: `OP-${doc.invoiceNo}`.slice(0, 40),
      postingDate: doc.invoiceDate,
      status: 'SUBMITTED',
      partyId: party._id,
      partyName: party.name,
      supplyType: 'INTRA',
      dueDate: doc.dueDate ?? doc.invoiceDate,
      lines: [],
      taxablePaise: doc.totalPaise,
      totalPaise: doc.totalPaise,
      isOpening: true,
      remarks: `Opening balance, ${doc.docNo}`,
      submittedAt: new Date(),
    };
    let created;
    if (doc.kind === 'SALES') {
      if (!party.isCustomer) throw rule(`${party.name} is not a customer.`, 'UNKNOWN_PARTY');
      [created] = await SalesInvoice.create([{ ...base, partyGstin: party.gstin, currency: doc.currency, fxRate4: doc.fxRate4, isExport: party.isExport, totalMinor: doc.amountMinor }], { session });
    } else {
      if (!party.isSupplier && !party.isJobWorker) throw rule(`${party.name} is not a supplier.`, 'UNKNOWN_PARTY');
      if (doc.currency !== 'INR') throw rule('Supplier balances are in rupees for now.', 'PAYMENT_INR_ONLY');
      [created] = await PurchaseInvoice.create([{ ...base, supplierGstin: party.gstin, supplierInvoiceNo: doc.invoiceNo, supplierInvoiceDate: doc.invoiceDate }], { session });
    }
    doc.createdInvoiceId = String(created._id);
    await postGl(session, {
      postingDate: doc.postingDate,
      voucherType: 'OpeningInvoice',
      voucherId: doc._id,
      voucherNo: doc.docNo,
      narration: `Opening balance ${doc.invoiceNo}`,
      lines: doc.kind === 'SALES'
        ? [{ accountCode: A.DEBTORS, debitPaise: doc.totalPaise, partyId: party._id }, { accountCode: A.OPENING, creditPaise: doc.totalPaise }]
        : [{ accountCode: A.OPENING, debitPaise: doc.totalPaise }, { accountCode: A.CREDITORS, creditPaise: doc.totalPaise, partyId: party._id }],
    });
    return { action: 'OPENING_BALANCE_POSTED', data: { totalPaise: doc.totalPaise } };
  },
  async onCancel(session, doc) {
    const Model = doc.kind === 'SALES' ? SalesInvoice : PurchaseInvoice;
    const invoice = await Model.findById(doc.createdInvoiceId).session(session);
    if (invoice.paidPaise > 0 || invoice.creditedPaise > 0) throw conflict('Money has been allocated to this. Undo that first.', 'INVOICE_HAS_PAYMENTS');
    invoice.status = 'CANCELLED';
    await invoice.save({ session });
  },
});

