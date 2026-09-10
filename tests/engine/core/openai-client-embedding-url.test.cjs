const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveEmbeddingBaseUrl } = require('../../../engine/src/core/openai-client.js');

test('embedding base URL is independent of the chat provider URL', () => {
  const previousChat = process.env.OPENAI_BASE_URL;
  const previousEmbed = process.env.EMBEDDING_BASE_URL;
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
  delete process.env.EMBEDDING_BASE_URL;
  assert.equal(resolveEmbeddingBaseUrl(), 'http://127.0.0.1:11434/v1');
  process.env.EMBEDDING_BASE_URL = 'http://127.0.0.1:28765/v1';
  assert.equal(resolveEmbeddingBaseUrl(), 'http://127.0.0.1:28765/v1');
  if (previousChat === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = previousChat;
  if (previousEmbed === undefined) delete process.env.EMBEDDING_BASE_URL;
  else process.env.EMBEDDING_BASE_URL = previousEmbed;
});
