// People: employees, attendance, shifts, leave, recruitment, expenses, appraisal, training.
import { define, modelOf } from '../engine/registry.js';
import { A } from '../config/accounts.js';
import { postGl } from '../services/ledgerService.js';
import { sumInts } from '../utils/money.js';
import { addDays, daysBetween, todayIst } from '../utils/dates.js';
import { conflict, rule } from '../utils/errors.js';

const m = (name, fields, extra = {}) => define({ name, module: 'hr', fields, ...extra });

m('EmploymentType', 'name!*');
m('EmployeeGrade', 'name!* defaultSalaryStructureId:link(SalaryStructure)');
m('EmployeeGroup', 'name!*', { tables: { members: 'employeeId!:link(Employee)' } });
m('Skill', 'name!* description');
m('IdentificationDocumentType', 'name!*');

define({
  name: 'Employee',
  module: 'hr',
  series: 'EMP',
  writers: ['ADMIN', 'MANAGEMENT', 'HR'],
  readers: ['HR', 'ACCOUNTS', 'PRODUCTION', 'ADMIN', 'MANAGEMENT'],
  labelFields: ['docNo', 'fullName'],
  searchFields: ['docNo', 'fullName', 'email', 'mobile'],
  fields: 'fullName! userId:link(User) departmentId:link(Department) designationId:link(Designation) gradeId:link(EmployeeGrade) employmentTypeId:link(EmploymentType) branchId:link(Branch) reportsToId:link(Employee) gender:select(MALE,FEMALE,OTHER) birthDate:date joiningDate!:date confirmationDate:date relievingDate:date state:select(ACTIVE,INACTIVE,LEFT,SUSPENDED)=ACTIVE email:email mobile:phone address:long pan aadhaarLast4 uan esiNo pfNo bankName bankAccountNo ifsc holidayListId:link(HolidayList) shiftTypeId:link(ShiftType) costCenterId:link(CostCenter) emergencyContact notes:long',
  tables: { skills: 'skillId:link(Skill) ratingBps:pct', education: 'qualification! institute yearPassed:int', history: 'company designation fromDate:date toDate:date' },
  list: 'docNo fullName departmentId designationId joiningDate state',
  dateField: 'joiningDate',
});

/* ---------- Shifts and attendance ---------- */

m('ShiftType', 'name!* startTime!:time endTime!:time graceMinutes:int=10 halfDayBelowHoursMilli:qty=4000 absentBelowHoursMilli:qty=2000', { list: 'name startTime endTime graceMinutes' });
m('ShiftAssignment', 'employeeId!:link(Employee) shiftTypeId!:link(ShiftType) startDate!:date endDate:date isActive:check=true', { labelFields: ['employeeId'], dateField: 'startDate', list: 'employeeId shiftTypeId startDate endDate' });
m('ShiftRequest', 'employeeId!:link(Employee) shiftTypeId!:link(ShiftType) fromDate!:date toDate!:date approverId:link(User) reason', { series: 'SHR', submittable: true, labelFields: ['docNo'], list: 'docNo employeeId shiftTypeId fromDate toDate' });

m('EmployeeCheckin', 'employeeId!:link(Employee) atTime!:datetime logType:select(IN,OUT)=IN deviceId', { labelFields: ['employeeId'], list: 'employeeId atTime logType deviceId', index: [{ employeeId: 1, atTime: 1 }], readers: ['HR', 'PRODUCTION'] });

define({
  name: 'Attendance',
  module: 'hr',
  labelFields: ['employeeId', 'onDate'],
  fields: 'employeeId!:link(Employee) onDate!:date state:select(PRESENT,ABSENT,HALF_DAY,ON_LEAVE,WORK_FROM_HOME)=PRESENT shiftTypeId:link(ShiftType) workingHoursMilli:qty lateEntry:check earlyExit:check leaveApplicationId~:link(LeaveApplication) source~:select(MANUAL,CHECKIN,LEAVE)=MANUAL',
  list: 'employeeId onDate state workingHoursMilli lateEntry source',
  dateField: 'onDate',
  index: [{ keys: { employeeId: 1, onDate: 1 }, options: { unique: true } }],
  async prepare(session, data, { isNew }) {
    if (isNew) {
      const clash = await modelOf('Attendance').countDocuments({ employeeId: data.employeeId, onDate: data.onDate }).session(session);
      if (clash > 0) throw conflict('Attendance for this person on this date is already marked.', 'ATTENDANCE_EXISTS');
    }
    if (data.onDate > todayIst()) throw rule('Attendance cannot be marked for the future.', 'FUTURE_DATE');
    return data;
  },
});

