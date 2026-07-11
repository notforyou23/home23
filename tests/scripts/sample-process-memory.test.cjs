const test = require('node:test');
const assert = require('node:assert/strict');

const targets = [
  { name: 'dashboard', kind: 'pm2', processName: 'home23-jerry-dash' },
  { name: 'cosmo', kind: 'pm2', processName: 'home23-cosmo23' },
];

function set(timestamp, dashboard = {}, cosmo = {}) {
  return [
    {
      name: 'dashboard', pid: 101, restartCount: 3, heapUsedMiB: 100,
      metricUpdatedAt: timestamp, metricTimestampAuthoritative: true,
      observedAt: timestamp + 5, ...dashboard,
    },
    {
      name: 'cosmo', pid: 202, restartCount: 1, heapUsedMiB: 40,
      metricUpdatedAt: timestamp, metricTimestampAuthoritative: true,
      observedAt: timestamp + 5, ...cosmo,
    },
  ];
}

test('computes per-target peak V8 heap from two fresh advancing samples', async () => {
  const { summarizeSamples } = await import('../../scripts/sample-process-memory.mjs');
  const summaries = summarizeSamples({
    targets,
    baseline: set(900),
    samples: [
      set(1_100, { heapUsedMiB: 180 }, { heapUsedMiB: 60 }),
      set(1_200, { heapUsedMiB: 140 }, { heapUsedMiB: 80 }),
    ],
    commandStartedAt: 1_000,
    maxMetricAgeMs: 100,
    maxHeapGrowthMiB: 256,
  });
  assert.deepEqual(summaries.map((row) => ({
    name: row.name,
    peak: row.peakHeapMiB,
    growth: row.heapGrowthMiB,
    fresh: row.metricFresh,
    restartDelta: row.restartDelta,
    pidChanged: row.pidChanged,
  })), [
    { name: 'dashboard', peak: 180, growth: 80, fresh: true, restartDelta: 0, pidChanged: false },
    { name: 'cosmo', peak: 80, growth: 40, fresh: true, restartDelta: 0, pidChanged: false },
  ]);
});

test('fails closed for stale metrics, PID replacement, restart, and heap growth', async () => {
  const { summarizeSamples } = await import('../../scripts/sample-process-memory.mjs');
  const base = {
    targets, baseline: set(900), commandStartedAt: 1_000,
    maxMetricAgeMs: 100, maxHeapGrowthMiB: 256,
  };
  for (const [code, samples, limit = 256] of [
    ['metric_stale', [set(900), set(900)]],
    ['pid_replaced', [set(1_100, { pid: 999 }), set(1_200, { pid: 999 })]],
    ['process_restarted', [set(1_100, { restartCount: 4 }), set(1_200, { restartCount: 4 })]],
    ['process_restarted', [set(1_100, { restartCount: 2 }), set(1_200, { restartCount: 2 })]],
    ['metric_timestamp_untrusted', [
      set(1_100, { metricTimestampAuthoritative: false }),
      set(1_200, { metricTimestampAuthoritative: false }),
    ]],
    ['heap_growth_exceeded', [set(1_100, { heapUsedMiB: 130 }), set(1_200, { heapUsedMiB: 130 })], 20],
  ]) {
    assert.throws(
      () => summarizeSamples({ ...base, samples, maxHeapGrowthMiB: limit }),
      (error) => error.code === code,
      code,
    );
  }
});

test('samples both execution processes around the exact command', async () => {
  const { sampleProcessMemory } = await import('../../scripts/sample-process-memory.mjs');
  let running = true;
  let sampleCalls = 0;
  let time = 1_000;
  const result = await sampleProcessMemory({
    targets,
    command: ['node', 'acceptance-command.mjs'],
    intervalMs: 1,
    maxMetricAgeMs: 100,
    maxHeapGrowthMiB: 256,
    now: () => { time += 10; return time; },
    sampleProvider: async () => {
      sampleCalls += 1;
      const timestamp = 1_010 + sampleCalls * 10;
      if (sampleCalls >= 3) running = false;
      return set(timestamp, { heapUsedMiB: 100 + sampleCalls }, { heapUsedMiB: 40 + sampleCalls });
    },
    commandLauncher: (command) => ({
      isRunning: () => running,
      completed: Promise.resolve({ code: 0, signal: null }),
      command,
    }),
  });
  assert.deepEqual(result.command, ['node', 'acceptance-command.mjs']);
  assert.equal(result.targets.length, 2);
  assert.ok(result.targets.every((target) => target.metricFresh));
  assert.equal(sampleCalls, 4);
  assert.equal(result.targets.every((target) => target.samples.at(-1).postCommand === true), true);
});

test('PM2 targets use loopback request-time runtime metrics instead of synthetic PM2 timestamps', async () => {
  const {
    createDefaultSampleProvider,
    runtimeMetricsUrlForProcess,
  } = await import('../../scripts/sample-process-memory.mjs');
  assert.equal(
    runtimeMetricsUrlForProcess('home23-jerry-dash'),
    'http://127.0.0.1:5002/home23/api/internal/runtime-metrics',
  );
  assert.equal(
    runtimeMetricsUrlForProcess('home23-cosmo23'),
    'http://127.0.0.1:43210/api/internal/runtime-metrics',
  );
  assert.throws(
    () => runtimeMetricsUrlForProcess('unapproved-process'),
    (error) => error.code === 'runtime_metrics_target_unsupported',
  );
  const requests = [];
  const sampledAt = '2026-07-11T12:00:00.000Z';
  const provider = createDefaultSampleProvider({
    listPm2Processes: async () => [
      { name: 'home23-jerry-dash', pid: 101, pm2_env: { restart_time: 3 } },
      { name: 'home23-cosmo23', pid: 202, pm2_env: { restart_time: 1 } },
    ],
    fetchImpl: async (url) => {
      requests.push(String(url));
      const dashboard = String(url).includes(':5002/');
      return new Response(JSON.stringify({
        schemaVersion: 1,
        role: dashboard ? 'dashboard' : 'cosmo',
        pid: dashboard ? 101 : 202,
        heapUsedBytes: (dashboard ? 100 : 40) * 1024 * 1024,
        sampledAt,
      }));
    },
  });
  const rows = await provider(targets, Date.parse(sampledAt) + 5);
  assert.deepEqual(requests, [
    'http://127.0.0.1:5002/home23/api/internal/runtime-metrics',
    'http://127.0.0.1:43210/api/internal/runtime-metrics',
  ]);
  assert.deepEqual(rows.map((row) => ({
    name: row.name,
    heapUsedMiB: row.heapUsedMiB,
    timestamp: row.metricUpdatedAt,
    authoritative: row.metricTimestampAuthoritative,
  })), [
    { name: 'dashboard', heapUsedMiB: 100, timestamp: Date.parse(sampledAt), authoritative: true },
    { name: 'cosmo', heapUsedMiB: 40, timestamp: Date.parse(sampledAt), authoritative: true },
  ]);
});
