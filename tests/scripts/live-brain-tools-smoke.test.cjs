const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
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
      matchOutcome: 'matches',
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

function providerTerminal(value, overrides = {}) {
  return {
    operationId: value.operationId,
    type: 'provider_call_terminal',
    eventSequence: overrides.eventSequence ?? 4,
    phase: overrides.phase ?? value.operationType,
    provider: overrides.provider ?? 'fixture-provider',
    model: overrides.model ?? 'fixture-model',
    providerCallId: overrides.providerCallId ?? value.operationType,
    outcome: overrides.outcome ?? 'complete',
    ...overrides,
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

async function canaryReceipt(state, authority = state.context.authority, overrides = {}) {
  const { canonicalReceiptRow } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const suffix = overrides.sourceHealth === 'degraded' ? '-degraded' : '';
  const file = path.join(state.context.receiptRunDir, `canary-${authority}${suffix}.json`);
  const sourceEvidence = overrides.sourceEvidence ?? {
    sourceHealth: 'healthy', matchOutcome: 'matches',
    deltaWatermark: { revision: 7 },
    authoritativeTotals: { nodes: 140_086, edges: 456_709 },
    returnedTotals: { nodes: 1, edges: 0 },
    selectedBrain: 'brain-jerry',
  };
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
    sourceHealth: overrides.sourceHealth ?? sourceEvidence.sourceHealth,
    selectedBrain: 'brain-jerry',
    sourceEvidence,
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
    activityLog: [
      ...sweepOutputs.map((sweep, index) => providerTerminal(partial, {
        eventSequence: index + 1,
        phase: 'pgs_sweep',
        providerCallId: `pgs:${sweep.workUnitId}`,
        workUnitId: sweep.workUnitId,
        partitionId: sweep.partitionId,
        provider: sweep.provider,
        model: sweep.model,
      })),
      providerTerminal(partial, {
        eventSequence: sweepOutputs.length + 1,
        phase: 'pgs_synthesis',
        providerCallId: 'pgs:synthesis',
        outcome: 'failed',
      }),
    ],
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

  const degradedCanary = await canaryReceipt(state, state.context.authority, {
    sourceHealth: 'degraded',
    sourceEvidence: {
      sourceHealth: 'degraded', freshness: 'unknown', matchOutcome: 'matches',
      deltaWatermark: { revision: 7 },
      authoritativeTotals: { nodes: 140_086, edges: 456_709 },
      returnedTotals: { nodes: 1, edges: 0 },
      selectedBrain: 'brain-jerry',
    },
  });
  const [degradedSweep] = sweepOutputs;
  const degradedPartial = operation({
    ...partial,
    operationId: 'op_pgs_degraded_pinned_0001',
    sourceEvidence: {
      sourceHealth: 'degraded', freshness: 'unknown', matchOutcome: 'unknown',
      deltaWatermark: { revision: 7 },
      authoritativeTotals: { nodes: 140_086, edges: 456_709 },
      returnedTotals: { nodes: 0, edges: 0 },
      selectedBrain: 'brain-jerry',
    },
    result: {
      answer: null,
      sweepOutputs: [degradedSweep],
      metadata: { pgs: { successfulSweeps: 1, retryablePartitions: ['retry-legacy'] } },
    },
  });
  const degradedEvents = [
    providerTerminal(degradedPartial, {
      eventSequence: 1,
      phase: 'pgs_sweep',
      providerCallId: `pgs:${degradedSweep.workUnitId}`,
      workUnitId: degradedSweep.workUnitId,
      partitionId: degradedSweep.partitionId,
      provider: degradedSweep.provider,
      model: degradedSweep.model,
    }),
    providerTerminal(degradedPartial, {
      eventSequence: 2,
      phase: 'pgs_synthesis',
      providerCallId: 'pgs:synthesis',
      outcome: 'failed',
    }),
  ];
  await assert.rejects(executeScenario({
    scenario: 'pgs', modules,
    client: {
      async query() { return degradedPartial; },
      async inspectOperation() { return degradedPartial; },
    },
    values: {
      'canary-receipt': degradedCanary,
      'target-brain': 'brain-jerry',
      'require-authoritative-nodes': '100000',
      'pgs-sweep-selection': JSON.stringify({ provider: 'fixture-provider', model: 'fixture-model' }),
      'pgs-synth-selection': JSON.stringify({ provider: 'fixture-provider', model: 'fixture-model' }),
    },
    context: state.context, baseUrl: 'http://fixture', callerAgent: 'jerry',
    signal: new AbortController().signal,
    activityLog: degradedEvents,
  }), (error) => error.code === 'source_evidence_not_useful');

  const duplicateSweepPartial = operation({
    ...partial,
    operationId: 'op_pgs_duplicate_sweep_0001',
    result: {
      answer: null,
      sweepOutputs: [degradedSweep, { ...degradedSweep, output: 'duplicate receipt row' }],
      metadata: { pgs: { successfulSweeps: 2, retryablePartitions: ['retry-duplicate'] } },
    },
  });
  await assert.rejects(executeScenario({
    scenario: 'pgs', modules,
    client: {
      async query() { return duplicateSweepPartial; },
      async inspectOperation() { return duplicateSweepPartial; },
    },
    values: {
      'canary-receipt': canary,
      'target-brain': 'brain-jerry',
      'require-authoritative-nodes': '100000',
      'pgs-sweep-selection': JSON.stringify({ provider: 'fixture-provider', model: 'fixture-model' }),
      'pgs-synth-selection': JSON.stringify({ provider: 'fixture-provider', model: 'fixture-model' }),
    },
    context: state.context, baseUrl: 'http://fixture', callerAgent: 'jerry',
    signal: new AbortController().signal,
    activityLog: [
      providerTerminal(duplicateSweepPartial, {
        eventSequence: 1,
        phase: 'pgs_sweep',
        providerCallId: `pgs:${degradedSweep.workUnitId}`,
        workUnitId: degradedSweep.workUnitId,
        partitionId: degradedSweep.partitionId,
      }),
      providerTerminal(duplicateSweepPartial, {
        eventSequence: 2,
        phase: 'pgs_synthesis',
        providerCallId: 'pgs:synthesis',
        outcome: 'failed',
      }),
    ],
  }), (error) => error.code === 'provider_terminal_unproven');

  await assert.rejects(executeScenario({
    scenario: 'pgs', modules,
    client: {
      async query() { return { ...degradedPartial, sourceEvidence: {
        ...degradedPartial.sourceEvidence, deltaWatermark: { revision: 8 },
      } }; },
      async inspectOperation() { return { ...degradedPartial, sourceEvidence: {
        ...degradedPartial.sourceEvidence, deltaWatermark: { revision: 8 },
      } }; },
    },
    values: {
      'canary-receipt': degradedCanary,
      'target-brain': 'brain-jerry',
      'require-authoritative-nodes': '100000',
    },
    context: state.context, baseUrl: 'http://fixture', callerAgent: 'jerry',
    signal: new AbortController().signal,
    activityLog: degradedEvents,
  }), (error) => error.code === 'canary_source_revision_mismatch');

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
    activityLog: [{
      operationId: partial.operationId,
      type: 'provider_call_terminal',
      eventSequence: 9,
    }],
  }), (error) => error.code === 'provider_terminal_unproven');
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
  const {
    createActivityCollector,
    flushActivity,
  } = await import('../../scripts/live-brain-tools-smoke.mjs');
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

  const collector = createActivityCollector({ maxEvents: 4 });
  const replay = {
    source: 'brain_operation', operationId: 'op_attachment_replay', type: 'progress',
    eventSequence: 1, sequence: 1, state: 'running', phase: 'provider',
    updatedAt: '2026-07-10T00:00:01.000Z', lastProviderActivityAt: null,
    lastProgressAt: '2026-07-10T00:00:01.000Z',
  };
  collector.listener('primary')(replay);
  collector.listener('survivor')({ ...replay });
  assert.equal(collector.events.length, 1);
  assert.deepEqual(collector.events[0].observedAttachments, ['primary', 'survivor']);
  assert.deepEqual(collector.summary('op_attachment_replay'), {
    uniqueEvents: 1,
    duplicateDeliveries: 1,
    attachments: [
      { attachment: 'primary', observations: 1 },
      { attachment: 'survivor', observations: 1 },
    ],
  });
  assert.throws(
    () => collector.listener('conflicting')({ ...replay, type: 'terminal' }),
    (error) => error.code === 'operation_event_identity_conflict',
  );
  const payloadReplay = {
    ...replay,
    eventSequence: 2,
    sequence: 2,
    tokenDelta: { text: 'first authenticated payload' },
  };
  collector.listener('primary')(payloadReplay);
  assert.throws(
    () => collector.listener('survivor')({
      ...payloadReplay,
      tokenDelta: { text: 'conflicting authenticated payload' },
    }),
    (error) => error.code === 'operation_event_identity_conflict',
  );
  const sequenceReplay = {
    ...replay,
    eventSequence: 3,
    sequence: 3,
  };
  collector.listener('primary')(sequenceReplay);
  assert.throws(
    () => collector.listener('survivor')({ ...sequenceReplay, sequence: 99 }),
    (error) => error.code === 'operation_event_identity_conflict',
  );
  collector.listener('other-operation')({
    ...replay,
    operationId: 'op_other_attachment',
  });
  assert.deepEqual(collector.summary('op_attachment_replay').attachments, [
    { attachment: 'primary', observations: 3 },
    { attachment: 'survivor', observations: 1 },
  ]);

  const eventBytes = Buffer.byteLength(JSON.stringify(replay), 'utf8');
  const byteBounded = createActivityCollector({
    maxEvents: 10,
    maxEventBytes: eventBytes + 16,
    maxRetainedBytes: eventBytes + 16,
  });
  byteBounded.add(replay);
  assert.throws(
    () => byteBounded.add({ ...replay, eventSequence: 2, sequence: 2 }),
    (error) => error.code === 'operation_activity_bytes_exceeded',
  );
  assert.throws(
    () => createActivityCollector({
      maxEvents: 10,
      maxEventBytes: 128,
      maxRetainedBytes: 1024,
    }).add({ ...replay, oversized: 'x'.repeat(1024) }),
    (error) => error.code === 'operation_activity_event_too_large',
  );
  const dedupedOutput = path.join(state.context.receiptRunDir, 'deduped-events.jsonl');
  await flushActivity(
    state.context,
    dedupedOutput,
    collector.events,
    'jerry',
    'detach-reattach',
    'live',
  );
  const [deduped] = (await fs.readFile(dedupedOutput, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(deduped.streamAttachments, ['primary', 'survivor']);
  await assert.rejects(
    flushActivity(
      state.context,
      path.join(state.context.receiptRunDir, 'duplicate-events.jsonl'),
      [replay, { ...replay }],
      'jerry',
      'detach-reattach',
      'live',
    ),
    (error) => error.code === 'operation_event_out_of_order',
  );
});

