import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { DashboardServer } = require('../../../engine/src/dashboard/server.js');

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

test('runtime health treats timed-out engine health as degraded when PM2 says process is online', async () => {
  const server = Object.create(DashboardServer.prototype);
  server.getHome23AgentContext = () => ({
    agentName: 'jerry',
    realtimePort: 5001,
    bridgePort: 5004,
  });
  server._home23RuntimeHealthTimeoutMs = 25;
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
    assert.deepEqual(timeouts, [1500, 1500]);
  } finally {
    globalThis.AbortSignal = originalAbortSignal;
  }
});
