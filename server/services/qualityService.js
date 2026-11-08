// FAT protocols and non-conformance reports.
import { Bom, FatProtocol, Gauge, MachineBuild, Ncr } from '../models/documents.js';
import { conflict, notFound, rule } from '../utils/errors.js';
import { assertPostingDate, getSettings } from './settingsService.js';
import { nextDocNo } from './numberService.js';
import { audit } from './auditService.js';

// Starts a protocol from the checklist on the build's own BOM revision.
export async function startFat(session, buildId, data, actor) {
  const build = await MachineBuild.findById(buildId).session(session);
  if (!build) throw notFound('Build');
  if (!['ASSEMBLY', 'FAT', 'FABRICATION', 'PROCUREMENT', 'PLANNED'].includes(build.stage)) {
    throw rule(`A build at ${build.stage} cannot start a FAT.`, 'BUILD_NOT_OPEN');
  }
  if (build.fatStatus === 'PASSED') throw rule('This machine has already passed its FAT.', 'FAT_ALREADY_PASSED');
  const draft = await FatProtocol.countDocuments({ buildId, status: 'DRAFT' }).session(session);
  if (draft > 0) throw rule('A FAT protocol is already open on this build.', 'FAT_ALREADY_OPEN');
  const bom = await Bom.findById(build.bomId).session(session).lean();
  if (!bom.fatChecklist?.length) throw rule(`BOM revision ${bom.revision} has no FAT checklist.`, 'NO_FAT_CHECKLIST');
  const attempt = (await FatProtocol.countDocuments({ buildId, status: { $in: ['PASSED', 'FAILED'] } }).session(session)) + 1;
  const [protocol] = await FatProtocol.create([{
    postingDate: data.postingDate,
    buildId,
    serialNo: build.serialNo,
    attempt,
    witnessName: data.witnessName ?? '',
    witnessCompany: data.witnessCompany ?? '',
    testedByName: data.testedByName ?? actor.name,
    createdBy: actor.id,
    results: bom.fatChecklist.map((c) => ({
      parameter: c.parameter,
      acceptance: c.acceptance,
      minMilli: c.minMilli,
      maxMilli: c.maxMilli,
      unit: c.unit,
      isCritical: c.isCritical,
    })),
  }], { session });
  if (build.stage !== 'FAT') {
    build.stage = 'FAT';
    build.stageHistory.push({ stage: 'FAT', at: new Date(), byName: actor.name, note: `FAT attempt ${attempt}` });
    await build.save({ session });
  }
  return protocol;
}

export async function saveFatResults(session, id, data) {
  const protocol = await FatProtocol.findById(id).session(session);
  if (!protocol) throw notFound('FAT protocol');
  if (protocol.status !== 'DRAFT') throw conflict('This protocol has been closed.');
  for (const key of ['witnessName', 'witnessCompany', 'testedByName', 'gaugeIds', 'remarks']) {
    if (data[key] !== undefined) protocol[key] = data[key];
  }
  for (const input of data.results ?? []) {
    const row = protocol.results.id(input.id);
    if (!row) throw rule('A result does not belong to this protocol.', 'BAD_RESULT_LINE');
    if (input.observedMilli !== undefined) row.observedMilli = input.observedMilli;
    if (input.observedText !== undefined) row.observedText = input.observedText;
    if (input.result !== undefined) row.result = input.result;
  }
  await protocol.save({ session });
  return protocol;
}

