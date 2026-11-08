// Payroll for India. Every statutory number is a record you can change, not code.
// A CA must check the rates and the rules before a real month is run.
import { define, modelOf } from '../engine/registry.js';
import { createDoc, submitDoc } from '../engine/documents.js';
import { A } from '../config/accounts.js';
import { postGl } from '../services/ledgerService.js';
import { applyBps, mulDivRound, sumInts } from '../utils/money.js';
import { addDays, todayIst } from '../utils/dates.js';
import { rule } from '../utils/errors.js';

const m = (name, fields, extra = {}) => define({ name, module: 'payroll', fields, ...extra });

m('SalaryComponent', 'name!* abbreviation! kind:select(EARNING,DEDUCTION)=EARNING isTaxable:check=true dependsOnAttendance:check=true accountCode:link(Account)', { list: 'name abbreviation kind isTaxable' });
m('PayrollPeriod', 'name!* startDate!:date endDate!:date', { list: 'name startDate endDate' });

// Components are an amount, or a share of basic. There is no formula language, so nothing
// typed in here can ever run as code.
m('SalaryStructure', 'name!* basicBps:pct=5000 isActive:check=true', {
  tables: { rows: 'componentId!:link(SalaryComponent) basis:select(FIXED,PERCENT_OF_BASIC,PERCENT_OF_CTC)=FIXED amountPaise:money rateBps:pct' },
  list: 'name basicBps isActive',
});
m('SalaryStructureAssignment', 'employeeId!:link(Employee) structureId!:link(SalaryStructure) monthlyCtcPaise!:money fromDate!:date', {
  series: 'SSA', submittable: true, labelFields: ['docNo'], dateField: 'fromDate', list: 'docNo employeeId structureId monthlyCtcPaise fromDate',
});
m('IncomeTaxSlab', 'name!* effectiveFrom!:date standardDeductionPaise:money cessBps:pct=400 rebateUptoPaise:money isActive:check=true', {
  tables: { slabs: 'fromPaise:money toPaise:money rateBps!:pct' },
  list: 'name effectiveFrom standardDeductionPaise isActive',
});

// PF, ESI and professional tax. One active row applies.
m('PayrollStatutory', 'name!* pfEmployeeBps:pct=1200 pfEmployerBps:pct=1200 pfWageCeilingPaise:money=1500000 esiEmployeeBps:pct=75 esiEmployerBps:pct=325 esiWageCeilingPaise:money=2100000 isActive:check=true', {
  tables: { professionalTax: 'fromGrossPaise:money toGrossPaise:money amountPaise:money' },
  list: 'name pfEmployeeBps esiEmployeeBps isActive',
});
m('AdditionalSalary', 'employeeId!:link(Employee) componentId!:link(SalaryComponent) amountPaise!:money forMonth!:date reason appliedSlipId~:link(SalarySlip)', {
  series: 'ADS', submittable: true, labelFields: ['docNo'], dateField: 'forMonth', list: 'docNo employeeId componentId amountPaise forMonth',
});
m('EmployeeIncentive', 'employeeId!:link(Employee) amountPaise!:money forMonth!:date reason', { series: 'EI', submittable: true, labelFields: ['docNo'], list: 'docNo employeeId amountPaise forMonth' });
m('RetentionBonus', 'employeeId!:link(Employee) bonusPaise!:money payOn!:date', { series: 'RB', submittable: true, labelFields: ['docNo'], list: 'docNo employeeId bonusPaise payOn' });
m('EmployeeTaxExemptionDeclaration', 'employeeId!:link(Employee) periodId!:link(PayrollPeriod) totalPaise~:money', {
  series: 'ETX', submittable: true, labelFields: ['docNo'], list: 'docNo employeeId periodId totalPaise',
  tables: { rows: 'section! description amountPaise!:money' },
  prepare: (_s, data) => ({ ...data, totalPaise: sumInts((data.rows ?? []).map((r) => r.amountPaise)) }),
});
m('EmployeeBenefitClaim', 'employeeId!:link(Employee) description! amountPaise!:money onDate!:date', { series: 'EBC', submittable: true, labelFields: ['docNo'], dateField: 'onDate', list: 'docNo employeeId description amountPaise' });

