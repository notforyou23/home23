import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs, { readFileSync } from 'node:fs';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const express = require('express');
const {
  createBrainOperationsPlaceholderRouter,
  createBrainOperationsRouter,
  writeSseFrame,
} = require('../../../engine/src/dashboard/brain-operations/router.js');
const {
  BrainOperationStore,
} = require('../../../engine/src/dashboard/brain-operations/operation-store.js');
const {
  createBrainOperationStoreReader,
} = require('../../../engine/src/dashboard/brain-operations/store-reader.js');
const {
  createBrainOperationExporter,
} = require('../../../engine/src/dashboard/brain-operations/exporter.js');

const OPERATION_ID = 'brop_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const RESULT_HANDLE = 'brres_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function record(overrides = {}) {
  return {
    operationId: OPERATION_ID,
    requestId: 'request-1',
    operationType: 'query',
    requestParameters: { query: 'canary' },
    parameters: { query: 'canary' },
    canonicalEvidence: true,
    recordVersion: 2,
    eventSequence: 1,
    requesterAgent: 'jerry',
    target: { domain: 'requester', requesterAgent: 'jerry' },
    state: 'running',
    phase: 'provider',
    startedAt: '2026-07-10T12:00:00.000Z',
    updatedAt: '2026-07-10T12:00:01.000Z',
    completedAt: null,
    lastProviderActivityAt: null,
    lastProgressAt: null,
    result: null,
    resultHandle: RESULT_HANDLE,
    resultArtifact: null,
    error: null,
    sourceEvidence: null,
    sourcePinDescriptor: null,
    sourcePinDigest: null,
    sourcePinReleasedAt: null,
    resultExpiresAt: null,
    resultExpiredAt: null,
    metadataExpiresAt: null,
    ...overrides,
  };
}

test('readiness reports provider migration truth without creating an operation', async () => {
  const ready = fakes();
  await withRouter(ready, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/readiness`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ready: true,
      providerOperations: {
        ready: true, status: 'ready', code: null, retryable: false, migrated: false,
      },
    });
  });
  assert.deepEqual(ready.calls, []);

  const unavailable = fakes({
    providerReadiness: () => ({
      ready: false, status: 'unavailable', code: 'provider_unavailable',
      retryable: true, migrated: false,
    }),
  });
  await withRouter(unavailable, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/readiness`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).providerOperations.code, 'provider_unavailable');
  });
  assert.deepEqual(unavailable.calls, []);
});

