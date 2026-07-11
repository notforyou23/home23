import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  assert.ok(end > start, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test('orchestrator feeder and background embedding writes use barrier-backed APIs', () => {
  const source = read('engine/src/core/orchestrator.js');
  const feeder = sliceBetween(
    source,
    '// Merge feeder-injected nodes:',
    '// ── MEMORY SOURCE MANIFESTS',
  );
  assert.match(feeder, /this\.memory\.importGraphChanges\(\{/);
  assert.doesNotMatch(feeder, /this\.memory\.(?:nodes|edges|clusters)\.(?:set|delete|clear)\(/);

  const embedding = sliceBetween(
    source,
    'async _regenerateEmbeddingsInBackground(nodeIds)',
    'async replayAgentJournals()',
  );
  assert.match(embedding, /this\.memory\.patchNode\(/);
  assert.match(embedding, /expectedNode: node/);
  assert.doesNotMatch(embedding, /\bnode\.(?:embedding|embedding_status)\s*=/);
});

test('recluster, summarizer, and ingestion callers expose no raw NetworkMemory writes', () => {
  const recluster = read('engine/src/memory/recluster.js');
  assert.match(recluster, /memory\.applyReclusterPlan\(plan\)/);
  assert.doesNotMatch(recluster, /memory\.(?:clusters|nodes)\.(?:set|delete|clear)\(/);
  assert.doesNotMatch(recluster, /\bnode\.cluster\s*=/);

  const summarizer = read('engine/src/memory/summarizer.js');
  assert.match(summarizer, /memoryNetwork\.patchNodes\(/);
  assert.match(summarizer, /memoryNetwork\.patchNode\(/);
  assert.match(summarizer, /memoryNetwork\.removeNodes\(/);
  assert.doesNotMatch(summarizer, /memoryNetwork\.(?:nodes|edges|clusters)\.(?:set|delete|clear)\(/);
  assert.doesNotMatch(summarizer, /\b(?:node|summaryNode)\.(?:consolidatedAt|metadata)\s*=/);

  const ingestion = read('engine/src/ingestion/ingestion-manifest.js');
  assert.match(ingestion, /this\.memory\.patchNode\(/);
  assert.doesNotMatch(ingestion, /\bnode\.metadata\s*=/);

  const cosmoSummarizer = read('cosmo23/engine/src/memory/summarizer.js');
  assert.match(cosmoSummarizer, /memoryNetwork\.patchNodes\(/);
  assert.match(cosmoSummarizer, /memoryNetwork\.removeNodes\(/);
  assert.doesNotMatch(cosmoSummarizer, /memoryNetwork\.(?:nodes|edges|clusters)\.(?:set|delete|clear)\(/);
  assert.doesNotMatch(cosmoSummarizer, /\bnode\.consolidatedAt\s*=/);

  const cosmoIngestion = read('cosmo23/engine/src/ingestion/ingestion-manifest.js');
  assert.match(cosmoIngestion, /this\.memory\.patchNode\(/);
  assert.doesNotMatch(cosmoIngestion, /\bnode\.metadata\s*=/);
});

test('root and COSMO topology writers preserve typed edge endpoints', () => {
  for (const relativePath of [
    'engine/src/memory/network-memory.js',
    'cosmo23/engine/src/memory/network-memory.js',
  ]) {
    const source = read(relativePath);
    const rewire = sliceBetween(source, 'async rewireSmallWorld(p)', 'Apply decay to unused nodes');
    assert.match(rewire, /edge(?:\.|\?\.)source/);
    assert.match(rewire, /edge(?:\.|\?\.)target/);
    assert.doesNotMatch(rewire, /split\(['"]->['"]\)\.map\(Number\)/);
  }
});

test('root and COSMO cluster merge paths use one suppressed graph import without raw map bypasses', () => {
  for (const relativePath of [
    'engine/src/cluster/cluster-aware-memory.js',
    'cosmo23/engine/src/cluster/cluster-aware-memory.js',
  ]) {
    const source = read(relativePath);
    const merge = sliceBetween(source, 'async fetchMergedState(cycle)', 'applyNodeSnapshot(data)');
    assert.match(merge, /withSuppressedTracking\(\(\) => this\.localMemory\.importGraphChanges\(\{/);
    assert.doesNotMatch(merge, /Map\.prototype\.(?:set|delete|clear)\.call/);
    assert.doesNotMatch(merge, /localMemory\.(?:nextNodeId|nextClusterId)\s*=/);
  }
});
