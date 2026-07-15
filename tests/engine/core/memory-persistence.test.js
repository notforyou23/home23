import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  loadMemoryRevision,
  persistMemoryRevision,
} = require('../../../engine/src/core/memory-persistence.js');
const {
  appendMemoryRevision,
  openMemorySource,
  readManifest,
  rewriteMemoryBase,
  writeJsonlGzAtomic,
} = require('../../../shared/memory-source');

function createTrackedMemory(nodes = [], events = []) {
  let generation = 1;
  let dirty = true;
  const rows = nodes.map((node) => ({ ...node }));
  return {
    upsertNode(node) {
      rows.push({ ...node });
      generation += 1;
      dirty = true;
    },
    hasPersistenceChanges() { return dirty; },
    capturePersistenceSnapshot() {
      events.push(`captured:${generation}`);
      const snapshotRows = rows.map((node) => Object.freeze({ ...node }));
      return Object.freeze({
        generation,
        changes: Object.freeze({
          nodes: Object.freeze(snapshotRows),
          edges: Object.freeze([]),
          removedNodeIds: Object.freeze([]),
          removedEdgeKeys: Object.freeze([]),
        }),
        fullView: Object.freeze({
          nodes: Object.freeze(snapshotRows),
          edges: Object.freeze([]),
        }),
        summary: Object.freeze({ nodeCount: snapshotRows.length, edgeCount: 0, clusterCount: 0 }),
      });
    },
    markPersistenceCleanIfGeneration(expected) {
      events.push(`clean-if:${expected}`);
      if (expected !== generation) return false;
      dirty = false;
      return true;
    },
  };
}

function createBarrier() {
  let resolveCaptured;
  let resolveCommit;
  return {
    snapshotCaptured: new Promise((resolve) => { resolveCaptured = resolve; }),
    commitReleased: new Promise((resolve) => { resolveCommit = resolve; }),
    captured(value) { resolveCaptured(value); },
    releaseCommit() { resolveCommit(); },
  };
}

test('writer failure preserves dirty persistence changes', async () => {
  const memory = createTrackedMemory([{ id: 'n1', concept: 'canary' }]);
  await assert.rejects(persistMemoryRevision({
    brainDir: '/unused',
    memory,
    writer: {
      readManifest: async () => ({ currentRevision: 1 }),
      appendMemoryRevision: async () => { throw new Error('disk full'); },
      rewriteMemoryBase: async () => { throw new Error('not expected'); },
    },
  }), /disk full/);
  assert.equal(memory.hasPersistenceChanges(), true);
});

test('successful delta commit clears dirty persistence changes after generation CAS', async () => {
  const events = [];
  const memory = createTrackedMemory([{ id: 'n1', concept: 'canary' }], events);
  const result = await persistMemoryRevision({
    brainDir: '/unused',
    memory,
    writer: {
      readManifest: async () => ({ currentRevision: 1 }),
      appendMemoryRevision: async () => {
        events.push('committed');
        return { manifest: { currentRevision: 2 }, count: 1 };
      },
      rewriteMemoryBase: async () => { throw new Error('not expected'); },
    },
  });
  assert.equal(result.manifest.currentRevision, 2);
  assert.equal(result.cleaned, true);
  assert.deepEqual(events, ['captured:1', 'committed', 'clean-if:1']);
});

test('a mutation accepted behind the persistence barrier cannot be marked clean', async () => {
  const barrier = createBarrier();
  const memory = createTrackedMemory([{ id: 'n1', concept: 'first' }]);
  const saving = persistMemoryRevision({
    brainDir: '/unused',
    memory,
    writer: {
      readManifest: async () => ({ currentRevision: 1 }),
      appendMemoryRevision: async () => {
        barrier.captured();
        await barrier.commitReleased;
        return { manifest: { currentRevision: 2 }, count: 1 };
      },
      rewriteMemoryBase: async () => { throw new Error('not expected'); },
    },
  });
  await barrier.snapshotCaptured;
  memory.upsertNode({ id: 'n2', concept: 'accepted while commit was pending' });
  barrier.releaseCommit();
  const first = await saving;
  assert.equal(first.cleaned, false);
  assert.equal(memory.hasPersistenceChanges(), true);
});

