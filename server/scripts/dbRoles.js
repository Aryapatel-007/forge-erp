// Creates the database role the production app must connect with. It can read and write
// everything except the ledgers, where it can only read and insert. So even a bug or a
// stolen app password cannot rewrite the books. Run once with an admin connection:
//   ADMIN_MONGO_URI=... APP_DB_USER=forge_app APP_DB_PASSWORD=... npm run db:roles
import { MongoClient } from 'mongodb';

const uri = process.env.ADMIN_MONGO_URI;
const user = process.env.APP_DB_USER;
const password = process.env.APP_DB_PASSWORD;
const database = process.env.APP_DB_NAME ?? 'forge-erp';
if (!uri || !user || !password) {
  console.error('Set ADMIN_MONGO_URI, APP_DB_USER and APP_DB_PASSWORD.');
  process.exit(1);
}

const LEDGERS = ['glentries', 'stockentries', 'auditlogs'];
const client = new MongoClient(uri);
await client.connect();
const db = client.db(database);
const collections = (await db.listCollections().toArray()).map((c) => c.name);

const FULL = ['find', 'insert', 'update', 'remove', 'createIndex', 'listIndexes', 'listCollections', 'collStats', 'dbStats'];
const privileges = [
  { resource: { db: database, collection: '' }, actions: ['listCollections', 'dbStats'] },
  ...collections.filter((c) => !LEDGERS.includes(c)).map((collection) => ({ resource: { db: database, collection }, actions: FULL })),
  ...LEDGERS.map((collection) => ({ resource: { db: database, collection }, actions: ['find', 'insert', 'createIndex', 'listIndexes'] })),
];

const role = 'forgeApp';
const exists = (await db.command({ rolesInfo: role })).roles.length > 0;
await db.command(exists ? { updateRole: role, privileges, roles: [] } : { createRole: role, privileges, roles: [] });
const hasUser = (await db.command({ usersInfo: user })).users.length > 0;
await db.command(hasUser ? { updateUser: user, pwd: password, roles: [role] } : { createUser: user, pwd: password, roles: [role] });
console.log(`Role ${role} ${exists ? 'updated' : 'created'}, and ${user} connects with it. Ledgers: ${LEDGERS.join(', ')} are find and insert only.`);
await client.close();
