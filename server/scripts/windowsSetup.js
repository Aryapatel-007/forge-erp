// Run by the Windows and Mac setup programs, not by hand. Each step is safe to run again, so an
// update or a repair reuses what is there and never replaces the database or the secrets.
//   node windowsSetup.js prepare     --data <dir> [--host 127.0.0.1|0.0.0.0|keep] [--pick-ports]
//
// With --pick-ports (the Windows setup), Forge and its database take 4100 and 27217 if they
// are free, and otherwise the next free ports. An update keeps the ports it had, unless
// another program has taken one since. The chosen web port is written to port.txt.
//   node windowsSetup.js replset     --data <dir>
//   node windowsSetup.js wait-ready  --data <dir>
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import mongoose from 'mongoose';

const DB_PORT = 27217;
const APP_PORT = 4100;

const args = process.argv.slice(2);
const step = args[0];
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at > 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const dataDir = option('data');
if (!dataDir) fail('Pass --data.');
const envFile = path.join(dataDir, 'forge.env');

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function readEnv() {
  if (!fs.existsSync(envFile)) return new Map();
  const rows = fs.readFileSync(envFile, 'utf8').split(/\r?\n/).filter((line) => line && !line.startsWith('#') && line.includes('='));
  return new Map(rows.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}

// True if nothing on this computer is listening on the port, on any address.
function isFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '0.0.0.0');
  });
}

async function freePort(wanted, avoid = []) {
  for (let port = wanted; port < wanted + 200; port += 1) {
    if (!avoid.includes(port) && await isFree(port)) return port;
  }
  fail(`No free port between ${wanted} and ${wanted + 199}.`);
}

const dbPortOf = (uri) => Number((/127\.0\.0\.1:(\d+)/.exec(uri ?? '') ?? [])[1] ?? DB_PORT);

// Settings and folders. Secrets are made once and kept, so sessions survive an update.
async function prepare() {
  for (const folder of ['db', 'logs', 'backups']) fs.mkdirSync(path.join(dataDir, folder), { recursive: true });
  const env = readEnv();
  const keep = (key, value) => { if (!env.has(key)) env.set(key, value); };
  keep('NODE_ENV', 'production');
  if (args.includes('--pick-ports')) {
    // Setup stopped Forge's own services before this, so a busy port is someone else's.
    const appPort = await freePort(Number(env.get('PORT') ?? APP_PORT));
    const dbPort = await freePort(dbPortOf(env.get('MONGO_URI')), [appPort]);
    if (env.has('PORT') && Number(env.get('PORT')) !== appPort) console.log(`Port ${env.get('PORT')} is now taken, so Forge moves to ${appPort}.`);
    env.set('PORT', String(appPort));
    env.set('MONGO_URI', `mongodb://127.0.0.1:${dbPort}/forge-erp?replicaSet=rs0`);
    console.log(`Forge will use port ${appPort}, and its database port ${dbPort}.`);
  }
  keep('PORT', String(APP_PORT));
  keep('MONGO_URI', `mongodb://127.0.0.1:${DB_PORT}/forge-erp?replicaSet=rs0`);
  keep('JWT_ACCESS_SECRET', crypto.randomBytes(48).toString('base64url'));
  keep('JWT_REFRESH_SECRET', crypto.randomBytes(48).toString('base64url'));
  keep('ACCESS_TOKEN_TTL', '15m');
  keep('REFRESH_TOKEN_DAYS', '7');
  keep('TRUST_PROXY', 'false');
  keep('BACKUP_DIR', path.join(dataDir, 'backups'));
  const host = option('host', 'keep');
  if (host !== 'keep') env.set('HOST', host);
  else keep('HOST', '127.0.0.1');
  const text = ['# Forge ERP settings. Written by setup. Keep this file private: it holds the sign-in secrets.', ...[...env].map(([key, value]) => `${key}=${value}`), ''].join('\n');
  fs.writeFileSync(envFile, text, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'port.txt'), env.get('PORT'));
  const dbPort = dbPortOf(env.get('MONGO_URI'));

  // Rewritten every time, so a repair puts it right.
  const quote = (value) => `'${value.replace(/'/g, "''")}'`;
  fs.writeFileSync(path.join(dataDir, 'mongod.cfg'), [
    'storage:',
    `  dbPath: ${quote(path.join(dataDir, 'db'))}`,
    '  wiredTiger:',
    '    engineConfig:',
    '      cacheSizeGB: 1',
    'systemLog:',
    '  destination: file',
    `  path: ${quote(path.join(dataDir, 'logs', 'mongod.log'))}`,
    '  logAppend: true',
    'net:',
    '  bindIp: 127.0.0.1',
    `  port: ${dbPort}`,
    'replication:',
    '  replSetName: rs0',
    '',
  ].join('\n'));
  console.log(`Settings are in ${dataDir}.`);
}

// Transactions need a replica set, even a set of one.
async function replset() {
  const dbPort = dbPortOf(readEnv().get('MONGO_URI'));
  const client = new mongoose.mongo.MongoClient(`mongodb://127.0.0.1:${dbPort}/?directConnection=true`, { serverSelectionTimeoutMS: 3000 });
  let connected = false;
  for (let i = 0; i < 40 && !connected; i += 1) {
    try {
      await client.connect();
      connected = true;
    } catch {
      await sleep(3000);
    }
  }
  if (!connected) fail('The database service did not start. Its log is in the logs folder.');
  const admin = client.db('admin');
  try {
    await admin.command({ replSetGetStatus: 1 });
    console.log('The database is already set up.');
  } catch (error) {
    if (error.code !== 94) throw error;
    await admin.command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: `127.0.0.1:${dbPort}` }] } });
    console.log('Set up the database.');
  }
  for (let i = 0; i < 40; i += 1) {
    const hello = await admin.command({ hello: 1 });
    if (hello.isWritablePrimary) {
      await client.close();
      console.log('The database is ready.');
      return;
    }
    await sleep(1500);
  }
  await client.close();
  fail('The database did not become ready in time.');
}

async function waitReady() {
  const port = readEnv().get('PORT') ?? APP_PORT;
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (response.ok) {
        console.log(`Forge is running at http://localhost:${port}/`);
        return;
      }
    } catch {
      // Not up yet.
    }
    await sleep(2000);
  }
  fail('Forge has not answered yet. Its log is in the logs folder.');
}

try {
  if (step === 'prepare') await prepare();
  else if (step === 'replset') await replset();
  else if (step === 'wait-ready') await waitReady();
  else fail(`Unknown step: ${step}`);
} catch (error) {
  fail(error.message);
}
