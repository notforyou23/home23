'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyLearningFeedback, evaluateLearnedDecision, normalizeLearningDecision, consolidateLearning, emptyLearningState, recordLearningDecision } = require('../../shared/seed-learning.cjs');

const decision = { schema: 'home23.learning-decision.v1', decisionId: 'outreach:one', scope: 'owner.outreach:machine.memory',
  tags: ['unsolicited', 'routine', 'mild'], sourceRefs: ['machine:sample1'], criterion: 'owner-value' };
const feedback = { schema: 'home23.learning-feedback.v1', decisionId: decision.decisionId, scope: decision.scope,
  direction: 'attenuate', tags: ['unsolicited', 'routine'], excludes: ['critical'], evidenceRefs: ['message:owner1'], basis: 'owner-feedback' };

test('a scoped owner lesson changes a later actual admission input without changing episodes', () => {
  const state = { version: 1, decisions: [normalizeLearningDecision(decision)], lessons: [], seenFeedbackIds: [] };
  const changed = applyLearningFeedback(state, feedback, { feedbackId: 'f1', observedAt: '2026-10-29T00:00:00Z', ownerAuthenticated: true });
  assert.equal(changed.applied, true);
  assert.equal(evaluateLearnedDecision(changed.state, { scope: decision.scope, tags: ['unsolicited', 'routine', 'mild'] }).suppress, true);
  assert.equal(evaluateLearnedDecision(state, { scope: decision.scope, tags: ['unsolicited', 'routine', 'mild'] }).suppress, false);
  assert.equal(evaluateLearnedDecision(changed.state, { scope: decision.scope, tags: ['unsolicited', 'routine', 'critical'] }).suppress, false);
  assert.equal(evaluateLearnedDecision(changed.state, { scope: 'owner.outreach:health', tags: ['unsolicited', 'routine'] }).suppress, false);
  assert.equal(applyLearningFeedback(changed.state, feedback, { feedbackId: 'f1', observedAt: '2026-10-29T00:01:00Z', ownerAuthenticated: true }).applied, false);
});

test('linked feedback cannot widen past its original context and positive learning changes rank', () => {
  const state = recordLearningDecision(emptyLearningState(), decision).state;
  const changed = applyLearningFeedback(state, { ...feedback, tags: [] }, { feedbackId: 'narrow', observedAt: '2026-10-29T00:00:00Z', ownerAuthenticated: true });
  assert.equal(evaluateLearnedDecision(changed.state, { scope: decision.scope, tags: ['unsolicited', 'routine'] }).suppress, false);
  assert.equal(evaluateLearnedDecision(changed.state, { scope: decision.scope, tags: decision.tags }).suppress, true);
  const positive = applyLearningFeedback(state, { ...feedback, direction: 'reinforce' }, { feedbackId: 'positive', observedAt: '2026-10-29T00:00:00Z', ownerAuthenticated: true });
  assert.equal(evaluateLearnedDecision(positive.state, { scope: decision.scope, tags: decision.tags, baseScore: 0.4 }).score, 0.65);
  assert.equal(applyLearningFeedback(emptyLearningState(), { ...feedback, decisionId: undefined, tags: [] }, { feedbackId: 'broad', observedAt: '2026-10-29T00:00:00Z', ownerAuthenticated: true }).applied, false);
});

test('execution success cannot cancel an applicable owner instruction', () => {
  const choice = { ...decision, scope: 'execution:refresh_sensor', tags: ['execution', 'action', 'target:weather'], criterion: 'execution' };
  let state = recordLearningDecision(emptyLearningState(), choice).state;
  const owner = applyLearningFeedback(state, { ...feedback, decisionId: choice.decisionId, scope: choice.scope,
    tags: choice.tags }, { feedbackId: 'owner-limit', observedAt: '2026-10-29T00:00:00Z', ownerAuthenticated: true });
  state = recordLearningDecision(owner.state, { ...choice, decisionId: 'explicit-retry' }).state;
  const success = applyLearningFeedback(state, { ...feedback, decisionId: 'explicit-retry', scope: choice.scope,
    tags: choice.tags, direction: 'reinforce', basis: 'verified-outcome', evidenceRefs: ['receipt:successful-retry'] },
  { feedbackId: 'retry-success', observedAt: '2026-10-29T00:01:00Z', verification: { criterion: 'execution', evidenceRefs: ['receipt:successful-retry'] } });
  assert.equal(success.applied, true);
  const next = evaluateLearnedDecision(success.state, { scope: choice.scope, tags: choice.tags });
  assert.equal(next.suppress, true, 'competence evidence is not permission to disregard an owner preference');
  assert.deepEqual(next.lessonIds, [owner.lesson.lessonId]);
});

