const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile: execFileCallback } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const execFile = promisify(execFileCallback);

async function git(cwd, args) {
  return (await execFile('git', args, { cwd, encoding: 'utf8' })).stdout.trim();
}

async function write(root, relative, value) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value);
}

async function fixture({ conflict = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-deployment-tree-')));
  const liveRoot = path.join(root, 'live');
  const receiptRunDir = path.join(root, 'receipt-run');
  const auditDir = path.join(receiptRunDir, 'deployment-audit');
  await fs.mkdir(liveRoot);
  await fs.mkdir(receiptRunDir);
  await git(liveRoot, ['init', '--quiet']);
  await git(liveRoot, ['config', 'user.email', 'fixture@example.invalid']);
  await git(liveRoot, ['config', 'user.name', 'Fixture']);
  await write(liveRoot, 'feature-change.txt', 'base feature\n');
  await write(liveRoot, 'staged.txt', 'base staged\n');
  await write(liveRoot, 'unstaged.txt', 'base unstaged\n');
  await write(liveRoot, 'local-delete.txt', 'base local delete\n');
  await write(liveRoot, 'removed-by-feature.txt', 'base remove\n');
  await write(liveRoot, 'merge.txt', 'alpha\nbeta\ngamma\n');
  await write(liveRoot, 'collision.txt', 'base collision\n');
  await git(liveRoot, ['add', '-A']);
  await git(liveRoot, ['commit', '--quiet', '-m', 'base']);
  const base = await git(liveRoot, ['rev-parse', 'HEAD']);

  await write(liveRoot, 'feature-change.txt', 'feature committed\n');
  await write(liveRoot, 'feature-new.txt', 'feature new\n');
  await fs.rm(path.join(liveRoot, 'removed-by-feature.txt'));
  await write(liveRoot, 'merge.txt', 'feature alpha\nbeta\ngamma\n');
  if (conflict) await write(liveRoot, 'collision.txt', 'feature collision\n');
  await git(liveRoot, ['add', '-A']);
  await git(liveRoot, ['commit', '--quiet', '-m', 'feature']);
  const feature = await git(liveRoot, ['rev-parse', 'HEAD']);

  await git(liveRoot, ['checkout', '--quiet', base]);
  await write(liveRoot, 'staged.txt', 'local staged\n');
  await git(liveRoot, ['add', 'staged.txt']);
  await write(liveRoot, 'unstaged.txt', 'local unstaged\n');
  await fs.rm(path.join(liveRoot, 'local-delete.txt'));
  await write(liveRoot, 'local-new.txt', 'local tracked addition\n');
  await git(liveRoot, ['add', 'local-new.txt']);
  await write(liveRoot, 'merge.txt', 'alpha\nbeta\nlocal gamma\n');
  if (conflict) await write(liveRoot, 'collision.txt', 'local collision\n');
  await write(liveRoot, 'unrelated.tmp', 'operator untracked bytes\n');

  const indexPath = await git(liveRoot, ['rev-parse', '--git-path', 'index']);
  const absoluteIndex = path.isAbsolute(indexPath) ? indexPath : path.join(liveRoot, indexPath);
  const context = {
    receiptRunDir,
    receiptRunId: 'deployment-fixture',
    authority: 'isolated-controlled',
    implementationCommit: feature,
    hostname: 'fixture-host',
    startedAt: '2026-07-10T00:00:00.000Z',
  };
  return { root, liveRoot, receiptRunDir, auditDir, base, feature, context, absoluteIndex };
}

async function applyExpected(state) {
  for (const relative of state.expectedAbsent) {
    await fs.rm(path.join(state.liveRoot, relative), { recursive: true, force: true });
  }
  for (const entry of state.expectedManifest) {
    const source = path.join(state.expectedRoot, entry.path);
    const destination = path.join(state.liveRoot, entry.path);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const stat = await fs.lstat(source);
    if (stat.isSymbolicLink()) {
      await fs.rm(destination, { force: true });
      await fs.symlink(await fs.readlink(source), destination);
    } else {
      await fs.copyFile(source, destination);
      await fs.chmod(destination, entry.mode === '100755' ? 0o755 : 0o644);
    }
  }
}

test('prepare writes only an external expected tree and one row per pending path', async (t) => {
  const { prepareDeploymentTree } = await import('../../scripts/verify-live-deployment-tree.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const indexBefore = await fs.readFile(state.absoluteIndex);
  const unrelatedBefore = crypto.createHash('sha256')
    .update(await fs.readFile(path.join(state.liveRoot, 'unrelated.tmp'))).digest('hex');
  const prepared = await prepareDeploymentTree(state);
  assert.equal(prepared.conflicts.length, 0);
  assert.equal(prepared.expectedRoot.startsWith(`${state.receiptRunDir}${path.sep}`), true);
  assert.deepEqual(await fs.readFile(state.absoluteIndex), indexBefore);
  assert.equal(crypto.createHash('sha256')
    .update(await fs.readFile(path.join(state.liveRoot, 'unrelated.tmp'))).digest('hex'), unrelatedBefore);
  const rows = (await fs.readFile(path.join(state.auditDir, 'three-way.jsonl'), 'utf8'))
    .trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(new Set(rows.map((row) => row.path)).size, rows.length);
  assert.ok(rows.length > 0);
  assert.ok(rows.length < prepared.expectedManifest.length + prepared.expectedAbsent.length);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).includes('baseOid'), true);
    assert.deepEqual(Object.keys(row).includes('featureOid'), true);
    assert.deepEqual(Object.keys(row).includes('liveHash'), true);
    assert.deepEqual(Object.keys(row).includes('mergedHash'), true);
    assert.ok(['feature', 'live', 'identical', 'merged'].includes(row.resolution));
  }
});

