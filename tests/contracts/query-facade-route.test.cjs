const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Ajv2020 = require('ajv/dist/2020');
const fs = require('fs');
const path = require('path');
const {
  buildQueryCatalog,
  createQueryApiRouter,
} = require('../../engine/src/dashboard/home23-query-api.js');

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
            path: '/Users/jtr/_JTR23_/release/home23/instances/jerry/brain',
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

test('query export facade proxies through selected agent brain route', async () => {
  const captured = {};
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
      '/api/brain/brain-jerry/export-query': ({ init }) => {
        captured.body = JSON.parse(init.body);
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

  assert.equal(res.status, 200);
  assert.equal(res.body.exportedTo, '/fake/exports/query.md');
  assert.equal(captured.body.query, 'what changed');
  assert.equal(captured.body.answer, 'facade export');
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
    model: 'gpt-5.5',
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

test('query run facade proxies non-dry request through selected brain route and validates response contract', async () => {
  const captured = {};
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
        captured.body = JSON.parse(init.body);
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

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.result.answer, 'facade query answer');
  assert.equal(captured.body.query, 'what changed');
  assert.equal(captured.body.enablePGS, true);
  assert.equal(captured.body.pgsConfig.sweepFraction, 0.25);
  assert.equal(captured.body.priorContext.answer, 'previous answer');

  const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'contracts/schemas/query.schema.json'), 'utf8'));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile({ ...schema, $ref: '#/$defs/queryRunResponse' });
  assert.equal(validate(res.body), true, ajv.errorsText(validate.errors));
});

test('query run facade maps upstream query errors into the query response contract', async () => {
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
        status: 503,
        body: { error: 'cosmo query unavailable' },
      },
    }),
  }));

  const res = await postJson(app, '/home23/api/query/run?agent=jerry', {
    query: 'will fail',
    model: 'gpt-5.5',
    mode: 'quick',
    enablePGS: false,
  });

  assert.equal(res.status, 503);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, 'cosmo query unavailable');

  const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'contracts/schemas/query.schema.json'), 'utf8'));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile({ ...schema, $ref: '#/$defs/queryRunResponse' });
  assert.equal(validate(res.body), true, ajv.errorsText(validate.errors));
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
