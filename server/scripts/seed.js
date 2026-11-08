// Fills a development database with a fictional machine builder, by driving the real
// services, so seed data obeys every rule real use does. It refuses a production
// database, and it wipes only the database it was pointed at when --fresh is given.
import mongoose from 'mongoose';
import { env, isProd } from '../config/env.js';
import { User, Settings } from '../models/core.js';
import { Account, Item, Party, Warehouse } from '../models/masters.js';
import { Bom, Gauge, MachineBuild, PurchaseOrder, Grn, SalesOrder, SalesInvoice, Quotation } from '../models/documents.js';
import { hashPassword } from '../services/authService.js';
import { ensureDefaults } from '../services/settingsService.js';
import { withTxn } from '../utils/txn.js';
import { todayIst, addDays } from '../utils/dates.js';
import { audit } from '../services/auditService.js';
import { createDoc } from '../engine/documents.js';
import * as sales from '../services/salesService.js';
import * as builds from '../services/buildService.js';
import * as purchase from '../services/purchaseService.js';
import * as stores from '../services/storesService.js';
import * as quality from '../services/qualityService.js';
import * as accounts from '../services/accountsService.js';
import '../models/index.js';
import '../doctypes/index.js';

if (isProd) throw new Error('The demo seed never runs in production.');
if (!/forge-erp(-dev)?$/.test(new URL(env.MONGO_URI.replace('mongodb://', 'http://')).pathname.slice(1))) {
  throw new Error('The demo seed only runs against a database named forge-erp.');
}

const PASSWORD = process.env.SEED_PASSWORD ?? 'forge-demo-1234';
const today = todayIst();

mongoose.set('strictQuery', 'throw');
await mongoose.connect(env.MONGO_URI);
if (process.argv.includes('--fresh')) await mongoose.connection.dropDatabase();
await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
await ensureDefaults();
if (await User.countDocuments()) {
  console.log('This database already has users. Run with --fresh to rebuild it.');
  await mongoose.disconnect();
  process.exit(0);
}

await Settings.updateOne({ _id: 'company' }, {
  legalName: 'Demo Pharma Machines Pvt. Ltd.',
  gstin: '24AAACD1234E1ZF',
  pan: 'AAACD1234E',
  stateCode: '24',
  address: 'Plot 12, Demo Industrial Estate, Ahmedabad, Gujarat 382213',
  email: 'accounts@demo-machines.example',
  phone: '+91 79 0000 0000',
  bankDetails: 'Demo Bank, A/c 000000000000, IFSC DEMO0000001',
  lutNumber: 'AD240000000001X',
});

const hash = await hashPassword(PASSWORD);
const staff = [
  ['Asha Admin', 'admin@forge.test', 'ADMIN'], ['Mohan Management', 'md@forge.test', 'MANAGEMENT'], ['Sara Sales', 'sales@forge.test', 'SALES'],
  ['Esha Engineering', 'design@forge.test', 'ENGINEERING'], ['Pavan Purchase', 'purchase@forge.test', 'PURCHASE'], ['Sonu Stores', 'stores@forge.test', 'STORES'],
  ['Prem Production', 'production@forge.test', 'PRODUCTION'], ['Qasim Quality', 'quality@forge.test', 'QUALITY'], ['Anita Accounts', 'accounts@forge.test', 'ACCOUNTS'], ['Sunil Service', 'service@forge.test', 'SERVICE'], ['Hina HR', 'hr@forge.test', 'HR'],
];
const users = {};
for (const [name, email, role] of staff) users[role] = await User.create({ name, email, role, passwordHash: hash });
const actor = (role) => ({ id: users[role]._id, name: users[role].name, role });

await Warehouse.insertMany([
  { code: 'STORES', name: 'Main stores', kind: 'STORES' },
  { code: 'QC-HOLD', name: 'Quality hold', kind: 'QUARANTINE' },
  { code: 'REJECT', name: 'Rejected goods', kind: 'REJECT' },
  { code: 'JOBWORK', name: 'At job workers', kind: 'JOBWORK' },
  { code: 'FG', name: 'Finished machines', kind: 'FG' },
]);
const wh = Object.fromEntries((await Warehouse.find().lean()).map((w) => [w.code, w._id]));

