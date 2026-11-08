// Behaviour for document types that were only records before. Each entry here is merged into
// its type's definition when that definition runs, so this file must load before the others.
import { define, extend, linkTarget, modelOf } from '../engine/registry.js';
import { cancelDoc, createDoc, submitDoc } from '../engine/documents.js';
import { Bin } from '../models/ledgers.js';
import { Item, Party, Warehouse } from '../models/masters.js';
import { Grn, Inspection, MachineBuild, PurchaseOrder, SalesOrder } from '../models/documents.js';
import { installBuild } from '../services/buildService.js';
import { queueEmail } from '../services/notifyService.js';
import { raiseNcr } from '../services/qualityService.js';
import { salesOrder as salesOrderService } from '../services/salesService.js';
import { getSettings } from '../services/settingsService.js';
import { computeTax, supplyTypeFor } from '../utils/tax.js';
import { lineValue, mulDivRound, sumInts } from '../utils/money.js';
import { addMonths, todayIst } from '../utils/dates.js';
import { conflict, rule } from '../utils/errors.js';

const BPS_WHOLE = 10000;

/* ---------- Pay items that reach the salary slip ---------- */

async function componentNamed(session, name, abbreviation, kind, actor) {
  const Component = modelOf('SalaryComponent');
  const found = await Component.findOne({ name }).session(session).lean();
  if (found) return found;
  return createDoc(session, 'SalaryComponent', { name, abbreviation, kind, isTaxable: kind === 'EARNING' }, actor);
}

// Goes on the employee's next salary slip for that month, by way of an additional salary.
async function addToPay(session, doc, { component, amountPaise, forMonth, reason }, actor) {
  const extra = await createDoc(session, 'AdditionalSalary', { employeeId: String(doc.employeeId), componentId: String(component._id), amountPaise, forMonth, reason }, actor);
  await submitDoc(session, 'AdditionalSalary', extra._id, actor);
  doc.additionalSalaryId = String(extra._id);
}

async function removeFromPay(session, doc, actor) {
  if (!doc.additionalSalaryId) return;
  const extra = await modelOf('AdditionalSalary').findById(doc.additionalSalaryId).session(session).lean();
  if (!extra || extra.status !== 'SUBMITTED') return;
  if (extra.appliedSlipId) throw conflict('This has already been paid on a salary slip.', 'ALREADY_ON_SLIP');
  await cancelDoc(session, 'AdditionalSalary', extra._id, `${doc.docNo} was cancelled`, actor);
}

const payItem = (name, abbreviation, valueOf) => ({
  fields: 'additionalSalaryId~:link(AdditionalSalary)',
  async onSubmit(session, doc, { actor }) {
    const { amountPaise, forMonth, reason } = valueOf(doc);
    const component = await componentNamed(session, name, abbreviation, 'EARNING', actor);
    await addToPay(session, doc, { component, amountPaise, forMonth, reason }, actor);
  },
  async onCancel(session, doc, { actor }) {
    await removeFromPay(session, doc, actor);
  },
});

extend('EmployeeIncentive', payItem('Incentive', 'INCV', (doc) => ({ amountPaise: doc.amountPaise, forMonth: doc.forMonth, reason: doc.reason || `Incentive ${doc.docNo}` })));
extend('RetentionBonus', payItem('Retention bonus', 'RETB', (doc) => ({ amountPaise: doc.bonusPaise, forMonth: doc.payOn, reason: `Retention bonus ${doc.docNo}` })));
extend('EmployeeBenefitClaim', payItem('Benefit claim', 'BENC', (doc) => ({ amountPaise: doc.amountPaise, forMonth: doc.onDate, reason: doc.description })));

extend('Arrear', {
  fields: 'additionalSalaryId~:link(AdditionalSalary)',
  async onSubmit(session, doc, { actor }) {
    if (doc.toDate < doc.fromDate) throw rule('The period ends before it starts.', 'BAD_DATES');
    const component = await modelOf('SalaryComponent').findById(doc.componentId).session(session).lean();
    await addToPay(session, doc, { component, amountPaise: doc.amountPaise, forMonth: todayIst(), reason: doc.reason || `Arrears ${doc.fromDate} to ${doc.toDate}` }, actor);
  },
  async onCancel(session, doc, { actor }) {
    await removeFromPay(session, doc, actor);
  },
});

// A correction to a slip already closed lands on the next one. Too much paid comes back
// as a deduction, too little as an earning.
extend('PayrollCorrection', {
  fields: 'additionalSalaryId~:link(AdditionalSalary)',
  async onSubmit(session, doc, { actor }) {
    if (doc.differencePaise === 0) throw rule('Enter the difference.', 'AMOUNT_REQUIRED');
    const slip = await modelOf('SalarySlip').findById(doc.salarySlipId).session(session).lean();
    if (!slip || slip.status !== 'SUBMITTED' || String(slip.employeeId) !== String(doc.employeeId)) throw rule('That slip is not a posted slip of this employee.', 'BAD_SLIP');
    const component = doc.differencePaise > 0
      ? await componentNamed(session, 'Payroll correction (added)', 'PCOA', 'EARNING', actor)
      : await componentNamed(session, 'Payroll correction (recovered)', 'PCOR', 'DEDUCTION', actor);
    await addToPay(session, doc, { component, amountPaise: Math.abs(doc.differencePaise), forMonth: todayIst(), reason: doc.reason }, actor);
  },
  async onCancel(session, doc, { actor }) {
    await removeFromPay(session, doc, actor);
  },
});

