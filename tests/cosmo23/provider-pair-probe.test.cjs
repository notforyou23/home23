'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createProviderProbeHandler,
  probeExactProviderPair,
  resolveConfiguredProviderPairs,
} = require('../../cosmo23/server/lib/provider-pair-probe.js');

function catalog() {
  const model = id => ({
    id, kind: 'chat', transport: 'responses',
    maxOutputTokens: 128, providerStallMs: 30_000,
  });
  return {
    providers: {
      direct: { models: [model('query-model')] },
      sweep: { models: [model('sweep-model')] },
      synth: { models: [model('synth-model')] },
    },
  };
}

function configuredPairs() {
  return resolveConfiguredProviderPairs({
    catalog: catalog(),
    queryDefaults: {
      defaultProvider: 'direct', defaultModel: 'query-model',
      pgsSweepProvider: 'sweep', pgsSweepModel: 'sweep-model',
      pgsSynthProvider: 'synth', pgsSynthModel: 'synth-model',
    },
  });
}

test('exact pair probe uses only the protected client and proves requested and observed identity', async () => {
  const calls = [];
  const registry = {
    getExact(provider, model) {
      assert.equal(provider, 'sweep');
      assert.equal(model, 'sweep-model');
      return {
        providerId: 'sweep',
        async generate(request) {
          calls.push(request);
          return {
            provider: 'sweep', model: 'sweep-model', content: 'OK',
            terminalReceived: true, finishReason: 'completed', hadError: false,
          };
        },
      };
    },
  };
  const result = await probeExactProviderPair({
    registry,
    catalog: catalog(),
    configuredPairs: configuredPairs(),
    purpose: 'pgs-sweep',
    pair: { provider: 'sweep', model: 'sweep-model' },
    now: (() => { let value = 1_000; return () => (value += 5); })(),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'sweep');
  assert.equal(calls[0].model, 'sweep-model');
  assert.equal(calls[0].maxOutputTokens, 16);
  assert.equal(calls[0].signal instanceof AbortSignal, true);
  assert.equal(result.healthy, true);
  assert.equal(result.terminalReceived, true);
  assert.deepEqual(result.requestedPair, { provider: 'sweep', model: 'sweep-model' });
  assert.deepEqual(result.observedPair, { provider: 'sweep', model: 'sweep-model' });
});

test('pair probe rejects empty, incomplete, wrong-identity, and nonconfigured output', async () => {
  for (const [response, code] of [
    [{
      provider: 'direct', model: 'query-model', content: '',
      terminalReceived: true, finishReason: 'completed', hadError: false,
    }, 'provider_incomplete'],
    [{
      provider: 'direct', model: 'query-model', content: 'truncated',
      terminalReceived: true, finishReason: 'max_tokens', hadError: false,
    }, 'provider_incomplete'],
    [{
      provider: 'direct', model: 'wrong-model', content: 'OK',
      terminalReceived: true, finishReason: 'completed', hadError: false,
    }, 'provider_model_mismatch'],
  ]) {
    const registry = {
      getExact() {
        return { providerId: 'direct', async generate() { return response; } };
      },
    };
    await assert.rejects(
      probeExactProviderPair({
        registry, catalog: catalog(), configuredPairs: configuredPairs(),
        purpose: 'direct-query', pair: { provider: 'direct', model: 'query-model' },
      }),
      (error) => error.code === code,
    );
  }
  await assert.rejects(
    probeExactProviderPair({
      registry: { getExact() { throw new Error('unreachable'); } },
      catalog: catalog(), configuredPairs: configuredPairs(),
      purpose: 'direct-query', pair: { provider: 'sweep', model: 'sweep-model' },
    }),
    error => error.code === 'provider_model_mismatch',
  );
});

test('pair probe aborts a hung protected client at its bounded deadline', async () => {
  let observedSignal = null;
  const registry = {
    getExact() {
      return {
        providerId: 'direct',
        generate({ signal }) {
          observedSignal = signal;
          return new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      };
    },
  };
  await assert.rejects(
    probeExactProviderPair({
      registry, catalog: catalog(), configuredPairs: configuredPairs(),
      purpose: 'direct-query', pair: { provider: 'direct', model: 'query-model' },
      timeoutMs: 10,
    }),
    error => error.code === 'provider_probe_timeout' && error.retryable === true,
  );
  assert.equal(observedSignal.aborted, true);
});

test('configured pairs require all three exact persisted provider/model assignments', () => {
  assert.deepEqual(configuredPairs(), {
    'direct-query': { provider: 'direct', model: 'query-model' },
    'pgs-sweep': { provider: 'sweep', model: 'sweep-model' },
    'pgs-synthesis': { provider: 'synth', model: 'synth-model' },
  });
  assert.throws(
    () => resolveConfiguredProviderPairs({
      catalog: catalog(),
      queryDefaults: { defaultModel: 'query-model' },
    }),
    error => error.code === 'provider_configuration_invalid',
  );
});

function response() {
  return {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('probe handler rejects browser-origin calls before protected provider work', async () => {
  let calls = 0;
  const handler = createProviderProbeHandler({
    getRuntime: () => ({
      async probeConfiguredProviderPair({ purpose }) {
        calls += 1;
        return { healthy: true, purpose };
      },
    }),
  });
  const denied = response();
  await handler({
    body: { purpose: 'direct-query' },
    headers: { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' },
    socket: { remoteAddress: '127.0.0.1' }, once() {}, removeListener() {},
  }, denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(calls, 0);

  const allowed = response();
  await handler({
    body: { purpose: 'direct-query' }, headers: {},
    socket: { remoteAddress: '127.0.0.1' }, once() {}, removeListener() {},
  }, allowed);
  assert.equal(allowed.statusCode, 200);
  assert.equal(calls, 1);
});
