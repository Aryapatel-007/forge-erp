// What a person should look at first. Each tile is declared once, with who may see it, so the
// home page and each area's overview draw from the same counts. Counts obey per-record limits.
import mongoose from 'mongoose';
import { accessFor, isLimited, scopeFilter, scopeFilterForModel } from '../engine/access.js';
import { getType } from '../engine/registry.js';
import { PERMISSIONS } from '../config/permissions.js';
import { Notification, Todo } from '../models/platform.js';
import { dashboard } from './reportService.js';
import { addDays, todayIst } from '../utils/dates.js';

const OPEN_BUILD = ['PLANNED', 'PROCUREMENT', 'FABRICATION', 'ASSEMBLY', 'FAT', 'READY'];
const unpaid = { $expr: { $gt: ['$totalPaise', { $add: [{ $ifNull: ['$paidPaise', 0] }, { $ifNull: ['$creditedPaise', 0] }] }] } };

// kind: attention is work waiting on someone. metric is how things stand.
const TILES = [
  { key: 'inbox', app: 'service', kind: 'attention', tone: 'warn', label: 'Emails waiting', to: '/InboundEmail?state=NEW', doctype: 'InboundEmail', filter: () => ({ state: 'NEW' }) },
  { key: 'leads-due', app: 'sales', kind: 'attention', tone: 'warn', label: 'Leads to follow up', to: '/Lead', doctype: 'Lead', filter: (t) => ({ nextContactOn: { $ne: null, $lte: t }, status: { $nin: ['CONVERTED', 'LOST', 'DO_NOT_CONTACT'] } }) },
  { key: 'orders-late', app: 'sales', kind: 'attention', tone: 'danger', label: 'Orders past delivery date', to: '/rep/pending-sales-orders', model: 'SalesOrder', perm: 'salesOrders.read', filter: (t) => ({ status: 'CONFIRMED', deliveryDate: { $ne: null, $lt: t } }) },
  { key: 'quotes-out', app: 'sales', kind: 'metric', label: 'Quotations out', to: '/quotations?status=SENT', model: 'Quotation', perm: 'quotations.read', filter: () => ({ status: 'SENT' }) },
  { key: 'orders-live', app: 'sales', kind: 'metric', label: 'Live orders', to: '/salesOrders?status=CONFIRMED', model: 'SalesOrder', perm: 'salesOrders.read', filter: () => ({ status: 'CONFIRMED' }) },
  { key: 'leads-new', app: 'sales', kind: 'metric', label: 'New leads', to: '/Lead?status=NEW', doctype: 'Lead', filter: () => ({ status: 'NEW' }) },

  { key: 'boms-draft', app: 'engineering', kind: 'attention', tone: 'info', label: 'BOMs not yet released', to: '/boms?status=DRAFT', model: 'Bom', perm: 'boms.read', filter: () => ({ status: 'DRAFT' }) },
  { key: 'items-active', app: 'engineering', kind: 'metric', label: 'Active items', to: '/items', model: 'Item', perm: 'items.read', filter: () => ({ isActive: true }) },

  { key: 'builds-late', app: 'manufacturing', kind: 'attention', tone: 'danger', label: 'Machines past their date', to: '/rep/late-builds', model: 'MachineBuild', perm: 'builds.read', filter: (t) => ({ stage: { $in: OPEN_BUILD }, targetDate: { $ne: null, $lt: t } }) },
  { key: 'wo-late', app: 'manufacturing', kind: 'attention', tone: 'danger', label: 'Work orders running late', to: '/rep/work-order-delays', doctype: 'WorkOrder', filter: (t) => ({ status: 'SUBMITTED', state: { $in: ['NOT_STARTED', 'IN_PROCESS'] }, plannedEnd: { $ne: null, $lt: t } }) },
  { key: 'builds-open', app: 'manufacturing', kind: 'metric', label: 'Machines in progress', to: '/builds', model: 'MachineBuild', perm: 'builds.read', filter: () => ({ stage: { $in: OPEN_BUILD } }) },
  { key: 'wo-open', app: 'manufacturing', kind: 'metric', label: 'Open work orders', to: '/WorkOrder?status=SUBMITTED', doctype: 'WorkOrder', filter: () => ({ status: 'SUBMITTED', state: { $in: ['NOT_STARTED', 'IN_PROCESS'] } }) },

  { key: 'po-approval', app: 'purchasing', kind: 'attention', tone: 'warn', label: 'POs waiting for approval', to: '/purchaseOrders?status=PENDING_APPROVAL', model: 'PurchaseOrder', perm: 'purchaseOrders.approve', filter: () => ({ status: 'PENDING_APPROVAL' }) },
  { key: 'po-late', app: 'purchasing', kind: 'attention', tone: 'danger', label: 'Supplies overdue', to: '/rep/pending-purchase-orders', model: 'PurchaseOrder', perm: 'purchaseOrders.read', filter: (t) => ({ status: 'APPROVED', expectedDate: { $ne: null, $lt: t } }) },
  { key: 'mr-open', app: 'purchasing', kind: 'attention', tone: 'warn', label: 'Material requests to order', to: '/MaterialRequest?state=OPEN', doctype: 'MaterialRequest', filter: () => ({ status: 'SUBMITTED', state: 'OPEN' }) },
  { key: 'po-open', app: 'purchasing', kind: 'metric', label: 'Open purchase orders', to: '/purchaseOrders?status=APPROVED', model: 'PurchaseOrder', perm: 'purchaseOrders.read', filter: () => ({ status: 'APPROVED' }) },

  { key: 'batches-expiring', app: 'inventory', kind: 'attention', tone: 'warn', label: 'Batches expiring in 30 days', to: '/rep/batch-expiry', doctype: 'Batch', filter: (t) => ({ expiresOn: { $ne: null, $lte: addDays(t, 30) } }) },
  { key: 'picks-open', app: 'inventory', kind: 'metric', label: 'Pick lists open', to: '/PickList?state=OPEN', doctype: 'PickList', filter: () => ({ state: 'OPEN' }) },

  { key: 'ncr-open', app: 'quality', kind: 'attention', tone: 'warn', label: 'Open non-conformances', to: '/ncrs?status=OPEN', model: 'Ncr', perm: 'ncrs.read', filter: () => ({ status: 'OPEN' }) },
  { key: 'fat-open', app: 'quality', kind: 'attention', tone: 'warn', label: 'Open FAT protocols', to: '/fat?status=DRAFT', model: 'FatProtocol', perm: 'fat.read', filter: () => ({ status: 'DRAFT' }) },
  { key: 'gauges-due', app: 'quality', kind: 'attention', tone: 'danger', label: 'Gauges out of calibration', to: '/gauges', model: 'Gauge', perm: 'gauges.read', filter: (t) => ({ isActive: true, dueOn: { $lt: t } }) },
  { key: 'ipi-failed', app: 'quality', kind: 'attention', tone: 'danger', label: 'Failed inspections with no NCR', to: '/rep/in-process-failures', doctype: 'InProcessInspection', filter: () => ({ status: 'FAIL', ncrId: { $in: [null, ''] } }) },

  { key: 'invoices-overdue', app: 'finance', kind: 'attention', tone: 'danger', label: 'Customer invoices overdue', to: '/rep/overdue-invoices', model: 'SalesInvoice', perm: 'salesInvoices.read', filter: (t) => ({ status: 'SUBMITTED', dueDate: { $ne: null, $lt: t }, ...unpaid }), sum: 'outstanding' },
  { key: 'bills-due', app: 'finance', kind: 'attention', tone: 'warn', label: 'Supplier bills due this week', to: '/rep/payable-detail', model: 'PurchaseInvoice', perm: 'purchaseInvoices.read', filter: (t) => ({ status: 'SUBMITTED', dueDate: { $ne: null, $lte: addDays(t, 7) }, ...unpaid }), sum: 'outstanding' },
  { key: 'invoices-draft', app: 'finance', kind: 'attention', tone: 'info', label: 'Draft invoices', to: '/salesInvoices?status=DRAFT', model: 'SalesInvoice', perm: 'salesInvoices.write', filter: () => ({ status: 'DRAFT' }) },
  { key: 'bank-open', app: 'finance', kind: 'attention', tone: 'info', label: 'Bank lines to match', to: '/BankTransaction?state=UNRECONCILED', doctype: 'BankTransaction', filter: () => ({ state: 'UNRECONCILED' }) },

  { key: 'tickets-open', app: 'service', kind: 'attention', tone: 'warn', label: 'Open service tickets', to: '/tickets', model: 'ServiceTicket', perm: 'service.read', filter: () => ({ status: { $in: ['OPEN', 'IN_PROGRESS'] } }) },
  { key: 'sla-breached', app: 'service', kind: 'attention', tone: 'danger', label: 'Issues past their SLA', to: '/rep/sla-breaches', doctype: 'Issue', filter: () => ({ isSlaBreached: true, status: { $nin: ['RESOLVED', 'CLOSED'] } }) },
  { key: 'issues-open', app: 'service', kind: 'metric', label: 'Open issues', to: '/Issue?status=OPEN', doctype: 'Issue', filter: () => ({ status: 'OPEN' }) },

  { key: 'tasks-late', app: 'projects', kind: 'attention', tone: 'danger', label: 'Tasks past their date', to: '/rep/delayed-tasks', doctype: 'Task', filter: (t) => ({ dueDate: { $ne: null, $lt: t }, status: { $nin: ['DONE', 'CANCELLED'] } }) },
  { key: 'projects-open', app: 'projects', kind: 'metric', label: 'Open projects', to: '/Project?status=OPEN', doctype: 'Project', filter: () => ({ status: 'OPEN' }) },

  { key: 'leave-pending', app: 'people', kind: 'attention', tone: 'warn', label: 'Leave to approve', to: '/LeaveApplication?status=DRAFT', doctype: 'LeaveApplication', filter: () => ({ status: 'DRAFT' }) },
  { key: 'claims-pending', app: 'people', kind: 'attention', tone: 'warn', label: 'Expense claims to approve', to: '/ExpenseClaim?status=DRAFT', doctype: 'ExpenseClaim', filter: () => ({ status: 'DRAFT' }) },
  { key: 'people-active', app: 'people', kind: 'metric', label: 'Active employees', to: '/Employee?state=ACTIVE', doctype: 'Employee', filter: () => ({ state: 'ACTIVE' }) },
];

