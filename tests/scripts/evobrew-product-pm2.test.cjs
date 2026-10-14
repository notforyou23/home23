'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const { runInNewContext } = require('node:vm');

function manager(product) {
  const calls = [];
  const source = readFileSync(require.resolve('../../evobrew/lib/daemon-manager.js'), 'utf8').replace(/^#![^\n]*\n/, '');
  const exported = { exports: {} };
  runInNewContext(source, {
    module: exported, exports: exported.exports,
    process: { platform: 'darwin', env: product ? { HOME23_PRODUCT_HOST: 'true' } : {} },
    require(name) {
      if (name === 'os') return { ...require('os'), homedir: () => '/fixture/evobrew-owner' };
      if (name === 'fs') return { ...require('fs'), existsSync: () => false };
      if (name === 'child_process') return { ...require(name), execSync: command => { calls.push(command); return command === 'pm2 jlist' ? '[]' : ''; } };
      return require(name);
    },
  });
  return { daemon: exported.exports, calls };
}

test('standalone Evobrew PM2 entrypoints fail before any process launch in product context', async () => {
  const { daemon, calls } = manager(true);
  for (const operation of ['hasPm2', 'getPm2Logs', 'getDaemonStatus']) {
    assert.throws(() => daemon[operation](), { code: 'host_supervisor_command_required' });
  }
  for (const operation of ['installPm2', 'uninstallPm2', 'startPm2', 'stopPm2', 'restartPm2']) {
    await assert.rejects(daemon[operation](), { code: 'host_supervisor_command_required' });
  }
  for (const operation of ['installDaemon', 'uninstallDaemon', 'startDaemon', 'stopDaemon', 'restartDaemon']) {
    await assert.rejects(daemon[operation]({ runner: 'pm2' }), { code: 'host_supervisor_command_required' });
  }
  assert.deepEqual(calls, []);
});

test('standalone Evobrew source PM2 controls preserve their commands', async () => {
  const { daemon, calls } = manager(false);
  assert.equal(daemon.hasPm2(), true);
  await daemon.startPm2();
  await daemon.stopPm2();
  await daemon.restartPm2();
  assert.deepEqual(calls, ['pm2 -v', 'pm2 -v', 'pm2 start evobrew', 'pm2 -v', 'pm2 stop evobrew', 'pm2 -v', 'pm2 restart evobrew --update-env']);
});
