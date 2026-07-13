'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { PGSEngine } = require('../../cosmo23/pgs-engine/src');
const { openPinnedPGSStore } = require('../../cosmo23/pgs-engine/src/pinned-store');
const { createOperationScratchQuota } = require('../../shared/memory-source/scratch-quota.cjs');

function catalog() {
  const row = id => ({
    id, kind: 'chat', maxOutputTokens: 512, providerStallMs: 900_000,
    contextWindowTokens: 128_000, transport: 'responses',
  });
  return {
    version: 1,
    providers: {
      sweep: { models: [row('shared-model')] },
      synth: { models: [row('shared-model')] },
    },
    defaults: {},
  };
}

function codexBudgetCatalog({
  sweepContextWindowTokens = 272_000,
  synthContextWindowTokens = 272_000,
  maxOutputTokens = 32_768,
} = {}) {
  const row = (id, contextWindowTokens) => ({
    id,
    kind: 'chat',
    maxOutputTokens,
    contextWindowTokens,
    providerStallMs: 900_000,
    transport: 'codex-responses',
  });
  return {
    version: 1,
    providers: {
      'openai-codex': {
        models: [
          row('gpt-5.4-mini', sweepContextWindowTokens),
          row('gpt-5.5', synthContextWindowTokens),
        ],
      },
    },
    defaults: {},
  };
}

function makeCodexBudgetEngine(catalogOptions = {}) {
  const calls = [];
  const client = {
    providerId: 'openai-codex',
    async generate(request) {
      calls.push(request);
      if (calls.length > (catalogOptions.maximumCalls || Number.POSITIVE_INFINITY)) {
        throw Object.assign(new Error('synthesis call ceiling exceeded'), {
          code: 'provider_failed', retryable: false,
        });
      }
      const configuredSynthesisOutput = typeof catalogOptions.synthesisOutput === 'function'
        ? catalogOptions.synthesisOutput(request)
        : 'bounded synthesis';
      return {
        content: request.model === 'gpt-5.4-mini' ? 'bounded sweep' : configuredSynthesisOutput,
        terminalReceived: true,
        finishReason: 'completed',
        hadError: false,
        provider: 'openai-codex',
        model: request.model,
      };
    },
  };
  const engine = new PGSEngine({
    modelCatalog: codexBudgetCatalog(catalogOptions),
    providerRegistry: {
      get(provider, model) {
        assert.equal(provider, 'openai-codex');
        assert.equal(['gpt-5.4-mini', 'gpt-5.5'].includes(model), true);
        return client;
      },
    },
  });
  return { engine, calls };
}

function codexBudgetOptions(pin, scratch, overrides = {}) {
  return {
    sourcePin: pin,
    scratchDir: scratch.scratchDir,
    scratchQuota: scratch.quota,
    query: 'What does the pinned evidence show?',
    pgsSweep: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
    pgsSynth: { provider: 'openai-codex', model: 'gpt-5.5' },
    signal: new AbortController().signal,
    pgsConfig: { sweepFraction: 1 },
    limits: {
      ...limits,
      maxScratchBytes: 64 * 1024 * 1024,
      maxContextCharsPerWorkUnit: 128_000,
      maxSweepOutputBytes: 256 * 1024,
      maxTotalSweepOutputBytes: 16 * 1024 * 1024,
      maxSynthesisInputBytes: 16 * 1024 * 1024,
      maxSynthesisOutputBytes: 2 * 1024 * 1024,
      maxResultBytes: 24 * 1024 * 1024,
    },
    ...overrides,
  };
}

function sourcePin({ nodeCount = 12 } = {}) {
  let releases = 0;
  const edgeCount = Math.max(0, nodeCount - 1);
  const nodes = Array.from({ length: nodeCount }, (_, index) => ({
    id: `n${index}`,
    clusterId: `cluster-${index % 2}`,
    content: `pinned evidence ${index}`,
  }));
  return {
    revision: 5,
    descriptor: {
      version: 1,
      canonicalRoot: '/synthetic/brain',
      generation: 'g5',
      baseRevision: 5,
      cutoffRevision: 5,
      summary: { nodeCount: nodes.length, edgeCount, clusterCount: nodeCount ? 2 : 0 },
      activeBase: {
        nodes: { file: 'nodes.gz', count: nodes.length, bytes: 1 },
        edges: { file: 'edges.gz', count: edgeCount, bytes: 1 },
      },
      activeDelta: {
        epoch: 'e1', file: 'delta', fromRevision: 6, toRevision: 5,
        count: 0, committedBytes: 0,
      },
    },
    async *iterateNodes({ signal } = {}) {
      for (const node of nodes) {
        if (signal?.aborted) throw signal.reason;
        yield node;
      }
    },
    async *iterateEdges({ signal } = {}) {
      for (let index = 0; index < edgeCount; index += 1) {
        if (signal?.aborted) throw signal.reason;
        yield { source: `n${index}`, target: `n${index + 1}`, type: 'next' };
      }
    },
    getEvidence(extra) {
      const returnedTotals = extra.returnedTotals || { nodes: 0, edges: 0 };
      const completeCoverage = extra.completeCoverage === true;
      return {
        sourceHealth: 'healthy',
        deltaWatermark: { revision: 5 },
        authoritativeTotals: { nodes: nodes.length, edges: edgeCount },
        returnedTotals,
        completeCoverage,
        filteredTotal: extra.filteredTotal || 0,
        matchOutcome: returnedTotals.nodes > 0
          ? 'matches'
          : completeCoverage && nodes.length === 0 ? 'corpus_empty'
            : completeCoverage ? 'no_match' : 'unknown',
        ...extra,
      };
    },
    async release() { releases += 1; },
    releaseCount() { return releases; },
    loadAll() { throw new Error('materializer forbidden'); },
    loadState() { throw new Error('materializer forbidden'); },
  };
}

async function scratchFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-pgs-operation-'));
  const operationRoot = path.join(root, 'instances', 'jerry', 'runtime', 'brain-operations', 'op-pgs');
  const scratchDir = path.join(operationRoot, 'scratch');
  await fs.mkdir(scratchDir, { recursive: true });
  const quota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 64 * 1024 * 1024,
  });
  t.after(async () => {
    quota.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, operationRoot, scratchDir, quota };
}

