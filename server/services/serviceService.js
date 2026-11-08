// After the machine leaves: AMC contracts and service tickets.
import { AmcContract, MachineBuild, ServiceTicket } from '../models/documents.js';
import { conflict, notFound, rule } from '../utils/errors.js';
import { nextDocNo } from './numberService.js';
import { audit } from './auditService.js';

export const amcContract = {
  Model: AmcContract,
  async prepare(session, data) {
    const build = await MachineBuild.findById(data.buildId).session(session).lean();
    if (!build) throw notFound('Build');
    if (!['INSTALLED', 'CLOSED'].includes(build.stage)) throw rule('An AMC starts after installation.', 'NOT_INSTALLED');
    if (data.endDate <= data.startDate) throw rule('The AMC must end after it starts.', 'BAD_DATE');
    return { ...data, serialNo: build.serialNo, partyId: build.partyId, partyName: build.partyName };
  },
  async submit(session, doc, { actor }) {
    if (doc.status !== 'DRAFT') throw conflict('Only a draft can be activated.');
    const overlap = await AmcContract.countDocuments({
      buildId: doc.buildId,
      status: 'ACTIVE',
      startDate: { $lte: doc.endDate },
      endDate: { $gte: doc.startDate },
    }).session(session);
    if (overlap > 0) throw rule('This machine already has an AMC covering those dates.', 'AMC_OVERLAP');
    doc.docNo = await nextDocNo(session, 'AMC', doc.postingDate);
    doc.status = 'ACTIVE';
    return { action: 'AMC_ACTIVATED', actor, data: { serialNo: doc.serialNo, valuePaise: doc.valuePaise } };
  },
  async cancel(session, doc) {
    doc.status = 'CANCELLED';
  },
};

// The ticket works out its own cover on the day it is raised.
async function coverageFor(session, build, date) {
  if (build.warrantyUntil && date <= build.warrantyUntil) return 'WARRANTY';
  const amc = await AmcContract.countDocuments({ buildId: build._id, status: 'ACTIVE', startDate: { $lte: date }, endDate: { $gte: date } }).session(session);
  return amc > 0 ? 'AMC' : 'CHARGEABLE';
}

export async function raiseTicket(session, data, actor) {
  const build = await MachineBuild.findById(data.buildId).session(session).lean();
  if (!build) throw notFound('Build');
  if (!['DISPATCHED', 'INSTALLED', 'CLOSED'].includes(build.stage)) throw rule('Only a machine that has left the plant can have a service ticket.', 'NOT_DISPATCHED');
  const [ticket] = await ServiceTicket.create([{
    ...data,
    docNo: await nextDocNo(session, 'ST', data.postingDate),
    serialNo: build.serialNo,
    partyName: build.partyName,
    coverage: await coverageFor(session, build, data.postingDate),
    createdBy: actor.id,
  }], { session });
  await audit(session, { actor, action: 'TICKET_RAISED', entityType: 'ServiceTicket', entityId: ticket._id, entityNo: ticket.docNo, data: { serialNo: build.serialNo, coverage: ticket.coverage } });
  return ticket;
}

export async function updateTicket(session, id, data, actor) {
  const ticket = await ServiceTicket.findById(id).session(session);
  if (!ticket) throw notFound('Ticket');
  if (['RESOLVED', 'CANCELLED'].includes(ticket.status)) throw rule('This ticket is closed.', 'TICKET_CLOSED');
  for (const key of ['status', 'assignedTo', 'resolution', 'priority']) {
    if (data[key] !== undefined) ticket[key] = data[key];
  }
  if (ticket.status === 'RESOLVED') {
    if (!ticket.resolution) throw rule('Say how this was resolved.', 'RESOLUTION_REQUIRED');
    ticket.resolvedOn = data.resolvedOn;
  }
  await ticket.save({ session });
  await audit(session, { actor, action: 'TICKET_UPDATED', entityType: 'ServiceTicket', entityId: ticket._id, entityNo: ticket.docNo, data: { status: ticket.status } });
  return ticket;
}
