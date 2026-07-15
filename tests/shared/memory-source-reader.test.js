import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { constants as fsConstants, promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  createOperationScratchQuota,
  openMemorySource,
  readJsonl,
  writeJsonlGzAtomic,
} = require('../../shared/memory-source');
const {
  acceptsWritableOpenCtimeDrift,
  openConfinedRegularFile,
} = require('../../shared/memory-source/confined-file.cjs');
const { OPENED_JSONL_FILE } = require('../../shared/memory-source/private-capabilities.cjs');
const {
  attestMemoryAuthority,
} = require('../../shared/memory-authority-attestation.cjs');

const AUTHORITY_KEY = '4'.repeat(64);
const priorAuthorityKey = process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY;
process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY = AUTHORITY_KEY;
test.after(() => {
  if (priorAuthorityKey === undefined) delete process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY;
  else process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY = priorAuthorityKey;
});

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'home23-memory-source-reader-'));
}

async function writeJsonl(filePath, records) {
  const text = records.map((record) => JSON.stringify(record)).join('\n');
  await fsp.writeFile(filePath, text ? `${text}\n` : '', 'utf8');
  return Buffer.byteLength(text ? `${text}\n` : '', 'utf8');
}

function confinedStat({ dev = 1n, ino = 2n, size = 3n, mtimeNs = 4n, ctimeNs = 5n } = {}) {
  return {
    dev,
    ino,
    size,
    mtimeNs,
    ctimeNs,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}

test('writable open accepts only ctime drift confirmed by a stable pathname restat', () => {
  const before = confinedStat();
  const opened = confinedStat({ ctimeNs: 6n });
  const stableRestat = confinedStat({ ctimeNs: 6n });

  assert.equal(acceptsWritableOpenCtimeDrift(before, opened, stableRestat, fsConstants.O_RDWR), true);
  assert.equal(acceptsWritableOpenCtimeDrift(before, opened, stableRestat, fsConstants.O_RDONLY), false);
  assert.equal(
    acceptsWritableOpenCtimeDrift(before, opened, confinedStat({ size: 4n, ctimeNs: 6n }), fsConstants.O_RDWR),
    false,
  );
  assert.equal(
    acceptsWritableOpenCtimeDrift(before, opened, confinedStat({ ino: 9n, ctimeNs: 6n }), fsConstants.O_RDWR),
    false,
  );
});

test('node-search overlay provider bypasses delta replay while preserving logical nodes', async () => {
  const delta = [{
    epoch: 'e3', sequence: 99, revision: 99, op: 'upsert_node',
    record: { id: 'would-fail-replay', concept: 'invalid physical delta' },
  }];
  const { dir, manifest } = await createManifestFixture({
    nodes: [{ id: 'base', concept: 'base node' }],
    delta,
    baseRevision: 2,
    currentRevision: 3,
    summary: { nodeCount: 2, edgeCount: 0, clusterCount: 1 },
  });
  let refreshes = 0;
  const logicalDelta = Object.freeze({ id: 'delta', concept: 'cached current node' });
  const source = await openMemorySource(dir, {
    nodeOverlayProvider: {
      async refresh({ canonicalRoot, manifest: received }) {
        refreshes += 1;
        assert.equal(canonicalRoot, await fsp.realpath(dir));
        assert.equal(received.currentRevision, manifest.currentRevision);
        return {
          deltaRecords: 1,
          nodeUpserts: () => Object.freeze([logicalDelta]),
          hasNodeUpsert: (id) => id === 'delta',
          hasRemovedNode: () => false,
        };
      },
    },
  });
  try {
    assert.deepEqual((await collect(source.iterateNodes())).map((node) => node.id), ['base', 'delta']);
    assert.equal(refreshes, 1);
    await assert.rejects(async () => {
      for await (const _edge of source.iterateEdges()) {}
    }, { code: 'source_operation_required' });
  } finally {
    await source.close();
  }
});

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

async function* records(count, createRecord) {
  for (let index = 0; index < count; index += 1) {
    yield createRecord(index);
  }
}

async function countOpenDescriptorsFor(filePath) {
  const descriptorRoot = process.platform === 'darwin' ? '/dev/fd' : '/proc/self/fd';
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null;
  const target = await fsp.stat(filePath, { bigint: true });
  const descriptors = await fsp.readdir(descriptorRoot);
  const matches = await Promise.all(descriptors.map(async (descriptor) => {
    try {
      const candidate = await fsp.stat(path.join(descriptorRoot, descriptor), { bigint: true });
      const sameFile = process.platform === 'darwin'
        ? candidate.ino === target.ino && candidate.size === target.size
        : candidate.dev === target.dev && candidate.ino === target.ino;
      return sameFile ? 1 : 0;
    } catch (error) {
      if (error?.code === 'EBADF' || error?.code === 'ENOENT') return 0;
      throw error;
    }
  }));
  return matches.reduce((total, match) => total + match, 0);
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
  const evidence = source.getEvidence();
  assert.equal(evidence.sourceHealth, 'healthy');
  assert.equal(evidence.freshness, 'known');
  assert.equal(evidence.deltaWatermark.appliedRecords, 3);
  assert.equal(source.descriptor.digest, undefined);
  await source.close();
});

