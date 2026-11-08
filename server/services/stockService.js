// The only writer of stock. Every change lands as one StockEntry plus one Bin update
// inside the caller's transaction.
import { Bin, StockEntry } from '../models/ledgers.js';
import { Warehouse } from '../models/masters.js';
import { A } from '../config/accounts.js';
import { mulDivRound } from '../utils/money.js';
import { rule } from '../utils/errors.js';
import { getType } from '../engine/registry.js';
import { getSettings } from './settingsService.js';
import { todayIst } from '../utils/dates.js';

const bucketKey = ({ itemId, warehouseId, lot = '', buildId = null }) => ({ itemId, warehouseId, lot: lot || '', buildId: buildId ?? null });

// Takes the bucket's row for this transaction. A concurrent writer of the same bucket
// gets a write conflict and its whole transaction is retried against the new balance.
async function lockBin(session, key) {
  return Bin.findOneAndUpdate(
    key,
    { $inc: { lockSeq: 1 }, $setOnInsert: { qtyMilli: 0, valuePaise: 0 } },
    { session, upsert: true, new: true },
  );
}

async function writeEntry(session, bin, { qtyMilli, valuePaise, voucher, isReversal }) {
  const balanceQtyMilli = bin.qtyMilli + qtyMilli;
  const balanceValuePaise = bin.valuePaise + valuePaise;
  bin.qtyMilli = balanceQtyMilli;
  bin.valuePaise = balanceValuePaise;
  await bin.save({ session });
  const [entry] = await StockEntry.create([{
    postingDate: voucher.postingDate,
    voucherType: voucher.voucherType,
    voucherId: voucher.voucherId,
    voucherNo: voucher.voucherNo,
    itemId: bin.itemId,
    warehouseId: bin.warehouseId,
    lot: bin.lot,
    buildId: bin.buildId,
    qtyMilli,
    valuePaise,
    balanceQtyMilli,
    balanceValuePaise,
    isReversal: Boolean(isReversal),
  }], { session });
  return entry;
}

// Goods in, at a known value.
export async function stockIn(session, { voucher, qtyMilli, valuePaise, ...bucket }) {
  if (!Number.isSafeInteger(qtyMilli) || qtyMilli <= 0) throw new RangeError('Stock in needs a positive quantity');
  if (!Number.isSafeInteger(valuePaise) || valuePaise < 0) throw new RangeError('Stock in needs a value of zero or more');
  const bin = await lockBin(session, bucketKey(bucket));
  await writeEntry(session, bin, { qtyMilli, valuePaise, voucher });
  return { qtyMilli, valuePaise };
}

// Goods out, at the bucket's average cost. Taking everything takes all of the value.
export async function stockOut(session, { voucher, qtyMilli, ...bucket }) {
  if (!Number.isSafeInteger(qtyMilli) || qtyMilli <= 0) throw new RangeError('Stock out needs a positive quantity');
  const bin = await lockBin(session, bucketKey(bucket));
  if (bin.qtyMilli < qtyMilli) {
    throw rule(`Not enough stock: ${qtyMilli / 1000} needed, ${bin.qtyMilli / 1000} on hand.`, 'INSUFFICIENT_STOCK', {
      itemId: String(bucket.itemId),
      warehouseId: String(bucket.warehouseId),
      lot: bucket.lot || '',
      onHandMilli: bin.qtyMilli,
    });
  }
  const valuePaise = qtyMilli === bin.qtyMilli
    ? bin.valuePaise
    : mulDivRound(bin.valuePaise, qtyMilli, bin.qtyMilli);
  await writeEntry(session, bin, { qtyMilli: -qtyMilli, valuePaise: -valuePaise, voucher });
  return { qtyMilli, valuePaise };
}

// Adds cost to stock already on hand, like freight that arrives after the goods.
export async function revalueBucket(session, { voucher, valuePaise, ...bucket }) {
  const bin = await lockBin(session, bucketKey(bucket));
  if (bin.qtyMilli <= 0) throw rule('There is no stock here to add cost to.', 'NOTHING_TO_REVALUE');
  await writeEntry(session, bin, { qtyMilli: 0, valuePaise, voucher });
}

// Same goods, another bucket. The value travels with them.
export async function stockMove(session, { voucher, qtyMilli, from, to }) {
  const { valuePaise } = await stockOut(session, { voucher, qtyMilli, itemId: from.itemId, warehouseId: from.warehouseId, lot: from.lot, buildId: from.buildId });
  await stockIn(session, { voucher, qtyMilli, valuePaise, itemId: to.itemId ?? from.itemId, warehouseId: to.warehouseId ?? from.warehouseId, lot: to.lot ?? from.lot, buildId: to.buildId === undefined ? from.buildId : to.buildId });
  return { qtyMilli, valuePaise };
}

