import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Closer } from '../../../engine/src/cognition/closer.mjs';

test('Closer constructs and runs a no-op close when disabled', async () => {
  const c = new Closer({ memory: {}, goals: {}, logger: console, enabled: false });
  const r = await c.close();
  assert.deepEqual(r, { closed: [], deduped: [], resolved: [] });
});

test('Closer.dedupeBeforeSpawn returns null when disabled', async () => {
  const c = new Closer({ memory: {}, goals: {}, logger: console, enabled: false });
  const r = await c.dedupeBeforeSpawn({ topicTags: ['x'] });
  assert.equal(r, null);
});

test('Closer.resolveWarning returns resolved:0 when disabled', async () => {
  const c = new Closer({ memory: {}, goals: {}, logger: console, enabled: false });
  const r = await c.resolveWarning({ channelId: 'x', flag: 'COLLECTED' });
  assert.deepEqual(r, { resolved: 0 });
});