async function withRouter(dependencies, callback, { broadParser } = {}) {
  const app = express();
  const placeholder = createBrainOperationsPlaceholderRouter();
  app.use('/home23/api/brain-operations', placeholder.router);
  app.use((req, res, next) => {
    if (req.brainOperationBodyParsed === true) return next();
    if (broadParser) return broadParser(req, res, next);
    return express.json({ limit: '10gb' })(req, res, next);
  });
  placeholder.attach(createBrainOperationsRouter(dependencies).router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/home23/api/brain-operations`;
  try {
    await callback(baseUrl);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function exactJsonBody(bytes) {
  const prefix = '{"pad":"';
  const suffix = '"}';
  return prefix + 'x'.repeat(bytes - Buffer.byteLength(prefix + suffix)) + suffix;
}

function fakes(overrides = {}) {
  const calls = [];
  const current = record();
  return {
    calls,
    requesterAgent: 'jerry',
    providerReadiness: () => ({
      ready: true, status: 'ready', code: null, retryable: false, migrated: false,
    }),
    buildCatalog: async () => ({ catalogRevision: 'catalog-1', brains: [] }),
    coordinator: {
      start: async (input) => { calls.push(['start', input]); return current; },
      cancel: async (operationId) => { calls.push(['cancel', operationId]); return record({ state: 'cancelled' }); },
      detach: async (operationId, input) => { calls.push(['detach', operationId, input]); return { state: 'detached', ...input }; },
      attach: async (operationId, input) => {
        calls.push(['attach', operationId, input.attachmentId]);
        assert.equal(input.onEvent, undefined);
        let delivered = false;
        return {
          done: Promise.resolve(),
          async nextEvent() {
            if (delivered) return null;
            delivered = true;
            return { type: 'progress', operationId, sequence: 2, eventSequence: 2 };
          },
        };
      },
    },
    reader: {
      getAuthorized: async (operationId) => { calls.push(['get', operationId]); return current; },
      listNonterminalAuthorized: async () => { calls.push(['list']); return [current]; },
      getResultAuthorized: async (operationId, handle) => {
        calls.push(['result', operationId, handle]);
        return { answer: 'stored answer' };
      },
    },
    exporter: {
      exportResult: async (input) => { calls.push(['export', input]); return { exportHandle: 'brexp_ok' }; },
    },
    ...overrides,
  };
}

function realTarget(home23Root) {
  const canonicalRoot = path.join(home23Root, 'instances', 'jerry', 'brain');
  return {
    domain: 'brain',
    brainId: 'brain-jerry',
    ownerAgent: 'jerry',
    displayName: 'Jerry',
    kind: 'resident',
    lifecycle: 'resident',
    catalogRevision: 'catalog-real-fixture',
    route: '/api/brain/brain-jerry',
    canonicalRoot,
    accessMode: 'own',
    mutationBoundaries: [
      { kind: 'brain', path: canonicalRoot },
      { kind: 'run', path: canonicalRoot },
      { kind: 'pgs', path: path.join(canonicalRoot, 'pgs-sessions') },
      { kind: 'session', path: path.join(canonicalRoot, 'sessions') },
      { kind: 'cache', path: path.join(canonicalRoot, 'cache') },
      { kind: 'export', path: path.join(canonicalRoot, 'exports') },
      { kind: 'agency', path: path.join(canonicalRoot, 'agency') },
    ],
  };
}

async function makeRouteFixture(t) {
  const home23Root = fs.realpathSync.native(fs.mkdtempSync(
    path.join(tmpdir(), 'home23-brain-operation-routes-'),
  ));
  for (const relative of [
    'instances/jerry/brain',
    'instances/jerry/runtime',
    'instances/jerry/workspace',
  ]) fs.mkdirSync(path.join(home23Root, relative), { recursive: true });
  const operationsRoot = path.join(home23Root, 'instances/jerry/runtime/brain-operations');
  const store = new BrainOperationStore({ root: operationsRoot, requesterAgent: 'jerry' });
  const reader = createBrainOperationStoreReader({
    operationsRoot,
    expectedRequester: 'jerry',
    liveStore: store,
  });
  const exporter = createBrainOperationExporter({
    home23Root,
    requesterAgent: 'jerry',
    reader,
  });
  const coordinator = {
    async start(input) {
      const created = await store.create({
        requestId: input.requestId,
        requesterAgent: 'jerry',
        target: realTarget(home23Root),
        operationType: input.operationType,
        requestParameters: input.parameters,
        parameters: input.parameters,
        sourcePinDescriptor: null,
        sourcePinDigest: null,
        canonicalEvidence: true,
      });
      return created.record;
    },
    async cancel(operationId) {
      const current = await store.get(operationId);
      return store.transition(operationId, {
        expectedVersion: current.recordVersion,
        state: 'cancelled',
        error: { code: 'cancelled', message: 'cancelled', retryable: false },
      });
    },
    async detach(operationId) { return store.get(operationId); },
    async attach() { throw Object.assign(new Error('attachment_not_available'), { code: 'operation_unavailable' }); },
  };
  const worker = {
    async complete(operationId, envelope) {
      let current = await store.get(operationId);
      if (envelope.result !== null) {
        current = await store.setResult(operationId, {
          expectedVersion: current.recordVersion,
          result: envelope.result,
        });
      }
      return store.transition(operationId, {
        expectedVersion: current.recordVersion,
        state: envelope.state,
        error: envelope.error,
        sourceEvidence: envelope.sourceEvidence,
      });
    },
    async completeArtifact(operationId, artifact) {
      let current = await store.get(operationId);
      current = await store.adoptResultArtifact(operationId, {
        expectedVersion: current.recordVersion,
        ...artifact,
      });
      return store.transition(operationId, {
        expectedVersion: current.recordVersion,
        state: 'complete',
        error: null,
        sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'matches' },
      });
    },
  };
  const app = express();
  const placeholder = createBrainOperationsPlaceholderRouter();
  app.use('/home23/api/brain-operations', placeholder.router);
  app.use((req, res, next) => {
    if (req.brainOperationBodyParsed === true) return next();
    return express.json({ limit: '10gb' })(req, res, next);
  });
  placeholder.attach(createBrainOperationsRouter({
    requesterAgent: 'jerry',
    coordinator,
    reader,
    exporter,
    buildCatalog: async () => ({ catalogRevision: 'catalog-real-fixture', brains: [] }),
  }).router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/home23/api/brain-operations`;
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(home23Root, { recursive: true, force: true });
  });
  const getJson = async (pathname) => {
    const response = await fetch(`${baseUrl}${pathname}`);
    return { status: response.status, body: await response.json() };
  };
  const postJson = async (pathname, body) => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    home23Root,
    store,
    coordinator,
    worker,
    getJson,
    postJson,
    async writeOperationScratch(operationId, fileName, bytes) {
      const scratch = await store.ensureScratchDirectory(operationId);
      const filePath = path.join(scratch, fileName);
      await fs.promises.writeFile(filePath, bytes);
      return filePath;
    },
    async readExport(relativePath) {
      return fs.promises.readFile(
        path.join(home23Root, 'instances', 'jerry', relativePath),
        'utf8',
      );
    },
    async readExportBuffer(relativePath) {
      return fs.promises.readFile(path.join(home23Root, 'instances', 'jerry', relativePath));
    },
    sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); },
  };
}