const limits = {
  maxScratchBytes: 64 * 1024 * 1024,
  minFreeScratchBytes: 1,
  maxTransactionRecords: 10,
  maxTransactionBytes: 1024 * 1024,
  maxNodesPerWorkUnit: 2,
  maxContextCharsPerWorkUnit: 4096,
  maxSelectedWorkUnits: 16,
  maxSweepOutputBytes: 16 * 1024,
  maxTotalSweepOutputBytes: 128 * 1024,
  maxSynthesisInputBytes: 256 * 1024,
  maxSynthesisOutputBytes: 64 * 1024,
  maxResultBytes: 512 * 1024,
};

function makeEngine({
  pending = false,
  sweepOutput = null,
  synthesisOutput = null,
  enforceOutputBytes = false,
} = {}) {
  const events = [];
  const calls = [];
  const sweepClient = {
    providerId: 'sweep',
    async generate(options) {
      calls.push({ phase: 'sweep', options });
      options.onProviderActivity({ type: 'response.output_text.delta', at: '2000-01-01T00:00:00Z' });
      const content = sweepOutput
        ?? `finding for ${JSON.parse(JSON.stringify(options.input)).slice(0, 24)}`;
      if (enforceOutputBytes && Buffer.byteLength(content, 'utf8') > options.maxOutputBytes) {
        throw Object.assign(new Error('bounded sweep adapter rejected output'), {
          code: 'result_too_large', retryable: false,
        });
      }
      return {
        content,
        terminalReceived: true,
        finishReason: 'completed',
        hadError: false,
        provider: 'sweep',
        model: 'shared-model',
      };
    },
  };
  const synthClient = {
    providerId: 'synth',
    async generate(options) {
      calls.push({ phase: 'synth', options });
      const content = synthesisOutput ?? 'final pinned synthesis';
      if (enforceOutputBytes && Buffer.byteLength(content, 'utf8') > options.maxOutputBytes) {
        throw Object.assign(new Error('bounded synthesis adapter rejected output'), {
          code: 'result_too_large', retryable: false,
        });
      }
      return {
        content,
        terminalReceived: true,
        finishReason: 'completed',
        hadError: false,
        provider: 'synth',
        model: 'shared-model',
      };
    },
  };
  const engine = new PGSEngine({
    modelCatalog: catalog(),
    providerRegistry: {
      get(provider) { return provider === 'sweep' ? sweepClient : synthClient; },
    },
  });
  return { engine, events, calls, pending };
}

function options(pin, scratch, extra = {}) {
  return {
    sourcePin: pin,
    scratchDir: scratch.scratchDir,
    scratchQuota: scratch.quota,
    query: 'What does the pinned evidence show?',
    pgsSweep: { provider: 'sweep', model: 'shared-model' },
    pgsSynth: { provider: 'synth', model: 'shared-model' },
    signal: new AbortController().signal,
    reportEvent: extra.reportEvent,
    pgsConfig: extra.pgsConfig || { sweepFraction: 1 },
    ...(extra.pgsMode ? { pgsMode: extra.pgsMode } : {}),
    ...(extra.pgsLevel ? { pgsLevel: extra.pgsLevel } : {}),
    ...(extra.targetPartitionIds ? { targetPartitionIds: extra.targetPartitionIds } : {}),
    limits,
  };
}

function singleWorkStore() {
  let committed = false;
  const summary = attemptId => ({
    attemptId, scopeWorkUnits: 1, scopeSuccessfulWorkUnits: committed ? 1 : 0,
    scopePendingWorkUnits: committed ? 0 : 1, scopeComplete: committed,
    globalCoveredWorkUnits: committed ? 1 : 0,
    globalPendingWorkUnits: committed ? 0 : 1, fullCoverage: committed,
    coverageLevel: 'full', coverageFraction: 1, targetPartitionIds: [],
  });
  return {
    stats: { nodeCount: 1, edgeCount: 0, workUnitCount: 1 },
    planScope({ attemptId }) {
      return summary(attemptId);
    },
    getScopeSummary(attemptId) { return summary(attemptId); },
    snapshotPendingWorkUnits() { return committed ? [] : ['p-c-one-u0000']; },
    beginWorkUnitAttempt() {},
    loadWorkUnit() {
      return {
        workUnitId: 'p-c-one-u0000', partitionId: 'c-one',
        nodes: [{ id: 'n1', content: 'one' }], edges: [],
      };
    },
    async commitSuccessfulSweeps() { committed = true; },
    listSuccessfulSweeps() {
      return committed ? [{
        workUnitId: 'p-c-one-u0000', partitionId: 'c-one',
        provider: 'sweep', model: 'shared-model', output: 'finding',
      }] : [];
    },
    listRetryablePartitions() { return []; },
    countScopeWorkUnits() { return 1; },
    countScopeSuccessfulWorkUnits() { return committed ? 1 : 0; },
    countScopePendingWorkUnits() { return committed ? 0 : 1; },
    countSuccessfulWorkUnits() { return committed ? 1 : 0; },
    countPendingWorkUnits() { return committed ? 0 : 1; },
    recordRetryableFailure() {},
    close() {},
  };
}

