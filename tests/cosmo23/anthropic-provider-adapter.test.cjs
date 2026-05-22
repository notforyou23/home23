const assert = require('node:assert/strict');
const test = require('node:test');

const { AnthropicAdapter } = require('../../cosmo23/server/providers/adapters/anthropic.js');

function createStubbedAdapter(providerId = 'anthropic') {
  const adapter = new AnthropicAdapter({
    providerId,
    authToken: providerId === 'anthropic' ? 'sk-ant-oauth-test-token' : undefined,
    apiKey: providerId === 'anthropic' ? undefined : 'test-key',
    seedModels: ['claude-sonnet-4-7'],
    useOAuthService: false
  });
  adapter._isOAuth = providerId === 'anthropic';
  return adapter;
}

test('Anthropic provider adapter health check falls back to available OAuth wire model', async () => {
  const adapter = createStubbedAdapter();
  let capturedRequest = null;

  adapter._client = {
    beta: {
      models: {
        list: async () => ({
          data: [
            { id: 'claude-sonnet-4-6' },
            { id: 'claude-haiku-4-5' }
          ]
        })
      }
    },
    messages: {
      create: async request => {
        capturedRequest = request;
        return {
          id: 'msg_test',
          model: request.model,
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 }
        };
      }
    }
  };

  const health = await adapter.healthCheck();

  assert.equal(health.healthy, true);
  assert.equal(capturedRequest.model, 'claude-sonnet-4-6');
});

test('Anthropic-compatible non-Anthropic adapters do not rewrite model ids', async () => {
  const adapter = createStubbedAdapter('minimax');
  let capturedRequest = null;

  adapter._client = {
    beta: {
      models: {
        list: async () => ({
          data: [{ id: 'MiniMax-M2.7' }]
        })
      }
    },
    messages: {
      create: async request => {
        capturedRequest = request;
        return {
          id: 'msg_test',
          model: request.model,
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 }
        };
      }
    }
  };

  await adapter.createMessage({
    model: 'MiniMax-M2.7',
    messages: [{ role: 'user', content: 'Hi' }],
    maxTokens: 16
  });

  assert.equal(capturedRequest.model, 'MiniMax-M2.7');
});
