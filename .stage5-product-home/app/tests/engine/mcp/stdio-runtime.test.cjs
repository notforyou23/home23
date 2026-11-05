'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startMcpStdioServer } = require('../../../engine/mcp/stdio-server.js');

test('stdio shutdown closes canonical memory tools after the SDK server', async () => {
  const events = [];
  class FakeServer {
    setRequestHandler() {}
    async connect(transport) { events.push(['connect', transport]); }
    async close() { events.push(['server-close']); }
  }
  const memoryTools = {
    async queryMemory() {},
    async getMemoryStatistics() {},
    async getMemoryGraph() {},
    async getSystemState() {},
    async close() { events.push(['memory-close']); },
  };
  const transport = {};
  const runtime = await startMcpStdioServer({
    brainDir: '/tmp/brain',
    memoryTools,
    readScalarState: async () => ({}),
    transport,
    sdk: {
      Server: FakeServer,
      CallToolRequestSchema: Symbol('call'),
      ListToolsRequestSchema: Symbol('list'),
    },
  });

  await runtime.close();
  assert.deepEqual(events, [
    ['connect', transport],
    ['server-close'],
    ['memory-close'],
  ]);
});
