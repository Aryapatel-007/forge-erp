// Make-to-stock alongside machine builds: work orders, job cards, routing, MRP, subcontracting.
// Machine builds keep their own WIP. Work orders use their own account, so each can be
// checked against the ledger separately.
import { define, modelOf } from '../engine/registry.js';
import { createDoc } from '../engine/documents.js';
import { A } from '../config/accounts.js';
import { Bin } from '../models/ledgers.js';
import { BUILD_STAGES, Bom, JobWorkChallan, MachineBuild, PurchaseOrder, SalesOrder } from '../models/documents.js';
import { Item, Warehouse } from '../models/masters.js';
import { createBomRevision, explodeBom } from '../services/buildService.js';
import { postGl } from '../services/ledgerService.js';
import { getSettings } from '../services/settingsService.js';
import { accountForWarehouseKind, assertWarehouseKind, pickBuckets, stockIn, stockMove, stockOut, warehouseOfKind } from '../services/stockService.js';
import { applyBps, lineValue, mulDivRound, sumInts } from '../utils/money.js';
import { conflict, rule } from '../utils/errors.js';
import { addDays, todayIst } from '../utils/dates.js';

const BOM_LEVELS = 8;
const OPEN_BUILD_STAGES = BUILD_STAGES.filter((stage) => !['DISPATCHED', 'INSTALLED', 'CLOSED', 'CANCELLED'].includes(stage));

const m = (name, fields, extra = {}) => define({ name, module: 'manufacturing', fields, ...extra });

m('WorkstationType', 'name!* description hourRatePaise:money');
m('Workstation', 'name!* typeId:link(WorkstationType) hourRatePaise:money capacityPerDay:int=1 plantId:link(Plant) holidayListId:link(HolidayList) description:long', { tables: { workingHours: 'startTime:time endTime:time' }, list: 'name typeId hourRatePaise plantId', readers: 'all' });
m('Operation', 'name!* workstationId:link(Workstation) description:long minutes:int', { readers: 'all' });
m('Routing', 'name!* itemId:link(Item)', { tables: { steps: 'operationId!:link(Operation) workstationId:link(Workstation) hoursMilli:qty' }, readers: 'all' });
m('PlantFloor', 'name!* plantId:link(Plant) description', { tables: { workstations: 'workstationId:link(Workstation)' } });
m('DowntimeEntry', 'workstationId!:link(Workstation) fromTime!:datetime toTime:datetime reason:select(MACHINE_FAILURE,NO_MATERIAL,NO_OPERATOR,SETUP,POWER,OTHER)=MACHINE_FAILURE minutes~:int remarks:long', {
  labelFields: ['workstationId'],
  list: 'workstationId fromTime toTime reason minutes',
  index: [{ fromTime: -1 }],
  prepare(_session, data) {
    if (!data.toTime) return { ...data, minutes: 0 };
    const ms = new Date(data.toTime).getTime() - new Date(data.fromTime).getTime();
    if (ms < 0) throw rule('Downtime must end after it starts.', 'BAD_TIME_LOG');
    return { ...data, minutes: Math.round(ms / 60000) };
  },
});
m('SalesForecast', 'name!* fiscalYearId:link(FiscalYear)', { tables: { lines: 'itemId!:link(Item) forMonth! qtyMilli!:qty' } });
m('MasterProductionSchedule', 'name!* fromDate!:date toDate!:date', {
  tables: { lines: 'itemId!:link(Item) onDate!:date qtyMilli!:qty' },
  list: 'name fromDate toDate',
  actions: [{
    key: 'fromForecast',
    label: 'Fill from a forecast',
    when: {},
    fields: 'forecastId!:link(SalesForecast)',
    async run(session, doc, body) {
      const forecast = await modelOf('SalesForecast').findById(body.forecastId).session(session).lean();
      if (!forecast) throw rule('That forecast does not exist.', 'LINK_NOT_FOUND');
      const lines = forecast.lines
        .map((line) => ({ itemId: String(line.itemId), onDate: `${line.forMonth}-01`, qtyMilli: line.qtyMilli, _labels: line._labels }))
        .filter((line) => line.onDate >= doc.fromDate.slice(0, 7) && line.onDate <= doc.toDate);
      if (lines.length === 0) throw rule('That forecast has nothing for these dates.', 'NO_DEMAND');
      doc.lines.push(...lines);
      await doc.save({ session });
      return doc;
    },
  }],
});

/* ---------- Capacity ---------- */

const MAX_SCHEDULE_DAYS = 730;
const STANDARD_DAY_MILLI = 8000;
const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

const hhmm = (text) => {
  const [h, min] = String(text ?? '').split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(min) ? h * 60 + min : null;
};

// Hours a workstation can give in a day: its shifts, times how many it can run at once.
export function workstationDayMilli(station) {
  let minutes = 0;
  for (const shift of station.workingHours ?? []) {
    const from = hhmm(shift.startTime);
    const to = hhmm(shift.endTime);
    if (from !== null && to !== null && to > from) minutes += to - from;
  }
  const dayMilli = minutes > 0 ? Math.round((minutes * 1000) / 60) : STANDARD_DAY_MILLI;
  return dayMilli * Math.max(1, station.capacityPerDay ?? 1);
}

export async function isWorkingDay(session, station, date, cache = new Map()) {
  if (!station.holidayListId) return new Date(`${date}T00:00:00Z`).getUTCDay() !== 0;
  const key = String(station.holidayListId);
  if (!cache.has(key)) cache.set(key, await modelOf('HolidayList').findById(key).session(session).lean());
  const list = cache.get(key);
  if (!list) return true;
  if (WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()] === list.weeklyOff) return false;
  return !(list.holidays ?? []).some((h) => h.onDate === date);
}

const freeBookings = (session, doc) => modelOf('CapacityBooking').deleteMany({ workOrderId: String(doc._id) }, { session });

// Hours booked on a workstation for a day. Written only by scheduling a work order.
m('CapacityBooking', 'workstationId!:link(Workstation) onDate!:date workOrderId:link(WorkOrder) hoursMilli:qty', { labelFields: ['workstationId'], list: 'workstationId onDate workOrderId hoursMilli', dateField: 'onDate', readers: 'all', writers: ['ADMIN'], index: [{ workstationId: 1, onDate: 1 }, { workOrderId: 1 }] });

/* ---------- Work orders ---------- */

const openOrderStates = ['NOT_STARTED', 'IN_PROCESS'];
const voucherOf = (doc, postingDate = todayIst()) => ({ voucherType: 'WorkOrder', voucherId: doc._id, voucherNo: doc.docNo, postingDate });
const postWo = (session, doc, narration, lines, postingDate = todayIst()) => postGl(session, { postingDate, voucherType: 'WorkOrder', voucherId: doc._id, voucherNo: doc.docNo, narration, lines });

async function issueQty(session, doc, row, qty) {
  const voucher = voucherOf(doc);
  const picks = await pickBuckets(session, { itemId: row.itemId, qtyMilli: qty, warehouseId: doc.sourceWarehouseId ?? null });
  let value = 0;
  for (const pick of picks) value += (await stockOut(session, { voucher, ...pick })).valuePaise;
  row.issuedMilli += qty;
  row.issuedValuePaise += value;
  return value;
}

const rowFor = (doc, itemId) => {
  const row = doc.materials.find((r) => String(r.itemId) === String(itemId));
  if (!row) throw rule('That item is not on this work order.', 'NOT_ON_ORDER');
  return row;
};