test('bounded placeholder parses operation bodies before and instead of the broad parser', async () => {
  const deps = fakes();
  let broadCalls = 0;
  await withRouter(deps, async (baseUrl) => {
    const over = await fetch(baseUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: exactJsonBody(1024 * 1024 + 1),
    });
    assert.equal(over.status, 413);
    assert.equal((await over.json()).error.code, 'request_too_large');

    const exact = await fetch(baseUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: exactJsonBody(1024 * 1024),
    });
    assert.equal(exact.status, 400);
    assert.notEqual((await exact.json()).error.code, 'request_too_large');

    const malformed = await fetch(baseUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"broken":',
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, 'invalid_json');
  }, {
    broadParser(req, _res, next) {
      broadCalls += 1;
      next(new Error(`broad parser saw ${req.path}`));
    },
  });
  assert.equal(broadCalls, 0);
  assert.equal(deps.calls.length, 0);
});

test('DashboardServer keeps the bounded mount and delegate ahead of its broad parser and routes', () => {
  const source = readFileSync(new URL(
    '../../../engine/src/dashboard/server.js', import.meta.url,
  ), 'utf8');
  const boundedMount = source.indexOf(
    "this.app.use('/home23/api/brain-operations', this.brainOperationsPlaceholder.router)",
  );
  const broadParser = source.indexOf('const broadJsonParser =');
  const delegateAttach = source.indexOf('this.initializeBrainOperations(options.brainOperations)');
  const generalRoutes = source.indexOf('this.setupRoutes()', delegateAttach);
  assert.ok(boundedMount > 0);
  assert.ok(boundedMount < broadParser);
  assert.ok(broadParser < delegateAttach);
  assert.ok(delegateAttach < generalRoutes);
  assert.match(source, /if \(req\.brainOperationBodyParsed === true\) return next\(\);/);
});

test('start derives requester identity and rejects spoofed or extra authority fields', async () => {
  const deps = fakes();
  await withRouter(deps, async (baseUrl) => {
    const spoofed = await fetch(baseUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: 'request-1', operationType: 'query', parameters: { query: 'canary' },
        requesterAgent: 'forrest',
      }),
    });
    assert.equal(spoofed.status, 400);

    const started = await fetch(baseUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'request-1', operationType: 'query', parameters: { query: 'canary' } }),
    });
    assert.equal(started.status, 202);
    assert.equal((await started.json()).requesterAgent, 'jerry');
  });
  assert.deepEqual(deps.calls, [[
    'start', { requestId: 'request-1', operationType: 'query', parameters: { query: 'canary' } },
  ]]);
});

