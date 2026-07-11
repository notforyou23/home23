const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Ajv2020 = require('ajv/dist/2020');
const fs = require('fs');
const path = require('path');
const {
  QUERY_COMPATIBILITY_BODY_LIMIT_BYTES,
  buildQueryCatalog,
  createQueryCompatibilityBodyParser,
  createQueryApiRouter,
} = require('../../engine/src/dashboard/home23-query-api.js');

const MAX_JSON_ESCAPED_UTF16_UNIT_BYTES = 6;
const MAX_AGENT_SELECTOR_CHARS = 256;
const MAX_QUERY_CHARS = 12_000;
const MAX_AD_HOC_ANSWER_CHARS = 1_000_000;
const MAX_METADATA_JSON_BYTES = 64 * 1024;
const MAX_AD_HOC_FIXED_BODY_BYTES = Buffer.byteLength(JSON.stringify({
  agent: '', query: '', answer: '', format: 'markdown', metadata: null,
  dryRun: true, validateOnly: true,
}), 'utf8') - Buffer.byteLength('null', 'utf8');
const EXPECTED_QUERY_COMPATIBILITY_BODY_LIMIT_BYTES = MAX_AD_HOC_FIXED_BODY_BYTES
  + MAX_JSON_ESCAPED_UTF16_UNIT_BYTES
    * (MAX_AGENT_SELECTOR_CHARS + MAX_QUERY_CHARS + MAX_AD_HOC_ANSWER_CHARS)
  + MAX_METADATA_JSON_BYTES;

function makeFetch(routes) {
  return async (url, init = {}) => {
    const parsed = new URL(url);
    const key = parsed.pathname;
    if (!Object.prototype.hasOwnProperty.call(routes, key)) {
      return new Response(JSON.stringify({ error: `unexpected ${key}` }), { status: 404 });
    }
    const value = routes[key];
    if (value instanceof Error) throw value;
    if (typeof value === 'function') {
      const next = await value({ url, parsed, init });
      if (next instanceof Response) return next;
      return new Response(JSON.stringify(next.body ?? next), {
        status: next.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(value.body ?? value), {
      status: value.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

async function postJson(app, route, body) {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const port = server.address().port;
        const res = await fetch(`http://127.0.0.1:${port}${route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        server.close();
        resolve({ status: res.status, body: json });
      } catch (err) {
        server.close();
        reject(err);
      }
    });
  });
}

async function postRawJson(app, route, body) {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const port = server.address().port;
        const res = await fetch(`http://127.0.0.1:${port}${route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
        const json = await res.json();
        server.close();
        resolve({ status: res.status, body: json });
      } catch (err) {
        server.close();
        reject(err);
      }
    });
  });
}

function exactJsonBody(bytes) {
  const prefix = '{"pad":"';
  const suffix = '"}';
  return prefix + 'x'.repeat(bytes - Buffer.byteLength(prefix + suffix)) + suffix;
}

function metadataObjectAtJsonBytes(bytes) {
  const fixed = Buffer.byteLength('{"pad":""}', 'utf8');
  const metadata = { pad: 'm'.repeat(bytes - fixed) };
  assert.equal(Buffer.byteLength(JSON.stringify(metadata), 'utf8'), bytes);
  return metadata;
}

async function getJson(app, route) {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const port = server.address().port;
        const res = await fetch(`http://127.0.0.1:${port}${route}`);
        const json = await res.json();
        server.close();
        resolve({ status: res.status, body: json });
      } catch (err) {
        server.close();
        reject(err);
      }
    });
  });
}

test('query catalog facade normalizes COSMO status, models, brains, and selected agent truth', async () => {
  const catalog = await buildQueryCatalog({
    agent: 'jerry',
    cosmoBaseUrl: 'http://cosmo.test',
    fetchImpl: makeFetch({
      '/api/status': {
        success: true,
        running: false,
        apiReachable: true,
        lifecycle: 'idle',
        activeRun: false,
        processOnline: false,
      },
      '/api/providers/models': {
        success: true,
        defaults: { queryModel: 'gpt-5.5', pgsSweepModel: 'claude-sonnet-4-7' },
        models: [
          { id: 'gpt-5.5', label: 'GPT-5.5', provider: 'openai', kind: 'chat' },
          { id: 'text-embedding-3-small', provider: 'openai', kind: 'embedding' },
        ],
      },
      '/api/brains': {
        brains: [
          {
            id: 'brain-jerry',
            routeKey: 'brain-jerry',
            name: 'brain',
            displayName: 'Jerry Brain',
            path: '/home/user/home23/instances/jerry/brain',
            sourceLabel: 'Jerry',
            sourceType: 'reference',
          },
        ],
      },
    }),
    queryDefaultsProvider: () => ({
      defaultModel: 'gpt-5.5',
      defaultProvider: 'openai-codex',
      defaultMode: 'dive',
      enablePGSByDefault: false,
      pgsSweepModel: 'claude-sonnet-4-7',
      pgsSweepProvider: 'anthropic',
      pgsSynthModel: 'gpt-5.5',
      pgsSynthProvider: 'openai-codex',
      pgsDepth: 0.25,
    }),
  });

  assert.equal(catalog.agent, 'jerry');
  assert.equal(catalog.available, true);
  assert.equal(catalog.reason, null);
  assert.equal(catalog.cosmo.apiReachable, true);
  assert.equal(catalog.cosmo.running, false);
  assert.equal(catalog.cosmo.activeRun, false);
  assert.equal(catalog.streaming, false);
  assert.equal(catalog.models.length, 1, 'embedding models are not query execution choices');
  assert.deepEqual(catalog.models[0], {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    provider: 'openai',
    providerLabel: null,
    kind: 'chat',
    source: null,
  });
  assert.equal(catalog.selectedBrain.routeKey, 'brain-jerry');
  assert.equal(catalog.defaults.provider, 'openai-codex');
  assert.equal(catalog.defaults.pgsSweepProvider, 'anthropic');
  assert.equal(catalog.defaults.pgsSynthProvider, 'openai-codex');
  assert.equal(catalog.endpoints.run, '/home23/api/query/run');
  assert.equal(catalog.endpoints.stream, '/home23/api/query/stream');
  assert.equal(catalog.endpoints.export, '/home23/api/query/export');
});

