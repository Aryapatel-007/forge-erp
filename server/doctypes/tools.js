// Tools for doing one job to many records at once.
import { define, modelOf } from '../engine/registry.js';
import { createDoc, submitDoc } from '../engine/documents.js';
import { Payment, PurchaseInvoice, SalesInvoice } from '../models/documents.js';
import { allocatePayment } from '../services/accountsService.js';
import { daysBetween, todayIst } from '../utils/dates.js';
import { rule } from '../utils/errors.js';

const MAX_DAYS = 62;

const activePeople = async (session, doc) => {
  const filter = { state: 'ACTIVE' };
  if (doc.departmentId) filter.departmentId = String(doc.departmentId);
  if (doc.branchId) filter.branchId = String(doc.branchId);
  const people = await modelOf('Employee').find(filter).session(session).lean();
  if (people.length === 0) throw rule('Nobody matches.', 'NOBODY');
  return people;
};

const hr = (name, fields, action, extra = {}) => define({
  name,
  module: 'hr',
  labelFields: ['createdByName'],
  fields: `${fields} done~:int skipped~:int`,
  list: `${fields.split(' ')[0].split(/[!:~]/)[0]} done skipped`,
  actions: [{
    key: 'apply',
    label: 'Apply to everyone',
    primary: true,
    when: { done: [0] },
    fields: '',
    async run(session, doc, _body, context) {
      const { done, skipped } = await action(session, doc, context);
      doc.done = done;
      doc.skipped = skipped;
      await doc.save({ session });
      return doc;
    },
  }],
  ...extra,
});

hr('EmployeeAttendanceTool', 'onDate!:date state:select(PRESENT,ABSENT,HALF_DAY,WORK_FROM_HOME)=PRESENT departmentId:link(Department) branchId:link(Branch)', async (session, doc, { actor }) => {
  let done = 0;
  let skipped = 0;
  for (const person of await activePeople(session, doc)) {
    // A day already marked keeps what it has, so running this twice cannot overwrite leave.
    if (await modelOf('Attendance').exists({ employeeId: String(person._id), onDate: doc.onDate }).session(session)) {
      skipped += 1;
    } else {
      await createDoc(session, 'Attendance', { employeeId: String(person._id), onDate: doc.onDate, state: doc.state }, actor);
      done += 1;
    }
  }
  return { done, skipped };
}, { hint: 'Marks everyone chosen who has no attendance for that day. Days already marked are left alone.' });

hr('LeaveControlPanel', 'periodId!:link(LeavePeriod) leaveTypeId!:link(LeaveType) halfDays!:int departmentId:link(Department) branchId:link(Branch)', async (session, doc, { actor }) => {
  if (doc.halfDays <= 0) throw rule('Enter the leave to give.', 'AMOUNT_REQUIRED');
  let done = 0;
  let skipped = 0;
  for (const person of await activePeople(session, doc)) {
    const has = await modelOf('LeaveAllocation').exists({ employeeId: String(person._id), leaveTypeId: String(doc.leaveTypeId), periodId: String(doc.periodId), status: 'SUBMITTED' }).session(session);
    if (has) {
      skipped += 1;
    } else {
      const row = await createDoc(session, 'LeaveAllocation', { employeeId: String(person._id), leaveTypeId: String(doc.leaveTypeId), periodId: String(doc.periodId), halfDays: doc.halfDays, notes: 'Leave control panel' }, actor);
      await submitDoc(session, 'LeaveAllocation', row._id, actor);
      done += 1;
    }
  }
  return { done, skipped };
}, { labels: { halfDays: 'Half days to give' }, hint: 'Anyone who already has this leave for the period is skipped.' });

hr('ShiftAssignmentTool', 'shiftTypeId!:link(ShiftType) startDate!:date endDate:date departmentId:link(Department) branchId:link(Branch)', async (session, doc, { actor }) => {
  if (doc.endDate && daysBetween(doc.startDate, doc.endDate) > MAX_DAYS * 12) throw rule('That is too long for one go.', 'BAD_DATES');
  let done = 0;
  let skipped = 0;
  const others = await modelOf('ShiftAssignment').find({ isActive: true }).session(session).lean();
  const end = doc.endDate ?? '9999-12-31';
  for (const person of await activePeople(session, doc)) {
    const clash = others.some((o) => String(o.employeeId) === String(person._id) && doc.startDate <= (o.endDate ?? '9999-12-31') && end >= o.startDate);
    if (clash) {
      skipped += 1;
    } else {
      await createDoc(session, 'ShiftAssignment', { employeeId: String(person._id), shiftTypeId: String(doc.shiftTypeId), startDate: doc.startDate, endDate: doc.endDate ?? null, isActive: true }, actor);
      done += 1;
    }
  }
  return { done, skipped };
}, { hint: 'Anyone who already has a shift on those dates is skipped.' });

