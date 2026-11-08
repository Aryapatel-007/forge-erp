// Business documents. Each goes DRAFT -> submitted -> CANCELLED, and a submitted
// document only changes through its service. Names, HSN codes and rates are frozen on
// each line when the line is made.
import mongoose from 'mongoose';
import { baseOptions } from './plugins.js';

const { Schema } = mongoose;
const Id = Schema.Types.ObjectId;

const docFields = {
  docNo: { type: String, default: null },
  postingDate: { type: String, required: true },
  remarks: { type: String, default: '' },
  createdBy: { type: Id, ref: 'User', default: null },
  submittedBy: { type: Id, ref: 'User', default: null },
  submittedAt: { type: Date, default: null },
  cancelledBy: { type: Id, ref: 'User', default: null },
  cancelledAt: { type: Date, default: null },
  cancelReason: { type: String, default: null },
};

const frozenItem = {
  itemId: { type: Id, ref: 'Item', required: true },
  itemCode: { type: String, required: true },
  itemName: { type: String, required: true },
  uom: { type: String, default: 'NOS' },
  hsn: { type: String, default: '' },
};

const uniqueDocNo = (schema) => {
  schema.index({ docNo: 1 }, { unique: true, partialFilterExpression: { docNo: { $type: 'string' } } });
  schema.index({ status: 1, postingDate: -1 });
  return schema;
};

const taxTotals = {
  supplyType: { type: String, required: true },
  taxablePaise: { type: Number, default: 0 },
  cgstPaise: { type: Number, default: 0 },
  sgstPaise: { type: Number, default: 0 },
  igstPaise: { type: Number, default: 0 },
  taxPaise: { type: Number, default: 0 },
  roundOffPaise: { type: Number, default: 0 },
  totalPaise: { type: Number, default: 0 },
};

/* ---------- Engineering ---------- */

const bomSchema = new Schema({
  itemId: { type: Id, ref: 'Item', required: true },
  itemCode: { type: String, required: true },
  itemName: { type: String, required: true },
  revision: { type: Number, required: true },
  status: { type: String, enum: ['DRAFT', 'RELEASED', 'OBSOLETE'], default: 'DRAFT' },
  changeNote: { type: String, default: '' },
  lines: [{
    ...frozenItem,
    qtyMilli: { type: Number, required: true, min: 1 },
    scrapBps: { type: Number, default: 0 },
    drawingNo: { type: String, default: '' },
  }],
  labourHoursMilli: { type: Number, default: 0 },
  fatChecklist: [{
    parameter: { type: String, required: true },
    acceptance: { type: String, default: '' },
    minMilli: { type: Number, default: null },
    maxMilli: { type: Number, default: null },
    unit: { type: String, default: '' },
    isCritical: { type: Boolean, default: true },
  }],
  releasedBy: { type: Id, ref: 'User', default: null },
  releasedAt: { type: Date, default: null },
  createdBy: { type: Id, ref: 'User', default: null },
}, baseOptions);
bomSchema.index({ itemId: 1, revision: 1 }, { unique: true });
bomSchema.index({ itemId: 1 }, { unique: true, partialFilterExpression: { status: 'RELEASED' }, name: 'one_released_bom' });
export const Bom = mongoose.model('Bom', bomSchema);

/* ---------- Sales ---------- */

const salesLine = {
  ...frozenItem,
  description: { type: String, default: '' },
  qtyMilli: { type: Number, required: true, min: 1 },
  rateMinor: { type: Number, required: true, min: 0 },
  discountBps: { type: Number, default: 0, min: 0, max: 10000 },
  gstRateBps: { type: Number, required: true, min: 0 },
  amountMinor: { type: Number, default: 0 },
};

