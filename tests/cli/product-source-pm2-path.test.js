import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSourceWriters } from '../../cli/lib/product-update.js';

test('source adoption resolves an executable absolute path before its mocked inventory command', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-source-pm2-path-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['first', 'second', 'global']) fs.mkdirSync(path.join(root, dir));
  fs.writeFileSync(path.join(root, 'first/pm2'), 'must never execute', { mode: 0o644 });
  const absolute = path.join(root, 'global/pm2');
  fs.writeFileSync(absolute, 'must never execute', { mode: 0o755 });
  fs.symlinkSync(absolute, path.join(root, 'second/pm2'));
  const calls = [];
  assert.deepEqual(await listSourceWriters(root, {
    env: { PATH: ['relative-directory', path.join(root, 'first'), path.join(root, 'second')].join(path.delimiter) },
    executeFile: async (file, args) => { calls.push([file, args]); return { stdout: '[]' }; },
  }), []);
  assert.deepEqual(calls, [[absolute, ['jlist', '--silent']]]);
});

test('missing executable or relative explicit source PM2 path fails before process execution', async () => {
  for (const dependencies of [{ env: { PATH: 'relative-directory' } },
    { env: { PATH: '/nonexistent-home23-pm2-path' } }, { pm2Command: 'pm2', env: {} }]) {
    await assert.rejects(listSourceWriters('/fixture', { ...dependencies,
      executeFile: () => assert.fail('unresolved PM2 must not execute'),
    }), { code: 'process_inventory_unavailable' });
  }
});
