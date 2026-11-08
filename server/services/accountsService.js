// Sales invoices (with dispatch), credit and debit notes, receipts and payments, journals.
import { AdjustmentNote, Journal, MachineBuild, Payment, PurchaseInvoice, SalesInvoice, SalesOrder } from '../models/documents.js';
import { Account, Item, Party } from '../models/masters.js';
import { GlEntry } from '../models/ledgers.js';
import { modelOf } from '../engine/registry.js';
import { can } from '../config/permissions.js';
import { A } from '../config/accounts.js';
import { afterDiscount, lineValue, mulDivRound, sumInts, toBasePaise } from '../utils/money.js';
import { computeTax, SUPPLY, supplyTypeFor, ZERO_RATED } from '../utils/tax.js';
import { conflict, forbidden, notFound, rule } from '../utils/errors.js';
import { addDays, daysBetween, todayIst } from '../utils/dates.js';
import { assertPostingDate, getSettings } from './settingsService.js';
import { nextDocNo } from './numberService.js';
import { audit } from './auditService.js';
import { postGl, reverseGl } from './ledgerService.js';
import { pickBuckets, reverseStock, stockIn, stockOut, warehouseOfKind } from './stockService.js';

/* ---------- Sales invoice ---------- */

// What a customer owes in the ledger, plus this invoice, against their limit. A party put
// on hold cannot be invoiced at all.
export async function assertCredit(session, partyId, addingPaise, actor, overrideReason) {
  const party = await Party.findById(partyId).session(session).lean();
  if (party.isOnHold) throw rule(`${party.name} is on hold.`, 'PARTY_ON_HOLD');
  if (!party.creditLimitPaise) return;
  const [row] = await GlEntry.aggregate([
    { $match: { accountCode: A.DEBTORS, partyId: party._id } },
    { $group: { _id: null, net: { $sum: { $subtract: ['$debitPaise', '$creditPaise'] } } } },
  ]).session(session);
  const after = (row?.net ?? 0) + addingPaise;
  if (after <= party.creditLimitPaise) return;
  if (!overrideReason) throw rule(`${party.name} would owe Rs ${after / 100}, over their limit of Rs ${party.creditLimitPaise / 100}.`, 'CREDIT_LIMIT_EXCEEDED', { after, limit: party.creditLimitPaise });
  if (!can(actor.role, 'salesInvoices.override')) throw forbidden('Only management can go over a credit limit.');
}

function salesAccountFor(kind, isExport) {
  if (isExport) return A.SALES_EXPORT;
  if (kind === 'MACHINE') return A.SALES_MACHINES;
  if (kind === 'GOODS') return A.SALES_SPARES;
  return A.SALES_SERVICE;
}