test('query catalog facade reports explicit unavailable state when COSMO is unreachable', async () => {
  const catalog = await buildQueryCatalog({
    agent: 'jerry',
    cosmoBaseUrl: 'http://cosmo.test',
    fetchImpl: makeFetch({
      '/api/status': new Error('connect ECONNREFUSED'),
      '/api/providers/models': new Error('connect ECONNREFUSED'),
      '/api/brains': new Error('connect ECONNREFUSED'),
    }),
  });

  assert.equal(catalog.available, false);
  assert.equal(catalog.reason, 'cosmo23 unreachable');
  assert.equal(catalog.lastRouteError, 'connect ECONNREFUSED');
  assert.equal(catalog.models.length, 0);
  assert.equal(catalog.brains.length, 0);
});

test('query catalog route validates against the query catalog schema', async () => {
  const app = express();
  app.use('/home23/api/query', createQueryApiRouter({
    getDefaultAgent: () => 'jerry',
    resolveAgent: (agent) => agent || 'jerry',
    cosmoBaseUrl: 'http://cosmo.test',
    fetchImpl: makeFetch({
      '/api/status': { success: true, running: false, apiReachable: true, activeRun: false },
      '/api/providers/models': { models: [{ id: 'gpt-5.5', label: 'GPT-5.5', provider: 'openai', kind: 'chat' }] },
      '/api/brains': { brains: [{ id: 'brain-jerry', routeKey: 'brain-jerry', displayName: 'Jerry Brain', sourceLabel: 'Jerry' }] },
    }),
  }));

  const res = await getJson(app, '/home23/api/query/catalog?agent=jerry');

  assert.equal(res.status, 200);
  const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'contracts/schemas/query.schema.json'), 'utf8'));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile({ ...schema, $ref: '#/$defs/queryCatalogResponse' });
  assert.equal(validate(res.body), true, ajv.errorsText(validate.errors));
});

test('query export facade refuses raw COSMO fallback when durable adapter is unavailable', async () => {
  let rawExportCalls = 0;
  const app = express();
  app.use(express.json());
  app.use('/home23/api/query', createQueryApiRouter({
    getDefaultAgent: () => 'jerry',
    resolveAgent: (agent) => agent || 'jerry',
    cosmoBaseUrl: 'http://cosmo.test',
    fetchImpl: makeFetch({
      '/api/status': { success: true, running: false, apiReachable: true, activeRun: false },
      '/api/providers/models': { models: [{ id: 'gpt-5.5', label: 'GPT-5.5', provider: 'openai', kind: 'chat' }] },
      '/api/brains': { brains: [{ id: 'brain-jerry', routeKey: 'brain-jerry', displayName: 'Jerry Brain', sourceLabel: 'Jerry' }] },
      '/api/brain/brain-jerry/export-query': () => {
        rawExportCalls += 1;
        return { exportedTo: '/fake/exports/query.md' };
      },
    }),
  }));

  const res = await postJson(app, '/home23/api/query/export?agent=jerry', {
    query: 'what changed',
    answer: 'facade export',
    format: 'markdown',
    metadata: { model: 'gpt-5.5' },
  });

  assert.equal(res.status, 503);
  assert.equal(res.body.success, false);
  assert.equal(res.body.error.code, 'operation_adapter_unavailable');
  assert.equal(rawExportCalls, 0);
});

