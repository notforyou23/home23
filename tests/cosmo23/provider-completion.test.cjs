const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ProviderCompletionError,
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
