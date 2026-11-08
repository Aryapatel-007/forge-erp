// The rest of the map: smaller records, and a few pieces of real logic that did not fit
// elsewhere. Asset capitalisation, invoice discounting, overtime, leave policy, statements.
import { define, modelOf } from '../engine/registry.js';
import { createDoc, submitDoc } from '../engine/documents.js';
import { A } from '../config/accounts.js';
import { Bin } from '../models/ledgers.js';
import { Party } from '../models/masters.js';
import { SalesInvoice } from '../models/documents.js';
import { postGl } from '../services/ledgerService.js';
import { queueEmail } from '../services/notifyService.js';
import { pickBuckets, stockOut } from '../services/stockService.js';
import { rule } from '../utils/errors.js';
import { mulDivRound } from '../utils/money.js';
import { todayIst } from '../utils/dates.js';

const simple = (module, list, extra = {}) => {
  for (const [name, fields, more] of list) define({ name, module, fields, ...extra, ...more });
};

/* ---------- Accounts ---------- */

simple('accounts', [
  ['AccountingPeriod', 'name!* startDate!:date endDate!:date isClosed:check', { list: 'name startDate endDate isClosed', dateField: 'startDate' }],
  ['AccountingDimension', 'name!* linkedDoctype isMandatory:check', { list: 'name linkedDoctype isMandatory' }],
  ['AccountCategory', 'name!* description'],
  ['BankAccountType', 'name!*'],
  ['BankAccountSubtype', 'name!*'],
  ['BankTransactionRule', 'name!* descriptionContains! accountCode:link(Account) partyId:link(Party) isActive:check=true', { list: 'name descriptionContains accountCode partyId' }],
  ['PartyLink', 'customerId!:link(Party;isCustomer=true) supplierId!:link(Party;isSupplier=true)', { labelFields: ['customerId'], list: 'customerId supplierId' }],
  ['PaymentGatewayAccount', 'name!* gateway accountCode:link(Account;isCashOrBank=true) currency=INR isDefault:check'],
  ['TaxWithholdingGroup', 'name!* description'],
  ['FinancialReportTemplate', 'name!* reportType:select(PROFIT_AND_LOSS,BALANCE_SHEET,CASH_FLOW)=PROFIT_AND_LOSS', { tables: { rows: 'heading! accountCode:link(Account) order:int' }, list: 'name reportType' }],
  ['LowerDeductionCertificate', 'partyId!:link(Party;isSupplier=true) categoryId!:link(TaxWithholdingCategory) certificateNo!* rateBps!:pct validFrom!:date validUpto!:date limitPaise:money', { list: 'certificateNo partyId rateBps validFrom validUpto', labelFields: ['certificateNo'], dateField: 'validUpto' }],
]);

// What the till held at the end of a shift, for a cashier without the full POS.
define({
  name: 'CashierClosing',
  module: 'accounts',
  series: 'CC',
  labelFields: ['docNo'],
  fields: 'cashierId!:link(User) onDate!:date openingPaise:money receivedPaise:money paidOutPaise:money countedPaise!:money differencePaise~:smoney notes',
  list: 'docNo cashierId onDate countedPaise differencePaise',
  dateField: 'onDate',
  prepare: (_s, data) => ({ ...data, differencePaise: (data.countedPaise ?? 0) - ((data.openingPaise ?? 0) + (data.receivedPaise ?? 0) - (data.paidOutPaise ?? 0)) }),
});

