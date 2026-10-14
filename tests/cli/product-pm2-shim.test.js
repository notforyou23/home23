import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runProductPm2Shim } from '../../cli/lib/product-pm2-shim.js';
import { productEnvironment, socketRootFor, withoutSupervisorEnvironment } from '../../cli/lib/product-environment.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RAW = ' [\n  {"name":"home23-fixture","pid":4321,"pm_id":0,"pm2_env":{"status":"online"}}\n]\n';
const ENV = { HOME23_PRODUCT_HOST: 'true', HOME23_ROOT: '/fixture/Home/app' };
function output() {
  const stdout = [], stderr = [];
  return { stdout, stderr, streams: {
    stdout: { write: value => stdout.push(value) }, stderr: { write: value => stderr.push(value) },
  } };
}

test('jlist uses only the guarded supervisor request and preserves exact JSON bytes', async () => {
  const out = output(), calls = [];
  const code = await runProductPm2Shim(['jlist'], { ...out.streams, environment: ENV,
    command: async (...args) => { calls.push(args); return { stdout: RAW, stderr: 'ignored supervisor chatter' }; },
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [['/fixture/Home', ['jlist', '--silent']]]);
  assert.equal(out.stdout.join(''), RAW);
  assert.deepEqual(out.stderr, []);
});

test('list, ls and status render the same guarded read-only inventory', async () => {
  for (const alias of ['list', 'ls', 'status']) {
    const out = output();
    const code = await runProductPm2Shim([alias, '--silent'], { ...out.streams, environment: ENV,
      command: async (home, args) => {
        assert.equal(home, '/fixture/Home'); assert.deepEqual(args, ['jlist', '--silent']);
        return { stdout: RAW };
      },
    });
    assert.equal(code, 0);
    assert.equal(out.stdout.join(''), 'id\tname\tstatus\tpid\n0\thome23-fixture\tonline\t4321\n');
    assert.deepEqual(out.stderr, []);
  }
});

test('start, stop, kill, save, flush and every unsupported command or flag fail before the client', async () => {
  for (const args of [[], ...['start', 'stop', 'kill', 'save', 'flush', 'restart', 'delete', 'update', 'logs'].map(cmd => [cmd]),
    ['jlist', '--no-daemon'], ['jlist', 'start'], ['jlist', '--silent', 'kill'], ['--no-daemon', 'jlist']]) {
    const out = output();
    const code = await runProductPm2Shim(args, { ...out.streams, environment: ENV,
      command: () => assert.fail('unsupported requests must never reach the supervisor'),
    });
    assert.equal(code, 1); assert.deepEqual(out.stdout, []);
    assert.match(out.stderr.join(''), /Use the Home23 Host/);
  }
});

test('missing product context and invalid home roots fail without any PM2 fallback', async () => {
  for (const environment of [{}, { ...ENV, HOME23_PRODUCT_HOST: '' },
    { ...ENV, HOME23_ROOT: undefined }, { ...ENV, HOME23_ROOT: 'app' }, { ...ENV, HOME23_ROOT: '/fixture/elsewhere' }]) {
    const out = output();
    assert.equal(await runProductPm2Shim(['jlist'], { ...out.streams, environment,
      command: () => assert.fail('unroutable requests must never reach the supervisor'),
    }), 1);
    assert.deepEqual(out.stdout, []); assert.match(out.stderr.join(''), /Home23/);
  }
});

test('unavailable, empty or invalid supervisor output fails without successful JSON or leaked errors', async () => {
  for (const command of [async () => { throw new Error('private error details'); },
    ...['', 'PM2 booting\n[]', '{}', 'null'].map(stdout => async () => ({ stdout }))]) {
    const out = output();
    assert.equal(await runProductPm2Shim(['jlist'], { ...out.streams, environment: ENV, command }), 1);
    assert.deepEqual(out.stdout, []);
    assert.match(out.stderr.join(''), /supervisor is unavailable.*cannot create a PM2 daemon/);
    assert.doesNotMatch(out.stderr.join(''), /private error details/);
  }
});

function installedFixture(t, supervisor) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-pm2-shim-')));
  const home = path.join(base, 'Home with spaces');
  t.after(() => { fs.rmSync(base, { recursive: true, force: true }); fs.rmSync(socketRootFor(home), { recursive: true, force: true }); });
  for (const dir of ['bin', 'app/cli/lib', 'app/scripts/product/shims']) fs.mkdirSync(path.join(home, dir), { recursive: true });
  fs.writeFileSync(path.join(home, 'app/package.json'), '{"type":"module"}');
  for (const file of ['scripts/product/shims/pm2', 'cli/lib/product-pm2-shim.js']) {
    fs.copyFileSync(path.join(ROOT, file), path.join(home, 'app', file));
  }
  fs.symlinkSync(process.execPath, path.join(home, 'bin/node'));
  const marker = path.join(home, 'raw-pm2-invoked');
  fs.writeFileSync(path.join(home, 'bin/pm2'), `#!/bin/sh\n: > '${marker}'\nexit 88\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(home, 'app/cli/lib/product-supervisor.js'), supervisor);
  const env = withoutSupervisorEnvironment(productEnvironment(home, { prepare: true }));
  return { home, marker, env };
}

test('a workspace child resolves the executable packaged shim first with PM2 metadata stripped', t => {
  const f = installedFixture(t, `
    export async function productSupervisorCommand(home, args) {
      if (home !== process.env.HOME23_ROOT.slice(0, -4) || JSON.stringify(args) !== '["jlist","--silent"]') throw new Error('wrong routing');
      if (Object.keys(process.env).some(key => key.startsWith('PM2_'))) throw new Error('inherited PM2 metadata');
      return { stdout: ${JSON.stringify(RAW)} };
    }
  `);
  const child = spawnSync('pm2', ['jlist'], { env: f.env, encoding: 'utf8', timeout: 5000 });
  assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, RAW); assert.equal(child.stderr, '');
  assert.equal(fs.existsSync(f.marker), false);
  assert.equal(fs.existsSync(path.join(f.env.HOME, '.pm2')), false);
});

test('missing supervisor socket makes the packaged shim fail without a raw PM2 invocation or daemon state', t => {
  const f = installedFixture(t, `
    import { connect } from 'node:net';
    export async function productSupervisorCommand(home, args) {
      if (JSON.stringify(args) !== '["jlist","--silent"]') throw new Error('wrong routing');
      await new Promise((resolve, reject) => {
        const socket = connect(home + '/runtime/missing-supervisor.sock');
        socket.once('connect', () => { socket.destroy(); resolve(); });
        socket.once('error', reject);
      });
      throw new Error('fixture socket must be absent');
    }
  `);
  const before = fs.readdirSync(path.join(f.home, 'runtime/pm2'));
  const child = spawnSync('pm2', ['jlist'], { env: f.env, encoding: 'utf8', timeout: 5000 });
  assert.equal(child.error, undefined); assert.equal(child.status, 1);
  assert.equal(child.stdout, ''); assert.match(child.stderr, /supervisor is unavailable.*cannot create a PM2 daemon/);
  assert.equal(fs.existsSync(f.marker), false);
  assert.equal(fs.existsSync(path.join(f.env.HOME, '.pm2')), false);
  assert.deepEqual(fs.readdirSync(path.join(f.home, 'runtime/pm2')), before);
});
