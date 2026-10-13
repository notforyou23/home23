import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConversationSources } from '../src/conversation-sources.js';

test('declared Seed subscriptions consume each source once and filter other resident streams to owner turns', () => {
  const sources = resolveConversationSources({
    SEED_CONVERSATION_SOURCE: '/tmp/jerry/conversation-stream.jsonl',
    SEED_OWNER_CONVERSATION_SOURCES: JSON.stringify([
      '/tmp/jerry/conversation-stream.jsonl', '/tmp/forrest/conversation-stream.jsonl',
      '/tmp/forrest/conversation-stream.jsonl',
    ]),
  }, 1024);
  assert.equal(sources.length, 2);
  assert.equal(sources[0]?.id, 'conversation', 'legacy own-source cursor identity survives');
  assert.equal(sources[0]?.sourceType, 'conversation-stream');
  assert.equal(sources[1]?.sourceType, 'owner-conversation-stream');
  assert.equal(sources[1]?.backfillBytes, 1024);
  const reordered = resolveConversationSources({ SEED_OWNER_CONVERSATION_SOURCES: JSON.stringify([
    '/tmp/forrest/conversation-stream.jsonl', '/tmp/jerry/conversation-stream.jsonl',
  ]) }, 1024);
  assert.equal(sources[1]?.id, reordered[0]?.id, 'list order cannot replay a source with another cursor identity');
});

test('subscription input rejects malformed declarations before a runner is started', () => {
  for (const raw of ['broken', '{}', '[42]', '["/tmp/a", ""]', '["/tmp/a\\u0000b"]']) {
    assert.throws(() => resolveConversationSources({ SEED_OWNER_CONVERSATION_SOURCES: raw }, 1), /SEED_OWNER_CONVERSATION_SOURCES/);
  }
  assert.deepEqual(resolveConversationSources({}, 1), []);
});
