import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const verifierUrl = new URL('../../scripts/verify-query-notebook-live.mjs', import.meta.url);

async function verifier() {
  return import(verifierUrl.href);
}

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`../../contracts/fixtures/${name}.json`, import.meta.url), 'utf8'));
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json', ...headers },
  });
}

function sseResponse(frames) {
  const body = frames.map((frame) => `${[
    `event: ${frame.event}`,
    `id: ${frame.data.eventSequence}`,
    `data: ${JSON.stringify(frame.data)}`,
  ].join('\n')}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function snapshotFrame(status, sequence, stage = status.progress.stage) {
  const progress = { ...status.progress, stage, eventSequence: sequence };
  return { event: 'snapshot', data: {
    type: 'snapshot', operationId: status.operationId, eventSequence: sequence,
    executionState: status.executionState, progress, error: status.error,
    resultAvailability: status.resultAvailability, resultVersion: status.resultVersion,
    actions: status.actions, notification: status.notification,
  } };
}

function fakeQuerySystem({ includeGap = true } = {}) {
  const dashboard = 'http://dashboard.test';
  const harness = 'http://harness.test';
  const wrong = 'http://wrong.test';
  const directId = `brop_${'B'.repeat(32)}`;
  const pgsId = `brop_${'A'.repeat(32)}`;
  const continuationId = `brop_${'D'.repeat(32)}`;
  const credential = fixture('query-notebook-device-credential');
  const pgsStatus = structuredClone(fixture('query-notebook-page').items[0]);
  pgsStatus.notification = { subscribed: true, deliveryState: 'active' };
  const directStatus = structuredClone(fixture('query-notebook-status'));
  Object.assign(directStatus, {
    executionState: 'complete', humanClassification: 'finished',
    completedAt: '2026-07-13T20:00:04.000Z', updatedAt: '2026-07-13T20:00:04.000Z',
    error: null, resultAvailability: 'available',
    expiresAt: '2026-07-20T20:00:04.000Z', answerPreviewAvailable: true,
    resultVersion: `qrv1_${'V'.repeat(43)}`, coverage: null, continuation: null,
    actions: [{ kind: 'openResult' }],
    progress: { version: 1, stage: 'terminal', eventSequence: 5,
      sourceNodes: 141900, sourceEdges: 464000,
      lastProgressAt: '2026-07-13T20:00:04.000Z' },
  });
  const continuationStatus = structuredClone(pgsStatus);
  continuationStatus.operationId = continuationId;
  continuationStatus.configuration.pgsMode = 'continue';
  continuationStatus.continuation.sourceOperationId = pgsId;
  const resultFor = (operationId) => ({ ...structuredClone(fixture('query-notebook-result')), operationId });
  const terminalSnapshot = snapshotFrame(pgsStatus, 41);
  const runningStatus = structuredClone(pgsStatus);
  Object.assign(runningStatus, {
    executionState: 'running', humanClassification: 'running', completedAt: null,
    error: null, resultAvailability: 'absent', expiresAt: null,
    answerPreviewAvailable: false, resultVersion: null, coverage: null, continuation: null,
    actions: [{ kind: 'cancel' }],
    progress: { version: 1, stage: 'sweeping', eventSequence: 3,
      selected: 12, completed: 1, successful: 1, failed: 0, reused: 0,
      pending: 11, retryable: 0, total: 12,
      lastProviderActivityAt: '2026-07-13T19:00:02.000Z',
      lastProgressAt: '2026-07-13T19:00:03.000Z' },
  });
  const runningSnapshot = snapshotFrame(runningStatus, 3);
  let pgsAfterZeroCalls = 0;

  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const auth = new Headers(init.headers).get('authorization');
    const deviceId = new Headers(init.headers).get('x-home23-device-id');
    const deviceAuthorized = auth === `Bearer ${credential.token}`
      && deviceId === credential.credentialId;

    if (url.origin === harness && url.pathname === '/api/device/query-credential') {
      return jsonResponse(credential);
    }
    if (url.origin === harness && url.pathname === '/api/chat/turn') {
      return jsonResponse({ turn_id: 'turn-live-acceptance' });
    }
    if (url.origin === harness && url.pathname === '/api/chat/turn-status') {
      return jsonResponse({ status: 'complete', provider: 'xai', model: 'grok-live' });
    }
    if (url.origin === harness && url.pathname === '/api/chat/stream') {
      return sseResponse([
        { event: 'message', data: { eventSequence: 1, kind: 'tool_start', data: { tool: 'brain_status' } } },
        { event: 'message', data: { eventSequence: 2, kind: 'tool_result', data: { tool: 'brain_status', success: true } } },
      ]);
    }
    if (url.pathname === '/home23/api/query/catalog') {
      const agent = url.origin === wrong ? 'forrest' : 'jerry';
      return jsonResponse({ agent, available: true, selectedBrain: { id: `brain-${agent}` },
        models: [
          { provider: 'xai', id: 'grok-4-0709' },
          { provider: 'minimax', id: 'MiniMax-M2.1' },
          { provider: 'anthropic', id: 'claude-opus-4-8' },
        ],
        defaults: { provider: 'xai', model: 'grok-4-0709', mode: 'grounded',
          pgsSweepProvider: 'minimax', pgsSweepModel: 'MiniMax-M2.1',
          pgsSynthProvider: 'anthropic', pgsSynthModel: 'claude-opus-4-8' } });
    }
    if (url.pathname === '/home23/api/query/notebook') {
      const cookie = new Headers(init.headers).get('cookie');
      if (url.origin === dashboard && cookie === 'home23_query_session=fake') {
        return jsonResponse(fixture('query-notebook-page'));
      }
      return jsonResponse({ error: 'unauthorized' }, url.origin === wrong ? 403 : 401);
    }
    if (url.origin !== dashboard) return jsonResponse({ error: 'not_found' }, 404);
    if (url.pathname === '/home23/api/query/run' && method === 'POST') {
      const body = JSON.parse(init.body);
      const operationId = body.enablePGS ? pgsId : directId;
      return jsonResponse({ operationId, state: 'queued', detached: true,
        attachmentState: 'detached' }, 202);
    }
    if (url.pathname === '/home23/api/query/session' && method === 'POST') {
      return jsonResponse(fixture('query-notebook-web-session'), 200,
        { 'set-cookie': 'home23_query_session=fake; HttpOnly; SameSite=Strict' });
    }
    const match = /^\/home23\/api\/query\/operations\/(brop_[A-Za-z0-9_-]{32})(.*)$/u.exec(url.pathname);
    if (!match) return jsonResponse({ error: 'not_found' }, 404);
    const [, operationId, suffix] = match;
    if (url.searchParams.has('canonicalRoot')) return jsonResponse({ error: 'invalid_field' }, 400);
    if (!deviceAuthorized) return jsonResponse({ error: 'unauthorized' }, 401);
    if (suffix === '/notifications') {
      return jsonResponse({ ...fixture('query-notebook-notification'), operationId });
    }
    if (suffix === '/actions') return jsonResponse(fixture('query-notebook-action'), 202);
    if (suffix === '/result') return jsonResponse(resultFor(operationId));
    if (suffix === '/events') {
      const after = Number(url.searchParams.get('after'));
      if (operationId !== pgsId) return sseResponse([terminalSnapshot]);
      if (after === 0) {
        pgsAfterZeroCalls += 1;
        if (pgsAfterZeroCalls === 1) return sseResponse([runningSnapshot]);
        const frames = [terminalSnapshot];
        if (includeGap) frames.push({ event: 'gap', data: {
          ...fixture('query-notebook-gap-event'), operationId, eventSequence: 30,
          fromSequence: 1, toSequence: 30,
        } });
        return sseResponse(frames);
      }
      return sseResponse([terminalSnapshot]);
    }
    if (suffix === '') {
      if (operationId === directId) return jsonResponse(directStatus);
      if (operationId === continuationId) return jsonResponse(continuationStatus);
      return jsonResponse(pgsStatus);
    }
    return jsonResponse({ error: 'not_found' }, 404);
  };
  return { dashboard, harness, wrong, fetchImpl };
}

test('CLI requires complete explicit provider/model pairs and separates route owners', async () => {
  const { parseOptions, validateRouteIdentities } = await verifier();
  assert.throws(() => parseOptions([
    '--agent', 'jerry', '--dashboard-url', 'http://127.0.0.1:5002',
    '--direct-provider', 'openai', '--output', '.verification/live.json',
  ], {}), { code: 'model_pair_invalid' });
  assert.throws(() => parseOptions([
    '--agent', 'jerry', '--dashboard-url', 'http://127.0.0.1:5002',
    '--harness-url', 'http://127.0.0.1:5002', '--output', '.verification/live.json',
  ], { HOME23_QUERY_BRIDGE_TOKEN: 'secret' }), { code: 'route_owner_collision' });

  const parsed = parseOptions([
    '--agent', 'jerry', '--dashboard-url', 'http://127.0.0.1:5002',
    '--harness-url', 'http://127.0.0.1:5004', '--output', '.verification/live.json',
  ], { HOME23_QUERY_BRIDGE_TOKEN: 'secret' });
  assert.equal(parsed.bridgeToken, 'secret');
  assert.equal(parsed.dashboardUrl, 'http://127.0.0.1:5002');
  assert.equal(parsed.harnessUrl, 'http://127.0.0.1:5004');
  assert.deepEqual(validateRouteIdentities('jerry', { agent: 'jerry' }, { agent: 'forrest' }), {
    selectedAgent: 'jerry', wrongAgent: 'forrest',
  });
  assert.throws(() => validateRouteIdentities('jerry', { agent: 'jerry' }, { agent: 'jerry' }), {
    code: 'wrong_agent_route_invalid',
  });
});

test('model selection resolves exact live-catalog pairs and never invents a fallback model', async () => {
  const { normalizeGitCommit, resolveModelPlan } = await verifier();
  const catalog = {
    available: true,
    models: [
      { provider: 'openai', id: 'direct-live' },
      { provider: 'anthropic', id: 'sweep-live' },
      { provider: 'xai', id: 'synth-live' },
    ],
    defaults: {
      provider: 'openai', model: 'direct-live',
      pgsSweepProvider: 'anthropic', pgsSweepModel: 'sweep-live',
      pgsSynthProvider: 'xai', pgsSynthModel: 'synth-live',
    },
  };
  assert.deepEqual(resolveModelPlan(catalog, {}), {
    direct: { provider: 'openai', model: 'direct-live' },
    sweep: { provider: 'anthropic', model: 'sweep-live' },
    synthesis: { provider: 'xai', model: 'synth-live' },
  });
  assert.throws(() => resolveModelPlan({
    ...catalog,
    defaults: { provider: 'openai', model: 'missing' },
  }, {}), { code: 'catalog_model_pair_unavailable' });
  assert.equal(normalizeGitCommit(`${'a'.repeat(40)}\n`), 'a'.repeat(40));
  assert.throws(() => normalizeGitCommit('main'), { code: 'implementation_commit_invalid' });
});

test('idempotent replay sends byte-identical request identity and returns one operation', async () => {
  const { replayDetachedStart } = await verifier();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init });
    return new Response(JSON.stringify({
      ok: false,
      operationId: `brop_${'A'.repeat(32)}`,
      state: 'queued',
      detached: true,
      attachmentState: 'detached',
    }), { status: 202, headers: { 'content-type': 'application/json' } });
  };
  const body = {
    agent: 'jerry', brainId: 'brain-jerry', query: 'durable truth',
    enablePGS: false, mode: 'full',
    modelSelection: { provider: 'openai', model: 'direct-live' },
  };
  const result = await replayDetachedStart({
    fetchImpl,
    url: 'http://127.0.0.1:5002/home23/api/query/run',
    body,
    requestId: `qreq_${'R'.repeat(32)}`,
    timeoutMs: 1_000,
  });
  assert.equal(result.operationId, `brop_${'A'.repeat(32)}`);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body, calls[1].body);
  assert.deepEqual(calls[0].headers, calls[1].headers);
  assert.equal(calls[0].headers['x-home23-query-request-id'], `qreq_${'R'.repeat(32)}`);
  assert.equal(calls[0].headers.prefer, 'respond-async');
});

test('activity-aware waiting resets the stall clock and enforces monotonic progress', async () => {
  const { createProgressReporter, recordBoundedSample, waitForTerminal } = await verifier();
  let now = 0;
  const statuses = [
    { executionState: 'running', updatedAt: '2026-07-13T20:00:00.000Z', progress: { version: 1, stage: 'sweeping', eventSequence: 1, selected: 3, completed: 1, successful: 1, failed: 0, pending: 2, retryable: 0, total: 3, lastProviderActivityAt: '2026-07-13T20:00:00.000Z' } },
    { executionState: 'running', updatedAt: '2026-07-13T20:00:00.000Z', progress: { version: 1, stage: 'sweeping', eventSequence: 1, selected: 3, completed: 1, successful: 1, failed: 0, pending: 2, retryable: 0, total: 3, lastProviderActivityAt: '2026-07-13T20:00:00.000Z' } },
    { executionState: 'running', updatedAt: '2026-07-13T20:00:02.000Z', progress: { version: 1, stage: 'sweeping', eventSequence: 2, selected: 3, completed: 2, successful: 2, failed: 0, pending: 1, retryable: 0, total: 3, lastProviderActivityAt: '2026-07-13T20:00:02.000Z' } },
    { executionState: 'complete', updatedAt: '2026-07-13T20:00:03.000Z', progress: { version: 1, stage: 'terminal', eventSequence: 3, selected: 3, completed: 3, successful: 3, failed: 0, pending: 0, retryable: 0, total: 3, lastProviderActivityAt: '2026-07-13T20:00:03.000Z' } },
  ];
  const samples = [];
  const terminal = await waitForTerminal({
    readStatus: async () => statuses.shift(),
    now: () => now,
    sleepImpl: async (milliseconds) => { now += milliseconds; },
    pollIntervalMs: 1_000,
    hardTimeoutMs: 10_000,
    stallTimeoutMs: 2_500,
    onSample: (sample) => samples.push(sample),
  });
  assert.equal(terminal.executionState, 'complete');
  assert.deepEqual(samples.map((sample) => sample.eventSequence), [1, 1, 2, 3]);

  const decreasing = [
    { executionState: 'running', progress: { version: 1, stage: 'sweeping', eventSequence: 5, completed: 2 } },
    { executionState: 'running', progress: { version: 1, stage: 'sweeping', eventSequence: 6, completed: 1 } },
  ];
  await assert.rejects(waitForTerminal({
    readStatus: async () => decreasing.shift(),
    now: () => now,
    sleepImpl: async () => {},
    pollIntervalMs: 1,
    hardTimeoutMs: 10_000,
    stallTimeoutMs: 10_000,
  }), { code: 'progress_not_monotonic' });

  for (const invalid of [
    [
      { executionState: 'running', progress: { version: 1, stage: 'synthesizing', eventSequence: 7 } },
      { executionState: 'running', progress: { version: 1, stage: 'sweeping', eventSequence: 8 } },
    ],
    [
      { executionState: 'running', progress: { version: 1, stage: 'sweeping', eventSequence: 7, lastProviderActivityAt: '2026-07-13T20:00:02.000Z' } },
      { executionState: 'running', progress: { version: 1, stage: 'sweeping', eventSequence: 8, lastProviderActivityAt: '2026-07-13T20:00:01.000Z' } },
    ],
  ]) {
    await assert.rejects(waitForTerminal({
      readStatus: async () => invalid.shift(), now: () => now,
      sleepImpl: async () => {}, pollIntervalMs: 1,
      hardTimeoutMs: 10_000, stallTimeoutMs: 10_000,
    }), { code: 'progress_not_monotonic' });
  }
  await assert.rejects(waitForTerminal({
    readStatus: async () => ({
      executionState: 'running',
      progress: { version: 1, stage: 'sweeping', eventSequence: 9,
        selected: 3, completed: 2, successful: 2, failed: 0, pending: 2, retryable: 1 },
    }),
    now: () => now, sleepImpl: async () => {}, pollIntervalMs: 1,
    hardTimeoutMs: 10_000, stallTimeoutMs: 10_000,
  }), { code: 'progress_snapshot_invalid' });

  const bounded = [];
  for (let value = 1; value <= 5; value += 1) {
    recordBoundedSample(bounded, { value }, 3);
  }
  assert.deepEqual(bounded, [{ value: 1 }, { value: 2 }, { value: 5 }],
    'bounded receipts must retain the first samples and the newest terminal sample');

  const emitted = [];
  const report = createProgressReporter({
    kind: 'pgs', operationId: `brop_${'P'.repeat(32)}`,
    now: () => now, emit: (event) => emitted.push(event), heartbeatMs: 60_000,
  });
  report({ eventSequence: 1, completed: 0, total: 3 });
  report({ eventSequence: 1, completed: 0, total: 3 });
  report({ eventSequence: 2, completed: 1, total: 3 });
  assert.equal(emitted.length, 2, 'unchanged polling must not flood progress output');
  assert.deepEqual(emitted[1].progress, { eventSequence: 2, completed: 1, total: 3 });
});

test('public projections use the exact contract schema and PGS evidence proves the requested path', async () => {
  const { assertPgsAcceptance, validatePublicProjection } = await verifier();
  const status = fixture('query-notebook-page').items[0];
  const result = fixture('query-notebook-result');
  assert.equal(validatePublicProjection('queryNotebookStatus', status), status);
  assert.equal(validatePublicProjection('queryNotebookResult', result), result);

  const unknown = structuredClone(result);
  unknown.coverage.unpublishedCounter = 1;
  assert.throws(() => validatePublicProjection('queryNotebookResult', unknown), {
    code: 'public_projection_invalid',
  });

  const evidence = assertPgsAcceptance(status, result, {
    level: 'sample',
    sweep: { provider: 'minimax', model: 'MiniMax-M2.1' },
    synthesis: { provider: 'anthropic', model: 'claude-opus-4-8' },
  });
  assert.equal(evidence.requestedLevel, 'sample');
  assert.equal(evidence.progress.completed, 10);
  assert.equal(evidence.progress.lastProviderActivityAt, '2026-07-13T19:09:58.000Z');

  const substituted = structuredClone(status);
  substituted.configuration.sweepModel.model = 'substituted-model';
  assert.throws(() => assertPgsAcceptance(substituted, result, {
    level: 'sample',
    sweep: { provider: 'minimax', model: 'MiniMax-M2.1' },
    synthesis: { provider: 'anthropic', model: 'claude-opus-4-8' },
  }), { code: 'pgs_execution_unproven' });
});

test('SSE acceptance requires a server gap and meaningful detach/reconnect advancement', async () => {
  const { proveGapRecoveryFrames, proveMeaningfulReconnect, proveServerGapFrames } = await verifier();
  const op = `brop_${'G'.repeat(32)}`;
  const snapshot = (sequence) => ({
    event: 'snapshot', id: sequence,
    data: { type: 'snapshot', operationId: op, eventSequence: sequence,
      executionState: 'running', progress: { version: 1, stage: 'sweeping', eventSequence: sequence },
      error: null, resultAvailability: 'absent', resultVersion: null,
      actions: [{ kind: 'cancel' }], notification: { subscribed: false, deliveryState: null } },
  });
  assert.throws(() => proveMeaningfulReconnect([snapshot(3)], [snapshot(3)], 0), {
    code: 'sse_reconnect_not_advanced',
  });
  assert.deepEqual(proveMeaningfulReconnect([snapshot(3)], [snapshot(5)], 0), {
    detachedAtSequence: 3, reconnectedAtSequence: 5,
  });
  await assert.rejects(proveServerGapFrames({
    frames: [snapshot(8)], requestedAfter: 0,
    readStatus: async () => ({ progress: { version: 1, stage: 'terminal', eventSequence: 8 } }),
  }), { code: 'server_gap_not_observed' });
  const gap = { event: 'gap', id: 6, data: {
    type: 'gap', operationId: op, eventSequence: 6, fromSequence: 1, toSequence: 6,
  } };
  assert.deepEqual(await proveServerGapFrames({
    frames: [snapshot(8), gap], requestedAfter: 0,
    readStatus: async () => ({ progress: { version: 1, stage: 'terminal', eventSequence: 8 } }),
  }), { fromSequence: 1, toSequence: 6, authoritativeSequence: 8 });
  assert.throws(() => proveGapRecoveryFrames([], {
    fromSequence: 1, toSequence: 6, authoritativeSequence: 6,
  }), { code: 'gap_recovery_invalid' });
});

test('SSE gap recovery rereads authority and advances the reconnect cursor', async () => {
  const { consumeNotebookFrames } = await verifier();
  const authoritative = {
    executionState: 'running',
    progress: { eventSequence: 17, completed: 8, total: 10 },
  };
  let reads = 0;
  const observed = await consumeNotebookFrames({
    frames: [
      { event: 'snapshot', id: 10, data: { type: 'snapshot', eventSequence: 10 } },
      { event: 'gap', id: 16, data: { type: 'gap', eventSequence: 16, fromSequence: 2, toSequence: 16 } },
      { event: 'progress', id: 18, data: { type: 'progress', eventSequence: 18, progress: { eventSequence: 18, completed: 9, total: 10 } } },
    ],
    readStatus: async () => { reads += 1; return authoritative; },
    afterSequence: 0,
  });
  assert.equal(reads, 1);
  assert.equal(observed.gapObserved, true);
  assert.equal(observed.afterSequence, 18);
  assert.deepEqual(observed.recoveries, [{ gapSequence: 16, authoritativeSequence: 17 }]);
});

test('receipt projection redacts secrets, rejects forbidden result fields, and is size bounded', async () => {
  const { encodeReceipt, redactForReceipt, safeErrorForReceipt, writeReceipt } = await verifier();
  const secret = 'bridge-token-must-not-leak';
  const redacted = redactForReceipt({
    authorization: `Bearer ${secret}`,
    token: secret,
    actionToken: secret,
    credentialId: 'qncred_public_receipt_id',
    nested: { apiKey: secret },
  });
  const encoded = encodeReceipt(redacted, 2_048);
  assert.equal(encoded.includes(secret), false);
  assert.equal(encoded.includes('qncred_public_receipt_id'), true);
  const safeError = safeErrorForReceipt(Object.assign(
    new Error('could not read /Users/jtr/private/token-file.txt containing super-secret'),
    { code: 'bridge_token_file_unsafe' },
  ));
  assert.deepEqual(safeError, { code: 'bridge_token_file_unsafe' });
  assert.equal(JSON.stringify(safeError).includes('/Users/'), false);
  assert.throws(() => encodeReceipt({ padding: 'x'.repeat(4_096) }, 1_024), {
    code: 'receipt_too_large',
  });

  const directory = await mkdtemp(path.join(tmpdir(), 'home23-query-verifier-'));
  try {
    const output = path.join(directory, 'receipt.json');
    await writeReceipt(output, { status: 'failed', token: secret }, 2_048);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal((await readFile(output, 'utf8')).includes(secret), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('integrated verifier proves PGS routing and rejects a fake server-gap success', async () => {
  const { parseOptions, runVerifier } = await verifier();
  const run = async (includeGap) => {
    const system = fakeQuerySystem({ includeGap });
    const options = parseOptions([
      '--agent', 'jerry', '--dashboard-url', system.dashboard,
      '--harness-url', system.harness, '--wrong-agent-dashboard-url', system.wrong,
      '--output', path.join(tmpdir(), 'unused-query-verification.json'),
      '--poll-ms', '250', '--sse-observe-ms', '1000',
      '--direct-hard-timeout-ms', '1000', '--direct-stall-timeout-ms', '1000',
      '--pgs-hard-timeout-ms', '1000', '--pgs-stall-timeout-ms', '1000',
      '--chat-hard-timeout-ms', '1000', '--chat-stall-timeout-ms', '1000',
    ], { HOME23_QUERY_BRIDGE_TOKEN: 'fake-bridge-token' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = system.fetchImpl;
    try { return await runVerifier(options); } finally { globalThis.fetch = originalFetch; }
  };

  const receipt = await run(true);
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.routes.dashboard, 'http://dashboard.test');
  assert.equal(receipt.routes.harness, 'http://harness.test');
  assert.equal(receipt.operations.pgs.acceptance.requestKind, 'pgs');
  assert.equal(receipt.operations.pgs.acceptance.requestedLevel, 'sample');
  assert.deepEqual(receipt.operations.pgs.acceptance.sweep,
    { provider: 'minimax', model: 'MiniMax-M2.1' });
  assert.deepEqual(receipt.operations.pgs.acceptance.synthesis,
    { provider: 'anthropic', model: 'claude-opus-4-8' });
  assert.deepEqual(receipt.operations.pgs.sse.serverGap,
    { fromSequence: 1, toSequence: 30, authoritativeSequence: 41 });
  assert.equal(receipt.operations.continuation.result.coverage.reusedWorkUnits, 3);
  assert.equal(receipt.compatibility.brainTool.toolSucceeded, true);

  await assert.rejects(run(false), { code: 'server_gap_not_observed' });
});