test('pinned PGS keeps provider roles exact and returns machine-readable durable sweeps', async t => {
  const scratch = await scratchFixture(t);
  const pin = sourcePin();
  const fixture = makeEngine();
  const events = [];

  const envelope = await fixture.engine.runPinnedOperation(options(pin, scratch, {
    reportEvent: event => events.push(event),
  }));

  assert.equal(envelope.state, 'complete');
  assert.equal(envelope.result.answer, 'final pinned synthesis');
  assert.equal(envelope.result.sweepOutputs.length, 6);
  assert.equal(envelope.result.metadata.pgs.successfulSweeps, 6);
  assert.equal(envelope.result.metadata.pgs.pendingWorkUnits, 0);
  assert.equal(envelope.result.metadata.pgs.selectedWorkUnits, 6);
  assert.deepEqual(envelope.result.metadata.pgs.sourceTotals, {
    nodes: 12, edges: 11, workUnits: 6,
  });
  assert.deepEqual(envelope.result.metadata.pgs.retryablePartitions, []);
  assert.equal(envelope.result.sourceEvidence.deltaWatermark.revision, 5);
  assert.equal(envelope.resultArtifact, null);
  assert.equal(pin.releaseCount(), 0);
  assert.equal(fixture.calls.filter(call => call.phase === 'sweep').length, 6);
  assert.equal(fixture.calls.filter(call => call.phase === 'synth').length, 1);
  assert.equal(fixture.calls.every(call => call.options.maxOutputTokens === 512), true);
  assert.equal(fixture.calls
    .filter(call => call.phase === 'sweep')
    .every(call => call.options.maxOutputBytes === limits.maxSweepOutputBytes), true);
  assert.equal(fixture.calls.find(call => call.phase === 'synth').options.maxOutputBytes,
    limits.maxSynthesisOutputBytes);
  assert.equal(events.filter(event => event.type === 'provider_selected').length, 7);
  assert.equal(events.filter(event => event.type === 'provider_call_terminal').length, 7);
  assert.deepEqual(events.filter(event => event.type === 'progress').map(event => event.stage), [
    'projection_started',
    'projection_complete',
    'work_selected',
    'sweep_complete',
    'synthesis_started',
    'synthesis_complete',
  ]);
  const selectionProgress = events.find(event => event.stage === 'work_selected');
  assert.equal(selectionProgress.candidateWorkUnits, 6);
  assert.equal(selectionProgress.pendingWorkUnits, 6);
  assert.equal(events.every(event => event.type !== 'response.output_text.delta'), true);
  assert.equal(events.find(event => event.type === 'provider_selected'
    && event.phase === 'pgs_sweep').provider, 'sweep');
  assert.equal(events.find(event => event.type === 'provider_selected'
    && event.phase === 'pgs_synthesis').provider, 'synth');

  const receipts = await fs.readdir(path.join(scratch.scratchDir, 'pgs-receipts'));
  assert.equal(receipts.length, 1);
  const receiptPath = path.join(scratch.scratchDir, 'pgs-receipts', receipts[0]);
  const receiptStat = await fs.lstat(receiptPath);
  assert.equal(receiptStat.isFile(), true);
  assert.equal(receiptStat.isSymbolicLink(), false);
  assert.equal(receiptStat.nlink, 1);
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.match(receipt.attemptId, /^attempt-/);
  assert.equal(receipt.result.answer, 'final pinned synthesis');
});

test('full PGS drains every bounded work batch beyond one selected-work window', async t => {
  const scratch = await scratchFixture(t);
  const fixture = makeEngine();
  const envelope = await fixture.engine.runPinnedOperation(options(
    sourcePin({ nodeCount: 40 }),
    scratch,
    { pgsMode: 'fresh', pgsLevel: 'full', pgsConfig: { sweepFraction: 1 } },
  ));

  assert.equal(envelope.state, 'complete');
  assert.equal(envelope.result.metadata.pgs.scopeWorkUnits, 20);
  assert.equal(envelope.result.metadata.pgs.scopeSuccessfulWorkUnits, 20);
  assert.equal(envelope.result.metadata.pgs.scopePendingWorkUnits, 0);
  assert.equal(envelope.result.metadata.pgs.fullCoverage, true);
  assert.equal(fixture.calls.filter(call => call.phase === 'sweep').length, 20);
  assert.equal(fixture.calls.filter(call => call.phase === 'synth').length, 1);
});

test('PGS work selection telemetry reports total pending beyond its bounded candidate snapshot', async t => {
  const scratch = await scratchFixture(t);
  const fixture = makeEngine();
  const events = [];
  const candidateIds = Array.from(
    { length: 100 },
    (_, index) => `p-c-one-u${String(index).padStart(4, '0')}`,
  );
  const committed = new Map();
  const summary = attemptId => ({
    attemptId,
    scopeWorkUnits: 100,
    scopeSuccessfulWorkUnits: committed.size,
    scopePendingWorkUnits: 100 - committed.size,
    scopeComplete: committed.size === 100,
    globalCoveredWorkUnits: committed.size,
    globalPendingWorkUnits: 1_000 - committed.size,
    fullCoverage: false,
    coverageLevel: 'skim',
    coverageFraction: 0.1,
    targetPartitionIds: [],
  });
  fixture.engine.openPinnedPGSStore = async () => ({
    stats: { nodeCount: 1_000, edgeCount: 0, workUnitCount: 1_000 },
    planScope({ attemptId }) { return summary(attemptId); },
    getScopeSummary(attemptId) { return summary(attemptId); },
    snapshotPendingWorkUnits({ limit, afterWorkUnitId }) {
      const start = afterWorkUnitId === undefined
        ? 0
        : candidateIds.indexOf(afterWorkUnitId) + 1;
      return candidateIds
        .slice(start)
        .filter(workUnitId => !committed.has(workUnitId))
        .slice(0, limit);
    },
    beginWorkUnitAttempt() {},
    loadWorkUnit(workUnitId) {
      return {
        workUnitId, partitionId: 'c-one',
        nodes: [{ id: workUnitId, content: 'bounded candidate evidence' }], edges: [],
      };
    },
    async commitSuccessfulSweeps(rows) {
      for (const row of rows) committed.set(row.workUnitId, {
        ...row, partitionId: 'c-one', provider: 'sweep', model: 'shared-model',
      });
    },
    listSuccessfulSweeps() { return [...committed.values()]; },
    listRetryablePartitions() { return ['c-one']; },
    countScopePendingWorkUnits() { return 100 - committed.size; },
    countPendingWorkUnits() { return 1_000 - committed.size; },
    recordRetryableFailure() {},
    close() {},
  });

  const envelope = await fixture.engine.runPinnedOperation({
    ...options(sourcePin({ nodeCount: 1_000 }), scratch, {
      reportEvent: event => events.push(event),
      pgsMode: 'fresh',
      pgsLevel: 'skim',
      pgsConfig: { sweepFraction: 0.1 },
    }),
    limits: { ...limits, maxSelectedWorkUnits: 16 },
  });

  assert.equal(envelope.state, 'complete');
  const selected = events.find(event => event.stage === 'work_selected');
  assert.equal(selected.candidateWorkUnits, 100);
  assert.equal(selected.selectedWorkUnits, 16);
  assert.equal(selected.pendingWorkUnits, 1_000);
  assert.equal(envelope.result.metadata.pgs.scopePendingWorkUnits, 0);
  assert.equal(envelope.result.metadata.pgs.pendingWorkUnits, 900);
});

