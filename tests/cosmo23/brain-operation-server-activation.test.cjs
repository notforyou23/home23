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
  const catalog = { providers: { alpha: { models: [] } } };
  const providerRegistry = { identity: 'exact-registry' };
  const queryEngine = { identity: 'operation-query-engine' };
  const worker = fakeWorker();
  const runtime = { worker };
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
  });

  assert.equal(result, runtime);
  assert.equal(mounted.length, 1);
  assert.equal(calls.provider.catalog, catalog);
  assert.equal(calls.query.providerRegistry, providerRegistry);
  assert.equal(calls.query.modelCatalog, catalog);
  assert.equal(calls.query.operationMode, true);
  assert.equal(calls.runtime.providerRegistry, providerRegistry);
  assert.equal(calls.runtime.queryEngine, queryEngine);
  assert.equal(calls.runtime.modelCatalog, catalog);
  assert.deepEqual([...calls.runtime.extraExecutors], []);
});
