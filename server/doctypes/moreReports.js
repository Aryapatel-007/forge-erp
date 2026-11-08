// Reports that follow from the logic in logic.js, and other questions people ask.
import { defineReport } from '../engine/reports.js';
import { modelOf } from '../engine/registry.js';
import { Bin } from '../models/ledgers.js';
import { Item, Party, Warehouse } from '../models/masters.js';
import { PurchaseOrder, SalesInvoice, SalesOrder } from '../models/documents.js';
import { lineValue, sumInts } from '../utils/money.js';
import { addDays, daysBetween, todayIst } from '../utils/dates.js';
import { rule } from '../utils/errors.js';

const OFFICE = ['ADMIN', 'MANAGEMENT'];
const STOCK = [...OFFICE, 'STORES', 'PURCHASE', 'PRODUCTION', 'ACCOUNTS'];
const SELL = [...OFFICE, 'SALES', 'ACCOUNTS'];
const BUY = [...OFFICE, 'PURCHASE', 'ACCOUNTS'];
const PEOPLE = [...OFFICE, 'HR'];
const FINANCE = [...OFFICE, 'ACCOUNTS'];
const CARE = [...OFFICE, 'SERVICE'];
const DATES = 'from:date to:date';
const within = (from, to, key = 'postingDate') => (from || to ? { [key]: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } } : {});

/* ---------- Stock ---------- */

defineReport({
  key: 'batch-expiry', module: 'stock', title: 'Batches near expiry', roles: STOCK, filters: 'withinDays:int',
  columns: 'batchNo item expiresOn:date daysLeft:sqty:Days_left qtyMilli:qty valuePaise:money', totals: 'valuePaise',
  async run({ withinDays }) {
    const today = todayIst();
    const limit = addDays(today, Number(withinDays) || 90);
    const batches = await modelOf('Batch').find({ expiresOn: { $ne: null, $lte: limit } }).sort({ expiresOn: 1 }).lean();
    const bins = await Bin.find({ lot: { $in: batches.map((b) => b.batchNo) }, qtyMilli: { $gt: 0 } }).lean();
    return batches.map((batch) => {
      const here = bins.filter((b) => b.lot === batch.batchNo && String(b.itemId) === String(batch.itemId));
      return { batchNo: batch.batchNo, item: batch._labels?.itemId, expiresOn: batch.expiresOn, daysLeft: daysBetween(today, batch.expiresOn) * 1000, qtyMilli: sumInts(here.map((b) => b.qtyMilli)), valuePaise: sumInts(here.map((b) => b.valuePaise)) };
    }).filter((row) => row.qtyMilli > 0);
  },
});

defineReport({
  key: 'stock-below-reorder', module: 'stock', title: 'Below reorder level', roles: STOCK, filters: '',
  columns: 'code name reorderLevelMilli:qty onHandMilli:qty onOrderMilli:qty shortMilli:qty leadTimeDays:int',
  async run() {
    const items = await Item.find({ reorderLevelMilli: { $gt: 0 }, isActive: true }, { code: 1, name: 1, reorderLevelMilli: 1, leadTimeDays: 1 }).lean();
    const stores = (await Warehouse.find({ kind: 'STORES' }, { _id: 1 }).lean()).map((w) => w._id);
    const bins = await Bin.find({ itemId: { $in: items.map((i) => i._id) }, warehouseId: { $in: stores }, buildId: null }).lean();
    const orders = await PurchaseOrder.find({ status: 'APPROVED', 'lines.itemId': { $in: items.map((i) => i._id) } }, { lines: 1 }).lean();
    return items.map((item) => {
      const key = String(item._id);
      const onHandMilli = sumInts(bins.filter((b) => String(b.itemId) === key).map((b) => b.qtyMilli));
      const onOrderMilli = sumInts(orders.flatMap((o) => o.lines).filter((l) => String(l.itemId) === key).map((l) => Math.max(0, l.qtyMilli - l.receivedMilli)));
      return { code: item.code, name: item.name, reorderLevelMilli: item.reorderLevelMilli, onHandMilli, onOrderMilli, shortMilli: Math.max(0, item.reorderLevelMilli - onHandMilli - onOrderMilli), leadTimeDays: item.leadTimeDays };
    }).filter((row) => row.onHandMilli < row.reorderLevelMilli);
  },
});

