import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const {
  createBrainSourceService,
  rejectCallerIdentity,
  sendBrainSourceError,
} = require('../../../engine/src/dashboard/brain-source-api');
const {
  openMemorySource, rewriteMemoryBase, appendMemoryRevision, readManifest,
} = require('../../../shared/memory-source');
const { createDefaultLoadAnn } = require('../../../engine/src/dashboard/memory-search');
const { ANN_AUTHORITY_PROJECTION_SCHEMA, projectAnnLabel } = require('../../../shared/ann-label-contract.cjs');

const statusAuthorityKey = '8'.repeat(64);

async function statusIndexFixture(t, { metadata = {}, indexBytes = 'synthetic index', withDelta = true, skippedNode = false } = {}) {
  const home23Root = await tempDir('home23-brain-status-index-');
  const brainDir = path.join(home23Root, 'brain');
  await fsp.mkdir(brainDir);
  const lockRoot = path.join(home23Root, 'locks');
  const node = { id: 'n1', concept: 'original ticket conversation', embedding: [1, 0] };
  const nodes = skippedNode ? [node, { id: 'no-vector', concept: 'unembedded original tickets' }] : [node];
  await rewriteMemoryBase(brainDir, {
    nodes, edges: [], summary: { nodeCount: nodes.length, edgeCount: 0, clusterCount: 0 },
  }, { lockRoot });
  const base = await readManifest(brainDir);
  await fsp.writeFile(path.join(brainDir, 'status.index'), indexBytes);
  await fsp.writeFile(path.join(brainDir, 'status.meta.json'), JSON.stringify({
    authorityProjectionSchema: ANN_AUTHORITY_PROJECTION_SCHEMA,
    authorityAttestationKeyId: createHash('sha256').update(statusAuthorityKey).digest('hex').slice(0, 16),
    dimension: 2,
    generation: base.generation,
    builtFromRevision: base.currentRevision,
    count: 1,
    ...metadata,
    labels: [projectAnnLabel(node)],
  }));
  await fsp.writeFile(path.join(brainDir, 'memory-manifest.json'), JSON.stringify({
    ...base, ann: { indexFile: 'status.index', metaFile: 'status.meta.json', builtFromRevision: base.currentRevision },
  }));
  if (withDelta) await appendMemoryRevision(brainDir, {
    nodes: [{ id: 'n2', concept: 'later ticket update', embedding: [0, 1] }],
    edges: [], removedNodeIds: [], removedEdgeKeys: [],
  }, { lockRoot, summary: { nodeCount: nodes.length + 1, edgeCount: 0, clusterCount: 0 } });
  const source = await openMemorySource(brainDir);
  let runtimeLoads = 0;
  const loadAnn = createDefaultLoadAnn({
    authorityKey: statusAuthorityKey,
    indexRuntimeFactory: async ({ indexPath }) => {
      runtimeLoads += 1;
      if (await fsp.readFile(indexPath, 'utf8') !== 'synthetic index') throw new Error('corrupt native index');
      return { isHealthy: () => true, async terminate() {} };
    },
  });
  const service = createBrainSourceService({ loadAnn });
  t.after(async () => {
    await service.close();
    await source.close();
    await fsp.rm(home23Root, { recursive: true, force: true });
  });
  return {
    source, service, loadAnn, brainDir, runtimeLoads: () => runtimeLoads,
    request: { sourcePin: source, identity: {
      requesterAgent: 'jerry', brainId: 'brain-jerry', canonicalRoot: await fsp.realpath(brainDir),
      catalogRevision: 'catalog-1', kind: 'resident', sourceType: 'brain',
      accessMode: 'read-only', operationId: 'status-test',
    } },
  };
}

async function tempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function fakeSource({ nodes = [], edges = [], sourceHealth = 'healthy', operationId = null } = {}) {
  return {
    revision: 3,
    async summarize() {
      return { nodes: nodes.length, edges: edges.length, clusters: 1 };
    },
    async *iterateNodes() {
      for (const node of nodes) yield node;
    },
    async *iterateEdges() {
      for (const edge of edges) yield edge;
    },
    getEvidence(input = {}) {
      return {
        route: 'shared-memory-source',
        implementation: 'manifest-v1',
        identity: {
          requesterAgent: null,
          targetAgent: null,
          brainId: null,
          canonicalRoot: input.identity?.canonicalRoot || null,
          catalogRevision: null,
          kind: null,
          sourceType: null,
          accessMode: null,
          operationId,
        },
        sourceHealth,
        matchOutcome: input.matchOutcome || (sourceHealth === 'healthy' ? 'matches' : 'unknown'),
        authoritativeTotals: input.authoritativeTotals,
        returnedTotals: input.returnedTotals,
        filters: input.filters,
        limits: input.limits,
      };
    },
  };
}

