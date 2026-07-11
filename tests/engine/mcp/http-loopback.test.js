import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  startMcpHttpServer,
} = require('../../../engine/mcp/http-server.js');

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function fixedReadiness(status) {
  return {
    status: () => status,
    close() {},
  };
}

function completeMemoryTools(overrides = {}) {
  return {
    async queryMemory() { return { ok: true, route: 'query' }; },
    async getMemoryStatistics() { return { ok: true, route: 'statistics' }; },
    async getMemoryGraph() { return { ok: true, route: 'graph' }; },
    async getSystemState() { return { ok: true, route: 'state' }; },
    ...overrides,
  };
}

async function callTool(server, name, args = {}) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `call-${name}`,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  const data = body.split('\n').find((line) => line.startsWith('data: '));
  assert.ok(data, body);
  const rpc = JSON.parse(data.slice('data: '.length));
  assert.equal(rpc.jsonrpc, '2.0');
  assert.equal(rpc.id, `call-${name}`);
  return JSON.parse(rpc.result.content[0].text);
}

test('engine MCP loopback serves canonical health and delegates a bounded tool call', async (t) => {
  const calls = [];
  const memoryTools = completeMemoryTools({
    async queryMemory(input) {
      calls.push(input);
      return {
        ok: true,
        query: input.query,
        results: [{ id: 'canonical-canary' }],
        evidence: { sourceHealth: 'healthy', revision: 23 },
      };
    },
  });
  const health = {
    ok: true,
    protocolVersion: '2025-03-26',
    sourceHealth: 'healthy',
    revision: 23,
    totals: { nodes: 2, edges: 1 },
  };
  const server = startMcpHttpServer({
    host: '127.0.0.1',
    port: 0,
    log: false,
    memoryTools,
    readiness: fixedReadiness(health),
  });
  await once(server, 'listening');
  t.after(() => close(server));

  assert.equal(server.address().address, '127.0.0.1');
  assert.equal(server.address().family, 'IPv4');
  const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), health);

  const result = await callTool(server, 'query_memory', {
    query: 'canonical canary',
    limit: 3,
    tag: 'proof',
  });
  assert.deepEqual(result.results, [{ id: 'canonical-canary' }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query, 'canonical canary');
  assert.equal(calls[0].limit, 3);
  assert.equal(calls[0].tag, 'proof');
  assert.ok(calls[0].signal instanceof AbortSignal);
});

test('engine MCP loopback rejects an oversized JSON-RPC body before tool delegation', async (t) => {
  let dispatches = 0;
  const server = startMcpHttpServer({
    host: '127.0.0.1',
    port: 0,
    log: false,
    requestBodyLimit: '512b',
    readiness: fixedReadiness({
      ok: true,
      protocolVersion: '2025-03-26',
      sourceHealth: 'healthy',
    }),
    memoryTools: completeMemoryTools({
      async queryMemory() {
        dispatches += 1;
        return { ok: true };
      },
    }),
  });
  await once(server, 'listening');
  t.after(() => close(server));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'oversized',
      method: 'tools/call',
      params: {
        name: 'query_memory',
        arguments: { query: 'x'.repeat(2_048) },
      },
    }),
  });

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    jsonrpc: '2.0',
    error: { code: -32600, message: 'MCP request body exceeds limit' },
    id: null,
  });
  assert.equal(dispatches, 0);
});
