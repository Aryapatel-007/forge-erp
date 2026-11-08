// Quotations and sales orders.
import { Bom, Item, MachineBuild, Party, Quotation, SalesOrder } from '../models/index.js';
import { afterDiscount, allocate, applyBps, lineValue, sumInts, toBasePaise } from '../utils/money.js';
import { conflict, notFound, rule } from '../utils/errors.js';
import { assertPostingDate, getSettings } from './settingsService.js';
import { nextDocNo, nextSerialNo } from './numberService.js';
import { audit } from './auditService.js';
import { explodeBom } from './buildService.js';
import { todayIst } from '../utils/dates.js';

export async function freezeSalesLines(session, lines) {
  const items = await Item.find({ _id: { $in: lines.map((l) => l.itemId) } }).session(session).lean();
  return lines.map((line) => {
    const item = items.find((i) => String(i._id) === String(line.itemId));
    if (!item) throw rule('A line names an item that does not exist.', 'UNKNOWN_ITEM');
    if (!item.isActive) throw rule(`${item.code} is switched off.`, 'INACTIVE_ITEM');
    const amountMinor = afterDiscount(lineValue(line.qtyMilli, line.rateMinor), line.discountBps ?? 0);
    return {
      itemId: item._id,
      itemCode: item.code,
      itemName: item.name,
      uom: item.uom,
      hsn: item.hsn,
      description: line.description ?? '',
      qtyMilli: line.qtyMilli,
      rateMinor: line.rateMinor,
      discountBps: line.discountBps ?? 0,
      gstRateBps: line.gstRateBps ?? item.gstRateBps,
      amountMinor,
    };
  });
}

function assertFx(currency, fxRate4) {
  if (currency !== 'INR' && !fxRate4) throw rule(`A ${currency} document needs an exchange rate.`, 'FX_REQUIRED');
}

async function partyFor(session, partyId) {
  const party = await Party.findById(partyId).session(session).lean();
  if (!party || !party.isCustomer) throw rule('That customer does not exist.', 'UNKNOWN_PARTY');
  if (!party.isActive) throw rule(`${party.name} is switched off.`, 'INACTIVE_PARTY');
  return party;
}

/* ---------- Quotation ---------- */

export const quotation = {
  Model: Quotation,
  async prepare(session, data) {
    const party = await partyFor(session, data.partyId);
    const lines = await freezeSalesLines(session, data.lines);
    assertFx(data.currency ?? party.currency, data.fxRate4);
    return {
      ...data,
      partyName: party.name,
      currency: data.currency ?? party.currency,
      lines,
      subtotalMinor: sumInts(lines.map((l) => l.amountMinor)),
    };
  },
  async submit(session, doc, { actor }) {
    if (doc.status !== 'DRAFT') throw conflict('Only a draft can be sent.');
    doc.docNo = doc.docNo || await nextDocNo(session, 'QT', doc.postingDate);
    doc.status = 'SENT';
    return { action: 'QUOTATION_SENT', actor };
  },
};

// A new revision is a new draft. The earlier one is superseded when this one is sent.
export async function reviseQuotation(session, id, actor) {
  const source = await Quotation.findById(id).session(session);
  if (!source) throw notFound('Quotation');
  if (source.status !== 'SENT') throw rule('Only a quotation that was sent can be revised.');
  source.status = 'SUPERSEDED';
  await source.save({ session });
  const data = source.toObject();
  delete data.id;
  delete data._id;
  const [copy] = await Quotation.create([{
    ...data,
    docNo: null,
    status: 'DRAFT',
    rootId: source.rootId ?? source._id,
    revision: source.revision + 1,
    postingDate: todayIst(),
    createdBy: actor.id,
    submittedBy: null,
    submittedAt: null,
    lines: source.lines.map((l) => {
      const line = l.toObject();
      delete line._id;
      delete line.id;
      return line;
    }),
  }], { session });
  await audit(session, { actor, action: 'QUOTATION_REVISED', entityType: 'Quotation', entityId: copy._id, entityNo: source.docNo, data: { revision: copy.revision } });
  return copy;
}

export async function markQuotationLost(session, id, reason, actor) {
  const doc = await Quotation.findById(id).session(session);
  if (!doc) throw notFound('Quotation');
  if (doc.status !== 'SENT') throw rule('Only a quotation that was sent can be marked lost.');
  doc.status = 'LOST';
  doc.lostReason = reason;
  await doc.save({ session });
  await audit(session, { actor, action: 'QUOTATION_LOST', entityType: 'Quotation', entityId: doc._id, entityNo: doc.docNo, reason });
  return doc;
}

export async function quotationToOrder(session, id, actor) {
  const source = await Quotation.findById(id).session(session);
  if (!source) throw notFound('Quotation');
  if (source.status !== 'SENT') throw rule('Only a quotation that was sent can become an order.');
  source.status = 'WON';
  await source.save({ session });
  const party = await Party.findById(source.partyId).session(session).lean();
  const [order] = await SalesOrder.create([{
    postingDate: todayIst(),
    status: 'DRAFT',
    quotationId: source._id,
    partyId: source.partyId,
    partyName: source.partyName,
    currency: source.currency,
    fxRate4: source.fxRate4,
    isExport: party.isExport,
    lines: source.lines.map((l) => {
      const line = l.toObject();
      delete line._id;
      delete line.id;
      return line;
    }),
    subtotalMinor: source.subtotalMinor,
    terms: source.terms,
    createdBy: actor.id,
    milestones: [
      { no: 1, name: 'Advance with order', trigger: 'ORDER', pctBps: 3000 },
      { no: 2, name: 'Before dispatch, after FAT', trigger: 'BEFORE_DISPATCH', pctBps: 6000 },
      { no: 3, name: 'After installation', trigger: 'AFTER_INSTALLATION', pctBps: 1000 },
    ],
  }], { session });
  await audit(session, { actor, action: 'QUOTATION_WON', entityType: 'Quotation', entityId: source._id, entityNo: source.docNo, data: { salesOrderId: String(order._id) } });
  return order;
}

