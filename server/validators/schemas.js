// Request shapes. Every object is strict, so an unexpected field is refused, not ignored.
import { z } from 'zod';
import mongoose from 'mongoose';
import { ROLES } from '../config/permissions.js';
import { isDateString } from '../utils/dates.js';
import { isValidGstin } from '../utils/tax.js';
import { ITEM_TYPES, WAREHOUSE_KINDS } from '../models/masters.js';

const MAX_MONEY = 1e13; // Rs 1,000 crore in paise
const MAX_QTY = 1e12;

const id = z.string().refine((v) => mongoose.isValidObjectId(v), 'Not a valid id');
const text = (max = 200) => z.string().trim().max(max);
const required = (max = 200) => z.string().trim().min(1, 'Required').max(max);
const date = z.string().refine(isDateString, 'Not a real date');
const money = z.number().int().min(0).max(MAX_MONEY);
const qty = z.number().int().positive().max(MAX_QTY);
const qtyOrZero = z.number().int().min(0).max(MAX_QTY);
const bps = z.number().int().min(0).max(10000);
const fx = z.number().int().positive().max(1e9);
const currency = z.string().trim().toUpperCase().length(3);
const lines = (schema) => z.array(schema).min(1, 'Add at least one line').max(500);
const gstin = z.string().trim().toUpperCase().refine((v) => v === '' || isValidGstin(v), 'Not a valid GSTIN');
const doc = { postingDate: date.optional(), remarks: text(1000).optional() };

export const loginSchema = z.strictObject({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) });
export const changePasswordSchema = z.strictObject({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(10, 'At least 10 characters').max(200) });

export const userCreateSchema = z.strictObject({ name: required(), email: z.string().trim().toLowerCase().email(), role: z.enum(ROLES), partyId: z.string().regex(/^[0-9a-f]{24}$/).nullable().optional(), password: z.string().min(10, 'At least 10 characters').max(200) });
export const userUpdateSchema = z.strictObject({ name: required().optional(), role: z.enum(ROLES).optional(), partyId: z.string().regex(/^[0-9a-f]{24}$/).nullable().optional(), isActive: z.boolean().optional(), password: z.string().min(10).max(200).optional() });

export const settingsSchema = z.strictObject({
  legalName: required().optional(),
  gstin: gstin.optional(),
  pan: text(10).optional(),
  stateCode: z.string().trim().regex(/^\d{2}$/, 'Two digits').optional(),
  address: text(500).optional(),
  email: text().optional(),
  phone: text(30).optional(),
  bankDetails: text(500).optional(),
  lutNumber: text(50).optional(),
  booksLockedUpTo: date.nullable().optional(),
  poApprovalLimitPaise: money.optional(),
  labourRatePaise: money.optional(),
  warrantyMonths: z.number().int().min(0).max(120).optional(),
  roundOffInvoices: z.boolean().optional(),
  jobWorkInputDays: z.number().int().positive().max(3650).optional(),
  jobWorkCapitalDays: z.number().int().positive().max(3650).optional(),
  gstB2clLimitPaise: money.optional(),
  einvoiceRequired: z.boolean().optional(),
  einvoiceReportDays: z.number().int().min(0).max(3650).optional(),
  caReviewedOn: z.string().nullable().optional(),
  blockExpiredBatches: z.boolean().optional(),
  siteShowPrices: z.boolean().optional(),
  woDefaultOverBps: z.number().int().min(0).max(10000).optional(),
  woDefaultBackflush: z.boolean().optional(),
});

