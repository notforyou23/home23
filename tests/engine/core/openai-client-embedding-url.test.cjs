const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveEmbeddingBaseUrl } = require('../../../engine/src/core/openai-client.js');

test('embedding base URL is independent of the chat provider URL', () => {
  const previousChat = process.env.OPENAI_BASE_URL;
  const previousEmbed = process.env.EMBEDDING_BASE_URL;
  const previousProvider = process.env.EMBEDDING_PROVIDER;
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
  delete process.env.EMBEDDING_BASE_URL;
  delete process.env.EMBEDDING_PROVIDER;
  assert.equal(resolveEmbeddingBaseUrl(), 'http://127.0.0.1:11434/v1');
  process.env.EMBEDDING_BASE_URL = 'http://127.0.0.1:28765/v1';
  assert.equal(resolveEmbeddingBaseUrl(), 'http://127.0.0.1:28765/v1');
  if (previousChat === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = previousChat;
  if (previousEmbed === undefined) delete process.env.EMBEDDING_BASE_URL;
  else process.env.EMBEDDING_BASE_URL = previousEmbed;
  if (previousProvider === undefined) delete process.env.EMBEDDING_PROVIDER;
  else process.env.EMBEDDING_PROVIDER = previousProvider;
});

test('owned encoder does not fall back to the Ollama default URL', () => {
  const previousEmbed = process.env.EMBEDDING_BASE_URL;
  const previousProvider = process.env.EMBEDDING_PROVIDER;
  delete process.env.EMBEDDING_BASE_URL;
  process.env.EMBEDDING_PROVIDER = 'home23-owned';
  assert.throws(
    () => resolveEmbeddingBaseUrl(),
    (error) => /owned encoder/i.test(error.message) && !String(error.message).includes('11434'),
  );
  process.env.EMBEDDING_BASE_URL = 'http://127.0.0.1:21495/v1';
  assert.equal(resolveEmbeddingBaseUrl(), 'http://127.0.0.1:21495/v1');
  if (previousEmbed === undefined) delete process.env.EMBEDDING_BASE_URL;
  else process.env.EMBEDDING_BASE_URL = previousEmbed;
  if (previousProvider === undefined) delete process.env.EMBEDDING_PROVIDER;
  else process.env.EMBEDDING_PROVIDER = previousProvider;
});
