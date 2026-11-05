'use strict';

const PROVIDER_PROTOCOL_RESERVE_TOKENS = 8_192;
const CONTEXT_WINDOW_UTILIZATION_NUMERATOR = 95;
const CONTEXT_WINDOW_UTILIZATION_DENOMINATOR = 100;

function typed(code, message) {
  return Object.assign(new Error(message), { code, retryable: false });
}

function resolveProviderInputBudget(capabilities, {
  maxInputBytes,
  label = 'Provider input',
} = {}) {
  const contextWindowTokens = capabilities?.contextWindowTokens;
  const maxOutputTokens = capabilities?.maxOutputTokens;
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens <= 0
      || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw typed(
      'model_capability_invalid',
      `${label} is missing a valid model context capability`,
    );
  }
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes <= 0) {
    throw typed('invalid_request', `${label} byte limit is invalid`);
  }
  const effectiveContextWindowTokens = Math.floor(
    (contextWindowTokens * CONTEXT_WINDOW_UTILIZATION_NUMERATOR)
      / CONTEXT_WINDOW_UTILIZATION_DENOMINATOR,
  );
  const inputBudgetTokens = effectiveContextWindowTokens
    - maxOutputTokens
    - PROVIDER_PROTOCOL_RESERVE_TOKENS;
  if (!Number.isSafeInteger(inputBudgetTokens) || inputBudgetTokens <= 0) {
    throw typed(
      'model_capability_invalid',
      `${label} model leaves no safe input context budget`,
    );
  }
  // One UTF-8 byte per token is deliberately conservative for byte-level
  // tokenizers and remains safe for arbitrary Unicode and JSON escaping.
  const modelInputBudgetBytes = inputBudgetTokens;
  const inputBudgetBytes = Math.min(maxInputBytes, modelInputBudgetBytes);
  return Object.freeze({
    contextWindowTokens,
    effectiveContextWindowTokens,
    maxOutputTokens,
    protocolReserveTokens: PROVIDER_PROTOCOL_RESERVE_TOKENS,
    inputBudgetTokens,
    modelInputBudgetBytes,
    inputBudgetBytes,
  });
}

function assertProviderInputWithinBudget({
  capabilities,
  maxInputBytes,
  instructions,
  input,
  label = 'Provider input',
} = {}) {
  if (typeof instructions !== 'string' || typeof input !== 'string') {
    throw typed('invalid_request', `${label} must use decoded string input`);
  }
  const budget = resolveProviderInputBudget(capabilities, { maxInputBytes, label });
  const instructionsBytes = Buffer.byteLength(instructions, 'utf8');
  const inputBytes = Buffer.byteLength(input, 'utf8');
  const totalInputBytes = instructionsBytes + inputBytes;
  if (!Number.isSafeInteger(totalInputBytes) || totalInputBytes > budget.inputBudgetBytes) {
    throw typed('result_too_large', `${label} exceeds the provider input byte limit`);
  }
  return Object.freeze({
    ...budget,
    instructionsBytes,
    inputBytes,
    totalInputBytes,
  });
}

module.exports = {
  CONTEXT_WINDOW_UTILIZATION_DENOMINATOR,
  CONTEXT_WINDOW_UTILIZATION_NUMERATOR,
  PROVIDER_PROTOCOL_RESERVE_TOKENS,
  assertProviderInputWithinBudget,
  resolveProviderInputBudget,
};
