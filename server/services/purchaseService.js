// Purchase orders, goods receipts, incoming inspection, purchase invoices.
import { Grn, Inspection, MachineBuild, Ncr, PurchaseInvoice, PurchaseOrder } from '../models/documents.js';
import { Item, Party } from '../models/masters.js';
import { A } from '../config/accounts.js';
import { lineValue, mulDivRound, sumInts } from '../utils/money.js';
import { computeTax, SUPPLY, supplyTypeFor } from '../utils/tax.js';
import { conflict, notFound, rule } from '../utils/errors.js';
import { addDays } from '../utils/dates.js';
import { assertPostingDate, getSettings } from './settingsService.js';
import { nextDocNo } from './numberService.js';
import { audit } from './auditService.js';
import { postGl, reverseGl } from './ledgerService.js';
import { reverseStock, stockIn, stockMove, warehouseOfKind } from './stockService.js';

async function supplierFor(session, partyId, { allowJobWorker = false } = {}) {
  const party = await Party.findById(partyId).session(session).lean();
  if (!party || !(party.isSupplier || (allowJobWorker && party.isJobWorker))) throw rule('That supplier does not exist.', 'UNKNOWN_PARTY');
  if (!party.isActive) throw rule(`${party.name} is switched off.`, 'INACTIVE_PARTY');
  return party;
}

/* ---------- Purchase order ---------- */

export const purchaseOrder = {
  Model: PurchaseOrder,
  async prepare(session, data) {
    const party = await supplierFor(session, data.partyId);
    const settings = await getSettings(session);
    const supplyType = party.isExport ? SUPPLY.IMPORT : supplyTypeFor({ companyState: settings.stateCode, partyState: party.stateCode, isExport: false });
    const items = await Item.find({ _id: { $in: data.lines.map((l) => l.itemId) } }).session(session).lean();
    const builds = await MachineBuild.find({ _id: { $in: data.lines.map((l) => l.buildId).filter(Boolean) } }, { serialNo: 1, stage: 1 }).session(session).lean();
    const lines = data.lines.map((line) => {
      const item = items.find((i) => String(i._id) === String(line.itemId));
      if (!item) throw rule('A line names an item that does not exist.', 'UNKNOWN_ITEM');
      if (!item.isActive) throw rule(`${item.code} is switched off.`, 'INACTIVE_ITEM');
      if (item.type === 'SERVICE') throw rule(`${item.code} is a service. Book it on a purchase invoice.`, 'NOT_STOCK_ITEM');
      const build = line.buildId ? builds.find((b) => String(b._id) === String(line.buildId)) : null;
      if (line.buildId && !build) throw rule('A line names a build that does not exist.', 'UNKNOWN_BUILD');
      return {
        itemId: item._id,
        itemCode: item.code,
        itemName: item.name,
        uom: item.uom,
        hsn: item.hsn,
        qtyMilli: line.qtyMilli,
        ratePaise: line.ratePaise,
        gstRateBps: line.gstRateBps ?? item.gstRateBps,
        buildId: line.buildId ?? null,
        serialNo: build?.serialNo ?? null,
        requiresInspection: item.requiresInspection,
      };
    });
    const tax = computeTax(lines.map((l) => ({ taxablePaise: lineValue(l.qtyMilli, l.ratePaise), gstRateBps: l.gstRateBps })), supplyType);
    return { ...data, partyName: party.name, supplyType, lines, taxablePaise: tax.taxablePaise, taxPaise: tax.taxPaise, totalPaise: tax.totalPaise };
  },
  // Below the limit it is approved on submit. At or above it, someone else must approve.
  async submit(session, doc, { actor }) {
    if (doc.status !== 'DRAFT') throw conflict('Only a draft can be submitted.');
    const settings = await getSettings(session);
    assertPostingDate(doc.postingDate, settings);
    doc.docNo = await nextDocNo(session, 'PO', doc.postingDate);
    if (doc.totalPaise >= settings.poApprovalLimitPaise) {
      doc.status = 'PENDING_APPROVAL';
      return { action: 'PO_SENT_FOR_APPROVAL', actor };
    }
    doc.status = 'APPROVED';
    doc.approvedBy = actor.id;
    doc.approvedAt = new Date();
    return { action: 'PO_APPROVED', actor, data: { automatic: true } };
  },
  async cancel(session, doc) {
    if (doc.lines.some((l) => l.receivedMilli > 0)) throw rule('Goods have been received on this order, so it cannot be cancelled.', 'PO_HAS_RECEIPTS');
    doc.status = 'CANCELLED';
  },
};

