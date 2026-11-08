import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb, rawCollection, resetDb } from './helpers/db.js';
import { Bin, GlEntry, Item, StockEntry, Warehouse, AuditLog, Settings, Counter } from '../models/index.js';
import { pickBuckets, reverseStock, stockIn, stockMove, stockOut } from '../services/stockService.js';
import { postGl, reverseGl } from '../services/ledgerService.js';
import { audit, verifyAuditChain } from '../services/auditService.js';
import { nextDocNo } from '../services/numberService.js';
import { withTxn } from '../utils/txn.js';
import { A } from '../config/accounts.js';
import { todayIst } from '../utils/dates.js';

const date = todayIst();
const voucher = () => ({ voucherType: 'TEST', voucherId: new mongoose.Types.ObjectId(), voucherNo: 'T/1', postingDate: date });
let item;
let stores;
let fg;

before(connectTestDb);
after(disconnectTestDb);
beforeEach(async () => {
  await resetDb();
  item = await Item.create({ code: 'SS316-2MM', name: 'SS 316L sheet 2 mm', type: 'RAW', uom: 'KG' });
  stores = await Warehouse.create({ code: 'STORES', name: 'Main stores', kind: 'STORES' });
  fg = await Warehouse.create({ code: 'FG', name: 'Finished goods', kind: 'FG' });
});

const bucket = () => ({ itemId: item._id, warehouseId: stores._id, lot: 'H1', buildId: null });
const getBin = () => Bin.findOne({ itemId: item._id, warehouseId: stores._id, lot: 'H1' }).lean();

test('average cost: receipts blend, an issue takes its share, and the last issue takes all', async () => {
  await withTxn((s) => stockIn(s, { ...bucket(), voucher: voucher(), qtyMilli: 3000, valuePaise: 100 }));
  await withTxn((s) => stockIn(s, { ...bucket(), voucher: voucher(), qtyMilli: 1000, valuePaise: 1 }));
  const first = await withTxn((s) => stockOut(s, { ...bucket(), voucher: voucher(), qtyMilli: 1000 }));
  assert.equal(first.valuePaise, 25, '101 * 1/4 = 25.25 rounds to 25');
  const second = await withTxn((s) => stockOut(s, { ...bucket(), voucher: voucher(), qtyMilli: 3000 }));
  assert.equal(second.valuePaise, 76, 'the last issue takes every remaining paisa');
  const bin = await getBin();
  assert.equal(bin.qtyMilli, 0);
  assert.equal(bin.valuePaise, 0);
});

test('stock can never go negative, and a refused issue changes nothing', async () => {
  await withTxn((s) => stockIn(s, { ...bucket(), voucher: voucher(), qtyMilli: 1000, valuePaise: 500 }));
  await assert.rejects(
    withTxn((s) => stockOut(s, { ...bucket(), voucher: voucher(), qtyMilli: 1001 })),
    (e) => e.code === 'INSUFFICIENT_STOCK',
  );
  const bin = await getBin();
  assert.equal(bin.qtyMilli, 1000);
  assert.equal(await StockEntry.countDocuments(), 1);
});

