// Stock beyond the ledger: batches, serials, variants, counts, landed cost, logistics.
import { define, modelOf } from '../engine/registry.js';
import { A } from '../config/accounts.js';
import { Bin } from '../models/ledgers.js';
import { Grn } from '../models/documents.js';
import { Item, Warehouse } from '../models/masters.js';
import { allocate, lineValue, mulDivRound, sumInts } from '../utils/money.js';
import { rule } from '../utils/errors.js';
import { postGl } from '../services/ledgerService.js';
import { accountForWarehouseKind, revalueBucket, stockIn, stockOut } from '../services/stockService.js';

const m = (name, fields, extra = {}) => define({ name, module: 'stock', fields, ...extra });

m('Manufacturer', 'name!* country website');
m('ItemAttribute', 'name!*', { tables: { values: 'value! abbreviation' }, readers: 'all' });
m('ItemAlternative', 'itemId!:link(Item) alternativeItemId!:link(Item) twoWay:check', { labelFields: ['itemId'], list: 'itemId alternativeItemId twoWay', readers: 'all' });
m('CustomsTariffNumber', 'code!* description');
m('PutawayRule', 'itemId!:link(Item) warehouseId!:link(Warehouse) capacityMilli!:qty priority:int=1 isActive:check=true', { labelFields: ['itemId'], list: 'itemId warehouseId capacityMilli priority' });
m('StockEntryType', 'name!* purpose');

m('Batch', 'batchNo!* itemId!:link(Item) supplierId:link(Party) manufacturedOn:date expiresOn:date certRef isActive:check=true notes:long', {
  list: 'batchNo itemId manufacturedOn expiresOn certRef',
  dateField: 'expiresOn',
  readers: 'all',
  labelFields: ['batchNo'],
});

m('SerialNo', 'serialNo!* itemId!:link(Item) warehouseId:link(Warehouse) state:select(IN_STOCK,DELIVERED,AT_JOB_WORK,CONSUMED,SCRAPPED)=IN_STOCK buildId:link(MachineBuild) partyId:link(Party) purchasedOn:date warrantyUntil:date amcUntil:date notes:long', {
  list: 'serialNo itemId warehouseId state partyId warrantyUntil',
  readers: 'all',
  labelFields: ['serialNo'],
});

// Makes one item per value of an attribute, from a template item.
m('ItemVariantGenerator', 'templateItemId!:link(Item) attributeId!:link(ItemAttribute) created~:int', {
  labelFields: ['templateItemId'],
  list: 'templateItemId attributeId created',
  actions: [{
    key: 'generate',
    label: 'Create variants',
    primary: true,
    when: {},
    fields: '',
    async run(session, doc) {
      const template = await Item.findById(doc.templateItemId).session(session).lean();
      const attribute = await modelOf('ItemAttribute').findById(doc.attributeId).session(session).lean();
      if (!attribute?.values?.length) throw rule('That attribute has no values.', 'NO_VALUES');
      let created = 0;
      for (const row of attribute.values) {
        const suffix = row.abbreviation || row.value.replace(/\W+/g, '').toUpperCase();
        const code = `${template.code}-${suffix}`;
        if (await Item.exists({ code }).session(session)) continue;
        const { _id, createdAt, updatedAt, __v, ...rest } = template;
        await Item.create([{ ...rest, code, name: `${template.name} ${row.value}`, variantOfId: template._id, variantValue: row.value }], { session });
        created += 1;
      }
      doc.created += created;
      await doc.save({ session });
      return doc;
    },
  }],
});

// A physical count. The difference from the books posts to stock adjustment.
define({
  name: 'StockReconciliation',
  module: 'stock',
  series: 'SR',
  submittable: true,
  fields: 'purpose:select(STOCK_COUNT,OPENING)=STOCK_COUNT reason differencePaise~:smoney',
  tables: { lines: 'itemId!:link(Item) warehouseId!:link(Warehouse) lot countedMilli:qty ratePaise:money bookMilli~:qty differenceMilli~:sqty differencePaise~:smoney' },
  list: 'docNo purpose reason differencePaise',
  submitLabel: 'Post count',
  async onSubmit(session, doc) {
    const voucher = { voucherType: 'StockReconciliation', voucherId: doc._id, voucherNo: doc.docNo, postingDate: doc.postingDate };
    const gl = [];
    let total = 0;
    const contra = doc.purpose === 'OPENING' ? A.OPENING : A.STOCK_ADJUSTMENT;
    for (const line of doc.lines) {
      const warehouse = await Warehouse.findById(line.warehouseId).session(session).lean();
      if (!['STORES', 'FG', 'REJECT'].includes(warehouse.kind)) throw rule(`${warehouse.name} cannot be counted this way.`, 'BAD_WAREHOUSE');
      const bucket = { itemId: line.itemId, warehouseId: line.warehouseId, lot: line.lot ?? '', buildId: null };
      const bin = await Bin.findOne(bucket).session(session).lean();
      const book = bin?.qtyMilli ?? 0;
      const difference = line.countedMilli - book;
      line.bookMilli = book;
      line.differenceMilli = difference;
      if (difference === 0) {
        line.differencePaise = 0;
        continue;
      }
      const account = accountForWarehouseKind(warehouse.kind);
      if (difference > 0) {
        const rate = line.ratePaise || (book > 0 ? mulDivRound(bin.valuePaise, 1000, book) : 0);
        const value = lineValue(difference, rate);
        await stockIn(session, { voucher, ...bucket, qtyMilli: difference, valuePaise: value });
        line.differencePaise = value;
        total += value;
        gl.push({ accountCode: account, debitPaise: value }, { accountCode: contra, creditPaise: value });
      } else {
        const { valuePaise } = await stockOut(session, { voucher, ...bucket, qtyMilli: -difference });
        line.differencePaise = -valuePaise;
        total -= valuePaise;
        gl.push({ accountCode: contra, debitPaise: valuePaise }, { accountCode: account, creditPaise: valuePaise });
      }
    }
    doc.differencePaise = total;
    await postGl(session, { postingDate: doc.postingDate, voucherType: 'StockReconciliation', voucherId: doc._id, voucherNo: doc.docNo, narration: doc.reason || 'Stock count', lines: gl });
    return { action: 'STOCK_COUNTED', reason: doc.reason, data: { differencePaise: total } };
  },
});

