#!/usr/bin/env node

/**
 * splice-brain.js — One-shot brain splice for jtr→jerry merge
 *
 * Takes the merged state output from merge_runs_v2.js and grafts ONLY the
 * memory (nodes + edges) into jerry's live brain state. Everything else
 * (cycleCount, journal, thoughtHistory, conversations, goals, etc.) is
 * preserved exactly as-is in jerry's state.
 *
 * Usage:
 *   node scripts/splice-brain.js <path-to-merged-state>
 *
 * The merged state path can be .json or .json.gz (StateCompression handles both).
 */

const path = require('path');
const { StateCompression } = require('../src/core/state-compression');

const JERRY_STATE_PATH = path.resolve(__dirname, '..', '..', 'instances', 'jerry', 'brain', 'state.json');

async function main() {
  const mergedPath = process.argv[2];
  if (!mergedPath) {
    console.error('Usage: node scripts/splice-brain.js <path-to-merged-state>');
    console.error('  The merged state file is the output of merge_runs_v2.js');
    process.exit(1);
  }

  const resolvedMergedPath = path.resolve(mergedPath);

  console.log('=== Brain Splice: jtr→jerry ===\n');

  // 1. Load jerry's live state
  console.log(`Loading jerry's live state from: ${JERRY_STATE_PATH}`);
  const jerryState = await StateCompression.loadCompressed(JERRY_STATE_PATH);

  const jerryNodes = jerryState.memory?.nodes || [];
  const jerryEdges = jerryState.memory?.edges || [];
  const jerryNextNodeId = jerryState.memory?.nextNodeId || 0;

  console.log(`  jerry nodes:      ${jerryNodes.length}`);
  console.log(`  jerry edges:      ${jerryEdges.length}`);
  console.log(`  jerry nextNodeId: ${jerryNextNodeId}`);
  console.log(`  jerry cycleCount: ${jerryState.cycleCount}`);
  console.log(`  jerry timestamp:  ${jerryState.timestamp}`);
  console.log();

  // 2. Load merged state
  console.log(`Loading merged state from: ${resolvedMergedPath}`);
  const mergedState = await StateCompression.loadCompressed(resolvedMergedPath);

  const mergedNodes = mergedState.memory?.nodes || [];
  const mergedEdges = mergedState.memory?.edges || [];

  console.log(`  merged nodes: ${mergedNodes.length}`);
  console.log(`  merged edges: ${mergedEdges.length}`);
  console.log();

  // 3. Identify jtr-sourced nodes (in merged but not in jerry's original)
  const jerryNodeIds = new Set(jerryNodes.map(n => n.id));
  const jtrNodes = mergedNodes.filter(n => !jerryNodeIds.has(n.id));
  const jerryRetainedNodes = mergedNodes.filter(n => jerryNodeIds.has(n.id));

  console.log(`  jtr-sourced nodes (new):  ${jtrNodes.length}`);
  console.log(`  jerry-retained nodes:     ${jerryRetainedNodes.length}`);
  console.log();

  // 4. Compute mean weights and normalize jtr-sourced nodes
  const meanWeight = (nodes) => {
    if (nodes.length === 0) return 0;
    const sum = nodes.reduce((acc, n) => acc + (n.weight || 0.5), 0);
    return sum / nodes.length;
  };

  const jerryMean = meanWeight(jerryNodes);
  const jtrMean = meanWeight(jtrNodes);
  const ratio = jtrMean > 0 ? jerryMean / jtrMean : 1;

  console.log(`  jerry mean weight: ${jerryMean.toFixed(4)}`);
  console.log(`  jtr mean weight:   ${jtrMean.toFixed(4)}`);
  console.log(`  normalization ratio (jerry/jtr): ${ratio.toFixed(4)}`);

  // Normalize jtr-sourced node weights in the merged array
  let normalizedCount = 0;
  for (const node of mergedNodes) {
    if (!jerryNodeIds.has(node.id)) {
      const original = node.weight || 0.5;
      node.weight = Math.min(1.0, Math.max(0.1, original * ratio));
      normalizedCount++;
    }
  }

  console.log(`  nodes normalized: ${normalizedCount}`);
  console.log();

  // 5. Compute new nextNodeId
  const maxMergedId = mergedNodes.reduce((max, n) => Math.max(max, n.id), 0);
  const newNextNodeId = Math.max(maxMergedId + 1, jerryNextNodeId);

  // 6. Splice: replace only memory.nodes, memory.edges, memory.nextNodeId
  jerryState.memory.nodes = mergedNodes;
  jerryState.memory.edges = mergedEdges;
  jerryState.memory.nextNodeId = newNextNodeId;

  console.log('=== Spliced State Summary ===');
  console.log(`  nodes:       ${jerryState.memory.nodes.length}`);
  console.log(`  edges:       ${jerryState.memory.edges.length}`);
  console.log(`  nextNodeId:  ${jerryState.memory.nextNodeId}`);
  console.log(`  cycleCount:  ${jerryState.cycleCount} (preserved)`);
  console.log(`  timestamp:   ${jerryState.timestamp} (preserved)`);
  console.log();

  // 7. Save back to jerry's state path
  console.log(`Saving spliced state to: ${JERRY_STATE_PATH}`);
  const result = await StateCompression.saveCompressed(JERRY_STATE_PATH, jerryState);
  console.log(`  written: ${(result.size / 1024 / 1024).toFixed(2)} MB (compressed: ${result.compressed})`);
  console.log('\nDone. Jerry\'s brain has been spliced.');
}

main().catch(err => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
