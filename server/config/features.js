// The parts of Forge the maintainer can switch off. A part that is off disappears from every
// screen and the server refuses it, for everyone. Its records are kept, and switching it
// on again brings everything back.
//
// A feature names what belongs to it: engine modules (every document type and report in
// them), permissions (the core screens and their routes), and API paths with no
// permission of their own. Items, customers and suppliers, settings, accounts for people,
// and reports on operations are always on.
import { PERMISSIONS } from './permissions.js';

export const FEATURES = [
  { key: 'crm', group: 'Selling', label: 'Leads and opportunities', blurb: 'Enquiries before they become quotations', modules: ['crm'] },
  { key: 'sales', group: 'Selling', label: 'Quotations and sales orders', blurb: 'Quotations, orders, delivery notes and pricing', modules: ['selling'], perms: ['quotations.*', 'salesOrders.*'] },
  { key: 'pos', group: 'Selling', label: 'Counter sales (POS)', blurb: 'Selling spares over the counter', modules: ['pos'] },
  { key: 'website', group: 'Selling', label: 'Website and web forms', blurb: 'Public pages, the product catalogue and enquiry forms', paths: ['/public/site', '/public/pages', '/public/catalogue', '/public/enquiry', '/public/forms'] },
  { key: 'portal', group: 'Selling', label: 'Customer and supplier portal', blurb: 'Customers and suppliers signing in to see their own documents', paths: ['/portal'] },
  { key: 'buying', group: 'Buying and stores', label: 'Purchase', blurb: 'Material requests, quotations from suppliers and purchase orders', modules: ['buying'], perms: ['purchaseOrders.*'] },
  { key: 'stock', group: 'Buying and stores', label: 'Stores and stock', blurb: 'Receiving, issuing, moving and counting stock', modules: ['stock'], perms: ['grns.*', 'stock.*', 'issues.*'] },
  { key: 'subcontracting', group: 'Buying and stores', label: 'Job work', blurb: 'Material sent out to be machined or coated', modules: ['subcontracting'], perms: ['jobWork.*'] },
  { key: 'builds', group: 'Making', label: 'Machine builds', blurb: 'Each machine built to order, its parts, time and cost', perms: ['builds.*', 'time.*'] },
  { key: 'manufacturing', group: 'Making', label: 'Work orders and shop floor', blurb: 'Batch work orders, job cards, planning and MRP', modules: ['manufacturing'] },
  { key: 'vault', group: 'Making', label: 'Drawing vault', blurb: 'SOLIDWORKS and AutoCAD files, with push, pull and release', perms: ['vault.*'], paths: ['/vault-agent'] },
  { key: 'projects', group: 'Making', label: 'Projects', blurb: 'Tasks and timesheets across a job', modules: ['projects'] },
  { key: 'quality', group: 'Quality and service', label: 'Quality', blurb: 'Inspections, FAT, problems (NCR) and instruments', modules: ['quality'], perms: ['inspections.*', 'ncrs.*', 'fat.*', 'gauges.*'] },
  { key: 'service', group: 'Quality and service', label: 'Service and AMC', blurb: 'Complaints, visits, warranty and maintenance contracts', modules: ['support', 'maintenance'], perms: ['service.*'] },
  { key: 'accounts', group: 'Money and people', label: 'Accounts and GST', blurb: 'Invoices, payments, bank, GST returns and the books', modules: ['accounts'], perms: ['salesInvoices.*', 'purchaseInvoices.*', 'payments.*', 'journals.*', 'reports.finance'] },
  { key: 'assets', group: 'Money and people', label: 'Fixed assets', blurb: 'Machines and equipment the company owns, and depreciation', modules: ['assets'] },
  { key: 'hr', group: 'Money and people', label: 'People and attendance', blurb: 'Employees, attendance, leave and hiring', modules: ['hr'] },
  { key: 'payroll', group: 'Money and people', label: 'Payroll', blurb: 'Salary structures, slips and payroll runs', modules: ['payroll'] },
];

export const FEATURE_KEYS = FEATURES.map((f) => f.key);

const expand = (patterns = []) => patterns.flatMap((p) => (p.endsWith('.*') ? Object.keys(PERMISSIONS).filter((k) => k.startsWith(p.slice(0, -1))) : [p]));

// Lookups built once: which feature a module, permission or path belongs to.
export const FEATURE_OF_MODULE = new Map(FEATURES.flatMap((f) => (f.modules ?? []).map((m) => [m, f.key])));
export const FEATURE_OF_PERM = new Map(FEATURES.flatMap((f) => expand(f.perms).map((p) => [p, f.key])));
export const FEATURE_PATHS = FEATURES.flatMap((f) => (f.paths ?? []).map((p) => [p, f.key]));
