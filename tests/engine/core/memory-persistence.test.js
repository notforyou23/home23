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
  compactMemoryBase,
  openMemorySource,
  readManifest,
  rewriteMemoryBase,
  rewriteMemoryBaseFromSnapshot,
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
      readManifest: async () => ({ currentRevision: 1, baseWrittenAt: new Date().toISOString() }),
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
      readManifest: async () => ({ currentRevision: 1, baseWrittenAt: new Date().toISOString() }),
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
      readManifest: async () => ({ currentRevision: 1, baseWrittenAt: new Date().toISOString() }),
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

test('large committed delta triggers a full base rewrite before the age interval', async () => {
  const events = [];
  const fullSnapshot = Object.freeze({
    generation: 12,
    changes: Object.freeze({
      nodes: Object.freeze([]), edges: Object.freeze([]),
      removedNodeIds: Object.freeze([]), removedEdgeKeys: Object.freeze([]),
    }),
    fullView: Object.freeze({
      nodes: Object.freeze([{ id: 'live', concept: 'live' }]),
      edges: Object.freeze([]),
    }),
    summary: Object.freeze({ nodeCount: 1, edgeCount: 0, clusterCount: 1 }),
  });
  const manifest = {
    baseWrittenAt: new Date().toISOString(),
    activeDelta: { committedBytes: 513 * 1024 * 1024, count: 10 },
    summary: fullSnapshot.summary,
  };
  const memory = {
    capturePersistenceChangesSnapshot() { throw new Error('changes-only snapshot not expected'); },
    capturePersistenceSnapshot() { events.push('full'); return fullSnapshot; },
    markPersistenceCleanIfGeneration(generation) { events.push(`clean:${generation}`); return true; },
  };

  const result = await persistMemoryRevision({
    brainDir: '/unused',
    memory,
    schedule: () => {},
    writer: {
      readManifest: async () => manifest,
      appendMemoryRevision: async () => { throw new Error('delta append not expected'); },
      rewriteMemoryBase: async (_brainDir, view) => {
        events.push(`rewrite:${view.nodes.length}`);
        return { manifest: { ...manifest, currentRevision: 13 }, count: 1 };
      },
    },
  });

  assert.equal(result.mode, 'full');
  assert.deepEqual(events, ['full', 'rewrite:1', 'clean:12']);
});

test('oversized delta commit falls back to a full base rewrite', async () => {
  const events = [];
  const changesSnapshot = Object.freeze({
    generation: 7,
    changes: Object.freeze({
      nodes: Object.freeze([{ id: 'new', concept: 'new' }]),
      edges: Object.freeze([]),
      removedNodeIds: Object.freeze([]),
      removedEdgeKeys: Object.freeze([]),
    }),
    summary: Object.freeze({ nodeCount: 2, edgeCount: 0, clusterCount: 1 }),
  });
  const fullSnapshot = Object.freeze({
    ...changesSnapshot,
    fullView: Object.freeze({
      nodes: Object.freeze([{ id: 'old', concept: 'old' }, { id: 'new', concept: 'new' }]),
      edges: Object.freeze([]),
    }),
  });
  const manifest = {
    baseWrittenAt: new Date().toISOString(),
    summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
  };
  const memory = {
    capturePersistenceChangesSnapshot() { events.push('changes'); return changesSnapshot; },
    capturePersistenceSnapshot() { events.push('full'); return fullSnapshot; },
    markPersistenceCleanIfGeneration(generation) { events.push(`clean:${generation}`); return true; },
  };

  const result = await persistMemoryRevision({
    brainDir: '/unused',
    memory,
    schedule: () => {},
    writer: {
      readManifest: async () => manifest,
      appendMemoryRevision: async () => {
        throw Object.assign(new Error('memory source delta_commit limit exceeded'), {
          code: 'result_too_large', limitKind: 'delta_commit',
        });
      },
      rewriteMemoryBase: async (_brainDir, view) => {
        events.push(`rewrite:${view.nodes.length}`);
        return { manifest: { ...manifest, summary: view.summary }, count: view.nodes.length };
      },
    },
  });

  assert.equal(result.mode, 'full');
  assert.equal(result.cleaned, true);
  assert.deepEqual(events, ['changes', 'full', 'rewrite:2', 'clean:7']);
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
    rebuildAnnIndex: async () => ({ status: 'fresh' }), // hermetic: no real builder spawn
    writer: {
      readManifest: async () => null,
      appendMemoryRevision: async () => { throw new Error('not expected'); },
      rewriteMemoryBase: async () => ({ manifest: { currentRevision: 1 }, count: 1 }),
    },
  });
  // A rewrite schedules retirement AND the ANN rebuild (2026-07-17: rebases
  // invalidate the generation-bound index by design, so each brings its own).
  assert.equal(scheduled.length, 2);
  for (const task of scheduled) await task();
  assert.deepEqual(calls, [['/brain', {
    home23Root: '/home23',
    lockRoot: '/home23/runtime/brain-source-locks',
  }]]);
});

