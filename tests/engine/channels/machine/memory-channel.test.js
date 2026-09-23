import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryChannel, _test } from '../../../../engine/src/channels/machine/memory-channel.js';

test('MemoryChannel.crystallize is null above threshold', () => {
  const ch = new MemoryChannel({ intervalMs: 10, lowFreePctThreshold: 10, platform: 'linux' });
  const v = ch.verify({ payload: { freePct: 50 }, sourceRef: 'm:1', producedAt: '2026-04-21T00:00:00Z' });
  assert.equal(ch.crystallize(v), null);
});

test('MemoryChannel.crystallize fires below threshold', () => {
  const ch = new MemoryChannel({ intervalMs: 10, lowFreePctThreshold: 10, platform: 'linux' });
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

test('parseLinuxMeminfo extracts MemAvailable in bytes', () => {
  assert.deepEqual(_test.parseLinuxMeminfo(`
MemTotal:       16384000 kB
MemFree:          131072 kB
MemAvailable:      49152 kB
Buffers:            4096 kB
`), {
    source: '/proc/meminfo:MemAvailable',
    availableBytes: 50_331_648,
  });
  assert.deepEqual(_test.parseLinuxMeminfo('MemAvailable: 0 kB'), {
    source: '/proc/meminfo:MemAvailable',
    availableBytes: 0,
  });
  assert.equal(_test.parseLinuxMeminfo('MemFree: 49152 kB'), null);
  assert.equal(_test.parseLinuxMeminfo('MemAvailable: -1 kB'), null);
  assert.equal(_test.parseLinuxMeminfo('MemAvailable: unknown kB'), null);
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
  assert.equal(sample.memoryPressure.metric, 'system-wide-memory-free-percentage');
  assert.equal(sample.memoryPressure.source, 'memory_pressure -Q');
  assert.equal(sample.memoryPressure.available, true);
});

test('MemoryChannel uses healthy Darwin pressure capacity instead of low raw free', () => {
  const ch = new MemoryChannel({ lowFreePctThreshold: 10, platform: 'darwin' });
  for (const [rawFreePct, pressureFreePct] of [[0.7, 48], [6.7, 53]]) {
    const healthy = ch.verify({
      payload: { freePct: rawFreePct, rawFreePct, pressureFreePct },
      sourceRef: `m:pressure:${pressureFreePct}`,
      producedAt: '2026-09-23T12:00:00Z',
    });
    assert.equal(ch.crystallize(healthy), null);
  }
});

test('MemoryChannel never crystallizes Darwin raw free when pressure is absent', () => {
  const ch = new MemoryChannel({ lowFreePctThreshold: 10, platform: 'darwin' });
  const pressureMissing = ch.verify({
    payload: { freePct: 0.8, rawFreePct: 0.8 },
    sourceRef: 'm:pressure-missing',
    producedAt: '2026-08-22T20:00:00Z',
  });
  assert.equal(ch.crystallize(pressureMissing), null);
});

test('MemoryChannel marks unavailable Darwin pressure and never crystallizes from raw free', async () => {
  const ch = new MemoryChannel({
    platform: 'darwin',
    sampleRawMemory: async () => ({ total: 1_000_000, free: 8_000 }),
    sampleDarwinPressure: async () => null,
  });

  const [sample] = await ch.poll();
  assert.equal(sample.rawFree, 8_000);
  assert.equal(sample.rawFreePct, 0.8);
  assert.equal(sample.freePct, 0.8);
  assert.equal(sample.pressureFreePct, undefined);
  assert.deepEqual(sample.memoryPressure, {
    metric: 'system-wide-memory-free-percentage',
    source: 'memory_pressure -Q',
    available: false,
    unavailableReason: 'sample-unavailable',
  });
  assert.equal(ch.crystallize(ch.verify(ch.parse(sample))), null);
});

test('MemoryChannel.poll uses Linux MemAvailable while retaining raw memory metrics', async () => {
  const ch = new MemoryChannel({
    platform: 'linux',
    sampleRawMemory: async () => ({ total: 1_024_000, free: 51_200 }),
    readLinuxMeminfo: async () => `
MemTotal:        1000 kB
MemFree:           50 kB
MemAvailable:     400 kB
`,
  });

  const [sample] = await ch.poll();
  assert.equal(sample.total, 1_024_000);
  assert.equal(sample.free, 409_600);
  assert.equal(sample.freePct, 40);
  assert.equal(sample.rawTotal, 1_024_000);
  assert.equal(sample.rawFree, 51_200);
  assert.equal(sample.rawFreePct, 5);
  assert.equal(sample.pressureFreePct, 40);
  assert.equal(sample.pressureTotalBytes, 1_024_000);
  assert.equal(sample.memoryPressure.source, '/proc/meminfo:MemAvailable');
  assert.equal(sample.memoryPressure.freeBytes, 409_600);

  const observation = ch.verify(ch.parse(sample));
  assert.equal(ch.crystallize(observation), null);
});

test('MemoryChannel crystallizes low Linux MemAvailable even when raw free is healthy', async () => {
  const ch = new MemoryChannel({
    platform: 'linux',
    sampleRawMemory: async () => ({ total: 1_024_000, free: 409_600 }),
    readLinuxMeminfo: async () => 'MemAvailable: 50 kB',
  });

  const [sample] = await ch.poll();
  assert.equal(sample.freePct, 5);
  assert.equal(sample.rawFreePct, 40);
  assert.ok(ch.crystallize(ch.verify(ch.parse(sample)))?.tags.includes('low-free'));
});

test('MemoryChannel falls back to raw Linux memory when MemAvailable is absent', async () => {
  const ch = new MemoryChannel({
    platform: 'linux',
    sampleRawMemory: async () => ({ total: 1_024_000, free: 51_200 }),
    readLinuxMeminfo: async () => `
MemTotal: 1000 kB
MemFree: 50 kB
`,
  });

  const [sample] = await ch.poll();
  assert.equal(sample.free, 51_200);
  assert.equal(sample.freePct, 5);
  assert.equal(sample.rawFree, 51_200);
  assert.equal(sample.rawFreePct, 5);
  assert.equal(sample.pressureFreePct, undefined);
  assert.equal(sample.memoryPressure, undefined);
  assert.ok(ch.crystallize(ch.verify(ch.parse(sample)))?.tags.includes('low-free'));
});

test('MemoryChannel falls back to raw Linux memory when meminfo cannot be read', async () => {
  const ch = new MemoryChannel({
    platform: 'linux',
    sampleRawMemory: async () => ({ total: 1_024_000, free: 204_800 }),
    readLinuxMeminfo: async () => { throw new Error('unreadable'); },
  });

  const [sample] = await ch.poll();
  assert.equal(sample.free, 204_800);
  assert.equal(sample.freePct, 20);
  assert.equal(sample.rawFree, 204_800);
  assert.equal(sample.rawFreePct, 20);
  assert.equal(sample.pressureFreePct, undefined);
  assert.equal(sample.memoryPressure, undefined);
});