test('full rewrite persists one immutable generation while live memory advances', async () => {
  const barrier = createBarrier();
  const memory = createTrackedMemory([{ id: 'n1', concept: 'captured' }]);
  let captured;
  const saving = persistMemoryRevision({
    brainDir: '/unused',
    memory,
    forceFull: true,
    schedule: () => {},
    writer: {
      readManifest: async () => null,
      appendMemoryRevision: async () => { throw new Error('not expected'); },
      rewriteMemoryBase: async (_brainDir, view) => {
        captured = view;
        barrier.captured();
        await barrier.commitReleased;
        return { manifest: { currentRevision: 1, summary: view.summary }, count: 1 };
      },
    },
  });
  await barrier.snapshotCaptured;
  assert.equal(Object.isFrozen(captured.nodes), true);
  assert.equal(Object.isFrozen(captured.nodes[0]), true);
  memory.upsertNode({ id: 'n2', concept: 'post-capture' });
  barrier.releaseCommit();
  const result = await saving;
  assert.deepEqual(captured.nodes.map((node) => node.id), ['n1']);
  assert.deepEqual(result.manifest.summary, { nodeCount: 1, edgeCount: 0, clusterCount: 0 });
  assert.equal(result.cleaned, false);
});

async function createBaseDeltaFixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-memory-persistence-load-'));
  const nodes = await writeJsonlGzAtomic(path.join(dir, 'memory-nodes.base-1.jsonl.gz'), [
    { id: 'n1', concept: 'old' },
  ]);
  const edges = await writeJsonlGzAtomic(path.join(dir, 'memory-edges.base-1.jsonl.gz'), []);
  const deltaLine = `${JSON.stringify({ epoch: 'e2', sequence: 1, revision: 2, op: 'upsert_node', record: { id: 'n1', concept: 'updated' } })}\n`
    + `${JSON.stringify({ epoch: 'e2', sequence: 2, revision: 3, op: 'upsert_node', record: { id: 'n2', concept: 'delta-only' } })}\n`;
  await fsp.writeFile(path.join(dir, 'memory-delta.e2.jsonl'), deltaLine);
  await fsp.writeFile(path.join(dir, 'memory-manifest.json'), `${JSON.stringify({
    formatVersion: 1,
    generation: 'g1',
    baseRevision: 1,
    currentRevision: 3,
    activeDeltaEpoch: 'e2',
    activeBase: {
      nodes: { file: 'memory-nodes.base-1.jsonl.gz', count: 1, bytes: nodes.bytes },
      edges: { file: 'memory-edges.base-1.jsonl.gz', count: 0, bytes: edges.bytes },
    },
    activeDelta: { epoch: 'e2', file: 'memory-delta.e2.jsonl', fromRevision: 2, toRevision: 3, count: 2, committedBytes: Buffer.byteLength(deltaLine) },
    ann: { indexFile: null, metaFile: null, builtFromRevision: 1 },
    summary: { nodeCount: 2, edgeCount: 0, clusterCount: 0 },
  }, null, 2)}\n`);
  return dir;
}

test('engine load materializes the exact logical revision', async () => {
  const dir = await createBaseDeltaFixture();
  const loaded = await loadMemoryRevision(dir);
  assert.deepEqual(loaded.nodes.map((node) => node.concept).sort(), ['delta-only', 'updated']);
  assert.equal(loaded.evidence.sourceHealth, 'healthy');
});

test('engine load supports legacy resident sidecars before manifest migration', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-legacy-sidecar-load-'));
  await writeJsonlGzAtomic(path.join(dir, 'memory-nodes.jsonl.gz'), [
    { id: 1, concept: 'base node', cluster: 'c1' },
    { id: 2, concept: 'removed node', cluster: 'c1' },
  ]);
  await writeJsonlGzAtomic(path.join(dir, 'memory-edges.jsonl.gz'), [
    { source: 1, target: 2, weight: 0.2, type: 'associative' },
  ]);
  await fsp.writeFile(path.join(dir, 'memory-delta.jsonl'), [
    JSON.stringify({ op: 'remove_node', id: 2 }),
    JSON.stringify({ op: 'upsert_node', record: { id: 3, concept: 'delta node', cluster: 'c2' } }),
    JSON.stringify({ op: 'upsert_edge', record: { source: 1, target: 3, weight: 0.4, type: 'associative' } }),
    '',
  ].join('\n'));

  const loaded = await loadMemoryRevision(dir);
  assert.deepEqual(loaded.nodes.map((node) => node.id).sort(), [1, 3]);
  assert.deepEqual(loaded.edges.map((edge) => [edge.source, edge.target]), [[1, 3]]);
  assert.equal(loaded.evidence.route, 'legacy-resident-sidecars');
  assert.equal(loaded.evidence.sourceHealth, 'healthy');
  assert.equal(loaded.evidence.deltaWatermark.appliedRecords, 3);
});

