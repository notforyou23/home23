import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  BUILTIN_MODEL_CATALOG,
  normalizeModelCatalog,
} = require('../../../cosmo23/server/config/model-catalog.js');
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
    // Engine tests must not read the operator's standalone ~/.cosmo2.3
    // catalog. Home23 injects its managed catalog at runtime.
    catalog: normalizeModelCatalog(BUILTIN_MODEL_CATALOG),
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

// ── readCommittedAnswer (2026-07-20) ──────────────────────────────────
// The synthesis product is the committed brain-state.json the result claim
// points at; readCommittedAnswer follows the pointer or says why it can't.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { canonicalJson } = require('../../../shared/brain-operations/canonical-json.cjs');

const COMMITTED_OPERATION_ID = `brop_${'A'.repeat(32)}`;

function committedState(overrides = {}) {
  const base = {
    generatedAt: '2026-07-20T12:00:00.000Z',
    generationMarker: `generation-42-${'a'.repeat(24)}`,
    operationId: COMMITTED_OPERATION_ID,
    trigger: 'manual',
    sourceRevision: 42,
    provider: 'minimax',
    model: 'MiniMax-M3',
    durationMs: 1000,
    brainStats: { nodes: 3, edges: 2, clusters: 1, documentsCompiled: 0 },
    selfUnderstanding: {
      summary: 'I hold the thread of what matters.',
      currentObsessions: ['shared world model'],
      relationship: 'working partnership with jtr',
    },
    consolidatedInsights: [{
      title: 'Receipts are part of cognition',
      excerpt: 'Completion without evidence is theatre.',
      source: 'agency charter',
      themes: ['governance'],
    }],
    knowledgeIndex: 'index digest',
    recentActivity: ['compacted the pursuits ledger'],
    ...overrides,
  };
  const brainStateSha256 = `sha256:${createHash('sha256')
    .update(canonicalJson(base), 'utf8').digest('hex')}`;
  return { ...base, brainStateSha256 };
}

function runtimeWithBrainDir(brainDir) {
  const document = { synthesis: { model: 'MiniMax-M3' } };
  return createDashboardSynthesisOperationRuntime({
    brainDir,
    workspacePath: brainDir,
    homeConfig: document,
    catalog: normalizeModelCatalog(BUILTIN_MODEL_CATALOG),
    providerRegistry: registry(),
    settingsStore: {
      async read() { return { data: structuredClone(document), version: 'v1' }; },
      async update() { return { data: structuredClone(document), version: 'v2' }; },
    },
    startOperation: async () => ({ state: 'queued' }),
    SynthesisAgentClass: FakeSynthesisAgent,
  });
}

test('readCommittedAnswer renders the committed product when the claim matches', async (t) => {
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-synth-answer-'));
  t.after(() => fs.rmSync(brainDir, { recursive: true, force: true }));
  const state = committedState();
  fs.writeFileSync(path.join(brainDir, 'brain-state.json'), `${canonicalJson(state)}\n`);
  const runtime = runtimeWithBrainDir(brainDir);

  const joined = await runtime.readCommittedAnswer({
    operationId: state.operationId,
    generationMarker: state.generationMarker,
  });

  assert.equal('answerUnavailableReason' in joined, false);
  assert.match(joined.answer, /Self-understanding/);
  assert.match(joined.answer, /I hold the thread of what matters\./);
  assert.match(joined.answer, /Receipts are part of cognition/);
  assert.match(joined.answer, /Completion without evidence is theatre\./);
  assert.match(joined.answer, /compacted the pursuits ledger/);
});

test('readCommittedAnswer reports supersession when a newer synthesis overwrote the state', async (t) => {
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-synth-super-'));
  t.after(() => fs.rmSync(brainDir, { recursive: true, force: true }));
  const state = committedState();
  fs.writeFileSync(path.join(brainDir, 'brain-state.json'), `${canonicalJson(state)}\n`);
  const runtime = runtimeWithBrainDir(brainDir);

  const joined = await runtime.readCommittedAnswer({
    operationId: `brop_${'B'.repeat(32)}`,
    generationMarker: `generation-41-${'c'.repeat(24)}`,
  });

  assert.equal('answer' in joined, false);
  assert.match(joined.answerUnavailableReason, /superseded/);
  assert.match(joined.answerUnavailableReason, new RegExp(state.generationMarker));
});

test('readCommittedAnswer explains a missing committed state instead of failing', async (t) => {
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-synth-missing-'));
  t.after(() => fs.rmSync(brainDir, { recursive: true, force: true }));
  const runtime = runtimeWithBrainDir(brainDir);

  const joined = await runtime.readCommittedAnswer({
    operationId: COMMITTED_OPERATION_ID,
    generationMarker: `generation-42-${'a'.repeat(24)}`,
  });

  assert.match(joined.answerUnavailableReason, /no committed synthesis state/);
});