defineReport({
  key: 'putaway-suggestion', module: 'stock', title: 'Where to put goods away', roles: STOCK, filters: 'itemId!:link(Item) qtyMilli:qty',
  columns: 'warehouse priority:int capacityMilli:qty holdingMilli:qty freeMilli:qty putMilli:qty:Put_here',
  async run({ itemId, qtyMilli }) {
    if (!itemId) throw rule('Choose an item.', 'ITEM_REQUIRED');
    const rules = await modelOf('PutawayRule').find({ itemId, isActive: true }).sort({ priority: 1 }).lean();
    const bins = await Bin.find({ itemId, qtyMilli: { $gt: 0 } }).lean();
    let left = Number(qtyMilli) || 0;
    return rules.map((row) => {
      const holdingMilli = sumInts(bins.filter((b) => String(b.warehouseId) === String(row.warehouseId)).map((b) => b.qtyMilli));
      const freeMilli = Math.max(0, row.capacityMilli - holdingMilli);
      const putMilli = Math.min(left, freeMilli);
      left -= putMilli;
      return { warehouse: row._labels?.warehouseId, priority: row.priority, capacityMilli: row.capacityMilli, holdingMilli, freeMilli, putMilli };
    });
  },
});

/* ---------- Selling ---------- */

defineReport({
  key: 'customer-acquisition', module: 'selling', title: 'New and returning customers', roles: SELL, filters: DATES,
  columns: 'month newCustomers:int returningCustomers:int newPaise:money:From_new returningPaise:money:From_returning', totals: 'newPaise returningPaise',
  async run({ from, to }) {
    const invoices = await SalesInvoice.find({ status: 'SUBMITTED', isOpening: { $ne: true } }, { partyId: 1, postingDate: 1, taxablePaise: 1 }).sort({ postingDate: 1 }).lean();
    const firstSeen = new Map();
    const months = new Map();
    for (const invoice of invoices) {
      const key = String(invoice.partyId);
      const month = invoice.postingDate.slice(0, 7);
      if (!firstSeen.has(key)) firstSeen.set(key, month);
      if ((from && invoice.postingDate < from) || (to && invoice.postingDate > to)) continue;
      const row = months.get(month) ?? { month, newSet: new Set(), oldSet: new Set(), newPaise: 0, returningPaise: 0 };
      if (firstSeen.get(key) === month) { row.newSet.add(key); row.newPaise += invoice.taxablePaise; } else { row.oldSet.add(key); row.returningPaise += invoice.taxablePaise; }
      months.set(month, row);
    }
    return [...months.values()].map(({ newSet, oldSet, ...row }) => ({ ...row, newCustomers: newSet.size, returningCustomers: oldSet.size }));
  },
});

defineReport({
  key: 'pending-sales-orders', module: 'selling', title: 'Sales orders not yet invoiced', roles: SELL, filters: 'partyId:link(Party)',
  columns: 'docNo partyName deliveryDate:date daysLate:int subtotalMinor:money:Order_value invoicedPaise:money:Invoiced', totals: 'subtotalMinor invoicedPaise',
  async run({ partyId }) {
    const today = todayIst();
    const orders = await SalesOrder.find({ status: 'CONFIRMED', ...(partyId ? { partyId } : {}) }).sort({ deliveryDate: 1 }).lean();
    const invoices = await SalesInvoice.aggregate([{ $match: { status: 'SUBMITTED', salesOrderId: { $in: orders.map((o) => o._id) } } }, { $group: { _id: '$salesOrderId', total: { $sum: '$taxablePaise' } } }]);
    return orders.map((order) => ({ docNo: order.docNo, partyName: order.partyName, deliveryDate: order.deliveryDate, daysLate: order.deliveryDate ? Math.max(0, daysBetween(order.deliveryDate, today)) : 0, subtotalMinor: order.subtotalMinor, invoicedPaise: invoices.find((i) => String(i._id) === String(order._id))?.total ?? 0 }));
  },
});