m('AttendanceRequest', 'employeeId!:link(Employee) fromDate!:date toDate!:date reason:select(ON_DUTY,WORK_FROM_HOME,FORGOT_PUNCH)=ON_DUTY explanation', {
  series: 'ATR',
  submittable: true,
  labelFields: ['docNo'],
  list: 'docNo employeeId fromDate toDate reason',
  async onSubmit(session, doc) {
    const Attendance = modelOf('Attendance');
    for (let date = doc.fromDate; date <= doc.toDate; date = addDays(date, 1)) {
      if (date > todayIst()) break;
      await Attendance.updateOne(
        { employeeId: String(doc.employeeId), onDate: date },
        { $set: { state: doc.reason === 'WORK_FROM_HOME' ? 'WORK_FROM_HOME' : 'PRESENT', source: 'MANUAL' } },
        { upsert: true, session },
      );
    }
  },
});

/* ---------- Leave ---------- */

m('LeaveType', 'name!* maxConsecutiveDays:int isWithoutPay:check isCarryForward:check isCompensatory:check annualAllocationHalfDays:int', { labels: { annualAllocationHalfDays: 'Yearly allocation, half days' }, readers: 'all' });
m('LeavePeriod', 'name!* fromDate!:date toDate!:date isActive:check=true', { list: 'name fromDate toDate isActive' });
m('LeavePolicy', 'name!*', { tables: { rows: 'leaveTypeId!:link(LeaveType) halfDays!:int' } });
m('LeaveBlockList', 'name!* appliesToDepartmentId:link(Department)', { tables: { dates: 'onDate!:date reason' } });

// Leave balances are counted in half days, so they stay whole numbers.
m('LeaveAllocation', 'employeeId!:link(Employee) leaveTypeId!:link(LeaveType) periodId!:link(LeavePeriod) halfDays!:int notes', {
  series: 'LAL',
  submittable: true,
  labelFields: ['docNo'],
  list: 'docNo employeeId leaveTypeId periodId halfDays',
});

export async function leaveBalance(session, employeeId, leaveTypeId, fromDate, toDate, exceptId = null) {
  const period = await modelOf('LeavePeriod').findOne({ fromDate: { $lte: fromDate }, toDate: { $gte: toDate } }).session(session).lean();
  if (!period) throw rule('No leave period covers those dates.', 'NO_LEAVE_PERIOD');
  const allocations = await modelOf('LeaveAllocation').find({ employeeId: String(employeeId), leaveTypeId: String(leaveTypeId), periodId: String(period._id), status: 'SUBMITTED' }).session(session).lean();
  const taken = await modelOf('LeaveApplication').find({ employeeId: String(employeeId), leaveTypeId: String(leaveTypeId), status: 'SUBMITTED', fromDate: { $gte: period.fromDate }, toDate: { $lte: period.toDate }, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }).session(session).lean();
  return sumInts(allocations.map((a) => a.halfDays)) - sumInts(taken.map((t) => t.halfDays));
}

async function holidaysFor(session, employeeId) {
  const employee = await modelOf('Employee').findById(employeeId).session(session).lean();
  if (!employee?.holidayListId) return { dates: new Set(), weeklyOff: null };
  const list = await modelOf('HolidayList').findById(employee.holidayListId).session(session).lean();
  return { dates: new Set((list?.holidays ?? []).map((h) => h.onDate)), weeklyOff: list?.weeklyOff };
}

const WEEKDAY = { SUNDAY: 0, FRIDAY: 5, SATURDAY: 6 };

