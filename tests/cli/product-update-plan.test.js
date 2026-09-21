import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inspectStatePreservation, compareUpdateContracts } from '../../cli/lib/product-update-plan.js';

function tempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-plan-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function entry(file, bytes = 'x', mode = 0o644) {
  return { path: file, type: 'file', mode, size: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex') };
}
function manifest(files) {
  return { schema: 'home23.product-payload.v1', sourceCommit: 'a'.repeat(40), platform: process.platform, arch: process.arch, nodeVersion: 'v22.19.0', files };
}
function contractManifest({ migrationBytes = 'migration', extraMigration = false, contractBytes = 'contracts', includeContracts = true } = {}) {
  const files = [
    entry('app/dist/coordination/migrations/index.js', migrationBytes),
    entry('app/dist/coordination/migrations/0001-coordination-spine.js', 'one'),
  ];
  if (extraMigration) files.push(entry('app/dist/coordination/migrations/0002-next.js', 'two'));
  if (includeContracts) {
    files.push(entry('app/dist/coordination/contracts/v1/pack-manifest.json', contractBytes));
    files.push(entry('app/dist/coordination/contracts/v1/schema.json', 'schema'));
  }
  return manifest(files);
}

test('state plan classifies fixed roots without opening protected content', t => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, 'app/instances/jerry/brain'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app/instances/jerry/brain/poison'), 'not-json and must not be read', { mode: 0o000 });
  fs.mkdirSync(path.join(root, 'app/config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app/config/secrets.yaml'), 'secret: must not be read', { mode: 0o000 });
  fs.writeFileSync(path.join(root, '.home23-install.json'), '{}');
  const result = inspectStatePreservation(root);
  assert.equal(result.schema, 'home23.product-preservation.v1');
  assert.equal(result.scope, 'declared_state_roots');
  assert.equal(result.complete, false);
  assert.ok(result.paths.some(item => item.path === 'app/instances' && item.status === 'present'));
  assert.ok(result.paths.some(item => item.path === 'app/config/secrets.yaml' && item.status === 'present'));
  assert.ok(result.paths.some(item => item.path === 'app/instances' && item.role === 'preserve'));
  assert.ok(result.paths.some(item => item.path === '.home23-install.json' && item.role === 'rebind'));
  assert.deepEqual(result.issues, []);
});

test('state plan reports missing, wrong-type, and linked roots without following links', t => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, '.home23-host.json'), 'state');
  fs.mkdirSync(path.join(root, 'app/config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app/config/home.yaml')); // declared file with wrong type
  fs.symlinkSync('/tmp', path.join(root, 'app/instances')); // declared directory; must not recurse/follow
  fs.symlinkSync('/tmp/missing', path.join(root, 'app/ecosystem.config.cjs')); // declared file leaf
  const result = inspectStatePreservation(root);
  assert.ok(result.paths.some(item => item.path === 'app/config/home.yaml' && item.status === 'type_mismatch'));
  assert.ok(result.paths.some(item => item.path === 'app/instances' && item.status === 'linked'));
  assert.ok(result.paths.some(item => item.path === 'app/ecosystem.config.cjs' && item.status === 'linked'));
  assert.ok(result.issues.filter(item => item.code === 'linked_state_path').length >= 2);
  assert.ok(result.paths.some(item => item.status === 'absent'));
  const external = tempRoot(t); fs.writeFileSync(path.join(external, 'home.yaml'), 'private content');
  fs.rmSync(path.join(root, 'app/config'), { recursive: true });
  fs.symlinkSync(external, path.join(root, 'app/config'));
  const linkedParent = inspectStatePreservation(root);
  assert.ok(linkedParent.paths.filter(item => item.path.startsWith('app/config/')).every(item => item.status === 'linked'));
});

test('contract comparison is order independent and detects changed, added, or removed assets', () => {
  const current = contractManifest();
  const reordered = manifest([...current.files].reverse());
  const same = compareUpdateContracts(current, reordered);
  assert.equal(same.complete, false);
  assert.equal(same.groups.coordinationMigrations.status, 'unchanged');
  assert.equal(same.groups.coordinationContracts.status, 'unchanged');
  const changed = compareUpdateContracts(current, contractManifest({ migrationBytes: 'changed', extraMigration: true, contractBytes: 'changed' }));
  assert.equal(changed.groups.coordinationMigrations.status, 'changed');
  assert.equal(changed.groups.coordinationContracts.status, 'changed');
  assert.ok(changed.groups.coordinationMigrations.changedPaths.includes('app/dist/coordination/migrations/0002-next.js'));
  assert.ok(changed.groups.coordinationContracts.changedPaths.includes('app/dist/coordination/contracts/v1/pack-manifest.json'));
  const removed = compareUpdateContracts(current, contractManifest({ includeContracts: false }));
  assert.equal(removed.groups.coordinationContracts.status, 'unavailable');
});
