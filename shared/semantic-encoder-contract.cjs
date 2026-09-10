'use strict';

const { createHash } = require('node:crypto');

/** Lived Home23 Ollama path. Existing homes keep this attention policy. */
const LEGACY_EMBEDDING_PROFILE = 'legacy-ollama-nomic-unprefixed';
/** Candidate owned recipe. Distinct space; matchFloor stays null. */
const OWNED_EMBEDDING_PROFILE = 'owned-nomic-v1.5-onnx-fp32-mean-noprefix';

const SEED_TRUNCATION_CHARS = 1000;
const MEMORY_TRUNCATION_CHARS = 2000;

const TYPED_ABSENCE = Object.freeze(new Set([
  'too_short',
  'timeout',
  'unavailable',
  'dimension_mismatch',
  'bad_artifact',
  'cancelled',
  'recipe_mismatch',
]));

const POLICIES = Object.freeze({
  [LEGACY_EMBEDDING_PROFILE]: Object.freeze({
    profileId: LEGACY_EMBEDDING_PROFILE,
    matchFloor: 0.6,
    matchMargin: 0.12,
    minMatchableAlnum: 20,
    canSemanticGate: true,
  }),
  [OWNED_EMBEDDING_PROFILE]: Object.freeze({
    profileId: OWNED_EMBEDDING_PROFILE,
    matchFloor: null,
    matchMargin: null,
    minMatchableAlnum: 20,
    canSemanticGate: false,
  }),
});

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function fingerprintRecipe(spec) {
  const payload = canonicalize({
    family: spec.family,
    source: spec.source,
    artifact_digests: spec.artifact_digests,
    precision: spec.precision,
    pooling: spec.pooling,
    prefix_policy: spec.prefix_policy,
    truncation: spec.truncation,
    expected_dim: spec.expected_dim,
    projection_seed: spec.projection_seed,
    projection_dim: spec.projection_dim,
  });
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

function isOwnedRecipe(recipeId) {
  return recipeId === OWNED_EMBEDDING_PROFILE;
}

function resolveAttentionPolicy(recipeId) {
  if (recipeId === OWNED_EMBEDDING_PROFILE) return POLICIES[OWNED_EMBEDDING_PROFILE];
  if (recipeId && recipeId !== LEGACY_EMBEDDING_PROFILE) {
    return Object.freeze({
      profileId: recipeId,
      matchFloor: null,
      matchMargin: null,
      minMatchableAlnum: 20,
      canSemanticGate: false,
    });
  }
  // Missing stamps do not mute existing homes — lived legacy policy.
  return POLICIES[LEGACY_EMBEDDING_PROFILE];
}

function recipesCompatibleForCompare(left, right) {
  const a = left || null;
  const b = right || null;
  if (a === b) return true;
  if (isOwnedRecipe(a) || isOwnedRecipe(b)) return false;
  if (a && b) return a === b;
  const present = a || b;
  return !present || present === LEGACY_EMBEDDING_PROFILE;
}

function recipesAllowAnnReuse({ queryRecipeId = null, indexRecipeId = null } = {}) {
  const query = queryRecipeId || null;
  const index = indexRecipeId || null;
  if (isOwnedRecipe(query) || (query && query !== LEGACY_EMBEDDING_PROFILE)) {
    return index === query;
  }
  if (isOwnedRecipe(index)) return false;
  return !index || index === LEGACY_EMBEDDING_PROFILE;
}

function sanitizeAbsenceReason(raw) {
  return typeof raw === 'string' && TYPED_ABSENCE.has(raw) ? raw : null;
}

function sanitizeRecipeId(raw) {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  if (!id || id.length > 256 || id.includes('\0')) return null;
  return id;
}

module.exports = {
  LEGACY_EMBEDDING_PROFILE,
  OWNED_EMBEDDING_PROFILE,
  SEED_TRUNCATION_CHARS,
  MEMORY_TRUNCATION_CHARS,
  TYPED_ABSENCE,
  fingerprintRecipe,
  isOwnedRecipe,
  resolveAttentionPolicy,
  recipesCompatibleForCompare,
  recipesAllowAnnReuse,
  sanitizeAbsenceReason,
  sanitizeRecipeId,
};