define({
  name: 'LeaveApplication',
  module: 'hr',
  series: 'LV',
  submittable: true,
  writers: ['ADMIN', 'MANAGEMENT', 'HR'],
  labelFields: ['docNo'],
  fields: 'employeeId!:link(Employee) leaveTypeId!:link(LeaveType) fromDate!:date toDate!:date isHalfDay:check halfDays~:int reason:long approverId:link(User)',
  list: 'docNo employeeId leaveTypeId fromDate toDate halfDays',
  dateField: 'fromDate',
  submitLabel: 'Approve',
  hint: 'Checks the balance, and marks attendance as on leave.',
  async prepare(session, data) {
    if (data.toDate < data.fromDate) throw rule('The leave must end after it starts.', 'BAD_DATE');
    const { dates, weeklyOff } = await holidaysFor(session, data.employeeId);
    let days = 0;
    for (let date = data.fromDate; date <= data.toDate; date = addDays(date, 1)) {
      const isOff = weeklyOff && weeklyOff !== 'NONE' && new Date(`${date}T00:00:00Z`).getUTCDay() === WEEKDAY[weeklyOff];
      if (!dates.has(date) && !isOff) days += 1;
    }
    if (days === 0) throw rule('Those dates are all holidays.', 'ALL_HOLIDAYS');
    return { ...data, halfDays: data.isHalfDay ? 1 : days * 2 };
  },
  async onSubmit(session, doc, { actor }) {
    const type = await modelOf('LeaveType').findById(doc.leaveTypeId).session(session).lean();
    const overlap = await modelOf('LeaveApplication').countDocuments({ _id: { $ne: doc._id }, employeeId: String(doc.employeeId), status: 'SUBMITTED', fromDate: { $lte: doc.toDate }, toDate: { $gte: doc.fromDate } }).session(session);
    if (overlap > 0) throw conflict('This person already has leave on those dates.', 'LEAVE_OVERLAP');
    if (type.maxConsecutiveDays > 0 && daysBetween(doc.fromDate, doc.toDate) + 1 > type.maxConsecutiveDays) throw rule(`${type.name} can be at most ${type.maxConsecutiveDays} days in a row.`, 'TOO_MANY_DAYS');
    if (!type.isWithoutPay) {
      const balance = await leaveBalance(session, doc.employeeId, doc.leaveTypeId, doc.fromDate, doc.toDate, doc._id);
      if (doc.halfDays > balance) throw rule(`Not enough leave: ${doc.halfDays / 2} days asked, ${balance / 2} left.`, 'INSUFFICIENT_LEAVE', { balance });
    }
    const Attendance = modelOf('Attendance');
    const { dates, weeklyOff } = await holidaysFor(session, doc.employeeId);
    for (let date = doc.fromDate; date <= doc.toDate; date = addDays(date, 1)) {
      const isOff = weeklyOff && weeklyOff !== 'NONE' && new Date(`${date}T00:00:00Z`).getUTCDay() === WEEKDAY[weeklyOff];
      if (dates.has(date) || isOff) continue;
      await Attendance.updateOne(
        { employeeId: String(doc.employeeId), onDate: date },
        { $set: { state: doc.isHalfDay ? 'HALF_DAY' : 'ON_LEAVE', leaveApplicationId: String(doc._id), source: 'LEAVE', createdByName: actor?.name ?? '' } },
        { upsert: true, session },
      );
    }
    return { action: 'LEAVE_APPROVED', data: { halfDays: doc.halfDays } };
  },
  async onCancel(session, doc) {
    await modelOf('Attendance').deleteMany({ leaveApplicationId: String(doc._id) }, { session });
  },
});

m('CompensatoryLeaveRequest', 'employeeId!:link(Employee) leaveTypeId!:link(LeaveType) workedOn!:date reason', { series: 'CLR', submittable: true, labelFields: ['docNo'], list: 'docNo employeeId workedOn' });
m('LeaveEncashment', 'employeeId!:link(Employee) leaveTypeId!:link(LeaveType) halfDays!:int amountPaise!:money', { series: 'LEN', submittable: true, labelFields: ['docNo'], list: 'docNo employeeId halfDays amountPaise' });

/* ---------- Recruitment ---------- */