// Selling a receivable to a bank. The money comes early, and the charges are the cost.
define({
  name: 'InvoiceDiscounting',
  module: 'accounts',
  series: 'ID',
  submittable: true,
  labelFields: ['docNo'],
  fields: 'bankAccountCode!:link(Account;isCashOrBank=true) loanAccountCode!:link(Account) chargesAccountCode!:link(Account) chargesPaise:money totalPaise~:money receivedPaise~:money',
  tables: { invoices: 'salesInvoiceId!:link(SalesInvoice) outstandingPaise~:money' },
  list: 'docNo bankAccountCode totalPaise chargesPaise receivedPaise',
  async onSubmit(session, doc) {
    let total = 0;
    for (const row of doc.invoices) {
      const invoice = await SalesInvoice.findById(row.salesInvoiceId).session(session).lean();
      if (!invoice || invoice.status !== 'SUBMITTED') throw rule('That invoice is not live.', 'INVOICE_NOT_SUBMITTED');
      row.outstandingPaise = invoice.totalPaise - invoice.paidPaise - invoice.creditedPaise;
      total += row.outstandingPaise;
    }
    if (total === 0) throw rule('Nothing is outstanding on those invoices.', 'NOTHING_OUTSTANDING');
    if (doc.chargesPaise > total) throw rule('The charges are more than the invoices.', 'BAD_CHARGES');
    doc.totalPaise = total;
    doc.receivedPaise = total - doc.chargesPaise;
    await postGl(session, {
      postingDate: doc.postingDate, voucherType: 'InvoiceDiscounting', voucherId: doc._id, voucherNo: doc.docNo, narration: 'Invoice discounting',
      lines: [
        { accountCode: doc.bankAccountCode, debitPaise: doc.receivedPaise },
        { accountCode: doc.chargesAccountCode, debitPaise: doc.chargesPaise },
        { accountCode: doc.loanAccountCode, creditPaise: total },
      ],
    });
    return { action: 'INVOICES_DISCOUNTED', data: { totalPaise: total } };
  },
});

// Sends each party a statement of what they owe. It goes on the email queue.
define({
  name: 'ProcessStatementOfAccounts',
  module: 'accounts',
  labelFields: ['name'],
  fields: 'name!* subject=Statement_of_account onlyOverdue:check sentOn~:date sentCount~:int',
  tables: { parties: 'partyId!:link(Party;isCustomer=true)' },
  list: 'name onlyOverdue sentOn sentCount',
  actions: [{
    key: 'send',
    label: 'Send statements',
    primary: true,
    when: {},
    fields: '',
    async run(session, doc) {
      const today = todayIst();
      let sent = 0;
      for (const row of doc.parties) {
        const party = await Party.findById(row.partyId).session(session).lean();
        if (!party.email) continue;
        const filter = { partyId: party._id, status: 'SUBMITTED', ...(doc.onlyOverdue ? { dueDate: { $lt: today } } : {}) };
        const invoices = (await SalesInvoice.find(filter).session(session).lean()).filter((i) => i.totalPaise - i.paidPaise - i.creditedPaise > 0);
        if (invoices.length === 0) continue;
        const body = invoices.map((i) => `${i.docNo}, due ${i.dueDate}: Rs ${((i.totalPaise - i.paidPaise - i.creditedPaise) / 100).toFixed(2)}`).join('\n');
        await queueEmail(session, { to: party.email, subject: doc.subject.replace(/_/g, ' '), body });
        sent += 1;
      }
      doc.sentOn = today;
      doc.sentCount = sent;
      await doc.save({ session });
      return doc;
    },
  }],
});

/* ---------- Assets ---------- */

simple('assets', [
  ['AssetShiftFactor', 'name!* factorBps!:pct isDefault:check', { list: 'name factorBps isDefault' }],
  ['AssetShiftAllocation', 'assetId!:link(Asset) shiftFactorId!:link(AssetShiftFactor) fromDate!:date toDate:date', { labelFields: ['assetId'], list: 'assetId shiftFactorId fromDate toDate', dateField: 'fromDate' }],
]);

