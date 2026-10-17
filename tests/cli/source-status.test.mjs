import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sourceStatus } from '../../scripts/release/source-status.mjs';
import { writeProductManifest } from '../../cli/lib/product-payload.js';

function productHomeFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-product-source-authority-')));
  const home = path.join(root, 'home');
  const app = path.join(home, 'app');
  const write = (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  };
  for (const relative of ['bin/node', 'app/cli/home23.js', 'app/cli/lib/product-payload.js', 'app/scripts/product/host.mjs', 'tools/node_modules/pm2/bin/pm2']) {
    write(path.join(home, relative), 'fixture');
  }
  fs.chmodSync(path.join(home, 'bin/node'), 0o755);
  const product = writeProductManifest(home, { sourceCommit: 'a'.repeat(40), platform: 'darwin', arch: 'arm64', nodeVersion: 'v22.19.0' });
  const development = Object.fromEntries(['backend', 'apple'].map(component => {
    const directory = path.join(root, component);
    fs.mkdirSync(path.join(directory, '.git'), { recursive: true });
    return [component, directory];
  }));
  const record = { schemaVersion: 2, development, recordedAt: '2026-10-17T23:00:00.000Z', recordedBy: 'owner-authorized-repair' };
  const authority = path.join(app, 'instances/.house/source-authority.json');
  write(authority, record);
  return { root, home, app, product, development, record, authority, write };
}

test('v2 maps a product home to maintained sources without inventing a preservation baseline', () => {
  const fixture = productHomeFixture();
  try {
    const before = fs.readFileSync(fixture.authority, 'utf8');
    const manifestBefore = fs.readFileSync(path.join(fixture.home, 'manifest.json'), 'utf8');
    const result = sourceStatus(fixture.app);
    assert.equal(result.ok, true);
    assert.equal(result.schemaVersion, 2);
    assert.equal(result.installationRoot, fs.realpathSync(fixture.app));
    assert.equal(result.productHomeRoot, fs.realpathSync(fixture.home));
    assert.deepEqual(result.development, fixture.development);
    assert.equal(result.selectedProduct.packageId, fixture.product.packageId);
    assert.equal(result.selectedProduct.sourceCommit, fixture.product.sourceCommit);
    assert.equal(result.recordedAt, fixture.record.recordedAt);
    assert.equal(result.recordedBy, fixture.record.recordedBy);
    assert.equal(result.preservation, null);
    assert.equal(result.changesSinceReconciledBaseline, null);
    assert.equal(result.installedAppleBuild, undefined);
    assert.equal(result.deployedReleaseId, undefined);
    assert(result.limits.some(value => /No byte.*baseline/.test(value)));
    assert(result.limits.some(value => /physical.*acceptance/.test(value)));
    assert(result.limits.some(value => /manifest.*runtime.*bytes/.test(value)));
    assert.equal(fs.readFileSync(fixture.authority, 'utf8'), before);
    assert.equal(fs.readFileSync(path.join(fixture.home, 'manifest.json'), 'utf8'), manifestBefore);
    assert.equal(fs.existsSync(path.join(fixture.app, 'instances/.house/coordination/active-release.json')), false);
    assert.equal(fs.existsSync(path.join(fixture.app, 'instances/.house/home23-ios.json')), false);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('v2 refuses malformed or unavailable maintained source mappings', async t => {
  const variants = [
    ['missing development', record => { delete record.development; }],
    ['missing Apple source', record => { delete record.development.apple; }],
    ['relative backend source', record => { record.development.backend = 'backend'; }],
    ['unavailable backend source', record => { record.development.backend += '-missing'; }],
    ['missing timestamp', record => { delete record.recordedAt; }],
    ['invalid timestamp', record => { record.recordedAt = 'not-a-date'; }],
    ['missing actor', record => { delete record.recordedBy; }],
    ['blank actor', record => { record.recordedBy = ' '; }],
  ];
  for (const [name, mutate] of variants) {
    await t.test(name, () => {
      const fixture = productHomeFixture();
      try {
        mutate(fixture.record);
        fixture.write(fixture.authority, fixture.record);
        assert.throws(() => sourceStatus(fixture.app), /Source authority/);
      } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
    });
  }
  await t.test('source directory must identify a Git repository', () => {
    const fixture = productHomeFixture();
    try {
      fs.rmSync(path.join(fixture.development.backend, '.git'), { recursive: true });
      assert.throws(() => sourceStatus(fixture.app), /Source authority/);
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
  });
});

test('v2 uses the official product manifest validation instead of trusting a package claim', () => {
  const fixture = productHomeFixture();
  try {
    fixture.write(path.join(fixture.home, 'manifest.json'), { ...fixture.product, sourceCommit: 'b'.repeat(40) });
    assert.throws(() => sourceStatus(fixture.app), /Invalid or changed Home23 product manifest/);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('source check distinguishes deployment drift from working edits without mutating either', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-source-authority-'));
  const write = (file, data) => { const p = path.join(root, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(data)); };
  try {
    for (const name of ['backend', 'apple']) {
      fs.mkdirSync(path.join(root, name)); fs.writeFileSync(path.join(root, name, 'source.txt'), 'original');
      write(`${name}.json`, [{ path: 'source.txt', sha256: createHash('sha256').update('original').digest('hex') }]);
    }
    write('instances/.house/source-authority.json', { schemaVersion: 1, deployedReleaseId: 'current', appleContractSHA256: 'pack', development: { backend: path.join(root, 'backend'), apple: path.join(root, 'apple') }, sourceManifests: { backend: path.join(root, 'backend.json'), apple: path.join(root, 'apple.json') }, preservation: root });
    write('instances/.house/coordination/active-release.json', { releaseId: 'current' });
    write('instances/.house/home23-ios.json', { sourceRoot: path.join(root, 'apple'), contractSHA256: 'pack', installedBuild: 119 });
    assert.equal(sourceStatus(root).ok, true);
    fs.writeFileSync(path.join(root, 'backend/source.txt'), 'working edit');
    assert.deepEqual(sourceStatus(root).changesSinceReconciledBaseline.backend, ['source.txt']);
    write('instances/.house/coordination/active-release.json', { releaseId: 'newer' });
    assert.equal(sourceStatus(root).ok, false);
    assert.equal(fs.readFileSync(path.join(root, 'backend/source.txt'), 'utf8'), 'working edit');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
