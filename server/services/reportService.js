// Reports only add up what was frozen when each event happened. They never write.
import mongoose from 'mongoose';
import { Bin, GlEntry, StockEntry } from '../models/ledgers.js';
import { Account, Item, Warehouse } from '../models/masters.js';
import { Counter } from '../models/core.js';
import {
  AdjustmentNote, AmcContract, FatProtocol, Gauge, Grn, Inspection, JobWorkChallan, Journal, MachineBuild,
  MaterialIssue, Ncr, Payment, PurchaseInvoice, PurchaseOrder, Quotation, SalesInvoice, SalesOrder,
  ServiceTicket, StockMove, TimeBooking,
} from '../models/documents.js';
import { A } from '../config/accounts.js';
import { sumInts } from '../utils/money.js';
import { addDays, daysBetween, todayIst } from '../utils/dates.js';
import { gstSetOff, SUPPLY, ZERO_RATED } from '../utils/tax.js';
import { getSettings } from './settingsService.js';
import { accountForWarehouseKind } from './stockService.js';
import { verifyAuditChain } from './auditService.js';
import { notFound } from '../utils/errors.js';
import { allTypes, modelOf } from '../engine/registry.js';

const netSign = (type) => (type === 'ASSET' || type === 'EXPENSE' ? 1 : -1);

async function balancesUpTo(to, from, { excludeClosing = false } = {}) {
  const match = excludeClosing ? { voucherType: { $ne: 'PeriodClosingVoucher' } } : {};
  if (from || to) match.postingDate = {};
  if (from) match.postingDate.$gte = from;
  if (to) match.postingDate.$lte = to;
  const rows = await GlEntry.aggregate([
    { $match: match },
    { $group: { _id: '$accountCode', debitPaise: { $sum: '$debitPaise' }, creditPaise: { $sum: '$creditPaise' } } },
  ]);
  return new Map(rows.map((r) => [r._id, r]));
}

export async function trialBalance({ from, to }) {
  const accounts = await Account.find().sort({ code: 1 }).lean();
  const opening = from ? await balancesUpTo(addDays(from, -1)) : new Map();
  const period = await balancesUpTo(to, from);
  const rows = accounts.map((account) => {
    const open = opening.get(account.code) ?? { debitPaise: 0, creditPaise: 0 };
    const move = period.get(account.code) ?? { debitPaise: 0, creditPaise: 0 };
    const openingNet = open.debitPaise - open.creditPaise;
    const closingNet = openingNet + move.debitPaise - move.creditPaise;
    return {
      code: account.code,
      name: account.name,
      type: account.type,
      group: account.group,
      openingDebitPaise: Math.max(openingNet, 0),
      openingCreditPaise: Math.max(-openingNet, 0),
      debitPaise: move.debitPaise,
      creditPaise: move.creditPaise,
      closingDebitPaise: Math.max(closingNet, 0),
      closingCreditPaise: Math.max(-closingNet, 0),
    };
  }).filter((r) => r.openingDebitPaise || r.openingCreditPaise || r.debitPaise || r.creditPaise);
  const total = (field) => sumInts(rows.map((r) => r[field]));
  const totals = {
    openingDebitPaise: total('openingDebitPaise'),
    openingCreditPaise: total('openingCreditPaise'),
    debitPaise: total('debitPaise'),
    creditPaise: total('creditPaise'),
    closingDebitPaise: total('closingDebitPaise'),
    closingCreditPaise: total('closingCreditPaise'),
  };
  return { from, to, rows, totals, balanced: totals.closingDebitPaise === totals.closingCreditPaise };
}

export async function profitAndLoss({ from, to, excludeClosing = true }) {
  const accounts = await Account.find({ type: { $in: ['INCOME', 'EXPENSE'] } }).sort({ code: 1 }).lean();
  // A statement of a period shows what was earned. Closing entries only move it to equity.
  const period = await balancesUpTo(to, from, { excludeClosing });
  const section = (type) => accounts.filter((a) => a.type === type).map((a) => {
    const move = period.get(a.code) ?? { debitPaise: 0, creditPaise: 0 };
    return { code: a.code, name: a.name, group: a.group, amountPaise: netSign(type) * (move.debitPaise - move.creditPaise) };
  }).filter((r) => r.amountPaise !== 0);
  const income = section('INCOME');
  const expenses = section('EXPENSE');
  const incomePaise = sumInts(income.map((r) => r.amountPaise));
  const expensePaise = sumInts(expenses.map((r) => r.amountPaise));
  return { from, to, income, expenses, incomePaise, expensePaise, profitPaise: incomePaise - expensePaise };
}

