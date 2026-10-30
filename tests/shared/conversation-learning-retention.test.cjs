'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { emptyLearningState, recordLearningDecision, applyLearningFeedback,
  previewLearningFeedback, normalizeLearningState, learningStateWithinBudget } = require('../../shared/seed-learning.cjs');

const axes = ['engagement', 'initiative', 'continuity', 'depth'];
let occurrenceSequence = 0;
let feedbackSequence = 0;
function decision(id, scope = 'execution:read_file') {
  return { schema: 'home23.learning-decision.v1', decisionId: id, scope,
    tags: ['situation:sharing', 'choice:explore'], sourceRefs: [`turn:${id}`],
    criterion: scope.startsWith('foreground.conduct.') ? 'owner-value' : 'execution',
    ...(scope.startsWith('foreground.conduct.') ? { observedAt: '2026-10-30T16:00:00Z',
      occurrence: { stream: 'harness', sequence: ++occurrenceSequence } } : {}) };
}
function add(state, item) {
  const result = recordLearningDecision(state, item);
  assert.equal(result.applied, true, result.reason);
  assert.ok(result.state.decisions.length <= 32);
  assert.ok(learningStateWithinBudget(result.state));
  return result.state;
}

test('ordinary decision history retains its exact previous FIFO semantics', () => {
  let state = emptyLearningState();
  for (let i = 0; i < 80; i++) state = add(state, decision(`ordinary:${i}`));
  assert.deepEqual(state.decisions.map(item => item.decisionId),
    Array.from({ length: 32 }, (_, i) => `ordinary:${i + 48}`));
});

test('real conversational eligibility survives unrelated churn and accepts delayed attributable feedback', () => {
  let state = emptyLearningState();
  const original = axes.map(axis => decision(`reply:one:${axis}`, `foreground.conduct.${axis}`));
  for (const item of original) state = add(state, item);
  for (let i = 0; i < 100; i++) state = add(state, decision(`read:${i}`));
  // Reopening the serialized existing state cannot invent or lose witnesses.
  state = normalizeLearningState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(state.decisions.slice(0, 4), original);
  const learned = applyLearningFeedback(state, {
    schema: 'home23.learning-feedback.v1', decisionId: original[0].decisionId,
    scope: original[0].scope, tags: original[0].tags,
    direction: 'reinforce', evidenceRefs: ['owner:actual-feedback'], basis: 'owner-feedback',
  }, { feedbackId: 'feedback:one', observedAt: '2026-10-30T16:00:00Z', ownerAuthenticated: true });
  assert.equal(learned.applied, true, learned.reason);
  assert.deepEqual(learned.lesson.eligibility, original[0]);
  assert.equal(learned.lesson.value, 0.25);
});

test('protection is bounded to eight new conduct decisions and never manufactures evicted evidence', () => {
  let state = emptyLearningState();
  for (let episode = 0; episode < 12; episode++) {
    for (const axis of axes) state = add(state, decision(`reply:${episode}:${axis}`, `foreground.conduct.${axis}`));
    for (let i = 0; i < 40; i++) state = add(state, decision(`read:${episode}:${i}`));
  }
  const kept = state.decisions.filter(item => item.scope.startsWith('foreground.conduct.'));
  assert.equal(kept.length, 8);
  assert.deepEqual(kept.map(item => item.decisionId), [10, 11].flatMap(episode => axes.map(axis => `reply:${episode}:${axis}`)));
  assert.equal(state.decisions.filter(item => item.scope === 'execution:read_file').length, 24);
  const refused = applyLearningFeedback(state, {
    schema: 'home23.learning-feedback.v1', decisionId: 'reply:0:engagement',
    scope: 'foreground.conduct.engagement', direction: 'attenuate',
    evidenceRefs: ['owner:feedback'], basis: 'owner-feedback',
  }, { feedbackId: 'feedback:too-old', observedAt: '2026-10-30T16:00:00Z', ownerAuthenticated: true });
  assert.equal(refused.applied, false);
  assert.equal(refused.reason, 'decision_not_retained');
});

