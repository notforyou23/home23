'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createQueryOperationExecutor,
} = require('../../cosmo23/server/lib/query-operation-worker.js');

function createSourcePin() {
  const evidenceCalls = [];
  let releases = 0;
  return {
    revision: 17,
    evidenceCalls,
    getEvidence(extra) {
      evidenceCalls.push(extra);
      const returnedTotals = extra.returnedTotals || { nodes: 0, edges: 0 };
      const completeCoverage = extra.completeCoverage === true;
      return Object.freeze({
        sourceHealth: 'healthy',
        freshness: 'known',
        baseWatermark: { revision: 16 },
        deltaWatermark: { revision: 17 },
        indexWatermark: { builtFromRevision: 17 },
        authoritativeTotals: { nodes: 20, edges: 19 },
        returnedTotals,
        completeCoverage,
        filteredTotal: extra.filteredTotal || 0,
        matchOutcome: returnedTotals.nodes > 0
          ? 'matches'
          : completeCoverage ? 'no_match' : 'unknown',
        ...extra,
      });
    },
    async release() { releases += 1; },
    releaseCount() { return releases; },
  };
}

function childEvidence(overrides = {}) {
  const returnedTotals = overrides.returnedTotals || { nodes: 2, edges: 1 };
  const completeCoverage = overrides.completeCoverage ?? true;
  return {
    selectedAgent: null,
    selectedBrain: null,
    route: 'engine-internal',
    sourceHealth: 'healthy',
    freshness: 'known',
    baseWatermark: { revision: 16 },
    deltaWatermark: { revision: 17 },
    indexWatermark: { builtFromRevision: 17 },
    authoritativeTotals: { nodes: 20, edges: 19 },
    returnedTotals,
    completeCoverage,
    filteredTotal: overrides.filteredTotal || 0,
    matchOutcome: returnedTotals.nodes > 0
      ? 'matches'
      : completeCoverage ? 'no_match' : 'unknown',
    ...overrides,
  };
}

function queryParameters(overrides = {}) {
  return {
    query: 'What does the pinned evidence show?',
    mode: 'dive',
    modelSelection: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    topK: 100,
    priorContext: { query: 'Earlier question', answer: 'Earlier answer' },
    enableSynthesis: true,
    includeOutputs: false,
    includeThoughts: true,
    includeCoordinatorInsights: false,
    allowActions: true,
    ...overrides,
  };
}

function pgsParameters(overrides = {}) {
  return {
    query: 'Cover every pinned partition',
    mode: 'full',
    pgsMode: 'full',
    pgsConfig: { sweepFraction: 0.25 },
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    pgsSynth: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    priorContext: null,
    allowActions: false,
    ...overrides,
  };
}

function operationContext(operationType, parameters, overrides = {}) {
  const controller = overrides.controller || new AbortController();
  const sourcePin = Object.hasOwn(overrides, 'sourcePin')
    ? overrides.sourcePin
    : createSourcePin();
  return {
    operationId: `op-${operationType}`,
    operationType,
    requesterAgent: 'jerry',
    target: {
      domain: 'brain',
      brainId: 'brain-jerry',
      canonicalRoot: '/not-readable-by-this-executor',
      accessMode: 'own',
      ownerAgent: 'jerry',
      route: 'resident:jerry',
      kind: 'resident',
      lifecycle: 'available',
      catalogRevision: 'catalog-1',
      mutationBoundaries: [],
      ...(overrides.target || {}),
    },
    parameters,
    scratchDir: '/requester/runtime/brain-operations/op/scratch',
    scratchQuota: { quota: 'trusted' },
    signal: controller.signal,
    sourcePin,
    reportEvent: overrides.reportEvent || (() => {}),
    ...overrides.context,
  };
}

function createHarness(handler) {
  const calls = [];
  const queryEngine = {
    async executeEnhancedQuery(query, options) {
      calls.push({ query, options });
      return handler ? handler(query, options, calls.length) : {
        answer: 'Pinned answer',
        metadata: { provider: options.provider, model: options.model },
        sourceEvidence: childEvidence(),
        resultArtifact: null,
      };
    },
  };
  return {
    calls,
    queryEngine,
    executor: createQueryOperationExecutor({ queryEngine }),
  };
}

