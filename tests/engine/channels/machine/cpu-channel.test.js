import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CpuChannel,
  createDefaultCpuSampler,
} from '../../../../engine/src/channels/machine/cpu-channel.js';

function saturatedPayload({ load1 = 8.5, cpuCount = 10 } = {}) {
  return {
    loadAvg: [load1, load1 - 0.5, load1 - 1],
    cpuCount,
    cpuUtilization: {
      available: true,
      aggregate: { busyPct: 91, idlePct: 9 },
      perCore: Array.from({ length: cpuCount }, (_, index) => ({
        index,
        busyPct: index === cpuCount - 1 ? 70 : 93,
        idlePct: index === cpuCount - 1 ? 30 : 7,
      })),
    },
    scheduler: { available: true, runnableProcesses: 1, runQueueProxy: 1 },
  };
}

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

test('CpuChannel.crystallize does not fire when normalized load is high but evidence is missing', () => {
  const ch = new CpuChannel({ intervalMs: 10, saturationRatioThreshold: 0.8 });
  const v = ch.verify({ payload: { loadAvg: [7, 2.0, 1.0], cpuCount: 8 }, sourceRef: 'x', producedAt: 't' });
  assert.equal(ch.crystallize(v), null);
});

test('CpuChannel.crystallize does not treat load1=4 on 10 CPUs as a spike', () => {
  const ch = new CpuChannel({ intervalMs: 10 });
  const v = ch.verify({ payload: { loadAvg: [4, 3.5, 3], cpuCount: 10 }, sourceRef: 'x', producedAt: 't' });
  assert.equal(ch.crystallize(v), null);
});

test('CpuChannel.crystallize does not fire for high load with high idle and no runnable queue', () => {
  const ch = new CpuChannel({ intervalMs: 10 });
  const payload = saturatedPayload();
  payload.cpuUtilization.aggregate = { busyPct: 12, idlePct: 88 };
  payload.cpuUtilization.perCore = payload.cpuUtilization.perCore.map(core => ({ ...core, busyPct: 12, idlePct: 88 }));
  payload.scheduler.runnableProcesses = 0;
  payload.scheduler.runQueueProxy = 0;
  const v = ch.verify({ payload, sourceRef: 'x', producedAt: 't' });
  assert.equal(ch.crystallize(v), null);
});

test('CpuChannel.crystallize allows all-core saturation from one runnable multithreaded process', () => {
  const ch = new CpuChannel({ intervalMs: 10 });
  const v = ch.verify({ payload: saturatedPayload(), sourceRef: 'x', producedAt: 't' });
  const d = ch.crystallize(v);
  assert.ok(d.tags.includes('load-spike'));
  assert.ok(d.tags.includes('capacity-saturated'));
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
  const v = ch.verify({ payload: saturatedPayload({ load1: 3.5, cpuCount: 8 }), sourceRef: 'x', producedAt: 't' });
  const d = ch.crystallize(v);
  assert.ok(d.tags.includes('load-spike'));
});

test('default CPU sampler derives utilization deltas and bounded ps evidence', async () => {
  let cpuRead = 0;
  const snapshots = [
    [
      { times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } },
      { times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } },
    ],
    [
      { times: { user: 180, nice: 0, sys: 60, idle: 860, irq: 0 } },
      { times: { user: 140, nice: 0, sys: 60, idle: 900, irq: 0 } },
    ],
  ];
  const osModule = {
    cpus: () => snapshots[Math.min(cpuRead++, snapshots.length - 1)],
    loadavg: () => [2.1, 1.8, 1.5],
    uptime: () => 1234,
  };
  let execOptions;
  const execFileFn = (file, args, options, callback) => {
    assert.equal(file, 'ps');
    assert.deepEqual(args, ['-axo', 'pid=,ppid=,state=,%cpu=,comm=']);
    execOptions = options;
    callback(null, [
      '  11   1 R    75.5 worker-a',
      '  12   1 U    14.2 blocked-worker',
      '  13   1 S     3.0 helper',
    ].join('\n'));
  };
  const sampler = createDefaultCpuSampler({
    osModule,
    execFileFn,
    now: (() => { let value = 1_000; return () => (value += 1_000); })(),
  });

  const sample = await sampler();
  assert.deepEqual(sample.cpuUtilization.aggregate, { busyPct: 70, idlePct: 30 });
  assert.deepEqual(sample.cpuUtilization.perCore.map(core => core.busyPct), [90, 50]);
  assert.equal(sample.scheduler.runnableProcesses, 1);
  assert.equal(sample.scheduler.runQueueProxy, 1);
  assert.equal(sample.scheduler.blockedProcesses, 1);
  assert.equal(sample.scheduler.uninterruptibleProcesses, 1);
  assert.deepEqual(sample.topCpuProcesses.map(process => process.pid), [11, 12, 13]);
  assert.equal(sample.iowait, null);
  assert.equal(sample.iowaitAvailable, false);
  assert.equal(execOptions.timeout, 2_000);
  assert.equal(execOptions.maxBuffer, 512 * 1024);
});
