import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const verifierUrl = new URL('../../scripts/verify-query-notebook-live.mjs', import.meta.url);

async function verifier() {
  return import(verifierUrl.href);
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
    { executionState: 'running', updatedAt: '2026-07-13T20:00:00.000Z', progress: { eventSequence: 1, completed: 1, total: 3 } },
    { executionState: 'running', updatedAt: '2026-07-13T20:00:00.000Z', progress: { eventSequence: 1, completed: 1, total: 3 } },
    { executionState: 'running', updatedAt: '2026-07-13T20:00:02.000Z', progress: { eventSequence: 2, completed: 2, total: 3 } },
    { executionState: 'complete', updatedAt: '2026-07-13T20:00:03.000Z', progress: { eventSequence: 3, completed: 3, total: 3 } },
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
    { executionState: 'running', progress: { eventSequence: 5, completed: 2 } },
    { executionState: 'running', progress: { eventSequence: 6, completed: 1 } },
  ];
  await assert.rejects(waitForTerminal({
    readStatus: async () => decreasing.shift(),
    now: () => now,
    sleepImpl: async () => {},
    pollIntervalMs: 1,
    hardTimeoutMs: 10_000,
    stallTimeoutMs: 10_000,
  }), { code: 'progress_not_monotonic' });

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
  const { assertSafeProjection, encodeReceipt, redactForReceipt, writeReceipt } = await verifier();
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
  assert.throws(() => assertSafeProjection({
    answer: 'safe answer',
    sweepOutputs: [{ output: 'private' }],
  }), { code: 'unsafe_projection' });
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
