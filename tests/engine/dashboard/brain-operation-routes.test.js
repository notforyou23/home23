import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const express = require('express');
const {
  createBrainOperationsPlaceholderRouter,
  createBrainOperationsRouter,
} = require('../../../engine/src/dashboard/brain-operations/router.js');

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
    buildCatalog: async () => ({ catalogRevision: 'catalog-1', brains: [] }),
    coordinator: {
      start: async (input) => { calls.push(['start', input]); return current; },
      cancel: async (operationId) => { calls.push(['cancel', operationId]); return record({ state: 'cancelled' }); },
      detach: async (operationId, input) => { calls.push(['detach', operationId, input]); return { state: 'detached', ...input }; },
      attach: async (operationId, input) => {
        calls.push(['attach', operationId, input.attachmentId]);
        input.onEvent({ type: 'progress', operationId, sequence: 2, eventSequence: 2 });
        return { done: Promise.resolve() };
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
      ['pgs-zero', 'pgs', { query: 'x', pgsConfig: { sweepFraction: 0 } }],
      ['pgs-extra', 'pgs', { query: 'x', pgsConfig: { sweepFraction: 0.5, extra: true } }],
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
        priorContext: { query: 'q', answer: 'a'.repeat(19_999) },
        pgsConfig: { sweepFraction: 0.25 },
        pgsSweep: { provider: 'anthropic', model: 'shared-name' },
        pgsSynth: { provider: 'openai', model: 'shared-name' },
      },
    });
    assert.equal(valid.status, 202);
  });
  assert.equal(deps.calls.filter(([name]) => name === 'start').length, 1);
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