test('PGS closes an opened store when work-selection progress reporting throws', async t => {
  const scratch = await scratchFixture(t);
  const fixture = makeEngine();
  const store = singleWorkStore();
  let closed = false;
  store.close = () => { closed = true; };
  fixture.engine.openPinnedPGSStore = async () => store;
  const marker = Object.assign(new Error('progress sink failed'), { code: 'worker_event_invalid' });

  await assert.rejects(
    fixture.engine.runPinnedOperation(options(sourcePin({ nodeCount: 1 }), scratch, {
      reportEvent(event) {
        if (event.stage === 'work_selected') throw marker;
      },
    })),
    error => error === marker,
  );
  assert.equal(closed, true);
});

test('PGS closes its receipt boundary when store cleanup throws', async t => {
  const scratch = await scratchFixture(t);
  const fixture = makeEngine();
  const store = singleWorkStore();
  const marker = Object.assign(new Error('store cleanup failed'), { code: 'pgs_cleanup_failed' });
  store.close = () => { throw marker; };
  fixture.engine.openPinnedPGSStore = async () => store;
  const originalCloseSync = fsSync.closeSync;
  let closedBoundaryHandles = 0;
  fsSync.closeSync = function instrumentedCloseSync(...args) {
    closedBoundaryHandles += 1;
    return originalCloseSync.apply(this, args);
  };

  try {
    await assert.rejects(
      fixture.engine.runPinnedOperation(options(sourcePin({ nodeCount: 1 }), scratch)),
      error => error === marker,
    );
  } finally {
    fsSync.closeSync = originalCloseSync;
  }
  assert.equal(closedBoundaryHandles > 0, true);
});

test('PGS bounds exact gpt-5.4-mini and gpt-5.5 inputs by decoded UTF-8 bytes', async t => {
  const scratch = await scratchFixture(t);
  const fixture = makeCodexBudgetEngine();
  const node = {
    id: 'n0',
    clusterId: 'cluster-0',
    content: `escaped Unicode evidence ${'🧠"\\\n'.repeat(4_000)}`,
  };
  const pin = sourcePin({ nodeCount: 1 });
  pin.iterateNodes = async function* iterateNodes() { yield node; };
  pin.iterateEdges = async function* iterateEdges() {};

  const envelope = await fixture.engine.runPinnedOperation(codexBudgetOptions(pin, scratch, {
    query: `Unicode question ${'🧠"\\\n'.repeat(1_000)}`,
  }));

  assert.equal(envelope.state, 'complete');
  assert.equal(fixture.calls.length, 2);
  const expectedModelBudget = Math.floor(272_000 * 0.95) - 32_768 - 8_192;
  const sweep = fixture.calls.find(call => call.model === 'gpt-5.4-mini');
  const synth = fixture.calls.find(call => call.model === 'gpt-5.5');
  assert.equal(sweep.provider, 'openai-codex');
  assert.equal(synth.provider, 'openai-codex');
  assert.equal(
    Buffer.byteLength(sweep.instructions, 'utf8') + Buffer.byteLength(sweep.input, 'utf8')
      <= Math.min(128_000, expectedModelBudget),
    true,
  );
  assert.equal(
    Buffer.byteLength(synth.instructions, 'utf8') + Buffer.byteLength(synth.input, 'utf8')
      <= expectedModelBudget,
    true,
  );
  assert.match(sweep.input, /escaped Unicode evidence/);
});

test('PGS partitions work units against the exact provider input budget before persistence', async t => {
  const sweepInstructions = 'Analyze only this pinned PGS work unit. Return evidence-backed findings and explicit absences.';
  for (const scenario of [
    {
      name: 'model-effective-32k',
      contextWindowTokens: 50_000,
      maxOutputTokens: 8_000,
      callerLimit: 128_000,
      contentChars: 15_400,
    },
    {
      name: 'lower-caller-limit',
      contextWindowTokens: 50_000,
      maxOutputTokens: 8_000,
      callerLimit: 24_000,
      contentChars: 11_800,
    },
  ]) {
    const scratch = await scratchFixture(t);
    const fixture = makeCodexBudgetEngine({
      sweepContextWindowTokens: scenario.contextWindowTokens,
      maxOutputTokens: scenario.maxOutputTokens,
    });
    let openedContextLimit = null;
    fixture.engine.openPinnedPGSStore = async input => {
      openedContextLimit = input.limits.maxContextCharsPerWorkUnit;
      return openPinnedPGSStore(input);
    };
    const pin = sourcePin({ nodeCount: 2 });
    pin.iterateNodes = async function* iterateNodes() {
      for (let index = 0; index < 2; index += 1) {
        yield {
          id: `n${index}`,
          clusterId: 'same-partition',
          content: `${scenario.name}-${index}-${'x'.repeat(scenario.contentChars)}`,
        };
      }
    };
    pin.iterateEdges = async function* iterateEdges() {};
    const query = 'budget canary';
    const runLimits = {
      ...codexBudgetOptions(pin, scratch).limits,
      maxContextCharsPerWorkUnit: scenario.callerLimit,
    };

    const envelope = await fixture.engine.runPinnedOperation(codexBudgetOptions(pin, scratch, {
      query,
      limits: runLimits,
    }));

    const modelBudget = Math.floor(scenario.contextWindowTokens * 0.95)
      - scenario.maxOutputTokens - 8_192;
    const totalBudget = Math.min(scenario.callerLimit, modelBudget);
    const framingBytes = Buffer.byteLength(
      `Query: ${query}\n\nPinned work unit ${'w'.repeat(256)}:\n`,
      'utf8',
    );
    const expectedStoreLimit = totalBudget
      - Buffer.byteLength(sweepInstructions, 'utf8')
      - framingBytes
      - (runLimits.maxNodesPerWorkUnit * Buffer.byteLength('NODE \n', 'utf8'));
    assert.equal(openedContextLimit, expectedStoreLimit, scenario.name);
    assert.equal(openedContextLimit < scenario.callerLimit, true, scenario.name);
    assert.equal(openedContextLimit < modelBudget, true, scenario.name);
    assert.equal(envelope.state, 'complete', scenario.name);
    assert.equal(
      fixture.calls.filter(call => call.model === 'gpt-5.4-mini').length,
      2,
      `${scenario.name} must split the two same-partition nodes`,
    );
  }
});

