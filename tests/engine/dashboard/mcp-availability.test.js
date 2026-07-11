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
