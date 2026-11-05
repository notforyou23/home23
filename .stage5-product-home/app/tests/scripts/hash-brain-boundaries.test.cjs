const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const KINDS = ['brain', 'run', 'pgs', 'session', 'cache', 'export', 'agency'];

async function fixture(kind = 'resident') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `home23-boundary-${kind}-`)));
  const canonicalRoot = path.join(root, kind === 'resident' ? 'instances/jerry/brain' : 'research/run-1');
  await fs.mkdir(path.join(canonicalRoot, 'nested'), { recursive: true });
  await fs.writeFile(path.join(canonicalRoot, 'memory-manifest.json'), JSON.stringify({
    generation: 'g1', currentRevision: 7, activeDeltaEpoch: 'e1',
  }));
  await fs.writeFile(path.join(canonicalRoot, 'nested', 'unknown.weird'), 'unknown bytes');
  await fs.writeFile(path.join(canonicalRoot, 'nested', 'extensionless'), 'extensionless bytes');
  const outside = path.join(root, 'requester-owned-scratch');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'must-not-cross'), 'secret');
  await fs.symlink(outside, path.join(canonicalRoot, 'scratch-link'));
  const paths = {
    brain: canonicalRoot,
    run: canonicalRoot,
    pgs: path.join(canonicalRoot, 'pgs'),
    session: path.join(canonicalRoot, 'session'),
    cache: path.join(canonicalRoot, 'cache'),
    export: path.join(canonicalRoot, 'export'),
    agency: path.join(canonicalRoot, 'agency'),
  };
  const target = {
    id: kind === 'resident' ? 'brain-jerry' : 'research-run-1',
    brainId: kind === 'resident' ? 'brain-jerry' : 'research-run-1',
    ownerAgent: kind === 'resident' ? 'jerry' : 'research',
    kind,
    lifecycle: kind === 'resident' ? 'resident' : 'completed',
    canonicalRoot,
    mutationBoundaries: KINDS.map((boundary) => ({ kind: boundary, path: paths[boundary] })),
  };
  return { root, canonicalRoot, target, catalog: { catalogRevision: 'catalog-7', brains: [target] } };
}

test('recursively inventories every file, records symlinks without following, and keeps seven named boundaries', async (t) => {
  const { buildBoundaryInventory, REQUIRED_BOUNDARIES } = await import('../../scripts/hash-brain-boundaries.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  await fs.writeFile(path.join(state.canonicalRoot, 'nested', 'added-after-fixture-start'), 'late bytes');
  const inventory = await buildBoundaryInventory({ catalog: state.catalog, targetAgent: 'jerry' });
  assert.deepEqual(REQUIRED_BOUNDARIES, KINDS);
  assert.deepEqual(inventory.boundaries.map(({ kind }) => kind), KINDS);
  assert.equal(new Set(inventory.boundaries.map(({ kind }) => kind)).size, 7);
  for (const file of ['nested/unknown.weird', 'nested/extensionless', 'nested/added-after-fixture-start']) {
    assert.ok(inventory.records.some((row) => row.boundary === 'brain'
      && row.path === file && row.type === 'file' && row.sha256
      && row.dev && row.ino && row.ctimeNs && Number.isSafeInteger(row.nlink)), file);
  }
  const links = inventory.records.filter((row) => row.path === 'scratch-link');
  assert.ok(links.length >= 2);
  assert.ok(links.every((row) => row.type === 'symlink'));
  assert.equal(inventory.records.some((row) => row.path.includes('must-not-cross')), false);
  for (const kind of ['pgs', 'session', 'cache', 'export', 'agency']) {
    assert.deepEqual(
      inventory.records.filter((row) => row.boundary === kind).map((row) => row.type),
      ['absent'],
    );
  }
  assert.deepEqual(
    inventory.records.filter((row) => row.path === 'nested/extensionless').map((row) => row.boundary),
    ['brain', 'run'],
  );
});

test('resident and completed-research targets bind brain and run to the exact canonical target root', async (t) => {
  const { buildBoundaryInventory } = await import('../../scripts/hash-brain-boundaries.mjs');
  for (const kind of ['resident', 'research']) {
    const state = await fixture(kind);
    t.after(() => fs.rm(state.root, { recursive: true, force: true }));
    const inventory = await buildBoundaryInventory({
      catalog: state.catalog,
      ...(kind === 'resident' ? { targetAgent: 'jerry' } : { targetBrain: 'research-run-1' }),
    });
    assert.equal(inventory.target.canonicalRoot, state.canonicalRoot);
    assert.equal(inventory.boundaries.find((row) => row.kind === 'brain').root, state.canonicalRoot);
    assert.equal(inventory.boundaries.find((row) => row.kind === 'run').root, state.canonicalRoot);
  }
});

test('a revision, byte, or file-set change is reported as target_changed_concurrently', async (t) => {
  const { buildBoundaryInventory, compareBoundaryInventories } = await import('../../scripts/hash-brain-boundaries.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const identity = { receiptRunId: 'boundary-run', authority: 'live' };
  const before = { ...identity, phase: 'before', ...(await buildBoundaryInventory({ catalog: state.catalog, targetAgent: 'jerry' })) };
  await fs.writeFile(path.join(state.canonicalRoot, 'nested', 'concurrent'), 'writer crossed');
  const after = { ...identity, phase: 'after', ...(await buildBoundaryInventory({ catalog: state.catalog, targetAgent: 'jerry' })) };
  assert.throws(
    () => compareBoundaryInventories(before, after),
    (error) => error.code === 'target_changed_concurrently',
  );
});

test('compare requires one receipt run and authority and detects inode or revision substitution', async (t) => {
  const { buildBoundaryInventory, compareBoundaryInventories } = await import('../../scripts/hash-brain-boundaries.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const build = async (phase, overrides = {}) => ({
    receiptRunId: 'boundary-run', authority: 'live', phase,
    ...(await buildBoundaryInventory({ catalog: state.catalog, targetAgent: 'jerry' })),
    ...overrides,
  });
  const before = await build('before');
  const same = await build('after');
  assert.equal(compareBoundaryInventories(before, same).unchanged, true);
  assert.throws(
    () => compareBoundaryInventories(before, { ...same, receiptRunId: 'other-run' }),
    (error) => error.code === 'boundary_authority_mismatch',
  );
  assert.throws(
    () => compareBoundaryInventories(before, { ...same, authority: 'isolated-controlled' }),
    (error) => error.code === 'boundary_authority_mismatch',
  );

  const file = path.join(state.canonicalRoot, 'nested', 'extensionless');
  const originalStat = await fs.stat(file);
  const bytes = await fs.readFile(file);
  await fs.rm(file);
  await fs.writeFile(file, bytes);
  await fs.utimes(file, originalStat.atime, originalStat.mtime);
  const replaced = await build('after');
  assert.throws(
    () => compareBoundaryInventories(before, replaced),
    (error) => error.code === 'target_changed_concurrently',
  );

  const revisionChanged = structuredClone(same);
  revisionChanged.sourceRevision.revision += 1;
  assert.throws(
    () => compareBoundaryInventories(before, revisionChanged),
    (error) => error.code === 'target_changed_concurrently',
  );
});
