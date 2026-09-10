/**
 * Stage 2 Memory guards: dimension reject, recipe-keyed cache, null-cal.
 * Public synthetic fixtures only. No real embedder.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cosine,
  semanticMatchScore,
  cachedEmbedRaw,
  resetSemanticMatchCache,
} from '../../src/substrate/semantic-match.js';
import {
  LEGACY_EMBEDDING_PROFILE,
  OWNED_EMBEDDING_PROFILE,
  resolveAttentionPolicy,
  admitsPairScore,
} from '../../src/substrate/encoder-attention-policy.js';

const LONG = 'abcdefghijklmnopqrstuvwxyz'; // 26 alnum > 20

test.beforeEach(() => {
  resetSemanticMatchCache();
});

test('cosine rejects unequal lengths instead of comparing the shorter prefix', () => {
  assert.equal(cosine([1, 0, 0], [1, 0]), null);
  assert.equal(cosine([1, 0], [1, 0]), 1);
});

test('legacy policy keeps lived floor, margin, and min-alnum; owned stays null-cal', () => {
  const legacy = resolveAttentionPolicy(undefined);
  assert.equal(legacy.profileId, LEGACY_EMBEDDING_PROFILE);
  assert.equal(legacy.matchFloor, 0.6);
  assert.equal(legacy.matchMargin, 0.12);
  assert.equal(legacy.minMatchableAlnum, 20);
  assert.equal(legacy.canSemanticGate, true);

  const owned = resolveAttentionPolicy(OWNED_EMBEDDING_PROFILE);
  assert.equal(owned.matchFloor, null);
  assert.equal(owned.matchMargin, null);
  assert.equal(owned.minMatchableAlnum, 20);
  assert.equal(owned.canSemanticGate, false);
});

test('null calibration never semantic-gates even when vectors would match', () => {
  const embed = () => [1, 0, 0, 0];
  const score = semanticMatchScore(LONG, LONG, embed, { recipeId: OWNED_EMBEDDING_PROFILE });
  assert.equal(score, null);
  assert.equal(admitsPairScore(1, resolveAttentionPolicy(OWNED_EMBEDDING_PROFILE)), false);
});

test('legacy pair score still admits at the lived floor', () => {
  const embed = (text: string) => (text === LONG ? [1, 0] : [0.8, 0.6]);
  const score = semanticMatchScore(LONG, `${LONG} related`, embed);
  assert.ok(score !== null && score >= 0.6);
  assert.equal(admitsPairScore(score, resolveAttentionPolicy(LEGACY_EMBEDDING_PROFILE)), true);
});

test('embed cache is keyed by recipe id, not text alone', () => {
  resetSemanticMatchCache();
  const calls: string[] = [];
  const embed = (text: string) => {
    calls.push(text);
    return [1, 0];
  };
  assert.deepEqual(cachedEmbedRaw(LONG, embed, LEGACY_EMBEDDING_PROFILE), [1, 0]);
  assert.deepEqual(cachedEmbedRaw(LONG, embed, LEGACY_EMBEDDING_PROFILE), [1, 0]);
  assert.equal(calls.length, 1, 'same recipe reuses the cache');
  assert.deepEqual(cachedEmbedRaw(LONG, embed, OWNED_EMBEDDING_PROFILE), [1, 0]);
  assert.equal(calls.length, 2, 'other recipe is a different cache key');
});

test('dimension mismatch is a typed absence, never a fabricated score', () => {
  const embed = (text: string) => (text === LONG ? [1, 0, 0] : [1, 0]);
  assert.equal(semanticMatchScore(LONG, `${LONG} other`, embed), null);
});
