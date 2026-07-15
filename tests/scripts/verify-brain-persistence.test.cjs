const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { gzipSync } = require('node:zlib');

const { appendMemoryRevision, rewriteMemoryBase } = require('../../shared/memory-source');
const execFileAsync = promisify(execFile);

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

test('100k-node/300k-edge persistence proof stays streaming under a 96 MiB old-space child cap', async () => {
  const probe = path.join(__dirname, 'verify-brain-persistence-heap-probe.cjs');
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    '--max-old-space-size=96',
    probe,
  ], {
    cwd: path.resolve(__dirname, '../..'),
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(stderr, '');
  const result = JSON.parse(stdout.trim());
  assert.equal(result.nodes, 100_000);
  assert.equal(result.edges, 300_000);
  assert.equal(result.resources.peakHeapUsedMiB <= 80, true);
  assert.equal(result.resources.v8HeapLimitMiB < 320, true);
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

async function legacyFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-persistence-legacy-')));
  const home23Root = path.join(root, 'home23');
  const brainDir = path.join(home23Root, 'instances', 'jerry', 'brain');
  const tempRoot = path.join(root, 'external-clones');
  await fs.mkdir(brainDir, { recursive: true });
  await fs.mkdir(tempRoot);
  await fs.writeFile(path.join(brainDir, 'memory-nodes.jsonl.gz'), gzipSync([
    JSON.stringify({ id: 'legacy-n1', concept: 'legacy canary', cluster: 'legacy' }),
    JSON.stringify({ id: 'legacy-n2', concept: 'legacy evidence', cluster: 'legacy' }),
    '',
  ].join('\n')));
  await fs.writeFile(path.join(brainDir, 'memory-edges.jsonl.gz'), gzipSync(`${JSON.stringify({
    source: 'legacy-n1', target: 'legacy-n2', weight: 1,
  })}\n`));
  await fs.writeFile(path.join(brainDir, 'memory-delta.jsonl'), '');
  await fs.writeFile(path.join(brainDir, 'brain-snapshot.json'), `${JSON.stringify({
    nodeCount: 2, edgeCount: 1, currentRevision: 0, generation: 'legacy-g0',
    savedAt: new Date().toISOString(),
  })}\n`);
  return { root, home23Root, brainDir, tempRoot };
}

test('read-only proof streams the exact live brain through the production source reader and proves counts and bytes', async (t) => {
  const { verifyReadOnlyPersistence } = await import('../../scripts/verify-brain-persistence.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const result = await verifyReadOnlyPersistence({
    home23Root: state.home23Root,
    agent: 'jerry',
    brainDir: state.brainDir,
    tempRoot: state.tempRoot,
  });
  assert.equal(result.mode, 'read-only-stream');
  assert.equal(result.selectedAuthority, 'manifest-v1');
  assert.equal(result.streamed.nodes, 2);
  assert.equal(result.streamed.edges, 1);
  assert.equal(result.streamed.revision, state.manifest.currentRevision);
  assert.match(result.streamed.nodeLogicalSha256, /^[a-f0-9]{64}$/);
  assert.match(result.streamed.edgeLogicalSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.streamed.resources.peakHeapUsedMiB > 0, true);
  assert.equal(result.fullMaterializerUsed, false);
  assert.equal(result.streamed.freshness, 'known');
  assert.deepEqual(result.expected, { nodes: 2, edges: 1 });
  assert.equal(result.unchanged, true);
  assert.deepEqual(result.before, result.after);
  assert.ok(result.before.some((row) => row.role === 'delta' && row.committedBytes === 0));
  assert.deepEqual(await fs.readdir(state.tempRoot), []);
});

test('read-only proof supports the production-selected legacy sidecar generation', async (t) => {
  const { verifyReadOnlyPersistence } = await import('../../scripts/verify-brain-persistence.mjs');
  const state = await legacyFixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const result = await verifyReadOnlyPersistence({
    home23Root: state.home23Root, agent: 'jerry', brainDir: state.brainDir,
    tempRoot: state.tempRoot,
  });
  assert.equal(result.selectedAuthority, 'legacy-resident-sidecars');
  assert.equal(result.streamed.nodes, 2);
  assert.equal(result.streamed.edges, 1);
  assert.equal(result.streamed.implementation, 'legacy-resident-sidecar-projection');
  assert.equal(result.streamed.sourceHealth, 'degraded');
  assert.equal(result.streamed.freshness, 'unknown');
  assert.equal(result.streamed.matchOutcome, 'matches');
  assert.equal(result.fullMaterializerUsed, false);
  assert.deepEqual(result.before, result.after);
  assert.deepEqual(await fs.readdir(state.tempRoot), []);
});

