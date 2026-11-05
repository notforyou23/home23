'use strict';

const { createHash } = require('node:crypto');

/** Lived Home23 Ollama path. Existing homes keep this attention policy. */
const LEGACY_EMBEDDING_PROFILE = 'legacy-ollama-nomic-unprefixed';
/** Candidate owned recipe. Distinct space; matchFloor stays null. */
const OWNED_EMBEDDING_PROFILE = 'owned-nomic-v1.5-onnx-fp32-mean-noprefix';
/** Stage 3 health.recipeId values (Encoder seams hashes). */
const LEGACY_EMBEDDING_RECIPE_ID = '5128b29c886857aeb89b148d2d9f2edf2c20f63de15a764342c2a18da640f71a';
const OWNED_EMBEDDING_RECIPE_ID = '12e9f736ef4a7462e88cc228236d9e098d9dff7c30d178c7f9a3cb243d65efd9';

const RECIPE_CANON = Object.freeze({
  [LEGACY_EMBEDDING_PROFILE]: LEGACY_EMBEDDING_PROFILE,
  [LEGACY_EMBEDDING_RECIPE_ID]: LEGACY_EMBEDDING_PROFILE,
  [OWNED_EMBEDDING_PROFILE]: OWNED_EMBEDDING_PROFILE,
  [OWNED_EMBEDDING_RECIPE_ID]: OWNED_EMBEDDING_PROFILE,
});

/** Map a profile name or frozen hash to the profile name. Unknown ids stay as-is. */
function canonicalizeRecipeId(recipeId) {
  if (typeof recipeId !== 'string' || !recipeId.trim()) return null;
  return RECIPE_CANON[recipeId.trim()] || recipeId.trim();
}

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
  return canonicalizeRecipeId(recipeId) === OWNED_EMBEDDING_PROFILE;
}

function resolveAttentionPolicy(recipeId) {
  const canon = canonicalizeRecipeId(recipeId);
  if (canon === OWNED_EMBEDDING_PROFILE) return POLICIES[OWNED_EMBEDDING_PROFILE];
  if (canon && canon !== LEGACY_EMBEDDING_PROFILE) {
    return Object.freeze({
      profileId: canon,
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
  const a = canonicalizeRecipeId(left);
  const b = canonicalizeRecipeId(right);
  if (a === b) return true;
  if (isOwnedRecipe(a) || isOwnedRecipe(b)) return false;
  if (a && b) return a === b;
  const present = a || b;
  return !present || present === LEGACY_EMBEDDING_PROFILE;
}

function recipesAllowAnnReuse({ queryRecipeId = null, indexRecipeId = null } = {}) {
  const query = canonicalizeRecipeId(queryRecipeId);
  const index = canonicalizeRecipeId(indexRecipeId);
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

/** Harness writers skip embed below this; absence is `too_short`. */
const WRITER_MIN_TEXT_LENGTH = 8;

const LIVED_LEGACY_ALIASES = new Set([
  LEGACY_EMBEDDING_PROFILE,
  LEGACY_EMBEDDING_RECIPE_ID,
  'nomic-embed-text',
  'nomic-embed-text:latest',
]);

const UNKNOWN_RECIPE = Object.freeze({
  profile: null,
  hash: null,
  known: false,
});

/**
 * Active Seed/contact recipe for NEW writer lines.
 * Default product remains lived legacy (nomic-embed-text / Ollama).
 * Unknown aliases stay unknown — they must not acquire the frozen legacy hash.
 */
function recipeFromRequested(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return UNKNOWN_RECIPE;
  const id = raw.trim();
  if (canonicalizeRecipeId(id) === OWNED_EMBEDDING_PROFILE) {
    return Object.freeze({
      profile: OWNED_EMBEDDING_PROFILE,
      hash: OWNED_EMBEDDING_RECIPE_ID,
      known: true,
    });
  }
  if (LIVED_LEGACY_ALIASES.has(id) || canonicalizeRecipeId(id) === LEGACY_EMBEDDING_PROFILE) {
    return Object.freeze({
      profile: LEGACY_EMBEDDING_PROFILE,
      hash: LEGACY_EMBEDDING_RECIPE_ID,
      known: true,
    });
  }
  return UNKNOWN_RECIPE;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function resolveWriterRecipe(requested) {
  const raw = firstNonEmpty(
    requested,
    process.env.SEED_EMBED_RECIPE_ID,
    process.env.SEED_EMBED_MODEL,
  ) || 'nomic-embed-text';
  return recipeFromRequested(raw);
}

/** Active brain/retrieval recipe for NEW NetworkMemory nodes. Prefer hash on write.
 * Default remains lived legacy. Owned only when the home explicitly requests it. */
function resolveMemoryRecipe(requested) {
  const raw = firstNonEmpty(
    requested,
    process.env.EMBEDDING_RECIPE_ID,
    process.env.EMBEDDING_MODEL,
  ) || 'nomic-embed-text';
  return recipeFromRequested(raw);
}

function inferWriterAbsence(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  return trimmed.length < WRITER_MIN_TEXT_LENGTH ? 'too_short' : 'unavailable';
}

/**
 * Additive provenance for a newly appended line.
 * Prefer hash on write; readers already accept name or hash.
 * Never invents a vector. Absence is stamped only when no vector is present.
 */
function buildWriterSemanticStamp({
  vector = null,
  text = '',
  absence = null,
  requestedRecipe = null,
} = {}) {
  const recipe = resolveWriterRecipe(requestedRecipe);
  if (!recipe.known) {
    if (Array.isArray(vector) && vector.length > 0) return { semantic_vector: vector };
    return { semantic_absence: sanitizeAbsenceReason(absence) || inferWriterAbsence(text) };
  }
  const fields = {
    semantic_recipe_id: recipe.hash,
    semantic_encoder: recipe.profile,
  };
  if (Array.isArray(vector) && vector.length > 0) {
    return { semantic_vector: vector, ...fields };
  }
  return {
    ...fields,
    semantic_absence: sanitizeAbsenceReason(absence) || inferWriterAbsence(text),
  };
}

module.exports = {
  LEGACY_EMBEDDING_PROFILE,
  OWNED_EMBEDDING_PROFILE,
  LEGACY_EMBEDDING_RECIPE_ID,
  OWNED_EMBEDDING_RECIPE_ID,
  SEED_TRUNCATION_CHARS,
  MEMORY_TRUNCATION_CHARS,
  WRITER_MIN_TEXT_LENGTH,
  TYPED_ABSENCE,
  fingerprintRecipe,
  canonicalizeRecipeId,
  isOwnedRecipe,
  resolveAttentionPolicy,
  recipesCompatibleForCompare,
  recipesAllowAnnReuse,
  sanitizeAbsenceReason,
  sanitizeRecipeId,
  resolveWriterRecipe,
  resolveMemoryRecipe,
  recipeFromRequested,
  inferWriterAbsence,
  buildWriterSemanticStamp,
};
