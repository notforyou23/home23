import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createOwnerConversationEnricher, ownerConversationMatch, ownerConversationQuery, type OwnerConversationEvidence }
  from '../../src/agent/owner-conversation-recall.js';

const NOW = Date.parse('2026-10-14T20:00:00.000Z');
const TS = '2026-10-14T12:58:30.300Z';
const SOURCE = 'coordination.message:msg_policy_owner';
const QUOTE = 'Check the brain. We also discussed the guitar lesson this morning.';

function fixture(t: test.TestContext, canonical: Record<string, unknown>[] = [], raw: Record<string, unknown>[] = []) {
  const instanceDir = mkdtempSync(join(tmpdir(), 'home23-owner-transcript-policy-'));
  t.after(() => rmSync(instanceDir, { recursive: true, force: true }));
  mkdirSync(join(instanceDir, 'substrate'));
  mkdirSync(join(instanceDir, 'conversations'));
  const jsonl = (rows: Record<string, unknown>[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  writeFileSync(join(instanceDir, 'substrate', 'conversation-stream.jsonl'), jsonl(canonical));
  if (raw.length) writeFileSync(join(instanceDir, 'conversations', 'jerry__coordination_chn_policy.jsonl'), jsonl(raw));
  return createOwnerConversationEnricher({ instanceDir, agentName: 'jerry' });
}

function contact(overrides: Record<string, unknown> = {}) {
  return { role: 'user', voice: 'jtr', text: QUOTE, ts: TS, session: 'coordination:chn_policy',
    contactId: 'message:msg_policy_owner', sourceRef: SOURCE, channelKind: 'direct',
    actor: { kind: 'owner', principalId: 'user_owner', displayName: 'Owner' }, ...overrides };
}

function evidence(quote = QUOTE): OwnerConversationEvidence {
  return { id: 'rel_policy', kind: 'decision', statement: 'Discussed a guitar lesson this morning.',
    quote, createdAt: TS, occurredAt: TS, sourceRefs: [SOURCE], sessionRefs: ['owner-session:policy'],
    privacyClass: 'internal', status: 'active' };
}

test('transcript retrieval excludes verification canonical chats and flagged turns before resolving an owner pointer', t => {
  for (const overrides of [{ session: 'coordination:home-verify-48-transcript' },
    { verification: true }, { metadata: { owner_evidence: false } }, { provenance: { verification: true } }]) {
    const enrich = fixture(t, [contact(overrides)]);
    const result = enrich(evidence(), ownerConversationQuery('What did we talk about this morning?', NOW));
    assert.equal(result.transcript, undefined);
  }
});

test('explicit retrieval-test owner turns are excluded while a genuine check-the-brain morning conversation remains available', t => {
  const testQuote = 'Let us test your recall of the guitar lesson with a retrieval test.';
  const excluded = fixture(t, [contact({ text: testQuote })])(
    evidence(testQuote), ownerConversationQuery('guitar lesson', NOW));
  assert.equal(excluded.transcript, undefined);
  const actual = fixture(t, [contact(), contact({ role: 'assistant', voice: 'self', text: 'You wanted to practice guitar phrasing.',
    sourceRef: 'coordination.message:msg_policy_reply', contactId: 'message:msg_policy_reply',
    actor: { kind: 'bot', principalId: 'resident-jerry', displayName: 'Jerry' } })])(
    evidence(), ownerConversationQuery('What did we talk about this morning?', NOW));
  assert.equal(actual.transcript?.turns[0]?.text, QUOTE);
  assert.match(actual.transcript?.excerpt ?? '', /guitar phrasing/);
});

test('authenticated raw history cannot resolve verification envelopes or individually flagged or test owner turns', t => {
  const pending = { type: 'turn', status: 'pending', started_at: TS, context_purpose: 'conversation',
    coordination_origin: { kind: 'coordination', channelId: 'chn_policy', originMessageId: 'msg_policy_owner' } };
  for (const [envelope, message] of [
    [{ ...pending, chat_id: 'home-verify-48-raw' }, { role: 'user', content: QUOTE, ts: TS }],
    [{ ...pending, chatId: 'home-verify-48-raw' }, { role: 'user', content: QUOTE, ts: TS }],
    [{ ...pending, verification: true }, { role: 'user', content: QUOTE, ts: TS }],
    [pending, { role: 'user', content: QUOTE, ts: TS, metadata: { verification: true } }],
    [pending, { role: 'user', content: 'Test your recall of the guitar lesson.', ts: TS }],
  ]) {
    const quote = String(message.content);
    const result = fixture(t, [], [envelope, message])(
      evidence(quote), ownerConversationQuery('guitar lesson', NOW));
    assert.equal(result.transcript, undefined);
  }
  const genuine = fixture(t, [], [pending, { role: 'user', content: QUOTE, ts: TS }])(
    evidence(), ownerConversationQuery('What did we talk about this morning?', NOW));
  assert.equal(genuine.transcript?.turns[0]?.text, QUOTE);
});

test('verification exclusions follow a canonical message id into its unflagged raw history copy', t => {
  const raw = [{ type: 'turn', status: 'pending', started_at: TS, context_purpose: 'conversation',
    coordination_origin: { kind: 'coordination', channelId: 'chn_policy', originMessageId: 'msg_policy_owner' } },
  { role: 'user', content: QUOTE, ts: TS }];
  const result = fixture(t, [contact({ verification: true })], raw)(
    evidence(), ownerConversationQuery('What did we talk about this morning?', NOW));
  assert.equal(result.transcript, undefined);
});

test('an excluded owner test cannot lend its assistant reply to later genuine owner context', t => {
  const reply = (id: string, text: string, ts: string) => contact({ role: 'assistant', voice: 'self', text, ts,
    sourceRef: `coordination.message:${id}`, contactId: `message:${id}`,
    actor: { kind: 'bot', principalId: 'resident-jerry', displayName: 'Jerry' } });
  const result = fixture(t, [
    contact({ text: 'Test your recall of the guitar lesson.', verification: true,
      ts: '2026-10-14T12:55:00.000Z', sourceRef: 'coordination.message:msg_test', contactId: 'message:msg_test' }),
    reply('msg_test_reply', 'SYNTHETIC_TEST_REPLY: guitar lesson test result.', '2026-10-14T12:56:00.000Z'),
    contact(), reply('msg_real_reply', 'REAL_OWNER_REPLY: let us practice guitar phrasing.', '2026-10-14T12:59:00.000Z'),
  ])(evidence(), ownerConversationQuery('guitar lesson', NOW));
  assert.match(result.transcript?.excerpt ?? '', /REAL_OWNER_REPLY/);
  assert.doesNotMatch(result.transcript?.excerpt ?? '', /SYNTHETIC_TEST_REPLY/);
  assert.equal(result.transcript?.turns.some(turn => turn.text.includes('SYNTHETIC_TEST_REPLY')), false);
});

test('a flagged current source excludes a neutral legacy pointer even when its hashed session ref is unflagged', t => {
  const query = ownerConversationQuery('guitar lesson', NOW);
  const result = fixture(t, [contact({ verification: true })])(evidence(), query);
  assert.equal(result.conversationKind, 'verification');
  assert.equal(ownerConversationMatch(result, query), null);
});

test('a newer genuine occurrence wins over an older excluded reference appended last to a merged pointer', t => {
  const oldRef = 'coordination.message:msg_older_test';
  const result = fixture(t, [contact({ verification: true, ts: '2026-10-14T11:00:00.000Z',
    sourceRef: oldRef, contactId: 'message:msg_older_test' }), contact()])(
    { ...evidence(), sourceRefs: [SOURCE, oldRef] }, ownerConversationQuery('guitar lesson', NOW));
  assert.notEqual(result.conversationKind, 'verification');
  assert.notEqual(ownerConversationMatch(result, ownerConversationQuery('guitar lesson', NOW)), null);
  assert.equal(result.transcript?.turns[0]?.sourceRef, SOURCE);
});

test('a verification raw envelope excludes its current quote-gated pointer while an older excluded raw replay does not', t => {
  const pending = { type: 'turn', status: 'pending', started_at: TS, context_purpose: 'conversation',
    coordination_origin: { kind: 'coordination', channelId: 'chn_policy', originMessageId: 'msg_policy_owner' } };
  const query = ownerConversationQuery('guitar lesson', NOW);
  const excluded = fixture(t, [], [{ ...pending, verification: true }, { role: 'user', content: QUOTE, ts: TS }])(
    evidence(), query);
  assert.equal(excluded.conversationKind, 'verification');
  assert.equal(ownerConversationMatch(excluded, query), null);
  const canonicalCopy = fixture(t, [contact()], [{ ...pending, verification: true },
    { role: 'user', content: QUOTE, ts: TS }])(evidence(), query);
  assert.equal(canonicalCopy.conversationKind, 'verification');
  assert.equal(ownerConversationMatch(canonicalCopy, query), null);
  const oldRef = 'coordination.message:msg_older_test';
  const older = { ...pending, started_at: '2026-10-14T11:00:00.000Z', verification: true,
    coordination_origin: { kind: 'coordination', channelId: 'chn_policy', originMessageId: 'msg_older_test' } };
  const actual = fixture(t, [], [pending, { role: 'user', content: QUOTE, ts: TS },
    { type: 'turn', status: 'complete' }, older,
    { role: 'user', content: QUOTE, ts: '2026-10-14T11:00:00.000Z' }])(
    { ...evidence(), sourceRefs: [SOURCE, oldRef] }, query);
  assert.notEqual(actual.conversationKind, 'verification');
  assert.notEqual(ownerConversationMatch(actual, query), null);
});
