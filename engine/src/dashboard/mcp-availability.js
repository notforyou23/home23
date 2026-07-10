'use strict';

function mcpEndpoint(port) {
  return `http://127.0.0.1:${port}/mcp`;
}

function mcpHealthEndpoint(port) {
  return `http://127.0.0.1:${port}/health`;
}

async function probeMcpAvailability({
  enabled = true,
  port,
  fetchImpl = globalThis.fetch,
  timeoutMs = 1500,
} = {}) {
  if (!enabled) return { available: false, endpoint: null, reason: 'mcp_disabled' };
  const numericPort = Number(port);
  if (!Number.isSafeInteger(numericPort) || numericPort <= 0 || numericPort > 65535) {
    return { available: false, endpoint: null, reason: 'mcp_unconfigured' };
  }
  if (typeof fetchImpl !== 'function') {
    return { available: false, endpoint: null, reason: 'mcp_fetch_unavailable' };
  }

  try {
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
    const response = await fetchImpl(mcpHealthEndpoint(numericPort), { signal });
    if (!response?.ok) {
      return { available: false, endpoint: null, reason: 'mcp_unhealthy' };
    }
    const body = await response.json();
    if (body?.protocolVersion !== '2025-03-26' || body?.ok !== true
        || body?.sourceHealth === 'unavailable') {
      return { available: false, endpoint: null, reason: 'mcp_source_unavailable' };
    }
    return { available: true, endpoint: mcpEndpoint(numericPort), reason: null };
  } catch (error) {
    return {
      available: false,
      endpoint: null,
      reason: 'mcp_unreachable',
      detail: error?.message || String(error),
    };
  }
}

function buildMcpUnavailableEnvelope(port, availability = null) {
  return {
    ok: false,
    success: false,
    error: {
      code: 'source_unavailable',
      message: 'Agent-scoped MCP service is unavailable for this runtime',
      retryable: true,
    },
    mcp: {
      available: false,
      port: port || null,
      reason: availability?.reason || 'mcp_unavailable',
    },
  };
}

function isMcpProxyAvailable(env = process.env) {
  return env.HOME23_MCP_AVAILABLE === 'true';
}

module.exports = {
  buildMcpUnavailableEnvelope,
  isMcpProxyAvailable,
  mcpEndpoint,
  mcpHealthEndpoint,
  probeMcpAvailability,
};
