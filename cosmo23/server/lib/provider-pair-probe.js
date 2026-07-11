'use strict';

const {
  assertProviderResultIdentity,
  requireCompleteProviderResult,
} = require('../../lib/provider-completion');
const { getModelCapabilities } = require('../config/model-catalog');
const { isLoopback } = require('../../../shared/runtime-metrics-route.cjs');

const PURPOSES = new Set(['direct-query', 'pgs-sweep', 'pgs-synthesis']);
const DEFAULT_PROBE_TIMEOUT_MS = 120_000;

function typed(code, message = code, fields = {}) {
  return Object.assign(new Error(message), { code, ...fields });
}

function exactPair(value, code = 'invalid_request') {
  if (!value || Array.isArray(value) || typeof value !== 'object'
      || Object.keys(value).sort().join(',') !== 'model,provider'
      || typeof value.provider !== 'string' || !value.provider
      || value.provider.trim() !== value.provider
      || typeof value.model !== 'string' || !value.model
      || value.model.trim() !== value.model
      || value.provider.length > 256 || value.model.length > 256) {
    throw typed(code);
  }
  return Object.freeze({ provider: value.provider, model: value.model });
}

function configuredPair(queryDefaults, providerKey, modelKey, catalog) {
  const pair = exactPair({
    provider: queryDefaults?.[providerKey],
    model: queryDefaults?.[modelKey],
  }, 'provider_configuration_invalid');
  try {
    getModelCapabilities(catalog, pair.provider, pair.model);
  } catch (error) {
    throw typed(
      'provider_configuration_invalid',
      `Configured provider pair is invalid: ${pair.provider}/${pair.model}`,
      { retryable: false, cause: error },
    );
  }
  return pair;
}

function resolveConfiguredProviderPairs({ catalog, queryDefaults } = {}) {
  if (!catalog?.providers || !queryDefaults || Array.isArray(queryDefaults)
      || typeof queryDefaults !== 'object') {
    throw typed('provider_configuration_invalid', 'Exact query defaults are unavailable', {
      retryable: false,
    });
  }
  return Object.freeze({
    'direct-query': configuredPair(
      queryDefaults, 'defaultProvider', 'defaultModel', catalog,
    ),
    'pgs-sweep': configuredPair(
      queryDefaults, 'pgsSweepProvider', 'pgsSweepModel', catalog,
    ),
    'pgs-synthesis': configuredPair(
      queryDefaults, 'pgsSynthProvider', 'pgsSynthModel', catalog,
    ),
  });
}

function samePair(left, right) {
  return left?.provider === right?.provider && left?.model === right?.model;
}

