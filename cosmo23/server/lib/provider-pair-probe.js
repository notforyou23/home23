'use strict';

const PURPOSES = new Set(['direct-query', 'pgs-sweep', 'pgs-synthesis']);
const TERMINAL_REASONS = new Set(['end_turn', 'stop_sequence', 'tool_use']);

function typed(code, message = code, fields = {}) {
  return Object.assign(new Error(message), { code, ...fields });
}

function exactPair(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
      || Object.keys(value).sort().join(',') !== 'model,provider'
      || typeof value.provider !== 'string' || !value.provider.trim()
      || typeof value.model !== 'string' || !value.model.trim()
      || value.provider.length > 256 || value.model.length > 256) {
    throw typed('invalid_request');
  }
  return Object.freeze({ provider: value.provider, model: value.model });
}

async function probeExactProviderPair({ registry, purpose, pair, now = Date.now } = {}) {
  if (!registry || typeof registry.getExact !== 'function'
      || !PURPOSES.has(purpose) || typeof now !== 'function') {
    throw typed('invalid_request');
  }
  const selected = exactPair(pair);
  const adapter = registry.getExact(selected.provider, selected.model);
  if (!adapter || typeof adapter.createMessage !== 'function') {
    throw typed('provider_unavailable', 'provider unavailable', { retryable: true });
  }
  const startedAt = Number(now());
  const response = await adapter.createMessage({
    model: selected.model,
    messages: [{ role: 'user', content: 'Reply with OK.' }],
    maxTokens: 16,
    temperature: 0,
  });
  const completedAt = Number(now());
  if (!response || typeof response !== 'object'
      || typeof response.content !== 'string'
      || !TERMINAL_REASONS.has(response.stopReason)) {
    throw typed('provider_incomplete', 'exact provider pair did not return a terminal response', {
      retryable: true,
    });
  }
  return Object.freeze({
    healthy: true,
    purpose,
    pair: selected,
    terminalReceived: true,
    finishReason: response.stopReason,
    latency: Number.isFinite(startedAt) && Number.isFinite(completedAt)
      ? Math.max(0, completedAt - startedAt) : null,
    timestamp: Number.isFinite(completedAt) ? completedAt : Date.now(),
  });
}

module.exports = {
  PURPOSES,
  probeExactProviderPair,
};
