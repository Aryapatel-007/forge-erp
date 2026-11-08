// Masters: items, parties, warehouses, accounts.
import mongoose from 'mongoose';
import { baseOptions } from './plugins.js';

const { Schema } = mongoose;

export const ITEM_TYPES = ['RAW', 'BOUGHT_OUT', 'FABRICATED', 'ASSEMBLY', 'MACHINE', 'SPARE', 'CONSUMABLE', 'SERVICE'];

const itemSchema = new Schema({
  code: { type: String, required: true, trim: true, uppercase: true, unique: true },
  name: { type: String, required: true, trim: true },
  type: { type: String, enum: ITEM_TYPES, required: true },
  uom: { type: String, required: true, trim: true, default: 'NOS' },
  hsn: { type: String, trim: true, default: '' },
  gstRateBps: { type: Number, required: true, default: 1800 },
  materialGrade: { type: String, trim: true, default: '' }, // like SS 316L
  drawingNo: { type: String, trim: true, default: '' },
  drawingRev: { type: String, trim: true, default: '' },
  trackLot: { type: Boolean, default: false }, // heat number, batch
  requiresInspection: { type: Boolean, default: false },
  isCapitalGoods: { type: Boolean, default: false },
  standardCostPaise: { type: Number, default: 0 },
  salePricePaise: { type: Number, default: 0 },
  reorderLevelMilli: { type: Number, default: 0 },
  leadTimeDays: { type: Number, default: 0 },
  itemGroupId: { type: String, default: null },
  brandId: { type: String, default: null },
  manufacturerId: { type: String, default: null },
  defaultSupplierId: { type: String, default: null },
  variantOfId: { type: Schema.Types.ObjectId, ref: 'Item', default: null },
  variantValue: { type: String, default: '' },
  hasSerialNo: { type: Boolean, default: false },
  shelfLifeDays: { type: Number, default: 0 },
  weightMilli: { type: Number, default: 0 },
  maxDiscountBps: { type: Number, default: 0 },
  barcode: { type: String, trim: true, default: '' },
  gstTreatment: { type: String, enum: ['TAXABLE', 'NIL', 'EXEMPT', 'NON_GST'], default: 'TAXABLE' },
  showOnWebsite: { type: Boolean, default: false },
  webDescription: { type: String, default: '' },
  isActive: { type: Boolean, default: true },
}, baseOptions);
itemSchema.index({ type: 1, isActive: 1 });
itemSchema.index({ name: 'text', code: 'text' });
export const Item = mongoose.model('Item', itemSchema);

const partySchema = new Schema({
  code: { type: String, required: true, trim: true, uppercase: true, unique: true },
  name: { type: String, required: true, trim: true },
  isCustomer: { type: Boolean, default: false },
  isSupplier: { type: Boolean, default: false },
  isJobWorker: { type: Boolean, default: false },
  gstin: { type: String, trim: true, uppercase: true, default: '' },
  pan: { type: String, trim: true, uppercase: true, default: '' },
  stateCode: { type: String, trim: true, default: '' },
  country: { type: String, trim: true, default: 'India' },
  isExport: { type: Boolean, default: false },
  isSez: { type: Boolean, default: false },
  currency: { type: String, trim: true, uppercase: true, default: 'INR' },
  address: { type: String, trim: true, default: '' },
  contactName: { type: String, trim: true, default: '' },
  email: { type: String, trim: true, lowercase: true, default: '' },
  phone: { type: String, trim: true, default: '' },
  paymentTermsDays: { type: Number, default: 30 },
  customerGroupId: { type: String, default: null },
  supplierGroupId: { type: String, default: null },
  territoryId: { type: String, default: null },
  salesPersonId: { type: String, default: null },
  priceListId: { type: String, default: null },
  creditLimitPaise: { type: Number, default: 0 },
  isOnHold: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
}, baseOptions);
partySchema.index({ name: 'text', code: 'text' });
export const Party = mongoose.model('Party', partySchema);

export const WAREHOUSE_KINDS = ['STORES', 'QUARANTINE', 'REJECT', 'JOBWORK', 'FG'];

const warehouseSchema = new Schema({
  code: { type: String, required: true, trim: true, uppercase: true, unique: true },
  name: { type: String, required: true, trim: true },
  kind: { type: String, enum: WAREHOUSE_KINDS, required: true },
  plant: { type: String, trim: true, default: 'Main plant' },
  isActive: { type: Boolean, default: true },
}, baseOptions);
export const Warehouse = mongoose.model('Warehouse', warehouseSchema);

const accountSchema = new Schema({
  code: { type: String, required: true, trim: true, unique: true },
  name: { type: String, required: true, trim: true },
  type: { type: String, enum: ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'], required: true },
  group: { type: String, trim: true, default: '' },
  isSystem: { type: Boolean, default: false },
  isControl: { type: Boolean, default: false }, // only the system posts here; no hand journals
  isCashOrBank: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
}, baseOptions);
export const Account = mongoose.model('Account', accountSchema);