test('HTTP, receipt, and memory evidence readers remain bounded before parse', async (t) => {
  const {
    createBoundedMetricAccumulator,
    readReceiptRows,
    readResponseJsonBounded,
  } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));

  const oversizedReceipt = path.join(state.context.receiptRunDir, 'oversized.json');
  const handle = await fs.open(oversizedReceipt, 'wx');
  await handle.truncate(32 * 1024 * 1024 + 1);
  await handle.close();
  await assert.rejects(
    readReceiptRows(oversizedReceipt),
    (error) => error.code === 'receipt_invalid',
  );
  const response = new Response('12345', {
    headers: { 'content-type': 'application/json', 'content-length': '5' },
  });
  await assert.rejects(
    readResponseJsonBounded(response, { maxBytes: 4, errorCode: 'bounded_http_test' }),
    (error) => error.code === 'bounded_http_test',
  );
  let advertisedBodyCancelled = false;
  await assert.rejects(
    readResponseJsonBounded({
      headers: { get: () => '5' },
      body: {
        async cancel() { advertisedBodyCancelled = true; },
        getReader() { throw new Error('oversized body must not be opened'); },
      },
    }, { maxBytes: 4, errorCode: 'bounded_http_test' }),
    (error) => error.code === 'bounded_http_test',
  );
  assert.equal(advertisedBodyCancelled, true);
  let synchronousBodyCancelled = false;
  await assert.rejects(
    readResponseJsonBounded({
      headers: { get: () => '5' },
      body: {
        cancel() { synchronousBodyCancelled = true; },
        getReader() { throw new Error('oversized body must not be opened'); },
      },
    }, { maxBytes: 4, errorCode: 'bounded_http_test' }),
    (error) => error.code === 'bounded_http_test',
  );
  assert.equal(synchronousBodyCancelled, true);
  await assert.rejects(
    readResponseJsonBounded({ headers: { get: () => null }, body: {} }, {
      maxBytes: 4,
      errorCode: 'bounded_http_test',
    }),
    (error) => error.code === 'bounded_http_test',
  );
  let invalidChunkCancelled = false;
  await assert.rejects(
    readResponseJsonBounded({
      headers: { get: () => null },
      body: {
        getReader() {
          let delivered = false;
          return {
            async read() {
              if (delivered) return { done: true, value: undefined };
              delivered = true;
              return { done: false, value: 'not-a-byte-chunk' };
            },
            async cancel() { invalidChunkCancelled = true; },
            releaseLock() {},
          };
        },
      },
    }, { maxBytes: 64, errorCode: 'bounded_http_test' }),
    (error) => error.code === 'bounded_http_test',
  );
  assert.equal(invalidChunkCancelled, true);

  const accumulator = createBoundedMetricAccumulator({ role: 'dashboard', expectedPid: 123 });
  for (let index = 0; index < 10_000; index += 1) {
    accumulator.add({
      role: 'dashboard', pid: 123, restartCount: 0,
      capturedAt: new Date(1_000 + index).toISOString(),
      updatedAt: new Date(1_000 + index).toISOString(),
      v8HeapUsedMiB: 100 + (index === 5_000 ? 50 : 0),
      rssMiB: 200 + (index === 6_000 ? 60 : 0),
      processMaxRssMiB: 300 + Math.floor(index / 1_000),
    });
  }
  const summary = accumulator.summary();
  assert.equal(summary.observedSamples, 10_000);
  assert.ok(summary.retainedSamples <= 256);
  assert.equal(summary.maxSampledV8HeapGrowthMiB, 50);
  assert.equal(summary.maxSampledRssGrowthMiB, 60);
  assert.equal(summary.processMaxRssGrowthMiB, 9);
  assert.equal(summary.samples.length, summary.retainedSamples);
});