test('legacy resident proof treats streamed base plus later delta as authoritative when snapshot lags', async (t) => {
  const { verifyReadOnlyPersistence } = await import('../../scripts/verify-brain-persistence.mjs');
  const state = await legacyFixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  await fs.appendFile(path.join(state.brainDir, 'memory-delta.jsonl'), `${JSON.stringify({
    op: 'upsert_node',
    record: { id: 'legacy-n3', concept: 'later committed evidence', cluster: 'legacy' },
  })}\n`);

  const result = await verifyReadOnlyPersistence({
    home23Root: state.home23Root, agent: 'jerry', brainDir: state.brainDir,
    tempRoot: state.tempRoot,
  });

  assert.equal(result.selectedAuthority, 'legacy-resident-sidecars');
  assert.deepEqual(result.expected, { nodes: 3, edges: 1 });
  assert.equal(result.expectedAuthority, 'streamed-logical-source');
  assert.equal(result.streamed.nodes, 3);
  assert.equal(result.streamed.edges, 1);
  assert.equal(result.snapshot.status, 'valid');
  assert.equal(result.snapshot.nodes, 2);
  assert.equal(result.snapshot.edges, 1);
  assert.equal(result.snapshot.matchesStreamed, false);
  assert.equal(result.snapshot.requiredForAcceptance, false);
  assert.equal(
    result.snapshot.notRequiredReason,
    'legacy-resident-sidecars-stream-includes-committed-delta',
  );
  assert.deepEqual(result.before, result.after);
  assert.deepEqual(await fs.readdir(state.tempRoot), []);
});

test('legacy resident proof records missing or invalid advisory snapshots without rejecting authority', async (t) => {
  const { verifyReadOnlyPersistence } = await import('../../scripts/verify-brain-persistence.mjs');
  for (const [label, mutate, status] of [
    ['missing', (snapshotPath) => fs.rm(snapshotPath), 'missing'],
    ['invalid', (snapshotPath) => fs.writeFile(snapshotPath, '{not-json\n'), 'invalid'],
  ]) {
    await t.test(label, async (st) => {
      const state = await legacyFixture();
      st.after(() => fs.rm(state.root, { recursive: true, force: true }));
      await mutate(path.join(state.brainDir, 'brain-snapshot.json'));
      const result = await verifyReadOnlyPersistence({
        home23Root: state.home23Root, agent: 'jerry', brainDir: state.brainDir,
        tempRoot: state.tempRoot,
      });
      assert.deepEqual(result.expected, { nodes: 2, edges: 1 });
      assert.equal(result.expectedAuthority, 'streamed-logical-source');
      assert.equal(result.snapshot.status, status);
      assert.equal(result.snapshot.nodes, null);
      assert.equal(result.snapshot.edges, null);
      assert.equal(result.snapshot.matchesStreamed, null);
      assert.equal(result.snapshot.requiredForAcceptance, false);
      assert.equal(
        result.snapshot.notRequiredReason,
        'legacy-resident-sidecars-stream-includes-committed-delta',
      );
      assert.deepEqual(result.before, result.after);
      assert.deepEqual(await fs.readdir(state.tempRoot), []);
    });
  }
});

test('temp-save clone accepts a stale legacy advisory snapshot and proves the later delta', async (t) => {
  const { verifyTempSaveClone } = await import('../../scripts/verify-brain-persistence.mjs');
  const state = await legacyFixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  await fs.appendFile(path.join(state.brainDir, 'memory-delta.jsonl'), `${JSON.stringify({
    op: 'upsert_node',
    record: { id: 'legacy-n3', concept: 'later committed evidence', cluster: 'legacy' },
  })}\n`);

  const result = await verifyTempSaveClone({
    home23Root: state.home23Root, agent: 'jerry', brainDir: state.brainDir,
    tempRoot: state.tempRoot,
  });

  assert.equal(result.mode, 'temp-save-clone-safe');
  assert.deepEqual(result.expected, { nodes: 3, edges: 1 });
  assert.equal(result.expectedAuthority, 'streamed-logical-source');
  assert.equal(result.snapshot.matchesStreamed, false);
  assert.equal(result.snapshot.requiredForAcceptance, false);
  assert.equal(result.clone.loaded.nodes, 4);
  assert.equal(result.clone.loaded.edges, 1);
  assert.equal(result.clone.canaryMatches, 1);
  assert.equal(result.cloneRemoved, true);
  assert.deepEqual(await fs.readdir(state.tempRoot), []);
});

