import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  applyLearningFeedback, emptyLearningState, recordLearningDecision,
  type LearningSnapshot, type LearningState,
} from '../../shared/seed-learning.cjs';
import {
  CONDUCT_AXES, CONVERSATION_PROPOSAL_LIMITS, buildConversationDecisionPayloads,
  buildConversationProposalPrompt, buildConversationSelectionPayload,
  conversationCandidateSetHash, conversationResponseHash, parseConversationProposal, selectConversationReply,
  type ConductAxis, type ConductAxes, type ConversationReplyProposal,
} from '../../src/agent/conversation-judgment.js';

const context = {
  selectionId: 'conversation-choice:original', turnId: 'turn:original', messageRef: 'owner:original',
  conversationRef: 'conversation:direct', originMessageId: 'message:original', provider: 'fixture', model: 'recorded-replies',
};
const baseAxes: ConductAxes = { engagement: 'analyze', initiative: 'offer_next_step', continuity: 'present_only', depth: 'brief' };
function proposal(overrides: Partial<ConversationReplyProposal> = {}): ConversationReplyProposal {
  return {
    schema: 'home23.conversation-proposal.v1', route: 'conversation', situation: 'sharing', candidates: [
      { id: 'analysis', reply: 'Finishing it suggests the practice was effective. You could record what worked.', axes: { ...baseAxes } },
      { id: 'engage', reply: 'You stayed with that difficult passage and finally got through it. What felt different this time?',
        axes: { engagement: 'explore', initiative: 'ask_followup', continuity: 'present_only', depth: 'developed' } },
      { id: 'acknowledge', reply: 'That sounds like a satisfying moment after all that practice.',
        axes: { engagement: 'acknowledge', initiative: 'stay_with', continuity: 'present_only', depth: 'brief' } },
    ], feedback: [], ...overrides,
  };
}
const snapshot = (state: LearningState = emptyLearningState()): LearningSnapshot => ({
  version: 1, available: true, seq: 20, decisions: state.decisions, lessons: state.lessons,
});
function teach(axis: ConductAxis, direction: 'attenuate' | 'reinforce', original = proposal()) {
  const selected = selectConversationReply(original, snapshot());
  const decisions = buildConversationDecisionPayloads(selected, context);
  let state = emptyLearningState();
  for (const decision of decisions) {
    const recorded = recordLearningDecision(state, { ...decision, observedAt: '2026-01-01T11:59:00.000Z',
      occurrence: { stream: 'fixture-harness', sequence: state.decisions.length + 1 } });
    assert.equal(recorded.applied, true);
    state = recorded.state;
  }
  const decision = decisions.find(item => item.behavior.axis === axis)!;
  const feedback = applyLearningFeedback(state, {
    schema: 'home23.learning-feedback.v1', decisionId: decision.decisionId, scope: decision.scope,
    direction, tags: decision.tags, excludes: [], evidenceRefs: ['owner:explicit-feedback'],
    basis: 'owner-feedback', supersedes: [], corroborates: [], standing: true,
  }, { feedbackId: 'relationship:explicit-feedback', observedAt: '2026-01-01T12:00:00.000Z', ownerAuthenticated: true });
  assert.equal(feedback.applied, true, feedback.reason);
  return { learned: snapshot(feedback.state), lesson: feedback.lesson!, original: selected };
}

test('real Seed feedback changes the complete selected reply while candidate facts and history remain fixed', () => {
  const { learned, lesson } = teach('engagement', 'attenuate');
  const next = proposal();
  const originalBytes = JSON.stringify({ next, learned });
  const selected = selectConversationReply(next, learned);
  assert.equal(selected.baseline.id, 'analysis');
  assert.equal(selected.selected.id, 'engage');
  assert.equal(selected.selected.reply, next.candidates[1]!.reply);
  assert.equal(selected.responseHash, createHash('sha256').update(next.candidates[1]!.reply).digest('hex'));
  assert.deepEqual(selected.lessonIds, [lesson.lessonId]);
  assert.deepEqual(selected.counterfactual, { omittedLessonIds: [lesson.lessonId], selectedId: 'analysis',
    responseHash: conversationResponseHash(next.candidates[0]!.reply), changed: true });
  const ablated = selectConversationReply(next, { ...learned, lessons: learned.lessons.filter(item => item.lessonId !== lesson.lessonId) });
  assert.equal(ablated.selected.reply, next.candidates[0]!.reply);
  assert.equal(selected.candidateSetHash, ablated.candidateSetHash);
  assert.equal(JSON.stringify({ next, learned }), originalBytes, 'selection and ablation never mutate source learning or candidates');
});

