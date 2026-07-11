'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { QueryEngine } = require('../../cosmo23/lib/query-engine');

function model(provider, id) {
  return {
    id,
    kind: 'chat',
    maxOutputTokens: 256,
    providerStallMs: 900_000,
    transport: 'responses',
  };
}

function catalog(shared = false) {
  return {
    version: 1,
    providers: {
      alpha: { models: [model('alpha', 'answer-model')] },
      ...(shared ? { beta: { models: [model('beta', 'answer-model')] } } : {}),
    },
    defaults: {},
  };
}

function sourcePin() {
  let released = 0;
  const materializerError = new Error('full materializer forbidden');
  return {
    revision: 11,
    descriptor: { cutoffRevision: 11 },
    async *iterateNodes({ signal } = {}) {
      if (signal?.aborted) throw signal.reason;
      yield { id: 'n1', content: 'alpha canary evidence', salience: 1 };
      yield { id: 'n2', content: 'supporting evidence', salience: 0.5 };
    },
    async *iterateEdges({ signal } = {}) {
      if (signal?.aborted) throw signal.reason;
      yield { source: 'n1', target: 'n2', type: 'supports' };
    },
    async summarize() { return { nodeCount: 2, edgeCount: 1, clusterCount: 0 }; },
    getEvidence(extra) {
      return { sourceHealth: 'healthy', deltaWatermark: { revision: 11 }, ...extra };
    },
    async release() { released += 1; },
    releaseCount() { return released; },
    loadAll() { throw materializerError; },
    loadState() { throw materializerError; },
    readGraph() { throw materializerError; },
    createPinnedQueryState() { throw materializerError; },
  };
}

function complete(content = 'pinned answer') {
  return {
    content,
    terminalReceived: true,
    finishReason: 'completed',
    hadError: false,
    provider: 'alpha',
    model: 'answer-model',
  };
}

function fixture(overrides = {}) {
  const calls = [];
  const events = [];
  const client = overrides.client || {
    providerId: 'alpha',
    async generate(options) {
      calls.push(options);
      options.onProviderActivity({
        type: 'response.output_text.delta',
        at: '2025-01-01T00:00:00.000Z',
        provider: 'wrong',
        providerCallId: 'wrong',
      });
      return complete();
    },
  };
  const registry = overrides.registry || {
    get(provider, selectedModel) {
      assert.equal(provider, 'alpha');
      assert.equal(selectedModel, 'answer-model');
      return client;
    },
  };
  const engine = new QueryEngine({
    operationMode: true,
    providerRegistry: registry,
    modelCatalog: overrides.catalog || catalog(),
    onEvent: event => events.push(event),
  });
  return { engine, calls, events, client };
}

function operationOptions(pin, extra = {}) {
  return {
    sourcePin: pin,
    modelSelection: { provider: 'alpha', model: 'answer-model' },
    signal: new AbortController().signal,
    ...extra,
  };
}

test('operation query uses only the pinned iterator and exact provider pair', async () => {
  const pin = sourcePin();
  const { engine, calls, events } = fixture();
  const options = operationOptions(pin);

  const result = await engine.executeQuery('alpha canary', options);

  assert.equal(result.answer, 'pinned answer');
  assert.equal(result.metadata.provider, 'alpha');
  assert.equal(result.metadata.model, 'answer-model');
  assert.equal(result.sourceEvidence.deltaWatermark.revision, 11);
  assert.equal(result.resultArtifact, null);
  assert.equal(pin.releaseCount(), 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].maxOutputTokens, 256);
  assert.equal(calls[0].provider, 'alpha');
  assert.equal(calls[0].model, 'answer-model');
  assert.equal(calls[0].signal, options.signal);
  assert.deepEqual(events, [
    {
      type: 'provider_selected', phase: 'query', provider: 'alpha',
      model: 'answer-model', providerStallMs: 900000, providerCallId: 'query',
    },
    {
      type: 'provider_activity', phase: 'query', provider: 'alpha',
      model: 'answer-model', providerCallId: 'query',
      providerEventType: 'response.output_text.delta',
      providerEventAt: '2025-01-01T00:00:00.000Z',
    },
    {
      type: 'provider_call_terminal', phase: 'query', provider: 'alpha',
      model: 'answer-model', providerCallId: 'query', outcome: 'complete',
    },
  ]);
});