// Yearly tax on income, in whole paise, slab by slab.
export function annualTax(annualIncomePaise, slabDoc) {
  const taxable = Math.max(0, annualIncomePaise - (slabDoc.standardDeductionPaise ?? 0));
  if (slabDoc.rebateUptoPaise > 0 && taxable <= slabDoc.rebateUptoPaise) return 0;
  let tax = 0;
  for (const slab of slabDoc.slabs) {
    const top = slab.toPaise > 0 ? slab.toPaise : Infinity;
    if (taxable <= slab.fromPaise) continue;
    tax += applyBps(Math.min(taxable, top) - slab.fromPaise, slab.rateBps);
  }
  return tax + applyBps(tax, slabDoc.cessBps ?? 0);
}

async function workedDays(session, employeeId, startDate, endDate) {
  let total = 0;
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) total += 1;
  const rows = await modelOf('Attendance').find({ employeeId: String(employeeId), onDate: { $gte: startDate, $lte: endDate } }).session(session).lean();
  const leaveTypes = await modelOf('LeaveType').find({ isWithoutPay: true }, { _id: 1 }).session(session).lean();
  const unpaidIds = leaveTypes.map((t) => String(t._id));
  // Half days, so a half day absent stays a whole number.
  let unpaidHalfDays = 0;
  for (const row of rows) {
    if (row.state === 'ABSENT') unpaidHalfDays += 2;
    else if (row.leaveApplicationId) {
      const leave = await modelOf('LeaveApplication').findById(row.leaveApplicationId).session(session).lean();
      if (leave && unpaidIds.includes(String(leave.leaveTypeId))) unpaidHalfDays += row.state === 'HALF_DAY' ? 1 : 2;
    } else if (row.state === 'HALF_DAY') unpaidHalfDays += 1;
  }
  return { totalDays: total, unpaidHalfDays };
}