test('missing, stale, zero, or disagreeing snapshot evidence fails closed', async (t) => {
  const { verifyReadOnlyPersistence } = await import('../../scripts/verify-brain-persistence.mjs');
  for (const [label, snapshot, code] of [
    ['missing', null, 'snapshot_counts_invalid'],
    ['stale', { nodeCount: 2, edgeCount: 1, currentRevision: 999 }, 'snapshot_stale'],
    ['missing revision', 'missing-revision', 'snapshot_stale'],
    ['missing generation', 'missing-generation', 'snapshot_stale'],
    ['wrong generation', 'wrong-generation', 'snapshot_stale'],
    ['zero', { nodeCount: 0, edgeCount: 0 }, 'snapshot_counts_invalid'],
    ['string node count', { nodeCount: '2', edgeCount: 1 }, 'snapshot_counts_invalid'],
    ['string edge count', { nodeCount: 2, edgeCount: '1' }, 'snapshot_counts_invalid'],
    ['array node count', { nodeCount: [2], edgeCount: 1 }, 'snapshot_counts_invalid'],
    ['array edge count', { nodeCount: 2, edgeCount: [1] }, 'snapshot_counts_invalid'],
    ['boolean node count', { nodeCount: true, edgeCount: 1 }, 'snapshot_counts_invalid'],
    ['boolean edge count', { nodeCount: 2, edgeCount: true }, 'snapshot_counts_invalid'],
    ['disagreeing', { nodeCount: 3, edgeCount: 1 }, 'persistence_count_mismatch'],
  ]) {
    const state = await fixture();
    t.after(() => fs.rm(state.root, { recursive: true, force: true }));
    const snapshotPath = path.join(state.brainDir, 'brain-snapshot.json');
    if (snapshot === null) await fs.rm(snapshotPath);
    else {
      const value = snapshot === 'missing-revision'
        ? { nodeCount: 2, edgeCount: 1, generation: state.manifest.generation }
        : snapshot === 'missing-generation'
          ? { nodeCount: 2, edgeCount: 1, currentRevision: state.manifest.currentRevision }
          : snapshot === 'wrong-generation'
            ? {
              nodeCount: 2, edgeCount: 1,
              currentRevision: state.manifest.currentRevision,
              generation: 'wrong-generation',
            }
            : label === 'disagreeing'
              ? {
                ...snapshot,
                currentRevision: state.manifest.currentRevision,
                generation: state.manifest.generation,
              }
            : snapshot;
      await fs.writeFile(snapshotPath, `${JSON.stringify(value)}\n`);
    }
    await assert.rejects(verifyReadOnlyPersistence({
      home23Root: state.home23Root, agent: 'jerry', brainDir: state.brainDir,
      tempRoot: state.tempRoot,
    }), (error) => error.code === code, label);
  }
});

