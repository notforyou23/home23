import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createSynthesisWorker,
} = require('../../../engine/src/dashboard/brain-operations/synthesis-worker.js');
const {
  BrainOperationWorkerAdapter,
} = require('../../../engine/src/dashboard/brain-operations/worker-adapter.js');

const OPERATION_ID = `brop_${'B'.repeat(32)}`;
const ROOT = '/tmp/home23-synthesis-brain';

function context(overrides = {}) {
  const sourcePin = overrides.sourcePin || {
    descriptor: { canonicalRoot: ROOT },
    getEvidence() { return { sourceHealth: 'healthy' }; },
  };
  return {
    operationId: OPERATION_ID,
    operationType: 'synthesis',
    requesterAgent: 'jerry',
    target: {
      domain: 'brain',
      brainId: 'jerry',
      canonicalRoot: ROOT,
      accessMode: 'own',
      ownerAgent: 'jerry',
      kind: 'resident',
      lifecycle: 'resident',
    },
    parameters: {
      trigger: 'manual',
      provider: 'minimax',
      model: 'MiniMax-M3',
    },
    sourcePin,
    signal: null,
    reportEvent() {},
    ...overrides,
  };
}

function worker(agent) {
  return createSynthesisWorker({
    agent,
    selection: { provider: 'minimax', model: 'MiniMax-M3' },
  });
}

test('synthesis worker returns the standard complete envelope without releasing the pin', async () => {
  const calls = [];
  const execute = worker({
    async runOperation(request) {
      calls.push(request);
      return {
        generationMarker: 'generation-51-deadbeef',
        generatedAt: '2026-07-10T12:00:00.000Z',
        sourceRevision: 51,
        provider: 'minimax',
        model: 'MiniMax-M3',
        operationId: OPERATION_ID,
        brainStateSha256: `sha256:${'a'.repeat(64)}`,
      };
    },
  });
  const result = await execute(context());
  assert.equal(result.state, 'complete');
  assert.equal(result.resultArtifact, null);
  assert.equal(result.error, null);
  assert.equal(result.result.generationMarker, 'generation-51-deadbeef');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourcePin.descriptor.canonicalRoot, ROOT);
});

test('synthesis worker denies read-only/cross-owner targets and pair/body overrides before provider work', async () => {
  let calls = 0;
  const execute = worker({ async runOperation() { calls += 1; } });

  for (const changed of [
    { target: { ...context().target, accessMode: 'read-only' } },
    { target: { ...context().target, ownerAgent: 'forrest' } },
    { operationType: 'query' },
    { parameters: { trigger: 'manual', provider: 'anthropic', model: 'MiniMax-M3' } },
    { parameters: { trigger: 'manual', provider: 'minimax', model: 'MiniMax-M3', sourcePath: '/tmp/x' } },
  ]) {
    const result = await execute(context(changed));
    assert.equal(result.state, 'failed');
    assert.equal(result.result, null);
    assert.equal(result.resultArtifact, null);
    assert.ok(['access_denied', 'provider_model_mismatch', 'invalid_request'].includes(result.error.code));
  }
  assert.equal(calls, 0);
});

test('typed provider and source_changed failures publish no marker', async () => {
  for (const error of [
    Object.assign(new Error('provider stopped'), { code: 'provider_incomplete', retryable: true }),
    Object.assign(new Error('revision moved'), { code: 'source_changed', retryable: true }),
  ]) {
    const execute = worker({ async runOperation() { throw error; } });
    const result = await execute(context());
    assert.equal(result.state, 'failed');
    assert.equal(result.result, null);
    assert.equal(result.resultArtifact, null);
    assert.equal(result.error.code, error.code);
    assert.equal(result.error.retryable, true);
    assert.equal(Object.hasOwn(result, 'generationMarker'), false);
  }
});