test('manifest delta loading uses bounded durable batches instead of one quota cycle per record', async () => {
  const entryCount = 32;
  const delta = Array.from({ length: entryCount }, (_, index) => ({
    epoch: 'e3',
    sequence: index + 1,
    revision: index + 3,
    op: 'upsert_node',
    record: { id: `batched-${index}`, concept: `value-${index}` },
  }));
  const { dir } = await createManifestFixture({
    nodes: [],
    edges: [],
    delta,
    baseRevision: 2,
    currentRevision: entryCount + 2,
    summary: { nodeCount: entryCount, edgeCount: 0, clusterCount: 0 },
  });
  const operationRoot = await tempDir();
  let ledgerPublishes = 0;
  const scratchQuota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 32 * 1024 * 1024,
    _testHooks: {
      async afterLedgerPublish() {
        ledgerPublishes += 1;
      },
    },
  });
  let source = null;
  try {
    source = await openMemorySource(dir, {
      operationRoot,
      scratchQuota,
      maxOverlayMemoryBytes: 0,
      maxOverlayDiskBytes: 16 * 1024 * 1024,
    });

    assert.equal(ledgerPublishes, 7);
    assert.equal(source.revision, entryCount + 2);
    assert.deepEqual(
      (await collect(source.iterateNodes())).map((node) => node.id),
      Array.from({ length: entryCount }, (_, index) => `batched-${index}`).sort(),
    );
  } finally {
    await source?.close();
    scratchQuota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('manifest delta loading obeys compressed-input and decoded-stream limits', async (t) => {
  const delta = [{
    epoch: 'e3',
    sequence: 1,
    revision: 3,
    op: 'upsert_node',
    record: { id: 'bounded-delta', concept: 'x'.repeat(1024) },
  }];
  const { dir } = await createManifestFixture({
    nodes: [],
    edges: [],
    delta,
    baseRevision: 2,
    currentRevision: 3,
    summary: { nodeCount: 1, edgeCount: 0, clusterCount: 0 },
  });
  try {
    for (const scenario of [
      {
        name: 'input',
        options: { maxInputBytes: 64, maxDecompressedBytes: 8 * 1024 },
        limitKind: 'input',
      },
      {
        name: 'decoded',
        options: { maxInputBytes: 8 * 1024, maxDecompressedBytes: 64 },
        limitKind: 'decompressed',
      },
    ]) {
      await t.test(scenario.name, async () => {
        await assert.rejects(
          () => openMemorySource(dir, scenario.options),
          (error) => error?.code === 'result_too_large'
            && error?.limitKind === scenario.limitKind
            && error?.limit === 64,
        );
      });
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
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

test('ignores appended bytes beyond a committed delta prefix at its exact input cap', async () => {
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
  assert.equal(
    (await fsp.stat(path.join(dir, 'memory-delta.e3.jsonl'))).size
      > manifest.activeDelta.committedBytes,
    true,
  );
  const source = await openMemorySource(dir, {
    maxInputBytes: manifest.activeDelta.committedBytes,
    maxDecompressedBytes: manifest.activeDelta.committedBytes,
  });
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

test('early iterator return quiesces large JSONL streams before closing their handles', async () => {
  const dir = await tempDir();
  const nodesPath = path.join(dir, 'memory-nodes.base-2.jsonl.gz');
  const edgesPath = path.join(dir, 'memory-edges.base-2.jsonl.gz');
  const deltaPath = path.join(dir, 'memory-delta.e0.jsonl');
  const nodeCount = 100_000;
  const edgeCount = 300_000;
  const nodes = await writeJsonlGzAtomic(nodesPath, records(nodeCount, (id) => ({
    id,
    concept: `large-source-node-${id}`,
  })));
  const edges = await writeJsonlGzAtomic(edgesPath, records(edgeCount, (id) => ({
    source: id % nodeCount,
    target: (id + 1) % nodeCount,
    weight: 0.5,
  })));
  await fsp.writeFile(deltaPath, '');
  await fsp.writeFile(path.join(dir, 'memory-manifest.json'), `${JSON.stringify({
    formatVersion: 1,
    generation: 'large-source-g1',
    baseRevision: 2,
    currentRevision: 2,
    activeDeltaEpoch: 'e0',
    activeBase: {
      nodes: { file: path.basename(nodesPath), count: nodeCount, bytes: nodes.bytes },
      edges: { file: path.basename(edgesPath), count: edgeCount, bytes: edges.bytes },
    },
    activeDelta: {
      epoch: 'e0',
      file: path.basename(deltaPath),
      fromRevision: 3,
      toRevision: 2,
      count: 0,
      committedBytes: 0,
    },
    ann: { indexFile: null, metaFile: null, builtFromRevision: 2 },
    summary: { nodeCount, edgeCount, clusterCount: 1 },
  }, null, 2)}\n`);

  const source = await openMemorySource(dir);
  try {
    for (const [iterator, filePath] of [
      [source.iterateNodes(), nodesPath],
      [source.iterateEdges(), edgesPath],
    ]) {
      assert.equal((await iterator.next()).done, false);
      await iterator.return();
      const afterReturn = await countOpenDescriptorsFor(filePath);
      if (afterReturn !== null) assert.equal(afterReturn, 0);
    }
  } finally {
    await source.close();
  }
});

test('early iterator return leaves a borrowed source handle open for its owner', async () => {
  const dir = await tempDir();
  const filePath = path.join(dir, 'borrowed.jsonl');
  await writeJsonl(filePath, [{ id: 1 }, { id: 2 }]);
  const opened = await openConfinedRegularFile(dir, filePath);
  try {
    const iterator = readJsonl(filePath, {
      confinedRoot: dir,
      [OPENED_JSONL_FILE]: opened,
    });
    assert.deepEqual((await iterator.next()).value, { id: 1 });
    await iterator.return();
    assert.equal((await opened.handle.stat()).isFile(), true);
  } finally {
    await opened.handle.close().catch((error) => {
      if (error?.code !== 'EBADF') throw error;
    });
  }
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
  assert.equal(result.evidence.sourceHealth, 'degraded');
  assert.equal(result.evidence.retrievalMode, 'logical-source-scan');
  assert.equal(result.evidence.fallback.reason, 'keyword_source_scan');
  assert.equal(result.evidence.matchOutcome, 'matches');
  await assert.rejects(() => source.searchKeyword({ query: '   ... ' }), { code: 'invalid_request' });
  await source.close();
});

test('keyword search applies the advertised exact tag filter and reports filtered matches', async () => {
  const { dir } = await createManifestFixture({
    nodes: [
      { id: 1, concept: 'shared canary', tag: 'alpha' },
      { id: 2, concept: 'shared canary', tag: 'beta' },
    ],
    edges: [],
    delta: [],
    currentRevision: 2,
    summary: { nodeCount: 2, edgeCount: 0, clusterCount: 1 },
  });
  const source = await openMemorySource(dir);
  const result = await source.searchKeyword({ query: 'shared canary', topK: 10, tag: 'alpha' });
  assert.deepEqual(result.results.map(({ id, concept, tag }) => ({ id, concept, tag })), [
    { id: '1', concept: 'shared canary', tag: 'alpha' },
  ]);
  assert.equal(result.results[0].retrievalAuthority.domain, 'current_ops');
  assert.equal(Number.isFinite(result.results[0].retrievalScore), true);
  assert.equal(result.filtered, 1);
  assert.equal(result.evidence.filteredTotal, 1);
  assert.deepEqual(result.evidence.filters, { tag: 'alpha' });
  assert.deepEqual(result.evidence.limits, { topK: 10 });
  await assert.rejects(
    () => source.searchKeyword({ query: 'shared', tag: ' alpha ' }),
    { code: 'invalid_request', status: 400, field: 'tag' },
  );
  await source.close();
});

test('keyword search ranks current verified evidence above earlier archive order and projects authority', async (t) => {
  const archive = {
    id: 'archive',
    concept: 'brain route canary is unavailable',
    tag: 'jerry_cron_docs',
    source_event_at: '2025-01-01T00:00:00.000Z',
    provenance: { authorityClass: 'narrative', operationalAuthority: false },
  };
  const current = {
    id: 'current',
    concept: 'brain route canary is available',
    tag: 'state_snapshot',
    asserted_at: '2026-07-14T19:59:00.000Z',
    provenance: {
      schema: 'home23.node-provenance.v1',
      authorityClass: 'verified_current_state',
      operationalAuthority: true,
      evidenceRefs: ['verifier:live-route'],
    },
  };
  attestMemoryAuthority(current, AUTHORITY_KEY);
  const fixture = await createManifestFixture({
    nodes: [archive, current],
    delta: [],
    baseRevision: 2,
    currentRevision: 2,
    summary: { nodeCount: 2, edgeCount: 0, clusterCount: 1 },
  });
  t.after(() => fsp.rm(fixture.dir, { recursive: true, force: true }));
  const source = await openMemorySource(fixture.dir);
  t.after(() => source.close());

  const result = await source.searchKeyword({ query: 'brain route canary', topK: 1 });

  assert.equal(result.results[0].id, 'current');
  assert.equal(Number.isFinite(result.results[0].retrievalAuthority.scoreExplanation.score), true);
  const { scoreExplanation, ...authority } = result.results[0].retrievalAuthority;
  assert.ok(scoreExplanation.factors.length <= 8);
  assert.deepEqual(authority, {
    schema: 'home23.memory-authority-profile.v1',
    domain: 'current_ops',
    retrievalDomain: 'current_ops',
    authorityClass: 'verified_current_state',
    operationalAuthority: true,
    requiresFreshVerification: false,
    semanticTime: '2026-07-14T19:59:00.000Z',
    sourceChain: [{ kind: 'evidence', ref: 'verifier:live-route' }],
  });
  assert.equal(result.evidence.completeCoverage, true);
});

test('keyword source scan applies shared closure and correction authority with explicit fallback mode', async (t) => {
  const nodes = [
    {
      id: 'alarm-old', concept: 'Current brain route status is down.', status: 'open',
      asserted_at: '2026-07-13T12:00:00.000Z', metadata: { incidentId: 'brain-route' },
    },
    {
      id: 'closure-new', concept: 'Current brain route status incident is closed.',
      tag: 'goal_resolution', type: 'goal_resolution', status: 'completed',
      asserted_at: '2026-07-14T15:00:00.000Z',
      metadata: {
        incidentId: 'brain-route', resolved_at: '2026-07-14T15:00:00.000Z',
        closure_proof_refs: ['verifier:brain-route-live'],
        provenance: {
          schema: 'home23.node-provenance.v1', authorityClass: 'worker_receipt',
          retrievalDomain: 'closed_incidents', sourceRefs: ['incident:brain-route'],
          evidenceRefs: ['verifier:brain-route-live'],
          generationMethod: 'goal_curator_resolution',
        },
      },
    },
    {
      id: 'claim-old', concept: 'Current brain route status uses legacy sidecars.',
      asserted_at: '2026-07-13T13:00:00.000Z',
    },
    {
      id: 'correction-new', concept: 'Current brain route status uses manifest-v1.',
      asserted_at: '2026-07-14T15:30:00.000Z',
      metadata: {
        actor: 'jtr', correction: true, supersedes: ['claim-old'],
        provenance: {
          schema: 'home23.node-provenance.v1', authorityClass: 'jtr_correction',
          retrievalDomain: 'current_ops', sourceRefs: ['turn:correction:user'],
          evidenceRefs: ['turn:correction:user'],
        },
      },
    },
  ];
  attestMemoryAuthority(nodes[1], AUTHORITY_KEY);
  attestMemoryAuthority(nodes[3], AUTHORITY_KEY);
  const fixture = await createManifestFixture({
    nodes, delta: [], baseRevision: 2, currentRevision: 2,
    summary: { nodeCount: nodes.length, edgeCount: 0, clusterCount: 1 },
  });
  t.after(() => fsp.rm(fixture.dir, { recursive: true, force: true }));
  const source = await openMemorySource(fixture.dir);
  t.after(() => source.close());

  const current = await source.searchKeyword({
    query: 'current brain route status', topK: 10, intent: 'current_state',
  });
  assert.deepEqual(current.results.map((row) => row.id), ['correction-new', 'closure-new']);
  assert.ok(current.results.every((row) => row.retrievalMode === 'logical-source-scan'));
  assert.equal(current.evidence.sourceHealth, 'degraded');
  assert.deepEqual(current.evidence.fallback, {
    route: 'logical-source-scan', reason: 'keyword_source_scan', completeness: 'complete',
  });
  assert.deepEqual(current.evidence.indexCoverage, {
    complete: false,
    indexedRevision: null,
    currentRevision: 2,
    coveredThroughRevision: null,
    route: 'logical-source-scan',
    completeness: 'complete',
  });
  assert.equal(Number.isFinite(current.evidence.stageTimingsMs.keywordScoring), true);
  assert.equal(Number.isFinite(current.evidence.stageTimingsMs.response), true);

  const history = await source.searchKeyword({
    query: 'brain route status history', topK: 10, intent: 'history',
  });
  assert.equal(history.results.find((row) => row.id === 'alarm-old').closureEvidence.closureNodeId, 'closure-new');
  assert.equal(history.results.find((row) => row.id === 'claim-old').supersessionEvidence.correctionNodeId, 'correction-new');
});

test('keyword source scan resolves suppression before topK so lower eligible matches backfill', async (t) => {
  const nodes = [
    {
      id: 'alarm-old', concept: 'service status exact', status: 'open',
      asserted_at: '2026-07-13T12:00:00.000Z', metadata: { incidentId: 'service-route' },
    },
    {
      id: 'eligible', concept: 'service alternative evidence',
      asserted_at: '2026-07-14T14:00:00.000Z',
    },
    {
      id: 'closure-new', concept: 'resolved unrelated wording',
      tag: 'goal_resolution', status: 'completed',
      asserted_at: '2026-07-14T15:00:00.000Z',
      metadata: {
        incidentId: 'service-route', resolved_at: '2026-07-14T15:00:00.000Z',
        closure_proof_refs: ['verifier:service-route-live'],
        provenance: {
          schema: 'home23.node-provenance.v1', authorityClass: 'worker_receipt',
          retrievalDomain: 'closed_incidents', sourceRefs: ['incident:service-route'],
          evidenceRefs: ['verifier:service-route-live'],
          generationMethod: 'goal_curator_resolution',
        },
      },
    },
  ];
  attestMemoryAuthority(nodes[2], AUTHORITY_KEY);
  const fixture = await createManifestFixture({
    nodes, delta: [], baseRevision: 2, currentRevision: 2,
    summary: { nodeCount: nodes.length, edgeCount: 0, clusterCount: 1 },
  });
  t.after(() => fsp.rm(fixture.dir, { recursive: true, force: true }));
  const source = await openMemorySource(fixture.dir);
  t.after(() => source.close());

  const result = await source.searchKeyword({
    query: 'service status exact', topK: 1, intent: 'current_state',
  });

  assert.deepEqual(result.results.map((row) => row.id), ['eligible']);
  assert.equal(result.evidence.matchOutcome, 'matches');
});
