import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CpuChannel } from '../../../../engine/src/channels/machine/cpu-channel.js';

test('CpuChannel poll uses injected sampler', async () => {
  const ch = new CpuChannel({ intervalMs: 10, sample: async () => ({ loadAvg: [0.5, 0.3, 0.2], cpuCount: 8, uptimeSec: 1000, at: '2026-04-21T00:00:00Z' }) });
  const r = await ch.poll();
  assert.equal(r.length, 1);
  assert.equal(r[0].loadAvg[0], 0.5);
});

test('CpuChannel.crystallize is null below saturation ratio threshold', () => {
  const ch = new CpuChannel({ intervalMs: 10, saturationRatioThreshold: 0.8 });
  const v = ch.verify({ payload: { loadAvg: [0.5, 0.3, 0.2], cpuCount: 8 }, sourceRef: 'x', producedAt: 't' });
  assert.equal(ch.crystallize(v), null);
});

test('CpuChannel.crystallize fires above saturation ratio threshold', () => {
  const ch = new CpuChannel({ intervalMs: 10, saturationRatioThreshold: 0.8 });
  const v = ch.verify({ payload: { loadAvg: [7, 2.0, 1.0], cpuCount: 8 }, sourceRef: 'x', producedAt: 't' });
  const d = ch.crystallize(v);
  assert.ok(d.tags.includes('load-spike'));
});

test('CpuChannel.crystallize does not treat load1=4 on 10 CPUs as a spike', () => {
  const ch = new CpuChannel({ intervalMs: 10 });
  const v = ch.verify({ payload: { loadAvg: [4, 3.5, 3], cpuCount: 10 }, sourceRef: 'x', producedAt: 't' });
  assert.equal(ch.crystallize(v), null);
});

test('CpuChannel.crystallize fires for genuinely saturated normalized load', () => {
  const ch = new CpuChannel({ intervalMs: 10 });
  const v = ch.verify({ payload: { loadAvg: [8.5, 8, 7.5], cpuCount: 10 }, sourceRef: 'x', producedAt: 't' });
  const d = ch.crystallize(v);
  assert.ok(d.tags.includes('load-spike'));
});

test('CpuChannel.crystallize safely ignores missing or invalid cpuCount', () => {
  const ch = new CpuChannel({ intervalMs: 10 });

  for (const cpuCount of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const v = ch.verify({ payload: { loadAvg: [8.5, 8, 7.5], cpuCount }, sourceRef: 'x', producedAt: 't' });
    assert.equal(ch.crystallize(v), null);
  }
});

test('CpuChannel accepts spikeThreshold as a normalized-ratio compatibility alias', () => {
  const ch = new CpuChannel({ intervalMs: 10, spikeThreshold: 0.4 });
  const v = ch.verify({ payload: { loadAvg: [3.5, 2.0, 1.0], cpuCount: 8 }, sourceRef: 'x', producedAt: 't' });
  const d = ch.crystallize(v);
  assert.ok(d.tags.includes('load-spike'));
});