extend('LeaveEncashment', {
  fields: 'additionalSalaryId~:link(AdditionalSalary) allocationId~:link(LeaveAllocation)',
  async onSubmit(session, doc, { actor }) {
    const { leaveBalance } = await import('./hr.js');
    const today = todayIst();
    if (doc.halfDays <= 0) throw rule('Enter the leave to encash.', 'AMOUNT_REQUIRED');
    const balance = await leaveBalance(session, doc.employeeId, doc.leaveTypeId, today, today);
    if (doc.halfDays > balance) throw rule(`Only ${balance / 2} days are left.`, 'NOT_ENOUGH_LEAVE');
    const period = await modelOf('LeavePeriod').findOne({ fromDate: { $lte: today }, toDate: { $gte: today } }).session(session).lean();
    const taken = await createDoc(session, 'LeaveAllocation', { employeeId: String(doc.employeeId), leaveTypeId: String(doc.leaveTypeId), periodId: String(period._id), halfDays: -doc.halfDays, notes: `Encashed on ${doc.docNo}` }, actor);
    await submitDoc(session, 'LeaveAllocation', taken._id, actor);
    doc.allocationId = String(taken._id);
    const component = await componentNamed(session, 'Leave encashment', 'LENC', 'EARNING', actor);
    await addToPay(session, doc, { component, amountPaise: doc.amountPaise, forMonth: today, reason: `Encashed ${doc.halfDays / 2} days` }, actor);
  },
  async onCancel(session, doc, { actor }) {
    await removeFromPay(session, doc, actor);
    if (doc.allocationId) await cancelDoc(session, 'LeaveAllocation', doc.allocationId, `${doc.docNo} was cancelled`, actor);
  },
});

extend('CompensatoryLeaveRequest', {
  fields: 'allocationId~:link(LeaveAllocation)',
  async onSubmit(session, doc, { actor }) {
    const leaveType = await modelOf('LeaveType').findById(doc.leaveTypeId).session(session).lean();
    if (!leaveType?.isCompensatory) throw rule('That leave type is not for compensatory leave.', 'NOT_COMPENSATORY');
    const attended = await modelOf('Attendance').exists({ employeeId: String(doc.employeeId), onDate: doc.workedOn, state: { $in: ['PRESENT', 'WORK_FROM_HOME', 'HALF_DAY'] } }).session(session);
    if (!attended) throw rule('There is no attendance for that day.', 'NO_ATTENDANCE');
    const period = await modelOf('LeavePeriod').findOne({ fromDate: { $lte: doc.workedOn }, toDate: { $gte: doc.workedOn } }).session(session).lean();
    if (!period) throw rule('No leave period covers that day.', 'NO_LEAVE_PERIOD');
    const given = await createDoc(session, 'LeaveAllocation', { employeeId: String(doc.employeeId), leaveTypeId: String(doc.leaveTypeId), periodId: String(period._id), halfDays: 2, notes: `For working on ${doc.workedOn}` }, actor);
    await submitDoc(session, 'LeaveAllocation', given._id, actor);
    doc.allocationId = String(given._id);
  },
  async onCancel(session, doc, { actor }) {
    if (doc.allocationId) await cancelDoc(session, 'LeaveAllocation', doc.allocationId, `${doc.docNo} was cancelled`, actor);
  },
});

extend('SalaryWithholding', {
  actions: [{
    key: 'release',
    label: 'Release',
    primary: true,
    when: { status: ['SUBMITTED'], isReleased: [false] },
    fields: '',
    async run(session, doc) {
      doc.isReleased = true;
      await doc.save({ session });
      return doc;
    },
  }],
  onSubmit(_session, doc) {
    if (doc.toDate < doc.fromDate) throw rule('The period ends before it starts.', 'BAD_DATES');
  },
});

// Is this person's salary being held for this slip's month? Payroll asks before paying.
export async function isSalaryHeld(session, employeeId, startDate, endDate) {
  return modelOf('SalaryWithholding').exists({ employeeId: String(employeeId), status: 'SUBMITTED', isReleased: { $ne: true }, fromDate: { $lte: endDate }, toDate: { $gte: startDate } }).session(session);
}

extend('GratuityRule', {
  prepare(_session, data) {
    if (data.daysInMonth === 0) throw rule('Days in a month cannot be zero.', 'BAD_RULE');
    return data;
  },
});

/* ---------- Shifts ---------- */

const overlaps = (aFrom, aTo, bFrom, bTo) => aFrom <= (bTo ?? '9999-12-31') && (aTo ?? '9999-12-31') >= bFrom;

extend('ShiftAssignment', {
  async prepare(session, data, { existing }) {
    if (data.endDate && data.endDate < data.startDate) throw rule('The shift ends before it starts.', 'BAD_DATES');
    if (data.isActive === false) return data;
    const others = await modelOf('ShiftAssignment').find({ employeeId: String(data.employeeId), isActive: true, _id: { $ne: existing?._id ?? null } }).session(session).lean();
    if (others.some((o) => overlaps(data.startDate, data.endDate, o.startDate, o.endDate))) throw rule('This person already has a shift on those dates.', 'SHIFT_OVERLAP');
    return data;
  },
});

extend('ShiftRequest', {
  fields: 'assignmentId~:link(ShiftAssignment)',
  async onSubmit(session, doc, { actor }) {
    if (doc.toDate < doc.fromDate) throw rule('The request ends before it starts.', 'BAD_DATES');
    const assignment = await createDoc(session, 'ShiftAssignment', { employeeId: String(doc.employeeId), shiftTypeId: String(doc.shiftTypeId), startDate: doc.fromDate, endDate: doc.toDate, isActive: true }, actor);
    doc.assignmentId = String(assignment._id);
  },
  async onCancel(session, doc) {
    if (doc.assignmentId) await modelOf('ShiftAssignment').updateOne({ _id: doc.assignmentId }, { isActive: false }, { session });
  },
});

/* ---------- Recruitment ---------- */

extend('JobRequisition', {
  fields: 'jobOpeningId~:link(JobOpening)',
  actions: [{
    key: 'makeOpening',
    label: 'Open the job',
    primary: true,
    when: { state: ['PENDING', 'OPEN'], jobOpeningId: [null] },
    fields: '',
    navigate: 'JobOpening',
    async run(session, doc, _body, { actor }) {
      const designation = await modelOf('Designation').findById(doc.designationId).session(session).lean();
      const opening = await createDoc(session, 'JobOpening', { title: designation?.name ?? 'New opening', designationId: String(doc.designationId), departmentId: doc.departmentId ? String(doc.departmentId) : null, vacancies: doc.openings || 1, description: doc.reason, state: 'OPEN' }, actor);
      doc.jobOpeningId = String(opening._id);
      doc.state = 'OPEN';
      await doc.save({ session });
      return opening;
    },
  }],
});