const leftToMake = (doc) => doc.qtyMilli - doc.producedMilli - doc.processLossMilli;

async function writeOffWip(session, doc, narration) {
  if (doc.wipPaise > 0) {
    await postWo(session, doc, narration, [{ accountCode: A.MFG_VARIANCE, debitPaise: doc.wipPaise }, { accountCode: A.WIP_WORK_ORDERS, creditPaise: doc.wipPaise }]);
    doc.varianceValuePaise += doc.wipPaise;
    doc.wipPaise = 0;
  }
}

async function finishOrder(session, doc, state) {
  doc.state = state;
  doc.completedOn = todayIst();
  await freeBookings(session, doc);
}

// Issuing and producing post under the work order's own voucher, so cancelling it undoes
// all of them together. It cannot be cancelled once anything has been produced.
define({
  name: 'WorkOrder',
  module: 'manufacturing',
  series: 'WO',
  submittable: true,
  labelFields: ['docNo'],
  fields: 'itemId!:link(Item) bomId:link(Bom) routingId:link(Routing) singleLevel:check qtyMilli!:qty sourceWarehouseId:link(Warehouse) targetWarehouseId!:link(Warehouse) salesOrderId:link(SalesOrder) productionPlanId:link(ProductionPlan) plannedStart:date plannedEnd:date lot backflush:check requiresInspection:check allowOverBps:pct state~:select(NOT_STARTED,IN_PROCESS,COMPLETED,STOPPED,CLOSED)=NOT_STARTED producedMilli~:qty processLossMilli~:qty inspectionPendingMilli~:qty rejectedMilli~:qty wipPaise~:money producedValuePaise~:money byProductValuePaise~:money varianceValuePaise~:money scheduledStart~:date scheduledEnd~:date completedOn~:date closeReason~ quarantineWarehouseId~:link(Warehouse)',
  labels: { singleLevel: 'Sub-assemblies come from stock', allowOverBps: 'Over-production allowed %', backflush: 'Issue materials automatically on finishing', requiresInspection: 'Finished goods need inspection', sourceWarehouseId: 'Take materials from' },
  tables: {
    materials: 'itemId!:link(Item) requiredMilli!:qty issuedMilli~:qty issuedValuePaise~:money',
    operations: 'operationId!:link(Operation) workstationId:link(Workstation) plannedHoursMilli:qty doneHoursMilli~:qty completedMilli~:qty scheduledStart~:date scheduledEnd~:date',
    'byProducts~': 'itemId:link(Item) qtyMilli:qty valuePaise:money warehouseId:link(Warehouse) onDate:date',
    'losses~': 'onDate:date qtyMilli:qty reason',
  },
  list: 'docNo itemId qtyMilli producedMilli plannedEnd state',
  async prepare(session, data, { isNew }) {
    const out = { ...data };
    if (isNew) {
      const settings = await getSettings(session);
      out.allowOverBps ??= settings.woDefaultOverBps;
      out.backflush ??= settings.woDefaultBackflush;
    }
    if (out.bomId && !out.materials?.length) {
      const bom = await Bom.findById(out.bomId).session(session).lean();
      if (!bom) throw rule('That BOM does not exist.', 'LINK_NOT_FOUND');
      if (bom.status !== 'RELEASED') throw rule('Only a released BOM can be used.', 'BOM_NOT_RELEASED');
      if (String(bom.itemId) !== String(out.itemId)) throw rule('That BOM is for another item.', 'BOM_OTHER_ITEM');
      if (out.singleLevel) {
        out.materials = bom.lines.map((line) => ({ itemId: String(line.itemId), requiredMilli: mulDivRound(line.qtyMilli + applyBps(line.qtyMilli, line.scrapBps ?? 0), out.qtyMilli, 1000) }));
      } else {
        const materials = await explodeBom(session, bom, out.qtyMilli);
        out.materials = materials.map((row) => ({ itemId: String(row.itemId), requiredMilli: row.requiredMilli }));
      }
    }
    if (!out.routingId) {
      const routing = await modelOf('Routing').findOne({ itemId: String(out.itemId) }).session(session).lean();
      if (routing) out.routingId = String(routing._id);
    }
    if (out.routingId && !out.operations?.length) {
      const routing = await modelOf('Routing').findById(out.routingId).session(session).lean();
      out.operations = (routing?.steps ?? []).map((step) => ({
        operationId: String(step.operationId),
        workstationId: step.workstationId ? String(step.workstationId) : null,
        plannedHoursMilli: mulDivRound(step.hoursMilli ?? 0, out.qtyMilli, 1000),
      }));
    }
    return out;
  },
  async onSubmit(session, doc) {
    if (!doc.materials.length) throw rule('A work order needs materials. Choose a released BOM.', 'NO_MATERIALS');
    await assertWarehouseKind(session, doc.targetWarehouseId, ['STORES', 'FG']);
    if (doc.sourceWarehouseId) await assertWarehouseKind(session, doc.sourceWarehouseId, ['STORES']);
  },
  async onCancel(session, doc) {
    if (doc.producedMilli > 0) throw rule('This work order has produced stock, so it cannot be cancelled.', 'WORK_ORDER_PRODUCED');
    // A job card's cost posts under the card, so cancelling the order alone would strand it.
    const cards = await modelOf('JobCard').countDocuments({ workOrderId: String(doc._id), status: 'SUBMITTED' }).session(session);
    if (cards > 0) throw conflict('Job cards are posted against this order. Cancel them first.', 'HAS_JOB_CARDS');
    await freeBookings(session, doc);
  },
  actions: [
    {
      key: 'issue',
      label: 'Issue all materials',
      primary: true,
      when: { status: ['SUBMITTED'], state: openOrderStates },
      fields: '',
      async run(session, doc) {
        let total = 0;
        let anything = false;
        for (const row of doc.materials) {
          const needed = row.requiredMilli - row.issuedMilli;
          if (needed <= 0) continue;
          anything = true;
          total += await issueQty(session, doc, row, needed);
        }
        if (!anything && doc.state !== 'NOT_STARTED') throw rule('Everything has been issued.', 'ALREADY_ISSUED');
        doc.wipPaise += total;
        doc.state = 'IN_PROCESS';
        await doc.save({ session });
        await postWo(session, doc, `Materials for ${doc.docNo}`, [{ accountCode: A.WIP_WORK_ORDERS, debitPaise: total }, { accountCode: A.INVENTORY, creditPaise: total }]);
        return doc;
      },
    },
    {
      key: 'issuePart',
      label: 'Issue some',
      when: { status: ['SUBMITTED'], state: openOrderStates },
      fields: 'itemId!:link(Item) qtyMilli!:qty',
      async run(session, doc, body) {
        const row = rowFor(doc, body.itemId);
        const limit = row.requiredMilli + applyBps(row.requiredMilli, doc.allowOverBps ?? 0);
        if (body.qtyMilli <= 0) throw rule('Enter a quantity.', 'QTY_REQUIRED');
        if (row.issuedMilli + body.qtyMilli > limit) throw rule(`Only ${(limit - row.issuedMilli) / 1000} more can be issued for this item.`, 'OVER_ISSUED');
        const value = await issueQty(session, doc, row, body.qtyMilli);
        doc.wipPaise += value;
        doc.state = 'IN_PROCESS';
        await doc.save({ session });
        await postWo(session, doc, `Materials for ${doc.docNo}`, [{ accountCode: A.WIP_WORK_ORDERS, debitPaise: value }, { accountCode: A.INVENTORY, creditPaise: value }]);
        return doc;
      },
    },
    {
      key: 'returnMaterial',
      label: 'Return materials',
      when: { status: ['SUBMITTED'], state: ['IN_PROCESS'] },
      fields: 'itemId!:link(Item) qtyMilli!:qty warehouseId!:link(Warehouse) lot',
      async run(session, doc, body) {
        const row = rowFor(doc, body.itemId);
        if (body.qtyMilli <= 0 || body.qtyMilli > row.issuedMilli) throw rule(`Only ${row.issuedMilli / 1000} has been issued.`, 'OVER_RETURNED');
        await assertWarehouseKind(session, body.warehouseId, ['STORES']);
        const value = body.qtyMilli === row.issuedMilli ? row.issuedValuePaise : mulDivRound(row.issuedValuePaise, body.qtyMilli, row.issuedMilli);
        if (value > doc.wipPaise) throw rule('That cost has already moved into finished goods.', 'COST_ALREADY_MOVED');
        await stockIn(session, { voucher: voucherOf(doc), itemId: row.itemId, warehouseId: body.warehouseId, lot: body.lot ?? '', qtyMilli: body.qtyMilli, valuePaise: value });
        row.issuedMilli -= body.qtyMilli;
        row.issuedValuePaise -= value;
        doc.wipPaise -= value;
        await doc.save({ session });
        await postWo(session, doc, `Returned from ${doc.docNo}`, [{ accountCode: A.INVENTORY, debitPaise: value }, { accountCode: A.WIP_WORK_ORDERS, creditPaise: value }]);
        return doc;
      },
    },
    {
      key: 'substitute',
      label: 'Use an alternative',
      when: { status: ['SUBMITTED'], state: openOrderStates },
      fields: 'itemId!:link(Item) alternativeItemId!:link(Item)',
      async run(session, doc, body) {
        const row = rowFor(doc, body.itemId);
        const listed = await modelOf('ItemAlternative').findOne({ $or: [
          { itemId: body.itemId, alternativeItemId: body.alternativeItemId },
          { itemId: body.alternativeItemId, alternativeItemId: body.itemId, twoWay: true },
        ] }).session(session).lean();
        if (!listed) throw rule('That item is not listed as an alternative to this one.', 'NOT_AN_ALTERNATIVE');
        const left = row.requiredMilli - row.issuedMilli;
        if (left <= 0) throw rule('This item has already been fully issued.', 'ALREADY_ISSUED');
        row.requiredMilli = row.issuedMilli;
        const existing = doc.materials.find((r) => String(r.itemId) === String(body.alternativeItemId));
        if (existing) existing.requiredMilli += left;
        else doc.materials.push({ itemId: body.alternativeItemId, requiredMilli: left });
        if (row.requiredMilli === 0) doc.materials.pull(row._id);
        await doc.save({ session });
        return doc;
      },
    },
    {
      key: 'start',
      label: 'Start',
      when: { status: ['SUBMITTED'], state: ['NOT_STARTED'], backflush: [true] },
      fields: '',
      async run(session, doc) {
        doc.state = 'IN_PROCESS';
        await doc.save({ session });
        return doc;
      },
    },
    {
      key: 'produce',
      label: 'Finish goods',
      primary: true,
      when: { status: ['SUBMITTED'], state: ['IN_PROCESS'] },
      fields: 'qtyMilli!:qty serialNos:long',
      async run(session, doc, body, { actor }) {
        const left = leftToMake(doc);
        const qty = Number(body.qtyMilli);
        if (!Number.isSafeInteger(qty) || qty <= 0) throw rule('Enter a quantity.', 'QTY_REQUIRED');
        const allowance = applyBps(doc.qtyMilli, doc.allowOverBps ?? 0);
        if (qty > left + allowance) throw rule(`Only ${(left + allowance) / 1000} left to make on this order.`, 'OVER_PRODUCED');
        const postingDate = todayIst();

        // Materials used for this batch are this batch's cost. Only the rest is shared.
        let issued = 0;
        const costBefore = doc.wipPaise;
        if (doc.backflush) {
          for (const row of doc.materials) {
            const target = mulDivRound(row.requiredMilli, Math.min(doc.qtyMilli, doc.producedMilli + doc.processLossMilli + qty), doc.qtyMilli);
            if (target > row.issuedMilli) issued += await issueQty(session, doc, row, target - row.issuedMilli);
          }
          doc.wipPaise += issued;
          await postWo(session, doc, `Materials used on ${doc.docNo}`, [{ accountCode: A.WIP_WORK_ORDERS, debitPaise: issued }, { accountCode: A.INVENTORY, creditPaise: issued }], postingDate);
        }

        const target = await assertWarehouseKind(session, doc.targetWarehouseId, ['STORES', 'FG']);
        const warehouse = doc.requiresInspection ? await warehouseOfKind(session, 'QUARANTINE') : target;
        // Finishing the last of the order takes every remaining paisa of WIP.
        const value = qty >= left ? doc.wipPaise : issued + mulDivRound(costBefore, qty, left);
        const lot = doc.lot ?? '';
        await stockIn(session, { voucher: voucherOf(doc, postingDate), itemId: doc.itemId, warehouseId: warehouse._id, lot, qtyMilli: qty, valuePaise: value });
        await postWo(session, doc, `Finished on ${doc.docNo}`, [{ accountCode: accountForWarehouseKind(warehouse.kind), debitPaise: value }, { accountCode: A.WIP_WORK_ORDERS, creditPaise: value }], postingDate);

        if (lot && !(await modelOf('Batch').findOne({ batchNo: lot }).session(session).lean())) {
          await createDoc(session, 'Batch', { batchNo: lot, itemId: String(doc.itemId), manufacturedOn: postingDate }, actor);
        }
        const item = await Item.findById(doc.itemId).session(session).lean();
        if (item?.hasSerialNo) {
          const serials = String(body.serialNos ?? '').split(/[\s,]+/).filter(Boolean);
          if (qty % 1000 !== 0 || serials.length !== qty / 1000) throw rule(`Give one serial number for each piece: ${qty / 1000} needed, ${serials.length} given.`, 'SERIAL_COUNT');
          for (const serialNo of serials) await createDoc(session, 'SerialNo', { serialNo, itemId: String(doc.itemId), warehouseId: String(warehouse._id), state: 'IN_STOCK' }, actor);
        }

        doc.producedMilli += qty;
        doc.producedValuePaise += value;
        doc.wipPaise -= value;
        if (doc.requiresInspection) {
          doc.quarantineWarehouseId = String(warehouse._id);
          doc.inspectionPendingMilli += qty;
        }
        if (leftToMake(doc) <= 0) await finishOrder(session, doc, 'COMPLETED');
        await doc.save({ session });
        return doc;
      },
    },
    {
      key: 'releaseInspected',
      label: 'Inspection result',
      when: { status: ['SUBMITTED'], requiresInspection: [true] },
      fields: 'qtyMilli!:qty passed:check=true remarks',
      async run(session, doc, body) {
        if (body.qtyMilli <= 0 || body.qtyMilli > doc.inspectionPendingMilli) throw rule(`Only ${doc.inspectionPendingMilli / 1000} is waiting for inspection.`, 'NOT_WAITING');
        const postingDate = todayIst();
        const passed = body.passed !== false;
        const to = passed ? await assertWarehouseKind(session, doc.targetWarehouseId, ['STORES', 'FG']) : await warehouseOfKind(session, 'REJECT');
        const { valuePaise } = await stockMove(session, {
          voucher: voucherOf(doc, postingDate),
          qtyMilli: body.qtyMilli,
          from: { itemId: doc.itemId, warehouseId: doc.quarantineWarehouseId, lot: doc.lot ?? '', buildId: null },
          to: { warehouseId: to._id },
        });
        const account = accountForWarehouseKind(to.kind);
        if (account !== A.INVENTORY) {
          await postWo(session, doc, `Passed inspection on ${doc.docNo}`, [{ accountCode: account, debitPaise: valuePaise }, { accountCode: A.INVENTORY, creditPaise: valuePaise }], postingDate);
        }
        doc.inspectionPendingMilli -= body.qtyMilli;
        if (!passed) doc.rejectedMilli += body.qtyMilli;
        await doc.save({ session });
        return doc;
      },
    },
    {
      key: 'reportLoss',
      label: 'Record process loss',
      when: { status: ['SUBMITTED'], state: ['IN_PROCESS'] },
      fields: 'qtyMilli!:qty reason!',
      async run(session, doc, body) {
        const left = leftToMake(doc);
        if (body.qtyMilli <= 0 || body.qtyMilli > left) throw rule(`Only ${left / 1000} is still to be made.`, 'OVER_LOSS');
        // The cost stays in WIP and falls on the good pieces, unless no good pieces remain.
        doc.processLossMilli += body.qtyMilli;
        doc.losses.push({ onDate: todayIst(), qtyMilli: body.qtyMilli, reason: body.reason });
        if (leftToMake(doc) <= 0) {
          await writeOffWip(session, doc, `Process loss on ${doc.docNo}`);
          await finishOrder(session, doc, 'COMPLETED');
        }
        await doc.save({ session });
        return doc;
      },
    },
    {
      key: 'recordByProduct',
      label: 'Record by-product or scrap',
      when: { status: ['SUBMITTED'], state: ['IN_PROCESS'] },
      fields: 'itemId!:link(Item) qtyMilli!:qty valuePaise!:money warehouseId!:link(Warehouse)',
      async run(session, doc, body) {
        if (body.valuePaise > doc.wipPaise) throw rule('Its value is more than the cost left on this order.', 'OVER_WIP');
        const warehouse = await assertWarehouseKind(session, body.warehouseId, ['STORES', 'FG', 'REJECT']);
        const postingDate = todayIst();
        await stockIn(session, { voucher: voucherOf(doc, postingDate), itemId: body.itemId, warehouseId: warehouse._id, qtyMilli: body.qtyMilli, valuePaise: body.valuePaise });
        await postWo(session, doc, `By-product on ${doc.docNo}`, [{ accountCode: accountForWarehouseKind(warehouse.kind), debitPaise: body.valuePaise }, { accountCode: A.WIP_WORK_ORDERS, creditPaise: body.valuePaise }], postingDate);
        doc.wipPaise -= body.valuePaise;
        doc.byProductValuePaise += body.valuePaise;
        doc.byProducts.push({ itemId: body.itemId, qtyMilli: body.qtyMilli, valuePaise: body.valuePaise, warehouseId: body.warehouseId, onDate: postingDate });
        await doc.save({ session });
        return doc;
      },
    },
    {
      key: 'closeShort',
      label: 'Close short',
      when: { status: ['SUBMITTED'], state: ['IN_PROCESS'] },
      fields: 'reason!',
      async run(session, doc, body) {
        await writeOffWip(session, doc, `Closed short: ${doc.docNo}`);
        doc.closeReason = body.reason;
        await finishOrder(session, doc, 'CLOSED');
        await doc.save({ session });
        return doc;
      },
    },
    {
      key: 'stop',
      label: 'Stop',
      when: { status: ['SUBMITTED'], state: openOrderStates },
      fields: '',
      async run(session, doc) {
        if (doc.wipPaise !== 0) throw rule('Materials are still on this order. Finish them or cancel it.', 'WORK_ORDER_HAS_WIP');
        doc.state = 'STOPPED';
        await freeBookings(session, doc);
        await doc.save({ session });
        return doc;
      },
    },
    {
      key: 'makeJobCards',
      label: 'Make job cards',
      when: { status: ['SUBMITTED'], state: openOrderStates },
      fields: '',
      navigate: 'JobCard',
      async run(session, doc, _body, { actor }) {
        if (doc.operations.length === 0) throw rule('This order has no operations. Choose a routing.', 'NO_OPERATIONS');
        let made = null;
        for (const op of doc.operations) {
          const existing = await modelOf('JobCard').countDocuments({ workOrderId: String(doc._id), operationId: String(op.operationId), status: { $ne: 'CANCELLED' } }).session(session);
          if (existing > 0) continue;
          made = await createDoc(session, 'JobCard', { workOrderId: String(doc._id), operationId: String(op.operationId), workstationId: op.workstationId ? String(op.workstationId) : null, hoursMilli: op.plannedHoursMilli, completedMilli: 0 }, actor);
        }
        if (!made) throw rule('Every operation already has a job card.', 'ALREADY_MADE');
        return made;
      },
    },
    {
      // Works back from the date promised, last operation first, and says so if that would
      // have had to start in the past.
      key: 'scheduleBack',
      label: 'Schedule back from a due date',
      when: { status: ['SUBMITTED'], state: openOrderStates },
      fields: 'dueDate!:date',
      async run(session, doc, body) {
        if (doc.operations.length === 0) throw rule('This order has no operations to schedule.', 'NO_OPERATIONS');
        await freeBookings(session, doc);
        const today = todayIst();
        const holidayCache = new Map();
        const Booking = modelOf('CapacityBooking');
        let cursor = body.dueDate;
        for (const op of [...doc.operations].reverse()) {
          op.scheduledStart = cursor;
          op.scheduledEnd = cursor;
          let remaining = Math.max(0, op.plannedHoursMilli - op.doneHoursMilli);
          if (!op.workstationId || remaining === 0) continue;
          const station = await modelOf('Workstation').findById(op.workstationId).session(session).lean();
          const dayMilli = workstationDayMilli(station);
          let last = null;
          for (let i = 0; remaining > 0; i += 1) {
            const day = addDays(cursor, -i);
            if (day < today) throw rule(`There is not enough free time to finish by ${body.dueDate}. Schedule forward to see when it can be done.`, 'CANNOT_MAKE_DATE');
            if (!(await isWorkingDay(session, station, day, holidayCache))) continue;
            const [booked] = await Booking.aggregate([{ $match: { workstationId: String(op.workstationId), onDate: day } }, { $group: { _id: null, hours: { $sum: '$hoursMilli' } } }]).session(session);
            const free = dayMilli - (booked?.hours ?? 0);
            if (free <= 0) continue;
            const use = Math.min(free, remaining);
            await Booking.create([{ workstationId: String(op.workstationId), onDate: day, workOrderId: String(doc._id), hoursMilli: use }], { session });
            remaining -= use;
            last ??= day;
            op.scheduledStart = day;
          }
          op.scheduledEnd = last;
          cursor = op.scheduledStart;
        }
        doc.scheduledStart = doc.operations[0].scheduledStart;
        doc.scheduledEnd = doc.operations.at(-1).scheduledEnd;
        doc.plannedStart = doc.scheduledStart;
        doc.plannedEnd = doc.scheduledEnd;
        await doc.save({ session });
        return doc;
      },
    },
    {
      key: 'schedule',
      label: 'Schedule against capacity',
      when: { status: ['SUBMITTED'], state: openOrderStates },
      fields: 'startDate!:date',
      async run(session, doc, body) {
        if (doc.operations.length === 0) throw rule('This order has no operations to schedule.', 'NO_OPERATIONS');
        await freeBookings(session, doc);
        const holidayCache = new Map();
        const Booking = modelOf('CapacityBooking');
        let cursor = body.startDate;
        for (const op of doc.operations) {
          op.scheduledStart = cursor;
          op.scheduledEnd = cursor;
          let remaining = Math.max(0, op.plannedHoursMilli - op.doneHoursMilli);
          if (!op.workstationId || remaining === 0) continue;
          const station = await modelOf('Workstation').findById(op.workstationId).session(session).lean();
          const dayMilli = workstationDayMilli(station);
          let first = null;
          for (let i = 0; remaining > 0; i += 1) {
            if (i > MAX_SCHEDULE_DAYS) throw rule('This workstation has no free time in the next two years.', 'NO_CAPACITY');
            const day = addDays(cursor, i);
            if (!(await isWorkingDay(session, station, day, holidayCache))) continue;
            const [booked] = await Booking.aggregate([{ $match: { workstationId: String(op.workstationId), onDate: day } }, { $group: { _id: null, hours: { $sum: '$hoursMilli' } } }]).session(session);
            const free = dayMilli - (booked?.hours ?? 0);
            if (free <= 0) continue;
            const use = Math.min(free, remaining);
            await Booking.create([{ workstationId: String(op.workstationId), onDate: day, workOrderId: String(doc._id), hoursMilli: use }], { session });
            remaining -= use;
            first ??= day;
            op.scheduledEnd = day;
          }
          op.scheduledStart = first;
          cursor = op.scheduledEnd;
        }
        doc.scheduledStart = doc.operations[0].scheduledStart;
        doc.scheduledEnd = doc.operations.at(-1).scheduledEnd;
        doc.plannedStart = doc.scheduledStart;
        doc.plannedEnd = doc.scheduledEnd;
        await doc.save({ session });
        return doc;
      },
    },
  ],
});

