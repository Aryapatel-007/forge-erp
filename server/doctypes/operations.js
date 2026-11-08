// Projects, quality, support, maintenance. Mostly records, with SLA and progress logic.
import { define, modelOf } from '../engine/registry.js';
import { Gauge } from '../models/documents.js';
import { mulDivRound } from '../utils/money.js';
import { rule } from '../utils/errors.js';
import { addDays, todayIst } from '../utils/dates.js';

/* ---------- Projects ---------- */

const p = (name, fields, extra = {}) => define({ name, module: 'projects', fields, ...extra });
p('ProjectType', 'name!*');
p('TaskType', 'name!* weightBps:pct');
p('ActivityType', 'name!* defaultCostPaise:money defaultBillingPaise:money');
p('ActivityCost', 'employeeId!:link(Employee) activityTypeId!:link(ActivityType) costPaise!:money billingPaise:money', { labelFields: ['employeeId'] });
p('ProjectTemplate', 'name!* projectTypeId:link(ProjectType)', { tables: { tasks: 'subject! offsetDays:int durationDays:int=1' } });

async function refreshProject(session, projectId) {
  if (!projectId) return;
  const project = await modelOf('Project').findById(projectId).session(session);
  if (!project) return;
  const tasks = await modelOf('Task').find({ projectId: String(projectId), status: { $ne: 'CANCELLED' } }).session(session).lean();
  project.progressBps = tasks.length ? mulDivRound(tasks.filter((t) => t.status === 'DONE').length, 10000, tasks.length) : 0;
  await project.save({ session });
}

p('Project', 'name!* projectTypeId:link(ProjectType) templateId:link(ProjectTemplate) partyId:link(Party) salesOrderId:link(SalesOrder) buildId:link(MachineBuild) managerId:link(User) startDate:date endDate:date status:select(OPEN,ON_HOLD,COMPLETED,CANCELLED)=OPEN priority:select(LOW,MEDIUM,HIGH)=MEDIUM budgetPaise:money progressBps~:pct costPaise~:money notes:long', {
  series: 'PJ',
  list: 'docNo name partyId managerId endDate progressBps status',
  searchFields: ['docNo', 'name'],
  dateField: 'startDate',
  async afterCreate(session, doc, { actor }) {
    if (!doc.templateId) return;
    const template = await modelOf('ProjectTemplate').findById(doc.templateId).session(session).lean();
    const start = doc.startDate ?? todayIst();
    const { createDoc } = await import('../engine/documents.js');
    for (const row of template?.tasks ?? []) {
      await createDoc(session, 'Task', { subject: row.subject, projectId: String(doc._id), startDate: addDays(start, row.offsetDays), dueDate: addDays(start, row.offsetDays + row.durationDays) }, actor);
    }
  },
});

p('Task', 'subject! projectId:link(Project) parentTaskId:link(Task) typeId:link(TaskType) assignedTo:link(User) status:select(OPEN,WORKING,PENDING_REVIEW,DONE,OVERDUE,CANCELLED)=OPEN priority:select(LOW,MEDIUM,HIGH,URGENT)=MEDIUM startDate:date dueDate:date expectedHoursMilli:qty actualHoursMilli~:qty description:long', {
  series: 'TK',
  tables: { dependsOn: 'taskId!:link(Task)' },
  list: 'docNo subject projectId assignedTo dueDate status',
  searchFields: ['docNo', 'subject'],
  dateField: 'dueDate',
  deletable: true,
  // A task cannot finish before the tasks it depends on.
  async prepare(session, data) {
    if (data.status === 'DONE' && data.dependsOn?.length) {
      const open = await modelOf('Task').countDocuments({ _id: { $in: data.dependsOn.map((d) => d.taskId) }, status: { $nin: ['DONE', 'CANCELLED'] } }).session(session);
      if (open > 0) throw rule(`${open} task(s) this depends on are not done yet.`, 'DEPENDENCY_OPEN');
    }
    return data;
  },
  afterCreate: (session, doc) => refreshProject(session, doc.projectId),
  afterUpdate: (session, doc) => refreshProject(session, doc.projectId),
});

async function applyTimesheet(session, doc, sign) {
  if (doc.projectId) {
    const project = await modelOf('Project').findById(doc.projectId).session(session);
    project.costPaise += sign * doc.totalCostPaise;
    await project.save({ session });
  }
  for (const row of doc.rows) {
    if (!row.taskId) continue;
    const task = await modelOf('Task').findById(row.taskId).session(session);
    if (task) {
      task.actualHoursMilli += sign * row.hoursMilli;
      await task.save({ session });
    }
  }
}

