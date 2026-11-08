import crypto from 'node:crypto';
import { AuditLog, Counter } from '../models/core.js';
import { withTxn } from '../utils/txn.js';

const GENESIS = 'GENESIS';
const HEAD_ID = 'audit-chain';

function hashOf(prevHash, entry) {
  const canonical = JSON.stringify([
    entry.seq,
    new Date(entry.at).toISOString(),
    entry.actorId ? String(entry.actorId) : null,
    entry.actorName,
    entry.action,
    entry.entityType,
    entry.entityId ?? null,
    entry.entityNo ?? null,
    entry.reason ?? null,
    entry.data ?? null,
  ]);
  return crypto.createHash('sha256').update(`${prevHash}|${canonical}`).digest('hex');
}

// Writes one link of the chain inside the caller's transaction. Taking the head row
// serialises writers: a concurrent transaction hits a write conflict and is retried.
export async function audit(session, { actor, action, entityType, entityId, entityNo, reason, data }) {
  const head = await Counter.findOneAndUpdate(
    { _id: HEAD_ID },
    { $inc: { seq: 1 } },
    { session, upsert: true, new: true },
  );
  const prevHash = head.hash || GENESIS;
  const entry = {
    seq: head.seq,
    at: new Date(),
    actorId: actor?.id ?? null,
    actorName: actor?.name ?? 'System',
    action,
    entityType,
    entityId: entityId ? String(entityId) : null,
    entityNo: entityNo ?? null,
    reason: reason ?? null,
    // Hash exactly what gets stored: ids and dates as text, no undefined values.
    data: data === undefined || data === null ? null : JSON.parse(JSON.stringify(data)),
  };
  entry.hash = hashOf(prevHash, entry);
  entry.prevHash = prevHash;
  await AuditLog.create([entry], { session });
  await Counter.updateOne({ _id: HEAD_ID }, { $set: { hash: entry.hash } }, { session });
  return entry;
}

export const auditNow = (entry) => withTxn((session) => audit(session, entry));

// Walks the whole chain in order. Returns the first break it finds.
export async function verifyAuditChain() {
  let prevHash = GENESIS;
  let expectedSeq = 1;
  let checked = 0;
  const cursor = AuditLog.find().sort({ seq: 1 }).lean().cursor();
  for await (const row of cursor) {
    if (row.seq !== expectedSeq) {
      return { ok: false, checked, message: `Audit record ${expectedSeq} is missing (next found is ${row.seq}).` };
    }
    if (row.prevHash !== prevHash || row.hash !== hashOf(prevHash, row)) {
      return { ok: false, checked, message: `Audit record ${row.seq} was changed after it was written.` };
    }
    prevHash = row.hash;
    expectedSeq += 1;
    checked += 1;
  }
  const head = await Counter.findById(HEAD_ID).lean();
  if ((head?.seq ?? 0) !== checked) {
    return { ok: false, checked, message: `The chain should hold ${head?.seq ?? 0} records but holds ${checked}.` };
  }
  return { ok: true, checked, message: `${checked} audit records verified.` };
}