export const salesInvoice = {
  Model: SalesInvoice,
  async prepare(session, data) {
    const party = await Party.findById(data.partyId).session(session).lean();
    if (!party || !party.isCustomer) throw rule('That customer does not exist.', 'UNKNOWN_PARTY');
    const settings = await getSettings(session);
    const isExport = data.isExport ?? party.isExport;
    const currency = data.currency ?? party.currency;
    const fxRate4 = currency === 'INR' ? 10000 : data.fxRate4;
    if (currency !== 'INR' && !fxRate4) throw rule('A foreign currency invoice needs an exchange rate.', 'FX_REQUIRED');
    const exportUnderLut = data.exportUnderLut ?? true;
    // Tax follows the place of supply, which is where the goods go, not where the buyer's
    // office is. It defaults to the customer's state.
    const placeState = data.placeOfSupplyState || party.stateCode;
    const supplyType = supplyTypeFor({ companyState: settings.stateCode, partyState: placeState, isExport, isSez: party.isSez, exportUnderLut });
    if (currency !== 'INR' && supplyType !== SUPPLY.EXPORT_LUT) {
      throw rule('A foreign currency invoice must be an export under LUT.', 'FX_LUT_ONLY');
    }
    const underLut = [SUPPLY.EXPORT_LUT, SUPPLY.SEZ_LUT].includes(supplyType);
    if (underLut && !settings.lutNumber) throw rule('Enter the company\'s LUT number in Settings first.', 'LUT_REQUIRED');

    const items = await Item.find({ _id: { $in: data.lines.map((l) => l.itemId).filter(Boolean) } }).session(session).lean();
    const builds = await MachineBuild.find({ _id: { $in: data.lines.map((l) => l.buildId).filter(Boolean) } }).session(session).lean();
    const lines = data.lines.map((line) => {
      let item = items.find((i) => String(i._id) === String(line.itemId));
      let build = null;
      if (line.kind === 'MACHINE') {
        build = builds.find((b) => String(b._id) === String(line.buildId));
        if (!build) throw rule('A machine line needs a build.', 'UNKNOWN_BUILD');
        item = items.find((i) => String(i._id) === String(build.itemId)) ?? { _id: build.itemId, code: build.itemCode, name: build.itemName, uom: 'NOS', hsn: build.hsn };
      }
      if (!item) throw rule('A line names an item that does not exist.', 'UNKNOWN_ITEM');
      const qtyMilli = line.kind === 'MACHINE' ? 1000 : line.qtyMilli;
      const taxableMinor = afterDiscount(lineValue(qtyMilli, line.rateMinor), line.discountBps ?? 0);
      return {
        kind: line.kind,
        itemId: item._id,
        itemCode: item.code,
        itemName: item.name,
        uom: item.uom,
        hsn: item.hsn,
        description: line.description ?? '',
        buildId: build?._id ?? null,
        serialNo: build?.serialNo ?? null,
        deliveryNoteId: line.deliveryNoteId ?? null,
        qtyMilli,
        rateMinor: line.rateMinor,
        discountBps: line.discountBps ?? 0,
        gstTreatment: item.gstTreatment ?? 'TAXABLE',
        gstRateBps: item.gstTreatment && item.gstTreatment !== 'TAXABLE' ? 0 : (line.gstRateBps ?? item.gstRateBps ?? 1800),
        taxableMinor,
        taxablePaise: toBasePaise(taxableMinor, fxRate4),
      };
    });
    const tax = computeTax(lines.map((l) => ({ taxablePaise: l.taxablePaise, gstRateBps: l.gstRateBps })), supplyType, {
      roundOff: settings.roundOffInvoices && currency === 'INR',
    });
    lines.forEach((line, i) => Object.assign(line, tax.lineTax[i]));
    const { lineTax: _lineTax, ...totals } = tax;
    const { exportUnderLut: _ignored, placeOfSupplyState: _place, ...rest } = data;
    return {
      ...rest,
      partyName: party.name,
      partyGstin: party.gstin,
      placeOfSupply: isExport ? '96' : placeState,
      currency,
      fxRate4,
      isExport,
      lutNumber: underLut ? settings.lutNumber : '',
      dueDate: data.dueDate ?? addDays(data.postingDate, party.paymentTermsDays),
      lines,
      ...totals,
      totalMinor: currency === 'INR' ? totals.totalPaise : sumInts(lines.map((l) => l.taxableMinor)),
    };
  },
  // The invoice travels with the goods, so submitting it is also the dispatch.
  async submit(session, doc, { actor, body }) {
    if (doc.status !== 'DRAFT') throw conflict('Only a draft can be submitted.');
    await assertCredit(session, doc.partyId, doc.totalPaise, actor, body?.creditOverrideReason);
    const settings = await getSettings(session);
    if (settings.einvoiceRequired && settings.einvoiceReportDays > 0 && (doc.partyGstin || ZERO_RATED.has(doc.supplyType))
      && daysBetween(doc.postingDate, todayIst()) > settings.einvoiceReportDays) {
      throw rule(`An e-invoice must be reported within ${settings.einvoiceReportDays} days, and this is dated ${doc.postingDate}.`, 'TOO_OLD_FOR_IRN');
    }
    doc.creditOverrideReason = body?.creditOverrideReason ?? '';
    doc.docNo = await nextDocNo(session, 'SI', doc.postingDate);
    doc.status = 'SUBMITTED';
    const voucher = { voucherType: 'SalesInvoice', voucherId: doc._id, voucherNo: doc.docNo, postingDate: doc.postingDate };

    const gl = [{ accountCode: A.DEBTORS, debitPaise: doc.totalPaise, partyId: doc.partyId }];
    let totalCost = 0;
    const serials = [];

    for (const line of doc.lines) {
      gl.push({ accountCode: salesAccountFor(line.kind, doc.isExport), creditPaise: line.taxablePaise, buildId: line.buildId });
      if (line.kind === 'MACHINE') {
        const build = await MachineBuild.findById(line.buildId).session(session);
        if (build.stage !== 'READY') throw rule(`${build.serialNo} is at ${build.stage}, not ready to dispatch.`, 'BUILD_NOT_READY');
        if (build.fatStatus !== 'PASSED') throw rule(`${build.serialNo} has not passed its FAT.`, 'FAT_NOT_PASSED');
        if (String(build.partyId) !== String(doc.partyId)) throw rule(`${build.serialNo} was built for another customer.`, 'BUILD_OTHER_CUSTOMER');
        await assertDispatchPayments(session, build, doc, actor, body);
        const fg = await warehouseOfKind(session, 'FG');
        const { valuePaise } = await stockOut(session, { voucher, itemId: build.itemId, warehouseId: fg._id, buildId: build._id, qtyMilli: 1000 });
        line.costPaise = valuePaise;
        totalCost += valuePaise;
        gl.push(
          { accountCode: A.COGS, debitPaise: valuePaise, buildId: build._id },
          { accountCode: A.FINISHED_GOODS, creditPaise: valuePaise, buildId: build._id },
        );
        build.stage = 'DISPATCHED';
        build.dispatchedOn = doc.postingDate;
        build.salesInvoiceId = doc._id;
        build.stageHistory.push({ stage: 'DISPATCHED', at: new Date(), byName: actor.name, note: `Invoice ${doc.docNo}` });
        await build.save({ session });
        serials.push(build.serialNo);
      } else if (line.kind === 'GOODS' && line.deliveryNoteId) {
        // The goods and their cost already left on the delivery note.
        const note = await modelOf('DeliveryNote').findById(line.deliveryNoteId).session(session);
        if (!note || note.status !== 'SUBMITTED') throw rule('That delivery note is not live.', 'DELIVERY_NOT_LIVE');
        if (String(note.partyId) !== String(doc.partyId)) throw rule(`${note.docNo} went to another customer.`, 'DELIVERY_OTHER_CUSTOMER');
        const row = note.lines.find((r) => String(r.itemId) === String(line.itemId) && r.billedMilli + line.qtyMilli <= r.qtyMilli);
        if (!row) throw rule(`More of ${line.itemCode} is being billed than ${note.docNo} delivered.`, 'OVER_BILLED');
        row.billedMilli += line.qtyMilli;
        note.isBilled = note.lines.every((r) => r.billedMilli >= r.qtyMilli);
        await note.save({ session });
      } else if (line.kind === 'GOODS') {
        const picks = await pickBuckets(session, { itemId: line.itemId, qtyMilli: line.qtyMilli });
        let value = 0;
        for (const pick of picks) {
          const taken = await stockOut(session, { voucher, ...pick });
          value += taken.valuePaise;
        }
        line.costPaise = value;
        totalCost += value;
        gl.push({ accountCode: A.COGS, debitPaise: value }, { accountCode: A.INVENTORY, creditPaise: value });
      }
    }
    doc.costPaise = totalCost;

    gl.push(
      { accountCode: A.OUTPUT_CGST, creditPaise: doc.cgstPaise },
      { accountCode: A.OUTPUT_SGST, creditPaise: doc.sgstPaise },
      { accountCode: A.OUTPUT_IGST, creditPaise: doc.igstPaise },
    );
    if (doc.roundOffPaise > 0) gl.push({ accountCode: A.ROUND_OFF, creditPaise: doc.roundOffPaise });
    if (doc.roundOffPaise < 0) gl.push({ accountCode: A.ROUND_OFF, debitPaise: -doc.roundOffPaise });

    await postGl(session, { postingDate: doc.postingDate, voucherType: 'SalesInvoice', voucherId: doc._id, voucherNo: doc.docNo, narration: `Invoice to ${doc.partyName}`, lines: gl });
    return { action: 'SALES_INVOICE_POSTED', actor, data: { totalPaise: doc.totalPaise, serials } };
  },
  async cancel(session, doc, { postingDate }) {
    if (doc.paidMinor > 0) throw rule('This invoice has receipts against it. Cancel them first.', 'INVOICE_HAS_PAYMENTS');
    if (doc.creditedMinor > 0) throw rule('This invoice has credit notes against it. Cancel them first.', 'INVOICE_HAS_NOTES');
    if (doc.irn && !doc.irnCancelledAt) throw rule('Cancel the IRN on the portal first, then record that here.', 'CANCEL_IRN_FIRST');
    if (doc.postingDate.slice(0, 7) !== postingDate.slice(0, 7)) {
      throw rule('An invoice from an earlier month cannot be cancelled. Issue a credit note.', 'USE_CREDIT_NOTE');
    }
    await reverseStock(session, { voucherType: 'SalesInvoice', voucherId: doc._id, voucherNo: doc.docNo, postingDate });
    await reverseGl(session, { postingDate, voucherType: 'SalesInvoice', voucherId: doc._id, voucherNo: doc.docNo });
    for (const line of doc.lines) {
      if (line.deliveryNoteId) {
        const note = await modelOf('DeliveryNote').findById(line.deliveryNoteId).session(session);
        const row = note.lines.find((r) => String(r.itemId) === String(line.itemId) && r.billedMilli >= line.qtyMilli);
        if (row) row.billedMilli -= line.qtyMilli;
        note.isBilled = false;
        await note.save({ session });
      }
      if (line.kind !== 'MACHINE') continue;
      const build = await MachineBuild.findById(line.buildId).session(session);
      if (build.stage !== 'DISPATCHED') throw rule(`${build.serialNo} has moved on to ${build.stage}.`, 'BUILD_MOVED_ON');
      build.stage = 'READY';
      build.dispatchedOn = null;
      build.salesInvoiceId = null;
      build.stageHistory.push({ stage: 'READY', at: new Date(), byName: 'System', note: `Invoice ${doc.docNo} cancelled` });
      await build.save({ session });
    }
    doc.status = 'CANCELLED';
  },
};

