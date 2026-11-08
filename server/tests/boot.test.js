// Loads the server the way production does. The other test files load the document types
// first, so a module load-order bug passes them all and only stops the real server starting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const serverDir = path.resolve(import.meta.dirname, '..');

test('server.js loads, in production order, with every document type registered', async () => {
  const script = `
    const { createApp } = await import('./server.js');
    const { assertRegistryValid, allTypes } = await import('./engine/registry.js');
    assertRegistryValid();
    if (typeof createApp !== 'function') throw new Error('No createApp');
    console.log(allTypes().length);
    process.exit(0);
  `;
  const { stdout } = await run(process.execPath, ['--env-file=.env.test', '--input-type=module', '-e', script], { cwd: serverDir, timeout: 60000 });
  assert.ok(Number(stdout.trim()) > 300, stdout);
});

test('no route or service imports a document type file directly', async () => {
  // That is what broke the load order once. Only doctypes/index.js may load them.
  const { stdout } = await run('grep', ['-rlE', "from '(\\.\\./)+doctypes/", 'routes', 'services', 'engine', 'middleware', 'server.js'], { cwd: serverDir }).catch((error) => {
    if (error.code === 1) return { stdout: '' };
    throw error;
  });
  assert.equal(stdout.trim(), '');
});