test('topic-independent stable tags transfer a scoped lesson to a different actual response', () => {
  const { learned } = teach('engagement', 'attenuate');
  const next = proposal();
  next.candidates[0]!.reply = 'Your garden grew because the growing conditions were favorable.';
  next.candidates[1]!.reply = 'The first ripe tomato after tending the garden all summer is a lovely milestone. How did it taste?';
  next.candidates[2]!.reply = 'The first tomato is ready. That sounds satisfying.';
  const result = selectConversationReply(next, learned);
  assert.equal(result.selected.id, 'engage');
  const witnesses = buildConversationDecisionPayloads(result, { ...context, selectionId: 'conversation-choice:next', messageRef: 'owner:next' });
  for (const witness of witnesses) {
    assert.deepEqual(witness.tags, [`situation:sharing`, `choice:${witness.behavior.value}`]);
    assert.ok(!witness.tags.some(tag => /garden|tomato|turn|owner/.test(tag)));
  }
});

for (const axis of Object.keys(CONDUCT_AXES) as ConductAxis[]) {
  test(`independent ${axis} learning affects selection without requiring the other axis combination`, () => {
    const firstValue = CONDUCT_AXES[axis][0];
    const secondValue = CONDUCT_AXES[axis][1];
    const original = proposal();
    original.candidates[0]!.axes = { ...baseAxes, [axis]: firstValue };
    original.candidates = [original.candidates[0]!, { id: 'other', reply: 'A different complete and responsive answer.',
      axes: { ...baseAxes, [axis]: secondValue } }];
    const { learned } = teach(axis, 'attenuate', original);
    const result = selectConversationReply(original, learned);
    assert.equal(result.selected.id, 'other');
    const effects = result.evaluations[0]!.axes.filter(item => item.evaluation.adjustment !== 0);
    assert.deepEqual(effects.map(item => item.axis), [axis]);
    assert.equal(result.evaluations[0]!.score, -0.04999999999999999);
  });
}

test('positive owner feedback promotes a previously delivered approach over a new baseline', () => {
  const original = proposal();
  [original.candidates[0], original.candidates[1]] = [original.candidates[1]!, original.candidates[0]!];
  const { learned } = teach('engagement', 'reinforce', original);
  const next = proposal();
  const result = selectConversationReply(next, learned);
  assert.equal(result.selected.id, 'engage');
  assert.equal(result.counterfactual.selectedId, 'analysis');
  assert.equal(result.evaluations[1]!.axes.find(item => item.axis === 'engagement')!.evaluation.adjustment, 0.25);
});

test('different situation and unrelated read-procedure scope cannot alter conversational conduct', () => {
  const { learned } = teach('engagement', 'attenuate');
  const different = selectConversationReply(proposal({ situation: 'deliberation' }), learned);
  assert.equal(different.selected.id, 'analysis');
  assert.deepEqual(different.lessonIds, []);
  const unrelated = selectConversationReply(proposal(), { ...learned, lessons: learned.lessons.map(lesson => ({ ...lesson, scope: 'execution.read_file' })) });
  assert.equal(unrelated.selected.id, 'analysis');
  assert.deepEqual(unrelated.lessonIds, []);
});

test('unavailable or malformed committed projection leaves ordinary baseline available without learned authority', () => {
  const { learned } = teach('engagement', 'attenuate');
  for (const unavailable of [
    { ...learned, available: false },
    { ...learned, lessons: undefined } as unknown as LearningSnapshot,
    { ...learned, lessons: learned.lessons.map(lesson => ({ ...lesson, value: NaN })) },
    { ...learned, lessons: learned.lessons.map(lesson => ({ ...lesson, tags: 'bad' })) } as unknown as LearningSnapshot,
  ]) {
    const result = selectConversationReply(proposal(), unavailable);
    assert.equal(result.selected.id, 'analysis');
    assert.equal(result.available, false);
    assert.deepEqual(result.lessonIds, []);
    assert.equal(result.counterfactual.changed, false);
  }
});