export async function balanceSheet({ asOf }) {
  const accounts = await Account.find({ type: { $in: ['ASSET', 'LIABILITY', 'EQUITY'] } }).sort({ code: 1 }).lean();
  const balances = await balancesUpTo(asOf);
  const section = (type) => accounts.filter((a) => a.type === type).map((a) => {
    const move = balances.get(a.code) ?? { debitPaise: 0, creditPaise: 0 };
    return { code: a.code, name: a.name, group: a.group, amountPaise: netSign(type) * (move.debitPaise - move.creditPaise) };
  }).filter((r) => r.amountPaise !== 0);
  // Profit not yet moved to retained earnings, so closing entries count here.
  const { profitPaise } = await profitAndLoss({ to: asOf, excludeClosing: false });
  const assets = section('ASSET');
  const liabilities = section('LIABILITY');
  const equity = section('EQUITY');
  equity.push({ code: '-', name: 'Profit to date', group: 'Equity', amountPaise: profitPaise });
  const assetsPaise = sumInts(assets.map((r) => r.amountPaise));
  const liabilitiesPaise = sumInts(liabilities.map((r) => r.amountPaise));
  const equityPaise = sumInts(equity.map((r) => r.amountPaise));
  return { asOf, assets, liabilities, equity, assetsPaise, liabilitiesPaise, equityPaise, balanced: assetsPaise === liabilitiesPaise + equityPaise };
}

export async function accountLedger({ code, partyId, from, to }) {
  const account = await Account.findOne({ code }).lean();
  if (!account) throw notFound('Account');
  const baseFilter = { accountCode: code };
  if (partyId) baseFilter.partyId = new mongoose.Types.ObjectId(partyId);
  let openingPaise = 0;
  if (from) {
    const [open] = await GlEntry.aggregate([
      { $match: { ...baseFilter, postingDate: { $lt: from } } },
      { $group: { _id: null, net: { $sum: { $subtract: ['$debitPaise', '$creditPaise'] } } } },
    ]);
    openingPaise = open?.net ?? 0;
  }
  const period = {};
  if (from) period.$gte = from;
  if (to) period.$lte = to;
  const filter = Object.keys(period).length ? { ...baseFilter, postingDate: period } : baseFilter;
  const entries = await GlEntry.find(filter).sort({ postingDate: 1, _id: 1 }).limit(5000).lean();
  let running = openingPaise;
  const rows = entries.map((entry) => {
    running += entry.debitPaise - entry.creditPaise;
    return {
      id: String(entry._id),
      postingDate: entry.postingDate,
      voucherType: entry.voucherType,
      voucherNo: entry.voucherNo,
      narration: entry.narration,
      debitPaise: entry.debitPaise,
      creditPaise: entry.creditPaise,
      balancePaise: running,
      isReversal: entry.isReversal,
    };
  });
  return { account: { code: account.code, name: account.name, type: account.type }, openingPaise, closingPaise: running, rows, truncated: entries.length === 5000 };
}

const AGE_BUCKETS = [[0, 30, 'd0to30Paise'], [31, 60, 'd31to60Paise'], [61, 90, 'd61to90Paise'], [91, Infinity, 'over90Paise']];

export async function ageing({ kind, asOf = todayIst() }) {
  const isSales = kind === 'RECEIVABLE';
  const Model = isSales ? SalesInvoice : PurchaseInvoice;
  const invoices = await Model.find({ status: 'SUBMITTED', postingDate: { $lte: asOf } }).lean();
  const rows = new Map();
  for (const invoice of invoices) {
    const outstanding = invoice.totalPaise - invoice.paidPaise - invoice.creditedPaise;
    if (outstanding <= 0) continue;
    const key = String(invoice.partyId);
    if (!rows.has(key)) {
      rows.set(key, { partyId: key, partyName: invoice.partyName, d0to30Paise: 0, d31to60Paise: 0, d61to90Paise: 0, over90Paise: 0, outstandingPaise: 0, advancePaise: 0, invoices: [] });
    }
    const row = rows.get(key);
    const age = Math.max(0, daysBetween(invoice.dueDate ?? invoice.postingDate, asOf));
    const bucket = AGE_BUCKETS.find(([low, high]) => age >= low && age <= high);
    row[bucket[2]] += outstanding;
    row.outstandingPaise += outstanding;
    row.invoices.push({ id: String(invoice._id), docNo: invoice.docNo, postingDate: invoice.postingDate, dueDate: invoice.dueDate, totalPaise: invoice.totalPaise, outstandingPaise: outstanding, ageDays: age });
  }
  const payments = await Payment.find({ kind: isSales ? 'RECEIPT' : 'PAYMENT', status: 'SUBMITTED', postingDate: { $lte: asOf } }).lean();
  for (const paid of payments) {
    const partyMinor = paid.amountMinor + (paid.deductionsPaise ?? 0);
    const left = partyMinor - paid.allocatedMinor;
    if (left <= 0) continue;
    const key = String(paid.partyId);
    if (!rows.has(key)) {
      rows.set(key, { partyId: key, partyName: paid.partyName, d0to30Paise: 0, d31to60Paise: 0, d61to90Paise: 0, over90Paise: 0, outstandingPaise: 0, advancePaise: 0, invoices: [] });
    }
    // An advance is shown at the rate it was received, the same as the ledger holds it.
    rows.get(key).advancePaise += Math.round(((paid.amountPaise + (paid.deductionsPaise ?? 0)) * left) / partyMinor);
  }
  const list = [...rows.values()].sort((a, b) => b.outstandingPaise - a.outstandingPaise);
  return {
    kind,
    asOf,
    rows: list,
    totals: {
      d0to30Paise: sumInts(list.map((r) => r.d0to30Paise)),
      d31to60Paise: sumInts(list.map((r) => r.d31to60Paise)),
      d61to90Paise: sumInts(list.map((r) => r.d61to90Paise)),
      over90Paise: sumInts(list.map((r) => r.over90Paise)),
      outstandingPaise: sumInts(list.map((r) => r.outstandingPaise)),
      advancePaise: sumInts(list.map((r) => r.advancePaise)),
    },
  };
}

