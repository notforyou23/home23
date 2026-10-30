import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventLedger } from '../../src/agent/event-ledger.js';
import { RelationshipLedger } from '../../src/agent/relationship-ledger.js';
import { relationshipNoteTool, relationshipUpdateTool } from '../../src/agent/tools/relationship.js';
import { applyConversationFeedback, readPriorDeliveredConversation } from '../../src/agent/conversation-feedback.js';
import { createLearningDecisionEvidenceReader } from '../../src/agent/learning-decision-evidence.js';
import { isExplicitStandingConversationInstruction, validateConversationFeedbackClaim, type ConversationFeedbackInterpretation } from '../../src/agent/conversation-feedback-contract.js';
import { buildConversationDecisionPayloads, buildConversationSelectionPayload, selectConversationReply,
  type ConversationReplyProposal } from '../../src/agent/conversation-judgment.js';
import { readSeedLearning, emptyLearningState } from '../../shared/seed-learning.cjs';
import { SeedProcess } from '../../substrate/src/seed.js';
import { EventLedgerTailAdapter } from '../../substrate/src/adapters/event-ledger-tail.js';

const originalText = 'I finally got a quiet afternoon to play music.';
const ownerText = 'Stop jumping straight into advice. Your reply was too long.';
const proposal: ConversationReplyProposal = { schema: 'home23.conversation-proposal.v1', route: 'conversation', situation: 'sharing', feedback: [],
  candidates: [
    { id: 'a', reply: 'That sounds like a welcome break. One option would be to set aside another afternoon for music and choose a few songs to explore.',
      axes: { engagement: 'analyze', initiative: 'offer_next_step', continuity: 'present_only', depth: 'developed' } },
    { id: 'b', reply: 'A quiet afternoon and some music sounds lovely. What did you end up playing?',
      axes: { engagement: 'explore', initiative: 'ask_followup', continuity: 'present_only', depth: 'brief' } },
  ] };

