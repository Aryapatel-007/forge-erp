// What runs by itself. Each job is safe to run twice: it only acts on what is still due.
import { defineJob } from '../engine/scheduler.js';
import { getType, modelOf } from '../engine/registry.js';
import { createDoc } from '../engine/documents.js';
import { A } from '../config/accounts.js';
import { User } from '../models/core.js';
import { Bin } from '../models/ledgers.js';
import { Item } from '../models/masters.js';
import { Gauge, SalesInvoice } from '../models/documents.js';
import { EmailQueue, Notification } from '../models/platform.js';
import { salesInvoice } from '../services/accountsService.js';
import { postGl } from '../services/ledgerService.js';
import { notify } from '../services/notifyService.js';
import { nextDocNo } from '../services/numberService.js';
import { withTxn } from '../utils/txn.js';
import { addDays, addMonths, todayIst } from '../utils/dates.js';
import { postDueDepreciation } from './assets.js';
import { createBackup } from '../services/backupService.js';
import { fetchExchangeRates, flushSms, readMailbox } from '../services/channelsService.js';
import { scanAllWatches } from '../services/vaultService.js';

const SYSTEM = { id: null, name: 'Scheduler', role: 'ADMIN' };
const asDate = (now) => todayIst(now);

defineJob('depreciation', 720, async (now) => withTxn((s) => postDueDepreciation(s, asDate(now))));

// Releases one month of deferred income or expense at a time, as each comes due.
export async function releaseDeferred(asOf) {
  const docs = await modelOf('DeferredSchedule').find({ status: 'SUBMITTED', rows: { $elemMatch: { isPosted: false, onDate: { $lte: asOf } } } }, { _id: 1 }).lean();
  let posted = 0;
  for (const { _id } of docs) {
    await withTxn(async (session) => {
      const doc = await modelOf('DeferredSchedule').findById(_id).session(session);
      for (const row of doc.rows) {
        if (row.isPosted || row.onDate > asOf) continue;
        const voucherNo = await nextDocNo(session, 'DR', row.onDate);
        const isIncome = doc.kind === 'INCOME';
        await postGl(session, {
          postingDate: row.onDate,
          voucherType: 'DeferredRelease',
          voucherId: doc._id,
          voucherNo,
          narration: `Release of ${doc.docNo}`,
          lines: isIncome
            ? [{ accountCode: A.DEFERRED_INCOME, debitPaise: row.amountPaise }, { accountCode: doc.sourceAccountCode, creditPaise: row.amountPaise }]
            : [{ accountCode: doc.sourceAccountCode, debitPaise: row.amountPaise }, { accountCode: A.PREPAID_EXPENSES, creditPaise: row.amountPaise }],
        });
        row.isPosted = true;
        row.voucherNo = voucherNo;
        posted += 1;
      }
      await doc.save({ session });
    });
  }
  return posted;
}
defineJob('deferred-release', 720, (now) => releaseDeferred(asDate(now)));

// Raises a draft invoice for every subscription that is due. Accounts reviews and posts it.
export async function raiseSubscriptionInvoices(asOf) {
  const due = await modelOf('Subscription').find({ state: 'ACTIVE', nextInvoiceOn: { $lte: asOf } }, { _id: 1 }).lean();
  let raised = 0;
  for (const { _id } of due) {
    await withTxn(async (session) => {
      const sub = await modelOf('Subscription').findById(_id).session(session);
      const plan = await modelOf('SubscriptionPlan').findById(sub.planId).session(session).lean();
      const prepared = await salesInvoice.prepare(session, {
        postingDate: asOf,
        partyId: String(sub.partyId),
        lines: [{ kind: 'SERVICE', itemId: String(plan.itemId), qtyMilli: 1000, rateMinor: plan.ratePaise, gstRateBps: plan.gstRateBps }],
      });
      const [invoice] = await SalesInvoice.create([prepared], { session });
      sub.lastInvoiceId = String(invoice._id);
      sub.invoicesRaised += 1;
      sub.nextInvoiceOn = addMonths(sub.nextInvoiceOn, plan.intervalMonths);
      if (sub.endDate && sub.nextInvoiceOn > sub.endDate) sub.state = 'ENDED';
      await sub.save({ session });
    });
    raised += 1;
  }
  return raised;
}
defineJob('subscriptions', 360, (now) => raiseSubscriptionInvoices(asDate(now)));

const NEXT = {
  DAILY: (d) => addDays(d, 1), WEEKLY: (d) => addDays(d, 7), MONTHLY: (d) => addMonths(d, 1), QUARTERLY: (d) => addMonths(d, 3), YEARLY: (d) => addMonths(d, 12),
};

