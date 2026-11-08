// Backups written from Node, so they need no database tools installed. One gzip file holds
// every collection as EJSON lines. A small manifest beside it holds counts, indexes and a
// checksum, and a restore refuses a file that does not match its manifest.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { once } from 'node:events';
import { createGunzip, createGzip } from 'node:zlib';
import mongoose from 'mongoose';

const { EJSON } = mongoose.mongo.BSON;

const DEFAULT_DIR = path.resolve(import.meta.dirname, '../../backups');
export const backupDir = () => process.env.BACKUP_DIR || DEFAULT_DIR;
const keepCount = () => Math.max(1, Number.parseInt(process.env.BACKUP_KEEP, 10) || 14);

const stamp = (now) => now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
const fileHash = async (file) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};

export async function createBackup({ db = mongoose.connection.db, dir = backupDir(), now = new Date() } = {}) {
  await fs.mkdir(dir, { recursive: true });
  const name = `forge-${stamp(now)}`;
  const file = path.join(dir, `${name}.jsonl.gz`);
  const temp = `${file}.part`;
  const gzip = createGzip();
  const out = createWriteStream(temp);
  gzip.pipe(out);
  const write = async (line) => {
    if (!gzip.write(`${line}\n`)) await once(gzip, 'drain');
  };

  const collections = (await db.listCollections().toArray()).filter((c) => c.type !== 'view' && !c.name.startsWith('system.'));
  const manifest = { name, createdAt: now.toISOString(), database: db.databaseName, collections: {} };
  for (const { name: collectionName } of collections) {
    const collection = db.collection(collectionName);
    let count = 0;
    await write(JSON.stringify({ $collection: collectionName }));
    for await (const doc of collection.find()) {
      await write(EJSON.stringify(doc, { relaxed: false }));
      count += 1;
    }
    manifest.collections[collectionName] = { count, indexes: await collection.indexes() };
  }
  gzip.end();
  await once(out, 'finish');
  await fs.rename(temp, file);
  manifest.sha256 = await fileHash(file);
  manifest.bytes = (await fs.stat(file)).size;
  await fs.writeFile(path.join(dir, `${name}.json`), JSON.stringify(manifest, null, 1));
  await pruneBackups(dir);
  const copy = await copyElsewhere(file, name, dir);
  return { name, file, bytes: manifest.bytes, sha256: manifest.sha256, collections: Object.keys(manifest.collections).length, ...copy };
}

// Point BACKUP_COPY_DIR at another disk or a synced folder, so losing this one is survivable.
// The copy is checked against the checksum, as a copy that silently failed is worth nothing.
async function copyElsewhere(file, name, dir) {
  const target = process.env.BACKUP_COPY_DIR;
  if (!target) return { copiedTo: null };
  try {
    await fs.mkdir(target, { recursive: true });
    const manifestPath = path.join(dir, `${name}.json`);
    const copy = path.join(target, `${name}.jsonl.gz`);
    await fs.copyFile(file, copy);
    await fs.copyFile(manifestPath, path.join(target, `${name}.json`));
    const { sha256 } = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if ((await fileHash(copy)) !== sha256) throw new Error('The copy does not match the original.');
    await pruneBackups(target);
    return { copiedTo: target };
  } catch (error) {
    return { copiedTo: null, copyError: error.message };
  }
}

async function pruneBackups(dir) {
  const names = (await fs.readdir(dir)).filter((f) => /^forge-.*\.jsonl\.gz$/.test(f)).sort();
  for (const old of names.slice(0, Math.max(0, names.length - keepCount()))) {
    await fs.rm(path.join(dir, old), { force: true });
    await fs.rm(path.join(dir, old.replace('.jsonl.gz', '.json')), { force: true });
  }
}

export async function listBackups(dir = backupDir()) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const rows = [];
  for (const file of names.filter((f) => f.endsWith('.json')).sort().reverse()) {
    const manifest = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
    rows.push({ id: manifest.name, name: manifest.name, createdAt: manifest.createdAt, bytes: manifest.bytes, sha256: manifest.sha256, collections: Object.keys(manifest.collections).length, documents: Object.values(manifest.collections).reduce((sum, c) => sum + c.count, 0) });
  }
  return rows;
}

export function backupPath(name, dir = backupDir()) {
  if (!/^forge-[0-9TZ-]+$/.test(name)) throw new Error('Bad backup name');
  return path.join(dir, `${name}.jsonl.gz`);
}

// Loads a backup into a database. It refuses one that already holds data, unless told to
// replace it, so a slip cannot overwrite live books. It then compares every count.
export async function restoreBackup({ file, db, replace = false }) {
  const manifest = JSON.parse(await fs.readFile(file.replace('.jsonl.gz', '.json'), 'utf8'));
  if ((await fileHash(file)) !== manifest.sha256) throw new Error('This backup does not match its checksum. It may be damaged.');
  const existing = await db.listCollections().toArray();
  if (existing.length > 0) {
    if (!replace) throw new Error(`Database ${db.databaseName} is not empty. Use another name, or replace it on purpose.`);
    for (const collection of existing) if (!collection.name.startsWith('system.')) await db.collection(collection.name).drop();
  }

  const counts = {};
  let target = null;
  let batch = [];
  const flush = async () => {
    if (batch.length && target) await db.collection(target).insertMany(batch, { ordered: true });
    batch = [];
  };
  const lines = readline.createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    if (line.startsWith('{"$collection":')) {
      await flush();
      target = JSON.parse(line).$collection;
      counts[target] = 0;
      await db.createCollection(target);
      continue;
    }
    batch.push(EJSON.parse(line, { relaxed: false }));
    counts[target] += 1;
    if (batch.length >= 500) await flush();
  }
  await flush();

  const mismatches = [];
  for (const [name, entry] of Object.entries(manifest.collections)) {
    const actual = await db.collection(name).countDocuments();
    if (actual !== entry.count) mismatches.push(`${name}: expected ${entry.count}, found ${actual}`);
    for (const index of entry.indexes) {
      if (index.name === '_id_') continue;
      const { v: _v, ns: _ns, key, ...options } = index;
      await db.collection(name).createIndex(key, options);
    }
  }
  if (mismatches.length) throw new Error(`The restore did not match: ${mismatches.join('; ')}`);
  return { collections: Object.keys(counts).length, documents: Object.values(counts).reduce((a, b) => a + b, 0) };
}
