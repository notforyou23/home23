import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheableSystemPrompt, cacheUsage, promptCacheKey } from '../../src/agent/prompt-cache.js';

test('notes and compaction changes leave the static cache boundary byte-identical', () => {
  const stable = 'Identity and applicable authority.';
  const first = cacheableSystemPrompt('anthropic', stable, 'Task note A');
  const after = cacheableSystemPrompt('anthropic', stable, 'Checkpoint B');
  assert.deepEqual(first[0], after[0]);
  assert.equal((first as any)[1].cache_control, undefined);
  assert.equal((after as any)[1].text, 'Checkpoint B');
});

test('routing keys identify stable workspace/model/prompt/tool scope without private labels', () => {
  const key = promptCacheKey('/private/owner/home', 'openai', 'model', 'identity', [{ name: 'read', schema: 1 }]);
  assert.equal(key, promptCacheKey('/private/owner/home', 'openai', 'model', 'identity', [{ name: 'read', schema: 1 }]));
  assert.doesNotMatch(key, /private|owner|identity/);
  for (const args of [
    ['/different', 'openai', 'model', 'identity', [{ name: 'read', schema: 1 }]],
    ['/private/owner/home', 'openai', 'other-model', 'identity', [{ name: 'read', schema: 1 }]],
    ['/private/owner/home', 'openai', 'model', 'new identity', [{ name: 'read', schema: 1 }]],
    ['/private/owner/home', 'openai', 'model', 'identity', [{ name: 'read', schema: 2 }]],
  ] as const) assert.notEqual(key, promptCacheKey(...args));
});

test('missing usage is unknown; confirmed zero is a miss; read and write totals are distinct', () => {
  assert.equal(cacheUsage('openai', undefined).read, null);
  assert.equal(cacheUsage('openai', { prompt_tokens_details: { cached_tokens: 0 } }).read, 0);
  assert.deepEqual(cacheUsage('openai-codex', { input_tokens: 15000, output_tokens: 20, input_tokens_details: { cached_tokens: 12000, cache_write_tokens: 3000 } }),
    { read: 12000, write: 3000, input: 0, inputTotal: 15000, output: 20 });
  assert.equal(cacheUsage('openai', { prompt_tokens_details: { cached_tokens: -10 } }).read, null);
  assert.equal(cacheUsage('anthropic', { input_tokens: 100 }).inputTotal, null);
});

test('plain compatible providers preserve the system text and receive no cache markers', () => {
  assert.equal(cacheableSystemPrompt('openai', 'stable', '\ndynamic'), 'stable\ndynamic');
  assert.equal(cacheableSystemPrompt('ollama-cloud', 'stable', '\ndynamic'), 'stable\ndynamic');
});
