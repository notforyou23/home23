'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LEGACY_EMBEDDING_PROFILE,
  OWNED_EMBEDDING_PROFILE,
  SEED_TRUNCATION_CHARS,
  MEMORY_TRUNCATION_CHARS,
  TYPED_ABSENCE,
  fingerprintRecipe,
  recipesCompatibleForCompare,
  recipesAllowAnnReuse,
  resolveAttentionPolicy,
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
