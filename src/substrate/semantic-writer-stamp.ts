/**
 * Harness-side wrapper for NEW-line semantic provenance.
 * History is never rewritten here; callers append only.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const contract = require('../../shared/semantic-encoder-contract.cjs') as {
  LEGACY_EMBEDDING_PROFILE: string;
  OWNED_EMBEDDING_PROFILE: string;
  LEGACY_EMBEDDING_RECIPE_ID: string;
  OWNED_EMBEDDING_RECIPE_ID: string;
  buildWriterSemanticStamp: (input?: {
    vector?: number[] | null;
    text?: string;
    absence?: string | null;
    requestedRecipe?: string | null;
  }) => WriterSemanticStamp;
};

export const LEGACY_EMBEDDING_PROFILE = contract.LEGACY_EMBEDDING_PROFILE;
export const OWNED_EMBEDDING_PROFILE = contract.OWNED_EMBEDDING_PROFILE;
export const LEGACY_EMBEDDING_RECIPE_ID = contract.LEGACY_EMBEDDING_RECIPE_ID;
export const OWNED_EMBEDDING_RECIPE_ID = contract.OWNED_EMBEDDING_RECIPE_ID;

export interface WriterSemanticStamp {
  semantic_recipe_id: string;
  semantic_encoder: string;
  semantic_vector?: number[];
  semantic_absence?: string;
}

export function buildWriterSemanticStamp(input?: {
  vector?: number[] | null;
  text?: string;
  absence?: string | null;
  requestedRecipe?: string | null;
}): WriterSemanticStamp {
  return contract.buildWriterSemanticStamp(input);
}
