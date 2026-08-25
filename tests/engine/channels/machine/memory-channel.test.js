import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryChannel, _test } from '../../../../engine/src/channels/machine/memory-channel.js';

test('MemoryChannel.crystallize is null above threshold', () => {
  const ch = new MemoryChannel({ intervalMs: 10, lowFreePctThreshold: 10 });
  const v = ch.verify({ payload: { freePct: 50 }, sourceRef: 'm:1', producedAt: '2026-04-21T00:00:00Z' });
  assert.equal(ch.crystallize(v), null);
});

test('MemoryChannel.crystallize fires below threshold', () => {
  const ch = new MemoryChannel({ intervalMs: 10, lowFreePctThreshold: 10 });
  const v = ch.verify({ payload: { freePct: 5 }, sourceRef: 'm:2', producedAt: '2026-04-21T00:00:00Z' });
  const d = ch.crystallize(v);
  assert.ok(d.tags.includes('low-free'));
});


test('parseMemoryPressure safely extracts Darwin system-wide free capacity', () => {
  assert.deepEqual(_test.parseMemoryPressure(`
The system has 17179869184 (1048576 pages with a page size of 16384).
System-wide memory free percentage: 42%
`), {
    source: 'memory_pressure -Q',
    freePct: 42,
    totalBytes: 17179869184,
  });
  assert.equal(_test.parseMemoryPressure('unexpected output'), null);
  assert.equal(_test.parseMemoryPressure('System-wide memory free percentage: 142%'), null);
});

test('MemoryChannel.poll retains legacy fields and adds Darwin pressure plus raw aliases', async () => {
  const ch = new MemoryChannel({
    platform: 'darwin',
    sampleDarwinPressure: async () => ({
      source: 'memory_pressure -Q',
      freePct: 42,
      totalBytes: 17179869184,
    }),
  });

  const [sample] = await ch.poll();
  assert.equal(sample.rawTotal, sample.total);
  assert.equal(sample.rawFree, sample.free);
  assert.equal(sample.rawFreePct, sample.freePct);
  assert.equal(sample.pressureFreePct, 42);
  assert.equal(sample.pressureTotalBytes, 17179869184);
  assert.equal(sample.memoryPressure.source, 'memory_pressure -Q');
});

test('MemoryChannel uses pressure capacity instead of raw free for low-memory crystallization', () => {
  const ch = new MemoryChannel({ lowFreePctThreshold: 10 });
  const healthy = ch.verify({
    payload: { freePct: 1.8, rawFreePct: 1.8, pressureFreePct: 42 },
    sourceRef: 'm:pressure',
    producedAt: '2026-08-22T20:00:00Z',
  });
  assert.equal(ch.crystallize(healthy), null);
});