test('direct Query forwards only the trusted projection and returns a canonical envelope', async () => {
  const harness = createHarness();
  const reportEvent = () => {};
  const context = operationContext('query', queryParameters(), { reportEvent });

  const envelope = await harness.executor(context);

  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].query, context.parameters.query);
  assert.deepEqual(Object.keys(harness.calls[0].options).sort(), [
    'allowActions', 'enablePGS', 'enableSynthesis', 'includeCoordinatorInsights',
    'includeOutputs', 'includeThoughts', 'mode', 'model', 'mutationPolicy',
    'priorContext', 'provider', 'reportEvent', 'scratchDir', 'scratchQuota',
    'signal', 'sourcePin', 'topK',
  ].sort());
  assert.deepEqual(harness.calls[0].options, {
    sourcePin: context.sourcePin,
    scratchDir: context.scratchDir,
    scratchQuota: context.scratchQuota,
    signal: context.signal,
    reportEvent,
    enablePGS: false,
    mode: 'dive',
    priorContext: { query: 'Earlier question', answer: 'Earlier answer' },
    mutationPolicy: 'own',
    allowActions: true,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    topK: 100,
    enableSynthesis: true,
    includeOutputs: false,
    includeThoughts: true,
    includeCoordinatorInsights: false,
  });
  assert.equal(envelope.state, 'complete');
  assert.equal(envelope.error, null);
  assert.equal(envelope.result.answer, 'Pinned answer');
  assert.equal(envelope.result.sourceEvidence, envelope.sourceEvidence);
  assert.equal(envelope.resultArtifact, null);
  assert.deepEqual(context.sourcePin.evidenceCalls, [{
    selectedAgent: 'jerry',
    selectedBrain: 'brain-jerry',
    route: 'resident:jerry',
    returnedTotals: { nodes: 2, edges: 1 },
    completeCoverage: true,
    filteredTotal: 0,
  }]);
  assert.deepEqual(envelope.sourceEvidence.returnedTotals, { nodes: 2, edges: 1 });
  assert.equal(envelope.sourceEvidence.matchOutcome, 'matches');
  assert.equal(context.sourcePin.releaseCount(), 0);
});

test('operationType alone selects Query versus PGS and legacy routing fields are rejected', async () => {
  const harness = createHarness((_query, options) => ({
    state: 'complete',
    result: {
      answer: options.enablePGS ? 'pgs' : 'query',
      sweepOutputs: [],
      sourceEvidence: childEvidence(),
    },
    error: null,
    sourceEvidence: childEvidence(),
    resultArtifact: null,
  }));

  await harness.executor(operationContext('query', queryParameters()));
  await harness.executor(operationContext('pgs', pgsParameters()));
  assert.equal(harness.calls[0].options.enablePGS, false);
  assert.equal(harness.calls[1].options.enablePGS, true);

  await assert.rejects(
    harness.executor(operationContext('query', queryParameters({ enablePGS: true }))),
    error => error.code === 'invalid_request',
  );
  await assert.rejects(
    harness.executor(operationContext('pgs', pgsParameters({ enablePGS: false }))),
    error => error.code === 'invalid_request',
  );
  assert.equal(harness.calls.length, 2);
});