// Money due before dispatch must be in, or someone allowed to must override with a reason.
async function assertDispatchPayments(session, build, doc, actor, body) {
  if (!build.salesOrderId) return;
  const order = await SalesOrder.findById(build.salesOrderId).session(session).lean();
  if (!order) return;
  const due = order.milestones.filter((m) => m.trigger !== 'AFTER_INSTALLATION');
  const dueMinor = sumInts(due.map((m) => m.amountMinor));
  const receivedMinor = sumInts(order.milestones.map((m) => m.receivedMinor));
  if (receivedMinor >= dueMinor) return;
  if (!body?.milestoneOverrideReason) {
    throw rule(`Order ${order.docNo} has ${dueMinor - receivedMinor} (minor units) still due before dispatch.`, 'PAYMENT_DUE_BEFORE_DISPATCH', { dueMinor, receivedMinor });
  }
  if (!can(actor.role, 'salesInvoices.override')) throw forbidden('Only management can dispatch before payment.');
  doc.milestoneOverrideReason = body.milestoneOverrideReason;
  doc.milestoneOverrideBy = actor.id;
  await audit(session, { actor, action: 'DISPATCH_BEFORE_PAYMENT', entityType: 'SalesInvoice', entityId: doc._id, entityNo: doc.docNo, reason: body.milestoneOverrideReason, data: { dueMinor, receivedMinor } });
}