function fullViewMemory() {
  const rows = [{ id: 'n1', concept: 'rewrite canary' }];
  return {
    capturePersistenceSnapshot() {
      return Object.freeze({
        generation: 5,
        changes: Object.freeze({
          nodes: Object.freeze(rows), edges: Object.freeze([]),
          removedNodeIds: Object.freeze([]), removedEdgeKeys: Object.freeze([]),
        }),
        fullView: Object.freeze({ nodes: Object.freeze(rows), edges: Object.freeze([]) }),
        summary: Object.freeze({ nodeCount: 1, edgeCount: 0, clusterCount: 1 }),
      });
    },
    markPersistenceCleanIfGeneration() { return true; },
  };
}

async function persistAgainstManifest(manifest) {
  const calls = [];
  const result = await persistMemoryRevision({
    brainDir: '/unused',
    memory: fullViewMemory(),
    schedule: () => {},
    writer: {
      readManifest: async () => manifest,
      appendMemoryRevision: async () => {
        calls.push('append');
        return { manifest: { currentRevision: 18 }, count: 1 };
      },
      rewriteMemoryBase: async () => {
        calls.push('rewrite');
        return { manifest: { currentRevision: 18 }, count: 1 };
      },
    },
  });
  return { mode: result.mode, calls };
}

test('a manifest without baseWrittenAt is due for a full rewrite', async () => {
  const { mode, calls } = await persistAgainstManifest({
    currentRevision: 17,
    summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
  });
  assert.equal(mode, 'full');
  assert.deepEqual(calls, ['rewrite']);
});

test('an unparseable baseWrittenAt is due for a full rewrite', async () => {
  const { mode, calls } = await persistAgainstManifest({
    currentRevision: 17,
    baseWrittenAt: 'not a date',
    summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
  });
  assert.equal(mode, 'full');
  assert.deepEqual(calls, ['rewrite']);
});

test('a stale baseWrittenAt is due for a full rewrite', async () => {
  const { mode, calls } = await persistAgainstManifest({
    currentRevision: 17,
    baseWrittenAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
    summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
  });
  assert.equal(mode, 'full');
  assert.deepEqual(calls, ['rewrite']);
});

test('a fresh baseWrittenAt saves as an ordinary delta, not a rewrite', async () => {
  const { mode, calls } = await persistAgainstManifest({
    currentRevision: 17,
    baseWrittenAt: new Date().toISOString(),
    summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
  });
  assert.equal(mode, 'delta');
  assert.deepEqual(calls, ['append']);
});

