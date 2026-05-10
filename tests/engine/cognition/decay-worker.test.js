import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DecayWorker } from '../../../engine/src/cognition/decay-worker.mjs';

test('DecayWorker.tick returns 0 when disabled', async () => {
  const w = new DecayWorker({ memory: {}, logger: console, enabled: false });
  const r = await w.tick();
  assert.equal(r.decayed, 0);
});

test('DecayWorker.tick is a no-op when memory has no applyDecay', async () => {
  const w = new DecayWorker({ memory: {}, logger: console, enabled: true });
  const r = await w.tick();
  assert.equal(r.decayed, 0);
});

test('DecayWorker.tick delegates to memory.applyDecay when enabled', async () => {
  const calls = [];
  const memory = { applyDecay: async (opts) => { calls.push(opts); return [{ id: 'm1' }]; } };
  const w = new DecayWorker({
    memory, logger: console, enabled: true,
    halfLife: { warning_node: 48 * 3600 * 1000 },
  });
  const r = await w.tick();
  assert.equal(r.decayed, 1);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].rules.warning);
});
