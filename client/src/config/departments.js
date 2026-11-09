// What each department sees. This is the one place that decides it.
//
// A person in a department opens to that department's page: the jobs they do most, what is
// waiting on them, the few lists they work in, and their reports. Nothing else is in their
// menus. Management and Admin see the whole company, and can open any department's page.
//
// This only decides what is shown. What a person may read or change is still checked by the
// server on every request, so a screen left out here is not a security setting.
//
// Tokens are the same as in apps.js. A token starting with + is a "new" button.
import { RESOURCES } from './resources.js';
import { resolveToken } from './apps.js';

export const DEPARTMENTS = {
  SALES: {
    title: 'Sales',
    icon: 'sales',
    tint: '#0f6e8c',
    blurb: 'Enquiries, quotations and orders, and keeping customers informed',
    tasks: ['+Lead', '+quotations', '+salesOrders'],
    sections: [
      { title: 'Selling', items: ['Lead', 'Opportunity', 'quotations', 'salesOrders'] },
      { title: 'Customers', items: ['parties', 'Contract'] },
      { title: 'Keep an eye on', items: ['builds', '@stock'] },
    ],
    reports: ['#open-sales-orders', '#opportunity-pipeline', '#milestones-due', '#sales-by-month'],
    tiles: ['leads-due', 'orders-late', 'inbox', 'quotes-out', 'orders-live', 'leads-new'],
  },
  ENGINEERING: {
    title: 'Engineering',
    icon: 'engineering',
    tint: '#5b4fa8',
    blurb: 'Items, bills of material and how each machine is made',
    tasks: ['+items', '+boms'],
    sections: [
      { title: 'Drawings', items: [{ to: '/vault', label: 'Drawing vault', perm: 'vault.read' }, { to: '/vault?tab=tasks', label: 'My vault tasks', perm: 'vault.read' }, { to: '/vault?mine=true', label: 'Locked by me', perm: 'vault.write' }, { to: '/vault?state=REVIEW', label: 'Waiting for review', perm: 'vault.release' }] },
      { title: 'Design', items: ['items', 'boms', 'Routing', 'Operation'] },
      { title: 'Changes and cost', items: ['BomUpdateTool', 'StandardCostRollup'] },
      { title: 'Keep an eye on', items: ['builds'] },
    ],
    reports: ['#bom-cost', '#bom-where-used', '#bom-compare', '#bom-stock'],
    tiles: ['boms-draft', 'items-active'],
  },
  PURCHASE: {
    title: 'Purchase',
    icon: 'cart',
    tint: '#2c7a4b',
    blurb: 'Buying what the machines need, on time and at the right price',
    tasks: ['+purchaseOrders', '+RequestForQuotation', '+MaterialRequest'],
    sections: [
      { title: 'Buying', items: ['MaterialRequest', 'RequestForQuotation', 'SupplierQuotation', 'purchaseOrders'] },
      { title: 'Suppliers', items: ['parties', 'SupplierScorecardPeriod'] },
      { title: 'Keep an eye on', items: ['grns', 'builds', { to: '/vault', label: 'Drawing vault', perm: 'vault.read' }] },
    ],
    reports: ['#pending-purchase-orders', '#pending-po-items', '#supplier-scores', '#rfq-replies'],
    tiles: ['po-late', 'mr-open', 'po-approval', 'po-open'],
  },
  STORES: {
    title: 'Stores',
    icon: 'box',
    tint: '#8a6d1b',
    blurb: 'Receiving, issuing and moving stock, and knowing where everything is',
    tasks: ['+grns', '+materialIssues', '+stockMoves'],
    sections: [
      { title: 'In and out', items: ['grns', 'materialIssues', 'stockMoves', 'jobWork'] },
      { title: 'Stock', items: ['@stock', '@stock-ledger', 'Batch', 'StockReconciliation'] },
      { title: 'Dispatch', items: ['PickList', 'Shipment', { to: '/vault', label: 'Drawing vault', perm: 'vault.read' }] },
    ],
    reports: ['#stock-below-reorder', '#batch-expiry', '#stock-by-warehouse', '@lot-trace'],
    tiles: ['batches-expiring', 'picks-open'],
  },
  PRODUCTION: {
    title: 'Production',
    icon: 'factory',
    tint: '#b4541a',
    blurb: 'Building the machines, and the parts made in batches',
    tasks: ['+timeBookings', '+materialIssues', '+WorkOrder'],
    sections: [
      { title: 'Machines', items: ['builds', 'materialIssues', 'timeBookings', { to: '/vault?state=RELEASED', label: 'Released drawings', perm: 'vault.read' }] },
      { title: 'Shop floor', items: ['WorkOrder', 'JobCard', 'DowntimeEntry'] },
      { title: 'Planning', items: ['ProductionPlan', 'jobWork'] },
    ],
    reports: ['#build-pipeline', '#late-builds', '#work-order-delays', '#capacity-load'],
    tiles: ['builds-late', 'wo-late', 'builds-open', 'wo-open'],
  },
  OPERATOR: {
    title: 'Shop floor',
    icon: 'factory',
    tint: '#9a5b13',
    blurb: 'Your jobs, your time, the drawings you build from, and reporting problems',
    tasks: ['+timeBookings', '+ncrs'],
    sections: [
      { title: 'My work', items: ['JobCard', 'timeBookings', 'DowntimeEntry'] },
      { title: 'Drawings', items: [{ to: '/vault?state=RELEASED', label: 'Released drawings', perm: 'vault.read' }] },
      { title: 'Problems', items: ['ncrs'] },
    ],
    reports: [],
    tiles: ['wo-open'],
  },
  QUALITY: {
    title: 'Quality',
    icon: 'shield',
    tint: '#0d7a73',
    blurb: 'Inspection, factory acceptance tests and fixing what goes wrong',
    tasks: ['+inspections', '+InProcessInspection', '+ncrs'],
    sections: [
      { title: 'Inspection', items: ['inspections', 'InProcessInspection', 'fat'] },
      { title: 'Problems', items: ['ncrs', 'QualityAction'] },
      { title: 'Instruments', items: ['gauges'] },
      { title: 'Drawings', items: [{ to: '/vault?state=RELEASED', label: 'Released drawings', perm: 'vault.read' }] },
    ],
    reports: ['#open-ncr-age', '#fat-results', '#calibration-due', '#in-process-failures'],
    tiles: ['ncr-open', 'fat-open', 'gauges-due', 'ipi-failed'],
  },
  ACCOUNTS: {
    title: 'Accounts',
    icon: 'rupee',
    tint: '#1f5fa8',
    blurb: 'Invoices, payments, bank, GST and the books',
    tasks: ['+salesInvoices', '+payments', '+purchaseInvoices'],
    sections: [
      { title: 'Customers', items: ['salesInvoices', 'notes', '@receivable'] },
      { title: 'Suppliers', items: ['purchaseInvoices', '@payable', 'TdsDeduction'] },
      { title: 'Bank', items: ['payments', 'BankStatementImport', 'BankTransfer'] },
      { title: 'GST', items: ['@gstr1', '@gstr3b', 'GstSetOff', 'Gstr2bReconciliation'] },
      { title: 'Books', items: ['journals', '@trial-balance', '@profit-and-loss', '@balance-sheet'] },
    ],
    reports: ['#overdue-invoices', '#day-book', '#general-ledger', '@integrity'],
    tiles: ['invoices-overdue', 'bills-due', 'invoices-draft', 'bank-open'],
  },
  SERVICE: {
    title: 'Service',
    icon: 'wrench',
    tint: '#a13a5c',
    blurb: 'Looking after machines at customers, from installation onwards',
    tasks: ['+tickets', '+MaintenanceVisit'],
    sections: [
      { title: 'Customers\' problems', items: ['tickets', 'Issue', 'InboundEmail'] },
      { title: 'Cover', items: ['amc', 'WarrantyClaim'] },
      { title: 'Visits', items: ['MaintenanceSchedule', 'MaintenanceVisit'] },
      { title: 'Drawings', items: [{ to: '/vault?state=RELEASED', label: 'Released drawings', perm: 'vault.read' }] },
    ],
    reports: ['#sla-breaches', '#amc-expiring', '#warranty-status'],
    tiles: ['tickets-open', 'sla-breached', 'inbox', 'issues-open'],
  },
  HR: {
    title: 'People',
    icon: 'users',
    tint: '#7a4a9c',
    blurb: 'Employees, attendance, leave and pay',
    tasks: ['+Employee', '+LeaveApplication', '+PayrollEntry'],
    sections: [
      { title: 'Employees', items: ['Employee', 'Attendance', 'EmployeeAttendanceTool'] },
      { title: 'Leave and claims', items: ['LeaveApplication', 'LeaveAllocation', 'ExpenseClaim'] },
      { title: 'Pay', items: ['PayrollEntry', 'SalarySlip', 'SalaryStructureAssignment'] },
      { title: 'Hiring', items: ['JobOpening', 'JobApplicant', 'Interview'] },
    ],
    reports: ['#employee-directory', '#monthly-attendance', '#leave-balance', '#salary-register'],
    tiles: ['leave-pending', 'claims-pending', 'people-active'],
  },
};