export async function stockBalance({ warehouseId, itemId, buildId } = {}) {
  const filter = { qtyMilli: { $gt: 0 } };
  if (warehouseId) filter.warehouseId = warehouseId;
  if (itemId) filter.itemId = itemId;
  if (buildId) filter.buildId = buildId;
  const bins = await Bin.find(filter).limit(5000).lean();
  const [items, warehouses, builds] = await Promise.all([
    Item.find({ _id: { $in: bins.map((b) => b.itemId) } }, { code: 1, name: 1, uom: 1 }).lean(),
    Warehouse.find({ _id: { $in: bins.map((b) => b.warehouseId) } }, { code: 1, name: 1, kind: 1 }).lean(),
    MachineBuild.find({ _id: { $in: bins.map((b) => b.buildId).filter(Boolean) } }, { serialNo: 1 }).lean(),
  ]);
  const rows = bins.map((bin) => {
    const item = items.find((i) => String(i._id) === String(bin.itemId));
    const warehouse = warehouses.find((w) => String(w._id) === String(bin.warehouseId));
    const build = bin.buildId ? builds.find((b) => String(b._id) === String(bin.buildId)) : null;
    return {
      id: String(bin._id),
      itemId: String(bin.itemId),
      itemCode: item?.code,
      itemName: item?.name,
      uom: item?.uom,
      warehouseId: String(bin.warehouseId),
      warehouseName: warehouse?.name,
      warehouseKind: warehouse?.kind,
      lot: bin.lot,
      buildId: bin.buildId ? String(bin.buildId) : null,
      serialNo: build?.serialNo ?? null,
      qtyMilli: bin.qtyMilli,
      valuePaise: bin.valuePaise,
    };
  }).sort((a, b) => String(a.itemCode).localeCompare(String(b.itemCode)));
  return { rows, totals: { valuePaise: sumInts(rows.map((r) => r.valuePaise)) } };
}

export async function stockLedger({ itemId, from, to }) {
  const filter = { itemId };
  if (from || to) filter.postingDate = {};
  if (from) filter.postingDate.$gte = from;
  if (to) filter.postingDate.$lte = to;
  const entries = await StockEntry.find(filter).sort({ _id: 1 }).limit(5000).lean();
  const warehouses = await Warehouse.find({ _id: { $in: entries.map((e) => e.warehouseId) } }, { name: 1 }).lean();
  return {
    rows: entries.map((entry) => ({
      id: String(entry._id),
      postingDate: entry.postingDate,
      voucherType: entry.voucherType,
      voucherNo: entry.voucherNo,
      warehouseName: warehouses.find((w) => String(w._id) === String(entry.warehouseId))?.name,
      lot: entry.lot,
      qtyMilli: entry.qtyMilli,
      valuePaise: entry.valuePaise,
      balanceQtyMilli: entry.balanceQtyMilli,
      balanceValuePaise: entry.balanceValuePaise,
      isReversal: entry.isReversal,
    })),
  };
}

// Traces a lot both ways: where it came from, and which builds took it.
export async function traceLot({ lot }) {
  const receipts = await Grn.find({ status: 'SUBMITTED', 'lines.lot': lot }, { docNo: 1, partyName: 1, postingDate: 1, lines: 1 }).lean();
  const issues = await MaterialIssue.find({ status: 'SUBMITTED', 'lines.picks.lot': lot }, { docNo: 1, serialNo: 1, postingDate: 1, lines: 1 }).lean();
  return {
    lot,
    receivedFrom: receipts.flatMap((g) => g.lines.filter((l) => l.lot === lot).map((l) => ({
      grnNo: g.docNo, partyName: g.partyName, postingDate: g.postingDate, itemCode: l.itemCode, qtyMilli: l.qtyMilli, certRef: l.certRef,
    }))),
    usedIn: issues.flatMap((m) => m.lines.flatMap((l) => l.picks.filter((p) => p.lot === lot).map((p) => ({
      issueNo: m.docNo, serialNo: m.serialNo, postingDate: m.postingDate, itemCode: l.itemCode, qtyMilli: p.qtyMilli,
    })))),
  };
}

const plusTax = (row, source) => {
  row.taxablePaise += source.taxablePaise;
  row.cgstPaise += source.cgstPaise;
  row.sgstPaise += source.sgstPaise;
  row.igstPaise += source.igstPaise;
};
const emptyTax = () => ({ taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 });
const isTaxableLine = (line) => (line.gstTreatment ?? 'TAXABLE') === 'TAXABLE';
const taxableOnly = (invoice) => sumInts(invoice.lines.filter(isTaxableLine).map((l) => l.taxablePaise));

