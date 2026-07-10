import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  canonicalIdentity,
  createSourceOperationExecutors,
} = require('../../../engine/src/dashboard/brain-operations/source-executors');
const { createGraphExportExecutor } = require('../../../engine/src/dashboard/brain-operations/graph-export-executor');

async function tempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function evidence(input = {}) {
  return {
    route: 'shared-memory-source',
    implementation: 'manifest-v1',
    identity: {
      requesterAgent: null,
      targetAgent: null,
      brainId: null,
      canonicalRoot: input.canonicalRoot || null,
      catalogRevision: null,
      kind: null,
      sourceType: null,
      accessMode: null,
      operationId: input.operationId || null,
    },
    sourceHealth: input.sourceHealth || 'healthy',
    matchOutcome: input.matchOutcome || 'matches',
    authoritativeTotals: input.authoritativeTotals || { nodes: 2, edges: 1 },
    returnedTotals: input.returnedTotals || { nodes: 0, edges: 0 },
  };
}

function sourcePin(canonicalRoot = '/tmp/brain') {
  return {
    descriptor: { version: 1, canonicalRoot, cutoffRevision: 3 },
    revision: 3,
    manifest: { sourceMode: 'manifest' },
    getEvidence(input = {}) { return evidence({ ...input, canonicalRoot }); },
    async summarize() { return { nodes: 2, edges: 1, clusters: 1 }; },
    async searchKeyword() { return { results: [] }; },
    async *iterateNodes() {
      yield { id: 'a', concept: 'alpha' };
      yield { id: 'b', concept: 'beta' };
    },
    async *iterateEdges() {
      yield { source: 'a', target: 'b', weight: 1 };
    },
  };
}

async function baseContext() {
  const canonicalRoot = await tempDir('home23-source-executor-brain-');
  const scratchDir = await tempDir('home23-source-executor-scratch-');
  return {
    operationId: 'op-1',
    operationType: 'graph',
    requesterAgent: 'ada',
    target: {
      domain: 'brain',
      brainId: 'ada',
      canonicalRoot,
      accessMode: 'own',
      ownerAgent: 'ada',
      kind: 'resident',
      catalogRevision: 'catalog-1',
    },
    parameters: {},
    scratchDir,
    scratchQuota: { claimed: 0, async claim(bytes) { this.claimed += bytes; } },
    sourcePin: sourcePin(canonicalRoot),
  };
}

test('canonical identity is derived only from operation context and source pin', async () => {
  const context = await baseContext();
  assert.deepEqual(canonicalIdentity(context), {
    requesterAgent: 'ada',
    targetAgent: 'ada',
    brainId: 'ada',
    canonicalRoot: context.target.canonicalRoot,
    catalogRevision: 'catalog-1',
    kind: 'resident',
    sourceType: 'memory-manifest',
    accessMode: 'own',
    operationId: 'op-1',
  });
  assert.throws(
    () => canonicalIdentity({ ...context, sourcePin: sourcePin('/tmp/other') }),
    { code: 'source_changed' },
  );
});

test('registerable source executors return standard envelopes', async () => {
  const context = await baseContext();
  const executors = createSourceOperationExecutors({
    searchService: {
      async search(request) {
        assert.equal(request.identity.requesterAgent, 'ada');
        assert.equal(request.sourcePin, context.sourcePin);
        return { results: [{ id: 'a' }], evidence: evidence({ canonicalRoot: context.target.canonicalRoot }) };
      },
    },
    brainSourceService: {
      async status(request) {
        assert.equal(request.identity.operationId, 'op-1');
        return { ok: true, bounded: true, evidence: evidence({ canonicalRoot: context.target.canonicalRoot }) };
      },
      async graph(request) {
        assert.equal(request.identity.operationId, 'op-1');
        return { bounded: true, evidence: evidence({ canonicalRoot: context.target.canonicalRoot }) };
      },
    },
    graphExportExecutor: async () => ({
      evidence: evidence({ canonicalRoot: context.target.canonicalRoot }),
      resultArtifact: {
        scratchPath: path.join(context.scratchDir, 'x.jsonl'),
        mediaType: 'application/x-ndjson',
        contentEncoding: 'identity',
        bytes: 0,
        sha256: '0'.repeat(64),
      },
    }),
  });

  assert.deepEqual([...executors.keys()].sort(), ['graph', 'graph_export', 'search', 'status'].sort());
  assert.equal((await executors.get('search')({ ...context, operationType: 'search', parameters: { query: 'alpha' } })).state, 'complete');
  assert.equal((await executors.get('status')({ ...context, operationType: 'status' })).state, 'complete');
  assert.equal((await executors.get('graph')({ ...context, operationType: 'graph' })).state, 'complete');
  const exported = await executors.get('graph_export')({ ...context, operationType: 'graph_export' });
  assert.equal(exported.state, 'complete');
  assert.equal(exported.result, null);
  assert.deepEqual(Object.keys(exported.resultArtifact).sort(), [
    'bytes', 'contentEncoding', 'mediaType', 'scratchPath', 'sha256',
  ].sort());
});

test('graph export streams NDJSON artifact and rejects caller-controlled destinations', async () => {
  const context = await baseContext();
  const executor = createGraphExportExecutor();
  const exported = await executor({ ...context, parameters: { format: 'jsonl' }, identity: canonicalIdentity(context) });
  assert.equal(exported.result, null);
  assert.equal(exported.resultArtifact.mediaType, 'application/x-ndjson');
  assert.equal(exported.resultArtifact.contentEncoding, 'identity');
  assert.equal(exported.resultArtifact.scratchPath.startsWith(await fsp.realpath(context.scratchDir)), true);
  assert.match(exported.resultArtifact.sha256, /^[a-f0-9]{64}$/);
  const text = await fsp.readFile(exported.resultArtifact.scratchPath, 'utf8');
  assert.match(text, /"type":"node"/);
  assert.match(text, /"type":"edge"/);
  assert.equal(exported.evidence.graphExport.nodeCount, 2);
  assert.equal(exported.evidence.graphExport.edgeCount, 1);

  await assert.rejects(
    () => executor({ ...context, parameters: { outputPath: '/tmp/x' }, identity: canonicalIdentity(context) }),
    { code: 'invalid_request' },
  );
});
