// Who may do what. The server checks this on every route.
export const ROLES = Object.freeze([
  'ADMIN', 'MANAGEMENT', 'SALES', 'ENGINEERING', 'PURCHASE', 'STORES',
  'PRODUCTION', 'OPERATOR', 'QUALITY', 'ACCOUNTS', 'SERVICE', 'HR', 'PORTAL',
]);
// A portal sign-in belongs to a customer or supplier, not to staff.
export const STAFF_ROLES = Object.freeze(ROLES.filter((role) => role !== 'PORTAL'));

const everyone = STAFF_ROLES;
// The shop floor does not see customers, suppliers or the chart of accounts.
const deskRoles = STAFF_ROLES.filter((role) => role !== 'OPERATOR');
const office = ['ADMIN', 'MANAGEMENT'];

export const PERMISSIONS = Object.freeze({
  'users.manage': ['ADMIN'],
  'settings.read': everyone,
  'settings.write': ['ADMIN'],
  'audit.read': ['ADMIN', 'MANAGEMENT'],

  'items.read': everyone,
  'items.write': [...office, 'ENGINEERING', 'PURCHASE', 'STORES'],
  'parties.read': deskRoles,
  'parties.write': [...office, 'SALES', 'PURCHASE', 'ACCOUNTS'],
  'warehouses.read': everyone,
  'warehouses.write': [...office, 'STORES'],
  'accounts.read': deskRoles,
  'accounts.write': [...office, 'ACCOUNTS'],

  'boms.read': everyone,
  'boms.write': [...office, 'ENGINEERING'],
  'boms.release': [...office, 'ENGINEERING'],

  'quotations.read': [...office, 'SALES', 'ACCOUNTS', 'ENGINEERING'],
  'quotations.write': [...office, 'SALES'],
  'salesOrders.read': [...office, 'SALES', 'ACCOUNTS', 'ENGINEERING', 'PURCHASE', 'PRODUCTION', 'QUALITY', 'SERVICE', 'STORES'],
  'salesOrders.write': [...office, 'SALES'],

  'builds.read': everyone,
  'builds.write': [...office, 'PRODUCTION', 'ENGINEERING'],
  'builds.complete': [...office, 'PRODUCTION'],
  'builds.install': [...office, 'SERVICE'],

  'purchaseOrders.read': [...office, 'PURCHASE', 'ACCOUNTS', 'STORES', 'PRODUCTION'],
  'purchaseOrders.write': [...office, 'PURCHASE'],
  'purchaseOrders.approve': office,
  'grns.read': [...office, 'PURCHASE', 'STORES', 'QUALITY', 'ACCOUNTS'],
  'grns.write': [...office, 'STORES'],
  'purchaseInvoices.read': [...office, 'ACCOUNTS', 'PURCHASE'],
  'purchaseInvoices.write': [...office, 'ACCOUNTS'],

  'stock.read': everyone,
  'stock.write': [...office, 'STORES'],
  'issues.write': [...office, 'STORES', 'PRODUCTION'],
  'jobWork.read': [...office, 'PURCHASE', 'STORES', 'PRODUCTION', 'ACCOUNTS'],
  'jobWork.write': [...office, 'PURCHASE', 'STORES'],
  'time.read': [...office, 'PRODUCTION', 'OPERATOR', 'ACCOUNTS'],
  'time.write': [...office, 'PRODUCTION', 'OPERATOR'],

  'inspections.read': [...office, 'QUALITY', 'STORES', 'PURCHASE'],
  'inspections.write': [...office, 'QUALITY'],
  'ncrs.read': [...office, 'QUALITY', 'PRODUCTION', 'OPERATOR', 'ENGINEERING', 'PURCHASE', 'SERVICE'],
  'ncrs.write': [...office, 'QUALITY', 'PRODUCTION', 'OPERATOR', 'SERVICE'],
  'ncrs.close': [...office, 'QUALITY'],
  'fat.read': [...office, 'QUALITY', 'PRODUCTION', 'SALES', 'SERVICE'],
  'fat.write': [...office, 'QUALITY'],
  'gauges.read': [...office, 'QUALITY', 'PRODUCTION'],
  'gauges.write': [...office, 'QUALITY'],

  'salesInvoices.read': [...office, 'ACCOUNTS', 'SALES'],
  'salesInvoices.write': [...office, 'ACCOUNTS'],
  'salesInvoices.override': office,
  'payments.read': [...office, 'ACCOUNTS'],
  'payments.write': [...office, 'ACCOUNTS'],
  'journals.read': [...office, 'ACCOUNTS'],
  'journals.write': [...office, 'ACCOUNTS'],

  'service.read': [...office, 'SERVICE', 'SALES', 'QUALITY'],
  'service.write': [...office, 'SERVICE'],

  // The drawing vault. Everyone can look at drawings; engineering changes and releases them.
  'vault.read': everyone,
  'vault.write': [...office, 'ENGINEERING'],
  'vault.release': [...office, 'ENGINEERING'],
  'vault.admin': ['ADMIN'],

  'reports.finance': [...office, 'ACCOUNTS'],
  'reports.operations': everyone,
});

export function can(role, permission) {
  const allowed = PERMISSIONS[permission];
  if (!allowed) throw new Error(`Unknown permission: ${permission}`);
  return allowed.includes(role);
}

export function permissionsFor(role) {
  return Object.keys(PERMISSIONS).filter((permission) => PERMISSIONS[permission].includes(role));
}