test('PGS rejects an oversized Unicode sweep prompt before either provider runs', async t => {
  const scratch = await scratchFixture(t);
  const fixture = makeCodexBudgetEngine();

  await assert.rejects(
    fixture.engine.runPinnedOperation(codexBudgetOptions(sourcePin({ nodeCount: 1 }), scratch, {
      query: '🧠'.repeat(40_000),
    })),
    { code: 'result_too_large', retryable: false },
  );
  assert.equal(fixture.calls.length, 0);
});

test('PGS hierarchically reduces one sweep output larger than the synthesis model context', async t => {
  const scratch = await scratchFixture(t);
  const fixture = makeCodexBudgetEngine();
  const oversizedSweepOutput = ('🧠 quoted \\" slash \\\\ newline\n').repeat(7_000);
  let closed = false;
  const summary = attemptId => ({
    attemptId,
    scopeWorkUnits: 1,
    scopeSuccessfulWorkUnits: 1,
    scopePendingWorkUnits: 0,
    scopeComplete: true,
    globalCoveredWorkUnits: 1,
    globalPendingWorkUnits: 0,
    fullCoverage: true,
    coverageLevel: 'full',
    coverageFraction: 1,
    targetPartitionIds: [],
  });
  fixture.engine.openPinnedPGSStore = async () => ({
    stats: { nodeCount: 1, edgeCount: 0, workUnitCount: 1 },
    planScope({ attemptId }) { return summary(attemptId); },
    getScopeSummary(attemptId) { return summary(attemptId); },
    snapshotPendingWorkUnits() { return []; },
    beginWorkUnitAttempt() { throw new Error('no pending work'); },
    loadWorkUnit() { throw new Error('no pending work'); },
    async commitSuccessfulSweeps() {},
    listSuccessfulSweeps() {
      return [{
        workUnitId: 'p-c-one-u0000',
        partitionId: 'c-one',
        provider: 'openai-codex',
        model: 'gpt-5.4-mini',
        output: oversizedSweepOutput,
      }];
    },
    listRetryablePartitions() { return []; },
    countScopePendingWorkUnits() { return 0; },
    countPendingWorkUnits() { return 0; },
    recordRetryableFailure() {},
    close() { closed = true; },
  });

  const envelope = await fixture.engine.runPinnedOperation(codexBudgetOptions(
    sourcePin({ nodeCount: 1 }),
    scratch,
  ));

  assert.equal(envelope.state, 'complete');
  assert.equal(envelope.result.answer, 'bounded synthesis');
  assert.equal(envelope.result.sweepOutputs.length, 1);
  assert.equal(envelope.error, null);
  assert.equal(fixture.calls.length > 1, true);
  assert.equal(envelope.result.metadata.pgs.synthesis.hierarchical, true);
  const sourceFragments = fixture.calls
    .filter(call => call.instructions.startsWith('Reduce this bounded shard'))
    .flatMap(call => call.input.split('\n').filter(line => line.startsWith('{')).map(JSON.parse))
    .filter(row => row.workUnitId === 'p-c-one-u0000')
    .sort((left, right) => left.fragmentIndex - right.fragmentIndex);
  assert.equal(sourceFragments.length > 1, true);
  assert.equal(sourceFragments.map(row => row.output).join(''), oversizedSweepOutput);
  assert.equal(closed, true);
});

test('PGS hierarchically synthesizes a large deterministic sweep fan-in within the exact model budget', async t => {
  const scratch = await scratchFixture(t);
  const events = [];
  const fixture = makeCodexBudgetEngine({
    synthContextWindowTokens: 48_000,
    maxOutputTokens: 4_096,
  });
  const sweepRows = Array.from({ length: 286 }, (_, index) => ({
    workUnitId: `p-c-${String(index).padStart(3, '0')}-u0000`,
    partitionId: `c-${String(index).padStart(3, '0')}`,
    provider: 'openai-codex',
    model: 'gpt-5.4-mini',
    output: `finding-${String(index).padStart(3, '0')} ${'evidence '.repeat(120)}`,
  }));
  const summary = attemptId => ({
    attemptId,
    scopeWorkUnits: sweepRows.length,
    scopeSuccessfulWorkUnits: sweepRows.length,
    scopePendingWorkUnits: 0,
    scopeComplete: true,
    globalCoveredWorkUnits: sweepRows.length,
    globalPendingWorkUnits: 0,
    fullCoverage: true,
    coverageLevel: 'full',
    coverageFraction: 1,
    targetPartitionIds: [],
  });
  fixture.engine.openPinnedPGSStore = async () => ({
    stats: { nodeCount: 10_000, edgeCount: 20_000, workUnitCount: sweepRows.length },
    planScope({ attemptId }) { return summary(attemptId); },
    getScopeSummary(attemptId) { return summary(attemptId); },
    snapshotPendingWorkUnits() { return []; },
    beginWorkUnitAttempt() { throw new Error('no pending work'); },
    loadWorkUnit() { throw new Error('no pending work'); },
    async commitSuccessfulSweeps() {},
    listSuccessfulSweeps() { return structuredClone(sweepRows); },
    listRetryablePartitions() { return []; },
    countScopePendingWorkUnits() { return 0; },
    countPendingWorkUnits() { return 0; },
    recordRetryableFailure() {},
    close() {},
  });

  const envelope = await fixture.engine.runPinnedOperation(codexBudgetOptions(
    sourcePin({ nodeCount: 1 }),
    scratch,
    {
      reportEvent(event) { events.push(event); },
      limits: {
        ...codexBudgetOptions(sourcePin({ nodeCount: 1 }), scratch).limits,
        maxSynthesisInputBytes: 512 * 1024,
      },
    },
  ));

  const synthesisCalls = fixture.calls.filter(call => call.model === 'gpt-5.5');
  assert.equal(envelope.state, 'complete');
  assert.equal(envelope.result.answer, 'bounded synthesis');
  assert.equal(synthesisCalls.length > 1, true, 'large fan-in must use multiple bounded calls');
  assert.equal(synthesisCalls.every(call => (
    Buffer.byteLength(call.instructions, 'utf8') + Buffer.byteLength(call.input, 'utf8')
  ) <= 33_312), true);
  assert.equal(envelope.result.metadata.pgs.synthesis.hierarchical, true);
  assert.equal(envelope.result.metadata.pgs.synthesis.inputSweeps, sweepRows.length);
  assert.equal(envelope.result.metadata.pgs.synthesis.providerCalls, synthesisCalls.length);
  assert.equal(envelope.result.metadata.pgs.synthesis.levels >= 2, true);
  assert.equal(events.some(event => event.type === 'provider_call_terminal'
    && event.phase === 'pgs_synthesis'
    && event.providerCallId === 'pgs:synthesis'
    && event.outcome === 'complete'), true);
  assert.equal(events.some(event => event.type === 'provider_call_terminal'
    && event.providerCallId.startsWith('pgs:synthesis:reduce:')), true);
});