async function fixture(t: { after(fn: () => void): void }, feedbackText = ownerText) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-conduct-feedback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const brain = path.join(root, 'brain');
  const ledger = new EventLedger(brain);
  const ledgerPath = path.join(brain, 'event-ledger.jsonl');
  const contactPath = path.join(root, 'contact.jsonl');
  const seedDir = path.join(root, 'seed');
  let seed = SeedProcess.initialize(seedDir);
  const selected = selectConversationReply(proposal, { ...emptyLearningState(), available: true });
  const context = { selectionId: 'reply:original', turnId: 'turn:original', messageRef: 'turn:original:user',
    conversationRef: 'coordination:owner-channel', provider: 'fixture', model: 'recorded-fixture', originMessageId: 'owner-original' };
  const payload = buildConversationSelectionPayload(selected, context);
  const decisions = buildConversationDecisionPayloads(selected, context);
  const occurredAt = '2026-10-30T16:00:00.000Z';
  const emit = (event_type: string, event_id: string, value: object) => ledger.emitDurable({
    event_type, event_id, actor: 'conversation', session_id: 'native-original', timestamp: occurredAt,
    payload: value as Record<string, unknown>,
  });
  emit('ConversationReplySelected', 'selected:original', payload);
  for (const decision of decisions) emit('LearningDecisionObserved', decision.decisionId, decision);
  emit('ConversationReplyCompleted', 'completed:original', { schema: 'home23.conversation-completion.v1', status: 'complete',
    selectionId: context.selectionId, turnId: context.turnId, conversationRef: context.conversationRef,
    responseHash: selected.responseHash, candidateSetHash: selected.candidateSetHash,
    decisionIds: decisions.map(item => item.decisionId), originMessageId: context.originMessageId });
  const contact = (messageId: string, role: 'user' | 'assistant', content: string, sourceSequence: number, replyToMessageId?: string) => ({
    schema: 'home23.resident.contact.v1', contactId: `message:${messageId}`, sourceRef: `coordination.message:${messageId}`,
    sourceSequence, channelId: 'owner-channel', session: context.conversationRef, conversationId: 'conversation', messageId,
    actor: { principalId: role === 'user' ? 'owner' : 'resident', kind: role === 'user' ? 'owner' : 'bot' },
    voice: role === 'user' ? 'jtr' : 'self', role, content, channelKind: 'direct', ts: occurredAt,
    ...(replyToMessageId ? { replyToMessageId } : {}),
  });
  const contacts = [contact('owner-original', 'user', originalText, 1),
    contact('reply-original', 'assistant', selected.selected.reply, 2, 'owner-original'),
    contact('owner-feedback', 'user', feedbackText, 4)];
  const writeContacts = () => fs.writeFileSync(contactPath, contacts.map(row => JSON.stringify(row)).join('\n') + '\n');
  writeContacts();
  const adapter = new EventLedgerTailAdapter({ sourcePath: ledgerPath, cursorDir: path.join(root, 'events-cursor'), fromEnd: false });
  for (const event of adapter.pullSync()) { seed.transition(event); adapter.commit(event.endOffset); }
  seed.checkpoint();
  const owner = { chatId: 'native-feedback', messageRef: 'turn:feedback:user', text: feedbackText };
  let authorizations = 0;
  const relationshipLedger = new RelationshipLedger(brain, { validateCorrectionIngress: value => {
    authorizations++;
    return authorizations === 1 && value.chatId === owner.chatId && value.messageRef === owner.messageRef && value.userText === owner.text;
  } });
  const read = () => readPriorDeliveredConversation({ ledgerPath, contactPath, conversationRef: context.conversationRef,
    currentMessageId: 'owner-feedback' });
  const feedback = [
    { decisionId: 'reply:original:initiative', quote: 'Stop jumping straight into advice.', direction: 'attenuate', standing: true },
    { decisionId: 'reply:original:depth', quote: 'Your reply was too long.', direction: 'attenuate' },
  ];
  const pullTeaching = () => {
    const teaching = new EventLedgerTailAdapter({ sourcePath: path.join(brain, 'relationship-ledger.events.jsonl'),
      sourceType: 'relationship-ledger', cursorDir: path.join(root, 'relationship-cursor'), fromEnd: false });
    for (const event of teaching.pullSync()) { seed.transition(event); teaching.commit(event.endOffset); }
    seed.checkpoint(); seed = SeedProcess.restore(seedDir);
  };
  return { root, brain, seedDir, ledgerPath, contactPath, selected, decisions, context, owner, relationshipLedger,
    read, feedback, contacts, contact, writeContacts, pullTeaching, authorizations: () => authorizations };
}

test('authentic multi-dimension conversation feedback changes the next delivered-text selection through real Seed', async t => {
  const f = await fixture(t);
  const prior = await f.read();
  assert.ok(prior);
  const result = applyConversationFeedback({ proposals: f.feedback, owner: f.owner, prior,
    relationshipLedger: f.relationshipLedger, seedStateDir: f.seedDir });
  assert.equal(result.status, 'source_recorded', JSON.stringify(result));
  assert.equal(result.seedApplication, 'not_yet_confirmed');
  assert.equal(result.projected, 2);
  assert.equal(f.authorizations(), 1, 'the whole encounter consumes one token');
  const entry = f.relationshipLedger.listEntries()[0]!;
  assert.equal(entry.statement, ownerText);
  assert.equal(entry.learning_batch?.length, 2);
  assert.equal(entry.learning, undefined);
  assert.match(entry.evidence_note!, /model interpretation/);
  f.pullTeaching();
  const learned = readSeedLearning(f.seedDir);
  const lessons = learned.lessons.filter(lesson => lesson.scope.startsWith('foreground.conduct.'));
  assert.equal(lessons.length, 2);
  assert.deepEqual(lessons.map(lesson => lesson.lessonId).sort(), result.lessonIds!.sort());
  assert.ok(lessons.every(lesson => lesson.authority === 'owner' && lesson.value === -0.25));
  const historyBefore = fs.readFileSync(path.join(f.seedDir, 'seed-ledger.jsonl'));
  const actual = selectConversationReply(proposal, learned);
  assert.equal(actual.selected.id, 'b');
  assert.equal(actual.selected.reply, proposal.candidates[1]!.reply);
  assert.equal(actual.counterfactual.selectedId, 'a');
  assert.equal(actual.counterfactual.changed, true);
  assert.deepEqual(fs.readFileSync(path.join(f.seedDir, 'seed-ledger.jsonl')), historyBefore);
  const retried = applyConversationFeedback({ proposals: f.feedback, owner: f.owner, prior,
    relationshipLedger: f.relationshipLedger, seedStateDir: f.seedDir });
  assert.equal(retried.status, 'source_recorded', JSON.stringify(retried));
  assert.deepEqual(retried.projectionIds, result.projectionIds);
  assert.equal(f.authorizations(), 1);
  assert.equal(f.relationshipLedger.listEntries().length, 1);
  assert.equal(fs.readFileSync(path.join(f.brain, 'relationship-ledger.events.jsonl'), 'utf8').trim().split('\n').length, 2);
});

