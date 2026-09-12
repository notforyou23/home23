'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LEGACY_EMBEDDING_PROFILE,
  OWNED_EMBEDDING_PROFILE,
  LEGACY_EMBEDDING_RECIPE_ID,
  OWNED_EMBEDDING_RECIPE_ID,
  SEED_TRUNCATION_CHARS,
  MEMORY_TRUNCATION_CHARS,
  TYPED_ABSENCE,
  fingerprintRecipe,
  canonicalizeRecipeId,
  recipesCompatibleForCompare,
  recipesAllowAnnReuse,
  resolveAttentionPolicy,
  resolveWriterRecipe,
  resolveMemoryRecipe,
  recipeFromRequested,
  buildWriterSemanticStamp,
} = require('../../shared/semantic-encoder-contract.cjs');

test('recipe fingerprint includes truncation; Seed 1000 and Memory 2000 stay distinct', () => {
  assert.equal(SEED_TRUNCATION_CHARS, 1000);
  assert.equal(MEMORY_TRUNCATION_CHARS, 2000);
  const seed = fingerprintRecipe({
    family: 'nomic',
    source: 'ollama',
    artifact_digests: ['0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f'],
    precision: 'gguf-f16',
    pooling: 'provider',
    prefix_policy: 'none',
    truncation: { chars: SEED_TRUNCATION_CHARS },
    expected_dim: 768,
    projection_seed: 20260808,
    projection_dim: 16,
  });
  const memory = fingerprintRecipe({
    family: 'nomic',
    source: 'ollama',
    artifact_digests: ['0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f'],
    precision: 'gguf-f16',
    pooling: 'provider',
    prefix_policy: 'none',
    truncation: { chars: MEMORY_TRUNCATION_CHARS },
    expected_dim: 768,
    projection_seed: 20260808,
    projection_dim: 16,
  });
  assert.notEqual(seed, memory);
  assert.match(seed, /^[0-9a-f]{64}$/);
});

test('alias or equal dimension does not make recipes compatible', () => {
  assert.equal(recipesCompatibleForCompare('nomic-embed-text', 'nomic-embed-text-v1.5'), false);
  assert.equal(recipesCompatibleForCompare(LEGACY_EMBEDDING_PROFILE, OWNED_EMBEDDING_PROFILE), false);
  assert.equal(recipesCompatibleForCompare(undefined, undefined), true, 'unstamped vs unstamped keeps legacy live compare');
  assert.equal(recipesCompatibleForCompare(undefined, LEGACY_EMBEDDING_PROFILE), true);
  assert.equal(recipesCompatibleForCompare(undefined, OWNED_EMBEDDING_PROFILE), false);
  assert.equal(recipesCompatibleForCompare(OWNED_EMBEDDING_PROFILE, OWNED_EMBEDDING_PROFILE), true);
});

test('ANN reuse: owned or missing-on-index recipe does not reuse; legacy without recipe id keeps provider+model path', () => {
  assert.equal(recipesAllowAnnReuse({ queryRecipeId: OWNED_EMBEDDING_PROFILE, indexRecipeId: null }), false);
  assert.equal(recipesAllowAnnReuse({
    queryRecipeId: OWNED_EMBEDDING_PROFILE,
    indexRecipeId: OWNED_EMBEDDING_PROFILE,
  }), true);
  assert.equal(recipesAllowAnnReuse({ queryRecipeId: null, indexRecipeId: null }), true);
  assert.equal(recipesAllowAnnReuse({ queryRecipeId: LEGACY_EMBEDDING_PROFILE, indexRecipeId: null }), true);
  assert.equal(recipesAllowAnnReuse({ queryRecipeId: null, indexRecipeId: OWNED_EMBEDDING_PROFILE }), false);
  assert.equal(recipesAllowAnnReuse({
    queryRecipeId: 'other-recipe',
    indexRecipeId: null,
  }), false);
});

test('typed absence codes are the lead-specified set', () => {
  for (const code of [
    'too_short', 'timeout', 'unavailable', 'dimension_mismatch',
    'bad_artifact', 'cancelled', 'recipe_mismatch',
  ]) assert.equal(TYPED_ABSENCE.has(code), true);
});

test('missing recipe resolves to lived legacy attention, not owned mute', () => {
  const policy = resolveAttentionPolicy(undefined);
  assert.equal(policy.canSemanticGate, true);
  assert.equal(policy.matchFloor, 0.6);
});