export async function computeSlip(session, { employeeId, startDate, endDate }) {
  const assignment = await modelOf('SalaryStructureAssignment').findOne({ employeeId: String(employeeId), status: 'SUBMITTED', fromDate: { $lte: endDate } }).sort({ fromDate: -1 }).session(session).lean();
  if (!assignment) throw rule('This person has no salary structure.', 'NO_SALARY_STRUCTURE');
  const structure = await modelOf('SalaryStructure').findById(assignment.structureId).session(session).lean();
  const statutory = await modelOf('PayrollStatutory').findOne({ isActive: true }).session(session).lean();
  if (!statutory) throw rule('Enter PF, ESI and professional tax in Payroll statutory first.', 'NO_STATUTORY');

  const { totalDays, unpaidHalfDays } = await workedDays(session, employeeId, startDate, endDate);
  const paidHalfDays = totalDays * 2 - unpaidHalfDays;
  const prorate = (amount) => mulDivRound(amount, paidHalfDays, totalDays * 2);

  const ctc = assignment.monthlyCtcPaise;
  const basicFull = applyBps(ctc, structure.basicBps);
  const earnings = [{ name: 'Basic', amountPaise: prorate(basicFull), isTaxable: true }];
  const deductions = [];
  const components = await modelOf('SalaryComponent').find({ _id: { $in: structure.rows.map((r) => r.componentId) } }).session(session).lean();
  let allocated = basicFull;
  for (const row of structure.rows) {
    const component = components.find((c) => String(c._id) === String(row.componentId));
    let amount = row.amountPaise;
    if (row.basis === 'PERCENT_OF_BASIC') amount = applyBps(basicFull, row.rateBps);
    if (row.basis === 'PERCENT_OF_CTC') amount = applyBps(ctc, row.rateBps);
    if (component.kind === 'EARNING') {
      allocated += amount;
      earnings.push({ name: component.name, amountPaise: component.dependsOnAttendance ? prorate(amount) : amount, isTaxable: component.isTaxable });
    } else {
      deductions.push({ name: component.name, amountPaise: amount });
    }
  }
  // Whatever the structure leaves unspent of the CTC is the special allowance.
  if (allocated < ctc) earnings.push({ name: 'Special allowance', amountPaise: prorate(ctc - allocated), isTaxable: true });

  const extras = await modelOf('AdditionalSalary').find({ employeeId: String(employeeId), status: 'SUBMITTED', forMonth: { $gte: startDate, $lte: endDate }, appliedSlipId: null }).session(session).lean();
  for (const extra of extras) {
    const component = await modelOf('SalaryComponent').findById(extra.componentId).session(session).lean();
    (component.kind === 'EARNING' ? earnings : deductions).push({ name: component.name, amountPaise: extra.amountPaise, isTaxable: component.isTaxable });
  }

  const gross = sumInts(earnings.map((e) => e.amountPaise));
  const basicPaid = earnings[0].amountPaise;
  const pfWage = Math.min(basicPaid, statutory.pfWageCeilingPaise);
  const pfEmployee = applyBps(pfWage, statutory.pfEmployeeBps);
  const pfEmployer = applyBps(pfWage, statutory.pfEmployerBps);
  const esiApplies = gross <= statutory.esiWageCeilingPaise;
  const esiEmployee = esiApplies ? applyBps(gross, statutory.esiEmployeeBps) : 0;
  const esiEmployer = esiApplies ? applyBps(gross, statutory.esiEmployerBps) : 0;
  const ptRow = (statutory.professionalTax ?? []).find((row) => gross >= row.fromGrossPaise && (row.toGrossPaise === 0 || gross <= row.toGrossPaise));
  const professionalTax = ptRow?.amountPaise ?? 0;

  const slab = await modelOf('IncomeTaxSlab').findOne({ isActive: true, effectiveFrom: { $lte: endDate } }).sort({ effectiveFrom: -1 }).session(session).lean();
  const taxableMonthly = sumInts(earnings.filter((e) => e.isTaxable !== false).map((e) => e.amountPaise));
  const tds = slab ? mulDivRound(annualTax(taxableMonthly * 12, slab), 1, 12) : 0;

  if (pfEmployee) deductions.push({ name: 'Provident fund', amountPaise: pfEmployee });
  if (esiEmployee) deductions.push({ name: 'ESI', amountPaise: esiEmployee });
  if (professionalTax) deductions.push({ name: 'Professional tax', amountPaise: professionalTax });
  if (tds) deductions.push({ name: 'Income tax', amountPaise: tds });

  const otherDeductions = sumInts(deductions.map((d) => d.amountPaise)) - pfEmployee - esiEmployee - professionalTax - tds;
  const totalDeductions = sumInts(deductions.map((d) => d.amountPaise));
  return {
    totalDays,
    paidHalfDays,
    earnings: earnings.map(({ name, amountPaise }) => ({ name, amountPaise })),
    deductions,
    grossPaise: gross,
    totalDeductionPaise: totalDeductions,
    netPaise: gross - totalDeductions,
    pfEmployeePaise: pfEmployee,
    pfEmployerPaise: pfEmployer,
    esiEmployeePaise: esiEmployee,
    esiEmployerPaise: esiEmployer,
    professionalTaxPaise: professionalTax,
    tdsPaise: tds,
    otherDeductionPaise: otherDeductions,
    additionalIds: extras.map((e) => e._id),
  };
}