// Undoes a voucher's stock at its original values. Refuses if later movements leave
// the bucket short, or if the reversal would strand value with no quantity behind it.
// Returns the entries reversed, so the caller can check the GL side.
export async function reverseStock(session, { voucherType, voucherId, voucherNo, postingDate }) {
  const entries = await StockEntry.find({ voucherType, voucherId, isReversal: false }).sort({ _id: -1 }).session(session).lean();
  const voucher = { voucherType, voucherId, voucherNo, postingDate };
  for (const entry of entries) {
    const bin = await lockBin(session, bucketKey(entry));
    const qtyMilli = 0 - entry.qtyMilli;
    const valuePaise = 0 - entry.valuePaise;
    const nextQty = bin.qtyMilli + qtyMilli;
    const nextValue = bin.valuePaise + valuePaise;
    if (nextQty < 0) {
      throw rule('This cannot be cancelled: the stock has already moved on.', 'STOCK_ALREADY_MOVED', { itemId: String(entry.itemId) });
    }
    if (nextValue < 0 || (nextQty === 0 && nextValue !== 0)) {
      throw rule('This cannot be cancelled: stock has moved at another cost since. Use a stock adjustment.', 'STOCK_ALREADY_MOVED', { itemId: String(entry.itemId) });
    }
    await writeEntry(session, bin, { qtyMilli, valuePaise, voucher, isReversal: true });
  }
  return entries;
}

export async function assertWarehouseKind(session, warehouseId, kinds) {
  const warehouse = await Warehouse.findById(warehouseId).session(session).lean();
  if (!warehouse || !warehouse.isActive) throw rule('That warehouse does not exist or is switched off.', 'BAD_WAREHOUSE');
  if (!kinds.includes(warehouse.kind)) {
    throw rule(`${warehouse.name} is a ${warehouse.kind} warehouse, and this needs ${kinds.join(' or ')}.`, 'BAD_WAREHOUSE');
  }
  return warehouse;
}

export async function warehouseOfKind(session, kind) {
  const warehouse = await Warehouse.findOne({ kind, isActive: true }).sort({ createdAt: 1 }).session(session).lean();
  if (!warehouse) throw rule(`No ${kind} warehouse has been set up.`, 'NO_WAREHOUSE');
  return warehouse;
}

// Which ledger account a warehouse's value sits in.
export const accountForWarehouseKind = (kind) => (kind === 'FG' ? A.FINISHED_GOODS : A.INVENTORY);

async function expiredLots(session, itemId, bins) {
  const lots = [...new Set(bins.map((b) => b.lot).filter(Boolean))];
  const Batch = getType('Batch')?.Model;
  if (lots.length === 0 || !Batch) return new Set();
  const settings = await getSettings(session);
  if (!settings.blockExpiredBatches) return new Set();
  const expired = await Batch.find({ itemId: String(itemId), batchNo: { $in: lots }, expiresOn: { $ne: null, $lt: todayIst() } }).session(session).lean();
  return new Set(expired.map((b) => b.batchNo));
}

// Finds where to take a quantity from: stock set aside for this build first, then free
// stock, oldest bucket first, in STORES warehouses only. Reads inside the transaction.
export async function pickBuckets(session, { itemId, qtyMilli, buildId = null, allowFree = true, warehouseId = null }) {
  const stores = await Warehouse.find({ kind: 'STORES', isActive: true, ...(warehouseId ? { _id: warehouseId } : {}) }, { _id: 1 }).session(session).lean();
  const storeIds = stores.map((w) => w._id);
  const pegged = buildId
    ? await Bin.find({ itemId, buildId, warehouseId: { $in: storeIds }, qtyMilli: { $gt: 0 } }).sort({ _id: 1 }).session(session).lean()
    : [];
  const free = allowFree
    ? await Bin.find({ itemId, buildId: null, warehouseId: { $in: storeIds }, qtyMilli: { $gt: 0 } }).sort({ _id: 1 }).session(session).lean()
    : [];
  const blocked = await expiredLots(session, itemId, [...pegged, ...free]);
  const picks = [];
  let left = qtyMilli;
  for (const bin of [...pegged, ...free]) {
    if (left <= 0) break;
    if (bin.lot && blocked.has(bin.lot)) continue;
    const take = Math.min(left, bin.qtyMilli);
    picks.push({ itemId, warehouseId: bin.warehouseId, lot: bin.lot, buildId: bin.buildId, qtyMilli: take });
    left -= take;
  }
  if (left > 0) {
    const note = blocked.size ? ` Batches past their expiry are not counted: ${[...blocked].join(', ')}.` : '';
    throw rule(`Not enough stock: short by ${left / 1000}.${note}`, 'INSUFFICIENT_STOCK', { itemId: String(itemId), shortMilli: left, expiredLots: [...blocked] });
  }
  return picks;
}
