'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const { ConfigLoader } = require('../../../engine/src/core/config-loader');
const { responsesReasoning } = require('../../../shared/responses-reasoning.cjs');

function fixture(t, overrides, assignments = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-effort-overlay-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const basePath = path.join(root, 'base-engine.yaml'), instancePath = path.join(root, 'instance.yaml');
  const base = yaml.load(fs.readFileSync(path.join(__dirname, '../../../configs/base-engine.yaml'), 'utf8'));
  base.modelAssignments = assignments;
  fs.writeFileSync(basePath, yaml.dump(base));
  fs.writeFileSync(instancePath, yaml.dump({ modelAssignments: overrides }));
  const loader = new ConfigLoader(basePath);
  loader.resolveInstanceConfigPath = () => instancePath;
  loader.resolveRunningAgentPaths = () => null;
  return loader;
}

test('effective instance loading retains frontier effort in all three thinking stages', t => {
  const slots = ['deepDive', 'critique', 'pgsSynthesis'];
  const selected = { provider: 'openai-codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' };
  const loader = fixture(t, Object.fromEntries(slots.map(key => [key, selected])),
    Object.fromEntries(slots.map(key => [key, { provider: 'minimax', model: 'MiniMax-M3' }])));
  const config = loader.load();
  for (const key of slots) {
    assert.deepEqual(config.modelAssignments[key], selected);
    assert.deepEqual(responsesReasoning(config.modelAssignments[key].model, config.modelAssignments[key].reasoningEffort),
      { effort: 'high', summary: 'auto' });
  }
});

test('omitted effort preserves the base, none is explicit, and unrelated override fields stay excluded', t => {
  const current = { provider: 'openai-codex', model: 'gpt-6.1-sol', reasoningEffort: 'medium', maxTokens: 900 };
  const loader = fixture(t, {
    inherited: { model: 'gpt-6-astra', arbitraryAuthority: 'publish' },
    off: { reasoningEffort: 'none', maxTokens: 99999,
      fallback: [{ provider: 'minimax', model: 'MiniMax-M3', arbitraryAuthority: 'publish' }] },
  }, { inherited: current, off: current });
  const assignments = loader.load().modelAssignments;
  assert.deepEqual(assignments.inherited, { ...current, model: 'gpt-6-astra' });
  assert.deepEqual(assignments.off, { ...current, reasoningEffort: 'none', fallback: [{ provider: 'minimax', model: 'MiniMax-M3' }] });
  assert.equal(responsesReasoning(assignments.off.model, assignments.off.reasoningEffort), undefined);
});

test('instance efforts use the transport enum and invalid values preserve the working effort with a warning', t => {
  const warnings = [];
  t.mock.method(console, 'warn', value => warnings.push(value));
  const overrides = {}, assignments = {};
  const accepted = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
  const rejected = ['ultra', 'HIGH', ['high'], null, true, 12];
  for (const [index, effort] of [...accepted, ...rejected].entries()) {
    assignments['slot' + index] = { provider: 'openai-codex', model: 'gpt-6.1-sol', reasoningEffort: 'medium' };
    overrides['slot' + index] = { reasoningEffort: effort };
  }
  const effective = fixture(t, overrides, assignments).load().modelAssignments;
  accepted.forEach((effort, index) => assert.equal(effective['slot' + index].reasoningEffort, effort));
  rejected.forEach((_, index) => assert.equal(effective['slot' + (index + accepted.length)].reasoningEffort, 'medium'));
  assert.equal(warnings.length, rejected.length);
  assert.ok(warnings.every(value => /reasoningEffort.*not applied/.test(value)));
});