test('two issues at once cannot oversell: one wins, the other is refused', async () => {
  await withTxn((s) => stockIn(s, { ...bucket(), voucher: voucher(), qtyMilli: 1000, valuePaise: 1000 }));
  const issue = () => withTxn((s) => stockOut(s, { ...bucket(), voucher: voucher(), qtyMilli: 700 }));
  const results = await Promise.allSettled([issue(), issue()]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected')[0].reason.code, 'INSUFFICIENT_STOCK');
  const bin = await getBin();
  assert.equal(bin.qtyMilli, 300);
  assert.equal(bin.valuePaise, 300);
});

test('many concurrent small issues all land, and the Bin matches the ledger', async () => {
  await withTxn((s) => stockIn(s, { ...bucket(), voucher: voucher(), qtyMilli: 10000, valuePaise: 100003 }));
  await Promise.all(Array.from({ length: 8 }, () => withTxn((s) => stockOut(s, { ...bucket(), voucher: voucher(), qtyMilli: 500 }))));
  const bin = await getBin();
  assert.equal(bin.qtyMilli, 6000);
  const entries = await StockEntry.find().lean();
  assert.equal(entries.reduce((sum, e) => sum + e.qtyMilli, 0), bin.qtyMilli);
  assert.equal(entries.reduce((sum, e) => sum + e.valuePaise, 0), bin.valuePaise);
});

test('a move carries its value to the new bucket', async () => {
  await withTxn((s) => stockIn(s, { ...bucket(), voucher: voucher(), qtyMilli: 2000, valuePaise: 1001 }));
  const buildId = new mongoose.Types.ObjectId();
  await withTxn((s) => stockMove(s, { voucher: voucher(), qtyMilli: 1000, from: bucket(), to: { buildId } }));
  const pegged = await Bin.findOne({ buildId }).lean();
  assert.equal(pegged.qtyMilli, 1000);
  assert.equal(pegged.valuePaise, 501);
  assert.equal((await getBin()).valuePaise, 500);
});

test('reversing a receipt restores the bucket; once the stock moved on it is refused', async () => {
  const v = voucher();
  await withTxn((s) => stockIn(s, { ...bucket(), voucher: v, qtyMilli: 1000, valuePaise: 700 }));
  await withTxn((s) => stockOut(s, { ...bucket(), voucher: voucher(), qtyMilli: 400 }));
  await assert.rejects(withTxn((s) => reverseStock(s, { ...v })), (e) => e.code === 'STOCK_ALREADY_MOVED');
  await withTxn((s) => stockIn(s, { ...bucket(), voucher: voucher(), qtyMilli: 400, valuePaise: 280 }));
  await withTxn((s) => reverseStock(s, { ...v }));
  const bin = await getBin();
  // 1000 in, 400 out, 400 back, then the 1000 receipt reversed: nothing is left.
  assert.equal(bin.qtyMilli, 0);
  assert.equal(bin.valuePaise, 0);
  const entries = await StockEntry.find().lean();
  assert.equal(entries.reduce((sum, e) => sum + e.qtyMilli, 0), 0);
  assert.equal(entries.reduce((sum, e) => sum + e.valuePaise, 0), 0);
});

test('pickBuckets takes stock set aside for the build first, then free stock', async () => {
  const buildId = new mongoose.Types.ObjectId();
  await withTxn(async (s) => {
    await stockIn(s, { ...bucket(), lot: 'FREE', voucher: voucher(), qtyMilli: 5000, valuePaise: 5000 });
    await stockIn(s, { ...bucket(), lot: 'PEG', buildId, voucher: voucher(), qtyMilli: 1000, valuePaise: 1000 });
  });
  const picks = await withTxn((s) => pickBuckets(s, { itemId: item._id, qtyMilli: 2500, buildId }));
  assert.deepEqual(picks.map((p) => [p.lot, p.qtyMilli]), [['PEG', 1000], ['FREE', 1500]]);
  await assert.rejects(withTxn((s) => pickBuckets(s, { itemId: item._id, qtyMilli: 6001, buildId })), (e) => e.code === 'INSUFFICIENT_STOCK');
});

const glLines = (amount) => [
  { accountCode: A.INVENTORY, debitPaise: amount },
  { accountCode: A.GRNI, creditPaise: amount },
];
const glVoucher = () => ({ postingDate: date, voucherType: 'TEST', voucherId: new mongoose.Types.ObjectId(), voucherNo: 'T/1' });

test('an unbalanced voucher does not post', async () => {
  await assert.rejects(
    withTxn((s) => postGl(s, { ...glVoucher(), lines: [{ accountCode: A.INVENTORY, debitPaise: 100 }, { accountCode: A.GRNI, creditPaise: 99 }] })),
    (e) => e.code === 'UNBALANCED_VOUCHER',
  );
  assert.equal(await GlEntry.countDocuments(), 0);
});

test('a voucher line cannot be fractional, negative or on both sides', async () => {
  const bad = [
    [{ accountCode: A.INVENTORY, debitPaise: 1.5 }, { accountCode: A.GRNI, creditPaise: 1.5 }],
    [{ accountCode: A.INVENTORY, debitPaise: -5 }, { accountCode: A.GRNI, creditPaise: -5 }],
    [{ accountCode: A.INVENTORY, debitPaise: 5, creditPaise: 5 }],
  ];
  for (const lines of bad) {
    await assert.rejects(withTxn((s) => postGl(s, { ...glVoucher(), lines })), RangeError);
  }
});

test('an unknown account is refused', async () => {
  await assert.rejects(
    withTxn((s) => postGl(s, { ...glVoucher(), lines: [{ accountCode: '9999', debitPaise: 1 }, { accountCode: A.GRNI, creditPaise: 1 }] })),
    (e) => e.code === 'UNKNOWN_ACCOUNT',
  );
});

test('the period lock refuses postings on or before the locked date, and future dates', async () => {
  await Settings.updateOne({ _id: 'company' }, { booksLockedUpTo: date });
  await assert.rejects(withTxn((s) => postGl(s, { ...glVoucher(), lines: glLines(1) })), (e) => e.code === 'PERIOD_LOCKED');
  await Settings.updateOne({ _id: 'company' }, { booksLockedUpTo: null });
  await assert.rejects(
    withTxn((s) => postGl(s, { ...glVoucher(), postingDate: '2999-01-01', lines: glLines(1) })),
    (e) => e.code === 'FUTURE_DATE',
  );
});

test('reversal mirrors a voucher and the account nets to zero', async () => {
  const v = glVoucher();
  await withTxn((s) => postGl(s, { ...v, lines: glLines(12345) }));
  await withTxn((s) => reverseGl(s, v));
  const rows = await GlEntry.find({ accountCode: A.INVENTORY }).lean();
  assert.equal(rows.length, 2);
  assert.equal(rows.reduce((sum, r) => sum + r.debitPaise - r.creditPaise, 0), 0);
});

test('ledgers refuse every update and delete from application code', async () => {
  const v = glVoucher();
  await withTxn((s) => postGl(s, { ...v, lines: glLines(100) }));
  const row = await GlEntry.findOne();
  await assert.rejects(GlEntry.updateOne({ _id: row._id }, { debitPaise: 1 }), /append-only/);
  await assert.rejects(GlEntry.findOneAndUpdate({ _id: row._id }, { debitPaise: 1 }), /append-only/);
  await assert.rejects(GlEntry.deleteOne({ _id: row._id }), /append-only/);
  await assert.rejects(GlEntry.deleteMany({}), /append-only/);
  await assert.rejects(row.deleteOne(), /append-only/);
  row.debitPaise = 1;
  await assert.rejects(row.save(), /append-only/);
  await assert.rejects(GlEntry.bulkWrite([{ deleteMany: { filter: {} } }]), /append-only/);
  await assert.rejects(StockEntry.updateMany({}, { qtyMilli: 1 }), /append-only/);
  await assert.rejects(AuditLog.deleteMany({}), /append-only/);
  assert.equal(await GlEntry.countDocuments(), 2);
});

test('document numbers: sequential, and an aborted transaction leaves no gap', async () => {
  const first = await withTxn((s) => nextDocNo(s, 'SI', '2026-11-01'));
  assert.equal(first, 'SI/2627/00001');
  assert.ok(first.length <= 16, 'GST allows 16 characters');
  await assert.rejects(withTxn(async (s) => {
    await nextDocNo(s, 'SI', '2026-11-01');
    throw new Error('boom');
  }), /boom/);
  assert.equal(await withTxn((s) => nextDocNo(s, 'SI', '2026-11-01')), 'SI/2627/00002');
  assert.equal(await withTxn((s) => nextDocNo(s, 'SI', '2027-04-01')), 'SI/2728/00001', 'a new year restarts');
});

test('concurrent numbering never repeats and leaves no gap', async () => {
  const numbers = await Promise.all(Array.from({ length: 8 }, () => withTxn((s) => nextDocNo(s, 'PO', '2026-11-01'))));
  assert.deepEqual([...numbers].sort(), Array.from({ length: 8 }, (_, i) => `PO/2627/0000${i + 1}`));
});

test('audit chain verifies, including under concurrency', async () => {
  await Promise.all(Array.from({ length: 6 }, (_, i) => withTxn((s) => audit(s, { action: 'X', entityType: 'T', entityId: String(i) }))));
  const result = await verifyAuditChain();
  assert.equal(result.ok, true, result.message);
  assert.equal(result.checked, 6);
});

test('audit chain catches a changed row, a deleted row and a removed tail', async () => {
  for (let i = 0; i < 3; i += 1) await withTxn((s) => audit(s, { action: 'X', entityType: 'T', data: { i } }));
  const raw = rawCollection(AuditLog);

  await raw.updateOne({ seq: 2 }, { $set: { 'data.i': 99 } });
  assert.match((await verifyAuditChain()).message, /record 2 was changed/);
  await raw.updateOne({ seq: 2 }, { $set: { 'data.i': 1 } });
  assert.equal((await verifyAuditChain()).ok, true, 'restoring the value restores the chain');

  const removed = await raw.findOne({ seq: 2 });
  await raw.deleteOne({ seq: 2 });
  assert.match((await verifyAuditChain()).message, /record 2 is missing/);
  await raw.insertOne(removed);

  await raw.deleteOne({ seq: 3 });
  assert.match((await verifyAuditChain()).message, /should hold 3/);
  assert.equal(await Counter.countDocuments({ _id: 'audit-chain' }), 1);
});

test('FG warehouse is a separate bucket from stores', async () => {
  await withTxn((s) => stockIn(s, { itemId: item._id, warehouseId: fg._id, voucher: voucher(), qtyMilli: 1000, valuePaise: 10 }));
  assert.equal(await Bin.countDocuments({ warehouseId: stores._id }), 0);
});
