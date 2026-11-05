import { SHARED_PROJECTION } from './recipe-id.mjs';
import { PROFILE_IDS } from './recipe-profiles.mjs';

export const ABSENCE_CODES = Object.freeze([
  'too_short',
  'timeout',
  'unavailable',
  'dimension_mismatch',
  'bad_artifact',
  'cancelled',
  'recipe_mismatch',
]);

export const PROTOCOLS = Object.freeze({
  ollamaNative: Object.freeze({
    method: 'POST',
    path: '/api/embeddings',
    requestKeys: Object.freeze(['model', 'prompt']),
    responseKeys: Object.freeze(['embedding']),
  }),
  openaiCompatible: Object.freeze({
    method: 'POST',
    path: '/v1/embeddings',
    requestKeys: Object.freeze(['model', 'input']),
    responseKeys: Object.freeze(['data']),
  }),
});

/** HTTP path for health is Stage 3 unknown. These fields are frozen regardless of path. */
export const HEALTH_REQUIRED_FIELDS = Object.freeze([
  'recipeId',
  'dimension',
  'artifactDigests',
  'warm',
]);

export const HEALTH_OPTIONAL_FIELDS = Object.freeze([
  'profileId',
  'protocols',
  'pid',
  'lastError',
]);

const PROFILE_SET = new Set(Object.values(PROFILE_IDS));

function isFiniteNumberArray(value, length) {
  return Array.isArray(value)
    && value.length === length
    && value.every((n) => typeof n === 'number' && Number.isFinite(n));
}

export function validateOllamaNativeRequest(body) {
  if (!body || typeof body !== 'object') return { ok: false, code: 'unavailable' };
  if (typeof body.model !== 'string' || !body.model.trim()) return { ok: false, code: 'recipe_mismatch' };
  if (typeof body.prompt !== 'string') return { ok: false, code: 'unavailable' };
  return { ok: true };
}

export function validateOllamaNativeResponse(body, expectedDim = SHARED_PROJECTION.expected_dim) {
  if (!body || typeof body !== 'object') return { ok: false, code: 'unavailable' };
  if (!isFiniteNumberArray(body.embedding, expectedDim)) return { ok: false, code: 'dimension_mismatch' };
  return { ok: true };
}

export function validateOpenAIRequest(body) {
  if (!body || typeof body !== 'object') return { ok: false, code: 'unavailable' };
  if (typeof body.model !== 'string' || !body.model.trim()) return { ok: false, code: 'recipe_mismatch' };
  const input = body.input;
  if (typeof input === 'string') return { ok: true };
  if (Array.isArray(input) && input.length > 0 && input.length <= 2048 && input.every((item) => typeof item === 'string')) {
    return { ok: true };
  }
  return { ok: false, code: 'unavailable' };
}

export function validateOpenAIResponse(body, requestCount, expectedDim = SHARED_PROJECTION.expected_dim) {
  if (!body || !Array.isArray(body.data)) return { ok: false, code: 'unavailable' };
  if (body.data.length !== requestCount) return { ok: false, code: 'unavailable' };
  const seen = new Set();
  for (const item of body.data) {
    if (!Number.isInteger(item?.index) || item.index < 0 || item.index >= requestCount || seen.has(item.index)) {
      return { ok: false, code: 'unavailable' };
    }
    if (!isFiniteNumberArray(item.embedding, expectedDim)) return { ok: false, code: 'dimension_mismatch' };
    seen.add(item.index);
  }
  return { ok: true };
}

/**
 * Ready means warm === true after real inference of expected dim.
 * /api/tags is never a valid health document.
 */
export function validateHealthDocument(body, { knownRecipeIds = [] } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'not-object' };
  if (Array.isArray(body.models)) return { ok: false, reason: 'api-tags-is-not-ready' };
  for (const field of HEALTH_REQUIRED_FIELDS) {
    if (!(field in body)) return { ok: false, reason: `missing-${field}` };
  }
  if (typeof body.recipeId !== 'string' || !/^[0-9a-f]{64}$/.test(body.recipeId)) {
    return { ok: false, reason: 'recipeId-not-sha256' };
  }
  if (knownRecipeIds.length && !knownRecipeIds.includes(body.recipeId)) {
    return { ok: false, reason: 'recipeId-unknown' };
  }
  if (body.dimension !== SHARED_PROJECTION.expected_dim) return { ok: false, reason: 'dimension' };
  if (!body.artifactDigests || typeof body.artifactDigests !== 'object' || Array.isArray(body.artifactDigests)) {
    return { ok: false, reason: 'artifactDigests' };
  }
  const digestValues = Object.values(body.artifactDigests);
  if (digestValues.length === 0 || digestValues.some((d) => typeof d !== 'string' || !/^[0-9a-f]{64}$/.test(d))) {
    return { ok: false, reason: 'artifactDigests' };
  }
  if (typeof body.warm !== 'boolean') return { ok: false, reason: 'warm' };
  if (body.warm !== true) return { ok: false, reason: 'not-warm' };
  if (body.profileId !== undefined && !PROFILE_SET.has(body.profileId)) {
    return { ok: false, reason: 'profileId' };
  }
  return { ok: true };
}

export function rejectUnknownModel(model, allowedAliases) {
  if (typeof model !== 'string' || !allowedAliases.has(model)) return { ok: false, code: 'recipe_mismatch' };
  return { ok: true };
}