test('start enforces operation authority domains and exact operation-specific schemas before coordinator work', async () => {
  const deps = fakes();
  await withRouter(deps, async (baseUrl) => {
    const post = (body) => fetch(baseUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const invalid = [
      { requestId: 'unknown-1', operationType: 'unknown', parameters: {} },
      { requestId: 'run-missing', operationType: 'research_watch', parameters: { after: 0 } },
      { requestId: 'run-brain-alias', operationType: 'research_watch',
        target: { brainId: 'brain-forrest' }, parameters: { after: 0 } },
      { requestId: 'requester-target', operationType: 'research_launch',
        target: { agent: 'jerry' }, parameters: { topic: 'topic' } },
      { requestId: 'research-context-missing', operationType: 'research_launch',
        parameters: { topic: 'topic' } },
      { requestId: 'brain-run-alias', operationType: 'query',
        target: { runId: 'run-1' }, parameters: { query: 'canary' } },
      { requestId: 'query-extra', operationType: 'query',
        parameters: { query: 'canary', canonicalRoot: '/forged' } },
      { requestId: 'query-flat-provider', operationType: 'query',
        parameters: { query: 'canary', provider: 'openai', model: 'same-name' } },
      { requestId: 'query-pgs-pair', operationType: 'query',
        parameters: { query: 'canary', pgsSweep: { provider: 'openai', model: 'same-name' } } },
      { requestId: 'pgs-query-pair', operationType: 'pgs',
        parameters: { query: 'canary', modelSelection: { provider: 'openai', model: 'same-name' } } },
      { requestId: 'synthesis-pair', operationType: 'synthesis',
        parameters: { trigger: 'tool', provider: 'openai', model: 'same-name' } },
      { requestId: 'graph-wrong-format', operationType: 'graph_export',
        parameters: { format: 'json' } },
    ];
    for (const body of invalid) {
      const response = await post(body);
      assert.equal(response.status, 400, body.requestId);
      assert.equal((await response.json()).error.code, 'invalid_request', body.requestId);
    }

    const valid = await post({
      requestId: 'valid-query', operationType: 'query',
      target: { agent: 'forrest', brainId: 'brain-forrest' },
      parameters: {
        query: 'canary', topK: 100,
        modelSelection: { provider: 'openai', model: 'same-name' },
      },
    });
    assert.equal(valid.status, 202);
  });
  assert.equal(deps.calls.filter(([name]) => name === 'start').length, 1);
});

test('start validates bounded query, graph, cursor, and PGS values without coercion', async () => {
  const deps = fakes();
  await withRouter(deps, async (baseUrl) => {
    const post = (body) => fetch(baseUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const invalid = [
      ['query-too-long', 'query', { query: 'x'.repeat(12_001) }],
      ['query-empty', 'query', { query: '   ' }],
      ['prior-too-long', 'query', { query: 'x', priorContext: { query: 'q', answer: 'a'.repeat(20_000) } }],
      ['topk-fractional', 'search', { query: 'x', topK: 1.5 }],
      ['topk-over', 'search', { query: 'x', topK: 101 }],
      ['nodes-over', 'graph', { nodeLimit: 2_001, edgeLimit: 8_000 }],
      ['edges-over', 'graph', { nodeLimit: 2_000, edgeLimit: 8_001 }],
      ['graph-view-invalid', 'graph', { view: 'full_graph' }],
      ['pgs-legacy', 'pgs', { query: 'x', pgsConfig: { sweepFraction: 0.25 } }],
      ['pgs-missing-level', 'pgs', {
        query: 'x', pgsMode: 'fresh',
        pgsSweep: { provider: 'anthropic', model: 'shared-name' },
        pgsSynth: { provider: 'openai', model: 'shared-name' },
      }],
      ['watch-limit', 'research_watch', { after: 0, limit: 501 }],
      ['watch-cursor', 'research_watch', { after: -1 }],
    ];
    for (const [requestId, operationType, parameters] of invalid) {
      const body = { requestId, operationType, parameters };
      if (operationType === 'research_watch') body.target = { runId: 'run-1' };
      const response = await post(body);
      assert.equal(response.status, 400, requestId);
      assert.equal((await response.json()).error.code, 'invalid_request', requestId);
    }

    const valid = await post({
      requestId: 'bounds-valid', operationType: 'pgs', target: { agent: 'forrest' },
      parameters: {
        query: 'x'.repeat(12_000),
        pgsMode: 'fresh',
        pgsLevel: 'sample',
        pgsSweep: { provider: 'anthropic', model: 'shared-name' },
        pgsSynth: { provider: 'openai', model: 'shared-name' },
      },
    });
    assert.equal(valid.status, 202);
    const preflight = await post({
      requestId: 'pgs-partition-preflight', operationType: 'graph', target: { agent: 'forrest' },
      parameters: { view: 'pgs_partitions' },
    });
    assert.equal(preflight.status, 202);
  });
  assert.equal(deps.calls.filter(([name]) => name === 'start').length, 2);
});

test('catalog, requester collection, status, result, cancel, detach, and export use exact facades', async () => {
  const deps = fakes();
  await withRouter(deps, async (baseUrl) => {
    assert.equal((await (await fetch(`${baseUrl}/catalog`)).json()).catalogRevision, 'catalog-1');
    const listed = await (await fetch(`${baseUrl}?state=nonterminal`)).json();
    assert.equal(listed.operations.length, 1);
    assert.equal((await (await fetch(`${baseUrl}/${OPERATION_ID}`)).json()).operationId, OPERATION_ID);
    const result = await (await fetch(`${baseUrl}/${OPERATION_ID}/result`)).json();
    assert.deepEqual(result.result, { answer: 'stored answer' });

    const cancelled = await fetch(`${baseUrl}/${OPERATION_ID}/cancel`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(cancelled.status, 200);
    const detached = await fetch(`${baseUrl}/${OPERATION_ID}/detach`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attachmentId: 'attachment-1', reason: 'wait_deadline' }),
    });
    assert.equal(detached.status, 200);
    const exported = await fetch(`${baseUrl}/${OPERATION_ID}/export`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'json', resultHandle: RESULT_HANDLE }),
    });
    assert.equal(exported.status, 200);
    assert.equal((await exported.json()).exportHandle, 'brexp_ok');
  });
  assert.ok(deps.calls.some((call) => call[0] === 'result' && call[2] === RESULT_HANDLE));
  assert.ok(deps.calls.some((call) => call[0] === 'export'
    && call[1].requesterAgent === 'jerry' && call[1].operationId === OPERATION_ID));
});