test('a separate matching opportunity corroborates only its linked provisional lesson', () => {
  const first = { ...decision, criterion: 'execution', scope: 'execution:research', tags: ['execution'] };
  const second = { ...first, decisionId: 'action:second', sourceRefs: ['receipt:second'] };
  let state = recordLearningDecision(emptyLearningState(), first).state;
  state = recordLearningDecision(state, second).state;
  const input = { ...feedback, scope: first.scope, tags: first.tags, direction: 'reinforce', basis: 'verified-outcome' };
  const taught = applyLearningFeedback(state, input, { feedbackId: 'exec1', observedAt: '2026-10-29T00:00:00Z', verification: { criterion: 'execution', evidenceRefs: input.evidenceRefs } });
  const linked = { ...input, decisionId: second.decisionId, corroborates: [taught.lesson.lessonId] };
  const corroborated = applyLearningFeedback(taught.state, linked, { feedbackId: 'exec2', observedAt: '2026-10-29T01:00:00Z', verification: { criterion: 'execution', evidenceRefs: linked.evidenceRefs } });
  assert.equal(corroborated.applied, true);
  assert.equal(corroborated.state.lessons.length, 1);
  assert.equal(corroborated.state.lessons[0].corroborations, 1);
  assert.equal(consolidateLearning(corroborated.state).lessons[0].value, 0.25);
  assert.equal(consolidateLearning(taught.state).lessons[0].value, 0.15);
  const sameTrial = applyLearningFeedback(taught.state, { ...linked, decisionId: first.decisionId }, { feedbackId: 'exec3', observedAt: '2026-10-29T01:00:00Z', verification: { criterion: 'execution', evidenceRefs: linked.evidenceRefs } });
  assert.equal(sameTrial.applied, false);
});

test('bounded history allows continued revisions and lost-cursor duplicates remain refused', () => {
  let state = recordLearningDecision(emptyLearningState(), decision).state, previous;
  for (let i = 1; i <= 550; i++) {
    const result = applyLearningFeedback(state, { ...feedback, standing: true,
      supersedes: previous ? [previous] : [] }, { feedbackId: `revision:${i}`, observedAt: '2026-10-29T00:00:00Z', ownerAuthenticated: true,
      stream: 'relationship', sequence: i });
    assert.equal(result.applied, true, `revision ${i} remains possible`);
    state = result.state; previous = result.lesson.lessonId;
  }
  assert.equal(state.lessons.filter(item => item.active).length, 1);
  assert.equal(state.seenFeedbackIds.length, 512);
  const old = applyLearningFeedback(state, { ...feedback, standing: true }, { feedbackId: 'revision:1',
    observedAt: '2026-10-29T00:00:00Z', ownerAuthenticated: true, stream: 'relationship', sequence: 1 });
  assert.equal(old.applied, false);
  assert.equal(old.reason, 'feedback_precedes_stream_watermark');
});

test('active owner lessons are never silently evicted to accept a new one', () => {
  let state = emptyLearningState();
  for (let i = 0; i < 64; i++) {
    const specific = { ...decision, decisionId: `choice:${i}`, scope: `foreground:scope${i}` };
    state = recordLearningDecision(state, specific).state;
    state = applyLearningFeedback(state, { ...feedback, decisionId: specific.decisionId, standing: true,
      scope: specific.scope }, { feedbackId: `owner:${i}`, observedAt: '2026-10-29T00:00:00Z', ownerAuthenticated: true }).state;
  }
  const first = state.lessons[0].lessonId;
  state = recordLearningDecision(state, { ...decision, decisionId: 'choice:extra', scope: 'foreground:extra' }).state;
  const extra = applyLearningFeedback(state, { ...feedback, decisionId: 'choice:extra', standing: true, scope: 'foreground:extra' },
    { feedbackId: 'owner:extra', observedAt: '2026-10-29T00:00:00Z', ownerAuthenticated: true });
  assert.equal(extra.applied, false);
  assert.equal(extra.reason, 'lesson_capacity');
  assert.ok(extra.state.lessons.some(item => item.lessonId === first && item.active));
});