// Copies a document as a new draft on a schedule. Only engine documents can repeat.
export async function runAutoRepeat(asOf) {
  const rules = await modelOf('AutoRepeat').find({ isActive: true }).lean();
  let made = 0;
  for (const repeat of rules) {
    const due = repeat.nextDate ?? repeat.startDate;
    if (due > asOf) continue;
    await withTxn(async (session) => {
      const source = await modelOf(repeat.doctypeName).findById(repeat.sourceId).session(session);
      if (!source) return;
      const type = getType(repeat.doctypeName);
      const input = {};
      for (const field of type.fields) if (!field.computed && source[field.key] !== undefined) input[field.key] = source[field.key];
      for (const table of type.tables) {
        if (table.computed) continue;
        input[table.key] = source[table.key].map((row) => {
          const out = {};
          for (const field of table.fields) if (!field.computed && row[field.key] !== undefined) out[field.key] = row[field.key];
          return out;
        });
      }
      await createDoc(session, repeat.doctypeName, input, SYSTEM);
      const row = await modelOf('AutoRepeat').findById(repeat._id).session(session);
      row.nextDate = NEXT[repeat.frequency](due);
      if (row.endDate && row.nextDate > row.endDate) row.isActive = false;
      await row.save({ session });
    });
    made += 1;
  }
  return made;
}
defineJob('auto-repeat', 360, (now) => runAutoRepeat(asDate(now)));

// Flags an issue past its deadline, once, and tells whoever it is assigned to.
export async function flagSlaBreaches(now) {
  const late = await modelOf('Issue').find({ isSlaBreached: false, status: { $in: ['OPEN', 'REPLIED', 'ON_HOLD'] }, resolveBy: { $ne: null, $lt: now } }, { _id: 1 }).lean();
  for (const { _id } of late) {
    await withTxn(async (session) => {
      const issue = await modelOf('Issue').findById(_id).session(session);
      issue.isSlaBreached = true;
      await issue.save({ session });
      if (issue.assignedTo) await notify(session, issue.assignedTo, `${issue.docNo} is past its SLA`, `/Issue/${issue._id}`);
    });
  }
  return late.length;
}
defineJob('sla-breaches', 15, (now) => flagSlaBreaches(now));

// Raises a draft material request for every item that has fallen below its reorder level,
// counting what is on hand everywhere and what is already on an open request.
export async function raiseReorders() {
  const items = await Item.find({ reorderLevelMilli: { $gt: 0 }, isActive: true }, { reorderLevelMilli: 1 }).lean();
  if (items.length === 0) return 0;
  const stock = await Bin.aggregate([{ $match: { itemId: { $in: items.map((i) => i._id) } } }, { $group: { _id: '$itemId', qty: { $sum: '$qtyMilli' } } }]);
  const open = await modelOf('MaterialRequest').find({ status: { $in: ['DRAFT', 'SUBMITTED'] }, state: 'OPEN' }, { lines: 1 }).lean();
  const requested = new Map();
  for (const request of open) for (const line of request.lines) requested.set(String(line.itemId), (requested.get(String(line.itemId)) ?? 0) + line.qtyMilli);
  const lines = [];
  for (const item of items) {
    const onHand = stock.find((s) => String(s._id) === String(item._id))?.qty ?? 0;
    const pending = requested.get(String(item._id)) ?? 0;
    if (onHand + pending < item.reorderLevelMilli) lines.push({ itemId: String(item._id), qtyMilli: item.reorderLevelMilli * 2 - onHand - pending });
  }
  if (lines.length === 0) return 0;
  await withTxn((session) => createDoc(session, 'MaterialRequest', { purpose: 'PURCHASE', reason: 'Below reorder level', lines }, SYSTEM));
  return lines.length;
}
defineJob('reorder', 720, () => raiseReorders());

// Warns quality about instruments that fall due within 15 days.
defineJob('calibration-reminders', 1440, async (now) => {
  const soon = addDays(asDate(now), 15);
  const gauges = await Gauge.find({ isActive: true, dueOn: { $ne: null, $lte: soon } }, { code: 1, dueOn: 1 }).lean();
  if (gauges.length === 0) return 0;
  const people = await User.find({ role: 'QUALITY', isActive: true }, { _id: 1 }).lean();
  await Notification.insertMany(people.map((p) => ({ userId: p._id, title: `${gauges.length} gauge(s) are due for calibration within 15 days`, link: '/gauges' })));
  return gauges.length;
});

