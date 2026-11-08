// The screens for masters and documents are described here and drawn by one set of
// generic pages. Adding a document type means adding an entry, not writing a screen.
//
// Field types: text, textarea, number, date, check, select, ref, money (paise), qty
// (thousandths), bps (percent), fx (rate x 10,000), integer, lines.
import { post } from '../api/client.js';
import { formatBps, formatDate, formatDateTime, formatFx, formatMinor, formatPaise, formatQty, humanise } from '../utils/format.js';

const ITEM_TYPES = ['RAW', 'BOUGHT_OUT', 'FABRICATED', 'ASSEMBLY', 'MACHINE', 'SPARE', 'CONSUMABLE', 'SERVICE'];
const option = (values) => values.map((value) => ({ value, label: humanise(value) }));

const item = { endpoint: '/items', labelOf: (r) => `${r.code} · ${r.name}` };
const stockItem = { ...item };
const warehouse = { endpoint: '/warehouses', labelOf: (r) => `${r.code} · ${r.name}` };
const build = { endpoint: '/builds', labelOf: (r) => `${r.serialNo} · ${r.itemName}` };
const customer = { endpoint: '/parties', params: { isCustomer: 'true' }, labelOf: (r) => `${r.code} · ${r.name}` };
const supplier = { endpoint: '/parties', params: { isSupplier: 'true' }, labelOf: (r) => `${r.code} · ${r.name}` };
const jobWorker = { endpoint: '/parties', params: { isJobWorker: 'true' }, labelOf: (r) => `${r.code} · ${r.name}` };
const anyParty = { endpoint: '/parties', labelOf: (r) => `${r.code} · ${r.name}` };
const bank = { endpoint: '/accounts', params: { isCashOrBank: 'true' }, labelOf: (r) => `${r.code} · ${r.name}` };
const account = { endpoint: '/accounts', labelOf: (r) => `${r.code} · ${r.name}` };

const text = (key, label, extra = {}) => ({ key, label, type: 'text', ...extra });
const col = (key, label, render, extra = {}) => ({ key, label, render: render ? (row) => render(row[key], row) : undefined, ...extra });
const moneyCol = (key, label) => ({ key, label, align: 'right', render: (row) => formatPaise(row[key]) });
const qtyCol = (key, label) => ({ key, label, align: 'right', render: (row) => formatQty(row[key]) });
const dateCol = (key, label) => ({ key, label, render: (row) => formatDate(row[key]) });
const statusCol = { key: 'status', label: 'Status', status: true };
const docNoCol = { key: 'docNo', label: 'Number', render: (row) => row.docNo ?? 'Draft' };

const lineFrozen = col('itemName', 'Item', (v, r) => `${r.itemCode ? `${r.itemCode} · ` : ''}${v}`, { wrap: true });

const salesLines = (currencyKey = 'currency') => ({
  key: 'lines',
  type: 'lines',
  label: 'Lines',
  fields: [
    { key: 'itemId', label: 'Item', type: 'ref', ref: item, required: true, wide: true, quote: 'selling', onPick: (r) => ({ rateMinor: r.salePricePaise ?? 0, gstRateBps: r.gstRateBps }) },
    { key: 'qtyMilli', label: 'Qty', type: 'qty', required: true },
    { key: 'rateMinor', label: 'Rate', type: 'money', required: true },
    { key: 'discountBps', label: 'Disc. %', type: 'bps' },
    { key: 'gstRateBps', label: 'GST %', type: 'bps' },
  ],
  currencyKey,
});
const salesLineColumns = [
  lineFrozen,
  { key: 'hsn', label: 'HSN' },
  qtyCol('qtyMilli', 'Qty'),
  { key: 'rateMinor', label: 'Rate', align: 'right', render: (row, doc) => formatMinor(row.rateMinor, doc?.currency) },
  { key: 'discountBps', label: 'Disc.', align: 'right', render: (row) => formatBps(row.discountBps) },
  { key: 'gstRateBps', label: 'GST', align: 'right', render: (row) => formatBps(row.gstRateBps) },
  { key: 'amountMinor', label: 'Amount', align: 'right', render: (row, doc) => formatMinor(row.amountMinor, doc?.currency) },
];

const taxSummary = [
  { key: 'taxablePaise', label: 'Taxable', format: formatPaise },
  { key: 'cgstPaise', label: 'CGST', format: formatPaise },
  { key: 'sgstPaise', label: 'SGST', format: formatPaise },
  { key: 'igstPaise', label: 'IGST', format: formatPaise },
  { key: 'roundOffPaise', label: 'Round-off', format: formatPaise },
  { key: 'totalPaise', label: 'Total', format: formatPaise, strong: true },
];

