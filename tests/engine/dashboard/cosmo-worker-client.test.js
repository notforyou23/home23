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

function exactJsonPayload(bytes) {
  const overhead = Buffer.byteLength(JSON.stringify({ payload: '' }), 'utf8');
  const value = { payload: 'x'.repeat(bytes - overhead) };
  assert.equal(Buffer.byteLength(JSON.stringify(value), 'utf8'), bytes);
  return value;
}

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
    fetchImpl: async (url) => url.endsWith('/start')
      ? jsonResponse({ operationId: OPERATION_ID, operationType: 'query', state: 'running' })
      : new Response(JSON.stringify({ value: 'x'.repeat(10 * 1024 * 1024) })),
  });
  await oversized.start({ operationId: OPERATION_ID, operationType: 'query' }, CAPABILITY);
  await assert.rejects(() => oversized.result(OPERATION_ID, CAPABILITY), {
    code: 'worker_response_too_large',
  });
});

test('result transport keeps small control limits but accepts exact Query and PGS ceilings', async () => {
  const MiB = 1024 * 1024;
  for (const [operationType, bytes, succeeds] of [
    ['query', 64 * 1024 + 1, true],
    ['query', 2 * MiB + 1, true],
    ['query', 8 * MiB, true],
    ['query', 8 * MiB + 1, false],
    ['pgs', 2 * MiB + 1, true],
    ['pgs', 24 * MiB, true],
    ['pgs', 24 * MiB + 1, false],
  ]) {
    const result = exactJsonPayload(bytes);
    const client = createCosmoBrainOperationWorkerClient({
      fetchImpl: async (url) => {
        if (url.endsWith('/start')) {
          return jsonResponse({ operationId: OPERATION_ID, operationType, state: 'running' });
        }
        if (url.endsWith('/result')) {
          return jsonResponse({
            state: 'complete', result, resultArtifact: null, error: null, sourceEvidence: {},
          });
        }
        throw new Error(`unexpected URL ${url}`);
      },
    });
    await client.start({ operationId: OPERATION_ID, operationType }, CAPABILITY);
    if (succeeds) {
      const envelope = await client.result(OPERATION_ID, CAPABILITY);
      assert.equal(Buffer.byteLength(JSON.stringify(envelope.result), 'utf8'), bytes);
    } else {
      await assert.rejects(
        () => client.result(OPERATION_ID, CAPABILITY),
        error => error.code === 'worker_response_too_large',
      );
    }
  }

  const smallControl = createCosmoBrainOperationWorkerClient({
    fetchImpl: async () => jsonResponse({ value: 'x'.repeat(2 * MiB + 1) }),
  });
  await assert.rejects(
    () => smallControl.status(OPERATION_ID, CAPABILITY),
    error => error.code === 'worker_response_too_large',
  );
});