defineReport({ key: 'proforma-open', module: 'selling', title: 'Proformas not yet ordered', roles: SELL, source: 'ProformaInvoice', filters: DATES, dateField: 'validUntil', match: { salesOrderId: null }, project: { docNo: 'docNo', party: '_labels.partyId', validUntil: 'validUntil', totalPaise: 'totalPaise' }, columns: 'docNo party validUntil:date totalPaise:money', totals: 'totalPaise' });
defineReport({
  key: 'blanket-order-balance', module: 'selling', title: 'Blanket orders: what is left', roles: SELL, filters: '',
  columns: 'docNo party toDate:date item qtyMilli:qty orderedMilli:qty leftMilli:qty',
  async run() {
    const blankets = await modelOf('BlanketOrder').find().lean();
    const orders = await SalesOrder.find({ blanketOrderId: { $in: blankets.map((b) => String(b._id)) }, status: { $ne: 'CANCELLED' } }, { blanketOrderId: 1, lines: 1 }).lean();
    return blankets.flatMap((blanket) => blanket.lines.map((line) => {
      const orderedMilli = sumInts(orders.filter((o) => o.blanketOrderId === String(blanket._id)).flatMap((o) => o.lines).filter((l) => String(l.itemId) === String(line.itemId)).map((l) => l.qtyMilli));
      return { docNo: blanket.docNo, party: blanket._labels?.partyId, toDate: blanket.toDate, item: line._labels?.itemId, qtyMilli: line.qtyMilli, orderedMilli, leftMilli: line.qtyMilli - orderedMilli };
    }));
  },
});
defineReport({ key: 'contracts-expiring', module: 'crm', title: 'Contracts ending soon', roles: SELL, source: 'Contract', filters: DATES, dateField: 'endDate', match: { status: 'SUBMITTED' }, sort: { endDate: 1 }, project: { docNo: 'docNo', title: 'title', party: '_labels.partyId', endDate: 'endDate', valuePaise: 'valuePaise', signedOn: 'signedOn', isFulfilled: 'isFulfilled' }, columns: 'docNo title party endDate:date valuePaise:money signedOn:date isFulfilled:check:Fulfilled', totals: 'valuePaise' });
defineReport({ key: 'campaign-summary', module: 'crm', title: 'Email campaigns', roles: SELL, source: 'EmailCampaign', filters: '', project: { name: 'name', campaign: '_labels.campaignId', status: 'status', sentCount: 'sentCount' }, columns: 'name campaign status sentCount:int' });

/* ---------- Buying ---------- */

defineReport({
  key: 'pending-purchase-orders', module: 'buying', title: 'What has not arrived yet', roles: BUY, filters: 'partyId:link(Party)',
  columns: 'docNo partyName expectedDate:date daysLate:int itemName orderedMilli:qty receivedMilli:qty leftMilli:qty valuePaise:money', totals: 'valuePaise',
  async run({ partyId }) {
    const today = todayIst();
    const orders = await PurchaseOrder.find({ status: 'APPROVED', ...(partyId ? { partyId } : {}) }).sort({ expectedDate: 1 }).lean();
    return orders.flatMap((order) => order.lines.filter((l) => l.qtyMilli > l.receivedMilli).map((l) => ({ docNo: order.docNo, partyName: order.partyName, expectedDate: order.expectedDate, daysLate: order.expectedDate ? Math.max(0, daysBetween(order.expectedDate, today)) : 0, itemName: l.itemName, orderedMilli: l.qtyMilli, receivedMilli: l.receivedMilli, leftMilli: l.qtyMilli - l.receivedMilli, valuePaise: lineValue(l.qtyMilli - l.receivedMilli, l.ratePaise) })));
  },
});