test('a full base rewrite schedules an ANN rebuild for the same brain', async () => {
  const scheduled = [];
  const annCalls = [];
  const result = await persistMemoryRevision({
    brainDir: '/brain',
    home23Root: '/home23',
    memory: fullViewMemory(),
    schedule: (fn) => scheduled.push(fn),
    retireUnpinnedSources: async () => ({ retired: [], retained: [] }),
    rebuildAnnIndex: async (options) => { annCalls.push(options); return { status: 'fresh' }; },
    writer: {
      readManifest: async () => null, // no manifest → forced full rewrite
      appendMemoryRevision: async () => { throw new Error('not expected'); },
      rewriteMemoryBase: async () => ({ manifest: { currentRevision: 1 }, count: 1 }),
    },
  });
  assert.equal(result.mode, 'full');
  for (const fn of scheduled) await fn();
  assert.equal(annCalls.length, 1, 'rewrite must schedule exactly one ANN rebuild');
  assert.equal(annCalls[0].brainDir, '/brain');
  assert.equal(annCalls[0].home23Root, '/home23');
});

test('an ordinary delta save schedules NO ANN rebuild (overlay covers deltas)', async () => {
  const scheduled = [];
  const annCalls = [];
  const result = await persistMemoryRevision({
    brainDir: '/brain',
    home23Root: '/home23',
    memory: fullViewMemory(),
    schedule: (fn) => scheduled.push(fn),
    rebuildAnnIndex: async (options) => { annCalls.push(options); },
    writer: {
      readManifest: async () => ({
        currentRevision: 17,
        baseWrittenAt: new Date().toISOString(),
        summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
      }),
      appendMemoryRevision: async () => ({ manifest: { currentRevision: 18 }, count: 1 }),
      rewriteMemoryBase: async () => { throw new Error('full rewrite not expected'); },
    },
  });
  assert.equal(result.mode, 'delta');
  for (const fn of scheduled) await fn();
  assert.equal(annCalls.length, 0, 'delta saves must not trigger ANN rebuilds');
});

test('an ANN rebuild failure is loud but never breaks the save', async () => {
  const scheduled = [];
  const warnings = [];
  const result = await persistMemoryRevision({
    brainDir: '/brain',
    home23Root: '/home23',
    memory: fullViewMemory(),
    schedule: (fn) => scheduled.push(fn),
    retireUnpinnedSources: async () => ({ retired: [], retained: [] }),
    rebuildAnnIndex: async () => { throw new Error('builder exploded'); },
    logger: { warn: (...a) => warnings.push(a), error: (...a) => warnings.push(a), info() {}, log() {} },
    writer: {
      readManifest: async () => null,
      appendMemoryRevision: async () => { throw new Error('not expected'); },
      rewriteMemoryBase: async () => ({ manifest: { currentRevision: 1 }, count: 1 }),
    },
  });
  assert.equal(result.mode, 'full');
  for (const fn of scheduled) await fn(); // must not throw
  assert.ok(warnings.some((w) => JSON.stringify(w).includes('builder exploded')),
    'the failure must be reported, not swallowed');
});

async function createCompactionFixture(t) {
  const home23Root = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-routine-compaction-'));
  t.after(() => fsp.rm(home23Root, { recursive: true, force: true }));
  const brainDir = path.join(home23Root, 'instances', 'jerry', 'brain');
  await fsp.mkdir(brainDir, { recursive: true });
  const nodes = [
    { id: 'n1', concept: 'retained', embedding: [0.5, -0.25], metadata: { source: ['original'] } },
    { id: 'n2', concept: 'removed later', embedding: [0.1, 0.9] },
  ];
  const edges = [{ key: 'n1->n2', source: 'n1', target: 'n2', weight: 0.5, metadata: { via: 'base' } }];
  const summary = { nodeCount: 2, edgeCount: 1, clusterCount: 0 };
  await rewriteMemoryBase(brainDir, { nodes, edges, summary }, {
    lockRoot: path.join(home23Root, 'runtime', 'brain-source-locks'),
  });
  return { home23Root, brainDir, nodes, edges, summary };
}

function createChangesOnlyMemory(changes, summary) {
  let generation = 8;
  let cleaned = false;
  let cleanCalls = 0;
  return {
    advanceGeneration() { generation += 1; },
    get cleaned() { return cleaned; },
    get cleanCalls() { return cleanCalls; },
    capturePersistenceSnapshot() { throw new Error('routine rebase cloned the full resident graph'); },
    capturePersistenceChangesSnapshot() {
      return { generation, changes, summary };
    },
    markPersistenceCleanIfGeneration(expected) {
      cleanCalls += 1;
      cleaned = generation === expected;
      return cleaned;
    },
  };
}

