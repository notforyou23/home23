const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const Ajv2020 = require('ajv/dist/2020');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  QUERY_COMPATIBILITY_BODY_LIMIT_BYTES,
  buildQueryCatalog,
  createQueryCompatibilityBodyParser,
  createQueryApiRouter,
} = require('../../engine/src/dashboard/home23-query-api.js');
const { buildClientCapabilities } = require('../../engine/src/dashboard/client-capabilities.js');

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
const CONTINUE_OPERATION_ID = `brop_${'c'.repeat(32)}`;
const PGS_PAIRS = Object.freeze({
  pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
  pgsSynth: { provider: 'anthropic', model: 'claude-sonnet-4-7' },
});

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

async function postJson(app, route, body, headers = {}) {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const port = server.address().port;
        const res = await fetch(`http://127.0.0.1:${port}${route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
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

async function postJsonWithRawHeaders(app, route, body, rawHeaders) {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const payload = JSON.stringify(body);
      const headers = {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(payload)),
      };
      for (let index = 0; index < rawHeaders.length; index += 2) {
        const name = rawHeaders[index];
        const value = rawHeaders[index + 1];
        headers[name] = Object.hasOwn(headers, name)
          ? [headers[name], value].flat()
          : value;
      }
      const request = http.request({
        host: '127.0.0.1',
        port: server.address().port,
        path: route,
        method: 'POST',
        headers,
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          server.close();
          try {
            resolve({
              status: response.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            });
          } catch (error) {
            reject(error);
          }
        });
      });
      request.once('error', (error) => {
        server.close();
        reject(error);
      });
      request.end(payload);
    });
  });
}

test('respond-async Query start returns durable identity without waiting for provider work', async () => {
  let waited = false;
  const fixture = makeQueryApp({ adapter: {
    attachAndWait: async () => {
      waited = true;
      throw new Error('async starts must not attach');
    },
  } });
  const response = await postJson(fixture.app, '/home23/api/query/run', {
    query: 'x',
    mode: 'quick',
    modelSelection: { provider: 'openai', model: 'gpt-5.5' },
    enablePGS: false,
  }, { prefer: 'respond-async' });

  assert.equal(response.status, 202);
  assert.equal(response.body.operationId, COMPAT_OPERATION_ID);
  assert.equal(response.body.state, 'queued');
  assert.equal(response.body.attachmentState, 'detached');
  assert.equal(response.body.detached, true);
  assert.equal(waited, false);
  assert.deepEqual(fixture.calls, ['start']);
});

test('respond-async Query terminal replay returns the original durable result without attachment', async () => {
  const calls = [];
  const terminal = canonicalCompatRecord({
    state: 'complete',
    eventSequence: 3,
    completedAt: '2026-07-13T16:00:00.000Z',
    result: { answer: 'already complete' },
    resultHandle: `brres_${'d'.repeat(32)}`,
  });
  const fixture = makeQueryApp({ adapter: {
    start: async () => {
      calls.push('start');
      return terminal;
    },
    attachAndWait: async () => {
      calls.push('attachAndWait');
      throw new Error('terminal replay must not attach');
    },
    getResult: async (operationId) => {
      calls.push('getResult');
      return {
        operationId,
        operationType: 'query',
        state: 'complete',
        result: terminal.result,
        resultHandle: terminal.resultHandle,
        resultArtifact: null,
        error: null,
        sourceEvidence: null,
      };
    },
  } });

  const response = await postJson(fixture.app, '/home23/api/query/run', {
    query: 'x',
    mode: 'quick',
    modelSelection: { provider: 'openai', model: 'gpt-5.5' },
    enablePGS: false,
  }, {
    prefer: 'respond-async',
    'X-Home23-Query-Request-Id': `qreq_${'a'.repeat(32)}`,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.operationId, COMPAT_OPERATION_ID);
  assert.equal(response.body.state, 'complete');
  assert.equal(response.body.attachmentState, 'closed');
  assert.equal(response.body.detached, false);
  assert.equal(response.body.result.answer, 'already complete');
  assert.deepEqual(calls, ['start', 'getResult']);
});

test('Query run forwards one valid client request ID unchanged to durable start', async () => {
  const forwarded = [];
  const fixture = makeQueryApp({ onForward: (request) => forwarded.push(request) });
  const clientRequestId = `qreq_${'A0_-'.repeat(8)}`;
  const response = await postJson(fixture.app, '/home23/api/query/run', {
    query: 'x',
    mode: 'quick',
    modelSelection: { provider: 'openai', model: 'gpt-5.5' },
    enablePGS: false,
  }, { 'X-Home23-Query-Request-Id': clientRequestId, prefer: 'respond-async' });

  assert.equal(response.status, 202);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].requestId, clientRequestId);
});

test('Query run generates its existing compatibility request ID when the client header is absent', async () => {
  const forwarded = [];
  const fixture = makeQueryApp({ onForward: (request) => forwarded.push(request) });
  const response = await postJson(fixture.app, '/home23/api/query/run', {
    query: 'x',
    mode: 'quick',
    modelSelection: { provider: 'openai', model: 'gpt-5.5' },
    enablePGS: false,
  }, { prefer: 'respond-async' });

  assert.equal(response.status, 202);
  assert.equal(forwarded.length, 1);
  assert.match(
    forwarded[0].requestId,
    /^compat-query-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test('Query run rejects malformed, comma-joined, and duplicate client request IDs before start', async () => {
  const body = {
    query: 'x',
    mode: 'quick',
    modelSelection: { provider: 'openai', model: 'gpt-5.5' },
    enablePGS: false,
  };
  const valid = `qreq_${'a'.repeat(32)}`;
  const malformed = [
    '',
    'qreq_short',
    `qreq_${'a'.repeat(31)}!`,
    `${valid},${valid}`,
  ];
  for (const value of malformed) {
    const fixture = makeQueryApp();
    const response = await postJson(fixture.app, '/home23/api/query/run', body, {
      'X-Home23-Query-Request-Id': value,
      prefer: 'respond-async',
    });
    assert.equal(response.status, 400, JSON.stringify(value));
    assert.equal(response.body.error.code, 'invalid_request', JSON.stringify(value));
    assert.equal(fixture.calls.length, 0, JSON.stringify(value));
  }

  const duplicate = makeQueryApp();
  const response = await postJsonWithRawHeaders(
    duplicate.app,
    '/home23/api/query/run',
    body,
    [
      'X-Home23-Query-Request-Id', valid,
      'X-Home23-Query-Request-Id', valid,
      'Prefer', 'respond-async',
    ],
  );
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'invalid_request');
  assert.equal(duplicate.calls.length, 0);
});

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

test('query catalog uses the shared Home23 exact-pair authority without fetching COSMO models', async () => {
  const calls = [];
  const catalog = await buildQueryCatalog({
    agent: 'jerry',
    cosmoBaseUrl: 'http://cosmo.test',
    fetchImpl: async (url, init) => {
      calls.push(new URL(url).pathname);
      return makeFetch({
        '/api/status': {
          success: true, running: false, apiReachable: true, activeRun: false,
        },
        '/api/brains': {
          brains: [{
            id: 'brain-jerry', routeKey: 'brain-jerry', sourceLabel: 'Jerry',
          }],
        },
      })(url, init);
    },
    modelAuthorityProvider: () => ({
      models: [
        {
          id: 'gpt-5.6-terra', model: 'gpt-5.6-terra', name: 'gpt-5.6-terra',
          provider: 'openai-codex', providerLabel: 'OpenAI Codex', kind: 'chat',
          source: 'home23-config',
        },
        {
          id: 'grok-4.5', model: 'grok-4.5', name: 'grok-4.5',
          provider: 'xai', providerLabel: 'xAI', kind: 'chat',
          source: 'home23-config',
        },
      ],
      queryDefaults: {
        defaultProvider: 'openai-codex', defaultModel: 'gpt-5.6-terra',
        pgsSweepProvider: 'xai', pgsSweepModel: 'grok-4.5',
        pgsSynthProvider: 'openai-codex', pgsSynthModel: 'gpt-5.6-terra',
        defaultMode: 'dive', enablePGSByDefault: false, pgsDepth: 0.5,
      },
    }),
  });

  assert.equal(catalog.available, true);
  assert.deepEqual(catalog.models.map(({ provider, id }) => ({ provider, id })), [
    { provider: 'openai-codex', id: 'gpt-5.6-terra' },
    { provider: 'xai', id: 'grok-4.5' },
  ]);
  assert.deepEqual(catalog.defaults, {
    model: 'gpt-5.6-terra', provider: 'openai-codex', mode: 'dive',
    enablePGSByDefault: false,
    pgsSweepModel: 'grok-4.5', pgsSweepProvider: 'xai',
    pgsSynthModel: 'gpt-5.6-terra', pgsSynthProvider: 'openai-codex',
    pgsDepth: 0.5,
  });
  assert.equal(calls.includes('/api/providers/models'), false);
});

test('client streaming capability matches an operation-backed Query catalog', async () => {
  const catalog = await buildQueryCatalog({
    agent: 'jerry',
    operationAdapter: {},
    fetchImpl: makeFetch({
      '/api/status': { success: true, apiReachable: true, running: false, activeRun: false },
      '/api/providers/models': {
        models: [{ id: 'gpt-5.5', provider: 'openai', kind: 'chat' }],
      },
      '/api/brains': {
        brains: [{ id: 'brain-jerry', routeKey: 'brain-jerry', sourceLabel: 'Jerry' }],
      },
    }),
  });
  const capabilities = buildClientCapabilities();
  assert.equal(catalog.streaming, true);
  assert.equal(capabilities.features.queryStreaming, catalog.streaming);
  assert.equal(capabilities.query.streaming, catalog.streaming);
});

test('query catalog resolves the resident agent brain without waiting for the global COSMO brain scan', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-query-resident-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const brainPath = path.join(root, 'instances', 'jerry', 'brain');
  fs.mkdirSync(brainPath, { recursive: true });
  fs.writeFileSync(path.join(root, 'instances', 'jerry', 'config.yaml'), 'agent:\n  displayName: Jerry\n');

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(new URL(url).pathname);
    return makeFetch({
      '/api/status': { success: true, apiReachable: true, running: false, activeRun: false },
      '/api/providers/models': {
        models: [{ id: 'gpt-5.5', label: 'GPT-5.5', provider: 'openai-codex', kind: 'chat' }],
      },
    })(url, init);
  };

  const catalog = await buildQueryCatalog({
    home23Root: root,
    agent: 'jerry',
    cosmoBaseUrl: 'http://cosmo.test',
    fetchImpl,
    modelAuthorityProvider: () => ({
      models: [{
        id: 'gpt-5.5', model: 'gpt-5.5', provider: 'openai-codex', kind: 'chat',
      }],
      queryDefaults: {
        defaultProvider: 'openai-codex', defaultModel: 'gpt-5.5',
        pgsSweepProvider: 'openai-codex', pgsSweepModel: 'gpt-5.5',
        pgsSynthProvider: 'openai-codex', pgsSynthModel: 'gpt-5.5',
      },
    }),
  });

  const canonicalRoot = fs.realpathSync(brainPath);
  const canonicalId = `brain-${crypto.createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 16)}`;
  const routeKey = crypto.createHash('sha1').update(path.resolve(brainPath)).digest('hex').slice(0, 16);
  assert.equal(catalog.available, true);
  assert.equal(catalog.reason, null);
  assert.equal(catalog.selectedBrain.id, canonicalId);
  assert.equal(catalog.selectedBrain.routeKey, routeKey);
  assert.equal(catalog.selectedBrain.sourceLabel, 'jerry');
  assert.deepEqual(catalog.brains, [catalog.selectedBrain]);
  assert.equal(calls.includes('/api/brains'), false);
  assert.equal(calls.includes('/api/providers/models'), false);
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
    priorContext: { query: 'p'.repeat(10001), answer: 'a'.repeat(10000) },
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

test('compatibility facade accepts only the four durable query modes before operation creation', async () => {
  for (const mode of ['quick', 'full', 'expert', 'dive']) {
    const forwarded = [];
    const fixture = makeQueryApp({ onForward: (request) => forwarded.push(request) });
    const response = await postJson(fixture.app, '/home23/api/query/run', {
      query: 'x',
      mode,
      modelSelection: { provider: 'openai', model: 'gpt-5.5' },
      enablePGS: false,
    });
    assert.equal(response.status, 200, mode);
    assert.equal(forwarded.length, 1, mode);
    assert.equal(forwarded[0].parameters.mode, mode);
  }

  for (const mode of [
    'fast', 'normal', 'deep', 'executive', 'raw', 'report',
    'innovation', 'consulting', 'grounded',
  ]) {
    const fixture = makeQueryApp();
    const response = await postJson(fixture.app, '/home23/api/query/run', {
      query: 'x',
      mode,
      modelSelection: { provider: 'openai', model: 'gpt-5.5' },
      enablePGS: false,
    });
    assert.equal(response.status, 400, mode);
    assert.equal(response.body.error.code, 'invalid_request', mode);
    assert.equal(fixture.calls.length, 0, mode);
  }
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
    pgsMode: 'fresh',
    pgsLevel: 'sample',
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    pgsSynth: { provider: 'anthropic', model: 'claude-sonnet-4-7' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(progress, [0, 121_000]);
  assert.equal(response.body.answer, 'ok');
});

test('compatibility PGS rejects the unrelated direct-query mode before durable start', async () => {
  const fixture = makeQueryApp();
  const response = await postJson(fixture.app, '/home23/api/query/run', {
    query: 'x',
    mode: 'quick',
    enablePGS: true,
    pgsMode: 'fresh',
    pgsLevel: 'sample',
    ...PGS_PAIRS,
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'invalid_request');
  assert.equal(fixture.calls.length, 0);
});

test('compatibility PGS accepts every named level in fresh, continue, and targeted modes and derives its fraction', async () => {
  const levels = new Map([
    ['skim', 0.1],
    ['sample', 0.25],
    ['deep', 0.5],
    ['full', 1],
  ]);
  const modes = [
    ['fresh', {}],
    ['continue', { continueFromOperationId: CONTINUE_OPERATION_ID }],
    ['targeted', { targetPartitionIds: ['c-one', 'c-two'] }],
  ];

  for (const [pgsMode, modeFields] of modes) {
    for (const [pgsLevel, sweepFraction] of levels) {
      const forwarded = [];
      const fixture = makeQueryApp({
        adapter: {
          start: async (request) => {
            forwarded.push(request);
            return {
              ...canonicalCompatRecord({ state: 'queued', eventSequence: 0 }),
              operationType: 'pgs',
            };
          },
          attachAndWait: async () => ({
            ...canonicalCompatRecord({ state: 'complete', eventSequence: 3, result: null }),
            operationType: 'pgs',
          }),
        },
      });
      const response = await postJson(fixture.app, '/home23/api/query/run', {
        query: 'x',
        enablePGS: true,
        pgsMode,
        pgsLevel,
        ...modeFields,
        ...PGS_PAIRS,
      });

      assert.equal(response.status, 200, `${pgsMode}/${pgsLevel}: ${JSON.stringify(response.body)}`);
      assert.equal(forwarded.length, 1, `${pgsMode}/${pgsLevel}`);
      assert.deepEqual(forwarded[0].parameters, {
        query: 'x',
        pgsMode,
        pgsLevel,
        pgsConfig: { sweepFraction },
        ...modeFields,
        ...PGS_PAIRS,
      });
    }
  }
});

test('compatibility PGS enforces exact mode-dependent continuation and target fields', async () => {
  const validTargetedContinuation = {
    query: 'x',
    enablePGS: true,
    pgsMode: 'targeted',
    pgsLevel: 'sample',
    continueFromOperationId: CONTINUE_OPERATION_ID,
    targetPartitionIds: ['c-one'],
    ...PGS_PAIRS,
  };
  const validFixture = makeQueryApp({ adapter: {
    start: async () => ({
      ...canonicalCompatRecord({ state: 'queued', eventSequence: 0 }),
      operationType: 'pgs',
    }),
    attachAndWait: async () => ({
      ...canonicalCompatRecord({ state: 'complete', eventSequence: 3, result: null }),
      operationType: 'pgs',
    }),
  } });
  assert.equal((await postJson(
    validFixture.app,
    '/home23/api/query/run',
    validTargetedContinuation,
  )).status, 200);

  const base = {
    query: 'x', enablePGS: true, pgsMode: 'fresh', pgsLevel: 'sample', ...PGS_PAIRS,
  };
  const invalidBodies = [
    { ...base, pgsMode: undefined },
    { ...base, pgsLevel: undefined },
    { ...base, pgsMode: 'full' },
    { ...base, pgsLevel: 'quarter' },
    { ...base, pgsSweep: undefined },
    { ...base, pgsSynth: undefined },
    { ...base, pgsConfig: { sweepFraction: 0.25 } },
    { ...base, continueFromOperationId: CONTINUE_OPERATION_ID },
    { ...base, targetPartitionIds: ['c-one'] },
    { ...base, pgsMode: 'continue' },
    { ...base, pgsMode: 'continue', continueFromOperationId: 'brop_short' },
    {
      ...base,
      pgsMode: 'continue',
      continueFromOperationId: CONTINUE_OPERATION_ID,
      targetPartitionIds: ['c-one'],
    },
    { ...base, pgsMode: 'targeted' },
    { ...base, pgsMode: 'targeted', targetPartitionIds: [] },
    { ...base, pgsMode: 'targeted', targetPartitionIds: ['one'] },
    { ...base, pgsMode: 'targeted', targetPartitionIds: ['c-one', 'c-one'] },
    {
      ...base,
      pgsMode: 'targeted',
      targetPartitionIds: Array.from({ length: 257 }, (_, index) => `c-${index}`),
    },
  ];
  for (const body of invalidBodies) {
    const fixture = makeQueryApp();
    const response = await postJson(fixture.app, '/home23/api/query/run', body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.body.error.code, 'invalid_request', JSON.stringify(body));
    assert.equal(fixture.calls.length, 0, JSON.stringify(body));
  }
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
    pgsMode: 'fresh',
    pgsLevel: 'full',
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
      options.onEvent(canonicalCompatRecord({
        state: 'running', eventSequence: 1,
        stage: 'work_selected', message: 'Selecting bounded PGS work',
        batchIndex: 2, selectedWorkUnits: 16, selectedWorkUnitsTotal: 48,
        candidateWorkUnits: 64, pendingWorkUnits: 80,
      }));
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
  assert.deepEqual({
    stage: rows[0].stage,
    message: rows[0].message,
    batchIndex: rows[0].batchIndex,
    selectedWorkUnits: rows[0].selectedWorkUnits,
    selectedWorkUnitsTotal: rows[0].selectedWorkUnitsTotal,
    candidateWorkUnits: rows[0].candidateWorkUnits,
    pendingWorkUnits: rows[0].pendingWorkUnits,
  }, {
    stage: 'work_selected',
    message: 'Selecting bounded PGS work',
    batchIndex: 2,
    selectedWorkUnits: 16,
    selectedWorkUnitsTotal: 48,
    candidateWorkUnits: 64,
    pendingWorkUnits: 80,
  });
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
    { query: 'x', pgsMode: 'continue', enablePGS: true },
    { query: 'x', pgsMode: 'targeted', enablePGS: true },
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

test('Query PGS partition preflight returns canonical IDs through a durable graph operation', async () => {
  const operationId = `brop_${'p'.repeat(32)}`;
  let startedRequest = null;
  const app = express();
  app.use('/home23/api/query', createQueryApiRouter({
    getDefaultAgent: () => 'jerry',
    resolveAgent: () => 'jerry',
    catalogProvider: async () => compatCatalog(),
    operationAdapter: {
      start: async (request) => {
        startedRequest = request;
        return { operationId, operationType: 'graph', state: 'queued' };
      },
      attachAndWait: async () => ({ operationId, operationType: 'graph', state: 'complete' }),
      getResult: async () => ({
        operationId,
        operationType: 'graph',
        state: 'complete',
        error: null,
        resultHandle: null,
        resultArtifact: null,
        sourceEvidence: { sourceHealth: 'healthy' },
        result: {
          complete: true,
          totalNodes: 42,
          totalPartitions: 1,
          estimatedWorkUnits: 1,
          partitions: [{ partitionId: 'c-alpha', nodeCount: 42, estimatedWorkUnits: 1 }],
        },
      }),
      detach: async () => {},
      exportStored: async () => {},
    },
  }));
  const response = await postJson(app, '/home23/api/query/pgs-partitions', {
    agent: 'jerry', brainId: 'brain-jerry',
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.partitions[0].partitionId, 'c-alpha');
  assert.equal(startedRequest.operationType, 'graph');
  assert.deepEqual(startedRequest.parameters, { view: 'pgs_partitions' });
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

test('compatibility export failures retain typed error and durable operation authority', async () => {
  const validate = compileQueryDefinition('queryExportResponse');
  const resultHandle = `brres_${'u'.repeat(32)}`;
  const resultArtifact = {
    mediaType: 'application/json', contentEncoding: 'identity', bytes: 42, sha256: 'b'.repeat(64),
  };
  const sourceEvidence = { sourceHealth: 'degraded', matchOutcome: 'unknown' };
  for (const row of [
    {
      state: 'failed', code: 'provider_export_failed',
      message: 'provider stopped after the durable export started', retryable: true,
    },
    {
      state: 'complete', code: 'export_receipt_invalid',
      message: 'export receipt failed validation', retryable: false,
    },
    {
      state: 'partial', code: 'export_receipt_invalid',
      message: 'partial export receipt failed validation', retryable: false,
    },
  ]) {
    const fixture = makeQueryApp({ adapter: {
      exportStored: async () => {
        const error = Object.assign(new Error(row.message), {
          code: row.code,
          retryable: row.retryable,
          operation: {
            operationId: COMPAT_OPERATION_ID,
            state: row.state,
            attachmentState: 'closed',
            resultHandle,
            resultArtifact,
            sourceEvidence,
          },
        });
        throw error;
      },
    } });
    const response = await postJson(fixture.app, '/home23/api/query/export', {
      query: 'x', answer: 'not canonical evidence', format: 'markdown',
    });
    assert.equal(response.status, row.retryable ? 503 : 500);
    assert.equal(response.body.success, false);
    assert.equal(response.body.operationId, COMPAT_OPERATION_ID);
    assert.equal(response.body.state, row.state);
    assert.equal(response.body.attachmentState, 'closed');
    assert.equal(response.body.detached, false);
    assert.equal(response.body.resultHandle, resultHandle);
    assert.deepEqual(response.body.resultArtifact, resultArtifact);
    assert.deepEqual(response.body.sourceEvidence, sourceEvidence);
    assert.deepEqual(response.body.error, {
      code: row.code, message: row.message, retryable: row.retryable,
    });
    assert.equal(validate(response.body), true, JSON.stringify(validate.errors));
  }
});

test('query request schema enforces direct requests and every named PGS mode/level contract', () => {
  const validate = compileQueryDefinition('queryRequest');
  assert.equal(validate({
    query: 'x',
    enablePGS: false,
    modelSelection: { provider: 'openai', model: 'gpt-5.5' },
  }), true, JSON.stringify(validate.errors));
  for (const mode of ['quick', 'full', 'expert', 'dive']) {
    assert.equal(validate({ query: 'x', enablePGS: false, mode }), true, mode);
  }
  for (const mode of [
    'fast', 'normal', 'deep', 'executive', 'raw', 'report',
    'innovation', 'consulting', 'grounded',
  ]) {
    assert.equal(validate({ query: 'x', enablePGS: false, mode }), false, mode);
  }
  for (const pgsLevel of ['skim', 'sample', 'deep', 'full']) {
    for (const [pgsMode, modeFields] of [
      ['fresh', {}],
      ['continue', { continueFromOperationId: CONTINUE_OPERATION_ID }],
      ['targeted', { targetPartitionIds: ['c-one'] }],
      ['targeted', {
        continueFromOperationId: CONTINUE_OPERATION_ID,
        targetPartitionIds: ['c-one', 'c-two'],
      }],
    ]) {
      const request = {
        query: 'x', enablePGS: true, pgsMode, pgsLevel, ...modeFields, ...PGS_PAIRS,
      };
      assert.equal(validate(request), true, `${JSON.stringify(request)} ${JSON.stringify(validate.errors)}`);
    }
  }
  for (const invalid of [
    { query: 'x', enablePGS: false, model: 'gpt-5.5', provider: 'openai' },
    { query: 'x', enablePGS: false, modelSelection: null },
    { query: 'x', enablePGS: false, modelSelection: { provider: 'openai' } },
    { query: 'x', enablePGS: true, pgsMode: 'fresh', pgsLevel: 'skim', ...PGS_PAIRS, pgsSweepModel: 'MiniMax-M3' },
    { query: 'x', enablePGS: true, pgsMode: 'fresh', pgsLevel: 'skim', pgsSynth: PGS_PAIRS.pgsSynth },
    { query: 'x', enablePGS: true, pgsMode: 'fresh', pgsLevel: 'skim', pgsSweep: PGS_PAIRS.pgsSweep },
    { query: 'x', enablePGS: true, pgsLevel: 'skim', ...PGS_PAIRS },
    { query: 'x', enablePGS: true, pgsMode: 'fresh', ...PGS_PAIRS },
    { query: 'x', enablePGS: true, pgsMode: 'continue', pgsLevel: 'sample', ...PGS_PAIRS },
    { query: 'x', enablePGS: true, pgsMode: 'targeted', pgsLevel: 'sample', ...PGS_PAIRS },
    { query: 'x', enablePGS: true, pgsMode: 'fresh', pgsLevel: 'sample', continueFromOperationId: CONTINUE_OPERATION_ID, ...PGS_PAIRS },
    { query: 'x', enablePGS: true, pgsMode: 'continue', pgsLevel: 'sample', continueFromOperationId: CONTINUE_OPERATION_ID, targetPartitionIds: ['c-one'], ...PGS_PAIRS },
    { query: 'x', enablePGS: true, pgsMode: 'targeted', pgsLevel: 'sample', targetPartitionIds: [], ...PGS_PAIRS },
    { query: 'x', enablePGS: true, pgsMode: 'targeted', pgsLevel: 'sample', targetPartitionIds: ['one'], ...PGS_PAIRS },
    { query: 'x', enablePGS: true, pgsMode: 'targeted', pgsLevel: 'sample', targetPartitionIds: ['c-one', 'c-one'], ...PGS_PAIRS },
    { query: 'x', enablePGS: true, pgsMode: 'fresh', pgsLevel: 'quarter', ...PGS_PAIRS },
    { query: 'x', enablePGS: true, pgsMode: 'fresh', pgsLevel: 'sample', pgsSweep: { provider: 'minimax', model: 'MiniMax-M3', extra: 1 }, pgsSynth: PGS_PAIRS.pgsSynth },
    { query: 'x', enablePGS: true, pgsMode: 'fresh', pgsLevel: 'sample', pgsConfig: { sweepFraction: 0.25 }, ...PGS_PAIRS },
    { query: 'x', enablePGS: true, pgsMode: 'fresh', pgsLevel: 'sample', priorContext: { query: 'before', answer: 'after' }, ...PGS_PAIRS },
    { query: 'x', enablePGS: true, pgsMode: 'fresh', pgsLevel: 'sample', mode: 'quick', ...PGS_PAIRS },
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