test('PGS forwards exact independent pairs and preserves machine-readable sweep outputs', async () => {
  const pendingUnits = Array.from({ length: 8 }, (_, index) => ({
    workUnitId: `p${index + 1}-u1`,
    partitionId: `p${index + 1}`,
    output: `evidence-${index + 1}`,
    provider: 'minimax',
    model: 'MiniMax-M3',
  }));
  const harness = createHarness((_query, options) => {
    const selected = Math.ceil(pendingUnits.length * options.pgsConfig.sweepFraction);
    const sweepOutputs = pendingUnits.slice(0, selected);
    return {
      state: selected === pendingUnits.length ? 'complete' : 'partial',
      result: {
        answer: selected === pendingUnits.length ? 'complete synthesis' : null,
        sweepOutputs,
        metadata: { pgs: {
          successfulSweeps: selected,
          retryablePartitions: pendingUnits.slice(selected).map(row => row.partitionId),
          sweepFraction: options.pgsConfig.sweepFraction,
          selectedWorkUnits: selected,
          pendingWorkUnits: pendingUnits.length - selected,
        } },
        sourceEvidence: childEvidence(),
      },
      error: selected === pendingUnits.length ? null : {
        code: 'provider_incomplete', message: 'truncated', retryable: true,
      },
      sourceEvidence: childEvidence(),
      resultArtifact: null,
    };
  });
  const partialContext = operationContext('pgs', pgsParameters(), {
    target: { accessMode: 'read-only', ownerAgent: 'forrest', brainId: 'brain-forrest' },
  });

  const partial = await harness.executor(partialContext);
  assert.equal(partial.state, 'partial');
  assert.equal(partial.result.sweepOutputs.length, 2);
  assert.deepEqual(partial.result.sweepOutputs, pendingUnits.slice(0, 2));
  assert.deepEqual(partial.result.metadata.pgs, {
    successfulSweeps: 2,
    retryablePartitions: ['p3', 'p4', 'p5', 'p6', 'p7', 'p8'],
    sweepFraction: 0.25,
    selectedWorkUnits: 2,
    pendingWorkUnits: 6,
  });
  assert.deepEqual(Object.keys(harness.calls[0].options).sort(), [
    'allowActions', 'enablePGS', 'mode', 'mutationPolicy', 'pgsConfig', 'pgsMode',
    'pgsSweep', 'pgsSynth', 'priorContext', 'reportEvent', 'scratchDir',
    'scratchQuota', 'signal', 'sourcePin',
  ].sort());
  assert.equal(harness.calls[0].options.enablePGS, true);
  assert.equal(harness.calls[0].options.mutationPolicy, 'read-only');
  assert.equal(harness.calls[0].options.allowActions, false);
  assert.deepEqual(harness.calls[0].options.pgsSweep, {
    provider: 'minimax', model: 'MiniMax-M3',
  });
  assert.deepEqual(harness.calls[0].options.pgsSynth, {
    provider: 'anthropic', model: 'claude-sonnet-4-6',
  });

  const fullParameters = pgsParameters();
  delete fullParameters.pgsConfig;
  const full = await harness.executor(operationContext('pgs', fullParameters));
  assert.equal(full.state, 'complete');
  assert.equal(full.result.sweepOutputs.length, 8);
  assert.equal(harness.calls[1].options.pgsConfig.sweepFraction, 1);
});

test('complete, partial, and failed child envelopes keep their terminal data', async () => {
  const states = [
    { state: 'complete', error: null },
    { state: 'partial', error: { code: 'provider_incomplete', message: 'short', retryable: true } },
    { state: 'failed', error: { code: 'pgs_all_failed', message: 'none', retryable: true } },
  ];
  for (const terminal of states) {
    const sweepOutputs = [{
      workUnitId: 'p1-u1', partitionId: 'p1', output: 'useful evidence',
      provider: 'minimax', model: 'MiniMax-M3',
    }];
    const result = {
      answer: terminal.state === 'complete' ? 'answer' : null,
      sweepOutputs,
      metadata: { pgs: {
        successfulSweeps: 1,
        retryablePartitions: terminal.state === 'complete' ? [] : ['p2'],
        sweepFraction: 1,
        selectedWorkUnits: 2,
        pendingWorkUnits: terminal.state === 'complete' ? 0 : 1,
      } },
      sourceEvidence: childEvidence({ route: 'child' }),
    };
    const harness = createHarness(() => ({
      state: terminal.state,
      result,
      error: terminal.error,
      sourceEvidence: childEvidence({ route: 'child-top' }),
      resultArtifact: null,
    }));
    const envelope = await harness.executor(operationContext('pgs', pgsParameters({
      pgsConfig: { sweepFraction: 1 },
    })));
    assert.equal(envelope.state, terminal.state);
    assert.equal(envelope.error, terminal.error);
    assert.equal(envelope.result.sweepOutputs, sweepOutputs);
    assert.deepEqual(envelope.result.metadata, result.metadata);
    assert.equal(envelope.result.sourceEvidence, envelope.sourceEvidence);
    assert.equal(envelope.resultArtifact, null);
  }
});

test('retrieval facts are re-bound to canonical source identity and authority', async () => {
  const harness = createHarness(() => ({
    answer: 'Evidence-backed answer',
    sourceEvidence: childEvidence({
      route: 'engine-internal-forged-route',
      returnedTotals: { nodes: 1, edges: 0 },
    }),
    resultArtifact: null,
  }));
  const context = operationContext('query', queryParameters());

  const envelope = await harness.executor(context);

  assert.equal(envelope.sourceEvidence.selectedAgent, 'jerry');
  assert.equal(envelope.sourceEvidence.selectedBrain, 'brain-jerry');
  assert.equal(envelope.sourceEvidence.route, 'resident:jerry');
  assert.deepEqual(envelope.sourceEvidence.authoritativeTotals, { nodes: 20, edges: 19 });
  assert.deepEqual(envelope.sourceEvidence.returnedTotals, { nodes: 1, edges: 0 });
  assert.equal(envelope.sourceEvidence.matchOutcome, 'matches');
});

