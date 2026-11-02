import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProviderToolCalls, serializeProviderHistory, toolRoundHistory } from '../../src/agent/provider-history.js';
import type { StoredMessage } from '../../src/agent/history.js';
import { estimateContextChars } from '../../src/agent/context-pressure.js';

const calls = normalizeProviderToolCalls([
  { function: { name: 'read', arguments: { path: 'notes.json', offset: 17 } } },
  { id: 'explicit-id', function: { name: 'inspect', arguments: '{"nested":{"label":"with spaces"}}' } },
], index => `assigned-${index}`);
const payload = 'first line\n' + 'x'.repeat(2500) + '\nlast line';
const history = toolRoundHistory(calls, [
  { id: 'assigned-0', content: payload },
  { id: 'explicit-id', content: 'permission refused', isError: true },
], 'I will inspect these sources.');

test('typed history preserves supplied bounded payload, arguments, text, identity, and failure', () => {
  assert.equal(history.length, 2);
  assert.deepEqual(history[0].content, [
    { type: 'text', text: 'I will inspect these sources.' },
    { type: 'tool_use', id: 'assigned-0', name: 'read', input: { path: 'notes.json', offset: 17 } },
    { type: 'tool_use', id: 'explicit-id', name: 'inspect', input: { nested: { label: 'with spaces' } } },
  ]);
  assert.deepEqual(history[1].content, [
    { type: 'tool_result', tool_use_id: 'assigned-0', content: payload },
    { type: 'tool_result', tool_use_id: 'explicit-id', content: 'permission refused', is_error: true },
  ]);
});

test('chat completions replay retains call/result linkage and JSON arguments', () => {
  const messages = serializeProviderHistory(history, 'chat-completions');
  assert.equal(messages[0].content, 'I will inspect these sources.');
  assert.deepEqual(JSON.parse(messages[0].tool_calls[0].function.arguments), { path: 'notes.json', offset: 17 });
  assert.equal(messages[1].role, 'tool');
  assert.equal(messages[1].tool_call_id, 'assigned-0');
  assert.equal(messages[1].content, payload);
  assert.equal(messages[2].tool_call_id, 'explicit-id');
});

test('Responses replay keeps complete function calls and outputs', () => {
  const messages = serializeProviderHistory(history, 'responses');
  assert.deepEqual(messages.map(message => message.type ?? message.role), ['assistant', 'function_call', 'function_call', 'function_call_output', 'function_call_output']);
  assert.equal(messages[1].call_id, messages[3].call_id);
  assert.equal(messages[3].output, payload);
});

test('Ollama replay includes native object arguments and matching tool names', () => {
  const messages = serializeProviderHistory(history, 'ollama');
  assert.deepEqual(messages[0].tool_calls[0].function.arguments, { path: 'notes.json', offset: 17 });
  assert.equal(messages[1].tool_name, 'read');
  assert.equal(messages[2].tool_name, 'inspect');
  assert.equal(messages[1].tool_call_id, messages[0].tool_calls[0].id);
});

test('mixed tool result and new user text keep their order', () => {
  const mixed: StoredMessage[] = [history[0], { role: 'user', content: [
    { type: 'tool_result', tool_use_id: calls[0].id, content: 'found' },
    { type: 'text', text: 'Also check this photograph.' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } },
  ] }];
  const oai = serializeProviderHistory(mixed, 'chat-completions');
  assert.equal(oai[1].role, 'tool');
  assert.equal(oai[2].role, 'user');
  assert.equal(oai[2].content[1].image_url.url, 'data:image/png;base64,YWJj');
  const native = serializeProviderHistory(mixed, 'ollama');
  assert.deepEqual(native[2].images, ['YWJj']);
});

test('historical lossy summaries remain visibly historical text', () => {
  const legacy: StoredMessage[] = [{ role: 'assistant', content: '[Used tools: read]\nread: old summary' }];
  assert.deepEqual(serializeProviderHistory(legacy, 'ollama'), legacy);
});

test('thinking signatures are not copied between providers', () => {
  assert.deepEqual(serializeProviderHistory([{ role: 'assistant', content: [
    { type: 'thinking', thinking: 'private', signature: 'provider-signature' },
    { type: 'text', text: 'visible' },
  ] }], 'responses'), [{ role: 'assistant', content: 'visible' }]);
});

test('malformed batches refuse rather than fabricating arguments', () => {
  for (const raw of [
    [{ function: { name: 'read', arguments: '{broken' } }],
    [{ function: { name: 'read', arguments: 'null' } }],
    [{ function: { name: 'read', arguments: [] } }],
    [{ function: { name: '', arguments: {} } }],
    [{ id: 'same', function: { name: 'read', arguments: {} } }, { id: 'same', function: { name: 'read', arguments: {} } }],
  ]) assert.throws(() => normalizeProviderToolCalls(raw, () => 'generated'), { code: 'provider_invalid_tool_call' });
});

test('a partially collected round cannot be published as complete history', () => {
  assert.throws(() => toolRoundHistory(calls, [{ id: calls[0].id, content: 'one' }]), /one ordered result/);
});

test('native image context budgeting counts image estimates rather than base64 bytes', () => {
  const first = [{ role: 'user', content: 'Inspect.', images: ['x'.repeat(100_000)] }];
  const larger = [{ role: 'user', content: 'Inspect.', images: ['x'.repeat(2_000_000)] }];
  assert.equal(estimateContextChars(first), estimateContextChars(larger));
  assert.ok(estimateContextChars(first) > 16000 && estimateContextChars(first) < 16200);
  assert.ok(estimateContextChars([{ role: 'user', images: ['a', 'b'] }]) > 32000);
});
