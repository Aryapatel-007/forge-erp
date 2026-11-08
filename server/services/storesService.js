// Stock moves (transfer, reserve, adjust, opening) and job work challans.
import { JobWorkChallan, MachineBuild, StockMove } from '../models/documents.js';
import { Item, Party, Warehouse } from '../models/masters.js';
import { A } from '../config/accounts.js';
import { lineValue } from '../utils/money.js';
import { conflict, notFound, rule } from '../utils/errors.js';
import { addDays } from '../utils/dates.js';
import { assertPostingDate, getSettings } from './settingsService.js';
import { nextDocNo } from './numberService.js';
import { audit } from './auditService.js';
import { postGl, reverseGl } from './ledgerService.js';
import { accountForWarehouseKind, assertWarehouseKind, reverseStock, stockIn, stockMove, stockOut, warehouseOfKind } from './stockService.js';

async function freezeItems(session, lines) {
  const items = await Item.find({ _id: { $in: lines.map((l) => l.itemId) } }).session(session).lean();
  return (line) => {
    const item = items.find((i) => String(i._id) === String(line.itemId));
    if (!item) throw rule('A line names an item that does not exist.', 'UNKNOWN_ITEM');
    if (item.type === 'SERVICE') throw rule(`${item.code} is a service and holds no stock.`, 'NOT_STOCK_ITEM');
    return { item, frozen: { itemId: item._id, itemCode: item.code, itemName: item.name, uom: item.uom, hsn: item.hsn } };
  };
}

/* ---------- Stock move ---------- */

const NEEDS_FROM = ['TRANSFER', 'RESERVE', 'UNRESERVE', 'ADJUST_OUT'];
const NEEDS_TO = ['TRANSFER', 'ADJUST_IN', 'OPENING'];