m('JobRequisition', 'designationId!:link(Designation) departmentId:link(Department) openings:int=1 requestedBy:link(User) reason:long state:select(PENDING,OPEN,FILLED,CANCELLED)=PENDING', { series: 'JRQ', labelFields: ['docNo'], list: 'docNo designationId departmentId openings state' });
m('JobOpening', 'title! designationId:link(Designation) departmentId:link(Department) description:long vacancies:int=1 state:select(OPEN,CLOSED)=OPEN', { list: 'title departmentId vacancies state' });
m('JobApplicantSource', 'name!*');
m('JobApplicant', 'applicantName! email:email phone:phone jobOpeningId:link(JobOpening) sourceId:link(JobApplicantSource) state:select(OPEN,REPLIED,HOLD,ACCEPTED,REJECTED)=OPEN resumeLink coverNote:long', { list: 'applicantName jobOpeningId email phone state', searchFields: ['applicantName', 'email', 'phone'], deletable: true });
m('InterviewType', 'name!* description');
m('Interview', 'applicantId!:link(JobApplicant) typeId:link(InterviewType) onDate!:date fromTime:time toTime:time state:select(PENDING,CLEARED,REJECTED)=PENDING', { tables: { interviewers: 'userId!:link(User)' }, labelFields: ['applicantId', 'onDate'], dateField: 'onDate', list: 'applicantId typeId onDate state' });
m('InterviewFeedback', 'interviewId!:link(Interview) interviewerId!:link(User) ratingBps:pct result:select(CLEARED,REJECTED)=CLEARED feedback:long', { labelFields: ['interviewId'], list: 'interviewId interviewerId ratingBps result' });
m('JobOffer', 'applicantId!:link(JobApplicant) designationId!:link(Designation) offerDate!:date monthlyCtcPaise:money state:select(AWAITING,ACCEPTED,REJECTED)=AWAITING terms:long', { series: 'JO', submittable: true, labelFields: ['docNo'], list: 'docNo applicantId designationId offerDate monthlyCtcPaise state' });
m('AppointmentLetter', 'applicantId!:link(JobApplicant) appointmentDate!:date body:long', { labelFields: ['applicantId'], dateField: 'appointmentDate', list: 'applicantId appointmentDate' });
m('StaffingPlan', 'name!* departmentId:link(Department) fromDate!:date toDate!:date', { tables: { rows: 'designationId!:link(Designation) vacancies:int estimatedCostPaise:money' }, list: 'name departmentId fromDate toDate' });
m('EmployeeReferral', 'referrerId!:link(Employee) candidateName! email:email jobOpeningId:link(JobOpening) state:select(PENDING,HIRED,REJECTED)=PENDING', { labelFields: ['candidateName'], list: 'candidateName referrerId jobOpeningId state' });

/* ---------- Lifecycle ---------- */

m('EmployeeOnboarding', 'employeeId:link(Employee) applicantId:link(JobApplicant) startDate!:date state:select(PENDING,IN_PROGRESS,COMPLETED)=PENDING', { tables: { activities: 'activity! assignedTo:link(User) isDone:check' }, labelFields: ['employeeId', 'startDate'], dateField: 'startDate', list: 'employeeId startDate state' });
m('EmployeeSeparation', 'employeeId!:link(Employee) resignedOn:date relievingOn!:date reason state:select(PENDING,IN_PROGRESS,COMPLETED)=PENDING', { tables: { activities: 'activity! assignedTo:link(User) isDone:check' }, labelFields: ['employeeId'], dateField: 'relievingOn', list: 'employeeId relievingOn state',
  async afterUpdate(session, doc) {
    if (doc.state !== 'COMPLETED') return;
    const employee = await modelOf('Employee').findById(doc.employeeId).session(session);
    employee.state = 'LEFT';
    employee.relievingDate = doc.relievingOn;
    await employee.save({ session });
  },
});
m('ExitInterview', 'employeeId!:link(Employee) onDate!:date reason:select(BETTER_OFFER,RELOCATION,HEALTH,MANAGEMENT,OTHER)=OTHER wouldRecommend:check feedback:long', { labelFields: ['employeeId'], dateField: 'onDate', list: 'employeeId onDate reason' });
m('EmployeeTransfer', 'employeeId!:link(Employee) onDate!:date toDepartmentId:link(Department) toBranchId:link(Branch) toReportsToId:link(Employee)', {
  series: 'ETR', submittable: true, labelFields: ['docNo'], list: 'docNo employeeId onDate toDepartmentId toBranchId',
  async onSubmit(session, doc) {
    const employee = await modelOf('Employee').findById(doc.employeeId).session(session);
    if (doc.toDepartmentId) employee.departmentId = doc.toDepartmentId;
    if (doc.toBranchId) employee.branchId = doc.toBranchId;
    if (doc.toReportsToId) employee.reportsToId = doc.toReportsToId;
    await employee.save({ session });
  },
});
m('EmployeePromotion', 'employeeId!:link(Employee) onDate!:date toDesignationId!:link(Designation) toGradeId:link(EmployeeGrade)', {
  series: 'EPR', submittable: true, labelFields: ['docNo'], list: 'docNo employeeId onDate toDesignationId',
  async onSubmit(session, doc) {
    const employee = await modelOf('Employee').findById(doc.employeeId).session(session);
    employee.designationId = doc.toDesignationId;
    if (doc.toGradeId) employee.gradeId = doc.toGradeId;
    await employee.save({ session });
  },
});
m('EmployeeGrievance', 'raisedById!:link(Employee) against subject! description:long onDate!:date state:select(OPEN,INVESTIGATING,RESOLVED,INVALID)=OPEN resolution:long', { labelFields: ['subject'], dateField: 'onDate', list: 'subject raisedById onDate state' });