// Stock used to build or improve an asset leaves stores and joins the asset's cost.
define({
  name: 'AssetCapitalization',
  module: 'assets',
  series: 'AC',
  submittable: true,
  labelFields: ['docNo'],
  fields: 'assetId!:link(Asset) reason totalPaise~:money',
  tables: { lines: 'itemId!:link(Item) qtyMilli!:qty valuePaise~:money' },
  list: 'docNo assetId reason totalPaise',
  async onSubmit(session, doc) {
    const asset = await modelOf('Asset').findById(doc.assetId).session(session);
    if (asset.state !== 'IN_USE') throw rule('This asset has left the books.', 'ASSET_GONE');
    const voucher = { voucherType: 'AssetCapitalization', voucherId: doc._id, voucherNo: doc.docNo, postingDate: doc.postingDate };
    let total = 0;
    for (const line of doc.lines) {
      const picks = await pickBuckets(session, { itemId: line.itemId, qtyMilli: line.qtyMilli });
      let value = 0;
      for (const pick of picks) value += (await stockOut(session, { voucher, ...pick })).valuePaise;
      line.valuePaise = value;
      total += value;
    }
    doc.totalPaise = total;
    asset.adjustedPaise += total;
    await asset.save({ session });
    await postGl(session, { postingDate: doc.postingDate, voucherType: 'AssetCapitalization', voucherId: doc._id, voucherNo: doc.docNo, narration: `Added to ${asset.docNo}`, lines: [{ accountCode: A.FIXED_ASSETS, debitPaise: total }, { accountCode: A.INVENTORY, creditPaise: total }] });
    return { action: 'ASSET_CAPITALISED_FROM_STOCK', data: { totalPaise: total } };
  },
  async onCancel(session, doc) {
    const asset = await modelOf('Asset').findById(doc.assetId).session(session);
    if (asset.state !== 'IN_USE') throw rule('This asset has left the books.', 'ASSET_GONE');
    asset.adjustedPaise -= doc.totalPaise;
    await asset.save({ session });
  },
});

/* ---------- Buying and selling records ---------- */

simple('buying', [
  ['SupplierScorecardCriteria', 'name!* maxScoreBps:pct=10000 weightBps:pct formulaNote', { list: 'name maxScoreBps weightBps' }],
  ['SupplierScorecardStanding', 'name!* minScoreBps!:pct maxScoreBps!:pct preventPurchaseOrders:check warnRfqs:check', { list: 'name minScoreBps maxScoreBps preventPurchaseOrders' }],
  ['SupplierScorecardVariable', 'name!* description path'],
  ['SupplierScorecardPeriod', 'partyId!:link(Party;isSupplier=true) fromDate!:date toDate!:date scoreBps:pct', { labelFields: ['partyId', 'toDate'], list: 'partyId fromDate toDate scoreBps', dateField: 'toDate' }],
]);
simple('selling', [
  ['PartySpecificItem', 'partyId!:link(Party) itemId:link(Item) itemGroupId:link(ItemGroup)', { labelFields: ['partyId'], list: 'partyId itemId itemGroupId' }],
  ['DeliverySchedule', 'salesOrderId!:link(SalesOrder) itemId!:link(Item) onDate!:date qtyMilli!:qty', { labelFields: ['salesOrderId', 'onDate'], list: 'salesOrderId itemId onDate qtyMilli', dateField: 'onDate' }],
]);
simple('setup', [
  ['QuotationLostReason', 'name!* description'],
  ['CommunicationMedium', 'name!* kind:select(EMAIL,PHONE,WHATSAPP,SMS,OTHER)=PHONE'],
  ['CodeList', 'name!* description', { tables: { codes: 'code! title' } }],
  ['CommonCode', 'code!* title! listId:link(CodeList)', { list: 'code title listId' }],
  ['Video', 'title!* url! description:long', { readers: 'all' }],
], { readers: 'all' });

/* ---------- Stock and manufacturing records ---------- */