export const stockMoveDoc = {
  Model: StockMove,
  async prepare(session, data) {
    const freeze = await freezeItems(session, data.lines);
    return {
      ...data,
      lines: data.lines.map((line) => {
        const { frozen } = freeze(line);
        if (NEEDS_FROM.includes(data.kind) && !line.fromWarehouseId) throw rule('This line needs a warehouse to take from.', 'WAREHOUSE_REQUIRED');
        if (NEEDS_TO.includes(data.kind) && !line.toWarehouseId) throw rule('This line needs a warehouse to put into.', 'WAREHOUSE_REQUIRED');
        if (data.kind === 'RESERVE' && !line.toBuildId) throw rule('Reserving needs a build.', 'BUILD_REQUIRED');
        if (data.kind === 'UNRESERVE' && !line.fromBuildId) throw rule('Unreserving needs a build.', 'BUILD_REQUIRED');
        return { ...line, ...frozen };
      }),
    };
  },
  async submit(session, doc, { actor }) {
    if (doc.status !== 'DRAFT') throw conflict('Only a draft can be submitted.');
    if (['ADJUST_IN', 'ADJUST_OUT'].includes(doc.kind) && !doc.reason) {
      throw rule('A stock adjustment must say why.', 'REASON_REQUIRED');
    }
    doc.docNo = await nextDocNo(session, 'SM', doc.postingDate);
    doc.status = 'SUBMITTED';
    const voucher = { voucherType: 'StockMove', voucherId: doc._id, voucherNo: doc.docNo, postingDate: doc.postingDate };
    const gl = [];
    let total = 0;

    for (const line of doc.lines) {
      const fromKey = { itemId: line.itemId, warehouseId: line.fromWarehouseId, lot: line.lot, buildId: line.fromBuildId };
      if (doc.kind === 'TRANSFER' || doc.kind === 'RESERVE' || doc.kind === 'UNRESERVE') {
        const toWarehouseId = line.toWarehouseId ?? line.fromWarehouseId;
        const to = { warehouseId: toWarehouseId, buildId: doc.kind === 'UNRESERVE' ? null : (doc.kind === 'RESERVE' ? line.toBuildId : line.fromBuildId) };
        const fromWarehouse = await Warehouse.findById(line.fromWarehouseId).session(session).lean();
        const toWarehouse = await Warehouse.findById(toWarehouseId).session(session).lean();
        if (!fromWarehouse || !toWarehouse) throw rule('That warehouse does not exist.', 'BAD_WAREHOUSE');
        for (const warehouse of [fromWarehouse, toWarehouse]) {
          if (warehouse.kind === 'QUARANTINE' || warehouse.kind === 'JOBWORK') {
            throw rule(`${warehouse.name} only moves through inspection or job work.`, 'WAREHOUSE_LOCKED');
          }
        }
        const { valuePaise } = await stockMove(session, { voucher, qtyMilli: line.qtyMilli, from: fromKey, to });
        line.valuePaise = valuePaise;
        total += valuePaise;
        const fromAccount = accountForWarehouseKind(fromWarehouse.kind);
        const toAccount = accountForWarehouseKind(toWarehouse.kind);
        if (fromAccount !== toAccount) {
          gl.push({ accountCode: toAccount, debitPaise: valuePaise }, { accountCode: fromAccount, creditPaise: valuePaise });
        }
      } else if (doc.kind === 'ADJUST_OUT') {
        const warehouse = await assertWarehouseKind(session, line.fromWarehouseId, ['STORES', 'REJECT', 'FG']);
        const { valuePaise } = await stockOut(session, { voucher, qtyMilli: line.qtyMilli, ...fromKey });
        line.valuePaise = valuePaise;
        total += valuePaise;
        gl.push({ accountCode: A.STOCK_ADJUSTMENT, debitPaise: valuePaise }, { accountCode: accountForWarehouseKind(warehouse.kind), creditPaise: valuePaise });
      } else {
        const warehouse = await assertWarehouseKind(session, line.toWarehouseId, ['STORES', 'FG', 'REJECT']);
        const valuePaise = lineValue(line.qtyMilli, line.ratePaise);
        await stockIn(session, { voucher, itemId: line.itemId, warehouseId: line.toWarehouseId, lot: line.lot, buildId: line.toBuildId, qtyMilli: line.qtyMilli, valuePaise });
        line.valuePaise = valuePaise;
        total += valuePaise;
        const contra = doc.kind === 'OPENING' ? A.OPENING : A.STOCK_ADJUSTMENT;
        gl.push({ accountCode: accountForWarehouseKind(warehouse.kind), debitPaise: valuePaise }, { accountCode: contra, creditPaise: valuePaise });
      }
    }
    doc.totalValuePaise = total;
    await postGl(session, { postingDate: doc.postingDate, voucherType: 'StockMove', voucherId: doc._id, voucherNo: doc.docNo, narration: `${doc.kind}: ${doc.reason}`, lines: gl });
    return { action: `STOCK_${doc.kind}`, actor, reason: doc.reason, data: { valuePaise: total } };
  },
  async cancel(session, doc, { postingDate }) {
    await reverseStock(session, { voucherType: 'StockMove', voucherId: doc._id, voucherNo: doc.docNo, postingDate });
    await reverseGl(session, { postingDate, voucherType: 'StockMove', voucherId: doc._id, voucherNo: doc.docNo });
    doc.status = 'CANCELLED';
  },
};

/* ---------- Job work ---------- */

export const jobWorkChallan = {
  Model: JobWorkChallan,
  async prepare(session, data) {
    const party = await Party.findById(data.partyId).session(session).lean();
    if (!party || !party.isJobWorker) throw rule('That job worker does not exist.', 'UNKNOWN_PARTY');
    const build = data.buildId ? await MachineBuild.findById(data.buildId, { serialNo: 1 }).session(session).lean() : null;
    if (data.buildId && !build) throw rule('That build does not exist.', 'UNKNOWN_BUILD');
    const freeze = await freezeItems(session, data.lines);
    return {
      ...data,
      partyName: party.name,
      serialNo: build?.serialNo ?? null,
      lines: data.lines.map((line) => {
        const { item, frozen } = freeze(line);
        return { ...line, ...frozen, gstRateBps: item.gstRateBps, isCapitalGoods: item.isCapitalGoods };
      }),
    };
  },
  // The goods stay ours, so stock moves to the JOBWORK warehouse with no GL entry.
  async submit(session, doc, { actor }) {
    if (doc.status !== 'DRAFT') throw conflict('Only a draft can be submitted.');
    const settings = await getSettings(session);
    assertPostingDate(doc.postingDate, settings);
    const jobWork = await warehouseOfKind(session, 'JOBWORK');
    doc.docNo = await nextDocNo(session, 'JW', doc.postingDate);
    doc.status = 'SENT';
    const voucher = { voucherType: 'JobWorkChallan', voucherId: doc._id, voucherNo: doc.docNo, postingDate: doc.postingDate };
    let total = 0;
    for (const line of doc.lines) {
      await assertWarehouseKind(session, line.fromWarehouseId, ['STORES']);
      const { valuePaise } = await stockMove(session, {
        voucher,
        qtyMilli: line.qtyMilli,
        from: { itemId: line.itemId, warehouseId: line.fromWarehouseId, lot: line.lot, buildId: doc.buildId },
        to: { warehouseId: jobWork._id },
      });
      line.valuePaise = valuePaise;
      total += valuePaise;
    }
    doc.totalValuePaise = total;
    // GST rule 45: inputs back in one year, capital goods in three.
    const days = doc.lines.some((l) => !l.isCapitalGoods) ? settings.jobWorkInputDays : settings.jobWorkCapitalDays;
    doc.returnBy = addDays(doc.postingDate, days);
    return { action: 'JOB_WORK_SENT', actor, data: { partyName: doc.partyName, valuePaise: total } };
  },
  async cancel(session, doc, { postingDate }) {
    if (doc.receipts.length > 0) throw rule('Goods have come back on this challan, so it cannot be cancelled.', 'CHALLAN_HAS_RECEIPTS');
    await reverseStock(session, { voucherType: 'JobWorkChallan', voucherId: doc._id, voucherNo: doc.docNo, postingDate });
    doc.status = 'CANCELLED';
  },
};

