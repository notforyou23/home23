'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readRecentConversationEntries } = require('../../../engine/src/cognition/seed-conversation-context');
function stream(t, lines, partial = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-contact-view-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'conversation-stream.jsonl');
  fs.writeFileSync(file, lines.map(row => JSON.stringify(row)).join('\n') + '\n' + partial);
  return file;
}
const now = Date.parse('2026-09-26T12:00:00Z');
const turn = (id, voice = 'jtr', text = 'actual words') => ({ ts: '2026-09-26T11:00:00Z', role: voice === 'self' ? 'assistant' : 'user', text, session: 'coordination:room', contactId: `message:${id}`, sourceRef: `coordination.message:${id}`, voice, actor: { principalId: voice, kind: voice === 'jtr' ? 'owner' : 'bot', displayName: voice === 'jtr' ? 'Jason' : voice === 'self' ? 'Jerry' : 'Coz' } });
test('current canonical contact retains complete words, authorship, event identity and original time', t => {
  const correction = 'earlier text '.repeat(900) + 'Actually, that hypothesis was wrong.';
  const file = stream(t, [turn('a'), turn('b','self'), turn('c','peer'), turn('d','jtr',correction), turn('d','jtr',correction)]);
  const entries = readRecentConversationEntries(file, { now });
  assert.equal(entries.length, 4);
  assert.match(entries[0].summary, /Owner Jason/);
  assert.match(entries[1].summary, /Resident Jerry/);
  assert.match(entries[2].summary, /Peer Coz/);
  assert.ok(entries[3].summary.endsWith(correction));
  assert.equal(entries[3].eventId, 'message:d');
  assert.equal(entries[3].ts, '2026-09-26T11:00:00Z');
});
test('rejects torn, stale, future, non-contact and mismatched identity rows', t => {
  const file = stream(t, [turn('good'), { ...turn('stale'), ts: '2025-01-01T00:00:00Z' }, { ...turn('future'), ts: '2027-01-01T00:00:00Z' }, { ...turn('tool'), role: 'tool' }, { ...turn('forged'), actor: { principalId: 'bot', kind: 'bot', displayName: 'bot' } }, { ...turn('wrongid'), contactId: 'message:elsewhere' }, { ...turn('badref'), sourceRef: 'random:file' }], JSON.stringify(turn('unfinished')));
  assert.deepEqual(readRecentConversationEntries(file, { now }).map(e => e.eventId), ['message:good']);
});
test('bounded tail drops partial first row and keeps newest complete contact', t => {
  const newest = turn('newest', 'self', 'latest response');
  const file = stream(t, [turn('huge','jtr','x'.repeat(10000)), newest]);
  const entries = readRecentConversationEntries(file, { now, maxReadBytes: 1500 });
  assert.deepEqual(entries.map(e => e.eventId), ['message:newest']);
});