const parties = await Party.insertMany([
  { code: 'C-MEDI', name: 'Medilife Injectables Ltd.', isCustomer: true, gstin: '27AAPFU0939F1ZV', stateCode: '27', address: 'Baddi Road, Mumbai', contactName: 'R. Nair', paymentTermsDays: 30 },
  { code: 'C-SUN', name: 'Sunrise Parenterals Pvt. Ltd.', isCustomer: true, gstin: '', stateCode: '24', address: 'Vatva GIDC, Ahmedabad', paymentTermsDays: 30 },
  { code: 'C-NILE', name: 'Nile Pharma Industries', isCustomer: true, country: 'Egypt', isExport: true, currency: 'USD', address: 'Cairo, Egypt', paymentTermsDays: 0 },
  { code: 'S-STEEL', name: 'Gujarat Stainless Traders', isSupplier: true, stateCode: '24', gstin: '', paymentTermsDays: 45 },
  { code: 'S-AUTO', name: 'Precision Automation Supplies', isSupplier: true, stateCode: '27', gstin: '', paymentTermsDays: 30 },
  { code: 'J-LASER', name: 'Ahmedabad Laser Cutting Works', isSupplier: true, isJobWorker: true, stateCode: '24', paymentTermsDays: 30 },
]);
const party = Object.fromEntries(parties.map((p) => [p.code, p]));

const itemRows = [
  { code: 'SS316-2MM', name: 'SS 316L sheet 2 mm', type: 'RAW', uom: 'KG', hsn: '72193300', gstRateBps: 1800, materialGrade: 'SS 316L', trackLot: true, requiresInspection: true, standardCostPaise: 42000, reorderLevelMilli: 200000 },
  { code: 'FRAME-CUT', name: 'Machine frame, laser cut', type: 'FABRICATED', uom: 'NOS', hsn: '84229090', gstRateBps: 1800, drawingNo: 'VF-100-01', drawingRev: 'B', trackLot: true, standardCostPaise: 1800000 },
  { code: 'PLC-S7', name: 'PLC controller with HMI', type: 'BOUGHT_OUT', uom: 'NOS', hsn: '85371000', gstRateBps: 1800, requiresInspection: true, standardCostPaise: 18500000 },
  { code: 'SERVO-1K', name: 'Servo motor 1 kW with drive', type: 'BOUGHT_OUT', uom: 'NOS', hsn: '85015290', gstRateBps: 1800, standardCostPaise: 6500000 },
  { code: 'PUMP-PIS', name: 'Piston filling pump, SS 316L', type: 'BOUGHT_OUT', uom: 'NOS', hsn: '84135090', gstRateBps: 1800, requiresInspection: true, standardCostPaise: 4200000 },
  { code: 'SILICONE-T', name: 'Silicone tube, pharma grade', type: 'CONSUMABLE', uom: 'MTR', hsn: '39173990', gstRateBps: 1800, standardCostPaise: 45000 },
  { code: 'ASM-FILL', name: 'Filling head assembly', type: 'ASSEMBLY', uom: 'NOS', hsn: '84229090', gstRateBps: 1800 },
  { code: 'VFM-100', name: 'Vial filling machine, 100 vials per minute', type: 'MACHINE', uom: 'NOS', hsn: '84223000', gstRateBps: 1800, salePricePaise: 250000000, leadTimeDays: 120 },
  { code: 'WASH-INST', name: 'Installation and commissioning', type: 'SERVICE', uom: 'NOS', hsn: '998719', gstRateBps: 1800 },
  { code: 'SP-NOZZLE', name: 'Spare filling nozzle', type: 'SPARE', uom: 'NOS', hsn: '84229090', gstRateBps: 1800, salePricePaise: 850000, standardCostPaise: 300000, reorderLevelMilli: 5000 },
];
const items = Object.fromEntries((await Item.insertMany(itemRows)).map((i) => [i.code, i]));

