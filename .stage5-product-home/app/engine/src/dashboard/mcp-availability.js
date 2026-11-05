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
  retryDelayMs = 25,
  now = Date.now,
  sleepImpl = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
} = {}) {
  if (!enabled) return { available: false, endpoint: null, reason: 'mcp_disabled' };
  const numericPort = Number(port);
  if (!Number.isSafeInteger(numericPort) || numericPort <= 0 || numericPort > 65535) {
    return { available: false, endpoint: null, reason: 'mcp_unconfigured' };
  }
  if (typeof fetchImpl !== 'function') {
    return { available: false, endpoint: null, reason: 'mcp_fetch_unavailable' };
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1
      || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1
      || typeof now !== 'function' || typeof sleepImpl !== 'function') {
    return { available: false, endpoint: null, reason: 'mcp_unconfigured' };
  }

  const deadline = now() + timeoutMs;
  const transientSourceCodes = new Set(['source_refresh_pending', 'source_busy']);
  let sawTransientSource = false;
  try {
    while (now() < deadline) {
      const remainingMs = Math.max(1, Math.ceil(deadline - now()));
      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(remainingMs)
        : undefined;
      const response = await fetchImpl(mcpHealthEndpoint(numericPort), { signal });
      let body;
      try {
        body = await response.json();
      } catch (error) {
        if (!response?.ok) {
          return { available: false, endpoint: null, reason: 'mcp_unhealthy' };
        }
        return { available: false, endpoint: null, reason: 'mcp_source_unavailable' };
      }
      const sourceCode = body?.error?.code;
      const transientSource = response?.status === 503
        && transientSourceCodes.has(sourceCode)
        && body?.error?.retryable === true
        && body?.protocolVersion === '2025-03-26'
        && body?.ok === false
        && body?.sourceHealth === 'unavailable';
      if (transientSource) {
        sawTransientSource = true;
        const retryRemainingMs = deadline - now();
        if (retryRemainingMs <= 0) break;
        await sleepImpl(Math.min(retryDelayMs, retryRemainingMs));
        continue;
      }
      if (!response?.ok) {
        return {
          available: false,
          endpoint: null,
          reason: sourceCode ? 'mcp_source_unavailable' : 'mcp_unhealthy',
        };
      }
      if (body?.protocolVersion !== '2025-03-26' || body?.ok !== true
          || body?.sourceHealth === 'unavailable') {
        return { available: false, endpoint: null, reason: 'mcp_source_unavailable' };
      }
      return { available: true, endpoint: mcpEndpoint(numericPort), reason: null };
    }
    if (sawTransientSource) {
      return { available: false, endpoint: null, reason: 'mcp_source_unavailable' };
    }
    return { available: false, endpoint: null, reason: 'mcp_unreachable' };
  } catch (error) {
    if (sawTransientSource && now() >= deadline) {
      return { available: false, endpoint: null, reason: 'mcp_source_unavailable' };
    }
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