test('harness completion alone and mismatched canonical output cannot earn feedback', async t => {
  const f = await fixture(t);
  const original = f.contacts[1]!;
  f.contacts.splice(1, 1); f.writeContacts();
  assert.equal(await f.read(), null);
  f.contacts.splice(1, 0, { ...original, content: 'A different actual reply.' }); f.writeContacts();
  assert.equal(await f.read(), null);
  f.contacts[1] = { ...original, replyToMessageId: 'different-origin' }; f.writeContacts();
  assert.equal(await f.read(), null);
  f.contacts[1] = { ...original, channelKind: 'group' }; f.writeContacts();
  assert.equal(await f.read(), null);
  assert.equal(f.authorizations(), 0);
});

test('readback proves actual response separately from context admission, with exact canonical source', async t => {
  const f = await fixture(t);
  const reader = createLearningDecisionEvidenceReader(f.ledgerPath, { contactPath: f.contactPath });
  const evidence = await reader(f.decisions);
  for (const decision of f.decisions) {
    const value = evidence[decision.decisionId]!;
    assert.equal(value.status, 'verified');
    if (value.status !== 'verified') continue;
    assert.equal(value.behavior.kind, 'conversation-response');
    assert.equal(value.delivery.status, 'observed');
    assert.equal(value.delivery.messageRef, 'coordination.message:reply-original');
    assert.equal(value.delivery.responseHash, f.selected.responseHash);
  }
  const unavailable = await createLearningDecisionEvidenceReader(f.ledgerPath)(f.decisions);
  assert.equal(unavailable[f.decisions[0]!.decisionId]!.status, 'verified');
  const value = unavailable[f.decisions[0]!.decisionId]!;
  if (value.status === 'verified') assert.equal(value.delivery.status, 'unavailable');
});

test('newer ordinary reply, missing current owner source, duplicate source and torn tails refuse attribution', async t => {
  const f = await fixture(t);
  f.contacts.splice(2, 0, f.contact('ordinary', 'assistant', 'A newer normal answer.', 3, 'other-owner'));
  f.writeContacts(); assert.equal(await f.read(), null);
  f.contacts.splice(2, 1); f.contacts.pop(); f.writeContacts(); assert.equal(await f.read(), null);
  f.contacts.push(f.contact('owner-feedback', 'user', ownerText, 4));
  f.contacts.push({ ...f.contacts[1]! }); f.writeContacts(); assert.equal(await f.read(), null);
  f.contacts.pop(); f.writeContacts();
  fs.appendFileSync(f.ledgerPath, '{"partial":'); assert.equal(await f.read(), null);
});

test('trusted Core current contact closes projection lag only with its exact preceding assistant identity', async t => {
  const f = await fixture(t);
  f.contacts.pop(); f.writeContacts();
  const input = { ledgerPath: f.ledgerPath, contactPath: f.contactPath, conversationRef: f.context.conversationRef,
    currentMessageId: 'owner-feedback', currentOwner: { messageRef: 'coordination.message:owner-feedback',
      text: ownerText, sourceSequence: 4, previousAssistantMessageId: 'reply-original' } };
  assert.ok(await readPriorDeliveredConversation(input));
  assert.equal(await readPriorDeliveredConversation({ ...input, currentOwner: { ...input.currentOwner,
    previousAssistantMessageId: 'newer-not-yet-projected' } }), null);
  assert.equal(await readPriorDeliveredConversation({ ...input, currentOwner: { ...input.currentOwner,
    previousAssistantMessageId: null } }), null);
  f.contacts.push(f.contact('owner-feedback', 'user', 'Conflicting owner words', 4)); f.writeContacts();
  assert.equal(await readPriorDeliveredConversation(input), null);
  f.contacts.push(f.contact('owner-feedback', 'user', ownerText, 4)); f.writeContacts();
  assert.equal(await readPriorDeliveredConversation(input), null, 'trusted metadata cannot erase a contradictory duplicate source');
});

