const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function operation(overrides = {}) {
  const state = overrides.state || 'complete';
  return {
    operationId: overrides.operationId || 'op_acceptance_0001',
    requestId: 'request-acceptance',
    operationType: overrides.operationType || 'query',
    requestParameters: { query: 'authoritative canary' },
    parameters: { query: 'authoritative canary' },
    canonicalEvidence: true,
    recordVersion: overrides.eventSequence ?? 2,
    eventSequence: overrides.eventSequence ?? 2,
    requesterAgent: 'jerry',
    target: { domain: 'brain', brainId: 'brain-jerry', ownerAgent: 'jerry', accessMode: 'own' },
    state,
    phase: state === 'running' ? 'provider' : state,
    startedAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:02.000Z',
    completedAt: ['queued', 'running'].includes(state) ? null : '2026-07-10T00:00:02.000Z',
    lastProviderActivityAt: '2026-07-10T00:00:02.000Z',
    lastProgressAt: '2026-07-10T00:00:01.000Z',
    result: overrides.result ?? { answer: 'authoritative answer' },
    resultHandle: ['queued', 'running'].includes(state) ? null : 'brres_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    resultArtifact: null,
    error: overrides.error ?? null,
    sourceEvidence: overrides.sourceEvidence ?? {
      sourceHealth: 'healthy',
      matchOutcome: 'matched',
      deltaWatermark: { revision: 7 },
      authoritativeTotals: { nodes: 140_086, edges: 456_709 },
      selectedBrain: 'brain-jerry',
    },
    sourcePinDescriptor: null,
    sourcePinDigest: null,
    sourcePinReleasedAt: null,
    resultExpiresAt: null,
    resultExpiredAt: null,
    metadataExpiresAt: null,
    attachmentState: 'closed',
    ...overrides,
  };
}

function envelope(value) {
  return {
    operationId: value.operationId,
    state: value.state,
    result: value.result,
    resultHandle: value.resultHandle,
    resultArtifact: value.resultArtifact,
    error: value.error,
    sourceEvidence: value.sourceEvidence,
  };
}

function notification(value, type = value.state === 'running' ? 'progress' : 'terminal') {
  return {
    type,
    operationId: value.operationId,
    eventSequence: value.eventSequence,
    sequence: value.eventSequence,
    at: value.updatedAt,
    state: value.state,
    phase: value.phase,
    updatedAt: value.updatedAt,
    lastProviderActivityAt: value.lastProviderActivityAt,
    lastProgressAt: value.lastProgressAt,
  };
}

async function fixture(authority = 'live') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-live-smoke-')));
  const receiptRunDir = path.join(root, 'receipt-run');
  const isolatedStore = path.join(root, 'isolated-store');
  await fs.mkdir(receiptRunDir);
  await fs.mkdir(isolatedStore);
  return {
    root,
    isolatedStore,
    context: {
      receiptRunDir,
      receiptRunId: 'brain-smoke-fixture',
      authority,
      implementationCommit: 'a'.repeat(40),
      hostname: 'fixture-host',
      startedAt: '2026-07-10T00:00:00.000Z',
    },
  };
}

async function canaryReceipt(state, authority = state.context.authority) {
  const { canonicalReceiptRow } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const file = path.join(state.context.receiptRunDir, `canary-${authority}.json`);
  const row = canonicalReceiptRow({ ...state.context, authority }, {
    helper: 'live-brain-tools-smoke',
    scenario: 'discover-canary',
    receiptKind: 'operation-terminal',
    operationId: 'op_canary_0001',
    operationType: 'search',
    state: 'complete',
    protectedResultRead: true,
    requesterAgent: 'jerry',
    authorizedEndpoint: authority === 'live' ? 'http://fixture' : null,
    isolatedStore: authority === 'live' ? null : state.isolatedStore,
    query: 'authoritative canary',
    nodeId: 'n-canary',
    sourceRevision: 7,
    sourceHealth: 'healthy',
    selectedBrain: 'brain-jerry',
  });
  await fs.writeFile(file, `${JSON.stringify(row)}\n`);
  return file;
}