test('PGS bounds JSON-escaped hierarchical shards and strictly reduces adversarial control output', async t => {
  const scratch = await scratchFixture(t);
  const fixture = makeCodexBudgetEngine({
    synthContextWindowTokens: 48_000,
    maxOutputTokens: 4_096,
    maximumCalls: 50,
    synthesisOutput(request) {
      return request.instructions.startsWith('Reduce this bounded shard')
        ? '\0'.repeat(request.maxOutputBytes)
        : 'bounded final synthesis';
    },
  });
  const sweepRows = Array.from({ length: 20 }, (_, index) => ({
    workUnitId: `p-control-${String(index).padStart(3, '0')}-u0000`,
    partitionId: `control-${String(index).padStart(3, '0')}`,
    provider: 'openai-codex',
    model: 'gpt-5.4-mini',
    output: `control evidence ${index} ${'x'.repeat(9_000)}`,
  }));
  const summary = attemptId => ({
    attemptId,
    scopeWorkUnits: sweepRows.length,
    scopeSuccessfulWorkUnits: sweepRows.length,
    scopePendingWorkUnits: 0,
    scopeComplete: true,
    globalCoveredWorkUnits: sweepRows.length,
    globalPendingWorkUnits: 0,
    fullCoverage: true,
    coverageLevel: 'full', coverageFraction: 1, targetPartitionIds: [],
  });
  fixture.engine.openPinnedPGSStore = async () => ({
    stats: { nodeCount: 2_000, edgeCount: 4_000, workUnitCount: sweepRows.length },
    planScope({ attemptId }) { return summary(attemptId); },
    getScopeSummary(attemptId) { return summary(attemptId); },
    snapshotPendingWorkUnits() { return []; },
    beginWorkUnitAttempt() { throw new Error('no pending work'); },
    loadWorkUnit() { throw new Error('no pending work'); },
    async commitSuccessfulSweeps() {},
    listSuccessfulSweeps() { return structuredClone(sweepRows); },
    listRetryablePartitions() { return []; },
    countScopePendingWorkUnits() { return 0; },
    countPendingWorkUnits() { return 0; },
    recordRetryableFailure() {},
    close() {},
  });

  const envelope = await fixture.engine.runPinnedOperation(codexBudgetOptions(
    sourcePin({ nodeCount: 1 }), scratch, {
      limits: {
        ...codexBudgetOptions(sourcePin({ nodeCount: 1 }), scratch).limits,
        maxSynthesisInputBytes: 512 * 1024,
      },
    },
  ));

  const synthesisCalls = fixture.calls.filter(call => call.model === 'gpt-5.5');
  assert.equal(envelope.state, 'complete');
  assert.equal(envelope.result.answer, 'bounded final synthesis');
  assert.equal(synthesisCalls.length < 20, true);
  assert.equal(envelope.result.metadata.pgs.synthesis.providerCalls, synthesisCalls.length);
  assert.equal(envelope.result.metadata.pgs.synthesis.intermediateEncodedBytes > 0, true);
  assert.equal(
    envelope.result.metadata.pgs.synthesis.providerCalls
      <= envelope.result.metadata.pgs.synthesis.providerCallCeiling,
    true,
  );
  assert.equal(
    envelope.result.metadata.pgs.synthesis.intermediateEncodedBytes
      <= envelope.result.metadata.pgs.synthesis.intermediateEncodedByteCeiling,
    true,
  );
  assert.equal(
    synthesisCalls
      .filter(call => call.instructions.startsWith('Reduce this bounded shard'))
      .every(call => call.maxOutputBytes < 1_500),
    true,
  );
});

test('pinned PGS derives complete source evidence from the opened projection store', async t => {
  const scratch = await scratchFixture(t);
  const pin = sourcePin({ nodeCount: 1 });
  const fixture = makeEngine();
  const evidenceCalls = [];
  let storeOpened = false;
  pin.getEvidence = (extra) => {
    assert.equal(storeOpened, true, 'source evidence must be derived after the store opens');
    evidenceCalls.push(structuredClone(extra));
    return {
      sourceHealth: 'healthy',
      matchOutcome: extra.returnedTotals.nodes > 0 ? 'matches' : 'corpus_empty',
      deltaWatermark: { revision: 5 },
      ...extra,
    };
  };
  fixture.engine.openPinnedPGSStore = async () => {
    storeOpened = true;
    return singleWorkStore();
  };

  const envelope = await fixture.engine.runPinnedOperation(options(pin, scratch));

  assert.deepEqual(evidenceCalls, [{
    route: 'pinned-pgs',
    returnedTotals: { nodes: 1, edges: 0 },
    completeCoverage: true,
  }]);
  assert.deepEqual(envelope.result.sourceEvidence.returnedTotals, { nodes: 1, edges: 0 });
  assert.equal(envelope.result.sourceEvidence.completeCoverage, true);
  assert.equal(envelope.result.sourceEvidence.matchOutcome, 'matches');
  assert.equal(envelope.sourceEvidence, envelope.result.sourceEvidence);
});

test('pinned PGS rejects non-integer projection totals before evidence or provider work', async t => {
  const scratch = await scratchFixture(t);
  const pin = sourcePin({ nodeCount: 1 });
  const fixture = makeEngine();
  let evidenceCalls = 0;
  let closes = 0;
  pin.getEvidence = () => { evidenceCalls += 1; };
  fixture.engine.openPinnedPGSStore = async () => ({
    ...singleWorkStore(),
    stats: { nodeCount: '1', edgeCount: 0, workUnitCount: 1 },
    close() { closes += 1; },
  });

  await assert.rejects(
    fixture.engine.runPinnedOperation(options(pin, scratch)),
    { code: 'pgs_projection_invalid', retryable: false },
  );
  assert.equal(evidenceCalls, 0);
  assert.equal(fixture.calls.length, 0);
  assert.equal(closes, 1);
});