const quotationSchema = uniqueDocNo(new Schema({
  ...docFields,
  status: { type: String, enum: ['DRAFT', 'SENT', 'WON', 'LOST', 'SUPERSEDED', 'CANCELLED'], default: 'DRAFT' },
  rootId: { type: Id, default: null },
  revision: { type: Number, default: 0 },
  partyId: { type: Id, ref: 'Party', required: true },
  partyName: { type: String, required: true },
  currency: { type: String, default: 'INR' },
  fxRate4: { type: Number, default: 10000 },
  validUntil: { type: String, default: null },
  lines: [salesLine],
  subtotalMinor: { type: Number, default: 0 },
  terms: { type: String, default: '' },
  lostReason: { type: String, default: '' },
}, baseOptions));
export const Quotation = mongoose.model('Quotation', quotationSchema);

const salesOrderSchema = uniqueDocNo(new Schema({
  ...docFields,
  status: { type: String, enum: ['DRAFT', 'CONFIRMED', 'CLOSED', 'CANCELLED'], default: 'DRAFT' },
  quotationId: { type: Id, ref: 'Quotation', default: null },
  blanketOrderId: { type: String, default: null },
  partyId: { type: Id, ref: 'Party', required: true },
  partyName: { type: String, required: true },
  customerPoNo: { type: String, default: '' },
  currency: { type: String, default: 'INR' },
  fxRate4: { type: Number, default: 10000 },
  isExport: { type: Boolean, default: false },
  incoterm: { type: String, default: '' },
  deliveryDate: { type: String, default: null },
  lines: [salesLine],
  subtotalMinor: { type: Number, default: 0 },
  milestones: [{
    no: { type: Number, required: true },
    name: { type: String, required: true },
    trigger: { type: String, enum: ['ORDER', 'BEFORE_FAT', 'BEFORE_DISPATCH', 'AFTER_INSTALLATION'], required: true },
    pctBps: { type: Number, required: true },
    amountMinor: { type: Number, default: 0 },
    receivedMinor: { type: Number, default: 0 },
  }],
  terms: { type: String, default: '' },
}, baseOptions));
export const SalesOrder = mongoose.model('SalesOrder', salesOrderSchema);

/* ---------- Builds ---------- */

export const BUILD_STAGES = ['PLANNED', 'PROCUREMENT', 'FABRICATION', 'ASSEMBLY', 'FAT', 'READY', 'DISPATCHED', 'INSTALLED', 'CLOSED', 'CANCELLED'];

const machineBuildSchema = new Schema({
  serialNo: { type: String, required: true, unique: true },
  itemId: { type: Id, ref: 'Item', required: true },
  itemCode: { type: String, required: true },
  itemName: { type: String, required: true },
  hsn: { type: String, default: '' },
  salesOrderId: { type: Id, ref: 'SalesOrder', default: null },
  salesOrderNo: { type: String, default: null },
  partyId: { type: Id, ref: 'Party', default: null },
  partyName: { type: String, default: '' },
  bomId: { type: Id, ref: 'Bom', required: true },
  bomRevision: { type: Number, required: true },
  stage: { type: String, enum: BUILD_STAGES, default: 'PLANNED' },
  targetDate: { type: String, default: null },
  budgetPaise: { type: Number, default: 0 },
  materials: [{
    ...frozenItem,
    requiredMilli: { type: Number, required: true },
    issuedMilli: { type: Number, default: 0 },
    issuedValuePaise: { type: Number, default: 0 },
  }],
  materialCostPaise: { type: Number, default: 0 },
  labourCostPaise: { type: Number, default: 0 },
  otherCostPaise: { type: Number, default: 0 },
  wipPaise: { type: Number, default: 0 },
  finishedValuePaise: { type: Number, default: 0 },
  fatStatus: { type: String, enum: ['NOT_DONE', 'PASSED', 'FAILED'], default: 'NOT_DONE' },
  completedAt: { type: Date, default: null },
  dispatchedOn: { type: String, default: null },
  salesInvoiceId: { type: Id, ref: 'SalesInvoice', default: null },
  installedOn: { type: String, default: null },
  installedBy: { type: String, default: '' },
  warrantyUntil: { type: String, default: null },
  installationRef: { type: String, default: '' },
  stageHistory: [{
    stage: String,
    at: Date,
    byName: String,
    note: String,
  }],
}, baseOptions);
machineBuildSchema.index({ stage: 1, targetDate: 1 });
machineBuildSchema.index({ partyId: 1 });
machineBuildSchema.index({ salesOrderId: 1 });
export const MachineBuild = mongoose.model('MachineBuild', machineBuildSchema);

