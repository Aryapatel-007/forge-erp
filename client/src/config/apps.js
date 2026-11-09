// What lives where. Everything a person can open belongs to one business area, named for the
// work rather than the software. Each area lists its daily work first. Lookup lists and setup
// sit apart, under Setup. A document type nobody has placed here still appears, by its module.
//
// Tokens:  quotations   a screen in resources.js
//          Lead         an engine document type
//          #oee         a report in the report runner
//          @stock       a report with a fixed screen
//          { to, label, perm }   anything else
import { RESOURCES } from './resources.js';

export const FIXED_REPORTS = {
  stock: { title: 'Stock on hand', perm: 'reports.operations' },
  'stock-ledger': { title: 'Stock ledger', perm: 'reports.operations' },
  'lot-trace': { title: 'Trace a heat or batch', perm: 'reports.operations' },
  'job-work': { title: 'Goods at job workers', perm: 'reports.operations' },
  'trial-balance': { title: 'Trial balance', perm: 'reports.finance' },
  'profit-and-loss': { title: 'Profit and loss', perm: 'reports.finance' },
  'balance-sheet': { title: 'Balance sheet', perm: 'reports.finance' },
  ledger: { title: 'Account ledger', perm: 'reports.finance' },
  receivable: { title: 'What customers owe', perm: 'reports.finance' },
  payable: { title: 'What we owe suppliers', perm: 'reports.finance' },
  gstr1: { title: 'GSTR-1 working', perm: 'reports.finance' },
  gstr3b: { title: 'GSTR-3B working', perm: 'reports.finance' },
  integrity: { title: 'Integrity checks', perm: 'reports.finance' },
};

