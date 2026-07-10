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