export async function approvePurchaseOrder(session, id, actor) {
  const doc = await PurchaseOrder.findById(id).session(session);
  if (!doc) throw notFound('Purchase order');
  if (doc.status !== 'PENDING_APPROVAL') throw rule('This order is not waiting for approval.', 'PO_NOT_PENDING');
  if (String(doc.submittedBy) === String(actor.id) || String(doc.createdBy) === String(actor.id)) {
    throw rule('Whoever raised a purchase order cannot approve it.', 'SELF_APPROVAL');
  }
  doc.status = 'APPROVED';
  doc.approvedBy = actor.id;
  doc.approvedAt = new Date();
  await doc.save({ session });
  await audit(session, { actor, action: 'PO_APPROVED', entityType: 'PurchaseOrder', entityId: doc._id, entityNo: doc.docNo, data: { totalPaise: doc.totalPaise } });
  return doc;
}

/* ---------- Goods receipt ---------- */

export const grn = {
  Model: Grn,
  async prepare(session, data) {
    const order = await PurchaseOrder.findById(data.purchaseOrderId).session(session).lean();
    if (!order) throw notFound('Purchase order');
    const lines = data.lines.map((line) => {
      const orderLine = order.lines.find((l) => String(l._id) === String(line.poLineId));
      if (!orderLine) throw rule('A line does not belong to this purchase order.', 'BAD_PO_LINE');
      return {
        itemId: orderLine.itemId,
        itemCode: orderLine.itemCode,
        itemName: orderLine.itemName,
        uom: orderLine.uom,
        hsn: orderLine.hsn,
        poLineId: orderLine._id,
        qtyMilli: line.qtyMilli,
        ratePaise: orderLine.ratePaise,
        gstRateBps: orderLine.gstRateBps,
        lot: line.lot ?? '',
        certRef: line.certRef ?? '',
        buildId: orderLine.buildId,
        requiresInspection: orderLine.requiresInspection,
      };
    });
    return { ...data, purchaseOrderNo: order.docNo, partyId: order.partyId, partyName: order.partyName, lines };
  },
  async submit(session, doc, { actor }) {
    if (doc.status !== 'DRAFT') throw conflict('Only a draft can be submitted.');
    const order = await PurchaseOrder.findById(doc.purchaseOrderId).session(session);
    if (!order || order.status !== 'APPROVED') throw rule('Goods can only be received against an approved purchase order.', 'PO_NOT_APPROVED');
    const items = await Item.find({ _id: { $in: doc.lines.map((l) => l.itemId) } }).session(session).lean();

    doc.docNo = await nextDocNo(session, 'GR', doc.postingDate);
    doc.status = 'SUBMITTED';
    const voucher = { voucherType: 'Grn', voucherId: doc._id, voucherNo: doc.docNo, postingDate: doc.postingDate };
    const quarantine = doc.lines.some((l) => l.requiresInspection) ? await warehouseOfKind(session, 'QUARANTINE') : null;
    const stores = doc.lines.some((l) => !l.requiresInspection) ? await warehouseOfKind(session, 'STORES') : null;

    let total = 0;
    for (const line of doc.lines) {
      const item = items.find((i) => String(i._id) === String(line.itemId));
      if (item.trackLot && !line.lot) throw rule(`${item.code} is tracked by heat or batch number, and this line has none.`, 'LOT_REQUIRED');
      const orderLine = order.lines.id(line.poLineId);
      if (orderLine.receivedMilli + line.qtyMilli > orderLine.qtyMilli) {
        throw rule(`${line.itemCode}: more is being received than was ordered.`, 'OVER_RECEIPT', { orderedMilli: orderLine.qtyMilli, receivedMilli: orderLine.receivedMilli });
      }
      orderLine.receivedMilli += line.qtyMilli;
      const warehouse = line.requiresInspection ? quarantine : stores;
      line.warehouseId = warehouse._id;
      line.valuePaise = lineValue(line.qtyMilli, line.ratePaise);
      if (!line.requiresInspection) line.acceptedMilli = line.qtyMilli;
      await stockIn(session, { voucher, itemId: line.itemId, warehouseId: warehouse._id, lot: line.lot, buildId: line.buildId, qtyMilli: line.qtyMilli, valuePaise: line.valuePaise });
      total += line.valuePaise;
    }
    doc.totalValuePaise = total;
    if (order.lines.every((l) => l.receivedMilli >= l.qtyMilli)) order.status = 'CLOSED';
    await order.save({ session });
    await postGl(session, {
      postingDate: doc.postingDate,
      voucherType: 'Grn',
      voucherId: doc._id,
      voucherNo: doc.docNo,
      narration: `Goods from ${doc.partyName}, ${order.docNo}`,
      lines: [
        { accountCode: A.INVENTORY, debitPaise: total },
        { accountCode: A.GRNI, creditPaise: total, partyId: doc.partyId },
      ],
    });
    return { action: 'GOODS_RECEIVED', actor, data: { purchaseOrderNo: order.docNo, valuePaise: total } };
  },
  async cancel(session, doc, { postingDate }) {
    if (doc.lines.some((l) => l.billedMilli > 0)) throw rule('This receipt has been billed. Cancel the purchase invoice first.', 'GRN_BILLED');
    const inspected = await Inspection.countDocuments({ grnId: doc._id, status: 'SUBMITTED' }).session(session);
    if (inspected > 0) throw rule('This receipt has been inspected. Cancel the inspection first.', 'GRN_INSPECTED');
    await reverseStock(session, { voucherType: 'Grn', voucherId: doc._id, voucherNo: doc.docNo, postingDate });
    await reverseGl(session, { postingDate, voucherType: 'Grn', voucherId: doc._id, voucherNo: doc.docNo });
    const order = await PurchaseOrder.findById(doc.purchaseOrderId).session(session);
    for (const line of doc.lines) order.lines.id(line.poLineId).receivedMilli -= line.qtyMilli;
    if (order.status === 'CLOSED') order.status = 'APPROVED';
    await order.save({ session });
    doc.status = 'CANCELLED';
  },
};

