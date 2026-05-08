import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildGoodLifeOperatorModel,
  buildLiveProblemSnapshot,
} = require('../../../engine/src/dashboard/good-life-operator.js');

const NOW = '2026-05-08T13:45:00.000Z';

function goodLifeState(overrides = {}) {
  return {
    evaluatedAt: '2026-05-08T13:42:00.000Z',
    summary: 'help - strained continuity drift (continuity:strained, usefulness:watch)',
    policy: {
      mode: 'help',
      reason: 'strained continuity drift',
      actionCard: {
        intent: 'help',
        goodLifeLanes: ['continuity', 'usefulness'],
        evidenceRequired: true,
        riskTier: 0,
        reversible: true,
        expectedOutcome: 'jtr-visible work advances or a blocked decision is surfaced',
        stopCondition: 'action is completed, refused, or converted into a bounded goal',
      },
    },
    lanes: {
      viability: { status: 'healthy', reasons: ['core engine evidence is flowing'] },
      continuity: { status: 'strained', reasons: ['16 open goals', '145 pending agenda item(s)'] },
      usefulness: { status: 'watch', reasons: ['usefulness must be proven by visible progress'] },
    },
    evidence: {
      liveProblems: { open: 0, chronic: 0, resolved: 12, unverifiable: 0, total: 12 },
      goals: { open: 16, total: 16 },
      agenda: { pending: 145 },
    },
    ...overrides,
  };
}

test('live-problem snapshot separates open, chronic, resolved, and unverifiable rows', () => {
  const snapshot = buildLiveProblemSnapshot([
    { id: 'open_1', state: 'open', claim: 'Open thing', openedAt: '2026-05-08T13:40:00.000Z' },
    { id: 'chronic_1', state: 'chronic', claim: 'Chronic thing', openedAt: '2026-05-08T13:00:00.000Z', lastResult: { detail: 'still failing' } },
    { id: 'resolved_1', state: 'resolved', claim: 'Resolved thing', resolvedAt: '2026-05-08T13:44:00.000Z' },
    { id: 'unv_1', state: 'unverifiable', claim: 'No verifier' },
  ], NOW);

  assert.equal(snapshot.counts.open, 1);
  assert.equal(snapshot.counts.chronic, 1);
  assert.equal(snapshot.counts.resolved, 1);
  assert.equal(snapshot.counts.unverifiable, 1);
  assert.equal(snapshot.open[0].ageMin, 5);
  assert.equal(snapshot.chronic[0].detail, 'still failing');
  assert.equal(snapshot.resolvedJustNow[0].id, 'resolved_1');
});

test('Good Life operator model exposes safe current help state with evidence and action card', () => {
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState(),
    commitments: {
      commitments: [
        { id: 'continuity', lane: 'continuity', active: true, status: 'strained', title: 'Preserve continuity' },
        { id: 'useful-output', lane: 'usefulness', active: true, status: 'watch', title: 'Produce visible progress' },
      ],
    },
    regulator: {
      'help:continuity:strained|usefulness:watch': {
        at: '2026-05-08T13:43:00.000Z',
        agendaId: 'ag-gl-test',
        mode: 'help',
      },
    },
    liveProblems: [],
    now: NOW,
  });

  assert.equal(model.status, 'current');
  assert.equal(model.safeToInherit, true);
  assert.equal(model.policy.mode, 'help');
  assert.equal(model.freshness.ageMin, 3);
  assert.deepEqual(model.liveProblems.counts, { open: 0, chronic: 0, resolved: 0, unverifiable: 0 });
  assert.equal(model.consistency.ok, true);
  assert.equal(model.actionCard.intent, 'help');
  assert.equal(model.latestRegulatorAction.agendaId, 'ag-gl-test');
  assert.equal(model.lanes.find((lane) => lane.name === 'continuity').active, true);
  assert.ok(model.operatorAnswer.some((line) => line.includes('strained continuity drift')));
});

test('Good Life operator model marks projection mismatch as conflicted and keeps direct live problems visible', () => {
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState({
      evaluatedAt: '2026-05-08T13:43:00.000Z',
      summary: 'repair - critical viability drift',
      policy: {
        mode: 'repair',
        reason: 'critical viability drift',
        actionCard: {
          intent: 'repair',
          goodLifeLanes: ['viability', 'continuity'],
          expectedOutcome: 'verified live problem count drops',
          stopCondition: 'verifier passes or repair is blocked',
        },
      },
      lanes: {
        viability: { status: 'critical', reasons: ['6 unresolved live problem(s)'] },
        continuity: { status: 'strained', reasons: ['145 pending agenda item(s)'] },
      },
      evidence: {
        liveProblems: { open: 1, chronic: 5, resolved: 11, unverifiable: 0, total: 17 },
      },
    }),
    liveProblems: [
      { id: 'agenda_a', state: 'chronic', claim: 'Verify process CPU usage', openedAt: '2026-05-03T15:54:27.000Z', lastResult: { detail: 'no diagnostic recipe recorded' } },
      { id: 'agenda_b', state: 'chronic', claim: 'Verify memory pressure', openedAt: '2026-05-03T19:03:13.000Z' },
      { id: 'resolved_a', state: 'resolved', claim: 'Transient open cleared', resolvedAt: '2026-05-08T13:40:00.000Z' },
    ],
    now: NOW,
  });

  assert.equal(model.status, 'conflicted');
  assert.equal(model.safeToInherit, false);
  assert.equal(model.liveProblems.counts.open, 0);
  assert.equal(model.liveProblems.counts.chronic, 2);
  assert.equal(model.projection.liveProblems.open, 1);
  assert.equal(model.projection.liveProblems.chronic, 5);
  assert.ok(model.consistency.warnings.some((warning) => warning.code === 'good_life_projection_mismatch'));
  assert.equal(model.liveProblems.chronic[0].id, 'agenda_a');
  assert.ok(model.operatorAnswer.some((line) => line.includes('0 open, 2 chronic')));
});

test('Good Life operator model treats old evaluations as stale even if counts agree', () => {
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState({ evaluatedAt: '2026-05-08T12:00:00.000Z' }),
    liveProblems: [],
    now: NOW,
  });

  assert.equal(model.status, 'stale');
  assert.equal(model.safeToInherit, false);
  assert.equal(model.freshness.status, 'stale');
  assert.ok(model.consistency.warnings.some((warning) => warning.code === 'good_life_projection_stale'));
});

test('Good Life operator model refuses inheritance when freshness is unknown', () => {
  const state = goodLifeState();
  delete state.evaluatedAt;

  const model = buildGoodLifeOperatorModel({
    state,
    liveProblems: [],
    now: NOW,
  });

  assert.equal(model.status, 'unknown');
  assert.equal(model.safeToInherit, false);
  assert.ok(model.consistency.warnings.some((warning) => warning.code === 'good_life_freshness_unknown'));
});
