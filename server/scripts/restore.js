// Restores a backup into a database of your choice.
//   node --env-file=../.env scripts/restore.js <backup.jsonl.gz> <databaseName> [--replace]
// It refuses a database that already holds data unless you pass --replace.
import mongoose from 'mongoose';
import { restoreBackup } from '../services/backupService.js';

const [file, databaseName, flag] = process.argv.slice(2);
if (!file || !databaseName) {
  console.error('Usage: restore.js <backup.jsonl.gz> <databaseName> [--replace]');
  process.exit(2);
}
await mongoose.connect(process.env.MONGODB_URI);
try {
  const db = mongoose.connection.useDb(databaseName, { useCache: false }).db;
  const result = await restoreBackup({ file, db, replace: flag === '--replace' });
  console.log(`Restored ${result.documents} documents in ${result.collections} collections into ${databaseName}.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
