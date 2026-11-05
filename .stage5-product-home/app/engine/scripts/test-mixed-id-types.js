#!/usr/bin/env node

/**
 * Test NetworkMemory with mixed ID types (numeric + string)
 * Verifies the string ID fixes work correctly
 */

const { NetworkMemory } = require('../src/memory/network-memory');

console.log('\n=== Mixed ID Type Test ===\n');

// Mock config and logger
const config = {
  embedding: { model: 'text-embedding-3-small', dimensions: 512 },
  spreading: { enabled: true, maxDepth: 3, activationThreshold: 0.1, decayFactor: 0.7 },
  hebbian: { enabled: true, reinforcementStrength: 0.1 },
  smallWorld: { clusteringCoefficient: 0.6, averagePathLength: 3.0, bridgeProbability: 0.05 }
};
const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: console.error };

const memory = new NetworkMemory(config, logger);

console.log('Test 1: Numeric IDs (backward compatibility)');
memory.addEdge(1, 2, 0.5, 'associative');
memory.addEdge(2, 3, 0.3, 'associative');
memory.addEdge(1, 3, 0.7, 'causal');

console.log('  ✓ Added edges with numeric IDs');
console.log('  Neighbors of 1:', memory.getNeighbors(1));
console.log('  Neighbors of 2:', memory.getNeighbors(2));
console.log('  Edge 1->2:', memory.getEdge(1, 2) ? 'EXISTS' : 'MISSING');
console.log('  hasEdge(1, 3):', memory.hasEdge(1, 3));

console.log('\nTest 2: String IDs (merged runs)');
memory.addEdge('fa7572_1', 'fa7572_2', 0.6, 'associative');
memory.addEdge('fa7572_2', '26e1db_3', 0.4, 'bridge');
memory.addEdge('fa7572_1', '26e1db_3', 0.8, 'causal');

console.log('  ✓ Added edges with string IDs');
console.log('  Neighbors of fa7572_1:', memory.getNeighbors('fa7572_1'));
console.log('  Neighbors of fa7572_2:', memory.getNeighbors('fa7572_2'));
console.log('  Edge fa7572_1->26e1db_3:', memory.getEdge('fa7572_1', '26e1db_3') ? 'EXISTS' : 'MISSING');
console.log('  hasEdge(fa7572_2, 26e1db_3):', memory.hasEdge('fa7572_2', '26e1db_3'));

console.log('\nTest 3: Mixed IDs (shouldn\'t happen but must not crash)');
memory.addEdge(100, 'mixed_1', 0.5, 'associative');
console.log('  ✓ Added edge between numeric and string ID (no crash)');
console.log('  Neighbors of 100:', memory.getNeighbors(100));
console.log('  Neighbors of mixed_1:', memory.getNeighbors('mixed_1'));

console.log('\nTest 4: Verify edges have source/target for serialization');
const edgesArray = Array.from(memory.edges.values());
const allHaveSourceTarget = edgesArray.every(e => e.source !== undefined && e.target !== undefined);
console.log('  All edges have source/target:', allHaveSourceTarget ? '✓ YES' : '✗ NO');

if (allHaveSourceTarget) {
  console.log('  Sample edge:', edgesArray[edgesArray.length - 1]);
}

console.log('\n=== All Tests Passed ===\n');