const modelFor = (tile) => (tile.doctype ? getType(tile.doctype)?.Model : mongoose.models[tile.model]);

async function allowed(tile, user) {
  if (tile.perm) return (PERMISSIONS[tile.perm] ?? []).includes(user.role);
  return (await accessFor(tile.doctype, user.role)).read;
}

// One tile failing should cost that tile, not the whole home page.
async function tileValue(tile, user, today) {
  const Model = modelFor(tile);
  if (!Model) return null;
  const scope = tile.doctype ? await scopeFilter(user, getType(tile.doctype)) : await scopeFilterForModel(user, Model);
  const base = tile.filter(today);
  const match = scope ? { $and: [base, scope] } : base;
  if (tile.sum !== 'outstanding') return { count: await Model.countDocuments(match) };
  const [row] = await Model.aggregate([
    { $match: match },
    { $group: { _id: null, count: { $sum: 1 }, value: { $sum: { $subtract: ['$totalPaise', { $add: [{ $ifNull: ['$paidPaise', 0] }, { $ifNull: ['$creditedPaise', 0] }] }] } } } },
  ]);
  return { count: row?.count ?? 0, valuePaise: row?.value ?? 0 };
}

export async function homeFor(user) {
  const today = todayIst();
  const visible = [];
  for (const tile of TILES) if (await allowed(tile, user)) visible.push(tile);
  const values = await Promise.all(visible.map((tile) => tileValue(tile, user, today).catch(() => null)));
  const tiles = visible
    .map((tile, index) => (values[index] ? { key: tile.key, app: tile.app, kind: tile.kind, tone: tile.tone ?? 'neutral', label: tile.label, to: tile.to, ...values[index] } : null))
    .filter(Boolean);

  const can = (perm) => (PERMISSIONS[perm] ?? []).includes(user.role);
  const [todos, unread] = await Promise.all([
    Todo.countDocuments({ assignedTo: user.id, isDone: { $ne: true } }).catch(() => 0),
    Notification.countDocuments({ userId: user.id, readAt: null }).catch(() => 0),
  ]);

  // Company-wide figures, so someone limited to some records does not get them.
  let floor = null;
  let money = null;
  if (can('reports.operations') && !(await isLimited(user))) {
    const d = await dashboard();
    floor = { stageCounts: d.stageCounts, builds: d.builds };
    if (can('reports.finance')) {
      money = [
        { key: 'receivable', label: 'Customers owe', valuePaise: d.receivablePaise, to: '/reports/receivable' },
        { key: 'payable', label: 'We owe suppliers', valuePaise: d.payablePaise, to: '/reports/payable' },
        { key: 'advances', label: 'Advances held', valuePaise: d.advancesPaise, to: '/rep/party-trial-balance' },
        { key: 'stock', label: 'Stock value', valuePaise: d.stockValuePaise, to: '/reports/stock' },
      ];
    }
  }
  return { today, tiles, me: { todos, unread }, floor, money };
}