define({
  name: 'SalarySlip',
  module: 'payroll',
  series: 'SAL',
  submittable: true,
  labelFields: ['docNo'],
  fields: 'employeeId!:link(Employee) startDate!:date endDate!:date payrollEntryId:link(PayrollEntry) totalDays~:int paidHalfDays~:int grossPaise~:money totalDeductionPaise~:money netPaise~:money pfEmployeePaise~:money pfEmployerPaise~:money esiEmployeePaise~:money esiEmployerPaise~:money professionalTaxPaise~:money tdsPaise~:money otherDeductionPaise~:money isPaid~:check',
  tables: { 'earnings~': 'name amountPaise:money', 'deductions~': 'name amountPaise:money' },
  list: 'docNo employeeId startDate grossPaise totalDeductionPaise netPaise isPaid',
  dateField: 'startDate',
  async prepare(session, data) {
    const { additionalIds: _ids, ...computed } = await computeSlip(session, data);
    return { ...data, ...computed };
  },
  async onSubmit(session, doc) {
    const clash = await modelOf('SalarySlip').countDocuments({ _id: { $ne: doc._id }, employeeId: String(doc.employeeId), startDate: doc.startDate, status: 'SUBMITTED' }).session(session);
    if (clash > 0) throw rule('This person already has a slip for this period.', 'SLIP_EXISTS');
    const fresh = await computeSlip(session, doc);
    if (fresh.netPaise !== doc.netPaise) throw rule('The figures have changed since this draft was made. Save it again first.', 'SLIP_STALE');
    for (const id of fresh.additionalIds) await modelOf('AdditionalSalary').updateOne({ _id: id }, { appliedSlipId: String(doc._id) }, { session });
    const employerCost = doc.pfEmployerPaise + doc.esiEmployerPaise;
    await postGl(session, {
      postingDate: doc.postingDate,
      voucherType: 'SalarySlip',
      voucherId: doc._id,
      voucherNo: doc.docNo,
      narration: `Salary ${doc.startDate}`,
      lines: [
        { accountCode: A.SALARIES, debitPaise: doc.grossPaise },
        { accountCode: A.EMPLOYER_CONTRIBUTIONS, debitPaise: employerCost },
        { accountCode: A.SALARY_PAYABLE, creditPaise: doc.netPaise + doc.otherDeductionPaise },
        { accountCode: A.PF_PAYABLE, creditPaise: doc.pfEmployeePaise + doc.pfEmployerPaise },
        { accountCode: A.ESI_PAYABLE, creditPaise: doc.esiEmployeePaise + doc.esiEmployerPaise },
        { accountCode: A.PT_PAYABLE, creditPaise: doc.professionalTaxPaise },
        { accountCode: A.TDS_PAYABLE, creditPaise: doc.tdsPaise },
      ],
    });
    return { action: 'SALARY_SLIP_POSTED', data: { netPaise: doc.netPaise } };
  },
  async onCancel(session, doc) {
    if (doc.isPaid) throw rule('This slip has been paid.', 'SLIP_PAID');
    await modelOf('AdditionalSalary').updateMany({ appliedSlipId: String(doc._id) }, { appliedSlipId: null }, { session });
  },
});