/* ---------- Credit and debit notes ---------- */

export const adjustmentNote = {
  Model: AdjustmentNote,
  async prepare(session, data) {
    const isCredit = data.kind === 'CREDIT';
    const invoice = isCredit
      ? await SalesInvoice.findById(data.invoiceId).session(session).lean()
      : await PurchaseInvoice.findById(data.invoiceId).session(session).lean();
    if (!invoice || invoice.status !== 'SUBMITTED') throw rule('A note needs a submitted invoice.', 'INVOICE_NOT_SUBMITTED');
    const fxRate4 = isCredit ? invoice.fxRate4 : 10000;
    const lines = data.lines.map((line) => {
      const source = invoice.lines.find((l) => String(l._id) === String(line.invoiceLineId));
      if (!source) throw rule('A line does not belong to this invoice.', 'BAD_INVOICE_LINE');
      return {
        invoiceLineId: source._id,
        itemId: source.itemId,
        itemCode: source.itemCode,
        itemName: source.itemName,
        hsn: source.hsn,
        gstRateBps: source.gstRateBps,
        qtyMilli: line.qtyMilli ?? 0,
        taxableMinor: line.taxableMinor,
        taxablePaise: toBasePaise(line.taxableMinor, fxRate4),
        returnGoods: line.returnGoods ?? false,
        warehouseId: line.warehouseId ?? null,
        lot: line.lot ?? '',
        salesAccountCode: isCredit ? salesAccountFor(source.kind, invoice.isExport) : null,
        itcBlocked: isCredit ? false : Boolean(source.itcBlocked),
      };
    });
    const tax = computeTax(lines.map((l) => ({ taxablePaise: l.taxablePaise, gstRateBps: l.gstRateBps })), invoice.supplyType);
    const { lineTax, slabs: _slabs, ...totals } = tax;
    lines.forEach((line, i) => Object.assign(line, lineTax[i]));
    const isReverseCharge = !isCredit && Boolean(invoice.isReverseCharge);
    if (isReverseCharge) totals.totalPaise = totals.taxablePaise;
    return {
      ...data,
      invoiceNo: invoice.docNo,
      partyId: invoice.partyId,
      partyName: invoice.partyName,
      partyGstin: invoice.partyGstin ?? invoice.supplierGstin ?? '',
      currency: isCredit ? invoice.currency : 'INR',
      fxRate4,
      lines,
      ...totals,
      isReverseCharge,
      totalMinor: isCredit && invoice.currency !== 'INR' ? sumInts(lines.map((l) => l.taxableMinor)) : totals.totalPaise,
    };
  },
  async submit(session, doc, { actor }) {
    if (doc.status !== 'DRAFT') throw conflict('Only a draft can be submitted.');
    const isCredit = doc.kind === 'CREDIT';
    const invoice = isCredit
      ? await SalesInvoice.findById(doc.invoiceId).session(session)
      : await PurchaseInvoice.findById(doc.invoiceId).session(session);
    if (invoice.status !== 'SUBMITTED') throw rule('That invoice is no longer live.', 'INVOICE_NOT_SUBMITTED');
    doc.docNo = await nextDocNo(session, isCredit ? 'CN' : 'DN', doc.postingDate);
    doc.status = 'SUBMITTED';
    const voucher = { voucherType: 'AdjustmentNote', voucherId: doc._id, voucherNo: doc.docNo, postingDate: doc.postingDate };
    const gl = [];

    if (isCredit) {
      const outstanding = invoice.totalMinor - invoice.paidMinor - invoice.creditedMinor;
      if (doc.totalMinor > outstanding) throw rule('This note is larger than what is left on the invoice. Refund the receipt first.', 'NOTE_TOO_LARGE', { outstanding });
      for (const line of doc.lines) {
        gl.push({ accountCode: line.salesAccountCode, debitPaise: line.taxablePaise });
        if (line.returnGoods) {
          const source = invoice.lines.id(line.invoiceLineId);
          if (source.kind !== 'GOODS') throw rule('Only spares can come back on a credit note.', 'RETURN_GOODS_ONLY');
          if (!line.warehouseId || !line.qtyMilli) throw rule('Returned goods need a warehouse and a quantity.', 'RETURN_NEEDS_WAREHOUSE');
          if (line.qtyMilli > source.qtyMilli) throw rule('More is coming back than was sold.', 'RETURN_TOO_MUCH');
          const value = mulDivRound(source.costPaise, line.qtyMilli, source.qtyMilli);
          await stockIn(session, { voucher, itemId: line.itemId, warehouseId: line.warehouseId, lot: line.lot, qtyMilli: line.qtyMilli, valuePaise: value });
          line.stockValuePaise = value;
          gl.push({ accountCode: A.INVENTORY, debitPaise: value }, { accountCode: A.COGS, creditPaise: value });
        }
      }
      gl.push(
        { accountCode: A.OUTPUT_CGST, debitPaise: doc.cgstPaise },
        { accountCode: A.OUTPUT_SGST, debitPaise: doc.sgstPaise },
        { accountCode: A.OUTPUT_IGST, debitPaise: doc.igstPaise },
        { accountCode: A.DEBTORS, creditPaise: doc.totalPaise, partyId: doc.partyId },
      );
      invoice.creditedMinor += doc.totalMinor;
      invoice.creditedPaise += doc.totalPaise;
    } else {
      const outstanding = invoice.totalPaise - invoice.paidPaise - invoice.creditedPaise;
      if (doc.totalPaise > outstanding) throw rule('This note is larger than what is left on the invoice.', 'NOTE_TOO_LARGE', { outstanding });
      gl.push({ accountCode: A.CREDITORS, debitPaise: doc.totalPaise, partyId: doc.partyId });
      for (const line of doc.lines) {
        let stockValue = 0;
        if (line.returnGoods) {
          const reject = await warehouseOfKind(session, 'REJECT');
          if (!line.qtyMilli) throw rule('Returned goods need a quantity.', 'RETURN_NEEDS_WAREHOUSE');
          const taken = await stockOut(session, { voucher, itemId: line.itemId, warehouseId: reject._id, lot: line.lot, qtyMilli: line.qtyMilli });
          stockValue = taken.valuePaise;
          line.stockValuePaise = stockValue;
          gl.push({ accountCode: A.INVENTORY, creditPaise: stockValue });
        }
        const variance = line.taxablePaise - stockValue;
        if (variance > 0) gl.push({ accountCode: A.PRICE_VARIANCE, creditPaise: variance });
        if (variance < 0) gl.push({ accountCode: A.PRICE_VARIANCE, debitPaise: -variance });
      }
      const sumOf = (key, blocked) => sumInts(doc.lines.filter((l) => Boolean(l.itcBlocked) === blocked).map((l) => l[key]));
      gl.push(
        { accountCode: A.INPUT_CGST, creditPaise: sumOf('cgstPaise', false) },
        { accountCode: A.INPUT_SGST, creditPaise: sumOf('sgstPaise', false) },
        { accountCode: A.INPUT_IGST, creditPaise: sumOf('igstPaise', false) },
        { accountCode: A.GST_NOT_CLAIMABLE, creditPaise: sumOf('cgstPaise', true) + sumOf('sgstPaise', true) + sumOf('igstPaise', true) },
      );
      if (doc.isReverseCharge) {
        gl.push(
          { accountCode: A.RCM_CGST, debitPaise: doc.cgstPaise },
          { accountCode: A.RCM_SGST, debitPaise: doc.sgstPaise },
          { accountCode: A.RCM_IGST, debitPaise: doc.igstPaise },
        );
      }
      invoice.creditedPaise += doc.totalPaise;
    }
    await invoice.save({ session });
    await postGl(session, { postingDate: doc.postingDate, voucherType: 'AdjustmentNote', voucherId: doc._id, voucherNo: doc.docNo, narration: `${isCredit ? 'Credit' : 'Debit'} note on ${doc.invoiceNo}: ${doc.reason}`, lines: gl });
    return { action: isCredit ? 'CREDIT_NOTE_POSTED' : 'DEBIT_NOTE_POSTED', actor, reason: doc.reason, data: { invoiceNo: doc.invoiceNo, totalPaise: doc.totalPaise } };
  },
  async cancel(session, doc, { postingDate }) {
    const isCredit = doc.kind === 'CREDIT';
    await reverseStock(session, { voucherType: 'AdjustmentNote', voucherId: doc._id, voucherNo: doc.docNo, postingDate });
    await reverseGl(session, { postingDate, voucherType: 'AdjustmentNote', voucherId: doc._id, voucherNo: doc.docNo });
    const invoice = isCredit
      ? await SalesInvoice.findById(doc.invoiceId).session(session)
      : await PurchaseInvoice.findById(doc.invoiceId).session(session);
    if (isCredit) invoice.creditedMinor -= doc.totalMinor;
    invoice.creditedPaise -= doc.totalPaise;
    await invoice.save({ session });
    doc.status = 'CANCELLED';
  },
};