// The working papers for GSTR-1. A person still files the return.
export async function gstr1({ from, to }) {
  const settings = await getSettings();
  const period = { $gte: from, $lte: to };
  const invoices = await SalesInvoice.find({ status: 'SUBMITTED', isOpening: { $ne: true }, postingDate: period }).sort({ docNo: 1 }).lean();
  const notes = await AdjustmentNote.find({ kind: 'CREDIT', status: 'SUBMITTED', postingDate: period }).sort({ docNo: 1 }).lean();
  const original = await SalesInvoice.find({ _id: { $in: notes.map((n) => n.invoiceId) } }).lean();

  const isLarge = (invoice) => !invoice.partyGstin && invoice.supplyType === SUPPLY.INTER && invoice.totalPaise > settings.gstB2clLimitPaise;
  const isSez = (invoice) => [SUPPLY.SEZ_LUT, SUPPLY.SEZ_IGST].includes(invoice.supplyType);

  const row = (invoice) => ({
    docNo: invoice.docNo,
    postingDate: invoice.postingDate,
    partyName: invoice.partyName,
    partyGstin: invoice.partyGstin,
    placeOfSupply: invoice.placeOfSupply,
    supplyType: invoice.supplyType,
    taxablePaise: taxableOnly(invoice),
    cgstPaise: invoice.cgstPaise,
    sgstPaise: invoice.sgstPaise,
    igstPaise: invoice.igstPaise,
    totalPaise: invoice.totalPaise,
    irn: invoice.irn && !invoice.irnCancelledAt ? invoice.irn : '',
  });

  const b2b = invoices.filter((i) => i.partyGstin && !i.isExport && !isSez(i)).map(row);
  const sez = invoices.filter(isSez).map(row);
  const b2cl = invoices.filter((i) => !i.isExport && !isSez(i) && isLarge(i)).map(row);
  const exportsRows = invoices.filter((i) => i.isExport).map((i) => ({ ...row(i), withPayment: i.supplyType === SUPPLY.EXPORT_IGST, shippingBillNo: i.shippingBillNo, lutNumber: i.lutNumber, currency: i.currency, fxRate4: i.fxRate4 }));

  // Small sales to unregistered buyers go in as one figure per place and rate, net of notes.
  const small = invoices.filter((i) => !i.partyGstin && !i.isExport && !isSez(i) && !isLarge(i));
  const b2csMap = new Map();
  const b2csRow = (place, rate) => {
    const key = `${place}|${rate}`;
    if (!b2csMap.has(key)) b2csMap.set(key, { placeOfSupply: place, gstRateBps: rate, ...emptyTax() });
    return b2csMap.get(key);
  };
  for (const invoice of small) {
    for (const slab of invoice.slabs) {
      if (slab.gstRateBps > 0) plusTax(b2csRow(invoice.placeOfSupply, slab.gstRateBps), slab);
    }
  }

  const cdnr = [];
  const cdnur = [];
  const noteRow = (note, invoice) => ({
    docNo: note.docNo,
    invoiceNo: note.invoiceNo,
    invoiceDate: invoice?.postingDate,
    postingDate: note.postingDate,
    partyName: note.partyName,
    partyGstin: note.partyGstin,
    reason: note.reason,
    placeOfSupply: invoice?.placeOfSupply,
    taxablePaise: note.taxablePaise,
    cgstPaise: note.cgstPaise,
    sgstPaise: note.sgstPaise,
    igstPaise: note.igstPaise,
    totalPaise: note.totalPaise,
  });
  for (const note of notes) {
    const invoice = original.find((i) => String(i._id) === String(note.invoiceId));
    if (note.partyGstin || (invoice && isSez(invoice))) cdnr.push(noteRow(note, invoice));
    else if (invoice && (invoice.isExport || isLarge(invoice))) cdnur.push(noteRow(note, invoice));
    else {
      for (const line of note.lines) {
        if (line.gstRateBps === 0) continue;
        const target = b2csRow(invoice?.placeOfSupply, line.gstRateBps);
        target.taxablePaise -= line.taxablePaise;
        target.cgstPaise -= line.cgstPaise;
        target.sgstPaise -= line.sgstPaise;
        target.igstPaise -= line.igstPaise;
      }
    }
  }

  // Nil-rated, exempt and non-GST supplies, by inter or intra-state and buyer type.
  const nilMap = new Map();
  for (const invoice of invoices) {
    for (const line of invoice.lines) {
      if (isTaxableLine(line)) continue;
      const isInter = invoice.placeOfSupply !== settings.stateCode;
      const heading = `${isInter ? 'Inter-state' : 'Intra-state'} to ${invoice.partyGstin ? 'registered' : 'unregistered'}`;
      const entry = nilMap.get(heading) ?? { heading, nilPaise: 0, exemptPaise: 0, nonGstPaise: 0 };
      if (line.gstTreatment === 'NIL') entry.nilPaise += line.taxablePaise;
      if (line.gstTreatment === 'EXEMPT') entry.exemptPaise += line.taxablePaise;
      if (line.gstTreatment === 'NON_GST') entry.nonGstPaise += line.taxablePaise;
      nilMap.set(heading, entry);
    }
  }

  // HSN summary, split between registered buyers and the rest, as the form now wants.
  const hsnTables = { all: new Map(), b2b: new Map(), b2c: new Map() };
  const addHsn = (table, line, sign) => {
    const key = `${line.hsn}|${line.gstRateBps}`;
    const entry = table.get(key) ?? { hsn: line.hsn, gstRateBps: line.gstRateBps, uom: line.uom, qtyMilli: 0, ...emptyTax() };
    entry.qtyMilli += sign * (line.qtyMilli ?? 0);
    entry.taxablePaise += sign * line.taxablePaise;
    entry.cgstPaise += sign * line.cgstPaise;
    entry.sgstPaise += sign * line.sgstPaise;
    entry.igstPaise += sign * line.igstPaise;
    table.set(key, entry);
  };
  const hsnFor = (invoice) => (invoice.partyGstin || isSez(invoice) ? hsnTables.b2b : hsnTables.b2c);
  for (const invoice of invoices) {
    for (const line of invoice.lines) {
      addHsn(hsnTables.all, line, 1);
      addHsn(hsnFor(invoice), line, 1);
    }
  }
  for (const note of notes) {
    const invoice = original.find((i) => String(i._id) === String(note.invoiceId));
    for (const line of note.lines) {
      addHsn(hsnTables.all, line, -1);
      if (invoice) addHsn(hsnFor(invoice), line, -1);
    }
  }
  const sorted = (table) => [...table.values()].sort((a, b) => a.hsn.localeCompare(b.hsn) || a.gstRateBps - b.gstRateBps);

  const numbers = await SalesInvoice.find({ docNo: { $ne: null }, isOpening: { $ne: true }, postingDate: period }, { docNo: 1, status: 1 }).sort({ docNo: 1 }).lean();
  const noteNumbers = await AdjustmentNote.find({ kind: 'CREDIT', docNo: { $ne: null }, postingDate: period }, { docNo: 1, status: 1 }).sort({ docNo: 1 }).lean();
  const series = (rows) => ({ firstNo: rows[0]?.docNo ?? null, lastNo: rows.at(-1)?.docNo ?? null, issued: rows.length, cancelled: rows.filter((d) => d.status === 'CANCELLED').length });

  return {
    from,
    to,
    b2clLimitPaise: settings.gstB2clLimitPaise,
    b2b,
    sez,
    b2cl,
    b2cs: [...b2csMap.values()].sort((a, b) => String(a.placeOfSupply).localeCompare(String(b.placeOfSupply)) || a.gstRateBps - b.gstRateBps),
    exports: exportsRows,
    nil: [...nilMap.values()],
    cdnr,
    cdnur,
    creditNotes: [...cdnr, ...cdnur],
    hsnSummary: sorted(hsnTables.all),
    hsnB2b: sorted(hsnTables.b2b),
    hsnB2c: sorted(hsnTables.b2c),
    documents: series(numbers),
    creditNoteDocuments: series(noteNumbers),
  };
}