/* ---------- Incoming inspection ---------- */

export const inspection = {
  Model: Inspection,
  async prepare(session, data) {
    const receipt = await Grn.findById(data.grnId).session(session).lean();
    if (!receipt || receipt.status !== 'SUBMITTED') throw rule('Only a submitted goods receipt can be inspected.', 'GRN_NOT_SUBMITTED');
    return {
      ...data,
      grnNo: receipt.docNo,
      partyName: receipt.partyName,
      lines: data.lines.map((line) => {
        const grnLine = receipt.lines.find((l) => String(l._id) === String(line.grnLineId));
        if (!grnLine) throw rule('A line does not belong to this goods receipt.', 'BAD_GRN_LINE');
        if (!grnLine.requiresInspection) throw rule(`${grnLine.itemCode} does not need inspection.`, 'NO_INSPECTION_NEEDED');
        return {
          grnLineId: grnLine._id,
          itemId: grnLine.itemId,
          itemCode: grnLine.itemCode,
          itemName: grnLine.itemName,
          lot: grnLine.lot,
          receivedMilli: grnLine.qtyMilli,
          acceptedMilli: line.acceptedMilli,
          rejectedMilli: line.rejectedMilli,
          certVerified: line.certVerified ?? false,
          observations: line.observations ?? '',
        };
      }),
    };
  },
  // Accepted goods leave quarantine for stores. Rejected ones go to the reject
  // warehouse and raise an NCR. No GL entry: both stay in the same inventory account.
  async submit(session, doc, { actor }) {
    if (doc.status !== 'DRAFT') throw conflict('Only a draft can be submitted.');
    const receipt = await Grn.findById(doc.grnId).session(session);
    if (!receipt || receipt.status !== 'SUBMITTED') throw rule('The goods receipt is no longer live.', 'GRN_NOT_SUBMITTED');
    doc.docNo = await nextDocNo(session, 'QC', doc.postingDate);
    doc.status = 'SUBMITTED';
    const voucher = { voucherType: 'Inspection', voucherId: doc._id, voucherNo: doc.docNo, postingDate: doc.postingDate };
    const stores = await warehouseOfKind(session, 'STORES');
    const reject = await warehouseOfKind(session, 'REJECT');

    for (const line of doc.lines) {
      const grnLine = receipt.lines.id(line.grnLineId);
      const decided = line.acceptedMilli + line.rejectedMilli;
      if (grnLine.acceptedMilli + grnLine.rejectedMilli + decided > grnLine.qtyMilli) {
        throw rule(`${line.itemCode}: more has been inspected than was received.`, 'OVER_INSPECTED');
      }
      if (decided <= 0) throw rule(`${line.itemCode}: enter an accepted or rejected quantity.`, 'NOTHING_INSPECTED');
      const from = { itemId: line.itemId, warehouseId: grnLine.warehouseId, lot: line.lot, buildId: grnLine.buildId };
      if (line.acceptedMilli > 0) {
        await stockMove(session, { voucher, qtyMilli: line.acceptedMilli, from, to: { warehouseId: stores._id } });
      }
      if (line.rejectedMilli > 0) {
        // Rejected stock stops being set aside for the build.
        await stockMove(session, { voucher, qtyMilli: line.rejectedMilli, from, to: { warehouseId: reject._id, buildId: null } });
        const ncrNo = await nextDocNo(session, 'NCR', doc.postingDate);
        await Ncr.create([{
          docNo: ncrNo,
          postingDate: doc.postingDate,
          source: 'INCOMING',
          itemId: line.itemId,
          itemName: line.itemName,
          description: `Rejected ${line.rejectedMilli / 1000} of ${line.itemCode} on ${receipt.docNo}${line.observations ? `: ${line.observations}` : ''}`,
          raisedBy: actor.id,
          raisedByName: actor.name,
          createdBy: actor.id,
        }], { session });
      }
      grnLine.acceptedMilli += line.acceptedMilli;
      grnLine.rejectedMilli += line.rejectedMilli;
    }
    await receipt.save({ session });
    return { action: 'INSPECTION_RECORDED', actor, data: { grnNo: receipt.docNo } };
  },
  async cancel(session, doc, { postingDate }) {
    await reverseStock(session, { voucherType: 'Inspection', voucherId: doc._id, voucherNo: doc.docNo, postingDate });
    const receipt = await Grn.findById(doc.grnId).session(session);
    for (const line of doc.lines) {
      const grnLine = receipt.lines.id(line.grnLineId);
      grnLine.acceptedMilli -= line.acceptedMilli;
      grnLine.rejectedMilli -= line.rejectedMilli;
    }
    await receipt.save({ session });
    doc.status = 'CANCELLED';
  },
};