// Hours against a project. Submitting adds the cost to the project and to the task.
p('Timesheet', 'employeeId!:link(Employee) projectId:link(Project) totalHoursMilli~:qty totalCostPaise~:money', {
  series: 'TS',
  submittable: true,
  tables: { rows: 'taskId:link(Task) activityTypeId:link(ActivityType) onDate!:date hoursMilli!:qty costRatePaise:money isBillable:check' },
  list: 'docNo employeeId projectId totalHoursMilli totalCostPaise',
  prepare(_session, data) {
    const rows = data.rows ?? [];
    return {
      ...data,
      totalHoursMilli: rows.reduce((sum, r) => sum + r.hoursMilli, 0),
      totalCostPaise: rows.reduce((sum, r) => sum + mulDivRound(r.hoursMilli, r.costRatePaise ?? 0, 1000), 0),
    };
  },
  onSubmit: (session, doc) => applyTimesheet(session, doc, 1),
  onCancel: (session, doc) => applyTimesheet(session, doc, -1),
});
p('ProjectUpdate', 'projectId!:link(Project) onDate!:date summary!:long', { labelFields: ['projectId', 'onDate'], dateField: 'onDate', list: 'projectId onDate' });

/* ---------- Quality ---------- */

const q = (name, fields, extra = {}) => define({ name, module: 'quality', fields, ...extra });
q('QualityGoal', 'name!* frequency:select(NONE,DAILY,WEEKLY,MONTHLY,QUARTERLY)=MONTHLY procedureId:link(QualityProcedure)', { tables: { objectives: 'objective! target unit' } });
q('QualityProcedure', 'name!* parentId:link(QualityProcedure) ownerId:link(User) revision=1 body:long', { tables: { steps: 'step! responsible' }, tree: true });
q('QualityAction', 'kind:select(CORRECTIVE,PREVENTIVE)=CORRECTIVE source goalId:link(QualityGoal) procedureId:link(QualityProcedure) ncrId:link(Ncr) description!:long status:select(OPEN,DONE)=OPEN dueOn:date ownerId:link(User)', { series: 'QA', list: 'docNo kind source dueOn status', searchFields: ['docNo', 'source'], dateField: 'dueOn', labelFields: ['docNo'] });
q('QualityReview', 'goalId!:link(QualityGoal) onDate!:date status:select(OPEN,PASSED,FAILED)=OPEN notes:long', { series: 'QR', tables: { objectives: 'objective! target achieved status:select(PASSED,FAILED)' }, dateField: 'onDate', list: 'docNo goalId onDate status', labelFields: ['docNo'] });
q('QualityMeeting', 'title! onDate!:date minutes:long status:select(OPEN,CLOSED)=OPEN', { tables: { agenda: 'topic! decision' }, dateField: 'onDate', list: 'title onDate status' });
q('QualityFeedbackTemplate', 'name!*', { tables: { parameters: 'parameter!' } });
q('QualityFeedback', 'templateId!:link(QualityFeedbackTemplate) partyId:link(Party) buildId:link(MachineBuild) onDate:date', { tables: { ratings: 'parameter! rating:int feedback' }, labelFields: ['templateId', 'onDate'], dateField: 'onDate', list: 'templateId partyId buildId onDate' });
q('InspectionTemplate', 'name!* itemId:link(Item)', { tables: { parameters: 'parameter! acceptance minMilli:sqty maxMilli:sqty unit' }, list: 'name itemId' });
q('InProcessInspection', 'buildId:link(MachineBuild) workOrderId:link(WorkOrder) itemId:link(Item) templateId:link(InspectionTemplate) inspector onDate!:date status:select(PASS,FAIL,PENDING)=PENDING remarks:long', { series: 'IP', tables: { readings: 'parameter! acceptance observed result:select(PASS,FAIL)' }, dateField: 'onDate', list: 'docNo buildId itemId onDate status', labelFields: ['docNo'] });
q('CalibrationRecord', 'gaugeId!:link(Gauge) calibratedOn!:date dueOn!:date agency certificateNo! result:select(PASS,FAIL)=PASS', {
  list: 'gaugeId calibratedOn dueOn agency result',
  labelFields: ['certificateNo'],
  dateField: 'calibratedOn',
  // A passed calibration moves the gauge's due date, which the FAT check reads.
  async afterCreate(session, doc) {
    if (doc.result !== 'PASS') return;
    await Gauge.updateOne({ _id: doc.gaugeId }, { lastCalibratedOn: doc.calibratedOn, dueOn: doc.dueOn, certRef: doc.certificateNo }, { session });
  },
});

/* ---------- Support ---------- */

const s = (name, fields, extra = {}) => define({ name, module: 'support', fields, ...extra });
s('IssueType', 'name!*');
s('IssuePriority', 'name!* order:int');
s('ServiceLevelAgreement', 'name!* isDefault:check partyId:link(Party) isActive:check=true', { tables: { priorities: 'priorityId!:link(IssuePriority) responseHours!:int resolutionHours!:int' }, list: 'name partyId isDefault isActive' });