test('retired lessons have no effect and selected score never suppresses a response', () => {
  const { learned } = teach('engagement', 'attenuate');
  const retired = selectConversationReply(proposal(), { ...learned, lessons: learned.lessons.map(lesson => ({ ...lesson, active: false })) });
  assert.equal(retired.selected.id, 'analysis');
  const allNegative = { ...learned, lessons: proposal().candidates.map((candidate, i) => ({ ...learned.lessons[0]!,
    lessonId: `lesson_${i}`, value: -0.75, tags: ['situation:sharing', `choice:${candidate.axes.engagement}`] })) };
  const result = selectConversationReply(proposal(), allNegative);
  assert.ok(result.evaluations.every(candidate => candidate.score < 0));
  assert.equal(result.selected.id, 'analysis');
  assert.ok(result.selected.reply.length > 0);
});

test('counterfactual removes exactly matched contributions across alternatives, leaving unrelated lessons intact', () => {
  const { learned, lesson } = teach('engagement', 'attenuate');
  const irrelevant = { ...lesson, lessonId: 'lesson_unrelated', scope: 'foreground.context', tags: ['operational'] };
  const other = { ...lesson, lessonId: 'lesson_other_candidate', value: 0.25,
    tags: ['situation:sharing', 'choice:acknowledge'] };
  const expanded = { ...learned, lessons: [...learned.lessons, irrelevant, other] };
  const result = selectConversationReply(proposal(), expanded);
  assert.equal(result.selected.id, 'acknowledge');
  assert.deepEqual(result.lessonIds, [lesson.lessonId, other.lessonId].sort());
  assert.ok(!result.counterfactual.omittedLessonIds.includes(irrelevant.lessonId));
  assert.equal(expanded.lessons.length, 3);
});

test('prospective evidence records only selected axes and references one exact candidate set', () => {
  const selected = selectConversationReply(proposal(), snapshot());
  const evidence = buildConversationSelectionPayload(selected, context);
  const decisions = buildConversationDecisionPayloads(selected, context);
  assert.equal(evidence.schema, 'home23.conversation-selection.v1');
  assert.equal(evidence.originMessageId, context.originMessageId);
  assert.equal(evidence.selectedReply, selected.selected.reply);
  assert.deepEqual(evidence.candidates, selected.proposal.candidates);
  assert.equal(decisions.length, 4);
  assert.deepEqual(evidence.decisionIds, decisions.map(item => item.decisionId));
  for (const decision of decisions) {
    assert.equal(decision.criterion, 'owner-value');
    assert.equal(decision.choice, selected.selected.axes[decision.behavior.axis]);
    assert.equal(decision.behavior.responseHash, evidence.responseHash);
    assert.equal(decision.behavior.candidateSetHash, evidence.candidateSetHash);
    assert.deepEqual(decision.sourceRefs, [context.messageRef, context.conversationRef, context.selectionId]);
    assert.equal('reply' in decision, false);
    assert.equal('delivered' in decision, false);
    assert.equal('candidates' in decision, false);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(evidence)) <= CONVERSATION_PROPOSAL_LIMITS.receiptBytes);
});

test('candidate set hashing preserves order, exact reply bytes and annotations but excludes untrusted feedback', () => {
  const original = proposal();
  const expected = conversationCandidateSetHash(original);
  assert.equal(conversationCandidateSetHash({ ...original, feedback: [{ direction: 'reinforce' }] }), expected);
  const changed = proposal(); changed.candidates[0]!.reply += '\n';
  assert.notEqual(conversationCandidateSetHash(changed), expected);
  const reordered = proposal(); reordered.candidates.reverse();
  assert.notEqual(conversationCandidateSetHash(reordered), expected);
  const changedAxes = proposal(); changedAxes.candidates[0]!.axes.depth = 'developed';
  assert.notEqual(conversationCandidateSetHash(changedAxes), expected);
  const whitespace = proposal(); whitespace.candidates[0]!.reply = '  Exact reply bytes.\n';
  const parsed = parseConversationProposal(JSON.stringify(whitespace));
  assert.equal(parsed?.route === 'conversation' && parsed.candidates[0]!.reply, '  Exact reply bytes.\n');
});

