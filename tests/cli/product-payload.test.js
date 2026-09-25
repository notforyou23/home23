import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { writeProductManifest, verifyProductPayload, installProductPayload, isProductStatePath, isOsMetadataPath } from '../../cli/lib/product-payload.js';

test('mixed operator roots retain state without absorbing maintained software', () => {
  for (const path of ['app/workspace/skills/index.js', 'app/configs/base-engine.yaml',
    'app/configs/action-allowlist.yaml', 'app/agency/charter.yaml', 'app/engine/config/image.json']) {
    assert.equal(isProductStatePath(path), false, path);
  }
  for (const path of ['app/workspace/operator-note.md', 'app/configs/local.yaml',
    'app/agency/local.json', 'app/engine/config/local.json']) {
    assert.equal(isProductStatePath(path), true, path);
  }
});

test('a packaged skill keeps its runtime data beside its code as preserved state', () => {
  for (const path of ['app/workspace/skills/x-research/data', 'app/workspace/skills/x-research/data/cache/37cd32e1dc4e.json']) {
    assert.equal(isProductStatePath(path), true, path);
  }
  for (const path of ['app/workspace/skills/x-research/index.js', 'app/workspace/skills/x-research/SKILL.md',
    'app/workspace/skills/x-research/references/api.md', 'app/workspace/skills/data', 'app/workspace/skills/x-research/database.js']) {
    assert.equal(isProductStatePath(path), false, path);
  }
});

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

test('state policy retains the Evobrew prefix exclusion from shipped payloads', t => {
  const { payload } = fixture(t);
  const directory = path.join(payload, 'app/evobrew/config.json');
  fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(directory, 'private-state'), 'must stay local');
  fs.unlinkSync(path.join(payload, 'manifest.json'));
  writeProductManifest(payload, { sourceCommit: 'a'.repeat(40), platform: process.platform, arch: process.arch, nodeVersion: 'v22.23.2' });
  assert.throws(() => verifyProductPayload(payload), /cannot contain installation state/);
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

test('Finder and other OS metadata is recognised by name at any depth', () => {
  for (const path of ['.DS_Store', 'app/config/.DS_Store', 'app/cli/lib/.DS_Store', 'app/cli/._home23.js', '._manifest.json',
    '.Spotlight-V100/Store-V2/index', '.fseventsd/fseventsd-uuid', '.Trashes/501/old.txt', '.TemporaryItems/folders.501',
    'tools/node_modules/Thumbs.db', 'app/desktop.ini', 'app/config/thumbs.db']) {
    assert.equal(isOsMetadataPath(path), true, path);
  }
  for (const path of ['app/config/home.yaml.bak', 'app/config/DS_Store', 'app/cli/_home23.js', 'app/cli/home23.js',
    'app/.gitkeep', 'app/instances/milo/lived.json', 'app/Trashes', 'tools/node_modules/.bin/pm2']) {
    assert.equal(isOsMetadataPath(path), false, path);
  }
});

const OS_METADATA_FILES = ['.DS_Store', 'app/.DS_Store', 'app/config/.DS_Store', 'app/cli/lib/.DS_Store', 'app/cli/._home23.js',
  'tools/node_modules/Thumbs.db', 'app/desktop.ini', '.Spotlight-V100/Store-V2/index', '.fseventsd/fseventsd-uuid',
  '.Trashes/501/old.txt', '.TemporaryItems/folders.501'];
function browseInFinder(root) {
  for (const relative of OS_METADATA_FILES) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), 'desktop metadata', { mode: 0o600 });
  }
}

test('OS metadata never enters a package and does not stop verification, install or Start', t => {
  const { payload, homeRoot } = fixture(t);
  // Finder browsed the extracted package before its manifest was written.
  fs.unlinkSync(path.join(payload, 'manifest.json'));
  browseInFinder(payload);
  const manifest = writeProductManifest(payload, { sourceCommit: 'a'.repeat(40), platform: process.platform, arch: process.arch, nodeVersion: 'v22.23.2' });
  assert.equal(manifest.files.some(entry => isOsMetadataPath(entry.path)), false);
  assert.equal(verifyProductPayload(payload).packageId, manifest.packageId);
  assert.equal(installProductPayload({ payloadPath: payload, homeRoot }).status, 'installed');
  for (const relative of OS_METADATA_FILES) assert.equal(fs.existsSync(path.join(homeRoot, relative)), false, relative);
  // Browsing the installed home must not make Start or an update refuse it.
  browseInFinder(homeRoot);
  fs.writeFileSync(path.join(homeRoot, 'app/config/home.yaml'), 'owner: new owner');
  assert.equal(verifyProductPayload(homeRoot, { allowRuntimeState: true }).packageId, manifest.packageId);
  assert.equal(installProductPayload({ payloadPath: payload, homeRoot }).replayed, true);
});

test('genuinely unknown files stay refused and the error names them, bounded to ten', t => {
  const { payload, homeRoot } = fixture(t);
  installProductPayload({ payloadPath: payload, homeRoot });
  fs.writeFileSync(path.join(homeRoot, 'app/config/.DS_Store'), 'desktop metadata');
  fs.writeFileSync(path.join(homeRoot, 'app/config/home.yaml.bak'), 'owner: backup');
  assert.throws(() => verifyProductPayload(homeRoot, { allowRuntimeState: true }),
    error => error.message === 'Unexpected product file: app/config/home.yaml.bak');
  for (let index = 0; index < 12; index += 1) fs.writeFileSync(path.join(homeRoot, `stray-${String(index).padStart(2, '0')}.bin`), 'stray');
  const shown = ['app/config/home.yaml.bak', ...Array.from({ length: 9 }, (_, index) => `stray-${String(index).padStart(2, '0')}.bin`)];
  assert.throws(() => verifyProductPayload(homeRoot, { allowRuntimeState: true }),
    error => error.message === `Unexpected product files: ${shown.join(', ')} (and 3 more)`);
});