/* ---------- Receipts and payments ---------- */

const outstandingMinor = (invoice, isSales) => (isSales
  ? invoice.totalMinor - invoice.paidMinor - invoice.creditedMinor
  : invoice.totalPaise - invoice.paidPaise - invoice.creditedPaise);

// What a payment settles with the party: the money, plus anything they kept or we kept,
// like TDS, bank charges or a small write-off.
const partyMinorOf = (payment) => payment.amountMinor + (payment.deductionsPaise ?? 0);
const partyPaiseOf = (payment) => payment.amountPaise + (payment.deductionsPaise ?? 0);

// Applies part of a payment to an invoice. The invoice is cleared at its own rate and the
// payment at its own, and the gap is the forex gain or loss. Shares are worked out
// cumulatively, so paying in full clears every paisa whatever the instalments were.
async function applyAllocation(session, payment, { docId, amountMinor }, postingDate) {
  const isReceipt = payment.kind === 'RECEIPT';
  const invoice = isReceipt
    ? await SalesInvoice.findById(docId).session(session)
    : await PurchaseInvoice.findById(docId).session(session);
  if (!invoice || invoice.status !== 'SUBMITTED') throw rule('That invoice is not live.', 'INVOICE_NOT_SUBMITTED');
  if (String(invoice.partyId) !== String(payment.partyId)) throw rule(`${invoice.docNo} belongs to another party.`, 'INVOICE_OTHER_PARTY');
  const currency = isReceipt ? invoice.currency : 'INR';
  if (currency !== payment.currency) throw rule(`${invoice.docNo} is in ${currency}, and this payment is in ${payment.currency}.`, 'CURRENCY_MISMATCH');
  if (payment.allocatedMinor + amountMinor > partyMinorOf(payment)) throw rule('This is more than is left on the payment.', 'OVER_ALLOCATED');
  if (amountMinor > outstandingMinor(invoice, isReceipt)) throw rule(`This is more than is left on ${invoice.docNo}.`, 'OVER_PAID', { outstandingMinor: outstandingMinor(invoice, isReceipt) });

  let carriedPaise = amountMinor;
  let forexPaise = 0;
  if (isReceipt) {
    const before = mulDivRound(invoice.totalPaise, invoice.paidMinor, invoice.totalMinor);
    const after = mulDivRound(invoice.totalPaise, invoice.paidMinor + amountMinor, invoice.totalMinor);
    carriedPaise = after - before;
    const shareBefore = mulDivRound(partyPaiseOf(payment), payment.allocatedMinor, partyMinorOf(payment));
    const shareAfter = mulDivRound(partyPaiseOf(payment), payment.allocatedMinor + amountMinor, partyMinorOf(payment));
    forexPaise = (shareAfter - shareBefore) - carriedPaise;
    invoice.paidMinor += amountMinor;
    invoice.paidPaise += carriedPaise;
  } else {
    invoice.paidPaise += amountMinor;
  }
  await invoice.save({ session });

  if (forexPaise !== 0) {
    await postGl(session, {
      postingDate,
      voucherType: 'PaymentForex',
      voucherId: payment._id,
      voucherNo: payment.docNo,
      narration: `Exchange difference on ${invoice.docNo}`,
      lines: forexPaise > 0
        ? [{ accountCode: A.DEBTORS, debitPaise: forexPaise, partyId: payment.partyId }, { accountCode: A.FOREX_GAIN, creditPaise: forexPaise }]
        : [{ accountCode: A.FOREX_LOSS, debitPaise: -forexPaise }, { accountCode: A.DEBTORS, creditPaise: -forexPaise, partyId: payment.partyId }],
    });
  }
  payment.allocatedMinor += amountMinor;
  payment.allocations.push({
    docType: isReceipt ? 'SalesInvoice' : 'PurchaseInvoice',
    docId: invoice._id,
    docNo: invoice.docNo,
    amountMinor,
    carriedPaise,
    forexPaise,
    allocatedOn: postingDate,
    voucherNo: payment.docNo,
  });
}