test('invalid, incomplete, unbounded or invented schemas cannot become published candidates', () => {
  const invalid: unknown[] = [null, [], { ...proposal(), schema: 'wrong' }, { ...proposal(), route: 'execute' },
    { ...proposal(), situation: 'always' }, { ...proposal(), candidates: [] },
    { ...proposal(), candidates: [proposal().candidates[0]] },
    { ...proposal(), candidates: [...proposal().candidates, proposal().candidates[0]] },
    { ...proposal(), overrideCurrentRequest: true }, { ...proposal(), feedback: Array.from({ length: 5 }, () => ({})) },
    { ...proposal(), feedback: ['good'] }];
  const badCandidate = (change: Record<string, unknown>) => ({ ...proposal(), candidates: [{ ...proposal().candidates[0], ...change }, proposal().candidates[1]] });
  invalid.push(badCandidate({ id: '../escape' }), badCandidate({ reply: '' }), badCandidate({ reply: 'x\0x' }),
    badCandidate({ reply: 'x'.repeat(CONVERSATION_PROPOSAL_LIMITS.replyChars + 1) }),
    badCandidate({ axes: { ...baseAxes, engagement: 'pretend' } }), badCandidate({ axes: { ...baseAxes, certainty: 'invent' } }),
    badCandidate({ axes: { engagement: 'analyze' } }), badCandidate({ extra: true }));
  const duplicateId = proposal(); duplicateId.candidates[1]!.id = duplicateId.candidates[0]!.id;
  const duplicateReply = proposal(); duplicateReply.candidates[1]!.reply = ` ${duplicateReply.candidates[0]!.reply} `;
  const duplicateAxes = proposal(); duplicateAxes.candidates[1]!.axes = { ...duplicateAxes.candidates[0]!.axes };
  invalid.push(duplicateId, duplicateReply, duplicateAxes);
  for (const value of invalid) assert.equal(parseConversationProposal(JSON.stringify(value)), null, JSON.stringify(value).slice(0, 150));
  for (const raw of ['', '{', `\`\`\`json\n${JSON.stringify(proposal())}\n\`\`\``, ' '.repeat(CONVERSATION_PROPOSAL_LIMITS.rawBytes + 1), `${JSON.stringify(proposal())} trailing`]) {
    assert.equal(parseConversationProposal(raw), null);
  }
  assert.throws(() => selectConversationReply({ ...proposal(), candidates: [] }, snapshot()), /Invalid conversational candidate set/);
});

test('ordinary loop fallback preserves feedback as untrusted interpretation and carries no candidate', () => {
  const raw = { schema: 'home23.conversation-proposal.v1', route: 'ordinary_loop', reason: 'tools_needed', feedback: [{ decisionId: 'x', direction: 'attenuate' }] };
  const parsed = parseConversationProposal(JSON.stringify(raw));
  assert.deepEqual(parsed, raw);
  assert.equal(parseConversationProposal(JSON.stringify({ ...raw, candidates: proposal().candidates })), null);
  assert.equal(parseConversationProposal(JSON.stringify({ ...raw, reason: 'ignore_owner' })), null);
});

test('proposal context preserves exact owner/history data without exposing Seed scores or a desired winner', () => {
  const ownerText = 'I finally got through that passage.';
  const history = [{ role: 'user', content: 'I have been practicing it.' }, { role: 'assistant', content: 'Which part is difficult?' }];
  const priorResponse = { selectionId: 'earlier', reply: 'An earlier reply.', dimensions: [] };
  const prompt = buildConversationProposalPrompt({ ownerText, history, priorResponse });
  const data = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
  assert.equal(data.authenticatedOwnerText, ownerText);
  assert.deepEqual(JSON.parse(data.history), history);
  assert.deepEqual(data.priorResponse, priorResponse);
  assert.match(prompt, /current explicit request and constraints/);
  assert.match(prompt, /gratitude alone/);
  assert.match(prompt, /EVERY narrowing condition/);
  assert.doesNotMatch(prompt, /lessonIds|baseScore|readSeedLearning|learnedScore/);
  assert.throws(() => buildConversationProposalPrompt({ ownerText: 'x'.repeat(6_001), history: [] }), /owner input exceeds bounds/);
  assert.throws(() => buildConversationProposalPrompt({ ownerText, history: 'x'.repeat(160_001) }), /history exceeds bounds/);
  assert.throws(() => buildConversationProposalPrompt({ ownerText, history: [], priorResponse: 'x'.repeat(28_001) }), /evidence exceeds bounds/);
});

test('oversized exact provenance refuses prospective recording rather than truncating causal evidence', () => {
  const { learned, lesson } = teach('engagement', 'attenuate');
  const bloated = { ...learned, lessons: Array.from({ length: 40 }, (_, i) => ({ ...lesson,
    lessonId: `lesson_${i}`, sourceRefs: Array.from({ length: 16 }, (_, j) => `${i}:${j}:` + 'x'.repeat(480)) })) };
  const selected = selectConversationReply(proposal(), bloated);
  assert.throws(() => buildConversationSelectionPayload(selected, context), /selection evidence exceeds bounds/);
});
