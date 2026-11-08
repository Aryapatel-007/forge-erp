// From a need to a purchase order: material requests, RFQs, supplier quotations, scorecards.
import { define, modelOf } from '../engine/registry.js';
import { Grn, PurchaseOrder } from '../models/documents.js';
import { purchaseOrder } from '../services/purchaseService.js';
import { rule } from '../utils/errors.js';
import { todayIst } from '../utils/dates.js';
import { mulDivRound } from '../utils/money.js';

// Makes a draft purchase order through the normal service, so its rules all apply.
async function draftPo(session, { partyId, lines }, actor) {
  const data = await purchaseOrder.prepare(session, { postingDate: todayIst(), partyId, lines });
  const [po] = await PurchaseOrder.create([{ ...data, createdBy: actor.id }], { session });
  return po;
}

define({
  name: 'MaterialRequest',
  module: 'buying',
  series: 'MQ',
  submittable: true,
  writers: ['ADMIN', 'MANAGEMENT', 'PURCHASE', 'STORES', 'PRODUCTION', 'ENGINEERING'],
  fields: 'purpose:select(PURCHASE,TRANSFER,ISSUE,MANUFACTURE)=PURCHASE requiredBy:date buildId:link(MachineBuild) reason state~:select(OPEN,ORDERED,STOPPED)=OPEN',
  tables: { lines: 'itemId!:link(Item) qtyMilli!:qty warehouseId:link(Warehouse) orderedMilli~:qty ratePaise:money' },
  list: 'docNo purpose requiredBy buildId state',
  actions: [{
    key: 'makePo',
    label: 'Make purchase order',
    primary: true,
    when: { status: ['SUBMITTED'], state: ['OPEN'] },
    fields: 'partyId!:link(Party;isSupplier=true)',
    navigateTo: 'purchaseOrders',
    async run(session, doc, body, { actor }) {
      if (!body.partyId) throw rule('Choose a supplier.', 'SUPPLIER_REQUIRED');
      const lines = doc.lines
        .filter((l) => l.orderedMilli < l.qtyMilli)
        .map((l) => ({ itemId: String(l.itemId), qtyMilli: l.qtyMilli - l.orderedMilli, ratePaise: l.ratePaise ?? 0, buildId: doc.buildId ? String(doc.buildId) : null }));
      if (lines.length === 0) throw rule('Everything on this request has been ordered.', 'ALREADY_ORDERED');
      const po = await draftPo(session, { partyId: body.partyId, lines }, actor);
      for (const line of doc.lines) line.orderedMilli = line.qtyMilli;
      doc.state = 'ORDERED';
      await doc.save({ session });
      return po;
    },
  }],
});

define({
  name: 'RequestForQuotation',
  module: 'buying',
  series: 'RQ',
  submittable: true,
  label: 'Request for quotation',
  fields: 'materialRequestId:link(MaterialRequest) replyBy:date message:long',
  tables: { lines: 'itemId!:link(Item) qtyMilli!:qty', suppliers: 'partyId!:link(Party;isSupplier=true) email:email hasReplied~:check' },
  list: 'docNo materialRequestId replyBy',
});

define({
  name: 'SupplierQuotation',
  module: 'buying',
  series: 'SQ',
  submittable: true,
  fields: 'partyId!:link(Party;isSupplier=true) rfqId:link(RequestForQuotation) supplierRef validUntil:date totalPaise~:money',
  tables: { lines: 'itemId!:link(Item) qtyMilli!:qty ratePaise!:money gstRateBps:pct leadTimeDays:int' },
  list: 'docNo partyId rfqId validUntil totalPaise',
  prepare(_session, data) {
    const total = (data.lines ?? []).reduce((sum, l) => sum + mulDivRound(l.qtyMilli, l.ratePaise, 1000), 0);
    return { ...data, totalPaise: total };
  },
  async onSubmit(session, doc) {
    if (!doc.rfqId) return;
    const rfq = await modelOf('RequestForQuotation').findById(doc.rfqId).session(session);
    const row = rfq?.suppliers.find((s) => String(s.partyId) === String(doc.partyId));
    if (row) {
      row.hasReplied = true;
      await rfq.save({ session });
    }
  },
  actions: [{
    key: 'makePo',
    label: 'Make purchase order',
    primary: true,
    when: { status: ['SUBMITTED'] },
    fields: '',
    navigateTo: 'purchaseOrders',
    async run(session, doc, _body, { actor }) {
      return draftPo(session, { partyId: String(doc.partyId), lines: doc.lines.map((l) => ({ itemId: String(l.itemId), qtyMilli: l.qtyMilli, ratePaise: l.ratePaise, gstRateBps: l.gstRateBps })) }, actor);
    },
  }],
});

// Scored from what actually happened: on-time receipts and accepted quantity.
define({
  name: 'SupplierScorecard',
  module: 'buying',
  fields: 'partyId!:link(Party;isSupplier=true) fromDate!:date toDate!:date onTimeBps~:pct acceptedBps~:pct scoreBps~:pct standing~:select(EXCELLENT,GOOD,AVERAGE,POOR)',
  list: 'partyId fromDate toDate onTimeBps acceptedBps scoreBps standing',
  labelFields: ['partyId', 'toDate'],
  actions: [{
    key: 'evaluate',
    label: 'Work out score',
    primary: true,
    when: {},
    fields: '',
    async run(session, doc) {
      const receipts = await Grn.find({ partyId: doc.partyId, status: 'SUBMITTED', postingDate: { $gte: doc.fromDate, $lte: doc.toDate } }).session(session).lean();
      if (receipts.length === 0) throw rule('This supplier delivered nothing in those dates.', 'NO_RECEIPTS');
      const orders = await PurchaseOrder.find({ _id: { $in: receipts.map((r) => r.purchaseOrderId) } }, { expectedDate: 1 }).session(session).lean();
      const onTime = receipts.filter((r) => {
        const expected = orders.find((o) => String(o._id) === String(r.purchaseOrderId))?.expectedDate;
        return !expected || r.postingDate <= expected;
      }).length;
      const lines = receipts.flatMap((r) => r.lines);
      const received = lines.reduce((sum, l) => sum + l.qtyMilli, 0);
      const rejected = lines.reduce((sum, l) => sum + l.rejectedMilli, 0);
      doc.onTimeBps = mulDivRound(onTime, 10000, receipts.length);
      doc.acceptedBps = mulDivRound(received - rejected, 10000, received);
      doc.scoreBps = mulDivRound(doc.onTimeBps + doc.acceptedBps, 1, 2);
      doc.standing = doc.scoreBps >= 9000 ? 'EXCELLENT' : doc.scoreBps >= 7500 ? 'GOOD' : doc.scoreBps >= 5000 ? 'AVERAGE' : 'POOR';
      await doc.save({ session });
      return doc;
    },
  }],
});