const materialIssueSchema = uniqueDocNo(new Schema({
  ...docFields,
  status: { type: String, enum: ['DRAFT', 'SUBMITTED', 'CANCELLED'], default: 'DRAFT' },
  buildId: { type: Id, ref: 'MachineBuild', required: true },
  serialNo: { type: String, required: true },
  direction: { type: String, enum: ['ISSUE', 'RETURN'], default: 'ISSUE' },
  lines: [{
    ...frozenItem,
    qtyMilli: { type: Number, required: true, min: 1 },
    valuePaise: { type: Number, default: 0 },
    warehouseId: { type: Id, ref: 'Warehouse', default: null }, // return only
    picks: [{ warehouseId: Id, lot: String, buildId: Id, qtyMilli: Number, valuePaise: Number }],
  }],
  totalValuePaise: { type: Number, default: 0 },
}, baseOptions));
export const MaterialIssue = mongoose.model('MaterialIssue', materialIssueSchema);

const timeBookingSchema = uniqueDocNo(new Schema({
  ...docFields,
  status: { type: String, enum: ['DRAFT', 'SUBMITTED', 'CANCELLED'], default: 'DRAFT' },
  buildId: { type: Id, ref: 'MachineBuild', required: true },
  serialNo: { type: String, required: true },
  operation: { type: String, required: true },
  employeeName: { type: String, required: true },
  hoursMilli: { type: Number, required: true, min: 1 },
  ratePaise: { type: Number, default: 0 },
  valuePaise: { type: Number, default: 0 },
}, baseOptions));
export const TimeBooking = mongoose.model('TimeBooking', timeBookingSchema);

/* ---------- Purchase ---------- */

const purchaseOrderSchema = uniqueDocNo(new Schema({
  ...docFields,
  status: { type: String, enum: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'CLOSED', 'CANCELLED'], default: 'DRAFT' },
  partyId: { type: Id, ref: 'Party', required: true },
  partyName: { type: String, required: true },
  supplyType: { type: String, default: 'INTRA' },
  expectedDate: { type: String, default: null },
  lines: [{
    ...frozenItem,
    qtyMilli: { type: Number, required: true, min: 1 },
    ratePaise: { type: Number, required: true, min: 0 },
    gstRateBps: { type: Number, required: true, min: 0 },
    buildId: { type: Id, ref: 'MachineBuild', default: null },
    serialNo: { type: String, default: null },
    requiresInspection: { type: Boolean, default: false },
    receivedMilli: { type: Number, default: 0 },
  }],
  taxablePaise: { type: Number, default: 0 },
  taxPaise: { type: Number, default: 0 },
  totalPaise: { type: Number, default: 0 },
  approvedBy: { type: Id, ref: 'User', default: null },
  approvedAt: { type: Date, default: null },
  terms: { type: String, default: '' },
}, baseOptions));
purchaseOrderSchema.index({ 'lines.buildId': 1 });
export const PurchaseOrder = mongoose.model('PurchaseOrder', purchaseOrderSchema);