// Works out attendance from a day's punches: first in, last out, against the shift.
export async function buildAttendance(date) {
  const start = new Date(`${date}T00:00:00+05:30`);
  const end = new Date(start.getTime() + 86400000);
  const punches = await modelOf('EmployeeCheckin').find({ atTime: { $gte: start, $lt: end } }).sort({ atTime: 1 }).lean();
  const byEmployee = new Map();
  for (const punch of punches) {
    const key = String(punch.employeeId);
    if (!byEmployee.has(key)) byEmployee.set(key, []);
    byEmployee.get(key).push(punch);
  }
  let marked = 0;
  for (const [employeeId, rows] of byEmployee) {
    const wasMarked = await withTxn(async (session) => {
      const exists = await modelOf('Attendance').countDocuments({ employeeId, onDate: date }).session(session);
      if (exists > 0) return false;
      const employee = await modelOf('Employee').findById(employeeId).session(session).lean();
      const shift = employee?.shiftTypeId ? await modelOf('ShiftType').findById(employee.shiftTypeId).session(session).lean() : null;
      const hoursMilli = Math.round((rows.at(-1).atTime - rows[0].atTime) / 3600);
      let state = 'PRESENT';
      if (shift && hoursMilli < shift.absentBelowHoursMilli) state = 'ABSENT';
      else if (shift && hoursMilli < shift.halfDayBelowHoursMilli) state = 'HALF_DAY';
      const arrivedIst = new Date(rows[0].atTime.getTime() + 330 * 60000).toISOString().slice(11, 16);
      const [h, m] = (shift?.startTime || '00:00').split(':').map(Number);
      const allowed = h * 60 + m + (shift?.graceMinutes ?? 0);
      const [ah, am] = arrivedIst.split(':').map(Number);
      await modelOf('Attendance').create([{ employeeId, onDate: date, state, shiftTypeId: shift ? String(shift._id) : null, workingHoursMilli: hoursMilli, lateEntry: Boolean(shift) && ah * 60 + am > allowed, source: 'CHECKIN' }], { session });
      return true;
    });
    if (wasMarked) marked += 1;
  }
  return marked;
}
defineJob('attendance-from-checkins', 240, (now) => buildAttendance(addDays(asDate(now), -1)));

// Sends what is queued. With no mail server set up, emails wait and say so, rather than
// pretending to have gone.
export async function flushEmails() {
  const queued = await EmailQueue.find({ status: { $in: ['QUEUED', 'NOT_CONFIGURED'] }, attempts: { $lt: 5 } }).sort({ createdAt: 1 }).limit(50);
  if (queued.length === 0) return 0;
  if (!process.env.SMTP_HOST) {
    await EmailQueue.updateMany({ _id: { $in: queued.map((e) => e._id) } }, { status: 'NOT_CONFIGURED' });
    return 0;
  }
  const nodemailer = (await import('nodemailer')).default;
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
  });
  let sent = 0;
  for (const email of queued) {
    try {
      await transport.sendMail({ from: process.env.SMTP_FROM ?? process.env.SMTP_USER, to: email.to, subject: email.subject, text: email.body });
      email.status = 'SENT';
      email.sentAt = new Date();
      sent += 1;
    } catch (error) {
      email.attempts += 1;
      email.status = email.attempts >= 5 ? 'FAILED' : 'QUEUED';
      email.error = String(error.message).slice(0, 500);
    }
    await email.save();
  }
  return sent;
}
defineJob('email-queue', 5, () => flushEmails());

// A copy of everything, once a day. It sits on the same disk until someone moves it off.
defineJob('backup', 1440, async () => {
  const result = await createBackup();
  if (result.copyError) {
    const admins = await User.find({ role: 'ADMIN', isActive: true }, { _id: 1 }).lean();
    await withTxn(async (session) => {
      for (const admin of admins) await notify(session, admin._id, `The backup was made, but copying it elsewhere failed: ${result.copyError}`, '/system');
    });
  }
  return { backup: result.name, bytes: result.bytes, copiedTo: result.copiedTo };
});

defineJob('email-in', 5, () => readMailbox());
defineJob('sms-queue', 5, () => flushSms());
defineJob('exchange-rates', 720, () => fetchExchangeRates());

// The drawing vault reads its watched folders every minute. Unchanged files are skipped by
// size and time, so a quiet folder costs one directory listing.
defineJob('vault-watch', 1, async (now) => scanAllWatches(now.getTime()));