defineReport({ key: 'supplier-scores', module: 'buying', title: 'Supplier scores', roles: BUY, source: 'SupplierScorecardPeriod', filters: 'partyId:link(Party)', sort: { toDate: -1 }, project: { supplier: '_labels.partyId', fromDate: 'fromDate', toDate: 'toDate', receipts: 'receiptsChecked', onTimeBps: 'onTimeBps', acceptedBps: 'acceptedBps', scoreBps: 'scoreBps', standing: 'standing' }, columns: 'supplier fromDate:date toDate:date receipts:int onTimeBps:pct:On_time acceptedBps:pct:Accepted scoreBps:pct:Score standing' });
defineReport({ key: 'rfq-replies', module: 'buying', title: 'RFQs and who has replied', roles: BUY, source: 'RequestForQuotation', filters: '', match: { status: 'SUBMITTED' }, unwind: 'suppliers', project: { docNo: 'docNo', replyBy: 'replyBy', supplier: 'suppliers._labels.partyId', hasReplied: 'suppliers.hasReplied' }, columns: 'docNo replyBy:date supplier hasReplied:check:Replied' });

/* ---------- Accounts ---------- */

defineReport({ key: 'bank-guarantees', module: 'accounts', title: 'Bank guarantees', roles: FINANCE, source: 'BankGuarantee', filters: DATES, dateField: 'endDate', sort: { endDate: 1 }, project: { guaranteeNo: 'guaranteeNo', kind: 'kind', party: '_labels.partyId', bank: '_labels.bankId', endDate: 'endDate', status: 'status', amountPaise: 'amountPaise' }, columns: 'guaranteeNo kind party bank endDate:date status amountPaise:money', totals: 'amountPaise' });

defineReport({
  key: 'share-ledger', module: 'accounts', title: 'Who holds the shares', roles: FINANCE, filters: 'onDate:date',
  columns: 'shareholder shareType held:int',
  async run({ onDate }) {
    const moves = await modelOf('ShareTransfer').find(onDate ? { onDate: { $lte: onDate } } : {}).lean();
    const holdings = new Map();
    const add = (id, label, typeLabel, count) => {
      if (!id) return;
      const key = `${id}|${typeLabel}`;
      const row = holdings.get(key) ?? { shareholder: label, shareType: typeLabel, held: 0 };
      row.held += count;
      holdings.set(key, row);
    };
    for (const move of moves) {
      add(move.toId, move._labels?.toId, move._labels?.shareTypeId, move.count);
      add(move.fromId, move._labels?.fromId, move._labels?.shareTypeId, -move.count);
    }
    return [...holdings.values()].filter((row) => row.held !== 0).sort((a, b) => String(a.shareholder).localeCompare(String(b.shareholder)));
  },
});

/* ---------- People ---------- */

defineReport({
  key: 'employee-anniversaries', module: 'hr', title: 'Birthdays and work anniversaries this month', roles: PEOPLE, filters: '',
  columns: 'fullName kind onDay',
  async run() {
    const month = todayIst().slice(5, 7);
    const people = await modelOf('Employee').find({ state: 'ACTIVE' }, { fullName: 1, birthDate: 1, joiningDate: 1 }).lean();
    const rows = [];
    for (const person of people) {
      if (person.birthDate?.slice(5, 7) === month) rows.push({ fullName: person.fullName, kind: 'Birthday', onDay: person.birthDate.slice(5) });
      if (person.joiningDate?.slice(5, 7) === month) rows.push({ fullName: person.fullName, kind: 'Work anniversary', onDay: person.joiningDate.slice(5) });
    }
    return rows.sort((a, b) => a.onDay.localeCompare(b.onDay));
  },
});