/* ---------- Performance and training ---------- */

m('AppraisalCycle', 'name!* fromDate!:date toDate!:date state:select(NOT_STARTED,IN_PROGRESS,COMPLETED)=NOT_STARTED', { list: 'name fromDate toDate state' });
m('Kra', 'name!* description');
m('AppraisalTemplate', 'name!*', { tables: { rows: 'kraId!:link(Kra) weightBps!:pct' } });
m('Appraisal', 'employeeId!:link(Employee) cycleId!:link(AppraisalCycle) templateId:link(AppraisalTemplate) reviewerId:link(User) scoreBps~:pct remarks:long', {
  series: 'APR', submittable: true, labelFields: ['docNo'],
  tables: { rows: 'kraId!:link(Kra) weightBps!:pct scoreBps:pct goalNotes' },
  list: 'docNo employeeId cycleId scoreBps',
  prepare(_s, data) {
    const rows = data.rows ?? [];
    const weight = sumInts(rows.map((r) => r.weightBps));
    if (rows.length && weight !== 10000) throw rule(`The weights add up to ${weight / 100}%, and they must add up to 100%.`, 'BAD_WEIGHTS');
    return { ...data, scoreBps: Math.round(rows.reduce((sum, r) => sum + r.weightBps * (r.scoreBps ?? 0), 0) / 10000) };
  },
});
m('Goal', 'title! employeeId!:link(Employee) cycleId:link(AppraisalCycle) kraId:link(Kra) progressBps:pct dueOn:date state:select(PENDING,IN_PROGRESS,COMPLETED,ARCHIVED)=PENDING', { dateField: 'dueOn', list: 'title employeeId dueOn progressBps state' });
m('EmployeeFeedback', 'employeeId!:link(Employee) reviewerId!:link(User) onDate!:date feedback!:long ratingBps:pct', { labelFields: ['employeeId', 'onDate'], dateField: 'onDate', list: 'employeeId reviewerId onDate ratingBps' });
m('TrainingProgram', 'name!* trainer description:long');
m('TrainingEvent', 'name!* programId:link(TrainingProgram) startOn!:date endOn:date location state:select(SCHEDULED,COMPLETED,CANCELLED)=SCHEDULED', { tables: { attendees: 'employeeId!:link(Employee) attended:check' }, dateField: 'startOn', list: 'name programId startOn state' });
m('TrainingResult', 'eventId!:link(TrainingEvent)', { tables: { rows: 'employeeId!:link(Employee) marksBps:pct grade comments' }, labelFields: ['eventId'], list: 'eventId' });
m('TrainingFeedback', 'eventId!:link(TrainingEvent) employeeId!:link(Employee) ratingBps:pct feedback:long', { labelFields: ['eventId'], list: 'eventId employeeId ratingBps' });

/* ---------- Money to and from people ---------- */

m('ExpenseClaimType', 'name!* accountCode!:link(Account)', { list: 'name accountCode' });
m('TravelRequest', 'employeeId!:link(Employee) purpose! fromDate!:date toDate!:date destination estimatedCostPaise:money', { series: 'TV', submittable: true, labelFields: ['docNo'], list: 'docNo employeeId purpose fromDate toDate destination' });
m('VehicleLog', 'vehicleId!:link(Vehicle) onDate!:date driverId:link(Driver) odometerFrom:int odometerTo:int fuelPaise:money serviceNote', { labelFields: ['vehicleId', 'onDate'], dateField: 'onDate', list: 'vehicleId onDate driverId odometerTo fuelPaise' });

// Money advanced to an employee is an asset until it is spent or repaid.
define({
  name: 'EmployeeAdvance',
  module: 'hr',
  series: 'EA',
  submittable: true,
  writers: ['ADMIN', 'MANAGEMENT', 'HR', 'ACCOUNTS'],
  labelFields: ['docNo'],
  fields: 'employeeId!:link(Employee) amountPaise!:money bankAccountCode!:link(Account;isCashOrBank=true) purpose settledPaise~:money',
  list: 'docNo employeeId amountPaise settledPaise purpose',
  async onSubmit(session, doc) {
    await postGl(session, {
      postingDate: doc.postingDate, voucherType: 'EmployeeAdvance', voucherId: doc._id, voucherNo: doc.docNo, narration: doc.purpose,
      lines: [{ accountCode: A.EMPLOYEE_ADVANCES, debitPaise: doc.amountPaise }, { accountCode: doc.bankAccountCode, creditPaise: doc.amountPaise }],
    });
    return { action: 'ADVANCE_PAID' };
  },
  async onCancel(_session, doc) {
    if (doc.settledPaise > 0) throw rule('Part of this advance has been settled.', 'ADVANCE_SETTLED');
  },
});

