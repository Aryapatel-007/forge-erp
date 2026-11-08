import mongoose from 'mongoose';

// Runs fn in one transaction. The driver retries the whole callback on a transient
// write conflict, so fn must do nothing outside the session.
export async function withTxn(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    return result;
  } finally {
    await session.endSession();
  }
}