test('status rehydrates operation type from the durable COSMO worker reference after dashboard restart', async () => {
  const calls = [];
  const client = createCosmoBrainOperationWorkerClient({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith('/status')) {
        return jsonResponse({
          reference: {
            version: 1,
            workerId: 'cosmo-worker-restart-fixture',
            workerType: 'cosmo',
            operationType: 'query',
          },
          operationId: OPERATION_ID,
          state: 'complete',
          phase: 'terminal',
          eventSequence: 4,
          activeProviderCalls: [],
        });
      }
      if (url.endsWith('/result')) {
        return jsonResponse({
          state: 'complete',
          result: { answer: 'recovered result' },
          resultArtifact: null,
          error: null,
          sourceEvidence: {},
        });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  await client.status(OPERATION_ID, CAPABILITY);
  const result = await client.result(OPERATION_ID, CAPABILITY);

  assert.equal(result.result.answer, 'recovered result');
  assert.deepEqual(calls.map((url) => url.slice(url.lastIndexOf('/') + 1)), [
    'status',
    'result',
  ]);

  const unsupported = createCosmoBrainOperationWorkerClient({
    fetchImpl: async () => jsonResponse({
      reference: {
        version: 1,
        workerId: 'cosmo-worker-invalid-type',
        workerType: 'cosmo',
        operationType: 'synthesis',
      },
      operationId: OPERATION_ID,
      state: 'running',
      phase: 'executing',
      eventSequence: 1,
      activeProviderCalls: [],
    }),
  });
  await assert.rejects(
    () => unsupported.status(OPERATION_ID, CAPABILITY),
    (error) => error.code === 'worker_transport_invalid',
  );
});

test('fresh client learns authenticated operation type from status before result after restart', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/start') || url.endsWith('/status')) {
      return jsonResponse({
        reference: {
          version: 1, workerId: 'cosmo-restart', workerType: 'cosmo', operationType: 'pgs',
        },
        operationId: OPERATION_ID,
        operationType: 'pgs',
        state: 'complete',
        phase: 'terminal',
        eventSequence: 1,
        activeProviderCalls: [],
      });
    }
    if (url.endsWith('/result')) {
      return jsonResponse({
        state: 'complete', result: { answer: 'after restart', sweepOutputs: [] },
        resultArtifact: null, error: null, sourceEvidence: {},
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const original = createCosmoBrainOperationWorkerClient({ fetchImpl });
  await original.start({ operationId: OPERATION_ID, operationType: 'pgs' }, CAPABILITY);

  const restarted = createCosmoBrainOperationWorkerClient({ fetchImpl });
  const status = await restarted.status(OPERATION_ID, CAPABILITY);
  assert.equal(status.operationType, 'pgs');
  assert.equal((await restarted.result(OPERATION_ID, CAPABILITY)).result.answer, 'after restart');
});

test('result recovers an evicted type through a distinct status capability and deletes terminal cache state', async () => {
  const operationIds = ['b', 'c', 'd'].map(character => `brop_${character.repeat(32)}`);
  const operationTypes = new Map(operationIds.map(operationId => [operationId, 'query']));
  const actions = [];
  const client = createCosmoBrainOperationWorkerClient({
    maxOperationTypeEntries: 2,
    fetchImpl: async (rawUrl, options) => {
      const url = new URL(rawUrl);
      const action = url.pathname.split('/').at(-1);
      const operationId = url.pathname.split('/').at(-2);
      actions.push({ action, operationId, authorization: options.headers.authorization });
      if (action === 'start') {
        return jsonResponse({ operationId, operationType: operationTypes.get(operationId) });
      }
      if (action === 'status') {
        const operationType = operationTypes.get(operationId);
        return jsonResponse({
          reference: {
            version: 1, workerId: `cosmo-${operationId}`, workerType: 'cosmo', operationType,
          },
          operationId,
          operationType,
          state: 'complete',
          phase: 'terminal',
          eventSequence: 1,
          activeProviderCalls: [],
        });
      }
      if (action === 'result') {
        return jsonResponse({
          state: 'complete', result: { answer: operationId },
          resultArtifact: null, error: null, sourceEvidence: {},
        });
      }
      throw new Error(`unexpected action ${action}`);
    },
  });
  for (const operationId of operationIds) {
    await client.start({ operationId, operationType: 'query' }, `start-${operationId}`);
  }

  const first = operationIds[0];
  await client.result(first, 'result-first', 'status-first');
  await client.result(first, 'result-second', 'status-second');
  const recovery = actions.filter(row => row.operationId === first && row.action !== 'start');
  assert.deepEqual(recovery.map(row => row.action), ['status', 'result', 'status', 'result']);
  assert.deepEqual(recovery.map(row => row.authorization), [
    'Bearer status-first', 'Bearer result-first',
    'Bearer status-second', 'Bearer result-second',
  ]);
});

test('custom control limits preserve envelope headroom at exact Query and PGS result ceilings', async () => {
  const MiB = 1024 * 1024;
  for (const [character, operationType, resultBytes] of [
    ['e', 'query', 8 * MiB],
    ['f', 'pgs', 24 * MiB],
  ]) {
    const operationId = `brop_${character.repeat(32)}`;
    const result = exactJsonPayload(resultBytes);
    const client = createCosmoBrainOperationWorkerClient({
      maxJsonBytes: 1024,
      fetchImpl: async (url) => {
        if (url.endsWith('/start')) return jsonResponse({ operationId, operationType });
        if (url.endsWith('/result')) {
          return jsonResponse({
            state: 'complete', result, resultArtifact: null, error: null,
            sourceEvidence: { receipt: 'x'.repeat(32 * 1024) },
          });
        }
        throw new Error(`unexpected URL ${url}`);
      },
    });
    await client.start({ operationId, operationType }, CAPABILITY);
    const envelope = await client.result(operationId, CAPABILITY, 'unused-status-capability');
    assert.equal(Buffer.byteLength(JSON.stringify(envelope.result), 'utf8'), resultBytes);
  }
});