await Gauge.insertMany([
  { code: 'G-BAL-01', name: 'Precision balance', lastCalibratedOn: addDays(today, -60), dueOn: addDays(today, 300), certRef: 'CAL/2026/118' },
  { code: 'G-TACH-02', name: 'Digital tachometer', lastCalibratedOn: addDays(today, -30), dueOn: addDays(today, 330), certRef: 'CAL/2026/144' },
  { code: 'G-OLD-03', name: 'Pressure gauge (retired)', lastCalibratedOn: addDays(today, -400), dueOn: addDays(today, -35), certRef: 'CAL/2025/020' },
]);
const gauges = await Gauge.find({ code: /^G-(BAL|TACH)/ }).lean();

const submit = async (service, data, role, extra = {}) => withTxn(async (session) => {
  const prepared = await service.prepare(session, { postingDate: today, ...data });
  const [doc] = await service.Model.create([{ ...prepared, createdBy: users[role]._id }], { session });
  doc.submittedBy = users[role]._id;
  doc.submittedAt = new Date();
  const result = await service.submit(session, doc, { actor: actor(role), body: extra });
  await doc.save({ session });
  await audit(session, { actor: actor(role), action: result.action, entityType: service.Model.modelName, entityId: doc._id, entityNo: doc.docNo, reason: result.reason, data: result.data });
  return doc;
});

// Opening stock, posted to the opening balances account.
await submit(stores.stockMoveDoc, {
  kind: 'OPENING',
  reason: 'Opening stock',
  lines: [
    { itemId: items['SILICONE-T']._id, qtyMilli: 100000, toWarehouseId: wh.STORES, ratePaise: 45000 },
    { itemId: items['SERVO-1K']._id, qtyMilli: 6000, toWarehouseId: wh.STORES, ratePaise: 6500000 },
    { itemId: items['SP-NOZZLE']._id, qtyMilli: 20000, toWarehouseId: wh.STORES, ratePaise: 300000 },
  ],
}, 'STORES');

// Engineering: a filling head assembly inside the machine's BOM.
const release = (data) => withTxn(async (session) => {
  const bom = await builds.createBomRevision(session, data, actor('ENGINEERING'));
  return builds.releaseBom(session, bom._id, actor('ENGINEERING'));
});
await release({ itemId: items['ASM-FILL']._id, lines: [{ itemId: items['PUMP-PIS']._id, qtyMilli: 4000 }, { itemId: items['SILICONE-T']._id, qtyMilli: 20000, scrapBps: 500 }] });
await release({
  itemId: items['VFM-100']._id,
  labourHoursMilli: 320000,
  lines: [
    { itemId: items['FRAME-CUT']._id, qtyMilli: 1000 },
    { itemId: items['PLC-S7']._id, qtyMilli: 1000 },
    { itemId: items['SERVO-1K']._id, qtyMilli: 2000 },
    { itemId: items['ASM-FILL']._id, qtyMilli: 1000 },
  ],
  fatChecklist: [
    { parameter: 'Output speed', acceptance: '95 to 105 vials per minute', minMilli: 95000, maxMilli: 105000, unit: 'vpm' },
    { parameter: 'Fill accuracy', acceptance: 'Within 1% of target', minMilli: -1000, maxMilli: 1000, unit: '%' },
    { parameter: 'No vial, no fill interlock', acceptance: 'Machine stops', isCritical: true },
    { parameter: 'Audit trail on HMI', acceptance: 'Records user, time and change', isCritical: true },
    { parameter: 'Surface finish', acceptance: 'Ra below 0.8 micron', minMilli: 0, maxMilli: 800, unit: 'micron', isCritical: false },
  ],
});

// A quotation that became an order, which opened two builds.
const quote = await submit(sales.quotation, { partyId: party['C-MEDI']._id, validUntil: addDays(today, 30), terms: 'Delivery 16 weeks from advance. Ex-works Ahmedabad.', lines: [{ itemId: items['VFM-100']._id, qtyMilli: 2000, rateMinor: 250000000, discountBps: 200 }] }, 'SALES');
const draftOrder = await withTxn((s) => sales.quotationToOrder(s, quote._id, actor('SALES')));
const order = await withTxn(async (session) => {
  const doc = await SalesOrder.findById(draftOrder._id).session(session);
  doc.customerPoNo = 'MIL/PO/7781';
  doc.deliveryDate = addDays(today, -3);
  const result = await sales.salesOrder.submit(session, doc, { actor: actor('SALES') });
  await doc.save({ session });
  await audit(session, { actor: actor('SALES'), action: result.action, entityType: 'SalesOrder', entityId: doc._id, entityNo: doc.docNo, data: result.data });
  return doc;
});
const [first, second] = await MachineBuild.find({ salesOrderId: order._id }).sort({ serialNo: 1 });

