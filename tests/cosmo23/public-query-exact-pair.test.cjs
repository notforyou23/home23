'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const querySource = fs.readFileSync(
  path.resolve(__dirname, '../../cosmo23/public/js/query-tab.js'),
  'utf8',
);
const appSource = fs.readFileSync(
  path.resolve(__dirname, '../../cosmo23/public/app.js'),
  'utf8',
);

function loadQueryHelpers(document = {}) {
  const context = vm.createContext({
    console,
    document,
    window: {},
    URLSearchParams,
    TextDecoder,
    setInterval,
    clearInterval,
  });
  vm.runInContext(`${querySource}\n;globalThis.__queryHelpers = {
    buildCosmoQueryRequest,
    buildCosmoPgsCoverageHTML,
    decodeQueryModelPair,
    encodeQueryModelPair,
    refreshCosmoQueryTabState,
  };`, context, { filename: 'query-tab.js' });
  return context.__queryHelpers;
}

function makeDocument() {
  return {
    createElement(kind) {
      if (kind === 'optgroup') {
        return {
          children: [],
          appendChild(option) { this.children.push(option); },
        };
      }
      return { value: '', textContent: '', dataset: {} };
    },
    querySelectorAll() { return []; },
    getElementById() { return null; },
  };
}

function makeSelect() {
  return {
    disabled: false,
    options: [],
    value: '',
    appendChild(group) { this.options.push(...group.children); },
    set innerHTML(_value) {
      this.options = [];
      this.value = '';
    },
  };
}

