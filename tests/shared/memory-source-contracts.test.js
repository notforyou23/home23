import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createGzip } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const require = createRequire(import.meta.url);
const {
  SOURCE_HEALTH,
  MATCH_OUTCOME,
  normalizeRevision,
  normalizeId,
  edgeKeyFor,
  canonicalJson,
  sourceDescriptorDigest,
  classifyMatchOutcome,
  createDiagnosticRing,
  createEvidence,
  isTypedMemorySourceError,
  normalizeKeywordTokens,
  enrichEvidenceIdentity,
  readJsonl,
  writeJsonlGzAtomic,
} = require('../../shared/memory-source');

async function collect(iterator) {
  const rows = [];
  for await (const row of iterator) rows.push(row);
  return rows;
}

async function gzipBytes(bytes) {
  const gzip = createGzip();
  const chunks = [];
  gzip.on('data', (chunk) => chunks.push(chunk));
  gzip.end(bytes);
  await once(gzip, 'end');
  return Buffer.concat(chunks);
}

async function writeHighlyCompressibleJsonlRecord({ conceptBytes }) {
  const dir = await mkdtemp(join(tmpdir(), 'memory-source-large-jsonl-'));
  const out = join(dir, 'large.jsonl.gz');
  const payload = `${JSON.stringify({ concept: 'x'.repeat(conceptBytes) })}\n`;
  await writeFile(out, await gzipBytes(Buffer.from(payload, 'utf8')));
  return out;
}

test('normalizes revisions and graph identifiers without conflating invalid values', () => {
  assert.equal(normalizeRevision('17'), 17);
  assert.equal(normalizeRevision(-1), null);
  assert.equal(normalizeId(4), '4');
  assert.equal(normalizeId('4'), '4');
  assert.equal(edgeKeyFor({ source: 9, target: '2' }), '2->9');
});

test('hashes a source descriptor from recursively key-sorted canonical JSON', () => {
  const descriptor = {
    version: 1,
    canonicalRoot: '/real/instances/jerry/brain',
    generation: 'g1',
    baseRevision: 2,
    cutoffRevision: 5,
    activeBase: { edges: { file: 'edges.gz' }, nodes: { file: 'nodes.gz' } },
    activeDelta: { committedBytes: 7, file: 'delta.jsonl', epoch: 'e1', toRevision: 5 },
  };
  assert.equal(canonicalJson(descriptor), canonicalJson({
    cutoffRevision: 5,
    generation: 'g1',
    version: 1,
    activeDelta: { toRevision: 5, epoch: 'e1', file: 'delta.jsonl', committedBytes: 7 },
    canonicalRoot: '/real/instances/jerry/brain',
    activeBase: { nodes: { file: 'nodes.gz' }, edges: { file: 'edges.gz' } },
    baseRevision: 2,
  }));
  assert.match(sourceDescriptorDigest(descriptor), /^sha256:[a-f0-9]{64}$/);
});

test('classifies empty only from healthy complete authoritative coverage', () => {
  assert.equal(classifyMatchOutcome({
    sourceHealth: SOURCE_HEALTH.HEALTHY,
    authoritativeTotal: 0,
    returnedTotal: 0,
    completeCoverage: true,
  }), MATCH_OUTCOME.CORPUS_EMPTY);
  assert.equal(classifyMatchOutcome({
    sourceHealth: SOURCE_HEALTH.DEGRADED,
    authoritativeTotal: 0,
    returnedTotal: 0,
    completeCoverage: false,
  }), MATCH_OUTCOME.UNKNOWN);
  assert.equal(classifyMatchOutcome({
    sourceHealth: SOURCE_HEALTH.HEALTHY,
    authoritativeTotal: 8,
    returnedTotal: 0,
    filteredTotal: 2,
    completeCoverage: true,
  }), MATCH_OUTCOME.FILTERED);
});

