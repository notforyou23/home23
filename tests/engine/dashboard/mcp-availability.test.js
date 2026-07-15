import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isMcpProxyAvailable,
  probeMcpAvailability,
} = require('../../../engine/src/dashboard/mcp-availability.js');
const {
  createMcpReadinessController,
} = require('../../../shared/memory-source/mcp-http-runtime.cjs');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test('configured enabled MCP fails closed when its exact loopback runtime is unreachable', async () => {
  const reservation = http.createServer();
  const port = await listen(reservation);
  await close(reservation);

  assert.equal(isMcpProxyAvailable({ HOME23_MCP_AVAILABLE: 'true' }), true);
  const result = await probeMcpAvailability({
    enabled: true,
    port,
    timeoutMs: 250,
  });

  assert.equal(result.available, false);
  assert.equal(result.endpoint, null);
  assert.equal(result.reason, 'mcp_unreachable');
  assert.equal(typeof result.detail, 'string');
  assert.equal(result.detail.length > 0, true);
});

test('configured enabled MCP becomes available only from the exact loopback health response', async (t) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, host: request.headers.host });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      ok: true,
      protocolVersion: '2025-03-26',
      sourceHealth: 'healthy',
      revision: 17,
    }));
  });
  const port = await listen(server);
  t.after(() => close(server));

  const result = await probeMcpAvailability({ enabled: true, port, timeoutMs: 1_000 });

  assert.deepEqual(requests, [{
    method: 'GET',
    url: '/health',
    host: `127.0.0.1:${port}`,
  }]);
  assert.deepEqual(result, {
    available: true,
    endpoint: `http://127.0.0.1:${port}/mcp`,
    reason: null,
  });
});

test('disabled MCP never probes and unhealthy canonical source never advertises an endpoint', async () => {
  let probes = 0;
  const fetchImpl = async () => {
    probes += 1;
    return new Response(JSON.stringify({
      ok: false,
      protocolVersion: '2025-03-26',
      sourceHealth: 'unavailable',
    }), { status: 503, headers: { 'content-type': 'application/json' } });
  };

  assert.deepEqual(await probeMcpAvailability({
    enabled: false,
    port: 5003,
    fetchImpl,
  }), {
    available: false,
    endpoint: null,
    reason: 'mcp_disabled',
  });
  assert.equal(probes, 0);

  const unavailable = await probeMcpAvailability({
    enabled: true,
    port: 5003,
    fetchImpl,
  });
  assert.equal(probes, 1);
  assert.deepEqual(unavailable, {
    available: false,
    endpoint: null,
    reason: 'mcp_unhealthy',
  });
});

test('HTTP-success health with unavailable source fails closed as source unavailable', async () => {
  const result = await probeMcpAvailability({
    enabled: true,
    port: 5003,
    fetchImpl: async () => new Response(JSON.stringify({
      ok: false,
      protocolVersion: '2025-03-26',
      sourceHealth: 'unavailable',
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  assert.deepEqual(result, {
    available: false,
    endpoint: null,
    reason: 'mcp_source_unavailable',
  });
});

test('availability retries only typed transient source health within one bounded budget', async () => {
  const responses = [
    new Response(JSON.stringify({
      ok: false,
      protocolVersion: '2025-03-26',
      sourceHealth: 'unavailable',
      error: { code: 'source_refresh_pending', retryable: true },
    }), { status: 503, headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({
      ok: false,
      protocolVersion: '2025-03-26',
      sourceHealth: 'unavailable',
      error: { code: 'source_busy', retryable: true },
    }), { status: 503, headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({
      ok: true,
      protocolVersion: '2025-03-26',
      sourceHealth: 'healthy',
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  ];
  let now = 100;
  let calls = 0;
  const result = await probeMcpAvailability({
    enabled: true,
    port: 5003,
    timeoutMs: 100,
    retryDelayMs: 10,
    now: () => now,
    sleepImpl: async (delay) => { now += delay; },
    fetchImpl: async () => {
      const response = responses[calls];
      calls += 1;
      return response;
    },
  });
  assert.equal(calls, 3);
  assert.deepEqual(result, {
    available: true,
    endpoint: 'http://127.0.0.1:5003/mcp',
    reason: null,
  });
});

test('availability never retries an actual source failure', async () => {
  let calls = 0;
  const result = await probeMcpAvailability({
    enabled: true,
    port: 5003,
    timeoutMs: 100,
    retryDelayMs: 10,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({
        ok: false,
        protocolVersion: '2025-03-26',
        sourceHealth: 'unavailable',
        error: { code: 'source_unavailable', retryable: true },
      }), { status: 503, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    available: false,
    endpoint: null,
    reason: 'mcp_source_unavailable',
  });
});

test('repeated live-shaped health probes remain available across multiple TTLs', async (t) => {
  let checks = 0;
  const readiness = createMcpReadinessController({
    memoryTools: {
      async checkReadiness() {
        checks += 1;
        return { ok: true, sourceHealth: 'healthy', revision: checks };
      },
    },
    retryMs: 60,
    refreshIntervalMs: 20,
    logger: { warn() {} },
  });
  await readiness.refresh();
  const server = http.createServer((_request, response) => {
    const status = readiness.status();
    response.writeHead(status.ok ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify(status));
  });
  const port = await listen(server);
  t.after(async () => {
    readiness.close();
    await close(server);
  });

  for (let probe = 0; probe < 5; probe += 1) {
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.deepEqual(await probeMcpAvailability({ port, timeoutMs: 300 }), {
      available: true,
      endpoint: `http://127.0.0.1:${port}/mcp`,
      reason: null,
    });
  }
  assert.equal(checks >= 4, true);
});

test('availability transient retries never extend the original timeout budget', async () => {
  let now = 100;
  let calls = 0;
  const sleeps = [];
  const result = await probeMcpAvailability({
    enabled: true,
    port: 5003,
    timeoutMs: 25,
    retryDelayMs: 10,
    now: () => now,
    sleepImpl: async (delay) => {
      sleeps.push(delay);
      now += delay;
    },
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({
        ok: false,
        protocolVersion: '2025-03-26',
        sourceHealth: 'unavailable',
        error: { code: 'source_refresh_pending', retryable: true },
      }), { status: 503, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.deepEqual(sleeps, [10, 10, 5]);
  assert.equal(calls, 3);
  assert.equal(now, 125);
  assert.deepEqual(result, {
    available: false,
    endpoint: null,
    reason: 'mcp_source_unavailable',
  });
});

test('availability makes one probe for an untyped or nonretryable 503', async () => {
  for (const fixture of [
    { error: null },
    { error: { code: 'source_busy', retryable: false } },
    { error: { code: 'source_busy' } },
    { error: { code: 'source_busy', retryable: true }, protocolVersion: 'wrong' },
    { error: { code: 'source_busy', retryable: true }, sourceHealth: 'healthy' },
  ]) {
    let calls = 0;
    const result = await probeMcpAvailability({
      enabled: true,
      port: 5003,
      timeoutMs: 100,
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({
          ok: false,
          protocolVersion: fixture.protocolVersion || '2025-03-26',
          sourceHealth: fixture.sourceHealth || 'unavailable',
          ...(fixture.error ? { error: fixture.error } : {}),
        }), { status: 503, headers: { 'content-type': 'application/json' } });
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.available, false);
    assert.equal(result.reason, fixture.error ? 'mcp_source_unavailable' : 'mcp_unhealthy');
  }
});
