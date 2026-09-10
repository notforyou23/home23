import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const recipes = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'schema/recipes.json'), 'utf8'));

export const OWNED_PROFILE = 'owned-nomic-v1.5-onnx-fp32-mean-noprefix';
export const OWNED_RECIPE_ID = recipes.profiles[OWNED_PROFILE].recipeId;
export const LEGACY_PROFILE = 'legacy-ollama-nomic-unprefixed';
export const LEGACY_RECIPE_ID = recipes.profiles[LEGACY_PROFILE].recipeId;
export const EXPECTED_DIM = 768;
export const HF_ID = 'nomic-ai/nomic-embed-text-v1.5';

export const OWNED_ARTIFACTS = recipes.profiles[OWNED_PROFILE].fingerprint.artifact_digests;

/** Models this owned service will encode. Legacy Ollama aliases are rejected. */
export const OWNED_MODEL_IDS = new Set([OWNED_PROFILE, OWNED_RECIPE_ID]);

/** Identifiers callers may configure (legacy default stays valid; this service still rejects it). */
export const KNOWN_CALLER_MODEL_IDS = new Set([
  'nomic-embed-text',
  'nomic-embed-text:latest',
  LEGACY_PROFILE,
  LEGACY_RECIPE_ID,
  OWNED_PROFILE,
  OWNED_RECIPE_ID,
]);

export function isOwnedModelId(model) {
  return typeof model === 'string' && OWNED_MODEL_IDS.has(model.trim());
}

export function isKnownCallerModelId(model) {
  return typeof model === 'string' && KNOWN_CALLER_MODEL_IDS.has(model.trim());
}

export function looksLikeEncoderIdentity(model) {
  if (typeof model !== 'string') return false;
  const id = model.trim();
  return /^(nomic-embed|legacy-ollama|owned-nomic)/.test(id) || /^[0-9a-f]{64}$/.test(id);
}

export const ownedProfile = recipes.profiles[OWNED_PROFILE];