export const payment = {
  Model: Payment,
  async prepare(session, data) {
    const party = await Party.findById(data.partyId).session(session).lean();
    if (!party) throw rule('That party does not exist.', 'UNKNOWN_PARTY');
    const account = await Account.findOne({ code: data.bankAccountCode }).session(session).lean();
    if (!account?.isCashOrBank) throw rule('Choose a cash or bank account.', 'NOT_BANK_ACCOUNT');
    const currency = data.currency ?? 'INR';
    const fxRate4 = currency === 'INR' ? 10000 : data.fxRate4;
    if (!fxRate4) throw rule('A foreign currency payment needs an exchange rate.', 'FX_REQUIRED');
    if (data.kind === 'PAYMENT' && currency !== 'INR') throw rule('Payments to suppliers are in rupees for now.', 'PAYMENT_INR_ONLY');
    const deductions = data.deductions ?? [];
    if (deductions.length && currency !== 'INR') throw rule('Deductions on a foreign currency payment are not supported yet.', 'DEDUCTIONS_INR_ONLY');
    if (deductions.length) {
      const found = await Account.find({ code: { $in: deductions.map((d) => d.accountCode) } }).session(session).lean();
      for (const row of deductions) {
        const account = found.find((a) => a.code === row.accountCode);
        if (!account) throw rule(`Account ${row.accountCode} does not exist.`, 'UNKNOWN_ACCOUNT');
        if (account.isControl) throw rule(`${account.name} is a control account.`, 'CONTROL_ACCOUNT');
      }
    }
    const docType = data.kind === 'RECEIPT' ? 'SalesInvoice' : 'PurchaseInvoice';
    return {
      ...data,
      partyName: party.name,
      currency,
      fxRate4,
      amountPaise: toBasePaise(data.amountMinor, fxRate4),
      deductions,
      deductionsPaise: sumInts(deductions.map((d) => d.amountPaise)),
      allocations: (data.allocations ?? []).map((a) => ({ ...a, docType })),
    };
  },
  async submit(session, doc, { actor }) {
    if (doc.status !== 'DRAFT') throw conflict('Only a draft can be submitted.');
    const isReceipt = doc.kind === 'RECEIPT';
    doc.docNo = await nextDocNo(session, isReceipt ? 'RC' : 'PY', doc.postingDate);
    doc.status = 'SUBMITTED';

    await postGl(session, {
      postingDate: doc.postingDate,
      voucherType: 'Payment',
      voucherId: doc._id,
      voucherNo: doc.docNo,
      narration: `${isReceipt ? 'Receipt from' : 'Payment to'} ${doc.partyName} ${doc.reference}`,
      lines: isReceipt
        ? [
          { accountCode: doc.bankAccountCode, debitPaise: doc.amountPaise },
          ...doc.deductions.map((d) => ({ accountCode: d.accountCode, debitPaise: d.amountPaise, narration: d.description })),
          { accountCode: A.DEBTORS, creditPaise: partyPaiseOf(doc), partyId: doc.partyId },
        ]
        : [
          { accountCode: A.CREDITORS, debitPaise: partyPaiseOf(doc), partyId: doc.partyId },
          { accountCode: doc.bankAccountCode, creditPaise: doc.amountPaise },
          ...doc.deductions.map((d) => ({ accountCode: d.accountCode, creditPaise: d.amountPaise, narration: d.description })),
        ],
    });

    if (doc.salesOrderId) {
      if (!isReceipt) throw rule('Only a receipt can be linked to a sales order.', 'BAD_MILESTONE');
      const order = await SalesOrder.findById(doc.salesOrderId).session(session);
      if (!order || order.status !== 'CONFIRMED') throw rule('That sales order is not confirmed.', 'BAD_MILESTONE');
      if (String(order.partyId) !== String(doc.partyId)) throw rule('That sales order belongs to another customer.', 'BAD_MILESTONE');
      if (order.currency !== doc.currency) throw rule(`That order is in ${order.currency}.`, 'CURRENCY_MISMATCH');
      const milestone = order.milestones.find((m) => m.no === doc.milestoneNo);
      if (!milestone) throw rule('That milestone is not on the order.', 'BAD_MILESTONE');
      milestone.receivedMinor += partyMinorOf(doc);
      await order.save({ session });
    }

    const planned = doc.allocations.map((a) => ({ docId: a.docId, amountMinor: a.amountMinor }));
    doc.allocations = [];
    doc.allocatedMinor = 0;
    for (const allocation of planned) await applyAllocation(session, doc, allocation, doc.postingDate);
    return { action: isReceipt ? 'RECEIPT_POSTED' : 'PAYMENT_POSTED', actor, data: { amountPaise: doc.amountPaise } };
  },
  async cancel(session, doc, { postingDate }) {
    const isReceipt = doc.kind === 'RECEIPT';
    await reverseGl(session, { postingDate, voucherType: 'Payment', voucherId: doc._id, voucherNo: doc.docNo });
    await reverseGl(session, { postingDate, voucherType: 'PaymentForex', voucherId: doc._id, voucherNo: doc.docNo });
    for (const allocation of doc.allocations) {
      const invoice = isReceipt
        ? await SalesInvoice.findById(allocation.docId).session(session)
        : await PurchaseInvoice.findById(allocation.docId).session(session);
      if (isReceipt) invoice.paidMinor -= allocation.amountMinor;
      invoice.paidPaise -= isReceipt ? allocation.carriedPaise : allocation.amountMinor;
      await invoice.save({ session });
    }
    if (doc.salesOrderId) {
      const order = await SalesOrder.findById(doc.salesOrderId).session(session);
      order.milestones.find((m) => m.no === doc.milestoneNo).receivedMinor -= partyMinorOf(doc);
      await order.save({ session });
    }
    doc.status = 'CANCELLED';
  },
};

