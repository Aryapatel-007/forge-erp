// The roles in Forge, as people see them. One app for everyone: who signs in decides which
// role, and the role decides the screens. The ADMIN role is shown as Maintainer: the person
// who makes accounts, switches parts of Forge on and off, and decides what each role sees.
export const ROLE_INFO = {
  ADMIN: { label: 'Maintainer', blurb: 'Runs Forge: accounts, what each role sees, features on and off, vault access. Sees everything.' },
  MANAGEMENT: { label: 'Management', blurb: 'The MD and directors. The whole company at a glance, approvals, every report.' },
  SALES: { label: 'Sales', blurb: 'Enquiries, quotations, orders and keeping customers informed.' },
  ENGINEERING: { label: 'Design and engineering', blurb: 'Items, bills of material, routings and the drawing vault.' },
  PURCHASE: { label: 'Purchase', blurb: 'Buying what the machines need, from request to purchase order.' },
  STORES: { label: 'Stores', blurb: 'Receiving, issuing and moving stock, batches and dispatch.' },
  PRODUCTION: { label: 'Production', blurb: 'Supervisors: machine builds, work orders, planning and the shop floor.' },
  OPERATOR: { label: 'Shop floor operator', blurb: 'Fitters, welders and electricians: their jobs and time, released drawings, reporting problems. No prices, customers or people.' },
  QUALITY: { label: 'Quality', blurb: 'Inspection, FAT, non-conformances and instruments.' },
  ACCOUNTS: { label: 'Accounts', blurb: 'Invoices, payments, bank, GST and the books.' },
  SERVICE: { label: 'Service', blurb: 'Machines at customers: complaints, visits, warranty and AMC.' },
  HR: { label: 'People (HR)', blurb: 'Employees, attendance, leave, payroll and hiring.' },
  PORTAL: { label: 'Customer or supplier', blurb: 'Outside the company: sees only their own orders, invoices and documents.' },
};

export const ROLE_KEYS = Object.keys(ROLE_INFO);
export const roleLabel = (role) => ROLE_INFO[role]?.label ?? role;