test('operation-mode construction and enhanced query never touch a target path', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-query-operation-'));
  const forbidden = path.join(root, 'target-must-not-exist');
  const { engine } = fixture();
  const constructed = new QueryEngine(forbidden, null, {
    operationMode: true,
    providerRegistry: engine.providerRegistry,
    modelCatalog: engine.modelCatalog,
  });

  const result = await constructed.executeEnhancedQuery(
    'alpha canary', operationOptions(sourcePin()),
  );

  assert.equal(result.answer, 'pinned answer');
  await assert.rejects(fs.lstat(forbidden), error => error.code === 'ENOENT');
  await fs.rm(root, { recursive: true, force: true });
});

test('ambiguous or unavailable exact pairs fail before provider work', async () => {
  const pin = sourcePin();
  const ambiguous = fixture({ catalog: catalog(true) });
  await assert.rejects(
    ambiguous.engine.executeQuery('x', {
      sourcePin: pin,
      modelSelection: { provider: '', model: 'answer-model' },
      signal: new AbortController().signal,
    }),
    error => error.code === 'model_ambiguous',
  );
  assert.equal(ambiguous.calls.length, 0);

  const unavailable = fixture({
    registry: {
      get() {
        throw Object.assign(new Error('not configured'), {
          code: 'provider_unavailable', retryable: true,
        });
      },
    },
  });
  await assert.rejects(
    unavailable.engine.executeQuery('x', operationOptions(pin)),
    error => error.code === 'provider_unavailable' && error.retryable === true,
  );
  assert.equal(unavailable.calls.length, 0);
});

test('prompt and provider result byte limits fail at the correct boundary', async () => {
  const pin = sourcePin();
  const prompt = fixture();
  await assert.rejects(
    prompt.engine.executeQuery('alpha canary', operationOptions(pin, {
      limits: { maxPromptBytes: 32 },
    })),
    error => error.code === 'result_too_large',
  );
  assert.equal(prompt.calls.length, 0);

  const result = fixture({
    client: {
      providerId: 'alpha',
      async generate(options) {
        result.calls.push(options);
        return complete('x'.repeat(2048));
      },
    },
  });
  await assert.rejects(
    result.engine.executeQuery('alpha canary', operationOptions(pin, {
      limits: { maxResultBytes: 1024 },
    })),
    error => error.code === 'result_too_large',
  );
  assert.equal(result.calls.length, 1);
  assert.equal(result.events.at(-1).outcome, 'failed');
});

test('provider cancellation preserves the exact operation reason and terminal event', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('operator cancelled'), { code: 'cancelled' });
  const pin = sourcePin();
  const pendingProvider = {
    providerId: 'alpha',
    generate({ signal }) {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };
  const item = fixture({ client: pendingProvider });
  const pending = item.engine.executeQuery('alpha canary', {
    ...operationOptions(pin),
    signal: controller.signal,
  });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(reason);

  await assert.rejects(pending, error => error === reason);
  assert.equal(item.events.at(-1).outcome, 'cancelled');
  assert.equal(pin.releaseCount(), 0);
});

test('incomplete provider output is never promoted to success', async () => {
  const item = fixture({
    client: {
      providerId: 'alpha',
      async generate() {
        return {
          content: 'partial', terminalReceived: false, finishReason: null,
          hadError: false, provider: 'alpha', model: 'answer-model',
        };
      },
    },
  });
  await assert.rejects(
    item.engine.executeQuery('alpha canary', operationOptions(sourcePin())),
    error => error.code === 'provider_incomplete',
  );
  assert.equal(item.events.at(-1).outcome, 'failed');
});
