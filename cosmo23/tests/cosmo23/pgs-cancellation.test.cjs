'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
  createEngine,
  operationOptions,
  scratchFixture,
  sourcePin,
} = require('./helpers/pinned-pgs-fixture.cjs');

async function eventually(predicate) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('condition did not become true');
}

test('cancellation during pinned projection preserves exact reason before provider work', async t => {
  const scratch = await scratchFixture(t, 'home23-pgs-cancel-projection-');
  const controller = new AbortController();
  const reason = Object.assign(new Error('cancel projection'), { code: 'cancelled' });
  const pin = sourcePin({
    nodeCount: 12,
    onNode(index) { if (index === 2) controller.abort(reason); },
  });
  const fixture = createEngine();

  await assert.rejects(
    fixture.engine.runPinnedOperation(operationOptions(pin, scratch, {
      signal: controller.signal,
    })),
    error => error === reason,
  );
  assert.equal(fixture.calls.length, 0);
  assert.equal(pin.releaseCount(), 0);
});

test('cancelled concurrent sweeps remain pending for a later exact retry', async t => {
  const scratch = await scratchFixture(t, 'home23-pgs-cancel-sweeps-');
  const pin = sourcePin();
  const controller = new AbortController();
  const reason = Object.assign(new Error('cancel sweeps'), { code: 'cancelled' });
  let starts = 0;
  const first = createEngine({
    sweepGenerate(options) {
      starts += 1;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    },
  });
  const pending = first.engine.runPinnedOperation(operationOptions(pin, scratch, {
    signal: controller.signal,
  }));
  await eventually(() => starts === 4);
  controller.abort(reason);

  await assert.rejects(pending, error => error === reason);
  assert.equal(starts, 4);
  const retry = createEngine();
  const complete = await retry.engine.runPinnedOperation(operationOptions(pin, scratch));
  assert.equal(complete.state, 'complete');
  assert.equal(retry.calls.filter(call => call.phase === 'sweep').length, 6);
  assert.equal(complete.result.metadata.pgs.pendingWorkUnits, 0);
});

test('final synthesis cancellation retains useful sweeps but publishes no success receipt', async t => {
  const scratch = await scratchFixture(t, 'home23-pgs-cancel-synthesis-');
  const pin = sourcePin();
  const controller = new AbortController();
  const reason = Object.assign(new Error('cancel synthesis'), { code: 'cancelled' });
  let synthesisStarted = false;
  const first = createEngine({
    synthGenerate(options) {
      synthesisStarted = true;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    },
  });
  const pending = first.engine.runPinnedOperation(operationOptions(pin, scratch, {
    signal: controller.signal,
  }));
  await eventually(() => synthesisStarted);
  controller.abort(reason);

  await assert.rejects(pending, error => error === reason);
  const receiptDir = path.join(scratch.scratchDir, 'pgs-receipts');
  assert.deepEqual(await fs.readdir(receiptDir).catch(() => []), []);

  const retry = createEngine();
  const complete = await retry.engine.runPinnedOperation(operationOptions(pin, scratch));
  assert.equal(complete.state, 'complete');
  assert.equal(retry.calls.filter(call => call.phase === 'sweep').length, 0);
  assert.equal(retry.calls.filter(call => call.phase === 'synth').length, 1);
});