const emptyCompactionChanges = () => ({ nodes: [], edges: [], removedNodeIds: [], removedEdgeKeys: [] });

test('routine age and delta thresholds compact unchanged committed graphs without full capture', async (t) => {
  for (const threshold of [
    { fullRewriteIntervalMs: 0 },
    { fullRewriteDeltaBytes: 0 },
    { fullRewriteDeltaCount: 0 },
  ]) {
    const fixture = await createCompactionFixture(t);
    const before = await readManifest(fixture.brainDir);
    const memory = createChangesOnlyMemory(emptyCompactionChanges(), fixture.summary);
    const scheduled = [];
    const result = await persistMemoryRevision({
      ...fixture, ...threshold, memory,
      schedule: (task) => scheduled.push(task),
    });
    assert.equal(result.mode, 'full');
    assert.notEqual(result.manifest.generation, before.generation);
    assert.equal(result.manifest.activeDelta.count, 0);
    assert.equal(result.manifest.currentRevision, before.currentRevision + 1);
    assert.equal(memory.cleanCalls, 0, 'unchanged graph has no captured dirty markers to clear');
    assert.equal(scheduled.length, 2, 'successful compaction schedules retirement and ANN rebuild');
    const loaded = await loadMemoryRevision(fixture.brainDir, { home23Root: fixture.home23Root });
    assert.deepEqual(loaded.nodes, fixture.nodes);
    assert.deepEqual(loaded.edges, fixture.edges);
  }
});

test('overdue dirty save appends complete mutations before streaming the committed rebase', async (t) => {
  const fixture = await createCompactionFixture(t);
  const changes = {
    nodes: [
      { id: 'n1', concept: 'updated', embedding: [0.7, -0.4], metadata: { source: ['new'], nested: { kept: true } } },
      { id: 'n3', concept: 'new node', embedding: [0.2, 0.8], extra: ['preserved'] },
    ],
    edges: [{ key: 'n1->n3', source: 'n1', target: 'n3', weight: 0.8, metadata: { via: 'delta' } }],
    removedNodeIds: ['n2'],
    removedEdgeKeys: ['n1->n2'],
  };
  const memory = createChangesOnlyMemory(changes, fixture.summary);
  const events = [];
  const result = await persistMemoryRevision({
    ...fixture, memory, fullRewriteIntervalMs: 0, schedule: () => {},
    writer: {
      readManifest,
      rewriteMemoryBase: async () => { throw new Error('full-view rewrite not expected'); },
      appendMemoryRevision: async (brainDir, captured, options) => {
        events.push('append');
        assert.equal(captured, changes);
        assert.match(options.expectedDigest, /^sha256:[a-f0-9]{64}$/);
        return appendMemoryRevision(brainDir, captured, options);
      },
      compactMemoryBase: async (brainDir, options) => {
        events.push('compact');
        const committed = await readManifest(brainDir);
        assert.ok(committed.activeDelta.count > 0);
        assert.equal(options.expectedRevision, committed.currentRevision);
        assert.equal(options.expectedGeneration, committed.generation);
        return compactMemoryBase(brainDir, options);
      },
    },
  });
  assert.deepEqual(events, ['append', 'compact']);
  assert.equal(result.cleaned, true);
  assert.equal(result.manifest.activeDelta.count, 0);
  const loaded = await loadMemoryRevision(fixture.brainDir, { home23Root: fixture.home23Root });
  assert.deepEqual(loaded.nodes, changes.nodes);
  assert.deepEqual(loaded.edges, changes.edges);
});