test('pinned PGS enforces lowered sweep and synthesis byte ceilings inside provider adapters', async t => {
  const exactSweepBytes = 128;
  const exactSynthesisBytes = 192;

  for (const [phase, over] of [
    ['sweep', false],
    ['sweep', true],
    ['synthesis', false],
    ['synthesis', true],
  ]) {
    const scratch = await scratchFixture(t);
    const fixture = makeEngine({
      enforceOutputBytes: true,
      sweepOutput: 's'.repeat(exactSweepBytes + (phase === 'sweep' && over ? 1 : 0)),
      synthesisOutput: 'y'.repeat(
        exactSynthesisBytes + (phase === 'synthesis' && over ? 1 : 0),
      ),
    });
    const bounded = {
      ...limits,
      maxSweepOutputBytes: exactSweepBytes,
      maxSynthesisOutputBytes: exactSynthesisBytes,
    };
    const run = fixture.engine.runPinnedOperation({
      ...options(sourcePin({ nodeCount: 1 }), scratch),
      limits: bounded,
    });

    if (over) {
      if (phase === 'synthesis') {
        const partial = await run;
        assert.equal(partial.state, 'partial');
        assert.equal(partial.result.answer, null);
        assert.equal(partial.result.sweepOutputs.length, 1);
        assert.deepEqual(partial.error, {
          code: 'result_too_large',
          message: 'bounded synthesis adapter rejected output',
          retryable: false,
        });
      } else {
        await assert.rejects(run, { code: 'result_too_large', retryable: false });
      }
      const callPhase = phase === 'synthesis' ? 'synth' : phase;
      assert.equal(
        fixture.calls.filter(call => call.phase === callPhase).length,
        1,
        `${phase} over-limit call count`,
      );
      if (phase === 'sweep') {
        assert.equal(fixture.calls.some(call => call.phase === 'synth'), false);
      }
      const receipts = await fs.readdir(path.join(scratch.scratchDir, 'pgs-receipts'))
        .catch((error) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        });
      assert.deepEqual(receipts, []);
    } else {
      const result = await run;
      assert.equal(result.state, 'complete');
      assert.equal(fixture.calls.find(call => call.phase === 'sweep').options.maxOutputBytes,
        exactSweepBytes);
      assert.equal(fixture.calls.find(call => call.phase === 'synth').options.maxOutputBytes,
        exactSynthesisBytes);
    }
  }
});