test('unknown conduct scopes and execution-criterion claims gain no reserved capacity', () => {
  let state = emptyLearningState();
  state = add(state, decision('unknown', 'foreground.conduct.invented'));
  state = add(state, { ...decision('wrong-criterion', 'foreground.conduct.engagement'), criterion: 'execution' });
  for (let i = 0; i < 40; i++) state = add(state, decision(`normal:${i}`));
  assert.ok(!state.decisions.some(item => ['unknown', 'wrong-criterion'].includes(item.decisionId)));
});

function conductFeedback(state, id, direction, standing = false) {
  const item = decision(`reply:${id}`, 'foreground.conduct.engagement');
  state = add(state, item);
  return applyLearningFeedback(state, {
    schema: 'home23.learning-feedback.v1', decisionId: item.decisionId,
    scope: item.scope, tags: item.tags, direction, standing,
    evidenceRefs: [`owner:${id}`], basis: 'owner-feedback',
  }, { feedbackId: `feedback:${id}`, observedAt: '2026-10-30T16:00:00Z', ownerAuthenticated: true,
    stream: 'relationship', sequence: ++feedbackSequence });
}

test('hundreds of attributable conversational outcomes strengthen one bounded contribution with original receipts retained', () => {
  let state = emptyLearningState();
  const receiptHistory = [];
  for (let i = 0; i < 150; i++) {
    const result = conductFeedback(state, String(i), 'reinforce');
    assert.equal(result.applied, true, result.reason);
    receiptHistory.push(JSON.stringify(result.lesson));
    state = result.state;
    assert.equal(state.lessons.filter(item => item.active).length, 1);
    assert.ok(learningStateWithinBudget(state));
  }
  assert.equal(state.lessons.find(item => item.active).value, 0.75);
  assert.equal(JSON.parse(receiptHistory[0]).value, 0.25, 'later learning does not rewrite the original result');
  assert.ok(state.lessons.length <= 18, 'bounded inactive read model; durable history stays outside it');
  const correction = conductFeedback(state, 'new-miss', 'attenuate');
  assert.equal(correction.applied, true, correction.reason);
  assert.equal(correction.lesson.value, 0.5, 'new contrary experience adjusts the same choice');
});

test('standing conduct preferences need an explicit revision; silence and isolated contrary feedback do not revoke them', () => {
  const first = conductFeedback(emptyLearningState(), 'standing', 'attenuate', true);
  assert.equal(first.lesson.standing, true);
  const unrelatedPraise = conductFeedback(first.state, 'praise', 'reinforce');
  assert.equal(unrelatedPraise.applied, false);
  assert.equal(unrelatedPraise.reason, 'standing_conduct_instruction_requires_revision');
  assert.equal(unrelatedPraise.state.lessons.find(item => item.active).lessonId, first.lesson.lessonId);
  const repeated = conductFeedback(first.state, 'same-direction', 'attenuate');
  assert.equal(repeated.applied, true);
  assert.equal(repeated.lesson.value, -0.25);
  assert.equal(repeated.lesson.standing, true);
  const revised = conductFeedback(repeated.state, 'explicit-revision', 'reinforce', true);
  assert.equal(revised.applied, true, revised.reason);
  assert.equal(revised.lesson.value, 0.25);
  assert.equal(revised.lesson.standing, true);
  assert.equal(revised.state.lessons.filter(item => item.active).length, 1);
});

test('the same delivered conversational choice cannot be rewarded twice under new feedback IDs', () => {
  const first = conductFeedback(emptyLearningState(), 'once', 'reinforce');
  const lesson = first.lesson;
  const duplicate = applyLearningFeedback(first.state, {
    schema: 'home23.learning-feedback.v1', decisionId: lesson.decisionId,
    scope: lesson.scope, tags: lesson.tags, direction: 'reinforce',
    evidenceRefs: ['owner:another-message'], basis: 'owner-feedback',
  }, { feedbackId: 'feedback:another-message', observedAt: '2026-10-30T16:00:00Z', ownerAuthenticated: true });
  assert.equal(duplicate.applied, false);
  assert.equal(duplicate.reason, 'conduct_trial_already_credited');
  assert.equal(duplicate.state.lessons.find(item => item.active).value, 0.25);
});

