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
  summarizeRetrievalAuthority,
  isTypedMemorySourceError,
  normalizeKeywordTokens,
  enrichEvidenceIdentity,
  readJsonl,
  MAX_MEMORY_SOURCE_BYTES,
  assertMemorySourceInputSelection,
  resolveMemorySourceReadLimits,
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

test('source read limits have one finite eight-gibibyte hard maximum and quota-derived defaults', () => {
  const hardMax = 8 * 1024 * 1024 * 1024;
  assert.equal(MAX_MEMORY_SOURCE_BYTES, hardMax);
  assert.equal(typeof resolveMemorySourceReadLimits, 'function');
  assert.deepEqual(resolveMemorySourceReadLimits(), {
    maxInputBytes: hardMax,
    maxDecompressedBytes: hardMax,
  });
  assert.deepEqual(resolveMemorySourceReadLimits({ quotaMaxBytes: 4096 }), {
    maxInputBytes: 4096,
    maxDecompressedBytes: 4096,
  });
  assert.deepEqual(resolveMemorySourceReadLimits({
    quotaMaxBytes: hardMax * 2,
  }), {
    maxInputBytes: hardMax,
    maxDecompressedBytes: hardMax,
  });
  assert.deepEqual(resolveMemorySourceReadLimits({
    quotaMaxBytes: 4096,
    maxInputBytes: 8192,
    maxDecompressedBytes: 16_384,
  }), {
    maxInputBytes: 8192,
    maxDecompressedBytes: 16_384,
  });
  for (const input of [
    { maxInputBytes: hardMax + 1 },
    { maxDecompressedBytes: hardMax + 1 },
    { quotaMaxBytes: 0 },
    { quotaMaxBytes: 1.5 },
    { quotaMaxBytes: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(() => resolveMemorySourceReadLimits(input), { code: 'invalid_request' });
  }
  assert.equal(assertMemorySourceInputSelection(4096, 4096), 4096);
  assert.throws(
    () => assertMemorySourceInputSelection(4097, 4096),
    (error) => error?.code === 'result_too_large'
      && error?.limitKind === 'input' && error?.limit === 4096,
  );
});

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
    completeCoverage: true,
    filteredTotal: 3,
    authoritativeTotals: { nodes: 20, edges: 30 },
    returnedTotals: { nodes: 2, edges: 0 },
  });
  assert.equal(evidence.baseWatermark.revision, 10);
  assert.equal(evidence.deltaWatermark.revision, 12);
  assert.equal(evidence.indexWatermark.fresh, true);
  assert.deepEqual(evidence.filters, { tag: 'conversation' });
  assert.equal(evidence.completeCoverage, true);
  assert.equal(evidence.filteredTotal, 3);
  assert.equal(evidence.identity.requesterAgent, 'ada');
  assert.equal(evidence.identity.targetAgent, 'jerry');
  assert.equal(evidence.identity.catalogRevision, 'catalog-17');
});

test('normalizes the approved retrieval evidence envelope without dropping legacy aliases', () => {
  const evidence = createEvidence({
    deltaRevision: 45,
    retrievalMode: 'semantic-ann-delta-overlay',
    indexCoverage: {
      complete: true,
      indexedRevision: 40,
      currentRevision: 45,
      coveredThroughRevision: 45,
      deltaRecords: 7,
      changedNodes: 4,
      upsertedNodes: 3,
      removedNodes: 1,
      edgeOnlyRecords: 2,
      route: 'ann-plus-delta',
      completeness: 'complete',
    },
    stageTimings: {
      sourceOpenMs: 1,
      embeddingMs: 2,
      overlayRefreshMs: 3,
      annLoadMs: 4,
      annSearchMs: 5,
      overlayScoringMs: 6,
      keywordScoringMs: 7,
      mergeMs: 8,
      responseMs: 9,
    },
    authoritySummary: {
      verifiedCurrentState: 1,
      narrative: 2,
      requiresFreshVerification: 2,
      retrievalDomains: { current_ops: 1, external_intake: 2 },
      sourceChain: {
        withEvidence: 1,
        withoutEvidence: 2,
        referenceCounts: { evidence: 1, generation: 2 },
      },
    },
  });

  assert.equal(evidence.retrievalMode, 'semantic-ann-delta-overlay');
  assert.deepEqual(evidence.indexCoverage, {
    complete: true,
    indexedRevision: 40,
    currentRevision: 45,
    coveredThroughRevision: 45,
    deltaRecords: 7,
    distinctChangedNodes: 4,
    distinctUpsertedNodes: 3,
    distinctRemovedNodes: 1,
    edgeOnlyRecords: 2,
    route: 'ann-plus-delta',
    completeness: 'complete',
  });
  assert.deepEqual(evidence.stageTimingsMs, {
    sourceOpen: 1,
    embedding: 2,
    overlayRefresh: 3,
    annLoad: 4,
    annSearch: 5,
    overlayScoring: 6,
    keywordScoring: 7,
    merge: 8,
    response: 9,
  });
  assert.deepEqual(evidence.authoritySummary.retrievalDomains, {
    current_ops: 1,
    closed_incidents: 0,
    project_history: 0,
    external_intake: 2,
  });
  assert.deepEqual(evidence.authoritySummary.sourceChain.referenceCounts, {
    source: 0,
    evidence: 1,
    artifact: 0,
    trace: 0,
    generation: 2,
    lineage: 0,
    verification: 0,
    closure: 0,
  });
});

test('summarizes bounded per-node authority, domain, and source-chain evidence', () => {
  const summary = summarizeRetrievalAuthority([
    {
      authorityClass: 'verified_current_state',
      retrievalDomain: 'current_ops',
      requiresFreshVerification: false,
      sourceChain: [{ kind: 'evidence', ref: 'verifier:live' }, { kind: 'trace', ref: 't1' }],
    },
    {
      authorityClass: 'narrative',
      domain: 'external_intake',
      requiresFreshVerification: true,
      sourceChain: [{ kind: 'generation', ref: 'query-result' }],
    },
  ]);

  assert.equal(summary.total, 2);
  assert.equal(summary.authorityClasses.verified_current_state, 1);
  assert.equal(summary.authorityClasses.narrative, 1);
  assert.equal(summary.retrievalDomains.current_ops, 1);
  assert.equal(summary.retrievalDomains.external_intake, 1);
  assert.equal(summary.sourceChain.withEvidence, 2);
  assert.equal(summary.sourceChain.referenceCounts.evidence, 1);
  assert.equal(summary.sourceChain.referenceCounts.trace, 1);
  assert.equal(summary.sourceChain.referenceCounts.generation, 1);
  assert.equal(summary.requiresFreshVerification, 1);
  assert.equal(summary.verifiedCurrentState, 1);
  assert.equal(summary.narrative, 1);
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
