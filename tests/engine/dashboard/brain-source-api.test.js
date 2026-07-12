import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  createBrainSourceService,
  rejectCallerIdentity,
  sendBrainSourceError,
} = require('../../../engine/src/dashboard/brain-source-api');
const { openMemorySource } = require('../../../shared/memory-source');

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