test('D1 then D2 cannot credit D1 again under a new authenticated feedback identity', () => {
  const first = conductFeedback(emptyLearningState(), 'D1', 'reinforce');
  const second = conductFeedback(first.state, 'D2', 'reinforce');
  assert.equal(second.lesson.value, 0.5);
  const duplicate = applyLearningFeedback(second.state, {
    schema: 'home23.learning-feedback.v1', decisionId: first.lesson.decisionId,
    scope: first.lesson.scope, tags: first.lesson.tags, direction: 'reinforce',
    evidenceRefs: ['owner:new-message-about-D1'], basis: 'owner-feedback',
  }, { feedbackId: 'feedback:new-message-about-D1', observedAt: '2026-10-30T16:01:00Z', ownerAuthenticated: true,
    stream: 'relationship', sequence: ++feedbackSequence });
  assert.equal(duplicate.applied, false);
  assert.equal(duplicate.reason, 'conduct_trial_already_credited');
  assert.equal(duplicate.state.lessons.find(item => item.active).value, 0.5);
});

test('permanent occurrence watermark survives bounded ID, feedback and inactive-lesson eviction', () => {
  const first = conductFeedback(emptyLearningState(), 'ancient', 'reinforce');
  const original = first.lesson.eligibility;
  let state = first.state;
  for (let i = 0; i < 600; i++) {
    const result = conductFeedback(state, `later-${i}`, i % 2 === 0 ? 'attenuate' : 'reinforce');
    assert.equal(result.applied, true, result.reason);
    state = result.state;
  }
  assert.equal(state.seenFeedbackIds.includes('feedback:ancient'), false);
  assert.ok(!state.lessons.some(item => item.eligibility?.decisionId === original.decisionId));
  assert.ok(!state.decisions.some(item => item.decisionId === original.decisionId));
  const credit = state.conductCredits['engagement:sharing:explore'];
  assert.equal(credit.recentDecisionHashes.length, 8);
  state = add(normalizeLearningState(JSON.parse(JSON.stringify(state))), original);
  const replay = applyLearningFeedback(state, {
    schema: 'home23.learning-feedback.v1', decisionId: original.decisionId, scope: original.scope,
    direction: 'reinforce', evidenceRefs: ['owner:late-repetition'], basis: 'owner-feedback',
  }, { feedbackId: 'feedback:late-repetition', observedAt: '2026-10-30T16:02:00Z', ownerAuthenticated: true,
    stream: 'relationship', sequence: ++feedbackSequence });
  assert.equal(replay.applied, false);
  assert.equal(replay.reason, 'conduct_trial_already_credited');
  assert.equal(replay.state.lessons.find(item => item.active).value, 0.25);
  assert.ok(learningStateWithinBudget(replay.state));
});

test('neutral contribution does not erase old credited occurrences', () => {
  const first = conductFeedback(emptyLearningState(), 'zero-original', 'reinforce');
  let state = first.state;
  for (let i = 0; i < 41; i++) state = conductFeedback(state, `zero-${i}`, i % 2 === 0 ? 'attenuate' : 'reinforce').state;
  assert.equal(state.lessons.filter(item => item.active).length, 0);
  assert.ok(!state.lessons.some(item => item.eligibility?.decisionId === first.lesson.decisionId));
  state = add(state, first.lesson.eligibility);
  const replay = applyLearningFeedback(state, {
    schema: 'home23.learning-feedback.v1', decisionId: first.lesson.decisionId, scope: first.lesson.scope,
    direction: 'reinforce', evidenceRefs: ['owner:old-episode'], basis: 'owner-feedback',
  }, { feedbackId: 'feedback:old-episode', observedAt: '2026-10-30T16:03:00Z', ownerAuthenticated: true });
  assert.equal(replay.applied, false);
  assert.equal(replay.reason, 'conduct_trial_already_credited');
});