// Core documents people look up by number or name, for the search box.
export const SEARCHABLE_CORE = [
  { model: 'Quotation', resource: 'quotations', typeLabel: 'Quotation', perm: 'quotations.read', fields: ['docNo', 'partyName'], label: ['docNo', 'partyName'] },
  { model: 'SalesOrder', resource: 'salesOrders', typeLabel: 'Sales order', perm: 'salesOrders.read', fields: ['docNo', 'partyName', 'customerPoNo'], label: ['docNo', 'partyName'] },
  { model: 'SalesInvoice', resource: 'salesInvoices', typeLabel: 'Sales invoice', perm: 'salesInvoices.read', fields: ['docNo', 'partyName'], label: ['docNo', 'partyName'] },
  { model: 'PurchaseOrder', resource: 'purchaseOrders', typeLabel: 'Purchase order', perm: 'purchaseOrders.read', fields: ['docNo', 'partyName'], label: ['docNo', 'partyName'] },
  { model: 'PurchaseInvoice', resource: 'purchaseInvoices', typeLabel: 'Purchase invoice', perm: 'purchaseInvoices.read', fields: ['docNo', 'partyName', 'supplierInvoiceNo'], label: ['docNo', 'partyName'] },
  { model: 'Payment', resource: 'payments', typeLabel: 'Payment', perm: 'payments.read', fields: ['docNo', 'partyName', 'reference'], label: ['docNo', 'partyName'] },
  { model: 'MachineBuild', resource: 'builds', typeLabel: 'Machine build', perm: 'builds.read', fields: ['serialNo', 'itemName', 'partyName'], label: ['serialNo', 'itemName'] },
  { model: 'Item', resource: 'items', typeLabel: 'Item', perm: 'items.read', fields: ['code', 'name'], label: ['code', 'name'] },
  { model: 'Party', resource: 'parties', typeLabel: 'Customer or supplier', perm: 'parties.read', fields: ['code', 'name', 'gstin'], label: ['code', 'name'] },
  { model: 'Ncr', resource: 'ncrs', typeLabel: 'Non-conformance', perm: 'ncrs.read', fields: ['docNo', 'itemName'], label: ['docNo', 'itemName'] },
];

export async function searchCore(user, pattern) {
  const hits = [];
  for (const entry of SEARCHABLE_CORE) {
    if (!(PERMISSIONS[entry.perm] ?? []).includes(user.role)) continue;
    const Model = mongoose.models[entry.model];
    if (!Model) continue;
    const scope = await scopeFilterForModel(user, Model);
    const found = { $or: entry.fields.map((f) => ({ [f]: pattern })) };
    const rows = await Model.find(scope ? { $and: [found, scope] } : found).sort({ createdAt: -1 }).limit(5).lean();
    for (const row of rows) hits.push({ doctype: entry.resource, typeLabel: entry.typeLabel, id: String(row._id), label: entry.label.map((k) => row[k]).filter(Boolean).join(' · ') || String(row._id) });
  }
  return hits;
}
