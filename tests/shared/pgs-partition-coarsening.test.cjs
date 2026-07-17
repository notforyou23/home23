'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  planPartitionCoarsening,
} = require('../../shared/memory-source/pgs-partitions.cjs');

// Community detection produced 1,834 partitions on jerry, 1,661 of them <=5
// nodes — a "swim around" query became 2,694 LLM sweeps (2026-07-17). Fold
// sub-threshold partitions into a bounded set of shared buckets. This planner
// is the pure, testable brain; the projection layer applies its remap.

function counts(spec) {
  return Object.entries(spec).map(([partitionId, nodeCount]) => ({ partitionId, nodeCount }));
}

test('large partitions keep their id; small ones fold into buckets', () => {
  const map = planPartitionCoarsening(
    counts({ 'c-1': 500, 'c-2': 100, 'c-3': 40, 'c-4': 5, 'c-5': 3, 'c-6': 1 }),
    { minPartitionNodes: 40, smallPartitionBuckets: 2 },
  );
  // >=40 never move
  assert.equal(map.has('c-1'), false);
  assert.equal(map.has('c-2'), false);
  assert.equal(map.has('c-3'), false, 'exactly-at-threshold stays');
  // <40 all move to a c-small-* bucket
  for (const small of ['c-4', 'c-5', 'c-6']) {
    assert.ok(map.has(small), `${small} must be remapped`);
    assert.match(map.get(small), /^c-small-[01]$/);
  }
});

test('the 1,661-island explosion collapses to at most bucketCount partitions', () => {
  const spec = { 'c-big': 5000 };
  for (let i = 0; i < 1661; i++) spec[`c-i${i}`] = (i % 5) + 1; // 1..5 nodes each
  const map = planPartitionCoarsening(counts(spec), { minPartitionNodes: 40, smallPartitionBuckets: 16 });
  const buckets = new Set(map.values());
  assert.ok(buckets.size <= 16, `expected <=16 buckets, got ${buckets.size}`);
  assert.equal(map.has('c-big'), false);
  assert.equal(map.size, 1661, 'every island is remapped');
});

test('deterministic: same input yields the same remap', () => {
  const spec = { 'c-1': 100 };
  for (let i = 0; i < 50; i++) spec[`c-s${i}`] = 2;
  const a = planPartitionCoarsening(counts(spec), { minPartitionNodes: 40, smallPartitionBuckets: 8 });
  const b = planPartitionCoarsening(counts(spec), { minPartitionNodes: 40, smallPartitionBuckets: 8 });
  assert.deepEqual([...a.entries()].sort(), [...b.entries()].sort());
});

test('no small partitions -> empty remap (no-op)', () => {
  const map = planPartitionCoarsening(counts({ 'c-1': 500, 'c-2': 40, 'c-3': 200 }), { minPartitionNodes: 40 });
  assert.equal(map.size, 0);
});

test('a handful of small partitions is left alone (coarsening only reshapes an explosion)', () => {
  // 2 small partitions, 16 buckets -> not worth it -> no-op, ids preserved.
  const map = planPartitionCoarsening(counts({ 'c-1': 500, 'c-2': 3, 'c-3': 5 }), { minPartitionNodes: 40, smallPartitionBuckets: 16 });
  assert.equal(map.size, 0, 'few small partitions must not be reshuffled');
});

test('bucket ids are valid PGS partition ids', () => {
  const spec = { 'c-1': 100 };
  for (let i = 0; i < 30; i++) spec[`c-x${i}`] = 4;
  const map = planPartitionCoarsening(counts(spec), { minPartitionNodes: 40, smallPartitionBuckets: 16 });
  for (const target of map.values()) {
    assert.match(target, /^[A-Za-z0-9._-]+$/, `${target} must satisfy the PGS partition-id charset`);
  }
});