test('invalid batch does not spend correction authority or write partial teaching', async t => {
  const f = await fixture(t);
  const prior = await f.read();
  assert.ok(prior);
  for (const proposals of [
    [...f.feedback, f.feedback[0]],
    [f.feedback[0], { ...f.feedback[1], decisionId: 'other:depth' }],
    [f.feedback[0], { ...f.feedback[1], quote: 'Invented owner criticism' }],
    [f.feedback[0], { ...f.feedback[1], direction: 'reinforce' }],
    [f.feedback[0], { ...f.feedback[1], conditions: ['only during music'] }],
    [f.feedback[0], { ...f.feedback[1], standing: true }],
  ]) {
    const result = applyConversationFeedback({ proposals, prior, owner: f.owner,
      relationshipLedger: f.relationshipLedger, seedStateDir: f.seedDir });
    assert.equal(result.status, 'refused', JSON.stringify(result));
  }
  assert.equal(f.authorizations(), 0);
  assert.equal(f.relationshipLedger.listEntries().length, 0);
});

test('source batch cannot grow or change after the authenticated encounter was spent', async t => {
  const f = await fixture(t);
  const prior = await f.read();
  const args = { prior, owner: f.owner, relationshipLedger: f.relationshipLedger, seedStateDir: f.seedDir };
  const first = applyConversationFeedback({ ...args, proposals: [f.feedback[0]] });
  assert.equal(first.status, 'source_recorded');
  const changed = applyConversationFeedback({ ...args, proposals: f.feedback });
  assert.equal(changed.status, 'refused');
  assert.match(changed.reason!, /already spent/);
  assert.equal(f.authorizations(), 1);
  assert.equal(f.relationshipLedger.listEntries()[0]!.learning_batch?.length, 1);
  const replayedCanonical = applyConversationFeedback({ ...args, owner: { ...f.owner, messageRef: 'different:turn:user' },
    proposals: [f.feedback[0]] });
  assert.equal(replayedCanonical.status, 'refused');
  assert.equal(f.authorizations(), 1, 'new transport turn cannot spend the same canonical owner encounter again');
});

test('generic gratitude, reported speech, hypothetical, conditional and verification statements abstain', () => {
  const base: ConversationFeedbackInterpretation = { decisionId: 'decision', axis: 'initiative', value: 'offer_next_step',
    situation: 'sharing', quote: '', direction: 'attenuate', standing: false, conditions: [], supersedes: [] };
  for (const value of [
    { text: 'Thanks!', direction: 'reinforce' },
    { text: 'I love my guitar.', direction: 'reinforce' },
    { text: 'My friend said stop giving advice.', direction: 'attenuate' },
    { text: 'Imagine I said stop giving advice.', direction: 'attenuate' },
    { text: 'Stop giving advice unless I ask.', direction: 'attenuate' },
    { text: 'Codex verifying this: stop giving advice.', direction: 'attenuate' },
    { text: 'That advice was not helpful.', direction: 'reinforce' },
    { text: "Your advice wasn't helpful.", direction: 'reinforce' },
    { text: 'Your advice wasn’t helpful.', direction: 'reinforce' },
  ]) assert.ok(validateConversationFeedbackClaim(value.text, { ...base, quote: value.text,
    direction: value.direction as 'attenuate' | 'reinforce' }), value.text);
  assert.equal(validateConversationFeedbackClaim('Your advice was helpful.', { ...base,
    quote: 'Your advice was helpful.', direction: 'reinforce' }), null);
});

