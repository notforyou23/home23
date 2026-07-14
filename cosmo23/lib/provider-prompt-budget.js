'use strict';

const {
  CONTEXT_WINDOW_UTILIZATION_DENOMINATOR,
  CONTEXT_WINDOW_UTILIZATION_NUMERATOR,
  PROVIDER_PROTOCOL_RESERVE_TOKENS,
} = require('./provider-input-budget');

const TOKEN_PROVIDERS = new Set(['openai', 'openai-codex']);
let openAIEncoding = null;

function typed(code, message) {
  return Object.assign(new Error(message), { code, retryable: false });
}

function tokenizer() {
  if (openAIEncoding) return openAIEncoding;
  const { get_encoding: getEncoding } = require('tiktoken');
  openAIEncoding = getEncoding('o200k_base');
  return openAIEncoding;
}

function assertStringInputs(instructions, input, label) {
  if (typeof instructions !== 'string' || typeof input !== 'string') {
    throw typed('invalid_request', `${label} must use decoded string input`);
  }
}

function createProviderPromptBudget({
  provider,
  capabilities,
  maxOutputTokens,
  maxInputBytes,
  label = 'Provider prompt',
} = {}) {
  const contextWindowTokens = capabilities?.contextWindowTokens;
  const capabilityOutputTokens = capabilities?.maxOutputTokens;
  if (typeof provider !== 'string' || !provider
      || !Number.isSafeInteger(contextWindowTokens) || contextWindowTokens <= 0
      || !Number.isSafeInteger(capabilityOutputTokens) || capabilityOutputTokens <= 0) {
    throw typed('model_capability_invalid', `${label} is missing a valid model context capability`);
  }
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0
      || maxOutputTokens > capabilityOutputTokens) {
    throw typed('model_capability_invalid', `${label} output budget is invalid`);
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
    throw typed('model_capability_invalid', `${label} model leaves no safe input context budget`);
  }
  const tokenAware = TOKEN_PROVIDERS.has(provider);
  const strategy = tokenAware ? 'o200k_base' : 'conservative-bytes';
  const inputBudgetBytes = tokenAware
    ? maxInputBytes
    : Math.min(maxInputBytes, inputBudgetTokens);

  function measure(instructions, input) {
    assertStringInputs(instructions, input, label);
    const instructionsBytes = Buffer.byteLength(instructions, 'utf8');
    const inputBytes = Buffer.byteLength(input, 'utf8');
    const totalBytes = instructionsBytes + inputBytes;
    const totalTokens = tokenAware
      ? tokenizer().encode(instructions).length + tokenizer().encode(input).length
      : totalBytes;
    return Object.freeze({
      strategy,
      instructionsBytes,
      inputBytes,
      totalBytes,
      totalTokens,
      inputBudgetBytes,
      inputBudgetTokens,
      fits: totalBytes <= inputBudgetBytes && totalTokens <= inputBudgetTokens,
    });
  }

  function fits(instructions, input) {
    return measure(instructions, input).fits;
  }

  function assertFits(instructions, input) {
    const measured = measure(instructions, input);
    if (!measured.fits) {
      throw typed('result_too_large', `${label} exceeds the provider input budget`);
    }
    return measured;
  }

  return Object.freeze({
    strategy,
    contextWindowTokens,
    effectiveContextWindowTokens,
    maxOutputTokens,
    protocolReserveTokens: PROVIDER_PROTOCOL_RESERVE_TOKENS,
    inputBudgetTokens,
    inputBudgetBytes,
    measure,
    fits,
    assertFits,
  });
}

module.exports = {
  createProviderPromptBudget,
};