// The working papers for GSTR-3B, by table. Blocked credit is taken in Table 4(A) and
// reversed in 4(B)(1), following CBIC's clarification as reported. Confirm with your CA.
export async function gstr3b({ from, to }) {
  const period = { $gte: from, $lte: to };
  const invoices = await SalesInvoice.find({ status: 'SUBMITTED', isOpening: { $ne: true }, postingDate: period }).lean();
  const credit = await AdjustmentNote.find({ kind: 'CREDIT', status: 'SUBMITTED', postingDate: period }).lean();
  const debit = await AdjustmentNote.find({ kind: 'DEBIT', status: 'SUBMITTED', postingDate: period }).lean();
  const purchases = await PurchaseInvoice.find({ status: 'SUBMITTED', isOpening: { $ne: true }, postingDate: period }).lean();
  const entries = await modelOf('BillOfEntry').find({ status: 'SUBMITTED', postingDate: period }).lean();

  const invoiceById = new Map((await SalesInvoice.find({ _id: { $in: credit.map((c) => c.invoiceId) } }).lean()).map((i) => [String(i._id), i]));
  const billById = new Map((await PurchaseInvoice.find({ _id: { $in: debit.map((d) => d.invoiceId) } }).lean()).map((p) => [String(p._id), p]));

  const addLines = (block, lines, sign) => {
    for (const line of lines) {
      block.taxablePaise += sign * line.taxablePaise;
      block.cgstPaise += sign * line.cgstPaise;
      block.sgstPaise += sign * line.sgstPaise;
      block.igstPaise += sign * line.igstPaise;
    }
  };
  const outward = emptyTax();
  const zeroRated = emptyTax();
  let nilExemptPaise = 0;
  let nonGstPaise = 0;
  const unregisteredByState = new Map();
  for (const invoice of invoices) {
    const taxable = invoice.lines.filter(isTaxableLine);
    addLines(ZERO_RATED.has(invoice.supplyType) ? zeroRated : outward, taxable, 1);
    for (const line of invoice.lines) {
      if (line.gstTreatment === 'NON_GST') nonGstPaise += line.taxablePaise;
      else if (!isTaxableLine(line)) nilExemptPaise += line.taxablePaise;
    }
    if (!invoice.partyGstin && invoice.supplyType === SUPPLY.INTER) {
      const entry = unregisteredByState.get(invoice.placeOfSupply) ?? { placeOfSupply: invoice.placeOfSupply, taxablePaise: 0, igstPaise: 0 };
      entry.taxablePaise += taxableOnly(invoice);
      entry.igstPaise += invoice.igstPaise;
      unregisteredByState.set(invoice.placeOfSupply, entry);
    }
  }
  for (const note of credit) {
    const invoice = invoiceById.get(String(note.invoiceId));
    addLines(invoice && ZERO_RATED.has(invoice.supplyType) ? zeroRated : outward, note.lines.filter((l) => l.gstRateBps > 0), -1);
  }

  const reverseCharge = emptyTax();
  const otherItc = emptyTax();
  const rcmItc = emptyTax();
  const blocked = emptyTax();
  let inwardExemptPaise = 0;
  const addCredit = (target, line, sign) => {
    target.cgstPaise += sign * line.cgstPaise;
    target.sgstPaise += sign * line.sgstPaise;
    target.igstPaise += sign * line.igstPaise;
  };
  const addPurchase = (bill, lines, sign) => {
    for (const line of lines) {
      if (bill.isReverseCharge) {
        reverseCharge.taxablePaise += sign * line.taxablePaise;
        addCredit(reverseCharge, line, sign);
      }
      addCredit(bill.isReverseCharge ? rcmItc : otherItc, line, sign);
      if (line.itcBlocked) addCredit(blocked, line, sign);
    }
  };
  for (const bill of purchases) {
    addPurchase(bill, bill.lines, 1);
    for (const line of bill.lines) if (line.gstTreatment && line.gstTreatment !== 'TAXABLE') inwardExemptPaise += line.taxablePaise;
  }
  for (const note of debit) {
    const bill = billById.get(String(note.invoiceId));
    if (bill) addPurchase(bill, note.lines, -1);
  }
  const importIgst = sumInts(entries.map((e) => e.igstPaise));
  const sumHead = (key) => otherItc[key] + rcmItc[key] + (key === 'igstPaise' ? importIgst : 0);
  const available = { cgstPaise: sumHead('cgstPaise'), sgstPaise: sumHead('sgstPaise'), igstPaise: sumHead('igstPaise') };
  const itc = {
    taxablePaise: 0,
    cgstPaise: available.cgstPaise - blocked.cgstPaise,
    sgstPaise: available.sgstPaise - blocked.sgstPaise,
    igstPaise: available.igstPaise - blocked.igstPaise,
  };
  const owed = { cgst: Math.max(0, outward.cgstPaise), sgst: Math.max(0, outward.sgstPaise), igst: Math.max(0, outward.igstPaise + zeroRated.igstPaise) };
  const plan = gstSetOff(owed, { cgst: Math.max(0, itc.cgstPaise), sgst: Math.max(0, itc.sgstPaise), igst: Math.max(0, itc.igstPaise) });
  return {
    from,
    to,
    outward,
    zeroRated,
    nilExemptPaise,
    nonGstPaise,
    reverseCharge,
    unregisteredByState: [...unregisteredByState.values()],
    itcImports: { igstPaise: importIgst },
    itcReverseCharge: rcmItc,
    itcOther: otherItc,
    itcBlocked: blocked,
    itc,
    inwardExemptPaise,
    // Before set-off, as a plain subtraction.
    netPayable: {
      cgstPaise: outward.cgstPaise - itc.cgstPaise,
      sgstPaise: outward.sgstPaise - itc.sgstPaise,
      igstPaise: outward.igstPaise + zeroRated.igstPaise - itc.igstPaise,
    },
    setOff: plan,
    reverseChargeCash: { cgstPaise: reverseCharge.cgstPaise, sgstPaise: reverseCharge.sgstPaise, igstPaise: reverseCharge.igstPaise },
  };
}