// An opening within a staffing plan cannot ask for more people than the plan allows.
extend('JobOpening', {
  fields: 'hiredCount~:int',
  async prepare(session, data) {
    if (!data.designationId || !data.vacancies) return data;
    const today = todayIst();
    const plans = await modelOf('StaffingPlan').find({ fromDate: { $lte: today }, toDate: { $gte: today }, 'rows.designationId': String(data.designationId) }).session(session).lean();
    if (plans.length === 0) return data;
    const allowed = sumInts(plans.flatMap((p) => p.rows).filter((r) => String(r.designationId) === String(data.designationId)).map((r) => r.vacancies));
    if (data.vacancies > allowed) throw rule(`The staffing plan allows ${allowed} for this designation.`, 'OVER_STAFFING_PLAN');
    return data;
  },
});

extend('Interview', {
  async prepare(session, data, { existing }) {
    if (data.fromTime && data.toTime && data.toTime <= data.fromTime) throw rule('The interview ends before it starts.', 'BAD_DATES');
    const interviewers = (data.interviewers ?? []).map((row) => String(row.userId));
    if (interviewers.length && data.fromTime && data.toTime) {
      const same = await modelOf('Interview').find({ onDate: data.onDate, _id: { $ne: existing?._id ?? null }, 'interviewers.userId': { $in: interviewers } }).session(session).lean();
      if (same.some((other) => other.fromTime && other.toTime && data.fromTime < other.toTime && data.toTime > other.fromTime)) throw rule('An interviewer already has an interview then.', 'INTERVIEWER_BUSY');
    }
    return data;
  },
});

// Once everyone has given feedback the interview takes the majority view. A tie is not a pass.
extend('InterviewFeedback', {
  async afterCreate(session, doc) {
    const interview = await modelOf('Interview').findById(doc.interviewId).session(session);
    if (!interview) return;
    if (!interview.interviewers.some((row) => String(row.userId) === String(doc.interviewerId))) throw rule('That person is not on this interview.', 'NOT_AN_INTERVIEWER');
    const given = await modelOf('InterviewFeedback').find({ interviewId: String(interview._id) }).session(session).lean();
    if (new Set(given.map((f) => String(f.interviewerId))).size !== given.length) throw conflict('That person has already given feedback.', 'FEEDBACK_EXISTS');
    if (given.length >= interview.interviewers.length) {
      const cleared = given.filter((f) => f.result === 'CLEARED').length;
      interview.state = cleared * 2 > given.length ? 'CLEARED' : 'REJECTED';
      await interview.save({ session });
    }
  },
});

extend('JobOffer', {
  fields: 'employeeId~:link(Employee)',
  async onSubmit(session, doc) {
    await modelOf('JobApplicant').updateOne({ _id: doc.applicantId }, { state: 'ACCEPTED' }, { session });
  },
  actions: [
    {
      key: 'accepted',
      label: 'Offer accepted',
      primary: true,
      when: { status: ['SUBMITTED'], state: ['AWAITING', null] },
      fields: '',
      async run(session, doc) {
        doc.state = 'ACCEPTED';
        await doc.save({ session });
        return doc;
      },
    },
    {
      key: 'rejected',
      label: 'Offer rejected',
      when: { status: ['SUBMITTED'], state: ['AWAITING', null] },
      fields: '',
      async run(session, doc) {
        doc.state = 'REJECTED';
        await modelOf('JobApplicant').updateOne({ _id: doc.applicantId }, { state: 'REJECTED' }, { session });
        await doc.save({ session });
        return doc;
      },
    },
    {
      key: 'makeEmployee',
      label: 'Make employee',
      primary: true,
      when: { status: ['SUBMITTED'], state: ['ACCEPTED'], employeeId: [null] },
      fields: 'joiningDate!:date departmentId:link(Department) onboardingTemplateId:link(EmployeeOnboardingTemplate)',
      navigate: 'Employee',
      async run(session, doc, body, { actor }) {
        const applicant = await modelOf('JobApplicant').findById(doc.applicantId).session(session).lean();
        const employee = await createDoc(session, 'Employee', { fullName: applicant.applicantName, email: applicant.email || '', mobile: applicant.phone || '', designationId: String(doc.designationId), departmentId: body.departmentId ?? null, joiningDate: body.joiningDate, state: 'ACTIVE' }, actor);
        doc.employeeId = String(employee._id);
        await doc.save({ session });
        if (applicant.jobOpeningId) await modelOf('JobOpening').updateOne({ _id: applicant.jobOpeningId }, { $inc: { hiredCount: 1 } }, { session });
        if (body.onboardingTemplateId) {
          const template = await modelOf('EmployeeOnboardingTemplate').findById(body.onboardingTemplateId).session(session).lean();
          await createDoc(session, 'EmployeeOnboarding', { employeeId: String(employee._id), applicantId: String(doc.applicantId), startDate: body.joiningDate, state: 'PENDING', activities: (template?.activities ?? []).map((a) => ({ activity: a.activity })) }, actor);
        }
        return employee;
      },
    },
  ],
});

const activityState = (rows, current) => {
  if (!rows?.length) return current ?? 'PENDING';
  const done = rows.filter((r) => r.isDone).length;
  if (done === 0) return 'PENDING';
  return done === rows.length ? 'COMPLETED' : 'IN_PROGRESS';
};
extend('EmployeeOnboarding', {
  prepare(_session, data) {
    return { ...data, state: activityState(data.activities, data.state) };
  },
});

// Starts a review cycle: one draft appraisal for each person still with the company.
extend('AppraisalCycle', {
  actions: [{
    key: 'start',
    label: 'Start appraisals',
    primary: true,
    when: { state: ['NOT_STARTED', null] },
    fields: 'templateId!:link(AppraisalTemplate) departmentId:link(Department)',
    async run(session, doc, body, { actor }) {
      const template = await modelOf('AppraisalTemplate').findById(body.templateId).session(session).lean();
      if (!template?.rows?.length) throw rule('That template has no KRAs.', 'EMPTY_TEMPLATE');
      const filter = { state: 'ACTIVE', ...(body.departmentId ? { departmentId: body.departmentId } : {}) };
      const people = await modelOf('Employee').find(filter).session(session).lean();
      if (people.length === 0) throw rule('Nobody matches.', 'NOBODY');
      for (const person of people) {
        await createDoc(session, 'Appraisal', { employeeId: String(person._id), cycleId: String(doc._id), templateId: String(template._id), rows: template.rows.map((r) => ({ kraId: String(r.kraId), weightBps: r.weightBps })) }, actor);
      }
      doc.state = 'IN_PROGRESS';
      await doc.save({ session });
      return doc;
    },
  }],
});

