import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { DashboardServer, readJsonlTail } = require('../../../engine/src/dashboard/server.js');

test('live-problems file resolves through requested agent context', () => {
  const server = Object.create(DashboardServer.prototype);
  server.getHome23AgentContext = (candidate) => ({
    agentName: candidate || 'jerry',
    runtimeDir: path.join('/tmp/home23-test', 'instances', candidate || 'jerry', 'brain'),
  });

  assert.equal(
    server.getHome23LiveProblemsFile('forrest'),
    path.join('/tmp/home23-test', 'instances', 'forrest', 'brain', 'live-problems.json'),
  );
});

test('readJsonlTail reads only the requested recent JSONL rows from a bounded window', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'home23-jsonl-tail-'));
  const file = path.join(dir, 'good-life-ledger.jsonl');
  try {
    const rows = [];
    for (let i = 0; i < 200; i++) {
      rows.push(JSON.stringify({
        index: i,
        payload: 'x'.repeat(120),
      }));
    }
    writeFileSync(file, rows.join('\n') + '\n');

    const tail = readJsonlTail(file, 3, 2048);

    assert.deepEqual(tail.map((row) => row.index), [197, 198, 199]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dashboard stop closes runtime handles used by PM2 restarts', async () => {
  const server = Object.create(DashboardServer.prototype);
  let synthesisStopped = false;
  let intervalCleared = false;
  let clientEnded = false;
  let clientDestroyed = false;
  let httpClosed = false;
  const originalClearInterval = globalThis.clearInterval;
  globalThis.clearInterval = (handle) => {
    if (handle === 'watch-handle') intervalCleared = true;
    return originalClearInterval(handle);
  };

  server._shutdownStarted = false;
  server._synthesisAgent = { stopSchedule: () => { synthesisStopped = true; } };
  server._logWatchInterval = 'watch-handle';
  server.logStreamClients = new Set([{
    end: () => { clientEnded = true; },
    destroy: () => { clientDestroyed = true; },
  }]);
  server._serverSockets = new Set();
  server.server = { close: (cb) => { httpClosed = true; cb(); } };

  try {
    await server.stop('test');

    assert.equal(synthesisStopped, true);
    assert.equal(intervalCleared, true);
    assert.equal(clientEnded, true);
    assert.equal(clientDestroyed, true);
    assert.equal(httpClosed, true);
    assert.equal(server.server, null);
    assert.equal(server._logWatchInterval, null);
    assert.equal(server.logStreamClients.size, 0);
  } finally {
    globalThis.clearInterval = originalClearInterval;
  }
});

test('dashboard concurrent stop callers share the in-flight brain cleanup', async () => {
  const server = Object.create(DashboardServer.prototype);
  let releaseCleanup;
  let coordinatorStops = 0;
  let workerStops = 0;
  server._shutdownStarted = false;
  server._shutdownPromise = null;
  server._synthesisAgent = null;
  server._logWatchInterval = null;
  server.logStreamClients = new Set();
  server._serverSockets = new Set();
  server.server = null;
  server.brainOperationsCoordinator = {
    async stop() {
      coordinatorStops += 1;
      await new Promise((resolve) => { releaseCleanup = resolve; });
    },
  };
  server.brainOperationsWorker = {
    async stop() { workerStops += 1; },
  };

  const first = server.stop('first-signal');
  await new Promise((resolve) => setImmediate(resolve));
  const second = server.stop('second-signal');
  let secondResolved = false;
  second.then(() => { secondResolved = true; });
  await new Promise((resolve) => setImmediate(resolve));

  try {
    assert.equal(first, second);
    assert.equal(secondResolved, false);
    assert.equal(coordinatorStops, 1);
    assert.equal(workerStops, 0);
  } finally {
    releaseCleanup();
  }
  await Promise.all([first, second]);
  assert.equal(workerStops, 1);
});