export async function jobWorkReport() {
  const open = await JobWorkChallan.find({ status: { $in: ['SENT', 'PARTLY_RETURNED'] } }).sort({ returnBy: 1 }).lean();
  const today = todayIst();
  return {
    rows: open.flatMap((challan) => challan.lines.filter((l) => l.consumedMilli < l.qtyMilli).map((line) => ({
      id: `${challan._id}-${line._id}`,
      challanId: String(challan._id),
      docNo: challan.docNo,
      partyName: challan.partyName,
      process: challan.process,
      serialNo: challan.serialNo,
      itemCode: line.itemCode,
      itemName: line.itemName,
      sentOn: challan.postingDate,
      returnBy: challan.returnBy,
      pendingMilli: line.qtyMilli - line.consumedMilli,
      isOverdue: challan.returnBy < today,
      daysLeft: daysBetween(today, challan.returnBy),
    }))),
  };
}

export async function dashboard() {
  const today = todayIst();
  const stageCounts = await MachineBuild.aggregate([{ $match: { stage: { $nin: ['CLOSED', 'CANCELLED'] } } }, { $group: { _id: '$stage', count: { $sum: 1 } } }]);
  const [lateBuilds, pendingPo, openNcr, openTickets, overdueGauges, openQuotes, fatToday, recentBuilds, activeOrders] = await Promise.all([
    MachineBuild.countDocuments({ stage: { $in: ['PLANNED', 'PROCUREMENT', 'FABRICATION', 'ASSEMBLY', 'FAT', 'READY'] }, targetDate: { $ne: null, $lt: today } }),
    PurchaseOrder.countDocuments({ status: 'PENDING_APPROVAL' }),
    Ncr.countDocuments({ status: 'OPEN' }),
    ServiceTicket.countDocuments({ status: { $in: ['OPEN', 'IN_PROGRESS'] } }),
    Gauge.countDocuments({ isActive: true, dueOn: { $lt: today } }),
    Quotation.countDocuments({ status: 'SENT' }),
    FatProtocol.countDocuments({ status: 'DRAFT' }),
    MachineBuild.find({ stage: { $nin: ['CLOSED', 'CANCELLED', 'INSTALLED'] } }).sort({ targetDate: 1 }).limit(8)
      .select('serialNo itemName partyName stage targetDate wipPaise budgetPaise').lean(),
    SalesOrder.countDocuments({ status: 'CONFIRMED' }),
  ]);
  const [receivable, payable, stock, jobWork, quarantine] = await Promise.all([
    ageing({ kind: 'RECEIVABLE' }),
    ageing({ kind: 'PAYABLE' }),
    Bin.aggregate([{ $group: { _id: null, value: { $sum: '$valuePaise' } } }]),
    jobWorkReport(),
    Grn.aggregate([
      { $match: { status: 'SUBMITTED' } },
      { $unwind: '$lines' },
      { $match: { 'lines.requiresInspection': true, $expr: { $lt: [{ $add: ['$lines.acceptedMilli', '$lines.rejectedMilli'] }, '$lines.qtyMilli'] } } },
      { $count: 'count' },
    ]),
  ]);
  return {
    stageCounts: Object.fromEntries(stageCounts.map((s) => [s._id, s.count])),
    lateBuilds,
    pendingPoApprovals: pendingPo,
    awaitingInspection: quarantine[0]?.count ?? 0,
    openNcrs: openNcr,
    openTickets,
    overdueGauges,
    openQuotations: openQuotes,
    openFat: fatToday,
    activeOrders,
    receivablePaise: receivable.totals.outstandingPaise,
    payablePaise: payable.totals.outstandingPaise,
    advancesPaise: receivable.totals.advancePaise,
    stockValuePaise: stock[0]?.value ?? 0,
    jobWorkOverdue: jobWork.rows.filter((r) => r.isOverdue).length,
    builds: recentBuilds.map((b) => ({ id: String(b._id), serialNo: b.serialNo, itemName: b.itemName, partyName: b.partyName, stage: b.stage, targetDate: b.targetDate, wipPaise: b.wipPaise, budgetPaise: b.budgetPaise })),
  };
}

