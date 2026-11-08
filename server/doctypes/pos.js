// Point of sale, for walk-in spares. Each sale posts straight away, and a closing compares
// what the till should hold with what was counted.
import { define, modelOf } from '../engine/registry.js';
import { A } from '../config/accounts.js';
import { Item } from '../models/masters.js';
import { postGl } from '../services/ledgerService.js';
import { pickBuckets, stockOut } from '../services/stockService.js';
import { computeTax, SUPPLY } from '../utils/tax.js';
import { afterDiscount, lineValue, sumInts } from '../utils/money.js';
import { conflict, rule } from '../utils/errors.js';

const m = (name, fields, extra = {}) => define({ name, module: 'pos', fields, ...extra });

m('PosProfile', 'name!* cashAccountCode!:link(Account;isCashOrBank=true) cardAccountCode:link(Account;isCashOrBank=true) priceListId:link(PriceList) isActive:check=true', { list: 'name cashAccountCode isActive', readers: ['SALES', 'ACCOUNTS'] });

m('PosOpening', 'profileId!:link(PosProfile) openingCashPaise:money cashierId!:link(User) state~:select(OPEN,CLOSED)=OPEN', {
  series: 'POP',
  submittable: true,
  labelFields: ['docNo'],
  list: 'docNo profileId cashierId openingCashPaise state',
  async onSubmit(session, doc) {
    const open = await modelOf('PosOpening').countDocuments({ _id: { $ne: doc._id }, profileId: doc.profileId, status: 'SUBMITTED', state: 'OPEN' }).session(session);
    if (open > 0) throw conflict('This till is already open.', 'TILL_ALREADY_OPEN');
  },
});

define({
  name: 'PosInvoice',
  module: 'pos',
  series: 'POS',
  submittable: true,
  labelFields: ['docNo'],
  fields: 'openingId!:link(PosOpening) partyId:link(Party;isCustomer=true) customerName taxablePaise~:money cgstPaise~:money sgstPaise~:money roundOffPaise~:smoney totalPaise~:money cashPaise:money cardPaise:money costPaise~:money',
  tables: { lines: 'itemId!:link(Item) qtyMilli!:qty ratePaise!:money discountBps:pct gstRateBps:pct taxablePaise~:money hsn~' },
  list: 'docNo customerName totalPaise cashPaise cardPaise',
  submitLabel: 'Take payment',
  async prepare(session, data) {
    const items = await Item.find({ _id: { $in: (data.lines ?? []).map((l) => l.itemId) } }).session(session).lean();
    const lines = (data.lines ?? []).map((line) => {
      const item = items.find((i) => String(i._id) === String(line.itemId));
      if (!item) throw rule('A line names an item that does not exist.', 'UNKNOWN_ITEM');
      return { ...line, gstRateBps: line.gstRateBps ?? item.gstRateBps, hsn: item.hsn, taxablePaise: afterDiscount(lineValue(line.qtyMilli, line.ratePaise), line.discountBps ?? 0) };
    });
    // A walk-in sale at the counter is always within the state.
    const tax = computeTax(lines.map((l) => ({ taxablePaise: l.taxablePaise, gstRateBps: l.gstRateBps })), SUPPLY.INTRA, { roundOff: true });
    return { ...data, lines, taxablePaise: tax.taxablePaise, cgstPaise: tax.cgstPaise, sgstPaise: tax.sgstPaise, roundOffPaise: tax.roundOffPaise, totalPaise: tax.totalPaise };
  },
  async onSubmit(session, doc) {
    const opening = await modelOf('PosOpening').findById(doc.openingId).session(session).lean();
    if (opening?.state !== 'OPEN' || opening.status !== 'SUBMITTED') throw rule('That till is not open.', 'TILL_NOT_OPEN');
    if ((doc.cashPaise ?? 0) + (doc.cardPaise ?? 0) !== doc.totalPaise) throw rule(`The payment must add up to the total, Rs ${doc.totalPaise / 100}.`, 'PAYMENT_MISMATCH');
    const profile = await modelOf('PosProfile').findById(opening.profileId).session(session).lean();
    if (doc.cardPaise > 0 && !profile.cardAccountCode) throw rule('This till takes no card payments.', 'NO_CARD_ACCOUNT');
    const voucher = { voucherType: 'PosInvoice', voucherId: doc._id, voucherNo: doc.docNo, postingDate: doc.postingDate };
    let cost = 0;
    for (const line of doc.lines) {
      const picks = await pickBuckets(session, { itemId: line.itemId, qtyMilli: line.qtyMilli });
      for (const pick of picks) cost += (await stockOut(session, { voucher, ...pick })).valuePaise;
    }
    doc.costPaise = cost;
    const lines = [
      { accountCode: profile.cashAccountCode, debitPaise: doc.cashPaise },
      { accountCode: A.SALES_SPARES, creditPaise: doc.taxablePaise },
      { accountCode: A.OUTPUT_CGST, creditPaise: doc.cgstPaise },
      { accountCode: A.OUTPUT_SGST, creditPaise: doc.sgstPaise },
      { accountCode: A.COGS, debitPaise: cost },
      { accountCode: A.INVENTORY, creditPaise: cost },
    ];
    if (doc.cardPaise > 0) lines.push({ accountCode: profile.cardAccountCode, debitPaise: doc.cardPaise });
    if (doc.roundOffPaise > 0) lines.push({ accountCode: A.ROUND_OFF, creditPaise: doc.roundOffPaise });
    if (doc.roundOffPaise < 0) lines.push({ accountCode: A.ROUND_OFF, debitPaise: -doc.roundOffPaise });
    await postGl(session, { postingDate: doc.postingDate, voucherType: 'PosInvoice', voucherId: doc._id, voucherNo: doc.docNo, narration: 'Counter sale', lines });
    return { action: 'POS_SALE', data: { totalPaise: doc.totalPaise } };
  },
  async onCancel(session, doc) {
    const opening = await modelOf('PosOpening').findById(doc.openingId).session(session).lean();
    if (opening.state !== 'OPEN') throw rule('That till has closed. Use a credit note.', 'TILL_CLOSED');
  },
});