test('requester collection lists bounded recent operations for recovery after context loss', async () => {
  const terminal = record({
    operationId: 'brop_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    state: 'partial',
    phase: 'complete',
    completedAt: '2026-07-10T12:05:00.000Z',
    updatedAt: '2026-07-10T12:05:00.000Z',
    error: { code: 'pgs_partitions_incomplete', message: 'partial', retryable: true },
  });
  const deps = fakes({
    reader: {
      getAuthorized: async () => record(),
      listNonterminalAuthorized: async () => [record()],
      listRecentAuthorized: async (limit) => {
        assert.equal(limit, 5);
        return [terminal, record()];
      },
      getResultAuthorized: async () => ({ answer: 'stored answer' }),
    },
  });
  await withRouter(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}?state=recent&limit=5`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.count, 2);
    assert.deepEqual(payload.operations.map((row) => row.operationId), [
      terminal.operationId,
      OPERATION_ID,
    ]);
    assert.equal(payload.operations[0].error.code, 'pgs_partitions_incomplete');

    for (const query of ['state=recent', 'state=recent&limit=0', 'state=recent&limit=101']) {
      const invalid = await fetch(`${baseUrl}?${query}`);
      assert.equal(invalid.status, 400, query);
      assert.equal((await invalid.json()).error.code, 'invalid_request', query);
    }
  });
});

test('research run discovery is requester-bound, bounded, and separate from operation state', async () => {
  const deps = fakes({
    researchRuns: {
      list: async (options) => ({ state: options.state, count: 1, runs: [{
        runId: 'active-run', state: 'active', topic: 'topic', updatedAt: '2026-07-12T12:00:00.000Z',
      }] }),
      getActive: async () => ({ active: true, runName: 'active-run', topic: 'topic' }),
    },
  });
  await withRouter(deps, async (baseUrl) => {
    const listed = await fetch(`${baseUrl}/research-runs?state=recent&limit=20`);
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).runs[0].runId, 'active-run');
    const active = await fetch(`${baseUrl}/research-runs/active`);
    assert.equal(active.status, 200);
    assert.equal((await active.json()).runName, 'active-run');
  });
});

test('collection and result fail closed on caller identity or handle injection', async () => {
  const deps = fakes();
  await withRouter(deps, async (baseUrl) => {
    for (const url of [
      `${baseUrl}?state=nonterminal&requesterAgent=forrest`,
      `${baseUrl}?state=all`,
      `${baseUrl}/${OPERATION_ID}/result?resultHandle=${RESULT_HANDLE}`,
    ]) {
      const response = await fetch(url);
      assert.equal(response.status, 400, url);
    }
  });

  const foreign = fakes({
    reader: {
      ...deps.reader,
      listNonterminalAuthorized: async () => [record({ requesterAgent: 'forrest' })],
    },
  });
  await withRouter(foreign, async (baseUrl) => {
    const response = await fetch(`${baseUrl}?state=nonterminal`);
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error.code, 'operation_store_corrupt');
  });
});

test('no-result failure terminals are canonical while unavailable, expired, and corrupt stay distinct', async () => {
  for (const state of ['failed', 'cancelled', 'interrupted']) {
    let resultReads = 0;
    const terminal = record({
      state,
      phase: state,
      result: null,
      resultHandle: null,
      resultArtifact: null,
      resultExpiredAt: null,
      error: { code: state, message: `${state} without result`, retryable: true },
    });
    const deps = fakes({
      reader: {
        ...fakes().reader,
        getAuthorized: async () => terminal,
        getResultAuthorized: async () => {
          resultReads += 1;
          throw Object.assign(new Error('result_unavailable'), { code: 'result_unavailable' });
        },
      },
    });
    await withRouter(deps, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/${OPERATION_ID}/result`);
      assert.equal(response.status, 200, state);
      assert.deepEqual(await response.json(), {
        operationId: OPERATION_ID,
        state,
        result: null,
        error: terminal.error,
        resultHandle: null,
        resultArtifact: null,
        sourceEvidence: null,
      });
    });
    assert.equal(resultReads, 0, state);
  }

  const cases = [
    {
      name: 'running',
      operation: record({ result: null, resultHandle: null, resultArtifact: null }),
      code: 'result_unavailable',
      status: 500,
    },
    {
      name: 'expired',
      operation: record({
        state: 'failed', result: null, resultHandle: null, resultArtifact: null,
        resultExpiredAt: '2026-07-10T12:00:02.000Z',
      }),
      code: 'result_expired',
      status: 410,
    },
    {
      name: 'corrupt',
      operation: record({ state: 'complete', result: null, resultHandle: RESULT_HANDLE }),
      code: 'result_corrupt',
      status: 500,
    },
  ];
  for (const fixture of cases) {
    const deps = fakes({
      reader: {
        ...fakes().reader,
        getAuthorized: async () => fixture.operation,
        getResultAuthorized: async () => {
          throw Object.assign(new Error(fixture.code), { code: fixture.code });
        },
      },
    });
    await withRouter(deps, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/${OPERATION_ID}/result`);
      assert.equal(response.status, fixture.status, fixture.name);
      assert.equal((await response.json()).error.code, fixture.code, fixture.name);
    });
  }
});

test('events require an attachment and stream canonical resumable SSE', async () => {
  const deps = fakes();
  await withRouter(deps, async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/${OPERATION_ID}/events?after=1`);
    assert.equal(missing.status, 400);
    const response = await fetch(`${baseUrl}/${OPERATION_ID}/events?after=1&attachmentId=attachment-1`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const body = await response.text();
    assert.match(body, /id: 2/);
    assert.match(body, /event: progress/);
    assert.match(body, /"operationId":"brop_/);
  });
});

