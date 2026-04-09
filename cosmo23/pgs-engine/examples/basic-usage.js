/**
 * basic-usage.js — PGS Engine with inline mock providers
 *
 * Demonstrates the full API shape using mock LLM providers and a tiny
 * synthetic graph. No API keys needed — everything runs locally with
 * canned responses.
 *
 * Usage:
 *   node examples/basic-usage.js
 */

'use strict';

const { PGSEngine } = require('../src');

// ─── Mock Providers ──────────────────────────────────────────────────

/**
 * Mock sweep provider — returns a canned analysis per partition.
 * Real providers would call an LLM API here.
 */
const sweepProvider = {
  generate: async ({ instructions, input }) => {
    // Extract partition ID from the input (if present)
    const match = input.match(/Partition (\d+)/i);
    const partitionId = match ? match[1] : '?';
    return {
      content: [
        `[Sweep of Partition ${partitionId}]`,
        'Key findings: The data in this partition reveals connections between',
        'quantum mechanics and thermodynamic entropy. Notable observation:',
        'energy conservation principles appear to bridge multiple sub-topics.',
        'Absence detected: No discussion of relativistic corrections found.',
      ].join('\n')
    };
  }
};

/**
 * Mock synthesis provider — combines sweep results.
 */
const synthesisProvider = {
  generate: async ({ instructions, input }) => {
    return {
      content: [
        '## Synthesized Analysis',
        '',
        'Across all examined partitions, the research reveals three key themes:',
        '',
        '1. **Quantum-thermodynamic bridge**: Energy conservation principles',
        '   connect quantum mechanical observations to classical thermodynamics.',
        '',
        '2. **Cross-domain patterns**: Multiple partitions independently surfaced',
        '   similar entropy-related concepts, suggesting a unifying framework.',
        '',
        '3. **Notable absences**: Relativistic corrections were not discussed',
        '   in any partition, which may represent a gap in the research.',
        '',
        'PGS sweep coverage ensured these connections were not missed by',
        'standard top-K retrieval.',
      ].join('\n')
    };
  }
};

// ─── Synthetic Graph ─────────────────────────────────────────────────

/**
 * Build a small synthetic graph with 10 nodes and 15 edges.
 * Each node has a 4-dimensional fake embedding for routing.
 */
function buildSyntheticGraph() {
  const topics = [
    { id: '1', concept: 'Quantum entanglement enables non-local correlations between particles.', tag: 'quantum', embedding: [0.9, 0.1, 0.2, 0.3] },
    { id: '2', concept: 'Thermodynamic entropy measures disorder in closed systems.', tag: 'thermo', embedding: [0.1, 0.9, 0.2, 0.1] },
    { id: '3', concept: 'Energy conservation is fundamental to all physical processes.', tag: 'general', embedding: [0.5, 0.5, 0.8, 0.2] },
    { id: '4', concept: 'Wave-particle duality demonstrates complementarity in quantum systems.', tag: 'quantum', embedding: [0.8, 0.2, 0.3, 0.4] },
    { id: '5', concept: 'Heat transfer occurs through conduction, convection, and radiation.', tag: 'thermo', embedding: [0.2, 0.8, 0.3, 0.1] },
    { id: '6', concept: 'The Schrodinger equation governs quantum state evolution.', tag: 'quantum', embedding: [0.85, 0.15, 0.25, 0.35] },
    { id: '7', concept: 'Statistical mechanics bridges microscopic and macroscopic descriptions.', tag: 'stat_mech', embedding: [0.4, 0.6, 0.5, 0.5] },
    { id: '8', concept: 'Phase transitions exhibit critical phenomena and universality.', tag: 'stat_mech', embedding: [0.3, 0.7, 0.4, 0.6] },
    { id: '9', concept: 'Quantum decoherence explains the emergence of classical behavior.', tag: 'quantum', embedding: [0.7, 0.3, 0.4, 0.5] },
    { id: '10', concept: 'The second law of thermodynamics constrains all natural processes.', tag: 'thermo', embedding: [0.15, 0.85, 0.25, 0.15] },
  ];

  const edges = [
    { source: '1', target: '4', weight: 0.9, type: 'related' },
    { source: '1', target: '6', weight: 0.8, type: 'related' },
    { source: '1', target: '9', weight: 0.7, type: 'related' },
    { source: '2', target: '5', weight: 0.8, type: 'related' },
    { source: '2', target: '10', weight: 0.9, type: 'related' },
    { source: '3', target: '2', weight: 0.5, type: 'bridge' },
    { source: '3', target: '7', weight: 0.6, type: 'bridge' },
    { source: '4', target: '6', weight: 0.85, type: 'related' },
    { source: '4', target: '9', weight: 0.7, type: 'related' },
    { source: '5', target: '7', weight: 0.5, type: 'bridge' },
    { source: '5', target: '10', weight: 0.7, type: 'related' },
    { source: '6', target: '9', weight: 0.75, type: 'related' },
    { source: '7', target: '8', weight: 0.8, type: 'related' },
    { source: '7', target: '2', weight: 0.55, type: 'bridge' },
    { source: '8', target: '10', weight: 0.4, type: 'bridge' },
  ];

  return { nodes: topics, edges };
}

