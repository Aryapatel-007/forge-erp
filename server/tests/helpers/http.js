import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import { connectTestDb, disconnectTestDb, resetDb } from './db.js';
import { createApp } from '../../server.js';
import { User } from '../../models/index.js';
import { ROLES } from '../../config/permissions.js';
import { issueAccessToken } from '../../services/authService.js';
import { integrity } from '../../services/reportService.js';

export const tokens = {};
export const users = {};
let server;
let base;

export async function startApi() {
  await connectTestDb();
  await resetDb();
  const app = createApp({ serveClient: false });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const passwordHash = await bcrypt.hash('correct-horse-battery', 4);
  for (const role of ROLES) {
    users[role] = await User.create({ name: `${role} person`, email: `${role.toLowerCase()}@t.test`, role, passwordHash });
    tokens[role] = issueAccessToken(users[role]);
  }
}

export async function stopApi() {
  await new Promise((resolve) => server.close(resolve));
  await disconnectTestDb();
}

export async function call(role, method, path, body, headers = {}) {
  const raw = Buffer.isBuffer(body);
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { ...(raw ? { 'content-type': 'application/octet-stream' } : { 'content-type': 'application/json' }), ...(role ? { authorization: `Bearer ${tokens[role]}` } : {}), ...headers },
    body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)),
  });
  const contentType = response.headers.get('content-type') ?? '';
  const parsed = contentType.includes('json') ? await response.json().catch(() => null) : await response.arrayBuffer().then((b) => Buffer.from(b));
  return { status: response.status, body: parsed, headers: response.headers };
}

export async function ok(role, method, path, body) {
  const result = await call(role, method, path, body);
  assert.ok(result.status < 300, `${method} ${path} -> ${result.status} ${JSON.stringify(result.body)?.slice(0, 600)}`);
  return result.body.data;
}

export async function refused(role, method, path, body, code, status) {
  const result = await call(role, method, path, body);
  assert.equal(result.body?.error?.code, code, `${method} ${path} -> ${result.status} ${JSON.stringify(result.body)?.slice(0, 600)}`);
  if (status) assert.equal(result.status, status);
  return result.body.error;
}

export async function post(role, path, body, submitBody = {}) {
  const draft = await ok(role, 'POST', path, body);
  return ok(role, 'POST', `${path}/${draft.id}/submit`, submitBody);
}

export async function booksAreClean(label) {
  const report = await integrity();
  const failed = report.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.message}`);
  assert.deepEqual(failed, [], `Books are wrong after ${label}`);
}