export const RESOURCES = {
  /* ---------- Masters ---------- */
  items: {
    canImport: true,
    kind: 'master', title: 'Items', single: 'Item', endpoint: '/items', read: 'items.read', write: 'items.write',
    filters: [{ key: 'type', label: 'Type', options: option(ITEM_TYPES) }],
    columns: [{ key: 'code', label: 'Code' }, col('name', 'Name', undefined, { wrap: true }), col('type', 'Type', humanise), { key: 'uom', label: 'Unit' }, { key: 'hsn', label: 'HSN' }, { key: 'gstRateBps', label: 'GST', align: 'right', render: (r) => formatBps(r.gstRateBps) }, moneyCol('standardCostPaise', 'Std cost')],
    fields: [
      text('code', 'Code', { required: true }), text('name', 'Name', { required: true, wide: true }),
      { key: 'type', label: 'Type', type: 'select', options: option(ITEM_TYPES), required: true },
      text('uom', 'Unit', { default: 'NOS' }), text('hsn', 'HSN or SAC'),
      { key: 'gstRateBps', label: 'GST %', type: 'bps', default: 1800 }, { key: 'gstTreatment', label: 'GST treatment', type: 'select', required: true, default: 'TAXABLE', options: option(['TAXABLE', 'NIL', 'EXEMPT', 'NON_GST']) }, { key: 'showOnWebsite', label: 'Show on the website', type: 'check' }, { key: 'webDescription', label: 'Website description', type: 'textarea', wide: true, showIf: (v) => v.showOnWebsite, hint: 'The first JPEG, PNG or WebP file attached to the item is its picture' },
      text('materialGrade', 'Material grade'), text('drawingNo', 'Drawing no.'), text('drawingRev', 'Drawing rev.'),
      { key: 'standardCostPaise', label: 'Standard cost', type: 'money' }, { key: 'salePricePaise', label: 'Sale price', type: 'money' },
      { key: 'reorderLevelMilli', label: 'Reorder level', type: 'qty' }, { key: 'leadTimeDays', label: 'Lead time, days', type: 'integer' },
      { key: 'trackLot', label: 'Track heat or batch no.', type: 'check' }, { key: 'requiresInspection', label: 'Needs incoming inspection', type: 'check' },
      { key: 'itemGroupId', label: 'Item group', type: 'ref', ref: { endpoint: '/d/ItemGroup', labelOf: (r) => r.name } }, { key: 'brandId', label: 'Brand', type: 'ref', ref: { endpoint: '/d/Brand', labelOf: (r) => r.name } }, { key: 'manufacturerId', label: 'Manufacturer', type: 'ref', ref: { endpoint: '/d/Manufacturer', labelOf: (r) => r.name } }, { key: 'defaultSupplierId', label: 'Default supplier', type: 'ref', ref: supplier },
      { key: 'barcode', label: 'Barcode', type: 'text' }, { key: 'shelfLifeDays', label: 'Shelf life, days', type: 'integer' }, { key: 'weightMilli', label: 'Weight, kg', type: 'qty' }, { key: 'maxDiscountBps', label: 'Max discount %', type: 'bps' },
      { key: 'hasSerialNo', label: 'Has serial numbers', type: 'check' }, { key: 'isCapitalGoods', label: 'Capital goods', type: 'check' }, { key: 'isActive', label: 'Active', type: 'check', default: true, editOnly: true },
    ],
  },
  parties: {
    canImport: true,
    kind: 'master', title: 'Customers and suppliers', single: 'Party', endpoint: '/parties', read: 'parties.read', write: 'parties.write',
    filters: [{ key: 'isCustomer', label: 'Customers', options: [{ value: 'true', label: 'Yes' }] }, { key: 'isSupplier', label: 'Suppliers', options: [{ value: 'true', label: 'Yes' }] }, { key: 'isJobWorker', label: 'Job workers', options: [{ value: 'true', label: 'Yes' }] }],
    columns: [{ key: 'code', label: 'Code' }, col('name', 'Name', undefined, { wrap: true }), { key: 'gstin', label: 'GSTIN' }, { key: 'stateCode', label: 'State' }, { key: 'country', label: 'Country' }, { key: 'currency', label: 'Currency' }],
    fields: [
      text('code', 'Code', { required: true }), text('name', 'Name', { required: true, wide: true }),
      { key: 'isCustomer', label: 'Customer', type: 'check' }, { key: 'isSupplier', label: 'Supplier', type: 'check' }, { key: 'isJobWorker', label: 'Job worker', type: 'check' }, { key: 'isExport', label: 'Overseas', type: 'check' }, { key: 'isSez', label: 'In an SEZ', type: 'check' },
      text('gstin', 'GSTIN'), text('pan', 'PAN'), text('stateCode', 'GST state code', { hint: 'Two digits, like 24 for Gujarat' }), text('country', 'Country', { default: 'India' }), text('currency', 'Currency', { default: 'INR' }),
      { key: 'paymentTermsDays', label: 'Payment terms, days', type: 'integer', default: 30 },
      text('contactName', 'Contact'), text('email', 'Email'), text('phone', 'Phone'),
      { key: 'customerGroupId', label: 'Customer group', type: 'ref', ref: { endpoint: '/d/CustomerGroup', labelOf: (r) => r.name } }, { key: 'supplierGroupId', label: 'Supplier group', type: 'ref', ref: { endpoint: '/d/SupplierGroup', labelOf: (r) => r.name } }, { key: 'territoryId', label: 'Territory', type: 'ref', ref: { endpoint: '/d/Territory', labelOf: (r) => r.name } }, { key: 'salesPersonId', label: 'Sales person', type: 'ref', ref: { endpoint: '/d/SalesPerson', labelOf: (r) => r.name } }, { key: 'priceListId', label: 'Price list', type: 'ref', ref: { endpoint: '/d/PriceList', labelOf: (r) => r.name } },
      { key: 'creditLimitPaise', label: 'Credit limit', type: 'money' }, { key: 'isOnHold', label: 'On hold', type: 'check' },
      { key: 'address', label: 'Address', type: 'textarea', wide: true }, { key: 'isActive', label: 'Active', type: 'check', default: true, editOnly: true },
    ],
  },
  warehouses: {
    canImport: true,
    kind: 'master', title: 'Warehouses', single: 'Warehouse', endpoint: '/warehouses', read: 'warehouses.read', write: 'warehouses.write',
    columns: [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, col('kind', 'Kind', humanise), { key: 'plant', label: 'Plant' }],
    fields: [text('code', 'Code', { required: true }), text('name', 'Name', { required: true }), { key: 'kind', label: 'Kind', type: 'select', options: option(['STORES', 'QUARANTINE', 'REJECT', 'JOBWORK', 'FG']), required: true }, text('plant', 'Plant', { default: 'Main plant' }), { key: 'isActive', label: 'Active', type: 'check', default: true, editOnly: true }],
  },
  accounts: {
    canImport: true,
    kind: 'master', title: 'Chart of accounts', single: 'Account', endpoint: '/accounts', read: 'accounts.read', write: 'accounts.write',
    filters: [{ key: 'type', label: 'Type', options: option(['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']) }],
    columns: [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, col('type', 'Type', humanise), { key: 'group', label: 'Group' }],
    fields: [text('code', 'Code', { required: true, createOnly: true }), text('name', 'Name', { required: true }), { key: 'type', label: 'Type', type: 'select', createOnly: true, options: option(['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']), required: true }, text('group', 'Group'), { key: 'isCashOrBank', label: 'Cash or bank', type: 'check', createOnly: true }, { key: 'isActive', label: 'Active', type: 'check', default: true, editOnly: true }],
  },
  gauges: {
    kind: 'master', title: 'Gauges and calibration', single: 'Gauge', endpoint: '/gauges', read: 'gauges.read', write: 'gauges.write',
    columns: [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, dateCol('lastCalibratedOn', 'Calibrated'), dateCol('dueOn', 'Due'), { key: 'certRef', label: 'Certificate' }],
    fields: [text('code', 'Code', { required: true }), text('name', 'Name', { required: true }), { key: 'lastCalibratedOn', label: 'Last calibrated', type: 'date' }, { key: 'dueOn', label: 'Due on', type: 'date' }, text('certRef', 'Certificate ref.'), { key: 'isActive', label: 'Active', type: 'check', default: true, editOnly: true }],
  },

  /* ---------- Sales ---------- */
  quotations: {
    kind: 'document', title: 'Quotations', single: 'Quotation', printTitle: 'Quotation', endpoint: '/quotations', read: 'quotations.read', write: 'quotations.write', submitLabel: 'Send',
    filters: [{ key: 'status', label: 'Status', options: option(['DRAFT', 'SENT', 'WON', 'LOST', 'SUPERSEDED']) }],
    columns: [docNoCol, { key: 'revision', label: 'Rev' }, dateCol('postingDate', 'Date'), { key: 'partyName', label: 'Customer', wrap: true }, { key: 'subtotalMinor', label: 'Value', align: 'right', render: (r) => formatMinor(r.subtotalMinor, r.currency) }, statusCol],
    fields: [{ key: 'partyId', label: 'Customer', type: 'ref', ref: customer, required: true, wide: true }, text('currency', 'Currency', { default: 'INR' }), { key: 'fxRate4', label: 'Rate to INR', type: 'fx', hint: 'For a foreign currency' }, { key: 'postingDate', label: 'Date', type: 'date' }, { key: 'validUntil', label: 'Valid until', type: 'date' }, salesLines(), { key: 'terms', label: 'Terms', type: 'textarea', wide: true }],
    summary: [{ key: 'partyName', label: 'Customer' }, { key: 'revision', label: 'Revision' }, { key: 'postingDate', label: 'Date', format: formatDate }, { key: 'validUntil', label: 'Valid until', format: formatDate }, { key: 'currency', label: 'Currency' }, { key: 'lostReason', label: 'Lost because' }],
    lineColumns: salesLineColumns,
    totals: [{ key: 'subtotalMinor', label: 'Before tax', minor: true, strong: true }],
    noteKey: 'terms',
    actions: [
      { label: 'Revise', when: (d) => d.status === 'SENT', perm: 'quotations.write', path: 'revise', navigate: 'quotations' },
      { label: 'Won: make order', when: (d) => d.status === 'SENT', perm: 'salesOrders.write', path: 'to-order', navigate: 'salesOrders', primary: true },
      { label: 'Mark lost', when: (d) => d.status === 'SENT', perm: 'quotations.write', path: 'lost', prompt: { key: 'reason', label: 'Why was it lost?' } },
    ],
  },
  salesOrders: {
    meta: { dateField: 'deliveryDate', submittable: false, labelFields: ['docNo'], fields: [{ key: 'status', label: 'Status', type: 'select', computed: true, options: ['DRAFT', 'CONFIRMED', 'CLOSED', 'CANCELLED'] }, { key: 'postingDate', label: 'Ordered', type: 'date' }, { key: 'deliveryDate', label: 'Delivery', type: 'date' }] },
    kind: 'document', title: 'Sales orders', single: 'Sales order', printTitle: 'Order acknowledgement', endpoint: '/sales-orders', read: 'salesOrders.read', write: 'salesOrders.write', submitLabel: 'Confirm', submitHint: 'Confirming allots a serial number and opens a build for every machine.',
    filters: [{ key: 'status', label: 'Status', options: option(['DRAFT', 'CONFIRMED', 'CLOSED', 'CANCELLED']) }],
    columns: [docNoCol, dateCol('postingDate', 'Date'), { key: 'partyName', label: 'Customer', wrap: true }, { key: 'customerPoNo', label: 'Their PO' }, { key: 'subtotalMinor', label: 'Value', align: 'right', render: (r) => formatMinor(r.subtotalMinor, r.currency) }, dateCol('deliveryDate', 'Delivery'), statusCol],
    fields: [
      { key: 'partyId', label: 'Customer', type: 'ref', ref: customer, required: true, wide: true }, text('customerPoNo', 'Customer PO no.'), { key: 'postingDate', label: 'Date', type: 'date' }, { key: 'deliveryDate', label: 'Delivery date', type: 'date' }, text('currency', 'Currency', { default: 'INR' }), { key: 'fxRate4', label: 'Rate to INR', type: 'fx' }, { key: 'isExport', label: 'Export', type: 'check' }, text('incoterm', 'Incoterm'),
      salesLines(),
      { key: 'milestones', type: 'lines', label: 'Payment milestones', default: [{ no: 1, name: 'Advance with order', trigger: 'ORDER', pctBps: 3000 }, { no: 2, name: 'Before dispatch, after FAT', trigger: 'BEFORE_DISPATCH', pctBps: 6000 }, { no: 3, name: 'After installation', trigger: 'AFTER_INSTALLATION', pctBps: 1000 }], fields: [{ key: 'no', label: 'No.', type: 'integer', required: true }, { key: 'name', label: 'Name', type: 'text', required: true, wide: true }, { key: 'trigger', label: 'When', type: 'select', options: option(['ORDER', 'BEFORE_FAT', 'BEFORE_DISPATCH', 'AFTER_INSTALLATION']), required: true }, { key: 'pctBps', label: '%', type: 'bps', required: true }] },
      { key: 'terms', label: 'Terms', type: 'textarea', wide: true },
    ],
    summary: [{ key: 'partyName', label: 'Customer' }, { key: 'customerPoNo', label: 'Customer PO' }, { key: 'postingDate', label: 'Date', format: formatDate }, { key: 'deliveryDate', label: 'Delivery', format: formatDate }, { key: 'currency', label: 'Currency' }, { key: 'incoterm', label: 'Incoterm' }],
    lineColumns: salesLineColumns,
    totals: [{ key: 'subtotalMinor', label: 'Before tax', minor: true, strong: true }],
    extraTables: [{ title: 'Payment milestones', key: 'milestones', rowKey: (r) => r.no, columns: [{ key: 'no', label: 'No.' }, { key: 'name', label: 'Milestone' }, col('trigger', 'When', humanise), { key: 'pctBps', label: '%', align: 'right', render: (r) => formatBps(r.pctBps) }, { key: 'amountMinor', label: 'Due', align: 'right', render: (r, d) => formatMinor(r.amountMinor, d?.currency) }, { key: 'receivedMinor', label: 'Received', align: 'right', render: (r, d) => formatMinor(r.receivedMinor, d?.currency) }] }],
    noteKey: 'terms',
    actions: [
      { label: 'See builds', when: (d) => d.status === 'CONFIRMED', link: (d) => `/builds?salesOrderId=${d.id}` },
      { label: 'Record receipt', when: (d) => d.status === 'CONFIRMED', perm: 'payments.write', link: (d) => `/payments/new?kind=RECEIPT&partyId=${d.partyId}&salesOrderId=${d.id}&currency=${d.currency}&fxRate4=${d.fxRate4}` },
    ],
  },
  salesInvoices: {
    meta: { dateField: 'dueDate', submittable: false, labelFields: ['docNo'], fields: [{ key: 'status', label: 'Status', type: 'select', computed: true, options: ['DRAFT', 'SUBMITTED', 'CANCELLED'] }, { key: 'postingDate', label: 'Invoice date', type: 'date' }, { key: 'dueDate', label: 'Due', type: 'date' }] },
    kind: 'document', title: 'Sales invoices', single: 'Sales invoice', printTitle: 'Tax invoice', endpoint: '/sales-invoices', read: 'salesInvoices.read', write: 'salesInvoices.write', submitLabel: 'Post and dispatch', submitHint: 'The invoice travels with the goods, so posting also takes them out of stock. For a machine, the money due before dispatch must be in.',
    submitPrompts: [{ key: 'milestoneOverrideReason', label: 'If payment is still due, why dispatch anyway? (management only)', optional: true }, { key: 'creditOverrideReason', label: 'If over the credit limit, why go ahead? (management only)', optional: true }],
    filters: [{ key: 'status', label: 'Status', options: option(['DRAFT', 'SUBMITTED', 'CANCELLED']) }],
    columns: [docNoCol, dateCol('postingDate', 'Date'), { key: 'partyName', label: 'Customer', wrap: true }, moneyCol('totalPaise', 'Total'), { key: 'due', label: 'Unpaid', align: 'right', render: (r) => formatPaise(r.totalPaise - r.paidPaise - r.creditedPaise) }, statusCol],
    fields: [
      { key: 'partyId', label: 'Customer', type: 'ref', ref: customer, required: true, wide: true }, { key: 'postingDate', label: 'Date', type: 'date' }, text('currency', 'Currency', { default: 'INR' }), { key: 'fxRate4', label: 'Rate to INR', type: 'fx' }, { key: 'isExport', label: 'Export', type: 'check' }, { key: 'exportUnderLut', label: 'Export or SEZ under LUT', type: 'check', default: true }, text('placeOfSupplyState', 'Place of supply, state code', { hint: 'If the goods go somewhere other than the customer\'s state' }), text('vehicleNo', 'Vehicle no.'), text('transporter', 'Transporter'), text('lrNo', 'LR no.'), text('ewayBillNo', 'E-way bill no.'), text('shippingBillNo', 'Shipping bill no.'),
      { key: 'lines', type: 'lines', label: 'Lines', fields: [
        { key: 'kind', label: 'Kind', type: 'select', options: option(['MACHINE', 'GOODS', 'SERVICE']), required: true, default: 'GOODS' },
        { key: 'buildId', label: 'Machine', type: 'ref', ref: { ...build, params: { stage: 'READY' } }, wide: true, showIf: (line) => line.kind === 'MACHINE' },
        { key: 'itemId', label: 'Item', type: 'ref', ref: stockItem, wide: true, showIf: (line) => line.kind !== 'MACHINE', onPick: (r) => ({ rateMinor: r.salePricePaise ?? 0, gstRateBps: r.gstRateBps }) },
        { key: 'qtyMilli', label: 'Qty', type: 'qty', showIf: (line) => line.kind !== 'MACHINE' },
        { key: 'rateMinor', label: 'Rate', type: 'money', required: true }, { key: 'discountBps', label: 'Disc. %', type: 'bps' }, { key: 'gstRateBps', label: 'GST %', type: 'bps' },
      ] },
    ],
    summary: [{ key: 'partyName', label: 'Customer' }, { key: 'partyGstin', label: 'GSTIN' }, { key: 'postingDate', label: 'Date', format: formatDate }, { key: 'dueDate', label: 'Due', format: formatDate }, { key: 'placeOfSupply', label: 'Place of supply' }, { key: 'supplyType', label: 'Supply', format: humanise }, { key: 'currency', label: 'Currency' }, { key: 'fxRate4', label: 'Rate', format: formatFx }, { key: 'lutNumber', label: 'LUT no.' }, { key: 'vehicleNo', label: 'Vehicle' }, { key: 'transporter', label: 'Transporter' }, { key: 'lrNo', label: 'LR no.' }, { key: 'ewayBillNo', label: 'E-way bill' }, { key: 'shippingBillNo', label: 'Shipping bill' }, { key: 'irn', label: 'IRN' }, { key: 'irnAckNo', label: 'IRN ack. no.' }, { key: 'irnAckAt', label: 'IRN ack. time', format: formatDateTime }, { key: 'irnCancelledAt', label: 'IRN cancelled', format: formatDateTime }, { key: 'milestoneOverrideReason', label: 'Dispatched before payment because' }],
    lineColumns: [lineFrozen, { key: 'serialNo', label: 'Serial no.' }, { key: 'hsn', label: 'HSN' }, qtyCol('qtyMilli', 'Qty'), { key: 'rateMinor', label: 'Rate', align: 'right', render: (r, d) => formatMinor(r.rateMinor, d?.currency) }, { key: 'gstRateBps', label: 'GST', align: 'right', render: (r) => formatBps(r.gstRateBps) }, moneyCol('taxablePaise', 'Taxable')],
    totals: taxSummary,
    showAmountInWords: true,
    actions: [
      { label: 'Record receipt', when: (d) => d.status === 'SUBMITTED' && d.totalPaise - d.paidPaise - d.creditedPaise > 0, perm: 'payments.write', link: (d) => `/payments/new?kind=RECEIPT&partyId=${d.partyId}&currency=${d.currency}&fxRate4=${d.fxRate4}` },
      { label: 'Credit note', when: (d) => d.status === 'SUBMITTED', perm: 'payments.write', link: (d) => `/notes/new?kind=CREDIT&invoiceId=${d.id}` },
      { label: 'E-invoice file', when: (d) => d.status === 'SUBMITTED', save: (d) => [`/sales-invoices/${d.id}/einvoice.json`, `einvoice-${d.docNo.replace(/\//g, '-')}.json`] },
      { label: 'Record IRN', when: (d) => d.status === 'SUBMITTED' && !d.isOpening && (!d.irn || d.irnCancelledAt), perm: 'salesInvoices.write', path: 'irn', form: { title: 'Record the IRN from the portal', fields: [{ key: 'irn', label: 'IRN', type: 'text', required: true }, { key: 'ackNo', label: 'Ack. no.', type: 'text', required: true }, { key: 'ackAt', label: 'Ack. date and time', type: 'datetime', required: true }] } },
      { label: 'IRN was cancelled', when: (d) => Boolean(d.irn) && !d.irnCancelledAt, perm: 'salesInvoices.write', path: 'irn-cancelled', prompt: { key: 'reason', label: 'Why? The portal allows this within 24 hours.' } },
      { label: 'E-way bill file', when: (d) => d.status === 'SUBMITTED', save: (d) => [`/sales-invoices/${d.id}/eway-bill.json`, `eway-${d.docNo.replace(/\//g, '-')}.json`] },
    ],
  },

  /* ---------- Purchase ---------- */
  purchaseOrders: {
    meta: { dateField: 'expectedDate', submittable: false, labelFields: ['docNo'], fields: [{ key: 'status', label: 'Status', type: 'select', computed: true, options: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'CLOSED', 'CANCELLED'] }, { key: 'postingDate', label: 'Ordered', type: 'date' }, { key: 'expectedDate', label: 'Expected', type: 'date' }] },
    kind: 'document', title: 'Purchase orders', single: 'Purchase order', printTitle: 'Purchase order', endpoint: '/purchase-orders', read: 'purchaseOrders.read', write: 'purchaseOrders.write',
    filters: [{ key: 'status', label: 'Status', options: option(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'CLOSED', 'CANCELLED']) }],
    columns: [docNoCol, dateCol('postingDate', 'Date'), { key: 'partyName', label: 'Supplier', wrap: true }, moneyCol('totalPaise', 'Total'), dateCol('expectedDate', 'Expected'), statusCol],
    fields: [{ key: 'partyId', label: 'Supplier', type: 'ref', ref: supplier, required: true, wide: true }, { key: 'postingDate', label: 'Date', type: 'date' }, { key: 'expectedDate', label: 'Expected', type: 'date' }, { key: 'lines', type: 'lines', label: 'Lines', fields: [{ key: 'itemId', label: 'Item', type: 'ref', ref: stockItem, required: true, wide: true, quote: 'buying', onPick: (r) => ({ ratePaise: r.standardCostPaise ?? 0, gstRateBps: r.gstRateBps }) }, { key: 'qtyMilli', label: 'Qty', type: 'qty', required: true }, { key: 'ratePaise', label: 'Rate', type: 'money', required: true }, { key: 'gstRateBps', label: 'GST %', type: 'bps' }, { key: 'buildId', label: 'For build', type: 'ref', ref: build }] }, { key: 'terms', label: 'Terms', type: 'textarea', wide: true }],
    summary: [{ key: 'partyName', label: 'Supplier' }, { key: 'postingDate', label: 'Date', format: formatDate }, { key: 'expectedDate', label: 'Expected', format: formatDate }, { key: 'supplyType', label: 'Supply', format: humanise }],
    lineColumns: [lineFrozen, { key: 'serialNo', label: 'For build' }, qtyCol('qtyMilli', 'Qty'), { key: 'ratePaise', label: 'Rate', align: 'right', render: (r) => formatPaise(r.ratePaise) }, { key: 'gstRateBps', label: 'GST', align: 'right', render: (r) => formatBps(r.gstRateBps) }, qtyCol('receivedMilli', 'Received')],
    totals: [{ key: 'taxablePaise', label: 'Taxable', format: formatPaise }, { key: 'taxPaise', label: 'GST', format: formatPaise }, { key: 'totalPaise', label: 'Total', format: formatPaise, strong: true }],
    noteKey: 'terms',
    actions: [
      { label: 'Approve', when: (d) => d.status === 'PENDING_APPROVAL', perm: 'purchaseOrders.approve', path: 'approve', primary: true },
      { label: 'Receive goods', when: (d) => d.status === 'APPROVED', perm: 'grns.write', link: (d) => `/grns/new?purchaseOrderId=${d.id}`, primary: true },
    ],
  },
  grns: {
    kind: 'document', title: 'Goods receipts', single: 'Goods receipt', printTitle: 'Goods receipt note', endpoint: '/grns', read: 'grns.read', write: 'grns.write',
    filters: [{ key: 'status', label: 'Status', options: option(['DRAFT', 'SUBMITTED', 'CANCELLED']) }],
    columns: [docNoCol, dateCol('postingDate', 'Date'), { key: 'partyName', label: 'Supplier', wrap: true }, { key: 'purchaseOrderNo', label: 'PO' }, { key: 'supplierChallanNo', label: 'Their challan' }, moneyCol('totalValuePaise', 'Value'), statusCol],
    prefill: { param: 'purchaseOrderId', endpoint: '/purchase-orders', map: (po) => ({ purchaseOrderId: po.id, lines: po.lines.filter((l) => l.qtyMilli > l.receivedMilli).map((l) => ({ poLineId: l.id, _label: `${l.itemCode} · ${l.itemName}`, qtyMilli: l.qtyMilli - l.receivedMilli, lot: '', certRef: '' })) }) },
    fields: [{ key: 'purchaseOrderId', label: 'Purchase order', type: 'ref', ref: { endpoint: '/purchase-orders', params: { status: 'APPROVED' }, labelOf: (r) => `${r.docNo} · ${r.partyName}` }, required: true, wide: true, prefillOnPick: true }, text('supplierChallanNo', 'Supplier challan no.'), { key: 'postingDate', label: 'Date', type: 'date' }, { key: 'lines', type: 'lines', label: 'Lines', fixed: true, fields: [{ key: 'poLineId', hidden: true }, { key: '_label', label: 'Item', display: true, wide: true }, { key: 'qtyMilli', label: 'Qty received', type: 'qty', required: true }, { key: 'lot', label: 'Heat or batch', type: 'text' }, { key: 'certRef', label: 'Certificate', type: 'text' }] }],
    summary: [{ key: 'partyName', label: 'Supplier' }, { key: 'purchaseOrderNo', label: 'Purchase order' }, { key: 'supplierChallanNo', label: 'Supplier challan' }, { key: 'postingDate', label: 'Date', format: formatDate }],
    lineColumns: [lineFrozen, { key: 'lot', label: 'Heat or batch' }, { key: 'certRef', label: 'Certificate' }, qtyCol('qtyMilli', 'Received'), qtyCol('acceptedMilli', 'Accepted'), qtyCol('rejectedMilli', 'Rejected'), qtyCol('billedMilli', 'Billed'), moneyCol('valuePaise', 'Value')],
    totals: [{ key: 'totalValuePaise', label: 'Value', format: formatPaise, strong: true }],
    actions: [
      { label: 'Inspect', when: (d) => d.status === 'SUBMITTED' && d.lines.some((l) => l.requiresInspection && l.acceptedMilli + l.rejectedMilli < l.qtyMilli), perm: 'inspections.write', link: (d) => `/inspections/new?grnId=${d.id}`, primary: true },
      { label: 'Book supplier invoice', when: (d) => d.status === 'SUBMITTED' && d.lines.some((l) => l.billedMilli < l.qtyMilli), perm: 'purchaseInvoices.write', link: (d) => `/purchaseInvoices/new?grnId=${d.id}` },
    ],
  },
  inspections: {
    kind: 'document', title: 'Incoming inspection', single: 'Inspection', printTitle: 'Incoming inspection report', endpoint: '/inspections', read: 'inspections.read', write: 'inspections.write', submitHint: 'Accepted goods move to stores. Rejected goods move to the reject warehouse and raise an NCR.',
    filters: [{ key: 'status', label: 'Status', options: option(['DRAFT', 'SUBMITTED', 'CANCELLED']) }],
    columns: [docNoCol, dateCol('postingDate', 'Date'), { key: 'grnNo', label: 'Goods receipt' }, { key: 'partyName', label: 'Supplier', wrap: true }, { key: 'inspectorName', label: 'Inspector' }, statusCol],
    prefill: { param: 'grnId', endpoint: '/grns', map: (g) => ({ grnId: g.id, lines: g.lines.filter((l) => l.requiresInspection && l.acceptedMilli + l.rejectedMilli < l.qtyMilli).map((l) => ({ grnLineId: l.id, _label: `${l.itemCode} · ${l.itemName} ${l.lot ? `(${l.lot})` : ''}`, acceptedMilli: l.qtyMilli - l.acceptedMilli - l.rejectedMilli, rejectedMilli: 0, certVerified: false, observations: '' })) }) },
    fields: [{ key: 'grnId', label: 'Goods receipt', type: 'ref', ref: { endpoint: '/grns', params: { status: 'SUBMITTED' }, labelOf: (r) => `${r.docNo} · ${r.partyName}` }, required: true, wide: true, prefillOnPick: true }, text('inspectorName', 'Inspector'), { key: 'postingDate', label: 'Date', type: 'date' }, { key: 'lines', type: 'lines', label: 'Lines', fixed: true, fields: [{ key: 'grnLineId', hidden: true }, { key: '_label', label: 'Item', display: true, wide: true }, { key: 'acceptedMilli', label: 'Accepted', type: 'qty' }, { key: 'rejectedMilli', label: 'Rejected', type: 'qty' }, { key: 'certVerified', label: 'Cert. checked', type: 'check' }, { key: 'observations', label: 'Observations', type: 'text' }] }],
    summary: [{ key: 'grnNo', label: 'Goods receipt' }, { key: 'partyName', label: 'Supplier' }, { key: 'inspectorName', label: 'Inspector' }, { key: 'postingDate', label: 'Date', format: formatDate }],
    lineColumns: [lineFrozen, { key: 'lot', label: 'Heat or batch' }, qtyCol('receivedMilli', 'Received'), qtyCol('acceptedMilli', 'Accepted'), qtyCol('rejectedMilli', 'Rejected'), { key: 'certVerified', label: 'Cert.', render: (r) => (r.certVerified ? 'Checked' : 'No') }, { key: 'observations', label: 'Observations', wrap: true }],
  },
  purchaseInvoices: {
    kind: 'document', title: 'Purchase invoices', single: 'Purchase invoice', endpoint: '/purchase-invoices', read: 'purchaseInvoices.read', write: 'purchaseInvoices.write',
    filters: [{ key: 'status', label: 'Status', options: option(['DRAFT', 'SUBMITTED', 'CANCELLED']) }],
    columns: [docNoCol, dateCol('postingDate', 'Date'), { key: 'partyName', label: 'Supplier', wrap: true }, { key: 'supplierInvoiceNo', label: 'Their invoice' }, moneyCol('totalPaise', 'Total'), { key: 'due', label: 'Unpaid', align: 'right', render: (r) => formatPaise(r.totalPaise - r.paidPaise - r.creditedPaise) }, statusCol],
    prefill: { param: 'grnId', endpoint: '/grns', map: (g) => ({ partyId: g.partyId, lines: g.lines.filter((l) => l.billedMilli < l.qtyMilli).map((l) => ({ kind: 'GOODS', grnId: g.id, grnLineId: l.id, _label: `${g.docNo}: ${l.itemCode} · ${l.itemName}`, qtyMilli: l.qtyMilli - l.billedMilli, ratePaise: l.ratePaise, gstRateBps: l.gstRateBps })) }) },
    fields: [
      { key: 'partyId', label: 'Supplier', type: 'ref', ref: anyParty, required: true, wide: true }, text('supplierInvoiceNo', 'Supplier invoice no.', { required: true }), { key: 'supplierInvoiceDate', label: 'Supplier invoice date', type: 'date', required: true }, { key: 'postingDate', label: 'Posting date', type: 'date' }, { key: 'dueDate', label: 'Due', type: 'date' }, { key: 'isReverseCharge', label: 'Reverse charge', type: 'check' },
      { key: 'lines', type: 'lines', label: 'Lines', fields: [
        { key: 'kind', label: 'Kind', type: 'select', options: option(['GOODS', 'SERVICE']), required: true, default: 'SERVICE' },
        { key: 'grnId', hidden: true }, { key: 'grnLineId', hidden: true }, { key: '_label', label: 'From receipt', display: true, wide: true, showIf: (l) => l.kind === 'GOODS' },
        { key: 'description', label: 'Description', type: 'text', wide: true, showIf: (l) => l.kind === 'SERVICE' }, { key: 'hsn', label: 'SAC', type: 'text', showIf: (l) => l.kind === 'SERVICE' },
        { key: 'buildId', label: 'For build', type: 'ref', ref: build, showIf: (l) => l.kind === 'SERVICE' }, { key: 'expenseAccountCode', label: 'Or expense account', type: 'ref', ref: { ...account, params: { type: 'EXPENSE' }, valueKey: 'code', byCode: true }, showIf: (l) => l.kind === 'SERVICE' },
        { key: 'qtyMilli', label: 'Qty', type: 'qty', required: true }, { key: 'ratePaise', label: 'Rate', type: 'money', required: true }, { key: 'gstRateBps', label: 'GST %', type: 'bps' }, { key: 'itcBlocked', label: 'Credit blocked', type: 'check' },
        { key: 'costCenterId', label: 'Cost centre', type: 'ref', ref: { endpoint: '/d/CostCenter', labelOf: (r) => r.name }, showIf: (l) => l.kind === 'SERVICE' }, { key: 'projectId', label: 'Project', type: 'ref', ref: { endpoint: '/d/Project', labelOf: (r) => r.name }, showIf: (l) => l.kind === 'SERVICE' },
      ] },
    ],
    summary: [{ key: 'partyName', label: 'Supplier' }, { key: 'isReverseCharge', label: 'Reverse charge', format: (v) => (v ? 'Yes' : 'No') }, { key: 'blockedTaxPaise', label: 'Blocked credit', format: formatPaise }, { key: 'supplierGstin', label: 'GSTIN' }, { key: 'supplierInvoiceNo', label: 'Their invoice' }, { key: 'supplierInvoiceDate', label: 'Their date', format: formatDate }, { key: 'postingDate', label: 'Posted', format: formatDate }, { key: 'dueDate', label: 'Due', format: formatDate }],
    lineColumns: [lineFrozen, { key: 'grnNo', label: 'Receipt' }, qtyCol('qtyMilli', 'Qty'), { key: 'ratePaise', label: 'Rate', align: 'right', render: (r) => formatPaise(r.ratePaise) }, { key: 'gstRateBps', label: 'GST', align: 'right', render: (r) => formatBps(r.gstRateBps) }, moneyCol('taxablePaise', 'Taxable')],
    totals: taxSummary,
    actions: [
      { label: 'Pay', when: (d) => d.status === 'SUBMITTED' && d.totalPaise - d.paidPaise - d.creditedPaise > 0, perm: 'payments.write', link: (d) => `/payments/new?kind=PAYMENT&partyId=${d.partyId}`, primary: true },
      { label: 'Debit note', when: (d) => d.status === 'SUBMITTED', perm: 'payments.write', link: (d) => `/notes/new?kind=DEBIT&invoiceId=${d.id}` },
    ],
  },

  /* ---------- Stores ---------- */
  stockMoves: {
    kind: 'document', title: 'Stock moves', single: 'Stock move', endpoint: '/stock-moves', read: 'stock.read', write: 'stock.write',
    filters: [{ key: 'kind', label: 'Kind', options: option(['TRANSFER', 'RESERVE', 'UNRESERVE', 'ADJUST_IN', 'ADJUST_OUT', 'OPENING']) }, { key: 'status', label: 'Status', options: option(['DRAFT', 'SUBMITTED', 'CANCELLED']) }],
    columns: [docNoCol, dateCol('postingDate', 'Date'), col('kind', 'Kind', humanise), { key: 'reason', label: 'Reason', wrap: true }, moneyCol('totalValuePaise', 'Value'), statusCol],
    fields: [{ key: 'kind', label: 'Kind', type: 'select', options: option(['TRANSFER', 'RESERVE', 'UNRESERVE', 'ADJUST_IN', 'ADJUST_OUT', 'OPENING']), required: true, default: 'TRANSFER' }, { key: 'postingDate', label: 'Date', type: 'date' }, text('reason', 'Reason', { wide: true }), { key: 'lines', type: 'lines', label: 'Lines', fields: [{ key: 'itemId', label: 'Item', type: 'ref', ref: stockItem, required: true, wide: true }, { key: 'qtyMilli', label: 'Qty', type: 'qty', required: true }, { key: 'fromWarehouseId', label: 'From', type: 'ref', ref: warehouse }, { key: 'toWarehouseId', label: 'To', type: 'ref', ref: warehouse }, { key: 'fromBuildId', label: 'From build', type: 'ref', ref: build }, { key: 'toBuildId', label: 'To build', type: 'ref', ref: build }, { key: 'lot', label: 'Heat or batch', type: 'text' }, { key: 'ratePaise', label: 'Rate (inward)', type: 'money' }] }],
    summary: [{ key: 'kind', label: 'Kind', format: humanise }, { key: 'reason', label: 'Reason' }, { key: 'postingDate', label: 'Date', format: formatDate }],
    lineColumns: [lineFrozen, { key: 'lot', label: 'Heat or batch' }, qtyCol('qtyMilli', 'Qty'), moneyCol('valuePaise', 'Value')],
    totals: [{ key: 'totalValuePaise', label: 'Value', format: formatPaise, strong: true }],
  },
  materialIssues: {
    kind: 'document', title: 'Material issues', single: 'Material issue', printTitle: 'Material issue slip', endpoint: '/material-issues', read: 'builds.read', write: 'issues.write', submitHint: 'Takes stock set aside for this build first, then free stock.',
    filters: [{ key: 'direction', label: 'Direction', options: option(['ISSUE', 'RETURN']) }, { key: 'status', label: 'Status', options: option(['DRAFT', 'SUBMITTED', 'CANCELLED']) }],
    columns: [docNoCol, dateCol('postingDate', 'Date'), { key: 'serialNo', label: 'Build' }, col('direction', 'Direction', humanise), moneyCol('totalValuePaise', 'Value'), statusCol],
    prefill: { param: 'buildId', endpoint: '/builds', map: (b) => ({ buildId: b.id, direction: 'ISSUE', lines: b.materials.filter((m) => m.requiredMilli > m.issuedMilli).map((m) => ({ itemId: m.itemId, qtyMilli: m.requiredMilli - m.issuedMilli })) }) },
    fields: [{ key: 'buildId', label: 'Build', type: 'ref', ref: build, required: true, wide: true }, { key: 'direction', label: 'Direction', type: 'select', options: option(['ISSUE', 'RETURN']), default: 'ISSUE' }, { key: 'postingDate', label: 'Date', type: 'date' }, { key: 'lines', type: 'lines', label: 'Lines', fields: [{ key: 'itemId', label: 'Item', type: 'ref', ref: stockItem, required: true, wide: true }, { key: 'qtyMilli', label: 'Qty', type: 'qty', required: true }] }],
    summary: [{ key: 'serialNo', label: 'Build' }, { key: 'direction', label: 'Direction', format: humanise }, { key: 'postingDate', label: 'Date', format: formatDate }],
    lineColumns: [lineFrozen, qtyCol('qtyMilli', 'Qty'), { key: 'uom', label: 'Unit' }, { key: 'lots', label: 'Heat or batch', render: (r) => (r.picks ?? []).map((p) => p.lot).filter(Boolean).join(', ') }, moneyCol('valuePaise', 'Value')],
    totals: [{ key: 'totalValuePaise', label: 'Value', format: formatPaise, strong: true }],
  },
  timeBookings: {
    kind: 'document', title: 'Labour bookings', single: 'Labour booking', endpoint: '/time-bookings', read: 'time.read', write: 'time.write',
    filters: [{ key: 'status', label: 'Status', options: option(['DRAFT', 'SUBMITTED', 'CANCELLED']) }],
    columns: [docNoCol, dateCol('postingDate', 'Date'), { key: 'serialNo', label: 'Build' }, { key: 'operation', label: 'Operation' }, { key: 'employeeName', label: 'Who' }, { key: 'hoursMilli', label: 'Hours', align: 'right', render: (r) => formatQty(r.hoursMilli) }, moneyCol('valuePaise', 'Value'), statusCol],
    fields: [{ key: 'buildId', label: 'Build', type: 'ref', ref: build, required: true, wide: true }, text('operation', 'Operation', { required: true }), text('employeeName', 'Who', { required: true }), { key: 'hoursMilli', label: 'Hours', type: 'qty', required: true }, { key: 'ratePaise', label: 'Rate per hour', type: 'money', hint: 'Blank uses the rate in Settings' }, { key: 'postingDate', label: 'Date', type: 'date' }],
    summary: [{ key: 'serialNo', label: 'Build' }, { key: 'operation', label: 'Operation' }, { key: 'employeeName', label: 'Who' }, { key: 'hoursMilli', label: 'Hours', format: formatQty }, { key: 'ratePaise', label: 'Rate', format: formatPaise }, { key: 'valuePaise', label: 'Value', format: formatPaise }, { key: 'postingDate', label: 'Date', format: formatDate }],
  },
  jobWork: {
    kind: 'document', title: 'Job work challans', single: 'Job work challan', printTitle: 'Job work challan (GST rule 45)', endpoint: '/job-work', read: 'jobWork.read', write: 'jobWork.write', submitLabel: 'Send', submitHint: 'The goods stay yours. The stock moves to the job work warehouse, and the return deadline starts.',
    filters: [{ key: 'status', label: 'Status', options: option(['DRAFT', 'SENT', 'PARTLY_RETURNED', 'RETURNED', 'CANCELLED']) }],
    columns: [docNoCol, dateCol('postingDate', 'Date'), { key: 'partyName', label: 'Job worker', wrap: true }, { key: 'process', label: 'Process' }, { key: 'serialNo', label: 'Build' }, dateCol('returnBy', 'Return by'), statusCol],
    fields: [{ key: 'partyId', label: 'Job worker', type: 'ref', ref: jobWorker, required: true, wide: true }, text('process', 'Process'), { key: 'buildId', label: 'For build', type: 'ref', ref: build }, { key: 'postingDate', label: 'Date', type: 'date' }, { key: 'lines', type: 'lines', label: 'Goods sent', fields: [{ key: 'itemId', label: 'Item', type: 'ref', ref: stockItem, required: true, wide: true }, { key: 'qtyMilli', label: 'Qty', type: 'qty', required: true }, { key: 'fromWarehouseId', label: 'From', type: 'ref', ref: { ...warehouse, params: { kind: 'STORES' } }, required: true }, { key: 'lot', label: 'Heat or batch', type: 'text' }] }],
    summary: [{ key: 'partyName', label: 'Job worker' }, { key: 'process', label: 'Process' }, { key: 'serialNo', label: 'Build' }, { key: 'postingDate', label: 'Sent', format: formatDate }, { key: 'returnBy', label: 'Return by', format: formatDate }],
    lineColumns: [lineFrozen, { key: 'lot', label: 'Heat or batch' }, qtyCol('qtyMilli', 'Sent'), qtyCol('consumedMilli', 'Came back'), moneyCol('valuePaise', 'Value')],
    totals: [{ key: 'totalValuePaise', label: 'Value', format: formatPaise, strong: true }],
    extraTables: [{ title: 'Goods back', key: 'receipts', columns: [{ key: 'docNo', label: 'Number' }, dateCol('postingDate', 'Date'), { key: 'outputItemName', label: 'Came back as', wrap: true }, qtyCol('consumedMilli', 'Used'), qtyCol('outputMilli', 'Output'), { key: 'supplierChallanNo', label: 'Their challan' }, moneyCol('valuePaise', 'Value')] }],
    actions: [{
      label: 'Receive goods back', when: (d) => ['SENT', 'PARTLY_RETURNED'].includes(d.status), perm: 'jobWork.write', path: 'receive', primary: true,
      form: {
        title: 'Goods back from the job worker',
        fields: [
          { key: 'lineId', label: 'Line sent', type: 'select', required: true, optionsFrom: (d) => d.lines.filter((l) => l.consumedMilli < l.qtyMilli).map((l) => ({ value: l.id, label: `${l.itemCode}, ${formatQty(l.qtyMilli - l.consumedMilli)} left` })) },
          { key: 'consumedMilli', label: 'Quantity of that used', type: 'qty', required: true },
          { key: 'outputItemId', label: 'Came back as', type: 'ref', ref: stockItem, required: true },
          { key: 'outputMilli', label: 'Quantity back', type: 'qty', required: true },
          { key: 'supplierChallanNo', label: 'Their challan no.', type: 'text' },
          { key: 'lot', label: 'Heat or batch', type: 'text' },
        ],
      },
    }],
  },

  /* ---------- Accounts ---------- */
  payments: {
    kind: 'document', title: 'Receipts and payments', single: 'Receipt or payment', endpoint: '/payments', read: 'payments.read', write: 'payments.write',
    filters: [{ key: 'kind', label: 'Kind', options: option(['RECEIPT', 'PAYMENT']) }, { key: 'status', label: 'Status', options: option(['DRAFT', 'SUBMITTED', 'CANCELLED']) }],
    columns: [docNoCol, dateCol('postingDate', 'Date'), col('kind', 'Kind', humanise), { key: 'partyName', label: 'Party', wrap: true }, { key: 'reference', label: 'Reference' }, { key: 'amountMinor', label: 'Amount', align: 'right', render: (r) => formatMinor(r.amountMinor, r.currency) }, { key: 'free', label: 'Not allocated', align: 'right', render: (r) => formatMinor(r.amountMinor - r.allocatedMinor, r.currency) }, statusCol],
    fromQuery: ['kind', 'partyId', 'salesOrderId', 'currency', 'fxRate4'],
    fields: [{ key: 'kind', label: 'Kind', type: 'select', options: option(['RECEIPT', 'PAYMENT']), required: true, default: 'RECEIPT' }, { key: 'partyId', label: 'Party', type: 'ref', ref: anyParty, required: true, wide: true }, { key: 'bankAccountCode', label: 'Bank or cash', type: 'ref', ref: { ...bank, valueKey: 'code', byCode: true }, required: true, default: '1120' }, { key: 'amountMinor', label: 'Amount', type: 'money', required: true }, text('currency', 'Currency', { default: 'INR' }), { key: 'fxRate4', label: 'Rate to INR', type: 'fx' }, text('reference', 'Reference'), { key: 'postingDate', label: 'Date', type: 'date' }, { key: 'salesOrderId', label: 'Against order', type: 'ref', ref: { endpoint: '/sales-orders', params: { status: 'CONFIRMED' }, labelOf: (r) => `${r.docNo} · ${r.partyName}` } }, { key: 'milestoneNo', label: 'Milestone no.', type: 'integer' }, { key: 'deductions', type: 'lines', label: 'Deductions: TDS, bank charges, write-off', fields: [{ key: 'accountCode', label: 'Account', type: 'ref', ref: { ...account, valueKey: 'code', byCode: true }, required: true, wide: true }, { key: 'amountPaise', label: 'Amount', type: 'money', required: true }, { key: 'description', label: 'For', type: 'text' }] }],
    summary: [{ key: 'kind', label: 'Kind', format: humanise }, { key: 'partyName', label: 'Party' }, { key: 'bankAccountCode', label: 'Account' }, { key: 'reference', label: 'Reference' }, { key: 'postingDate', label: 'Date', format: formatDate }, { key: 'currency', label: 'Currency' }, { key: 'fxRate4', label: 'Rate', format: formatFx }, { key: 'amountPaise', label: 'In rupees', format: formatPaise }, { key: 'deductionsPaise', label: 'Deductions', format: formatPaise }, { key: 'milestoneNo', label: 'Milestone' }],
    extraTables: [{ title: 'Deductions', key: 'deductions', columns: [{ key: 'accountCode', label: 'Account' }, { key: 'description', label: 'For', wrap: true }, moneyCol('amountPaise', 'Amount')] }, { title: 'Allocated to', key: 'allocations', columns: [{ key: 'docNo', label: 'Invoice' }, dateCol('allocatedOn', 'On'), { key: 'amountMinor', label: 'Amount', align: 'right', render: (r, d) => formatMinor(r.amountMinor, d?.currency) }, moneyCol('forexPaise', 'Exchange difference')] }],
    actions: [{
      label: 'Undo an allocation',
      when: (d) => d.status === 'SUBMITTED' && d.allocations.length > 0,
      perm: 'payments.write',
      path: 'unallocate',
      form: { title: 'Take an allocation back', fields: [{ key: 'allocationId', label: 'Allocation', type: 'select', required: true, optionsFrom: (d) => d.allocations.map((a) => ({ value: a.id, label: `${a.docNo}, ${formatMinor(a.amountMinor, d.currency)}` })) }] },
    }, {
      label: 'Allocate to invoice', when: (d) => d.status === 'SUBMITTED' && d.allocatedMinor < d.amountMinor + (d.deductionsPaise ?? 0), perm: 'payments.write', path: 'allocate', primary: true,
      form: {
        title: 'Allocate to an invoice',
        fields: (d) => [
          { key: 'docId', label: 'Invoice', type: 'ref', required: true, ref: d.kind === 'RECEIPT' ? { endpoint: '/sales-invoices', params: { status: 'SUBMITTED', partyId: d.partyId }, labelOf: (r) => `${r.docNo}, unpaid ${formatMinor(r.totalMinor - r.paidMinor - r.creditedMinor, r.currency)}` } : { endpoint: '/purchase-invoices', params: { status: 'SUBMITTED', partyId: d.partyId }, labelOf: (r) => `${r.docNo}, unpaid ${formatPaise(r.totalPaise - r.paidPaise - r.creditedPaise)}` } },
          { key: 'amountMinor', label: 'Amount', type: 'money', required: true },
        ],
      },
    }],
  },
  notes: {
    kind: 'document', title: 'Credit and debit notes', single: 'Note', printTitle: 'Credit or debit note', endpoint: '/notes', read: 'payments.read', write: 'payments.write',
    filters: [{ key: 'kind', label: 'Kind', options: option(['CREDIT', 'DEBIT']) }],
    columns: [docNoCol, dateCol('postingDate', 'Date'), col('kind', 'Kind', humanise), { key: 'invoiceNo', label: 'Invoice' }, { key: 'partyName', label: 'Party', wrap: true }, moneyCol('totalPaise', 'Total'), statusCol],
    prefillNote: true,
    fields: [{ key: 'kind', label: 'Kind', type: 'select', options: option(['CREDIT', 'DEBIT']), required: true, default: 'CREDIT' }, { key: 'invoiceId', label: 'Invoice', hidden: true, required: true }, text('reason', 'Reason', { required: true, wide: true }), { key: 'postingDate', label: 'Date', type: 'date' }, { key: 'lines', type: 'lines', label: 'Lines', fixed: true, fields: [{ key: 'invoiceLineId', hidden: true }, { key: '_label', label: 'Item', display: true, wide: true }, { key: 'taxableMinor', label: 'Reduce taxable by', type: 'money', required: true }, { key: 'qtyMilli', label: 'Qty back', type: 'qty' }, { key: 'returnGoods', label: 'Goods coming back', type: 'check' }, { key: 'warehouseId', label: 'Into (credit note)', type: 'ref', ref: warehouse }, { key: 'lot', label: 'Heat or batch', type: 'text' }] }],
    summary: [{ key: 'kind', label: 'Kind', format: humanise }, { key: 'invoiceNo', label: 'Invoice' }, { key: 'partyName', label: 'Party' }, { key: 'partyGstin', label: 'GSTIN' }, { key: 'reason', label: 'Reason' }, { key: 'postingDate', label: 'Date', format: formatDate }],
    lineColumns: [lineFrozen, { key: 'hsn', label: 'HSN' }, qtyCol('qtyMilli', 'Qty back'), { key: 'gstRateBps', label: 'GST', align: 'right', render: (r) => formatBps(r.gstRateBps) }, moneyCol('taxablePaise', 'Taxable')],
    totals: taxSummary,
  },
  journals: {
    kind: 'document', title: 'Journals', single: 'Journal', endpoint: '/journals', read: 'journals.read', write: 'journals.write',
    filters: [{ key: 'status', label: 'Status', options: option(['DRAFT', 'SUBMITTED', 'CANCELLED']) }],
    columns: [docNoCol, dateCol('postingDate', 'Date'), { key: 'narration', label: 'Narration', wrap: true }, moneyCol('totalPaise', 'Total'), statusCol],
    fields: [text('narration', 'Narration', { required: true, wide: true }), { key: 'postingDate', label: 'Date', type: 'date' }, { key: 'lines', type: 'lines', label: 'Lines', fields: [{ key: 'accountCode', label: 'Account', type: 'ref', ref: { ...account, valueKey: 'code', byCode: true }, required: true, wide: true }, { key: 'debitPaise', label: 'Debit', type: 'money' }, { key: 'creditPaise', label: 'Credit', type: 'money' }] }],
    summary: [{ key: 'narration', label: 'Narration' }, { key: 'postingDate', label: 'Date', format: formatDate }, { key: 'totalPaise', label: 'Total', format: formatPaise }],
    lineColumns: [{ key: 'accountCode', label: 'Account' }, moneyCol('debitPaise', 'Debit'), moneyCol('creditPaise', 'Credit')],
  },

  /* ---------- Service ---------- */
  amc: {
    kind: 'document', title: 'AMC contracts', single: 'AMC contract', endpoint: '/amc', read: 'service.read', write: 'service.write', submitLabel: 'Activate',
    filters: [{ key: 'status', label: 'Status', options: option(['DRAFT', 'ACTIVE', 'ENDED', 'CANCELLED']) }],
    columns: [docNoCol, { key: 'serialNo', label: 'Machine' }, { key: 'partyName', label: 'Customer', wrap: true }, dateCol('startDate', 'From'), dateCol('endDate', 'To'), moneyCol('valuePaise', 'Value'), statusCol],
    fields: [{ key: 'buildId', label: 'Machine', type: 'ref', ref: { ...build, params: { stage: 'INSTALLED' } }, required: true, wide: true }, { key: 'startDate', label: 'From', type: 'date', required: true }, { key: 'endDate', label: 'To', type: 'date', required: true }, { key: 'visitsPerYear', label: 'Visits a year', type: 'integer', default: 2 }, { key: 'valuePaise', label: 'Value', type: 'money' }, { key: 'postingDate', label: 'Date', type: 'date' }],
    summary: [{ key: 'serialNo', label: 'Machine' }, { key: 'partyName', label: 'Customer' }, { key: 'startDate', label: 'From', format: formatDate }, { key: 'endDate', label: 'To', format: formatDate }, { key: 'visitsPerYear', label: 'Visits a year' }, { key: 'valuePaise', label: 'Value', format: formatPaise }],
  },

  /* ---------- Engineering ---------- */
  boms: {
    kind: 'document', title: 'Bills of material', single: 'BOM', endpoint: '/boms', read: 'boms.read', write: 'boms.write',
    noSubmit: true, noCancel: true, noDelete: true, omitOnEdit: ['itemId'],
    titleOf: (d) => `${d.itemCode} rev ${d.revision}`,
    filters: [{ key: 'status', label: 'Status', options: option(['DRAFT', 'RELEASED', 'OBSOLETE']) }],
    columns: [{ key: 'itemCode', label: 'Machine or assembly' }, { key: 'itemName', label: 'Name', wrap: true }, { key: 'revision', label: 'Rev' }, { key: 'parts', label: 'Parts', align: 'right', render: (r) => r.lines.length }, { key: 'checks', label: 'FAT checks', align: 'right', render: (r) => r.fatChecklist.length }, statusCol],
    prefill: { param: 'copyFrom', endpoint: '/boms', map: (b) => ({ itemId: b.itemId, labourHoursMilli: b.labourHoursMilli, lines: b.lines, fatChecklist: b.fatChecklist, changeNote: '' }) },
    fields: [
      { key: 'itemId', label: 'Machine or assembly', type: 'ref', ref: item, required: true, wide: true, createOnly: true }, { key: 'labourHoursMilli', label: 'Planned labour, hours', type: 'qty' }, text('changeNote', 'What changed in this revision', { wide: true }),
      { key: 'lines', type: 'lines', label: 'Parts', fields: [{ key: 'itemId', label: 'Part', type: 'ref', ref: item, required: true, wide: true }, { key: 'qtyMilli', label: 'Qty', type: 'qty', required: true }, { key: 'scrapBps', label: 'Scrap %', type: 'bps' }, { key: 'drawingNo', label: 'Drawing', type: 'text' }] },
      { key: 'fatChecklist', type: 'lines', label: 'FAT checklist', fields: [{ key: 'parameter', label: 'Check', type: 'text', required: true, wide: true }, { key: 'acceptance', label: 'Acceptance', type: 'text', wide: true }, { key: 'minMilli', label: 'Min', type: 'qtySigned' }, { key: 'maxMilli', label: 'Max', type: 'qtySigned' }, { key: 'unit', label: 'Unit', type: 'text' }, { key: 'isCritical', label: 'Critical', type: 'check', default: true }] },
    ],
    summary: [{ key: 'itemName', label: 'Name' }, { key: 'revision', label: 'Revision' }, { key: 'labourHoursMilli', label: 'Planned hours', format: formatQty }, { key: 'changeNote', label: 'What changed' }],
    lineColumns: [lineFrozen, qtyCol('qtyMilli', 'Qty'), { key: 'uom', label: 'Unit' }, { key: 'scrapBps', label: 'Scrap', align: 'right', render: (r) => formatBps(r.scrapBps) }, { key: 'drawingNo', label: 'Drawing' }],
    extraTables: [{ title: 'FAT checklist', key: 'fatChecklist', columns: [{ key: 'parameter', label: 'Check', wrap: true }, { key: 'acceptance', label: 'Acceptance', wrap: true }, { key: 'minMilli', label: 'Min', align: 'right', render: (r) => (r.minMilli === null ? '' : formatQty(r.minMilli)) }, { key: 'maxMilli', label: 'Max', align: 'right', render: (r) => (r.maxMilli === null ? '' : formatQty(r.maxMilli)) }, { key: 'unit', label: 'Unit' }, { key: 'isCritical', label: 'Critical', render: (r) => (r.isCritical ? 'Yes' : 'No') }] }],
    actions: [
      { label: 'Release', when: (d) => d.status === 'DRAFT', perm: 'boms.release', path: 'release', primary: true },
      { label: 'New revision', when: (d) => d.status === 'RELEASED', perm: 'boms.write', link: (d) => `/boms/new?copyFrom=${d.id}` },
    ],
  },

  /* ---------- Production ---------- */
  builds: {
    meta: { dateField: 'targetDate', submittable: false, labelFields: ['serialNo'], fields: [{ key: 'stage', label: 'Stage', type: 'select', options: ['PLANNED', 'PROCUREMENT', 'FABRICATION', 'ASSEMBLY', 'FAT', 'READY', 'DISPATCHED', 'INSTALLED', 'CLOSED', 'CANCELLED'] }, { key: 'targetDate', label: 'Target date', type: 'date' }] },
    move: (id, stage) => post(`/builds/${id}/stage`, { stage }),
    kind: 'document', title: 'Machine builds', single: 'Build', endpoint: '/builds', read: 'builds.read', write: 'builds.write', noCreate: true,
    filters: [{ key: 'stage', label: 'Stage', options: option(['PLANNED', 'PROCUREMENT', 'FABRICATION', 'ASSEMBLY', 'FAT', 'READY', 'DISPATCHED', 'INSTALLED', 'CLOSED', 'CANCELLED']) }],
    columns: [{ key: 'serialNo', label: 'Serial no.' }, { key: 'itemName', label: 'Machine', wrap: true }, { key: 'partyName', label: 'Customer', wrap: true }, { key: 'salesOrderNo', label: 'Order' }, dateCol('targetDate', 'Due'), { key: 'stage', label: 'Stage', status: true }, { key: 'fatStatus', label: 'FAT', status: true }],
  },
  fat: {
    kind: 'document', title: 'FAT protocols', single: 'FAT protocol', endpoint: '/fat', read: 'fat.read', write: 'fat.write', noCreate: true,
    filters: [{ key: 'status', label: 'Status', options: option(['DRAFT', 'PASSED', 'FAILED']) }],
    columns: [docNoCol, dateCol('postingDate', 'Date'), { key: 'serialNo', label: 'Machine' }, { key: 'attempt', label: 'Attempt' }, { key: 'witnessName', label: 'Witness' }, statusCol],
  },
  ncrs: {
    kind: 'document', title: 'Non-conformance reports', single: 'NCR', endpoint: '/ncrs', read: 'ncrs.read', write: 'ncrs.write', noSubmit: true, noCancel: true, noDelete: true, noEdit: true,
    filters: [{ key: 'status', label: 'Status', options: option(['OPEN', 'CLOSED']) }, { key: 'source', label: 'Source', options: option(['INCOMING', 'IN_PROCESS', 'FAT', 'CUSTOMER']) }],
    columns: [{ key: 'docNo', label: 'Number' }, dateCol('postingDate', 'Date'), col('source', 'Source', humanise), { key: 'serialNo', label: 'Machine' }, { key: 'description', label: 'What went wrong', wrap: true }, statusCol],
    fields: [{ key: 'source', label: 'Source', type: 'select', options: option(['INCOMING', 'IN_PROCESS', 'FAT', 'CUSTOMER']), required: true, default: 'IN_PROCESS' }, { key: 'buildId', label: 'Machine', type: 'ref', ref: build }, { key: 'postingDate', label: 'Date', type: 'date' }, { key: 'description', label: 'What went wrong', type: 'textarea', required: true, wide: true }],
    summary: [{ key: 'source', label: 'Source', format: humanise }, { key: 'serialNo', label: 'Machine' }, { key: 'itemName', label: 'Item' }, { key: 'description', label: 'What went wrong' }, { key: 'raisedByName', label: 'Raised by' }, { key: 'disposition', label: 'Disposition', format: humanise }, { key: 'rootCause', label: 'Root cause' }, { key: 'correctiveAction', label: 'Corrective action' }, { key: 'preventiveAction', label: 'Preventive action' }],
    actions: [{
      label: 'Close', when: (d) => d.status === 'OPEN', perm: 'ncrs.close', path: 'close', primary: true,
      form: { title: 'Close this NCR', hint: 'Whoever raised an NCR cannot close it.', fields: [{ key: 'disposition', label: 'Disposition', type: 'select', required: true, options: option(['USE_AS_IS', 'REWORK', 'SCRAP', 'RETURN']) }, { key: 'rootCause', label: 'Root cause', type: 'textarea', required: true }, { key: 'correctiveAction', label: 'Corrective action', type: 'textarea', required: true }, { key: 'preventiveAction', label: 'Preventive action', type: 'textarea' }] },
    }],
  },
  tickets: {
    kind: 'document', title: 'Service tickets', single: 'Ticket', endpoint: '/tickets', read: 'service.read', write: 'service.write', noSubmit: true, noCancel: true, noDelete: true, noEdit: true,
    filters: [{ key: 'status', label: 'Status', options: option(['OPEN', 'IN_PROGRESS', 'RESOLVED']) }, { key: 'priority', label: 'Priority', options: option(['LOW', 'NORMAL', 'HIGH', 'LINE_DOWN']) }],
    columns: [{ key: 'docNo', label: 'Number' }, dateCol('postingDate', 'Date'), { key: 'serialNo', label: 'Machine' }, { key: 'partyName', label: 'Customer', wrap: true }, { key: 'complaint', label: 'Complaint', wrap: true }, { key: 'priority', label: 'Priority', status: true }, col('coverage', 'Cover', humanise), statusCol],
    fromQuery: ['buildId'],
    fields: [{ key: 'buildId', label: 'Machine', type: 'ref', ref: build, required: true, wide: true }, { key: 'priority', label: 'Priority', type: 'select', options: option(['LOW', 'NORMAL', 'HIGH', 'LINE_DOWN']), default: 'NORMAL' }, text('assignedTo', 'Assigned to'), { key: 'postingDate', label: 'Date', type: 'date' }, { key: 'complaint', label: 'Complaint', type: 'textarea', required: true, wide: true }],
    summary: [{ key: 'serialNo', label: 'Machine' }, { key: 'partyName', label: 'Customer' }, { key: 'priority', label: 'Priority', format: humanise }, { key: 'coverage', label: 'Cover', format: humanise }, { key: 'complaint', label: 'Complaint' }, { key: 'assignedTo', label: 'Assigned to' }, { key: 'resolution', label: 'Resolution' }, { key: 'resolvedOn', label: 'Resolved', format: formatDate }],
    actions: [{
      label: 'Update', when: (d) => ['OPEN', 'IN_PROGRESS'].includes(d.status), perm: 'service.write', method: 'PATCH', primary: true,
      form: { title: 'Update this ticket', fields: (d) => [{ key: 'status', label: 'Status', type: 'select', default: d.status, options: option(['OPEN', 'IN_PROGRESS', 'RESOLVED']) }, { key: 'assignedTo', label: 'Assigned to', type: 'text', default: d.assignedTo }, { key: 'resolution', label: 'Resolution', type: 'textarea' }] },
    }],
  },
};

export const RESOURCE_ROUTES = Object.keys(RESOURCES);