test('legacy resident sidecar save appends delta instead of full manifest rewrite', async () => {
  const installRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-legacy-sidecar-save-'));
  const dir = path.join(installRoot, 'brain');
  await fsp.mkdir(dir);
  const home23Root = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-legacy-sidecar-home-'));
  await writeJsonlGzAtomic(path.join(dir, 'memory-nodes.jsonl.gz'), [
    { id: 'base', concept: 'base node' },
  ]);
  await writeJsonlGzAtomic(path.join(dir, 'memory-edges.jsonl.gz'), []);
  const events = [];
  const memory = createTrackedMemory([{ id: 'delta', concept: 'delta node' }], events);

  const result = await persistMemoryRevision({
    brainDir: dir,
    home23Root,
    memory,
    writer: {
      readManifest: async () => null,
      appendMemoryRevision: async () => { throw new Error('manifest append not expected'); },
      rewriteMemoryBase: async () => { throw new Error('full rewrite not expected'); },
    },
  });

  assert.equal(result.mode, 'legacy-delta');
  assert.equal(result.cleaned, true);
  assert.equal(result.manifest, null);
  await assert.rejects(fsp.stat(path.join(dir, 'memory-manifest.json')), /ENOENT/);
  const deltaText = await fsp.readFile(path.join(dir, 'memory-delta.jsonl'), 'utf8');
  assert.match(deltaText, /"op":"upsert_node"/);
  assert.match(deltaText, /"id":"delta"/);
  assert.equal(await fsp.stat(path.join(home23Root, 'runtime', 'brain-source-locks'))
    .then((stat) => stat.isDirectory(), () => false), true);
  assert.equal(await fsp.stat(path.join(installRoot, '.home23-memory-source-locks'))
    .then(() => true, () => false), false);
  assert.deepEqual(events, ['captured:1', 'clean-if:1']);
});

test('legacy resident sidecar save uses changes-only snapshot when available', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-legacy-sidecar-changes-only-'));
  await writeJsonlGzAtomic(path.join(dir, 'memory-nodes.jsonl.gz'), [
    { id: 'base', concept: 'base node' },
  ]);
  await writeJsonlGzAtomic(path.join(dir, 'memory-edges.jsonl.gz'), []);
  const events = [];
  const memory = {
    capturePersistenceSnapshot() {
      throw new Error('full snapshot not expected');
    },
    capturePersistenceChangesSnapshot() {
      events.push('changes-only');
      return Object.freeze({
        generation: 7,
        changes: Object.freeze({
          nodes: Object.freeze([{ id: 'delta', concept: 'delta node' }]),
          edges: Object.freeze([]),
          removedNodeIds: Object.freeze([]),
          removedEdgeKeys: Object.freeze([]),
        }),
        summary: Object.freeze({ nodeCount: 2, edgeCount: 0, clusterCount: 0 }),
      });
    },
    markPersistenceCleanIfGeneration(expected) {
      events.push(`clean-if:${expected}`);
      return expected === 7;
    },
  };

  const result = await persistMemoryRevision({
    brainDir: dir,
    memory,
    writer: {
      readManifest: async () => null,
      appendMemoryRevision: async () => { throw new Error('manifest append not expected'); },
      rewriteMemoryBase: async () => { throw new Error('full rewrite not expected'); },
    },
  });

  assert.equal(result.mode, 'legacy-delta');
  assert.equal(result.cleaned, true);
  assert.deepEqual(events, ['changes-only', 'clean-if:7']);
});

test('manifest delta and reuse saves never materialize the full resident graph', async () => {
  for (const hasChanges of [true, false]) {
    const events = [];
    const changes = Object.freeze({
      nodes: Object.freeze(hasChanges ? [{ id: 'delta', concept: 'bounded delta' }] : []),
      edges: Object.freeze([]),
      removedNodeIds: Object.freeze([]),
      removedEdgeKeys: Object.freeze([]),
    });
    const memory = {
      capturePersistenceSnapshot() {
        throw new Error('full resident graph materializer invoked');
      },
      capturePersistenceChangesSnapshot() {
        events.push('changes-only');
        return Object.freeze({
          generation: 13,
          changes,
          summary: Object.freeze({ nodeCount: 139000, edgeCount: 455000, clusterCount: 37 }),
        });
      },
      markPersistenceCleanIfGeneration(expected) {
        events.push(`clean-if:${expected}`);
        return expected === 13;
      },
    };
    let appended = null;
    const result = await persistMemoryRevision({
      brainDir: '/unused',
      memory,
      writer: {
        readManifest: async () => ({
          currentRevision: 17,
          baseWrittenAt: new Date().toISOString(),
          summary: { nodeCount: 139000, edgeCount: 455000, clusterCount: 37 },
        }),
        appendMemoryRevision: async (_brainDir, capturedChanges, options) => {
          events.push('committed');
          appended = { capturedChanges, summary: options.summary };
          return { manifest: { currentRevision: 18 }, count: 1 };
        },
        rewriteMemoryBase: async () => { throw new Error('full rewrite not expected'); },
      },
    });

    assert.equal(result.mode, hasChanges ? 'delta' : 'reused');
    assert.deepEqual(events, hasChanges
      ? ['changes-only', 'committed', 'clean-if:13']
      : ['changes-only']);
    if (hasChanges) {
      assert.equal(appended.capturedChanges, changes);
      assert.deepEqual(appended.summary, {
        nodeCount: 139000,
        edgeCount: 455000,
        clusterCount: 37,
      });
    } else {
      assert.equal(appended, null);
    }
  }
});

