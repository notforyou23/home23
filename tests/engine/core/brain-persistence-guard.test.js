import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  countSidecarNodes,
  evaluateSaveSafety,
  resolveKnownGoodNodeCount,
} from '../../../engine/src/core/brain-persistence-guard.js';
import {
  appendMemoryDelta,
  edgesPath,
  nodesPath,
  writeJsonlGz,
  writeMemorySidecars,
} from '../../../engine/src/core/memory-sidecar.js';
import { StateCompression } from '../../../engine/src/core/state-compression.js';

test('resolveKnownGoodNodeCount prefers brain-snapshot count', async () => {
  const result = await resolveKnownGoodNodeCount('/tmp/unused', '/tmp/state.json', {
    readSnapshot: () => ({ nodeCount: 34074 }),
    sidecarsExist: () => true,
    countSidecarNodes: async () => 12,
    loadCompressed: async () => ({ memory: { nodes: [{ id: 'inline' }] } }),
  });

  assert.deepEqual(result, { count: 34074, source: 'snapshot' });
});

test('resolveKnownGoodNodeCount counts memory sidecar before empty small-shape state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-guard-'));
  const statePath = join(dir, 'state.json');
  const nodes = Array.from({ length: 125 }, (_, i) => ({ id: `n${i}`, concept: `node ${i}` }));
  await writeMemorySidecars(dir, { nodes, edges: [] });
  await StateCompression.saveCompressed(statePath, { memory: { nodes: [], edges: [] } });

  const result = await resolveKnownGoodNodeCount(dir, statePath, {
    readSnapshot: () => null,
  });

  assert.equal(result.count, 125);
  assert.equal(result.source, 'memory-manifest');
});

test('resolveKnownGoodNodeCount uses manifest summary without scanning graph records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-guard-manifest-summary-'));
  const statePath = join(dir, 'state.json');
  await writeMemorySidecars(dir, {
    nodes: [{ id: 'n1' }, { id: 'n2' }],
    edges: [{ source: 'n1', target: 'n2' }],
  });

  const result = await resolveKnownGoodNodeCount(dir, statePath, {
    countSidecarNodes: async () => {
      throw new Error('sidecar scan called');
    },
    readSnapshot: () => {
      throw new Error('snapshot fallback called');
    },
    loadCompressed: async () => {
      throw new Error('state fallback called');
    },
  });

  assert.deepEqual(result, { count: 2, source: 'memory-manifest' });
});

test('countSidecarNodes reads manifest totals without traversing edge records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-guard-manifest-edges-'));
  await writeMemorySidecars(dir, {
    nodes: [{ id: 'n1' }, { id: 'n2' }],
    edges: [{ source: 'n1', target: 'n2' }],
  });

  assert.equal(await countSidecarNodes(dir), 2);
});

test('countSidecarNodes applies legacy node deltas', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-guard-legacy-delta-'));
  await writeJsonlGz(nodesPath(dir), [{ id: 'n1' }, { id: 'n2' }]);
  await writeJsonlGz(edgesPath(dir), []);
  await appendMemoryDelta(dir, {
    nodes: [{ id: 'n3' }, { id: 'n4' }],
    removedNodeIds: ['n1'],
  });

  assert.equal(await countSidecarNodes(dir), 3);
});

test('resolveKnownGoodNodeCount uses the committed summary after manifest deltas', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-guard-delta-'));
  const statePath = join(dir, 'state.json');
  await writeMemorySidecars(dir, {
    nodes: [{ id: 'n1' }, { id: 'n2' }],
    edges: [],
  });
  await appendMemoryDelta(dir, {
    nodes: [{ id: 'n3' }, { id: 'n4' }],
    removedNodeIds: ['n1'],
    summary: { nodeCount: 3, edgeCount: 0, clusterCount: 0 },
  });
  await StateCompression.saveCompressed(statePath, { memory: { nodes: [], edges: [] } });

  const result = await resolveKnownGoodNodeCount(dir, statePath, {
    readSnapshot: () => null,
  });

  assert.equal(result.count, 3);
  assert.equal(result.source, 'memory-manifest');
});

test('resolveKnownGoodNodeCount falls back to inline state when no snapshot or sidecars exist', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-guard-inline-'));
  const statePath = join(dir, 'state.json');
  await StateCompression.saveCompressed(statePath, {
    memory: { nodes: [{ id: 'a' }, { id: 'b' }], edges: [] },
  });

  const result = await resolveKnownGoodNodeCount(dir, statePath, {
    readSnapshot: () => null,
  });

  assert.equal(result.count, 2);
  assert.equal(result.source, 'state-file');
  assert.equal(result.state.memory.nodes.length, 2);
});

test('evaluateSaveSafety refuses catastrophic drops with explicit metadata', () => {
  const result = evaluateSaveSafety({
    currentNodes: 12,
    existingNodes: 125,
    source: 'memory-sidecar',
    cycle: 77,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'catastrophic_node_loss');
  assert.equal(result.dropPercent, 90.4);
  assert.equal(result.source, 'memory-sidecar');
});

test('evaluateSaveSafety allows normal saves and fresh brains', () => {
  assert.equal(evaluateSaveSafety({ currentNodes: 80, existingNodes: 125 }).ok, true);
  assert.equal(evaluateSaveSafety({ currentNodes: 0, existingNodes: 0 }).ok, true);
});