async function workOrderFor(session, doc) {
  const order = await modelOf('WorkOrder').findById(doc.workOrderId).session(session);
  if (!order || order.status !== 'SUBMITTED') throw rule('That work order is not live.', 'WORK_ORDER_NOT_LIVE');
  if (['COMPLETED', 'CLOSED', 'STOPPED'].includes(order.state)) throw rule('That work order is finished and takes no more cost.', 'WORK_ORDER_DONE');
  return order;
}

// Time on an operation. The workstation's rate moves into the work order's WIP.
define({
  name: 'JobCard',
  module: 'manufacturing',
  series: 'JC',
  submittable: true,
  labelFields: ['docNo'],
  fields: 'workOrderId!:link(WorkOrder) operationId!:link(Operation) workstationId:link(Workstation) employeeId:link(Employee) hoursMilli:qty completedMilli:qty ratePaise:money valuePaise~:money remarks',
  tables: { timeLogs: 'fromTime:datetime toTime:datetime employeeId:link(Employee) hoursMilli:qty' },
  list: 'docNo workOrderId operationId workstationId hoursMilli valuePaise',
  labels: { completedMilli: 'Pieces completed' },
  prepare(_session, data) {
    const out = { ...data };
    if (out.timeLogs?.length) {
      out.timeLogs = out.timeLogs.map((log) => {
        if (log.hoursMilli || !log.fromTime || !log.toTime) return log;
        const ms = new Date(log.toTime).getTime() - new Date(log.fromTime).getTime();
        if (ms <= 0) throw rule('A time log must end after it starts.', 'BAD_TIME_LOG');
        return { ...log, hoursMilli: Math.round(ms / 3600) };
      });
      out.hoursMilli = sumInts(out.timeLogs.map((log) => log.hoursMilli ?? 0));
    }
    return out;
  },
  async onSubmit(session, doc) {
    if (!doc.hoursMilli) throw rule('Enter the hours worked.', 'HOURS_REQUIRED');
    const order = await workOrderFor(session, doc);

    // One person cannot be in two places at once.
    const people = doc.timeLogs.filter((log) => log.employeeId && log.fromTime && log.toTime);
    if (people.length > 0) {
      const others = await modelOf('JobCard').find({ _id: { $ne: doc._id }, status: 'SUBMITTED', 'timeLogs.employeeId': { $in: people.map((log) => log.employeeId) } }).session(session).lean();
      for (const log of people) {
        const from = new Date(log.fromTime).getTime();
        const to = new Date(log.toTime).getTime();
        for (const other of others) {
          for (const theirs of other.timeLogs) {
            if (String(theirs.employeeId) !== String(log.employeeId) || !theirs.fromTime || !theirs.toTime) continue;
            if (from < new Date(theirs.toTime).getTime() && to > new Date(theirs.fromTime).getTime()) throw rule(`That person is already booked on ${other.docNo} at that time.`, 'EMPLOYEE_BUSY');
          }
        }
      }
    }

    let rate = doc.ratePaise;
    if (!rate && doc.workstationId) rate = (await modelOf('Workstation').findById(doc.workstationId).session(session).lean())?.hourRatePaise ?? 0;
    doc.ratePaise = rate;
    doc.valuePaise = lineValue(doc.hoursMilli, rate);
    order.wipPaise += doc.valuePaise;
    if (order.state === 'NOT_STARTED') order.state = 'IN_PROCESS';
    const index = order.operations.findIndex((o) => String(o.operationId) === String(doc.operationId));
    if (index >= 0) {
      const operation = order.operations[index];
      operation.doneHoursMilli += doc.hoursMilli;
      if (doc.completedMilli > 0) {
        const total = operation.completedMilli + doc.completedMilli;
        const previous = order.operations[index - 1];
        if (previous && total > previous.completedMilli) throw rule(`Only ${previous.completedMilli / 1000} have come through the step before this one.`, 'OUT_OF_SEQUENCE');
        if (total > order.qtyMilli + applyBps(order.qtyMilli, order.allowOverBps ?? 0)) throw rule('That is more than this order is making.', 'OVER_COMPLETED');
        operation.completedMilli = total;
      }
    }
    await order.save({ session });
    await postGl(session, { postingDate: doc.postingDate, voucherType: 'JobCard', voucherId: doc._id, voucherNo: doc.docNo, narration: `Job card on ${order.docNo}`, lines: [{ accountCode: A.WIP_WORK_ORDERS, debitPaise: doc.valuePaise }, { accountCode: A.LABOUR_ABSORBED, creditPaise: doc.valuePaise }] });
    return { action: 'JOB_CARD_POSTED', data: { valuePaise: doc.valuePaise } };
  },
  async onCancel(session, doc) {
    const order = await workOrderFor(session, doc);
    // Once anything has been finished, part of this cost is already in that stock.
    if (order.producedMilli > 0) throw conflict('Cost from this card has already moved into finished goods.', 'COST_ALREADY_MOVED');
    order.wipPaise -= doc.valuePaise;
    const index = order.operations.findIndex((o) => String(o.operationId) === String(doc.operationId));
    if (index >= 0) {
      const operation = order.operations[index];
      operation.doneHoursMilli -= doc.hoursMilli;
      operation.completedMilli -= doc.completedMilli;
      const next = order.operations[index + 1];
      if (next && next.completedMilli > operation.completedMilli) throw conflict('The next step has already used these pieces.', 'LATER_STEP_DONE');
    }
    await order.save({ session });
  },
});

