'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createBrainOperationTargetResolver,
  createCosmoBrainOperationRuntime,
  createSharedWorkerSourcePins,
} = require('../../cosmo23/server/lib/brain-operation-runtime');

const root = '/tmp/home23-runtime-fixture';
const boundaries = (canonicalRoot) => [
  'brain', 'run', 'pgs', 'session', 'cache', 'export', 'agency',
].map((kind) => ({ kind, path: canonicalRoot }));

test('shared worker source pins derive one provider only from the verified requester', async () => {
  const calls = [];
  const sourcePins = createSharedWorkerSourcePins({
    home23Root: root,
    providerFactory(options) {
      calls.push(options);
      return { async openPinnedSource(descriptor, expectations) { return { descriptor, expectations }; } };
    },
  });
  await sourcePins.openPinnedSource({ version: 1 }, { requesterAgent: 'jerry' });
  await sourcePins.openPinnedSource({ version: 1 }, { requesterAgent: 'forrest' });
  assert.deepEqual(calls, [
    { home23Root: root, requesterAgent: 'jerry' },
    { home23Root: root, requesterAgent: 'forrest' },
  ]);
  await assert.rejects(
    async () => sourcePins.openPinnedSource({}, { requesterAgent: '../escape' }),
    { code: 'invalid_request' },
  );
});

test('target resolver rebuilds exact brain, requester, and owned-run authority', async () => {
  const canonicalRoot = path.join(root, 'instances', 'jerry', 'brain');
  const entry = {
    id: 'brain-jerry', canonicalRoot, ownerAgent: 'jerry', displayName: 'Jerry',
    kind: 'resident', lifecycle: 'resident', route: '/api/brain/brain-jerry',
    mutationBoundaries: boundaries(canonicalRoot),
  };
  const resolver = createBrainOperationTargetResolver({
    buildCatalog: async () => ({ catalogRevision: 'catalog-1', brains: [entry] }),
    resolveCanonicalTarget: () => entry,
    resolveOwnedRun: async ({ runId, requesterAgent }) => ({ runId, ownerAgent: requesterAgent }),
    buildOwnedRunTarget: (run) => ({
      domain: 'owned-run', runId: run.runId, ownerAgent: run.ownerAgent,
    }),
  });
  const brain = await resolver({
    requesterAgent: 'jerry', target: { domain: 'brain', brainId: 'brain-jerry' },
  });
  assert.equal(brain.accessMode, 'own');
  assert.equal(brain.catalogRevision, 'catalog-1');
  assert.notEqual(brain.mutationBoundaries, entry.mutationBoundaries);
  assert.deepEqual(await resolver({
    requesterAgent: 'jerry', target: { domain: 'requester', requesterAgent: 'jerry' },
  }), { domain: 'requester', requesterAgent: 'jerry' });
  assert.deepEqual(await resolver({
    requesterAgent: 'jerry', target: { domain: 'owned-run', runId: 'run-1' },
  }), { domain: 'owned-run', runId: 'run-1', ownerAgent: 'jerry' });
});

test('COSMO operation runtime registers query and PGS exactly once with extra executors', (t) => {
  const home23Root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-cosmo-operation-runtime-'));
  t.after(() => fs.rmSync(home23Root, { recursive: true, force: true }));
  const catalog = { providers: { alpha: { models: [] } } };
  const queryEngine = { async executeEnhancedQuery() { return {}; } };
  const providerRegistry = {};
  const runtime = createCosmoBrainOperationRuntime({
    home23Root,
    capabilityKey: 'a'.repeat(64),
    buildCatalog: async () => ({ catalogRevision: 'c', brains: [] }),
    resolveCanonicalTarget() {},
    modelCatalog: catalog,
    providerRegistry,
    queryEngine,
    sourcePins: { async openPinnedSource() {} },
    extraExecutors: new Map([['research_watch', async () => ({})]]),
  });
  assert.deepEqual([...runtime.executors.keys()], ['query', 'pgs', 'research_watch']);
  assert.equal(queryEngine.modelCatalog, catalog);
  assert.equal(queryEngine.providerRegistry, providerRegistry);
  assert.throws(() => createCosmoBrainOperationRuntime({
    home23Root,
    capabilityKey: 'a'.repeat(64),
    buildCatalog: async () => ({}),
    resolveCanonicalTarget() {},
    modelCatalog: catalog,
    providerRegistry: {},
    queryEngine,
    sourcePins: { async openPinnedSource() {} },
    extraExecutors: new Map([['query', async () => ({})]]),
  }), { code: 'executor_conflict' });
});
