import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import yaml from 'js-yaml';
import { buildFreshEngineConfig, prepareFreshEngineConfig } from '../../cli/lib/fresh-engine-config.js';

const require = createRequire(import.meta.url);
const { ConfigLoader } = require('../../engine/src/core/config-loader.js');
const profile = { name: 'milo', ownerName: 'Alex', purpose: 'Help with family projects.', provider: 'anthropic', model: 'claude-haiku-4-5' };

test('new-home engine has the selected provider in every maintained assignment and no inherited owner identity', () => {
  const config = buildFreshEngineConfig(profile);
  assert.deepEqual(Object.keys(config.providers), ['anthropic']);
  assert.equal(config.providers.anthropic.enabled, true);
  for (const assignment of Object.values(config.modelAssignments)) {
    assert.deepEqual(assignment, { provider: profile.provider, model: profile.model });
  }
  assert.equal(config.models.primary, profile.model);
  assert.equal(config.coordinator.model, profile.model);
  assert.equal(config.feeder.compiler.model, profile.model);
  const roles = JSON.stringify(config.architecture.roleSystem);
  assert.match(roles, /Alex/);
  assert.match(roles, /Help with family projects/);
  assert.doesNotMatch(roles, /\bjtr\b|\bjerry\b|\bforrest\b|\bsauna\b/i);
  const local = buildFreshEngineConfig({ ...profile, provider: 'ollama-local', model: 'qwen2.5:7b' });
  assert.equal(local.modelAssignments.default.provider, 'local');
  assert.equal(local.providers.local.defaultModel, 'qwen2.5:7b');
  assert.deepEqual(local.providers.local.modelMapping, {});
  assert.throws(() => buildFreshEngineConfig({ ...profile, provider: 'unsupported' }), /Unsupported/);
});

test('prepared full engine configuration loads through the real engine and a retry preserves edits', t => {
  const root = mkdtempSync(join(tmpdir(), 'home23-engine-birth-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const instance = join(root, 'instances', profile.name);
  mkdirSync(instance, { recursive: true });
  writeFileSync(join(instance, 'config.yaml'), yaml.dump({ engine: { thought: profile.model, consolidation: profile.model, dreaming: profile.model } }));
  const result = prepareFreshEngineConfig(root, profile);
  assert.equal(result.created, true);
  assert.equal(result.engineConfigPath, 'engine.yaml');
  const loader = new ConfigLoader(result.absolutePath);
  loader.resolveInstanceConfigPath = () => join(instance, 'config.yaml');
  loader.resolveRunningAgentPaths = () => null;
  const loaded = loader.load();
  assert.deepEqual(loaded.modelAssignments.deepDive, { provider: 'anthropic', model: 'claude-haiku-4-5' });
  assert.equal(loaded.providers.anthropic.enabled, true);
  const edited = readFileSync(result.absolutePath, 'utf8') + '\n# An owner adjustment after preparation\n';
  writeFileSync(result.absolutePath, edited);
  assert.equal(prepareFreshEngineConfig(root, profile).created, false);
  assert.equal(readFileSync(result.absolutePath, 'utf8'), edited);
});