test('a revision, file-set, or byte change during streaming is source_changed_concurrently', async (t) => {
  const { verifyReadOnlyPersistence } = await import('../../scripts/verify-brain-persistence.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  await assert.rejects(verifyReadOnlyPersistence({
    home23Root: state.home23Root,
    agent: 'jerry',
    brainDir: state.brainDir,
    tempRoot: state.tempRoot,
    afterStream: async () => {
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
  assert.equal(result.mode, 'temp-save-clone-safe');
  assert.equal(result.cloneRemoved, true);
  assert.equal(path.dirname(result.writeBrainDir), state.tempRoot);
  assert.match(path.basename(result.writeBrainDir), /^brain-save-clone-/);
  assert.equal(result.writeBrainDir.startsWith(`${state.home23Root}${path.sep}`), false);
  assert.deepEqual(await fs.readdir(state.tempRoot), []);
  assert.equal(result.clone.loaded.nodes, 3);
  assert.equal(result.clone.loaded.edges, 1);
  assert.equal(result.clone.persistedMode, 'delta');
  assert.equal(result.clone.canaryMatches, 1);
  assert.equal(result.clone.fullMaterializerUsed, false);
  assert.equal(result.clone.copyPolicy, 'exact-physical-files-with-portable-manifest');
  assert.deepEqual(result.clone.manifestProjection, {
    projected: true,
    chainAuthority: 'retained',
    removedFields: ['fileIdentity'],
  });
  const manifestCopy = result.clone.copiedFiles.find((row) => row.path === 'memory-manifest.json');
  assert.equal(manifestCopy.projection, 'portable-delta-identity');
  assert.notEqual(manifestCopy.sourceSha256, manifestCopy.destinationSha256);
  assert.equal(result.clone.copiedFiles
    .filter((row) => row.path !== 'memory-manifest.json')
    .every((row) => row.sourceSha256 === row.destinationSha256), true);
  assert.equal(result.boundedForceFull.persistedMode, 'full');
  assert.deepEqual(result.boundedForceFull.loaded, { nodes: 2, edges: 1 });
  assert.equal(result.boundedForceFull.persistedRevision, result.boundedForceFull.reloadedRevision);
  assert.equal(result.liveForceFull.attempted, false);
  assert.match(result.liveForceFull.reason, /prohibited/);
  assert.deepEqual(result.before, result.after);
});

test('temp-save projects source-only identities from a nonempty chained native delta', async (t) => {
  const { verifyTempSaveClone } = await import('../../scripts/verify-brain-persistence.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const appended = await appendMemoryRevision(state.brainDir, {
    nodes: [{ id: 'n3', concept: 'committed native delta', cluster: 'two' }],
  }, {
    lockRoot: path.join(state.root, 'fixture-locks'),
    summary: { nodeCount: 3, edgeCount: 1, clusterCount: 2 },
  });
  await fs.writeFile(path.join(state.brainDir, 'brain-snapshot.json'), `${JSON.stringify({
    nodeCount: 3,
    edgeCount: 1,
    currentRevision: appended.manifest.currentRevision,
    generation: appended.manifest.generation,
    savedAt: new Date().toISOString(),
  })}\n`);

  const result = await verifyTempSaveClone({
    home23Root: state.home23Root,
    agent: 'jerry',
    brainDir: state.brainDir,
    tempRoot: state.tempRoot,
  });

  assert.deepEqual(result.clone.manifestProjection, {
    projected: true,
    chainAuthority: 'retained',
    removedFields: ['fileIdentity', 'appendFrom'],
  });
  assert.equal(result.clone.loaded.nodes, 4);
  assert.equal(result.clone.canaryMatches, 1);
  assert.equal(result.clone.copiedFiles
    .filter((row) => row.path !== 'memory-manifest.json')
    .every((row) => row.sourceSha256 === row.destinationSha256), true);
  assert.deepEqual(result.before, result.after);
});

test('clone mode keeps one pinned source inventory and revalidates it before writer work', async (t) => {
  const { verifyTempSaveClone } = await import('../../scripts/verify-brain-persistence.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  await assert.rejects(verifyTempSaveClone({
    home23Root: state.home23Root,
    agent: 'jerry',
    brainDir: state.brainDir,
    tempRoot: state.tempRoot,
    afterReadOnlyProof: async () => {
      await fs.appendFile(path.join(state.brainDir, 'brain-snapshot.json'), ' ');
    },
  }), (error) => error.code === 'source_changed_concurrently');
  assert.deepEqual(await fs.readdir(state.tempRoot), []);
});

test('clone destination refuses symlink aliases and every other live brain', async (t) => {
  const { verifyTempSaveClone } = await import('../../scripts/verify-brain-persistence.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const otherBrain = path.join(state.home23Root, 'instances', 'forrest', 'brain');
  await fs.mkdir(otherBrain, { recursive: true });
  await assert.rejects(verifyTempSaveClone({
    home23Root: state.home23Root, agent: 'jerry', brainDir: state.brainDir,
    tempRoot: otherBrain,
  }), (error) => ['temp_root_overlaps_home23', 'temp_root_overlaps_live_brain'].includes(error.code));
  const alias = path.join(state.root, 'external-alias');
  await fs.symlink(state.tempRoot, alias);
  await assert.rejects(verifyTempSaveClone({
    home23Root: state.home23Root, agent: 'jerry', brainDir: state.brainDir,
    tempRoot: alias,
  }), (error) => error.code === 'path_invalid');
});

test('cleanup failure still revalidates the live source and cannot hide source drift', async (t) => {
  const { verifyTempSaveClone } = await import('../../scripts/verify-brain-persistence.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  await assert.rejects(verifyTempSaveClone({
    home23Root: state.home23Root,
    agent: 'jerry',
    brainDir: state.brainDir,
    tempRoot: state.tempRoot,
    removeClone: async () => {
      await fs.appendFile(path.join(state.brainDir, 'brain-snapshot.json'), 'drift');
      throw Object.assign(new Error('injected cleanup failure'), { code: 'clone_cleanup_injected' });
    },
  }), (error) => error.code === 'source_changed_concurrently');
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
