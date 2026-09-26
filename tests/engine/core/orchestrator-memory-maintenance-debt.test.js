// Forrest, 2026-09-24..26: every overdue compaction failed after its delta
// append had committed, and saveState refused the whole state save each
// time, so every restart reverted cognition to 23 Sep. These tests drive the
// real _saveStateUnlocked with a stubbed persister (harness style of
// tests/engine/core/state-snapshot.test.js: Object.create(prototype)).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { Orchestrator } = require('../../../engine/src/core/orchestrator.js');
const persistence = require('../../../engine/src/core/memory-persistence.js');
const { readSnapshot } = require('../../../engine/src/core/brain-snapshot.js');
const { StateCompression } = require('../../../engine/src/core/state-compression.js');
const { readManifest, rewriteMemoryBase } = require('../../../shared/memory-source');

async function createSavingOrchestrator(t) {
  const home23Root = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-maintenance-debt-'));
  t.after(() => fsp.rm(home23Root, { recursive: true, force: true }));
  const logsDir = path.join(home23Root, 'instances', 'forrest', 'brain');
  await fsp.mkdir(logsDir, { recursive: true });
  await rewriteMemoryBase(logsDir, {
    nodes: [{ id: 'n1', concept: 'one' }, { id: 'n2', concept: 'two' }],
    edges: [{ key: 'n1->n2', source: 'n1', target: 'n2' }],
    summary: { nodeCount: 2, edgeCount: 1, clusterCount: 0 },
  }, { lockRoot: path.join(home23Root, 'runtime', 'brain-source-locks') });
  const entries = [];
  const logger = Object.fromEntries(['info', 'warn', 'error', 'debug']
    .map((level) => [level, (message, data) => entries.push({ level, message, data })]));
  const memory = {
    nodes: new Map([['n1', { id: 'n1' }], ['n2', { id: 'n2' }]]),
    edges: new Map([['n1->n2', { source: 'n1', target: 'n2' }]]),
    exportPersistenceShell: () => ({ nodes: [], edges: [], clusters: [], nextNodeId: 3, nextClusterId: 1 }),
  };
  const orchestrator = Object.create(Orchestrator.prototype);
  Object.assign(orchestrator, {
    logger, memory, logsDir, home23Root,
    // A two-node graph stands in for a large brain: no inline fallback.
    config: { persistence: { inlineMemoryFallbackMaxNodes: 1 } },
    cycleCount: 36424, journal: [], lastSummarization: 0, reasoningHistory: [], webSearchCount: 0,
    goals: { export: () => ({ active: [], completed: [], archived: [] }) },
    roles: { getRoles: () => [] },
    reflection: { export: () => ({}) },
    oscillator: { getStats: () => ({}) },
    stateModulator: { getState: () => ({ mode: 'active' }) },
    sleepSession: { active: false, startCycle: 0, consolidationRun: false, noticePassRun: false },
  });
  return { orchestrator, entries, logsDir };
}

function stubPersister(t, implementation) {
  const original = persistence.persistMemoryRevision;
  persistence.persistMemoryRevision = implementation;
  t.after(() => { persistence.persistMemoryRevision = original; });
}

const graphCounts = { nodes: 2, edges: 2, clusters: 0 };
const manifestSummary = { nodeCount: 2, edgeCount: 1, clusterCount: 0 };

test('a compaction failure after a committed append saves state with maintenance debt', async (t) => {
  const { orchestrator, entries, logsDir } = await createSavingOrchestrator(t);
  const committed = await readManifest(logsDir);
  const maintenanceDebt = {
    reason: 'compaction_failed', error: 'graph summary mismatch',
    retryAfter: new Date(Date.now() + 3600_000).toISOString(), graphCounts, manifestSummary,
  };
  stubPersister(t, async () => {
    throw Object.assign(new Error('graph summary mismatch'), {
      code: 'source_changed', retryable: true, graphCounts, manifestSummary,
      memoryCommitted: { manifest: committed, mode: 'delta', count: 3, bytes: 900, cleaned: false, maintenanceDebt },
    });
  });
  const result = await orchestrator._saveStateUnlocked();
  assert.equal(result.saved, true);
  assert.equal(result.sidecars, 'sidecar');
  assert.deepEqual(result.memoryMaintenanceDebt, maintenanceDebt);
  const warning = entries.find((entry) => entry.message.startsWith('Memory compaction failed after delta commit'));
  assert.deepEqual(warning.data.graphCounts, graphCounts);
  assert.deepEqual(warning.data.manifestSummary, manifestSummary);
  assert.ok(!entries.some((entry) => entry.message.startsWith('REFUSING STATE SAVE')));
  const state = await StateCompression.loadCompressed(path.join(logsDir, 'state.json'));
  assert.equal(state.cycleCount, 36424);
  assert.deepEqual(state.memory.nodes, [], 'memory stays in the revisioned source, never inline');
  const snapshot = readSnapshot(logsDir);
  assert.equal(snapshot.memoryRevision, committed.currentRevision);
  assert.equal(snapshot.memoryDeltaEntries, 3);
});

test('an uncommitted sidecar failure still refuses the save and logs the counted view', async (t) => {
  const { orchestrator, entries, logsDir } = await createSavingOrchestrator(t);
  stubPersister(t, async () => {
    throw Object.assign(new Error('resident rewrite refused — catastrophic graph loss'), {
      code: 'catastrophic_graph_loss', retryable: false, graphCounts, manifestSummary,
      residentSummary: { nodeCount: 1, edgeCount: 0, clusterCount: 0 },
    });
  });
  const result = await orchestrator._saveStateUnlocked();
  assert.equal(result.saved, false);
  assert.equal(result.reason, 'memory_sidecar_write_failed');
  const warning = entries.find((entry) => entry.message === 'Memory sidecar write failed');
  assert.deepEqual(warning.data.graphCounts, graphCounts);
  assert.deepEqual(warning.data.manifestSummary, manifestSummary);
  assert.equal(warning.data.residentSummary.nodeCount, 1);
  assert.ok(entries.some((entry) => entry.message === 'REFUSING STATE SAVE — sidecar write failed for large brain'));
  await assert.rejects(fsp.stat(path.join(logsDir, 'state.json.gz')), { code: 'ENOENT' });
});
