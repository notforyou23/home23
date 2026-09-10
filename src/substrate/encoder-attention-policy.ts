/**
 * Shared attention policy for Seed/contact consumers.
 * Lived legacy keeps 0.60 / 0.12 / 20. Owned recipe stays null-cal.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const contract = require('../../shared/semantic-encoder-contract.cjs') as {
  LEGACY_EMBEDDING_PROFILE: string;
  OWNED_EMBEDDING_PROFILE: string;
  resolveAttentionPolicy: (recipeId?: string | null) => AttentionPolicy;
};

export const LEGACY_EMBEDDING_PROFILE = contract.LEGACY_EMBEDDING_PROFILE;
export const OWNED_EMBEDDING_PROFILE = contract.OWNED_EMBEDDING_PROFILE;

export interface AttentionPolicy {
  profileId: string;
  matchFloor: number | null;
  matchMargin: number | null;
  minMatchableAlnum: number;
  canSemanticGate: boolean;
}

export function resolveAttentionPolicy(recipeId?: string | null): AttentionPolicy {
  return contract.resolveAttentionPolicy(recipeId);
}

/** Single-pair admit (context-assembly / trigger-index). Margin applies to pools. */
export function admitsPairScore(score: number, policy: AttentionPolicy): boolean {
  if (!policy.canSemanticGate || policy.matchFloor === null) return false;
  return score >= policy.matchFloor;
}

/** Seed-context pool admit: floor AND clearance above the turn's median. */
export function admitsPoolScore(score: number, median: number, policy: AttentionPolicy): boolean {
  if (!policy.canSemanticGate || policy.matchFloor === null || policy.matchMargin === null) return false;
  return score >= policy.matchFloor && score - median >= policy.matchMargin;
}