export const APPS = [
  {
    key: 'sales',
    label: 'Sales',
    icon: 'sales',
    tint: '#0f6e8c',
    blurb: 'Enquiries, quotations, orders and customers',
    modules: ['crm', 'selling', 'pos'],
    process: ['Lead', 'Opportunity', 'quotations', 'salesOrders', 'DeliveryNote', 'salesInvoices'],
    sections: [
      { title: 'Pipeline', items: ['Lead', 'Opportunity', 'Prospect', 'Appointment', 'Campaign', 'EmailCampaign'] },
      { title: 'Orders', items: ['quotations', 'salesOrders', 'ProformaInvoice', 'BlanketOrder', 'DeliverySchedule'] },
      { title: 'Delivery', items: ['DeliveryNote', 'PackingSlip', 'InstallationNote'] },
      { title: 'Customers', items: ['parties', 'Contract', 'Contact', 'Address'] },
      { title: 'Pricing', items: ['PriceList', 'ItemPrice', 'PricingRule', 'PromotionalScheme', 'CouponCode'] },
      { title: 'Counter sales', items: ['PosInvoice', 'PosOpening', 'PosClosing'] },
    ],
    setup: ['SalesPerson', 'SalesPartner', 'Territory', 'CustomerGroup', 'TermsAndConditions', 'Incoterm', 'QuotationLostReason'],
    reports: ['#open-sales-orders', '#opportunity-pipeline', '#milestones-due', '#sales-by-month', '#quotation-trends'],
  },
  {
    key: 'engineering',
    label: 'Engineering',
    icon: 'engineering',
    tint: '#5b4fa8',
    blurb: 'Items, bills of material and how things are made',
    modules: [],
    process: [{ to: '/vault', label: 'Drawing vault', perm: 'vault.read' }, 'items', 'boms', 'Routing', 'StandardCostRollup'],
    sections: [
      { title: 'Drawings', items: [{ to: '/vault', label: 'Drawing vault', perm: 'vault.read' }, { to: '/vault/admin', label: 'Vault access and set-up', perm: 'vault.admin' }] },
      { title: 'Product data', items: ['items', 'boms', 'ItemAlternative', 'ItemVariantGenerator'] },
      { title: 'Process', items: ['Routing', 'Operation', 'Workstation'] },
      { title: 'Changes and cost', items: ['BomUpdateTool', 'StandardCostRollup', 'ItemStandardCost'] },
    ],
    setup: ['ItemAttribute', 'ItemGroup', 'Brand', 'Manufacturer', 'ItemManufacturer', 'Uom', 'UomCategory', 'UomConversion', 'CustomsTariffNumber'],
    reports: ['#bom-cost', '#bom-where-used', '#bom-compare', '#bom-stock', '#standard-cost-variance'],
  },
  {
    key: 'manufacturing',
    label: 'Manufacturing',
    icon: 'factory',
    tint: '#b4541a',
    blurb: 'Machine builds, work orders and the shop floor',
    modules: ['manufacturing', 'subcontracting'],
    process: ['ProductionPlan', 'builds', 'WorkOrder', 'JobCard', 'fat'],
    sections: [
      { title: 'Machine builds', items: ['builds', 'materialIssues', 'timeBookings'] },
      { title: 'Shop floor', items: ['WorkOrder', 'JobCard', 'DowntimeEntry'] },
      { title: 'Planning', items: ['ProductionPlan', 'MasterProductionSchedule', 'SalesForecast', 'CapacityBooking'] },
      { title: 'Job work', items: ['jobWork', 'SubcontractingOrder', 'SubcontractingInwardOrder', 'SubcontractingBom', '@job-work'] },
    ],
    setup: ['WorkstationType', 'PlantFloor', 'Plant', 'WorkstationOperatingComponent'],
    reports: ['#build-pipeline', '#late-builds', '#work-order-delays', '#production-shortages', '#capacity-load', '#oee', '#build-costs'],
  },
  {
    key: 'purchasing',
    label: 'Purchasing',
    icon: 'cart',
    tint: '#2c7a4b',
    blurb: 'Requests, orders, receipts and suppliers',
    modules: ['buying'],
    process: ['MaterialRequest', 'RequestForQuotation', 'purchaseOrders', 'grns', 'inspections', 'purchaseInvoices'],
    sections: [
      { title: 'Sourcing', items: ['MaterialRequest', 'RequestForQuotation', 'SupplierQuotation'] },
      { title: 'Orders', items: ['purchaseOrders', 'grns', 'purchaseInvoices'] },
      { title: 'Suppliers', items: ['parties', 'SupplierScorecardPeriod', 'SupplierScorecard'] },
    ],
    setup: ['SupplierGroup'],
    reports: ['#pending-purchase-orders', '#pending-po-items', '#received-not-billed', '#supplier-scores', '#rfq-replies'],
  },
  {
    key: 'inventory',
    label: 'Inventory',
    icon: 'box',
    tint: '#8a6d1b',
    blurb: 'Stock, movements, batches and shipping',
    modules: ['stock'],
    process: ['grns', 'stockMoves', 'PickList', 'Shipment'],
    sections: [
      { title: 'Stock', items: ['@stock', '@stock-ledger', '@lot-trace', 'StockReconciliation'] },
      { title: 'Movements', items: ['stockMoves', 'PickList', 'LandedCostVoucher'] },
      { title: 'Shipping', items: ['Shipment', 'DeliveryTrip'] },
      { title: 'Tracking', items: ['Batch', 'SerialNo'] },
    ],
    setup: ['warehouses', 'PutawayRule', 'Location', 'Driver', 'Vehicle', 'ItemLeadTime', 'WarehouseType'],
    reports: ['#stock-below-reorder', '#stock-by-warehouse', '#stock-ageing', '#batch-expiry', '#serial-status'],
  },
  {
    key: 'quality',
    label: 'Quality',
    icon: 'shield',
    tint: '#0d7a73',
    blurb: 'Inspection, FAT, non-conformance and calibration',
    modules: ['quality'],
    process: ['inspections', 'InProcessInspection', 'fat', 'ncrs', 'QualityAction'],
    sections: [
      { title: 'Inspection', items: ['inspections', 'InProcessInspection', 'fat'] },
      { title: 'Problems', items: ['ncrs', 'QualityAction'] },
      { title: 'Instruments', items: ['gauges', 'CalibrationRecord'] },
      { title: 'Quality system', items: ['QualityProcedure', 'QualityGoal', 'QualityReview', 'QualityMeeting', 'QualityFeedback'] },
    ],
    setup: ['InspectionTemplate', 'InspectionParameter', 'InspectionParameterGroup', 'QualityFeedbackTemplate'],
    reports: ['#open-ncr-age', '#ncr-summary', '#fat-results', '#calibration-due', '#in-process-failures'],
  },
  {
    key: 'finance',
    label: 'Accounting',
    icon: 'rupee',
    tint: '#1f5fa8',
    blurb: 'Invoices, payments, banking, GST and the books',
    modules: ['accounts', 'assets'],
    process: ['salesInvoices', 'payments', 'BankStatementImport', 'GstSetOff', 'PeriodClosingVoucher'],
    sections: [
      { title: 'Customers', items: ['salesInvoices', 'notes', 'PaymentRequest', 'Dunning', 'ProcessStatementOfAccounts'] },
      { title: 'Suppliers', items: ['purchaseInvoices', 'PaymentOrder', 'TdsDeduction', 'BillOfEntry'] },
      { title: 'Banking', items: ['payments', 'BankTransfer', 'BankStatementImport', 'BankTransaction', 'PaymentReconciliation', 'BankGuarantee'] },
      { title: 'Books', items: ['journals', 'accounts', '@trial-balance', '@profit-and-loss', '@balance-sheet', '@ledger', 'Budget', 'PeriodClosingVoucher'] },
      { title: 'GST', items: ['@gstr1', '@gstr3b', 'GstSetOff', 'Gstr2bReconciliation'] },
      { title: 'Assets', items: ['Asset', 'AssetMovement', 'AssetRepair', 'AssetCapitalization', 'AssetValueAdjustment', 'AssetMaintenance', 'AssetMaintenanceLog'] },
      { title: 'Going live', items: ['OpeningInvoice'] },
    ],
    setup: ['CostCenter', 'CostCenterAllocation', 'BankAccount', 'Bank', 'ModeOfPayment', 'PaymentTerm', 'PaymentTermsTemplate', 'AccountingPeriod', 'AccountingDimension', 'AccountingDimensionFilter', 'FiscalYear', 'Currency', 'CurrencyExchange', 'AssetCategory', 'TaxWithholdingCategory', 'LowerDeductionCertificate', 'BankTransactionRule'],
    reports: ['@receivable', '@payable', '#overdue-invoices', '#day-book', '#general-ledger', '#cash-flow-statement', '#profit-by-month', '@integrity'],
  },
  {
    key: 'service',
    label: 'Service',
    icon: 'wrench',
    tint: '#a13a5c',
    blurb: 'Tickets, contracts, warranty and site visits',
    modules: ['support', 'maintenance'],
    process: ['InboundEmail', 'tickets', 'MaintenanceVisit'],
    sections: [
      { title: 'Support', items: ['tickets', 'Issue', 'InboundEmail', 'CallLog'] },
      { title: 'Contracts', items: ['amc', 'WarrantyClaim'] },
      { title: 'Site visits', items: ['MaintenanceSchedule', 'MaintenanceVisit'] },
    ],
    setup: ['ServiceLevelAgreement', 'IssueType', 'IssuePriority'],
    reports: ['#sla-breaches', '#amc-expiring', '#warranty-status', '#maintenance-due'],
  },
  {
    key: 'projects',
    label: 'Projects',
    icon: 'folder',
    tint: '#4d6b24',
    blurb: 'Projects, tasks and time',
    modules: ['projects'],
    process: ['Project', 'Task', 'Timesheet'],
    sections: [
      { title: 'Work', items: ['Project', 'Task', 'Timesheet', 'ProjectUpdate'] },
    ],
    setup: [],
    reports: ['#project-summary', '#delayed-tasks', '#timesheet-hours'],
  },
  {
    key: 'people',
    label: 'People',
    icon: 'users',
    tint: '#7a4a9c',
    blurb: 'Employees, attendance, leave, hiring and payroll',
    modules: ['hr', 'payroll'],
    process: ['JobApplicant', 'Employee', 'Attendance', 'PayrollEntry'],
    sections: [
      { title: 'Employees', items: ['Employee', 'EmployeeOnboarding', 'EmployeeTransfer', 'EmployeePromotion', 'EmployeeSeparation', 'EmployeeGrievance'] },
      { title: 'Time', items: ['Attendance', 'EmployeeCheckin', 'AttendanceRequest', 'ShiftAssignment', 'ShiftRequest', 'EmployeeAttendanceTool', 'ShiftAssignmentTool'] },
      { title: 'Leave', items: ['LeaveApplication', 'LeaveAllocation', 'CompensatoryLeaveRequest', 'LeaveEncashment', 'LeaveControlPanel'] },
      { title: 'Hiring', items: ['JobRequisition', 'JobOpening', 'JobApplicant', 'Interview', 'JobOffer', 'StaffingPlan'] },
      { title: 'Performance', items: ['Appraisal', 'AppraisalCycle', 'Goal', 'TrainingEvent', 'TrainingResult', 'EmployeeFeedback'] },
      { title: 'Expenses', items: ['ExpenseClaim', 'EmployeeAdvance', 'TravelRequest', 'VehicleLog'] },
      { title: 'Payroll', items: ['PayrollEntry', 'SalarySlip', 'SalaryStructureAssignment', 'AdditionalSalary', 'EmployeeIncentive', 'Arrear', 'Gratuity', 'SalaryWithholding', 'BulkSalaryStructureAssignment'] },
    ],
    setup: ['Department', 'Designation', 'Branch', 'HolidayList', 'SalaryComponent', 'SalaryStructure', 'PayrollPeriod', 'PayrollStatutory', 'IncomeTaxSlab', 'LeaveType', 'LeavePeriod', 'LeavePolicy', 'ShiftType'],
    reports: ['#employee-directory', '#monthly-attendance', '#leave-balance', '#salary-register', '#pf-esi-register'],
  },
  {
    key: 'website',
    label: 'Website',
    icon: 'globe',
    tint: '#22737f',
    blurb: 'Public pages, the catalogue, forms and messages',
    modules: [],
    process: [],
    sections: [
      { title: 'Site', items: ['WebPage', 'WebForm', { to: '/site', label: 'Open the website', perm: 'settings.write', external: true }] },
      { title: 'Messages', items: ['SmsCenter', 'SmsMessage'] },
    ],
    setup: [],
    reports: [],
  },
  {
    key: 'insights',
    label: 'Insights',
    icon: 'chart',
    tint: '#3f5468',
    blurb: 'Dashboards and every report in one place',
    modules: [],
    process: [],
    sections: [
      { title: 'Dashboards', items: [{ to: '/dash', label: 'Dashboards', perm: 'reports.operations' }, 'NumberCard', 'DashboardChart'] },
      { title: 'Reports', items: [{ to: '/reports', label: 'All reports', perm: 'reports.operations' }, { to: '/report-builder', label: 'Build a report', perm: 'reports.operations' }] },
    ],
    setup: [],
    reports: [],
  },
  {
    key: 'settings',
    label: 'Settings',
    icon: 'gear',
    tint: '#555b5e',
    blurb: 'Company, users, permissions and automation',
    modules: ['setup', 'platform'],
    process: [],
    sections: [
      { title: 'Maintainer', items: [{ to: '/maintainer', label: 'Maintainer home', perm: 'settings.write' }, { to: '/users', label: 'Accounts', perm: 'users.manage' }, { to: '/maintainer/features', label: 'Features on and off', perm: 'settings.write' }, { to: '/maintainer/roles', label: 'What each role sees', perm: 'settings.write' }, { to: '/vault/admin', label: 'Vault access', perm: 'vault.admin' }] },
      { title: 'Company', items: [{ to: '/going-live', label: 'Going live', perm: 'settings.write' }, { to: '/settings', label: 'Company settings', perm: 'settings.write' }, 'LetterHead', 'PrintFormat', 'Translation'] },
      { title: 'People and access', items: [{ to: '/departments', label: 'Who sees what', perm: 'users.manage' }, { to: '/users', label: 'Users', perm: 'users.manage' }, { to: '/role-permissions', label: 'Role permissions', perm: 'users.manage' }, 'UserPermission', 'AuthorizationRule'] },
      { title: 'Automation', items: ['Workflow', 'NotificationRule', 'AutoRepeat', 'EmailDigest', { to: '/custom-fields', label: 'Custom fields', perm: 'settings.write' }] },
      { title: 'System', items: [{ to: '/system', label: 'Jobs, email and backups', perm: 'settings.write' }, { to: '/audit', label: 'Audit trail', perm: 'audit.read' }, 'RenameTool'] },
    ],
    setup: [],
    reports: [],
  },
];