test('creates a complete additive evidence envelope with canonical identity', () => {
  const evidence = createEvidence({
    selectedAgent: 'jerry',
    selectedBrain: 'brain-jerry',
    identity: {
      requesterAgent: 'ada', targetAgent: 'jerry', brainId: 'brain-jerry',
      canonicalRoot: '/real/instances/jerry/brain', catalogRevision: 'catalog-17',
      kind: 'agent', sourceType: 'memory-manifest', accessMode: 'sibling',
      operationId: 'op-17',
    },
    route: 'shared-memory-source',
    implementation: 'manifest-v1',
    sourceHealth: 'healthy',
    matchOutcome: 'matches',
    baseRevision: 10,
    deltaRevision: 12,
    deltaApplied: 2,
    annBuiltFromRevision: 12,
    annFresh: true,
    filters: { tag: 'conversation' },
    limits: { topK: 5 },
    authoritativeTotals: { nodes: 20, edges: 30 },
    returnedTotals: { nodes: 2, edges: 0 },
  });
  assert.equal(evidence.baseWatermark.revision, 10);
  assert.equal(evidence.deltaWatermark.revision, 12);
  assert.equal(evidence.indexWatermark.fresh, true);
  assert.deepEqual(evidence.filters, { tag: 'conversation' });
  assert.equal(evidence.identity.requesterAgent, 'ada');
  assert.equal(evidence.identity.targetAgent, 'jerry');
  assert.equal(evidence.identity.catalogRevision, 'catalog-17');
});

test('identity enrichment preserves evidence and rejects canonical mismatch', () => {
  const evidence = createEvidence({ baseRevision: 10, deltaRevision: 12, sourceHealth: 'healthy' });
  const identity = {
    requesterAgent: 'ada', targetAgent: null, brainId: 'research-r1',
    canonicalRoot: '/real/runs/r1', catalogRevision: 'catalog-19', kind: 'research',
    sourceType: 'legacy-research-projection', accessMode: 'completed-research',
    operationId: 'op-r1',
  };
  const enriched = enrichEvidenceIdentity(evidence, identity);
  assert.equal(enriched.baseWatermark.revision, 10);
  assert.equal(enriched.identity.kind, 'research');
  assert.throws(() => enrichEvidenceIdentity(enriched, {
    ...identity, canonicalRoot: '/real/runs/r2',
  }), (error) => error.code === 'source_changed');
});

test('diagnostics and keyword helpers stay bounded and typed', () => {
  const ring = createDiagnosticRing({ maxEntries: 2, maxBytes: 64, maxEntryBytes: 16 });
  ring.push('revision_gap: ' + 'x'.repeat(100));
  ring.push('ok');
  ring.push('dropped');
  assert.equal(ring.sawDegradation, true);
  assert.equal(ring.dropped, 1);
  assert.deepEqual(normalizeKeywordTokens('Alpha alpha tag:home'), ['alpha', 'tag:home']);
  assert.equal(isTypedMemorySourceError(Object.assign(new Error('x'), { code: 'source_busy' })), true);
});

test('round-trips gzip JSONL without full-array serialization', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'memory-source-jsonl-'));
  const out = join(dir, 'nodes.jsonl.gz');
  await writeJsonlGzAtomic(out, [{ id: 1 }, { id: 2 }]);
  const rows = [];
  for await (const row of readJsonl(out, { gzip: true })) rows.push(row);
  assert.deepEqual(rows, [{ id: 1 }, { id: 2 }]);
  await assert.rejects(readFile(out + '.tmp'));
});

test('aborting a JSONL iterator destroys the stream and preserves AbortError', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'memory-source-abort-'));
  const out = join(dir, 'nodes.jsonl.gz');
  await writeJsonlGzAtomic(out, Array.from({ length: 1000 }, (_, id) => ({ id })));
  const controller = new AbortController();
  const iterator = readJsonl(out, { gzip: true, signal: controller.signal });
  assert.equal((await iterator.next()).done, false);
  controller.abort(Object.assign(new Error('cancelled'), { name: 'AbortError', code: 'cancelled' }));
  await assert.rejects(iterator.next(), (error) => error.name === 'AbortError');
});

test('caps decompressed bytes and a single JSONL record before parsing', async () => {
  const fixture = await writeHighlyCompressibleJsonlRecord({ conceptBytes: 8 * 1024 * 1024 });
  await assert.rejects(
    collect(readJsonl(fixture, { gzip: true, maxRecordBytes: 64 * 1024 })),
    (error) => error.code === 'result_too_large' && error.limitKind === 'record',
  );
  await assert.rejects(
    collect(readJsonl(fixture, { gzip: true, maxDecompressedBytes: 32 * 1024 })),
    (error) => error.code === 'result_too_large' && error.limitKind === 'decompressed',
  );
});
