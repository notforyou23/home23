'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertProviderInputWithinBudget,
  resolveProviderInputBudget,
} = require('../../cosmo23/lib/provider-input-budget');
const {
  createProviderPromptBudget,
} = require('../../cosmo23/lib/provider-prompt-budget');

test('provider input budget reserves 5 percent, model output, and protocol capacity', () => {
  const budget = resolveProviderInputBudget({
    contextWindowTokens: 272_000,
    maxOutputTokens: 32_768,
  }, {
    maxInputBytes: 16 * 1024 * 1024,
    label: 'PGS synthesis input',
  });

  assert.deepEqual(budget, {
    contextWindowTokens: 272_000,
    effectiveContextWindowTokens: 258_400,
    maxOutputTokens: 32_768,
    protocolReserveTokens: 8_192,
    inputBudgetTokens: 217_440,
    modelInputBudgetBytes: 217_440,
    inputBudgetBytes: 217_440,
  });
});

test('provider input measurement counts exact decoded UTF-8 instructions and prompt bytes', () => {
  const instructions = 'Instruction 🧠';
  const input = JSON.stringify({ query: '🧠"\\\n'.repeat(50) });
  const expectedBytes = Buffer.byteLength(instructions, 'utf8')
    + Buffer.byteLength(input, 'utf8');
  const measured = assertProviderInputWithinBudget({
    capabilities: { contextWindowTokens: 64_000, maxOutputTokens: 4_096 },
    maxInputBytes: expectedBytes,
    instructions,
    input,
    label: 'Unicode provider input',
  });

  assert.equal(measured.instructionsBytes, Buffer.byteLength(instructions, 'utf8'));
  assert.equal(measured.inputBytes, Buffer.byteLength(input, 'utf8'));
  assert.equal(measured.totalInputBytes, expectedBytes);
  assert.equal(measured.inputBudgetBytes, expectedBytes);
  assert.throws(() => assertProviderInputWithinBudget({
    capabilities: { contextWindowTokens: 64_000, maxOutputTokens: 4_096 },
    maxInputBytes: expectedBytes - 1,
    instructions,
    input,
    label: 'Unicode provider input',
  }), { code: 'result_too_large', retryable: false });
});

test('provider input budget fails closed without exact reviewed context capability', () => {
  for (const capabilities of [
    { maxOutputTokens: 4_096 },
    { contextWindowTokens: 4_096, maxOutputTokens: 4_096 },
    { contextWindowTokens: 12_000, maxOutputTokens: 4_096 },
  ]) {
    assert.throws(() => resolveProviderInputBudget(capabilities, {
      maxInputBytes: 1_024,
      label: 'provider input',
    }), { code: 'model_capability_invalid', retryable: false });
  }
});

test('OpenAI prompt budget measures final input with o200k_base tokens', () => {
  const budget = createProviderPromptBudget({
    provider: 'openai-codex',
    capabilities: { contextWindowTokens: 128_000, maxOutputTokens: 32_768 },
    maxOutputTokens: 25_000,
    maxInputBytes: 8 * 1024 * 1024,
    label: 'Direct Query prompt',
  });
  const instructions = 'Give a direct evidence-backed answer.';
  const input = JSON.stringify({ evidence: 'evidence '.repeat(40_000) });
  const measurement = budget.measure(instructions, input);

  assert.equal(budget.strategy, 'o200k_base');
  assert.equal(budget.inputBudgetTokens, 88_408);
  assert.equal(measurement.totalTokens < measurement.totalBytes, true);
  assert.equal(measurement.fits, true);
  assert.equal(budget.fits(instructions, input), true);
  assert.equal(
    budget.fits(instructions, JSON.stringify({ evidence: 'evidence '.repeat(100_000) })),
    false,
  );
});

test('non-OpenAI prompt budget retains conservative byte accounting', () => {
  const budget = createProviderPromptBudget({
    provider: 'anthropic',
    capabilities: { contextWindowTokens: 128_000, maxOutputTokens: 32_768 },
    maxOutputTokens: 25_000,
    maxInputBytes: 8 * 1024 * 1024,
  });
  const instructions = 'answer';
  const input = 'x'.repeat(88_500);

  assert.equal(budget.strategy, 'conservative-bytes');
  assert.equal(budget.fits(instructions, input), false);
});