test('ordinary situation conditions and quotes of the actual delivered reply retain honest attribution', async t => {
  const text = 'When I share something, stop giving advice.';
  const f = await fixture(t, text);
  const condition = { decisionId: 'reply:original:initiative', quote: text, direction: 'attenuate',
    standing: true, conditions: ['When I share something'] };
  const result = applyConversationFeedback({ proposals: [condition], prior: await f.read(), owner: f.owner,
    relationshipLedger: f.relationshipLedger, seedStateDir: f.seedDir });
  assert.equal(result.status, 'source_recorded', JSON.stringify(result));
  assert.deepEqual(f.relationshipLedger.listEntries()[0]!.learning_batch![0]!.tags,
    ['situation:sharing', 'choice:offer_next_step']);

  const quoteText = 'You said “That sounds like a welcome break.” Stop offering advice.';
  const q = await fixture(t, quoteText);
  const quoteResult = applyConversationFeedback({ proposals: [{ decisionId: 'reply:original:initiative', quote: 'Stop offering advice.',
    direction: 'attenuate', standing: true }], prior: await q.read(), owner: q.owner,
    relationshipLedger: q.relationshipLedger, seedStateDir: q.seedDir });
  assert.equal(quoteResult.status, 'source_recorded', JSON.stringify(quoteResult));
  assert.equal(q.relationshipLedger.listEntries()[0]!.statement, quoteText);
});

test('condition truncation, wrong situation and quoted instructions cannot be laundered as owner feedback', () => {
  const base: ConversationFeedbackInterpretation = { decisionId: 'decision', axis: 'initiative', value: 'offer_next_step',
    situation: 'sharing', quote: 'Stop giving advice.', direction: 'attenuate', standing: true, conditions: [], supersedes: [] };
  for (const [owner, conditions] of [
    ['When I share something upsetting, Stop giving advice.', ['When I share something']],
    ['When I share something, Stop giving advice.', []],
    ["When I'm weighing a choice, Stop giving advice.", ["When I'm weighing a choice"]],
    ['When I share something, Stop giving advice. Unless I ask.', ['When I share something']],
  ] as const) assert.ok(validateConversationFeedbackClaim(owner, { ...base, conditions: [...conditions] }), owner);
  for (const owner of ["You said 'Stop giving advice.'", 'You said “Stop giving advice.”', 'My friend said “Stop giving advice.”']) {
    assert.ok(validateConversationFeedbackClaim(owner, { ...base, quote: owner }, 'Stop giving advice.'), owner);
  }
});

test('negation and reported evaluations cannot reverse the owner meaning through a trimmed quote', () => {
  const base: ConversationFeedbackInterpretation = { decisionId: 'decision', axis: 'initiative', value: 'ask_followup',
    situation: 'sharing', quote: '', direction: 'attenuate', standing: false, conditions: [], supersedes: [] };
  for (const [owner, quote, direction] of [
    ['I do not think your question was helpful.', 'your question was helpful', 'reinforce'],
    ["Don't stop asking me questions.", "Don't stop asking me questions.", 'attenuate'],
    ["I don't want you to stop asking questions.", "I don't want you to stop asking questions.", 'attenuate'],
    ['Your question was not too much.', 'Your question was not too much.', 'attenuate'],
    ['My brother thinks your questions are unnecessary.', 'My brother thinks your questions are unnecessary.', 'attenuate'],
    ['Yesterday you said you should stop asking me questions.', 'Yesterday you said you should stop asking me questions.', 'attenuate'],
    ['Your questions are good; never stop asking them.', 'Your questions are good; never stop asking them.', 'attenuate'],
    ['Stop giving advice and ask questions.', 'Stop giving advice and ask questions.', 'attenuate'],
    ["Your questions aren't unhelpful.", "Your questions aren't unhelpful.", 'attenuate'],
    ['Your questions aren’t unhelpful.', 'Your questions aren’t unhelpful.', 'attenuate'],
    ["You shouldn't ask fewer questions.", "You shouldn't ask fewer questions.", 'attenuate'],
    ["Your questions aren't horrible.", "Your questions aren't horrible.", 'attenuate'],
  ] as const) assert.ok(validateConversationFeedbackClaim(owner, { ...base, quote, direction }), owner);
  const mixed = 'Less generic acknowledgement, more thoughtful questions.';
  assert.ok(validateConversationFeedbackClaim(mixed, { ...base, quote: mixed, axis: 'engagement', value: 'acknowledge', direction: 'reinforce' }));
  assert.equal(validateConversationFeedbackClaim("Your question wasn't helpful.", { ...base, quote: "Your question wasn't helpful." }), null);
});