test('failed overdue append never compacts or acknowledges dirty memory', async (t) => {
  const fixture = await createCompactionFixture(t);
  const memory = createChangesOnlyMemory({ ...emptyCompactionChanges(), nodes: [fixture.nodes[0]] }, fixture.summary);
  let compactions = 0;
  const scheduled = [];
  await assert.rejects(persistMemoryRevision({
    ...fixture, memory, fullRewriteIntervalMs: 0, schedule: (task) => scheduled.push(task),
    writer: {
      readManifest,
      appendMemoryRevision: async () => { throw new Error('disk full'); },
      compactMemoryBase: async () => { compactions += 1; },
    },
  }), /disk full/);
  assert.equal(compactions, 0);
  assert.equal(memory.cleanCalls, 0);
  assert.equal(scheduled.length, 0);
});

test('failed compaction preserves appended data and dirty markers without scheduling maintenance', async (t) => {
  const fixture = await createCompactionFixture(t);
  const changes = { ...emptyCompactionChanges(), nodes: [{ ...fixture.nodes[0], concept: 'durably appended' }] };
  const memory = createChangesOnlyMemory(changes, fixture.summary);
  const before = await readManifest(fixture.brainDir);
  const scheduled = [];
  await assert.rejects(persistMemoryRevision({
    ...fixture, memory, fullRewriteIntervalMs: 0, schedule: (task) => scheduled.push(task),
    writer: {
      readManifest, appendMemoryRevision,
      compactMemoryBase: async () => {
        throw Object.assign(new Error('compaction source changed'), { code: 'source_changed', retryable: true });
      },
    },
  }), { code: 'source_changed', retryable: true });
  assert.equal(memory.cleanCalls, 0);
  assert.equal(scheduled.length, 0);
  const after = await readManifest(fixture.brainDir);
  assert.equal(after.generation, before.generation);
  assert.ok(after.currentRevision > before.currentRevision);
  const loaded = await loadMemoryRevision(fixture.brainDir, { home23Root: fixture.home23Root });
  assert.equal(loaded.nodes.find((node) => node.id === 'n1').concept, 'durably appended');
});

test('resident mutations during streaming compaction remain dirty after commit', async (t) => {
  const fixture = await createCompactionFixture(t);
  const memory = createChangesOnlyMemory({ ...emptyCompactionChanges(), nodes: [fixture.nodes[0]] }, fixture.summary);
  const result = await persistMemoryRevision({
    ...fixture, memory, fullRewriteIntervalMs: 0, schedule: () => {},
    writer: {
      readManifest, appendMemoryRevision,
      compactMemoryBase: async (brainDir, options) => {
        memory.advanceGeneration();
        return compactMemoryBase(brainDir, options);
      },
    },
  });
  assert.equal(result.mode, 'full');
  assert.equal(result.cleaned, false);
  assert.equal(memory.cleaned, false);
  assert.equal(memory.cleanCalls, 1);
});

test('compaction refuses a concurrent persisted revision instead of acknowledging its graph', async (t) => {
  const fixture = await createCompactionFixture(t);
  const memory = createChangesOnlyMemory({ ...emptyCompactionChanges(), nodes: [fixture.nodes[0]] }, fixture.summary);
  const scheduled = [];
  await assert.rejects(persistMemoryRevision({
    ...fixture, memory, fullRewriteIntervalMs: 0, schedule: (task) => scheduled.push(task),
    writer: {
      readManifest, appendMemoryRevision,
      compactMemoryBase: async (brainDir, options) => {
        await appendMemoryRevision(brainDir, {
          ...emptyCompactionChanges(), nodes: [{ id: 'other-writer', concept: 'concurrent' }],
        }, { lockRoot: options.lockRoot, summary: { nodeCount: 3, edgeCount: 1, clusterCount: 0 } });
        return compactMemoryBase(brainDir, options);
      },
    },
  }), { code: 'source_changed', retryable: true });
  assert.equal(memory.cleanCalls, 0);
  assert.equal(scheduled.length, 0);
  const loaded = await loadMemoryRevision(fixture.brainDir, { home23Root: fixture.home23Root });
  assert.ok(loaded.nodes.some((node) => node.id === 'other-writer'));
});

