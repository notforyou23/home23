import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createProductionMcpMemoryTools,
  startMcpHttpServer,
} = require('../../../engine/mcp/http-server.js');
const {
  createDefaultMcpMemoryTools,
} = require('../../../shared/memory-source/mcp-http-runtime.cjs');

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

async function listTools(server) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'list-tools',
      method: 'tools/list',
      params: {},
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  const data = body.split('\n').find((line) => line.startsWith('data: '));
  assert.ok(data, body);
  return JSON.parse(data.slice('data: '.length)).result.tools;
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

test('production MCP memory tools use the dashboard search service with canonical catalog identity', async () => {
  const calls = [];
  let closes = 0;
  const overlayProvider = Object.freeze({ async refresh() {} });
  let directOptions = null;
  const memoryTools = createProductionMcpMemoryTools({
    brainDir: '/canonical/brain',
    home23Root: '/canonical/home23',
    requesterAgent: 'ada',
    createSearchService(options) {
      return {
        async close() { closes += 1; },
        async search(input) {
          calls.push({ input, options });
          const resolved = await options.resolveTargetContext({});
          return {
            query: input.query,
            results: [{ id: 'shared-canary' }],
            evidence: {
              sourceHealth: 'healthy',
              matchOutcome: 'matches',
              deltaWatermark: { revision: 9 },
              authoritativeTotals: { nodes: 10, edges: 20 },
              returnedTotals: { nodes: 1, edges: 0 },
              selectedBrain: null,
              selectedAgent: null,
              identity: {
                requesterAgent: 'ada',
                targetAgent: resolved.target.ownerAgent,
                brainId: resolved.target.id,
                canonicalRoot: resolved.target.canonicalRoot,
                catalogRevision: resolved.catalogRevision,
                kind: resolved.target.kind,
                sourceType: resolved.target.sourceType,
                accessMode: resolved.accessMode,
                operationId: 'mcp-production-test',
              },
            },
          };
        },
      };
    },
    createOverlayCache(options) {
      assert.equal(options.cacheRoot, '/canonical/home23/instances/ada/runtime/cache');
      return overlayProvider;
    },
    createDirectMemoryTools(options) {
      directOptions = options;
      return createDefaultMcpMemoryTools(options);
    },
    buildCatalog: async () => ({
      catalogRevision: 'catalog-9',
      brains: [{
        id: 'brain-ada',
        ownerAgent: 'ada',
        canonicalRoot: '/canonical/brain',
        kind: 'resident',
        sourceType: 'memory-manifest',
      }],
    }),
    realpath: async (value) => value,
  });

  const result = await memoryTools.queryMemory({ query: 'shared', limit: 4 });
  assert.equal(result.ok, true);
  assert.equal(result.evidence.selectedBrain, 'brain-ada');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.topK, 4);
  assert.equal(calls[0].options.deltaOverlayCache, overlayProvider);
  assert.equal(directOptions.nodeOverlayProvider, overlayProvider);
  await memoryTools.close();
  await memoryTools.close();
  assert.equal(closes, 1);
});

test('HTTP server shutdown closes canonical memory tools', async () => {
  let closes = 0;
  const server = startMcpHttpServer({
    host: '127.0.0.1',
    port: 0,
    log: false,
    memoryTools: completeMemoryTools({
      async close() { closes += 1; },
    }),
    readiness: fixedReadiness({
      ok: true,
      protocolVersion: '2025-03-26',
      sourceHealth: 'healthy',
    }),
  });
  await once(server, 'listening');
  await close(server);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closes, 1);
});

test('engine MCP advertises the exact graph controls and own-brain diagnostic boundary', async (t) => {
  const server = startMcpHttpServer({
    host: '127.0.0.1',
    port: 0,
    log: false,
    memoryTools: completeMemoryTools(),
    readiness: fixedReadiness({
      ok: true,
      protocolVersion: '2025-03-26',
      sourceHealth: 'healthy',
    }),
  });
  await once(server, 'listening');
  t.after(() => close(server));

  const tools = await listTools(server);
  const graph = tools.find(({ name }) => name === 'get_memory_graph');
  assert.deepEqual(Object.keys(graph.inputSchema.properties).sort(), [
    'clusterId', 'edgeLimit', 'nodeLimit',
  ]);
  assert.equal(graph.inputSchema.additionalProperties, false);
  assert.match(graph.description, /own brain/i);
  assert.match(graph.description, /durable brain operations/i);
  assert.match(
    tools.find(({ name }) => name === 'query_memory').description,
    /own brain/i,
  );
});