test('forged canonical assertions and malformed retrieval totals fail closed', async () => {
  const missingReturnedTotals = childEvidence();
  delete missingReturnedTotals.returnedTotals;
  const missingCoverage = childEvidence();
  delete missingCoverage.completeCoverage;
  const extraReturnedTotal = childEvidence({
    returnedTotals: { nodes: 1, edges: 0, clusters: 1 },
  });
  for (const sourceEvidence of [
    childEvidence({ selectedBrain: 'forged-brain' }),
    childEvidence({ authoritativeTotals: { nodes: 999, edges: 19 } }),
    childEvidence({ matchOutcome: 'no_match' }),
    childEvidence({ sourceHealth: 'degraded' }),
    childEvidence({ freshness: 'unknown' }),
    childEvidence({ deltaWatermark: { revision: 999 } }),
    childEvidence({ identity: { brainId: 'forged-brain' } }),
    childEvidence({ returnedTotals: { nodes: '1', edges: 0 } }),
    childEvidence({ returnedTotals: { nodes: 1.5, edges: 0 } }),
    childEvidence({ returnedTotals: { nodes: -1, edges: 0 } }),
    childEvidence({ returnedTotals: { nodes: 21, edges: 0 } }),
    childEvidence({ returnedTotals: { nodes: 1, edges: 20 } }),
    childEvidence({ completeCoverage: 'true' }),
    childEvidence({ filteredTotal: -1 }),
    childEvidence({ filteredTotal: 1.5 }),
    childEvidence({ filteredTotal: 21 }),
    missingReturnedTotals,
    missingCoverage,
    extraReturnedTotal,
  ]) {
    const harness = createHarness(() => ({
      answer: 'must not escape',
      sourceEvidence,
      resultArtifact: null,
    }));
    await assert.rejects(
      harness.executor(operationContext('query', queryParameters())),
      error => error.code === 'worker_result_invalid',
    );
  }
});

test('terminal top-level and result evidence must agree on retrieval facts', async () => {
  const harness = createHarness(() => ({
    state: 'partial',
    result: {
      answer: null,
      sweepOutputs: [],
      sourceEvidence: childEvidence({ returnedTotals: { nodes: 2, edges: 1 } }),
    },
    error: { code: 'provider_incomplete', message: 'short', retryable: true },
    sourceEvidence: childEvidence({ returnedTotals: { nodes: 1, edges: 0 } }),
    resultArtifact: null,
  }));

  await assert.rejects(
    harness.executor(operationContext('pgs', pgsParameters())),
    error => error.code === 'worker_result_invalid',
  );
});

test('failed null results may use canonical baseline evidence without child retrieval facts', async () => {
  const harness = createHarness(() => ({
    state: 'failed',
    result: null,
    error: { code: 'provider_failed', message: 'gone', retryable: true },
    sourceEvidence: null,
    resultArtifact: null,
  }));

  const envelope = await harness.executor(operationContext('pgs', pgsParameters()));

  assert.equal(envelope.state, 'failed');
  assert.equal(envelope.result, null);
  assert.equal(envelope.sourceEvidence.matchOutcome, 'unknown');
  assert.deepEqual(envelope.sourceEvidence.returnedTotals, { nodes: 0, edges: 0 });
});

test('failed non-null results cannot omit child retrieval evidence', async () => {
  const harness = createHarness(() => ({
    state: 'failed',
    result: { answer: null, sweepOutputs: [] },
    error: { code: 'pgs_all_failed', message: 'none', retryable: true },
    sourceEvidence: null,
    resultArtifact: null,
  }));

  await assert.rejects(
    harness.executor(operationContext('pgs', pgsParameters())),
    error => error.code === 'worker_result_invalid',
  );
});

test('non-object executor output fails with a typed worker result error', async () => {
  const harness = createHarness(() => null);

  await assert.rejects(
    harness.executor(operationContext('query', queryParameters())),
    error => error.code === 'worker_result_invalid',
  );
});

test('read-only targets suppress actions and forged sibling ownership is denied', async () => {
  const harness = createHarness();
  const readOnly = operationContext('query', queryParameters({ allowActions: true }), {
    target: { accessMode: 'read-only', ownerAgent: 'forrest', brainId: 'brain-forrest' },
  });
  await harness.executor(readOnly);
  assert.equal(harness.calls[0].options.allowActions, false);
  assert.equal(harness.calls[0].options.mutationPolicy, 'read-only');

  const forgedOwn = operationContext('query', queryParameters({ allowActions: true }), {
    target: { accessMode: 'own', ownerAgent: 'forrest', brainId: 'brain-forrest' },
  });
  await assert.rejects(
    harness.executor(forgedOwn),
    error => error.code === 'access_denied',
  );
  assert.equal(harness.calls.length, 1);
});