const grnSchema = uniqueDocNo(new Schema({
  ...docFields,
  status: { type: String, enum: ['DRAFT', 'SUBMITTED', 'CANCELLED'], default: 'DRAFT' },
  purchaseOrderId: { type: Id, ref: 'PurchaseOrder', required: true },
  purchaseOrderNo: { type: String, default: null },
  partyId: { type: Id, ref: 'Party', required: true },
  partyName: { type: String, required: true },
  supplierChallanNo: { type: String, default: '' },
  lines: [{
    ...frozenItem,
    poLineId: { type: Id, required: true },
    qtyMilli: { type: Number, required: true, min: 1 },
    ratePaise: { type: Number, required: true },
    gstRateBps: { type: Number, default: 0 },
    valuePaise: { type: Number, default: 0 },
    lot: { type: String, default: '' },
    certRef: { type: String, default: '' },
    buildId: { type: Id, ref: 'MachineBuild', default: null },
    requiresInspection: { type: Boolean, default: false },
    warehouseId: { type: Id, ref: 'Warehouse', default: null },
    acceptedMilli: { type: Number, default: 0 },
    rejectedMilli: { type: Number, default: 0 },
    billedMilli: { type: Number, default: 0 },
  }],
  totalValuePaise: { type: Number, default: 0 },
}, baseOptions));
grnSchema.index({ purchaseOrderId: 1 });
export const Grn = mongoose.model('Grn', grnSchema);

const purchaseInvoiceSchema = uniqueDocNo(new Schema({
  ...docFields,
  status: { type: String, enum: ['DRAFT', 'SUBMITTED', 'CANCELLED'], default: 'DRAFT' },
  partyId: { type: Id, ref: 'Party', required: true },
  partyName: { type: String, required: true },
  supplierGstin: { type: String, default: '' },
  supplierInvoiceNo: { type: String, required: true },
  supplierInvoiceDate: { type: String, required: true },
  dueDate: { type: String, default: null },
  lines: [{
    kind: { type: String, enum: ['GOODS', 'SERVICE'], required: true },
    itemId: { type: Id, ref: 'Item', default: null },
    itemCode: { type: String, default: '' },
    itemName: { type: String, required: true },
    uom: { type: String, default: 'NOS' },
    hsn: { type: String, default: '' },
    grnId: { type: Id, ref: 'Grn', default: null },
    grnLineId: { type: Id, default: null },
    grnNo: { type: String, default: null },
    buildId: { type: Id, ref: 'MachineBuild', default: null },
    expenseAccountCode: { type: String, default: null },
    costCenterId: { type: String, default: null },
    projectId: { type: String, default: null },
    itcBlocked: { type: Boolean, default: false },
    gstTreatment: { type: String, default: 'TAXABLE' },
    cgstPaise: { type: Number, default: 0 },
    sgstPaise: { type: Number, default: 0 },
    igstPaise: { type: Number, default: 0 },
    qtyMilli: { type: Number, required: true, min: 1 },
    ratePaise: { type: Number, required: true, min: 0 },
    gstRateBps: { type: Number, required: true, min: 0 },
    taxablePaise: { type: Number, default: 0 },
    grnValuePaise: { type: Number, default: 0 },
  }],
  ...taxTotals,
  isReverseCharge: { type: Boolean, default: false },
  isOpening: { type: Boolean, default: false },
  blockedTaxPaise: { type: Number, default: 0 },
  paidPaise: { type: Number, default: 0 },
  creditedPaise: { type: Number, default: 0 },
}, baseOptions));
purchaseInvoiceSchema.index(
  { partyId: 1, supplierInvoiceNo: 1 },
  { unique: true, partialFilterExpression: { status: 'SUBMITTED' }, name: 'one_live_supplier_invoice' },
);
export const PurchaseInvoice = mongoose.model('PurchaseInvoice', purchaseInvoiceSchema);

/* ---------- Stores ---------- */

