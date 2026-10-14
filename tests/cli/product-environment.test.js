import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { productEnvironment, productRoleEnvironment, withoutSupervisorEnvironment } from '../../cli/lib/product-environment.js';

function fixture(t) {
  const homeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-product-environment-')));
  t.after(() => fs.rmSync(homeRoot, { recursive: true, force: true }));
  return homeRoot;
}

test('product role PATH resolves the packaged PM2 shim before Node and system commands', t => {
  const homeRoot = fixture(t);
  const env = productEnvironment(homeRoot);
  assert.deepEqual(env.PATH.split(path.delimiter), [
    path.join(homeRoot, 'app', 'scripts', 'product', 'shims'),
    path.join(homeRoot, 'bin'),
    '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  ]);
  assert.equal(env.PATH.split(path.delimiter).includes(path.join(homeRoot, 'tools', 'node_modules', 'pm2', 'bin')), false);
  assert.equal(env.HOME23_PRODUCT_HOST, 'true');
  assert.equal(env.HOME23_ROOT, path.join(homeRoot, 'app'));
  assert.deepEqual(fs.readdirSync(homeRoot), [], 'constructing an environment does not create runtime state');
});

test('house roles keep the safe PM2 PATH after supervisor control variables are removed', t => {
  const homeRoot = fixture(t);
  const residentEnvironment = withoutSupervisorEnvironment(productEnvironment(homeRoot));
  assert.equal(Object.keys(residentEnvironment).some(key => /^PM2_/i.test(key)), false);
  assert.equal(residentEnvironment.PATH.split(path.delimiter)[0], path.join(homeRoot, 'app', 'scripts', 'product', 'shims'));
  assert.equal(residentEnvironment.PATH.includes(path.join(homeRoot, 'tools', 'node_modules', 'pm2', 'bin')), false);
  assert.equal(residentEnvironment.HOME23_PRODUCT_HOST, 'true');
  assert.equal(residentEnvironment.HOME, path.join(homeRoot, 'runtime', 'user'));
});

test('preserved role environments cannot replace the shim PATH or product routing', t => {
  const homeRoot = fixture(t), shim = path.join(homeRoot, 'app/scripts/product/shims');
  const rawPm2 = path.join(homeRoot, 'tools/node_modules/pm2/bin');
  const original = { PATH: `${rawPm2}/:${homeRoot}/tools/node_modules/.bin:/custom/tools:${shim}:/usr/bin`,
    HOME23_PRODUCT_HOST: 'false', HOME23_ROOT: '/different/app', PM2_HOME: '/different/supervisor', KEEP: 'preserved' };
  const saved = structuredClone(original), env = productRoleEnvironment(homeRoot, original);
  assert.deepEqual(env.PATH.split(path.delimiter), [shim, path.join(homeRoot, 'bin'),
    path.join(homeRoot, 'tools/node_modules/.bin'), '/custom/tools', '/usr/bin']);
  assert.equal(env.HOME23_PRODUCT_HOST, 'true');
  assert.equal(env.HOME23_ROOT, path.join(homeRoot, 'app'));
  assert.equal(env.PM2_HOME, undefined);
  assert.equal(env.KEEP, 'preserved');
  assert.deepEqual(productRoleEnvironment(homeRoot, env), env, 'normalization is stable across restoration');
  assert.deepEqual(original, saved, 'saved settings remain unchanged');
  assert.deepEqual(fs.readdirSync(homeRoot), [], 'normalization does not create runtime state');
});