m('PosClosing', 'openingId!:link(PosOpening) countedCashPaise!:money expectedCashPaise~:money salesPaise~:money differencePaise~:smoney', {
  series: 'PCL',
  submittable: true,
  labelFields: ['docNo'],
  list: 'docNo openingId salesPaise expectedCashPaise countedCashPaise differencePaise',
  async onSubmit(session, doc) {
    const opening = await modelOf('PosOpening').findById(doc.openingId).session(session);
    if (!opening || opening.state !== 'OPEN') throw rule('That till is not open.', 'TILL_NOT_OPEN');
    const sales = await modelOf('PosInvoice').find({ openingId: String(doc.openingId), status: 'SUBMITTED' }).session(session).lean();
    doc.salesPaise = sumInts(sales.map((s) => s.totalPaise));
    doc.expectedCashPaise = opening.openingCashPaise + sumInts(sales.map((s) => s.cashPaise));
    doc.differencePaise = doc.countedCashPaise - doc.expectedCashPaise;
    opening.state = 'CLOSED';
    await opening.save({ session });
    if (doc.differencePaise !== 0) {
      const profile = await modelOf('PosProfile').findById(opening.profileId).session(session).lean();
      const value = Math.abs(doc.differencePaise);
      await postGl(session, {
        postingDate: doc.postingDate, voucherType: 'PosClosing', voucherId: doc._id, voucherNo: doc.docNo, narration: 'Till difference',
        lines: doc.differencePaise > 0
          ? [{ accountCode: profile.cashAccountCode, debitPaise: value }, { accountCode: A.CASH_DIFFERENCE, creditPaise: value }]
          : [{ accountCode: A.CASH_DIFFERENCE, debitPaise: value }, { accountCode: profile.cashAccountCode, creditPaise: value }],
      });
    }
    return { action: 'TILL_CLOSED', data: { differencePaise: doc.differencePaise } };
  },
  async onCancel(session, doc) {
    const opening = await modelOf('PosOpening').findById(doc.openingId).session(session);
    opening.state = 'OPEN';
    await opening.save({ session });
  },
});