test('exact cancellation reason reaches the agent and is rethrown to the common terminalizer', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('cancel exactly'), { name: 'AbortError' });
  const execute = worker({
    async runOperation({ signal }) {
      assert.equal(signal, controller.signal);
      controller.abort(reason);
      throw signal.reason;
    },
  });
  await assert.rejects(() => execute(context({ signal: controller.signal })), (error) => error === reason);
});

test('worker forwards the exact event sink and trusted trigger only', async () => {
  const events = [];
  const execute = worker({
    async runOperation(request) {
      assert.equal(request.trigger, 'scheduled');
      await request.onEvent({ type: 'phase', phase: 'synthesis' });
      return {
        generationMarker: 'generation-1-ok', generatedAt: '2026-07-10T12:00:00.000Z',
        sourceRevision: 1, provider: 'minimax', model: 'MiniMax-M3',
        operationId: OPERATION_ID, brainStateSha256: `sha256:${'b'.repeat(64)}`,
      };
    },
  });
  const result = await execute(context({
    parameters: { reason: 'scheduled', provider: 'minimax', model: 'MiniMax-M3' },
    reportEvent: (event) => events.push(event),
  }));
  assert.equal(result.state, 'complete');
  assert.deepEqual(events, [{ type: 'phase', phase: 'synthesis' }]);
});

test('synthesis provider events cross the real local worker adapter as one correlated call', async () => {
  const adapter = new BrainOperationWorkerAdapter({
    supportsSourceOperations: true,
    sourceOperationTypes: ['synthesis'],
  });
  const execute = createSynthesisWorker({
    selection: { provider: 'minimax', model: 'MiniMax-M3' },
    agent: {
      async runOperation({ onEvent }) {
        onEvent({
          type: 'provider_selected', phase: 'synthesis', provider: 'minimax',
          model: 'MiniMax-M3', providerCallId: 'synthesis', providerStallMs: 900000,
          sourceRevision: 51,
        });
        onEvent({
          type: 'provider_activity', phase: 'synthesis', provider: 'minimax',
          model: 'MiniMax-M3', providerCallId: 'synthesis', childEventType: 'content_delta',
          providerEventAt: '2099-01-01T00:00:00.000Z', sourceRevision: 51,
        });
        onEvent({
          type: 'provider_call_terminal', phase: 'synthesis', provider: 'minimax',
          model: 'MiniMax-M3', providerCallId: 'synthesis', outcome: 'complete',
        });
        return {
          generationMarker: 'generation-51-ok', generatedAt: '2026-07-10T12:00:00.000Z',
          sourceRevision: 51, provider: 'minimax', model: 'MiniMax-M3',
          operationId: OPERATION_ID, brainStateSha256: `sha256:${'c'.repeat(64)}`,
        };
      },
    },
  });
  adapter.registerLocalExecutor('synthesis', execute);
  let released = 0;
  const raw = context({
    operationControl: { hardDeadlineAt: '2026-07-11T12:00:00.000Z' },
    scratchDir: '/tmp/home23-synthesis-operation',
    sourcePin: {
      descriptor: { canonicalRoot: ROOT },
      getEvidence() { return { sourceHealth: 'healthy' }; },
      async release() { released += 1; },
    },
    scratchQuota: { async close() {} },
  });
  await adapter.start(raw);
  let status;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    status = await adapter.status(OPERATION_ID);
    if (status.state === 'complete') break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(status.state, 'complete');
  assert.deepEqual(status.activeProviderCalls, []);
  const signal = new AbortController();
  const events = [];
  for await (const event of adapter.events(OPERATION_ID, {
    afterSequence: 0,
    signal: signal.signal,
  })) events.push(event);
  assert.deepEqual(events.slice(0, 3).map((event) => event.type), [
    'provider_selected', 'provider_activity', 'provider_call_terminal',
  ]);
  assert.equal(events[0].providerCallId, 'synthesis');
  assert.equal(events[1].providerCallId, 'synthesis');
  assert.equal(events[2].providerCallId, 'synthesis');
  assert.equal((await adapter.result(OPERATION_ID)).state, 'complete');
  assert.equal(released, 1);
  await adapter.stop();
});
