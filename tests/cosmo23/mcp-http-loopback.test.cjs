const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const {
  startMcpHttpServer,
} = require('../../cosmo23/engine/mcp/http-server.js');

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function callTool(server, name, args = {}) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: args },
    }),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
  assert.ok(dataLine, text);
  const rpc = JSON.parse(dataLine.slice(6));
  return JSON.parse(rpc.result.content[0].text);
}

test('COSMO MCP HTTP server binds only to loopback and exposes health', async () => {
  let resolveReadiness;
  const readiness = new Promise((resolve) => { resolveReadiness = resolve; });
  const memoryTools = {
    checkReadiness: () => readiness,
  };
  const server = startMcpHttpServer({
    port: 0, host: '127.0.0.1', log: false, memoryTools,
  });
  await once(server, 'listening');
  try {
    assert.equal(server.address().address, '127.0.0.1');
    const starting = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    assert.equal(starting.status, 503);
    assert.deepEqual(await starting.json(), {
      ok: false,
      protocolVersion: '2025-03-26',
      sourceHealth: 'starting',
    });

    resolveReadiness({ ok: true, sourceHealth: 'healthy', revision: 9 });
    await new Promise((resolve) => setImmediate(resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.protocolVersion, '2025-03-26');
    assert.equal(body.sourceHealth, 'healthy');
    assert.equal(body.revision, 9);
  } finally {
    await closeServer(server);
  }
});

test('COSMO MCP health is unavailable when the canonical source check fails', async () => {
  const server = startMcpHttpServer({
    port: 0,
    host: '127.0.0.1',
    log: false,
    memoryTools: {
      async checkReadiness() {
        return { ok: false, sourceHealth: 'unavailable', error: { code: 'source_unavailable' } };
      },
    },
  });
  await once(server, 'listening');
  try {
    await new Promise((resolve) => setImmediate(resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.sourceHealth, 'unavailable');
    assert.equal(body.error.code, 'source_unavailable');
  } finally {
    await closeServer(server);
  }
});

test('COSMO MCP memory tools delegate to the bounded canonical-source adapter', async () => {
  const calls = [];
  const memoryTools = {
    async checkReadiness() { return { ok: true, sourceHealth: 'healthy' }; },
    async queryMemory(input) { calls.push(['search', input]); return { ok: true, route: 'search' }; },
    async getMemoryStatistics(input) { calls.push(['statistics', input]); return { ok: true, route: 'statistics' }; },
    async getMemoryGraph(input) { calls.push(['graph', input]); return { ok: true, route: 'graph' }; },
    async getSystemState(input) { calls.push(['state', input]); return { ok: true, route: 'state' }; },
  };
  const server = startMcpHttpServer({
    port: 0,
    host: '127.0.0.1',
    log: false,
    memoryTools,
    readScalarState: async () => { throw new Error('full state path must not run'); },
  });
  await once(server, 'listening');
  try {
    assert.equal((await callTool(server, 'query_memory', { query: 'canary', limit: 3 })).route, 'search');
    assert.equal((await callTool(server, 'get_memory_statistics')).route, 'statistics');
    assert.equal((await callTool(server, 'get_memory_graph', { limit: 5, edgeLimit: 7 })).route, 'graph');
    assert.equal((await callTool(server, 'get_system_state')).route, 'state');
    assert.deepEqual(calls.map(([name]) => name), ['search', 'statistics', 'graph', 'state']);
    assert.equal(calls[0][1].query, 'canary');
    assert.equal(calls[0][1].limit, 3);
    assert.equal(calls[2][1].nodeLimit, 5);
    assert.equal(calls[2][1].edgeLimit, 7);
    for (const [, input] of calls) assert.ok(input.signal instanceof AbortSignal);
  } finally {
    await closeServer(server);
  }
});

test('COSMO MCP HTTP server rejects non-loopback hosts before listen', () => {
  for (const host of ['0.0.0.0', '::', 'localhost', 'example.com']) {
    assert.throws(
      () => startMcpHttpServer({ port: 0, host, log: false }),
      (error) => error.code === 'invalid_mcp_host',
    );
  }
});

test('COSMO MCP HTTP rejects an oversized control message before tool dispatch', async () => {
  const server = startMcpHttpServer({
    port: 0,
    host: '127.0.0.1',
    log: false,
    requestBodyLimit: '1kb',
    memoryTools: { async checkReadiness() { return { ok: true, sourceHealth: 'healthy' }; } },
  });
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(2048) }),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, -32600);
  } finally {
    await closeServer(server);
  }
});