test('production client and real brain_query tool survive SSE progress, EOF reconnect, and terminal readback', async (t) => {
  const {
    QUERY_WAIT_MS,
    PGS_WAIT_MS,
    createClientOptions,
    loadProductionModules,
  } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const modules = await loadProductionModules();
  const activities = [];
  const queued = operation({ state: 'queued', eventSequence: 0, result: null, sourceEvidence: null });
  const running = operation({ state: 'running', eventSequence: 1, result: null });
  const terminal = operation();
  let eventCalls = 0;
  let statusCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (init.method === 'POST') return new Response(JSON.stringify(queued));
    if (parsed.pathname.endsWith('/result')) return new Response(JSON.stringify(envelope(terminal)));
    if (parsed.pathname.endsWith('/events')) {
      eventCalls += 1;
      const value = eventCalls === 1 ? running : terminal;
      return new Response(`data: ${JSON.stringify(notification(value))}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    if (parsed.pathname.endsWith(`/${terminal.operationId}`)) {
      statusCalls += 1;
      return new Response(JSON.stringify(eventCalls >= 2 ? terminal : running));
    }
    return new Response('', { status: 404 });
  };
  const options = createClientOptions({
    baseUrl: 'http://fixture', callerAgent: 'jerry', values: {}, fetchImpl,
    onActivity: (activity) => activities.push(activity),
  });
  assert.equal(options.queryWaitMs, 5_400_000);
  assert.equal(options.pgsWaitMs, 21_600_000);
  assert.equal(options.queryWaitMs, QUERY_WAIT_MS);
  assert.equal(options.pgsWaitMs, PGS_WAIT_MS);
  const client = new modules.BrainOperationsClient({ ...options, reconnectDelayMs: 1 });
  const controller = new AbortController();
  const result = await modules.brainQueryTool.execute({ query: 'authoritative canary' }, {
    turnRuntime: {
      turnId: 'acceptance-turn', abortController: controller,
      signal: controller.signal, brainOperations: client, onOperationActivity() {},
    },
    brainOperations: client,
    agentName: 'jerry',
  });
  assert.equal(result.is_error, undefined);
  assert.equal(result.metadata.operationId, terminal.operationId);
  assert.equal(result.metadata.state, 'complete');
  assert.equal(eventCalls, 2);
  assert.ok(statusCalls >= 2);
  assert.deepEqual(activities.map((entry) => entry.sequence), [1, 2]);
});

test('large pinned PGS partial retains canonical null-answer sweep outputs and exact source revision', async (t) => {
  const { executeScenario, loadProductionModules } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const modules = await loadProductionModules();
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const canary = await canaryReceipt(state);
  const sweepOutputs = Array.from({ length: 128 }, (_, index) => ({
    workUnitId: `work-${String(index).padStart(3, '0')}`,
    partitionId: `partition-${String(index).padStart(3, '0')}`,
    output: `bounded sweep evidence ${index}`,
    provider: 'fixture-provider',
    model: 'fixture-model',
  }));
  const partial = operation({
    operationType: 'pgs',
    state: 'partial',
    result: {
      answer: null,
      sweepOutputs,
      metadata: { pgs: { successfulSweeps: sweepOutputs.length, retryablePartitions: ['retry-001'] } },
    },
    error: { code: 'provider_partial', message: 'one partition remains retryable', retryable: true },
  });
  const client = {
    async query() { return partial; },
    async inspectOperation() { return partial; },
  };
  const row = await executeScenario({
    scenario: 'pgs', modules, client,
    values: {
      'canary-receipt': canary,
      'target-brain': 'brain-jerry',
      'require-authoritative-nodes': '100000',
      'pgs-sweep-selection': JSON.stringify({ provider: 'fixture-provider', model: 'fixture-model' }),
      'pgs-synth-selection': JSON.stringify({ provider: 'fixture-provider', model: 'fixture-model' }),
    },
    context: state.context, baseUrl: 'http://fixture', callerAgent: 'jerry',
    signal: new AbortController().signal,
  });
  assert.equal(row.state, 'partial');
  assert.equal(row.result.answerPresent, false);
  assert.equal(row.result.sweepOutputCount, 128);
  assert.equal(row.sourceRevision, 7);
  assert.equal(row.liveProviderLargePgsGatePassed, true);
});

test('authoritative canary discovery precedes query and typed failures remain failures', async (t) => {
  const { executeScenario, loadProductionModules } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const modules = await loadProductionModules();
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const calls = [];
  const searchTerminal = operation({ operationId: 'op_search_0001', operationType: 'search' });
  const client = {
    async resolveTarget() { calls.push('resolve'); return { id: 'brain-jerry', ownerAgent: 'jerry' }; },
    async graph() { calls.push('graph'); return { nodes: [{ id: 'n-canary', concept: 'authoritative canary phrase' }] }; },
    async search() {
      calls.push('search');
      return { operationId: searchTerminal.operationId, results: [{ id: 'n-canary' }], sourceEvidence: searchTerminal.sourceEvidence };
    },
    async inspectOperation() { calls.push('protected-result'); return searchTerminal; },
  };
  const discovered = await executeScenario({
    scenario: 'discover-canary', modules, client, values: {}, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal: new AbortController().signal,
  });
  assert.deepEqual(calls, ['resolve', 'graph', 'search', 'protected-result']);
  assert.equal(discovered.nodeId, 'n-canary');
  assert.equal(discovered.sourceRevision, 7);

  const canary = await canaryReceipt(state);
  await assert.rejects(executeScenario({
    scenario: 'direct-query', modules,
    client: { async query() { throw Object.assign(new Error('hard deadline'), { code: 'operation_timeout' }); } },
    values: { 'canary-receipt': canary }, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal: new AbortController().signal,
  }), (error) => error.code === 'operation_timeout');
});

test('isolated synthesis reconnect and MCP disabled/unreachable outcomes are typed', async (t) => {
  const { executeScenario } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const state = await fixture('isolated-controlled');
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const values = { 'isolated-store': state.isolatedStore };
  const completed = operation({
    operationId: 'op_synthesis_0001', operationType: 'synthesis',
    result: { generationMarker: 'generation-7' },
  });
  let reattached = 0;
  const synthesis = await executeScenario({
    scenario: 'synthesis-reconnect', modules: {},
    client: {
      async synthesize() { return operation({ ...completed, state: 'running', result: null }); },
      async reattachSynthesis() { reattached += 1; return completed; },
      async inspectOperation() { return completed; },
    },
    values, context: state.context, baseUrl: 'http://isolated', callerAgent: 'jerry',
    signal: new AbortController().signal,
  });
  assert.equal(reattached, 1);
  assert.equal(synthesis.state, 'complete');
  assert.equal(synthesis.generationMarker, 'generation-7');

  const disabled = await executeScenario({
    scenario: 'mcp-unavailable', modules: {}, client: {},
    values: { ...values, 'expect-reason': 'mcp_disabled' }, context: state.context,
    baseUrl: 'http://isolated', callerAgent: 'jerry', signal: new AbortController().signal,
    fetchImpl: async () => new Response(JSON.stringify({ mcp: { reason: 'mcp_disabled' } }), {
      status: 503, headers: { 'content-type': 'application/json' },
    }),
  });
  assert.equal(disabled.reason, 'mcp_disabled');
  const unreachable = await executeScenario({
    scenario: 'mcp-unavailable', modules: {}, client: {},
    values: { ...values, 'expect-reason': 'mcp_unreachable' }, context: state.context,
    baseUrl: 'http://isolated', callerAgent: 'jerry', signal: new AbortController().signal,
    fetchImpl: async () => { throw new TypeError('connection refused'); },
  });
  assert.equal(unreachable.reason, 'mcp_unreachable');
});

test('receipt verification rejects duplicate terminal rows and conflicting identity metadata', async (t) => {
  const { canonicalReceiptRow } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const { verifyReceiptManifest } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const operationId = 'op_receipt_0001';
  const terminal = operation({ operationId });
  const terminalRow = canonicalReceiptRow(state.context, {
    helper: 'live-brain-tools-smoke', scenario: 'direct-query', receiptKind: 'operation-terminal',
    operationId, operationType: 'query', state: 'complete', protectedResultRead: true,
    requesterAgent: 'jerry', authorizedEndpoint: 'http://fixture', isolatedStore: null,
  });
  const receipt = path.join(state.context.receiptRunDir, 'operation.jsonl');
  await fs.writeFile(receipt, `${JSON.stringify(terminalRow)}\n`);
  const manifest = path.join(state.context.receiptRunDir, 'identity.json');
  await fs.writeFile(manifest, JSON.stringify({ groups: { live: [{
    operationId, receipt: 'operation.jsonl', authority: 'live',
    requesterAgent: 'jerry', authorizedEndpoint: 'http://fixture',
  }] } }));
  class FixtureClient {
    async inspectOperation() { return terminal; }
  }
  const valid = await verifyReceiptManifest({
    manifestPath: manifest, modules: { BrainOperationsClient: FixtureClient },
    context: state.context, values: {}, callerAgent: 'jerry', signal: new AbortController().signal,
  });
  assert.equal(valid.observed.length, 1);
  await fs.appendFile(receipt, `${JSON.stringify(terminalRow)}\n`);
  await assert.rejects(verifyReceiptManifest({
    manifestPath: manifest, modules: { BrainOperationsClient: FixtureClient },
    context: state.context, values: {}, callerAgent: 'jerry', signal: new AbortController().signal,
  }), (error) => error.code === 'receipt_terminal_duplicate');

  const conflictingEvent = canonicalReceiptRow({ ...state.context, authority: 'isolated-controlled' }, {
    helper: 'live-brain-tools-smoke', scenario: 'direct-query', receiptKind: 'operation-event',
    operationId, requesterAgent: 'jerry', protectedResultRead: false,
  });
  await fs.writeFile(receipt, `${JSON.stringify(conflictingEvent)}\n${JSON.stringify(terminalRow)}\n`);
  await assert.rejects(verifyReceiptManifest({
    manifestPath: manifest, modules: { BrainOperationsClient: FixtureClient },
    context: state.context, values: {}, callerAgent: 'jerry', signal: new AbortController().signal,
  }), (error) => error.code === 'receipt_identity_conflict');
});