test('batch source survives failed projection and restart without duplicate credit or reauthentication', async t => {
  const f = await fixture(t);
  const eventsPath = path.join(f.brain, 'relationship-ledger.events.jsonl');
  fs.mkdirSync(eventsPath);
  const result = applyConversationFeedback({ proposals: f.feedback, prior: await f.read(), owner: f.owner,
    relationshipLedger: f.relationshipLedger, seedStateDir: f.seedDir });
  assert.equal(result.status, 'source_recorded');
  assert.equal(result.projected, 0);
  assert.equal(result.pending, 2);
  assert.equal(f.authorizations(), 1);
  const source = JSON.parse(fs.readFileSync(path.join(f.brain, 'relationship-ledger.json'), 'utf8'));
  assert.equal(source.entries.length, 1);
  assert.equal(source.entries[0].seed_projections.length, 2);
  fs.rmdirSync(eventsPath);
  const restored = new RelationshipLedger(f.brain);
  assert.deepEqual(restored.flushSeedTeaching(), { projected: 2, pending: 0 });
  // Crash after append/fsync and before acknowledgement: replay uses same IDs.
  fs.writeFileSync(path.join(f.brain, 'relationship-ledger.json'), JSON.stringify(source));
  assert.deepEqual(new RelationshipLedger(f.brain).flushSeedTeaching(), { projected: 2, pending: 0 });
  assert.equal(fs.readFileSync(eventsPath, 'utf8').trim().split('\n').length, 2);
  f.pullTeaching();
  assert.equal(readSeedLearning(f.seedDir).lessons.filter(item => item.scope.startsWith('foreground.conduct.')).length, 2);
});

test('legacy single-note tools cannot bypass new conversational delivery and batch guards', async t => {
  const f = await fixture(t);
  const result = await relationshipNoteTool.execute({ type: 'attenuation', title: 'Advice', statement: ownerText,
    learning: { schema: 'home23.learning-feedback.v1', decisionId: 'reply:original:initiative',
      scope: 'foreground.conduct.initiative', direction: 'attenuate', tags: ['situation:sharing', 'choice:offer_next_step'],
      basis: 'owner-feedback', evidenceRefs: [f.owner.messageRef] } }, {
    chatId: f.owner.chatId, authenticatedUserMessage: f.owner, relationshipLedger: f.relationshipLedger,
    seedStateDir: f.seedDir,
  } as never);
  assert.equal(result.is_error, true);
  assert.match(result.content, /conversation_feedback_requires_delivered_reply/);
  assert.equal(f.authorizations(), 0);
});

test('lifecycle tools cannot silently erase or partially replace an authenticated feedback batch', async t => {
  const f = await fixture(t);
  const result = applyConversationFeedback({ proposals: f.feedback, prior: await f.read(), owner: f.owner,
    relationshipLedger: f.relationshipLedger, seedStateDir: f.seedDir });
  assert.equal(result.status, 'source_recorded');
  for (const action of ['remove', 'resolve', 'supersede']) {
    const update = await relationshipUpdateTool.execute({ id: result.entryId, action, statement: 'Different feedback' }, {
      chatId: f.owner.chatId, relationshipLedger: f.relationshipLedger,
    } as never);
    assert.equal(update.is_error, true);
  }
  assert.equal(f.relationshipLedger.getEntry(result.entryId!)?.status, 'active');
  assert.equal(f.authorizations(), 1);
});