test('dashboard stop force-closes tracked sockets when active connections block close', async () => {
  const server = Object.create(DashboardServer.prototype);
  let closeCalled = false;
  let idleClosed = false;
  let allClosed = false;
  let socketDestroyed = false;

  server._shutdownStarted = false;
  server._synthesisAgent = null;
  server._logWatchInterval = null;
  server.logStreamClients = new Set();
  server._serverCloseTimeoutMs = 25;
  server._socketDestroyGraceMs = 1;
  server._serverSockets = new Set([{
    destroy: () => { socketDestroyed = true; },
  }]);
  server.server = {
    close: () => { closeCalled = true; },
    closeIdleConnections: () => { idleClosed = true; },
    closeAllConnections: () => { allClosed = true; },
  };

  await server.stop('test-active-connections');

  assert.equal(closeCalled, true);
  assert.equal(idleClosed, true);
  assert.equal(allClosed, true);
  assert.equal(socketDestroyed, true);
  assert.equal(server.server, null);
  assert.equal(server._serverSockets.size, 0);
});

test('runtime health treats timed-out engine health as degraded when PM2 says process is online', async () => {
  const server = Object.create(DashboardServer.prototype);
  server.getHome23AgentContext = () => ({
    agentName: 'jerry',
    realtimePort: 5001,
    bridgePort: 5004,
  });
  server._home23RuntimeEngineHealthTimeoutMs = 25;
  server._home23RuntimeHealthTimeoutMs = 2500;
  server._home23RuntimeHealthFetch = async (url) => {
    if (url.includes(':5001/health')) {
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      throw error;
    }
    return {
      ok: true,
      status: 200,
    };
  };
  server._home23RuntimeProcessSnapshot = () => ({
    'home23-jerry': { name: 'home23-jerry', status: 'online', pid: 1234 },
    'home23-jerry-harness': { name: 'home23-jerry-harness', status: 'online', pid: 1235 },
  });

  const health = await server.getHome23RuntimeHealth('jerry');
  const engine = health.services.find((service) => service.id === 'engine');

  assert.equal(health.ok, true);
  assert.equal(engine.ok, true);
  assert.equal(engine.degraded, true);
  assert.equal(engine.slow, true);
  assert.equal(engine.fallback, 'pm2-online');
  assert.equal(engine.timeoutMs, 25);
  assert.match(engine.error, /health endpoint timed out/i);
  assert.equal(engine.pm2.status, 'online');
});

test('runtime health default timeout stays bounded for operator responsiveness', async () => {
  const server = Object.create(DashboardServer.prototype);
  server.getHome23AgentContext = () => ({
    agentName: 'jerry',
    realtimePort: 5001,
    bridgePort: 5004,
  });
  server._home23RuntimeProcessSnapshot = () => ({});
  const originalAbortSignal = globalThis.AbortSignal;
  const timeouts = [];
  globalThis.AbortSignal = {
    ...originalAbortSignal,
    timeout(ms) {
      timeouts.push(ms);
      return originalAbortSignal.timeout(ms);
    },
  };
  server._home23RuntimeHealthFetch = async () => ({
    ok: true,
    status: 200,
  });

  try {
    const health = await server.getHome23RuntimeHealth('jerry');

    assert.equal(health.ok, true);
    assert.ok(health.services.every((service) => service.ok));
    assert.deepEqual(timeouts, [2000, 2500]);
  } finally {
    globalThis.AbortSignal = originalAbortSignal;
  }
});

test('runtime health lets callers override engine timeout separately from harness timeout', async () => {
  const server = Object.create(DashboardServer.prototype);
  server.getHome23AgentContext = () => ({
    agentName: 'jerry',
    realtimePort: 5001,
    bridgePort: 5004,
  });
  server._home23RuntimeEngineHealthTimeoutMs = 125;
  server._home23RuntimeHealthTimeoutMs = 1500;
  server._home23RuntimeProcessSnapshot = () => ({});
  const originalAbortSignal = globalThis.AbortSignal;
  const timeouts = [];
  globalThis.AbortSignal = {
    ...originalAbortSignal,
    timeout(ms) {
      timeouts.push(ms);
      return originalAbortSignal.timeout(ms);
    },
  };
  server._home23RuntimeHealthFetch = async () => ({
    ok: true,
    status: 200,
  });

  try {
    const health = await server.getHome23RuntimeHealth('jerry');

    assert.equal(health.ok, true);
    assert.deepEqual(timeouts, [125, 1500]);
    assert.equal(health.services.find((service) => service.id === 'engine').timeoutMs, 125);
    assert.equal(health.services.find((service) => service.id === 'harness').timeoutMs, 1500);
  } finally {
    globalThis.AbortSignal = originalAbortSignal;
  }
});