const stockMoveSchema = uniqueDocNo(new Schema({
  ...docFields,
  status: { type: String, enum: ['DRAFT', 'SUBMITTED', 'CANCELLED'], default: 'DRAFT' },
  kind: { type: String, enum: ['TRANSFER', 'RESERVE', 'UNRESERVE', 'ADJUST_IN', 'ADJUST_OUT', 'OPENING'], required: true },
  reason: { type: String, default: '' },
  lines: [{
    ...frozenItem,
    qtyMilli: { type: Number, required: true, min: 1 },
    fromWarehouseId: { type: Id, ref: 'Warehouse', default: null },
    toWarehouseId: { type: Id, ref: 'Warehouse', default: null },
    fromBuildId: { type: Id, ref: 'MachineBuild', default: null },
    toBuildId: { type: Id, ref: 'MachineBuild', default: null },
    lot: { type: String, default: '' },
    ratePaise: { type: Number, default: 0 }, // inward kinds only
    valuePaise: { type: Number, default: 0 },
  }],
  totalValuePaise: { type: Number, default: 0 },
}, baseOptions));
export const StockMove = mongoose.model('StockMove', stockMoveSchema);

const jobWorkChallanSchema = uniqueDocNo(new Schema({
  ...docFields,
  status: { type: String, enum: ['DRAFT', 'SENT', 'PARTLY_RETURNED', 'RETURNED', 'CANCELLED'], default: 'DRAFT' },
  partyId: { type: Id, ref: 'Party', required: true },
  partyName: { type: String, required: true },
  process: { type: String, default: '' },
  buildId: { type: Id, ref: 'MachineBuild', default: null },
  serialNo: { type: String, default: null },
  returnBy: { type: String, default: null },
  lines: [{
    ...frozenItem,
    qtyMilli: { type: Number, required: true, min: 1 },
    gstRateBps: { type: Number, default: 0 },
    isCapitalGoods: { type: Boolean, default: false },
    fromWarehouseId: { type: Id, ref: 'Warehouse', required: true },
    lot: { type: String, default: '' },
    valuePaise: { type: Number, default: 0 },
    consumedMilli: { type: Number, default: 0 },
    consumedValuePaise: { type: Number, default: 0 },
  }],
  receipts: [{
    docNo: String,
    postingDate: String,
    lineId: Id,
    consumedMilli: Number,
    outputItemId: { type: Id, ref: 'Item' },
    outputItemCode: String,
    outputItemName: String,
    outputMilli: Number,
    wasteMilli: Number,
    warehouseId: { type: Id, ref: 'Warehouse' },
    lot: String,
    valuePaise: Number,
    supplierChallanNo: String,
    voucherId: Id,
  }],
  totalValuePaise: { type: Number, default: 0 },
}, baseOptions));
jobWorkChallanSchema.index({ partyId: 1, status: 1 });
export const JobWorkChallan = mongoose.model('JobWorkChallan', jobWorkChallanSchema);

/* ---------- Quality ---------- */

const inspectionSchema = uniqueDocNo(new Schema({
  ...docFields,
  status: { type: String, enum: ['DRAFT', 'SUBMITTED', 'CANCELLED'], default: 'DRAFT' },
  grnId: { type: Id, ref: 'Grn', required: true },
  grnNo: { type: String, required: true },
  partyName: { type: String, default: '' },
  inspectorName: { type: String, default: '' },
  lines: [{
    grnLineId: { type: Id, required: true },
    itemId: { type: Id, ref: 'Item', required: true },
    itemCode: String,
    itemName: String,
    lot: String,
    receivedMilli: Number,
    acceptedMilli: { type: Number, default: 0 },
    rejectedMilli: { type: Number, default: 0 },
    certVerified: { type: Boolean, default: false },
    observations: { type: String, default: '' },
  }],
}, baseOptions));
inspectionSchema.index({ grnId: 1 });
export const Inspection = mongoose.model('Inspection', inspectionSchema);

