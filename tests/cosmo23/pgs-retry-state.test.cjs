'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createEngine,
  operationOptions,
  scratchFixture,
  sourcePin,
} = require('./helpers/pinned-pgs-fixture.cjs');

test('fractional PGS retry reuses durable sweeps and launches only pending work', async t => {
  const scratch = await scratchFixture(t, 'home23-pgs-fractional-retry-');
  const pin = sourcePin();
  const first = createEngine();
  const partial = await first.engine.runPinnedOperation(operationOptions(pin, scratch, {
    pgsConfig: { sweepFraction: 0.5 },
  }));

  assert.equal(partial.state, 'complete');
  assert.equal(partial.error, null);
  assert.equal(partial.result.metadata.pgs.selectedWorkUnits, 3);
  assert.equal(partial.result.metadata.pgs.successfulSweeps, 3);
  assert.equal(partial.result.metadata.pgs.scopePendingWorkUnits, 0);
  assert.equal(partial.result.metadata.pgs.globalPendingWorkUnits, 3);

  const retry = createEngine();
  const complete = await retry.engine.runPinnedOperation(operationOptions(pin, scratch));
  assert.equal(complete.state, 'complete');
  assert.equal(complete.result.metadata.pgs.successfulSweeps, 6);
  assert.equal(complete.result.metadata.pgs.pendingWorkUnits, 0);
  assert.equal(retry.calls.filter(call => call.phase === 'sweep').length, 3);
  assert.equal(retry.calls.filter(call => call.phase === 'synth').length, 1);
});

test('named PGS levels expand cumulatively without repeating successful sweeps', async t => {
  const scratch = await scratchFixture(t, 'home23-pgs-level-retry-');
  const pin = sourcePin({ nodeCount: 16 });
  const levels = [
    ['skim', 0.1, 1, 0, 1],
    ['sample', 0.25, 1, 1, 2],
    ['deep', 0.5, 2, 2, 4],
    ['full', 1, 4, 4, 8],
  ];
  const swept = new Set();

  for (const [pgsLevel, sweepFraction, newCount, reusedCount, scopeCount] of levels) {
    const fixture = createEngine();
    const envelope = await fixture.engine.runPinnedOperation(operationOptions(pin, scratch, {
      pgsMode: pgsLevel === 'skim' ? 'fresh' : 'continue',
      pgsLevel,
      pgsConfig: { sweepFraction },
    }));
    assert.equal(envelope.state, 'complete', pgsLevel);
    assert.equal(fixture.calls.filter(call => call.phase === 'sweep').length, newCount, pgsLevel);
    assert.equal(envelope.result.metadata.pgs.reusedWorkUnits, reusedCount, pgsLevel);
    assert.equal(envelope.result.metadata.pgs.newWorkUnits, newCount, pgsLevel);
    assert.equal(envelope.result.metadata.pgs.scopeSuccessfulWorkUnits, scopeCount, pgsLevel);
    assert.equal(envelope.result.metadata.pgs.scopePendingWorkUnits, 0, pgsLevel);
    assert.equal(envelope.result.metadata.pgs.scopeComplete, true, pgsLevel);
    assert.equal(envelope.result.metadata.pgs.globalCoveredWorkUnits, scopeCount, pgsLevel);
    assert.equal(envelope.result.metadata.pgs.fullCoverage, pgsLevel === 'full', pgsLevel);
    for (const call of fixture.calls.filter(call => call.phase === 'sweep')) {
      assert.equal(swept.has(call.options.input), false, `${pgsLevel} repeated a successful unit`);
      swept.add(call.options.input);
    }
  }
});

test('ordinary failed PGS work remains pending and a new attempt retries only that work', async t => {
  const scratch = await scratchFixture(t, 'home23-pgs-failed-retry-');
  const pin = sourcePin();
  let failed = false;
  const events = [];
  const first = createEngine({
    sweepGenerate() {
      if (!failed) {
        failed = true;
        throw Object.assign(new Error('controlled provider outage'), {
          code: 'provider_failed', retryable: true,
        });
      }
      return {
        content: 'useful finding', terminalReceived: true, finishReason: 'completed',
        hadError: false, provider: 'sweep', model: 'shared-model',
      };
    },
  });
  const partial = await first.engine.runPinnedOperation(operationOptions(pin, scratch, {
    reportEvent(event) { events.push(event); },
  }));
  assert.equal(partial.state, 'partial');
  assert.equal(partial.result.metadata.pgs.successfulSweeps, 5);
  assert.equal(partial.result.metadata.pgs.pendingWorkUnits, 1);
  assert.equal(partial.result.metadata.pgs.retryablePartitions.length, 1);
  assert.deepEqual(events
    .filter(event => event.stage === 'sweep_batch_complete')
    .map(({ completed, successful, failed: failedCount, pending, retryable }) => ({
      completed, successful, failed: failedCount, pending, retryable,
    })), [
    { completed: 2, successful: 1, failed: 1, pending: 4, retryable: 1 },
    { completed: 4, successful: 3, failed: 1, pending: 2, retryable: 1 },
    { completed: 6, successful: 5, failed: 1, pending: 0, retryable: 1 },
  ]);

  const retry = createEngine();
  const complete = await retry.engine.runPinnedOperation(operationOptions(pin, scratch));
  assert.equal(complete.state, 'complete');
  assert.equal(retry.calls.filter(call => call.phase === 'sweep').length, 1);
  assert.equal(retry.calls.filter(call => call.phase === 'synth').length, 1);
  assert.equal(pin.releaseCount(), 0);
});

test('retryable failures in the first bounded window do not starve later work', async t => {
  const scratch = await scratchFixture(t, 'home23-pgs-failed-window-');
  const pin = sourcePin({ nodeCount: 40 });
  let sweepCalls = 0;
  const fixture = createEngine({
    sweepGenerate() {
      sweepCalls += 1;
      if (sweepCalls <= 16) {
        throw Object.assign(new Error('controlled first-window outage'), {
          code: 'provider_failed', retryable: true,
        });
      }
      return {
        content: `later finding ${sweepCalls}`,
        terminalReceived: true,
        finishReason: 'completed',
        hadError: false,
        provider: 'sweep',
        model: 'shared-model',
      };
    },
  });

  const partial = await fixture.engine.runPinnedOperation(operationOptions(pin, scratch));

  assert.equal(sweepCalls, 20);
  assert.equal(partial.state, 'partial');
  assert.equal(partial.result.metadata.pgs.successfulSweeps, 4);
  assert.equal(partial.result.metadata.pgs.pendingWorkUnits, 16);
  assert.equal(partial.result.metadata.pgs.newWorkUnits, 4);
});

test('PGS retry configuration is capability-bound to sweepFraction only', async t => {
  const scratch = await scratchFixture(t, 'home23-pgs-bound-retry-');
  const fixture = createEngine();
  await assert.rejects(
    fixture.engine.runPinnedOperation(operationOptions(sourcePin(), scratch, {
      pgsConfig: { sweepFraction: 1, maxConcurrentSweeps: 4 },
    })),
    error => error.code === 'invalid_request',
  );
  assert.equal(fixture.calls.length, 0);
});
