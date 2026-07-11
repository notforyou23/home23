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

  assert.equal(partial.state, 'partial');
  assert.equal(partial.error.code, 'pgs_partitions_incomplete');
  assert.equal(partial.result.metadata.pgs.selectedWorkUnits, 3);
  assert.equal(partial.result.metadata.pgs.successfulSweeps, 3);
  assert.equal(partial.result.metadata.pgs.pendingWorkUnits, 3);

  const retry = createEngine();
  const complete = await retry.engine.runPinnedOperation(operationOptions(pin, scratch));
  assert.equal(complete.state, 'complete');
  assert.equal(complete.result.metadata.pgs.successfulSweeps, 6);
  assert.equal(complete.result.metadata.pgs.pendingWorkUnits, 0);
  assert.equal(retry.calls.filter(call => call.phase === 'sweep').length, 3);
  assert.equal(retry.calls.filter(call => call.phase === 'synth').length, 1);
});

test('ordinary failed PGS work remains pending and a new attempt retries only that work', async t => {
  const scratch = await scratchFixture(t, 'home23-pgs-failed-retry-');
  const pin = sourcePin();
  let failed = false;
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
  const partial = await first.engine.runPinnedOperation(operationOptions(pin, scratch));
  assert.equal(partial.state, 'partial');
  assert.equal(partial.result.metadata.pgs.successfulSweeps, 5);
  assert.equal(partial.result.metadata.pgs.pendingWorkUnits, 1);
  assert.equal(partial.result.metadata.pgs.retryablePartitions.length, 1);

  const retry = createEngine();
  const complete = await retry.engine.runPinnedOperation(operationOptions(pin, scratch));
  assert.equal(complete.state, 'complete');
  assert.equal(retry.calls.filter(call => call.phase === 'sweep').length, 1);
  assert.equal(retry.calls.filter(call => call.phase === 'synth').length, 1);
  assert.equal(pin.releaseCount(), 0);
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
