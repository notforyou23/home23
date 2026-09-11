const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveSeedEmbeddingEnv } = require('../../shared/seed-embedding-config.cjs');

test('explicit Seed contact endpoint is shared without provider credentials', () => {
  assert.deepEqual(resolveSeedEmbeddingEnv({}), {});
  assert.deepEqual(resolveSeedEmbeddingEnv({ providers: { openai: { apiKey: 'never-into-seed' } },
    substrate: { embedding: { endpoint: 'http://127.0.0.1:43219/api/embeddings', model: 'nomic-embed-text' } } }), {
    SEED_EMBED_ENDPOINT: 'http://127.0.0.1:43219/api/embeddings',
    SEED_EMBED_MODEL: 'nomic-embed-text',
    SEED_EMBED_RECIPE_ID: '5128b29c886857aeb89b148d2d9f2edf2c20f63de15a764342c2a18da640f71a',
  });
  for (const embedding of [
    { endpoint: 'http://user:secret@127.0.0.1/api/embeddings' },
    { endpoint: 'http://127.0.0.1/api/embeddings?key=secret' },
    { endpoint: 'file:///private/file' },
    { endpoint: 'http://127.0.0.1/api/embeddings', apiKey: 'secret' },
  ]) assert.throws(() => resolveSeedEmbeddingEnv({ substrate: { embedding } }));
});

test('Seed model may be legacy alias, owned profile name, or frozen hash; unknown nomic is rejected', () => {
  const endpoint = 'http://127.0.0.1:28765/api/embeddings';
  const ownedName = resolveSeedEmbeddingEnv({
    substrate: { embedding: { endpoint, model: 'owned-nomic-v1.5-onnx-fp32-mean-noprefix' } },
  });
  assert.equal(ownedName.SEED_EMBED_MODEL, 'owned-nomic-v1.5-onnx-fp32-mean-noprefix');
  assert.equal(ownedName.SEED_EMBED_RECIPE_ID, '12e9f736ef4a7462e88cc228236d9e098d9dff7c30d178c7f9a3cb243d65efd9');
  const ownedHash = resolveSeedEmbeddingEnv({
    substrate: { embedding: { endpoint, model: '12e9f736ef4a7462e88cc228236d9e098d9dff7c30d178c7f9a3cb243d65efd9' } },
  });
  assert.equal(ownedHash.SEED_EMBED_MODEL, '12e9f736ef4a7462e88cc228236d9e098d9dff7c30d178c7f9a3cb243d65efd9');
  assert.equal(ownedHash.SEED_EMBED_RECIPE_ID, '12e9f736ef4a7462e88cc228236d9e098d9dff7c30d178c7f9a3cb243d65efd9');
  const ownedFromField = resolveSeedEmbeddingEnv({
    substrate: { embedding: { endpoint, model: 'owned-nomic-v1.5-onnx-fp32-mean-noprefix', recipeId: '12e9f736ef4a7462e88cc228236d9e098d9dff7c30d178c7f9a3cb243d65efd9' } },
  });
  assert.equal(ownedFromField.SEED_EMBED_RECIPE_ID, '12e9f736ef4a7462e88cc228236d9e098d9dff7c30d178c7f9a3cb243d65efd9');
  assert.throws(() => resolveSeedEmbeddingEnv({
    substrate: { embedding: { endpoint, model: 'nomic-embed-text-v1.5' } },
  }));
  const unknownLocal = resolveSeedEmbeddingEnv({
    substrate: { embedding: { endpoint, model: 'custom-local-embed' } },
  });
  assert.equal(unknownLocal.SEED_EMBED_MODEL, 'custom-local-embed');
  assert.equal(unknownLocal.SEED_EMBED_RECIPE_ID, undefined);
});
