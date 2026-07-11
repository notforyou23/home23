import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createCosmoBrainOperationWorkerClient,
  normalizeLoopbackBaseUrl,
} = require('../../../engine/src/dashboard/brain-operations/cosmo-worker-client.js');

const OPERATION_ID = `brop_${'a'.repeat(32)}`;
const CAPABILITY = 'header.payload.signature';

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status || 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('COSMO worker client accepts only uncredentialed loopback HTTP origins', () => {
  assert.equal(normalizeLoopbackBaseUrl('http://127.0.0.1:43210'), 'http://127.0.0.1:43210');
  assert.equal(normalizeLoopbackBaseUrl('http://localhost:43210/'), 'http://localhost:43210');
  assert.equal(normalizeLoopbackBaseUrl('http://[::1]:43210'), 'http://[::1]:43210');
  for (const value of [
    'https://127.0.0.1:43210',
    'http://192.168.1.5:43210',
    'http://user:pass@127.0.0.1:43210',
    'http://127.0.0.1:43210/path',
  ]) assert.throws(() => normalizeLoopbackBaseUrl(value), { code: 'worker_configuration_invalid' });
});

test('control calls use exact protected routes and a fresh bearer without leaking it in bodies', async () => {
  const calls = [];
  const client = createCosmoBrainOperationWorkerClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ ok: true });
    },
  });
  const context = { operationId: OPERATION_ID, operationType: 'query' };
  await client.start(context, CAPABILITY);
  await client.status(OPERATION_ID, CAPABILITY);
  await client.result(OPERATION_ID, CAPABILITY);
  await client.cancel(OPERATION_ID, CAPABILITY);
  assert.deepEqual(calls.map((call) => [call.options.method, call.url]), [
    ['POST', `http://127.0.0.1:43210/api/internal/brain-operations/${OPERATION_ID}/start`],
    ['GET', `http://127.0.0.1:43210/api/internal/brain-operations/${OPERATION_ID}/status`],
    ['GET', `http://127.0.0.1:43210/api/internal/brain-operations/${OPERATION_ID}/result`],
    ['POST', `http://127.0.0.1:43210/api/internal/brain-operations/${OPERATION_ID}/cancel`],
  ]);
  for (const call of calls) {
    assert.equal(call.options.headers.authorization, `Bearer ${CAPABILITY}`);
    assert.doesNotMatch(call.options.body || '', /header\.payload\.signature/);
  }
  assert.deepEqual(JSON.parse(calls[0].options.body), context);
  assert.deepEqual(JSON.parse(calls[3].options.body), {});
  assert.equal(client.supportsSourceOperation('query'), true);
  assert.equal(client.supportsSourceOperation('search'), false);
});

test('events parse chunked NDJSON incrementally and preserve exact cancellation identity', async () => {
  const encoder = new TextEncoder();
  let observedSignal;
  const client = createCosmoBrainOperationWorkerClient({
    fetchImpl: async (url, options) => {
      assert.match(url, /afterSequence=7$/);
      observedSignal = options.signal;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('{"type":"phase","eventSequence":8}\n{"type":'));
          controller.enqueue(encoder.encode('"progress","eventSequence":9}\n'));
          controller.close();
        },
      }), { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    },
  });
  const controller = new AbortController();
  const rows = [];
  for await (const row of client.events(
    OPERATION_ID,
    { afterSequence: 7, signal: controller.signal },
    CAPABILITY,
  )) rows.push(row);
  assert.deepEqual(rows, [
    { type: 'phase', eventSequence: 8 },
    { type: 'progress', eventSequence: 9 },
  ]);
  assert.equal(observedSignal, controller.signal);

  const reason = Object.assign(new Error('detach'), { code: 'detached' });
  const aborted = new AbortController();
  aborted.abort(reason);
  const cancelledClient = createCosmoBrainOperationWorkerClient({
    fetchImpl: async (_url, options) => {
      assert.equal(options.signal, aborted.signal);
      throw options.signal.reason;
    },
  });
  await assert.rejects(async () => {
    for await (const _row of cancelledClient.events(
      OPERATION_ID,
      { afterSequence: 0, signal: aborted.signal },
      CAPABILITY,
    )) {}
  }, (error) => error === reason);
});

test('events reject unterminated frames and error envelopes while JSON reads are bounded', async () => {
  const unterminated = createCosmoBrainOperationWorkerClient({
    fetchImpl: async () => new Response('{"type":"phase"}', { status: 200 }),
  });
  const controller = new AbortController();
  await assert.rejects(async () => {
    for await (const _row of unterminated.events(
      OPERATION_ID,
      { afterSequence: 0, signal: controller.signal },
      CAPABILITY,
    )) {}
  }, { code: 'worker_event_invalid' });

  const denied = createCosmoBrainOperationWorkerClient({
    fetchImpl: async () => jsonResponse({
      success: false,
      error: { code: 'capability_replay', message: 'already used' },
    }, { status: 401 }),
  });
  await assert.rejects(() => denied.status(OPERATION_ID, CAPABILITY), (error) =>
    error.code === 'capability_replay' && error.statusCode === 401);

  const oversized = createCosmoBrainOperationWorkerClient({
    maxJsonBytes: 1024,
    fetchImpl: async () => new Response(JSON.stringify({ value: 'x'.repeat(2000) })),
  });
  await assert.rejects(() => oversized.result(OPERATION_ID, CAPABILITY), {
    code: 'worker_response_too_large',
  });
});
