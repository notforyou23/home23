'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildLegacyQueryResponse,
  createLegacyQueryOperationAdapter,
  normalizeLegacyQueryRequest,
} = require('../../cosmo23/server/lib/legacy-query-operation-adapter');

const OPERATION_ID = `brop_${'A'.repeat(32)}`;

test('legacy COSMO query routes cannot reach the path-owned QueryEngine', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../cosmo23/server/index.js'), 'utf8');
  const start = source.indexOf("app.post('/api/brain/:name/query'");
  const end = source.indexOf("app.get('/api/brain/:name/suggestions'", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const routes = source.slice(start, end);
  assert.match(routes, /legacyQueryOperationAdapter\.execute/);
  assert.doesNotMatch(routes, /getQueryEngine|executeEnhancedQuery|globalThis\.fetch|\bfetch\s*\(/);
});

test('remaining live COSMO QueryEngine callers are non-provider utilities only', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../cosmo23/server/index.js'), 'utf8');
  assert.doesNotMatch(source, /\.execute(?:Enhanced)?Query\s*\(/);
  assert.doesNotMatch(source, /\.generateExecutiveView\s*\(/);
  assert.match(source, /\.getQuerySuggestions\s*\(/);
  assert.match(source, /\.loadBrainState\s*\(/);
  assert.match(source, /\.exportResult\s*\(/);
});

function catalog(shared = false) {
  const model = id => ({
    id, kind: 'chat', transport: 'responses',
    maxOutputTokens: 128, providerStallMs: 30_000,
  });
  return {
    version: 1,
    providers: {
      alpha: { models: [model('answer-model')] },
      ...(shared ? { beta: { models: [model('answer-model')] } } : {}),
    },
  };
}

function response(body, status = 200, contentType = 'application/json') {
  return new Response(
    contentType === 'application/json' ? JSON.stringify(body) : body,
    { status, headers: { 'content-type': contentType } },
  );
}

test('legacy request normalization resolves only a unique model provider and strips legacy shortcuts', () => {
  assert.deepEqual(normalizeLegacyQueryRequest({
    query: 'canary', model: 'answer-model', mode: 'normal',
    includeEvidenceMetrics: true, includeOutputs: true,
  }, { catalog: catalog() }), {
    operationType: 'query',
    parameters: {
      query: 'canary', mode: 'full',
      modelSelection: { provider: 'alpha', model: 'answer-model' },
      includeOutputs: true,
    },
  });
  assert.throws(
    () => normalizeLegacyQueryRequest({ query: 'x', model: 'answer-model' }, {
      catalog: catalog(true),
    }),
    error => error.code === 'model_ambiguous',
  );
  assert.throws(
    () => normalizeLegacyQueryRequest({
      query: 'x', enablePGS: true, pgsSweepModel: 'answer-model',
    }, { catalog: catalog() }),
    error => error.code === 'invalid_request',
  );
});

test('route response construction copies a frozen durable result before adding legacy fields', () => {
  const durable = Object.freeze({ answer: 'durable', operationId: OPERATION_ID });
  const artifactInventory = Object.freeze({ fingerprint: 'inventory-1' });
  const responseBody = buildLegacyQueryResponse(durable, {
    query: 'canary', artifactInventory,
  });
  assert.notEqual(responseBody, durable);
  assert.equal(Object.isFrozen(responseBody), false);
  assert.equal(responseBody.query, 'canary');
  assert.equal(responseBody.artifactInventory, artifactInventory);
});

test('legacy adapter starts, attaches, and validates one durable canonical result', async t => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/home23/api/brain-operations')) {
      return response({
        operationId: OPERATION_ID, operationType: 'query', state: 'running',
        requesterAgent: 'jerry', eventSequence: 0,
        target: { domain: 'brain', brainId: 'brain-jerry' },
        parameters: { modelSelection: { provider: 'alpha', model: 'answer-model' } },
      }, 202);
    }
    if (url.includes('/events?')) {
      return response(
        `data: ${JSON.stringify({
          type: 'terminal', operationId: OPERATION_ID, eventSequence: 1,
          state: 'complete', phase: 'terminal',
        })}\n\n`,
        200,
        'text/event-stream',
      );
    }
    if (url.endsWith(`/${OPERATION_ID}/result`)) {
      return response({
        operationId: OPERATION_ID,
        state: 'complete',
        result: { answer: 'durable answer', metadata: { provider: 'alpha', model: 'answer-model' } },
        error: null,
        resultHandle: null,
        resultArtifact: null,
        sourceEvidence: { sourceHealth: 'healthy' },
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const adapter = createLegacyQueryOperationAdapter({
    dashboardOrigin: 'http://127.0.0.1:5002',
    fetchImpl,
    catalogProvider: () => catalog(),
    requesterAgent: 'jerry',
    randomUUID: () => '00000000-0000-4000-8000-000000000000',
  });
  const events = [];
  const result = await adapter.execute({
    brainId: 'brain-jerry',
    body: { query: 'canary', model: 'answer-model' },
    signal: new AbortController().signal,
    onEvent: event => events.push(event),
  });
  assert.equal(result.answer, 'durable answer');
  assert.equal(result.operationId, OPERATION_ID);
  assert.equal(result.state, 'complete');
  assert.equal(events.length, 1);
  const start = JSON.parse(calls[0].options.body);
  assert.deepEqual(start, {
    requestId: 'legacy-query-00000000-0000-4000-8000-000000000000',
    operationType: 'query',
    target: { brainId: 'brain-jerry' },
    parameters: {
      query: 'canary', mode: 'full',
      modelSelection: { provider: 'alpha', model: 'answer-model' },
    },
  });
  assert.equal(calls.every(call => call.options.signal instanceof AbortSignal), true);
});

test('legacy adapter preserves caller cancellation identity and detaches the durable attachment', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('caller left'), { code: 'caller_disconnected' });
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/home23/api/brain-operations')) {
      return response({
        operationId: OPERATION_ID, operationType: 'query', state: 'running',
        requesterAgent: 'jerry', eventSequence: 0,
        target: { domain: 'brain', brainId: 'brain-jerry' },
        parameters: { modelSelection: { provider: 'alpha', model: 'answer-model' } },
      }, 202);
    }
    if (url.includes('/events?')) {
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    }
    if (url.endsWith(`/${OPERATION_ID}/detach`)) return response({ ok: true });
    throw new Error(`unexpected URL ${url}`);
  };
  const adapter = createLegacyQueryOperationAdapter({
    dashboardOrigin: 'http://127.0.0.1:5002', fetchImpl,
    catalogProvider: () => catalog(),
    requesterAgent: 'jerry',
    randomUUID: () => '00000000-0000-4000-8000-000000000000',
  });
  const pending = adapter.execute({
    brainId: 'brain-jerry', body: { query: 'canary' }, signal: controller.signal,
  });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(calls.some(call => call.url.endsWith(`/${OPERATION_ID}/detach`)), true);
});

test('caller cancellation is not held open by an unreachable detach endpoint', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('caller left'), { code: 'caller_disconnected' });
  let detachAborted = false;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/home23/api/brain-operations')) {
      return response({
        operationId: OPERATION_ID, operationType: 'query', state: 'running',
        requesterAgent: 'jerry',
        target: { domain: 'brain', brainId: 'brain-jerry' },
        parameters: { modelSelection: { provider: 'alpha', model: 'answer-model' } },
      }, 202);
    }
    if (url.includes('/events?')) {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    }
    if (url.endsWith(`/${OPERATION_ID}/detach`)) {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          detachAborted = true;
          reject(options.signal.reason);
        }, { once: true });
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const adapter = createLegacyQueryOperationAdapter({
    dashboardOrigin: 'http://127.0.0.1:5002', fetchImpl,
    catalogProvider: () => catalog(), requesterAgent: 'jerry', detachTimeoutMs: 10,
  });
  const pending = adapter.execute({
    brainId: 'brain-jerry', body: { query: 'canary' }, signal: controller.signal,
  });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(detachAborted, true);
});