test('query run dry-run validates through facade without forwarding to COSMO brain query', async () => {
  const app = express();
  app.use(express.json());
  app.use('/home23/api/query', createQueryApiRouter({
    getDefaultAgent: () => 'jerry',
    resolveAgent: (agent) => agent || 'jerry',
    cosmoBaseUrl: 'http://cosmo.test',
    fetchImpl: makeFetch({
      '/api/status': { success: true, running: false, apiReachable: true, activeRun: false },
      '/api/providers/models': { models: [{ id: 'gpt-5.5', label: 'GPT-5.5', provider: 'openai', kind: 'chat' }] },
      '/api/brains': { brains: [{ id: 'brain-jerry', routeKey: 'brain-jerry', displayName: 'Jerry Brain', sourceLabel: 'Jerry' }] },
      '/api/brain/brain-jerry/query': () => {
        throw new Error('dry-run must not forward to COSMO query');
      },
    }),
  }));

  const res = await postJson(app, '/home23/api/query/run?agent=jerry', {
    query: 'contract probe',
    modelSelection: { provider: 'openai', model: 'gpt-5.5' },
    mode: 'quick',
    enablePGS: false,
    dryRun: true,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.dryRun, true);
  assert.equal(res.body.result.metadata.dryRun, true);
  assert.equal(res.body.result.metadata.operation, 'run');
  assert.match(res.body.result.answer, /without forwarding to COSMO23/);
});

test('query run facade rejects legacy flat model and PGS spellings before execution', async () => {
  let rawQueryCalls = 0;
  const app = express();
  app.use(express.json());
  app.use('/home23/api/query', createQueryApiRouter({
    getDefaultAgent: () => 'jerry',
    resolveAgent: (agent) => agent || 'jerry',
    cosmoBaseUrl: 'http://cosmo.test',
    fetchImpl: makeFetch({
      '/api/status': { success: true, running: false, apiReachable: true, activeRun: false },
      '/api/providers/models': {
        models: [
          { id: 'gpt-5.5', label: 'GPT-5.5', provider: 'openai', kind: 'chat' },
        ],
      },
      '/api/brains': {
        brains: [
          { id: 'brain-jerry', routeKey: 'brain-jerry', displayName: 'Jerry Brain', sourceLabel: 'Jerry' },
        ],
      },
      '/api/brain/brain-jerry/query': ({ init }) => {
        rawQueryCalls += 1;
        return {
          body: {
            query: 'what changed',
            answer: 'facade query answer',
            metadata: {
              model: 'gpt-5.5',
              mode: 'full',
              pgs: { enabled: true },
            },
          },
        };
      },
    }),
  }));

  const res = await postJson(app, '/home23/api/query/run?agent=jerry', {
    query: 'what changed',
    model: 'gpt-5.5',
    mode: 'full',
    includeEvidenceMetrics: true,
    enableSynthesis: true,
    includeCoordinatorInsights: true,
    includeOutputs: true,
    includeThoughts: true,
    allowActions: false,
    enablePGS: true,
    pgsMode: 'full',
    pgsSessionId: 'pgs-contract-test',
    pgsFullSweep: false,
    pgsConfig: { sweepFraction: 0.25 },
    pgsSweepModel: 'claude-sonnet-4-7',
    priorContext: {
      query: 'previous',
      answer: 'previous answer',
    },
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error.code, 'invalid_request');
  assert.equal(rawQueryCalls, 0);
});

test('query run facade does not fall back to raw COSMO when durable adapter is unavailable', async () => {
  let rawQueryCalls = 0;
  const app = express();
  app.use(express.json());
  app.use('/home23/api/query', createQueryApiRouter({
    getDefaultAgent: () => 'jerry',
    resolveAgent: (agent) => agent || 'jerry',
    cosmoBaseUrl: 'http://cosmo.test',
    fetchImpl: makeFetch({
      '/api/status': { success: true, running: false, apiReachable: true, activeRun: false },
      '/api/providers/models': { models: [{ id: 'gpt-5.5', label: 'GPT-5.5', provider: 'openai', kind: 'chat' }] },
      '/api/brains': { brains: [{ id: 'brain-jerry', routeKey: 'brain-jerry', displayName: 'Jerry Brain', sourceLabel: 'Jerry' }] },
      '/api/brain/brain-jerry/query': {
        body: () => { rawQueryCalls += 1; return { answer: 'must not run' }; },
      },
    }),
  }));

  const res = await postJson(app, '/home23/api/query/run?agent=jerry', {
    query: 'will fail',
    modelSelection: { provider: 'openai', model: 'gpt-5.5' },
    mode: 'quick',
    enablePGS: false,
  });

  assert.equal(res.status, 503);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error.code, 'operation_adapter_unavailable');
  assert.equal(rawQueryCalls, 0);
});

test('query export dry-run returns export contract shape without writing through COSMO export', async () => {
  const app = express();
  app.use(express.json());
  app.use('/home23/api/query', createQueryApiRouter({
    getDefaultAgent: () => 'jerry',
    resolveAgent: (agent) => agent || 'jerry',
    cosmoBaseUrl: 'http://cosmo.test',
    fetchImpl: makeFetch({
      '/api/status': { success: true, running: false, apiReachable: true, activeRun: false },
      '/api/providers/models': { models: [{ id: 'gpt-5.5', label: 'GPT-5.5', provider: 'openai', kind: 'chat' }] },
      '/api/brains': { brains: [{ id: 'brain-jerry', routeKey: 'brain-jerry', displayName: 'Jerry Brain', sourceLabel: 'Jerry' }] },
      '/api/brain/brain-jerry/export-query': () => {
        throw new Error('dry-run must not forward to COSMO export');
      },
    }),
  }));

  const res = await postJson(app, '/home23/api/query/export?agent=jerry', {
    query: 'what changed',
    answer: 'facade export',
    format: 'markdown',
    metadata: { model: 'gpt-5.5' },
    validateOnly: true,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.dryRun, true);
  assert.equal(res.body.exportedTo, null);
  assert.equal(res.body.metadata.operation, 'export');
});

const COMPAT_OPERATION_ID = `brop_${'c'.repeat(32)}`;

function canonicalCompatBoundaries(root) {
  return [
    { kind: 'brain', path: root },
    { kind: 'run', path: root },
    { kind: 'pgs', path: `${root}/pgs-sessions` },
    { kind: 'session', path: `${root}/sessions` },
    { kind: 'cache', path: `${root}/cache` },
    { kind: 'export', path: `${root}/exports` },
    { kind: 'agency', path: `${root}/agency` },
  ];
}

function canonicalCompatRecord(overrides = {}) {
  return {
    operationId: COMPAT_OPERATION_ID,
    requestId: 'request-compat',
    operationType: 'query',
    requestParameters: { query: 'x' },
    parameters: { query: 'x' },
    canonicalEvidence: true,
    recordVersion: 1,
    eventSequence: 0,
    requesterAgent: 'jerry',
    target: {
      domain: 'brain',
      brainId: 'brain-jerry',
      ownerAgent: 'jerry',
      displayName: 'Jerry Brain',
      kind: 'resident',
      lifecycle: 'resident',
      catalogRevision: 'catalog-compat',
      route: '/api/brain/brain-jerry',
      canonicalRoot: '/fixture/jerry',
      accessMode: 'own',
      mutationBoundaries: canonicalCompatBoundaries('/fixture/jerry'),
    },
    state: 'queued',
    phase: null,
    startedAt: null,
    updatedAt: '2026-07-09T12:00:00.000Z',
    completedAt: null,
    lastProviderActivityAt: null,
    lastProgressAt: null,
    result: null,
    resultHandle: null,
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

function compatCatalog() {
  return {
    agent: 'jerry',
    available: true,
    reason: null,
    selectedBrain: { id: 'brain-jerry', routeKey: 'brain-jerry', displayName: 'Jerry Brain' },
    brains: [{ id: 'brain-jerry', routeKey: 'brain-jerry', displayName: 'Jerry Brain' }],
    models: [{ id: 'gpt-5.5', provider: 'openai' }],
    defaults: { model: 'gpt-5.5', mode: 'quick' },
    endpoints: {
      run: '/home23/api/query/run',
      stream: '/home23/api/query/stream',
      export: '/home23/api/query/export',
    },
    cosmo: { apiReachable: true, running: false, activeRun: false },
    streaming: true,
    limits: { maxQueryChars: 12000, maxPriorContextChars: 20000 },
    lastRouteError: null,
  };
}

function makeQueryApp({
  onForward = () => {},
  adapter = {},
  catalogProvider = async () => compatCatalog(),
  resolveAgent = () => 'jerry',
} = {}) {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use('/home23/api/query', createQueryApiRouter({
    getDefaultAgent: () => 'jerry',
    resolveAgent,
    cosmoBaseUrl: 'http://cosmo.test',
    fetchImpl: makeFetch({
      '/api/status': { success: true, running: false, apiReachable: true, activeRun: false },
      '/api/providers/models': { models: [{ id: 'gpt-5.5', provider: 'openai', kind: 'chat' }] },
      '/api/brains': { brains: [{ id: 'brain-jerry', routeKey: 'brain-jerry', displayName: 'Jerry Brain', sourceLabel: 'jerry' }] },
      '/api/brain/brain-jerry/query': { body: { answer: 'legacy bypass' } },
      '/api/brain/brain-forrest/query': { body: { answer: 'wrong target bypass' } },
    }),
    catalogProvider,
    operationAdapter: {
      start: async (request) => {
        calls.push('start');
        onForward(request);
        return canonicalCompatRecord({ state: 'queued', eventSequence: 0 });
      },
      attachAndWait: async (operation, options) => {
        calls.push('attachAndWait');
        assert.equal(operation.operationId, COMPAT_OPERATION_ID);
        assert.ok(options.attachmentId);
        assert.equal(options.waitMs, 5_400_000);
        return canonicalCompatRecord({ state: 'complete', eventSequence: 3, result: null });
      },
      getResult: async (operationId) => {
        calls.push('getResult');
        return {
          operationId,
          state: 'complete',
          result: { answer: 'ok' },
          resultHandle: `brres_${'d'.repeat(32)}`,
          resultArtifact: null,
          error: null,
          sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'matches' },
        };
      },
      detach: async () => { calls.push('detach'); },
      exportStored: async (request) => {
        calls.push('exportStored');
        onForward(request);
        const canonicalEvidence = request.kind === 'canonical';
        const relativePath = `workspace/brain-exports/result-brexp_${'e'.repeat(32)}.md`;
        return {
          operationId: COMPAT_OPERATION_ID,
          state: 'complete',
          resultHandle: canonicalEvidence ? `brres_${'d'.repeat(32)}` : null,
          canonicalEvidence,
          exportedTo: relativePath,
          exportHandle: `brexp_${'e'.repeat(32)}`,
          relativePath,
          bytes: 123,
          sha256: 'f'.repeat(64),
          sourceOperationId: COMPAT_OPERATION_ID,
          sourceResultHandleHash: canonicalEvidence ? 'a'.repeat(64) : null,
          format: request.format,
        };
      },
      ...adapter,
    },
  }));
  return { app, calls };
}

async function postRaw(app, pathname, body) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, text: await response.text() };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function parseSseData(text) {
  return text.replace(/\r\n/g, '\n').split('\n\n').flatMap((frame) => {
    const data = frame.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    return data && data !== '[DONE]' ? [JSON.parse(data)] : [];
  });
}

function compileQueryDefinition(definition) {
  const schema = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), 'contracts/schemas/query.schema.json'),
    'utf8',
  ));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  return ajv.compile({ ...schema, $ref: `#/$defs/${definition}` });
}

