import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const {
  createBrainProviderClientRegistry,
} = require('../../../cosmo23/lib/brain-provider-client-registry.js');
const {
  BUILTIN_MODEL_CATALOG,
  normalizeModelCatalog,
} = require('../../../cosmo23/server/config/model-catalog.js');
const {
  ProviderCompletionError,
} = require('../../../cosmo23/lib/provider-completion.js');
const {
  SYNTHESIS_OPERATION_LIMITS,
} = require('../../../cosmo23/lib/brain-operation-limits.js');
const {
  createSynthesisProviderAdapter,
  resolveSynthesisConfig,
} = require('../../../engine/src/synthesis/provider-registry.js');

function catalog() {
  // Keep the portable engine suite isolated from the operator's standalone
  // ~/.cosmo2.3 catalog. Home23 injects its managed catalog in production.
  return normalizeModelCatalog(BUILTIN_MODEL_CATALOG);
}

function exactRegistry(modelCatalog, generate = async () => ({
  content: '{"ok":true}',
  terminalReceived: true,
  finishReason: 'stop',
  hadError: false,
})) {
  return createBrainProviderClientRegistry({
    catalog: modelCatalog,
    providerConfig: {},
    pairFactories: {
      'minimax\0MiniMax-M3': ({ provider }) => ({ providerId: provider, generate }),
      'anthropic\0claude-opus-4-8': ({ provider }) => ({ providerId: provider, generate }),
    },
  });
}

test('public home example parses once and carries exact query and synthesis pairs', async () => {
  const file = path.resolve('config/home.yaml.example');
  const parsed = yaml.load(await readFile(file, 'utf8'), { json: false });
  assert.deepEqual(parsed.synthesis, {
    provider: 'minimax',
    model: 'MiniMax-M3',
    intervalHours: 4,
  });
  assert.deepEqual({
    provider: parsed.query.defaultProvider,
    model: parsed.query.defaultModel,
  }, {
    provider: 'anthropic',
    model: 'claude-opus-4-8',
  });
});

test('fresh synthesis config resolves the exact minimax pair and capabilities', () => {
  const modelCatalog = catalog();
  const resolved = resolveSynthesisConfig({
    homeConfig: {},
    env: {},
    modelCatalog,
    providerRegistry: exactRegistry(modelCatalog),
  });
  assert.deepEqual(resolved.selection, { provider: 'minimax', model: 'MiniMax-M3' });
  assert.deepEqual(resolved.capabilities, {
    maxOutputTokens: 32768,
    providerStallMs: 900000,
  });
  assert.equal(resolved.intervalHours, 4);
  assert.equal(resolved.migratedFromModelOnly, false);
  assert.equal(resolved.needsPersistence, true);
  assert.equal(typeof resolved.client.generate, 'function');
});

test('explicit and unique legacy synthesis choices preserve exact provider identity', () => {
  const modelCatalog = catalog();
  const registry = exactRegistry(modelCatalog);
  const explicit = resolveSynthesisConfig({
    homeConfig: { synthesis: { provider: 'minimax', model: 'MiniMax-M3', intervalHours: 8 } },
    env: {},
    modelCatalog,
    providerRegistry: registry,
  });
  assert.equal(explicit.needsPersistence, false);
  assert.equal(explicit.intervalHours, 8);

  const legacy = resolveSynthesisConfig({
    homeConfig: { synthesis: { model: 'MiniMax-M3' } },
    env: {},
    modelCatalog,
    providerRegistry: registry,
  });
  assert.deepEqual(legacy.selection, { provider: 'minimax', model: 'MiniMax-M3' });
  assert.equal(legacy.migratedFromModelOnly, true);
  assert.equal(legacy.needsPersistence, true);
});

test('ambiguous, provider-only, missing, and unavailable pairs fail before provider work', () => {
  const modelCatalog = catalog();
  const duplicate = structuredClone(modelCatalog);
  duplicate.providers.anthropic.models.push({
    ...duplicate.providers.minimax.models.find((row) => row.id === 'MiniMax-M3'),
  });
  assert.throws(() => resolveSynthesisConfig({
    homeConfig: { synthesis: { model: 'MiniMax-M3' } },
    env: {},
    modelCatalog: duplicate,
    providerRegistry: exactRegistry(modelCatalog),
  }), { code: 'model_ambiguous' });

  assert.throws(() => resolveSynthesisConfig({
    homeConfig: { synthesis: { provider: 'minimax' } },
    env: {},
    modelCatalog,
    providerRegistry: exactRegistry(modelCatalog),
  }), { code: 'synthesis_config_invalid' });
  assert.throws(() => resolveSynthesisConfig({
    homeConfig: {},
    env: { SYNTHESIS_LLM_PROVIDER: 'minimax' },
    modelCatalog,
    providerRegistry: exactRegistry(modelCatalog),
  }), { code: 'synthesis_config_invalid' });
  assert.throws(() => resolveSynthesisConfig({
    homeConfig: { synthesis: { model: 'not-real' } },
    env: {},
    modelCatalog,
    providerRegistry: exactRegistry(modelCatalog),
  }), { code: 'model_not_found' });
  assert.throws(() => resolveSynthesisConfig({
    homeConfig: {},
    env: {},
    modelCatalog,
    providerRegistry: { assertPairAvailable() { throw Object.assign(new Error('no key'), { code: 'provider_unavailable' }); } },
  }), { code: 'provider_unavailable' });
});