const itemFields = {
  code: required(40),
  name: required(),
  type: z.enum(ITEM_TYPES),
  uom: required(10).optional(),
  hsn: z.string().trim().regex(/^(\d{4}|\d{6}|\d{8})?$/, 'HSN must be 4, 6 or 8 digits').optional(),
  gstRateBps: bps.optional(),
  materialGrade: text(60).optional(),
  drawingNo: text(60).optional(),
  drawingRev: text(10).optional(),
  trackLot: z.boolean().optional(),
  requiresInspection: z.boolean().optional(),
  isCapitalGoods: z.boolean().optional(),
  standardCostPaise: money.optional(),
  salePricePaise: money.optional(),
  reorderLevelMilli: qtyOrZero.optional(),
  leadTimeDays: z.number().int().min(0).max(1000).optional(),
  itemGroupId: id.nullable().optional(),
  brandId: id.nullable().optional(),
  manufacturerId: id.nullable().optional(),
  defaultSupplierId: id.nullable().optional(),
  hasSerialNo: z.boolean().optional(),
  shelfLifeDays: z.number().int().min(0).max(36500).optional(),
  weightMilli: qtyOrZero.optional(),
  maxDiscountBps: bps.optional(),
  barcode: text(40).optional(),
  gstTreatment: z.enum(['TAXABLE', 'NIL', 'EXEMPT', 'NON_GST']).optional(),
  showOnWebsite: z.boolean().optional(),
  webDescription: text(4000).optional(),
  isActive: z.boolean().optional(),
};
export const itemSchema = z.strictObject(itemFields);
export const itemUpdateSchema = z.strictObject(itemFields).partial();

const partyFields = {
  code: required(40),
  name: required(),
  isCustomer: z.boolean().optional(),
  isSupplier: z.boolean().optional(),
  isJobWorker: z.boolean().optional(),
  gstin: gstin.optional(),
  pan: text(10).optional(),
  stateCode: z.string().trim().regex(/^(\d{2})?$/, 'Two digits').optional(),
  country: text(60).optional(),
  isExport: z.boolean().optional(),
  isSez: z.boolean().optional(),
  currency: currency.optional(),
  address: text(500).optional(),
  contactName: text().optional(),
  email: text().optional(),
  phone: text(30).optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  customerGroupId: id.nullable().optional(),
  supplierGroupId: id.nullable().optional(),
  territoryId: id.nullable().optional(),
  salesPersonId: id.nullable().optional(),
  priceListId: id.nullable().optional(),
  creditLimitPaise: money.optional(),
  isOnHold: z.boolean().optional(),
  isActive: z.boolean().optional(),
};
const partyRules = (party, ctx) => {
  if (party.gstin && party.stateCode && party.gstin.slice(0, 2) !== party.stateCode) {
    ctx.addIssue({ code: 'custom', path: ['stateCode'], message: 'The state code must match the first two digits of the GSTIN' });
  }
};
export const partySchema = z.strictObject(partyFields).superRefine(partyRules);
export const partyUpdateSchema = z.strictObject(partyFields).partial().superRefine(partyRules);

const warehouseFields = { code: required(20), name: required(), kind: z.enum(WAREHOUSE_KINDS), plant: text().optional(), isActive: z.boolean().optional() };
export const warehouseSchema = z.strictObject(warehouseFields);
export const warehouseUpdateSchema = z.strictObject(warehouseFields).partial();

