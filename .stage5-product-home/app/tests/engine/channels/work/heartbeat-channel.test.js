import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HeartbeatChannel } from '../../../../engine/src/channels/work/heartbeat-channel.js';

test('HeartbeatChannel returns one observation per poll with injected state', async () => {
  const state = { cycleCount: 5, awakeForMs: 1234 };
  const ch = new HeartbeatChannel({ getEngineState: () => state, intervalMs: 10 });
  const r = await ch.poll();
  assert.equal(r.length, 1);
  assert.equal(r[0].cycleCount, 5);
  assert.equal(r[0].tick, 1);
});

test('HeartbeatChannel.crystallize is null (informational only)', () => {
  const ch = new HeartbeatChannel({ intervalMs: 10 });
  const v = ch.verify({ payload: { tick: 1 }, sourceRef: 'hb:1', producedAt: '2026-04-21T00:00:00Z' });
  assert.equal(ch.crystallize(v), null);
});