function createStreamingMemory(nodes, edges = []) {
  let generation = 12;
  let cleanCalls = 0;
  const summary = { nodeCount: nodes.length, edgeCount: edges.length, clusterCount: 0 };
  return {
    dirtyNodeIds: new Set(nodes.map((node) => node.id)),
    dirtyEdgeKeys: new Set(),
    advanceGeneration() { generation += 1; },
    get cleanCalls() { return cleanCalls; },
    capturePersistenceSnapshot() { throw new Error('full graph allocation is forbidden'); },
    capturePersistenceChangesSnapshot() { throw new Error('all-dirty changes allocation is forbidden'); },
    capturePersistenceStreamingSnapshot() {
      const capturedGeneration = generation;
      const validate = () => {
        if (capturedGeneration !== generation) {
          throw Object.assign(new Error('resident generation changed'), { code: 'source_changed', retryable: true });
        }
      };
      return {
        generation: capturedGeneration,
        summary,
        fullView: {
          nodes: { *[Symbol.iterator]() { for (const node of nodes) { validate(); yield node; } } },
          edges: { *[Symbol.iterator]() { for (const edge of edges) { validate(); yield edge; } } },
        },
        validate,
      };
    },
    markPersistenceCleanIfGeneration(expected) {
      cleanCalls += 1;
      if (expected !== generation) return false;
      this.dirtyNodeIds.clear();
      return true;
    },
  };
}

test('large dirty generations stream before any eager changes capture', async (t) => {
  const fixture = await createCompactionFixture(t);
  const nodes = Array.from({ length: 1024 }, (_, index) => ({
    id: `dirty-${index}`, concept: `complete record ${index}`, embedding: [index / 1024, -0.5],
    metadata: { preserved: [index, true] },
  }));
  const memory = createStreamingMemory(nodes);
  const scheduled = [];
  const result = await persistMemoryRevision({
    ...fixture, memory, schedule: (task) => scheduled.push(task),
  });
  assert.equal(result.mode, 'full');
  assert.equal(result.cleaned, true);
  assert.equal(result.persistedChanges, null);
  assert.equal(result.persistedChangesCaptured, false);
  assert.equal(scheduled.length, 2);
  const loaded = await loadMemoryRevision(fixture.brainDir, { home23Root: fixture.home23Root });
  assert.deepEqual(loaded.nodes, nodes);
  assert.deepEqual(loaded.edges, []);
});

test('initial and explicit full saves use streaming snapshots when supported', async (t) => {
  for (const forceFull of [false, true]) {
    const fixture = await createCompactionFixture(t);
    if (!forceFull) {
      await fsp.rm(path.join(fixture.brainDir, 'memory-manifest.json'));
    }
    const memory = createStreamingMemory(fixture.nodes, fixture.edges);
    const result = await persistMemoryRevision({
      ...fixture, memory, forceFull, schedule: () => {},
      writer: {
        readManifest, compactMemoryBase,
        rewriteMemoryBaseFromSnapshot: async (brainDir, snapshot, options) => {
          if (forceFull) {
            assert.match(options.expectedDigest, /^sha256:[a-f0-9]{64}$/);
            assert.equal(options.expectedRevision, (await readManifest(brainDir)).currentRevision);
          } else {
            assert.equal(options.expectedSourceAbsent, true);
          }
          return rewriteMemoryBaseFromSnapshot(brainDir, snapshot, options);
        },
      },
    });
    assert.equal(result.mode, 'full');
    assert.equal(result.cleaned, true);
    assert.equal(result.persistedChangesCaptured, false);
    const loaded = await loadMemoryRevision(fixture.brainDir, { home23Root: fixture.home23Root });
    assert.deepEqual(loaded.nodes, fixture.nodes);
  }
});

