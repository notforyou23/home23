/**
 * explore-brain.js — Explore a brain's structure without any API keys
 *
 * Loads the physics2 brain, partitions it using Louvain community detection,
 * and prints detailed partition structure with stats. This is purely
 * algorithmic — no LLM calls, no API keys required.
 *
 * Usage:
 *   node examples/explore-brain.js
 */

'use strict';

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { PGSEngine } = require('../src');

// ─── Load Brain ──────────────────────────────────────────────────────

const dataPath = path.join(__dirname, 'data', 'physics2.json.gz');
console.log(`Loading brain from ${dataPath}...`);

const gz = fs.readFileSync(dataPath);
const data = JSON.parse(zlib.gunzipSync(gz).toString());
const graph = { nodes: data.nodes, edges: data.edges };

// ─── Print Metadata ──────────────────────────────────────────────────

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  BRAIN METADATA');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

if (data.metadata) {
  console.log(`  Name:        ${data.metadata.name || '(unnamed)'}`);
  console.log(`  Description: ${data.metadata.description || '(none)'}`);
  if (data.metadata.embeddingDimensions) {
    console.log(`  Embedding:   ${data.metadata.embeddingDimensions} dimensions`);
  }
}
console.log(`  Nodes:       ${graph.nodes.length}`);
console.log(`  Edges:       ${graph.edges.length}`);

// Count node tags
const tagCounts = {};
for (const node of graph.nodes) {
  const tag = node.tag || 'untagged';
  tagCounts[tag] = (tagCounts[tag] || 0) + 1;
}
console.log(`  Tags:        ${Object.keys(tagCounts).length} unique`);
for (const [tag, count] of Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`               - ${tag}: ${count}`);
}

// ─── Partition ───────────────────────────────────────────────────────

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  PARTITIONING (Louvain community detection)');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const startTime = Date.now();

// PGSEngine requires providers, but partition() is purely algorithmic.
// We pass dummy providers since we won't call execute().
const engine = new PGSEngine({
  sweepProvider: { generate: async () => ({ content: '' }) },
  synthesisProvider: { generate: async () => ({ content: '' }) }
});

const partitions = engine.partition(graph);

const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
console.log(`\n  Partitioned ${graph.nodes.length} nodes into ${partitions.length} communities in ${elapsed}s\n`);

// ─── Print Partitions ────────────────────────────────────────────────

for (const p of partitions) {
  console.log('──────────────────────────────────────────────────────────');
  console.log(`  Partition ${p.id}`);
  console.log(`  Nodes: ${p.nodeCount}`);
  console.log(`  Keywords (top 5): ${(p.keywords || []).slice(0, 5).join(', ')}`);

  if (p.adjacentPartitions && p.adjacentPartitions.length > 0) {
    console.log(`  Adjacent: ${p.adjacentPartitions.join(', ')}`);
  } else {
    console.log('  Adjacent: (none)');
  }

  if (p.summary) {
    const truncated = p.summary.length > 100 ? p.summary.substring(0, 100) + '...' : p.summary;
    console.log(`  Summary: ${truncated}`);
  }

  if (p.centroidEmbedding) {
    console.log(`  Centroid: [${p.centroidEmbedding.slice(0, 3).map(v => v.toFixed(4)).join(', ')}, ...] (${p.centroidEmbedding.length}d)`);
  }
}

// ─── Summary Stats ───────────────────────────────────────────────────

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  SUMMARY');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const sizes = partitions.map(p => p.nodeCount);
const totalNodes = sizes.reduce((a, b) => a + b, 0);
const avgSize = (totalNodes / partitions.length).toFixed(1);
const minSize = Math.min(...sizes);
const maxSize = Math.max(...sizes);

console.log(`  Total partitions:    ${partitions.length}`);
console.log(`  Total nodes covered: ${totalNodes}`);
console.log(`  Partition sizes:     min=${minSize}, avg=${avgSize}, max=${maxSize}`);

const withEmbeddings = partitions.filter(p => p.centroidEmbedding).length;
console.log(`  With centroids:      ${withEmbeddings}/${partitions.length}`);

const totalAdjacencies = partitions.reduce((sum, p) => sum + (p.adjacentPartitions?.length || 0), 0);
console.log(`  Total adjacencies:   ${totalAdjacencies}`);
console.log(`  Partition time:      ${elapsed}s`);
console.log('');
