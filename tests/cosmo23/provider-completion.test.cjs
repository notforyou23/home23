const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ProviderCompletionError,
  assertProviderResultIdentity,
  normalizeProviderCompletion,
  requireCompleteProviderResult,
} = require('../../cosmo23/lib/provider-completion');

const base = {
  provider: 'openai',
  model: 'gpt-5.4-mini',
  content: 'Grounded answer',
  terminalReceived: true,
  finishReason: 'completed',
  hadError: false,
  usage: { input_tokens: 10, output_tokens: 4 },
};

test('normal terminal response is complete', () => {
  const result = normalizeProviderCompletion(base);
  assert.equal(result.status, 'complete');
  assert.equal(result.error, null);
});

for (const [name, patch, expectedStatus, expectedCode] of [
  ['missing terminal', { terminalReceived: false }, 'partial', 'provider_incomplete'],
  ['responses incomplete', { finishReason: 'response.incomplete' }, 'partial', 'provider_incomplete'],
  ['chat length', { finishReason: 'length' }, 'partial', 'provider_incomplete'],
  ['anthropic max tokens', { finishReason: 'max_tokens' }, 'partial', 'provider_incomplete'],
  ['partial stream error', { hadError: true, error: { message: 'socket reset' } }, 'partial', 'provider_failed'],
  ['provider error object without flag', { error: { message: 'socket reset' } }, 'partial', 'provider_failed'],
  ['provider error type without flag', { errorType: 'socket_reset' }, 'partial', 'provider_failed'],
  ['empty normal response', { content: '' }, 'failed', 'provider_incomplete'],
  ['error payload', { content: '[Error: provider returned no content]' }, 'failed', 'provider_failed'],
]) {
  test(name, () => {
    const result = normalizeProviderCompletion({ ...base, ...patch });
    assert.equal(result.status, expectedStatus);
    assert.equal(result.error.code, expectedCode);
  });
}

test('requireCompleteProviderResult throws typed error for partial completion', () => {
  assert.throws(
    () => requireCompleteProviderResult({ ...base, finishReason: 'length' }),
    error => error instanceof ProviderCompletionError && error.code === 'provider_incomplete',
  );
});

test('a normalized incomplete result remains incomplete when required', () => {
  const normalized = normalizeProviderCompletion({ ...base, finishReason: 'length' });

  assert.equal(normalized.hadError, false);
  assert.equal(normalized.error.code, 'provider_incomplete');
  assert.throws(
    () => requireCompleteProviderResult(normalized),
    error => error instanceof ProviderCompletionError
      && error.code === 'provider_incomplete'
      && error.result?.error?.code === 'provider_incomplete',
  );
});

test('a raw failed envelope cannot use an incomplete label to become complete', () => {
  const result = normalizeProviderCompletion({
    ...base,
    status: 'failed',
    hadError: false,
    error: {
      code: 'provider_incomplete',
      message: 'upstream provider failed',
      retryable: true,
    },
  });

  assert.notEqual(result.status, 'complete');
  assert.equal(result.error.code, 'provider_failed');
  assert.throws(
    () => requireCompleteProviderResult({
      ...base,
      status: 'failed',
      hadError: false,
      error: { code: 'provider_incomplete', message: 'upstream provider failed' },
    }),
    error => error instanceof ProviderCompletionError
      && error.code === 'provider_failed',
  );
});

test('status-labeled envelopes are normalized and revalidated', () => {
  assert.throws(
    () => requireCompleteProviderResult({
      ...base,
      status: 'complete',
      content: '',
      terminalReceived: false,
    }),
    error => error instanceof ProviderCompletionError && error.code === 'provider_incomplete',
  );
});

test('null provider results fail through the typed completion boundary', () => {
  assert.throws(
    () => requireCompleteProviderResult(null),
    error => error instanceof ProviderCompletionError
      && error.code === 'provider_incomplete'
      && error.status === 'failed',
  );
});

test('wire aliases are bounded metadata and never replace canonical identity', () => {
  const result = normalizeProviderCompletion({
    ...base,
    observedModel: 'gpt-5.4-mini-20260701',
  });
  assert.equal(result.model, 'gpt-5.4-mini');
  assert.equal(result.observedModel, 'gpt-5.4-mini-20260701');
  assert.equal(assertProviderResultIdentity(result, 'openai', 'gpt-5.4-mini'), result);

  const oversized = normalizeProviderCompletion({
    ...base,
    observedModel: 'm'.repeat(513),
  });
  assert.equal(oversized.model, 'gpt-5.4-mini');
  assert.equal(oversized.observedModel, null);

  assert.throws(
    () => assertProviderResultIdentity({
      ...result,
      model: 'arbitrary-wire-model',
      observedModel: 'gpt-5.4-mini',
    }, 'openai', 'gpt-5.4-mini'),
    error => error.code === 'provider_model_mismatch' && error.retryable === false,
  );
});