test('engine MCP snapshot-only tools return typed unsupported state, never invented empty totals', async (t) => {
  const unsupported = (capability) => ({
    status: 'unsupported',
    error: {
      code: 'snapshot_capability_unsupported',
      message: `${capability} is not projected by brain-snapshot`,
      retryable: false,
    },
  });
  const readScalarState = async () => ({
    cycleCount: null,
    currentMode: null,
    cognitiveState: null,
    goals: {
      active: null,
      completed: null,
      archived: null,
      counts: { active: null, completed: null, archived: null },
    },
    scalarProjection: {
      source: 'brain-snapshot',
      sourceHealth: 'unavailable',
      capabilities: {
        goals: unsupported('goals'),
        agentActivity: unsupported('agent activity'),
        journal: unsupported('journal'),
        dreams: unsupported('dreams'),
        oscillator: unsupported('oscillator'),
      },
    },
  });
  const server = startMcpHttpServer({
    host: '127.0.0.1',
    port: 0,
    log: false,
    memoryTools: completeMemoryTools(),
    readScalarState,
    readiness: fixedReadiness({
      ok: true,
      protocolVersion: '2025-03-26',
      sourceHealth: 'healthy',
    }),
  });
  await once(server, 'listening');
  t.after(() => close(server));

  for (const [tool, capability] of [
    ['get_active_goals', 'goals'],
    ['get_agent_activity', 'agentActivity'],
    ['get_journal', 'journal'],
    ['get_dreams', 'dreams'],
    ['get_oscillator_mode', 'oscillator'],
  ]) {
    const result = await callTool(server, tool);
    assert.equal(result.ok, false, tool);
    assert.equal(result.status, 'unsupported', tool);
    assert.equal(result.sourceHealth, 'unavailable', tool);
    assert.equal(result.capability, capability, tool);
    assert.equal(result.error.code, 'snapshot_capability_unsupported', tool);
    assert.equal(Object.hasOwn(result, 'count'), false, tool);
    assert.equal(Object.hasOwn(result, 'totalEntries'), false, tool);
  }
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

test('engine MCP defaults to IPv4 loopback and rejects every non-loopback host before listen', async (t) => {
  const originalHost = process.env.MCP_HTTP_HOST;
  delete process.env.MCP_HTTP_HOST;
  t.after(() => {
    if (originalHost === undefined) delete process.env.MCP_HTTP_HOST;
    else process.env.MCP_HTTP_HOST = originalHost;
  });
  const server = startMcpHttpServer({
    port: 0,
    log: false,
    readiness: fixedReadiness({
      ok: true,
      protocolVersion: '2025-03-26',
      sourceHealth: 'healthy',
    }),
    memoryTools: completeMemoryTools(),
  });
  await once(server, 'listening');
  t.after(() => close(server));
  assert.equal(server.address().address, '127.0.0.1');

  for (const host of ['0.0.0.0', '::', 'localhost', 'example.com']) {
    assert.throws(
      () => startMcpHttpServer({ host, port: 0, log: false }),
      (error) => error?.code === 'invalid_mcp_host',
      host,
    );
  }
});

test('engine MCP health returns 503 for unavailable canonical source evidence', async (t) => {
  const unavailable = {
    ok: false,
    protocolVersion: '2025-03-26',
    sourceHealth: 'unavailable',
    error: { code: 'source_unavailable' },
  };
  const server = startMcpHttpServer({
    host: '127.0.0.1',
    port: 0,
    log: false,
    readiness: fixedReadiness(unavailable),
    memoryTools: completeMemoryTools(),
  });
  await once(server, 'listening');
  t.after(() => close(server));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), unavailable);
});
