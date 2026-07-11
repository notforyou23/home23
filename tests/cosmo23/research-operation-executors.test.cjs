'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createResearchOperationExecutors,
} = require('../../cosmo23/server/lib/research-operation-executors');

function sourcePin() {
  return {
    getEvidence() {
      return { sourceType: 'native', cutoffRevision: 7 };
    },
  };
}

function harness(overrides = {}) {
  const calls = [];
  const run = {
    runId: 'run-1',
    ownerAgent: 'jerry',
    state: 'active',
  };
  const processManager = {
    async createOwnedRun(input) {
      calls.push(['createOwnedRun', input]);
      return { runId: input.runId, ownerAgent: input.ownerAgent };
    },
    async start(runId, options) {
      calls.push(['start', runId, options]);
      return { state: 'active' };
    },
    async continue(runId, parameters, options) {
      calls.push(['continue', runId, parameters, options]);
      return { runId, state: 'active' };
    },
    async stopAndWait(runId, options) {
      calls.push(['stopAndWait', runId, options]);
      return { runId, state: 'stopped', terminal: true };
    },
    async watch(runId, options) {
      calls.push(['watch', runId, options]);
      return { runId, cursor: 9, latest: 9, logs: [] };
    },
    ...overrides.processManager,
  };
  const resolveOwnedRun = overrides.resolveOwnedRun || (async (selector) => {
    calls.push(['resolveOwnedRun', selector]);
    return run;
  });
  const readPinnedIntelligence = overrides.readPinnedIntelligence
    || (async (_source, selection, options) => {
      calls.push(['readPinnedIntelligence', selection, options]);
      return {
        content: { nodes: [{ id: 'n1', content: 'fact' }], edges: [] },
        selection,
        evidence: { sourceType: 'native', cutoffRevision: 7 },
      };
    });
  const createRequesterOutputWriter = overrides.createRequesterOutputWriter
    || (async (input) => {
      calls.push(['createRequesterOutputWriter', input]);
      return { writeAtomic: async () => ({ relativePath: 'research/result.md' }) };
    });
  const compileSectionWithProvider = overrides.compileSectionWithProvider
    || (async (input) => {
      calls.push(['compileSectionWithProvider', input]);
      return {
        state: 'complete',
        result: { relativePath: 'research/result.md' },
        resultArtifact: null,
        error: null,
        sourceEvidence: input.sourceEvidence,
      };
    });
  return {
    calls,
    executors: createResearchOperationExecutors({
      processManager,
      resolveOwnedRun,
      readPinnedIntelligence,
      createRequesterOutputWriter,
      compileSectionWithProvider,
    }),
  };
}

function context(operationType, overrides = {}) {
  return {
    operationId: 'op-1',
    operationType,
    requesterAgent: 'jerry',
    target: { runId: 'run-1' },
    parameters: {},
    signal: new AbortController().signal,
    sourcePin: null,
    reportEvent() {},
    ...overrides,
  };
}

test('registers all six research executors without a query alias', () => {
  const { executors } = harness();
  assert.deepEqual([...executors.keys()].sort(), [
    'research_compile',
    'research_continue',
    'research_intelligence',
    'research_launch',
    'research_stop',
    'research_watch',
  ]);
  assert.equal(executors.has('query'), false);
});

test('research launch derives stable owner/run identity and forwards only approved parameters', async () => {
  const { executors, calls } = harness();
  const parameters = {
    topic: 'durable research',
    context: 'current evidence',
    cycles: 12,
    explorationMode: 'guided',
    analysisDepth: 'deep',
    maxConcurrent: 3,
    primaryModel: 'gpt-5.5',
    primaryProvider: 'openai',
  };
  const result = await executors.get('research_launch')(
    context('research_launch', { target: { domain: 'requester', requesterAgent: 'jerry' }, parameters }),
  );
  assert.equal(result.state, 'complete');
  assert.equal(result.result.runId, 'research-op-1');
  assert.deepEqual(calls[0][1], {
    runId: 'research-op-1',
    ownerAgent: 'jerry',
    operationId: 'op-1',
    topic: 'durable research',
    parameters,
  });
  assert.equal(Object.hasOwn(calls[0][1].parameters, 'enableWebSearch'), false);
  assert.equal(calls[1][0], 'start');
});

test('owned-run operations re-resolve the exact owner and preserve the watch cursor', async () => {
  const { executors, calls } = harness();
  const canonicalTarget = {
    domain: 'owned-run',
    runId: 'run-1',
    canonicalRoot: '/tmp/run-1',
    ownerAgent: 'jerry',
    runState: 'active',
    catalogRevision: 'a'.repeat(64),
    route: '/api/research/runs/run-1',
    mutationBoundaries: [],
  };
  const result = await executors.get('research_watch')(context('research_watch', {
    target: canonicalTarget,
    parameters: { after: 7, limit: 25, filter: 'errors' },
  }));
  assert.equal(result.state, 'complete');
  assert.deepEqual(calls[0], [
    'resolveOwnedRun', { runId: 'run-1', requesterAgent: 'jerry' },
  ]);
  assert.deepEqual(calls[1], [
    'watch', 'run-1', { after: 7, limit: 25, filter: 'errors' },
  ]);
});