test('invalid trusted projections fail before QueryEngine work', async () => {
  const harness = createHarness();
  const queryBase = queryParameters();
  const pgsBase = pgsParameters();
  const invalid = [
    ['unsupported operation', operationContext('search', queryBase)],
    ['missing source', operationContext('query', queryBase, { sourcePin: null })],
    ['non-brain target', operationContext('query', queryBase, { target: { domain: 'owned-run' } })],
    ['query array', operationContext('query', [])],
    ['empty query', operationContext('query', { ...queryBase, query: '   ' })],
    ['long query', operationContext('query', { ...queryBase, query: 'x'.repeat(12_001) })],
    ['bad mode', operationContext('query', { ...queryBase, mode: 'normal' })],
    ['flat provider', operationContext('query', { ...queryBase, provider: 'anthropic' })],
    ['flat model', operationContext('query', { ...queryBase, model: 'claude-sonnet-4-6' })],
    ['partial query pair', operationContext('query', {
      ...queryBase, modelSelection: { provider: 'anthropic' },
    })],
    ['extra query pair key', operationContext('query', {
      ...queryBase,
      modelSelection: { provider: 'anthropic', model: 'claude-sonnet-4-6', fallback: true },
    })],
    ['fractional topK', operationContext('query', { ...queryBase, topK: 1.5 })],
    ['topK over max', operationContext('query', { ...queryBase, topK: 101 })],
    ['string boolean', operationContext('query', { ...queryBase, includeOutputs: 'false' })],
    ['prior context extra', operationContext('query', {
      ...queryBase, priorContext: { query: 'q', answer: 'a', extra: true },
    })],
    ['prior context too long', operationContext('query', {
      ...queryBase, priorContext: { query: 'q', answer: 'a'.repeat(20_000) },
    })],
    ['query with PGS pair', operationContext('query', { ...queryBase, pgsSweep: pgsBase.pgsSweep })],
    ['PGS with query pair', operationContext('pgs', { ...pgsBase, modelSelection: queryBase.modelSelection })],
    ['PGS targeted mode', operationContext('pgs', { ...pgsBase, pgsMode: 'targeted' })],
    ['PGS zero fraction', operationContext('pgs', {
      ...pgsBase, pgsConfig: { sweepFraction: 0 },
    })],
    ['PGS nonfinite fraction', operationContext('pgs', {
      ...pgsBase, pgsConfig: { sweepFraction: Number.NaN },
    })],
    ['PGS extra config key', operationContext('pgs', {
      ...pgsBase, pgsConfig: { sweepFraction: 0.5, maxConcurrentSweeps: 4 },
    })],
    ['PGS partial sweep pair', operationContext('pgs', {
      ...pgsBase, pgsSweep: { provider: 'minimax' },
    })],
  ];

  for (const [label, context] of invalid) {
    await assert.rejects(
      harness.executor(context),
      error => ['invalid_request', 'provider_model_mismatch', 'source_pin_required']
        .includes(error.code),
      label,
    );
  }
  assert.equal(harness.calls.length, 0);
});

test('cancellation preserves the exact signal reason and never releases the pin', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('operator cancelled'), { code: 'cancelled' });
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const harness = createHarness((_query, options) => new Promise((_resolve, reject) => {
    started();
    options.signal.addEventListener('abort', () => {
      reject(new Error('child wrapped the cancellation'));
    }, { once: true });
  }));
  const context = operationContext('query', queryParameters(), { controller });
  const pending = harness.executor(context);
  await startedPromise;
  controller.abort(reason);

  await assert.rejects(pending, error => error === reason);
  assert.equal(context.sourcePin.releaseCount(), 0);
});

test('already-aborted work rejects by identity before QueryEngine execution', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('cancel before start'), { code: 'cancelled' });
  controller.abort(reason);
  const harness = createHarness();
  const context = operationContext('query', queryParameters(), { controller });

  await assert.rejects(harness.executor(context), error => error === reason);
  assert.equal(harness.calls.length, 0);
  assert.equal(context.sourcePin.releaseCount(), 0);
});

test('factory rejects a missing QueryEngine dependency', () => {
  assert.throws(
    () => createQueryOperationExecutor(),
    error => error.code === 'executor_unavailable' && error.retryable === true,
  );
  assert.throws(
    () => createQueryOperationExecutor({ queryEngine: {} }),
    error => error.code === 'executor_unavailable' && error.retryable === true,
  );
});
