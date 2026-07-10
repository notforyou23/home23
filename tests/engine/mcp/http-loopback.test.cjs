const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const {
  startMcpHttpServer,
} = require('../../../engine/mcp/http-server.js');

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test('engine MCP HTTP server binds only to loopback and exposes health', async () => {
  const server = startMcpHttpServer({ port: 0, host: '127.0.0.1', log: false });
  await once(server, 'listening');
  try {
    assert.equal(server.address().address, '127.0.0.1');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.protocolVersion, '2025-03-26');
    assert.equal(body.sourceHealth, 'healthy');
  } finally {
    await closeServer(server);
  }
});

test('engine MCP HTTP server rejects non-loopback hosts before listen', () => {
  for (const host of ['0.0.0.0', '::', 'localhost', 'example.com']) {
    assert.throws(
      () => startMcpHttpServer({ port: 0, host, log: false }),
      (error) => error.code === 'invalid_mcp_host',
    );
  }
});