test('owned-run selectors and owner mismatches fail before mutation', async () => {
  for (const target of [
    undefined,
    {},
    { runId: '*' },
    { brainId: 'run-1' },
    { runId: 'run-1', extra: true },
  ]) {
    const { executors, calls } = harness();
    const result = await executors.get('research_stop')(
      context('research_stop', { target }),
    );
    assert.equal(result.error.code, 'invalid_request');
    assert.equal(calls.length, 0);
  }

  const { executors, calls } = harness({
    resolveOwnedRun: async () => ({ runId: 'run-1', ownerAgent: 'cosmo' }),
  });
  const denied = await executors.get('research_continue')(
    context('research_continue'),
  );
  assert.equal(denied.error.code, 'access_denied');
  assert.equal(calls.length, 0);
});

test('research intelligence reads only the supplied source pin with exact bounded options', async () => {
  const pin = sourcePin();
  const { executors, calls } = harness();
  const result = await executors.get('research_intelligence')(
    context('research_intelligence', {
      target: { domain: 'brain' },
      parameters: { include: ['goals', 'insights'] },
      sourcePin: pin,
    }),
  );
  assert.equal(result.state, 'complete');
  assert.deepEqual(calls[0][1], {
    kind: 'intelligence', include: ['goals', 'insights'],
  });
  assert.deepEqual(calls[0][2], {
    signal: result.result ? calls[0][2].signal : null,
    maxNodes: 2_000,
    maxEdges: 8_000,
    maxBytes: 8 * 1024 * 1024,
  });
  assert.deepEqual(result.sourceEvidence, pin.getEvidence());
});

test('research compile validates the writer before provider work and keeps its operation type', async () => {
  const pin = sourcePin();
  const { executors, calls } = harness();
  const events = [];
  const ctx = context('research_compile', {
    parameters: {
      kind: 'section', section: 'goal', sectionId: 'goal-7', focus: 'evidence',
    },
    sourcePin: pin,
    reportEvent(event) { events.push(event); },
  });
  const result = await executors.get('research_compile')(ctx);
  assert.equal(result.state, 'complete');
  assert.deepEqual(calls.map((entry) => entry[0]), [
    'readPinnedIntelligence',
    'createRequesterOutputWriter',
    'compileSectionWithProvider',
  ]);
  assert.deepEqual(calls[0][1], {
    kind: 'section', section: 'goal', sectionId: 'goal-7',
  });
  assert.equal(calls[2][1].context.operationType, 'research_compile');
  assert.equal(calls[2][1].writer.writeAtomic instanceof Function, true);
  assert.deepEqual(events, [
    { type: 'progress', phase: 'research_compile', stage: 'source_projection_complete' },
    { type: 'progress', phase: 'research_compile', stage: 'requester_artifact_published' },
  ]);
});

test('missing section and writer prevalidation failure prevent provider work', async () => {
  const missing = harness({ readPinnedIntelligence: async () => null });
  const missingResult = await missing.executors.get('research_compile')(
    context('research_compile', {
      parameters: { kind: 'section', section: 'goal', sectionId: 'missing' },
      sourcePin: sourcePin(),
    }),
  );
  assert.equal(missingResult.error.code, 'section_not_found');
  assert.equal(missing.calls.length, 0);

  let providerCalls = 0;
  const unsafe = harness({
    createRequesterOutputWriter: async () => {
      throw Object.assign(new Error('swapped'), { code: 'output_boundary_changed' });
    },
    compileSectionWithProvider: async () => {
      providerCalls += 1;
    },
  });
  await assert.rejects(
    unsafe.executors.get('research_compile')(context('research_compile', {
      parameters: { kind: 'brain' }, sourcePin: sourcePin(),
    })),
    { code: 'output_boundary_changed' },
  );
  assert.equal(providerCalls, 0);
});

test('cancellation before execution prevents reads, writes, and provider calls', async () => {
  let calls = 0;
  const { executors } = harness({
    readPinnedIntelligence: async () => { calls += 1; },
    createRequesterOutputWriter: async () => { calls += 1; },
    compileSectionWithProvider: async () => { calls += 1; },
  });
  const controller = new AbortController();
  controller.abort(Object.assign(new Error('cancelled'), { code: 'operation_cancelled' }));
  await assert.rejects(
    executors.get('research_compile')(context('research_compile', {
      parameters: { kind: 'brain' }, sourcePin: sourcePin(), signal: controller.signal,
    })),
    { code: 'operation_cancelled' },
  );
  assert.equal(calls, 0);
});