test('COSMO authority rejection keeps an independent hard deadline for status, result, and cancel', async () => {
  const { proveCosmoAuthorityRejection } = await import('../../scripts/live-brain-tools-smoke.mjs');
  for (const hungAction of ['status', 'result', 'cancel']) {
    const observed = [];
    const started = Date.now();
    await assert.rejects(
      proveCosmoAuthorityRejection({
        baseUrl: 'http://127.0.0.1:43210',
        operationId: 'brop_' + 'a'.repeat(32),
        signal: new AbortController().signal,
        timeoutMs: 10,
        fetchImpl: async (url, init) => {
          const action = new URL(url).pathname.split('/').at(-1);
          observed.push(action);
          if (action !== hungAction) {
            return new Response(JSON.stringify({
              success: false,
              error: { code: 'capability_invalid' },
            }), { status: 401, headers: { 'content-type': 'application/json' } });
          }
          return new Promise((resolve, reject) => {
            if (init.signal.aborted) {
              reject(init.signal.reason);
              return;
            }
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
          });
        },
      }),
      (error) => error.code === 'cosmo_authority_rejection_unproven'
        && error.message.includes(hungAction),
    );
    assert.deepEqual(observed, ['status', 'result', 'cancel'].slice(0, observed.length));
    assert.equal(observed.at(-1), hungAction);
    assert.ok(Date.now() - started < 1_000);
  }
});

