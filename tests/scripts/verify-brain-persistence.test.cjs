const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { rewriteMemoryBase } = require('../../shared/memory-source');

test('streaming hash metadata accepts Jerry-sized files above 1 GiB without allocating them', async () => {
  const { resolveHashByteCount } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  assert.equal(typeof resolveHashByteCount, 'function');
  assert.equal(resolveHashByteCount(1_203_460_990n), 1_203_460_990);
  assert.equal(resolveHashByteCount(9_000_000_000n, { prefixBytes: 64 }), 64);
  assert.throws(
    () => resolveHashByteCount(9n * 1024n * 1024n * 1024n),
    (error) => error.code === 'file_too_large',
  );
});

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-persistence-proof-')));
  const home23Root = path.join(root, 'home23');
  const brainDir = path.join(home23Root, 'instances', 'jerry', 'brain');
  const tempRoot = path.join(root, 'external-clones');
  await fs.mkdir(brainDir, { recursive: true });
  await fs.mkdir(tempRoot);
  const committed = await rewriteMemoryBase(brainDir, {
    nodes: [
      { id: 'n1', concept: 'authoritative canary', cluster: 'one' },
      { id: 'n2', concept: 'connected evidence', cluster: 'one' },
    ],
    edges: [{ source: 'n1', target: 'n2', weight: 0.8 }],
    summary: { nodeCount: 2, edgeCount: 1, clusterCount: 1 },
  }, { lockRoot: path.join(root, 'fixture-locks') });
  await fs.writeFile(path.join(brainDir, 'brain-snapshot.json'), `${JSON.stringify({
    nodeCount: 2,
    edgeCount: 1,
    currentRevision: committed.manifest.currentRevision,
    generation: committed.manifest.generation,
    savedAt: new Date().toISOString(),
  })}\n`);
  return { root, home23Root, brainDir, tempRoot, manifest: committed.manifest };
}

test('read-only proof invokes the production loader against the exact live brain and proves counts and bytes', async (t) => {
  const { verifyReadOnlyPersistence } = await import('../../scripts/verify-brain-persistence.mjs');
  const { loadMemoryRevision } = require('../../engine/src/core/memory-persistence.js');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const calls = [];
  const result = await verifyReadOnlyPersistence({
    home23Root: state.home23Root,
    agent: 'jerry',
    brainDir: state.brainDir,
    loader: async (...args) => {
      calls.push(args[0]);
      return loadMemoryRevision(...args);
    },
  });
  assert.deepEqual(calls, [state.brainDir]);
  assert.equal(result.selectedAuthority, 'manifest-v1');
  assert.deepEqual(result.loaded, { nodes: 2, edges: 1, revision: state.manifest.currentRevision });
  assert.deepEqual(result.expected, { nodes: 2, edges: 1 });
  assert.equal(result.unchanged, true);
  assert.deepEqual(result.before, result.after);
  assert.ok(result.before.some((row) => row.role === 'delta' && row.committedBytes === 0));
});

test('missing, stale, zero, or disagreeing snapshot evidence fails closed', async (t) => {
  const { verifyReadOnlyPersistence } = await import('../../scripts/verify-brain-persistence.mjs');
  for (const [label, snapshot, code] of [
    ['missing', null, 'snapshot_counts_invalid'],
    ['stale', { nodeCount: 2, edgeCount: 1, currentRevision: 999 }, 'snapshot_stale'],
    ['zero', { nodeCount: 0, edgeCount: 0 }, 'snapshot_counts_invalid'],
    ['disagreeing', { nodeCount: 3, edgeCount: 1 }, 'persistence_count_mismatch'],
  ]) {
    const state = await fixture();
    t.after(() => fs.rm(state.root, { recursive: true, force: true }));
    const snapshotPath = path.join(state.brainDir, 'brain-snapshot.json');
    if (snapshot === null) await fs.rm(snapshotPath);
    else await fs.writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`);
    await assert.rejects(verifyReadOnlyPersistence({
      home23Root: state.home23Root, agent: 'jerry', brainDir: state.brainDir,
    }), (error) => error.code === code, label);
  }
});

test('a revision, file-set, or byte change during load is source_changed_concurrently', async (t) => {
  const { verifyReadOnlyPersistence } = await import('../../scripts/verify-brain-persistence.mjs');
  const { loadMemoryRevision } = require('../../engine/src/core/memory-persistence.js');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  await assert.rejects(verifyReadOnlyPersistence({
    home23Root: state.home23Root,
    agent: 'jerry',
    brainDir: state.brainDir,
    loader: loadMemoryRevision,
    afterLoad: async () => {
      await fs.appendFile(path.join(state.brainDir, 'brain-snapshot.json'), ' ');
    },
  }), (error) => error.code === 'source_changed_concurrently');
});

test('temp-save writes only an external unpredictable clone, reloads it, and guardedly removes it', async (t) => {
  const { verifyTempSaveClone } = await import('../../scripts/verify-brain-persistence.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const result = await verifyTempSaveClone({
    home23Root: state.home23Root,
    agent: 'jerry',
    brainDir: state.brainDir,
    tempRoot: state.tempRoot,
  });
  assert.equal(result.mode, 'temp-save-clone');
  assert.equal(result.cloneRemoved, true);
  assert.equal(path.dirname(result.writeBrainDir), state.tempRoot);
  assert.match(path.basename(result.writeBrainDir), /^brain-save-clone-/);
  assert.equal(result.writeBrainDir.startsWith(`${state.home23Root}${path.sep}`), false);
  assert.deepEqual(await fs.readdir(state.tempRoot), []);
  assert.equal(result.clone.loaded.nodes, 2);
  assert.equal(result.clone.loaded.edges, 1);
  assert.deepEqual(result.before, result.after);
});

test('clone mode refuses overlap and still rehashes the source after a clone writer failure', async (t) => {
  const { verifyTempSaveClone } = await import('../../scripts/verify-brain-persistence.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const overlapping = path.join(state.home23Root, 'unsafe-clones');
  await fs.mkdir(overlapping);
  await assert.rejects(verifyTempSaveClone({
    home23Root: state.home23Root, agent: 'jerry', brainDir: state.brainDir, tempRoot: overlapping,
  }), (error) => error.code === 'temp_root_overlaps_home23');

  await assert.rejects(verifyTempSaveClone({
    home23Root: state.home23Root,
    agent: 'jerry',
    brainDir: state.brainDir,
    tempRoot: state.tempRoot,
    persister: async ({ brainDir }) => {
      assert.equal(brainDir.startsWith(`${state.tempRoot}${path.sep}`), true);
      await fs.appendFile(path.join(state.brainDir, 'brain-snapshot.json'), 'changed');
      throw Object.assign(new Error('injected clone failure'), { code: 'injected_clone_failure' });
    },
  }), (error) => error.code === 'source_changed_concurrently');
  assert.deepEqual(await fs.readdir(state.tempRoot), []);
});