// The documents people start most often, offered by the + button.
export const CREATE_ITEMS = [
  'Lead', 'quotations', 'salesOrders', 'salesInvoices', 'payments', 'MaterialRequest', 'purchaseOrders', 'grns', 'purchaseInvoices',
  'stockMoves', 'WorkOrder', 'JobCard', 'materialIssues', 'tickets', 'Issue', 'Task', 'LeaveApplication', 'ExpenseClaim', 'items', 'parties',
];

const newable = (token, can, meta) => {
  if (token.charAt(0) === token.charAt(0).toUpperCase()) {
    const type = meta.doctypes.find((d) => d.name === token);
    return type?.can?.write ? { to: `/${token}/new`, label: type.label } : null;
  }
  const config = RESOURCES[token];
  return config && !config.noCreate && can(config.write) ? { to: `/${token}/new`, label: config.single } : null;
};

export const createItems = (can, meta) => CREATE_ITEMS.map((token) => newable(token, can, meta)).filter(Boolean);

function resolve(token, can, meta) {
  if (typeof token === 'object') return !token.perm || can(token.perm) ? token : null;
  if (token.startsWith('@')) {
    const key = token.slice(1);
    const report = FIXED_REPORTS[key];
    return report && can(report.perm) ? { to: `/reports/${key}`, label: report.title, isReport: true } : null;
  }
  if (token.startsWith('#')) {
    const key = token.slice(1);
    const report = meta.reports.find((r) => r.key === key);
    return report ? { to: `/rep/${key}`, label: report.title, isReport: true } : null;
  }
  if (token.charAt(0) === token.charAt(0).toUpperCase()) {
    const type = meta.doctypes.find((d) => d.name === token);
    return type ? { to: `/${token}`, label: type.label, token } : null;
  }
  const config = RESOURCES[token];
  return config && can(config.read) ? { to: `/${token}`, label: config.title, token } : null;
}