async function probeExactProviderPair({
  registry,
  catalog,
  configuredPairs,
  purpose,
  pair,
  signal = null,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  if (!registry || typeof registry.getExact !== 'function'
      || !catalog?.providers
      || !configuredPairs || Array.isArray(configuredPairs) || typeof configuredPairs !== 'object'
      || !PURPOSES.has(purpose)
      || (signal !== null && !(signal instanceof AbortSignal))
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000
      || typeof now !== 'function') {
    throw typed('invalid_request');
  }
  const selected = exactPair(pair);
  const configured = exactPair(configuredPairs[purpose], 'provider_configuration_invalid');
  if (!samePair(selected, configured)) {
    throw typed(
      'provider_model_mismatch',
      'Provider probe pair does not match the configured purpose',
      { retryable: false },
    );
  }
  const capabilities = getModelCapabilities(catalog, selected.provider, selected.model);
  const client = registry.getExact(selected.provider, selected.model);
  if (!client || typeof client.generate !== 'function') {
    throw typed('provider_unavailable', 'provider unavailable', { retryable: true });
  }
  if (client.providerId !== selected.provider) {
    throw typed('provider_model_mismatch', 'Provider client identity mismatch', {
      retryable: false,
    });
  }

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    controller.abort(typed(
      'provider_probe_timeout',
      'Exact provider probe exceeded its deadline',
      { retryable: true },
    ));
  }, timeoutMs);

  const startedAt = Number(now());
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    const providerWork = Promise.resolve().then(() => client.generate({
      provider: selected.provider,
      model: selected.model,
      instructions: 'Return a normal terminal response containing OK.',
      input: 'Reply with OK.',
      maxOutputTokens: Math.min(16, capabilities.maxOutputTokens),
      signal: controller.signal,
    }));
    const abortWork = new Promise((_, reject) => {
      const abort = () => reject(controller.signal.reason);
      if (controller.signal.aborted) abort();
      else controller.signal.addEventListener('abort', abort, { once: true });
    });
    const raw = await Promise.race([providerWork, abortWork]);
    if (controller.signal.aborted) throw controller.signal.reason;
    const complete = requireCompleteProviderResult(raw);
    assertProviderResultIdentity(complete, selected.provider, selected.model);
    if (!complete.content.trim()) {
      throw typed(
        'provider_incomplete',
        'Exact provider pair returned no content',
        { retryable: true },
      );
    }
    const completedAt = Number(now());
    const observedPair = Object.freeze({
      provider: complete.provider,
      model: complete.model,
    });
    return Object.freeze({
      healthy: true,
      purpose,
      pair: selected,
      requestedPair: selected,
      observedPair,
      terminalReceived: true,
      finishReason: complete.finishReason,
      latency: Number.isFinite(startedAt) && Number.isFinite(completedAt)
        ? Math.max(0, completedAt - startedAt) : null,
      timestamp: Number.isFinite(completedAt) ? completedAt : Date.now(),
    });
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

function browserInitiated(req) {
  const headers = req?.headers || {};
  return typeof headers.origin === 'string'
    || typeof headers['sec-fetch-site'] === 'string';
}

function errorStatus(code) {
  if (['invalid_request', 'provider_model_mismatch'].includes(code)) return 400;
  if (code === 'access_denied') return 403;
  if (code === 'provider_probe_timeout') return 504;
  if (['provider_unavailable', 'provider_configuration_invalid'].includes(code)) return 503;
  if (code === 'provider_incomplete') return 502;
  return 500;
}

function createProviderProbeHandler({ getRuntime } = {}) {
  if (typeof getRuntime !== 'function') {
    throw typed('provider_probe_configuration_invalid');
  }
  return async function providerProbeHandler(req, res) {
    if (!isLoopback(req?.socket?.remoteAddress) || browserInitiated(req)) {
      return res.status(403).json({ error: { code: 'access_denied' } });
    }
    if (!req.body || Array.isArray(req.body) || typeof req.body !== 'object'
        || Object.keys(req.body).join(',') !== 'purpose'
        || !PURPOSES.has(req.body.purpose)) {
      return res.status(400).json({ error: { code: 'invalid_request' } });
    }
    const controller = new AbortController();
    let finished = false;
    const abort = () => {
      if (!finished && !controller.signal.aborted) {
        controller.abort(typed('caller_disconnected', 'Provider probe caller disconnected', {
          retryable: true,
        }));
      }
    };
    req.once?.('aborted', abort);
    res.once?.('close', abort);
    try {
      const runtime = getRuntime();
      if (!runtime || typeof runtime.probeConfiguredProviderPair !== 'function') {
        throw typed('provider_unavailable', 'Protected provider runtime is unavailable', {
          retryable: true,
        });
      }
      const result = await runtime.probeConfiguredProviderPair({
        purpose: req.body.purpose,
        signal: controller.signal,
      });
      finished = true;
      return res.status(200).json(result);
    } catch (error) {
      finished = true;
      const code = error?.code || 'provider_probe_failed';
      return res.status(errorStatus(code)).json({
        error: {
          code,
          message: String(error?.message || code).slice(0, 1024),
          retryable: error?.retryable === true,
        },
      });
    } finally {
      req.removeListener?.('aborted', abort);
      res.removeListener?.('close', abort);
    }
  };
}

module.exports = {
  DEFAULT_PROBE_TIMEOUT_MS,
  PURPOSES,
  createProviderProbeHandler,
  probeExactProviderPair,
  resolveConfiguredProviderPairs,
};
