/**
 * P2-12/13 (2026-08-11 audit): ONE canonical model→provider rule set with two
 * DECLARED caller policies, and ONE fleet defaults table. Before this, two
 * copies of the inference rules had opposite failure modes (subagent rejected
 * what generateText silently routed to ollama-cloud), and the default-model
 * table existed in seven places naming dead models.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { inferProviderFromModel, resolveModelOverride } from '../../src/agent/model-resolution.js';
import { inferTextGenerationProvider } from '../../src/agent/text-generation.js';

const requireCjs = createRequire(import.meta.url);
const fleetDefaults = requireCjs('../../shared/model-defaults.cjs') as {
  DEFAULT_CHAT_PROVIDER: string;
  DEFAULT_CHAT_MODEL: string;
  DEFAULT_MODEL_BY_PROVIDER: Record<string, string>;
};

test('canonical inference: one rule set', () => {
  assert.equal(inferProviderFromModel('claude-haiku-4-5'), 'anthropic');
  assert.equal(inferProviderFromModel('grok-4.5'), 'xai');
  assert.equal(inferProviderFromModel('MiniMax-M3'), 'minimax');
  assert.equal(inferProviderFromModel('gpt-5.6-terra'), 'openai');
  assert.equal(inferProviderFromModel('kimi-k3:cloud'), 'unknown');
  assert.equal(inferProviderFromModel('anything', 'openai-codex'), 'openai-codex', 'explicit provider always wins');
});

test('MiniMax case rule is a contract, not a bug: lowercase clones are NOT the MiniMax API', () => {
  // 'minimax-m2.7' is an ollama-cloud-served clone (it is in the ollama-cloud
  // catalog). Routing it to the MiniMax API would be wrong — the brand-cased
  // discriminator is deliberate.
  assert.equal(inferProviderFromModel('minimax-m2.7'), 'unknown');
  assert.equal(inferTextGenerationProvider('minimax-m2.7'), 'ollama-cloud');
});

test('strict policy rejects what the lenient policy routes to the catch-all tier', () => {
  // STRICT (background-work creators): unknown → null.
  assert.equal(resolveModelOverride('totally-made-up-model'), null);
  // LENIENT (bare names from lobes/cron): unknown → ollama-cloud.
  assert.equal(inferTextGenerationProvider('totally-made-up-model'), 'ollama-cloud');
  // Both agree wherever the canonical rules match.
  for (const [model, provider] of [
    ['claude-haiku-4-5', 'anthropic'],
    ['grok-4.3', 'xai'],
    ['MiniMax-M3', 'minimax'],
    ['gpt-5.4-mini', 'openai'],
  ] as const) {
    assert.equal(inferTextGenerationProvider(model), provider);
    assert.deepEqual(resolveModelOverride(model), { model, provider });
  }
});

test('alias resolution wins over inference and carries the declared provider', () => {
  const aliases = { m27: { provider: 'ollama-cloud', model: 'minimax-m2.7' } };
  assert.deepEqual(resolveModelOverride('m27', aliases), { model: 'minimax-m2.7', provider: 'ollama-cloud' });
});

test('fleet defaults: one table, no dead models', () => {
  assert.equal(fleetDefaults.DEFAULT_CHAT_PROVIDER, 'ollama-cloud');
  assert.equal(fleetDefaults.DEFAULT_CHAT_MODEL, 'kimi-k3:cloud');
  assert.notEqual(fleetDefaults.DEFAULT_CHAT_MODEL, 'kimi-k2.6', 'the dead model the seven copies disagreed about');
  for (const provider of ['anthropic', 'minimax', 'openai', 'openai-codex', 'xai', 'ollama-cloud']) {
    assert.ok(fleetDefaults.DEFAULT_MODEL_BY_PROVIDER[provider], `${provider} has a floor model`);
  }
});