test('SSE frame writer waits for drain and releases promptly on cancellation', async () => {
  class SlowResponse extends EventEmitter {
    constructor() {
      super();
      this.writableEnded = false;
      this.destroyed = false;
      this.writes = [];
    }
    write(frame) { this.writes.push(frame); return false; }
  }
  const response = new SlowResponse();
  const controller = new AbortController();
  let settled = false;
  const writing = writeSseFrame(response, 'data: one\n\n', controller.signal)
    .then((value) => { settled = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  response.emit('drain');
  assert.equal(await writing, true);

  const cancelled = writeSseFrame(response, 'data: two\n\n', controller.signal);
  controller.abort(new Error('stop'));
  assert.equal(await cancelled, false);
  assert.deepEqual(response.writes, ['data: one\n\n', 'data: two\n\n']);
});

test('events authenticates the durable attachment before committing SSE headers', async () => {
  const denied = fakes({
    coordinator: {
      ...fakes().coordinator,
      async attach() {
        const error = new Error('access_denied');
        error.code = 'access_denied';
        throw error;
      },
    },
  });
  await withRouter(denied, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/${OPERATION_ID}/events?after=0&attachmentId=attachment-denied`,
    );
    assert.equal(response.status, 403);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal((await response.json()).error.code, 'access_denied');
  });
});

test('large durable result reloads by operation route and canonical export rejects caller bytes', async (t) => {
  const fixture = await makeRouteFixture(t);
  const operation = await fixture.coordinator.start({
    requestId: 'large-result-route', operationType: 'query',
    parameters: { query: 'large result fixture' },
  });
  const answer = 'durable-result-byte\n'.repeat(80_000);
  await fixture.worker.complete(operation.operationId, {
    state: 'complete', result: { answer }, error: null,
    sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'matches' },
  });
  const status = await fixture.store.get(operation.operationId);
  assert.equal(typeof status.resultHandle, 'string');
  assert.match(status.resultHandle, /^brres_[A-Za-z0-9_-]{32}$/);
  assert.equal(status.resultHandle.includes(operation.operationId), false);
  assert.doesNotMatch(status.resultHandle, /[\\/]/);
  assert.equal(status.result, null);

  const loaded = await fixture.getJson(`/${operation.operationId}/result`);
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.result.answer.length, answer.length);
  assert.equal(loaded.body.resultHandle, status.resultHandle);

  const exported = await fixture.postJson(`/${operation.operationId}/export`, {
    format: 'markdown', resultHandle: status.resultHandle,
  });
  assert.equal(exported.status, 200);
  const exportedText = await fixture.readExport(exported.body.relativePath);
  assert.match(exportedText, /# Brain Operation Result/);
  const fencedJson = exportedText.match(/```json\n([\s\S]+)\n```/);
  assert.ok(fencedJson);
  assert.equal(JSON.parse(fencedJson[1]).answer, answer);

  const forged = await fixture.postJson(`/${operation.operationId}/export`, {
    format: 'markdown', answer: 'forged caller bytes',
  });
  assert.equal(forged.status, 400);
  assert.equal(forged.body.error.code, 'invalid_request');
});

test('graph artifact result route returns metadata and handle but never graph bytes', async (t) => {
  const fixture = await makeRouteFixture(t);
  const operation = await fixture.coordinator.start({
    requestId: 'graph-artifact-route', operationType: 'graph_export',
    parameters: { format: 'jsonl' },
  });
  const graphBytes = Buffer.from('{"node":{"id":"n1"}}\n'.repeat(100_000));
  await fixture.worker.completeArtifact(operation.operationId, {
    scratchPath: await fixture.writeOperationScratch(operation.operationId, 'graph.jsonl', graphBytes),
    mediaType: 'application/x-ndjson', contentEncoding: 'identity',
    bytes: graphBytes.length, sha256: fixture.sha256(graphBytes),
  });
  const status = await fixture.store.get(operation.operationId);
  assert.equal(typeof status.resultHandle, 'string');
  assert.match(status.resultHandle, /^brres_[A-Za-z0-9_-]{32}$/);
  assert.equal(status.resultHandle.includes(operation.operationId), false);
  assert.doesNotMatch(status.resultHandle, /[\\/]/);
  assert.equal(status.resultArtifact.bytes, graphBytes.length);
  assert.equal(status.resultArtifact.contentEncoding, 'identity');
  assert.match(status.resultArtifact.sha256, /^[a-f0-9]{64}$/);

  const loaded = await fixture.getJson(`/${operation.operationId}/result`);
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.result, null);
  assert.equal(loaded.body.resultHandle, status.resultHandle);
  assert.deepEqual(loaded.body.resultArtifact, status.resultArtifact);
  assert.equal(JSON.stringify(loaded.body).includes('"node"'), false);

  const exported = await fixture.postJson(`/${operation.operationId}/export`, { format: 'jsonl' });
  assert.equal(exported.status, 200);
  const copied = await fixture.readExportBuffer(exported.body.relativePath);
  assert.equal(copied.length, graphBytes.length);
  assert.equal(fixture.sha256(copied), status.resultArtifact.sha256);
});