// Roles that look after the whole company rather than one department.
export const COMPANY_ROLES = new Set(['ADMIN', 'MANAGEMENT']);

const newLink = (token, can, meta) => {
  if (token.charAt(0) === token.charAt(0).toUpperCase()) {
    const type = meta.doctypes.find((d) => d.name === token);
    return type?.can?.write ? { to: `/${token}/new`, label: `New ${type.label.toLowerCase()}` } : null;
  }
  const config = RESOURCES[token];
  return config && !config.noCreate && can(config.write) ? { to: `/${token}/new`, label: `New ${config.single.toLowerCase()}` } : null;
};

// How a token is named in the maintainer's choices: its text, or a link's address.
export const tokenId = (token) => (typeof token === 'string' ? token : token.to);

// A department's page for one person, with only what that person is allowed to open, after
// the maintainer's choices for the role: screens hidden, and screens added.
export function buildDepartment(role, can, meta, screen = null) {
  const dept = DEPARTMENTS[role];
  if (!dept) return null;
  const hidden = new Set(screen?.hidden ?? []);
  const shown = (token) => !hidden.has(tokenId(token));
  const fill = (tokens) => tokens.filter(shown).map((token) => resolveToken(token, can, meta)).filter(Boolean);
  const sections = dept.sections.map((s) => ({ title: s.title, items: fill(s.items) }));
  const added = fill(screen?.added ?? []);
  if (added.length) sections.push({ title: 'Also', items: added });
  return {
    ...dept,
    key: role,
    tasks: dept.tasks.filter(shown).map((token) => newLink(token.slice(1), can, meta)).filter(Boolean),
    sections: sections.filter((s) => s.items.length > 0),
    reports: fill(dept.reports),
    tiles: dept.tiles.filter((key) => !hidden.has(`tile:${key}`)),
  };
}

// For the who-sees-what page: every department, as anyone in it would see it.
export function departmentTable(meta) {
  const everything = () => true;
  return Object.keys(DEPARTMENTS).map((role) => buildDepartment(role, everything, meta));
}
