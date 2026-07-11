'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertProviderInputWithinBudget,
  resolveProviderInputBudget,
} = require('../../cosmo23/lib/provider-input-budget');

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