export const resolveToken = resolve;

const tokensIn = (app) => [...app.sections.flatMap((s) => s.items), ...app.setup, ...app.process, ...app.reports];

// The apps this person can use, with only what they may open. Pure, so a test can check that
// nothing has been left without a home.
export function buildApps(can, meta) {
  const placed = new Set(APPS.flatMap((app) => tokensIn(app)).filter((t) => typeof t === 'string'));
  const appOfModule = new Map(APPS.flatMap((app) => app.modules.map((module) => [module, app.key])));
  const leftovers = new Map(APPS.map((app) => [app.key, { documents: [], setup: [], reports: [] }]));
  for (const type of meta.doctypes) {
    if (placed.has(type.name)) continue;
    const bucket = leftovers.get(appOfModule.get(type.module) ?? 'settings');
    (type.submittable || type.series ? bucket.documents : bucket.setup).push({ to: `/${type.name}`, label: type.label, token: type.name });
  }
  for (const report of meta.reports) {
    if (placed.has(`#${report.key}`)) continue;
    leftovers.get(appOfModule.get(report.module) ?? 'insights').reports.push({ to: `/rep/${report.key}`, label: report.title, isReport: true });
  }
  const byLabel = (a, b) => a.label.localeCompare(b.label);
  const fill = (tokens) => tokens.map((token) => resolve(token, can, meta)).filter(Boolean);

  return APPS.map((app) => {
    const extra = leftovers.get(app.key);
    const sections = app.sections
      .map((section) => ({ title: section.title, items: fill(section.items) }))
      .filter((section) => section.items.length > 0);
    if (extra.documents.length) sections.push({ title: 'More', items: extra.documents.sort(byLabel) });
    const setup = [...fill(app.setup), ...extra.setup.sort(byLabel)];
    const reports = [...fill(app.reports), ...extra.reports.sort(byLabel)];
    return { ...app, sections, setup, reports, process: fill(app.process) };
  }).filter((app) => app.sections.length > 0 || app.reports.length > 0);
}

