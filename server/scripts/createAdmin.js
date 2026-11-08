// The first sign-in on a real install:
//   ADMIN_EMAIL=you@company.com ADMIN_NAME="Your Name" node --env-file=../.env scripts/createAdmin.js
// Prints a generated password once, unless ADMIN_PASSWORD gives one. It is never stored in
// plain text. With ADMIN_IF_NONE=1 it does nothing when an admin already exists, so the
// Windows setup can run it on every update.
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { User } from '../models/core.js';
import { hashPassword } from '../services/authService.js';
import { ensureDefaults } from '../services/settingsService.js';
import { audit } from '../services/auditService.js';
import { withTxn } from '../utils/txn.js';
import '../models/index.js';
import '../doctypes/index.js';

const email = process.env.ADMIN_EMAIL;
const name = process.env.ADMIN_NAME ?? 'Administrator';
if (!email) {
  console.error('Set ADMIN_EMAIL.');
  process.exit(1);
}
mongoose.set('strictQuery', 'throw');
await mongoose.connect(env.MONGO_URI);
await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
await ensureDefaults();
if (process.env.ADMIN_IF_NONE === '1' && await User.exists({ role: 'ADMIN' })) {
  console.log('An administrator already exists, so none was added.');
  await mongoose.disconnect();
  process.exit(0);
}
const chosen = process.env.ADMIN_PASSWORD;
if (chosen !== undefined && chosen.length < 10) {
  console.error('The password needs at least 10 characters.');
  await mongoose.disconnect();
  process.exit(1);
}
const password = chosen || crypto.randomBytes(15).toString('base64url');
const passwordHash = await hashPassword(password);
await withTxn(async (session) => {
  const [user] = await User.create([{ name, email, role: 'ADMIN', passwordHash }], { session });
  await audit(session, { action: 'USER_CREATED', entityType: 'User', entityId: user._id, data: { role: 'ADMIN', bootstrap: true } });
});
console.log(chosen ? `Admin ${email} created, with the password you chose.` : `Admin ${email} created. Password, shown once: ${password}`);
await mongoose.disconnect();