// The 30% advance.
await submit(accounts.payment, { kind: 'RECEIPT', partyId: party['C-MEDI']._id, bankAccountCode: '1120', amountMinor: order.milestones[0].amountMinor, reference: 'NEFT 88213', salesOrderId: order._id, milestoneNo: 1 }, 'ACCOUNTS');

// Purchase for the first build. Steel and control parts need inspection.
const steelPo = await submit(purchase.purchaseOrder, { partyId: party['S-STEEL']._id, expectedDate: today, lines: [{ itemId: items['SS316-2MM']._id, qtyMilli: 250000, ratePaise: 42000, buildId: first._id }] }, 'PURCHASE');
const autoPo = await submit(purchase.purchaseOrder, { partyId: party['S-AUTO']._id, expectedDate: today, lines: [
  { itemId: items['PLC-S7']._id, qtyMilli: 2000, ratePaise: 18000000 },
  { itemId: items['PUMP-PIS']._id, qtyMilli: 4000, ratePaise: 4200000, buildId: first._id },
] }, 'PURCHASE');
await submit(purchase.purchaseOrder, { partyId: party['S-AUTO']._id, lines: [{ itemId: items['PLC-S7']._id, qtyMilli: 3000, ratePaise: 18500000 }] }, 'PURCHASE');
await withTxn(async (session) => {
  const po = await PurchaseOrder.findById(autoPo._id).session(session);
  if (po.status === 'PENDING_APPROVAL') await purchase.approvePurchaseOrder(session, po._id, actor('MANAGEMENT'));
});
const steelFresh = await PurchaseOrder.findById(steelPo._id);
if (steelFresh.status === 'PENDING_APPROVAL') await withTxn((s) => purchase.approvePurchaseOrder(s, steelPo._id, actor('MANAGEMENT')));

const steelLine = (await PurchaseOrder.findById(steelPo._id)).lines[0];
const steelGrn = await submit(purchase.grn, { purchaseOrderId: steelPo._id, supplierChallanNo: 'GST/4471', lines: [{ poLineId: steelLine._id, qtyMilli: 250000, lot: 'HEAT-A7721', certRef: 'MTC-A7721' }] }, 'STORES');
const autoFresh = await PurchaseOrder.findById(autoPo._id);
const autoGrn = await submit(purchase.grn, { purchaseOrderId: autoPo._id, supplierChallanNo: 'PAS/991', lines: autoFresh.lines.map((l) => ({ poLineId: l._id, qtyMilli: l.qtyMilli })) }, 'STORES');

// Incoming inspection: one reject raises an NCR by itself.
await submit(purchase.inspection, { grnId: steelGrn._id, inspectorName: 'Qasim Quality', lines: [{ grnLineId: steelGrn.lines[0]._id, acceptedMilli: 245000, rejectedMilli: 5000, certVerified: true, observations: 'One sheet scratched' }] }, 'QUALITY');
await submit(purchase.inspection, { grnId: autoGrn._id, inspectorName: 'Qasim Quality', lines: autoGrn.lines.map((l) => ({ grnLineId: l._id, acceptedMilli: l.qtyMilli, rejectedMilli: 0, certVerified: true })) }, 'QUALITY');

// The supplier's invoice, at a slightly higher rate, so a variance shows in the books.
await submit(purchase.purchaseInvoice, { partyId: party['S-STEEL']._id, supplierInvoiceNo: 'GST/INV/2201', supplierInvoiceDate: today, lines: [{ kind: 'GOODS', grnId: steelGrn._id, grnLineId: steelGrn.lines[0]._id, qtyMilli: 250000, ratePaise: 42500 }] }, 'ACCOUNTS');

