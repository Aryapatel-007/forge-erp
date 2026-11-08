import { Counter } from '../models/core.js';
import { fyOf } from '../utils/dates.js';

// Reserved inside the submit transaction: if the submit aborts, the increment rolls
// back too, so a series can never have a gap. "SI/2627/00001" fits GST's 16 characters.
export async function nextDocNo(session, prefix, date) {
  const fy = fyOf(date);
  const counter = await Counter.findOneAndUpdate(
    { _id: `doc:${prefix}:${fy}` },
    { $inc: { seq: 1 } },
    { session, upsert: true, new: true },
  );
  return `${prefix}/${fy}/${String(counter.seq).padStart(5, '0')}`;
}

// A machine serial number: model code, financial year, running number.
export async function nextSerialNo(session, itemCode, date) {
  const fy = fyOf(date);
  const counter = await Counter.findOneAndUpdate(
    { _id: `serial:${itemCode}:${fy}` },
    { $inc: { seq: 1 } },
    { session, upsert: true, new: true },
  );
  return `${itemCode}-${fy}-${String(counter.seq).padStart(4, '0')}`;
}