test('profile name and frozen hash are aliases; service recipeId is the hash', () => {
  assert.equal(canonicalizeRecipeId(OWNED_EMBEDDING_RECIPE_ID), OWNED_EMBEDDING_PROFILE);
  assert.equal(canonicalizeRecipeId(LEGACY_EMBEDDING_RECIPE_ID), LEGACY_EMBEDDING_PROFILE);
  assert.equal(recipesCompatibleForCompare(OWNED_EMBEDDING_PROFILE, OWNED_EMBEDDING_RECIPE_ID), true);
  assert.equal(recipesCompatibleForCompare(LEGACY_EMBEDDING_PROFILE, LEGACY_EMBEDDING_RECIPE_ID), true);
  assert.equal(recipesCompatibleForCompare(LEGACY_EMBEDDING_RECIPE_ID, OWNED_EMBEDDING_RECIPE_ID), false);
  assert.equal(recipesCompatibleForCompare(LEGACY_EMBEDDING_RECIPE_ID, OWNED_EMBEDDING_PROFILE), false);
  const legacyHashPolicy = resolveAttentionPolicy(LEGACY_EMBEDDING_RECIPE_ID);
  assert.equal(legacyHashPolicy.profileId, LEGACY_EMBEDDING_PROFILE);
  assert.equal(legacyHashPolicy.matchFloor, 0.6);
  assert.equal(legacyHashPolicy.matchMargin, 0.12);
  assert.equal(legacyHashPolicy.canSemanticGate, true);
  assert.equal(resolveAttentionPolicy(OWNED_EMBEDDING_RECIPE_ID).canSemanticGate, false);
  assert.equal(resolveAttentionPolicy(OWNED_EMBEDDING_RECIPE_ID).matchFloor, null);
  assert.equal(recipesAllowAnnReuse({
    queryRecipeId: OWNED_EMBEDDING_RECIPE_ID,
    indexRecipeId: OWNED_EMBEDDING_PROFILE,
  }), true);
  assert.equal(recipesAllowAnnReuse({
    queryRecipeId: LEGACY_EMBEDDING_RECIPE_ID,
    indexRecipeId: null,
  }), true);
  assert.equal(recipesAllowAnnReuse({
    queryRecipeId: OWNED_EMBEDDING_RECIPE_ID,
    indexRecipeId: null,
  }), false);
  assert.equal(recipesAllowAnnReuse({
    queryRecipeId: LEGACY_EMBEDDING_PROFILE,
    indexRecipeId: OWNED_EMBEDDING_RECIPE_ID,
  }), false);
});

test('new writer stamps prefer recipe hash; absence does not invent a vector', () => {
  const vector = [0.1, 0.2];
  const stamped = buildWriterSemanticStamp({
    vector,
    text: 'recycle paper tomorrow morning',
    requestedRecipe: 'nomic-embed-text',
  });
  assert.equal(stamped.semantic_recipe_id, LEGACY_EMBEDDING_RECIPE_ID);
  assert.equal(stamped.semantic_encoder, LEGACY_EMBEDDING_PROFILE);
  assert.deepEqual(stamped.semantic_vector, vector);
  assert.equal(stamped.semantic_absence, undefined);

  const owned = buildWriterSemanticStamp({
    vector,
    text: 'recycle paper tomorrow morning',
    requestedRecipe: OWNED_EMBEDDING_PROFILE,
  });
  assert.equal(owned.semantic_recipe_id, OWNED_EMBEDDING_RECIPE_ID);
  assert.equal(owned.semantic_encoder, OWNED_EMBEDDING_PROFILE);

  const ownedHash = buildWriterSemanticStamp({
    vector,
    requestedRecipe: OWNED_EMBEDDING_RECIPE_ID,
  });
  assert.equal(ownedHash.semantic_recipe_id, OWNED_EMBEDDING_RECIPE_ID);

  const absent = buildWriterSemanticStamp({
    vector: null,
    text: 'recycle paper tomorrow morning',
    requestedRecipe: LEGACY_EMBEDDING_PROFILE,
  });
  assert.equal(absent.semantic_vector, undefined);
  assert.equal(absent.semantic_absence, 'unavailable');
  assert.equal(absent.semantic_recipe_id, LEGACY_EMBEDDING_RECIPE_ID);

  const short = buildWriterSemanticStamp({ vector: null, text: 'ok', requestedRecipe: LEGACY_EMBEDDING_PROFILE });
  assert.equal(short.semantic_absence, 'too_short');
  assert.equal(short.semantic_vector, undefined);
});

