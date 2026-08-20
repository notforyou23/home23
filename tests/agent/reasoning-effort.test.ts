import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORTS,
  parseReasoningEffort,
  validateReasoningEffortConfig,
} from '../../src/agent/reasoning-effort.js';
import { resolveModelOverride } from '../../src/agent/model-resolution.js';

test('accepts exactly the six reasoning effort values', () => {
  assert.deepEqual(REASONING_EFFORTS, ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(DEFAULT_REASONING_EFFORT, 'medium');
  for (const value of REASONING_EFFORTS) {
    assert.equal(parseReasoningEffort(value), value);
  }
  for (const value of ['', 'LOW', 'ultra', 1, null]) {
    assert.throws(() => parseReasoningEffort(value), /none, low, medium, high, xhigh, max/);
  }
});

test('model alias resolution carries an alias effort override', () => {
  assert.deepEqual(resolveModelOverride('gpt56', {
    gpt56: { provider: 'openai-codex', model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' },
  }), {
    model: 'gpt-5.6-sol', provider: 'openai-codex', reasoningEffort: 'xhigh',
  });
});

test('config effort validation rejects invalid chat, model, and alias values', () => {
  assert.throws(
    () => validateReasoningEffortConfig({ chat: { reasoningEffort: 'ultra' } }),
    /chat\.reasoningEffort/,
  );
  assert.throws(
    () => validateReasoningEffortConfig({ models: { reasoningEffort: { 'gpt-5.6-sol': 'ultra' } } }),
    /models\.reasoningEffort/,
  );
  assert.throws(
    () => validateReasoningEffortConfig({ models: { aliases: { gpt56: { reasoningEffort: 'ultra' } } } }),
    /models\.aliases\.gpt56\.reasoningEffort/,
  );
});