const ncrSchema = uniqueDocNo(new Schema({
  ...docFields,
  status: { type: String, enum: ['OPEN', 'CLOSED', 'CANCELLED'], default: 'OPEN' },
  source: { type: String, enum: ['INCOMING', 'IN_PROCESS', 'FAT', 'CUSTOMER'], required: true },
  buildId: { type: Id, ref: 'MachineBuild', default: null },
  serialNo: { type: String, default: null },
  itemId: { type: Id, ref: 'Item', default: null },
  itemName: { type: String, default: '' },
  description: { type: String, required: true },
  raisedBy: { type: Id, ref: 'User', default: null },
  raisedByName: { type: String, default: '' },
  disposition: { type: String, enum: ['', 'USE_AS_IS', 'REWORK', 'SCRAP', 'RETURN'], default: '' },
  rootCause: { type: String, default: '' },
  correctiveAction: { type: String, default: '' },
  preventiveAction: { type: String, default: '' },
  closedBy: { type: Id, ref: 'User', default: null },
  closedAt: { type: Date, default: null },
}, baseOptions));
ncrSchema.index({ buildId: 1, status: 1 });
export const Ncr = mongoose.model('Ncr', ncrSchema);

const fatProtocolSchema = uniqueDocNo(new Schema({
  ...docFields,
  status: { type: String, enum: ['DRAFT', 'PASSED', 'FAILED', 'CANCELLED'], default: 'DRAFT' },
  buildId: { type: Id, ref: 'MachineBuild', required: true },
  serialNo: { type: String, required: true },
  attempt: { type: Number, default: 1 },
  witnessName: { type: String, default: '' },
  witnessCompany: { type: String, default: '' },
  testedByName: { type: String, default: '' },
  gaugeIds: [{ type: Id, ref: 'Gauge' }],
  results: [{
    parameter: { type: String, required: true },
    acceptance: { type: String, default: '' },
    minMilli: { type: Number, default: null },
    maxMilli: { type: Number, default: null },
    unit: { type: String, default: '' },
    isCritical: { type: Boolean, default: true },
    observedMilli: { type: Number, default: null },
    observedText: { type: String, default: '' },
    result: { type: String, enum: ['', 'PASS', 'FAIL', 'NA'], default: '' },
  }],
}, baseOptions));
fatProtocolSchema.index({ buildId: 1, attempt: 1 });
export const FatProtocol = mongoose.model('FatProtocol', fatProtocolSchema);

const gaugeSchema = new Schema({
  code: { type: String, required: true, trim: true, uppercase: true, unique: true },
  name: { type: String, required: true, trim: true },
  lastCalibratedOn: { type: String, default: null },
  dueOn: { type: String, default: null },
  certRef: { type: String, default: '' },
  isActive: { type: Boolean, default: true },
}, baseOptions);
export const Gauge = mongoose.model('Gauge', gaugeSchema);

/* ---------- Accounts ---------- */