// Freight, duty and handling added to the cost of goods already received. Stock still on
// hand takes its share. Whatever has already left goes to the price variance account.
define({
  name: 'LandedCostVoucher',
  module: 'stock',
  series: 'LC',
  submittable: true,
  writers: ['ADMIN', 'MANAGEMENT', 'ACCOUNTS', 'PURCHASE'],
  fields: 'grnId!:link(Grn) distributeBy:select(VALUE,QTY)=VALUE totalPaise~:money capitalisedPaise~:money expensedPaise~:money',
  tables: { charges: 'description! amountPaise!:money' },
  list: 'docNo grnId totalPaise capitalisedPaise expensedPaise',
  prepare(_session, data) {
    return { ...data, totalPaise: sumInts((data.charges ?? []).map((c) => c.amountPaise)) };
  },
  async onSubmit(session, doc) {
    const receipt = await Grn.findById(doc.grnId).session(session).lean();
    if (!receipt || receipt.status !== 'SUBMITTED') throw rule('That goods receipt is not live.', 'GRN_NOT_SUBMITTED');
    const voucher = { voucherType: 'LandedCostVoucher', voucherId: doc._id, voucherNo: doc.docNo, postingDate: doc.postingDate };
    const weights = receipt.lines.map((l) => (doc.distributeBy === 'QTY' ? l.qtyMilli : l.valuePaise));
    const shares = allocate(doc.totalPaise, weights);
    let capitalised = 0;
    let expensed = 0;
    for (let i = 0; i < receipt.lines.length; i += 1) {
      const line = receipt.lines[i];
      const bins = await Bin.find({ itemId: line.itemId, lot: line.lot ?? '', buildId: line.buildId ?? null, qtyMilli: { $gt: 0 } }).session(session).lean();
      const stillHere = Math.min(line.qtyMilli, sumInts(bins.map((b) => b.qtyMilli)));
      const toStock = mulDivRound(shares[i], stillHere, line.qtyMilli);
      expensed += shares[i] - toStock;
      if (toStock > 0) {
        const parts = allocate(toStock, bins.map((b) => b.qtyMilli));
        for (let b = 0; b < bins.length; b += 1) {
          if (parts[b] > 0) await revalueBucket(session, { voucher, itemId: bins[b].itemId, warehouseId: bins[b].warehouseId, lot: bins[b].lot, buildId: bins[b].buildId, valuePaise: parts[b] });
        }
        capitalised += toStock;
      }
    }
    doc.capitalisedPaise = capitalised;
    doc.expensedPaise = expensed;
    await postGl(session, {
      postingDate: doc.postingDate,
      voucherType: 'LandedCostVoucher',
      voucherId: doc._id,
      voucherNo: doc.docNo,
      narration: `Landed cost on ${receipt.docNo}`,
      lines: [
        { accountCode: A.INVENTORY, debitPaise: capitalised },
        { accountCode: A.PRICE_VARIANCE, debitPaise: expensed },
        { accountCode: A.LANDED_COST_CLEARING, creditPaise: doc.totalPaise },
      ],
    });
    return { action: 'LANDED_COST_POSTED', data: { capitalised, expensed } };
  },
});

define({
  name: 'PickList',
  module: 'stock',
  series: 'PL',
  labelFields: ['docNo'],
  fields: 'purpose:select(DELIVERY,MATERIAL_ISSUE)=DELIVERY deliveryNoteId:link(DeliveryNote) buildId:link(MachineBuild) state:select(OPEN,PICKED,CANCELLED)=OPEN assignedTo:link(User)',
  tables: { lines: 'itemId!:link(Item) warehouseId:link(Warehouse) lot qtyMilli!:qty pickedMilli:qty' },
  list: 'docNo purpose buildId assignedTo state',
});

define({
  name: 'Shipment',
  module: 'stock',
  series: 'SH',
  labelFields: ['docNo'],
  fields: 'deliveryNoteId:link(DeliveryNote) salesInvoiceId:link(SalesInvoice) partyId!:link(Party) carrier awbNo pickupOn:date valuePaise:money chargesPaise:money state:select(BOOKED,IN_TRANSIT,DELIVERED,CANCELLED)=BOOKED deliveredOn:date',
  tables: { parcels: 'lengthMilli:qty widthMilli:qty heightMilli:qty weightMilli:qty count:int=1' },
  list: 'docNo partyId carrier awbNo pickupOn state',
  dateField: 'pickupOn',
  searchFields: ['docNo', 'carrier', 'awbNo'],
});

define({
  name: 'DeliveryTrip',
  module: 'stock',
  series: 'DT',
  labelFields: ['docNo'],
  fields: 'driverId!:link(Driver) vehicleId!:link(Vehicle) departOn!:date state:select(SCHEDULED,IN_TRANSIT,COMPLETED,CANCELLED)=SCHEDULED',
  tables: { stops: 'deliveryNoteId:link(DeliveryNote) partyId:link(Party) address isVisited:check' },
  list: 'docNo driverId vehicleId departOn state',
  dateField: 'departOn',
});
