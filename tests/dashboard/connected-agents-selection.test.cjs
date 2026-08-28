const assert = require('node:assert/strict');
const test = require('node:test');

const Selection = require('../../engine/src/dashboard/connected-agents-selection.js');

const wire = (channelId = 'chn_0198d95f-6c00-7000-8000-000000000001') => ({
  channelId,
  conversationId: 'cnv_0198d95f-6c00-7000-8000-000000000002',
  targetBotId: 'bot_0198d95f-6c00-7000-8000-000000000003',
  models: [
    { alias: 'sol', provider: 'openai-codex', model: 'gpt-5.6-sol', reasoningEffort: 'high' },
    { alias: 'terra', provider: 'openai-codex', model: 'gpt-5.6-terra', reasoningEffort: null },
  ],
  defaultModel: 'gpt-5.6-sol',
  defaultProvider: 'openai-codex',
  defaultReasoningEffort: 'high',
  reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
});

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    values,
  };
}

test('execution catalog validation binds exact aliases and efforts to one Channel', () => {
  const options = Selection.normalizeOptions(wire(), wire().channelId);
  assert.deepEqual(options.models.map((model) => model.alias), ['sol', 'terra']);
  assert.equal(options.defaultReasoningEffort, 'high');
  assert.throws(
    () => Selection.normalizeOptions(wire(), 'chn_0198d95f-6c00-7000-8000-000000000099'),
    /different Channel/,
  );
  const duplicate = wire();
  duplicate.models.push({ ...duplicate.models[0] });
  assert.throws(() => Selection.normalizeOptions(duplicate), /unique/);
  assert.throws(() => Selection.normalizeOptions({ ...wire(), reasoningEfforts: ['ultra'] }), /invalid/);
});

test('conversation defaults persist without sharing state across Channels', () => {
  const storage = memoryStorage();
  const firstChannel = wire().channelId;
  const secondChannel = 'chn_0198d95f-6c00-7000-8000-000000000004';
  const first = Selection.normalizeOptions(wire(firstChannel), firstChannel);
  const second = Selection.normalizeOptions(wire(secondChannel), secondChannel);
  assert.equal(Selection.savePreference(storage, firstChannel, {
    modelAlias: 'sol', reasoningEffort: 'xhigh',
  }, first), true);
  assert.deepEqual(Selection.loadPreference(storage, firstChannel, first), {
    modelAlias: 'sol', reasoningEffort: 'xhigh',
  });
  assert.deepEqual(Selection.loadPreference(storage, secondChannel, second), {
    modelAlias: null, reasoningEffort: null,
  });
  storage.setItem(Selection.storageKey(secondChannel), JSON.stringify({
    modelAlias: 'retired-alias', reasoningEffort: 'max',
  }));
  assert.deepEqual(Selection.loadPreference(storage, secondChannel, second), {
    modelAlias: null, reasoningEffort: null,
  });
  assert.doesNotMatch([...storage.values.keys()].join('\n'), /token|credential|secret/i);
});

test('a pending send captures one exact selection that retry cannot rewrite', () => {
  const original = Selection.capture({ modelAlias: 'sol', reasoningEffort: 'max' });
  const pendingRecord = Object.freeze({
    text: 'exact turn',
    messageId: 'msg_1',
    clientMessageId: 'client_1',
    idempotencyKey: 'stable-key',
    ...original,
  });
  const laterConversationDefault = Selection.capture({ modelAlias: 'terra', reasoningEffort: 'low' });
  assert.deepEqual(Selection.requestFields(pendingRecord), {
    modelAlias: 'sol', reasoningEffort: 'max',
  });
  assert.notDeepEqual(Selection.requestFields(pendingRecord), laterConversationDefault);
  assert.equal(Object.isFrozen(original), true);
});