/* ---------- MRP ---------- */

// Works down the BOMs one level at a time, netting each item against what is free, so a
// sub-assembly in stock stops its parts being bought. An item used at several depths waits
// until its lowest use, so all of its demand is known before it is netted.
async function runMrp(session, doc) {
  const today = todayIst();
  const top = new Map();
  for (const row of doc.items) {
    const key = String(row.itemId);
    const entry = top.get(key) ?? { firm: 0, needBy: row.requiredBy ?? doc.planDate };
    entry.firm += row.qtyMilli;
    if (row.requiredBy && row.requiredBy < entry.needBy) entry.needBy = row.requiredBy;
    top.set(key, entry);
  }

  const boms = new Map();
  const itemsById = new Map();
  const load = async (ids) => {
    const missing = ids.filter((id) => !itemsById.has(id));
    if (missing.length === 0) return;
    for (const item of await Item.find({ _id: { $in: missing } }).session(session).lean()) itemsById.set(String(item._id), item);
    for (const bom of await Bom.find({ itemId: { $in: missing }, status: 'RELEASED' }).session(session).lean()) boms.set(String(bom.itemId), bom);
  };
  await load([...top.keys()]);
  const makes = (id) => boms.has(id) && (top.has(id) || itemsById.get(id)?.type === 'ASSEMBLY');
  for (const id of top.keys()) {
    if (!boms.has(id)) throw rule('One of these items has no released BOM.', 'NO_RELEASED_BOM', { itemId: id });
  }

  // Lowest level each item appears at.
  const levels = new Map();
  const walk = async (id, level, path) => {
    if (path.includes(id)) throw rule('These BOMs contain a loop.', 'BOM_LOOP');
    if (level > BOM_LEVELS) throw rule('These BOMs are nested too deeply.', 'BOM_TOO_DEEP');
    levels.set(id, Math.max(levels.get(id) ?? 0, level));
    await load([id]);
    if (!makes(id)) return;
    const children = boms.get(id).lines.map((line) => String(line.itemId));
    await load(children);
    for (const child of children) await walk(child, level + 1, [...path, id]);
  };
  for (const id of top.keys()) await walk(id, 0, []);

  const ids = [...levels.keys()];
  const stores = (await Warehouse.find({ kind: { $in: ['STORES', 'FG'] } }, { _id: 1 }).session(session).lean()).map((w) => w._id);
  const bins = await Bin.find({ itemId: { $in: ids }, warehouseId: { $in: stores }, buildId: null }).session(session).lean();
  const sumFor = (rows, id, valueOf) => sumInts(rows.filter((r) => r.key === id).map(valueOf));
  const onHandRows = bins.map((b) => ({ key: String(b.itemId), qty: b.qtyMilli }));

  // Coming in. Purchase lines for one build are already that build's, and are netted there.
  const orderRows = [];
  if (doc.considerOnOrder !== false) {
    const orders = await PurchaseOrder.find({ status: 'APPROVED', 'lines.itemId': { $in: ids } }, { lines: 1, expectedDate: 1 }).session(session).lean();
    for (const order of orders) {
      for (const line of order.lines) {
        if (!line.buildId && line.qtyMilli > line.receivedMilli) orderRows.push({ key: String(line.itemId), qty: line.qtyMilli - line.receivedMilli, on: order.expectedDate ?? null });
      }
    }
    const open = await modelOf('WorkOrder').find({ status: 'SUBMITTED', state: { $in: openOrderStates }, itemId: { $in: ids } }, { itemId: 1, qtyMilli: 1, producedMilli: 1, processLossMilli: 1, plannedEnd: 1 }).session(session).lean();
    for (const order of open) orderRows.push({ key: String(order.itemId), qty: Math.max(0, order.qtyMilli - order.producedMilli - order.processLossMilli), on: order.plannedEnd ?? null });
  }

  // Already spoken for, by other open work orders and machine builds.
  const claimRows = [];
  const openOrders = await modelOf('WorkOrder').find({ status: 'SUBMITTED', state: { $in: openOrderStates } }, { materials: 1 }).session(session).lean();
  for (const order of openOrders) {
    for (const row of order.materials) if (row.requiredMilli > row.issuedMilli) claimRows.push({ key: String(row.itemId), qty: row.requiredMilli - row.issuedMilli });
  }
  const builds = await MachineBuild.find({ stage: { $in: OPEN_BUILD_STAGES } }, { materials: 1 }).session(session).lean();
  if (builds.length > 0) {
    const pegged = await Bin.find({ buildId: { $in: builds.map((b) => b._id) }, qtyMilli: { $gt: 0 } }).session(session).lean();
    const peggedOrders = await PurchaseOrder.find({ status: 'APPROVED', 'lines.buildId': { $in: builds.map((b) => b._id) } }, { lines: 1 }).session(session).lean();
    for (const build of builds) {
      for (const material of build.materials ?? []) {
        const key = String(material.itemId);
        const held = sumInts(pegged.filter((b) => String(b.buildId) === String(build._id) && String(b.itemId) === key).map((b) => b.qtyMilli));
        const coming = sumInts(peggedOrders.flatMap((o) => o.lines).filter((l) => String(l.buildId) === String(build._id) && String(l.itemId) === key).map((l) => Math.max(0, l.qtyMilli - l.receivedMilli)));
        const claim = material.requiredMilli - material.issuedMilli - held - coming;
        if (claim > 0) claimRows.push({ key, qty: claim });
      }
    }
  }

  const gross = new Map([...top.entries()].map(([id, entry]) => [id, entry.firm]));
  const needBy = new Map([...top.entries()].map(([id, entry]) => [id, entry.needBy]));
  const order = ids.slice().sort((a, b) => levels.get(a) - levels.get(b));
  const rows = [];
  for (const id of order) {
    const item = itemsById.get(id);
    const required = gross.get(id) ?? 0;
    if (required === 0) continue;
    const supply = makes(id) ? 'MAKE' : 'BUY';
    const firm = top.get(id)?.firm ?? 0;
    const onHandMilli = sumFor(onHandRows, id, (r) => r.qty);
    const allocatedMilli = sumFor(claimRows, id, (r) => r.qty);
    const safetyMilli = doc.considerSafetyStock === false ? 0 : (item?.reorderLevelMilli ?? 0);
    // What the plan's own items call for is to be made regardless. Only demand from a
    // parent, plus what others have claimed, is met from stock.
    const fromParents = required - firm;
    const date = needBy.get(id) ?? doc.planDate;
    // Supply due after the need is too late to count. Supply with no date is taken at its word.
    const onOrderMilli = sumFor(orderRows.filter((r) => !r.on || r.on <= date), id, (r) => r.qty);
    const lateSupplyMilli = sumFor(orderRows.filter((r) => r.on && r.on > date), id, (r) => r.qty);
    const lead = item?.leadTimeDays ?? 0;
    // Late supply cannot serve this need, but it can serve other orders' claims, as those
    // are mostly due later too. Otherwise the same goods would be bought twice.
    const claimsLeft = Math.max(0, allocatedMilli - lateSupplyMilli);
    const shortMilli = firm + Math.max(0, fromParents + claimsLeft + safetyMilli - onHandMilli - onOrderMilli);
    const orderBy = addDays(date, -lead);
    rows.push({ itemId: id, level: levels.get(id), supply, requiredMilli: required, onHandMilli, onOrderMilli, lateSupplyMilli, allocatedMilli, safetyMilli, shortMilli, needBy: date, orderBy, isLate: shortMilli > 0 && orderBy < today, _labels: { itemId: `${item?.code} · ${item?.name}` } });
    if (supply === 'MAKE' && shortMilli > 0) {
      for (const line of boms.get(id).lines) {
        const child = String(line.itemId);
        const withScrap = line.qtyMilli + applyBps(line.qtyMilli, line.scrapBps ?? 0);
        gross.set(child, (gross.get(child) ?? 0) + mulDivRound(withScrap, shortMilli, 1000));
        const childDate = addDays(date, -lead);
        if (!needBy.has(child) || childDate < needBy.get(child)) needBy.set(child, childDate);
      }
    }
  }
  return rows;
}

