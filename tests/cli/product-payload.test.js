import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { writeProductManifest, verifyProductPayload, installProductPayload } from '../../cli/lib/product-payload.js';

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-product-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const payload = path.join(base, 'payload'), homeRoot = path.join(base, 'A new home');
  for (const [relative, contents] of Object.entries({ 'bin/node': 'test executable\n', 'app/cli/home23.js': 'export {};\n',
    'app/cli/lib/product-payload.js': 'export {};\n', 'app/scripts/product/host.mjs': 'export {};\n',
    'tools/node_modules/pm2/bin/pm2': 'test process manager\n', 'app/config/home.yaml.example': 'home: {}\n' })) {
    const file = path.join(payload, relative); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, contents, { mode: relative === 'bin/node' ? 0o755 : 0o644 });
  }
  fs.mkdirSync(path.join(payload, 'tools/node_modules/.bin'), { mode: 0o755 });
  fs.symlinkSync('../pm2/bin/pm2', path.join(payload, 'tools/node_modules/.bin/pm2'));
  const manifest = writeProductManifest(payload, { sourceCommit: 'a'.repeat(40), platform: process.platform, arch: process.arch, nodeVersion: 'v22.23.2' });
  return { base, payload, homeRoot, manifest };
}

test('installs complete verified payload and exact retry preserves lived state', t => {
  const { payload, homeRoot, manifest } = fixture(t);
  const result = installProductPayload({ payloadPath: payload, homeRoot });
  assert.equal(result.status, 'installed'); assert.equal(result.packageId, manifest.packageId); assert.equal(result.replayed, false);
  assert.equal(result.appRoot, path.join(homeRoot, 'app'));
  assert.equal(fs.readlinkSync(path.join(homeRoot, 'tools/node_modules/.bin/pm2')), '../pm2/bin/pm2');
  fs.mkdirSync(path.join(homeRoot, 'app/instances/milo'), { recursive: true });
  fs.writeFileSync(path.join(homeRoot, 'app/instances/milo/lived.json'), 'real future contact');
  fs.writeFileSync(path.join(homeRoot, 'app/config/home.yaml'), 'owner: new owner');
  assert.equal(installProductPayload({ payloadPath: payload, homeRoot }).replayed, true);
  assert.equal(fs.readFileSync(path.join(homeRoot, 'app/instances/milo/lived.json'), 'utf8'), 'real future contact');
});

test('refuses changed payload files, executable modes, and undeclared additions before installing', t => {
  const { payload, homeRoot } = fixture(t);
  const node = path.join(payload, 'bin/node');
  fs.chmodSync(node, 0o644);
  assert.throws(() => installProductPayload({ payloadPath: payload, homeRoot }), /Product file changed/);
  assert.equal(fs.existsSync(homeRoot), false);
  fs.chmodSync(node, 0o755); fs.appendFileSync(node, 'changed');
  assert.throws(() => verifyProductPayload(payload), /Product file changed/);
});

test('refuses an unowned destination and never overwrites its files', t => {
  const { payload, homeRoot } = fixture(t);
  fs.mkdirSync(homeRoot); fs.writeFileSync(path.join(homeRoot, 'owner.txt'), 'keep');
  assert.throws(() => installProductPayload({ payloadPath: payload, homeRoot }), /Refusing to adopt/);
  assert.equal(fs.readFileSync(path.join(homeRoot, 'owner.txt'), 'utf8'), 'keep');
});

test('resumes an interrupted claimed copy and recovers a dead installer lock', t => {
  const { base, payload, homeRoot, manifest } = fixture(t), id = randomUUID(), name = path.basename(homeRoot);
  const claim = { schema: 'home23.product-install.v1', id, homeRoot, packageId: manifest.packageId, status: 'copying' };
  fs.writeFileSync(path.join(base, `.${name}.home23-install.json`), JSON.stringify(claim));
  fs.writeFileSync(path.join(base, `.${name}.home23-install.lock`), JSON.stringify({ pid: 2147483647 }));
  const stage = path.join(base, `.${name}.home23-stage-${id}`);
  fs.mkdirSync(path.join(stage, 'bin'), { recursive: true, mode: 0o755 });
  fs.copyFileSync(path.join(payload, 'bin/node'), path.join(stage, 'bin/node'));
  fs.mkdirSync(path.join(stage, 'app/cli'), { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(stage, 'app/cli/home23.js.home23-copy'), 'interrupted bytes');
  assert.equal(installProductPayload({ payloadPath: payload, homeRoot }).status, 'installed');
  assert.equal(fs.existsSync(stage), false);
  assert.equal(fs.existsSync(path.join(homeRoot, 'app/cli/home23.js.home23-copy')), false);
});

test('refuses another active installer and another package claim', t => {
  const { base, payload, homeRoot } = fixture(t), name = path.basename(homeRoot);
  const lock = path.join(base, `.${name}.home23-install.lock`);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  assert.throws(() => installProductPayload({ payloadPath: payload, homeRoot }), /already in progress/);
  fs.unlinkSync(lock);
  fs.writeFileSync(path.join(base, `.${name}.home23-install.json`), JSON.stringify({ schema: 'home23.product-install.v1', id: randomUUID(), homeRoot, packageId: 'different' }));
  assert.throws(() => installProductPayload({ payloadPath: payload, homeRoot }), /another package/);
});

test('refuses escaping links and symlink installation ancestors', t => {
  const { base, payload } = fixture(t);
  fs.symlinkSync(base, path.join(base, 'destination-link'));
  assert.throws(() => installProductPayload({ payloadPath: payload, homeRoot: path.join(base, 'destination-link/new-home') }), /real directory/);
  const link = path.join(payload, 'tools/node_modules/.bin/pm2');
  fs.unlinkSync(link); fs.symlinkSync('../../../../outside', link);
  assert.throws(() => verifyProductPayload(payload), /symlink/);
});

test('refuses private state in even a freshly recomputed payload manifest', t => {
  const { payload } = fixture(t);
  fs.unlinkSync(path.join(payload, 'manifest.json'));
  fs.mkdirSync(path.join(payload, 'app/instances/private-resident'), { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(payload, 'app/instances/private-resident/memory.txt'), 'private', { mode: 0o644 });
  writeProductManifest(payload, { sourceCommit: 'a'.repeat(40), platform: process.platform, arch: process.arch, nodeVersion: 'v22.23.2' });
  assert.throws(() => verifyProductPayload(payload), /installation state/);
});

test('an installed payload cannot be silently repaired over modified source', t => {
  const { payload, homeRoot } = fixture(t);
  installProductPayload({ payloadPath: payload, homeRoot });
  const file = path.join(homeRoot, 'app/cli/home23.js'); fs.appendFileSync(file, '// locally changed');
  assert.throws(() => installProductPayload({ payloadPath: payload, homeRoot }), /Product file changed/);
  assert.match(fs.readFileSync(file, 'utf8'), /locally changed/);
});
