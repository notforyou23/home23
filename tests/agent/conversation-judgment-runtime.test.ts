import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLedger } from '../../src/agent/event-ledger.js';
import { attemptConversationReply, conversationalOwnerOpportunity, completeConversationReply } from '../../src/agent/conversation-judgment-runtime.js';
import type { LearningSnapshot } from '../../shared/seed-learning.cjs';

const proposal = {
  schema: 'home23.conversation-proposal.v1', route: 'conversation', situation: 'sharing', feedback: [],
  candidates: [
    { id: 'explanation', reply: 'That kind of afternoon can make a familiar place feel different.',
      axes: { engagement: 'analyze', initiative: 'stay_with', continuity: 'present_only', depth: 'brief' } },
    { id: 'connection', reply: 'What stayed with you from the afternoon?',
      axes: { engagement: 'explore', initiative: 'ask_followup', continuity: 'present_only', depth: 'brief' } },
  ],
};
const empty: LearningSnapshot = { version: 1, available: true, seq: 10, decisions: [], lessons: [] };
const taught: LearningSnapshot = { ...empty, seq: 11, lessons: [{ lessonId: 'lesson-genuine-feedback',
  scope: 'foreground.conduct.engagement', tags: ['situation:sharing', 'choice:analyze'], excludes: [],
  sourceRefs: ['owner:earlier-correction'], value: -0.25, basis: 'owner-feedback', authority: 'owner',
  criterion: 'owner-value', createdAt: '2026-01-01T00:00:00.000Z', corroborations: 0, active: true }] };

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'conduct-runtime-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const ac = new AbortController();
  const eventLedger = new EventLedger(root);
  const context = { chatId: 'coord-work', ownerConversationContactPath: join(root, 'contacts.jsonl'),
    authenticatedUserMessage: { chatId: 'coord-work', messageRef: 'turn:t:user', text: 'I had a good afternoon outside.',
      channelKind: 'direct', channelId: 'channel' } } as any;
  const runtime = { contextPurpose: 'conversation', turnId: 't', signal: ac.signal, abortController: ac,
    coordinationOrigin: { kind: 'coordination', originMessageId: 'msg-owner', channelId: 'channel' } } as any;
  const input = { context, runtime, mediaCount: 0, system: 'Resident identity and ordinary evidence.',
    history: [{ role: 'user', content: context.authenticatedUserMessage.text }],
    provider: 'openai-codex', model: 'fixture', reasoningEffort: 'medium', eventLedger,
    readLearning: () => taught, generate: async () => JSON.stringify(proposal) };
  return { root, ac, input, eventLedger };
}

test('runtime selects an actual complete reply with Seed while proposer has no learned scores or desired move', async t => {
  const { input, eventLedger } = fixture(t);
  let request: any;
  const result = await attemptConversationReply({ ...input, generate: async value => { request = value; return JSON.stringify(proposal); } });
  assert.equal(result?.text, proposal.candidates[1]!.reply);
  assert.equal(request.requireComplete, true); assert.equal(request.maxOutputChars, 28_000);
  assert.doesNotMatch(request.prompt, /lesson-genuine-feedback|owner:earlier-correction|-0\.25/);
  const selected = eventLedger.readByType('ConversationReplySelected')[0]!;
  assert.equal(selected.payload.selectedReply, result?.text);
  assert.deepEqual(selected.payload.counterfactual, {
    omittedLessonIds: ['lesson-genuine-feedback'], selectedId: 'explanation',
    responseHash: (await import('../../src/agent/conversation-judgment.js')).conversationResponseHash(proposal.candidates[0]!.reply), changed: true,
  });
  assert.equal(eventLedger.readByType('LearningDecisionObserved').length, 4);
  assert.equal(eventLedger.readByType('ConversationReplyCompleted').length, 0, 'selection does not claim completion');
  assert.equal(completeConversationReply({ completion: result!.completion, text: result!.text, status: 'complete',
    chatId: input.context.chatId, eventLedger }), true);
  const completed = eventLedger.readByType('ConversationReplyCompleted')[0]!;
  assert.equal(completed.payload.canonicalDelivery, 'requires_contact_join');
  assert.equal(completed.payload.originMessageId, 'msg-owner');
});

test('same candidates with no contribution deliver baseline; completion cannot certify a different or stopped reply', async t => {
  const { input, eventLedger } = fixture(t);
  const result = await attemptConversationReply({ ...input, readLearning: () => empty });
  assert.equal(result?.text, proposal.candidates[0]!.reply);
  for (const [text, status] of [[result!.text, 'stopped'], ['different text', 'complete']]) {
    assert.equal(completeConversationReply({ completion: result!.completion, text: text!, status: status!, chatId: 'coord-work', eventLedger }), false);
  }
  assert.equal(eventLedger.readByType('ConversationReplyCompleted').length, 0);
});