// MRP: what these items need, against stock on hand, and what to do about the shortfall.
define({
  name: 'ProductionPlan',
  module: 'manufacturing',
  series: 'PP',
  labelFields: ['docNo'],
  fields: 'planDate!:date notes considerOnOrder:check=true considerSafetyStock:check=true state~:select(DRAFT,PLANNED,REQUESTED)=DRAFT workOrdersMade~:check',
  labels: { considerOnOrder: 'Count what is on order', considerSafetyStock: 'Keep reorder level in stock' },
  dateField: 'planDate',
  tables: {
    items: 'itemId!:link(Item) qtyMilli!:qty salesOrderId:link(SalesOrder) requiredBy:date source',
    'requirements~': 'itemId:link(Item) level:int supply requiredMilli:qty onHandMilli:qty onOrderMilli:qty lateSupplyMilli:qty allocatedMilli:qty safetyMilli:qty shortMilli:qty needBy:date orderBy:date isLate:check',
  },
  list: 'docNo planDate state',
  actions: [
    {
      key: 'pullDemand',
      label: 'Pull in demand',
      when: { state: ['DRAFT', 'PLANNED'] },
      fields: 'fromDate:date toDate:date includeSalesOrders:check=true includeSchedule:check=true',
      async run(session, doc, body) {
        const inRange = (date) => (!body.fromDate || !date || date >= body.fromDate) && (!body.toDate || !date || date <= body.toDate);
        const added = [];
        if (body.includeSalesOrders !== false) {
          const orders = await SalesOrder.find({ status: 'CONFIRMED' }).session(session).lean();
          for (const order of orders) {
            if (!inRange(order.deliveryDate)) continue;
            const builds = await MachineBuild.find({ salesOrderId: order._id }, { itemId: 1 }).session(session).lean();
            const made = await modelOf('WorkOrder').find({ salesOrderId: String(order._id), status: { $ne: 'CANCELLED' } }, { itemId: 1, qtyMilli: 1 }).session(session).lean();
            for (const line of order.lines) {
              const key = String(line.itemId);
              if (!(await Bom.exists({ itemId: line.itemId, status: 'RELEASED' }).session(session))) continue;
              const covered = builds.filter((b) => String(b.itemId) === key).length * 1000 + sumInts(made.filter((w) => String(w.itemId) === key).map((w) => w.qtyMilli));
              const already = doc.items.some((row) => String(row.salesOrderId) === String(order._id) && String(row.itemId) === key);
              if (line.qtyMilli > covered && !already) added.push({ itemId: key, qtyMilli: line.qtyMilli - covered, salesOrderId: String(order._id), requiredBy: order.deliveryDate, source: order.docNo });
            }
          }
        }
        if (body.includeSchedule !== false) {
          const schedules = await modelOf('MasterProductionSchedule').find().session(session).lean();
          for (const schedule of schedules) {
            for (const line of schedule.lines) {
              const already = doc.items.some((row) => row.source === schedule.name && String(row.itemId) === String(line.itemId) && row.requiredBy === line.onDate);
              if (!inRange(line.onDate) || already) continue;
              if (await Bom.exists({ itemId: line.itemId, status: 'RELEASED' }).session(session)) added.push({ itemId: String(line.itemId), qtyMilli: line.qtyMilli, requiredBy: line.onDate, source: schedule.name });
            }
          }
        }
        if (added.length === 0) throw rule('No new demand was found.', 'NO_DEMAND');
        const items = await Item.find({ _id: { $in: added.map((a) => a.itemId) } }, { code: 1, name: 1 }).session(session).lean();
        for (const row of added) {
          const item = items.find((i) => String(i._id) === row.itemId);
          doc.items.push({ ...row, _labels: { itemId: `${item?.code} · ${item?.name}` } });
        }
        doc.state = 'DRAFT';
        await doc.save({ session });
        return doc;
      },
    },
    {
      key: 'explode',
      label: 'Work out requirements',
      primary: true,
      when: { state: ['DRAFT', 'PLANNED'] },
      fields: '',
      async run(session, doc) {
        doc.requirements = await runMrp(session, doc);
        doc.state = 'PLANNED';
        await doc.save({ session });
        return doc;
      },
    },
    {
      key: 'makeRequest',
      label: 'Raise material request',
      when: { state: ['PLANNED'] },
      fields: '',
      navigate: 'MaterialRequest',
      async run(session, doc, _body, { actor }) {
        const lines = doc.requirements.filter((r) => r.supply !== 'MAKE' && r.shortMilli > 0).map((r) => ({ itemId: String(r.itemId), qtyMilli: r.shortMilli }));
        if (lines.length === 0) throw rule('Nothing is short.', 'NOTHING_SHORT');
        const request = await createDoc(session, 'MaterialRequest', { purpose: 'PURCHASE', reason: `From ${doc.docNo}`, lines }, actor);
        doc.state = 'REQUESTED';
        await doc.save({ session });
        return request;
      },
    },
    {
      key: 'makeWorkOrders',
      label: 'Make work orders',
      when: { state: ['PLANNED', 'REQUESTED'], workOrdersMade: [false] },
      fields: 'targetWarehouseId!:link(Warehouse)',
      navigate: 'WorkOrder',
      async run(session, doc, body, { actor }) {
        const rows = doc.requirements.filter((r) => r.supply === 'MAKE' && r.shortMilli > 0);
        if (rows.length === 0) throw rule('Nothing needs making.', 'NOTHING_SHORT');
        let last = null;
        for (const row of rows) {
          const bom = await Bom.findOne({ itemId: row.itemId, status: 'RELEASED' }).session(session).lean();
          if (!bom) throw rule('One of these items no longer has a released BOM.', 'NO_RELEASED_BOM', { itemId: String(row.itemId) });
          const source = doc.items.find((i) => String(i.itemId) === String(row.itemId) && i.salesOrderId);
          // Sub-assemblies have their own orders here, so each order takes its direct parts only.
          last = await createDoc(session, 'WorkOrder', { itemId: String(row.itemId), bomId: String(bom._id), singleLevel: true, qtyMilli: row.shortMilli, targetWarehouseId: body.targetWarehouseId, productionPlanId: String(doc._id), plannedEnd: row.needBy, salesOrderId: source ? String(source.salesOrderId) : null }, actor);
        }
        doc.workOrdersMade = true;
        await doc.save({ session });
        return last;
      },
    },
  ],
});