simple('stock', [
  ['UomCategory', 'name!*', { readers: 'all' }],
  ['WarehouseType', 'name!*', { readers: 'all' }],
  ['ItemLeadTime', 'itemId!:link(Item) partyId:link(Party;isSupplier=true) leadDays!:int', { labelFields: ['itemId'], list: 'itemId partyId leadDays' }],
  ['ItemManufacturer', 'itemId!:link(Item) manufacturerId!:link(Manufacturer) partNo isDefault:check', { labelFields: ['itemId'], list: 'itemId manufacturerId partNo isDefault' }],
  ['ItemStandardCost', 'itemId!:link(Item) costPaise!:money validFrom!:date', { labelFields: ['itemId'], list: 'itemId costPaise validFrom', dateField: 'validFrom' }],
  ['InspectionParameterGroup', 'name!*'],
  ['InspectionParameter', 'name!* groupId:link(InspectionParameterGroup) description', { list: 'name groupId' }],
  ['ShipmentParcelTemplate', 'name!* lengthMilli:qty widthMilli:qty heightMilli:qty weightMilli:qty', { list: 'name lengthMilli widthMilli heightMilli weightMilli' }],
  ['InventoryDimension', 'name!* targetField description', { list: 'name targetField' }],
]);

// A dated snapshot of what stock was worth, to compare with the books at a month end.
define({
  name: 'StockClosingEntry',
  module: 'stock',
  series: 'CL',
  labelFields: ['docNo'],
  fields: 'closedOn!:date valuePaise~:money buckets~:int notes',
  list: 'docNo closedOn valuePaise buckets',
  dateField: 'closedOn',
  async prepare(session, data) {
    const [row] = await Bin.aggregate([{ $match: { qtyMilli: { $gt: 0 } } }, { $group: { _id: null, value: { $sum: '$valuePaise' }, buckets: { $sum: 1 } } }]).session(session);
    return { ...data, valuePaise: row?.value ?? 0, buckets: row?.buckets ?? 0 };
  },
});

simple('manufacturing', [
  ['WorkstationOperatingComponent', 'workstationId!:link(Workstation) name! hourCostPaise!:money', { labelFields: ['name'], list: 'workstationId name hourCostPaise' }],
]);
simple('subcontracting', [
  ['SubcontractingBom', 'finishedItemId!:link(Item) serviceItemId!:link(Item) bomId:link(Bom) conversionMilli:qty=1000 isActive:check=true', { labelFields: ['finishedItemId'], list: 'finishedItemId serviceItemId bomId isActive' }],
  ['SubcontractingInwardOrder', 'partyId!:link(Party;isCustomer=true) itemId!:link(Item) qtyMilli!:qty ratePaise!:money receivedMilli~:qty deliveredMilli~:qty', { series: 'SIO', labelFields: ['docNo'], list: 'docNo partyId itemId qtyMilli ratePaise' }],
]);

/* ---------- Telephony ---------- */

simple('support', [
  ['CallLog', 'fromNumber! toNumber direction:select(INCOMING,OUTGOING)=INCOMING state:select(RINGING,IN_PROGRESS,COMPLETED,MISSED)=COMPLETED atTime:datetime durationSeconds:int partyId:link(Party) leadId:link(Lead) summary:long', { labelFields: ['fromNumber'], list: 'fromNumber toNumber direction state partyId', searchFields: ['fromNumber', 'toNumber'] }],
  ['TelephonyCallType', 'name!*'],
]);

/* ---------- People ---------- */

