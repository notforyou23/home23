import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  decodeModelPair,
  encodeModelPair,
} from '../../../engine/src/dashboard/home23-model-pair.mjs';

test('Chat model values preserve exact provider identity for duplicate model IDs', () => {
  const openai = encodeModelPair({ provider: 'openai', model: 'gpt-5.5' });
  const codex = encodeModelPair({ provider: 'openai-codex', model: 'gpt-5.5' });

  assert.notEqual(openai, codex);
  assert.deepEqual(decodeModelPair(openai), { provider: 'openai', model: 'gpt-5.5' });
  assert.deepEqual(decodeModelPair(codex), { provider: 'openai-codex', model: 'gpt-5.5' });
});

test('Chat model codec rejects model-only, incomplete, or ambiguous values', () => {
  for (const value of [
    'gpt-5.5',
    'openai::',
    '::gpt-5.5',
    'openai::gpt-5.5::extra',
    '%E0%A4%A::gpt-5.5',
  ]) {
    assert.throws(() => decodeModelPair(value), { code: 'model_pair_invalid' });
  }
});

test('Chat picker stores and persists only decoded exact pairs', () => {
  const source = fs.readFileSync(
    path.resolve('engine/src/dashboard/home23-chat.js'),
    'utf8',
  );
  assert.match(source, /value="\$\{escapeHtml\(encodeModelPair\(modelEntry\)\)\}"/);
  assert.match(source, /<optgroup label="\$\{escapeHtml\(providerName\)\}">/);
  assert.match(source, /(?:const|let) selectedPair;[\s\S]*selectedPair = decodeModelPair\(select\.value\)/);
  assert.match(source, /JSON\.stringify\(\{ model: selectedPair\.model, provider: selectedPair\.provider \}\)/);
  assert.doesNotMatch(source, /chatModel\s*=\s*select\.value/);
});