// Goods back from the job worker. The value of the input consumed moves onto the output.
// Process charges arrive separately on a purchase invoice.
export async function receiveJobWork(session, id, data, actor) {
  const doc = await JobWorkChallan.findById(id).session(session);
  if (!doc) throw notFound('Challan');
  if (!['SENT', 'PARTLY_RETURNED'].includes(doc.status)) throw rule('This challan is not open.', 'CHALLAN_NOT_OPEN');
  const settings = await getSettings(session);
  assertPostingDate(data.postingDate, settings);
  const line = doc.lines.id(data.lineId);
  if (!line) throw rule('That line is not on this challan.', 'BAD_CHALLAN_LINE');
  if (line.consumedMilli + data.consumedMilli > line.qtyMilli) {
    throw rule(`${line.itemCode}: more is being consumed than was sent.`, 'OVER_CONSUMED', { sentMilli: line.qtyMilli, consumedMilli: line.consumedMilli });
  }
  const output = await Item.findById(data.outputItemId).session(session).lean();
  if (!output) throw rule('The output item does not exist.', 'UNKNOWN_ITEM');
  const stores = data.warehouseId
    ? await assertWarehouseKind(session, data.warehouseId, ['STORES'])
    : await warehouseOfKind(session, 'STORES');
  const jobWork = await warehouseOfKind(session, 'JOBWORK');

  const docNo = await nextDocNo(session, 'JR', data.postingDate);
  const voucher = { voucherType: 'JobWorkReceipt', voucherId: doc._id, voucherNo: docNo, postingDate: data.postingDate };
  const { valuePaise } = await stockOut(session, { voucher, itemId: line.itemId, warehouseId: jobWork._id, lot: line.lot, buildId: doc.buildId, qtyMilli: data.consumedMilli });
  const lot = data.lot ?? line.lot;
  await stockIn(session, { voucher, itemId: output._id, warehouseId: stores._id, lot, buildId: doc.buildId, qtyMilli: data.outputMilli, valuePaise });

  line.consumedMilli += data.consumedMilli;
  line.consumedValuePaise += valuePaise;
  doc.receipts.push({
    docNo,
    postingDate: data.postingDate,
    lineId: line._id,
    consumedMilli: data.consumedMilli,
    outputItemId: output._id,
    outputItemCode: output.code,
    outputItemName: output.name,
    outputMilli: data.outputMilli,
    wasteMilli: Math.max(0, data.consumedMilli - data.outputMilli),
    warehouseId: stores._id,
    lot,
    valuePaise,
    supplierChallanNo: data.supplierChallanNo ?? '',
    voucherId: doc._id,
  });
  doc.status = doc.lines.every((l) => l.consumedMilli >= l.qtyMilli) ? 'RETURNED' : 'PARTLY_RETURNED';
  await doc.save({ session });
  await audit(session, { actor, action: 'JOB_WORK_RECEIVED', entityType: 'JobWorkChallan', entityId: doc._id, entityNo: docNo, data: { challanNo: doc.docNo, valuePaise } });
  return doc;
}

