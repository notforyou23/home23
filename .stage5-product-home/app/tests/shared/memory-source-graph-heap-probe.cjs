'use strict';

const assert = require('node:assert/strict');
const { sampleMemoryGraph } = require('../../shared/memory-source');

async function main() {
  if (typeof global.gc !== 'function') {
    throw new Error('heap probe requires --expose-gc');
  }

  const nodeCount = 1_000_000;
  const edgeCount = 3_000_000;
  let peakHeap = 0;
  function sampleHeap() {
    if (global.gc) global.gc();
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  }

  const source = {
    revision: 11,
    async *iterateNodes({ signal } = {}) {
      for (let index = 0; index < nodeCount; index += 1) {
        if (signal?.aborted) throw signal.reason;
        if (index % 10_000 === 0) sampleHeap();
        yield {
          id: `node-${index}`,
          concept: index % 997 === 0 ? 'x'.repeat(96 * 1024) : `concept ${index}`,
          tag: 'general',
          weight: index % 101,
          activation: index % 103,
          cluster: index % 97,
          created: '2026-07-10T00:00:00.000Z',
          accessCount: index % 19,
          embedding: new Array(4096).fill(index),
          metadata: { huge: 'discarded'.repeat(1000) },
        };
      }
    },
    async *iterateEdges({ signal } = {}) {
      for (let index = 0; index < edgeCount; index += 1) {
        if (signal?.aborted) throw signal.reason;
        if (index % 30_000 === 0) sampleHeap();
        yield {
          source: `node-${index % nodeCount}`,
          target: `node-${(index + 1) % nodeCount}`,
          weight: index % 53,
          metadata: { huge: 'discarded'.repeat(500) },
        };
      }
    },
    async summarize() {
      return { nodes: nodeCount, edges: edgeCount, clusters: 97 };
    },
    getEvidence(input = {}) {
      return {
        sourceHealth: 'healthy',
        matchOutcome: input.matchOutcome || 'matches',
        authoritativeTotals: input.authoritativeTotals,
        returnedTotals: input.returnedTotals,
      };
    },
  };

  const result = await sampleMemoryGraph(source, { nodeLimit: 2000, edgeLimit: 8000 });
  sampleHeap();

  assert.equal(result.nodes.length <= 2000, true);
  assert.equal(result.edges.length <= 8000, true);
  assert.equal(result.meta.maxNodeHeapSize <= 2000, true);
  assert.equal(result.meta.maxEdgeHeapSize <= 8000, true);
  assert.equal(result.meta.maxNodeRetainedBytes <= 16 * 1024 * 1024, true);
  assert.equal(result.meta.maxEdgeRetainedBytes <= 8 * 1024 * 1024, true);
  assert.equal(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 32 * 1024 * 1024, true);
  assert.equal(peakHeap < 160 * 1024 * 1024, true, `peak heap ${peakHeap}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
