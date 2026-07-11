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
    sourcePinDescriptor: { version: 1, sourceRevision: 7, digest: 'pin-descriptor' },
    sourcePinDigest: `sha256:${'b'.repeat(64)}`,
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
    activityLog: [{
      operationId: partial.operationId,
      type: 'provider_call_terminal',
      eventSequence: 9,
    }],
  });
  assert.equal(row.state, 'partial');
  assert.equal(row.result.answerPresent, false);
  assert.equal(row.result.sweepOutputCount, 128);
  assert.equal(row.result.sweepOutputs.length, 128);
  assert.match(row.result.sweepOutputs[0].outputSha256, /^[a-f0-9]{64}$/);
  assert.equal(row.result.metadata.pgs.successfulSweeps, 128);
  assert.equal(row.sourceRevision, 7);
  assert.equal(row.providerTerminalValidated, true);
  assert.equal(row.authoritativeNodeCount, 140_086);
  assert.equal(row.sourcePinDescriptor.sourceRevision, 7);
  assert.match(row.sourcePinDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(row.liveProviderLargePgsGatePassed, true);
  await assert.rejects(executeScenario({
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
    activityLog: [],
  }), (error) => error.code === 'provider_terminal_unproven');
});

test('SSE receipts preserve production event type and monotonic eventSequence', async (t) => {
  const { flushActivity } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const output = path.join(state.context.receiptRunDir, 'pgs-events.jsonl');
  await flushActivity(state.context, output, [
    {
      source: 'brain_operation', operationId: 'op_pgs_events', type: 'progress',
      eventSequence: 1, sequence: 1, state: 'running', phase: 'sweep',
      updatedAt: '2026-07-10T00:00:01.000Z', lastProviderActivityAt: null,
      lastProgressAt: '2026-07-10T00:00:01.000Z',
    },
    {
      source: 'brain_operation', operationId: 'op_pgs_events', type: 'heartbeat',
      eventSequence: 2, sequence: 2, state: 'running', phase: 'synthesize',
      updatedAt: '2026-07-10T00:00:02.000Z', lastProviderActivityAt: '2026-07-10T00:00:02.000Z',
      lastProgressAt: '2026-07-10T00:00:01.000Z',
    },
  ], 'jerry', 'pgs', 'live');
  const rows = (await fs.readFile(output, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(({ type, eventSequence }) => ({ type, eventSequence })), [
    { type: 'progress', eventSequence: 1 },
    { type: 'heartbeat', eventSequence: 2 },
  ]);
  assert.equal(rows.some((row) => Object.hasOwn(row, 'sequence')), false);
  assert.deepEqual(rows.map((row) => row.lastProgressAt), [
    '2026-07-10T00:00:01.000Z',
    '2026-07-10T00:00:01.000Z',
  ]);
});

test('authoritative canary discovery precedes query and typed failures remain failures', async (t) => {
  const { executeScenario, loadProductionModules } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const modules = await loadProductionModules();
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const calls = [];
  let graphRequest;
  const searchTerminal = operation({ operationId: 'op_search_0001', operationType: 'search' });
  const client = {
    async resolveTarget() { calls.push('resolve'); return { id: 'brain-jerry', ownerAgent: 'jerry' }; },
    async graph(request) {
      calls.push('graph');
      graphRequest = request;
      return { nodes: [{ id: 'n-canary', concept: 'authoritative canary phrase' }] };
    },
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
  assert.equal(graphRequest.edgeLimit, 1);
  assert.equal(discovered.nodeId, 'n-canary');
  assert.equal(discovered.sourceRevision, 7);

  const { writeJsonReceipt } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const consumedCanary = path.join(state.context.receiptRunDir, 'discovered-canary.json');
  await writeJsonReceipt(state.context, consumedCanary, discovered);
  const queryTerminal = operation({ operationId: 'op_query_after_canary_0001' });
  const consumed = await executeScenario({
    scenario: 'direct-query', modules,
    client: {
      async query() { return queryTerminal; },
      async inspectOperation() { return queryTerminal; },
    },
    values: { 'canary-receipt': consumedCanary }, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal: new AbortController().signal,
    activityLog: [{
      operationId: queryTerminal.operationId,
      type: 'provider_call_terminal',
      eventSequence: 4,
    }],
  });
  assert.equal(consumed.canaryNodeId, 'n-canary');
  assert.equal(consumed.canarySourceRevision, 7);

  const canary = await canaryReceipt(state);
  await assert.rejects(executeScenario({
    scenario: 'direct-query', modules,
    client: { async query() { throw Object.assign(new Error('hard deadline'), { code: 'operation_timeout' }); } },
    values: { 'canary-receipt': canary }, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal: new AbortController().signal,
  }), (error) => error.code === 'operation_timeout');
});

test('healthy model discovery performs exact direct, PGS sweep, and PGS synthesis pair probes', async () => {
  const { discoverHealthyModels } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/api/providers/probe' && init.method === 'POST') {
      const request = JSON.parse(init.body);
      calls.push(request);
      const pairs = {
        'direct-query': { provider: 'direct-provider', model: 'query-model' },
        'pgs-sweep': { provider: 'sweep-provider', model: 'sweep-model' },
        'pgs-synthesis': { provider: 'synth-provider', model: 'synth-model' },
      };
      return new Response(JSON.stringify({
        healthy: true,
        purpose: request.purpose,
        pair: pairs[request.purpose],
        requestedPair: pairs[request.purpose],
        observedPair: pairs[request.purpose],
        terminalReceived: true,
      }));
    }
    return new Response('', { status: 404 });
  };
  const selected = await discoverHealthyModels('http://cosmo-fixture', fetchImpl);
  assert.deepEqual(calls, [
    { purpose: 'direct-query' },
    { purpose: 'pgs-sweep' },
    { purpose: 'pgs-synthesis' },
  ]);
  assert.deepEqual(selected.modelSelection, { provider: 'direct-provider', model: 'query-model' });
  assert.deepEqual(selected.pgsSweep, { provider: 'sweep-provider', model: 'sweep-model' });
  assert.deepEqual(selected.pgsSynth, { provider: 'synth-provider', model: 'synth-model' });
  assert.equal(selected.probes.every((probe) => probe.healthy && probe.terminalReceived), true);
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
  await assert.rejects(executeScenario({
    scenario: 'synthesis-reconnect', modules: {},
    client: {
      async synthesize() { return operation({ ...completed, state: 'running', result: null }); },
      async reattachSynthesis() { reattached += 1; return completed; },
      async inspectOperation() { return completed; },
    },
    values, context: state.context, baseUrl: 'http://isolated', callerAgent: 'jerry',
    signal: new AbortController().signal,
  }), (error) => error.code === 'provider_terminal_unproven');
  reattached = 0;
  const synthesis = await executeScenario({
    scenario: 'synthesis-reconnect', modules: {},
    client: {
      async synthesize() { return operation({ ...completed, state: 'running', result: null }); },
      async reattachSynthesis() { reattached += 1; return completed; },
      async inspectOperation() { return completed; },
    },
    values, context: state.context, baseUrl: 'http://isolated', callerAgent: 'jerry',
    signal: new AbortController().signal,
    activityLog: [{
      operationId: completed.operationId,
      type: 'provider_call_terminal',
      eventSequence: 7,
    }],
  });
  assert.equal(reattached, 1);
  assert.equal(synthesis.state, 'complete');
  assert.equal(synthesis.generationMarker, 'generation-7');
  assert.equal(synthesis.providerTerminalValidated, true);
  assert.equal(synthesis.lastProgressAt, completed.lastProgressAt);

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
  const { BrainOperationStore } = require('../../engine/src/dashboard/brain-operations/operation-store.js');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const urls = { jerry: 'http://jerry.fixture', forrest: 'http://forrest.fixture' };
  const boundaries = (root) => ['brain', 'run', 'pgs', 'session', 'cache', 'export', 'agency']
    .map((kind) => ({ kind, path: kind === 'brain' || kind === 'run' ? root : path.join(root, kind) }));
  const target = (agent) => ({
    domain: 'brain', brainId: `brain-${agent}`, canonicalRoot: `/fixture/${agent}/brain`,
    accessMode: 'own', ownerAgent: agent, displayName: agent, kind: 'resident',
    lifecycle: 'resident', catalogRevision: 'catalog-fixture-v1', route: `/api/brain/${agent}`,
    mutationBoundaries: boundaries(`/fixture/${agent}/brain`),
  });
  const sourceEvidence = (agent, operationId) => ({
    selectedAgent: agent, selectedBrain: `brain-${agent}`, route: 'fixture-readback',
    identity: { requesterAgent: agent, targetAgent: agent, brainId: `brain-${agent}`, operationId },
    deltaWatermark: { revision: 7, epoch: 'e7', appliedRecords: 0 },
    authoritativeTotals: { nodes: 3, edges: 2 }, returnedTotals: { nodes: 1, edges: 0 },
    sourceHealth: 'healthy', matchOutcome: 'matches',
  });
  const liveRecord = (agent, letter) => {
    const operationId = `brop_${letter.repeat(32)}`;
    return operation({
      operationId, requesterAgent: agent, target: target(agent), result: {}, resultHandle: null,
      sourceEvidence: sourceEvidence(agent, operationId),
    });
  };
  const jerry = liveRecord('jerry', 'J');
  const forrest = liveRecord('forrest', 'F');
  const store = new BrainOperationStore({ root: state.isolatedStore, requesterAgent: 'fixture-agent' });
  const created = await store.create({
    requestId: 'isolated-receipt-fixture', requesterAgent: 'fixture-agent',
    target: target('fixture-agent'), operationType: 'query',
    requestParameters: { query: 'receipt fixture' }, parameters: { query: 'receipt fixture' },
    sourcePinDescriptor: null, sourcePinDigest: null, canonicalEvidence: true,
  });
  const withResult = await store.setResult(created.record.operationId, {
    expectedVersion: created.record.recordVersion, result: {},
  });
  const isolatedEvidence = sourceEvidence('fixture-agent', created.record.operationId);
  const isolated = {
    ...(await store.transition(created.record.operationId, {
      expectedVersion: withResult.recordVersion, state: 'complete', phase: 'terminal',
      error: null, sourceEvidence: isolatedEvidence,
    })),
    result: {}, sourceEvidence: isolatedEvidence,
  };
  const projectedEmptyResult = {
    answerPresent: false, answerBytes: 0, answerSha256: null,
    sweepOutputCount: null, sweepOutputs: null, metadata: null,
  };
  const receiptRow = (context, record, authorizedEndpoint, isolatedStore) => canonicalReceiptRow(context, {
    helper: 'live-brain-tools-smoke', scenario: 'direct-query', receiptKind: 'operation-terminal',
    operationId: record.operationId, operationType: 'query', state: 'complete',
    protectedResultRead: true, requesterAgent: record.requesterAgent,
    authorizedEndpoint, isolatedStore, target: record.target, resultHandle: record.resultHandle,
    resultArtifact: record.resultArtifact, sourcePinDescriptor: record.sourcePinDescriptor,
    sourcePinDigest: record.sourcePinDigest, sourceEvidence: record.sourceEvidence,
    error: record.error, result: projectedEmptyResult,
  });
  const jerryReceipt = path.join(state.context.receiptRunDir, 'jerry.jsonl');
  const forrestReceipt = path.join(state.context.receiptRunDir, 'forrest.jsonl');
  const isolatedReceipt = path.join(state.context.receiptRunDir, 'isolated.jsonl');
  const terminalRow = receiptRow(state.context, jerry, urls.jerry, null);
  await fs.writeFile(jerryReceipt, `${JSON.stringify(terminalRow)}\n`);
  await fs.writeFile(forrestReceipt, `${JSON.stringify(receiptRow(
    state.context, forrest, urls.forrest, null,
  ))}\n`);
  await fs.writeFile(isolatedReceipt, `${JSON.stringify(receiptRow(
    { ...state.context, authority: 'isolated-controlled' }, isolated, null, state.isolatedStore,
  ))}\n`);
  const manifest = path.join(state.context.receiptRunDir, 'identity.json');
  await fs.writeFile(manifest, JSON.stringify({
    schemaVersion: 1, receiptRunId: state.context.receiptRunId,
    authorities: ['live', 'isolated-controlled'], auditRoot: state.context.receiptRunDir,
    createdAt: '2026-07-10T00:00:00.000Z',
    groups: {
      jerryLive: [{ operationId: jerry.operationId, authority: 'live', requesterAgent: 'jerry',
        receipt: 'jerry.jsonl', isolatedStore: null, authorizedEndpoint: urls.jerry }],
      forrestLive: [{ operationId: forrest.operationId, authority: 'live', requesterAgent: 'forrest',
        receipt: 'forrest.jsonl', isolatedStore: null, authorizedEndpoint: urls.forrest }],
      isolatedControlled: [{ operationId: isolated.operationId, authority: 'isolated-controlled',
        requesterAgent: 'fixture-agent', receipt: 'isolated.jsonl',
        isolatedStore: state.isolatedStore, authorizedEndpoint: null }],
    },
  }));
  const liveRecords = new Map([[urls.jerry, jerry], [urls.forrest, forrest]]);
  const clientFactory = ({ baseUrl, callerAgent }) => ({
    async inspectOperation(operationId) {
      const record = liveRecords.get(baseUrl);
      if (!record || record.operationId !== operationId || record.requesterAgent !== callerAgent) {
        throw Object.assign(new Error('access_denied'), { code: 'access_denied' });
      }
      return record;
    },
  });
  const verify = () => verifyReceiptManifest({
    manifestPath: manifest, modules: {}, context: state.context,
    values: { 'base-url': urls.jerry, 'forrest-base-url': urls.forrest },
    callerAgent: 'jerry', signal: new AbortController().signal, clientFactory,
  });
  const valid = await verify();
  assert.equal(valid.observed.length, 3);
  await fs.appendFile(jerryReceipt, `${JSON.stringify(terminalRow)}\n`);
  await assert.rejects(verify(), (error) => error.code === 'receipt_terminal_duplicate');

  const conflictingEvent = canonicalReceiptRow({ ...state.context, authority: 'isolated-controlled' }, {
    helper: 'live-brain-tools-smoke', scenario: 'direct-query', receiptKind: 'operation-event',
    operationId: jerry.operationId, requesterAgent: 'jerry', protectedResultRead: false,
  });
  await fs.writeFile(jerryReceipt, `${JSON.stringify(conflictingEvent)}\n${JSON.stringify(terminalRow)}\n`);
  await assert.rejects(verify(), (error) => error.code === 'receipt_identity_conflict');
});

