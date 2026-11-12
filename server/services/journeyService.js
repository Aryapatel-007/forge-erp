// Each machine order's journey through the company: who is doing what now, what is late,
// and what is waiting on which department. One record per machine build, made from the
// template in config/orderJourney.js the first time anyone looks.
//
// Steps with evidence in the records tick themselves (order confirmed, advance in, BOM
// released, materials ordered and issued, stages passed, FAT passed, payments, dispatch,
// installation). The rest are ticked by the department that owns them, or by Projects,
// Management or the maintainer. Ticking is recorded in the audit chain.
import mongoose from 'mongoose';
import { BUILD_STAGES, Bom, MachineBuild, PurchaseOrder, SalesOrder } from '../models/documents.js';
import { DISPATCH_DAY, JOURNEY_OVERSEERS, JOURNEY_STEPS, PHASES } from '../config/orderJourney.js';
import { auditNow } from './auditService.js';
import { addDays, daysBetween, todayIst } from '../utils/dates.js';
import { badRequest, forbidden, notFound, rule } from '../utils/errors.js';

const { Schema } = mongoose;
const journeySchema = new Schema({
  buildId: { type: Schema.Types.ObjectId, ref: 'MachineBuild', required: true, unique: true },
  startedOn: { type: String, required: true },
  steps: [{
    _id: false,
    key: { type: String, required: true },
    plannedDate: { type: String, required: true },
    doneOn: { type: String, default: null },
    doneByName: { type: String, default: '' },
    auto: { type: Boolean, default: false },
    skipped: { type: Boolean, default: false },
    note: { type: String, default: '' },
  }],
}, { timestamps: true });
export const OrderJourney = mongoose.models.OrderJourney ?? mongoose.model('OrderJourney', journeySchema);

const STEP = new Map(JOURNEY_STEPS.map((s, i) => [s.key, { ...s, index: i }]));
const stageAt = (stage) => BUILD_STAGES.indexOf(stage);
const ACTIVE = { stage: { $nin: ['CLOSED', 'CANCELLED'] } };
const isoDay = (date) => todayIst(date instanceof Date ? date : new Date(date));

// When each step is due: the template's days, stretched so dispatch falls on the delivery date.
function plan(startedOn, deliveryDate) {
  const span = deliveryDate ? daysBetween(startedOn, deliveryDate) : DISPATCH_DAY;
  const scale = span > 0 ? span / DISPATCH_DAY : 1;
  return JOURNEY_STEPS.map((s) => ({ key: s.key, plannedDate: addDays(startedOn, Math.round(s.day * scale)) }));
}

async function context(build) {
  const [order, bom, poCount] = await Promise.all([
    build.salesOrderId ? SalesOrder.findById(build.salesOrderId, { status: 1, milestones: 1, deliveryDate: 1, postingDate: 1 }).lean() : null,
    Bom.findById(build.bomId, { status: 1 }).lean(),
    PurchaseOrder.countDocuments({ 'lines.buildId': build._id, status: { $nin: ['DRAFT', 'CANCELLED'] } }),
  ]);
  return { order, bom, poCount };
}

// Milestones of these triggers all received? null when the order has none of them.
function paid(order, triggers) {
  const due = (order?.milestones ?? []).filter((m) => triggers.includes(m.trigger) && m.amountMinor > 0);
  if (due.length === 0) return null;
  return due.every((m) => m.receivedMinor >= m.amountMinor);
}

const EVIDENCE = {
  orderConfirmed: (b, c) => !c.order || ['CONFIRMED', 'CLOSED'].includes(c.order.status),
  advance: (b, c) => paid(c.order, ['ORDER']),
  bomReleased: (b, c) => ['RELEASED', 'OBSOLETE'].includes(c.bom?.status),
  materialsOrdered: (b, c) => c.poCount > 0 || EVIDENCE.materialsIssued(b),
  materialsIssued: (b) => b.materials.length > 0 && b.materials.every((m) => m.issuedMilli >= m.requiredMilli),
  pastFabrication: (b) => stageAt(b.stage) >= stageAt('ASSEMBLY'),
  pastAssembly: (b) => stageAt(b.stage) >= stageAt('FAT'),
  fatPassed: (b) => b.fatStatus === 'PASSED',
  dispatchPayment: (b, c) => paid(c.order, ['BEFORE_FAT', 'BEFORE_DISPATCH']),
  dispatched: (b) => Boolean(b.dispatchedOn) || stageAt(b.stage) >= stageAt('DISPATCHED'),
  installed: (b) => Boolean(b.installedOn) || stageAt(b.stage) >= stageAt('INSTALLED'),
  finalPayment: (b, c) => paid(c.order, ['AFTER_INSTALLATION']),
};
const evidenceDate = { dispatched: (b) => b.dispatchedOn, installed: (b) => b.installedOn };

// Makes the journey if it is new, and ticks what the records show has happened.
async function syncOne(build) {
  const c = await context(build);
  let journey = await OrderJourney.findOne({ buildId: build._id });
  if (!journey) {
    const startedOn = c.order?.postingDate ?? isoDay(build.createdAt ?? new Date());
    journey = new OrderJourney({ buildId: build._id, startedOn, steps: plan(startedOn, build.targetDate ?? c.order?.deliveryDate) });
  }
  let changed = journey.isNew;
  for (const step of journey.steps) {
    const def = STEP.get(step.key);
    if (!def?.auto || step.doneOn || step.skipped) continue;
    if (EVIDENCE[def.auto](build, c) === true) {
      step.doneOn = evidenceDate[def.auto]?.(build) ?? todayIst();
      step.doneByName = 'Forge, from the records';
      step.auto = true;
      changed = true;
    }
  }
  if (changed) await journey.save();
  return journey;
}