simple('hr', [
  ['GrievanceType', 'name!*'],
  ['OfferTerm', 'name!*'],
  ['PurposeOfTravel', 'name!*'],
  ['Interest', 'name!*'],
  ['ShiftLocation', 'name!* latitudeMilli:sqty longitudeMilli:sqty radiusMetres:int=100', { list: 'name radiusMetres' }],
  ['ShiftSchedule', 'name!* shiftTypeId!:link(ShiftType) repeatDays:int=7', { list: 'name shiftTypeId repeatDays' }],
  ['ShiftScheduleAssignment', 'employeeId!:link(Employee) scheduleId!:link(ShiftSchedule) fromDate!:date isActive:check=true', { labelFields: ['employeeId'], list: 'employeeId scheduleId fromDate isActive', dateField: 'fromDate' }],
  ['HolidayListAssignment', 'employeeId!:link(Employee) holidayListId!:link(HolidayList) fromDate!:date', { labelFields: ['employeeId'], list: 'employeeId holidayListId fromDate', dateField: 'fromDate' }],
  ['EmployeeHealthInsurance', 'employeeId!:link(Employee) provider! policyNo coverPaise:money validUpto:date', { labelFields: ['employeeId'], list: 'employeeId provider policyNo validUpto', dateField: 'validUpto' }],
  ['EmployeeFeedbackCriteria', 'name!* description'],
  ['EmployeeSkillMap', 'employeeId!:link(Employee)', { tables: { skills: 'skillId!:link(Skill) ratingBps:pct' }, labelFields: ['employeeId'], list: 'employeeId' }],
  ['AppointmentLetterTemplate', 'name!* intro:long closing:long', { tables: { terms: 'title! description:long' } }],
  ['JobOfferTermTemplate', 'name!*', { tables: { terms: 'termId!:link(OfferTerm) value' } }],
  ['JobOpeningTemplate', 'name!* designationId:link(Designation) description:long'],
  ['EmployeeOnboardingTemplate', 'name!* departmentId:link(Department)', { tables: { activities: 'activity! role' } }],
  ['EmployeeSeparationTemplate', 'name!* departmentId:link(Department)', { tables: { activities: 'activity! role' } }],
  ['OvertimeType', 'name!* multiplierBps:pct=20000 componentId:link(SalaryComponent)', { list: 'name multiplierBps componentId' }],
]);

// A correction to a leave balance, with a reason. It counts as an allocation.
define({
  name: 'LeaveAdjustment',
  module: 'hr',
  series: 'LAJ',
  submittable: true,
  labelFields: ['docNo'],
  fields: 'employeeId!:link(Employee) leaveTypeId!:link(LeaveType) periodId!:link(LeavePeriod) halfDays!:int reason! allocationId~:link(LeaveAllocation)',
  list: 'docNo employeeId leaveTypeId halfDays reason',
  async onSubmit(session, doc, { actor }) {
    const allocation = await createDoc(session, 'LeaveAllocation', { employeeId: doc.employeeId, leaveTypeId: doc.leaveTypeId, periodId: doc.periodId, halfDays: doc.halfDays, notes: `Adjustment ${doc.docNo}: ${doc.reason}` }, actor);
    await submitDoc(session, 'LeaveAllocation', allocation._id, actor);
    doc.allocationId = String(allocation._id);
  },
  async onCancel(_session) {
    throw rule('Adjust again the other way, with a reason.', 'ADJUST_THE_OTHER_WAY');
  },
});

// Gives a person everything their policy allows for the period, in one step.
define({
  name: 'LeavePolicyAssignment',
  module: 'hr',
  series: 'LPA',
  labelFields: ['docNo'],
  fields: 'employeeId!:link(Employee) policyId!:link(LeavePolicy) periodId!:link(LeavePeriod) isAllocated~:check',
  list: 'docNo employeeId policyId periodId isAllocated',
  actions: [{
    key: 'allocate',
    label: 'Allocate leave',
    primary: true,
    when: { isAllocated: [false] },
    fields: '',
    async run(session, doc, _body, { actor }) {
      const policy = await modelOf('LeavePolicy').findById(doc.policyId).session(session).lean();
      if (!policy.rows.length) throw rule('That policy allows no leave.', 'EMPTY_POLICY');
      for (const row of policy.rows) {
        const allocation = await createDoc(session, 'LeaveAllocation', { employeeId: doc.employeeId, leaveTypeId: row.leaveTypeId, periodId: doc.periodId, halfDays: row.halfDays, notes: `From ${doc.docNo}` }, actor);
        await submitDoc(session, 'LeaveAllocation', allocation._id, actor);
      }
      doc.isAllocated = true;
      await doc.save({ session });
      return doc;
    },
  }],
});