test('fixture cleanup owns signals, aborts work, removes handlers, and stops once', async () => {
  const { createBoundedFixtureCleanup } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const signalTarget = new EventEmitter();
  const controller = new AbortController();
  let stops = 0;
  const fixtureValue = { pids: {}, children: {} };
  const cleanup = createBoundedFixtureCleanup({
    fixture: fixtureValue,
    stopFixture: async (received) => {
      stops += 1;
      assert.equal(received, fixtureValue);
      return { retainedStore: '/controlled/store' };
    },
    controller,
    signalTarget,
    timeoutMs: 1_000,
  });
  signalTarget.emit('SIGTERM');
  assert.equal(controller.signal.aborted, true);
  assert.equal(controller.signal.reason.code, 'acceptance_interrupted');
  assert.equal(controller.signal.reason.exitCode, 143);
  assert.deepEqual(await cleanup.cleanup(), { retainedStore: '/controlled/store' });
  await cleanup.cleanup();
  cleanup.dispose();
  assert.equal(stops, 1);
  assert.equal(signalTarget.listenerCount('SIGINT'), 0);
  assert.equal(signalTarget.listenerCount('SIGTERM'), 0);
});

test('fixture cleanup deadline force-kills only the three exact owned fixture children', async () => {
  const { createBoundedFixtureCleanup } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const killed = [];
  const pids = { dashboard: 101, cosmo: 202, mcp: 303 };
  const children = Object.fromEntries(Object.entries(pids).map(([role, pid]) => {
    const child = new EventEmitter();
    child.pid = pid;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal) => {
      killed.push({ role, pid, signal });
      setImmediate(() => child.emit('exit', null, signal));
      return true;
    };
    return [role, child];
  }));
  const cleanup = createBoundedFixtureCleanup({
    fixture: { pids, children },
    stopFixture: () => new Promise(() => {}),
    controller: new AbortController(),
    signalTarget: new EventEmitter(),
    timeoutMs: 5,
    forceTimeoutMs: 1_000,
  });
  await assert.rejects(
    cleanup.cleanup(),
    (error) => error.code === 'isolated_fixture_cleanup_timeout',
  );
  cleanup.dispose();
  assert.deepEqual(killed, [
    { role: 'dashboard', pid: 101, signal: 'SIGKILL' },
    { role: 'cosmo', pid: 202, signal: 'SIGKILL' },
    { role: 'mcp', pid: 303, signal: 'SIGKILL' },
  ]);
});