const firstSegment = (pathname) => pathname.split('/').filter(Boolean)[0] ?? '';

// Which app a page belongs to. A screen can sit in two apps, like purchase invoices, so the
// app already open wins, and people are not moved about as they work.
export function appForPath(apps, pathname, currentKey = null) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] === 'app') return apps.find((app) => app.key === parts[1]) ?? null;
  if (parts.length === 0 || ['apps', 'my-work', 'search', 'password', 'print'].includes(parts[0])) return null;
  const targets = parts[0] === 'rep' || parts[0] === 'reports' ? [`/${parts[0]}/${parts[1] ?? ''}`.replace(/\/$/, '')] : [`/${firstSegment(pathname)}`];
  const owns = (app) => [...app.sections.flatMap((s) => s.items), ...app.setup, ...app.reports].some((item) => targets.includes(item.to));
  const current = apps.find((app) => app.key === currentKey);
  if (current && owns(current)) return current;
  return apps.find(owns) ?? null;
}

// Every place a person can go, for the search box.
export function allDestinations(apps) {
  const seen = new Set();
  const out = [];
  for (const app of apps) {
    const add = (item) => {
      if (seen.has(item.to)) return;
      seen.add(item.to);
      out.push({ ...item, appLabel: app.label });
    };
    out.push({ to: `/app/${app.key}`, label: app.label, appLabel: 'Area' });
    app.sections.flatMap((s) => s.items).forEach(add);
    app.reports.forEach(add);
    app.setup.forEach(add);
  }
  return out;
}