hr('BulkSalaryStructureAssignment', 'structureId!:link(SalaryStructure) monthlyCtcPaise!:money fromDate!:date departmentId:link(Department) branchId:link(Branch)', async (session, doc, { actor }) => {
  let done = 0;
  let skipped = 0;
  for (const person of await activePeople(session, doc)) {
    if (await modelOf('SalaryStructureAssignment').exists({ employeeId: String(person._id), status: 'SUBMITTED', fromDate: doc.fromDate }).session(session)) {
      skipped += 1;
    } else {
      const row = await createDoc(session, 'SalaryStructureAssignment', { employeeId: String(person._id), structureId: String(doc.structureId), monthlyCtcPaise: doc.monthlyCtcPaise, fromDate: doc.fromDate }, actor);
      await submitDoc(session, 'SalaryStructureAssignment', row._id, actor);
      done += 1;
    }
  }
  return { done, skipped };
}, { hint: 'Everyone chosen gets the same monthly figure. Use it for a grade, not for people on different pay.' });

// Payments that were never matched to a bill, set against the oldest bills first.
define({
  name: 'PaymentReconciliation',
  module: 'accounts',
  labelFields: ['partyId'],
  fields: 'partyId!:link(Party) kind:select(RECEIPT,PAYMENT)=RECEIPT uptoDate:date allocatedPaise~:money matchedCount~:int',
  tables: { 'matches~': 'paymentNo invoiceNo amountPaise:money' },
  list: 'partyId kind allocatedPaise matchedCount',
  hint: 'Rupee payments only. Foreign currency receipts are matched by hand, so the exchange gain or loss is checked.',
  actions: [{
    key: 'match',
    label: 'Match oldest first',
    primary: true,
    when: { matchedCount: [0] },
    fields: '',
    async run(session, doc, _body, { actor }) {
      const today = todayIst();
      const upto = doc.uptoDate ?? today;
      const payments = await Payment.find({ partyId: doc.partyId, kind: doc.kind, status: 'SUBMITTED', currency: 'INR', postingDate: { $lte: upto } }).sort({ postingDate: 1 }).session(session);
      const Invoice = doc.kind === 'RECEIPT' ? SalesInvoice : PurchaseInvoice;
      const invoices = await Invoice.find({ partyId: doc.partyId, status: 'SUBMITTED', postingDate: { $lte: upto } }).sort({ dueDate: 1, postingDate: 1 }).session(session).lean();
      const open = invoices
        .filter((i) => (i.currency ?? 'INR') === 'INR')
        .map((i) => ({ id: i._id, docNo: i.docNo, left: i.totalPaise - (i.paidPaise ?? 0) - (i.creditedPaise ?? 0) }))
        .filter((i) => i.left > 0);
      const matches = [];
      for (const payment of payments) {
        let left = payment.amountMinor + (payment.deductionsPaise ?? 0) - payment.allocatedMinor;
        for (const invoice of open) {
          if (left <= 0) break;
          const take = Math.min(left, invoice.left);
          if (take <= 0) continue;
          await allocatePayment(session, payment._id, { docId: invoice.id, amountMinor: take, postingDate: today }, actor);
          invoice.left -= take;
          left -= take;
          matches.push({ paymentNo: payment.docNo, invoiceNo: invoice.docNo, amountPaise: take });
        }
      }
      if (matches.length === 0) throw rule('Nothing here can be matched.', 'NOTHING_TO_MATCH');
      doc.matches = matches;
      doc.matchedCount = matches.length;
      doc.allocatedPaise = matches.reduce((sum, m) => sum + m.amountPaise, 0);
      await doc.save({ session });
      return doc;
    },
  }],
});