// ─── Run ─────────────────────────────────────────────────────────────

async function main() {
  console.log('PGS Engine — Basic Usage Example');
  console.log('Using mock providers with a synthetic 10-node graph\n');

  const graph = buildSyntheticGraph();
  console.log(`Graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges\n`);

  // Create engine with mock providers
  const engine = new PGSEngine({
    sweepProvider,
    synthesisProvider,
    config: {
      minCommunitySize: 2,     // Small graph needs smaller communities
      targetPartitionMax: 10,
      minNodesForPgs: 0,
    },
    onEvent: (event) => {
      if (event.type === 'partitioning' && event.partitionCount) {
        console.log(`  [partition] ${event.partitionCount} partitions created`);
      } else if (event.type === 'routing' && event.selectedCount) {
        console.log(`  [route]     ${event.selectedCount}/${event.totalCount} partitions selected`);
      } else if (event.type === 'sweeping') {
        console.log(`  [sweep]     ${event.message}`);
      } else if (event.type === 'sweep_complete') {
        console.log(`  [sweep]     Partition ${event.partitionId} done`);
      } else if (event.type === 'synthesizing') {
        console.log(`  [synth]     ${event.message}`);
      } else if (event.type === 'complete') {
        console.log(`  [done]      ${event.elapsedMs}ms`);
      }
    }
  });

  const startTime = Date.now();
  const query = 'What are the key findings in this research?';

  console.log(`Query: "${query}"\n`);
  console.log('Pipeline events:');

  try {
    const result = await engine.execute(query, graph);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  RESULT');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(result.answer);

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  METADATA');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(JSON.stringify(result.metadata, null, 2));

    console.log(`\nTotal time: ${elapsed}s`);
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  }

  // ─── Composable API Demo ────────────────────────────────────────────

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  COMPOSABLE API');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Step by step: partition -> route -> sweep -> synthesize
  const partitions = engine.partition(graph);
  console.log(`\nPartitions: ${partitions.length}`);

  const routed = await engine.route(query, graph, partitions);
  console.log(`Routed:     ${routed.length} partitions selected`);

  // Sweep each partition individually
  const sweepResults = [];
  for (const p of routed) {
    const result = await engine.sweepPartition(query, p, graph, partitions);
    sweepResults.push(result);
    console.log(`Swept:      Partition ${p.id} (${p.nodeCount} nodes)`);
  }

  const synthesis = await engine.synthesize(query, sweepResults, {
    totalNodes: graph.nodes.length,
    totalEdges: graph.edges.length,
    totalPartitions: partitions.length,
    selectedPartitions: routed.length,
  });

  console.log(`\nComposable synthesis result:\n${synthesis.substring(0, 200)}...`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
