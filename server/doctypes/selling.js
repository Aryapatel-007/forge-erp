// Selling beyond the quotation and order: price lists, pricing rules, bundles, delivery.
import { define } from '../engine/registry.js';
import { A } from '../config/accounts.js';
import { Item } from '../models/masters.js';
import { postGl } from '../services/ledgerService.js';
import { pickBuckets, stockOut } from '../services/stockService.js';
import { rule } from '../utils/errors.js';

const m = (name, fields, extra = {}) => define({ name, module: 'selling', fields, ...extra });

m('PriceList', 'name!* currency=INR forSelling:check=true forBuying:check isActive:check=true', { list: 'name currency forSelling forBuying isActive', readers: 'all' });
m('ItemPrice', 'itemId!:link(Item) priceListId!:link(PriceList) ratePaise!:money minQtyMilli:qty partyId:link(Party) validFrom:date validUpto:date', {
  list: 'itemId priceListId ratePaise minQtyMilli validFrom validUpto', labelFields: ['itemId'], readers: 'all', deletable: true,
  index: [{ itemId: 1, priceListId: 1 }],
});
m('PricingRule', 'title!* forSelling:check=true forBuying:check itemId:link(Item) itemGroupId:link(ItemGroup) brandId:link(Brand) partyId:link(Party) customerGroupId:link(CustomerGroup) territoryId:link(Territory) minQtyMilli:qty maxQtyMilli:qty minAmountPaise:money validFrom:date validUpto:date kind:select(DISCOUNT_PERCENT,DISCOUNT_AMOUNT,FIXED_RATE)=DISCOUNT_PERCENT discountBps:pct discountPaise:money ratePaise:money priority:int=1 isActive:check=true', {
  list: 'title kind discountBps ratePaise validFrom validUpto isActive', readers: 'all',
});
m('PromotionalScheme', 'title!* forSelling:check=true itemGroupId:link(ItemGroup) minQtyMilli:qty freeItemId:link(Item) freeQtyMilli:qty validFrom:date validUpto:date isActive:check=true', { list: 'title itemGroupId minQtyMilli freeItemId freeQtyMilli' });
m('CouponCode', 'code!* pricingRuleId!:link(PricingRule) maxUse:int=0 used:int validFrom:date validUpto:date', { list: 'code pricingRuleId maxUse used validUpto' });
m('ShippingRule', 'name!* kind:select(FIXED,BY_NET_TOTAL,BY_WEIGHT)=FIXED accountCode:link(Account) fixedPaise:money isActive:check=true', { tables: { slabs: 'fromPaise:money toPaise:money amountPaise:money' }, list: 'name kind fixedPaise isActive' });
m('ProductBundle', 'itemId!:link(Item) description isActive:check=true', { tables: { lines: 'itemId!:link(Item) qtyMilli!:qty' }, labelFields: ['itemId'], list: 'itemId description isActive' });
m('SalesPartnerType', 'name!*');
m('IndustryType', 'name!*');
m('ProformaInvoice', 'partyId!:link(Party;isCustomer=true) reference validUntil:date totalPaise:money terms:long', { series: 'PF', tables: { lines: 'itemId!:link(Item) qtyMilli!:qty ratePaise!:money gstRateBps:pct' }, list: 'docNo partyId reference totalPaise validUntil', deletable: true });
m('BlanketOrder', 'title! partyId!:link(Party) fromDate!:date toDate!:date', { series: 'BO', tables: { lines: 'itemId!:link(Item) qtyMilli!:qty ratePaise!:money orderedMilli~:qty' }, list: 'docNo title partyId fromDate toDate' });
m('SalesTarget', 'salesPersonId!:link(SalesPerson) fiscalYearId!:link(FiscalYear) targetPaise!:money itemGroupId:link(ItemGroup)', { labelFields: ['salesPersonId'], list: 'salesPersonId fiscalYearId targetPaise itemGroupId' });

// Goods leaving ahead of the invoice. The stock and its cost move now, and the invoice
// that follows names this note, so nothing leaves twice.
define({
  name: 'DeliveryNote',
  module: 'selling',
  series: 'DL',
  submittable: true,
  writers: ['ADMIN', 'MANAGEMENT', 'STORES', 'SALES'],
  fields: 'partyId!:link(Party;isCustomer=true) salesOrderId:link(SalesOrder) vehicleNo transporter lrNo ewayBillNo isBilled~:check totalCostPaise~:money',
  tables: { lines: 'itemId!:link(Item) qtyMilli!:qty costPaise~:money billedMilli~:qty' },
  list: 'docNo partyId salesOrderId vehicleNo totalCostPaise isBilled',
  submitLabel: 'Dispatch',
  hint: 'Takes the goods out of stock and books their cost.',
  async onSubmit(session, doc) {
    const voucher = { voucherType: 'DeliveryNote', voucherId: doc._id, voucherNo: doc.docNo, postingDate: doc.postingDate };
    let total = 0;
    const items = await Item.find({ _id: { $in: doc.lines.map((l) => l.itemId) } }).session(session).lean();
    for (const line of doc.lines) {
      const item = items.find((i) => String(i._id) === String(line.itemId));
      if (item.type === 'SERVICE') throw rule(`${item.code} is a service and cannot be delivered.`, 'NOT_STOCK_ITEM');
      if (item.type === 'MACHINE') throw rule(`${item.code}: a machine leaves on its invoice.`, 'MACHINE_ON_INVOICE');
      const picks = await pickBuckets(session, { itemId: line.itemId, qtyMilli: line.qtyMilli });
      let value = 0;
      for (const pick of picks) value += (await stockOut(session, { voucher, ...pick })).valuePaise;
      line.costPaise = value;
      total += value;
    }
    doc.totalCostPaise = total;
    await postGl(session, {
      postingDate: doc.postingDate, voucherType: 'DeliveryNote', voucherId: doc._id, voucherNo: doc.docNo, narration: `Delivery ${doc.docNo}`,
      lines: [{ accountCode: A.COGS, debitPaise: total }, { accountCode: A.INVENTORY, creditPaise: total }],
    });
    return { action: 'DELIVERY_NOTE_POSTED', data: { totalCostPaise: total } };
  },
  async onCancel(_session, doc) {
    if (doc.lines.some((l) => l.billedMilli > 0)) throw rule('This delivery has been invoiced. Cancel the invoice first.', 'DELIVERY_BILLED');
  },
});

m('InstallationNote', 'partyId!:link(Party) buildId:link(MachineBuild) installedOn!:date engineer remarks:long', { series: 'IN', list: 'docNo partyId buildId installedOn engineer', dateField: 'installedOn' });
m('PackingSlip', 'deliveryNoteId!:link(DeliveryNote) packageNo:int=1 grossWeightMilli:qty netWeightMilli:qty', { series: 'PK', tables: { lines: 'itemId!:link(Item) qtyMilli!:qty' }, list: 'docNo deliveryNoteId packageNo grossWeightMilli' });