const accountFields = { code: z.string().trim().regex(/^\d{3,6}$/, '3 to 6 digits'), name: required(), type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']), group: text().optional(), isCashOrBank: z.boolean().optional(), isActive: z.boolean().optional() };
export const accountSchema = z.strictObject(accountFields);
export const accountUpdateSchema = z.strictObject({ name: required().optional(), group: text().optional(), isActive: z.boolean().optional() });

const gaugeFields = { code: required(30), name: required(), lastCalibratedOn: date.nullable().optional(), dueOn: date.nullable().optional(), certRef: text().optional(), isActive: z.boolean().optional() };
export const gaugeSchema = z.strictObject(gaugeFields);
export const gaugeUpdateSchema = z.strictObject(gaugeFields).partial();

const fatRow = z.strictObject({
  parameter: required(),
  acceptance: text(300).optional(),
  minMilli: z.number().int().nullable().optional(),
  maxMilli: z.number().int().nullable().optional(),
  unit: text(20).optional(),
  isCritical: z.boolean().optional(),
});
const bomLine = z.strictObject({ itemId: id, qtyMilli: qty, scrapBps: bps.optional(), drawingNo: text(60).optional() });
export const bomSchema = z.strictObject({ itemId: id, changeNote: text(500).optional(), lines: lines(bomLine), labourHoursMilli: qtyOrZero.optional(), fatChecklist: z.array(fatRow).max(200).optional() });
export const bomUpdateSchema = z.strictObject({ changeNote: text(500).optional(), lines: lines(bomLine).optional(), labourHoursMilli: qtyOrZero.optional(), fatChecklist: z.array(fatRow).max(200).optional() });

const salesLine = z.strictObject({ itemId: id, description: text(500).optional(), qtyMilli: qty, rateMinor: money, discountBps: bps.optional(), gstRateBps: bps.optional() });
export const quotationSchema = z.strictObject({ ...doc, partyId: id, currency: currency.optional(), fxRate4: fx.optional(), validUntil: date.nullable().optional(), lines: lines(salesLine), terms: text(4000).optional() });
const milestone = z.strictObject({ no: z.number().int().positive(), name: required(), trigger: z.enum(['ORDER', 'BEFORE_FAT', 'BEFORE_DISPATCH', 'AFTER_INSTALLATION']), pctBps: bps });
export const salesOrderSchema = z.strictObject({ ...doc, partyId: id, customerPoNo: text(80).optional(), currency: currency.optional(), fxRate4: fx.optional(), isExport: z.boolean().optional(), incoterm: text(40).optional(), deliveryDate: date.nullable().optional(), lines: lines(salesLine), milestones: z.array(milestone).min(1).max(12), terms: text(4000).optional() });
export const reasonSchema = z.strictObject({ reason: required(500) });
export const optionalReasonSchema = z.strictObject({ reason: text(500).optional() });

export const stageSchema = z.strictObject({ stage: z.string(), note: text(500).optional() });
export const completeSchema = z.strictObject({ postingDate: date.optional(), allowUnissued: z.boolean().optional(), reason: text(500).optional() });
export const installSchema = z.strictObject({ installedOn: date, installedBy: required(), installationRef: text(100).optional() });

const issueLine = z.strictObject({ itemId: id, qtyMilli: qty, warehouseId: id.nullable().optional() });
export const materialIssueSchema = z.strictObject({ ...doc, buildId: id, direction: z.enum(['ISSUE', 'RETURN']).optional(), lines: lines(issueLine) });
export const timeBookingSchema = z.strictObject({ ...doc, buildId: id, operation: required(), employeeName: required(), hoursMilli: qty, ratePaise: money.optional() });

const poLine = z.strictObject({ itemId: id, qtyMilli: qty, ratePaise: money, gstRateBps: bps.optional(), buildId: id.nullable().optional() });
export const purchaseOrderSchema = z.strictObject({ ...doc, partyId: id, expectedDate: date.nullable().optional(), lines: lines(poLine), terms: text(4000).optional() });
const grnLine = z.strictObject({ poLineId: id, qtyMilli: qty, lot: text(60).optional(), certRef: text(100).optional() });
export const grnSchema = z.strictObject({ ...doc, purchaseOrderId: id, supplierChallanNo: text(60).optional(), lines: lines(grnLine) });
const inspectionLine = z.strictObject({ grnLineId: id, acceptedMilli: qtyOrZero, rejectedMilli: qtyOrZero, certVerified: z.boolean().optional(), observations: text(500).optional() });
export const inspectionSchema = z.strictObject({ ...doc, grnId: id, inspectorName: text().optional(), lines: lines(inspectionLine) });
const piLine = z.strictObject({
  kind: z.enum(['GOODS', 'SERVICE']),
  grnId: id.optional(),
  grnLineId: id.optional(),
  itemId: id.nullable().optional(),
  description: text(200).optional(),
  hsn: text(8).optional(),
  buildId: id.nullable().optional(),
  expenseAccountCode: text(6).nullable().optional(),
  costCenterId: id.nullable().optional(),
  projectId: id.nullable().optional(),
  itcBlocked: z.boolean().optional(),
  qtyMilli: qty,
  ratePaise: money,
  gstRateBps: bps.optional(),
});
export const purchaseInvoiceSchema = z.strictObject({ ...doc, partyId: id, supplierInvoiceNo: required(40), supplierInvoiceDate: date, dueDate: date.nullable().optional(), isReverseCharge: z.boolean().optional(), lines: lines(piLine) });

const moveLine = z.strictObject({ itemId: id, qtyMilli: qty, fromWarehouseId: id.nullable().optional(), toWarehouseId: id.nullable().optional(), fromBuildId: id.nullable().optional(), toBuildId: id.nullable().optional(), lot: text(60).optional(), ratePaise: money.optional() });
export const stockMoveSchema = z.strictObject({ ...doc, kind: z.enum(['TRANSFER', 'RESERVE', 'UNRESERVE', 'ADJUST_IN', 'ADJUST_OUT', 'OPENING']), reason: text(500).optional(), lines: lines(moveLine) });
const challanLine = z.strictObject({ itemId: id, qtyMilli: qty, fromWarehouseId: id, lot: text(60).optional() });
export const jobWorkSchema = z.strictObject({ ...doc, partyId: id, process: text().optional(), buildId: id.nullable().optional(), lines: lines(challanLine) });
export const jobWorkReceiveSchema = z.strictObject({ postingDate: date.optional(), lineId: id, consumedMilli: qty, outputItemId: id, outputMilli: qty, warehouseId: id.nullable().optional(), lot: text(60).optional(), supplierChallanNo: text(60).optional() });

export const ncrSchema = z.strictObject({ postingDate: date.optional(), source: z.enum(['INCOMING', 'IN_PROCESS', 'FAT', 'CUSTOMER']), buildId: id.nullable().optional(), itemId: id.nullable().optional(), itemName: text().optional(), description: required(1000) });
export const ncrCloseSchema = z.strictObject({ disposition: z.enum(['USE_AS_IS', 'REWORK', 'SCRAP', 'RETURN']), rootCause: required(1000), correctiveAction: required(1000), preventiveAction: text(1000).optional() });
export const fatStartSchema = z.strictObject({ postingDate: date.optional(), witnessName: text().optional(), witnessCompany: text().optional(), testedByName: text().optional() });
export const fatSaveSchema = z.strictObject({
  witnessName: text().optional(),
  witnessCompany: text().optional(),
  testedByName: text().optional(),
  gaugeIds: z.array(id).max(50).optional(),
  remarks: text(1000).optional(),
  results: z.array(z.strictObject({ id, observedMilli: z.number().int().nullable().optional(), observedText: text(200).optional(), result: z.enum(['', 'PASS', 'FAIL', 'NA']).optional() })).max(200).optional(),
});

const invoiceLine = z.strictObject({ kind: z.enum(['MACHINE', 'GOODS', 'SERVICE']), itemId: id.optional(), buildId: id.optional(), deliveryNoteId: id.nullable().optional(), description: text(500).optional(), qtyMilli: qty.optional(), rateMinor: money, discountBps: bps.optional(), gstRateBps: bps.optional() }).superRefine((line, ctx) => {
  if (line.kind === 'MACHINE' && !line.buildId) ctx.addIssue({ code: 'custom', path: ['buildId'], message: 'Choose the machine' });
  if (line.kind !== 'MACHINE' && !line.itemId) ctx.addIssue({ code: 'custom', path: ['itemId'], message: 'Choose an item' });
  if (line.kind !== 'MACHINE' && !line.qtyMilli) ctx.addIssue({ code: 'custom', path: ['qtyMilli'], message: 'Enter a quantity' });
});
export const salesInvoiceSchema = z.strictObject({
  ...doc,
  partyId: id,
  salesOrderId: id.nullable().optional(),
  salesOrderNo: text(30).nullable().optional(),
  currency: currency.optional(),
  fxRate4: fx.optional(),
  isExport: z.boolean().optional(),
  exportUnderLut: z.boolean().optional(),
  placeOfSupplyState: z.string().trim().regex(/^(\d{2})?$/, 'Two digits').nullable().optional(),
  dueDate: date.nullable().optional(),
  vehicleNo: text(20).optional(),
  transporter: text().optional(),
  lrNo: text(40).optional(),
  ewayBillNo: text(20).optional(),
  shippingBillNo: text(30).optional(),
  lines: lines(invoiceLine),
});
export const irnSchema = z.strictObject({ irn: z.string().trim().regex(/^[0-9a-fA-F]{64}$/, 'An IRN is 64 hexadecimal characters'), ackNo: required(30), ackAt: z.iso.datetime({ offset: true }) });
export const invoiceSubmitSchema = z.strictObject({ milestoneOverrideReason: text(500).optional(), creditOverrideReason: text(500).optional() });
const noteLine = z.strictObject({ invoiceLineId: id, qtyMilli: qtyOrZero.optional(), taxableMinor: z.number().int().positive().max(MAX_MONEY), returnGoods: z.boolean().optional(), warehouseId: id.nullable().optional(), lot: text(60).optional() });
export const noteSchema = z.strictObject({ ...doc, kind: z.enum(['CREDIT', 'DEBIT']), invoiceId: id, reason: required(500), lines: lines(noteLine) });

const paymentAllocation = z.strictObject({ docId: id, amountMinor: z.number().int().positive().max(MAX_MONEY) });
export const paymentSchema = z.strictObject({
  ...doc,
  kind: z.enum(['RECEIPT', 'PAYMENT']),
  partyId: id,
  bankAccountCode: required(6),
  reference: text(80).optional(),
  currency: currency.optional(),
  fxRate4: fx.optional(),
  amountMinor: z.number().int().positive().max(MAX_MONEY),
  salesOrderId: id.nullable().optional(),
  milestoneNo: z.number().int().positive().nullable().optional(),
  allocations: z.array(paymentAllocation).max(100).optional(),
  deductions: z.array(z.strictObject({ accountCode: required(6), amountPaise: z.number().int().positive().max(MAX_MONEY), description: text(200).optional() })).max(20).optional(),
});
export const allocateSchema = z.strictObject({ docId: id, amountMinor: z.number().int().positive().max(MAX_MONEY), postingDate: date.optional() });

export const unallocateSchema = z.strictObject({ allocationId: id, postingDate: date.optional() });

const journalLine = z.strictObject({ accountCode: required(6), debitPaise: money.optional(), creditPaise: money.optional(), partyId: id.nullable().optional(), costCenterId: id.nullable().optional(), projectId: id.nullable().optional() });
export const journalSchema = z.strictObject({ ...doc, narration: required(500), lines: z.array(journalLine).min(2, 'A journal needs two lines').max(200) });

export const amcSchema = z.strictObject({ ...doc, buildId: id, startDate: date, endDate: date, visitsPerYear: z.number().int().min(0).max(52).optional(), valuePaise: money.optional() });
export const ticketSchema = z.strictObject({ postingDate: date.optional(), buildId: id, priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'LINE_DOWN']).optional(), complaint: required(1000), assignedTo: text().optional() });
export const ticketUpdateSchema = z.strictObject({ status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CANCELLED']).optional(), assignedTo: text().optional(), resolution: text(1000).optional(), priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'LINE_DOWN']).optional() });