test('legacy adapter rejects a mismatched or nonterminal result envelope', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/home23/api/brain-operations')) {
      return response({
        operationId: OPERATION_ID, operationType: 'query', state: 'running',
        requesterAgent: 'jerry',
        target: { domain: 'brain', brainId: 'brain-jerry' },
        parameters: { modelSelection: { provider: 'alpha', model: 'answer-model' } },
      }, 202);
    }
    if (url.includes('/events?')) return response('', 200, 'text/event-stream');
    return response({
      operationId: `brop_${'B'.repeat(32)}`, state: 'running', result: null, error: null,
    });
  };
  const adapter = createLegacyQueryOperationAdapter({
    dashboardOrigin: 'http://127.0.0.1:5002', fetchImpl,
    catalogProvider: () => catalog(),
    requesterAgent: 'jerry',
  });
  await assert.rejects(
    adapter.execute({ brainId: 'brain-jerry', body: { query: 'x' } }),
    error => error.code === 'operation_contract_invalid',
  );
});

test('legacy adapter bounds detach cleanup and preserves the original cancellation', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('caller left'), { code: 'caller_disconnected' });
  let detachSignal = null;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/home23/api/brain-operations')) {
      return response({
        operationId: OPERATION_ID, operationType: 'query', state: 'running',
        requesterAgent: 'jerry',
        target: { domain: 'brain', brainId: 'brain-jerry' },
        parameters: { modelSelection: { provider: 'alpha', model: 'answer-model' } },
      }, 202);
    }
    if (url.includes('/events?')) {
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    }
    if (url.endsWith(`/${OPERATION_ID}/detach`)) {
      detachSignal = options.signal;
      return new Promise(() => {});
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const adapter = createLegacyQueryOperationAdapter({
    dashboardOrigin: 'http://127.0.0.1:5002', fetchImpl,
    catalogProvider: () => catalog(), requesterAgent: 'jerry',
    cleanupTimeoutMs: 10,
    randomUUID: () => '00000000-0000-4000-8000-000000000000',
  });
  const pending = adapter.execute({
    brainId: 'brain-jerry', body: { query: 'canary' }, signal: controller.signal,
  });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(detachSignal.aborted, true);
});