// Replaces a part across every released BOM by raising a new draft revision of each.
m('BomUpdateTool', 'currentItemId!:link(Item) newItemId!:link(Item) changeNote! revisionsCreated~:int', {
  labelFields: ['currentItemId'],
  list: 'currentItemId newItemId revisionsCreated',
  actions: [{
    key: 'replace',
    label: 'Raise new revisions',
    primary: true,
    when: {},
    fields: '',
    async run(session, doc, _body, { actor }) {
      const boms = await Bom.find({ status: 'RELEASED', 'lines.itemId': doc.currentItemId }).session(session).lean();
      if (boms.length === 0) throw rule('No released BOM uses that part.', 'NOT_USED');
      for (const bom of boms) {
        await createBomRevision(session, {
          itemId: bom.itemId,
          changeNote: doc.changeNote,
          labourHoursMilli: bom.labourHoursMilli,
          fatChecklist: bom.fatChecklist.map(({ _id, ...rest }) => rest),
          lines: bom.lines.map((l) => ({ itemId: String(l.itemId) === String(doc.currentItemId) ? doc.newItemId : l.itemId, qtyMilli: l.qtyMilli, scrapBps: l.scrapBps, drawingNo: l.drawingNo })),
        }, actor);
      }
      doc.revisionsCreated += boms.length;
      await doc.save({ session });
      return doc;
    },
  }],
});

