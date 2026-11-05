'use strict';

const assert = require('node:assert/strict');
const {
  createBoundedCandidateHeap,
  MAX_HEAP_BYTES,
} = require('../../../engine/src/dashboard/memory-search');

if (typeof global.gc !== 'function') {
  throw new Error('run with --expose-gc');
}

global.gc();
const before = process.memoryUsage().heapUsed;
let baseScanCalls = 0;
const scanBase = () => { baseScanCalls += 1; };
const retrievalMode = 'semantic-ann-delta-overlay';
const heap = createBoundedCandidateHeap({
  maxCount: 1000,
  maxBytes: MAX_HEAP_BYTES,
});
const embedding = new Array(768).fill(0.1);
for (let index = 0; index < 1_000_000; index += 1) {
  heap.offer({
    id: `node-${index}`,
    concept: `adversarial canary ${index} ${'x'.repeat(256)}`,
    embedding,
    similarity: index % 1000 / 1000,
    retrievalScore: index % 1000 / 1000,
    retrievalMode,
  });
}
global.gc();
const after = process.memoryUsage().heapUsed;
const growth = after - before;
assert.equal(heap.length <= 1000, true);
assert.equal(heap.retainedBytes <= MAX_HEAP_BYTES, true);
assert.equal(growth < 192 * 1024 * 1024, true, `heap grew ${growth} bytes`);
assert.equal(baseScanCalls, 0);
for (const row of heap.sorted()) {
  assert.equal(Object.hasOwn(row, 'embedding'), false);
}
process.stdout.write(`${JSON.stringify({
  candidates: 1_000_000,
  retained: heap.length,
  retainedBytes: heap.retainedBytes,
  heapGrowthBytes: growth,
  baseScanCalls,
  retrievalMode,
})}\n`);