test('artifact manifest fails closed on malformed JSON and verifies detached digest, tags, hashes, and identities', async (t) => {
  const { canonicalReceiptRow } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const {
    buildArtifactManifest,
    verifyArtifactManifest,
  } = await import('../../scripts/live-brain-tools-smoke.mjs');

  const malformed = await fixture();
  t.after(() => fs.rm(malformed.root, { recursive: true, force: true }));
  await fs.mkdir(path.join(malformed.context.receiptRunDir, 'live'));
  await fs.writeFile(path.join(malformed.context.receiptRunDir, 'live', 'broken.json'), '{broken');
  await assert.rejects(buildArtifactManifest({
    smokeRoot: malformed.context.receiptRunDir,
    output: path.join(malformed.context.receiptRunDir, 'artifact-manifest.json'),
    context: malformed.context,
  }), (error) => error.code === 'artifact_json_invalid');

  const emptyInventory = await fixture();
  t.after(() => fs.rm(emptyInventory.root, { recursive: true, force: true }));
  await fs.mkdir(path.join(emptyInventory.context.receiptRunDir, 'live'));
  await fs.writeFile(path.join(emptyInventory.context.receiptRunDir, 'live', 'raw.txt'), 'raw only\n');
  await assert.rejects(buildArtifactManifest({
    smokeRoot: emptyInventory.context.receiptRunDir,
    output: path.join(emptyInventory.context.receiptRunDir, 'artifact-manifest.json'),
    context: emptyInventory.context,
  }), (error) => error.code === 'operation_inventory_empty');

  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const live = path.join(state.context.receiptRunDir, 'live');
  const isolated = path.join(state.context.receiptRunDir, 'isolated-controlled');
  await fs.mkdir(live);
  await fs.mkdir(isolated);
  const liveReceipt = canonicalReceiptRow(state.context, {
    helper: 'fixture', receiptKind: 'operation-terminal', operationId: 'op_artifact_live_0001',
    operationType: 'query', state: 'complete', requesterAgent: 'jerry',
    protectedResultRead: true, authorizedEndpoint: 'http://fixture', isolatedStore: null,
  });
  const isolatedContext = { ...state.context, authority: 'isolated-controlled' };
  const isolatedReceipt = canonicalReceiptRow(isolatedContext, {
    helper: 'fixture', receiptKind: 'operation-terminal', operationId: 'op_artifact_fixture_0001',
    operationType: 'query', state: 'complete', requesterAgent: 'acceptance-fixture',
    protectedResultRead: true, authorizedEndpoint: null, isolatedStore: state.isolatedStore,
  });
  await fs.writeFile(path.join(live, 'operation.jsonl'), `${JSON.stringify(liveReceipt)}\n`);
  await fs.writeFile(path.join(isolated, 'operation.jsonl'), `${JSON.stringify(isolatedReceipt)}\n`);
  await fs.writeFile(path.join(live, 'raw.txt'), 'third-party capture\n');
  const manifestPath = path.join(state.context.receiptRunDir, 'artifact-manifest.json');
  const built = await buildArtifactManifest({
    smokeRoot: state.context.receiptRunDir,
    output: manifestPath,
    context: state.context,
  });
  assert.equal(built.artifacts.length, 3);
  assert.ok(built.artifacts.every((entry) => entry.receiptRunId === state.context.receiptRunId
    && ['live', 'isolated-controlled'].includes(entry.authority)
    && entry.dev && entry.ino && Number.isSafeInteger(entry.nlink)
    && /^[a-f0-9]{64}$/.test(entry.sha256)));
  const verified = await verifyArtifactManifest({ manifestPath, context: state.context });
  assert.equal(verified.artifactCount, 3);
  await fs.appendFile(path.join(live, 'raw.txt'), 'tamper');
  await assert.rejects(
    verifyArtifactManifest({ manifestPath, context: state.context }),
    (error) => error.code === 'artifact_identity_mismatch',
  );

  await fs.writeFile(path.join(live, 'raw.txt'), 'third-party capture\n');
  await fs.writeFile(
    path.join(state.context.receiptRunDir, 'artifact-manifest.sha256'),
    `${'0'.repeat(64)}  artifact-manifest.json\n`,
  );
  await assert.rejects(
    verifyArtifactManifest({ manifestPath, context: state.context }),
    (error) => error.code === 'artifact_manifest_digest_mismatch',
  );
});