// The month's run: makes a slip for each person, submits them, and pays them in one go.
define({
  name: 'PayrollEntry',
  module: 'payroll',
  series: 'PY2',
  labelFields: ['docNo'],
  fields: 'startDate!:date endDate!:date departmentId:link(Department) state~:select(DRAFT,SLIPS_MADE,POSTED,PAID)=DRAFT slipCount~:int grossPaise~:money netPaise~:money',
  list: 'docNo startDate endDate departmentId state slipCount netPaise',
  dateField: 'startDate',
  actions: [
    {
      key: 'makeSlips',
      label: 'Make salary slips',
      primary: true,
      when: { state: ['DRAFT'] },
      fields: '',
      async run(session, doc, _body, { actor }) {
        const filter = { state: 'ACTIVE', joiningDate: { $lte: doc.endDate } };
        if (doc.departmentId) filter.departmentId = String(doc.departmentId);
        const employees = await modelOf('Employee').find(filter).session(session).lean();
        if (employees.length === 0) throw rule('No active employees match.', 'NO_EMPLOYEES');
        let gross = 0;
        let net = 0;
        for (const employee of employees) {
          const slip = await createDoc(session, 'SalarySlip', { employeeId: String(employee._id), startDate: doc.startDate, endDate: doc.endDate, payrollEntryId: String(doc._id), postingDate: doc.endDate > todayIst() ? todayIst() : doc.endDate }, actor);
          gross += slip.grossPaise;
          net += slip.netPaise;
        }
        doc.slipCount = employees.length;
        doc.grossPaise = gross;
        doc.netPaise = net;
        doc.state = 'SLIPS_MADE';
        await doc.save({ session });
        return doc;
      },
    },
    {
      key: 'postSlips',
      label: 'Submit all slips',
      primary: true,
      when: { state: ['SLIPS_MADE'] },
      fields: '',
      async run(session, doc, _body, { actor }) {
        const slips = await modelOf('SalarySlip').find({ payrollEntryId: String(doc._id), status: 'DRAFT' }, { _id: 1 }).session(session).lean();
        for (const slip of slips) await submitDoc(session, 'SalarySlip', slip._id, actor);
        doc.state = 'POSTED';
        await doc.save({ session });
        return doc;
      },
    },
    {
      key: 'pay',
      label: 'Pay salaries',
      primary: true,
      when: { state: ['POSTED'] },
      fields: 'bankAccountCode!:link(Account;isCashOrBank=true)',
      async run(session, doc, body) {
        const { isSalaryHeld } = await import('./logic.js');
        const allSlips = await modelOf('SalarySlip').find({ payrollEntryId: String(doc._id), status: 'SUBMITTED', isPaid: false }).session(session);
        const slips = [];
        for (const slip of allSlips) {
          if (!(await isSalaryHeld(session, slip.employeeId, slip.startDate, slip.endDate))) slips.push(slip);
        }
        const total = sumInts(slips.map((s) => s.netPaise));
        await postGl(session, {
          postingDate: todayIst(), voucherType: 'PayrollEntry', voucherId: doc._id, voucherNo: doc.docNo, narration: 'Salaries paid',
          lines: [{ accountCode: A.SALARY_PAYABLE, debitPaise: total }, { accountCode: body.bankAccountCode, creditPaise: total }],
        });
        for (const slip of slips) {
          slip.isPaid = true;
          await slip.save({ session });
        }
        // Anyone held back stays unpaid, and this entry can be paid again once they are released.
        doc.state = slips.length === allSlips.length ? 'PAID' : 'POSTED';
        await doc.save({ session });
        return doc;
      },
    },
  ],
});

m('Gratuity', 'employeeId!:link(Employee) yearsMilli!:qty lastBasicPaise!:money amountPaise~:money bankAccountCode!:link(Account;isCashOrBank=true)', {
  series: 'GR2',
  submittable: true,
  labelFields: ['docNo'],
  list: 'docNo employeeId yearsMilli amountPaise',
  // 15 days' pay for each year, on a 26-day month. Five years' service is the usual minimum.
  prepare(_s, data) {
    if (data.yearsMilli < 5000) throw rule('Gratuity needs at least five years of service.', 'UNDER_FIVE_YEARS');
    const years = Math.round(data.yearsMilli / 1000);
    return { ...data, amountPaise: mulDivRound(data.lastBasicPaise * 15, years, 26) };
  },
  async onSubmit(session, doc) {
    await postGl(session, {
      postingDate: doc.postingDate, voucherType: 'Gratuity', voucherId: doc._id, voucherNo: doc.docNo, narration: 'Gratuity',
      lines: [{ accountCode: A.SALARIES, debitPaise: doc.amountPaise }, { accountCode: doc.bankAccountCode, creditPaise: doc.amountPaise }],
    });
    return { action: 'GRATUITY_PAID' };
  },
});
