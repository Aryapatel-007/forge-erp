import mongoose from 'mongoose';
import { env } from '../../config/env.js';
import { ensureDefaults } from '../../services/settingsService.js';
import '../../models/index.js';
import '../../doctypes/index.js';

// Tests run against the real replica set, in their own database, so transactions are
// really exercised. This refuses to wipe anything not named as a test database.
export async function connectTestDb() {
  mongoose.set('strictQuery', 'throw');
  await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  if (!mongoose.connection.name.endsWith('-test')) {
    throw new Error(`Refusing to run tests against "${mongoose.connection.name}"`);
  }
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}

export async function resetDb() {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
  await ensureDefaults();
}

export async function disconnectTestDb() {
  await mongoose.disconnect();
}

// Reaches past the append-only guard, to simulate tampering in the integrity tests.
export const rawCollection = (model) => mongoose.connection.db.collection(model.collection.name);