const salesInvoiceSchema = uniqueDocNo(new Schema({
  ...docFields,
  status: { type: String, enum: ['DRAFT', 'SUBMITTED', 'CANCELLED'], default: 'DRAFT' },
  partyId: { type: Id, ref: 'Party', required: true },
  partyName: { type: String, required: true },
  partyGstin: { type: String, default: '' },
  placeOfSupply: { type: String, default: '' },
  salesOrderId: { type: Id, ref: 'SalesOrder', default: null },
  salesOrderNo: { type: String, default: null },
  currency: { type: String, default: 'INR' },
  fxRate4: { type: Number, default: 10000 },
  isExport: { type: Boolean, default: false },
  lutNumber: { type: String, default: '' },
  dueDate: { type: String, default: null },
  vehicleNo: { type: String, default: '' },
  transporter: { type: String, default: '' },
  lrNo: { type: String, default: '' },
  ewayBillNo: { type: String, default: '' },
  shippingBillNo: { type: String, default: '' },
  milestoneOverrideReason: { type: String, default: '' },
  milestoneOverrideBy: { type: Id, ref: 'User', default: null },
  creditOverrideReason: { type: String, default: '' },
  isOpening: { type: Boolean, default: false },
  irn: { type: String, default: null },
  irnAckNo: { type: String, default: null },
  irnAckAt: { type: Date, default: null },
  irnCancelledAt: { type: Date, default: null },
  lines: [{
    kind: { type: String, enum: ['MACHINE', 'GOODS', 'SERVICE'], required: true },
    ...frozenItem,
    description: { type: String, default: '' },
    buildId: { type: Id, ref: 'MachineBuild', default: null },
    serialNo: { type: String, default: null },
    warehouseId: { type: Id, ref: 'Warehouse', default: null },
    deliveryNoteId: { type: String, default: null },
    gstTreatment: { type: String, default: 'TAXABLE' },
    qtyMilli: { type: Number, required: true, min: 1 },
    rateMinor: { type: Number, required: true, min: 0 },
    discountBps: { type: Number, default: 0 },
    gstRateBps: { type: Number, required: true, min: 0 },
    taxableMinor: { type: Number, default: 0 },
    taxablePaise: { type: Number, default: 0 },
    cgstPaise: { type: Number, default: 0 },
    sgstPaise: { type: Number, default: 0 },
    igstPaise: { type: Number, default: 0 },
    costPaise: { type: Number, default: 0 },
  }],
  slabs: [{ gstRateBps: Number, taxablePaise: Number, cgstPaise: Number, sgstPaise: Number, igstPaise: Number }],
  ...taxTotals,
  totalMinor: { type: Number, default: 0 },
  costPaise: { type: Number, default: 0 },
  paidMinor: { type: Number, default: 0 },
  paidPaise: { type: Number, default: 0 },
  creditedMinor: { type: Number, default: 0 },
  creditedPaise: { type: Number, default: 0 },
}, baseOptions));
salesInvoiceSchema.index({ partyId: 1, status: 1 });
salesInvoiceSchema.index({ irn: 1 }, { unique: true, partialFilterExpression: { irn: { $type: 'string' } } });
export const SalesInvoice = mongoose.model('SalesInvoice', salesInvoiceSchema);

const paymentSchema = uniqueDocNo(new Schema({
  ...docFields,
  status: { type: String, enum: ['DRAFT', 'SUBMITTED', 'CANCELLED'], default: 'DRAFT' },
  kind: { type: String, enum: ['RECEIPT', 'PAYMENT'], required: true },
  partyId: { type: Id, ref: 'Party', required: true },
  partyName: { type: String, required: true },
  bankAccountCode: { type: String, required: true },
  reference: { type: String, default: '' },
  currency: { type: String, default: 'INR' },
  fxRate4: { type: Number, default: 10000 },
  amountMinor: { type: Number, required: true, min: 1 },
  amountPaise: { type: Number, default: 0 },
  deductions: [{ accountCode: { type: String, required: true }, amountPaise: { type: Number, required: true, min: 1 }, description: { type: String, default: '' } }],
  deductionsPaise: { type: Number, default: 0 },
  salesOrderId: { type: Id, ref: 'SalesOrder', default: null },
  milestoneNo: { type: Number, default: null },
  allocations: [{
    docType: { type: String, enum: ['SalesInvoice', 'PurchaseInvoice'], required: true },
    docId: { type: Id, required: true },
    docNo: String,
    amountMinor: { type: Number, required: true, min: 1 },
    carriedPaise: { type: Number, default: 0 },
    forexPaise: { type: Number, default: 0 },
    allocatedOn: String,
    voucherNo: String,
  }],
  allocatedMinor: { type: Number, default: 0 },
}, baseOptions));
paymentSchema.index({ partyId: 1, status: 1 });
export const Payment = mongoose.model('Payment', paymentSchema);

const journalSchema = uniqueDocNo(new Schema({
  ...docFields,
  status: { type: String, enum: ['DRAFT', 'SUBMITTED', 'CANCELLED'], default: 'DRAFT' },
  narration: { type: String, required: true },
  lines: [{
    accountCode: { type: String, required: true },
    debitPaise: { type: Number, default: 0, min: 0 },
    creditPaise: { type: Number, default: 0, min: 0 },
    partyId: { type: Id, ref: 'Party', default: null },
    costCenterId: { type: String, default: null },
    projectId: { type: String, default: null },
  }],
  totalPaise: { type: Number, default: 0 },
}, baseOptions));
export const Journal = mongoose.model('Journal', journalSchema);