test('a clean resident snapshot repairs stale manifest summary without appending a revision', async () => {
  const events = [];
  const brainDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-summary-repair-unit-'));
  const summary = Object.freeze({ nodeCount: 1, edgeCount: 0, clusterCount: 1 });
  const memory = {
    capturePersistenceSnapshot() {
      throw new Error('full resident graph materializer invoked');
    },
    capturePersistenceChangesSnapshot() {
      events.push('changes-only');
      return Object.freeze({
        generation: 9,
        changes: Object.freeze({
          nodes: Object.freeze([]),
          edges: Object.freeze([]),
          removedNodeIds: Object.freeze([]),
          removedEdgeKeys: Object.freeze([]),
        }),
        summary,
      });
    },
    markPersistenceCleanIfGeneration() {
      throw new Error('clean graph must not need a dirty-generation CAS');
    },
  };
  const manifest = {
    formatVersion: 1,
    generation: 'summary-repair-generation',
    baseRevision: 1,
    currentRevision: 17,
    baseWrittenAt: new Date().toISOString(),
    activeBase: {
      nodes: { file: 'nodes.gz', count: 1, bytes: 1 },
      edges: { file: 'edges.gz', count: 0, bytes: 1 },
    },
    activeDelta: {
      epoch: 'summary-repair-epoch', file: 'delta.jsonl',
      fromRevision: 2, toRevision: 17, count: 16, committedBytes: 1,
    },
    summary: { nodeCount: 2, edgeCount: 0, clusterCount: 1 },
  };

  const result = await persistMemoryRevision({
    brainDir,
    memory,
    writer: {
      readManifest: async () => manifest,
      appendMemoryRevision: async (_brainDir, changes, options) => {
        events.push('summary-repaired');
        assert.deepEqual(changes, {
          nodes: [], edges: [], removedNodeIds: [], removedEdgeKeys: [],
        });
        assert.equal(options.summary, summary);
        assert.equal(options.expectedGeneration, manifest.generation);
        assert.equal(options.expectedRevision, manifest.currentRevision);
        assert.match(options.expectedDigest, /^sha256:[a-f0-9]{64}$/);
        return { manifest: { ...manifest, summary }, count: 0 };
      },
      rewriteMemoryBase: async () => { throw new Error('full rewrite not expected'); },
    },
  });

  assert.equal(result.mode, 'summary-repair');
  assert.deepEqual(result.manifest.summary, summary);
  assert.deepEqual(events, ['changes-only', 'summary-repaired']);
});

test('summary-only repair refuses to rewrite unrelated edge or cluster authority', async () => {
  let appendCalls = 0;
  const manifest = {
    currentRevision: 17,
    baseWrittenAt: new Date().toISOString(),
    summary: { nodeCount: 2, edgeCount: 4, clusterCount: 1 },
  };
  const memory = {
    capturePersistenceChangesSnapshot() {
      return Object.freeze({
        generation: 9,
        changes: Object.freeze({
          nodes: Object.freeze([]), edges: Object.freeze([]),
          removedNodeIds: Object.freeze([]), removedEdgeKeys: Object.freeze([]),
        }),
        summary: Object.freeze({ nodeCount: 1, edgeCount: 3, clusterCount: 2 }),
      });
    },
  };

  const result = await persistMemoryRevision({
    brainDir: '/unused',
    memory,
    writer: {
      readManifest: async () => manifest,
      appendMemoryRevision: async () => { appendCalls += 1; },
      rewriteMemoryBase: async () => { throw new Error('full rewrite not expected'); },
    },
  });

  assert.equal(result.mode, 'reused');
  assert.equal(result.manifest, manifest);
  assert.equal(appendCalls, 0);
});

