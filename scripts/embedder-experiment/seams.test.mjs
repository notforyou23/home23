import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { recipeIdFromFingerprint, SHARED_PROJECTION } from './lib/recipe-id.mjs';
import { computeRecipeIds, HOME23_TRUNCATION, PROFILE_IDS, profiles } from './lib/recipe-profiles.mjs';
import {
  ABSENCE_CODES,
  PROTOCOLS,
  validateHealthDocument,
  validateOllamaNativeRequest,
  validateOllamaNativeResponse,
  validateOpenAIRequest,
  validateOpenAIResponse,
} from './lib/validate-seams.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(here, '../embedder/schema');
const recipes = JSON.parse(readFileSync(join(schemaDir, 'recipes.json'), 'utf8'));
const http = JSON.parse(readFileSync(join(schemaDir, 'http.json'), 'utf8'));
const health = JSON.parse(readFileSync(join(schemaDir, 'health.json'), 'utf8'));
const stage1Summary = JSON.parse(readFileSync(join(here, 'results/stage1-summary.json'), 'utf8'));
const vec768 = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));

test('frozen recipeIds match hashes computed from Stage 1 pins (no new download)', () => {
  const computed = computeRecipeIds();
  assert.equal(computed[PROFILE_IDS.legacy], recipes.profiles[PROFILE_IDS.legacy].recipeId);
  assert.equal(computed[PROFILE_IDS.owned], recipes.profiles[PROFILE_IDS.owned].recipeId);
  assert.equal(recipes.profiles[PROFILE_IDS.legacy].recipeId, '5128b29c886857aeb89b148d2d9f2edf2c20f63de15a764342c2a18da640f71a');
  assert.equal(recipes.profiles[PROFILE_IDS.owned].recipeId, '12e9f736ef4a7462e88cc228236d9e098d9dff7c30d178c7f9a3cb243d65efd9');
  assert.notEqual(computed[PROFILE_IDS.legacy], computed[PROFILE_IDS.owned]);
});

test('recipes stay distinct and keep published projection', () => {
  assert.equal(recipes.projection.expected_dim, 768);
  assert.equal(recipes.projection.projection_seed, 20260808);
  assert.equal(recipes.projection.projection_dim, 16);
  assert.equal(recipes.projection.metric, 'cosine');
  assert.deepEqual(SHARED_PROJECTION, {
    expected_dim: 768,
    projection_seed: 20260808,
    projection_dim: 16,
    metric: 'cosine',
  });
  const live = profiles();
  assert.equal(live[PROFILE_IDS.owned].compatibleWithOwned, true);
  assert.equal(live[PROFILE_IDS.legacy].compatibleWithOwned, false);
  assert.deepEqual(live[PROFILE_IDS.owned].fingerprint.truncation, HOME23_TRUNCATION);
  assert.equal(live[PROFILE_IDS.legacy].fingerprint.truncation.seed.maxChars, 1000);
  assert.equal(live[PROFILE_IDS.legacy].fingerprint.truncation.memory.maxChars, 2000);
});

test('uncalibrated owned matchFloor stays null; legacy keeps lived floors', () => {
  const owned = recipes.profiles[PROFILE_IDS.owned].attention;
  const legacy = recipes.profiles[PROFILE_IDS.legacy].attention;
  assert.equal(owned.matchFloor, null);
  assert.equal(owned.matchMargin, null);
  assert.equal(owned.minMatchableAlnum, 20);
  assert.equal(legacy.matchFloor, 0.6);
  assert.equal(legacy.matchMargin, 0.12);
  assert.equal(legacy.minMatchableAlnum, 20);
});

test('fingerprint change or extra key is a different or rejected recipe', () => {
  const body = profiles()[PROFILE_IDS.owned].fingerprint;
  const mutated = { ...body, pooling: 'cls' };
  assert.notEqual(recipeIdFromFingerprint(mutated), recipes.profiles[PROFILE_IDS.owned].recipeId);
  assert.throws(() => recipeIdFromFingerprint({ ...body, extra: true }));
});

test('both HTTP shapes accept fixtures and reject bad vectors', () => {
  assert.equal(PROTOCOLS.ollamaNative.path, '/api/embeddings');
  assert.equal(PROTOCOLS.openaiCompatible.path, '/v1/embeddings');
  assert.equal(http.protocols.ollamaNative.path, '/api/embeddings');
  assert.equal(http.protocols.openaiCompatible.path, '/v1/embeddings');
  assert.deepEqual(http.absenceCodes, ABSENCE_CODES);

  assert.equal(validateOllamaNativeRequest(http.protocols.ollamaNative.fixtures.request).ok, true);
  assert.equal(validateOllamaNativeRequest({ model: '', prompt: 'x' }).code, 'recipe_mismatch');
  assert.equal(validateOllamaNativeResponse({ embedding: vec768 }).ok, true);
  assert.equal(validateOllamaNativeResponse({ embedding: vec768.slice(0, 16) }).code, 'dimension_mismatch');
  assert.equal(validateOllamaNativeResponse({ embedding: Array(768).fill(Number.NaN) }).code, 'dimension_mismatch');

  assert.equal(validateOpenAIRequest(http.protocols.openaiCompatible.fixtures.request).ok, true);
  assert.equal(validateOpenAIRequest({ model: 'nomic-embed-text', input: [] }).ok, false);
  const batch = {
    data: [
      { index: 0, embedding: vec768 },
      { index: 1, embedding: vec768 },
    ],
  };
  assert.equal(validateOpenAIResponse(batch, 2).ok, true);
  assert.equal(validateOpenAIResponse({ data: [{ index: 0, embedding: [1, 2] }] }, 1).code, 'dimension_mismatch');
});

test('health fields require warm inference; /api/tags is not ready', () => {
  assert.equal(health.httpPath, null);
  assert.equal(health.processNameDocumentedOnly, 'home23-embedder');
  const known = Object.values(recipes.profiles).map((p) => p.recipeId);
  assert.equal(validateHealthDocument(health.fixtureReadyExample, { knownRecipeIds: known }).ok, true);
  assert.equal(validateHealthDocument(health.fixtureTagsIsNotReady, { knownRecipeIds: known }).reason, 'api-tags-is-not-ready');
  assert.equal(validateHealthDocument({ ...health.fixtureReadyExample, warm: false }).reason, 'not-warm');
  assert.equal(validateHealthDocument({ ...health.fixtureReadyExample, recipeId: 'nomic-embed-text' }).reason, 'recipeId-not-sha256');
  const missingWarm = { ...health.fixtureReadyExample };
  delete missingWarm.warm;
  assert.equal(validateHealthDocument(missingWarm).reason, 'missing-warm');
});

test('schema tests are fixtures; Stage 1 evidence remains real inference', () => {
  assert.equal(stage1Summary.realInference.ollama, true);
  assert.equal(stage1Summary.realInference.onnx, true);
  assert.equal(stage1Summary.comparisons['onnx-fp32-noprefix'].projectionEqual4dp, '0/25');
  assert.equal(existsSync(join(here, '../embedder/serve.mjs')), false);
});
