// What a production manager and a cost accountant ask of the shop floor.
import { defineReport } from '../engine/reports.js';
import { modelOf } from '../engine/registry.js';
import { Bin } from '../models/ledgers.js';
import { Bom, MachineBuild } from '../models/documents.js';
import { Item } from '../models/masters.js';
import { applyBps, lineValue, mulDivRound, sumInts } from '../utils/money.js';
import { addDays, daysBetween, todayIst } from '../utils/dates.js';
import { rule } from '../utils/errors.js';
import { isWorkingDay, workstationDayMilli } from './manufacturing.js';

const MAKE = ['ADMIN', 'MANAGEMENT', 'PRODUCTION', 'ENGINEERING', 'ACCOUNTS'];
const DATES = 'from:date to:date';
const pctOf = (part, whole) => (whole > 0 ? mulDivRound(part, 10000, whole) : 0);

/* ---------- BOMs ---------- */

async function unitCosts(itemIds) {
  const bins = await Bin.find({ itemId: { $in: itemIds }, qtyMilli: { $gt: 0 } }).lean();
  const items = await Item.find({ _id: { $in: itemIds } }, { standardCostPaise: 1 }).lean();
  const costs = new Map();
  for (const item of items) {
    const key = String(item._id);
    const mine = bins.filter((b) => String(b.itemId) === key);
    const qty = sumInts(mine.map((b) => b.qtyMilli));
    costs.set(key, qty > 0 ? mulDivRound(sumInts(mine.map((b) => b.valuePaise)), 1000, qty) : item.standardCostPaise ?? 0);
  }
  return costs;
}

// Every level, with what a piece would cost at today's stock value, or standard if none.
async function walkBom(bom, parentMilli, level, rows, path = []) {
  if (level > 8 || path.includes(String(bom.itemId))) throw rule('These BOMs contain a loop or are nested too deeply.', 'BOM_LOOP');
  const children = await Bom.find({ itemId: { $in: bom.lines.map((l) => l.itemId) }, status: 'RELEASED' }).lean();
  const items = await Item.find({ _id: { $in: bom.lines.map((l) => l.itemId) } }, { type: 1 }).lean();
  const costs = await unitCosts(bom.lines.map((l) => l.itemId));
  let total = 0;
  for (const line of bom.lines) {
    const key = String(line.itemId);
    const qtyMilli = mulDivRound(line.qtyMilli + applyBps(line.qtyMilli, line.scrapBps ?? 0), parentMilli, 1000);
    const item = items.find((i) => String(i._id) === key);
    const child = item?.type === 'ASSEMBLY' ? children.find((b) => String(b.itemId) === key) : null;
    const row = { level, code: line.itemCode, name: `${'  '.repeat(level)}${line.itemName}`, drawingNo: line.drawingNo ?? '', qtyMilli, uom: line.uom, unitCostPaise: costs.get(key) ?? 0, amountPaise: 0, rollupPaise: 0 };
    rows.push(row);
    if (child) {
      row.rollupPaise = await walkBom(child, qtyMilli, level + 1, rows, [...path, String(bom.itemId)]);
      total += row.rollupPaise;
    } else {
      row.amountPaise = lineValue(qtyMilli, row.unitCostPaise);
      total += row.amountPaise;
    }
  }
  return total;
}

defineReport({
  key: 'bom-cost', module: 'manufacturing', title: 'BOM explorer and cost', roles: MAKE, filters: 'itemId!:link(Item) qtyMilli:qty',
  columns: 'level:int code name drawingNo qtyMilli:qty uom unitCostPaise:money:Unit_cost amountPaise:money:Bought_parts rollupPaise:money:Sub-assembly_total', totals: 'amountPaise',
  async run({ itemId, qtyMilli }) {
    if (!itemId) throw rule('Choose an item.', 'ITEM_REQUIRED');
    const bom = await Bom.findOne({ itemId, status: 'RELEASED' }).lean();
    if (!bom) throw rule('That item has no released BOM.', 'NO_RELEASED_BOM');
    const rows = [];
    await walkBom(bom, Number(qtyMilli) || 1000, 0, rows);
    return rows;
  },
});

