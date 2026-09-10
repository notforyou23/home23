import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.mjs';

/** Fingerprint keys required by Lead contracts §2. Extra keys are rejected. */
export const FINGERPRINT_KEYS = Object.freeze([
  'artifact_digests',
  'expected_dim',
  'family',
  'normalization',
  'pooling',
  'precision',
  'prefix_policy',
  'projection_dim',
  'projection_seed',
  'source',
  'truncation',
]);

export const SHARED_PROJECTION = Object.freeze({
  expected_dim: 768,
  projection_seed: 20260808,
  projection_dim: 16,
  metric: 'cosine',
});

export function fingerprintBody(input) {
  const keys = Object.keys(input).sort();
  const unexpected = keys.filter((key) => !FINGERPRINT_KEYS.includes(key));
  if (unexpected.length) throw new Error(`Unexpected fingerprint keys: ${unexpected.join(', ')}`);
  const missing = FINGERPRINT_KEYS.filter((key) => !(key in input));
  if (missing.length) throw new Error(`Missing fingerprint keys: ${missing.join(', ')}`);
  if (input.expected_dim !== SHARED_PROJECTION.expected_dim) {
    throw new Error('expected_dim must be 768 until a separate design change');
  }
  if (input.projection_seed !== SHARED_PROJECTION.projection_seed) {
    throw new Error('projection_seed must remain 20260808');
  }
  if (input.projection_dim !== SHARED_PROJECTION.projection_dim) {
    throw new Error('projection_dim must remain 16');
  }
  return canonicalizeFingerprint(input);
}

function canonicalizeFingerprint(input) {
  return {
    artifact_digests: Object.fromEntries(
      Object.entries(input.artifact_digests).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    expected_dim: input.expected_dim,
    family: input.family,
    normalization: input.normalization,
    pooling: input.pooling,
    precision: input.precision,
    prefix_policy: input.prefix_policy,
    projection_dim: input.projection_dim,
    projection_seed: input.projection_seed,
    source: input.source,
    truncation: input.truncation,
  };
}

export function recipeIdFromFingerprint(input) {
  const body = fingerprintBody(input);
  return createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
}