test('resident status and graph derive canonical identity and private operation id', async () => {
  const brainDir = await tempDir('home23-brain-source-api-brain-');
  const canonicalRoot = await fsp.realpath(brainDir);
  const home23Root = await tempDir('home23-brain-source-api-home-');
  let resolveCalls = 0;
  const target = {
    id: 'brain-jerry',
    ownerAgent: 'jerry',
    canonicalRoot,
    kind: 'resident',
    sourceType: 'brain',
  };
  const service = createBrainSourceService({
    brainDir,
    home23Root,
    requesterAgent: 'jerry',
    resolveTargetContext: async () => {
      resolveCalls += 1;
      return { catalogRevision: 'catalog-1', accessMode: 'own', target };
    },
    withEphemeralSource: async (options, callback) => {
      assert.equal(options.prefix, 'dashboard-source');
      assert.equal(options.identity.brainId, target.id);
      return callback(fakeSource({
        operationId: 'dashboard-source-test',
        nodes: [
          { id: 'n1', concept: 'one', weight: 1 },
          { id: 'n2', concept: 'two', weight: 2 },
        ],
        edges: [{ source: 'n1', target: 'n2', weight: 1 }],
      }), {
        identity: { ...options.identity, canonicalRoot, operationId: 'dashboard-source-test' },
      });
    },
  });
  const status = await service.status();
  assert.equal(status.ok, true);
  assert.equal(status.evidence.identity.requesterAgent, 'jerry');
  assert.equal(status.evidence.identity.brainId, 'brain-jerry');
  assert.match(status.evidence.identity.operationId, /^dashboard-source-/);
  const graph = await service.graph({ nodeLimit: 2, edgeLimit: 1 });
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.evidence.identity.canonicalRoot, canonicalRoot);
  assert.equal(resolveCalls, 2);
});

test('caller-supplied source identity fields are rejected at compatibility boundary', () => {
  for (const key of ['identity', 'requesterAgent', 'target', 'canonicalRoot', 'catalogRevision', 'operationId']) {
    assert.throws(
      () => rejectCallerIdentity({ [key]: 'forged' }),
      (error) => error.code === 'invalid_request' && error.status === 400 && error.field === key,
    );
  }
});

test('dashboard maps retryable compatibility admission contention to HTTP 503', () => {
  const response = {
    statusCode: null,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
  sendBrainSourceError(response, Object.assign(new Error('compatibility source busy'), {
    code: 'source_busy',
    retryable: true,
  }));
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.payload, {
    ok: false,
    success: false,
    error: {
      code: 'source_busy',
      message: 'compatibility source busy',
      retryable: true,
    },
  });
});

test('catalog/source mismatch fails before source iteration', async () => {
  const brainDir = await tempDir('home23-brain-source-api-brain-');
  let opened = false;
  const service = createBrainSourceService({
    brainDir,
    home23Root: await tempDir('home23-brain-source-api-home-'),
    requesterAgent: 'jerry',
    resolveTargetContext: async () => ({
      catalogRevision: 'catalog-1',
      accessMode: 'own',
      target: {
        id: 'other',
        canonicalRoot: await tempDir('home23-brain-source-api-other-'),
        kind: 'resident',
        sourceType: 'brain',
      },
    }),
    withEphemeralSource: async () => {
      opened = true;
    },
  });
  await assert.rejects(() => service.graph({ nodeLimit: 1 }), (error) => (
    error.code === 'source_changed' && error.retryable === true
  ));
  assert.equal(opened, false);
});

test('status on unavailable source returns false with unknown evidence', async () => {
  const brainDir = await tempDir('home23-brain-source-api-brain-');
  const canonicalRoot = await fsp.realpath(brainDir);
  const service = createBrainSourceService({
    brainDir,
    home23Root: await tempDir('home23-brain-source-api-home-'),
    requesterAgent: 'jerry',
    resolveTargetContext: async () => ({
      catalogRevision: 'catalog-1',
      accessMode: 'own',
      target: { id: 'brain-jerry', canonicalRoot, kind: 'resident', sourceType: 'brain' },
    }),
    withEphemeralSource: async (options, callback) => callback(fakeSource({
      sourceHealth: 'unavailable',
      operationId: 'dashboard-source-test',
    }), {
      identity: { ...options.identity, canonicalRoot, operationId: 'dashboard-source-test' },
    }),
  });
  const status = await service.status();
  assert.equal(status.ok, false);
  assert.equal(status.evidence.sourceHealth, 'unavailable');
  assert.equal(status.evidence.matchOutcome, 'unknown');
});

test('the real unavailable source cannot become a successful zero graph', async () => {
  const brainDir = await tempDir('home23-brain-source-api-unavailable-');
  const canonicalRoot = await fsp.realpath(brainDir);
  const source = await openMemorySource(brainDir);
  assert.equal(source.getEvidence().sourceHealth, 'unavailable');
  const service = createBrainSourceService({
    brainDir,
    home23Root: await tempDir('home23-brain-source-api-home-'),
    requesterAgent: 'jerry',
    resolveTargetContext: async () => ({
      catalogRevision: 'catalog-1',
      accessMode: 'own',
      target: { id: 'brain-jerry', canonicalRoot, kind: 'resident', sourceType: 'brain' },
    }),
    withEphemeralSource: async (options, callback) => callback(source, {
      identity: { ...options.identity, canonicalRoot, operationId: 'dashboard-source-unavailable' },
    }),
  });
  await assert.rejects(
    () => service.graph({ nodeLimit: 10 }),
    (error) => error.code === 'source_unavailable'
      && error.status === 503
      && error.sourceEvidence?.sourceHealth === 'unavailable',
  );
  await source.close();
});

