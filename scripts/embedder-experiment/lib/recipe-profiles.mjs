import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recipeIdFromFingerprint, SHARED_PROJECTION } from './recipe-id.mjs';

const pin = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../results/recipe-pin.json'), 'utf8'));

/** Home23 writer truncation — part of the fingerprint. Do not silently unify Seed vs Memory. */
export const HOME23_TRUNCATION = Object.freeze({
  memory: Object.freeze({
    maxChars: 2000,
    maxTokensIfTokenizer: 512,
    minLength: 0,
  }),
  seed: Object.freeze({
    maxChars: 1000,
    minLength: 8,
  }),
});

export const PROFILE_IDS = Object.freeze({
  legacy: 'legacy-ollama-nomic-unprefixed',
  owned: 'owned-nomic-v1.5-onnx-fp32-mean-noprefix',
});

/**
 * Human profile ids Lead froze. Distinct. Equal dimension does not merge them.
 * Process name home23-embedder is documented only; Host is not wired here.
 */
export function legacyFingerprint() {
  return {
    artifact_digests: {
      'ollama/nomic-embed-text:latest': pin.baseline.digest,
    },
    expected_dim: SHARED_PROJECTION.expected_dim,
    family: 'nomic-embed-text',
    normalization: 'none-at-provider',
    pooling: 'ollama-gguf-native',
    precision: 'gguf-f16',
    prefix_policy: 'none',
    projection_dim: SHARED_PROJECTION.projection_dim,
    projection_seed: SHARED_PROJECTION.projection_seed,
    source: 'ollama:nomic-embed-text',
    truncation: HOME23_TRUNCATION,
  };
}

export function ownedFingerprint() {
  const digests = {};
  for (const file of pin.candidate.artifacts) digests[file.path] = file.sha256;
  return {
    artifact_digests: digests,
    expected_dim: SHARED_PROJECTION.expected_dim,
    family: 'nomic-embed-text-v1.5',
    normalization: 'none-at-provider',
    pooling: 'mean',
    precision: 'fp32',
    prefix_policy: 'none',
    projection_dim: SHARED_PROJECTION.projection_dim,
    projection_seed: SHARED_PROJECTION.projection_seed,
    source: pin.candidate.source,
    truncation: HOME23_TRUNCATION,
  };
}

export function computeRecipeIds() {
  return {
    [PROFILE_IDS.legacy]: recipeIdFromFingerprint(legacyFingerprint()),
    [PROFILE_IDS.owned]: recipeIdFromFingerprint(ownedFingerprint()),
  };
}

export function profiles() {
  const ids = computeRecipeIds();
  return {
    [PROFILE_IDS.legacy]: {
      profileId: PROFILE_IDS.legacy,
      recipeId: ids[PROFILE_IDS.legacy],
      role: 'legacy-active-homes',
      compatibleWithOwned: false,
      attention: { matchFloor: 0.6, matchMargin: 0.12, minMatchableAlnum: 20 },
      fingerprint: legacyFingerprint(),
    },
    [PROFILE_IDS.owned]: {
      profileId: PROFILE_IDS.owned,
      recipeId: ids[PROFILE_IDS.owned],
      role: 'new-distinct-recipe',
      compatibleWithOwned: true,
      attention: { matchFloor: null, matchMargin: null, minMatchableAlnum: 20 },
      fingerprint: ownedFingerprint(),
    },
  };
}