test('source preflight uses the exact anchored cell budget and refuses a whole over-capacity batch before authority', async t => {
  const writeSnapshot = (dir: string, development: object) => {
    // Isolated read-model fixture, never a live Seed mutation.
    fs.rmSync(path.join(dir, 'checkpoints'), { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'checkpoints'));
    const sha = (value: string) => createHash('sha256').update(value).digest('hex');
    const stateHash = sha(JSON.stringify({ cells: [], dispositions: {}, development }));
    const line = JSON.stringify({ seq: 1, prevHash: '0'.repeat(64), category: 'genesis', payload: {}, stateHashAfter: stateHash });
    fs.writeFileSync(path.join(dir, 'seed-ledger.jsonl'), line + '\n');
    fs.writeFileSync(path.join(dir, 'checkpoints', 'ckpt_0001.json'), JSON.stringify({ version: 2,
      cells: [], dispositions: {}, stateHash, ledgerSeq: 1, ledgerCursor: sha(line), development }));
  };
  const unrelatedLessons = Array.from({ length: 64 }, (_, i) => ({ lessonId: `unrelated:${i}`, scope: 'execution:other',
    tags: [`target:${i}`], excludes: [], sourceRefs: [`source:${i}`], value: 0.25, active: true,
    authority: 'provisional', criterion: 'execution', basis: 'verified-outcome', createdAt: '2026-10-30T15:00:00Z', corroborations: 0 }));
  const unrelatedDecisions = Array.from({ length: 32 }, (_, i) => ({ schema: 'home23.learning-decision.v1',
    decisionId: `other:${i}`, scope: 'execution:other', tags: [`target:${i}`], sourceRefs: [`source:${i}`], criterion: 'execution' }));
  const f = await fixture(t);
  const original = readSeedLearning(f.seedDir);
  const cell = original.conductAnchorCellId!;
  assert.ok(cell);
  writeSnapshot(f.seedDir, { [cell]: { experience: { ...emptyLearningState(), conductAnchor: true, decisions: original.decisions } },
    'other.cell': { experience: { ...emptyLearningState(), decisions: unrelatedDecisions, lessons: unrelatedLessons } } });
  const result = applyConversationFeedback({ proposals: f.feedback, prior: await f.read(), owner: f.owner,
    relationshipLedger: f.relationshipLedger, seedStateDir: f.seedDir });
  assert.equal(result.status, 'source_recorded', JSON.stringify(result));

  const capped = await fixture(t);
  const retained = readSeedLearning(capped.seedDir);
  writeSnapshot(capped.seedDir, { [retained.conductAnchorCellId!]: { experience: { ...emptyLearningState(), conductAnchor: true,
    decisions: retained.decisions, lessons: unrelatedLessons.slice(0, 63) } } });
  const rejected = applyConversationFeedback({ proposals: capped.feedback, prior: await capped.read(), owner: capped.owner,
    relationshipLedger: capped.relationshipLedger, seedStateDir: capped.seedDir });
  assert.equal(rejected.status, 'refused');
  assert.match(rejected.reason!, /lesson_capacity/);
  assert.equal(capped.authorizations(), 0);
  assert.equal(capped.relationshipLedger.listEntries().length, 0);
});

test('model omission cannot downgrade explicit ongoing owner instructions into incidental feedback', async t => {
  for (const declaredStanding of [undefined, false]) {
    const text = 'Please stop offering advice.';
    const f = await fixture(t, text);
    const result = applyConversationFeedback({ proposals: [{ decisionId: 'reply:original:initiative', quote: text,
      direction: 'attenuate', ...(declaredStanding === undefined ? {} : { standing: declaredStanding }) }],
    prior: await f.read(), owner: f.owner, relationshipLedger: f.relationshipLedger, seedStateDir: f.seedDir });
    assert.equal(result.status, 'source_recorded', JSON.stringify(result));
    assert.equal(f.relationshipLedger.listEntries()[0]!.learning_batch![0]!.standing, true);
    f.pullTeaching();
    assert.equal(readSeedLearning(f.seedDir).lessons.find(item => item.scope === 'foreground.conduct.initiative')?.standing, true);
  }
  assert.equal(isExplicitStandingConversationInstruction('I liked how you kept asking questions.'), false);
  assert.equal(isExplicitStandingConversationInstruction('Your questions were helpful.'), false);
  const descriptive = 'I liked how you keep asking questions.';
  assert.equal(validateConversationFeedbackClaim(descriptive, { decisionId: 'selected:initiative', axis: 'initiative',
    value: 'ask_followup', situation: 'reflection', quote: descriptive, direction: 'reinforce',
    standing: true, conditions: [], supersedes: [] }), 'standing_instruction_not_explicit');
  const directive = 'Please stop asking me questions.';
  assert.equal(validateConversationFeedbackClaim(directive, { decisionId: 'selected:initiative', axis: 'initiative',
    value: 'ask_followup', situation: 'reflection', quote: directive, direction: 'attenuate',
    standing: false, conditions: [], supersedes: [] }), 'standing_instruction_annotation_missing');
});
