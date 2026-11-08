// Registers everything. Import this once, before the server starts or tests run.
// logic.js is imported statically and first, because it extends types defined below.
import './logic.js';
import './channels.js';
import { registerExternal, assertRegistryValid } from '../engine/registry.js';
import { User } from '../models/core.js';
import { Account, Item, Party, Warehouse } from '../models/masters.js';
import {
  AmcContract, Bom, Gauge, Grn, JobWorkChallan, MachineBuild, Ncr, PurchaseInvoice, PurchaseOrder, Quotation, SalesInvoice, SalesOrder, ServiceTicket,
} from '../models/documents.js';

registerExternal('Item', { Model: Item, endpoint: '/items', labelFields: ['code', 'name'] });
registerExternal('Party', { Model: Party, endpoint: '/parties', labelFields: ['code', 'name'] });
registerExternal('Warehouse', { Model: Warehouse, endpoint: '/warehouses', labelFields: ['code', 'name'] });
registerExternal('Account', { Model: Account, endpoint: '/accounts', labelFields: ['code', 'name'], valueKey: 'code' });
registerExternal('User', { Model: User, endpoint: '/lookup/User', labelFields: ['name'] });
registerExternal('MachineBuild', { Model: MachineBuild, endpoint: '/builds', labelFields: ['serialNo', 'itemName'] });
registerExternal('Bom', { Model: Bom, endpoint: '/boms', labelFields: ['itemCode', 'revision'] });
registerExternal('Quotation', { Model: Quotation, endpoint: '/quotations', labelFields: ['docNo', 'partyName'] });
registerExternal('SalesOrder', { Model: SalesOrder, endpoint: '/sales-orders', labelFields: ['docNo', 'partyName'] });
registerExternal('SalesInvoice', { Model: SalesInvoice, endpoint: '/sales-invoices', labelFields: ['docNo', 'partyName'] });
registerExternal('PurchaseOrder', { Model: PurchaseOrder, endpoint: '/purchase-orders', labelFields: ['docNo', 'partyName'] });
registerExternal('PurchaseInvoice', { Model: PurchaseInvoice, endpoint: '/purchase-invoices', labelFields: ['docNo', 'partyName'] });
registerExternal('Grn', { Model: Grn, endpoint: '/grns', labelFields: ['docNo', 'partyName'] });
registerExternal('Ncr', { Model: Ncr, endpoint: '/ncrs', labelFields: ['docNo'] });
registerExternal('Gauge', { Model: Gauge, endpoint: '/gauges', labelFields: ['code', 'name'] });
registerExternal('ServiceTicket', { Model: ServiceTicket, endpoint: '/tickets', labelFields: ['docNo'] });
registerExternal('AmcContract', { Model: AmcContract, endpoint: '/amc', labelFields: ['docNo', 'serialNo'] });
registerExternal('JobWorkChallan', { Model: JobWorkChallan, endpoint: '/job-work', labelFields: ['docNo', 'partyName'] });

await import('./setup.js');
await import('./crm.js');
await import('./selling.js');
await import('./buying.js');
await import('./stock.js');
await import('./manufacturing.js');
await import('./accounts.js');
await import('./assets.js');
await import('./pos.js');
await import('./operations.js');
await import('./hr.js');
await import('./payroll.js');
await import('./extras.js');
await import('./gst.js');
await import('./accountsReports.js');
await import('./manufacturingReports.js');
await import('./platformViews.js');
await import('./tools.js');
await import('./moreReports.js');
await import('./reports.js');
await import('./jobs.js');

assertRegistryValid();