// A credit note reduces a sales invoice. A debit note reduces a purchase invoice, and
// can send rejected goods back to the supplier.
const adjustmentNoteSchema = uniqueDocNo(new Schema({
  ...docFields,
  status: { type: String, enum: ['DRAFT', 'SUBMITTED', 'CANCELLED'], default: 'DRAFT' },
  kind: { type: String, enum: ['CREDIT', 'DEBIT'], required: true },
  invoiceId: { type: Id, required: true },
  invoiceNo: { type: String, required: true },
  partyId: { type: Id, ref: 'Party', required: true },
  partyName: { type: String, required: true },
  partyGstin: { type: String, default: '' },
  reason: { type: String, required: true },
  currency: { type: String, default: 'INR' },
  fxRate4: { type: Number, default: 10000 },
  lines: [{
    invoiceLineId: { type: Id, required: true },
    itemId: { type: Id, ref: 'Item', default: null },
    itemCode: { type: String, default: '' },
    itemName: { type: String, default: '' },
    hsn: { type: String, default: '' },
    gstRateBps: { type: Number, default: 0 },
    qtyMilli: { type: Number, default: 0 },
    taxableMinor: { type: Number, required: true, min: 1 },
    taxablePaise: { type: Number, default: 0 },
    itcBlocked: { type: Boolean, default: false },
    cgstPaise: { type: Number, default: 0 },
    sgstPaise: { type: Number, default: 0 },
    igstPaise: { type: Number, default: 0 },
    returnGoods: { type: Boolean, default: false },
    warehouseId: { type: Id, ref: 'Warehouse', default: null },
    lot: { type: String, default: '' },
    salesAccountCode: { type: String, default: null },
    stockValuePaise: { type: Number, default: 0 },
  }],
  ...taxTotals,
  isReverseCharge: { type: Boolean, default: false },
  totalMinor: { type: Number, default: 0 },
}, baseOptions));
adjustmentNoteSchema.index({ invoiceId: 1, status: 1 });
export const AdjustmentNote = mongoose.model('AdjustmentNote', adjustmentNoteSchema);

/* ---------- Service ---------- */

const amcContractSchema = uniqueDocNo(new Schema({
  ...docFields,
  status: { type: String, enum: ['DRAFT', 'ACTIVE', 'ENDED', 'CANCELLED'], default: 'DRAFT' },
  buildId: { type: Id, ref: 'MachineBuild', required: true },
  serialNo: { type: String, required: true },
  partyId: { type: Id, ref: 'Party', required: true },
  partyName: { type: String, required: true },
  startDate: { type: String, required: true },
  endDate: { type: String, required: true },
  visitsPerYear: { type: Number, default: 2 },
  valuePaise: { type: Number, default: 0 },
}, baseOptions));
amcContractSchema.index({ buildId: 1, endDate: -1 });
export const AmcContract = mongoose.model('AmcContract', amcContractSchema);

const serviceTicketSchema = uniqueDocNo(new Schema({
  ...docFields,
  status: { type: String, enum: ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CANCELLED'], default: 'OPEN' },
  buildId: { type: Id, ref: 'MachineBuild', required: true },
  serialNo: { type: String, required: true },
  partyName: { type: String, default: '' },
  priority: { type: String, enum: ['LOW', 'NORMAL', 'HIGH', 'LINE_DOWN'], default: 'NORMAL' },
  complaint: { type: String, required: true },
  coverage: { type: String, enum: ['WARRANTY', 'AMC', 'CHARGEABLE'], default: 'CHARGEABLE' },
  assignedTo: { type: String, default: '' },
  resolution: { type: String, default: '' },
  resolvedOn: { type: String, default: null },
}, baseOptions));
serviceTicketSchema.index({ buildId: 1, status: 1 });
export const ServiceTicket = mongoose.model('ServiceTicket', serviceTicketSchema);