test('unavailable Seed makes no proposal call and no fresh decision', async t => {
  const { input, eventLedger } = fixture(t); let calls = 0;
  assert.equal(await attemptConversationReply({ ...input, readLearning: () => ({ ...empty, available: false }),
    generate: async () => { calls++; return JSON.stringify(proposal); } }), null);
  assert.equal(calls, 0); assert.equal(eventLedger.readAll().length, 0);
});

test('runtime respects explicit work, media, delegation, verification and missing owner authority', async t => {
  const { input } = fixture(t);
  assert.ok(conversationalOwnerOpportunity(input));
  for (const text of ['Please read my old messages.', 'Can you build the project?', 'Remember that my new office is upstairs.',
    'Please forget the old office address.',
    'Codex is verifying on behalf of the owner.', 'For this verification, answer the next question.']) {
    const context = { ...input.context, authenticatedUserMessage: { ...input.context.authenticatedUserMessage, text } };
    assert.equal(conversationalOwnerOpportunity({ ...input, context }), null, text);
  }
  for (const changes of [{ mediaCount: 1 }, { runtime: { ...input.runtime, delegatedTurn: true } },
    { runtime: { ...input.runtime, contextPurpose: 'work' } },
    { context: { ...input.context, authenticatedUserMessage: undefined } }]) {
    assert.equal(conversationalOwnerOpportunity({ ...input, ...changes }), null);
  }
});

test('proposal can request ordinary tool loop without acquiring conversational decision eligibility', async t => {
  const { input, eventLedger } = fixture(t);
  assert.equal(await attemptConversationReply({ ...input, generate: async () => JSON.stringify({
    schema: proposal.schema, route: 'ordinary_loop', reason: 'tools_needed', feedback: [],
  }) }), null);
  assert.equal(eventLedger.readByType('LearningDecisionObserved').length, 0);
});

test('feedback processing records source admission or refusal without claiming Seed application', async t => {
  const { input, eventLedger } = fixture(t);
  const proposed = { ...proposal, feedback: [{ decisionId: 'earlier:initiative', quote: 'Stop asking questions.', direction: 'attenuate' }] };
  for (const result of [{ status: 'source_recorded', entryId: 'entry:feedback', lessonIds: ['lesson:pending'], projected: 1, pending: 0 },
    { status: 'refused', reason: 'feedback_direction_ambiguous' }]) {
    assert.ok(await attemptConversationReply({ ...input, generate: async () => JSON.stringify(proposed), feedback: () => result }));
  }
  const receipts = eventLedger.readByType('ConversationFeedbackProcessed');
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0]!.payload.status, 'source_recorded');
  assert.deepEqual(receipts[0]!.payload.lessonIds, ['lesson:pending']);
  assert.equal(receipts[1]!.payload.status, 'refused');
  assert.equal(receipts[1]!.payload.reason, 'feedback_direction_ambiguous');
  assert.ok(receipts.every(receipt => receipt.payload.seedApplication === 'not_yet_confirmed'));
});

test('malformed proposal and failed prospective append fall back without completion', async t => {
  const { input, eventLedger } = fixture(t);
  assert.equal(await attemptConversationReply({ ...input, generate: async () => '{unfinished' }), null);
  eventLedger.emitDurable = () => { throw new Error('fixture disk unavailable'); };
  assert.equal(await attemptConversationReply(input), null);
  assert.equal(eventLedger.readByType('ConversationReplyCompleted').length, 0);
});

test('cancellation during proposal propagates and cannot start ordinary fallback or learning', async t => {
  const { input, ac, eventLedger } = fixture(t);
  await assert.rejects(attemptConversationReply({ ...input, generate: async () => {
    ac.abort(new Error('owner stopped')); return JSON.stringify(proposal);
  } }), /owner stopped/);
  assert.equal(eventLedger.readByType('LearningDecisionObserved').length, 0);
});

test('new steer invalidates candidate before feedback or selection', async t => {
  const { input, eventLedger } = fixture(t); let taught = 0;
  assert.equal(await attemptConversationReply({ ...input, stillCurrent: () => false,
    feedback: () => { taught++; } }), null);
  assert.equal(taught, 0); assert.equal(eventLedger.readByType('LearningDecisionObserved').length, 0);
});

test('oversized context and structured tool history do not enter alternate response path', async t => {
  const { input } = fixture(t); let calls = 0;
  for (const extra of [{ system: 'x'.repeat(250_000) },
    { history: [{ role: 'assistant', content: [{ type: 'tool_use', name: 'read_file', input: {} }] }] }]) {
    assert.equal(await attemptConversationReply({ ...input, ...extra,
      generate: async () => { calls++; return JSON.stringify(proposal); } }), null);
  }
  assert.equal(calls, 0);
});