test('tied times need trusted source order and missing original occurrence cannot teach', () => {
  const first = conductFeedback(emptyLearningState(), 'tied-first', 'reinforce');
  const original = first.lesson.eligibility;
  const second = { ...original, decisionId: 'tied-second', occurrence: { stream: 'harness', sequence: ++occurrenceSequence } };
  const state = add(first.state, second);
  const feedback = { schema: 'home23.learning-feedback.v1', decisionId: second.decisionId, scope: second.scope,
    direction: 'reinforce', evidenceRefs: ['owner:tied'], basis: 'owner-feedback' };
  const authority = { feedbackId: 'feedback:tied', observedAt: '2026-10-30T16:00:00Z', ownerAuthenticated: true };
  assert.equal(applyLearningFeedback(state, feedback, authority).applied, true);
  const noOrder = { ...state, decisions: state.decisions.map(item => item.decisionId === second.decisionId ? { ...item, occurrence: undefined } : item) };
  assert.equal(applyLearningFeedback(noOrder, feedback, authority).reason, 'conduct_trial_already_credited');
  const noTime = { ...state, decisions: state.decisions.map(item => item.decisionId === second.decisionId ? { ...item, observedAt: undefined } : item) };
  assert.equal(applyLearningFeedback(noTime, feedback, authority).reason, 'conduct_occurrence_unavailable');
});

test('standing revision of the same episode requires a fresh source cursor and never compounds experience', () => {
  const first = conductFeedback(emptyLearningState(), 'revision-original', 'attenuate', true);
  const feedback = { schema: 'home23.learning-feedback.v1', decisionId: first.lesson.decisionId,
    scope: first.lesson.scope, direction: 'reinforce', standing: true,
    evidenceRefs: ['owner:actual-new-revision'], basis: 'owner-feedback' };
  const authority = { feedbackId: 'feedback:actual-new-revision', observedAt: '2026-10-30T16:04:00Z', ownerAuthenticated: true };
  const bytes = JSON.stringify(first.state);
  assert.equal(applyLearningFeedback(first.state, feedback, authority).reason, 'conduct_revision_source_order_unavailable');
  const preview = previewLearningFeedback(first.state, feedback, authority);
  assert.equal(preview.applied, true);
  assert.equal(JSON.stringify(first.state), bytes, 'pure preview has no state or source side effect');
  assert.equal(previewLearningFeedback(first.state, feedback, { ...authority, ownerAuthenticated: false }).reason, 'owner_authority_missing');
  assert.equal(previewLearningFeedback(first.state, { ...feedback, tags: ['invented'] }, authority).reason, 'feedback_context_mismatch');
  const applied = applyLearningFeedback(first.state, feedback, { ...authority, stream: 'relationship', sequence: ++feedbackSequence });
  assert.equal(applied.applied, true, applied.reason);
  assert.equal(applied.lesson.value, 0.25);
  const newer = applyLearningFeedback(applied.state, { ...feedback, evidenceRefs: ['owner:another-real-instruction'] }, {
    ...authority, feedbackId: 'feedback:another-real-instruction', stream: 'relationship', sequence: ++feedbackSequence,
  });
  assert.equal(newer.applied, true);
  assert.equal(newer.lesson.value, 0.25, 'an instruction revision replaces its bounded preference; it is not extra outcome evidence');
});

test('historical state normalization has no new defaults and corrupt credit evidence fails closed', () => {
  const old = emptyLearningState();
  assert.deepEqual(normalizeLearningState(old), old);
  assert.equal(Object.hasOwn(normalizeLearningState(old), 'conductAnchor'), false);
  assert.equal(Object.hasOwn(normalizeLearningState(old), 'conductCredits'), false);
  const first = conductFeedback(old, 'metadata', 'reinforce');
  assert.deepEqual(normalizeLearningState(JSON.parse(JSON.stringify(first.state))), first.state);
  assert.throws(() => normalizeLearningState({ ...first.state, conductCredits: [] }), /invalid conduct credit state/);
  assert.throws(() => normalizeLearningState({ ...first.state, conductCredits: { bad: {} } }), /invalid conduct credit state/);
  assert.throws(() => normalizeLearningState({ ...first.state, conductAnchor: false }), /invalid conduct anchor state/);
});
