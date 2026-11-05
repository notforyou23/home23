const assert = require('node:assert/strict');
const test = require('node:test');

const { GPT5Client } = require('../../../engine/src/core/gpt5-client');

test('GPT5Client complete delegates to the normal generation path', async () => {
  const client = new GPT5Client({ info() {}, warn() {}, error() {}, debug() {} });
  let captured = null;
  client.generateWithRetry = async (options, maxRetries) => {
    captured = { options, maxRetries };
    return { content: '{"ok":true}' };
  };

  const result = await client.complete({
    model: 'gpt-5.5',
    messages: [{ role: 'user', content: 'diagnose' }],
    max_tokens: 250,
    temperature: 0.1,
  });

  assert.equal(result.content, '{"ok":true}');
  assert.equal(captured.maxRetries, 1);
  assert.equal(captured.options.maxTokens, 250);
  assert.equal(captured.options.max_tokens, undefined);
});
