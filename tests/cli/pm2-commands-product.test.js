import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLogs, runStatus, runStop } from '../../cli/lib/pm2-commands.js';

test('product CLI status, stop and logs never fall back to a plain PM2 daemon', async t => {
  const root = mkdtempSync(join(tmpdir(), 'home23-product-cli-pm2-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, 'app'), marker = join(root, 'plain-pm2-called'), commands = join(root, 'commands.jsonl');
  mkdirSync(join(app, 'cli/lib'), { recursive: true });
  writeFileSync(join(app, 'package.json'), '{"type":"module"}');
  writeFileSync(join(app, 'cli/lib/product-supervisor.js'), `
    import { appendFileSync } from 'node:fs';
    export async function productSupervisorCommand(home, args) {
      appendFileSync(home + '/commands.jsonl', JSON.stringify(args) + '\\n');
      if (args[0] === 'jlist') throw Object.assign(new Error('fixture supervisor exited'), { code: 'host_supervisor_exited' });
      return { stdout: '[]' };
    }
  `);
  writeFileSync(join(root, 'pm2'), `#!/bin/sh\n: > '${marker}'\nexit 88\n`);
  chmodSync(join(root, 'pm2'), 0o755);
  const previous = Object.fromEntries(['HOME23_PRODUCT_HOST', 'HOME23_ROOT', 'PATH'].map(key => [key, process.env[key]]));
  const originalLog = console.log;
  try {
    process.env.HOME23_PRODUCT_HOST = 'true';
    process.env.HOME23_ROOT = app;
    process.env.PATH = root;
    console.log = () => {};
    await assert.rejects(runStatus(), error => error.status === 75 && /host_supervisor_exited/.test(error.stderr));
    await assert.rejects(runLogs(app, 'fixture'), { code: 'host_supervisor_logs_unavailable' });
    await runStop(app, 'fixture');
    const calls = readFileSync(commands, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls[0], ['jlist']);
    assert.ok(calls.slice(1).length > 0);
    assert.ok(calls.slice(1).every(args => args[0] === 'stop' && args[1].startsWith('home23-fixture')));
    assert.equal(existsSync(marker), false);
  } finally {
    console.log = originalLog;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
