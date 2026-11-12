// How one machine order moves through the company, from order to handover. The steps follow
// what pharma machine builders do (see docs/RESEARCH.md): kick-off, the customer approving
// the GA drawing and design qualification, building, FAT witnessed by the customer,
// dispatch clearance, then installation, SAT and IQ/OQ on site.
//
// Each step belongs to one department (role). `day` is when it is planned, counted from the
// order date for a 95-day order; Forge stretches or squeezes the days so that "dispatched"
// lands on the order's delivery date. A step with `auto` ticks itself when the records show
// it happened; the others are ticked by the department that owns them.
export const PHASES = [
  { key: 'order', label: 'Order' },
  { key: 'design', label: 'Design' },
  { key: 'materials', label: 'Materials' },
  { key: 'build', label: 'Build' },
  { key: 'testing', label: 'Testing' },
  { key: 'delivery', label: 'Delivery' },
  { key: 'site', label: 'At the customer' },
];

export const JOURNEY_STEPS = [
  { key: 'order-confirmed', phase: 'order', role: 'SALES', day: 0, auto: 'orderConfirmed', title: 'Order confirmed', hint: 'The customer\'s purchase order is checked against the offer and the order is confirmed.' },
  { key: 'advance', phase: 'order', role: 'ACCOUNTS', day: 7, auto: 'advance', title: 'Advance received', hint: 'The advance agreed in the order has been received.' },
  { key: 'kickoff-internal', phase: 'order', role: 'PROJECTS', day: 3, title: 'Internal kick-off', hint: 'Sales hands the order to projects. Design, purchase, production and quality agree the plan.' },
  { key: 'kickoff-customer', phase: 'order', role: 'PROJECTS', day: 7, title: 'Customer kick-off', hint: 'Schedule, contacts, URS points and documents to be supplied agreed with the customer.' },
  { key: 'ga-sent', phase: 'design', role: 'ENGINEERING', day: 14, title: 'GA drawing and DQ sent to customer', hint: 'General arrangement drawing, layout, utilities and the design qualification document.' },
  { key: 'ga-approved', phase: 'design', role: 'PROJECTS', day: 21, title: 'Customer approved GA and DQ', hint: 'Signed approval received. Changes after this are change requests.' },
  { key: 'design-released', phase: 'design', role: 'ENGINEERING', day: 25, auto: 'bomReleased', title: 'Design released', hint: 'The bill of materials and manufacturing drawings are released.' },
  { key: 'materials-ordered', phase: 'materials', role: 'PURCHASE', day: 30, auto: 'materialsOrdered', title: 'Materials ordered', hint: 'Purchase orders placed, long-lead items first (PLC, servo, pumps, SS 316L).' },
  { key: 'materials-issued', phase: 'materials', role: 'STORES', day: 55, auto: 'materialsIssued', title: 'All materials issued', hint: 'Every part received, inspected and issued to the machine.' },
  { key: 'fabrication', phase: 'build', role: 'PRODUCTION', day: 60, auto: 'pastFabrication', title: 'Fabrication and machining done', hint: 'Frame, contact parts and machined parts made and polished.' },
  { key: 'assembly', phase: 'build', role: 'PRODUCTION', day: 75, auto: 'pastAssembly', title: 'Assembly and electrical done', hint: 'Mechanical assembly, panel wiring and PLC/HMI programme loaded.' },
  { key: 'fat-protocol', phase: 'testing', role: 'VALIDATION', day: 70, title: 'FAT protocol approved by customer', hint: 'The test protocol the FAT will follow, signed by the customer before the FAT.' },
  { key: 'internal-trial', phase: 'testing', role: 'QUALITY', day: 80, title: 'Internal trial passed', hint: 'Forge\'s own run before the customer comes: speed, fill accuracy, interlocks.' },
  { key: 'fat-passed', phase: 'testing', role: 'QUALITY', day: 85, auto: 'fatPassed', title: 'FAT passed with the customer', hint: 'Factory acceptance test witnessed by the customer and signed.' },
  { key: 'punch-list', phase: 'testing', role: 'PRODUCTION', day: 90, title: 'FAT points closed', hint: 'Everything the customer asked for at FAT is done.' },
  { key: 'dispatch-payment', phase: 'delivery', role: 'ACCOUNTS', day: 92, auto: 'dispatchPayment', title: 'Payment before dispatch received', hint: 'The milestone due before FAT or dispatch has been received.' },
  { key: 'dispatch-clearance', phase: 'delivery', role: 'PROJECTS', day: 93, title: 'Dispatch clearance given', hint: 'FAT done, points closed, payment in, documents and spares packed: cleared to ship.' },
  { key: 'dispatched', phase: 'delivery', role: 'STORES', day: 95, auto: 'dispatched', title: 'Packed and dispatched', hint: 'Seaworthy packing, invoice and e-way bill, transporter details to the customer.' },
  { key: 'installed', phase: 'site', role: 'SERVICE', day: 110, auto: 'installed', title: 'Installed and commissioned', hint: 'Installed at the customer\'s site and running.' },
  { key: 'sat-iq-oq', phase: 'site', role: 'VALIDATION', day: 115, title: 'SAT and IQ/OQ done', hint: 'Site acceptance test and installation and operational qualification signed with the customer.' },
  { key: 'handover', phase: 'site', role: 'PROJECTS', day: 120, title: 'Handed over', hint: 'Operators trained; manuals, certificates and as-built drawings handed over. Warranty starts.' },
  { key: 'final-payment', phase: 'site', role: 'ACCOUNTS', day: 130, auto: 'finalPayment', title: 'Final payment received', hint: 'The balance due after installation has been received.' },
];

export const DISPATCH_DAY = 95;
// Who may tick any step: the people who run orders.
export const JOURNEY_OVERSEERS = ['ADMIN', 'MANAGEMENT', 'PROJECTS'];
