const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveSeedEmbeddingEnv } = require('../../shared/seed-embedding-config.cjs');

test('explicit Seed contact endpoint is shared without provider credentials', () => {
  assert.deepEqual(resolveSeedEmbeddingEnv({}), {});
  assert.deepEqual(resolveSeedEmbeddingEnv({ providers: { openai: { apiKey: 'never-into-seed' } },
    substrate: { embedding: { endpoint: 'http://127.0.0.1:43219/api/embeddings', model: 'nomic-embed-text' } } }), {
    SEED_EMBED_ENDPOINT: 'http://127.0.0.1:43219/api/embeddings', SEED_EMBED_MODEL: 'nomic-embed-text',
  });
  for (const embedding of [
    { endpoint: 'http://user:secret@127.0.0.1/api/embeddings' },
    { endpoint: 'http://127.0.0.1/api/embeddings?key=secret' },
    { endpoint: 'file:///private/file' },
    { endpoint: 'http://127.0.0.1/api/embeddings', apiKey: 'secret' },
  ]) assert.throws(() => resolveSeedEmbeddingEnv({ substrate: { embedding } }));
});
