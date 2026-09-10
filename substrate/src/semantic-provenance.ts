/**
 * EncodeEvent boundary: additive provenance parse-through.
 * Never fabricates a vector. Unstamped history stays unknown.
 * metabolism.ts stays unchanged — callers admit recorded vectors as-is.
 */

import type { SourceEvent } from './types.js';

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