// Adjusts an advance already received against an invoice raised later.
export async function allocatePayment(session, id, { docId, amountMinor, postingDate }, actor) {
  const doc = await Payment.findById(id).session(session);
  if (!doc) throw notFound('Payment');
  if (doc.status !== 'SUBMITTED') throw rule('Only a submitted payment can be allocated.', 'PAYMENT_NOT_SUBMITTED');
  const settings = await getSettings(session);
  assertPostingDate(postingDate, settings);
  await applyAllocation(session, doc, { docId, amountMinor }, postingDate);
  await doc.save({ session });
  await audit(session, { actor, action: 'PAYMENT_ALLOCATED', entityType: 'Payment', entityId: doc._id, entityNo: doc.docNo, data: { amountMinor, docNo: doc.allocations.at(-1).docNo } });
  return doc;
}

// The IRN comes back from the portal, and is kept on the invoice it belongs to.
export async function recordIrn(session, id, { irn, ackNo, ackAt }, actor) {
  const doc = await SalesInvoice.findById(id).session(session);
  if (!doc) throw notFound('Invoice');
  if (doc.status !== 'SUBMITTED') throw rule('Only a submitted invoice has an IRN.', 'INVOICE_NOT_SUBMITTED');
  if (doc.isOpening) throw rule('An opening balance is not an invoice for the portal.', 'OPENING_INVOICE');
  if (doc.irn && !doc.irnCancelledAt) throw conflict('This invoice already has an IRN.', 'IRN_EXISTS');
  doc.irn = irn.toLowerCase();
  doc.irnAckNo = ackNo;
  doc.irnAckAt = new Date(ackAt);
  doc.irnCancelledAt = null;
  await doc.save({ session });
  await audit(session, { actor, action: 'IRN_RECORDED', entityType: 'SalesInvoice', entityId: doc._id, entityNo: doc.docNo, data: { ackNo } });
  return doc;
}