defineReport({
  key: 'recruitment-pipeline', module: 'hr', title: 'Recruitment by opening', roles: PEOPLE, source: 'JobApplicant', filters: '', groupBy: { opening: '_labels.jobOpeningId', state: 'state' }, sums: { applicants: 1 }, sort: { opening: 1 },
  columns: 'opening state applicants:int', totals: 'applicants',
});

defineReport({ key: 'interview-results', module: 'hr', title: 'Interviews', roles: PEOPLE, source: 'Interview', filters: DATES, dateField: 'onDate', sort: { onDate: -1 }, project: { applicant: '_labels.applicantId', kind: '_labels.typeId', onDate: 'onDate', state: 'state' }, columns: 'applicant kind onDate:date state' });
defineReport({ key: 'goal-progress', module: 'hr', title: 'Goals', roles: PEOPLE, source: 'Goal', filters: '', sort: { dueOn: 1 }, project: { title: 'title', employee: '_labels.employeeId', dueOn: 'dueOn', progressBps: 'progressBps', state: 'state' }, columns: 'title employee dueOn:date progressBps:pct:Progress state' });
defineReport({ key: 'training-results', module: 'hr', title: 'Training results', roles: PEOPLE, source: 'TrainingResult', filters: '', unwind: 'rows', project: { event: '_labels.eventId', employee: 'rows._labels.employeeId', marksBps: 'rows.marksBps', grade: 'rows.grade' }, columns: 'event employee marksBps:pct:Marks grade' });
defineReport({ key: 'vehicle-running', module: 'hr', title: 'Vehicle running and fuel', roles: [...PEOPLE, 'ACCOUNTS'], source: 'VehicleLog', filters: DATES, dateField: 'onDate', groupBy: { vehicle: '_labels.vehicleId' }, sums: { trips: 1, distance: 'distance', fuelPaise: 'fuelPaise' }, columns: 'vehicle trips:int distance:int:Distance fuelPaise:money', totals: 'fuelPaise' });
defineReport({ key: 'salary-held', module: 'payroll', title: 'Salary being held', roles: [...PEOPLE, 'ACCOUNTS'], source: 'SalaryWithholding', filters: '', match: { status: 'SUBMITTED', isReleased: { $ne: true } }, project: { employee: '_labels.employeeId', fromDate: 'fromDate', toDate: 'toDate', reason: 'reason' }, columns: 'employee fromDate:date toDate:date reason' });

/* ---------- Service, quality, assets ---------- */

defineReport({ key: 'warranty-claims', module: 'support', title: 'Warranty claims', roles: CARE, source: 'WarrantyClaim', filters: DATES, dateField: 'onDate', sort: { onDate: -1 }, project: { docNo: 'docNo', party: '_labels.partyId', build: '_labels.buildId', onDate: 'onDate', status: 'status', underWarranty: 'underWarranty' }, columns: 'docNo party build onDate:date status underWarranty:check:In_warranty' });
defineReport({ key: 'in-process-failures', module: 'quality', title: 'Failed in-process inspections', roles: [...OFFICE, 'QUALITY', 'PRODUCTION'], source: 'InProcessInspection', filters: DATES, dateField: 'onDate', match: { status: 'FAIL' }, sort: { onDate: -1 }, project: { docNo: 'docNo', build: '_labels.buildId', workOrder: '_labels.workOrderId', item: '_labels.itemId', onDate: 'onDate', ncr: '_labels.ncrId' }, columns: 'docNo build workOrder item onDate:date ncr:text:NCR' });
defineReport({ key: 'customer-feedback', module: 'quality', title: 'Customer feedback', roles: [...OFFICE, 'QUALITY', 'SERVICE'], source: 'QualityFeedback', filters: DATES, dateField: 'onDate', sort: { onDate: -1 }, project: { party: '_labels.partyId', build: '_labels.buildId', onDate: 'onDate', averageRatingMilli: 'averageRatingMilli' }, columns: 'party build onDate:date averageRatingMilli:qty:Average_rating' });

