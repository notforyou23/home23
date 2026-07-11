const test = require('node:test');
const assert = require('node:assert/strict');

const targets = [
  { name: 'dashboard', kind: 'pm2', processName: 'home23-jerry-dash' },
  { name: 'cosmo', kind: 'pm2', processName: 'home23-cosmo23' },
];

function set(timestamp, dashboard = {}, cosmo = {}) {
  return [
    {
      name: 'dashboard', pid: 101, restartCount: 3,
      v8HeapUsedMiB: 100, rssMiB: 200, processMaxRssMiB: 220,
      metricUpdatedAt: timestamp, metricTimestampAuthoritative: true,
      observedAt: timestamp + 5, ...dashboard,
    },
    {
      name: 'cosmo', pid: 202, restartCount: 1,
      v8HeapUsedMiB: 40, rssMiB: 80, processMaxRssMiB: 90,
      metricUpdatedAt: timestamp, metricTimestampAuthoritative: true,
      observedAt: timestamp + 5, ...cosmo,
    },
  ];
}

test('reports sampled V8/RSS maxima separately from process RSS high-water', async () => {
  const { summarizeSamples } = await import('../../scripts/sample-process-memory.mjs');
  const summaries = summarizeSamples({
    targets,
    baseline: set(900),
    samples: [
      set(1_100,
        { v8HeapUsedMiB: 180, rssMiB: 240, processMaxRssMiB: 250 },
        { v8HeapUsedMiB: 60, rssMiB: 100, processMaxRssMiB: 110 }),
      set(1_200,
        { v8HeapUsedMiB: 140, rssMiB: 220, processMaxRssMiB: 250 },
        { v8HeapUsedMiB: 80, rssMiB: 120, processMaxRssMiB: 130 }),
    ],
    commandStartedAt: 1_000,
    maxMetricAgeMs: 100,
    maxHeapGrowthMiB: 256,
    maxRssGrowthMiB: 256,
  });
  assert.deepEqual(summaries.map((row) => ({
    name: row.name,
    maxSampledV8: row.maxSampledV8HeapUsedMiB,
    sampledV8Growth: row.maxSampledV8HeapGrowthMiB,
    maxSampledRss: row.maxSampledRssMiB,
    sampledRssGrowth: row.maxSampledRssGrowthMiB,
    processMaxRssGrowth: row.processMaxRssGrowthMiB,
    fresh: row.metricFresh,
    restartDelta: row.restartDelta,
    pidChanged: row.pidChanged,
  })), [
    {
      name: 'dashboard', maxSampledV8: 180, sampledV8Growth: 80,
      maxSampledRss: 240, sampledRssGrowth: 40, processMaxRssGrowth: 30,
      fresh: true, restartDelta: 0, pidChanged: false,
    },
    {
      name: 'cosmo', maxSampledV8: 80, sampledV8Growth: 40,
      maxSampledRss: 120, sampledRssGrowth: 40, processMaxRssGrowth: 40,
      fresh: true, restartDelta: 0, pidChanged: false,
    },
  ]);
});