/* ---------- Sales order ---------- */

// The order value a milestone percent applies to: taxable plus GST at each line's rate,
// or plain taxable value for an export under LUT.
export function orderGrandTotalMinor(lines, isExport) {
  const taxable = sumInts(lines.map((l) => l.amountMinor));
  if (isExport) return taxable;
  return taxable + sumInts(lines.map((l) => applyBps(l.amountMinor, l.gstRateBps)));
}

export const salesOrder = {
  Model: SalesOrder,
  async prepare(session, data) {
    const party = await partyFor(session, data.partyId);
    const lines = await freezeSalesLines(session, data.lines);
    assertFx(data.currency ?? party.currency, data.fxRate4);
    return {
      ...data,
      partyName: party.name,
      currency: data.currency ?? party.currency,
      isExport: data.isExport ?? party.isExport,
      lines,
      subtotalMinor: sumInts(lines.map((l) => l.amountMinor)),
    };
  },
  // Confirming allots a serial number and opens a build for every machine ordered.
  async submit(session, doc, { actor }) {
    if (doc.status !== 'DRAFT') throw conflict('Only a draft can be confirmed.');
    const settings = await getSettings(session);
    assertPostingDate(doc.postingDate, settings);

    const pct = sumInts(doc.milestones.map((m) => m.pctBps));
    if (pct !== 10000) throw rule(`The payment milestones add up to ${pct / 100}%, and they must add up to 100%.`, 'BAD_MILESTONES');
    const grand = orderGrandTotalMinor(doc.lines, doc.isExport);
    const shares = allocate(grand, doc.milestones.map((m) => m.pctBps));
    doc.milestones.forEach((m, i) => {
      m.amountMinor = shares[i];
    });

    const party = await Party.findById(doc.partyId).session(session).lean();
    if (party.isOnHold) throw rule(`${party.name} is on hold.`, 'PARTY_ON_HOLD');
    doc.docNo = await nextDocNo(session, 'SO', doc.postingDate);
    doc.status = 'CONFIRMED';

    const machineLines = [];
    const items = await Item.find({ _id: { $in: doc.lines.map((l) => l.itemId) } }).session(session).lean();
    for (const line of doc.lines) {
      const item = items.find((i) => String(i._id) === String(line.itemId));
      if (item.type === 'MACHINE') machineLines.push({ line, item });
    }

    const serials = [];
    for (const { line, item } of machineLines) {
      if (line.qtyMilli % 1000 !== 0) throw rule(`${item.code}: machines are ordered in whole numbers.`, 'WHOLE_MACHINES_ONLY');
      const bom = await Bom.findOne({ itemId: item._id, status: 'RELEASED' }).session(session).lean();
      if (!bom) throw rule(`${item.code} has no released BOM. Engineering must release one first.`, 'NO_RELEASED_BOM');
      const materials = await explodeBom(session, bom, 1000);
      const unitAmount = toBasePaise(Math.round(line.amountMinor / (line.qtyMilli / 1000)), doc.fxRate4);
      for (let i = 0; i < line.qtyMilli / 1000; i += 1) {
        const serialNo = await nextSerialNo(session, item.code, doc.postingDate);
        await MachineBuild.create([{
          serialNo,
          itemId: item._id,
          itemCode: item.code,
          itemName: item.name,
          hsn: item.hsn,
          salesOrderId: doc._id,
          salesOrderNo: doc.docNo,
          partyId: doc.partyId,
          partyName: doc.partyName,
          bomId: bom._id,
          bomRevision: bom.revision,
          targetDate: doc.deliveryDate,
          budgetPaise: unitAmount,
          materials,
          stageHistory: [{ stage: 'PLANNED', at: new Date(), byName: actor.name, note: `From order ${doc.docNo}` }],
        }], { session });
        serials.push(serialNo);
      }
    }
    return { action: 'SALES_ORDER_CONFIRMED', actor, data: { serials } };
  },
  // Open builds go with the order. Refused once a build holds cost or a milestone holds money.
  async cancel(session, doc, { actor }) {
    if (doc.milestones.some((m) => m.receivedMinor > 0)) {
      throw rule('Money has been received against this order. Refund it first.', 'ORDER_HAS_RECEIPTS');
    }
    const builds = await MachineBuild.find({ salesOrderId: doc._id }).session(session);
    for (const build of builds) {
      if (build.wipPaise !== 0 || build.finishedValuePaise !== 0 || build.materials.some((m) => m.issuedMilli > 0)) {
        throw rule(`Build ${build.serialNo} already holds cost, so this order cannot be cancelled.`, 'BUILD_HAS_COST');
      }
      build.stage = 'CANCELLED';
      build.stageHistory.push({ stage: 'CANCELLED', at: new Date(), byName: actor.name, note: `Order ${doc.docNo} cancelled` });
      await build.save({ session });
    }
    doc.status = 'CANCELLED';
  },
};