test('full graph compatibility request is rejected with typed 413', async () => {
  const brainDir = await tempDir('home23-brain-source-api-brain-');
  const canonicalRoot = await fsp.realpath(brainDir);
  const service = createBrainSourceService({
    brainDir,
    home23Root: await tempDir('home23-brain-source-api-home-'),
    requesterAgent: 'jerry',
    resolveTargetContext: async () => ({
      catalogRevision: 'catalog-1',
      accessMode: 'own',
      target: { id: 'brain-jerry', canonicalRoot, kind: 'resident', sourceType: 'brain' },
    }),
    withEphemeralSource: async (options, callback) => callback(fakeSource({
      operationId: 'dashboard-source-test',
      nodes: [{ id: 'n1', concept: 'one' }],
    }), {
      identity: { ...options.identity, canonicalRoot, operationId: 'dashboard-source-test' },
    }),
  });
  await assert.rejects(
    () => service.graph({ full: '1' }),
    (error) => error.code === 'result_too_large' && error.status === 413,
  );
});

test('status validates complete ANN delta coverage, shares the loader cache and preserves read-only files', async (t) => {
  const fixture = await statusIndexFixture(t);
  const snapshot = async () => Promise.all((await fsp.readdir(fixture.brainDir)).sort().map(async file => (
    [file, (await fsp.readFile(path.join(fixture.brainDir, file))).toString('base64')]
  )));
  const before = await snapshot();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await fixture.service.status(fixture.request);
    assert.equal(result.ok, true);
    assert.equal(result.evidence.sourceHealth, 'healthy');
    assert.equal(result.evidence.indexWatermark.fresh, false);
    assert.equal(result.evidence.indexWatermark.status, 'covered via overlay');
    assert.equal(result.evidence.indexCoverage.complete, true);
    assert.equal(result.evidence.indexCoverage.coveredThroughRevision, fixture.source.revision);
    assert.equal(result.evidence.retrievalMode, 'semantic-ann-delta-overlay');
  }
  assert.equal(fixture.runtimeLoads(), 1, 'repeat status must reuse the validated native index');
  assert.deepEqual(await snapshot(), before, 'read-only status must not rebuild or mutate the brain');
});

test('status distinguishes a current base index from complete overlay coverage', async (t) => {
  const fixture = await statusIndexFixture(t, { withDelta: false });
  const result = await fixture.service.status(fixture.request);
  assert.equal(result.evidence.indexWatermark.fresh, true);
  assert.equal(result.evidence.indexWatermark.status, 'fresh');
  assert.equal(result.evidence.retrievalMode, 'semantic-ann');
});

test('status rejects ANN coverage when labels omit skipped unembedded nodes', async t => {
  const fixture = await statusIndexFixture(t, { skippedNode: true, metadata: { skipped: 1 } });
  await fixture.loadAnn(fixture.source, fixture.source.manifest.ann);
  const result = await fixture.service.status(fixture.request);
  assert.equal(fixture.runtimeLoads(), 1, 'native index validates, but its labels do not cover every source node');
  assert.equal(result.evidence.indexCoverage.complete, false);
  assert.equal(result.evidence.indexWatermark.status, 'unavailable');
});

test('status refuses overlay freshness for incompatible metadata and corrupt or missing index files', async (t) => {
  for (const options of [
    { metadata: { authorityProjectionSchema: 'obsolete' } },
    { metadata: { authorityAttestationKeyId: 'wrong-key' } },
    { metadata: { builtFromRevision: 999 } },
    { metadata: { generation: 'different-generation' } },
    { indexBytes: 'corrupt' },
    { missingIndex: true },
  ]) {
    const fixture = await statusIndexFixture(t, options);
    if (options.missingIndex) await fsp.unlink(path.join(fixture.brainDir, 'status.index'));
    const result = await fixture.service.status(fixture.request);
    assert.equal(result.evidence.indexWatermark.status, 'unavailable', JSON.stringify(options));
    assert.equal(result.evidence.indexCoverage.complete, false);
    assert.equal(result.evidence.indexCoverage.coveredThroughRevision, null);
    assert.equal(result.evidence.indexWatermark.fresh, false);
  }
});

test('status never promotes an incomplete or unavailable canonical overlay', async (t) => {
  const fixture = await statusIndexFixture(t);
  for (const override of [
    { sourceHealth: 'unavailable' },
    { deltaWatermark: { revision: fixture.source.revision, appliedRecords: 0 } },
  ]) {
    const source = { ...fixture.source, getEvidence(input) { return { ...fixture.source.getEvidence(input), ...override }; } };
    const result = await fixture.service.status({ ...fixture.request, sourcePin: source });
    assert.equal(result.evidence.indexWatermark.status, 'unavailable');
    assert.equal(result.evidence.indexCoverage.complete, false);
  }
  assert.equal(fixture.runtimeLoads(), 0, 'unproven source coverage must not load an ANN');
});