test('isolated own, sibling, and research source manifests are rehashed after a run', async (t) => {
  const {
    captureFixtureSourceIntegrity,
    verifyFixtureSourceIntegrity,
  } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-source-integrity-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const agent = 'integrity-fixture';
  const roots = {
    own: path.join(root, 'instances', agent, 'brain'),
    sibling: path.join(root, 'instances', `${agent}-sibling`, 'brain'),
    research: path.join(
      root, 'instances', agent, 'workspace', 'research', 'runs', 'completed-fixture-run',
    ),
  };
  for (const [role, brainDir] of Object.entries(roots)) {
    await fs.mkdir(brainDir, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(brainDir, 'nodes.jsonl'), `${role}-node\n`),
      fs.writeFile(path.join(brainDir, 'edges.jsonl'), `${role}-edge\n`),
      fs.writeFile(path.join(brainDir, 'delta.jsonl'), ''),
      fs.writeFile(path.join(brainDir, 'brain-snapshot.json'), '{"currentRevision":1}\n'),
      fs.writeFile(path.join(brainDir, 'brain-state.json'), '{"mutable":true}\n'),
    ]);
    await fs.writeFile(path.join(brainDir, 'memory-manifest.json'), JSON.stringify({
      generation: `${role}-g1`,
      currentRevision: 1,
      activeBase: { nodes: { file: 'nodes.jsonl' }, edges: { file: 'edges.jsonl' } },
      activeDelta: { file: 'delta.jsonl' },
    }));
  }
  const options = { fixtureRoot: root, agent };
  const before = await captureFixtureSourceIntegrity(options);
  const unchanged = await verifyFixtureSourceIntegrity(before, options);
  assert.equal(unchanged.unchanged, true);
  assert.deepEqual(unchanged.before.sources.map((source) => source.role), [
    'own', 'sibling', 'research',
  ]);
  assert.ok(unchanged.before.sources.every((source) => source.files.length === 5
    && source.excludedMutableFiles[0] === 'brain-state.json'));

  await fs.appendFile(path.join(roots.sibling, 'nodes.jsonl'), 'drift\n');
  await assert.rejects(
    verifyFixtureSourceIntegrity(before, options),
    (error) => error.code === 'isolated_source_identity_or_hash_drift',
  );
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
    activityLog: [providerTerminal(queryTerminal)],
  });
  assert.equal(consumed.canaryNodeId, 'n-canary');
  assert.equal(consumed.canarySourceRevision, 7);

  const degradedProviderProse = operation({
    operationId: 'op_query_degraded_prose_0001',
    sourceEvidence: {
      sourceHealth: 'degraded', freshness: 'unknown', matchOutcome: 'unknown',
      deltaWatermark: { revision: 7 },
      authoritativeTotals: { nodes: 140_086, edges: 456_709 },
      returnedTotals: { nodes: 0, edges: 0 },
      selectedBrain: 'brain-jerry',
    },
    result: { answer: 'provider prose that is not exact source-match evidence' },
  });
  await assert.rejects(executeScenario({
    scenario: 'direct-query', modules,
    client: {
      async query() { return degradedProviderProse; },
      async inspectOperation() { return degradedProviderProse; },
    },
    values: { 'canary-receipt': consumedCanary }, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal: new AbortController().signal,
    activityLog: [providerTerminal(degradedProviderProse)],
  }), (error) => error.code === 'source_evidence_not_useful');

  for (const invalidIdentity of [
    { phase: 'synthesis', providerCallId: 'query' },
    { phase: 'query', providerCallId: 'synthesis' },
  ]) {
    await assert.rejects(executeScenario({
      scenario: 'direct-query', modules,
      client: {
        async query() { return queryTerminal; },
        async inspectOperation() { return queryTerminal; },
      },
      values: { 'canary-receipt': consumedCanary }, context: state.context,
      baseUrl: 'http://fixture', callerAgent: 'jerry', signal: new AbortController().signal,
      activityLog: [providerTerminal(queryTerminal, invalidIdentity)],
    }), (error) => error.code === 'provider_terminal_unproven');
  }

  const canary = await canaryReceipt(state);
  await assert.rejects(executeScenario({
    scenario: 'direct-query', modules,
    client: { async query() { throw Object.assign(new Error('hard deadline'), { code: 'operation_timeout' }); } },
    values: { 'canary-receipt': canary }, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal: new AbortController().signal,
  }), (error) => error.code === 'operation_timeout');

  const failed = operation({
    operationId: 'op_query_failed_after_canary_0001',
    state: 'failed',
    result: null,
    error: { code: 'provider_failed', message: 'fixture failure', retryable: true },
  });
  await assert.rejects(executeScenario({
    scenario: 'direct-query', modules,
    client: {
      async query() { return failed; },
      async inspectOperation() { return failed; },
    },
    values: { 'canary-receipt': canary }, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal: new AbortController().signal,
  }), (error) => error.toolResult?.is_error === true && /provider_failed/.test(error.message));
});