/* ---------- Subcontracting ---------- */

// The commercial order to a job worker. Sending the goods is a job work challan, so GST
// rule 45 tracking and valuation stay in one place.
define({
  name: 'SubcontractingOrder',
  module: 'subcontracting',
  series: 'SCO',
  submittable: true,
  labelFields: ['docNo'],
  fields: 'partyId!:link(Party;isJobWorker=true) finishedItemId!:link(Item) qtyMilli!:qty serviceRatePaise!:money buildId:link(MachineBuild) requiredBy:date challanId~:link(JobWorkChallan) receivedMilli~:qty materialValuePaise~:money serviceValuePaise~:money',
  tables: {
    supplied: 'itemId!:link(Item) qtyMilli!:qty fromWarehouseId!:link(Warehouse) lot',
    'receipts~': 'onDate:date outputMilli:qty warehouseId:link(Warehouse) materialPaise:money servicePaise:money supplierChallanNo lot',
  },
  list: 'docNo partyId finishedItemId qtyMilli receivedMilli requiredBy',
  async onCancel(_session, doc) {
    if (doc.receivedMilli > 0) throw rule('Finished goods have been received on this order.', 'ALREADY_RECEIVED');
  },
  actions: [{
    key: 'makeChallan',
    label: 'Make job work challan',
    primary: true,
    when: { status: ['SUBMITTED'], challanId: [null] },
    fields: '',
    navigateTo: 'jobWork',
    async run(session, doc, _body, { actor }) {
      if (doc.supplied.length === 0) throw rule('List the materials being sent.', 'NO_MATERIALS');
      const { jobWorkChallan } = await import('../services/storesService.js');
      const data = await jobWorkChallan.prepare(session, {
        postingDate: todayIst(),
        partyId: doc.partyId,
        process: doc.docNo,
        buildId: doc.buildId ?? null,
        lines: doc.supplied.map((row) => ({ itemId: String(row.itemId), qtyMilli: row.qtyMilli, fromWarehouseId: String(row.fromWarehouseId), lot: row.lot ?? '' })),
      });
      const [challan] = await JobWorkChallan.create([{ ...data, createdBy: actor.id }], { session });
      doc.challanId = String(challan._id);
      await doc.save({ session });
      return challan;
    },
  }, {
    // The goods come back carrying the cost of the materials sent, plus the job worker's
    // charge. That charge waits in a clearing account for the job worker's bill.
    key: 'receive',
    label: 'Receive finished goods',
    when: { status: ['SUBMITTED'] },
    fields: 'outputMilli!:qty warehouseId!:link(Warehouse) lot supplierChallanNo',
    async run(session, doc, body) {
      if (!doc.challanId) throw rule('Send the materials on a challan first.', 'NO_CHALLAN');
      if (body.outputMilli <= 0) throw rule('Enter a quantity.', 'QTY_REQUIRED');
      const left = doc.qtyMilli - doc.receivedMilli;
      if (body.outputMilli > left) throw rule(`Only ${left / 1000} is still to come.`, 'OVER_RECEIVED');
      const challan = await JobWorkChallan.findById(doc.challanId).session(session);
      if (!challan || challan.status === 'DRAFT' || challan.status === 'CANCELLED') throw rule('Submit the challan first.', 'CHALLAN_NOT_OPEN');
      const warehouse = await assertWarehouseKind(session, body.warehouseId, ['STORES', 'FG']);
      const jobWork = await warehouseOfKind(session, 'JOBWORK');
      const postingDate = todayIst();
      const voucher = { voucherType: 'SubcontractingOrder', voucherId: doc._id, voucherNo: doc.docNo, postingDate };
      const finishing = body.outputMilli === left;
      const lot = body.lot ?? '';
      let material = 0;
      const receiptNo = `${doc.docNo}/${doc.receipts.length + 1}`;
      for (const line of challan.lines) {
        const open = line.qtyMilli - line.consumedMilli;
        const share = finishing ? open : Math.min(open, mulDivRound(line.qtyMilli, body.outputMilli, doc.qtyMilli));
        if (share <= 0) continue;
        const { valuePaise } = await stockOut(session, { voucher, itemId: line.itemId, warehouseId: jobWork._id, lot: line.lot, buildId: challan.buildId, qtyMilli: share });
        line.consumedMilli += share;
        line.consumedValuePaise += valuePaise;
        material += valuePaise;
      }
      const service = lineValue(body.outputMilli, doc.serviceRatePaise);
      await stockIn(session, { voucher, itemId: doc.finishedItemId, warehouseId: warehouse._id, lot, buildId: challan.buildId ?? null, qtyMilli: body.outputMilli, valuePaise: material + service });
      const account = accountForWarehouseKind(warehouse.kind);
      const lines = [{ accountCode: account, debitPaise: service }, { accountCode: A.JOB_WORK_UNBILLED, creditPaise: service }];
      // Goods at a job worker are inventory, so finished goods take their value across.
      if (account !== A.INVENTORY) lines.push({ accountCode: account, debitPaise: material }, { accountCode: A.INVENTORY, creditPaise: material });
      await postGl(session, { postingDate, voucherType: 'SubcontractingOrder', voucherId: doc._id, voucherNo: doc.docNo, narration: `Received on ${doc.docNo}`, lines });
      const item = await Item.findById(doc.finishedItemId).session(session).lean();
      challan.receipts.push({ docNo: receiptNo, postingDate, lineId: challan.lines[0]._id, consumedMilli: 0, outputItemId: item._id, outputItemCode: item.code, outputItemName: item.name, outputMilli: body.outputMilli, wasteMilli: 0, warehouseId: warehouse._id, lot, valuePaise: material + service, supplierChallanNo: body.supplierChallanNo ?? '', voucherId: doc._id });
      challan.status = challan.lines.every((l) => l.consumedMilli >= l.qtyMilli) ? 'RETURNED' : 'PARTLY_RETURNED';
      await challan.save({ session });
      doc.receivedMilli += body.outputMilli;
      doc.materialValuePaise += material;
      doc.serviceValuePaise += service;
      doc.receipts.push({ onDate: postingDate, outputMilli: body.outputMilli, warehouseId: String(warehouse._id), materialPaise: material, servicePaise: service, supplierChallanNo: body.supplierChallanNo ?? '', lot });
      await doc.save({ session });
      return doc;
    },
  }],
});