extend('AppraisalTemplate', {
  prepare(_session, data) {
    const total = sumInts((data.rows ?? []).map((r) => r.weightBps));
    if (data.rows?.length && total !== BPS_WHOLE) throw rule(`The weights add up to ${total / 100}%, and must add up to 100%.`, 'BAD_WEIGHTS');
    return data;
  },
});

extend('Goal', {
  prepare(_session, data) {
    if (data.state === 'ARCHIVED') return data;
    const progress = data.progressBps ?? 0;
    if (progress > BPS_WHOLE) throw rule('Progress cannot be over 100%.', 'BAD_PROGRESS');
    let state = 'PENDING';
    if (progress >= BPS_WHOLE) state = 'COMPLETED';
    else if (progress > 0) state = 'IN_PROGRESS';
    return { ...data, state };
  },
});

extend('TrainingResult', {
  async prepare(session, data) {
    const event = await modelOf('TrainingEvent').findById(data.eventId).session(session).lean();
    if (!event) throw rule('That training event does not exist.', 'LINK_NOT_FOUND');
    const attended = new Set(event.attendees.map((a) => String(a.employeeId)));
    if ((data.rows ?? []).some((row) => !attended.has(String(row.employeeId)))) throw rule('Everyone with a result must be on the event.', 'NOT_AN_ATTENDEE');
    return data;
  },
});

extend('TravelRequest', {
  onSubmit(_session, doc) {
    if (doc.toDate < doc.fromDate) throw rule('The trip ends before it starts.', 'BAD_DATES');
  },
});

extend('VehicleLog', {
  fields: 'distance~:int',
  async prepare(session, data, { existing }) {
    const from = data.odometerFrom ?? 0;
    const to = data.odometerTo ?? 0;
    if (to && to < from) throw rule('The odometer cannot go backwards.', 'BAD_ODOMETER');
    const previous = await modelOf('VehicleLog').findOne({ vehicleId: String(data.vehicleId), _id: { $ne: existing?._id ?? null }, onDate: { $lte: data.onDate } }).sort({ onDate: -1, createdAt: -1 }).session(session).lean();
    if (previous?.odometerTo && from && from < previous.odometerTo) throw rule(`The last log ended at ${previous.odometerTo}.`, 'BAD_ODOMETER');
    return { ...data, distance: to ? to - from : 0 };
  },
});

/* ---------- Selling ---------- */

const orderFromLines = async (session, doc, lines, actor, extra = {}) => {
  const data = await salesOrderService.prepare(session, {
    ...extra,
    partyId: String(doc.partyId),
    postingDate: todayIst(),
    lines,
    milestones: [{ no: 1, name: 'Against invoice', trigger: 'BEFORE_DISPATCH', pctBps: BPS_WHOLE }],
    terms: doc.terms ?? '',
  });
  const [order] = await SalesOrder.create([{ ...data, createdBy: actor.id }], { session });
  return order;
};

// Prices the proforma the way an invoice would be, so the figure quoted is the figure billed.
extend('ProformaInvoice', {
  fields: 'taxablePaise~:money taxPaise~:money salesOrderId~:link(SalesOrder)',
  async prepare(session, data) {
    const party = await Party.findById(data.partyId).session(session).lean();
    if (!party) throw rule('That party does not exist.', 'LINK_NOT_FOUND');
    const settings = await getSettings(session);
    const supplyType = supplyTypeFor({ companyState: settings.stateCode, partyState: party.stateCode, isExport: party.isExport, isSez: party.isSez });
    const lines = (data.lines ?? []).map((line) => ({ ...line, gstRateBps: line.gstRateBps ?? 0, taxablePaise: lineValue(line.qtyMilli, line.ratePaise) }));
    const tax = computeTax(lines, supplyType);
    const taxablePaise = sumInts(lines.map((l) => l.taxablePaise));
    return { ...data, taxablePaise, taxPaise: tax.taxPaise, totalPaise: taxablePaise + tax.taxPaise };
  },
  actions: [{
    key: 'makeSalesOrder',
    label: 'Make sales order',
    primary: true,
    when: { salesOrderId: [null] },
    fields: '',
    navigateTo: 'salesOrders',
    async run(session, doc, _body, { actor }) {
      const order = await orderFromLines(session, doc, doc.lines.map((l) => ({ itemId: String(l.itemId), qtyMilli: l.qtyMilli, rateMinor: l.ratePaise, gstRateBps: l.gstRateBps })), actor);
      doc.salesOrderId = String(order._id);
      await doc.save({ session });
      return order;
    },
  }],
});

extend('BlanketOrder', {
  prepare(_session, data) {
    if (data.toDate < data.fromDate) throw rule('The order ends before it starts.', 'BAD_DATES');
    return data;
  },
  actions: [{
    key: 'callOff',
    label: 'Call off against this',
    primary: true,
    when: {},
    fields: 'itemId!:link(Item) qtyMilli!:qty',
    navigateTo: 'salesOrders',
    async run(session, doc, body, { actor }) {
      const today = todayIst();
      if (today < doc.fromDate || today > doc.toDate) throw rule('This blanket order is outside its dates.', 'OUTSIDE_DATES');
      const line = doc.lines.find((l) => String(l.itemId) === String(body.itemId));
      if (!line) throw rule('That item is not on this order.', 'NOT_ON_ORDER');
      // Counted from the orders themselves, so a cancelled or deleted one gives its share back.
      const live = await SalesOrder.find({ blanketOrderId: String(doc._id), status: { $ne: 'CANCELLED' } }, { lines: 1 }).session(session).lean();
      const ordered = sumInts(live.flatMap((o) => o.lines).filter((l) => String(l.itemId) === String(body.itemId)).map((l) => l.qtyMilli));
      const left = line.qtyMilli - ordered;
      if (body.qtyMilli <= 0 || body.qtyMilli > left) throw rule(`Only ${left / 1000} is left on this order.`, 'OVER_BLANKET');
      const order = await orderFromLines(session, doc, [{ itemId: String(body.itemId), qtyMilli: body.qtyMilli, rateMinor: line.ratePaise }], actor, { blanketOrderId: String(doc._id) });
      line.orderedMilli = ordered + body.qtyMilli;
      await doc.save({ session });
      return order;
    },
  }],
});