test('positive reads require complete exact targets while zero-result requires healthy coverage', async (t) => {
  const { executeScenario } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const signal = new AbortController().signal;

  const failedGraph = operation({
    operationId: 'op_graph_failed_0001',
    operationType: 'graph',
    state: 'failed',
    result: null,
    error: { code: 'source_failed', message: 'graph failed', retryable: false },
  });
  await assert.rejects(executeScenario({
    scenario: 'graph', modules: {},
    client: {
      async graph() { return { operationId: failedGraph.operationId, nodes: [{ id: 'n1' }] }; },
      async inspectOperation() { return failedGraph; },
    },
    values: {}, context: state.context, baseUrl: 'http://fixture', callerAgent: 'jerry', signal,
  }), (error) => error.code === 'operation_success_required');

  const lyingGraph = operation({
    operationId: 'op_graph_lying_totals_0001',
    operationType: 'graph',
    sourceEvidence: {
      sourceHealth: 'healthy', matchOutcome: 'matches', selectedBrain: 'brain-jerry',
      authoritativeTotals: { nodes: 3, edges: 2 },
      returnedTotals: { nodes: 1, edges: 1 },
    },
  });
  await assert.rejects(executeScenario({
    scenario: 'graph', modules: {},
    client: {
      async graph() {
        return {
          operationId: lyingGraph.operationId,
          nodes: [{ id: 'n1' }, { id: 'n2' }],
          edges: [{ source: 'n1', target: 'n2' }, { source: 'n2', target: 'n1' }],
        };
      },
      async inspectOperation() { return lyingGraph; },
    },
    values: { 'node-limit': '1', 'edge-limit': '1' }, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal,
  }), (error) => error.code === 'graph_result_invalid');

  const wrongCanaryTarget = operation({
    operationId: 'op_search_wrong_target_0001',
    operationType: 'search',
    target: { domain: 'brain', brainId: 'brain-other', ownerAgent: 'other', accessMode: 'sibling' },
    sourceEvidence: {
      sourceHealth: 'healthy', matchOutcome: 'matched', deltaWatermark: { revision: 7 },
      authoritativeTotals: { nodes: 10, edges: 4 }, selectedBrain: 'brain-other',
    },
  });
  await assert.rejects(executeScenario({
    scenario: 'discover-canary', modules: {},
    client: {
      async resolveTarget() { return { id: 'brain-jerry', ownerAgent: 'jerry' }; },
      async graph() { return { nodes: [{ id: 'n-canary', concept: 'authoritative canary phrase' }] }; },
      async search() {
        return {
          operationId: wrongCanaryTarget.operationId,
          results: [{ id: 'n-canary' }],
          sourceEvidence: wrongCanaryTarget.sourceEvidence,
        };
      },
      async inspectOperation() { return wrongCanaryTarget; },
    },
    values: {}, context: state.context, baseUrl: 'http://fixture', callerAgent: 'jerry', signal,
  }), (error) => error.code === 'canary_target_mismatch');

  const degradedEvidence = {
    sourceHealth: 'degraded', freshness: 'unknown', matchOutcome: 'matches',
    deltaWatermark: { revision: 7 }, authoritativeTotals: { nodes: 10, edges: 4 },
    returnedTotals: { nodes: 1, edges: 0 }, selectedBrain: 'brain-jerry',
  };
  const degradedSearch = operation({
    operationId: 'op_search_degraded_0001', operationType: 'search',
    sourceEvidence: degradedEvidence,
  });
  const degradedCanary = await executeScenario({
    scenario: 'discover-canary', modules: {},
    client: {
      async resolveTarget() { return { id: 'brain-jerry', ownerAgent: 'jerry' }; },
      async graph() { return { nodes: [{ id: 'n-canary', concept: 'authoritative canary phrase' }] }; },
      async search() {
        return {
          operationId: degradedSearch.operationId,
          results: [{ id: 'n-canary' }],
          sourceEvidence: degradedEvidence,
        };
      },
      async inspectOperation() { return degradedSearch; },
    },
    values: {}, context: state.context, baseUrl: 'http://fixture', callerAgent: 'jerry', signal,
  });
  assert.equal(degradedCanary.state, 'complete');
  assert.equal(degradedCanary.sourceHealth, 'degraded');

  const zeroEvidence = {
    sourceHealth: 'healthy', matchOutcome: 'no_match', completeCoverage: true,
    deltaWatermark: { revision: 7 }, authoritativeTotals: { nodes: 10, edges: 4 },
    selectedBrain: 'brain-jerry',
  };
  const partialZero = operation({
    operationId: 'op_zero_partial_0001', operationType: 'search', state: 'partial',
    result: { results: [] }, sourceEvidence: zeroEvidence,
    error: { code: 'source_partial', message: 'partial search', retryable: true },
  });
  await assert.rejects(executeScenario({
    scenario: 'zero-result', modules: {},
    client: {
      async search() {
        return { operationId: partialZero.operationId, results: [], sourceEvidence: zeroEvidence };
      },
      async inspectOperation() { return partialZero; },
    },
    values: { query: 'definitely absent' }, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal,
  }), (error) => error.code === 'operation_success_required');
  const degradedZero = operation({
    operationId: 'op_zero_degraded_0001', operationType: 'search',
    result: { results: [] },
    sourceEvidence: { ...zeroEvidence, sourceHealth: 'degraded', freshness: 'unknown' },
  });
  await assert.rejects(executeScenario({
    scenario: 'zero-result', modules: {},
    client: {
      async search() {
        return {
          operationId: degradedZero.operationId,
          results: [],
          sourceEvidence: degradedZero.sourceEvidence,
        };
      },
      async inspectOperation() { return degradedZero; },
    },
    values: { query: 'degraded absence is not proof' }, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal,
  }), (error) => error.code === 'source_health_unhealthy');

  const canary = await canaryReceipt(state);
  const dashboardTerminal = operation({
    operationId: 'op_mcp_parity_0001', operationType: 'search',
  });
  const mcpResponse = (selectedBrain) => new Response(JSON.stringify({
    jsonrpc: '2.0', id: 'acceptance', result: { content: [{
      type: 'text',
      text: JSON.stringify({
        results: [{ id: 'n-canary' }],
        evidence: {
          sourceHealth: 'healthy', deltaWatermark: { revision: 7 }, selectedBrain,
        },
      }),
    }] },
  }), { headers: { 'content-type': 'application/json' } });
  const mcpClient = {
    async search() {
      return {
        operationId: dashboardTerminal.operationId,
        results: [{ id: 'n-canary' }],
        sourceEvidence: dashboardTerminal.sourceEvidence,
      };
    },
    async inspectOperation() { return dashboardTerminal; },
  };
  await assert.rejects(executeScenario({
    scenario: 'mcp-parity', modules: {}, client: mcpClient,
    values: { 'canary-receipt': canary }, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal,
    fetchImpl: async () => mcpResponse('brain-other'),
  }), (error) => error.code === 'mcp_target_mismatch');
  const parity = await executeScenario({
    scenario: 'mcp-parity', modules: {}, client: mcpClient,
    values: { 'canary-receipt': canary }, context: state.context,
    baseUrl: 'http://fixture', callerAgent: 'jerry', signal,
    fetchImpl: async () => mcpResponse('brain-jerry'),
  });
  assert.equal(parity.state, 'complete');
  assert.equal(parity.mcpParity, true);
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
    activityLog: [providerTerminal(completed, {
      eventSequence: 7,
      phase: 'synthesis',
      providerCallId: 'synthesis',
    })],
  });
  assert.equal(reattached, 1);
  assert.equal(synthesis.state, 'complete');
  assert.equal(synthesis.generationMarker, 'generation-7');
  assert.equal(synthesis.providerTerminalValidated, true);
  assert.equal(synthesis.lastProgressAt, completed.lastProgressAt);
  await assert.rejects(executeScenario({
    scenario: 'synthesis-reconnect', modules: {},
    client: {
      async synthesize() { return operation({ ...completed, state: 'running', result: null }); },
      async reattachSynthesis() { return completed; },
      async inspectOperation() { return completed; },
    },
    values, context: state.context, baseUrl: 'http://isolated', callerAgent: 'jerry',
    signal: new AbortController().signal,
    activityLog: [
      providerTerminal(completed, {
        eventSequence: 7,
        phase: 'synthesis',
        providerCallId: 'synthesis',
        outcome: 'complete',
      }),
      providerTerminal(completed, {
        eventSequence: 8,
        phase: 'synthesis',
        providerCallId: 'synthesis',
        outcome: 'failed',
      }),
    ],
  }), (error) => error.code === 'provider_terminal_unproven');

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
  const urls = {
    jerry: 'http://jerry.fixture',
    forrest: 'http://forrest.fixture',
    cosmo: 'http://127.0.0.1:43210',
  };
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
    values: {
      'base-url': urls.jerry,
      'forrest-base-url': urls.forrest,
      'cosmo-base-url': urls.cosmo,
    },
    callerAgent: 'jerry', signal: new AbortController().signal, clientFactory,
    fetchImpl: async () => new Response(JSON.stringify({
      success: false,
      error: { code: 'capability_invalid', message: 'capability_invalid' },
    }), { status: 401, headers: { 'content-type': 'application/json' } }),
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
    main,
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
  const inventory = async () => {
    const names = (await fs.readdir(state.context.receiptRunDir, { recursive: true })).sort();
    return Promise.all(names.map(async (name) => {
      const absolute = path.join(state.context.receiptRunDir, name);
      const stat = await fs.lstat(absolute, { bigint: true });
      return {
        name,
        size: String(stat.size),
        mtimeNs: String(stat.mtimeNs),
        ctimeNs: String(stat.ctimeNs),
      };
    }));
  };
  const beforeCliVerification = await inventory();
  const cliVerified = await main([
    '--receipt-run-dir', state.context.receiptRunDir,
    '--receipt-run-id', state.context.receiptRunId,
    '--authority', state.context.authority,
    '--scenario', 'verify-receipts',
    '--verify-artifact-manifest',
    '--artifact-manifest', manifestPath,
  ], {});
  assert.equal(cliVerified.receiptKind, 'artifact-manifest-verification');
  assert.equal(cliVerified.ok, true);
  assert.deepEqual(await inventory(), beforeCliVerification);
  const refusedOutput = path.join(state.context.receiptRunDir, 'verification.json');
  await assert.rejects(main([
    '--receipt-run-dir', state.context.receiptRunDir,
    '--receipt-run-id', state.context.receiptRunId,
    '--authority', state.context.authority,
    '--scenario', 'verify-receipts',
    '--verify-artifact-manifest',
    '--artifact-manifest', manifestPath,
    '--output', refusedOutput,
  ], {}), (error) => error.code === 'artifact_manifest_verification_read_only');
  await assert.rejects(fs.lstat(refusedOutput), (error) => error.code === 'ENOENT');
  await assert.rejects(main([
    '--receipt-run-dir', state.context.receiptRunDir,
    '--receipt-run-id', state.context.receiptRunId,
    '--authority', state.context.authority,
    '--scenario', 'verify-receipts',
    '--build-artifact-manifest',
    '--verify-artifact-manifest',
    '--smoke-root', state.context.receiptRunDir,
    '--artifact-manifest', manifestPath,
    '--output', path.join(state.context.receiptRunDir, 'other-manifest.json'),
  ], {}), (error) => error.code === 'artifact_manifest_mode_conflict');
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
