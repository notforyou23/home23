const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMcpUnavailableEnvelope,
  isMcpProxyAvailable,
  probeMcpAvailability,
} = require('../../../engine/src/dashboard/mcp-availability.js');

test('MCP proxy is unavailable by default unless runtime advertises a started service', () => {
  assert.equal(isMcpProxyAvailable({}), false);
  assert.equal(isMcpProxyAvailable({ HOME23_MCP_AVAILABLE: 'false' }), false);
  assert.equal(isMcpProxyAvailable({ HOME23_MCP_AVAILABLE: 'true' }), true);
});

test('MCP availability probes the configured port rather than hardcoded legacy ports', async () => {
  const calls = [];
  const result = await probeMcpAvailability({
    port: 6103,
    fetchImpl: async (url) => {
      calls.push(url);
      return {
        ok: true,
        json: async () => ({
          ok: true,
          protocolVersion: '2025-03-26',
          sourceHealth: 'healthy',
        }),
      };
    },
  });
  assert.deepEqual(calls, ['http://127.0.0.1:6103/health']);
  assert.deepEqual(result, {
    available: true,
    endpoint: 'http://127.0.0.1:6103/mcp',
    reason: null,
  });
});

test('MCP availability fails closed for disabled, unhealthy, or source-unavailable runtime', async () => {
  assert.deepEqual(await probeMcpAvailability({ enabled: false, port: 6103 }), {
    available: false,
    endpoint: null,
    reason: 'mcp_disabled',
  });
  assert.equal((await probeMcpAvailability({
    port: 6103,
    fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
  })).reason, 'mcp_unhealthy');
  assert.equal((await probeMcpAvailability({
    port: 6103,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        ok: false,
        protocolVersion: '2025-03-26',
        sourceHealth: 'unavailable',
      }),
    }),
  })).reason, 'mcp_source_unavailable');
});

test('MCP unavailable envelope is typed and does not pretend an empty result', () => {
  assert.deepEqual(buildMcpUnavailableEnvelope(5003, { reason: 'mcp_disabled' }), {
    ok: false,
    success: false,
    error: {
      code: 'source_unavailable',
      message: 'Agent-scoped MCP service is unavailable for this runtime',
      retryable: true,
    },
    mcp: {
      available: false,
      port: 5003,
      reason: 'mcp_disabled',
    },
  });
});
