/**
 * Shared semantic matcher — the retina as the harness's attention gate.
 *
 * v2 cut 3 (triggers): keyword-substring tripwires were the file paradigm's
 * idea of attention — hand-configured lexical cues that fire on "watch" in
 * "watch the sunset". The cell paradigm gates on MEANING: embed the turn
 * and the candidate's anchor text in the embedder's native space, admit on
 * the calibrated floor (0.60 ≈ genuine pull; calibrated 2026-08-08 against
 * real conversation turns — see seed-context.ts for the full record).
 *
 * One module, one cache, one cosine — the expression organ, the triggered
 * surfaces, and the trigger index all share it, so a turn's text embeds
 * once per process no matter how many gates consult it.
 *
 * Degraded-honest: embedder down, text too short, null-cal, or dimension
 * mismatch → null, and callers fall back to their file-era mechanism
 * (substring match). The organ owns the gate only while it is actually alive.
 */

import { embedTextRawSync } from './embed-at-contact.js';
import {
  LEGACY_EMBEDDING_PROFILE,
  resolveAttentionPolicy,
  type AttentionPolicy,
} from './encoder-attention-policy.js';

/** Calibrated floor for turn↔anchor genuine pull (native space). Lived legacy. */
export const SEMANTIC_MATCH_FLOOR = 0.6;
/** Turns with less topical content than this cannot be matched on meaning. */
export const MIN_MATCHABLE_ALNUM = 20;
const CACHE_MAX = 800;

const cache = new Map<string, number[]>();

export interface SemanticMatchOptions {
  recipeId?: string | null;
}

function cacheKey(recipeId: string, text: string): string {
  return `${recipeId}\0${text}`;
}

function activeRecipeId(recipeId?: string | null): string {
  return recipeId || process.env['SEED_EMBED_RECIPE_ID'] || LEGACY_EMBEDDING_PROFILE;
}

export function resetSemanticMatchCache(): void {
  cache.clear();
}

/** Embed with a recipe-keyed process cache; null is degraded-honest (never cached). */
export function cachedEmbedRaw(
  text: string,
  embed: (t: string) => number[] | null = embedTextRawSync,
  recipeId?: string | null,
): number[] | null {
  const recipe = activeRecipeId(recipeId);
  const key = cacheKey(recipe, text);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const vec = embed(text);
  if (vec !== null) {
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, vec);
  }
  return vec;
}

/** Cosine in one space. Unequal lengths are rejected, not truncated. */
export function cosine(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export function alnumLength(text: string): number {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '').length;
}

export function resolveMatchPolicy(recipeId?: string | null): AttentionPolicy {
  return resolveAttentionPolicy(recipeId ?? process.env['SEED_EMBED_RECIPE_ID']);
}

/**
 * Score a turn against an anchor's meaning, or null when meaning-matching
 * is unavailable (short turn, embedder down, null-cal, dim mismatch) —
 * callers must treat null as "use your fallback", never as "no match".
 */
export function semanticMatchScore(
  turnText: string,
  anchorText: string,
  embed?: (t: string) => number[] | null,
  options?: SemanticMatchOptions,
): number | null {
  const recipeId = options?.recipeId;
  const policy = resolveMatchPolicy(recipeId);
  if (!policy.canSemanticGate) return null;
  if (alnumLength(turnText) < policy.minMatchableAlnum) return null;
  const turnVec = cachedEmbedRaw(turnText, embed, recipeId);
  if (turnVec === null) return null;
  const anchorVec = cachedEmbedRaw(anchorText, embed, recipeId);
  if (anchorVec === null) return null;
  return cosine(turnVec, anchorVec);
}