test('oversized small deltas fall back to streaming snapshots without full materialization', async (t) => {
  const fixture = await createCompactionFixture(t);
  const memory = createStreamingMemory(fixture.nodes, fixture.edges);
  memory.capturePersistenceChangesSnapshot = () => ({
    generation: 12,
    changes: { ...emptyCompactionChanges(), nodes: [fixture.nodes[0]] },
    summary: fixture.summary,
  });
  const result = await persistMemoryRevision({
    ...fixture, memory, schedule: () => {}, logger: { warn() {} },
    writer: {
      readManifest, compactMemoryBase, rewriteMemoryBaseFromSnapshot,
      rewriteMemoryBase: async () => { throw new Error('eager full writer is forbidden'); },
      appendMemoryRevision: async () => {
        throw Object.assign(new Error('delta too large'), { code: 'result_too_large', limitKind: 'delta_commit' });
      },
    },
  });
  assert.equal(result.mode, 'full');
  assert.equal(result.cleaned, true);
  assert.equal(result.persistedChangesCaptured, false);
  const loaded = await loadMemoryRevision(fixture.brainDir, { home23Root: fixture.home23Root });
  assert.deepEqual(loaded.nodes, fixture.nodes);
});

test('streaming snapshot failure keeps prior manifest, dirty markers, and maintenance untouched', async (t) => {
  const fixture = await createCompactionFixture(t);
  const memory = createStreamingMemory(fixture.nodes, fixture.edges);
  const before = await readManifest(fixture.brainDir);
  const scheduled = [];
  await assert.rejects(persistMemoryRevision({
    ...fixture, memory, forceFull: true, schedule: (task) => scheduled.push(task),
    writer: {
      readManifest,
      rewriteMemoryBaseFromSnapshot: async (brainDir, snapshot, options) => {
        memory.advanceGeneration();
        return rewriteMemoryBaseFromSnapshot(brainDir, snapshot, options);
      },
    },
  }), { code: 'source_changed', retryable: true });
  assert.equal(memory.cleanCalls, 0);
  assert.equal(memory.dirtyNodeIds.size, fixture.nodes.length);
  assert.equal(scheduled.length, 0);
  assert.deepEqual(await readManifest(fixture.brainDir), before);
});

test('overdue clean numeric and string node aliases rewrite canonical resident rows once', async (t) => {
  const fixture = await createCompactionFixture(t);
  const physicalNodes = [
    { id: 42, concept: 'numeric alias', embedding: [0.2, 0.8] },
    { id: '42', concept: 'canonical resident node', embedding: [0.4, 0.6], metadata: { preserved: true } },
  ];
  await rewriteMemoryBase(fixture.brainDir, {
    nodes: physicalNodes, edges: [], summary: { nodeCount: 2, edgeCount: 0, clusterCount: 0 },
  }, { lockRoot: path.join(fixture.home23Root, 'runtime', 'brain-source-locks') });
  const before = {
    ...await readManifest(fixture.brainDir),
    baseWrittenAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
  };
  await fsp.writeFile(path.join(fixture.brainDir, 'memory-manifest.json'), JSON.stringify(before));
  const memory = createStreamingMemory([physicalNodes[1]]);
  memory.dirtyNodeIds.clear();
  memory.capturePersistenceChangesSnapshot = () => ({
    generation: 12, changes: emptyCompactionChanges(),
    summary: { nodeCount: 1, edgeCount: 0, clusterCount: 0 },
  });
  const scheduled = [];
  let streamed = 0;
  const writer = {
    readManifest,
    compactMemoryBase: async () => { throw new Error('alias repair must use canonical resident rows'); },
    appendMemoryRevision: async () => { throw new Error('must not publish repaired counts over duplicate physical rows'); },
    rewriteMemoryBaseFromSnapshot: async (brainDir, snapshot, options) => {
      streamed += 1;
      assert.equal(options.expectedGeneration, before.generation);
      assert.equal(options.expectedRevision, before.currentRevision);
      assert.match(options.expectedDigest, /^sha256:[a-f0-9]{64}$/);
      return rewriteMemoryBaseFromSnapshot(brainDir, snapshot, options);
    },
  };
  const first = await persistMemoryRevision({ ...fixture, memory, writer, schedule: (task) => scheduled.push(task) });
  assert.equal(first.mode, 'full');
  assert.equal(first.manifest.summary.nodeCount, 1);
  assert.equal(first.manifest.activeBase.nodes.count, 1);
  assert.equal(first.manifest.activeDelta.count, 0);
  assert.equal(first.persistedChangesCaptured, false);
  assert.equal(memory.cleanCalls, 0);
  assert.equal(scheduled.length, 2);
  assert.deepEqual((await loadMemoryRevision(fixture.brainDir, { home23Root: fixture.home23Root })).nodes, [physicalNodes[1]]);

  const second = await persistMemoryRevision({ ...fixture, memory, writer, schedule: (task) => scheduled.push(task) });
  assert.equal(second.mode, 'reused');
  assert.equal(second.manifest.generation, first.manifest.generation);
  assert.equal(streamed, 1);
  assert.equal(memory.cleanCalls, 0);
  assert.equal(scheduled.length, 2, 'reuse must not reschedule maintenance');
});