test('seal and verify prove the exact combined working tree without changing the live index', async (t) => {
  const {
    prepareDeploymentTree,
    sealDeploymentTree,
    verifyDeploymentTree,
  } = await import('../../scripts/verify-live-deployment-tree.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const indexBefore = await fs.readFile(state.absoluteIndex);
  const prepared = await prepareDeploymentTree(state);
  const sealed = await sealDeploymentTree({ auditDir: state.auditDir, context: state.context });
  assert.match(sealed.expectedTree, /^[a-f0-9]{40,64}$/);
  await applyExpected(prepared);
  const verified = await verifyDeploymentTree({ auditDir: state.auditDir, context: state.context });
  assert.equal(verified.actualTree, sealed.expectedTree);
  assert.deepEqual(await fs.readFile(state.absoluteIndex), indexBefore);
  assert.equal(await fs.readFile(path.join(state.liveRoot, 'unrelated.tmp'), 'utf8'), 'operator untracked bytes\n');
});

test('conflicts block sealing and one-byte or unrelated-untracked drift blocks verification', async (t) => {
  const {
    prepareDeploymentTree,
    sealDeploymentTree,
    verifyDeploymentTree,
  } = await import('../../scripts/verify-live-deployment-tree.mjs');
  const conflict = await fixture({ conflict: true });
  t.after(() => fs.rm(conflict.root, { recursive: true, force: true }));
  await assert.rejects(prepareDeploymentTree(conflict), (error) => error.code === 'deployment_tree_conflict');
  await assert.rejects(sealDeploymentTree({
    auditDir: conflict.auditDir, context: conflict.context,
  }), (error) => error.code === 'deployment_tree_not_prepared');

  const drift = await fixture();
  t.after(() => fs.rm(drift.root, { recursive: true, force: true }));
  const prepared = await prepareDeploymentTree(drift);
  await sealDeploymentTree({ auditDir: drift.auditDir, context: drift.context });
  await applyExpected(prepared);
  await fs.appendFile(path.join(drift.liveRoot, 'feature-change.txt'), 'one-byte-ish drift');
  await assert.rejects(verifyDeploymentTree({
    auditDir: drift.auditDir, context: drift.context,
  }), (error) => error.code === 'live_tree_drift');

  const untracked = await fixture();
  t.after(() => fs.rm(untracked.root, { recursive: true, force: true }));
  const untrackedPrepared = await prepareDeploymentTree(untracked);
  await sealDeploymentTree({ auditDir: untracked.auditDir, context: untracked.context });
  await applyExpected(untrackedPrepared);
  await fs.appendFile(path.join(untracked.liveRoot, 'unrelated.tmp'), 'changed');
  await assert.rejects(verifyDeploymentTree({
    auditDir: untracked.auditDir, context: untracked.context,
  }), (error) => error.code === 'unrelated_untracked_changed');
});