extend('UserPermission', {
  async prepare(session, data) {
    let target;
    try {
      target = linkTarget(data.targetDoctype);
    } catch {
      throw rule(`There is no record type called ${data.targetDoctype}.`, 'BAD_TARGET');
    }
    const key = target.valueKey ?? '_id';
    const found = await target.Model.exists({ [key]: data.valueId }).session(session).catch(() => null);
    if (!found) throw rule(`That ${data.targetDoctype} does not exist.`, 'LINK_NOT_FOUND');
    return data;
  },
});

extend('InstallationNote', {
  writers: ['ADMIN', 'MANAGEMENT', 'SALES', 'SERVICE'],
  fields: 'appliedToBuild~:check',
  actions: [{
    key: 'apply',
    label: 'Mark machine installed',
    primary: true,
    when: { appliedToBuild: [false] },
    fields: '',
    async run(session, doc, _body, { actor }) {
      if (!doc.buildId) throw rule('This note is not for a machine build.', 'NO_BUILD');
      await installBuild(session, doc.buildId, { installedOn: doc.installedOn, installedBy: doc.engineer || actor.name, installationRef: doc.docNo }, actor);
      doc.appliedToBuild = true;
      await doc.save({ session });
      return doc;
    },
  }],
});

// A packing slip cannot pack more than the delivery note sends, across all its slips.
extend('PackingSlip', {
  writers: ['ADMIN', 'MANAGEMENT', 'STORES', 'SALES'],
  async prepare(session, data, { existing }) {
    if (data.netWeightMilli && data.grossWeightMilli && data.netWeightMilli > data.grossWeightMilli) throw rule('Net weight cannot be more than gross.', 'BAD_WEIGHT');
    const note = await modelOf('DeliveryNote').findById(data.deliveryNoteId).session(session).lean();
    if (!note) throw rule('That delivery note does not exist.', 'LINK_NOT_FOUND');
    const others = await modelOf('PackingSlip').find({ deliveryNoteId: String(note._id), _id: { $ne: existing?._id ?? null } }).session(session).lean();
    for (const line of data.lines ?? []) {
      const key = String(line.itemId);
      const sent = sumInts(note.lines.filter((l) => String(l.itemId) === key).map((l) => l.qtyMilli));
      const packed = sumInts(others.flatMap((s) => s.lines).filter((l) => String(l.itemId) === key).map((l) => l.qtyMilli));
      if (packed + line.qtyMilli > sent) throw rule(`Only ${(sent - packed) / 1000} of that item is left to pack.`, 'OVER_PACKED');
    }
    return data;
  },
});

/* ---------- Stock movements on paper ---------- */

// Where to go and get things: buckets with stock, oldest first, nearest expiry before that.
extend('PickList', {
  actions: [
    {
      key: 'generate',
      label: 'Work out where to pick',
      primary: true,
      when: { state: ['OPEN', null] },
      fields: '',
      async run(session, doc) {
        let wanted = [];
        if (doc.deliveryNoteId) {
          const note = await modelOf('DeliveryNote').findById(doc.deliveryNoteId).session(session).lean();
          wanted = (note?.lines ?? []).map((l) => ({ itemId: l.itemId, qtyMilli: l.qtyMilli }));
        } else if (doc.buildId) {
          const build = await MachineBuild.findById(doc.buildId, { materials: 1 }).session(session).lean();
          wanted = (build?.materials ?? []).map((m) => ({ itemId: m.itemId, qtyMilli: m.requiredMilli - m.issuedMilli })).filter((m) => m.qtyMilli > 0);
        }
        if (wanted.length === 0) throw rule('Name a delivery note or a build with something to pick.', 'NOTHING_TO_PICK');
        const stores = (await Warehouse.find({ kind: { $in: ['STORES', 'FG'] }, isActive: true }, { _id: 1 }).session(session).lean()).map((w) => w._id);
        const lines = [];
        const short = [];
        for (const row of wanted) {
          const bins = await Bin.find({ itemId: row.itemId, warehouseId: { $in: stores }, qtyMilli: { $gt: 0 }, buildId: doc.buildId ? { $in: [doc.buildId, null] } : null }).sort({ _id: 1 }).session(session).lean();
          const batches = await modelOf('Batch').find({ itemId: String(row.itemId), batchNo: { $in: bins.map((b) => b.lot).filter(Boolean) } }).session(session).lean();
          const expiry = (bin) => batches.find((b) => b.batchNo === bin.lot)?.expiresOn ?? '9999-12-31';
          bins.sort((a, b) => expiry(a).localeCompare(expiry(b)));
          let left = row.qtyMilli;
          for (const bin of bins) {
            if (left <= 0) break;
            const take = Math.min(left, bin.qtyMilli);
            lines.push({ itemId: String(row.itemId), warehouseId: String(bin.warehouseId), lot: bin.lot, qtyMilli: take, pickedMilli: 0 });
            left -= take;
          }
          if (left > 0) short.push(String(row.itemId));
        }
        doc.lines = lines;
        doc.state = 'OPEN';
        doc.shortItems = short.length;
        await doc.save({ session });
        return doc;
      },
    },
    {
      key: 'confirm',
      label: 'Everything picked',
      when: { state: ['OPEN', null] },
      fields: '',
      async run(session, doc) {
        if (doc.lines.length === 0) throw rule('There is nothing on this list.', 'NOTHING_TO_PICK');
        for (const line of doc.lines) line.pickedMilli = line.qtyMilli;
        doc.state = 'PICKED';
        await doc.save({ session });
        return doc;
      },
    },
  ],
  fields: 'shortItems~:int',
});

