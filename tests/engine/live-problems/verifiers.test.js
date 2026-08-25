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

test('create_file_tool_probe verifies createFile writes readable bytes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-create-file-probe-test-'));
  const modulePath = path.join(dir, 'tools.cjs');
  fs.writeFileSync(modulePath, `
    const fs = require('fs').promises;
    const path = require('path');
    class ToolExecutor {
      constructor(_indexer, workingDirectory) {
        this.cwd = workingDirectory;
      }
      resolvePath(inputPath) {
        return path.isAbsolute(inputPath) ? inputPath : path.join(this.cwd, inputPath);
      }
      async createFile(filePath, content) {
        const resolved = this.resolvePath(filePath);
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, content, 'utf8');
        return { success: true, path: resolved };
      }
    }
    module.exports = { ToolExecutor };
  `);

  try {
    const result = await runVerifier({
      type: 'create_file_tool_probe',
      args: {
        modulePath,
        filePath: 'nested/probe.txt',
        content: 'probe-body\n',
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.observed.bytes, 'probe-body\n'.length);
    assert.equal(result.observed.contentMatches, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('create_file_tool_probe fails when createFile returns without writing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-create-file-stub-test-'));
  const modulePath = path.join(dir, 'tools.cjs');
  fs.writeFileSync(modulePath, `
    class ToolExecutor {
      constructor(_indexer, workingDirectory) {
        this.cwd = workingDirectory;
      }
      async createFile(filePath, _content) {
        return { success: true, path: this.cwd + '/' + filePath };
      }
    }
    module.exports = { ToolExecutor };
  `);

  try {
    const result = await runVerifier({
      type: 'create_file_tool_probe',
      args: {
        modulePath,
        filePath: 'nested/probe.txt',
        content: 'probe-body\n',
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.detail, /no file was written/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function pm2Jlist(pid, name = 'home23-jerry-dash') {
  return JSON.stringify([{ name, pid, pm2_env: { status: 'online' } }]);
}

// Every pm2_port_owner test routes child processes through this stub. It throws
// on anything but `pm2 jlist`, so an lsof call (or any other shell-out) fails
// the test loudly instead of silently returning to macOS's wedged proc_pidfdinfo.
function onlyPm2ExecFileSync(pid, calls, name) {
  return (command, args) => {
    calls.push([command, ...(args || [])].join(' '));
    if (command === 'pm2') return pm2Jlist(pid, name);
    throw new Error(`forbidden child process: ${command}`);
  };
}

test('pm2_port_owner passes when the listener identifies itself as the PM2 pid', async () => {
  const calls = [];
  const requested = [];
  const result = await runVerifier({
    type: 'pm2_port_owner',
    args: { name: 'home23-jerry-dash', port: '5002' },
  }, {
    execFileSync: onlyPm2ExecFileSync(69054, calls),
    httpGetJson(url, timeoutMs) {
      requested.push({ url, timeoutMs });
      return Promise.resolve({
        status: 200,
        body: JSON.stringify({
          ok: true,
          service: 'home23-dashboard',
          pid: 69054,
          port: 5002,
          agent: 'jerry',
          pm2Name: 'home23-jerry-dash',
          startedAt: '2026-08-21T00:00:00.000Z',
        }),
      });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.observed.pm2Pid, 69054);
  assert.equal(result.observed.listenerPid, 69054);
  assert.equal(result.observed.listenerService, 'home23-dashboard');
  assert.equal(result.observed.listenerPm2Name, 'home23-jerry-dash');
  assert.equal(result.observed.identityUrl, 'http://127.0.0.1:5002/home23/process.json');
  assert.equal(requested.length, 1);
  assert.ok(requested[0].timeoutMs > 0 && requested[0].timeoutMs <= 10000);
  assert.deepEqual(calls, ['pm2 jlist']);
});

test('pm2_port_owner never invokes lsof', async () => {
  const calls = [];
  const result = await runVerifier({
    type: 'pm2_port_owner',
    args: { name: 'home23-jerry-dash', port: '5002' },
  }, {
    execFileSync: onlyPm2ExecFileSync(69054, calls),
    httpGetJson: () => Promise.resolve({ status: 200, body: JSON.stringify({ pid: 69054 }) }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['pm2 jlist']);
  assert.equal(calls.some(call => call.includes('lsof')), false);
});

test('pm2_port_owner never invokes lsof when the identity probe fails either', async () => {
  const calls = [];
  for (const probe of [
    () => Promise.reject(new Error('connect ECONNREFUSED')),
    () => Promise.resolve({ status: 404, body: 'Cannot GET /home23/process.json' }),
    () => Promise.resolve({ status: 200, body: '<html>not json</html>' }),
    () => Promise.resolve({ status: 200, body: JSON.stringify({ pid: 44914 }) }),
  ]) {
    const result = await runVerifier({
      type: 'pm2_port_owner',
      args: { name: 'home23-jerry-dash', port: '5002' },
    }, {
      execFileSync: onlyPm2ExecFileSync(69054, calls),
      httpGetJson: probe,
    });
    assert.equal(result.ok, false);
  }

  assert.deepEqual([...new Set(calls)], ['pm2 jlist']);
});

test('pm2_port_owner fails when a stale listener answers with an older pid', async () => {
  const calls = [];
  const result = await runVerifier({
    type: 'pm2_port_owner',
    args: { name: 'home23-jerry-dash', port: '5002' },
  }, {
    execFileSync: onlyPm2ExecFileSync(67231, calls),
    httpGetJson: () => Promise.resolve({
      status: 200,
      body: JSON.stringify({ ok: true, service: 'home23-dashboard', pid: 44914, port: 5002 }),
    }),
  });

  assert.equal(result.ok, false);
  assert.match(result.detail, /stale pid 44914/);
  assert.match(result.detail, /expected home23-jerry-dash pid 67231/);
  assert.equal(result.observed.listenerPid, 44914);
  assert.deepEqual(calls, ['pm2 jlist']);
});

test('pm2_port_owner fails when the identity endpoint is unreachable', async () => {
  const result = await runVerifier({
    type: 'pm2_port_owner',
    args: { name: 'home23-jerry-dash', port: '5002' },
  }, {
    execFileSync: onlyPm2ExecFileSync(69054, []),
    httpGetJson: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5002')),
  });

  assert.equal(result.ok, false);
  assert.match(result.detail, /no identity answer on port 5002/);
  assert.equal(result.observed.reachable, false);
  assert.equal(result.observed.pm2Pid, 69054);
});

test('pm2_port_owner fails closed when HTTP succeeds but the route is missing', async () => {
  const result = await runVerifier({
    type: 'pm2_port_owner',
    args: { name: 'home23-jerry-dash', port: '5002' },
  }, {
    execFileSync: onlyPm2ExecFileSync(69054, []),
    httpGetJson: () => Promise.resolve({ status: 404, body: 'Cannot GET /home23/process.json' }),
  });

  assert.equal(result.ok, false);
  assert.match(result.detail, /HTTP 404/);
  assert.equal(result.observed.httpStatus, 404);
});

test('pm2_port_owner fails closed on a 200 that is not parseable identity JSON', async () => {
  const malformed = await runVerifier({
    type: 'pm2_port_owner',
    args: { name: 'home23-jerry-dash', port: '5002' },
  }, {
    execFileSync: onlyPm2ExecFileSync(69054, []),
    httpGetJson: () => Promise.resolve({ status: 200, body: '<html>dashboard</html>' }),
  });

  assert.equal(malformed.ok, false);
  assert.match(malformed.detail, /malformed JSON/);

  const nonObject = await runVerifier({
    type: 'pm2_port_owner',
    args: { name: 'home23-jerry-dash', port: '5002' },
  }, {
    execFileSync: onlyPm2ExecFileSync(69054, []),
    httpGetJson: () => Promise.resolve({ status: 200, body: '[1,2,3]' }),
  });

  assert.equal(nonObject.ok, false);
  assert.match(nonObject.detail, /non-object body/);

  const pidless = await runVerifier({
    type: 'pm2_port_owner',
    args: { name: 'home23-jerry-dash', port: '5002' },
  }, {
    execFileSync: onlyPm2ExecFileSync(69054, []),
    httpGetJson: () => Promise.resolve({ status: 200, body: JSON.stringify({ ok: true, service: 'home23-dashboard' }) }),
  });

  assert.equal(pidless.ok, false);
  assert.match(pidless.detail, /no usable pid/);
  assert.equal(pidless.observed.listenerPid, null);
});

test('pm2_port_owner reads a real dashboard identity route over loopback', async () => {
  const server = http.createServer((req, res) => {
    if (req.url !== '/home23/process.json') {
      res.writeHead(404).end('Cannot GET ' + req.url);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'home23-dashboard', pid: process.pid, port: 0 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const port = server.address().port;
    const calls = [];

    const owned = await runVerifier({
      type: 'pm2_port_owner',
      args: { name: 'home23-jerry-dash', port: String(port), timeoutMs: 2000 },
    }, { execFileSync: onlyPm2ExecFileSync(process.pid, calls) });

    assert.equal(owned.ok, true);
    assert.equal(owned.observed.listenerPid, process.pid);

    const stale = await runVerifier({
      type: 'pm2_port_owner',
      args: { name: 'home23-jerry-dash', port: String(port), timeoutMs: 2000 },
    }, { execFileSync: onlyPm2ExecFileSync(process.pid + 1, calls) });

    assert.equal(stale.ok, false);
    assert.match(stale.detail, /stale pid/);

    const missingRoute = await runVerifier({
      type: 'pm2_port_owner',
      args: { name: 'home23-jerry-dash', port: String(port), path: '/nope.json', timeoutMs: 2000 },
    }, { execFileSync: onlyPm2ExecFileSync(process.pid, calls) });

    assert.equal(missingRoute.ok, false);
    assert.match(missingRoute.detail, /HTTP 404/);

    assert.deepEqual([...new Set(calls)], ['pm2 jlist']);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('pm2_port_owner gives up on a listener that accepts but never answers', async () => {
  // The failure this whole change exists to avoid is a probe that cannot be
  // reaped. Prove the bound is real: a socket that is accepted and then held
  // open forever must still resolve to ok:false, not hang the verifier tick.
  const held = new Set();
  const server = http.createServer((req, res) => { held.add(res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const port = server.address().port;
    const startedAt = process.hrtime.bigint();
    const result = await runVerifier({
      type: 'pm2_port_owner',
      args: { name: 'home23-jerry-dash', port: String(port), timeoutMs: 300 },
    }, { execFileSync: onlyPm2ExecFileSync(process.pid, []) });
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    assert.equal(result.ok, false);
    assert.equal(result.observed.reachable, false);
    assert.match(result.detail, /no identity answer on port/);
    assert.ok(elapsedMs < 5000, `verifier must stay bounded, took ${elapsedMs.toFixed(0)}ms`);
  } finally {
    for (const res of held) res.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});

test('pm2_port_owner does not probe anything when the PM2 process is not online', async () => {
  const commands = [];
  let probed = 0;
  const result = await runVerifier({
    type: 'pm2_port_owner',
    args: { name: 'home23-jerry-dash', port: '5002' },
  }, {
    execFileSync(command, args) {
      commands.push([command, ...(args || [])].join(' '));
      if (command === 'pm2') {
        return JSON.stringify([{
          name: 'home23-jerry-dash',
          pid: 0,
          pm2_env: { status: 'stopped' },
        }]);
      }
      throw new Error(`forbidden child process: ${command}`);
    },
    httpGetJson() {
      probed += 1;
      throw new Error('identity probe must not run for an offline process');
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.detail, /status=stopped/);
  assert.deepEqual(commands, ['pm2 jlist']);
  assert.equal(probed, 0);
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

test('jsonl_recent_match can cap unresolved attention notifications', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-jsonl-attention-'));
  const channelsDir = path.join(dir, 'channels');
  fs.mkdirSync(channelsDir, { recursive: true });
  const file = path.join(channelsDir, 'work.notify.cognition.jsonl');
  const now = new Date().toISOString();
  fs.writeFileSync(file, [
    JSON.stringify({
      payload: {
        id: 'notif-unacked',
        severity: 'attention',
        acknowledged: false,
        message: 'operator-visible deadlock',
      },
      receivedAt: now,
    }),
    JSON.stringify({
      payload: {
        severity: 'info',
        acknowledged: false,
        message: 'background note',
      },
      receivedAt: now,
    }),
    '',
  ].join('\n'));

  const result = await runVerifier({
    type: 'jsonl_recent_match',
    args: {
      path: file,
      tsField: 'receivedAt',
      windowMinutes: 60,
      minCount: 0,
      maxCount: 0,
      filters: [
        { field: 'payload.severity', op: '==', value: 'attention' },
        { field: 'payload.acknowledged', op: '==', value: false },
      ],
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.observed.matchCount, 1);
  assert.match(result.detail, /limit 0/);
});

test('jsonl_recent_match overlays notification ack state for append-only bus rows', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-jsonl-attention-acked-'));
  const channelsDir = path.join(dir, 'channels');
  fs.mkdirSync(channelsDir, { recursive: true });
  const file = path.join(channelsDir, 'work.notify.cognition.jsonl');
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'notifications-ack.json'), JSON.stringify({
    'notif-acked': { acknowledged_at: now, acknowledged_by: 'test' },
  }));
  fs.writeFileSync(file, [
    JSON.stringify({
      payload: {
        id: 'notif-acked',
        severity: 'attention',
        acknowledged: false,
        message: 'stale bus snapshot, canonical acked',
      },
      receivedAt: now,
    }),
    '',
  ].join('\n'));

  const result = await runVerifier({
    type: 'jsonl_recent_match',
    args: {
      path: file,
      tsField: 'receivedAt',
      windowMinutes: 60,
      minCount: 0,
      maxCount: 0,
      filters: [
        { field: 'payload.severity', op: '==', value: 'attention' },
        { field: 'payload.acknowledged', op: '==', value: false },
      ],
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.observed.matchCount, 0);
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

// ── oauth_token_lineage_fresh ──
// Regression guard for the 2026-07-27 Codex outage: the Codex CLI refreshed the
// shared account on 07-22, silently invalidating the refresh token Home23 held,
// but nothing surfaced until the 10-day access token aged out 4.5 days later.

function fakeJwt({ iat, exp }) {
  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat, exp })}.sig`;
}

function writeLineageFixture(dir, { profileIat, profileExp, rivalIat, account = 'acct-1', rivalAccount }) {
  const profilePath = path.join(dir, 'auth-profiles.json');
  fs.writeFileSync(profilePath, JSON.stringify({
    version: 1,
    profiles: {
      'openai-codex:default': {
        accessToken: fakeJwt({ iat: profileIat, exp: profileExp }),
        refreshToken: 'rt.profile',
        expires: profileExp * 1000,
        accountId: account,
      },
    },
  }));

  let rivalPath = null;
  if (rivalIat !== undefined) {
    rivalPath = path.join(dir, 'codex-auth.json');
    fs.writeFileSync(rivalPath, JSON.stringify({
      tokens: {
        access_token: fakeJwt({ iat: rivalIat, exp: rivalIat + 864000 }),
        refresh_token: 'rt.rival',
        account_id: rivalAccount || account,
      },
    }));
  }
  return { profilePath, rivalPath };
}

test('oauth_token_lineage_fresh passes when the profile holds the newest credential', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-lineage-ok-'));
  const nowSec = Math.floor(Date.now() / 1000);
  const { profilePath, rivalPath } = writeLineageFixture(dir, {
    profileIat: nowSec - 3600,
    profileExp: nowSec + 864000,
    rivalIat: nowSec - 7200,
  });

  const result = await runVerifier({
    type: 'oauth_token_lineage_fresh',
    args: { profilePath, profileKey: 'openai-codex:default', rivalPath },
  });

  assert.equal(result.ok, true, result.detail);
});

test('oauth_token_lineage_fresh fails when a rival client minted a newer token for the same account', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-lineage-superseded-'));
  const nowSec = Math.floor(Date.now() / 1000);
  // The exact 07-22 shape: profile access token still valid for days, but the
  // CLI already re-minted, so the profile's refresh token is dead on arrival.
  const { profilePath, rivalPath } = writeLineageFixture(dir, {
    profileIat: nowSec - 864000 + 400000,
    profileExp: nowSec + 400000,
    rivalIat: nowSec - 3600,
  });

  const result = await runVerifier({
    type: 'oauth_token_lineage_fresh',
    args: { profilePath, profileKey: 'openai-codex:default', rivalPath },
  });

  assert.equal(result.ok, false);
  assert.match(result.detail, /supersed/i);
  assert.equal(result.observed.superseded, true);
});

test('oauth_token_lineage_fresh ignores a rival credential for a different account', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-lineage-other-acct-'));
  const nowSec = Math.floor(Date.now() / 1000);
  const { profilePath, rivalPath } = writeLineageFixture(dir, {
    profileIat: nowSec - 3600,
    profileExp: nowSec + 864000,
    rivalIat: nowSec - 60,
    rivalAccount: 'acct-other',
  });

  const result = await runVerifier({
    type: 'oauth_token_lineage_fresh',
    args: { profilePath, profileKey: 'openai-codex:default', rivalPath },
  });

  assert.equal(result.ok, true, result.detail);
});

test('oauth_token_lineage_fresh warns before the access token actually expires', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-lineage-expiring-'));
  const nowSec = Math.floor(Date.now() / 1000);
  const { profilePath } = writeLineageFixture(dir, {
    profileIat: nowSec - 864000,
    profileExp: nowSec + 3600, // 1h left, inside the default 3-day warn window
  });

  const result = await runVerifier({
    type: 'oauth_token_lineage_fresh',
    args: { profilePath, profileKey: 'openai-codex:default' },
  });

  assert.equal(result.ok, false);
  assert.match(result.detail, /expir/i);
});

test('oauth_token_lineage_fresh reports a missing profile rather than throwing', async () => {
  const result = await runVerifier({
    type: 'oauth_token_lineage_fresh',
    args: { profilePath: '/nonexistent/auth-profiles.json', profileKey: 'openai-codex:default' },
  });

  assert.equal(result.ok, false);
  assert.match(result.detail, /missing/i);
});