// A measured value is checked against its limits on the server, whatever the tester
// marked. Every instrument used must be in calibration on the test date.
export async function closeFat(session, id, actor) {
  const protocol = await FatProtocol.findById(id).session(session);
  if (!protocol) throw notFound('FAT protocol');
  if (protocol.status !== 'DRAFT') throw conflict('This protocol has been closed.');
  const settings = await getSettings(session);
  assertPostingDate(protocol.postingDate, settings);
  if (!protocol.witnessName) throw rule('A FAT must name its witness.', 'WITNESS_REQUIRED');
  if (!protocol.gaugeIds.length) throw rule('A FAT must list the instruments used.', 'GAUGES_REQUIRED');

  const gauges = await Gauge.find({ _id: { $in: protocol.gaugeIds } }).session(session).lean();
  if (gauges.length !== protocol.gaugeIds.length) throw rule('An instrument on this protocol does not exist.', 'UNKNOWN_GAUGE');
  for (const gauge of gauges) {
    if (!gauge.dueOn || gauge.dueOn < protocol.postingDate) {
      throw rule(`${gauge.code} (${gauge.name}) is out of calibration, due ${gauge.dueOn ?? 'never recorded'}.`, 'GAUGE_OUT_OF_CALIBRATION');
    }
  }

  let failed = 0;
  for (const row of protocol.results) {
    if (!row.result) throw rule(`"${row.parameter}" has no result.`, 'RESULT_MISSING');
    const hasLimits = row.minMilli !== null || row.maxMilli !== null;
    if (hasLimits && row.result !== 'NA') {
      if (row.observedMilli === null) throw rule(`"${row.parameter}" has limits, so it needs a measured value.`, 'READING_MISSING');
      const low = row.minMilli !== null && row.observedMilli < row.minMilli;
      const high = row.maxMilli !== null && row.observedMilli > row.maxMilli;
      if ((low || high) && row.result === 'PASS') {
        throw rule(`"${row.parameter}" reads ${row.observedMilli / 1000}, outside its limits, and cannot be a pass.`, 'READING_OUT_OF_LIMITS');
      }
    }
    if (row.result === 'NA' && row.isCritical) throw rule(`"${row.parameter}" is critical and cannot be marked not applicable.`, 'CRITICAL_NOT_NA');
    if (row.result === 'FAIL') failed += 1;
  }

  protocol.docNo = await nextDocNo(session, 'FAT', protocol.postingDate);
  protocol.status = failed === 0 ? 'PASSED' : 'FAILED';
  protocol.submittedBy = actor.id;
  protocol.submittedAt = new Date();
  await protocol.save({ session });

  const build = await MachineBuild.findById(protocol.buildId).session(session);
  build.fatStatus = protocol.status;
  build.stageHistory.push({ stage: build.stage, at: new Date(), byName: actor.name, note: `FAT ${protocol.docNo}: ${protocol.status}` });
  await build.save({ session });

  if (protocol.status === 'FAILED') {
    const failedNames = protocol.results.filter((r) => r.result === 'FAIL').map((r) => r.parameter).join(', ');
    await Ncr.create([{
      docNo: await nextDocNo(session, 'NCR', protocol.postingDate),
      postingDate: protocol.postingDate,
      source: 'FAT',
      buildId: build._id,
      serialNo: build.serialNo,
      itemId: build.itemId,
      itemName: build.itemName,
      description: `FAT ${protocol.docNo} failed on: ${failedNames}`,
      raisedBy: actor.id,
      raisedByName: actor.name,
      createdBy: actor.id,
    }], { session });
  }
  await audit(session, { actor, action: `FAT_${protocol.status}`, entityType: 'FatProtocol', entityId: protocol._id, entityNo: protocol.docNo, data: { serialNo: build.serialNo, witness: protocol.witnessName, failed } });
  return protocol;
}

export async function raiseNcr(session, data, actor) {
  const build = data.buildId ? await MachineBuild.findById(data.buildId, { serialNo: 1 }).session(session).lean() : null;
  if (data.buildId && !build) throw notFound('Build');
  const [ncr] = await Ncr.create([{
    ...data,
    docNo: await nextDocNo(session, 'NCR', data.postingDate),
    serialNo: build?.serialNo ?? null,
    raisedBy: actor.id,
    raisedByName: actor.name,
    createdBy: actor.id,
  }], { session });
  await audit(session, { actor, action: 'NCR_RAISED', entityType: 'Ncr', entityId: ncr._id, entityNo: ncr.docNo, data: { source: ncr.source } });
  return ncr;
}

// Closing needs the disposition and the root cause. Whoever raised it cannot close it.
export async function closeNcr(session, id, data, actor) {
  const ncr = await Ncr.findById(id).session(session);
  if (!ncr) throw notFound('NCR');
  if (ncr.status !== 'OPEN') throw rule('This NCR is not open.', 'NCR_NOT_OPEN');
  if (String(ncr.raisedBy) === String(actor.id)) throw rule('Whoever raised an NCR cannot close it.', 'SELF_APPROVAL');
  ncr.disposition = data.disposition;
  ncr.rootCause = data.rootCause;
  ncr.correctiveAction = data.correctiveAction;
  ncr.preventiveAction = data.preventiveAction ?? '';
  ncr.status = 'CLOSED';
  ncr.closedBy = actor.id;
  ncr.closedAt = new Date();
  await ncr.save({ session });
  await audit(session, { actor, action: 'NCR_CLOSED', entityType: 'Ncr', entityId: ncr._id, entityNo: ncr.docNo, data: { disposition: ncr.disposition } });
  return ncr;
}