test('inactive supersession cannot create a sixty-fifth active contribution', () => {
  let state = recordLearningDecision(emptyLearningState(), decision).state;
  let first;
  for (let i = 0; i < 65; i++) {
    const result = applyLearningFeedback(state, { ...feedback, ...(i === 1 ? { supersedes: [first] } : {}) },
      { feedbackId: `cap:${i}`, observedAt: '2026-10-29T00:00:00Z', ownerAuthenticated: true });
    assert.equal(result.applied, true);
    state = result.state; if (i === 0) first = result.lesson.lessonId;
  }
  assert.equal(state.lessons.filter(item => item.active).length, 64);
  const refused = applyLearningFeedback(state, { ...feedback, supersedes: [first] },
    { feedbackId: 'cap:overflow', observedAt: '2026-10-29T00:00:00Z', ownerAuthenticated: true });
  assert.equal(refused.applied, false);
  assert.equal(refused.reason, 'supersession_target_inactive');
  assert.equal(refused.state.lessons.filter(item => item.active).length, 64);
});

test('hundreds of equivalent empirical trials keep learning while stale provisional state retires and owner instructions survive', () => {
  let state = recordLearningDecision(emptyLearningState(), decision).state;
  state = applyLearningFeedback(state, feedback, { feedbackId: 'standing-owner', observedAt: '2026-10-29T00:00:00Z', ownerAuthenticated: true }).state;
  for (let i = 0; i < 180; i++) {
    const opportunity = { ...decision, decisionId: `execution:${i}`, scope: 'execution:refresh_sensor', tags: ['execution', 'action', 'target:one'], criterion: 'execution' };
    state = recordLearningDecision(state, opportunity).state;
    const update = { ...feedback, decisionId: opportunity.decisionId, scope: opportunity.scope, tags: opportunity.tags,
      direction: i < 90 ? 'reinforce' : 'attenuate', basis: 'verified-outcome' };
    const result = applyLearningFeedback(state, update, { feedbackId: `trial:${i}`, observedAt: '2026-10-29T00:00:00Z',
      verification: { criterion: 'execution', evidenceRefs: update.evidenceRefs } });
    assert.equal(result.applied, true, `trial ${i} does not exhaust the individual`);
    state = result.state;
  }
  assert.equal(state.lessons.filter(item => item.active).length, 2);
  assert.equal(evaluateLearnedDecision(state, { scope: 'execution:refresh_sensor', tags: ['execution', 'action', 'target:one'] }).suppress, true);
  for (let i = 0; i < 60; i++) state = consolidateLearning(state);
  assert.equal(state.lessons.filter(item => item.active && item.authority !== 'owner').length, 0);
  assert.equal(state.lessons.filter(item => item.active && item.authority === 'owner').length, 1);
  assert.equal(evaluateLearnedDecision(state, { scope: decision.scope, tags: decision.tags }).suppress, true);
});

test('owner authority persists while unrelated success never corroborates a provisional lesson', () => {
  const initial = { version: 1, decisions: [normalizeLearningDecision(decision)], lessons: [], seenFeedbackIds: [] };
  const taught = applyLearningFeedback(initial, feedback, { feedbackId: 'f1', observedAt: '2026-10-29T00:00:00Z', ownerAuthenticated: true }).state;
  const after = consolidateLearning(taught);
  assert.equal(after.lessons[0].value, taught.lessons[0].value);
  assert.equal(after.lessons[0].corroborations, 0);
  assert.equal(applyLearningFeedback(initial, feedback, { feedbackId: 'f2', observedAt: '2026-10-29T00:00:00Z', ownerAuthenticated: false }).applied, false);
  const wrongScope = { ...feedback, basis: 'verified-outcome' };
  assert.equal(applyLearningFeedback(initial, wrongScope, { feedbackId: 'f3', observedAt: '2026-10-29T00:00:00Z', verification: { criterion: 'execution', evidenceRefs: ['receipt:handler'] } }).applied, false);
});