// Deadlines come from the SLA when the issue is raised, and a job flags any breach.
s('Issue', 'subject! partyId:link(Party) buildId:link(MachineBuild) typeId:link(IssueType) priorityId:link(IssuePriority) slaId:link(ServiceLevelAgreement) status:select(OPEN,REPLIED,ON_HOLD,RESOLVED,CLOSED)=OPEN assignedTo:link(User) description:long resolution:long respondBy~:datetime resolveBy~:datetime firstRespondedAt~:datetime resolvedAt~:datetime isSlaBreached~:check', {
  series: 'IS',
  list: 'docNo subject partyId priorityId status resolveBy isSlaBreached',
  searchFields: ['docNo', 'subject'],
  async prepare(session, data, { isNew, existing }) {
    const now = new Date();
    if (isNew && data.priorityId) {
      const Sla = modelOf('ServiceLevelAgreement');
      let sla = data.slaId ? await Sla.findById(data.slaId).session(session).lean() : null;
      if (!sla && data.partyId) sla = await Sla.findOne({ partyId: data.partyId, isActive: true }).session(session).lean();
      if (!sla) sla = await Sla.findOne({ isDefault: true, isActive: true }).session(session).lean();
      const row = sla?.priorities.find((r) => String(r.priorityId) === String(data.priorityId));
      if (row) {
        data.slaId = String(sla._id);
        data.respondBy = new Date(now.getTime() + row.responseHours * 3600000);
        data.resolveBy = new Date(now.getTime() + row.resolutionHours * 3600000);
      }
    }
    if (!isNew) {
      if (data.status === 'REPLIED' && !existing.firstRespondedAt) data.firstRespondedAt = now;
      if (['RESOLVED', 'CLOSED'].includes(data.status) && !existing.resolvedAt) {
        if (!data.resolution) throw rule('Say how this was resolved.', 'RESOLUTION_REQUIRED');
        data.resolvedAt = now;
      }
    }
    return data;
  },
});
s('WarrantyClaim', 'partyId!:link(Party) buildId:link(MachineBuild) itemId:link(Item) complaint!:long onDate!:date status:select(OPEN,WORK_IN_PROGRESS,CLOSED,CANCELLED)=OPEN resolution:long', { series: 'WC', dateField: 'onDate', list: 'docNo partyId buildId onDate status', labelFields: ['docNo'] });

/* ---------- Maintenance ---------- */

const n = (name, fields, extra = {}) => define({ name, module: 'maintenance', fields, ...extra });
n('MaintenanceSchedule', 'partyId!:link(Party) buildId:link(MachineBuild) amcId:link(AmcContract) startDate!:date endDate!:date visits:int=2 assignedTo status:select(ACTIVE,ENDED)=ACTIVE', {
  series: 'MS',
  dateField: 'startDate',
  labelFields: ['docNo'],
  tables: { slots: 'onDate!:date engineer isDone~:check visitId~:link(MaintenanceVisit)' },
  list: 'docNo partyId buildId startDate endDate status',
  prepare(_session, data) {
    if (data.slots?.length || !data.startDate || !data.endDate) return data;
    const from = Date.parse(`${data.startDate}T00:00:00Z`);
    const to = Date.parse(`${data.endDate}T00:00:00Z`);
    if (to <= from) throw rule('The end must be after the start.', 'BAD_DATE');
    const count = data.visits ?? 2;
    const gap = Math.floor((to - from) / 86400000 / Math.max(count, 1));
    return { ...data, slots: Array.from({ length: count }, (_, i) => ({ onDate: addDays(data.startDate, gap * (i + 1)), engineer: data.assignedTo ?? '' })) };
  },
});
n('MaintenanceVisit', 'partyId!:link(Party) buildId:link(MachineBuild) scheduleId:link(MaintenanceSchedule) ticketId:link(ServiceTicket) onDate!:date engineer kind:select(SCHEDULED,BREAKDOWN,UNSCHEDULED)=SCHEDULED workDone:long customerFeedback status2:select(PARTLY_DONE,FULLY_DONE)=FULLY_DONE', {
  series: 'MV',
  submittable: true,
  dateField: 'onDate',
  labelFields: ['docNo'],
  labels: { status2: 'Completion' },
  tables: { spares: 'itemId:link(Item) qtyMilli:qty' },
  list: 'docNo partyId buildId onDate engineer',
  async onSubmit(session, doc) {
    if (!doc.scheduleId) return;
    const schedule = await modelOf('MaintenanceSchedule').findById(doc.scheduleId).session(session);
    const slot = schedule?.slots.find((row) => !row.isDone);
    if (slot) {
      slot.isDone = true;
      slot.visitId = String(doc._id);
      await schedule.save({ session });
    }
  },
});
