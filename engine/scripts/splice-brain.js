#!/usr/bin/env node

/**
 * splice-brain.js — One-shot brain splice for jtr→jerry merge
 *
 * Takes the merged state output from merge_runs_v2.js and grafts ONLY the
 * memory (nodes + edges) into jerry's live brain state. Everything else
 * (cycleCount, journal, thoughtHistory, conversations, goals, etc.) is
 * preserved exactly as-is in jerry's state.
 *
 * Handles merge_runs_v2.js output: string IDs get renumbered to sequential
 * numeric IDs, edges get remapped, merge-only metadata fields get stripped,
 * and jtr-sourced nodes get weight-normalized using provenance.origin.run.
 *
 * Usage:
 *   node scripts/splice-brain.js <path-to-merged-state>
 */

const path = require('path');
const { StateCompression } = require('../src/core/state-compression');

const JERRY_STATE_PATH = path.resolve(__dirname, '..', '..', 'instances', 'jerry', 'brain', 'state.json');
const MERGE_FIELDS = ['originalId', 'sourceRun', 'runPrefix', 'sourceRuns', 'provenance', 'degree'];

async function main() {
  const mergedPath = process.argv[2];
  if (!mergedPath) {
    console.error('Usage: node scripts/splice-brain.js <path-to-merged-state>');
    process.exit(1);
  }

  const resolvedMergedPath = path.resolve(mergedPath);
  console.log('=== Brain Splice: jtr→jerry ===\n');

  // 1. Load jerry's live state (from backup — original numeric IDs)
  console.log(`Loading jerry's live state from: ${JERRY_STATE_PATH}`);
  const jerryState = await StateCompression.loadCompressed(JERRY_STATE_PATH);
  const jerryNodes = jerryState.memory?.nodes || [];
  const jerryEdges = jerryState.memory?.edges || [];

  console.log(`  jerry nodes:      ${jerryNodes.length}`);
  console.log(`  jerry edges:      ${jerryEdges.length}`);
  console.log(`  jerry nextNodeId: ${jerryState.memory?.nextNodeId}`);
  console.log(`  jerry cycleCount: ${jerryState.cycleCount}`);
  console.log(`  jerry timestamp:  ${jerryState.timestamp}\n`);

  // 2. Load merged state (has string IDs from merge_runs_v2.js)
  console.log(`Loading merged state from: ${resolvedMergedPath}`);
  const mergedState = await StateCompression.loadCompressed(resolvedMergedPath);
  const mergedNodes = mergedState.memory?.nodes || [];
  const mergedEdges = mergedState.memory?.edges || [];

  console.log(`  merged nodes: ${mergedNodes.length}`);
  console.log(`  merged edges: ${mergedEdges.length}\n`);

  // 3. Identify jtr-sourced nodes using provenance metadata
  const jtrSourced = new Set();
  const jerrySourced = new Set();
  let unknownSource = 0;

  for (const node of mergedNodes) {
    const source = node.sourceRun || node.provenance?.origin?.run;
    if (source === 'jtr-source') {
      jtrSourced.add(node.id);
    } else if (source === 'jerry') {
      jerrySourced.add(node.id);
    } else {
      unknownSource++;
      jerrySourced.add(node.id);
    }
  }

  console.log(`  jtr-sourced nodes:   ${jtrSourced.size}`);
  console.log(`  jerry-sourced nodes: ${jerrySourced.size}`);
  if (unknownSource > 0) console.log(`  unknown source:      ${unknownSource} (treated as jerry)`);

  // 4. Weight normalization — compute means from jerry's ORIGINAL nodes
  const mean = (nodes) => {
    if (nodes.length === 0) return 0.5;
    return nodes.reduce((s, n) => s + (n.weight || 0.5), 0) / nodes.length;
  };

  const jerryMean = mean(jerryNodes);
  const jtrMergedNodes = mergedNodes.filter(n => jtrSourced.has(n.id));
  const jtrMean = mean(jtrMergedNodes);
  const ratio = jtrMean > 0 ? jerryMean / jtrMean : 1;

  console.log(`\n  jerry original mean weight: ${jerryMean.toFixed(4)}`);
  console.log(`  jtr merged mean weight:    ${jtrMean.toFixed(4)}`);
  console.log(`  normalization ratio:       ${ratio.toFixed(4)}`);

  let normalizedCount = 0;
  for (const node of mergedNodes) {
    if (jtrSourced.has(node.id)) {
      node.weight = Math.min(1.0, Math.max(0.1, (node.weight || 0.5) * ratio));
      normalizedCount++;
    }
  }
  console.log(`  nodes weight-normalized:   ${normalizedCount}\n`);

  // 5. Renumber: string merge IDs → sequential numeric IDs
  const idMap = new Map();
  let nextId = 1;
  for (const node of mergedNodes) {
    idMap.set(node.id, nextId);
    node.id = nextId;
    nextId++;
  }

  // Remap edge references
  let remappedEdges = 0;
  let droppedEdges = 0;
  const finalEdges = [];
  for (const edge of mergedEdges) {
    const newSource = idMap.get(edge.source);
    const newTarget = idMap.get(edge.target);
    if (newSource !== undefined && newTarget !== undefined) {
      edge.source = newSource;
      edge.target = newTarget;
      finalEdges.push(edge);
      remappedEdges++;
    } else {
      droppedEdges++;
    }
  }

  console.log(`  IDs renumbered: ${idMap.size} (1 through ${nextId - 1})`);
  console.log(`  edges remapped:  ${remappedEdges}`);
  if (droppedEdges > 0) console.log(`  edges dropped (orphan): ${droppedEdges}`);

  // 6. Strip merge-only metadata fields from nodes
  for (const node of mergedNodes) {
    for (const field of MERGE_FIELDS) {
      delete node[field];
    }
  }

  // 7. Splice into jerry's state
  jerryState.memory.nodes = mergedNodes;
  jerryState.memory.edges = finalEdges;
  jerryState.memory.nextNodeId = nextId;

  console.log('\n=== Spliced State Summary ===');
  console.log(`  nodes:       ${jerryState.memory.nodes.length}`);
  console.log(`  edges:       ${jerryState.memory.edges.length}`);
  console.log(`  nextNodeId:  ${jerryState.memory.nextNodeId}`);
  console.log(`  cycleCount:  ${jerryState.cycleCount} (preserved)`);
  console.log(`  timestamp:   ${jerryState.timestamp} (preserved)\n`);

  // 8. Save
  console.log(`Saving spliced state to: ${JERRY_STATE_PATH}`);
  const result = await StateCompression.saveCompressed(JERRY_STATE_PATH, jerryState);
  console.log(`  written: ${(result.size / 1024 / 1024).toFixed(2)} MB (compressed: ${result.compressed})`);
  console.log('\nDone. Jerry\'s brain has been spliced.');
}

main().catch(err => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