test('summary-only repair publishes coherent authority through the production writer and reader', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-summary-repair-brain-'));
  const home23Root = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-summary-repair-home-'));
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  await rewriteMemoryBase(dir, {
    nodes: [{ id: '42', concept: 'one canonical node', cluster: 7 }],
    edges: [],
    summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
  }, { lockRoot });
  const stale = await readManifest(dir);
  await fsp.writeFile(path.join(dir, 'memory-manifest.json'), `${JSON.stringify({
    ...stale,
    summary: { nodeCount: 2, edgeCount: 0, clusterCount: 1 },
  }, null, 2)}\n`);
  const memory = {
    capturePersistenceChangesSnapshot() {
      return Object.freeze({
        generation: 5,
        changes: Object.freeze({
          nodes: Object.freeze([]), edges: Object.freeze([]),
          removedNodeIds: Object.freeze([]), removedEdgeKeys: Object.freeze([]),
        }),
        summary: Object.freeze({ nodeCount: 1, edgeCount: 0, clusterCount: 1 }),
      });
    },
    markPersistenceCleanIfGeneration() {
      throw new Error('summary-only repair must not consume a dirty generation');
    },
  };

  const result = await persistMemoryRevision({ brainDir: dir, home23Root, memory });
  assert.equal(result.mode, 'summary-repair');
  assert.equal(result.manifest.currentRevision, stale.currentRevision);
  assert.deepEqual(result.manifest.summary, { nodeCount: 1, edgeCount: 0, clusterCount: 1 });

  const source = await openMemorySource(dir, {
    operationRoot: path.join(home23Root, 'operation'),
    lockRoot,
  });
  try {
    const nodes = [];
    for await (const node of source.iterateNodes()) nodes.push(node.id);
    assert.deepEqual(nodes, ['42']);
    assert.equal(source.descriptor.summary.nodeCount, nodes.length);
  } finally {
    await source.close();
  }
});

test('summary-only repair loses an exact-source CAS race without rewriting newer authority', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-summary-race-brain-'));
  const home23Root = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-summary-race-home-'));
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  await rewriteMemoryBase(dir, {
    nodes: [{ id: 'base', concept: 'base node', cluster: 1 }],
    edges: [],
    summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
  }, { lockRoot });
  const before = await readManifest(dir);
  let raced = false;
  const memory = {
    capturePersistenceChangesSnapshot() {
      return Object.freeze({
        generation: 8,
        changes: Object.freeze({
          nodes: Object.freeze([]), edges: Object.freeze([]),
          removedNodeIds: Object.freeze([]), removedEdgeKeys: Object.freeze([]),
        }),
        summary: Object.freeze({ nodeCount: 0, edgeCount: 0, clusterCount: 1 }),
      });
    },
  };

  await assert.rejects(
    () => persistMemoryRevision({
      brainDir: dir,
      home23Root,
      memory,
      writer: {
        readManifest,
        rewriteMemoryBase,
        appendMemoryRevision: async (brainDir, changes, options) => {
          if (!raced) {
            raced = true;
            await appendMemoryRevision(brainDir, {
              nodes: [{ id: 'new', concept: 'concurrent node', cluster: 2 }],
            }, {
              lockRoot,
              summary: { nodeCount: 2, edgeCount: 0, clusterCount: 2 },
            });
          }
          return appendMemoryRevision(brainDir, changes, options);
        },
      },
    }),
    (error) => error?.code === 'source_changed' && error?.retryable === true,
  );

  const after = await readManifest(dir);
  assert.equal(after.currentRevision, before.currentRevision + 1);
  assert.deepEqual(after.summary, { nodeCount: 2, edgeCount: 0, clusterCount: 2 });
});

test('a successful full rewrite schedules production retirement with global pin discovery', async () => {
  const scheduled = [];
  const calls = [];
  await persistMemoryRevision({
    brainDir: '/brain',
    home23Root: '/home23',
    memory: createTrackedMemory([]),
    forceFull: true,
    schedule: (task) => scheduled.push(task),
    retireUnpinnedSources: async (brainDir, options) => calls.push([brainDir, options]),
    writer: {
      readManifest: async () => null,
      appendMemoryRevision: async () => { throw new Error('not expected'); },
      rewriteMemoryBase: async () => ({ manifest: { currentRevision: 1 }, count: 1 }),
    },
  });
  assert.equal(scheduled.length, 1);
  await scheduled[0]();
  assert.deepEqual(calls, [['/brain', {
    home23Root: '/home23',
    lockRoot: '/home23/runtime/brain-source-locks',
  }]]);
});