/* ---------- Integrity ---------- */

const pass = (id, name, message) => ({ id, name, ok: true, message });
const fail = (id, name, message, details) => ({ id, name, ok: false, message, details });

async function checkGlBalances() {
  const name = 'Every voucher balances';
  const bad = await GlEntry.aggregate([
    { $group: { _id: { t: '$voucherType', i: '$voucherId', n: '$voucherNo', r: '$isReversal' }, net: { $sum: { $subtract: ['$debitPaise', '$creditPaise'] } } } },
    { $match: { net: { $ne: 0 } } },
    { $limit: 20 },
  ]);
  if (bad.length) return fail('I1', name, `${bad.length} voucher(s) do not balance.`, bad.map((b) => b._id.n));
  const [total] = await GlEntry.aggregate([{ $group: { _id: null, net: { $sum: { $subtract: ['$debitPaise', '$creditPaise'] } } } }]);
  if ((total?.net ?? 0) !== 0) return fail('I1', name, `The GL is out by ${total.net} paise.`);
  return pass('I1', name, 'Debits equal credits across the whole ledger.');
}

async function checkBinsMatchLedger() {
  const name = 'Stock summary matches the stock ledger';
  const fromLedger = await StockEntry.aggregate([
    { $group: { _id: { i: '$itemId', w: '$warehouseId', l: '$lot', b: '$buildId' }, qty: { $sum: '$qtyMilli' }, value: { $sum: '$valuePaise' } } },
  ]);
  const bins = await Bin.find().lean();
  const key = (i, w, l, b) => `${i}|${w}|${l}|${b ?? ''}`;
  const binMap = new Map(bins.map((b) => [key(b.itemId, b.warehouseId, b.lot, b.buildId), b]));
  const bad = [];
  for (const row of fromLedger) {
    const k = key(row._id.i, row._id.w, row._id.l, row._id.b);
    const bin = binMap.get(k);
    if (!bin || bin.qtyMilli !== row.qty || bin.valuePaise !== row.value) bad.push(k);
    binMap.delete(k);
  }
  for (const [k, bin] of binMap) {
    if (bin.qtyMilli !== 0 || bin.valuePaise !== 0) bad.push(k);
  }
  if (bad.length) return fail('I2', name, `${bad.length} stock bucket(s) disagree with the ledger.`, bad.slice(0, 20));
  return pass('I2', name, `${fromLedger.length} buckets agree.`);
}