function statusOf(step, today) {
  if (step.skipped) return 'SKIPPED';
  if (step.doneOn) return 'DONE';
  if (step.plannedDate < today) return 'LATE';
  if (step.plannedDate <= addDays(today, 7)) return 'DUE';
  return 'UPCOMING';
}

function shape(build, journey) {
  const today = todayIst();
  const steps = journey.steps
    .map((s) => ({ ...(s.toObject?.() ?? s), ...STEP.get(s.key) }))
    .filter((s) => s.title)
    .sort((a, b) => a.index - b.index)
    .map((s) => ({
      key: s.key, title: s.title, hint: s.hint, phase: s.phase, role: s.role, auto: Boolean(s.auto), canAuto: Boolean(STEP.get(s.key).auto),
      plannedDate: s.plannedDate, doneOn: s.doneOn, doneByName: s.doneByName, note: s.note, skipped: s.skipped,
      status: statusOf(s, today), lateDays: !s.doneOn && !s.skipped && s.plannedDate < today ? daysBetween(s.plannedDate, today) : 0,
    }));
  const open = steps.filter((s) => s.status !== 'DONE' && s.status !== 'SKIPPED');
  return {
    build: {
      id: String(build._id), serialNo: build.serialNo, itemName: build.itemName, partyName: build.partyName,
      salesOrderId: build.salesOrderId ? String(build.salesOrderId) : null, salesOrderNo: build.salesOrderNo,
      stage: build.stage, targetDate: build.targetDate,
    },
    startedOn: journey.startedOn,
    phases: PHASES.map((p) => {
      const inPhase = steps.filter((s) => s.phase === p.key);
      const done = inPhase.filter((s) => s.status === 'DONE' || s.status === 'SKIPPED').length;
      return { ...p, done, total: inPhase.length, state: done === inPhase.length ? 'DONE' : inPhase.some((s) => s.status === 'LATE') ? 'LATE' : done > 0 || inPhase.some((s) => s.status === 'DUE') ? 'ACTIVE' : 'WAITING' };
    }),
    steps,
    done: steps.length - open.length,
    total: steps.length,
    // What is next: the open step due soonest.
    current: [...open].sort((x, y) => x.plannedDate.localeCompare(y.plannedDate))[0] ?? null,
    late: open.filter((s) => s.status === 'LATE').length,
  };
}

export async function journeyFor(buildId) {
  if (!mongoose.isValidObjectId(buildId)) throw badRequest('That id is not valid.');
  const build = await MachineBuild.findById(buildId).lean();
  if (!build) throw notFound('Machine');
  return shape(build, await syncOne(build));
}

// Every machine order still going, with where it is and what is late.
export async function board({ includeClosed = false } = {}) {
  const builds = await MachineBuild.find(includeClosed ? { stage: { $ne: 'CANCELLED' } } : ACTIVE).sort({ targetDate: 1, createdAt: 1 }).limit(300).lean();
  const out = [];
  for (const build of builds) out.push(shape(build, await syncOne(build)));
  return out;
}

// What is waiting on this department: open steps due in the next two weeks, oldest first.
export async function waitingOn(role) {
  const horizon = addDays(todayIst(), 14);
  const everything = JOURNEY_OVERSEERS.includes(role);
  const rows = [];
  for (const j of await board()) {
    for (const s of j.steps) {
      if (s.status === 'DONE' || s.status === 'SKIPPED' || s.plannedDate > horizon) continue;
      if (!everything && s.role !== role) continue;
      if (s.canAuto && !everything) continue; // ticks itself when the work is recorded
      rows.push({ ...s, build: j.build });
    }
  }
  return rows.sort((a, b) => a.plannedDate.localeCompare(b.plannedDate)).slice(0, 100);
}

export async function actOnStep(buildId, key, user, { action, note = '', plannedDate = null }) {
  const def = STEP.get(key);
  if (!def) throw notFound('Step');
  if (user.role !== def.role && !JOURNEY_OVERSEERS.includes(user.role)) throw forbidden('This step belongs to another department.');
  const build = await MachineBuild.findById(buildId).lean();
  if (!build) throw notFound('Machine');
  const journey = await syncOne(build);
  const step = journey.steps.find((s) => s.key === key);
  if (action === 'done') {
    if (step.doneOn) throw rule('This step is already done.');
    Object.assign(step, { doneOn: todayIst(), doneByName: user.name, auto: false, skipped: false, note: note.slice(0, 1000) });
  } else if (action === 'undo') {
    if (step.auto) throw rule('Forge ticked this from the records, so it cannot be undone here. Change the record instead.');
    Object.assign(step, { doneOn: null, doneByName: '', skipped: false, note: note.slice(0, 1000) });
  } else if (action === 'skip') {
    if (!note.trim()) throw badRequest('Say why this step does not apply to this order.');
    Object.assign(step, { skipped: true, doneByName: user.name, note: note.slice(0, 1000) });
  } else if (action === 'plan') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(plannedDate ?? '')) throw badRequest('Choose a date.');
    step.plannedDate = plannedDate;
  } else {
    throw badRequest('Unknown action.');
  }
  await journey.save();
  await auditNow({ actor: user, action: `JOURNEY_${action.toUpperCase()}`, entityType: 'MachineBuild', entityId: build._id, entityNo: build.serialNo, reason: note || null, data: { step: key, plannedDate: step.plannedDate } });
  return shape(build, journey);
}
