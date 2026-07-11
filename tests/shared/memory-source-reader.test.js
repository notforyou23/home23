import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  openMemorySource,
  readJsonl,
  writeJsonlGzAtomic,
} = require('../../shared/memory-source');

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'home23-memory-source-reader-'));
}

async function writeJsonl(filePath, records) {
  const text = records.map((record) => JSON.stringify(record)).join('\n');
  await fsp.writeFile(filePath, text ? `${text}\n` : '', 'utf8');
  return Buffer.byteLength(text ? `${text}\n` : '', 'utf8');
}

async function createManifestFixture({
  nodes = [],
  edges = [],
  delta = [],
  generation = 'g1',
  baseRevision = 2,
  currentRevision = 5,
  activeDeltaEpoch = 'e3',
  summary = { nodeCount: 2, edgeCount: 0, clusterCount: 1 },
} = {}) {
  const dir = await tempDir();
  const nodeBase = await writeJsonlGzAtomic(path.join(dir, 'memory-nodes.base-2.jsonl.gz'), nodes);
  const edgeBase = await writeJsonlGzAtomic(path.join(dir, 'memory-edges.base-2.jsonl.gz'), edges);
  const committedBytes = await writeJsonl(path.join(dir, 'memory-delta.e3.jsonl'), delta);
  const manifest = {
    formatVersion: 1,
    generation,
    baseRevision,
    currentRevision,
    activeDeltaEpoch,
    activeBase: {
      nodes: { file: 'memory-nodes.base-2.jsonl.gz', count: nodes.length, bytes: nodeBase.bytes },
      edges: { file: 'memory-edges.base-2.jsonl.gz', count: edges.length, bytes: edgeBase.bytes },
    },
    activeDelta: {
      epoch: activeDeltaEpoch,
      file: 'memory-delta.e3.jsonl',
      fromRevision: baseRevision + 1,
      toRevision: currentRevision,
      count: currentRevision - baseRevision,
      committedBytes,
    },
    ann: { indexFile: null, metaFile: null, builtFromRevision: baseRevision },
    summary,
  };
  await fsp.writeFile(path.join(dir, 'memory-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, manifest };
}

async function collect(iterator) {
  const rows = [];
  for await (const row of iterator) rows.push(row);
  return rows;
}

test('projects base plus ordered delta upserts and tombstones at one pinned revision', async () => {
  const { dir } = await createManifestFixture({
    nodes: [
      { id: 1, concept: 'old', tag: 'base', cluster: 4 },
      { id: 2, concept: 'deleted', tag: 'base', cluster: '4' },
    ],
    edges: [{ source: 1, target: 2, weight: 0.5 }],
    delta: [
      { epoch: 'e3', sequence: 1, revision: 3, op: 'upsert_node', record: { id: 1, concept: 'updated', tag: 'updated', cluster: '4' } },
      { epoch: 'e3', sequence: 2, revision: 4, op: 'remove_node', id: 2 },
      { epoch: 'e3', sequence: 3, revision: 5, op: 'upsert_node', record: { id: 3, concept: 'new canary', tag: 'new', cluster: 4 } },
    ],
  });
  const source = await openMemorySource(dir);
  const nodes = await collect(source.iterateNodes());
  const edges = await collect(source.iterateEdges());
  assert.deepEqual(nodes.map((node) => [String(node.id), node.concept]), [['1', 'updated'], ['3', 'new canary']]);
  assert.deepEqual(edges, []);
  assert.equal(source.getEvidence().sourceHealth, 'healthy');
  assert.equal(source.getEvidence().deltaWatermark.appliedRecords, 3);
  assert.equal(source.descriptor.digest, undefined);
  await source.close();
});

test('edge overlay emits one last-write-wins row for a replaced base edge', async () => {
  const { dir } = await createManifestFixture({
    nodes: [{ id: 'n1' }, { id: 'n2' }],
    edges: [{ source: 'n1', target: 'n2', weight: 0.1 }],
    baseRevision: 2,
    currentRevision: 4,
    delta: [
      {
        epoch: 'e3',
        sequence: 1,
        revision: 3,
        op: 'upsert_edge',
        record: { source: 'n1', target: 'n2', weight: 0.5 },
      },
      {
        epoch: 'e3',
        sequence: 2,
        revision: 4,
        op: 'upsert_edge',
        record: { source: 'n1', target: 'n2', weight: 0.9 },
      },
    ],
    summary: { nodeCount: 2, edgeCount: 1, clusterCount: 0 },
  });
  const source = await openMemorySource(dir);
  try {
    assert.deepEqual(await collect(source.iterateEdges()), [
      { source: 'n1', target: 'n2', weight: 0.9 },
    ]);
  } finally {
    await source.close();
  }
});

test('ignores bytes beyond the committed delta cutoff', async () => {
  const { dir, manifest } = await createManifestFixture({
    nodes: [{ id: 1, concept: 'base' }],
    edges: [],
    delta: [
      { epoch: 'e3', sequence: 1, revision: 3, op: 'upsert_node', record: { id: 1, concept: 'committed' } },
      { epoch: 'e3', sequence: 2, revision: 4, op: 'upsert_node', record: { id: 2, concept: 'second' } },
      { epoch: 'e3', sequence: 3, revision: 5, op: 'upsert_node', record: { id: 3, concept: 'third' } },
    ],
    summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
  });
  const committed = `${JSON.stringify({ epoch: 'e3', sequence: 1, revision: 3, op: 'upsert_node', record: { id: 1, concept: 'committed' } })}\n`;
  const orphan = `${JSON.stringify({ epoch: 'e3', sequence: 2, revision: 4, op: 'upsert_node', record: { id: 9, concept: 'orphan' } })}\n`;
  await fsp.writeFile(path.join(dir, 'memory-delta.e3.jsonl'), committed + orphan);
  manifest.currentRevision = 3;
  manifest.activeDelta.toRevision = 3;
  manifest.activeDelta.count = 1;
  manifest.activeDelta.committedBytes = Buffer.byteLength(committed);
  await fsp.writeFile(path.join(dir, 'memory-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const source = await openMemorySource(dir);
  const nodes = await collect(source.iterateNodes());
  assert.deepEqual(nodes.map((node) => node.concept), ['committed']);
  await source.close();
});

test('committed JSONL reader tolerates append-only bytes beyond its pinned prefix', async () => {
  const dir = await tempDir();
  const deltaPath = path.join(dir, 'committed-prefix.jsonl');
  const committed = [
    { sequence: 1, value: 'first' },
    { sequence: 2, value: 'second' },
  ];
  const committedBytes = await writeJsonl(deltaPath, committed);
  const iterator = readJsonl(deltaPath, {
    confinedRoot: dir,
    byteLimit: committedBytes,
    requireCompletePrefix: true,
    allowTrailingBytes: true,
  });
  const first = await iterator.next();
  assert.deepEqual(first.value, committed[0]);

  await fsp.appendFile(deltaPath, `${JSON.stringify({ sequence: 3, value: 'uncommitted' })}\n`);
  const rows = [first.value];
  for await (const row of iterator) rows.push(row);
  assert.deepEqual(rows, committed);
});

test('committed JSONL reader rejects an in-place change to its pinned prefix', async () => {
  const dir = await tempDir();
  const deltaPath = path.join(dir, 'changed-prefix.jsonl');
  const committed = [
    { sequence: 1, value: 'first' },
    { sequence: 2, value: 'second' },
  ];
  const committedBytes = await writeJsonl(deltaPath, committed);
  const iterator = readJsonl(deltaPath, {
    confinedRoot: dir,
    byteLimit: committedBytes,
    requireCompletePrefix: true,
    allowTrailingBytes: true,
  });
  assert.deepEqual((await iterator.next()).value, committed[0]);

  const text = await fsp.readFile(deltaPath, 'utf8');
  const position = Buffer.byteLength(text.slice(0, text.indexOf('first')), 'utf8');
  const handle = await fsp.open(deltaPath, 'r+');
  try {
    await handle.write(Buffer.from('F'), 0, 1, position);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await assert.rejects(async () => {
    for await (const _row of iterator) {
      // Complete the pinned iterator so its final prefix validation runs.
    }
  }, { code: 'source_changed' });
});

test('summary stays scalar and optional breakdowns are byte and key bounded', async () => {
  const { dir } = await createManifestFixture({
    nodes: [{ id: 1, concept: 'x', tag: 'huge', cluster: 1 }],
    edges: [],
    delta: [
      { epoch: 'e3', sequence: 1, revision: 3, op: 'upsert_node', record: { id: 1, concept: 'x' } },
      { epoch: 'e3', sequence: 2, revision: 4, op: 'upsert_node', record: { id: 2, concept: 'y' } },
      { epoch: 'e3', sequence: 3, revision: 5, op: 'upsert_node', record: { id: 3, concept: 'z' } },
    ],
    summary: { nodeCount: 999999, edgeCount: 7, clusterCount: 333 },
  });
  const source = await openMemorySource(dir);
  assert.deepEqual(await source.summarize(), { nodes: 999999, edges: 7, clusters: 333 });
  const breakdowns = await source.summarizeBreakdowns({ maxKeys: 100, maxBytes: 64 * 1024 });
  assert.equal(breakdowns.tags, null);
  assert.equal(breakdowns.clusterTotals, null);
  assert.equal(breakdowns.omitted, true);
  assert.equal(breakdowns.scannedNodes, source.descriptor.summary.nodeCount);
  assert.equal(source.maxBreakdownKeys <= 100, true);
  await source.close();
});

test('a missing active base is unavailable rather than healthy empty', async () => {
  const { dir } = await createManifestFixture({
    delta: [
      { epoch: 'e3', sequence: 1, revision: 3, op: 'upsert_node', record: { id: 1, concept: 'updated' } },
      { epoch: 'e3', sequence: 2, revision: 4, op: 'upsert_node', record: { id: 2, concept: 'updated' } },
      { epoch: 'e3', sequence: 3, revision: 5, op: 'upsert_node', record: { id: 3, concept: 'updated' } },
    ],
  });
  await fsp.rm(path.join(dir, 'memory-nodes.base-2.jsonl.gz'));
  const source = await openMemorySource(dir);
  await assert.rejects(() => collect(source.iterateNodes()), { code: 'source_unavailable' });
  assert.equal(source.getEvidence().sourceHealth, 'unavailable');
  assert.equal(source.getEvidence({ completeCoverage: true }).matchOutcome, 'unknown');
  await source.close();
});

test('short-token keyword canary is searchable with complete-coverage evidence', async () => {
  const { dir } = await createManifestFixture({
    nodes: [{ id: 1, concept: 'AI' }],
    edges: [],
    delta: [
      { epoch: 'e3', sequence: 1, revision: 3, op: 'upsert_node', record: { id: 1, concept: 'AI' } },
      { epoch: 'e3', sequence: 2, revision: 4, op: 'upsert_node', record: { id: 2, concept: 'other' } },
      { epoch: 'e3', sequence: 3, revision: 5, op: 'upsert_node', record: { id: 3, concept: 'none' } },
    ],
    summary: { nodeCount: 3, edgeCount: 0, clusterCount: 1 },
  });
  const source = await openMemorySource(dir);
  const result = await source.searchKeyword({ query: 'AI', topK: 100 });
  assert.deepEqual(result.results.map((row) => row.id), ['1']);
  assert.equal(result.evidence.sourceHealth, 'healthy');
  assert.equal(result.evidence.matchOutcome, 'matches');
  await assert.rejects(() => source.searchKeyword({ query: '   ... ' }), { code: 'invalid_request' });
  await source.close();
});
