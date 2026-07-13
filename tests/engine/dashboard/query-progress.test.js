import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  reduceQueryProgressSnapshot,
  validateQueryProgressSnapshot,
} = require('../../../engine/src/dashboard/brain-operations/query-progress.js');

test('settled PGS progress is monotonic and bounded', () => {
  const first = reduceQueryProgressSnapshot(null, {
    type: 'progress',
    stage: 'sweep_batch_complete',
    selected: 10,
    completed: 4,
    successful: 3,
    failed: 1,
    reused: 0,
    pending: 6,
    retryable: 1,
    total: 10,
  }, { operationType: 'pgs', nextSequence: 7, now: 1_783_000_000_000 });
  assert.equal(first.stage, 'sweeping');
  assert.equal(first.eventSequence, 7);
  assert.throws(() => reduceQueryProgressSnapshot(first, {
    type: 'progress', stage: 'sweep_batch_complete', completed: 3, total: 10,
  }, { operationType: 'pgs', nextSequence: 8, now: 1_783_000_001_000 }), /progress_snapshot_invalid/);
});

test('v1 snapshot accepts only the exact source, work, synthesis, and activity fields', () => {
  const snapshot = {
    version: 1,
    stage: 'synthesizing',
    eventSequence: 12,
    sourceNodes: 100,
    sourceEdges: 200,
    candidateWorkUnits: 12,
    selected: 8,
    completed: 8,
    successful: 7,
    failed: 1,
    reused: 2,
    pending: 0,
    retryable: 1,
    total: 10,
    synthesisLevel: 2,
    synthesisBatch: 1,
    synthesisBatches: 3,
    lastProviderActivityAt: '2026-07-13T12:00:00.000Z',
    lastProgressAt: '2026-07-13T12:00:01.000Z',
  };
  assert.deepEqual(validateQueryProgressSnapshot(snapshot), snapshot);
  assert.throws(
    () => validateQueryProgressSnapshot({ ...snapshot, updatedAt: snapshot.lastProgressAt }),
    /progress_snapshot_invalid/,
  );
  assert.throws(
    () => validateQueryProgressSnapshot({ ...snapshot, sourceNodes: Number.MAX_SAFE_INTEGER + 1 }),
    /progress_snapshot_invalid/,
  );
});

test('v1 snapshot rejects impossible partial settled-work algebra', () => {
  const base = { version: 1, stage: 'sweeping', eventSequence: 1 };
  for (const counters of [
    { selected: 3, completed: 4 },
    { completed: 3, successful: 4 },
    { completed: 3, failed: 4 },
    { selected: 3, successful: 4 },
    { selected: 3, failed: 4 },
    { selected: 3, pending: 4 },
    { selected: 3, reused: 4 },
    { selected: 3, retryable: 4 },
    { completed: 3, reused: 4 },
    { completed: 3, retryable: 4 },
    { total: 3, completed: 4 },
    { total: 3, successful: 4 },
    { total: 3, failed: 4 },
    { total: 3, pending: 4 },
    { total: 3, reused: 4 },
    { total: 3, retryable: 4 },
    { selected: 3, successful: 2, failed: 2 },
    { selected: 3, successful: 2, failed: 1, pending: 1 },
    { selected: 5, successful: 2, failed: 1, pending: 1 },
    { total: 3, successful: 2, failed: 2 },
    { total: 3, completed: 2, pending: 2 },
    { selected: Number.MAX_SAFE_INTEGER, successful: Number.MAX_SAFE_INTEGER, failed: 1 },
    { total: Number.MAX_SAFE_INTEGER, completed: Number.MAX_SAFE_INTEGER, pending: 1 },
  ]) {
    assert.throws(
      () => validateQueryProgressSnapshot({ ...base, ...counters }),
      /progress_snapshot_invalid/,
    );
  }
});

test('raw stages map exact counters without folding global pending into active work', () => {
  const projection = reduceQueryProgressSnapshot({
    version: 1, stage: 'queued', eventSequence: 0,
  }, {
    type: 'progress',
    stage: 'projection_complete',
    nodeCount: 100,
    edgeCount: 200,
    workUnitCount: 12,
    at: '2026-07-13T12:00:00.000Z',
  }, { operationType: 'pgs', nextSequence: 1, now: 1_783_000_000_000 });
  assert.deepEqual(projection, {
    version: 1,
    stage: 'preparing_source',
    eventSequence: 1,
    sourceNodes: 100,
    sourceEdges: 200,
    candidateWorkUnits: 12,
    lastProgressAt: '2026-07-13T12:00:00.000Z',
  });

  const selected = reduceQueryProgressSnapshot(projection, {
    type: 'progress',
    stage: 'work_selected',
    candidateWorkUnits: 12,
    selectedWorkUnitsTotal: 8,
    pendingWorkUnits: 99,
  }, { operationType: 'pgs', nextSequence: 2, now: Date.parse('2026-07-13T12:00:01.000Z') });
  assert.equal(selected.stage, 'selecting_work');
  assert.equal(selected.candidateWorkUnits, 12);
  assert.equal(selected.selected, 8);
  assert.equal(Object.hasOwn(selected, 'pending'), false);
});