// Job work: steel goes out for laser cutting, frames come back.
const challan = await submit(stores.jobWorkChallan, { partyId: party['J-LASER']._id, process: 'Laser cutting and bending', buildId: first._id, lines: [{ itemId: items['SS316-2MM']._id, qtyMilli: 180000, fromWarehouseId: wh.STORES, lot: 'HEAT-A7721' }] }, 'STORES');
await withTxn((s) => stores.receiveJobWork(s, challan._id, { postingDate: today, lineId: challan.lines[0]._id, consumedMilli: 180000, outputItemId: items['FRAME-CUT']._id, outputMilli: 1000, supplierChallanNo: 'ALC/212' }, actor('STORES')));
await submit(purchase.purchaseInvoice, { partyId: party['J-LASER']._id, supplierInvoiceNo: 'ALC/INV/88', supplierInvoiceDate: today, lines: [{ kind: 'SERVICE', description: 'Laser cutting of frame', hsn: '998898', buildId: first._id, qtyMilli: 1000, ratePaise: 3500000, gstRateBps: 1800 }] }, 'ACCOUNTS');

// Build one: fully issued, labour booked, FAT passed, finished. It stops at READY,
// because the balance before dispatch is not yet in.
const issueLines = (await MachineBuild.findById(first._id)).materials.map((m) => ({ itemId: m.itemId, qtyMilli: m.requiredMilli }));
await submit(builds.materialIssue, { buildId: first._id, lines: issueLines }, 'STORES');
await submit(builds.timeBooking, { buildId: first._id, operation: 'Assembly', employeeName: 'Fitter team A', hoursMilli: 240000 }, 'PRODUCTION');
await submit(builds.timeBooking, { buildId: first._id, operation: 'Wiring and testing', employeeName: 'Electrical team', hoursMilli: 80000 }, 'PRODUCTION');
await withTxn((s) => builds.setStage(s, first._id, { stage: 'ASSEMBLY', note: 'All material in' }, actor('PRODUCTION')));

const protocol = await withTxn((s) => quality.startFat(s, first._id, { postingDate: today, witnessName: 'R. Nair', witnessCompany: 'Medilife Injectables Ltd.', testedByName: 'Qasim Quality' }, actor('QUALITY')));
await withTxn((s) => quality.saveFatResults(s, protocol._id, {
  gaugeIds: gauges.map((g) => String(g._id)),
  results: protocol.results.map((r) => ({
    id: String(r._id),
    result: 'PASS',
    observedMilli: r.minMilli !== null ? Math.round((r.minMilli + r.maxMilli) / 2) : null,
    observedText: r.minMilli === null ? 'Confirmed' : '',
  })),
}));
await withTxn((s) => quality.closeFat(s, protocol._id, actor('QUALITY')));
await withTxn((s) => builds.completeBuild(s, first._id, { postingDate: today }, actor('PRODUCTION')));

// Build two is still waiting for parts.
await withTxn((s) => builds.setStage(s, second._id, { stage: 'PROCUREMENT', note: 'Long-lead parts on order' }, actor('PRODUCTION')));

// A spare parts sale, so receivables are not empty.
await submit(accounts.salesInvoice, { partyId: party['C-SUN']._id, vehicleNo: 'GJ01AB1234', lines: [{ kind: 'GOODS', itemId: items['SP-NOZZLE']._id, qtyMilli: 4000, rateMinor: 850000 }] }, 'ACCOUNTS');

// An open export quotation in dollars.
await submit(sales.quotation, { partyId: party['C-NILE']._id, currency: 'USD', fxRate4: 840000, validUntil: addDays(today, 45), terms: 'FOB Mundra. Letter of credit at sight.', lines: [{ itemId: items['VFM-100']._id, qtyMilli: 1000, rateMinor: 3200000 }] }, 'SALES');