test('pinned PGS rejects a redirected receipt directory before provider work', async t => {
  const scratch = await scratchFixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-pgs-receipt-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(scratch.scratchDir, 'pgs-receipts'));
  const fixture = makeEngine();
  fixture.engine.openPinnedPGSStore = async () => singleWorkStore();

  await assert.rejects(
    () => fixture.engine.runPinnedOperation(options(sourcePin({ nodeCount: 1 }), scratch)),
    { code: 'invalid_request' },
  );
  assert.equal(fixture.calls.length, 0);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('pinned PGS removes only its exact receipt temporary on cancellation', async t => {
  const scratch = await scratchFixture(t);
  const controller = new AbortController();
  const reason = Object.assign(new Error('cancel receipt publication'), { code: 'cancelled' });
  let reconciles = 0;
  const quota = {
    operationRoot: scratch.quota.operationRoot,
    async assertOperationRoot(candidate) {
      return scratch.quota.assertOperationRoot(candidate);
    },
    async reconcile() {
      reconciles += 1;
      if (reconciles === 1) controller.abort(reason);
      return scratch.quota.reconcile();
    },
  };
  const fixture = makeEngine();
  fixture.engine.openPinnedPGSStore = async () => singleWorkStore();

  await assert.rejects(
    () => fixture.engine.runPinnedOperation({
      ...options(sourcePin({ nodeCount: 1 }), scratch),
      scratchQuota: quota,
      signal: controller.signal,
    }),
    error => error === reason,
  );
  assert.equal(reconciles >= 2, true);
  assert.deepEqual(await fs.readdir(path.join(scratch.scratchDir, 'pgs-receipts')), []);
});

test('PGS receipt publication uses an atomic no-replace filesystem primitive', async () => {
  const source = await fs.readFile(
    path.resolve(__dirname, '../../cosmo23/pgs-engine/src/pinned-operation.js'),
    'utf8',
  );
  const start = source.indexOf('async function writeSuccessReceipt');
  const end = source.indexOf('async function runPinnedOperation', start);
  const writer = source.slice(start, end);
  assert.match(writer, /await fsp\.link\(temporary, destination\)/);
  assert.doesNotMatch(writer, /fsp\.rename\(temporary, destination\)/);
});

test('empty pinned source fails honestly without provider work', async t => {
  const scratch = await scratchFixture(t);
  const pin = sourcePin({ nodeCount: 0 });
  const fixture = makeEngine();

  const envelope = await fixture.engine.runPinnedOperation(options(pin, scratch));

  assert.equal(envelope.state, 'failed');
  assert.equal(envelope.error.code, 'source_empty');
  assert.equal(envelope.error.retryable, false);
  assert.deepEqual(envelope.result.sweepOutputs, []);
  assert.deepEqual(envelope.result.metadata.pgs.sourceTotals, {
    nodes: 0, edges: 0, workUnits: 0,
  });
  assert.deepEqual(envelope.sourceEvidence.returnedTotals, { nodes: 0, edges: 0 });
  assert.equal(envelope.sourceEvidence.completeCoverage, true);
  assert.equal(envelope.sourceEvidence.matchOutcome, 'corpus_empty');
  assert.equal(fixture.calls.length, 0);
  assert.equal(pin.releaseCount(), 0);
});

test('PGS requires exact client and completion provider identities', async t => {
  for (const [name, sweepClient, expectedCalls] of [
    ['missing client provider', {
      async generate() { throw new Error('unreachable'); },
    }, 0],
    ['mismatched client provider', {
      providerId: 'synth', async generate() { throw new Error('unreachable'); },
    }, 0],
    ['missing completion provider', {
      providerId: 'sweep', async generate() {
        return {
          content: 'finding', terminalReceived: true, finishReason: 'completed',
          hadError: false, provider: null, model: 'shared-model',
        };
      },
    }, 1],
    ['mismatched completion model', {
      providerId: 'sweep', async generate() {
        return {
          content: 'finding', terminalReceived: true, finishReason: 'completed',
          hadError: false, provider: 'sweep', model: 'wrong-model',
        };
      },
    }, 1],
  ]) {
    const scratch = await scratchFixture(t);
    let calls = 0;
    const wrappedSweep = {
      ...sweepClient,
      async generate(options) {
        calls += 1;
        return sweepClient.generate(options);
      },
    };
    const engine = new PGSEngine({
      modelCatalog: catalog(),
      providerRegistry: {
        get(provider) {
          if (provider === 'sweep') return wrappedSweep;
          return {
            providerId: 'synth',
            async generate() {
              return {
                content: 'synthesis', terminalReceived: true, finishReason: 'completed',
                hadError: false, provider: 'synth', model: 'shared-model',
              };
            },
          };
        },
      },
    });
    await assert.rejects(
      engine.runPinnedOperation(options(sourcePin({ nodeCount: 2 }), scratch)),
      error => error.code === 'provider_model_mismatch',
      name,
    );
    if (expectedCalls === 0) assert.equal(calls, 0, name);
    else assert.equal(calls > 0, true, name);
  }
});

test('pinned PGS rejects caller-controlled concurrency before store or provider work', async t => {
  const scratch = await scratchFixture(t);
  const fixture = makeEngine();
  let storeCalls = 0;
  fixture.engine.openPinnedPGSStore = async () => {
    storeCalls += 1;
    return singleWorkStore();
  };

  await assert.rejects(
    fixture.engine.runPinnedOperation(options(sourcePin({ nodeCount: 1 }), scratch, {
      pgsConfig: { sweepFraction: 1, maxConcurrentSweeps: 4 },
    })),
    error => error.code === 'invalid_request',
  );
  assert.equal(storeCalls, 0);
  assert.equal(fixture.calls.length, 0);
});

test('fractional scope completes honestly and a higher level executes only pending work', async t => {
  const scratch = await scratchFixture(t);
  const pin = sourcePin();
  const first = makeEngine();
  const partial = await first.engine.runPinnedOperation(options(pin, scratch, {
    pgsConfig: { sweepFraction: 0.5 },
  }));
  assert.equal(partial.state, 'complete');
  assert.equal(partial.error, null);
  assert.equal(partial.result.metadata.pgs.successfulSweeps, 3);
  assert.equal(partial.result.metadata.pgs.scopePendingWorkUnits, 0);
  assert.equal(partial.result.metadata.pgs.globalPendingWorkUnits, 3);

  const retry = makeEngine();
  const complete = await retry.engine.runPinnedOperation(options(pin, scratch));
  assert.equal(complete.state, 'complete');
  assert.equal(complete.result.metadata.pgs.successfulSweeps, 6);
  assert.equal(retry.calls.filter(call => call.phase === 'sweep').length, 3);
  assert.equal(retry.calls.filter(call => call.phase === 'synth').length, 1);
});

test('targeted PGS synthesizes only the explicit partition scope and expands by union', async t => {
  const scratch = await scratchFixture(t);
  const pin = sourcePin();
  const first = makeEngine();
  const targeted = await first.engine.runPinnedOperation(options(pin, scratch, {
    pgsMode: 'targeted',
    pgsLevel: 'full',
    targetPartitionIds: ['c-cluster-0'],
  }));

  assert.equal(targeted.state, 'complete');
  assert.equal(targeted.result.sweepOutputs.length, 3);
  assert.equal(targeted.result.sweepOutputs.every(row => row.partitionId === 'c-cluster-0'), true);
  assert.deepEqual(targeted.result.metadata.pgs.targetPartitionIds, ['c-cluster-0']);
  assert.equal(targeted.result.metadata.pgs.scopeComplete, true);
  assert.equal(targeted.result.metadata.pgs.fullCoverage, false);
  const firstSynthesis = first.calls.find(call => call.phase === 'synth');
  assert.match(firstSynthesis.options.input, /c-cluster-0/);
  assert.doesNotMatch(firstSynthesis.options.input, /c-cluster-1/);

  const second = makeEngine();
  const expanded = await second.engine.runPinnedOperation(options(pin, scratch, {
    pgsMode: 'targeted',
    pgsLevel: 'full',
    targetPartitionIds: ['c-cluster-1', 'c-cluster-0'],
  }));
  assert.equal(expanded.state, 'complete');
  assert.equal(expanded.result.sweepOutputs.length, 6);
  assert.equal(expanded.result.metadata.pgs.reusedWorkUnits, 3);
  assert.equal(expanded.result.metadata.pgs.newWorkUnits, 3);
  assert.equal(expanded.result.metadata.pgs.fullCoverage, true);
  assert.equal(second.calls.filter(call => call.phase === 'sweep').length, 3);
  const secondSynthesis = second.calls.find(call => call.phase === 'synth');
  assert.match(secondSynthesis.options.input, /c-cluster-0/);
  assert.match(secondSynthesis.options.input, /c-cluster-1/);
});

test('cancellation during concurrent sweeps preserves the exact reason and starts no later work', async t => {
  const scratch = await scratchFixture(t);
  const pin = sourcePin();
  const controller = new AbortController();
  const reason = Object.assign(new Error('cancel pgs'), { code: 'cancelled' });
  let starts = 0;
  const events = [];
  const pendingClient = {
    providerId: 'sweep',
    generate({ signal }) {
      starts += 1;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };
  const engine = new PGSEngine({
    modelCatalog: catalog(),
    providerRegistry: {
      get(provider) {
        if (provider === 'sweep') return pendingClient;
        return { providerId: 'synth', generate() { throw new Error('synthesis must not run'); } };
      },
    },
  });
  const pending = engine.runPinnedOperation({
    ...options(pin, scratch, { reportEvent: event => events.push(event) }),
    signal: controller.signal,
  });
  while (starts < 2) await new Promise(resolve => setImmediate(resolve));
  controller.abort(reason);

  await assert.rejects(pending, error => error === reason);
  assert.equal(starts, 2);
  assert.equal(events.filter(event => event.outcome === 'cancelled').length, 2);
  assert.equal(pin.releaseCount(), 0);
});