test('fails closed for stale metrics, PID replacement, restart, and heap growth', async () => {
  const { summarizeSamples } = await import('../../scripts/sample-process-memory.mjs');
  const base = {
    targets, baseline: set(900), commandStartedAt: 1_000,
    maxMetricAgeMs: 100, maxHeapGrowthMiB: 256,
  };
  for (const [code, samples, heapLimit = 256, rssLimit = 256] of [
    ['metric_stale', [set(900), set(900)]],
    ['pid_replaced', [set(1_100, { pid: 999 }), set(1_200, { pid: 999 })]],
    ['process_restarted', [set(1_100, { restartCount: 4 }), set(1_200, { restartCount: 4 })]],
    ['process_restarted', [set(1_100, { restartCount: 2 }), set(1_200, { restartCount: 2 })]],
    ['metric_timestamp_untrusted', [
      set(1_100, { metricTimestampAuthoritative: false }),
      set(1_200, { metricTimestampAuthoritative: false }),
    ]],
    ['sampled_v8_heap_growth_exceeded', [
      set(1_100, { v8HeapUsedMiB: 130 }), set(1_200, { v8HeapUsedMiB: 130 }),
    ], 20],
    ['sampled_rss_growth_exceeded', [
      set(1_100, { rssMiB: 230, processMaxRssMiB: 250 }),
      set(1_200, { rssMiB: 230, processMaxRssMiB: 250 }),
    ], 256, 20],
    ['rss_high_water_growth_exceeded', [
      set(1_100, { processMaxRssMiB: 500 }),
      set(1_200, { processMaxRssMiB: 500 }),
    ], 256, 256],
    ['rss_high_water_regressed', [
      set(1_100, { processMaxRssMiB: 250 }),
      set(1_200, { processMaxRssMiB: 240 }),
    ]],
  ]) {
    assert.throws(
      () => summarizeSamples({
        ...base, samples, maxHeapGrowthMiB: heapLimit, maxRssGrowthMiB: rssLimit,
      }),
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
      return set(timestamp, {
        v8HeapUsedMiB: 100 + sampleCalls,
        rssMiB: 200 + sampleCalls,
        processMaxRssMiB: 220 + sampleCalls,
      }, {
        v8HeapUsedMiB: 40 + sampleCalls,
        rssMiB: 80 + sampleCalls,
        processMaxRssMiB: 90 + sampleCalls,
      });
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
  assert.equal(result.metric, 'runtime-memory-evidence-v2');
  assert.match(result.semantics.sampledV8Heap, /not a continuous heap high-water/);
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
  const requestWindowStart = Date.parse('2026-07-11T12:00:00.000Z');
  const clockValues = [
    requestWindowStart,
    requestWindowStart + 25,
    requestWindowStart + 30,
    requestWindowStart + 55,
  ];
  const provider = createDefaultSampleProvider({
    listPm2Processes: async () => [
      { name: 'home23-jerry-dash', pid: 101, pm2_env: { restart_time: 3 } },
      { name: 'home23-cosmo23', pid: 202, pm2_env: { restart_time: 1 } },
    ],
    fetchImpl: async (url) => {
      requests.push(String(url));
      const dashboard = String(url).includes(':5002/');
      const sampledAt = new Date(requestWindowStart + (dashboard ? 10 : 40)).toISOString();
      return new Response(JSON.stringify({
        schemaVersion: 2,
        role: dashboard ? 'dashboard' : 'cosmo',
        pid: dashboard ? 101 : 202,
        v8HeapUsedBytes: (dashboard ? 100 : 40) * 1024 * 1024,
        rssBytes: (dashboard ? 200 : 80) * 1024 * 1024,
        processMaxRssBytes: (dashboard ? 220 : 90) * 1024 * 1024,
        semantics: {
          v8HeapUsedBytes: 'request-time-sample',
          rssBytes: 'request-time-sample',
          processMaxRssBytes: 'process-lifetime-high-water',
        },
        sampledAt,
      }));
    },
    now: () => clockValues.shift(),
  });
  const rows = await provider(targets, requestWindowStart - 100);
  assert.deepEqual(requests, [
    'http://127.0.0.1:5002/home23/api/internal/runtime-metrics',
    'http://127.0.0.1:43210/api/internal/runtime-metrics',
  ]);
  assert.deepEqual(rows.map((row) => ({
    name: row.name,
    v8HeapUsedMiB: row.v8HeapUsedMiB,
    rssMiB: row.rssMiB,
    processMaxRssMiB: row.processMaxRssMiB,
    timestamp: row.metricUpdatedAt,
    observedAt: row.observedAt,
    authoritative: row.metricTimestampAuthoritative,
  })), [
    {
      name: 'dashboard', v8HeapUsedMiB: 100, rssMiB: 200,
      processMaxRssMiB: 220, timestamp: requestWindowStart + 10,
      observedAt: requestWindowStart + 25, authoritative: true,
    },
    {
      name: 'cosmo', v8HeapUsedMiB: 40, rssMiB: 80,
      processMaxRssMiB: 90, timestamp: requestWindowStart + 40,
      observedAt: requestWindowStart + 55, authoritative: true,
    },
  ]);
  assert.equal(clockValues.length, 0);
});

test('PM2 runtime metrics reject timestamps outside the request observation window', async () => {
  const { createDefaultSampleProvider } = await import('../../scripts/sample-process-memory.mjs');
  const requestStartedAt = Date.parse('2026-07-11T12:00:00.000Z');
  const provider = createDefaultSampleProvider({
    listPm2Processes: async () => [
      { name: 'home23-jerry-dash', pid: 101, pm2_env: { restart_time: 3 } },
    ],
    fetchImpl: async () => new Response(JSON.stringify({
      schemaVersion: 2,
      role: 'dashboard',
      pid: 101,
      v8HeapUsedBytes: 100 * 1024 * 1024,
      rssBytes: 200 * 1024 * 1024,
      processMaxRssBytes: 220 * 1024 * 1024,
      semantics: {
        v8HeapUsedBytes: 'request-time-sample',
        rssBytes: 'request-time-sample',
        processMaxRssBytes: 'process-lifetime-high-water',
      },
      sampledAt: new Date(requestStartedAt - 1_001).toISOString(),
    })),
    now: (() => {
      const values = [requestStartedAt, requestStartedAt + 25];
      return () => values.shift();
    })(),
  });
  await assert.rejects(
    provider([targets[0]], requestStartedAt),
    (error) => error.code === 'runtime_metrics_invalid',
  );
});

test('PM2 runtime metrics reject declared and chunked oversized bodies before JSON parsing', async () => {
  const { createDefaultSampleProvider } = await import('../../scripts/sample-process-memory.mjs');
  const pm2 = async () => [
    { name: 'home23-jerry-dash', pid: 101, pm2_env: { restart_time: 3 } },
  ];

  let bodyRead = false;
  const declaredProvider = createDefaultSampleProvider({
    listPm2Processes: pm2,
    fetchImpl: async () => ({
      ok: true,
      headers: new Headers({ 'content-length': String(64 * 1024 + 1) }),
      get body() {
        bodyRead = true;
        throw new Error('oversized declared body must not be opened');
      },
      json() { throw new Error('unbounded response.json must not be called'); },
    }),
  });
  await assert.rejects(
    declaredProvider([targets[0]]),
    (error) => error.code === 'runtime_metrics_invalid',
  );
  assert.equal(bodyRead, false);

  let cancelled = false;
  const chunkedProvider = createDefaultSampleProvider({
    listPm2Processes: pm2,
    fetchImpl: async () => ({
      ok: true,
      headers: new Headers(),
      body: new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(24 * 1024).fill(0x78));
        },
        cancel() { cancelled = true; },
      }),
      json() { throw new Error('unbounded response.json must not be called'); },
    }),
  });
  await assert.rejects(
    chunkedProvider([targets[0]]),
    (error) => error.code === 'runtime_metrics_invalid',
  );
  assert.equal(cancelled, true);
});