// A little in every other module, so no screen opens empty.
const sample = (name, data, role = 'ADMIN') => withTxn((session) => createDoc(session, name, data, actor(role)));
const year = today.slice(0, 4);
await sample('FiscalYear', { name: `FY ${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` });
await sample('ItemGroup', { name: 'Machines' });
await sample('Brand', { name: 'Demo Machines' });
await sample('Territory', { name: 'Gujarat' }, 'SALES');
const source = await sample('LeadSource', { name: 'PMEC exhibition' }, 'SALES');
const stage = await sample('SalesStage', { name: 'Proposal', probabilityBps: 5000, order: 2 }, 'SALES');
const lead = await sample('Lead', { leadName: 'Priya Shah', companyName: 'Zenith Sterile Pvt. Ltd.', mobile: '9800000000', city: 'Hyderabad', sourceId: String(source._id), requirement: 'A vial washer and tunnel, 120 per minute', nextContactOn: addDays(today, 2) }, 'SALES');
await sample('Opportunity', { title: 'Zenith washing line', leadId: String(lead._id), stageId: String(stage._id), amountPaise: 750000000, probabilityBps: 5000, expectedCloseOn: addDays(today, 60) }, 'SALES');
await sample('PriceList', { name: 'Standard selling' }, 'SALES');
const center = await sample('CostCenter', { name: 'Plant' }, 'ACCOUNTS');
await sample('ModeOfPayment', { name: 'Bank transfer', kind: 'BANK', accountCode: '1120' }, 'ACCOUNTS');
const assetCategory = await sample('AssetCategory', { name: 'Plant and machinery', method: 'WRITTEN_DOWN', lifeMonths: 120, wdvRateBps: 1500 }, 'ACCOUNTS');
await sample('Asset', { assetName: 'Laser marking machine', categoryId: String(assetCategory._id), costCenterId: String(center._id), purchasedOn: today, grossPaise: 180000000, salvagePaise: 9000000, depreciationStartOn: today }, 'ACCOUNTS');
await sample('Workstation', { name: 'Assembly bay 1', hourRatePaise: 60000 }, 'PRODUCTION');
await sample('Project', { name: 'Installation at Medilife', partyId: String(party['C-MEDI']._id), buildId: String(first._id), startDate: today, endDate: addDays(today, 30) }, 'PRODUCTION');
const priority = await sample('IssuePriority', { name: 'High', order: 1 }, 'SERVICE');
await sample('ServiceLevelAgreement', { name: 'Standard', isDefault: true, priorities: [{ priorityId: String(priority._id), responseHours: 4, resolutionHours: 48 }] }, 'SERVICE');
await sample('Issue', { subject: 'Nozzle alignment query', partyId: String(party['C-MEDI']._id), priorityId: String(priority._id) }, 'SERVICE');
const department = await sample('Department', { name: 'Assembly' }, 'HR');
const designation = await sample('Designation', { name: 'Fitter' }, 'HR');
const holidays = await sample('HolidayList', { name: `Holidays ${year}`, fromDate: `${year}-01-01`, toDate: `${year}-12-31` }, 'HR');
const worker = await sample('Employee', { fullName: 'Ramesh Fitter', departmentId: String(department._id), designationId: String(designation._id), joiningDate: '2024-04-01', holidayListId: String(holidays._id) }, 'HR');
const leaveType = await sample('LeaveType', { name: 'Casual leave' }, 'HR');
await sample('LeavePeriod', { name: `Leave ${year}`, fromDate: `${year}-01-01`, toDate: `${year}-12-31` }, 'HR');
await sample('PayrollStatutory', { name: 'Current rates, check with your CA', professionalTax: [{ fromGrossPaise: 1200000, toGrossPaise: 0, amountPaise: 20000 }] }, 'HR');
await sample('SalaryStructure', { name: 'Staff' }, 'HR');
await sample('JobOpening', { title: 'Service engineer', vacancies: 2 }, 'HR');
if (worker && leaveType) console.log('Sample records added in every module.');

const counts = { accounts: await Account.countDocuments(), items: await Item.countDocuments(), boms: await Bom.countDocuments(), builds: await MachineBuild.countDocuments(), orders: await SalesOrder.countDocuments(), quotes: await Quotation.countDocuments(), grns: await Grn.countDocuments(), invoices: await SalesInvoice.countDocuments() };
console.log('Seeded:', counts);
console.log(`Sign in as admin@forge.test (or md@, sales@, design@, purchase@, stores@, production@, quality@, accounts@, service@, hr@forge.test). Password: ${PASSWORD}`);
await mongoose.disconnect();
