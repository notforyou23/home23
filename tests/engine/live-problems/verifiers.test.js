import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runVerifier } = require('../../../engine/src/live-problems/verifiers.js');

function hhmmss(date) {
  return [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0'),
  ].join(':');
}

test('http_ping verifies a local HTTP status without fetch', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(204);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const result = await runVerifier({
      type: 'http_ping',
      args: {
        url: `http://127.0.0.1:${port}/health`,
        expectStatus: 204,
        timeoutMs: 1000,
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.observed.status, 204);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('pm2_port_owner passes when the online PM2 process owns the listening port', async () => {
  const result = await runVerifier({
    type: 'pm2_port_owner',
    args: { name: 'home23-jerry-dash', port: '5002' },
  }, {
    execFileSync(command) {
      if (command === 'pm2') {
        return JSON.stringify([{
          name: 'home23-jerry-dash',
          pid: 69054,
          pm2_env: { status: 'online' },
        }]);
      }
      if (command === 'lsof') {
        return [
          'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
          'node    69054  jtr   23u  IPv4 123456      0t0  TCP *:5002 (LISTEN)',
          '',
        ].join('\n');
      }
      throw new Error(`unexpected command ${command}`);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.observed.pm2Pid, 69054);
  assert.deepEqual(result.observed.listenerPids, [69054]);
});

test('pm2_port_owner fails when a stale listener owns the dashboard port', async () => {
  const result = await runVerifier({
    type: 'pm2_port_owner',
    args: { name: 'home23-jerry-dash', port: '5002' },
  }, {
    execFileSync(command) {
      if (command === 'pm2') {
        return JSON.stringify([{
          name: 'home23-jerry-dash',
          pid: 67231,
          pm2_env: { status: 'online' },
        }]);
      }
      if (command === 'lsof') {
        return [
          'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
          'node    44914  jtr   23u  IPv4 123456      0t0  TCP *:5002 (LISTEN)',
          '',
        ].join('\n');
      }
      throw new Error(`unexpected command ${command}`);
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.detail, /expected home23-jerry-dash pid 67231/);
  assert.deepEqual(result.observed.listenerPids, [44914]);
});

test('log_recent_count fails when recent bracketed log matches exceed maxCount', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-log-'));
  const file = path.join(dir, 'engine-err.log');
  const now = new Date();
  fs.writeFileSync(file, [
    `[${hhmmss(now)}] WARN [TimeoutManager] Cycle timeout exceeded after 180000ms`,
    `[${hhmmss(now)}] WARN [TimeoutManager] Cycle timeout exceeded after 180000ms`,
    '',
  ].join('\n'));

  const result = await runVerifier({
    type: 'log_recent_count',
    args: {
      path: file,
      pattern: '\\[TimeoutManager\\] Cycle timeout exceeded',
      windowMinutes: 30,
      maxCount: 0,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.observed.matchCount, 2);
  assert.match(result.detail, /limit 0/);
});

test('log_recent_count includes nearby timeout phase context when configured', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-log-context-'));
  const file = path.join(dir, 'engine-err.log');
  const now = new Date();
  fs.writeFileSync(file, [
    `[${hhmmss(now)}] ERROR: [TimeoutManager] Cycle timeout exceeded {"cycle":12,"timeoutMs":300000,"elapsedMs":301000}`,
    `[${hhmmss(now)}] ERROR: [cycle-phase] timeout context {"cycle":12,"elapsedMs":301000,"phase":"state_save","phaseElapsedMs":53007}`,
    '',
  ].join('\n'));

  const result = await runVerifier({
    type: 'log_recent_count',
    args: {
      path: file,
      pattern: '\\[TimeoutManager\\] Cycle timeout exceeded',
      contextPattern: '\\[cycle-phase\\] timeout context',
      contextWindowLines: 2,
      windowMinutes: 30,
      maxCount: 0,
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.detail, /latest context phase=state_save phaseElapsedMs=53007 elapsedMs=301000/);
  assert.equal(result.observed.lastMatch.contextSummary, 'phase=state_save phaseElapsedMs=53007 elapsedMs=301000');
});

test('log_recent_count ignores matches outside the configured window', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-log-'));
  const file = path.join(dir, 'engine-err.log');
  const old = new Date(Date.now() - 90 * 60_000);
  fs.writeFileSync(file, [
    `[${hhmmss(old)}] WARN [TimeoutManager] Cycle timeout exceeded after 180000ms`,
    '',
  ].join('\n'));

  const result = await runVerifier({
    type: 'log_recent_count',
    args: {
      path: file,
      pattern: '\\[TimeoutManager\\] Cycle timeout exceeded',
      windowMinutes: 30,
      maxCount: 0,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.observed.matchCount, 0);
});

test('log_recent_count can ignore stale matches before the latest start marker', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-log-since-'));
  const file = path.join(dir, 'engine-err.log');
  const now = new Date();
  fs.writeFileSync(file, [
    `[${hhmmss(now)}] ERROR: [TimeoutManager] Cycle timeout exceeded {"cycle":1}`,
    `[${hhmmss(now)}] INFO: Starting cognitive loop...`,
    '',
  ].join('\n'));

  const result = await runVerifier({
    type: 'log_recent_count',
    args: {
      path: file,
      pattern: '\\[TimeoutManager\\] Cycle timeout exceeded',
      sincePattern: 'Starting cognitive loop',
      windowMinutes: 30,
      maxCount: 0,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.observed.matchCount, 0);
  assert.equal(result.observed.sinceLineMatched, true);
});

test('log_recent_count reports missing log files as failed', async () => {
  const result = await runVerifier({
    type: 'log_recent_count',
    args: {
      path: path.join(os.tmpdir(), 'missing-home23-engine.log'),
      pattern: 'Cycle timeout exceeded',
      windowMinutes: 30,
      maxCount: 0,
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.detail, /missing/);
});

test('cron_job_errors fails when enabled jobs have repeated errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-cron-errors-'));
  const cronPath = path.join(dir, 'cron-jobs.json');
  fs.writeFileSync(cronPath, JSON.stringify([
    {
      id: 'job-ok',
      name: 'Healthy job',
      enabled: true,
      state: { lastStatus: 'ok', consecutiveErrors: 0 },
    },
    {
      id: 'job-bad',
      name: 'HealthKit pipeline freshness check',
      enabled: true,
      state: { lastStatus: 'error', consecutiveErrors: 3, lastDurationMs: 6123 },
    },
    {
      id: 'job-disabled',
      name: 'Disabled broken job',
      enabled: false,
      state: { lastStatus: 'error', consecutiveErrors: 99 },
    },
  ]));

  const result = await runVerifier({
    type: 'cron_job_errors',
    args: { path: cronPath, maxConsecutiveErrors: 0 },
  });

  assert.equal(result.ok, false);
  assert.match(result.detail, /HealthKit pipeline freshness check/);
  assert.equal(result.observed.failingJobs.length, 1);
  assert.equal(result.observed.failingJobs[0].id, 'job-bad');
});

test('cron_job_errors passes when enabled jobs are healthy or below threshold', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-cron-ok-'));
  const cronPath = path.join(dir, 'cron-jobs.json');
  fs.writeFileSync(cronPath, JSON.stringify({
    jobs: [
      {
        id: 'job-starting',
        name: 'Starting job',
        enabled: true,
        state: { lastStatus: 'error', consecutiveErrors: 1 },
      },
      {
        id: 'job-ok',
        name: 'Healthy job',
        status: 'enabled',
        lastStatus: 'ok',
        consecutiveErrors: 0,
      },
    ],
  }));

  const result = await runVerifier({
    type: 'cron_job_errors',
    args: { path: cronPath, maxConsecutiveErrors: 1 },
  });

  assert.equal(result.ok, true);
  assert.match(result.detail, /0 failing enabled cron jobs/);
});

test('jsonl_metric_date_fresh fails when wrapper writes are fresh but metric date is stale', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-health-'));
  const file = path.join(dir, 'health.jsonl');
  fs.writeFileSync(file, JSON.stringify({
    ts: new Date().toISOString(),
    metrics: {
      heartRateVariability: { date: '2026-04-21', unit: 'ms', value: 28.5 },
    },
  }) + '\n');

  const result = await runVerifier({
    type: 'jsonl_metric_date_fresh',
    args: {
      path: file,
      metricDateField: 'metrics.heartRateVariability.date',
      maxAgeDays: 3,
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.detail, /stale/);
  assert.equal(result.observed.newestMetricDate, '2026-04-21');
});

test('jsonl_metric_date_fresh passes for a current metric date', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-health-'));
  const file = path.join(dir, 'health.jsonl');
  fs.writeFileSync(file, JSON.stringify({
    ts: new Date().toISOString(),
    metrics: {
      heartRateVariability: { date: new Date().toISOString().slice(0, 10), unit: 'ms', value: 42 },
    },
  }) + '\n');

  const result = await runVerifier({
    type: 'jsonl_metric_date_fresh',
    args: {
      path: file,
      metricDateField: 'metrics.heartRateVariability.date',
      maxAgeDays: 3,
    },
  });

  assert.equal(result.ok, true);
});

test('jsonpath_http retries one transient fetch failure before marking problem open', async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new Error('socket hang up');
    return new Response(JSON.stringify({ sensors: [{ id: 'tile.sauna-control', ts: new Date().toISOString() }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const result = await runVerifier({
      type: 'jsonpath_http',
      args: {
        url: 'http://127.0.0.1:5012/api/sensors',
        path: 'sensors[id=tile.sauna-control].ts',
        op: '>',
        value: '{{iso:now-10min}}',
        timeoutMs: 4000,
      },
    });

    assert.equal(result.ok, true);
    assert.equal(calls, 2);
    assert.match(result.detail, /after 2 attempts/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('jsonpath_http retries a missing selected array element before failing', async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    const sensors = calls === 1
      ? []
      : [{ id: 'tile.sauna-control', ts: new Date().toISOString() }];
    return new Response(JSON.stringify({ sensors }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const result = await runVerifier({
      type: 'jsonpath_http',
      args: {
        url: 'http://127.0.0.1:5012/api/sensors',
        path: 'sensors[id=tile.sauna-control].ts',
        op: '>',
        value: '{{iso:now-10min}}',
        timeoutMs: 4000,
      },
    });

    assert.equal(result.ok, true);
    assert.equal(calls, 2);
    assert.match(result.detail, /after 2 attempts/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('jsonpath_http marks repeated missing selected array element in detail', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ sensors: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  try {
    const result = await runVerifier({
      type: 'jsonpath_http',
      args: {
        url: 'http://127.0.0.1:5012/api/sensors',
        path: 'sensors[id=tile.sauna-control].ts',
        op: '>',
        value: '{{iso:now-10min}}',
        timeoutMs: 4000,
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.detail, /after 2 attempts/);
    assert.match(result.detail, /missing selected array element/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