test('multi-window selection keeps sweeping stage and selected-run candidate authority', () => {
  const projection = reduceQueryProgressSnapshot(null, {
    type: 'progress',
    stage: 'projection_complete',
    workUnitCount: 1_000,
  }, { operationType: 'pgs', nextSequence: 1, now: Date.parse('2026-07-13T12:00:00.000Z') });
  const first = reduceQueryProgressSnapshot(projection, {
    type: 'progress',
    stage: 'work_selected',
    candidateWorkUnits: 100,
    selectedWorkUnitsTotal: 64,
  }, { operationType: 'pgs', nextSequence: 2, now: Date.parse('2026-07-13T12:00:01.000Z') });
  const settled = reduceQueryProgressSnapshot(first, {
    type: 'progress',
    stage: 'sweep_batch_complete',
    selected: 64,
    completed: 64,
    successful: 64,
    failed: 0,
    reused: 0,
    pending: 0,
    retryable: 0,
    total: 100,
  }, { operationType: 'pgs', nextSequence: 3, now: Date.parse('2026-07-13T12:00:02.000Z') });
  const second = reduceQueryProgressSnapshot(settled, {
    type: 'progress',
    stage: 'work_selected',
    candidateWorkUnits: 36,
    selectedWorkUnitsTotal: 100,
  }, { operationType: 'pgs', nextSequence: 4, now: Date.parse('2026-07-13T12:00:03.000Z') });

  assert.equal(first.candidateWorkUnits, 100);
  assert.equal(second.stage, 'sweeping');
  assert.equal(second.candidateWorkUnits, 100);
  assert.equal(second.selected, 100);
  assert.equal(second.pending, 36);
  assert.throws(() => reduceQueryProgressSnapshot(settled, {
    type: 'progress',
    stage: 'work_selected',
    candidateWorkUnits: 36,
    selectedWorkUnitsTotal: 101,
  }, { operationType: 'pgs', nextSequence: 4, now: Date.parse('2026-07-13T12:00:03.000Z') }),
  /progress_snapshot_invalid/);
  assert.throws(() => reduceQueryProgressSnapshot({
    ...second, stage: 'synthesizing', eventSequence: 5,
  }, {
    type: 'progress',
    stage: 'work_selected',
    candidateWorkUnits: 20,
    selectedWorkUnitsTotal: 120,
  }, { operationType: 'pgs', nextSequence: 6, now: Date.parse('2026-07-13T12:00:04.000Z') }),
  /progress_snapshot_invalid/);
});

test('provider activity and synthesis stages advance only canonical snapshot authority', () => {
  const queued = { version: 1, stage: 'queued', eventSequence: 0 };
  const provider = reduceQueryProgressSnapshot(queued, {
    type: 'provider_activity', at: '2026-07-13T12:00:00.000Z', completed: 999,
  }, { operationType: 'query', nextSequence: 1, now: 1_783_000_000_000 });
  assert.deepEqual(provider, {
    version: 1,
    stage: 'queued',
    eventSequence: 1,
    lastProviderActivityAt: '2026-07-13T12:00:00.000Z',
  });
  const reduction = reduceQueryProgressSnapshot(provider, {
    type: 'progress', stage: 'synthesis_reduction_started', level: 2, batches: 4,
  }, { operationType: 'query', nextSequence: 2, now: Date.parse('2026-07-13T12:00:01.000Z') });
  assert.equal(reduction.stage, 'synthesizing');
  assert.equal(reduction.synthesisLevel, 2);
  assert.equal(reduction.synthesisBatches, 4);
  const complete = reduceQueryProgressSnapshot(reduction, {
    type: 'progress', stage: 'synthesis_complete', levels: 3,
  }, { operationType: 'query', nextSequence: 3, now: Date.parse('2026-07-13T12:00:02.000Z') });
  assert.equal(complete.stage, 'finalizing');
  assert.equal(complete.synthesisLevel, 3);
  assert.equal(Object.hasOwn(complete, 'completed'), false);
});

test('unknown eligible progress advances time without trusting unknown counters', () => {
  const previous = {
    version: 1,
    stage: 'selecting_work',
    eventSequence: 3,
    selected: 4,
    lastProgressAt: '2026-07-13T12:00:00.000Z',
  };
  const next = reduceQueryProgressSnapshot(previous, {
    type: 'progress',
    stage: 'future_worker_stage',
    selected: 99,
    completed: 99,
    at: '2026-07-13T12:00:01.000Z',
  }, { operationType: 'pgs', nextSequence: 4, now: 0 });
  assert.deepEqual(next, {
    ...previous,
    eventSequence: 4,
    lastProgressAt: '2026-07-13T12:00:01.000Z',
  });
  assert.equal(reduceQueryProgressSnapshot(null, {
    type: 'progress', stage: 'future_worker_stage', at: '2026-07-13T12:00:01.000Z',
  }, { operationType: 'graph_export', nextSequence: 1, now: 0 }), null);
});