// Approving books the expense and what we now owe the person, less any advance they hold.
define({
  name: 'ExpenseClaim',
  module: 'hr',
  series: 'EX',
  submittable: true,
  writers: ['ADMIN', 'MANAGEMENT', 'HR', 'ACCOUNTS'],
  labelFields: ['docNo'],
  fields: 'employeeId!:link(Employee) advanceId:link(EmployeeAdvance) advanceUsedPaise:money costCenterId:link(CostCenter) projectId:link(Project) totalPaise~:money payablePaise~:money paidPaise~:money',
  tables: { lines: 'typeId!:link(ExpenseClaimType) onDate!:date description amountPaise!:money' },
  list: 'docNo employeeId totalPaise advanceUsedPaise payablePaise paidPaise',
  submitLabel: 'Approve',
  prepare(_s, data) {
    const total = sumInts((data.lines ?? []).map((l) => l.amountPaise));
    const used = data.advanceUsedPaise ?? 0;
    if (used > total) throw rule('The advance used cannot exceed the claim.', 'ADVANCE_TOO_LARGE');
    return { ...data, totalPaise: total, payablePaise: total - used };
  },
  async onSubmit(session, doc) {
    const gl = [];
    const types = await modelOf('ExpenseClaimType').find({ _id: { $in: doc.lines.map((l) => l.typeId) } }).session(session).lean();
    for (const line of doc.lines) {
      const type = types.find((t) => String(t._id) === String(line.typeId));
      gl.push({ accountCode: type.accountCode, debitPaise: line.amountPaise, costCenterId: doc.costCenterId ?? null, projectId: doc.projectId ?? null });
    }
    if (doc.advanceUsedPaise > 0) {
      if (!doc.advanceId) throw rule('Choose the advance being used.', 'ADVANCE_REQUIRED');
      const advance = await modelOf('EmployeeAdvance').findById(doc.advanceId).session(session);
      if (advance.status !== 'SUBMITTED' || String(advance.employeeId) !== String(doc.employeeId)) throw rule('That advance is not available.', 'ADVANCE_NOT_AVAILABLE');
      if (advance.settledPaise + doc.advanceUsedPaise > advance.amountPaise) throw rule('That is more than is left on the advance.', 'ADVANCE_TOO_LARGE');
      advance.settledPaise += doc.advanceUsedPaise;
      await advance.save({ session });
      gl.push({ accountCode: A.EMPLOYEE_ADVANCES, creditPaise: doc.advanceUsedPaise });
    }
    gl.push({ accountCode: A.EMPLOYEE_PAYABLE, creditPaise: doc.payablePaise });
    await postGl(session, { postingDate: doc.postingDate, voucherType: 'ExpenseClaim', voucherId: doc._id, voucherNo: doc.docNo, narration: 'Expense claim', lines: gl });
    return { action: 'EXPENSE_APPROVED', data: { totalPaise: doc.totalPaise } };
  },
  async onCancel(session, doc) {
    if (doc.paidPaise > 0) throw rule('This claim has been paid.', 'CLAIM_PAID');
    if (doc.advanceUsedPaise > 0) {
      const advance = await modelOf('EmployeeAdvance').findById(doc.advanceId).session(session);
      advance.settledPaise -= doc.advanceUsedPaise;
      await advance.save({ session });
    }
  },
  actions: [{
    key: 'pay',
    label: 'Pay',
    primary: true,
    when: { status: ['SUBMITTED'] },
    fields: 'bankAccountCode!:link(Account;isCashOrBank=true)',
    async run(session, doc, body) {
      const left = doc.payablePaise - doc.paidPaise;
      if (left <= 0) throw rule('This claim has been paid.', 'CLAIM_PAID');
      await postGl(session, {
        postingDate: todayIst(), voucherType: 'ExpenseClaim', voucherId: doc._id, voucherNo: doc.docNo, narration: 'Expense claim paid',
        lines: [{ accountCode: A.EMPLOYEE_PAYABLE, debitPaise: left }, { accountCode: body.bankAccountCode, creditPaise: left }],
      });
      doc.paidPaise += left;
      await doc.save({ session });
      return doc;
    },
  }],
});