// Hours over the shift, paid at a multiple of the hourly rate. Submitting puts the amount on
// the next salary slip. The hourly rate is the monthly gross over 26 days of 8 hours.
define({
  name: 'OvertimeSlip',
  module: 'hr',
  series: 'OT',
  submittable: true,
  labelFields: ['docNo'],
  fields: 'employeeId!:link(Employee) typeId!:link(OvertimeType) forMonth!:date hoursMilli!:qty monthlyGrossPaise!:money amountPaise~:money additionalSalaryId~:link(AdditionalSalary)',
  list: 'docNo employeeId forMonth hoursMilli amountPaise',
  dateField: 'forMonth',
  async onSubmit(session, doc, { actor }) {
    const type = await modelOf('OvertimeType').findById(doc.typeId).session(session).lean();
    if (!type.componentId) throw rule('That overtime type has no salary component.', 'NO_COMPONENT');
    const hourly = mulDivRound(doc.monthlyGrossPaise, 1, 208);
    doc.amountPaise = mulDivRound(mulDivRound(hourly, type.multiplierBps, 10000), doc.hoursMilli, 1000);
    const extra = await createDoc(session, 'AdditionalSalary', { employeeId: doc.employeeId, componentId: type.componentId, amountPaise: doc.amountPaise, forMonth: doc.forMonth, reason: `Overtime ${doc.docNo}` }, actor);
    await submitDoc(session, 'AdditionalSalary', extra._id, actor);
    doc.additionalSalaryId = String(extra._id);
    return { action: 'OVERTIME_APPROVED', data: { amountPaise: doc.amountPaise } };
  },
});

/* ---------- Payroll records ---------- */

simple('payroll', [
  ['EmployeeTaxExemptionCategory', 'name!* maxPaise:money isActive:check=true', { list: 'name maxPaise isActive' }],
  ['EmployeeTaxExemptionSubCategory', 'name!* categoryId!:link(EmployeeTaxExemptionCategory) maxPaise:money', { list: 'name categoryId maxPaise' }],
  ['EmployeeOtherIncome', 'employeeId!:link(Employee) periodId!:link(PayrollPeriod) source! amountPaise!:money', { labelFields: ['employeeId'], list: 'employeeId periodId source amountPaise' }],
  ['EmployeeBenefitApplication', 'employeeId!:link(Employee) periodId!:link(PayrollPeriod) componentId!:link(SalaryComponent) amountPaise!:money', { series: 'EBA', submittable: true, labelFields: ['docNo'], list: 'docNo employeeId componentId amountPaise' }],
  ['EmployeeBenefitLedger', 'employeeId!:link(Employee) componentId!:link(SalaryComponent) onDate!:date amountPaise!:smoney reference', { labelFields: ['employeeId'], list: 'employeeId componentId onDate amountPaise', dateField: 'onDate' }],
  ['GratuityRule', 'name!* yearsToQualifyMilli:qty=5000 daysPerYear:int=15 daysInMonth:int=26 isActive:check=true', { list: 'name yearsToQualifyMilli daysPerYear daysInMonth' }],
  ['Arrear', 'employeeId!:link(Employee) fromDate!:date toDate!:date componentId!:link(SalaryComponent) amountPaise!:money reason', { series: 'ARR', submittable: true, labelFields: ['docNo'], list: 'docNo employeeId fromDate toDate amountPaise' }],
  ['PayrollCorrection', 'employeeId!:link(Employee) salarySlipId!:link(SalarySlip) componentId!:link(SalaryComponent) differencePaise!:smoney reason!', { series: 'PCR', submittable: true, labelFields: ['docNo'], list: 'docNo employeeId salarySlipId differencePaise reason' }],
  ['SalaryWithholding', 'employeeId!:link(Employee) fromDate!:date toDate!:date reason! isReleased:check', { series: 'SWH', submittable: true, labelFields: ['docNo'], list: 'docNo employeeId fromDate toDate reason isReleased' }],
]);

