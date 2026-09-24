import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runRemediator } = require('../../../engine/src/live-problems/remediators.js');

test('pm2 restart keeps the event loop responsive and observes command failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-pm2-restart-'));
  const previous = {
    PATH: process.env.PATH,
    INSTANCE_ID: process.env.INSTANCE_ID,
    FAKE_PM2_ARGS: process.env.FAKE_PM2_ARGS,
    FAKE_PM2_EXIT: process.env.FAKE_PM2_EXIT,
  };
  try {
    const pm2 = join(dir, 'pm2');
    writeFileSync(pm2, '#!/bin/sh\nprintf "%s\\n" "$@" > "$FAKE_PM2_ARGS"\nsleep 0.2\nexit "$FAKE_PM2_EXIT"\n');
    chmodSync(pm2, 0o755);
    process.env.PATH = `${dir}:${previous.PATH || ''}`;
    process.env.INSTANCE_ID = 'home23-test-engine';
    process.env.FAKE_PM2_ARGS = join(dir, 'args');
    process.env.FAKE_PM2_EXIT = '0';

    let timerRan = false;
    const pending = runRemediator({ type: 'pm2_restart', args: { name: 'home23-test-dash' } });
    setTimeout(() => { timerRan = true; }, 25);
    assert.deepEqual(await pending, { outcome: 'success', detail: 'restarted home23-test-dash' });
    assert.equal(timerRan, true);
    assert.deepEqual(readFileSync(process.env.FAKE_PM2_ARGS, 'utf8').trim().split('\n'),
      ['restart', 'home23-test-dash', '--update-env']);

    process.env.FAKE_PM2_EXIT = '7';
    const failed = await runRemediator({ type: 'pm2_restart', args: { name: 'home23-test-dash' } });
    assert.equal(failed.outcome, 'failed');
    assert.match(failed.detail, /pm2 restart failed/);

    assert.deepEqual(await runRemediator({ type: 'pm2_restart', args: { name: 'jerry-api' } }),
      { outcome: 'rejected', detail: 'not restartable: jerry-api' });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