async function checkStockMatchesGl() {
  const name = 'Stock value matches the accounts';
  const warehouses = await Warehouse.find().lean();
  const accountOf = new Map(warehouses.map((w) => [String(w._id), accountForWarehouseKind(w.kind)]));
  const rows = await Bin.aggregate([{ $group: { _id: '$warehouseId', value: { $sum: '$valuePaise' } } }]);
  const stock = { [A.INVENTORY]: 0, [A.FINISHED_GOODS]: 0 };
  for (const row of rows) stock[accountOf.get(String(row._id))] += row.value;
  const balances = await balancesUpTo();
  const problems = [];
  for (const code of [A.INVENTORY, A.FINISHED_GOODS]) {
    const move = balances.get(code) ?? { debitPaise: 0, creditPaise: 0 };
    const gl = move.debitPaise - move.creditPaise;
    if (gl !== stock[code]) problems.push(`Account ${code}: ledger ${gl}, stock ${stock[code]}`);
  }
  if (problems.length) return fail('I3', name, problems.join('; '));
  return pass('I3', name, 'Inventory and finished goods agree with the stock on hand.');
}

async function checkWipMatchesBuilds() {
  const name = 'WIP matches the open builds';
  const [builds] = await MachineBuild.aggregate([{ $group: { _id: null, wip: { $sum: '$wipPaise' } } }]);
  const move = (await balancesUpTo()).get(A.WIP) ?? { debitPaise: 0, creditPaise: 0 };
  const gl = move.debitPaise - move.creditPaise;
  if (gl !== (builds?.wip ?? 0)) return fail('I4', name, `Ledger ${gl}, builds ${builds?.wip ?? 0}.`);
  const orders = await modelOf('WorkOrder').aggregate([{ $match: { status: 'SUBMITTED' } }, { $group: { _id: null, wip: { $sum: '$wipPaise' } } }]);
  const moveWo = (await balancesUpTo()).get(A.WIP_WORK_ORDERS) ?? { debitPaise: 0, creditPaise: 0 };
  const glWo = moveWo.debitPaise - moveWo.creditPaise;
  if (glWo !== (orders[0]?.wip ?? 0)) return fail('I4', name, `Work orders: ledger ${glWo}, orders ${orders[0]?.wip ?? 0}.`);
  return pass('I4', name, 'WIP in the ledger equals the cost on open builds and work orders.');
}

async function checkNoNegativeStock() {
  const name = 'No negative stock';
  const negative = await Bin.countDocuments({ $or: [{ qtyMilli: { $lt: 0 } }, { valuePaise: { $lt: 0 } }] });
  if (negative) return fail('I5', name, `${negative} bucket(s) are negative.`);
  const stranded = await Bin.countDocuments({ qtyMilli: 0, valuePaise: { $ne: 0 } });
  if (stranded) return fail('I5', name, `${stranded} bucket(s) hold value with no quantity.`);
  return pass('I5', name, 'Every bucket is zero or more, and no value is stranded.');
}

const SERIES = { QT: Quotation, SO: SalesOrder, MI: MaterialIssue, MR: MaterialIssue, TB: TimeBooking, PO: PurchaseOrder, GR: Grn, QC: Inspection, PI: PurchaseInvoice, SM: StockMove, JW: JobWorkChallan, NCR: Ncr, FAT: FatProtocol, SI: SalesInvoice, CN: AdjustmentNote, DN: AdjustmentNote, RC: Payment, PY: Payment, JV: Journal, AMC: AmcContract, ST: ServiceTicket };

async function checkNoGaps() {
  const name = 'No gaps in document numbers';
  const counters = await Counter.find({ _id: /^doc:/ }).lean();
  const problems = [];
  for (const counter of counters) {
    const [, prefix, fy] = counter._id.split(':');
    const Model = SERIES[prefix] ?? allTypes().find((t) => t.series === prefix && !t.deletable)?.Model;
    if (!Model) continue; // FG, JR, AD and DP numbers live on ledger vouchers, not on a document
    const count = await Model.countDocuments({ docNo: new RegExp(`^${prefix}/${fy}/`) });
    if (count !== counter.seq) problems.push(`${prefix}/${fy}: ${counter.seq} issued, ${count} found`);
  }
  if (problems.length) return fail('I7', name, problems.join('; '));
  return pass('I7', name, `${counters.length} series are unbroken.`);
}

export async function integrity() {
  const audit = await verifyAuditChain();
  const checks = [
    await checkGlBalances(),
    await checkBinsMatchLedger(),
    await checkStockMatchesGl(),
    await checkWipMatchesBuilds(),
    await checkNoNegativeStock(),
    audit.ok ? pass('I6', 'Audit trail is unbroken', audit.message) : fail('I6', 'Audit trail is unbroken', audit.message),
    await checkNoGaps(),
  ];
  return { ok: checks.every((c) => c.ok), checkedAt: new Date().toISOString(), checks };
}

