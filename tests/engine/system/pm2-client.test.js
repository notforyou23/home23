import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pm2Channel } from '../../../engine/src/channels/os/pm2-channel.js';

const require = createRequire(import.meta.url);
const { pm2Invocation, runPm2, runPm2Sync, schedulePm2 } = require('../../../engine/src/system/pm2-client.cjs');
const { runVerifier } = require('../../../engine/src/live-problems/verifiers.js');
const crashLoops = require('../../../engine/src/diagnostic/checks/crash-loops.js');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'home23-pm2-client-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'app/cli/lib'), { recursive: true });
  writeFileSync(join(root, 'app/package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'app/cli/lib/product-supervisor.js'), `
    export async function productSupervisorCommand(_home, args) {
      if (Object.keys(process.env).some(key => key.startsWith('PM2_'))) throw new Error('inherited PM2 metadata');
      if (args[1] === 'home23-unavailable') throw Object.assign(new Error('fixture unavailable'), { code: 'host_supervisor_exited' });
      return { stdout: JSON.stringify([{ name: 'home23-fixture', pid: 4321, pm2_env: { status: 'online', restart_time: 7 } }]) };
    }
  `);
  const plain = join(root, 'pm2'), marker = join(root, 'plain-daemon-invoked');
  writeFileSync(plain, `#!/bin/sh\n: > '${marker}'\nexit 88\n`);
  chmodSync(plain, 0o755);
  return { root, marker, env: { HOME23_PRODUCT_HOST: 'true', HOME23_ROOT: join(root, 'app'), PATH: root, PM2_HOME: join(root, 'runtime/pm2'), PM2_DAEMON_RPC_PORT: join(root, 'rpc.sock') } };
}

test('source PM2 calls preserve their executable, arguments and environment', async () => {
  const args = ['jlist'], options = { env: { PATH: '/fixture/path' }, encoding: 'utf8', timeout: 12 };
  assert.deepEqual(pm2Invocation(args, options), { file: 'pm2', args, options });
  const calls = [];
  assert.equal(runPm2Sync(args, options, (...call) => { calls.push(call); return '[]'; }), '[]');
  assert.deepEqual(await runPm2(args, options, async (...call) => { calls.push(call); return { stdout: '[]' }; }), { stdout: '[]' });
  assert.deepEqual(calls, [['pm2', args, options], ['pm2', args, options]]);
});

test('product callers use the guarded installed client and reject a lost supervisor without plain PM2 fallback', async t => {
  const f = fixture(t), options = { env: f.env, encoding: 'utf8', timeout: 3000 };
  const plan = pm2Invocation(['jlist'], options);
  assert.equal(plan.file, process.execPath);
  assert.equal(plan.args[3], f.root);
  assert.deepEqual(plan.options.env, { HOME23_PRODUCT_HOST: 'true', HOME23_ROOT: join(f.root, 'app'), LANG: 'en_US.UTF-8' });
  assert.equal(JSON.parse(runPm2Sync(['jlist'], options))[0].pid, 4321);
  assert.equal(JSON.parse((await runPm2(['jlist'], options)).stdout)[0].name, 'home23-fixture');
  await assert.rejects(runPm2(['restart', 'home23-unavailable'], options), error => error.code === 75 && /host_supervisor_exited/.test(error.stderr));
  assert.equal(existsSync(f.marker), false, 'no caller invokes a plain daemon-creating PM2 executable');
});

test('invalid product routing and supervisor lifecycle commands fail before launching a client', async t => {
  const f = fixture(t), execute = () => assert.fail('client must not launch');
  for (const args of [['kill'], ['update'], ['flush'], ['stop', 'all'], ['jlist', '--no-daemon']]) {
    assert.throws(() => runPm2Sync(args, { env: f.env }, execute), { code: 'host_supervisor_ambiguous' });
  }
  for (const HOME23_ROOT of [undefined, 'app', '/tmp/home/elsewhere']) {
    await assert.rejects(runPm2(['jlist'], { env: { ...f.env, HOME23_ROOT } }, execute), { code: 'host_supervisor_unavailable' });
  }
});

test('scheduled product self-restarts keep the guard and strip inherited PM2 metadata', t => {
  const f = fixture(t), calls = [], child = { unref() { calls.push('unref'); } };
  schedulePm2(['restart', 'home23-fixture', '--update-env'], { env: f.env, delayMs: 1000 }, (...call) => { calls.push(call); return child; });
  assert.equal(calls[0][0], process.execPath);
  assert.equal(calls[0][1].at(-1), '1000');
  assert.equal(calls[0][2].detached, true);
  assert.equal(calls[0][2].stdio, 'ignore');
  assert.equal(calls[0][2].env.PM2_HOME, undefined);
  assert.equal(calls[1], 'unref');
});

test('product process observations and verifiers share the guarded client after PM2 env is removed', async t => {
  const f = fixture(t), keys = ['HOME23_PRODUCT_HOST', 'HOME23_ROOT', 'PATH', 'PM2_HOME', 'PM2_DAEMON_RPC_PORT'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.HOME23_PRODUCT_HOST = 'true';
    process.env.HOME23_ROOT = join(f.root, 'app');
    process.env.PATH = f.root;
    delete process.env.PM2_HOME;
    delete process.env.PM2_DAEMON_RPC_PORT;
    const channel = new Pm2Channel();
    assert.deepEqual(await channel.poll(), []);
    assert.equal(channel._seen.get('home23-fixture').status, 'online');
    assert.equal((await runVerifier({ type: 'pm2_status', args: { name: 'home23-fixture' } })).ok, true);
    assert.equal((await crashLoops.run({})).findings[0].code, 'pm2_restart_count_exceeded');
    assert.equal(existsSync(f.marker), false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