extend('Shipment', {
  fields: 'totalWeightMilli~:qty parcelCount~:int',
  prepare(_session, data) {
    const parcels = data.parcels ?? [];
    return {
      ...data,
      totalWeightMilli: sumInts(parcels.map((p) => mulDivRound(p.weightMilli ?? 0, (p.count || 1) * 1000, 1000))),
      parcelCount: sumInts(parcels.map((p) => p.count || 1)),
    };
  },
  actions: [
    {
      key: 'dispatch',
      label: 'In transit',
      primary: true,
      when: { state: ['BOOKED', null] },
      fields: 'awbNo',
      async run(session, doc, body) {
        if (body.awbNo) doc.awbNo = body.awbNo;
        doc.state = 'IN_TRANSIT';
        await doc.save({ session });
        return doc;
      },
    },
    {
      key: 'delivered',
      label: 'Delivered',
      primary: true,
      when: { state: ['IN_TRANSIT'] },
      fields: 'deliveredOn!:date',
      async run(session, doc, body) {
        doc.state = 'DELIVERED';
        doc.deliveredOn = body.deliveredOn;
        await doc.save({ session });
        return doc;
      },
    },
  ],
});

extend('DeliveryTrip', {
  actions: [
    {
      key: 'depart',
      label: 'Left',
      primary: true,
      when: { state: ['SCHEDULED', null] },
      fields: '',
      async run(session, doc) {
        if (doc.stops.length === 0) throw rule('Add the stops first.', 'NO_STOPS');
        doc.state = 'IN_TRANSIT';
        await doc.save({ session });
        return doc;
      },
    },
    {
      key: 'complete',
      label: 'Trip finished',
      primary: true,
      when: { state: ['IN_TRANSIT'] },
      fields: '',
      async run(session, doc) {
        for (const stop of doc.stops) stop.isVisited = true;
        doc.state = 'COMPLETED';
        await doc.save({ session });
        return doc;
      },
    },
  ],
});

/* ---------- Buying ---------- */

extend('RequestForQuotation', {
  async onSubmit(session, doc) {
    if (doc.suppliers.length === 0 || doc.lines.length === 0) throw rule('An RFQ needs suppliers and items.', 'EMPTY_RFQ');
    const items = await Item.find({ _id: { $in: doc.lines.map((l) => l.itemId) } }, { code: 1, name: 1 }).session(session).lean();
    const list = doc.lines.map((l) => {
      const item = items.find((i) => String(i._id) === String(l.itemId));
      return `${item?.code} ${item?.name}: ${l.qtyMilli / 1000}`;
    }).join('\n');
    for (const supplier of doc.suppliers) {
      if (supplier.email) await queueEmail(session, { to: supplier.email, subject: `Request for quotation ${doc.docNo}`, body: `${doc.message || 'Please quote for the following.'}\n\n${list}\n\n${doc.replyBy ? `Please reply by ${doc.replyBy}.` : ''}` });
    }
  },
  actions: [{
    key: 'makeQuotation',
    label: 'Enter a supplier quotation',
    primary: true,
    when: { status: ['SUBMITTED'] },
    fields: 'partyId!:link(Party;isSupplier=true)',
    navigate: 'SupplierQuotation',
    async run(session, doc, body, { actor }) {
      if (!doc.suppliers.some((s) => String(s.partyId) === String(body.partyId))) throw rule('That supplier is not on this RFQ.', 'NOT_ON_RFQ');
      return createDoc(session, 'SupplierQuotation', { partyId: body.partyId, rfqId: String(doc._id), lines: doc.lines.map((l) => ({ itemId: String(l.itemId), qtyMilli: l.qtyMilli, ratePaise: 0 })) }, actor);
    },
  }],
});

extend('SupplierQuotation', {
  async onSubmit(session, doc) {
    if (!doc.rfqId) return;
    await modelOf('RequestForQuotation').updateOne({ _id: doc.rfqId, 'suppliers.partyId': String(doc.partyId) }, { $set: { 'suppliers.$.hasReplied': true } }, { session });
  },
});

// The two things a buyer can prove from the books: did it come on time, and was it any good.
extend('SupplierScorecardPeriod', {
  fields: 'receiptsChecked~:int onTimeBps~:pct acceptedBps~:pct standing~',
  actions: [{
    key: 'score',
    label: 'Work out the score',
    primary: true,
    when: {},
    fields: '',
    async run(session, doc) {
      const receipts = await Grn.find({ partyId: doc.partyId, status: 'SUBMITTED', postingDate: { $gte: doc.fromDate, $lte: doc.toDate } }).session(session).lean();
      if (receipts.length === 0) throw rule('Nothing was received from them in these dates.', 'NO_RECEIPTS');
      const orders = await PurchaseOrder.find({ _id: { $in: receipts.map((r) => r.purchaseOrderId) } }, { expectedDate: 1 }).session(session).lean();
      const onTime = receipts.filter((r) => {
        const order = orders.find((o) => String(o._id) === String(r.purchaseOrderId));
        return !order?.expectedDate || r.postingDate <= order.expectedDate;
      }).length;
      const checks = await Inspection.find({ grnId: { $in: receipts.map((r) => r._id) }, status: 'SUBMITTED' }).session(session).lean();
      const lines = checks.flatMap((c) => c.lines ?? []);
      const accepted = sumInts(lines.map((l) => l.acceptedMilli ?? 0));
      const rejected = sumInts(lines.map((l) => l.rejectedMilli ?? 0));
      doc.receiptsChecked = receipts.length;
      doc.onTimeBps = mulDivRound(onTime, BPS_WHOLE, receipts.length);
      doc.acceptedBps = accepted + rejected > 0 ? mulDivRound(accepted, BPS_WHOLE, accepted + rejected) : BPS_WHOLE;
      doc.scoreBps = Math.round((doc.onTimeBps + doc.acceptedBps) / 2);
      let standing = 'POOR';
      if (doc.scoreBps >= 9000) standing = 'EXCELLENT';
      else if (doc.scoreBps >= 7500) standing = 'GOOD';
      else if (doc.scoreBps >= 5000) standing = 'AVERAGE';
      doc.standing = standing;
      await doc.save({ session });
      return doc;
    },
  }],
});

/* ---------- CRM ---------- */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

extend('EmailCampaign', {
  fields: 'sentCount~:int',
  actions: [{
    key: 'send',
    label: 'Send now',
    primary: true,
    when: { status: ['SCHEDULED', null] },
    fields: '',
    async run(session, doc) {
      const addresses = [...new Set(doc.recipients.split(/[\s,;]+/).filter(Boolean))];
      const bad = addresses.filter((a) => !EMAIL_PATTERN.test(a));
      if (bad.length) throw rule(`These are not email addresses: ${bad.slice(0, 5).join(', ')}`, 'BAD_EMAIL');
      if (addresses.length === 0) throw rule('There is nobody to send to.', 'NO_RECIPIENTS');
      for (const to of addresses) await queueEmail(session, { to, subject: doc.subject, body: doc.body });
      doc.status = 'SENT';
      doc.sentCount = addresses.length;
      await doc.save({ session });
      return doc;
    },
  }],
});

