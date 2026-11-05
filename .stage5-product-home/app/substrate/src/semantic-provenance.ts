/**
 * EncodeEvent boundary: additive provenance parse-through + new-line stamps.
 * Never fabricates a vector. Unstamped history stays unknown.
 * metabolism.ts stays unchanged — callers admit recorded vectors as-is.
 */

import { createRequire } from 'node:module';
import type { SourceEvent } from './types.js';

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

/** Stamp a newly appended writer line. Does not rewrite history. */
export function buildWriterSemanticStamp(input?: {
  vector?: number[] | null;
  text?: string;
  absence?: string | null;
  requestedRecipe?: string | null;
}): WriterSemanticStamp {
  return contract.buildWriterSemanticStamp(input);
}

export const TYPED_ABSENCE = Object.freeze([
  'too_short',
  'timeout',
  'unavailable',
  'dimension_mismatch',
  'bad_artifact',
  'cancelled',
  'recipe_mismatch',
] as const);

export type SemanticAbsence = typeof TYPED_ABSENCE[number];

const ABSENCE_SET = new Set<string>(TYPED_ABSENCE);

function sanitizeRecipeId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const id = raw.trim();
  if (!id || id.length > 256 || id.includes('\0')) return undefined;
  return id;
}

function sanitizeAbsence(raw: unknown): SemanticAbsence | undefined {
  return typeof raw === 'string' && ABSENCE_SET.has(raw) ? raw as SemanticAbsence : undefined;
}

export interface SemanticProvenance {
  semanticRecipeId?: string;
  semanticEncoder?: string;
  semanticAbsence?: SemanticAbsence;
}

/** Parse optional stamps from a source JSONL object. Does not invent a vector. */
export function readSemanticProvenance(parsed: Record<string, unknown>): SemanticProvenance {
  const semanticRecipeId = sanitizeRecipeId(parsed['semantic_recipe_id']);
  const semanticEncoder = sanitizeRecipeId(parsed['semantic_encoder']);
  const semanticAbsence = sanitizeAbsence(parsed['semantic_absence']);
  return {
    ...(semanticRecipeId !== undefined ? { semanticRecipeId } : {}),
    ...(semanticEncoder !== undefined ? { semanticEncoder } : {}),
    ...(semanticAbsence !== undefined ? { semanticAbsence } : {}),
  };
}

/**
 * Admit a mapped source event for encodeEvent.
 * Keeps the recorded vector (replay). Never adds or rewrites one.
 */
export function admitSourceEvent<T extends SourceEvent>(event: T): T {
  return event;
}

export function withSemanticProvenance<T extends SourceEvent>(
  event: T,
  parsed: Record<string, unknown>,
): T {
  return { ...event, ...readSemanticProvenance(parsed) };
}
