'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { QueryEngine } = require('../../cosmo23/lib/query-engine');
const {
  createSyntheticPinnedSource,
} = require('./helpers/brain-operation-fixtures.cjs');

function model(provider, id, overrides = {}) {
  return {
    id,
    kind: 'chat',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 256,
    contextWindowTokens: 128_000,
    providerStallMs: 900_000,
    transport: 'responses',
    ...overrides,
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
    mode: 'full',
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
  assert.equal(calls[0].reasoningEffort, 'high');
  assert.equal(calls[0].verbosity, 'high');
  assert.match(calls[0].instructions, /findings/i);
  assert.match(calls[0].instructions, /projection limit/i);
  assert.equal(calls[0].maxOutputBytes, 8 * 1024 * 1024);
  assert.equal(calls[0].provider, 'alpha');
  assert.equal(calls[0].model, 'answer-model');
  assert.equal(calls[0].signal, options.signal);
  assert.deepEqual(events, [
    {
      type: 'progress', phase: 'query', stage: 'projection_complete',
      selectedNodes: 2, selectedEdges: 1,
    },
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

test('operation query sends the exact selected mode policy to the provider', async () => {
  const highCeilingCatalog = {
    version: 1,
    providers: {
      alpha: {
        models: [model('alpha', 'answer-model', {
          contextWindowTokens: 256_000,
          maxOutputTokens: 50_000,
        })],
      },
    },
    defaults: {},
  };
  const { engine, calls } = fixture({ catalog: highCeilingCatalog });
  const expected = [
    ['quick', 'low', 'low', 2_500, /strongest matching evidence/i],
    ['full', 'high', 'high', 25_000, /findings.*evidence.*implications.*gaps/is],
    ['expert', 'high', 'high', 30_000, /contradictions.*confidence.*unresolved questions/is],
    ['dive', 'high', 'high', 32_000, /themes.*non-obvious connections.*convergence/is],
  ];

  for (const [mode] of expected) {
    await engine.executeQuery('alpha canary', operationOptions(sourcePin(), { mode }));
  }

  assert.equal(calls.length, expected.length);
  expected.forEach(([mode, reasoningEffort, verbosity, maxOutputTokens, instruction], index) => {
    assert.equal(calls[index].reasoningEffort, reasoningEffort, mode);
    assert.equal(calls[index].verbosity, verbosity, mode);
    assert.equal(calls[index].maxOutputTokens, maxOutputTokens, mode);
    assert.match(calls[index].instructions, instruction, mode);
  });
});

test('operation query never forwards vector payloads and leaves pinned evidence untouched', async () => {
  const node = {
    id: 'n1',
    content: 'alpha vector sanitization canary',
    salience: 1,
    embedding: Buffer.from([1, 2, 3, 4]),
    vector: [0.3, 0.4],
    metadata: {
      source: 'jerry',
      embeddings: Object.assign(new Array(3), { 2: 0.6 }),
      nested: { vectors: [[0.7, 0.8]], evidence: 'preserved' },
    },
  };
  const edge = {
    source: 'n1', target: 'n1', type: 'supports', evidence: 'preserved edge',
    embedding: [0.9], vector: [1],
  };
  const before = JSON.stringify({ node, edge });
  const pin = {
    revision: 12,
    descriptor: { cutoffRevision: 12 },
    async *iterateNodes() { yield node; },
    async *iterateEdges() { yield edge; },
    async summarize() { return { nodeCount: 1, edgeCount: 1, clusterCount: 0 }; },
    getEvidence(extra) {
      return { sourceHealth: 'healthy', deltaWatermark: { revision: 12 }, ...extra };
    },
  };
  const { engine, calls } = fixture();

  await engine.executeQuery('alpha sanitization', operationOptions(pin));

  assert.equal(calls.length, 1);
  const providerInput = JSON.parse(calls[0].input);
  function assertNoVectorFields(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(['embedding', 'embeddings', 'vector', 'vectors'].includes(key), false);
      assertNoVectorFields(child);
    }
  }
  assertNoVectorFields(providerInput.source.nodes);
  assertNoVectorFields(providerInput.source.edges);
  assert.equal(providerInput.source.nodes[0].provenance, 'jerry');
  assert.equal(Object.hasOwn(providerInput.source.nodes[0], 'metadata'), false);
  assert.equal(providerInput.source.edges[0].evidence, 'preserved edge');
  assert.equal(JSON.stringify({ node, edge }), before);
});

test('Jerry-shaped projection is trimmed to the prompt budget and reaches the provider', async () => {
  const pin = createSyntheticPinnedSource({
    nodeCount: 2_000,
    edgeCount: 4_000,
    nodeFactory: index => ({
      id: `n${index}`,
      content: `jerry canary ${index} ${'x'.repeat(8 * 1024)}`,
      salience: (index % 100) / 100,
    }),
  });
  const { engine, calls } = fixture();

  const result = await engine.executeQuery('jerry canary', operationOptions(pin));

  assert.equal(calls.length, 1);
  assert.equal(result.answer, 'pinned answer');
  assert.equal(result.metadata.promptBytes <= 8 * 1024 * 1024, true);
  assert.equal(result.metadata.projection.nodesRetained > 0, true);
  assert.equal(result.metadata.projection.nodesRetained < 2_000, true);
  assert.equal(result.metadata.projection.retainedBytes < 8 * 1024 * 1024, true);
  assert.equal(pin.stats().recordsConsumed, 6_000);
});

test('gpt-5.5 large-brain projection stays below its conservative model context budget', async () => {
  const contextWindowTokens = 272_000;
  const maxOutputTokens = 32_768;
  const expectedPromptByteLimit = Math.floor(contextWindowTokens * 0.95)
    - 25_000
    - 8_192;
  const captured = [];
  const pin = createSyntheticPinnedSource({
    nodeCount: 2_000,
    edgeCount: 4_000,
    nodeFactory: index => ({
      id: `n${index}`,
      content: `jerry canary ${index} ${'x'.repeat(8 * 1024)}`,
      salience: (index % 100) / 100,
    }),
  });
  const constrainedCatalog = {
    version: 1,
    providers: {
      alpha: {
        models: [model('alpha', 'answer-model', {
          contextWindowTokens,
          maxOutputTokens,
        })],
      },
    },
    defaults: {},
  };
  const client = {
    providerId: 'alpha',
    async generate(options) {
      captured.push(options);
      const providerInputBytes = Buffer.byteLength(options.instructions, 'utf8')
        + Buffer.byteLength(options.input, 'utf8');
      if (providerInputBytes > expectedPromptByteLimit) {
        throw Object.assign(
          new Error('Your input exceeds the context window of this model.'),
          { code: 'provider_failed', retryable: false },
        );
      }
      return complete();
    },
  };
  const { engine } = fixture({ catalog: constrainedCatalog, client });

  const result = await engine.executeQuery('jerry canary', operationOptions(pin));

  assert.equal(result.answer, 'pinned answer');
  assert.equal(captured.length, 1);
  assert.equal(result.metadata.promptBudgetBytes, expectedPromptByteLimit);
  assert.equal(result.metadata.inputBudgetTokens, expectedPromptByteLimit);
  assert.equal(result.metadata.promptBytes <= expectedPromptByteLimit, true);
  assert.equal(result.metadata.projection.nodesRetained > 0, true);
  assert.equal(result.metadata.projection.nodesRetained < 2_000, true);
  assert.equal(pin.stats().recordsConsumed, 6_000);
});

test('OpenAI Direct Query fits compact evidence to the measured o200k prompt budget', async () => {
  const provider = 'openai-codex';
  const selectedModel = 'gpt-5.5';
  const calls = [];
  const source = createSyntheticPinnedSource({
    nodeCount: 2_000,
    edgeCount: 0,
    nodeFactory: index => ({
      id: `openai-${index}`,
      type: ['finding', 'decision', 'observation', 'question'][index % 4],
      tags: [`lane-${index % 8}`],
      content: `openai projection canary ${index} ${'evidence '.repeat(500)}`,
      salience: (index % 100) / 100,
      metadata: { providerPayload: 'z'.repeat(32 * 1024) },
    }),
  });
  const selectedCatalog = {
    version: 1,
    providers: {
      [provider]: {
        models: [model(provider, selectedModel, {
          contextWindowTokens: 128_000,
          maxOutputTokens: 32_768,
          transport: 'codex-responses',
        })],
      },
    },
    defaults: {},
  };
  const engine = new QueryEngine({
    operationMode: true,
    modelCatalog: selectedCatalog,
    providerRegistry: {
      get(requestedProvider, requestedModel) {
        assert.equal(requestedProvider, provider);
        assert.equal(requestedModel, selectedModel);
        return {
          providerId: provider,
          async generate(options) {
            calls.push(options);
            return {
              content: 'bounded OpenAI answer',
              terminalReceived: true,
              finishReason: 'completed',
              hadError: false,
              provider,
              model: selectedModel,
            };
          },
        };
      },
    },
  });

  const result = await engine.executeQuery('openai projection canary', {
    sourcePin: source,
    modelSelection: { provider, model: selectedModel },
    mode: 'full',
    signal: new AbortController().signal,
  });

  assert.equal(calls.length, 1);
  assert.equal(result.metadata.promptBudgetStrategy, 'o200k_base');
  assert.equal(result.metadata.promptTokens <= result.metadata.inputBudgetTokens, true);
  assert.equal(result.metadata.projection.nodesRetained >= 64, true);
  assert.equal(result.metadata.projection.promptReduced, true);
  assert.equal(result.metadata.projection.droppedForPromptBudget > 0, true);
  assert.equal(result.metadata.promptBytes <= 8 * 1024 * 1024, true);
});

test('model budget counts Unicode and escaped JSON scaffold overhead before provider work', async () => {
  const constrainedCatalog = {
    version: 1,
    providers: {
      alpha: {
        models: [model('alpha', 'answer-model', {
          contextWindowTokens: 128_000,
          maxOutputTokens: 32_768,
        })],
      },
    },
    defaults: {},
  };
  const item = fixture({ catalog: constrainedCatalog });
  const hugeUnicodeQuery = '🧠"\\\n'.repeat(40_000);

  await assert.rejects(
    item.engine.executeQuery(hugeUnicodeQuery, operationOptions(sourcePin())),
    error => error.code === 'result_too_large',
  );
  assert.equal(item.calls.length, 0);
  assert.deepEqual(item.events, []);
});

test('operation query reports provider lifecycle through the canonical reportEvent seam', async () => {
  const { engine, events: fallbackEvents } = fixture();
  const operationEvents = [];
  await engine.executeQuery('alpha canary', operationOptions(sourcePin(), {
    reportEvent: event => operationEvents.push(event),
  }));
  assert.deepEqual(operationEvents.map(event => event.type), [
    'progress', 'provider_selected', 'provider_activity', 'provider_call_terminal',
  ]);
  assert.deepEqual(fallbackEvents, []);
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
        const content = 'x'.repeat(2048);
        if (Buffer.byteLength(content, 'utf8') > options.maxOutputBytes) {
          throw Object.assign(new Error('provider output exceeded its byte budget'), {
            code: 'result_too_large', retryable: false,
          });
        }
        return complete(content);
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
  assert.equal(result.calls[0].maxOutputBytes, 1024);
  assert.equal(result.events.at(-1).outcome, 'failed');
});

test('generic exact completion lowers a trusted byte ceiling and rejects caller raises before provider work', async () => {
  let content = 'x'.repeat(16);
  let calls = 0;
  const item = fixture({
    client: {
      providerId: 'alpha',
      async generate(options) {
        calls += 1;
        assert.equal(options.maxOutputBytes, 16);
        if (Buffer.byteLength(content, 'utf8') > options.maxOutputBytes) {
          throw Object.assign(new Error('bounded provider adapter rejected output'), {
            code: 'result_too_large', retryable: false,
          });
        }
        return complete(content);
      },
    },
  });

  const exact = await item.engine._generateExactCompletion({
    provider: 'alpha', model: 'answer-model', maxOutputBytes: 16,
  });
  assert.equal(exact.content, 'x'.repeat(16));
  content += 'x';
  await assert.rejects(
    item.engine._generateExactCompletion({
      provider: 'alpha', model: 'answer-model', maxOutputBytes: 16,
    }),
    { code: 'result_too_large', retryable: false },
  );
  assert.equal(calls, 2);

  await assert.rejects(
    item.engine._generateExactCompletion({
      provider: 'alpha', model: 'answer-model', maxOutputBytes: (8 * 1024 * 1024) + 1,
    }),
    { code: 'invalid_request' },
  );
  assert.equal(calls, 2);
});

test('operation query bounds prompt construction before serializing a huge projection', async () => {
  const item = fixture();
  item.engine.projectPinnedQuery = async () => ({
    sourceRevision: 11,
    summary: { nodeCount: 1, edgeCount: 0, clusterCount: 0 },
    nodes: [{ id: 'huge', content: 'x'.repeat(32 * 1024 * 1024) }],
    edges: [],
    stats: { selectedNodes: 1, selectedEdges: 0 },
    sourceEvidence: { sourceHealth: 'healthy' },
  });
  const maximum = 64 * 1024;
  await assert.rejects(
    item.engine.executeQuery('bounded prompt', operationOptions(sourcePin(), {
      limits: { maxPromptBytes: maximum },
    })),
    error => error.code === 'result_too_large'
      && error.bytesExamined <= maximum + (16 * 1024),
  );
  assert.equal(item.calls.length, 0);
  assert.deepEqual(item.events, []);
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

test('operation query requires exact client and completion provider identities', async () => {
  for (const [name, client, expectedCalls] of [
    ['missing client provider', { async generate() { throw new Error('unreachable'); } }, 0],
    ['mismatched client provider', {
      providerId: 'beta', async generate() { throw new Error('unreachable'); },
    }, 0],
    ['missing completion provider', {
      providerId: 'alpha', async generate() { return { ...complete(), provider: null }; },
    }, 1],
    ['mismatched completion provider', {
      providerId: 'alpha', async generate() { return { ...complete(), provider: 'beta' }; },
    }, 1],
    ['mismatched completion model', {
      providerId: 'alpha', async generate() { return { ...complete(), model: 'other-model' }; },
    }, 1],
  ]) {
    let calls = 0;
    const counted = {
      ...client,
      async generate(options) {
        calls += 1;
        return client.generate(options);
      },
    };
    const item = fixture({ client: counted });
    await assert.rejects(
      item.engine.executeQuery('identity canary', operationOptions(sourcePin())),
      error => error.code === 'provider_model_mismatch',
      name,
    );
    assert.equal(calls, expectedCalls, name);
  }
});

test('operation PGS selection delegates only to the pinned package path', async () => {
  const forwarded = [];
  const engine = new QueryEngine({
    operationMode: true,
    providerRegistry: { get() { throw new Error('query registry path must not run'); } },
    modelCatalog: catalog(),
    pgsEngineFactory(dependencies) {
      assert.ok(dependencies.providerRegistry);
      assert.ok(dependencies.modelCatalog);
      return {
        async runPinnedOperation(options) {
          forwarded.push(options);
          return {
            state: 'complete',
            result: { answer: 'pgs answer', sweepOutputs: [], metadata: { pgs: {} } },
            error: null,
            resultArtifact: null,
          };
        },
      };
    },
  });
  const pin = sourcePin();
  const signal = new AbortController().signal;
  const reportEvent = () => {};
  const sessionStorage = { databasePath: '/trusted/session.sqlite' };
  const result = await engine.executeEnhancedQuery('pgs query', {
    operationType: 'pgs',
    enablePGS: true,
    sourcePin: pin,
    scratchDir: '/trusted/scratch',
    scratchQuota: { operationRoot: '/trusted' },
    pgsSweep: { provider: 'alpha', model: 'answer-model' },
    pgsSynth: { provider: 'alpha', model: 'answer-model' },
    pgsConfig: { sweepFraction: 0.5 },
    pgsMode: 'continue',
    pgsLevel: 'deep',
    targetPartitionIds: ['c-alpha'],
    sessionStorage,
    reportEvent,
    signal,
  });

  assert.equal(result.result.answer, 'pgs answer');
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].sourcePin, pin);
  assert.equal(forwarded[0].signal, signal);
  assert.equal(forwarded[0].reportEvent, reportEvent);
  assert.deepEqual(forwarded[0].pgsConfig, { sweepFraction: 0.5 });
  assert.equal(forwarded[0].pgsMode, 'continue');
  assert.equal(forwarded[0].pgsLevel, 'deep');
  assert.deepEqual(forwarded[0].targetPartitionIds, ['c-alpha']);
  assert.equal(forwarded[0].sessionStorage, sessionStorage);
  assert.equal(pin.releaseCount(), 0);
});