// The portal allows this within 24 hours. After that, the fix is a credit note.
const IRN_CANCEL_WINDOW_MS = 24 * 3600000;

export async function recordIrnCancelled(session, id, reason, actor, now = new Date()) {
  const doc = await SalesInvoice.findById(id).session(session);
  if (!doc) throw notFound('Invoice');
  if (!doc.irn || doc.irnCancelledAt) throw rule('This invoice has no live IRN.', 'NO_LIVE_IRN');
  if (now.getTime() - doc.irnAckAt.getTime() > IRN_CANCEL_WINDOW_MS) {
    throw rule('An IRN can only be cancelled within 24 hours. Issue a credit note instead.', 'IRN_CANCEL_WINDOW_OVER');
  }
  doc.irnCancelledAt = now;
  await doc.save({ session });
  await audit(session, { actor, action: 'IRN_CANCELLED', entityType: 'SalesInvoice', entityId: doc._id, entityNo: doc.docNo, reason });
  return doc;
}

// Takes one allocation back off an invoice, and the money is free to allocate again.
export async function unallocatePayment(session, id, { allocationId, postingDate }, actor) {
  const doc = await Payment.findById(id).session(session);
  if (!doc) throw notFound('Payment');
  if (doc.status !== 'SUBMITTED') throw rule('Only a submitted payment can be changed.', 'PAYMENT_NOT_SUBMITTED');
  const settings = await getSettings(session);
  assertPostingDate(postingDate, settings);
  const allocation = doc.allocations.id(allocationId);
  if (!allocation) throw notFound('Allocation');
  const isReceipt = doc.kind === 'RECEIPT';
  const invoice = isReceipt
    ? await SalesInvoice.findById(allocation.docId).session(session)
    : await PurchaseInvoice.findById(allocation.docId).session(session);
  if (isReceipt) invoice.paidMinor -= allocation.amountMinor;
  invoice.paidPaise -= isReceipt ? allocation.carriedPaise : allocation.amountMinor;
  await invoice.save({ session });
  if (allocation.forexPaise !== 0) {
    const value = Math.abs(allocation.forexPaise);
    await postGl(session, {
      postingDate,
      voucherType: 'PaymentForex',
      voucherId: doc._id,
      voucherNo: doc.docNo,
      isReversal: true,
      narration: `Exchange difference reversed on ${allocation.docNo}`,
      lines: allocation.forexPaise > 0
        ? [{ accountCode: A.FOREX_GAIN, debitPaise: value }, { accountCode: A.DEBTORS, creditPaise: value, partyId: doc.partyId }]
        : [{ accountCode: A.DEBTORS, debitPaise: value, partyId: doc.partyId }, { accountCode: A.FOREX_LOSS, creditPaise: value }],
    });
  }
  doc.allocatedMinor -= allocation.amountMinor;
  const undone = { docNo: allocation.docNo, amountMinor: allocation.amountMinor };
  doc.allocations.pull(allocation._id);
  await doc.save({ session });
  await audit(session, { actor, action: 'PAYMENT_UNALLOCATED', entityType: 'Payment', entityId: doc._id, entityNo: doc.docNo, data: undone });
  return doc;
}

/* ---------- Journal ---------- */

export const journal = {
  Model: Journal,
  async prepare(session, data) {
    const codes = [...new Set(data.lines.map((l) => l.accountCode))];
    const accounts = await Account.find({ code: { $in: codes } }).session(session).lean();
    for (const code of codes) {
      const account = accounts.find((a) => a.code === code);
      if (!account) throw rule(`Account ${code} does not exist.`, 'UNKNOWN_ACCOUNT');
      // Only the documents that own these balances may move them, or the sub-ledgers
      // would stop agreeing with the GL.
      if (account.isControl) throw rule(`${account.name} is a control account. Use its own document.`, 'CONTROL_ACCOUNT');
    }
    return { ...data, totalPaise: sumInts(data.lines.map((l) => l.debitPaise ?? 0)) };
  },
  async submit(session, doc, { actor }) {
    if (doc.status !== 'DRAFT') throw conflict('Only a draft can be submitted.');
    doc.docNo = await nextDocNo(session, 'JV', doc.postingDate);
    doc.status = 'SUBMITTED';
    await postGl(session, {
      postingDate: doc.postingDate,
      voucherType: 'Journal',
      voucherId: doc._id,
      voucherNo: doc.docNo,
      narration: doc.narration,
      lines: doc.lines.map((l) => ({ accountCode: l.accountCode, debitPaise: l.debitPaise, creditPaise: l.creditPaise, partyId: l.partyId, costCenterId: l.costCenterId, projectId: l.projectId })),
    });
    return { action: 'JOURNAL_POSTED', actor, reason: doc.narration, data: { totalPaise: doc.totalPaise } };
  },
  async cancel(session, doc, { postingDate }) {
    await reverseGl(session, { postingDate, voucherType: 'Journal', voucherId: doc._id, voucherNo: doc.docNo });
    doc.status = 'CANCELLED';
  },
};