test('fixed adapter crosses the exact registry client and revalidates completion', async () => {
  const modelCatalog = catalog();
  const calls = [];
  const activity = [];
  const clientSignal = new AbortController().signal;
  const registry = exactRegistry(modelCatalog, async (request) => {
    calls.push(request);
    request.onProviderActivity({ type: 'content_delta', at: '2026-07-10T00:00:00.000Z' });
    return {
      content: '{"selfUnderstanding":{"summary":"ok"}}',
      terminalReceived: true,
      finishReason: 'stop',
      hadError: false,
    };
  });
  const resolved = resolveSynthesisConfig({
    homeConfig: { synthesis: { provider: 'minimax', model: 'MiniMax-M3' } },
    env: {},
    modelCatalog,
    providerRegistry: registry,
  });
  const adapter = createSynthesisProviderAdapter(resolved);
  const result = await adapter.generate({
    instructions: 'fixed instructions',
    input: 'fixed input',
    signal: clientSignal,
    onProviderActivity: (event) => activity.push(event),
  });
  assert.equal(result.status, 'complete');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'minimax');
  assert.equal(calls[0].model, 'MiniMax-M3');
  assert.equal(calls[0].maxOutputTokens, 32768);
  assert.equal(
    calls[0].maxOutputBytes,
    SYNTHESIS_OPERATION_LIMITS.maxProviderOutputBytes,
  );
  assert.equal(calls[0].signal, clientSignal);
  assert.deepEqual(activity, [{ type: 'content_delta', at: '2026-07-10T00:00:00.000Z' }]);
  await assert.rejects(() => adapter.generate({ model: 'other' }), {
    code: 'provider_model_mismatch',
  });
});

test('fixed adapter forwards lowered output bytes, accepts exact boundary, and rejects raises', async () => {
  const modelCatalog = catalog();
  let content = 'x'.repeat(64);
  let calls = 0;
  const registry = exactRegistry(modelCatalog, async (request) => {
    calls += 1;
    assert.equal(request.maxOutputBytes, 64);
    if (Buffer.byteLength(content, 'utf8') > request.maxOutputBytes) {
      throw Object.assign(new Error('bounded provider adapter rejected output'), {
        code: 'result_too_large', retryable: false,
      });
    }
    return {
      content, terminalReceived: true, finishReason: 'stop', hadError: false,
    };
  });
  const adapter = createSynthesisProviderAdapter(resolveSynthesisConfig({
    homeConfig: {}, env: {}, modelCatalog, providerRegistry: registry,
  }));

  const exact = await adapter.generate({ maxOutputBytes: 64 });
  assert.equal(exact.content, 'x'.repeat(64));
  content += 'x';
  await assert.rejects(adapter.generate({ maxOutputBytes: 64 }), {
    code: 'result_too_large', retryable: false,
  });
  assert.equal(calls, 2);

  await assert.rejects(adapter.generate({
    maxOutputBytes: SYNTHESIS_OPERATION_LIMITS.maxProviderOutputBytes + 1,
  }), { code: 'invalid_request' });
  assert.equal(calls, 2);
});

test('fixed adapter preserves exact cancellation and rejects incomplete provider results', async () => {
  const modelCatalog = catalog();
  const incomplete = createSynthesisProviderAdapter(resolveSynthesisConfig({
    homeConfig: {}, env: {}, modelCatalog,
    providerRegistry: exactRegistry(modelCatalog, async () => ({
      content: '', terminalReceived: false, finishReason: null, hadError: false,
    })),
  }));
  await assert.rejects(() => incomplete.generate({}), (error) => error instanceof ProviderCompletionError);

  const controller = new AbortController();
  const reason = Object.assign(new Error('sentinel'), { name: 'AbortError' });
  controller.abort(reason);
  await assert.rejects(() => incomplete.generate({ signal: controller.signal }), (error) => error === reason);
});