/* ---------- Purchase invoice ---------- */

export const purchaseInvoice = {
  Model: PurchaseInvoice,
  async prepare(session, data) {
    const party = await supplierFor(session, data.partyId, { allowJobWorker: true });
    const settings = await getSettings(session);
    // Goods from abroad pay IGST at customs. A service from abroad is reverse charge, which
    // is inter-state. Whether tax comes from the supplier or from us, the sum is the same.
    let supplyType;
    if (party.isExport) supplyType = data.isReverseCharge ? SUPPLY.INTER : SUPPLY.IMPORT;
    else supplyType = supplyTypeFor({ companyState: settings.stateCode, partyState: party.stateCode, isExport: false });
    const items = await Item.find({ _id: { $in: data.lines.map((l) => l.itemId).filter(Boolean) } }).session(session).lean();
    const grns = await Grn.find({ _id: { $in: data.lines.map((l) => l.grnId).filter(Boolean) } }).session(session).lean();

    const lines = data.lines.map((line) => {
      if (line.kind === 'GOODS') {
        const receipt = grns.find((g) => String(g._id) === String(line.grnId));
        if (!receipt) throw rule('A line names a goods receipt that does not exist.', 'UNKNOWN_GRN');
        if (String(receipt.partyId) !== String(party._id)) throw rule(`${receipt.docNo} is from another supplier.`, 'GRN_OTHER_SUPPLIER');
        const grnLine = receipt.lines.find((l) => String(l._id) === String(line.grnLineId));
        if (!grnLine) throw rule('A line does not belong to its goods receipt.', 'BAD_GRN_LINE');
        return {
          kind: 'GOODS',
          itemId: grnLine.itemId,
          itemCode: grnLine.itemCode,
          itemName: grnLine.itemName,
          uom: grnLine.uom,
          hsn: grnLine.hsn,
          grnId: receipt._id,
          grnLineId: grnLine._id,
          grnNo: receipt.docNo,
          buildId: grnLine.buildId,
          qtyMilli: line.qtyMilli,
          ratePaise: line.ratePaise,
          gstRateBps: line.gstRateBps ?? grnLine.gstRateBps,
          itcBlocked: line.itcBlocked ?? false,
          taxablePaise: lineValue(line.qtyMilli, line.ratePaise),
        };
      }
      const item = line.itemId ? items.find((i) => String(i._id) === String(line.itemId)) : null;
      if (line.itemId && !item) throw rule('A line names an item that does not exist.', 'UNKNOWN_ITEM');
      if (!line.buildId && !line.expenseAccountCode) throw rule('A service line needs a build or an expense account.', 'SERVICE_NEEDS_TARGET');
      return {
        kind: 'SERVICE',
        itemId: item?._id ?? null,
        itemCode: item?.code ?? '',
        itemName: item?.name ?? line.description ?? 'Service',
        uom: item?.uom ?? 'NOS',
        hsn: item?.hsn ?? line.hsn ?? '',
        buildId: line.buildId ?? null,
        expenseAccountCode: line.expenseAccountCode ?? null,
        costCenterId: line.costCenterId ?? null,
        projectId: line.projectId ?? null,
        itcBlocked: line.itcBlocked ?? false,
        gstTreatment: item?.gstTreatment ?? 'TAXABLE',
        qtyMilli: line.qtyMilli,
        ratePaise: line.ratePaise,
        gstRateBps: item && item.gstTreatment !== 'TAXABLE' ? 0 : (line.gstRateBps ?? item?.gstRateBps ?? 1800),
        taxablePaise: lineValue(line.qtyMilli, line.ratePaise),
      };
    });
    const tax = computeTax(lines.map((l) => ({ taxablePaise: l.taxablePaise, gstRateBps: l.gstRateBps })), supplyType);
    const { lineTax, slabs: _slabs, ...totals } = tax;
    lines.forEach((line, i) => Object.assign(line, lineTax[i]));
    // On reverse charge the supplier charges no tax. We pay it to the government ourselves.
    if (data.isReverseCharge) totals.totalPaise = totals.taxablePaise;
    const blockedTaxPaise = sumInts(lines.filter((l) => l.itcBlocked).map((l) => l.cgstPaise + l.sgstPaise + l.igstPaise));
    return {
      ...data,
      partyName: party.name,
      supplierGstin: party.gstin,
      lines,
      ...totals,
      isReverseCharge: data.isReverseCharge ?? false,
      blockedTaxPaise,
      dueDate: data.dueDate ?? addDays(data.supplierInvoiceDate, party.paymentTermsDays),
    };
  },
  async submit(session, doc, { actor }) {
    if (doc.status !== 'DRAFT') throw conflict('Only a draft can be submitted.');
    doc.docNo = await nextDocNo(session, 'PI', doc.postingDate);
    doc.status = 'SUBMITTED';

    const gl = [];
    const grnCache = new Map();
    for (const line of doc.lines) {
      if (line.kind === 'GOODS') {
        const key = String(line.grnId);
        if (!grnCache.has(key)) grnCache.set(key, await Grn.findById(line.grnId).session(session));
        const receipt = grnCache.get(key);
        if (receipt.status !== 'SUBMITTED') throw rule(`${receipt.docNo} is no longer live.`, 'GRN_NOT_SUBMITTED');
        const grnLine = receipt.lines.id(line.grnLineId);
        if (grnLine.billedMilli + line.qtyMilli > grnLine.qtyMilli) {
          throw rule(`${line.itemCode}: more is being billed than was received on ${receipt.docNo}.`, 'OVER_BILLED', { receivedMilli: grnLine.qtyMilli, billedMilli: grnLine.billedMilli });
        }
        // Clear GRNI at what the receipt recorded, in proportion, so full billing
        // clears the receipt to the paisa. The difference is the price variance.
        const alreadyBilledValue = mulDivRound(grnLine.valuePaise, grnLine.billedMilli, grnLine.qtyMilli);
        const nowBilledValue = mulDivRound(grnLine.valuePaise, grnLine.billedMilli + line.qtyMilli, grnLine.qtyMilli);
        line.grnValuePaise = nowBilledValue - alreadyBilledValue;
        grnLine.billedMilli += line.qtyMilli;
        const variance = line.taxablePaise - line.grnValuePaise;
        gl.push({ accountCode: A.GRNI, debitPaise: line.grnValuePaise, partyId: doc.partyId });
        if (variance > 0) gl.push({ accountCode: A.PRICE_VARIANCE, debitPaise: variance });
        if (variance < 0) gl.push({ accountCode: A.PRICE_VARIANCE, creditPaise: -variance });
      } else if (line.buildId) {
        const build = await MachineBuild.findById(line.buildId).session(session);
        if (!build) throw rule('A line names a build that does not exist.', 'UNKNOWN_BUILD');
        if (!['PLANNED', 'PROCUREMENT', 'FABRICATION', 'ASSEMBLY', 'FAT'].includes(build.stage)) {
          throw rule(`Build ${build.serialNo} is finished and takes no more cost. Book this to an expense account.`, 'BUILD_CLOSED_TO_COST');
        }
        build.otherCostPaise += line.taxablePaise;
        build.wipPaise += line.taxablePaise;
        await build.save({ session });
        gl.push({ accountCode: A.WIP, debitPaise: line.taxablePaise, buildId: build._id, projectId: line.projectId });
      } else {
        gl.push({ accountCode: line.expenseAccountCode, debitPaise: line.taxablePaise, costCenterId: line.costCenterId, projectId: line.projectId });
      }
    }
    for (const receipt of grnCache.values()) await receipt.save({ session });

    // Blocked credit is a cost. Everything else can be claimed.
    const sumOf = (key, blocked) => sumInts(doc.lines.filter((l) => Boolean(l.itcBlocked) === blocked).map((l) => l[key]));
    gl.push(
      { accountCode: A.INPUT_CGST, debitPaise: sumOf('cgstPaise', false) },
      { accountCode: A.INPUT_SGST, debitPaise: sumOf('sgstPaise', false) },
      { accountCode: A.INPUT_IGST, debitPaise: sumOf('igstPaise', false) },
      { accountCode: A.GST_NOT_CLAIMABLE, debitPaise: doc.blockedTaxPaise },
      { accountCode: A.CREDITORS, creditPaise: doc.totalPaise, partyId: doc.partyId },
    );
    if (doc.isReverseCharge) {
      gl.push(
        { accountCode: A.RCM_CGST, creditPaise: doc.cgstPaise },
        { accountCode: A.RCM_SGST, creditPaise: doc.sgstPaise },
        { accountCode: A.RCM_IGST, creditPaise: doc.igstPaise },
      );
    }
    await postGl(session, {
      postingDate: doc.postingDate,
      voucherType: 'PurchaseInvoice',
      voucherId: doc._id,
      voucherNo: doc.docNo,
      narration: `${doc.partyName} invoice ${doc.supplierInvoiceNo}`,
      lines: gl,
    });
    return { action: 'PURCHASE_INVOICE_POSTED', actor, data: { supplierInvoiceNo: doc.supplierInvoiceNo, totalPaise: doc.totalPaise } };
  },
  async cancel(session, doc, { postingDate }) {
    if (doc.paidPaise > 0) throw rule('This invoice has payments against it. Cancel them first.', 'INVOICE_HAS_PAYMENTS');
    await reverseGl(session, { postingDate, voucherType: 'PurchaseInvoice', voucherId: doc._id, voucherNo: doc.docNo });
    for (const line of doc.lines) {
      if (line.kind === 'GOODS') {
        const receipt = await Grn.findById(line.grnId).session(session);
        receipt.lines.id(line.grnLineId).billedMilli -= line.qtyMilli;
        await receipt.save({ session });
      } else if (line.buildId) {
        const build = await MachineBuild.findById(line.buildId).session(session);
        if (!['PLANNED', 'PROCUREMENT', 'FABRICATION', 'ASSEMBLY', 'FAT'].includes(build.stage)) {
          throw rule(`Build ${build.serialNo} is finished, so a cost on it cannot be removed.`, 'BUILD_CLOSED_TO_COST');
        }
        build.otherCostPaise -= line.taxablePaise;
        build.wipPaise -= line.taxablePaise;
        await build.save({ session });
      }
    }
    doc.status = 'CANCELLED';
  },
};