function loadAppHelpers(document = makeDocument()) {
  const context = vm.createContext({
    console,
    document,
    localStorage: {},
    window: {
      addEventListener() {},
      location: { protocol: 'http:', hostname: 'localhost' },
    },
    URLSearchParams,
    TextDecoder,
    setInterval,
    clearInterval,
  });
  vm.runInContext(querySource, context, { filename: 'query-tab.js' });
  vm.runInContext(`${appSource}\n;globalThis.__appHelpers = {
    CosmoStandaloneApp,
  };`, context, { filename: 'app.js' });
  return context.__appHelpers;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('COSMO Query model values retain exact provider identity for duplicate model IDs', () => {
  const { encodeQueryModelPair, decodeQueryModelPair } = loadQueryHelpers();
  const openai = encodeQueryModelPair({ provider: 'openai', model: 'gpt-5.5' });
  const codex = encodeQueryModelPair({ provider: 'openai-codex', model: 'gpt-5.5' });

  assert.notEqual(openai, codex);
  assert.deepEqual(plain(decodeQueryModelPair(codex)), {
    provider: 'openai-codex',
    model: 'gpt-5.5',
  });
});

test('COSMO Query builds the same exact Direct body for streaming and non-streaming routes', () => {
  const { buildCosmoQueryRequest } = loadQueryHelpers();
  assert.deepEqual(plain(buildCosmoQueryRequest({
    query: 'what changed',
    enablePGS: false,
    mode: 'full',
    modelSelection: { provider: 'openai-codex', model: 'gpt-5.5' },
    enableSynthesis: true,
    includeCoordinatorInsights: true,
    includeOutputs: true,
    includeThoughts: true,
    allowActions: false,
    priorContext: { query: 'before', answer: 'earlier answer' },
  })), {
    query: 'what changed',
    enablePGS: false,
    mode: 'full',
    provider: 'openai-codex',
    model: 'gpt-5.5',
    enableSynthesis: true,
    includeCoordinatorInsights: true,
    includeOutputs: true,
    includeThoughts: true,
    allowActions: false,
    priorContext: { query: 'before', answer: 'earlier answer' },
  });
});

test('COSMO Query sends exact PGS pairs with canonical modes and named levels', () => {
  const { buildCosmoQueryRequest } = loadQueryHelpers();
  const request = plain(buildCosmoQueryRequest({
    query: 'cover the graph',
    enablePGS: true,
    pgsMode: 'fresh',
    pgsLevel: 'deep',
    pgsSweep: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
    pgsSynth: { provider: 'openai-codex', model: 'gpt-5.5' },
  }));

  assert.deepEqual(request, {
    query: 'cover the graph',
    enablePGS: true,
    pgsMode: 'fresh',
    pgsLevel: 'deep',
    pgsSweep: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
    pgsSynth: { provider: 'openai-codex', model: 'gpt-5.5' },
  });
  for (const legacyField of [
    'model', 'provider', 'pgsConfig', 'pgsFullSweep', 'pgsSessionId', 'pgsSweepModel',
  ]) {
    assert.equal(Object.hasOwn(request, legacyField), false, legacyField);
  }

  assert.deepEqual(plain(buildCosmoQueryRequest({
    query: 'continue graph coverage',
    enablePGS: true,
    pgsMode: 'continue',
    pgsLevel: 'full',
    continueFromOperationId: `brop_${'A'.repeat(32)}`,
    pgsSweep: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
    pgsSynth: { provider: 'openai-codex', model: 'gpt-5.5' },
  })), {
    query: 'continue graph coverage',
    enablePGS: true,
    pgsMode: 'continue',
    pgsLevel: 'full',
    continueFromOperationId: `brop_${'A'.repeat(32)}`,
    pgsSweep: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
    pgsSynth: { provider: 'openai-codex', model: 'gpt-5.5' },
  });

  assert.deepEqual(plain(buildCosmoQueryRequest({
    query: 'focus graph coverage',
    enablePGS: true,
    pgsMode: 'targeted',
    pgsLevel: 'skim',
    continueFromOperationId: `brop_${'A'.repeat(32)}`,
    targetPartitionIds: 'c-one, h-two',
    pgsSweep: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
    pgsSynth: { provider: 'openai-codex', model: 'gpt-5.5' },
  })), {
    query: 'focus graph coverage',
    enablePGS: true,
    pgsMode: 'targeted',
    pgsLevel: 'skim',
    continueFromOperationId: `brop_${'A'.repeat(32)}`,
    targetPartitionIds: ['c-one', 'h-two'],
    pgsSweep: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
    pgsSynth: { provider: 'openai-codex', model: 'gpt-5.5' },
  });
});

test('COSMO Query rejects model-only selections and invalid PGS session combinations', () => {
  const { buildCosmoQueryRequest } = loadQueryHelpers();
  assert.throws(() => buildCosmoQueryRequest({
    query: 'x', enablePGS: false, mode: 'full', modelSelection: { model: 'gpt-5.5' },
  }), /provider/i);
  assert.throws(() => buildCosmoQueryRequest({
    query: 'x', enablePGS: true, pgsMode: 'continue', pgsLevel: 'sample',
    pgsSweep: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
    pgsSynth: { provider: 'openai-codex', model: 'gpt-5.5' },
  }), /prior operation/i);
  assert.throws(() => buildCosmoQueryRequest({
    query: 'x', enablePGS: true, pgsMode: 'fresh', pgsLevel: 'sample',
    continueFromOperationId: `brop_${'A'.repeat(32)}`,
    pgsSweep: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
    pgsSynth: { provider: 'openai-codex', model: 'gpt-5.5' },
  }), /fresh/i);
  assert.throws(() => buildCosmoQueryRequest({
    query: 'x', enablePGS: true, pgsMode: 'targeted', pgsLevel: 'sample',
    targetPartitionIds: ['not-a-canonical-partition'],
    pgsSweep: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
    pgsSynth: { provider: 'openai-codex', model: 'gpt-5.5' },
  }), /partition/i);
  assert.throws(() => buildCosmoQueryRequest({
    query: 'x', enablePGS: true, pgsMode: 'targeted', pgsLevel: 'sample',
    targetPartitionIds: ['c-one', 'c-one'],
    pgsSweep: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
    pgsSynth: { provider: 'openai-codex', model: 'gpt-5.5' },
  }), /duplicate/i);
  assert.throws(() => buildCosmoQueryRequest({
    query: 'x', enablePGS: true, pgsMode: 'fresh', pgsLevel: 'quarter',
    pgsSweep: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
    pgsSynth: { provider: 'openai-codex', model: 'gpt-5.5' },
  }), /level/i);
});

test('COSMO Query exposes fresh, continue, and targeted PGS controls', () => {
  assert.match(querySource, /<select id="qt-pgs-mode"[^>]*>/);
  assert.match(querySource, /<option value="fresh"[^>]*>/);
  assert.match(querySource, /<option value="continue"[^>]*>/);
  assert.match(querySource, /<option value="targeted"[^>]*>/);
  assert.match(querySource, /id="qt-pgs-continue-operation"/);
  assert.match(querySource, /id="qt-pgs-targets"/);
});

test('COSMO Query refreshes its model summary and selected-brain empty state after async data arrives', () => {
  const elements = new Map([
    ['qt-options-summary', { textContent: 'Full mode · Loading models...' }],
    ['qt-mode', { value: 'full' }],
    ['qt-model', {
      value: 'openai-codex::gpt-5.5',
      selectedOptions: [{ textContent: 'gpt-5.5' }],
    }],
    ['qt-pgs', { checked: false }],
    ['qt-pgs-level', { value: 'sample' }],
    ['qt-pgs-mode', { value: 'fresh' }],
    ['query-brain', { value: 'brain-jerry' }],
  ]);
  const placeholder = { textContent: 'No brain selected' };
  const document = {
    getElementById(id) { return elements.get(id) || null; },
    querySelector(selector) {
      return selector === '.qt-result-placeholder p' ? placeholder : null;
    },
  };
  const { refreshCosmoQueryTabState } = loadQueryHelpers(document);

  refreshCosmoQueryTabState();

  assert.equal(elements.get('qt-options-summary').textContent, 'Full mode · gpt-5.5');
  assert.equal(placeholder.textContent, "Ask a question above to query this brain's knowledge");
});

test('COSMO async model and brain renderers refresh the Query tab state', () => {
  assert.match(appSource, /renderModelOptions\(\)[\s\S]*?refreshCosmoQueryTabState/);
  assert.match(appSource, /renderQueryBrains\(\)[\s\S]*?refreshCosmoQueryTabState/);
});

test('COSMO Query reports truthful scoped and reusable PGS coverage with its prior operation ID', () => {
  const { buildCosmoPgsCoverageHTML } = loadQueryHelpers();
  const html = buildCosmoPgsCoverageHTML({
    coverageLevel: 'skim',
    coverageFraction: 0.1,
    scopeSuccessfulWorkUnits: 8,
    scopeWorkUnits: 10,
    scopePendingWorkUnits: 2,
    globalCoveredWorkUnits: 18,
    globalWorkUnits: 100,
    globalPendingWorkUnits: 82,
    reusedWorkUnits: 6,
    newWorkUnits: 2,
    fullCoverage: false,
    targetPartitionIds: ['c-one'],
  }, { operationId: `brop_${'A'.repeat(32)}` });

  assert.match(html, /Skim \(10%\)/);
  assert.match(html, /Requested scope: 8\/10 complete; 2 pending/);
  assert.match(html, /Global coverage: 18\/100; 82 pending/);
  assert.match(html, /Full graph coverage: not yet complete/);
  assert.match(html, /6 reused; 2 new/);
  assert.match(html, /Target partitions: c-one/);
  assert.match(html, new RegExp(`Operation:.*brop_${'A'.repeat(32)}`));
  assert.doesNotMatch(html, /100% coverage/);
});

test('COSMO Query selectors use managed exact defaults and never invent custom entries', () => {
  const document = makeDocument();
  const { CosmoStandaloneApp } = loadAppHelpers(document);
  const app = Object.create(CosmoStandaloneApp.prototype);
  const models = [
    { id: 'gpt-5.5', provider: 'openai', providerLabel: 'OpenAI', label: 'GPT 5.5' },
    { id: 'gpt-5.5', provider: 'openai-codex', providerLabel: 'Codex', label: 'GPT 5.5' },
  ];
  const select = makeSelect();

  assert.equal(app.populateQueryModelSelect(select, models, {
    provider: 'openai-codex', model: 'gpt-5.5',
  }), true);
  assert.equal(select.disabled, false);
  assert.equal(select.options.length, 2);
  assert.equal(new Set(select.options.map(option => option.value)).size, 2);
  assert.equal(select.options.some(option => /custom/i.test(option.textContent)), false);

  assert.equal(app.populateQueryModelSelect(select, models, {
    provider: 'xai', model: 'gpt-5.5',
  }), false);
  assert.equal(select.disabled, true);
  assert.equal(select.options.some(option => /custom/i.test(option.textContent)), false);
});

test('COSMO model loading retains provider-bearing managed Query defaults', async () => {
  const { CosmoStandaloneApp } = loadAppHelpers();
  const app = Object.create(CosmoStandaloneApp.prototype);
  const queryDefaults = {
    defaultProvider: 'openai-codex', defaultModel: 'gpt-5.5',
    pgsSweepProvider: 'openai-codex', pgsSweepModel: 'gpt-5.4-mini',
    pgsSynthProvider: 'openai-codex', pgsSynthModel: 'gpt-5.5',
  };
  app.models = [];
  app.modelDefaults = {};
  app.queryDefaults = null;
  app.api = async () => ({ models: [], defaults: {}, queryDefaults });
  app.renderModelOptions = () => {};
  app.showToast = (message) => assert.fail(message);

  await app.loadModels();
  assert.deepEqual(plain(app.queryDefaults), queryDefaults);
});

test('COSMO Query production code has no literal model fallback', () => {
  const renderStart = appSource.indexOf('renderModelOptions()');
  const renderEnd = appSource.indexOf('applyCatalogFormValues()', renderStart);
  assert.notEqual(renderStart, -1);
  assert.notEqual(renderEnd, -1);
  const renderSource = appSource.slice(renderStart, renderEnd);
  assert.doesNotMatch(renderSource, /qt-(?:model|pgs-sweep-model|pgs-synth-model)[\s\S]{0,160}gpt-[0-9]/);
});