test('overdue clean node-count repair supports older resident snapshot callers', async (t) => {
  const fixture = await createCompactionFixture(t);
  const canonical = {
    generation: 15,
    summary: { nodeCount: 1, edgeCount: 1, clusterCount: 0 },
    changes: emptyCompactionChanges(),
    fullView: { nodes: [fixture.nodes[0]], edges: fixture.edges },
  };
  let fullCaptures = 0;
  const memory = {
    capturePersistenceChangesSnapshot: () => canonical,
    capturePersistenceSnapshot: () => { fullCaptures += 1; return canonical; },
    markPersistenceCleanIfGeneration: () => { throw new Error('clean graph must not clear dirty markers'); },
  };
  const result = await persistMemoryRevision({
    ...fixture, memory, fullRewriteIntervalMs: 0, schedule: () => {},
    writer: {
      readManifest, rewriteMemoryBase,
      compactMemoryBase: async () => { throw new Error('canonical graph requires resident rewrite'); },
      appendMemoryRevision: async () => { throw new Error('summary append must not precede canonical rewrite'); },
    },
  });
  assert.equal(result.mode, 'full');
  assert.equal(result.cleaned, false);
  assert.equal(fullCaptures, 1);
  assert.equal(result.manifest.summary.nodeCount, 1);
});

test('fresh alias repair publishes canonical rows before a later overdue disk compaction', async (t) => {
  const fixture = await createCompactionFixture(t);
  const canonical = { id: '42', concept: 'canonical node', embedding: [0.4, 0.6] };
  await rewriteMemoryBase(fixture.brainDir, {
    nodes: [{ id: 42, concept: 'old alias' }, canonical], edges: [],
    summary: { nodeCount: 2, edgeCount: 0, clusterCount: 0 },
  }, { lockRoot: path.join(fixture.home23Root, 'runtime', 'brain-source-locks') });
  const memory = createStreamingMemory([canonical]);
  memory.dirtyNodeIds.clear();
  memory.capturePersistenceChangesSnapshot = () => ({
    generation: 12, changes: emptyCompactionChanges(),
    summary: { nodeCount: 1, edgeCount: 0, clusterCount: 0 },
  });
  const scheduled = [];
  const options = { ...fixture, memory, schedule: (task) => scheduled.push(task) };
  const repaired = await persistMemoryRevision(options);
  assert.equal(repaired.mode, 'full');
  assert.equal(repaired.manifest.summary.nodeCount, 1);
  assert.equal(repaired.manifest.activeBase.nodes.count, 1);
  assert.equal(repaired.persistedChangesCaptured, false);
  const compacted = await persistMemoryRevision({ ...options, fullRewriteIntervalMs: 0 });
  assert.equal(compacted.mode, 'full');
  assert.notEqual(compacted.manifest.generation, repaired.manifest.generation);
  assert.equal(compacted.manifest.activeBase.nodes.count, 1);
  assert.deepEqual((await loadMemoryRevision(fixture.brainDir, { home23Root: fixture.home23Root })).nodes, [canonical]);
  assert.equal(memory.cleanCalls, 0);
  assert.equal(scheduled.length, 4);
  const reused = await persistMemoryRevision(options);
  assert.equal(reused.mode, 'reused');
  assert.equal(scheduled.length, 4);
});