test('default writer recipe stays lived legacy; owned only when requested', () => {
  const priorRecipe = process.env.SEED_EMBED_RECIPE_ID;
  const priorModel = process.env.SEED_EMBED_MODEL;
  delete process.env.SEED_EMBED_RECIPE_ID;
  delete process.env.SEED_EMBED_MODEL;
  try {
    const recipe = resolveWriterRecipe();
    assert.equal(recipe.profile, LEGACY_EMBEDDING_PROFILE);
    assert.equal(recipe.hash, LEGACY_EMBEDDING_RECIPE_ID);
    assert.equal(resolveWriterRecipe('nomic-embed-text').profile, LEGACY_EMBEDDING_PROFILE);
    assert.equal(resolveWriterRecipe(OWNED_EMBEDDING_PROFILE).hash, OWNED_EMBEDDING_RECIPE_ID);
  } finally {
    if (priorRecipe === undefined) delete process.env.SEED_EMBED_RECIPE_ID;
    else process.env.SEED_EMBED_RECIPE_ID = priorRecipe;
    if (priorModel === undefined) delete process.env.SEED_EMBED_MODEL;
    else process.env.SEED_EMBED_MODEL = priorModel;
  }
});

test('unknown aliases do not acquire the frozen lived-legacy hash', () => {
  const prior = {
    SEED_EMBED_RECIPE_ID: process.env.SEED_EMBED_RECIPE_ID,
    SEED_EMBED_MODEL: process.env.SEED_EMBED_MODEL,
    EMBEDDING_RECIPE_ID: process.env.EMBEDDING_RECIPE_ID,
    EMBEDDING_MODEL: process.env.EMBEDDING_MODEL,
  };
  delete process.env.SEED_EMBED_RECIPE_ID;
  delete process.env.SEED_EMBED_MODEL;
  delete process.env.EMBEDDING_RECIPE_ID;
  delete process.env.EMBEDDING_MODEL;
  try {
    const unknown = recipeFromRequested('test-embedding');
    assert.equal(unknown.known, false);
    assert.equal(unknown.hash, null);
    assert.equal(unknown.profile, null);
    assert.notEqual(recipeFromRequested('nomic-embed-text-v1.5').hash, LEGACY_EMBEDDING_RECIPE_ID);
    assert.equal(recipeFromRequested('nomic-embed-text').known, true);
    assert.equal(recipeFromRequested('nomic-embed-text').hash, LEGACY_EMBEDDING_RECIPE_ID);
    assert.equal(recipeFromRequested('nomic-embed-text:latest').hash, LEGACY_EMBEDDING_RECIPE_ID);
    assert.equal(resolveWriterRecipe('test-embedding').known, false);
    assert.equal(resolveMemoryRecipe('test-embedding').known, false);
    const stamped = buildWriterSemanticStamp({
      vector: [0.1, 0.2],
      text: 'recycle paper tomorrow morning',
      requestedRecipe: 'test-embedding',
    });
    assert.deepEqual(stamped.semantic_vector, [0.1, 0.2]);
    assert.equal(stamped.semantic_recipe_id, undefined);
    assert.equal(stamped.semantic_encoder, undefined);
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('default memory recipe stays lived legacy; owned only when requested', () => {
  const priorRecipe = process.env.EMBEDDING_RECIPE_ID;
  const priorModel = process.env.EMBEDDING_MODEL;
  const priorSeedRecipe = process.env.SEED_EMBED_RECIPE_ID;
  delete process.env.EMBEDDING_RECIPE_ID;
  delete process.env.EMBEDDING_MODEL;
  process.env.SEED_EMBED_RECIPE_ID = OWNED_EMBEDDING_RECIPE_ID;
  try {
    const recipe = resolveMemoryRecipe();
    assert.equal(recipe.profile, LEGACY_EMBEDDING_PROFILE);
    assert.equal(recipe.hash, LEGACY_EMBEDDING_RECIPE_ID);
    assert.equal(resolveMemoryRecipe('nomic-embed-text').profile, LEGACY_EMBEDDING_PROFILE);
    assert.equal(resolveMemoryRecipe(OWNED_EMBEDDING_PROFILE).hash, OWNED_EMBEDDING_RECIPE_ID);
    assert.equal(resolveMemoryRecipe(OWNED_EMBEDDING_RECIPE_ID).hash, OWNED_EMBEDDING_RECIPE_ID);
  } finally {
    if (priorRecipe === undefined) delete process.env.EMBEDDING_RECIPE_ID;
    else process.env.EMBEDDING_RECIPE_ID = priorRecipe;
    if (priorModel === undefined) delete process.env.EMBEDDING_MODEL;
    else process.env.EMBEDDING_MODEL = priorModel;
    if (priorSeedRecipe === undefined) delete process.env.SEED_EMBED_RECIPE_ID;
    else process.env.SEED_EMBED_RECIPE_ID = priorSeedRecipe;
  }
});
