// The two ledgers, and the Bin that summarises stock.
import mongoose from 'mongoose';
import { appendOnly, baseOptions } from './plugins.js';

const { Schema } = mongoose;

const voucher = {
  voucherType: { type: String, required: true },
  voucherId: { type: Schema.Types.ObjectId, required: true },
  voucherNo: { type: String, required: true },
};

const glEntrySchema = new Schema({
  postingDate: { type: String, required: true },
  ...voucher,
  accountCode: { type: String, required: true },
  debitPaise: { type: Number, default: 0, min: 0 },
  creditPaise: { type: Number, default: 0, min: 0 },
  partyId: { type: Schema.Types.ObjectId, ref: 'Party', default: null },
  buildId: { type: Schema.Types.ObjectId, ref: 'MachineBuild', default: null },
  costCenterId: { type: String, default: null },
  projectId: { type: String, default: null },
  narration: { type: String, default: '' },
  isReversal: { type: Boolean, default: false },
}, { ...baseOptions, timestamps: { createdAt: true, updatedAt: false } });
glEntrySchema.index({ accountCode: 1, postingDate: 1 });
glEntrySchema.index({ voucherType: 1, voucherId: 1 });
glEntrySchema.index({ partyId: 1, postingDate: 1 });
glEntrySchema.index({ buildId: 1, accountCode: 1 });
glEntrySchema.index({ postingDate: 1 });
glEntrySchema.index({ costCenterId: 1, accountCode: 1, postingDate: 1 });
glEntrySchema.index({ projectId: 1, postingDate: 1 });
appendOnly(glEntrySchema, { name: 'GlEntry' });
export const GlEntry = mongoose.model('GlEntry', glEntrySchema);

const stockEntrySchema = new Schema({
  postingDate: { type: String, required: true },
  ...voucher,
  itemId: { type: Schema.Types.ObjectId, ref: 'Item', required: true },
  warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse', required: true },
  lot: { type: String, default: '' },
  buildId: { type: Schema.Types.ObjectId, ref: 'MachineBuild', default: null },
  qtyMilli: { type: Number, required: true },
  valuePaise: { type: Number, required: true },
  balanceQtyMilli: { type: Number, required: true },
  balanceValuePaise: { type: Number, required: true },
  isReversal: { type: Boolean, default: false },
}, { ...baseOptions, timestamps: { createdAt: true, updatedAt: false } });
stockEntrySchema.index({ itemId: 1, warehouseId: 1, lot: 1, buildId: 1, _id: 1 });
stockEntrySchema.index({ voucherType: 1, voucherId: 1 });
stockEntrySchema.index({ postingDate: 1 });
appendOnly(stockEntrySchema, { name: 'StockEntry' });
export const StockEntry = mongoose.model('StockEntry', stockEntrySchema);

// One row per bucket: item + warehouse + lot + build. Only stockService writes it.
const binSchema = new Schema({
  itemId: { type: Schema.Types.ObjectId, ref: 'Item', required: true },
  warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse', required: true },
  lot: { type: String, default: '' },
  buildId: { type: Schema.Types.ObjectId, ref: 'MachineBuild', default: null },
  qtyMilli: { type: Number, default: 0, min: 0 },
  valuePaise: { type: Number, default: 0 },
  lockSeq: { type: Number, default: 0 },
}, baseOptions);
binSchema.index({ itemId: 1, warehouseId: 1, lot: 1, buildId: 1 }, { unique: true });
binSchema.index({ buildId: 1, itemId: 1 });
export const Bin = mongoose.model('Bin', binSchema);
