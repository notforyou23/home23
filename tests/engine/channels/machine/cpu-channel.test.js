import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CpuChannel } from '../../../../engine/src/channels/machine/cpu-channel.js';

test('CpuChannel poll uses injected sampler', async () => {
  const ch = new CpuChannel({ intervalMs: 10, sample: async () => ({ loadAvg: [0.5, 0.3, 0.2], cpuCount: 8, uptimeSec: 1000, at: '2026-04-21T00:00:00Z' }) });
  const r = await ch.poll();
  assert.equal(r.length, 1);
  assert.equal(r[0].loadAvg[0], 0.5);
});

test('CpuChannel.crystallize is null below spike threshold', () => {
  const ch = new CpuChannel({ intervalMs: 10, spikeThreshold: 2.0 });
  const v = ch.verify({ payload: { loadAvg: [0.5, 0.3, 0.2] }, sourceRef: 'x', producedAt: 't' });
  assert.equal(ch.crystallize(v), null);
});

test('CpuChannel.crystallize fires above spike threshold', () => {
  const ch = new CpuChannel({ intervalMs: 10, spikeThreshold: 2.0 });
  const v = ch.verify({ payload: { loadAvg: [3.5, 2.0, 1.0] }, sourceRef: 'x', producedAt: 't' });
  const d = ch.crystallize(v);
  assert.ok(d.tags.includes('load-spike'));
});