extend('Appointment', {
  async prepare(session, data, { existing }) {
    if (!data.ownerId || !data.atTime || data.status === 'CANCELLED') return data;
    const clash = await modelOf('Appointment').exists({ _id: { $ne: existing?._id ?? null }, ownerId: String(data.ownerId), onDate: data.onDate, atTime: data.atTime, status: { $ne: 'CANCELLED' } }).session(session);
    if (clash) throw rule('That person already has an appointment then.', 'APPOINTMENT_CLASH');
    return data;
  },
});

extend('Contract', {
  async prepare(session, data) {
    const out = { ...data };
    if (out.endDate && out.endDate < out.startDate) throw rule('The contract ends before it starts.', 'BAD_DATES');
    if (out.templateId) {
      const template = await modelOf('ContractTemplate').findById(out.templateId).session(session).lean();
      if (template && !out.terms) out.terms = template.terms;
      if (template?.requiresFulfilment && !out.fulfilment?.length) out.fulfilment = template.fulfilmentTerms.map((t) => ({ requirement: t.requirement }));
    }
    return out;
  },
  actions: [
    {
      key: 'sign',
      label: 'Signed',
      primary: true,
      when: { status: ['SUBMITTED'], signedOn: [null] },
      fields: 'signedBy!:text signedOn!:date',
      async run(session, doc, body) {
        doc.signedBy = body.signedBy;
        doc.signedOn = body.signedOn;
        await doc.save({ session });
        return doc;
      },
    },
    {
      key: 'fulfil',
      label: 'Requirements met',
      when: { status: ['SUBMITTED'], isFulfilled: [false] },
      fields: '',
      async run(session, doc) {
        for (const row of doc.fulfilment) row.isDone = true;
        doc.isFulfilled = true;
        await doc.save({ session });
        return doc;
      },
    },
  ],
});

/* ---------- Accounts ---------- */

extend('PaymentTermsTemplate', {
  prepare(_session, data) {
    const total = sumInts((data.terms ?? []).map((t) => t.portionBps));
    if (data.terms?.length && total !== BPS_WHOLE) throw rule(`The portions add up to ${total / 100}%, and must add up to 100%.`, 'BAD_TERMS');
    return data;
  },
});

extend('CostCenterAllocation', {
  prepare(_session, data) {
    const total = sumInts((data.shares ?? []).map((s) => s.percentBps));
    if (total !== BPS_WHOLE) throw rule(`The shares add up to ${total / 100}%, and must add up to 100%.`, 'BAD_SHARES');
    return data;
  },
});

extend('AccountingPeriod', {
  async prepare(session, data, { existing }) {
    if (data.endDate < data.startDate) throw rule('The period ends before it starts.', 'BAD_DATES');
    const clash = await modelOf('AccountingPeriod').exists({ _id: { $ne: existing?._id ?? null }, startDate: { $lte: data.endDate }, endDate: { $gte: data.startDate } }).session(session);
    if (clash) throw rule('These dates overlap another period.', 'PERIOD_OVERLAP');
    return data;
  },
});

extend('BankGuarantee', {
  prepare(_session, data) {
    if (data.endDate < data.startDate) throw rule('The guarantee ends before it starts.', 'BAD_DATES');
    return data;
  },
  actions: [
    {
      key: 'release',
      label: 'Released',
      primary: true,
      when: { status: ['ACTIVE', null] },
      fields: '',
      async run(session, doc) {
        doc.status = 'RELEASED';
        await doc.save({ session });
        return doc;
      },
    },
    {
      key: 'invoke',
      label: 'Invoked',
      when: { status: ['ACTIVE', null] },
      fields: '',
      async run(session, doc) {
        doc.status = 'INVOKED';
        await doc.save({ session });
        return doc;
      },
    },
  ],
});

// Shares cannot be sold by someone who does not hold them. A transfer is a permanent record.
extend('ShareTransfer', {
  lockedWhen: () => true,
  async prepare(session, data) {
    if (data.count <= 0) throw rule('Enter the number of shares.', 'AMOUNT_REQUIRED');
    if (['ISSUE'].includes(data.kind) && !data.toId) throw rule('Who are the shares issued to?', 'SHAREHOLDER_REQUIRED');
    if (['PURCHASE', 'TRANSFER'].includes(data.kind) && !data.fromId) throw rule('Who are the shares from?', 'SHAREHOLDER_REQUIRED');
    if (data.kind === 'TRANSFER' && !data.toId) throw rule('Who are the shares going to?', 'SHAREHOLDER_REQUIRED');
    if (data.fromId) {
      const moves = await modelOf('ShareTransfer').find({ shareTypeId: String(data.shareTypeId), onDate: { $lte: data.onDate }, $or: [{ fromId: String(data.fromId) }, { toId: String(data.fromId) }] }).session(session).lean();
      const held = sumInts(moves.map((m) => (String(m.toId) === String(data.fromId) ? m.count : -m.count)));
      if (data.count > held) throw rule(`They hold only ${held} of these shares.`, 'NOT_ENOUGH_SHARES');
    }
    return data;
  },
});

// Which cost centres or projects may be used on an account, and whether one must be.
define({
  name: 'AccountingDimensionFilter',
  module: 'accounts',
  labelFields: ['accountCode'],
  fields: 'accountCode!:link(Account) dimension:select(COST_CENTER,PROJECT)=COST_CENTER isMandatory:check',
  tables: { allowed: 'valueId! note' },
  list: 'accountCode dimension isMandatory',
  labels: { isMandatory: 'A value must be given' },
  hint: 'List the allowed cost centre or project ids. Leave the list empty to allow any.',
  deletable: true,
});

/* ---------- Assets ---------- */

const NEXT_MONTHS = { MONTHLY: 1, QUARTERLY: 3, HALF_YEARLY: 6, YEARLY: 12 };

