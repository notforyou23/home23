'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  probeExactProviderPair,
} = require('../../cosmo23/server/lib/provider-pair-probe.js');

test('exact pair probe calls only the selected adapter and requires a terminal response', async () => {
  const calls = [];
  const registry = {
    getExact(provider, model) {
      assert.equal(provider, 'fixture-provider');
      assert.equal(model, 'fixture-model');
      return {
        async createMessage(request) {
          calls.push(request);
          return {
            model: 'fixture-model', content: 'OK', stopReason: 'end_turn',
          };
        },
      };
    },
  };
  const result = await probeExactProviderPair({
    registry,
    purpose: 'pgs-sweep',
    pair: { provider: 'fixture-provider', model: 'fixture-model' },
    now: (() => { let value = 1_000; return () => (value += 5); })(),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'fixture-model');
  assert.equal(calls[0].maxTokens, 16);
  assert.equal(result.healthy, true);
  assert.equal(result.terminalReceived, true);
  assert.deepEqual(result.pair, { provider: 'fixture-provider', model: 'fixture-model' });
});

test('pair probe rejects mismatch, incomplete output, and unknown purposes', async () => {
  const registry = {
    getExact() {
      return {
        async createMessage() {
          return { model: 'fixture-model', content: 'truncated', stopReason: 'max_tokens' };
        },
      };
    },
  };
  await assert.rejects(
    probeExactProviderPair({
      registry, purpose: 'direct-query',
      pair: { provider: 'fixture-provider', model: 'fixture-model' },
    }),
    (error) => error.code === 'provider_incomplete',
  );
  for (const input of [
    { purpose: 'unknown', pair: { provider: 'fixture-provider', model: 'fixture-model' } },
    { purpose: 'pgs-synthesis', pair: { provider: 'fixture-provider' } },
  ]) {
    await assert.rejects(
      probeExactProviderPair({ registry, ...input }),
      (error) => error.code === 'invalid_request',
    );
  }
});
