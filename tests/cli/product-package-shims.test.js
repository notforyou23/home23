import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installProductPayload, verifyProductPayload, writeProductManifest } from '../../cli/lib/product-payload.js';

const shimRelative = 'app/scripts/product/shims/pm2';
const shimSource = fileURLToPath(new URL('../../scripts/product/shims/pm2', import.meta.url));

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-product-shims-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const payload = path.join(base, 'payload');
  for (const relative of ['bin/node', 'app/cli/home23.js', 'app/cli/lib/product-payload.js',
    'app/scripts/product/host.mjs', 'tools/node_modules/pm2/bin/pm2']) {
    const file = path.join(payload, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, 'fixture only; never executed\n', { mode: relative === 'bin/node' ? 0o755 : 0o644 });
  }
  fs.mkdirSync(path.dirname(path.join(payload, shimRelative)), { recursive: true, mode: 0o755 });
  fs.copyFileSync(shimSource, path.join(payload, shimRelative));
  const helperSource = fileURLToPath(new URL('../../cli/lib/product-pm2-shim.js', import.meta.url));
  fs.copyFileSync(helperSource, path.join(payload, 'app/cli/lib/product-pm2-shim.js'));
  const manifest = writeProductManifest(payload, {
    sourceCommit: 'a'.repeat(40), platform: process.platform, arch: process.arch, nodeVersion: 'v22.23.2',
  });
  return { payload, homeRoot: path.join(base, 'home'), manifest };
}

test('product inventory and install retain the packaged PM2 shim executable and helper', t => {
  assert.equal(fs.statSync(shimSource).mode & 0o7777, 0o755, 'Git archive must receive an executable source shim');
  const { payload, homeRoot, manifest } = fixture(t);
  assert.equal(manifest.files.find(entry => entry.path === shimRelative)?.mode, 0o755);
  assert.equal(manifest.files.find(entry => entry.path === 'app/cli/lib/product-pm2-shim.js')?.type, 'file');
  assert.equal(verifyProductPayload(payload).packageId, manifest.packageId);
  installProductPayload({ payloadPath: payload, homeRoot });
  assert.equal(fs.statSync(path.join(homeRoot, shimRelative)).mode & 0o7777, 0o755);
  assert.deepEqual(fs.readFileSync(path.join(homeRoot, shimRelative)), fs.readFileSync(shimSource));
});

test('product verification refuses a shim that loses its executable mode', t => {
  const { payload } = fixture(t);
  fs.chmodSync(path.join(payload, shimRelative), 0o644);
  assert.throws(() => verifyProductPayload(payload), /Product file changed: app\/scripts\/product\/shims\/pm2/);
});