extend('AssetMaintenanceLog', {
  async afterCreate(session, doc) {
    if (doc.result !== 'DONE') return;
    const plans = await modelOf('AssetMaintenance').find({ assetId: String(doc.assetId) }).session(session);
    for (const plan of plans) {
      if (!plan.tasks.some((t) => t.task === doc.task) && plan.tasks.length > 0) continue;
      const months = NEXT_MONTHS[plan.frequency];
      if (months) {
        plan.nextDueOn = addMonths(doc.onDate, months);
        await plan.save({ session });
      }
    }
  },
});

/* ---------- Support ---------- */

extend('WarrantyClaim', {
  fields: 'underWarranty~:check warrantyUntil~:date',
  async prepare(session, data) {
    if (!data.buildId) return { ...data, underWarranty: false, warrantyUntil: null };
    const build = await MachineBuild.findById(data.buildId, { warrantyUntil: 1, partyId: 1 }).session(session).lean();
    if (!build) throw rule('That build does not exist.', 'LINK_NOT_FOUND');
    if (build.partyId && String(build.partyId) !== String(data.partyId)) throw rule('That machine belongs to another customer.', 'WRONG_CUSTOMER');
    return { ...data, warrantyUntil: build.warrantyUntil, underWarranty: Boolean(build.warrantyUntil && data.onDate <= build.warrantyUntil) };
  },
  actions: [{
    key: 'close',
    label: 'Close',
    primary: true,
    when: { status: ['OPEN', 'WORK_IN_PROGRESS', null] },
    fields: 'resolution!:long',
    async run(session, doc, body) {
      doc.resolution = body.resolution;
      doc.status = 'CLOSED';
      await doc.save({ session });
      return doc;
    },
  }],
});

extend('ServiceLevelAgreement', {
  prepare(_session, data) {
    const seen = new Set();
    for (const row of data.priorities ?? []) {
      const key = String(row.priorityId);
      if (seen.has(key)) throw rule('A priority can only be listed once.', 'DUPLICATE_PRIORITY');
      seen.add(key);
      if (row.resolutionHours < row.responseHours) throw rule('Resolving cannot take less time than responding.', 'BAD_SLA');
    }
    return data;
  },
});

/* ---------- Quality ---------- */

// Readings decide the result. A person cannot pass an inspection that has a failed reading.
const readingResult = (readings) => {
  if (!readings?.length) return 'PENDING';
  if (readings.some((r) => r.result === 'FAIL')) return 'FAIL';
  return readings.every((r) => r.result === 'PASS') ? 'PASS' : 'PENDING';
};

extend('InProcessInspection', {
  fields: 'ncrId~:link(Ncr)',
  async prepare(session, data) {
    const out = { ...data };
    if (out.templateId && !out.readings?.length) {
      const template = await modelOf('InspectionTemplate').findById(out.templateId).session(session).lean();
      const rows = template?.parameters ?? template?.rows ?? [];
      out.readings = rows.map((row) => ({ parameter: row.parameter, acceptance: row.acceptance ?? '' }));
    }
    out.status = readingResult(out.readings);
    return out;
  },
  actions: [{
    key: 'raiseNcr',
    label: 'Raise an NCR',
    primary: true,
    when: { status: ['FAIL'], ncrId: [null] },
    fields: '',
    navigateTo: 'ncrs',
    async run(session, doc, _body, { actor }) {
      const failed = doc.readings.filter((r) => r.result === 'FAIL').map((r) => `${r.parameter}: ${r.observed}`).join('; ');
      const item = doc.itemId ? await Item.findById(doc.itemId, { name: 1 }).session(session).lean() : null;
      const ncr = await raiseNcr(session, { postingDate: doc.onDate, source: 'IN_PROCESS', buildId: doc.buildId ?? null, itemId: doc.itemId ?? null, itemName: item?.name ?? '', description: `In-process inspection ${doc.docNo} failed. ${failed}` }, actor);
      doc.ncrId = String(ncr._id);
      await doc.save({ session });
      return ncr;
    },
  }],
});

extend('QualityReview', {
  prepare(_session, data) {
    if (!data.objectives?.length) return data;
    const all = data.objectives.map((o) => o.status);
    if (all.includes('FAILED')) return { ...data, status: 'FAILED' };
    return { ...data, status: all.every((s) => s === 'PASSED') ? 'PASSED' : 'OPEN' };
  },
});

extend('QualityFeedback', {
  fields: 'averageRatingMilli~:qty',
  prepare(_session, data) {
    const rows = (data.ratings ?? []).filter((r) => r.rating > 0);
    if (rows.some((r) => r.rating > 5)) throw rule('Ratings go from 1 to 5.', 'BAD_RATING');
    return { ...data, averageRatingMilli: rows.length ? mulDivRound(sumInts(rows.map((r) => r.rating)), 1000, rows.length) : 0 };
  },
});

/* ---------- Work done for customers on their goods ---------- */

// Their material is not our stock, so these move no value. The charge goes out on an invoice.
extend('SubcontractingInwardOrder', {
  fields: 'state~:select(OPEN,RECEIVED,DELIVERED)=OPEN',
  actions: [
    {
      key: 'receive',
      label: 'Their goods came in',
      primary: true,
      when: { state: ['OPEN', 'RECEIVED'] },
      fields: 'qtyMilli!:qty',
      async run(session, doc, body) {
        if (body.qtyMilli <= 0 || doc.receivedMilli + body.qtyMilli > doc.qtyMilli) throw rule(`Only ${(doc.qtyMilli - doc.receivedMilli) / 1000} is expected.`, 'OVER_RECEIVED');
        doc.receivedMilli += body.qtyMilli;
        doc.state = 'RECEIVED';
        await doc.save({ session });
        return doc;
      },
    },
    {
      key: 'deliver',
      label: 'Sent back to them',
      primary: true,
      when: { state: ['RECEIVED'] },
      fields: 'qtyMilli!:qty',
      async run(session, doc, body) {
        if (body.qtyMilli <= 0 || doc.deliveredMilli + body.qtyMilli > doc.receivedMilli) throw rule(`Only ${(doc.receivedMilli - doc.deliveredMilli) / 1000} of theirs is here.`, 'OVER_DELIVERED');
        doc.deliveredMilli += body.qtyMilli;
        if (doc.deliveredMilli >= doc.qtyMilli) doc.state = 'DELIVERED';
        await doc.save({ session });
        return doc;
      },
    },
  ],
});

