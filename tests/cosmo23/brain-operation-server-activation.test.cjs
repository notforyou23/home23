'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const priorCapability = process.env.HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY;
delete process.env.HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY;
const {
  initializeProtectedBrainOperations,
} = require('../../cosmo23/server');
if (priorCapability === undefined) {
  delete process.env.HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY;
} else {
  process.env.HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY = priorCapability;
}

function fakeWorker() {
  return {
    async start() {},
    async status() {},
    async *events() {},
    async result() {},
    async cancel() {},
    async stop() {},
  };
}

test('COSMO leaves protected routes disabled when no generated capability is present', () => {
  const mounted = [];
  const result = initializeProtectedBrainOperations({
    capabilityKey: '',
    targetApp: { use(router) { mounted.push(router); } },
  });
  assert.equal(result, null);
  assert.equal(mounted.length, 0);
});

test('COSMO composes and mounts the exact protected query runtime before broad middleware', () => {
  const mounted = [];
  const calls = {};
  const catalog = { providers: { alpha: { models: [{
    id: 'model', kind: 'chat', transport: 'responses',
    maxOutputTokens: 128, providerStallMs: 30_000,
  }] } } };
  const providerClient = {
    providerId: 'alpha',
    async generate(request) {
      calls.probeRequest = request;
      return {
        provider: 'alpha', model: 'model', content: 'OK',
        terminalReceived: true, finishReason: 'completed', hadError: false,
      };
    },
  };
  const providerRegistry = {
    identity: 'exact-registry',
    getExact(provider, model) {
      assert.equal(provider, 'alpha');
      assert.equal(model, 'model');
      return providerClient;
    },
  };
  const queryEngine = { identity: 'operation-query-engine' };
  const worker = fakeWorker();
  const runtime = { worker };
  const researchRunAdapter = {
    async createOwnedRun() {},
    async start() {},
    async continue() {},
    async stopAndWait() {},
    async watch() {},
    async resolveOwnedRun() {},
  };
  const researchOperationTypes = [
    'research_compile', 'research_continue', 'research_intelligence',
    'research_launch', 'research_stop', 'research_watch',
  ];
  const result = initializeProtectedBrainOperations({
    capabilityKey: 'a'.repeat(64),
    targetApp: { use(router) { mounted.push(router); } },
    home23Root: '/tmp/home23',
    modelCatalog: catalog,
    providerRuntimeFactory(options) {
      calls.provider = options;
      return { providerRegistry };
    },
    queryEngineFactory(options) {
      calls.query = options;
      return queryEngine;
    },
    runtimeFactory(options) {
      calls.runtime = options;
      return runtime;
    },
    buildCatalog: async () => ({ catalogRevision: 'c', brains: [] }),
    canonicalTargetResolver() {},
    configuredAgents: {
      'agents.research-synthesis': { provider: 'alpha', model: 'model' },
    },
    queryDefaultsProvider: () => ({
      defaultProvider: 'alpha', defaultModel: 'model',
      pgsSweepProvider: 'alpha', pgsSweepModel: 'model',
      pgsSynthProvider: 'alpha', pgsSynthModel: 'model',
    }),
    researchRunAdapterFactory(options) {
      calls.researchRun = options;
      return researchRunAdapter;
    },
    researchCompileAdapterFactory(options) {
      calls.researchCompile = options;
      return async () => {};
    },
    researchExecutorsFactory(options) {
      calls.researchExecutors = options;
      return new Map(researchOperationTypes.map((type) => [type, async () => {}]));
    },
  });

  assert.equal(result.worker, runtime.worker);
  assert.equal(typeof result.probeConfiguredProviderPair, 'function');
  assert.equal(mounted.length, 1);
  assert.equal(calls.provider.catalog, catalog);
  assert.equal(calls.query.providerRegistry, providerRegistry);
  assert.equal(calls.query.modelCatalog, catalog);
  assert.equal(calls.query.operationMode, true);
  assert.equal(calls.runtime.providerRegistry, providerRegistry);
  assert.equal(calls.runtime.queryEngine, queryEngine);
  assert.equal(calls.runtime.modelCatalog, catalog);
  assert.deepEqual([...calls.runtime.extraExecutors.keys()].sort(), researchOperationTypes);
  assert.equal(calls.runtime.resolveOwnedRun, researchRunAdapter.resolveOwnedRun);
  assert.equal(typeof calls.runtime.buildOwnedRunTarget, 'function');
  assert.equal(calls.researchRun.home23Root, '/tmp/home23');
  assert.equal(calls.researchExecutors.processManager, researchRunAdapter);
  assert.equal(calls.researchExecutors.resolveOwnedRun, researchRunAdapter.resolveOwnedRun);
  assert.equal(typeof calls.researchExecutors.readPinnedIntelligence, 'function');
  assert.equal(typeof calls.researchExecutors.createRequesterOutputWriter, 'function');
  assert.equal(typeof calls.researchExecutors.compileSectionWithProvider, 'function');
});

test('protected provider probe uses the same exact production registry and persisted pair', async () => {
  const mounted = [];
  const requestLog = [];
  const catalog = { providers: { alpha: { models: [{
    id: 'model', kind: 'chat', transport: 'responses',
    maxOutputTokens: 128, providerStallMs: 30_000,
  }] } } };
  const providerRegistry = {
    getExact() {
      return {
        providerId: 'alpha',
        async generate(request) {
          requestLog.push(request);
          return {
            provider: 'alpha', model: 'model', content: 'OK',
            terminalReceived: true, finishReason: 'completed', hadError: false,
          };
        },
      };
    },
  };
  const researchRunAdapter = {
    async resolveOwnedRun() {},
  };
  const result = initializeProtectedBrainOperations({
    capabilityKey: 'b'.repeat(64),
    targetApp: { use(router) { mounted.push(router); } },
    home23Root: '/tmp/home23', modelCatalog: catalog,
    providerRuntimeFactory: () => ({ providerRegistry }),
    queryEngineFactory: () => ({}),
    runtimeFactory: () => ({ worker: fakeWorker() }),
    buildCatalog: async () => ({ catalogRevision: 'c', brains: [] }),
    canonicalTargetResolver() {},
    configuredAgents: {
      'agents.research-synthesis': { provider: 'alpha', model: 'model' },
    },
    queryDefaultsProvider: () => ({
      defaultProvider: 'alpha', defaultModel: 'model',
      pgsSweepProvider: 'alpha', pgsSweepModel: 'model',
      pgsSynthProvider: 'alpha', pgsSynthModel: 'model',
    }),
    researchRunAdapterFactory: () => researchRunAdapter,
    researchCompileAdapterFactory: () => async () => {},
    researchExecutorsFactory: () => new Map(),
  });
  const probed = await result.probeConfiguredProviderPair({ purpose: 'direct-query' });
  assert.equal(probed.healthy, true);
  assert.deepEqual(probed.requestedPair, { provider: 'alpha', model: 'model' });
  assert.deepEqual(probed.observedPair, { provider: 'alpha', model: 'model' });
  assert.equal(requestLog.length, 1);
  assert.equal(requestLog[0].signal instanceof AbortSignal, true);
});