test('legacy adapter exposes useful PGS partial output with a typed nonretryable synthesis error', async () => {
  const pgsCatalog = {
    providers: {
      sweep: { models: [{ id: 'sweep-model', kind: 'chat' }] },
      synth: { models: [{ id: 'synth-model', kind: 'chat' }] },
    },
  };
  const fetchImpl = async (url) => {
    if (url.endsWith('/home23/api/brain-operations')) {
      return response({
        operationId: OPERATION_ID, operationType: 'pgs', state: 'running',
        requesterAgent: 'jerry',
        target: { domain: 'brain', brainId: 'brain-jerry' },
        parameters: {
          pgsSweep: { provider: 'sweep', model: 'sweep-model' },
          pgsSynth: { provider: 'synth', model: 'synth-model' },
        },
      }, 202);
    }
    if (url.includes('/events?')) return response('', 200, 'text/event-stream');
    return response({
      operationId: OPERATION_ID,
      state: 'partial',
      result: {
        answer: null,
        sweepOutputs: [{
          workUnitId: 'p-a-u0000', partitionId: 'a',
          provider: 'sweep', model: 'sweep-model', output: 'useful evidence',
        }],
      },
      error: {
        code: 'provider_model_mismatch', message: 'synthesis identity changed', retryable: false,
      },
      resultArtifact: null,
      resultHandle: null,
      sourceEvidence: { sourceHealth: 'healthy' },
    });
  };
  const adapter = createLegacyQueryOperationAdapter({
    dashboardOrigin: 'http://127.0.0.1:5002', fetchImpl,
    catalogProvider: () => pgsCatalog, requesterAgent: 'jerry',
  });
  const result = await adapter.execute({
    brainId: 'brain-jerry', body: { query: 'canary', enablePGS: true },
  });
  assert.equal(result.state, 'partial');
  assert.equal(result.sweepOutputs.length, 1);
  assert.deepEqual(result.error, {
    code: 'provider_model_mismatch', message: 'synthesis identity changed', retryable: false,
  });
});

test('legacy adapter rejects a start response bound to another requester or target', async () => {
  for (const mismatch of [
    { requesterAgent: 'forrest', target: { domain: 'brain', brainId: 'brain-jerry' } },
    { requesterAgent: 'jerry', target: { domain: 'brain', brainId: 'brain-forrest' } },
  ]) {
    const fetchImpl = async (url) => {
      if (url.endsWith('/home23/api/brain-operations')) {
        return response({
          operationId: OPERATION_ID, operationType: 'query', state: 'running',
          ...mismatch,
          parameters: { modelSelection: { provider: 'alpha', model: 'answer-model' } },
        }, 202);
      }
      throw new Error(`unexpected URL ${url}`);
    };
    const adapter = createLegacyQueryOperationAdapter({
      dashboardOrigin: 'http://127.0.0.1:5002', fetchImpl,
      catalogProvider: () => catalog(), requesterAgent: 'jerry',
    });
    await assert.rejects(
      adapter.execute({ brainId: 'brain-jerry', body: { query: 'canary' } }),
      error => error.code === 'operation_contract_invalid',
    );
  }
});