defineReport({
  key: 'bom-where-used', module: 'manufacturing', title: 'Where a part is used', roles: MAKE, filters: 'itemId!:link(Item)',
  columns: 'level:int code name revision:int qtyMilli:qty status',
  async run({ itemId }) {
    if (!itemId) throw rule('Choose an item.', 'ITEM_REQUIRED');
    const rows = [];
    const seen = new Set();
    const climb = async (id, level) => {
      if (level > 8) return;
      for (const bom of await Bom.find({ 'lines.itemId': id, status: 'RELEASED' }).lean()) {
        const key = `${bom._id}:${level}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const line = bom.lines.find((l) => String(l.itemId) === String(id));
        rows.push({ level, code: bom.itemCode, name: `${'  '.repeat(level)}${bom.itemName}`, revision: bom.revision, qtyMilli: line.qtyMilli, status: bom.status });
        await climb(bom.itemId, level + 1);
      }
    };
    await climb(itemId, 0);
    return rows;
  },
});

defineReport({
  key: 'bom-compare', module: 'manufacturing', title: 'Compare two BOMs', roles: MAKE, filters: 'firstBomId!:link(Bom) secondBomId!:link(Bom)',
  columns: 'code name firstMilli:qty:First secondMilli:qty:Second changeMilli:sqty:Change note',
  async run({ firstBomId, secondBomId }) {
    if (!firstBomId || !secondBomId) throw rule('Choose two BOMs.', 'BOM_REQUIRED');
    const [first, second] = await Promise.all([Bom.findById(firstBomId).lean(), Bom.findById(secondBomId).lean()]);
    if (!first || !second) throw rule('That BOM does not exist.', 'LINK_NOT_FOUND');
    const rows = new Map();
    for (const line of first.lines) rows.set(String(line.itemId), { code: line.itemCode, name: line.itemName, firstMilli: line.qtyMilli, secondMilli: 0 });
    for (const line of second.lines) {
      const row = rows.get(String(line.itemId)) ?? { code: line.itemCode, name: line.itemName, firstMilli: 0, secondMilli: 0 };
      row.secondMilli = line.qtyMilli;
      rows.set(String(line.itemId), row);
    }
    const noteFor = (row) => {
      if (row.firstMilli === 0) return 'Added';
      if (row.secondMilli === 0) return 'Removed';
      return row.firstMilli === row.secondMilli ? 'Same' : 'Quantity changed';
    };
    return [...rows.values()].map((row) => ({ ...row, changeMilli: row.secondMilli - row.firstMilli, note: noteFor(row) })).sort((a, b) => a.code.localeCompare(b.code));
  },
});

/* ---------- Work orders ---------- */

const openStates = ['NOT_STARTED', 'IN_PROCESS'];

defineReport({
  key: 'wip-work-orders', module: 'manufacturing', title: 'Work in progress on work orders', roles: MAKE, filters: '',
  columns: 'docNo item qtyMilli:qty producedMilli:qty processLossMilli:qty wipPaise:money plannedEnd:date', totals: 'wipPaise',
  async run() {
    const orders = await modelOf('WorkOrder').find({ status: 'SUBMITTED', wipPaise: { $ne: 0 } }).sort({ plannedEnd: 1 }).lean();
    return orders.map((o) => ({ docNo: o.docNo, item: o._labels?.itemId, qtyMilli: o.qtyMilli, producedMilli: o.producedMilli, processLossMilli: o.processLossMilli, wipPaise: o.wipPaise, plannedEnd: o.plannedEnd }));
  },
});

defineReport({
  key: 'work-order-variance', module: 'manufacturing', title: 'Work order cost and variance', roles: MAKE, filters: DATES,
  columns: 'docNo item state qtyMilli:qty producedMilli:qty materialPaise:money:Materials labourPaise:money:Labour byProductPaise:money:By-products producedValuePaise:money:In_finished_goods varianceValuePaise:money:Written_off wipPaise:money:Still_in_WIP unitCostPaise:money:Cost_per_piece',
  totals: 'materialPaise labourPaise byProductPaise producedValuePaise varianceValuePaise wipPaise',
  async run({ from, to }) {
    const filter = { status: 'SUBMITTED', ...(from || to ? { postingDate: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } } : {}) };
    const orders = await modelOf('WorkOrder').find(filter).sort({ postingDate: -1 }).limit(2000).lean();
    const cards = await modelOf('JobCard').find({ status: 'SUBMITTED', workOrderId: { $in: orders.map((o) => String(o._id)) } }, { workOrderId: 1, valuePaise: 1 }).lean();
    return orders.map((o) => ({
      docNo: o.docNo,
      item: o._labels?.itemId,
      state: o.state,
      qtyMilli: o.qtyMilli,
      producedMilli: o.producedMilli,
      materialPaise: sumInts(o.materials.map((m) => m.issuedValuePaise ?? 0)),
      labourPaise: sumInts(cards.filter((c) => String(c.workOrderId) === String(o._id)).map((c) => c.valuePaise)),
      byProductPaise: o.byProductValuePaise ?? 0,
      producedValuePaise: o.producedValuePaise,
      varianceValuePaise: o.varianceValuePaise ?? 0,
      wipPaise: o.wipPaise,
      unitCostPaise: o.producedMilli > 0 ? mulDivRound(o.producedValuePaise, 1000, o.producedMilli) : 0,
    }));
  },
});

defineReport({
  key: 'work-order-materials', module: 'manufacturing', title: 'Materials on work orders', roles: MAKE, filters: 'workOrderId:link(WorkOrder)',
  columns: 'docNo item requiredMilli:qty issuedMilli:qty leftMilli:qty issuedValuePaise:money', totals: 'issuedValuePaise',
  async run({ workOrderId }) {
    const filter = workOrderId ? { _id: workOrderId } : { status: 'SUBMITTED', state: { $in: openStates } };
    const orders = await modelOf('WorkOrder').find(filter).limit(500).lean();
    return orders.flatMap((o) => o.materials.map((m) => ({ docNo: o.docNo, item: m._labels?.itemId ?? String(m.itemId), requiredMilli: m.requiredMilli, issuedMilli: m.issuedMilli, leftMilli: Math.max(0, m.requiredMilli - m.issuedMilli), issuedValuePaise: m.issuedValuePaise })));
  },
});

defineReport({
  key: 'process-loss', module: 'manufacturing', title: 'Process loss', roles: MAKE, filters: '',
  columns: 'docNo item onDate:date qtyMilli:qty reason', totals: 'qtyMilli',
  async run() {
    const orders = await modelOf('WorkOrder').find({ status: 'SUBMITTED', 'losses.0': { $exists: true } }).lean();
    return orders.flatMap((o) => o.losses.map((l) => ({ docNo: o.docNo, item: o._labels?.itemId, onDate: l.onDate, qtyMilli: l.qtyMilli, reason: l.reason })));
  },
});

defineReport({
  key: 'work-order-delays', module: 'manufacturing', title: 'Late work orders', roles: MAKE, filters: '',
  columns: 'docNo item state plannedEnd:date completedOn:date daysLate:int',
  async run() {
    const today = todayIst();
    const orders = await modelOf('WorkOrder').find({ status: 'SUBMITTED', plannedEnd: { $ne: null } }).lean();
    return orders
      .map((o) => ({ docNo: o.docNo, item: o._labels?.itemId, state: o.state, plannedEnd: o.plannedEnd, completedOn: o.completedOn, daysLate: daysBetween(o.plannedEnd, o.completedOn ?? today) }))
      .filter((r) => r.daysLate > 0 && !['STOPPED'].includes(r.state))
      .sort((a, b) => b.daysLate - a.daysLate);
  },
});

defineReport({
  key: 'production-shortages', module: 'manufacturing', title: 'What the latest plans are short of', roles: [...MAKE, 'PURCHASE', 'STORES'], source: 'ProductionPlan',
  filters: 'planId:link(ProductionPlan)',
  columns: 'docNo item supply requiredMilli:qty onHandMilli:qty onOrderMilli:qty allocatedMilli:qty shortMilli:qty orderBy:date isLate:check:Late',
  async run({ planId }) {
    const plans = await modelOf('ProductionPlan').find(planId ? { _id: planId } : { state: { $in: ['PLANNED', 'REQUESTED'] } }).sort({ createdAt: -1 }).limit(20).lean();
    return plans.flatMap((p) => p.requirements.filter((r) => r.shortMilli > 0).map((r) => ({ docNo: p.docNo, item: r._labels?.itemId, supply: r.supply, requiredMilli: r.requiredMilli, onHandMilli: r.onHandMilli, onOrderMilli: r.onOrderMilli, allocatedMilli: r.allocatedMilli, shortMilli: r.shortMilli, orderBy: r.orderBy, isLate: r.isLate })));
  },
});

/* ---------- Capacity and the floor ---------- */

defineReport({
  key: 'capacity-load', module: 'manufacturing', title: 'Workstation load', roles: MAKE, filters: `${DATES} workstationId:link(Workstation)`,
  columns: 'workstation onDate:date capacityMilli:qty:Capacity_hours bookedMilli:qty:Booked_hours freeMilli:sqty:Free_hours loadBps:pct:Load',
  async run({ from, to, workstationId }) {
    const start = from ?? todayIst();
    const end = to ?? addDays(start, 30);
    const stations = await modelOf('Workstation').find(workstationId ? { _id: workstationId } : {}).lean();
    const bookings = await modelOf('CapacityBooking').aggregate([
      { $match: { onDate: { $gte: start, $lte: end } } },
      { $group: { _id: { station: '$workstationId', day: '$onDate' }, hours: { $sum: '$hoursMilli' } } },
    ]);
    const rows = [];
    const cache = new Map();
    for (const station of stations) {
      const capacity = workstationDayMilli(station);
      for (let i = 0; i <= daysBetween(start, end) && i <= 366; i += 1) {
        const day = addDays(start, i);
        const booked = bookings.find((b) => b._id.station === String(station._id) && b._id.day === day)?.hours ?? 0;
        const working = await isWorkingDay(null, station, day, cache);
        if (!working && booked === 0) continue;
        const dayCapacity = working ? capacity : 0;
        rows.push({ workstation: station.name, onDate: day, capacityMilli: dayCapacity, bookedMilli: booked, freeMilli: dayCapacity - booked, loadBps: pctOf(booked, dayCapacity) });
      }
    }
    return rows;
  },
});

defineReport({
  key: 'downtime-by-reason', module: 'manufacturing', title: 'Downtime by workstation and reason', roles: MAKE, source: 'DowntimeEntry', filters: DATES, dateField: 'fromTime',
  groupBy: { workstation: '_labels.workstationId', reason: 'reason' }, sums: { entries: 1, minutes: 'minutes' }, sort: { minutes: -1 },
  columns: 'workstation reason entries:int minutes:int', totals: 'minutes',
});

// Not full OEE: Forge has no standard cycle time per piece, so performance is left out.
defineReport({
  key: 'workstation-utilisation', module: 'manufacturing', title: 'Workstation availability and use', roles: MAKE, filters: DATES,
  columns: 'workstation plannedMilli:qty:Planned_hours downMilli:qty:Down_hours runMilli:qty:Run_hours availabilityBps:pct:Available useBps:pct:Used',
  async run({ from, to }) {
    const end = to ?? todayIst();
    const start = from ?? addDays(end, -29);
    const stations = await modelOf('Workstation').find().lean();
    const cache = new Map();
    const rows = [];
    const cards = await modelOf('JobCard').aggregate([{ $match: { status: 'SUBMITTED', postingDate: { $gte: start, $lte: end } } }, { $group: { _id: '$workstationId', hours: { $sum: '$hoursMilli' } } }]);
    const downtime = await modelOf('DowntimeEntry').find({}, { workstationId: 1, fromTime: 1, minutes: 1 }).lean();
    for (const station of stations) {
      let planned = 0;
      const capacity = workstationDayMilli(station);
      for (let i = 0; i <= daysBetween(start, end) && i <= 366; i += 1) {
        if (await isWorkingDay(null, station, addDays(start, i), cache)) planned += capacity;
      }
      const down = sumInts(downtime.filter((d) => String(d.workstationId) === String(station._id) && String(new Date(d.fromTime).toISOString()).slice(0, 10) >= start && String(new Date(d.fromTime).toISOString()).slice(0, 10) <= end).map((d) => Math.round(((d.minutes ?? 0) * 1000) / 60)));
      const run = cards.find((c) => c._id === String(station._id))?.hours ?? 0;
      const available = Math.max(0, planned - down);
      rows.push({ workstation: station.name, plannedMilli: planned, downMilli: down, runMilli: run, availabilityBps: pctOf(available, planned), useBps: pctOf(run, available) });
    }
    return rows;
  },
});

defineReport({
  key: 'job-card-time', module: 'manufacturing', title: 'Hours by person', roles: MAKE, source: 'JobCard', filters: DATES, dateField: 'postingDate', match: { status: 'SUBMITTED' },
  groupBy: { employee: '_labels.employeeId', operation: '_labels.operationId' }, sums: { cards: 1, hoursMilli: 'hoursMilli', valuePaise: 'valuePaise' }, sort: { hoursMilli: -1 },
  columns: 'employee operation cards:int hoursMilli:qty:Hours valuePaise:money', totals: 'valuePaise',
});

defineReport({
  key: 'subcontract-status', module: 'subcontracting', title: 'Subcontracting orders', roles: [...MAKE, 'PURCHASE'], source: 'SubcontractingOrder', filters: DATES, dateField: 'postingDate', match: { status: 'SUBMITTED' },
  sort: { requiredBy: 1 }, project: { docNo: 'docNo', party: '_labels.partyId', item: '_labels.finishedItemId', qtyMilli: 'qtyMilli', receivedMilli: 'receivedMilli', requiredBy: 'requiredBy', materialValuePaise: 'materialValuePaise', serviceValuePaise: 'serviceValuePaise' },
  columns: 'docNo party item qtyMilli:qty receivedMilli:qty requiredBy:date materialValuePaise:money serviceValuePaise:money', totals: 'materialValuePaise serviceValuePaise',
});

/* ---------- Machine builds ---------- */

defineReport({
  key: 'build-pipeline', module: 'manufacturing', title: 'Machines being built', roles: [...MAKE, 'SALES'], filters: '',
  columns: 'serialNo itemName partyName stage targetDate:date daysLeft:int budgetPaise:money wipPaise:money overBudgetPaise:money', totals: 'wipPaise',
  async run() {
    const today = todayIst();
    const builds = await MachineBuild.find({ stage: { $nin: ['DISPATCHED', 'INSTALLED', 'CANCELLED', 'CLOSED'] } }).sort({ targetDate: 1 }).lean();
    return builds.map((b) => ({ serialNo: b.serialNo, itemName: b.itemName, partyName: b.partyName, stage: b.stage, targetDate: b.targetDate, daysLeft: b.targetDate ? daysBetween(today, b.targetDate) : 0, budgetPaise: b.budgetPaise, wipPaise: b.wipPaise, overBudgetPaise: b.budgetPaise > 0 ? Math.max(0, b.wipPaise - b.budgetPaise) : 0 }));
  },
});

/* ---------- OEE and standard cost ---------- */

// Availability times performance times quality. Performance needs the operation's standard
// minutes, and quality comes from what its work orders lost or rejected. A workstation whose
// operations have no standard minutes shows no performance, and so no OEE.
defineReport({
  key: 'oee', module: 'manufacturing', title: 'OEE by workstation', roles: MAKE, filters: DATES,
  columns: 'workstation availabilityBps:pct:Availability performanceBps:pct:Performance qualityBps:pct:Quality oeeBps:pct:OEE runMilli:qty:Run_hours standardMilli:qty:Standard_hours goodMilli:qty:Pieces_counted',
  async run({ from, to }) {
    const end = to ?? todayIst();
    const start = from ?? addDays(end, -29);
    const stations = await modelOf('Workstation').find().lean();
    const cards = await modelOf('JobCard').find({ status: 'SUBMITTED', postingDate: { $gte: start, $lte: end } }).lean();
    const operations = await modelOf('Operation').find({ _id: { $in: cards.map((c) => c.operationId) } }, { minutes: 1 }).lean();
    const orders = await modelOf('WorkOrder').find({ _id: { $in: cards.map((c) => c.workOrderId) } }, { producedMilli: 1, processLossMilli: 1, rejectedMilli: 1 }).lean();
    const downtime = await modelOf('DowntimeEntry').find({}, { workstationId: 1, fromTime: 1, minutes: 1 }).lean();
    const cache = new Map();
    const rows = [];
    for (const station of stations) {
      const key = String(station._id);
      let planned = 0;
      const capacity = workstationDayMilli(station);
      for (let i = 0; i <= daysBetween(start, end) && i <= 366; i += 1) {
        if (await isWorkingDay(null, station, addDays(start, i), cache)) planned += capacity;
      }
      const inRange = (d) => {
        const day = new Date(d.fromTime).toISOString().slice(0, 10);
        return String(d.workstationId) === key && day >= start && day <= end;
      };
      const down = sumInts(downtime.filter(inRange).map((d) => Math.round(((d.minutes ?? 0) * 1000) / 60)));
      const mine = cards.filter((c) => String(c.workstationId) === key);
      const run = sumInts(mine.map((c) => c.hoursMilli));
      let standard = 0;
      let counted = 0;
      let good = 0;
      for (const card of mine) {
        const minutes = operations.find((o) => String(o._id) === String(card.operationId))?.minutes ?? 0;
        if (card.completedMilli > 0 && minutes > 0) standard += mulDivRound(card.completedMilli, minutes * 1000, 60000);
        if (card.completedMilli > 0) {
          const order = orders.find((o) => String(o._id) === String(card.workOrderId));
          const made = (order?.producedMilli ?? 0) + (order?.processLossMilli ?? 0);
          const bad = (order?.processLossMilli ?? 0) + (order?.rejectedMilli ?? 0);
          const share = made > 0 ? mulDivRound(Math.max(0, made - bad), 10000, made) : 10000;
          counted += card.completedMilli;
          good += mulDivRound(card.completedMilli, share, 10000);
        }
      }
      const availabilityBps = pctOf(Math.max(0, planned - down), planned);
      const performanceBps = pctOf(standard, run);
      const qualityBps = pctOf(good, counted);
      const oeeBps = mulDivRound(mulDivRound(availabilityBps, performanceBps, 10000), qualityBps, 10000);
      rows.push({ workstation: station.name, availabilityBps, performanceBps, qualityBps, oeeBps, runMilli: run, standardMilli: standard, goodMilli: good });
    }
    return rows;
  },
});

// Stock stays at actual moving average. This compares what orders cost with what they should.
defineReport({
  key: 'standard-cost-variance', module: 'manufacturing', title: 'Actual against standard cost', roles: MAKE, filters: DATES,
  columns: 'docNo item producedMilli:qty standardCostPaise:money:Standard_each standardPaise:money:At_standard actualPaise:money:Actual variancePaise:smoney:Over_standard',
  totals: 'standardPaise actualPaise variancePaise',
  async run({ from, to }) {
    const filter = { status: 'SUBMITTED', producedMilli: { $gt: 0 }, ...(from || to ? { postingDate: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } } : {}) };
    const orders = await modelOf('WorkOrder').find(filter).limit(2000).lean();
    const items = await Item.find({ _id: { $in: orders.map((o) => o.itemId) } }, { standardCostPaise: 1 }).lean();
    return orders.map((o) => {
      const standardCostPaise = items.find((i) => String(i._id) === String(o.itemId))?.standardCostPaise ?? 0;
      const standardPaise = lineValue(o.producedMilli, standardCostPaise);
      const actualPaise = o.producedValuePaise + (o.varianceValuePaise ?? 0);
      return { docNo: o.docNo, item: o._labels?.itemId, producedMilli: o.producedMilli, standardCostPaise, standardPaise, actualPaise, variancePaise: actualPaise - standardPaise };
    });
  },
});
