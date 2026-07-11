import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadModelCatalogSync } = require('../../../cosmo23/server/config/model-catalog.js');
const {
  createDashboardSynthesisOperationRuntime,
  persistSynthesisSelection,
} = require('../../../engine/src/dashboard/brain-operations/synthesis-operation-runtime.js');

function registry() {
  return {
    assertPairAvailable(provider, model) {
      assert.equal(provider, 'minimax');
      assert.equal(model, 'MiniMax-M3');
      return {
        providerId: provider,
        async generate() {
          return { content: '{}', terminalReceived: true, finishReason: 'stop', hadError: false };
        },
      };
    },
  };
}

class FakeSynthesisAgent {
  constructor(options) {
    this.options = options;
  }
  async runOperation() {
    throw new Error('not exercised');
  }
  run({ trigger } = {}) {
    return this.options.startSynthesisOperation({ trigger });
  }
}

test('dashboard synthesis runtime fixes the exact pair, migrates config, and starts durably', async () => {
  let document = { synthesis: { model: 'MiniMax-M3' } };
  let version = 1;
  const starts = [];
  const runtime = createDashboardSynthesisOperationRuntime({
    brainDir: '/tmp/home23-synthesis-runtime-brain',
    workspacePath: '/tmp/home23-synthesis-runtime-workspace',
    homeConfig: document,
    catalog: loadModelCatalogSync(),
    providerRegistry: registry(),
    settingsStore: {
      async read() { return { data: structuredClone(document), version: `v${version}` }; },
      async update({ expectedVersion, mutate }) {
        assert.equal(expectedVersion, `v${version}`);
        document = mutate(structuredClone(document));
        version += 1;
        return { data: structuredClone(document), version: `v${version}` };
      },
    },
    startOperation: async (input) => { starts.push(input); return { state: 'queued' }; },
    SynthesisAgentClass: FakeSynthesisAgent,
  });
  await runtime.settled;
  assert.deepEqual(document.synthesis, {
    model: 'MiniMax-M3', provider: 'minimax', intervalHours: 4,
  });
  assert.deepEqual(runtime.getReadiness(), {
    ready: true, status: 'ready', code: null, retryable: false, migrated: true,
  });
  assert.deepEqual(await runtime.resolveParameters({
    operationType: 'synthesis',
    requestParameters: { trigger: 'manual' },
  }), {
    trigger: 'manual', provider: 'minimax', model: 'MiniMax-M3',
  });
  assert.deepEqual(await runtime.agent.run({ trigger: 'scheduled' }), { state: 'queued' });
  assert.deepEqual(starts, [{
    trigger: 'scheduled', selection: { provider: 'minimax', model: 'MiniMax-M3' },
  }]);
  assert.equal(typeof runtime.executor, 'function');
});

test('synthesis settings CAS retries conflicts and reports durable exhaustion', async () => {
  const resolved = {
    needsPersistence: true,
    selection: { provider: 'minimax', model: 'MiniMax-M3' },
    intervalHours: 4,
  };
  let attempts = 0;
  const migrated = await persistSynthesisSelection({
    async read() { return { data: {}, version: `v${attempts}` }; },
    async update({ mutate }) {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('changed'), { code: 'settings_changed' });
      const data = mutate({});
      assert.deepEqual(data.synthesis, {
        provider: 'minimax', model: 'MiniMax-M3', intervalHours: 4,
      });
    },
  }, resolved);
  assert.equal(migrated, true);
  assert.equal(attempts, 3);

  await assert.rejects(() => persistSynthesisSelection({
    async read() { return { data: {}, version: 'v' }; },
    async update() { throw Object.assign(new Error('changed'), { code: 'settings_changed' }); },
  }, resolved, { maxAttempts: 2 }), { code: 'settings_changed' });
});