test('query facade rejects one character beyond published query and prior-context limits', async () => {
  const forwarded = [];
  const { app } = makeQueryApp({ onForward: (request) => forwarded.push(request) });
  const tooLongQuery = await postJson(app, '/home23/api/query/run', {
    query: 'q'.repeat(12001),
    modelSelection: { provider: 'openai', model: 'gpt-5.5' },
    mode: 'quick',
    enablePGS: false,
  });
  assert.equal(tooLongQuery.status, 413);
  assert.equal(tooLongQuery.body.error.code, 'invalid_request');
  const tooLongPrior = await postJson(app, '/home23/api/query/run', {
    query: 'ok',
    modelSelection: { provider: 'openai', model: 'gpt-5.5' },
    mode: 'quick',
    enablePGS: false,
    priorContext: { query: 'p', answer: 'a'.repeat(20001) },
  });
  assert.equal(tooLongPrior.status, 413);
  assert.equal(forwarded.length, 0);
});

test('compatibility facade rejects agent and brain mismatch instead of forwarding arbitrary target', async () => {
  const response = await postJson(makeQueryApp().app, '/home23/api/query/run?agent=jerry', {
    brainId: 'brain-forrest',
    query: 'x',
    modelSelection: { provider: 'openai', model: 'gpt-5.5' },
    mode: 'quick',
    enablePGS: false,
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'target_mismatch');
});

test('compatibility facade rejects query/body disagreement and explicit unknown agents before catalog or start', async () => {
  let catalogCalls = 0;
  const disagree = makeQueryApp({
    catalogProvider: async () => { catalogCalls += 1; return compatCatalog(); },
  });
  const mismatch = await postJson(disagree.app, '/home23/api/query/run?agent=forrest', {
    agent: 'jerry',
    query: 'x',
    modelSelection: { provider: 'openai', model: 'gpt-5.5' },
    enablePGS: false,
  });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.error.code, 'target_mismatch');
  assert.equal(catalogCalls, 0);
  assert.equal(disagree.calls.length, 0);

  const unknown = makeQueryApp({
    catalogProvider: async () => { catalogCalls += 1; return compatCatalog(); },
  });
  const missing = await postJson(unknown.app, '/home23/api/query/run?agent=forrest', {
    query: 'x',
    modelSelection: { provider: 'openai', model: 'gpt-5.5' },
    enablePGS: false,
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'target_not_found');
  assert.equal(catalogCalls, 0);
  assert.equal(unknown.calls.length, 0);
});

test('compatibility run performs durable start, attach/wait, then protected result read', async () => {
  const fixture = makeQueryApp();
  const response = await postJson(fixture.app, '/home23/api/query/run', {
    query: 'x',
    modelSelection: { provider: 'openai', model: 'gpt-5.5' },
    mode: 'quick',
    enablePGS: false,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(fixture.calls, ['start', 'attachAndWait', 'getResult']);
  assert.equal(response.body.operationId, COMPAT_OPERATION_ID);
  assert.equal(response.body.answer, 'ok');
});

test('compatibility PGS selects six-hour attachment policy and forwards progress beyond 120 seconds', async () => {
  let now = 0;
  const progress = [];
  const fixture = makeQueryApp({ adapter: {
    start: async () => ({
      ...canonicalCompatRecord({ state: 'queued', eventSequence: 0 }),
      operationType: 'pgs',
    }),
    attachAndWait: async (_operation, options) => {
      assert.equal(options.waitMs, 21_600_000);
      options.onEvent(canonicalCompatRecord({ state: 'running', eventSequence: 1 }));
      progress.push(now);
      now += 121_000;
      options.onEvent(canonicalCompatRecord({ state: 'running', eventSequence: 2 }));
      progress.push(now);
      return canonicalCompatRecord({ state: 'complete', eventSequence: 3, result: null });
    },
  } });
  const response = await postJson(fixture.app, '/home23/api/query/run', {
    query: 'x',
    enablePGS: true,
    pgsConfig: { sweepFraction: 0.25 },
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    pgsSynth: { provider: 'anthropic', model: 'claude-sonnet-4-7' },
    mode: 'quick',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(progress, [0, 121_000]);
  assert.equal(response.body.answer, 'ok');
});

test('compatibility PGS preserves a useful null-answer partial with sweep output and typed error', async () => {
  const sourceEvidence = { sourceHealth: 'healthy', matchOutcome: 'matches' };
  const fixture = makeQueryApp({ adapter: {
    start: async () => ({
      ...canonicalCompatRecord({ state: 'queued', eventSequence: 0 }),
      operationType: 'pgs',
    }),
    attachAndWait: async () => ({
      ...canonicalCompatRecord({ state: 'partial', eventSequence: 3 }),
      operationType: 'pgs',
    }),
    getResult: async (operationId) => ({
      operationId,
      state: 'partial',
      result: {
        answer: null,
        sweepOutputs: [{
          workUnitId: 'p1-u1',
          partitionId: 'p1',
          output: 'useful evidence',
          provider: 'minimax',
          model: 'MiniMax-M3',
        }],
        metadata: { pgs: {
          successfulSweeps: 1,
          retryablePartitions: ['p2'],
          sweepFraction: 1,
          selectedWorkUnits: 2,
          pendingWorkUnits: 1,
        } },
        sourceEvidence,
      },
      resultHandle: `brres_${'d'.repeat(32)}`,
      resultArtifact: null,
      error: { code: 'provider_incomplete', message: 'synthesis truncated', retryable: true },
      sourceEvidence,
    }),
  } });
  const response = await postJson(fixture.app, '/home23/api/query/run', {
    query: 'x',
    enablePGS: true,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    pgsSynth: { provider: 'anthropic', model: 'claude-sonnet-4-7' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.state, 'partial');
  assert.equal(response.body.answer, null);
  assert.equal(response.body.result.sweepOutputs[0].output, 'useful evidence');
  assert.equal(response.body.error.code, 'provider_incomplete');
  const validate = compileQueryDefinition('queryRunResponse');
  assert.equal(validate(response.body), true, JSON.stringify(validate.errors));
});

test('compatibility detach is honest and remains actionable', async () => {
  let resultReads = 0;
  let detaches = 0;
  const fixture = makeQueryApp({ adapter: {
    attachAndWait: async () => ({
      ...canonicalCompatRecord({ state: 'running', eventSequence: 2 }),
      attachmentState: 'detached',
    }),
    getResult: async () => {
      resultReads += 1;
      throw new Error('result must not be read');
    },
    detach: async () => { detaches += 1; },
  } });
  const response = await postJson(fixture.app, '/home23/api/query/run', {
    query: 'x',
    modelSelection: { provider: 'openai', model: 'gpt-5.5' },
    mode: 'quick',
    enablePGS: false,
  });
  assert.equal(response.status, 202);
  assert.equal(response.body.operationId, COMPAT_OPERATION_ID);
  assert.equal(response.body.state, 'running');
  assert.equal(response.body.detached, true);
  assert.match(JSON.stringify(response.body), /status|result|cancel|resume/);
  assert.equal('answer' in response.body, false);
  assert.equal(resultReads, 0);
  assert.equal(detaches, 0, 'adapter already returned an authoritative detached state');
});

test('compatibility stream attaches to events and terminal bytes come only from result', async () => {
  let resultReads = 0;
  const fixture = makeQueryApp({ adapter: {
    attachAndWait: async (_operation, options) => {
      options.onEvent(canonicalCompatRecord({ state: 'running', eventSequence: 1 }));
      options.onEvent(canonicalCompatRecord({ state: 'complete', eventSequence: 2, result: null }));
      return canonicalCompatRecord({ state: 'complete', eventSequence: 2, result: null });
    },
    getResult: async (operationId) => {
      resultReads += 1;
      return {
        operationId,
        state: 'complete',
        result: { answer: 'protected bytes' },
        resultHandle: `brres_${'d'.repeat(32)}`,
        resultArtifact: null,
        error: null,
        sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'matches' },
      };
    },
  } });
  const response = await postRaw(fixture.app, '/home23/api/query/stream', {
    query: 'x',
    modelSelection: { provider: 'openai', model: 'gpt-5.5' },
    mode: 'quick',
    enablePGS: false,
  });
  assert.equal(response.status, 200);
  const rows = parseSseData(response.text);
  assert.deepEqual(rows.filter((row) => row.eventSequence).map((row) => row.eventSequence), [1, 2]);
  assert.equal(rows.at(-1).answer, 'protected bytes');
  assert.equal(resultReads, 1);
  assert.equal(fixture.calls.filter((call) => call === 'start').length, 1);
});

test('compatibility request accepts only exact nested provider pairs and finite numeric controls', async () => {
  const invalidBodies = [
    { query: 'x', model: 'gpt-5.5', provider: 'openai', enablePGS: false },
    { query: 'x', modelSelection: null, enablePGS: false },
    { query: 'x', modelSelection: { provider: 'openai' }, enablePGS: false },
    { query: 'x', modelSelection: { provider: 'openai', model: 'gpt-5.5', extra: true }, enablePGS: false },
    { query: 'x', modelSelection: { provider: 'openai', model: 'gpt-5.5' }, topK: null, enablePGS: false },
    { query: 'x', modelSelection: { provider: 'openai', model: 'gpt-5.5' }, priorContext: null, enablePGS: false },
    { query: 'x', pgsSweepModel: 'MiniMax-M3', enablePGS: true },
    { query: 'x', pgsSweep: null, enablePGS: true },
    { query: 'x', pgsSweep: { provider: 'minimax' }, enablePGS: true },
    { query: 'x', pgsConfig: { sweepFraction: null }, enablePGS: true },
    { query: 'x', pgsConfig: { sweepFraction: 0.25, extra: 1 }, enablePGS: true },
    { query: 'x', unknown: true, enablePGS: false },
  ];
  for (const body of invalidBodies) {
    const fixture = makeQueryApp();
    const response = await postJson(fixture.app, '/home23/api/query/run', body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.body.error.code, 'invalid_request', JSON.stringify(body));
    assert.equal(fixture.calls.length, 0, JSON.stringify(body));
  }
});

test('compatibility forwarding strips facade controls and binds the selected canonical target', async () => {
  const forwarded = [];
  const fixture = makeQueryApp({ onForward: (request) => forwarded.push(request) });
  const response = await postJson(fixture.app, '/home23/api/query/run?agent=jerry', {
    agent: 'jerry',
    brainId: 'brain-jerry',
    query: 'x',
    modelSelection: { provider: 'openai', model: 'gpt-5.5' },
    mode: 'quick',
    enablePGS: false,
  });
  assert.equal(response.status, 200);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].operationType, 'query');
  assert.deepEqual(forwarded[0].target, { brainId: 'brain-jerry' });
  assert.deepEqual(forwarded[0].parameters, {
    query: 'x',
    mode: 'quick',
    modelSelection: { provider: 'openai', model: 'gpt-5.5' },
  });
  assert.equal('enablePGS' in forwarded[0].parameters, false);
  assert.equal('agent' in forwarded[0].parameters, false);
});

test('compatibility terminal success rejects success false, embedded errors, and missing answer', async () => {
  const resultHandle = `brres_${'v'.repeat(32)}`;
  const resultArtifact = { mediaType: 'application/json', contentEncoding: 'identity', bytes: 7, sha256: 'b'.repeat(64) };
  const sourceEvidence = { sourceHealth: 'healthy', matchOutcome: 'matches' };
  const validate = compileQueryDefinition('queryRunResponse');
  for (const row of [
    { state: 'complete', result: { success: false, answer: 'misleading' }, error: null },
    { state: 'complete', result: { error: 'provider failed', answer: 'misleading' }, error: null },
    { state: 'complete', result: { metadata: { done: true } }, error: null },
    {
      state: 'partial', result: { answer: null },
      error: { code: 'provider_incomplete', message: 'partial malformed', retryable: true },
    },
  ]) {
    const fixture = makeQueryApp({ adapter: {
      attachAndWait: async () => canonicalCompatRecord({ state: row.state, eventSequence: 3 }),
      getResult: async (operationId) => ({
        operationId,
        state: row.state,
        result: row.result,
        resultHandle,
        resultArtifact,
        error: row.error,
        sourceEvidence,
      }),
    } });
    const response = await postJson(fixture.app, '/home23/api/query/run', {
      query: 'x',
      modelSelection: { provider: 'openai', model: 'gpt-5.5' },
      enablePGS: false,
    });
    assert.equal(response.status, 502, JSON.stringify(row));
    assert.equal(response.body.ok, false);
    assert.match(response.body.error.code, /^result_/);
    assert.equal(response.body.operationId, COMPAT_OPERATION_ID);
    assert.equal(response.body.state, row.state);
    assert.equal(response.body.resultHandle, resultHandle);
    assert.deepEqual(response.body.resultArtifact, resultArtifact);
    assert.deepEqual(response.body.sourceEvidence, sourceEvidence);
    assert.equal(validate(response.body), true, JSON.stringify(validate.errors));
  }
});

test('compatibility wait and protected result cannot switch operation identity', async () => {
  const otherId = `brop_${'f'.repeat(32)}`;
  for (const adapter of [
    {
      attachAndWait: async () => canonicalCompatRecord({ operationId: otherId, state: 'complete' }),
    },
    {
      getResult: async () => ({
        operationId: otherId,
        state: 'complete',
        result: { answer: 'wrong operation' },
        resultHandle: null,
        resultArtifact: null,
        error: null,
        sourceEvidence: null,
      }),
    },
  ]) {
    const response = await postJson(makeQueryApp({ adapter }).app, '/home23/api/query/run', {
      query: 'x', enablePGS: false,
    });
    assert.equal(response.status, 502);
    assert.equal(response.body.error.code, 'operation_contract_invalid');
  }
});

test('compatibility canonical export rejects inline bytes and forwards only stored operation authority', async () => {
  const forwarded = [];
  const fixture = makeQueryApp({ onForward: (request) => forwarded.push(request) });
  const rejected = await postJson(fixture.app, '/home23/api/query/export', {
    operationId: COMPAT_OPERATION_ID,
    answer: 'caller supplied bytes',
    query: 'x',
    format: 'markdown',
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.code, 'invalid_request');
  assert.equal(forwarded.length, 0);

  for (const invalid of [
    { operationId: 'not-an-operation', format: 'markdown' },
    { operationId: COMPAT_OPERATION_ID, resultHandle: 'not-a-result', format: 'markdown' },
  ]) {
    const response = await postJson(fixture.app, '/home23/api/query/export', invalid);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'invalid_request');
  }
  assert.equal(forwarded.length, 0);

  const accepted = await postJson(fixture.app, '/home23/api/query/export', {
    operationId: COMPAT_OPERATION_ID,
    resultHandle: `brres_${'d'.repeat(32)}`,
    format: 'markdown',
    fileName: 'result',
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.success, true);
  assert.deepEqual(forwarded[0], {
    kind: 'canonical',
    operationId: COMPAT_OPERATION_ID,
    resultHandle: `brres_${'d'.repeat(32)}`,
    format: 'markdown',
    fileName: 'result',
  });
});

test('canonical stored export remains local and works while the live COSMO catalog is unavailable', async () => {
  const forwarded = [];
  let catalogCalls = 0;
  const fixture = makeQueryApp({
    onForward: (request) => forwarded.push(request),
    catalogProvider: async () => {
      catalogCalls += 1;
      throw Object.assign(new Error('COSMO catalog unavailable'), { code: 'catalog_unavailable' });
    },
  });
  const response = await postJson(fixture.app, '/home23/api/query/export', {
    operationId: COMPAT_OPERATION_ID,
    resultHandle: `brres_${'d'.repeat(32)}`,
    format: 'markdown',
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(catalogCalls, 0);
  assert.deepEqual(forwarded, [{
    kind: 'canonical',
    operationId: COMPAT_OPERATION_ID,
    resultHandle: `brres_${'d'.repeat(32)}`,
    format: 'markdown',
  }]);
});

test('query compatibility JSON is bounded before the dashboard broad parser materializes it', async () => {
  let broadCalls = 0;
  let adapterCalls = 0;
  const app = express();
  app.use('/home23/api/query', createQueryCompatibilityBodyParser());
  app.use((req, res, next) => {
    if (req.queryCompatibilityBodyParsed === true) return next();
    broadCalls += 1;
    return express.json({ limit: '10gb' })(req, res, next);
  });
  app.use('/home23/api/query', createQueryApiRouter({
    getDefaultAgent: () => 'jerry',
    resolveAgent: () => 'jerry',
    catalogProvider: async () => compatCatalog(),
    operationAdapter: {
      start: async () => { adapterCalls += 1; throw new Error('must not start'); },
      attachAndWait: async () => {},
      getResult: async () => {},
      detach: async () => {},
      exportStored: async () => {},
    },
  }));
  const response = await postRawJson(
    app,
    '/home23/api/query/run',
    exactJsonBody(EXPECTED_QUERY_COMPATIBILITY_BODY_LIMIT_BYTES + 1),
  );
  assert.equal(response.status, 413);
  assert.equal(response.body.error.code, 'request_too_large');
  assert.equal(broadCalls, 0);
  assert.equal(adapterCalls, 0);
});

test('query compatibility body cap admits the maximum valid ad hoc export aggregate', async () => {
  assert.equal(
    QUERY_COMPATIBILITY_BODY_LIMIT_BYTES,
    EXPECTED_QUERY_COMPATIBILITY_BODY_LIMIT_BYTES,
  );
  let forwarded = null;
  let broadCalls = 0;
  const app = express();
  app.use('/home23/api/query', createQueryCompatibilityBodyParser());
  app.use((req, res, next) => {
    if (req.queryCompatibilityBodyParsed === true) return next();
    broadCalls += 1;
    return express.json({ limit: '10gb' })(req, res, next);
  });
  app.use('/home23/api/query', createQueryApiRouter({
    getDefaultAgent: () => 'jerry',
    resolveAgent: () => 'jerry',
    catalogProvider: async () => { throw new Error('catalog must not be read'); },
    operationAdapter: {
      start: async () => {}, attachAndWait: async () => {}, getResult: async () => {}, detach: async () => {},
      exportStored: async (request) => {
        forwarded = request;
        const relativePath = `workspace/brain-exports/max-brexp_${'m'.repeat(32)}.json`;
        return {
          operationId: COMPAT_OPERATION_ID, state: 'complete', resultHandle: null,
          canonicalEvidence: false, exportedTo: relativePath,
          exportHandle: `brexp_${'m'.repeat(32)}`, relativePath, bytes: 1,
          sha256: 'c'.repeat(64), sourceOperationId: COMPAT_OPERATION_ID,
          sourceResultHandleHash: null, format: 'json',
        };
      },
    },
  }));
  const metadata = metadataObjectAtJsonBytes(64 * 1024);
  const body = JSON.stringify({
    query: 'q'.repeat(12_000),
    answer: 'a'.repeat(1_000_000),
    format: 'json',
    metadata,
  });
  assert.ok(Buffer.byteLength(body, 'utf8') <= QUERY_COMPATIBILITY_BODY_LIMIT_BYTES);
  const response = await postRawJson(app, '/home23/api/query/export', body);
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(broadCalls, 0);
  assert.equal(forwarded.query.length, 12_000);
  assert.equal(forwarded.answer.length, 1_000_000);
  assert.equal(Buffer.byteLength(JSON.stringify(forwarded.metadata), 'utf8'), 64 * 1024);
  assert.equal(Object.hasOwn(forwarded.metadata, 'canonicalEvidence'), false);
});

test('DashboardServer mounts the bounded query parser before its legacy ten-gigabyte parser', () => {
  const source = fs.readFileSync(path.join(
    process.cwd(), 'engine/src/dashboard/server.js',
  ), 'utf8');
  const boundedQueryParser = source.indexOf(
    "this.app.use('/home23/api/query', this.queryCompatibilityBodyParser)",
  );
  const broadParser = source.indexOf('const broadJsonParser =');
  const broadUrlencodedParser = source.indexOf('const broadUrlencodedParser =');
  const routeRegistration = source.indexOf('registerQueryApiRoutes(this.app');
  assert.ok(boundedQueryParser > 0);
  assert.ok(boundedQueryParser < broadParser);
  assert.ok(broadParser < broadUrlencodedParser);
  assert.ok(broadUrlencodedParser < routeRegistration);
  assert.equal(
    (source.match(/if \(req\.queryCompatibilityBodyParsed === true\) return next\(\);/g) || []).length,
    2,
  );
});

test('compatibility ad hoc export is explicitly noncanonical and independent of COSMO catalog', async () => {
  const forwarded = [];
  let catalogCalls = 0;
  const fixture = makeQueryApp({
    onForward: (request) => forwarded.push(request),
    catalogProvider: async () => {
      catalogCalls += 1;
      throw Object.assign(new Error('COSMO catalog unavailable'), { code: 'catalog_unavailable' });
    },
  });
  const response = await postJson(fixture.app, '/home23/api/query/export', {
    query: 'x',
    answer: 'not a stored operation result',
    format: 'json',
    metadata: { source: 'compatibility' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.canonicalEvidence, false);
  assert.equal(catalogCalls, 0);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].kind, 'ad_hoc');
  assert.deepEqual(forwarded[0].metadata, { source: 'compatibility' });
  assert.match(forwarded[0].requestId, /^compat-export-/);
});

test('query request schema enforces exact direct and PGS provider objects', () => {
  const validate = compileQueryDefinition('queryRequest');
  assert.equal(validate({
    query: 'x',
    enablePGS: false,
    modelSelection: { provider: 'openai', model: 'gpt-5.5' },
  }), true, JSON.stringify(validate.errors));
  assert.equal(validate({
    query: 'x',
    enablePGS: true,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    pgsSynth: { provider: 'anthropic', model: 'claude-sonnet-4-7' },
    pgsConfig: { sweepFraction: 0.25 },
  }), true, JSON.stringify(validate.errors));
  for (const invalid of [
    { query: 'x', enablePGS: false, model: 'gpt-5.5', provider: 'openai' },
    { query: 'x', enablePGS: false, modelSelection: null },
    { query: 'x', enablePGS: false, modelSelection: { provider: 'openai' } },
    { query: 'x', enablePGS: true, pgsSweepModel: 'MiniMax-M3' },
    { query: 'x', enablePGS: true, pgsSweep: { provider: 'minimax', model: 'MiniMax-M3', extra: 1 } },
    { query: 'x', enablePGS: true, pgsConfig: { sweepFraction: 0 } },
  ]) assert.equal(validate(invalid), false, JSON.stringify(invalid));
});

test('query response schema distinguishes terminal, detached, and typed failure shapes', async () => {
  const validate = compileQueryDefinition('queryRunResponse');
  const terminalFixture = makeQueryApp();
  const terminal = await postJson(terminalFixture.app, '/home23/api/query/run', {
    query: 'x',
    enablePGS: false,
    modelSelection: { provider: 'openai', model: 'gpt-5.5' },
  });
  assert.equal(validate(terminal.body), true, JSON.stringify(validate.errors));

  const detachedFixture = makeQueryApp({ adapter: {
    attachAndWait: async () => ({
      ...canonicalCompatRecord({ state: 'running', eventSequence: 2 }),
      attachmentState: 'detached',
    }),
  } });
  const detached = await postJson(detachedFixture.app, '/home23/api/query/run', {
    query: 'x', enablePGS: false,
  });
  assert.equal(detached.status, 202);
  assert.equal(validate(detached.body), true, JSON.stringify(validate.errors));

  const failure = await postJson(makeQueryApp().app, '/home23/api/query/run', {
    query: 'x', enablePGS: false, unknown: true,
  });
  assert.equal(failure.status, 400);
  assert.equal(validate(failure.body), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ok: true, operationId: COMPAT_OPERATION_ID, state: 'running' }), false);
});

test('failed, cancelled, and interrupted durable responses retain actionable operation references', async () => {
  const validate = compileQueryDefinition('queryRunResponse');
  for (const state of ['failed', 'cancelled', 'interrupted']) {
    const resultHandle = `brres_${state[0].repeat(32)}`;
    const resultArtifact = {
      mediaType: 'application/json',
      contentEncoding: 'identity',
      bytes: 123,
      sha256: 'a'.repeat(64),
    };
    const sourceEvidence = { sourceHealth: 'degraded', matchOutcome: 'unknown' };
    const fixture = makeQueryApp({ adapter: {
      attachAndWait: async () => canonicalCompatRecord({ state, eventSequence: 4 }),
      getResult: async (operationId) => ({
        operationId,
        operationType: 'query',
        state,
        result: null,
        resultHandle,
        resultArtifact,
        error: { code: `operation_${state}`, message: `${state} durably`, retryable: state !== 'cancelled' },
        sourceEvidence,
      }),
    } });
    const response = await postJson(fixture.app, '/home23/api/query/run', {
      query: 'x', enablePGS: false,
    });
    assert.equal(response.status, state === 'cancelled' ? 409 : 502);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.operationId, COMPAT_OPERATION_ID);
    assert.equal(response.body.state, state);
    assert.equal(response.body.resultHandle, resultHandle);
    assert.deepEqual(response.body.resultArtifact, resultArtifact);
    assert.deepEqual(response.body.sourceEvidence, sourceEvidence);
    assert.equal(response.body.error.code, `operation_${state}`);
    assert.equal(validate(response.body), true, `${state}: ${JSON.stringify(validate.errors)}`);
  }
});

test('stream terminal failure retains the durable operation reference in its typed error event', async () => {
  const sourceEvidence = { sourceHealth: 'degraded', matchOutcome: 'unknown' };
  const fixture = makeQueryApp({ adapter: {
    attachAndWait: async (_operation, options) => {
      options.onEvent(canonicalCompatRecord({ state: 'running', eventSequence: 1 }));
      return canonicalCompatRecord({ state: 'failed', eventSequence: 2 });
    },
    getResult: async (operationId) => ({
      operationId,
      operationType: 'query',
      state: 'failed',
      result: null,
      resultHandle: `brres_${'e'.repeat(32)}`,
      resultArtifact: null,
      error: { code: 'provider_failed', message: 'provider failed durably', retryable: true },
      sourceEvidence,
    }),
  } });
  const response = await postRaw(fixture.app, '/home23/api/query/stream', {
    query: 'x', enablePGS: false,
  });
  assert.equal(response.status, 200);
  const final = parseSseData(response.text).at(-1);
  assert.equal(final.type, 'error');
  assert.equal(final.operationId, COMPAT_OPERATION_ID);
  assert.equal(final.state, 'failed');
  assert.equal(final.resultHandle, `brres_${'e'.repeat(32)}`);
  assert.deepEqual(final.sourceEvidence, sourceEvidence);
  assert.equal(final.error.code, 'provider_failed');
  const validate = compileQueryDefinition('streamEvent');
  assert.equal(validate(final), true, JSON.stringify(validate.errors));
});

test('query stream and export responses validate against typed compatibility schemas', async () => {
  const validateStream = compileQueryDefinition('streamEvent');
  const streamFixture = makeQueryApp({ adapter: {
    attachAndWait: async (_operation, options) => {
      options.onEvent(canonicalCompatRecord({ state: 'running', eventSequence: 1 }));
      options.onEvent(canonicalCompatRecord({ state: 'complete', eventSequence: 2 }));
      return canonicalCompatRecord({ state: 'complete', eventSequence: 2 });
    },
  } });
  const stream = await postRaw(streamFixture.app, '/home23/api/query/stream', {
    query: 'x', enablePGS: false,
  });
  for (const event of parseSseData(stream.text)) {
    assert.equal(validateStream(event), true, `${JSON.stringify(event)} ${JSON.stringify(validateStream.errors)}`);
  }

  const validateExport = compileQueryDefinition('queryExportResponse');
  const exported = await postJson(makeQueryApp().app, '/home23/api/query/export', {
    operationId: COMPAT_OPERATION_ID,
    format: 'markdown',
  });
  assert.equal(validateExport(exported.body), true, JSON.stringify(validateExport.errors));
  const exportFailure = await postJson(makeQueryApp().app, '/home23/api/query/export', {
    operationId: COMPAT_OPERATION_ID,
    answer: 'forbidden',
    format: 'markdown',
  });
  assert.equal(validateExport(exportFailure.body), true, JSON.stringify(validateExport.errors));
});
