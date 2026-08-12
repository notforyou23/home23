'use strict';

/**
 * Engine roles must accept openai-codex models.
 *
 * resolveProvider() gated every role on base-engine.yaml's providers[name]
 * .enabled — correct for constructor-initialized providers (xai, minimax,
 * ollama-cloud fail at call time as "not initialized" when disabled), but
 * WRONG for openai-codex, which UnifiedClient routes at call time and builds
 * lazily; it consults no enabled flag. The gate silently discarded jtr's
 * codex engine roles from 2026-04-18 until it was made loud on 2026-08-11 —
 * while chat, Query, and research ran codex the whole time through paths
 * that never see this gate.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function makeConfigDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-codex-'));
  fs.mkdirSync(path.join(root, 'configs'));
  fs.mkdirSync(path.join(root, 'config'));
  // Real base-engine.yaml so every required section exists; the test then
  // pins providers/modelAssignments explicitly post-load.
  fs.copyFileSync(
    path.join(__dirname, '..', '..', '..', 'configs', 'base-engine.yaml'),
    path.join(root, 'configs', 'base-engine.yaml'),
  );
  fs.writeFileSync(path.join(root, 'config', 'home.yaml'), [
    'providers:',
    '  openai-codex:',
    '    defaultModels: [gpt-5.6-luna, gpt-5.6-sol]',
    '  xai:',
    '    defaultModels: [grok-test-1]',
    '',
  ].join('\n'));
  return root;
}

function loadWith(root, engineOverrides) {
  const modulePath = require.resolve('../../../engine/src/core/config-loader');
  delete require.cache[modulePath];
  const { ConfigLoader } = require(modulePath);
  const loader = new ConfigLoader(path.join(root, 'configs', 'base-engine.yaml'));
  loader.load();
  loader.config.providers = { minimax: { enabled: true }, openai: { enabled: false } };
  loader.config.modelAssignments = {
    'quantumReasoner.branches': { provider: 'minimax', model: 'MiniMax-M3' },
    coordinator: { provider: 'minimax', model: 'MiniMax-M3' },
  };
  loader.applyInstanceEngineOverrides({ engine: engineOverrides });
  return loader.config;
}

test('an openai-codex model IS accepted for engine roles — codex needs no enabled flag', (t) => {
  const root = makeConfigDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const config = loadWith(root, { thought: 'gpt-5.6-luna' });
  const slot = config.modelAssignments['quantumReasoner.branches'];
  assert.equal(slot.model, 'gpt-5.6-luna');
  assert.equal(slot.provider, 'openai-codex');
});

test('a model of a DISABLED constructor-gated provider is still refused', (t) => {
  const root = makeConfigDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // xai is in home.yaml's catalog but NOT enabled in base-engine: the unified
  // client genuinely will not have an xai client, so the skip is correct.
  const config = loadWith(root, { thought: 'grok-test-1' });
  const slot = config.modelAssignments['quantumReasoner.branches'];
  assert.equal(slot.model, 'MiniMax-M3', 'slot keeps its working assignment');
  assert.equal(slot.provider, 'minimax');
});
