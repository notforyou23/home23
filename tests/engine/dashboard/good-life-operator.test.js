import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildGoodLifeOperatorModel,
  buildLiveProblemSnapshot,
  buildGoodLifeObligationSnapshot,
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
    { id: 'resolved_1', state: 'resolved', claim: 'Resolved thing', resolvedAt: '2026-05-08T13:44:00.000Z', evidence: { receiptId: 'ev_1', result: 'pass' } },
    { id: 'unv_1', state: 'unverifiable', claim: 'No verifier' },
  ], NOW);

  assert.equal(snapshot.counts.open, 1);
  assert.equal(snapshot.counts.chronic, 1);
  assert.equal(snapshot.counts.resolved, 1);
  assert.equal(snapshot.counts.unverifiable, 1);
  assert.equal(snapshot.counts.interventionRequired, 0);
  assert.equal(snapshot.open[0].ageMin, 5);
  assert.equal(snapshot.chronic[0].detail, 'still failing');
  assert.equal(snapshot.resolvedJustNow[0].id, 'resolved_1');
  assert.equal(snapshot.resolved[0].id, 'resolved_1');
  assert.equal(snapshot.resolved[0].evidence.receiptId, 'ev_1');
});

test('live-problem snapshot marks current user-intervention remediation steps', () => {
  const snapshot = buildLiveProblemSnapshot([
    {
      id: 'needs_jtr',
      state: 'open',
      claim: 'Needs a human decision',
      openedAt: '2026-05-08T13:00:00.000Z',
      stepIndex: 1,
      remediation: [
        { type: 'dispatch_to_agent', args: { budgetHours: 2 } },
        { type: 'notify_jtr', args: { text: 'Choose whether to restart the external bridge.' } },
      ],
    },
  ], NOW);

  assert.equal(snapshot.counts.interventionRequired, 1);
  assert.equal(snapshot.open[0].nextRemediation.type, 'notify_jtr');
  assert.equal(snapshot.open[0].intervention.required, true);
  assert.equal(snapshot.open[0].intervention.reason, 'Choose whether to restart the external bridge.');
});

test('Good Life obligation snapshot exposes active agenda rows and goals', () => {
  const snapshot = buildGoodLifeObligationSnapshot({
    agendaRows: [
      { type: 'add', id: 'ag-1', record: { status: 'candidate', content: 'Check dashboard operator path', createdAt: '2026-05-08T13:00:00.000Z' } },
      { type: 'add', id: 'ag-2', record: { status: 'candidate', content: 'Old Good Life item', createdAt: '2026-05-08T12:00:00.000Z', sourceSignal: 'good-life' } },
      { type: 'status', id: 'ag-2', status: 'stale', at: '2026-05-08T13:10:00.000Z' },
      { type: 'add', id: 'ag-3', record: { status: 'surfaced', content: 'Surface decision', createdAt: '2026-05-08T13:20:00.000Z' } },
    ],
    goals: {
      active: [
        ['goal_1', { id: 'goal_1', description: 'Resolve operator visibility gap', status: 'active', createdAt: '2026-05-08T13:30:00.000Z' }],
      ],
    },
    now: NOW,
  });

  assert.equal(snapshot.counts.activeAgenda, 2);
  assert.equal(snapshot.counts.activeGoals, 1);
  assert.deepEqual(snapshot.activeAgenda.map((row) => row.id), ['ag-3', 'ag-1']);
  assert.equal(snapshot.activeGoals[0].id, 'goal_1');
  assert.equal(snapshot.activeGoals[0].description, 'Resolve operator visibility gap');
  assert.equal(snapshot.activeGoals[0].review.recommended, false);
  assert.equal(snapshot.latestAgendaById['ag-2'].status, 'stale');
  assert.equal(snapshot.latestAgendaById['ag-3'].status, 'surfaced');
});

test('Good Life obligation snapshot compacts force-output goal prompts for operator display', () => {
  const snapshot = buildGoodLifeObligationSnapshot({
    goals: {
      active: [
        ['goal_force', {
          id: 'goal_force',
          description: 'Produce outputs/digest-6427.md. Synthesize these findings from recent memory:\\n  - [#1 tag=agent_insight] internal retrieval note',
          status: 'active',
          source: 'force-output',
          createdAt: '2026-05-08T13:30:00.000Z',
        }],
      ],
    },
    now: NOW,
  });

  assert.equal(snapshot.activeGoals[0].description, 'Produce outputs/digest-6427.md');
  assert.match(snapshot.activeGoals[0].rawDescription, /Synthesize these findings/);
});

test('Good Life obligation snapshot reports promised output artifact status', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-good-life-output-'));
  const outputsDir = path.join(dir, 'outputs');
  fs.mkdirSync(outputsDir, { recursive: true });
  fs.writeFileSync(path.join(outputsDir, 'digest-6427.md'), '# Digest\n');

  try {
    const ready = buildGoodLifeObligationSnapshot({
      goals: {
        active: [
          ['goal_ready', {
            id: 'goal_ready',
            description: 'Produce outputs/digest-6427.md. Synthesize current evidence.',
            status: 'active',
            source: 'force-output',
            createdAt: '2026-05-08T13:30:00.000Z',
          }],
        ],
      },
      outputRoots: [dir],
      now: NOW,
    });

    assert.equal(ready.activeGoals[0].artifact.exists, true);
    assert.equal(ready.activeGoals[0].artifact.relativePath, 'outputs/digest-6427.md');
    assert.match(ready.activeGoals[0].artifact.path, /digest-6427\.md$/);

    const pending = buildGoodLifeObligationSnapshot({
      goals: {
        active: [
          ['goal_pending', {
            id: 'goal_pending',
            description: 'Produce outputs/missing.md. Synthesize current evidence.',
            status: 'active',
            source: 'force-output',
            createdAt: '2026-05-08T13:30:00.000Z',
          }],
        ],
      },
      outputRoots: [dir],
      now: NOW,
    });

    assert.equal(pending.activeGoals[0].artifact.exists, false);
    assert.equal(pending.activeGoals[0].artifact.relativePath, 'outputs/missing.md');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Good Life obligation snapshot flags stale force-output goals for operator review', () => {
  const snapshot = buildGoodLifeObligationSnapshot({
    goals: {
      active: [
        ['goal_force', {
          id: 'goal_force',
          description: 'Produce outputs/digest-6382.md',
          status: 'active',
          source: { origin: 'force-output', label: 'force-output' },
          progress: 0,
          createdAt: '2026-05-07T23:00:00.000Z',
        }],
      ],
    },
    now: NOW,
  });

  assert.equal(snapshot.activeGoals[0].review.recommended, true);
  assert.equal(snapshot.activeGoals[0].review.required, false);
  assert.match(snapshot.activeGoals[0].review.reason, /force-output goal/);
});

test('Good Life obligation snapshot flags stale active agenda rows for operator review', () => {
  const snapshot = buildGoodLifeObligationSnapshot({
    agendaRows: [
      {
        type: 'add',
        id: 'ag-old-good-life',
        record: {
          status: 'candidate',
          content: 'Diagnose Good Life repair drift',
          sourceSignal: 'good-life',
          topicTags: ['good-life', 'good-life:repair'],
          createdAt: '2026-05-08T11:30:00.000Z',
        },
      },
      {
        type: 'add',
        id: 'ag-old-ack',
        record: {
          status: 'acknowledged',
          content: 'Old acknowledged work',
          createdAt: '2026-05-07T11:30:00.000Z',
        },
      },
    ],
    now: NOW,
  });

  assert.equal(snapshot.activeAgenda.length, 2);
  assert.equal(snapshot.activeAgenda[0].review.recommended, true);
  assert.match(snapshot.activeAgenda[0].review.reason, /Good Life agenda row/);
  assert.equal(snapshot.activeAgenda[0].review.suggestedWorker.worker, 'systems');
  assert.equal(snapshot.activeAgenda[0].review.suggestedWorker.inferred, true);
  assert.equal(snapshot.activeAgenda[1].review.recommended, true);
  assert.match(snapshot.activeAgenda[1].review.reason, /acknowledged agenda row/);
});

test('Good Life obligation snapshot suggests systems worker for fresh friction rest rows', () => {
  const snapshot = buildGoodLifeObligationSnapshot({
    agendaRows: [
      {
        type: 'add',
        id: 'ag-fresh-good-life-rest',
        record: {
          status: 'candidate',
          content: 'Diagnose Good Life friction drift and reduce loop pressure',
          sourceSignal: 'good-life',
          topicTags: ['good-life', 'good-life:friction', 'mode:rest'],
          createdAt: '2026-05-08T13:30:00.000Z',
        },
      },
    ],
    now: NOW,
  });

  assert.equal(snapshot.activeAgenda.length, 1);
  assert.equal(snapshot.activeAgenda[0].review.recommended, false);
  assert.equal(snapshot.activeAgenda[0].review.severity, 'ok');
  assert.equal(snapshot.activeAgenda[0].review.suggestedWorker.worker, 'systems');
  assert.equal(snapshot.activeAgenda[0].review.suggestedWorker.inferred, true);
});

test('Good Life obligation snapshot suggests workers for stale legacy agenda topics', () => {
  const snapshot = buildGoodLifeObligationSnapshot({
    agendaRows: [
      {
        type: 'add',
        id: 'ag-old-memory',
        record: {
          status: 'surfaced',
          content: 'Audit persistent context copies across workspaces and consolidate canonical memory',
          sourceSignal: 'anomaly',
          topicTags: ['system', 'memory'],
          createdAt: '2026-05-07T11:30:00.000Z',
        },
      },
      {
        type: 'add',
        id: 'ag-old-cron',
        record: {
          status: 'surfaced',
          content: 'Verify Pi API cron job is fetching recent running data',
          sourceSignal: 'anomaly',
          topicTags: ['cron', 'data ingestion'],
          createdAt: '2026-05-07T11:30:00.000Z',
        },
      },
    ],
    now: NOW,
  });

  assert.equal(snapshot.activeAgenda[0].review.suggestedWorker.worker, 'memory');
  assert.equal(snapshot.activeAgenda[1].review.suggestedWorker.worker, 'freshness');
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
  assert.deepEqual(model.liveProblems.counts, { open: 0, chronic: 0, resolved: 0, unverifiable: 0, interventionRequired: 0 });
  assert.equal(model.consistency.ok, true);
  assert.equal(model.actionCard.intent, 'help');
  assert.equal(model.latestRegulatorAction.agendaId, 'ag-gl-test');
  assert.equal(model.lanes.find((lane) => lane.name === 'continuity').active, true);
  assert.ok(model.operatorAnswer.some((line) => line.includes('strained continuity drift')));
  assert.deepEqual(model.operatorDigest.evidence, {
    open: 0,
    chronic: 0,
    interventionRequired: 0,
    activeWork: 0,
    latestResolutionId: null,
    targetTab: 'issues',
  });
  assert.equal(model.operatorDigest.issue, 'No active live problems');
  assert.equal(model.operatorDigest.currentWork, 'No active routed work');
  assert.equal(model.operatorDigest.userAction, 'No user action needed right now.');
});

test('Good Life operator model annotates latest routed agenda status', () => {
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState(),
    regulator: {
      'help:continuity:strained|usefulness:watch': {
        at: '2026-05-08T13:43:00.000Z',
        agendaId: 'ag-gl-test',
        mode: 'help',
      },
    },
    obligations: buildGoodLifeObligationSnapshot({
      agendaRows: [
        { type: 'add', id: 'ag-gl-test', record: { status: 'candidate', content: 'Check thing', createdAt: '2026-05-08T13:00:00.000Z' } },
        { type: 'status', id: 'ag-gl-test', status: 'acted_on', at: '2026-05-08T13:44:00.000Z', note: 'completed in test' },
      ],
      now: NOW,
    }),
    liveProblems: [],
    now: NOW,
  });

  assert.equal(model.latestRegulatorAction.agendaId, 'ag-gl-test');
  assert.equal(model.latestRegulatorAction.agendaStatus, 'acted_on');
  assert.equal(model.latestRegulatorAction.agendaStatusNote, 'completed in test');
});

test('Good Life operator answer surfaces live problems that need user intervention', () => {
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState({ evidence: { liveProblems: { open: 1, chronic: 0, resolved: 0, unverifiable: 0, total: 1 } } }),
    liveProblems: [
      {
        id: 'needs_jtr',
        state: 'open',
        claim: 'Needs a human decision',
        openedAt: '2026-05-08T13:00:00.000Z',
        stepIndex: 0,
        remediation: [
          { type: 'notify_jtr', args: { text: 'Pick the bridge owner.' } },
        ],
      },
    ],
    now: NOW,
  });

  assert.equal(model.liveProblems.counts.interventionRequired, 1);
  assert.ok(model.operatorAnswer.some((line) => line.includes('need user intervention')));
  assert.ok(model.operatorAnswer.some((line) => line.includes('Top live problem: needs_jtr')));
  assert.ok(model.operatorAnswer.some((line) => line.includes('Next user action: notify_jtr - Pick the bridge owner.')));
  assert.equal(model.operatorBrief.severity, 'needs-user');
  assert.equal(model.operatorBrief.needsUser, true);
  assert.equal(model.operatorBrief.activeProblemId, 'needs_jtr');
  assert.match(model.operatorBrief.next, /User action: notify_jtr - Pick the bridge owner/);
  assert.deepEqual(model.operatorBrief.target, {
    tab: 'issues',
    id: 'needs_jtr',
    label: 'Review Issue',
    worker: null,
  });
  assert.match(model.operatorDigest.issue, /1 active live problem: .*Needs a human decision/);
  assert.match(model.operatorDigest.userAction, /User action: notify_jtr - Pick the bridge owner/);
  assert.equal(model.operatorDigest.evidence.interventionRequired, 1);
});

test('Good Life operator answer names open live problem and latest fix attempt', () => {
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState({ evidence: { liveProblems: { open: 1, chronic: 0, resolved: 0, unverifiable: 0, total: 1 } } }),
    liveProblems: [
      {
        id: 'forrest_engine_cycle_timeouts_clear',
        state: 'open',
        claim: 'forrest engine has no cycle timeout exceeded events in the last 30 minutes',
        openedAt: '2026-05-08T13:30:00.000Z',
        lastResult: { detail: '2 matching log entries in last 30m (limit 0); scanned 498' },
        stepIndex: 1,
        remediation: [
          { type: 'dispatch_to_worker', args: { worker: 'systems', budgetHours: 2 } },
          { type: 'dispatch_to_agent', args: { budgetHours: 2 }, cooldownMin: 30 },
        ],
        remediationLog: [
          {
            step: 1,
            type: 'dispatch_to_worker',
            outcome: 'dispatched',
            detail: 'Forrest is online and fresh, but the verifier window is still failing.',
            at: '2026-05-08T13:42:00.000Z',
          },
        ],
      },
    ],
    now: NOW,
  });

  assert.ok(model.operatorAnswer.some((line) => line.includes('Top live problem: forrest_engine_cycle_timeouts_clear')));
  assert.equal(model.liveProblems.open[0].issue, 'forrest engine has recent cycle timeout exceeded events in the last 30 minutes');
  assert.match(model.operatorBrief.why, /forrest engine has recent cycle timeout exceeded events/);
  assert.match(model.operatorDigest.issue, /forrest engine has recent cycle timeout exceeded events/);
  assert.ok(model.operatorAnswer.some((line) => line.includes('Verifier: 2 matching log entries in last 30m')));
  assert.ok(model.operatorAnswer.some((line) => line.includes('Latest fix attempt: dispatch_to_worker dispatched')));
  assert.ok(model.operatorAnswer.some((line) => line.includes('Next autonomous step: dispatch_to_agent')));
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
  assert.equal(model.operatorBrief.severity, 'repairing');
  assert.equal(model.operatorBrief.status, 'Repairing');
  assert.equal(model.operatorBrief.activeProblemId, 'agenda_a');
  assert.ok(model.operatorAnswer.some((line) => line.includes('0 open, 2 chronic')));
});

test('Good Life operator brief calls out projection mismatch when registry is clear', () => {
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState({
      lanes: {
        viability: { status: 'critical', reasons: ['1 unresolved live problem(s)'] },
      },
      evidence: {
        liveProblems: { open: 1, chronic: 0, resolved: 11, unverifiable: 0, total: 12 },
      },
    }),
    liveProblems: [
      { id: 'resolved_a', state: 'resolved', claim: 'Open issue cleared', resolvedAt: '2026-05-08T13:40:00.000Z' },
    ],
    now: NOW,
  });

  assert.equal(model.status, 'conflicted');
  assert.equal(model.liveProblems.counts.open, 0);
  assert.equal(model.operatorBrief.severity, 'attention');
  assert.equal(model.operatorBrief.status, 'Reconciling');
  assert.match(model.operatorBrief.headline, /projection disagrees/);
  assert.match(model.operatorBrief.why, /open projected 1, registry 0/);
  assert.equal(model.operatorBrief.target.tab, 'insights');
});

test('Good Life operator warns when projected open goals disagree with active goal list', () => {
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState({
      evidence: {
        goals: { open: 1, complete: 0, total: 1 },
      },
    }),
    liveProblems: [],
    obligations: { activeAgenda: [], activeGoals: [], counts: { activeAgenda: 0, activeGoals: 0, activeGoalsTrusted: true } },
    now: NOW,
  });

  assert.equal(model.status, 'current');
  assert.equal(model.safeToInherit, false);
  assert.ok(model.consistency.warnings.some((warning) => warning.code === 'good_life_goal_projection_mismatch'));
  assert.ok(model.operatorAnswer.some((line) => line.includes('Good Life goal count disagrees with active goals')));
  assert.equal(model.operatorBrief.severity, 'attention');
  assert.equal(model.operatorBrief.target.tab, 'insights');
});

test('Good Life operator accepts capped active goal summaries when total count matches projection', () => {
  const activeGoals = Array.from({ length: 12 }, (_, index) => ({
    id: `goal_${index + 1}`,
    description: `Visible goal ${index + 1}`,
    status: 'active',
    progress: 0,
    createdAt: `2026-05-09T14:${String(index).padStart(2, '0')}:00.000Z`,
  }));
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState({
      evidence: {
        goals: { open: 20, complete: 0, total: 20 },
      },
    }),
    liveProblems: [],
    obligations: {
      activeAgenda: [],
      activeGoals,
      counts: { activeAgenda: 0, activeGoals: 20, activeGoalsShown: 12, activeGoalsTrusted: true },
    },
    now: NOW,
  });

  assert.equal(model.safeToInherit, true);
  assert.equal(model.work.activeGoals, 20);
  assert.equal(model.work.activeGoalsShown, 12);
  assert.equal(model.work.activeTotal, 20);
  assert.ok(!model.consistency.warnings.some((warning) => warning.code === 'good_life_goal_projection_mismatch'));
  assert.ok(model.operatorAnswer.some((line) => line.includes('Active work: 20')));
});

test('Good Life operator brief names clear state and latest resolution receipt', () => {
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState(),
    liveProblems: [
      {
        id: 'cycle_timeout_clear',
        state: 'resolved',
        claim: 'Cycle timeout verifier is clear',
        resolvedAt: '2026-05-08T13:44:00.000Z',
        lastResult: { detail: '0 matching log entries in last 30m' },
        evidence: { receiptPath: 'instances/jerry/brain/evidence/live-problems/receipt.json' },
      },
    ],
    now: NOW,
  });

  assert.equal(model.operatorBrief.severity, 'clear');
  assert.equal(model.operatorBrief.headline, 'No active issues after recent repairs');
  assert.equal(model.operatorBrief.latestResolution.id, 'cycle_timeout_clear');
  assert.match(model.operatorBrief.next, /0 matching log entries/);
  assert.deepEqual(model.operatorBrief.target, {
    tab: 'resolutions',
    id: 'cycle_timeout_clear',
    label: 'View Resolution',
    worker: null,
  });
});

test('Good Life operator answer names latest verified resolution in clear state', () => {
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState(),
    liveProblems: [
      {
        id: 'weather_sensor_fresh',
        state: 'resolved',
        claim: 'Weather tile sensor refreshing within last 30 min',
        resolvedAt: '2026-05-08T13:44:00.000Z',
        lastResult: { detail: 'weather sensor timestamp passed freshness check' },
        fixRecipe: {
          summary: 'Weather freshness passed after republishing the tile-backed sensor.',
          verifierStatus: 'pass',
        },
        evidence: {
          receiptId: 'ev_weather',
          receiptPath: 'instances/jerry/brain/evidence/live-problems/weather.evidence.json',
        },
      },
    ],
    now: NOW,
  });

  assert.ok(model.operatorAnswer.some((line) => line.includes('Latest verified resolution: Weather freshness passed')));
  assert.ok(model.operatorAnswer.some((line) => line.includes('Resolution verifier: weather sensor timestamp passed freshness check')));
  assert.ok(model.operatorAnswer.some((line) => line.includes('Resolution receipt: ev_weather')));
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

test('Good Life operator model escalates unavailable runtime services', () => {
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState(),
    liveProblems: [],
    runtime: {
      ok: false,
      services: [
        { id: 'engine', label: 'Jerry engine admin', ok: false, error: 'fetch failed' },
        { id: 'harness', label: 'Jerry harness bridge', ok: true },
      ],
    },
    now: NOW,
  });

  assert.equal(model.status, 'critical');
  assert.equal(model.safeToInherit, false);
  assert.equal(model.runtime.ok, false);
  assert.ok(model.consistency.warnings.some((warning) => warning.code === 'runtime_engine_unavailable'));
  assert.ok(model.operatorAnswer.some((line) => line.includes('Jerry engine admin is unavailable')));
});

test('Good Life operator model reports engine admin timeout without overriding clean registry', () => {
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState(),
    liveProblems: [],
    runtime: {
      ok: false,
      services: [
        { id: 'engine', label: 'Forrest engine admin', ok: false, error: 'The operation was aborted due to timeout' },
        { id: 'harness', label: 'Forrest harness bridge', ok: true },
      ],
    },
    now: NOW,
  });

  const warning = model.consistency.warnings.find((item) => item.code === 'runtime_engine_unavailable');
  assert.equal(model.status, 'current');
  assert.equal(model.safeToInherit, false);
  assert.equal(warning?.severity, 'warning');
  assert.ok(model.operatorAnswer.some((line) => line.includes('Forrest engine admin is unavailable')));
});

test('Good Life operator model reports slow runtime services without calling them unavailable', () => {
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState(),
    liveProblems: [],
    runtime: {
      ok: true,
      services: [
        { id: 'engine', label: 'Forrest engine realtime', ok: true, status: 200, latencyMs: 6200, slow: true, slowThresholdMs: 5000 },
        { id: 'harness', label: 'Forrest harness bridge', ok: true, status: 200, latencyMs: 12 },
      ],
    },
    now: NOW,
  });

  const warning = model.consistency.warnings.find((item) => item.code === 'runtime_engine_slow');
  assert.equal(model.status, 'current');
  assert.equal(model.operatorBrief.status, 'Attention');
  assert.equal(model.safeToInherit, false);
  assert.equal(warning?.severity, 'warning');
  assert.match(warning?.message || '', /slow/);
  assert.equal(model.consistency.warnings.some((item) => item.code === 'runtime_engine_unavailable'), false);
  assert.ok(model.operatorAnswer.some((line) => line.includes('Forrest engine realtime is slow')));
  assert.match(model.operatorDigest.userAction, /No user action needed; Home23 is watching/);
});

test('Good Life operator treats PM2-online degraded runtime health as advisory', () => {
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState(),
    liveProblems: [],
    runtime: {
      ok: true,
      services: [
        {
          id: 'engine',
          label: 'Jerry engine realtime',
          ok: true,
          degraded: true,
          fallback: 'pm2-online',
          slow: true,
          pm2: { name: 'home23-jerry', status: 'online' },
          error: 'health endpoint timed out or did not answer; home23-jerry is online in PM2',
        },
        { id: 'harness', label: 'Jerry harness bridge', ok: true, status: 200, latencyMs: 12 },
      ],
    },
    now: NOW,
  });

  const advisory = model.consistency.warnings.find((item) => item.code === 'runtime_engine_slow');
  assert.equal(model.status, 'current');
  assert.equal(model.operatorBrief.status, 'Clear');
  assert.equal(model.safeToInherit, true);
  assert.equal(advisory?.severity, 'info');
  assert.match(advisory?.message || '', /home23-jerry is online/);
});

test('Good Life operator model builds end-user detail sections for drill-down navigation', () => {
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState({
      evidence: {
        liveProblems: { open: 0, chronic: 1, resolved: 1, unverifiable: 0, total: 2 },
      },
    }),
    commitments: {
      commitments: [
        { id: 'continuity', lane: 'continuity', active: true, status: 'strained', title: 'Preserve continuity', reasons: ['16 open goals'] },
        { id: 'development', lane: 'development', active: false, status: 'healthy', title: 'Learn from evidence' },
      ],
    },
    trends: {
      latest: {
        at: '2026-05-08T13:43:00.000Z',
        policy: 'help',
        metrics: { openLiveProblems: 1, pendingAgenda: 145, lastUsefulOutputAt: '2026-05-08T13:30:00.000Z' },
      },
    },
    regulator: {
      daily: {
        date: '2026-05-08',
        actions: [
          { at: '2026-05-08T12:00:00.000Z', agendaId: 'ag-old', mode: 'repair' },
          { at: '2026-05-08T13:00:00.000Z', agendaId: 'ag-new', mode: 'help' },
        ],
      },
    },
    obligations: {
      activeAgenda: [{ id: 'ag-visible', status: 'surfaced', content: 'Visible operator work' }],
      activeGoals: [{ id: 'goal-visible', status: 'active', description: 'Visible operator goal' }],
      counts: { activeAgenda: 1, activeGoals: 1 },
    },
    liveProblems: [
      { id: 'chronic_1', state: 'chronic', claim: 'Chronic thing', openedAt: '2026-05-08T13:00:00.000Z', lastResult: { detail: 'still failing' } },
      {
        id: 'resolved_1',
        state: 'resolved',
        claim: 'Resolved thing',
        resolvedAt: '2026-05-08T13:44:00.000Z',
        fixRecipe: { summary: 'Restarted the dashboard' },
        evidence: { receiptId: 'ev_resolved_1', result: 'pass', claimLevel: 'verified_claim' },
      },
    ],
    ledgerTail: [
      { at: '2026-05-08T13:40:00.000Z', event: 'good_life.evaluated', summary: 'help mode', evidence: { heavy: 'x'.repeat(10_000) } },
      { schema: 'home23.good-life.v1', evaluatedAt: '2026-05-08T13:42:00.000Z', policy: { mode: 'learn' }, summary: 'learn mode' },
    ],
    now: NOW,
  });

  assert.equal(model.detail.issues.activeCount, 1);
  assert.equal(model.detail.issues.rows[0].id, 'chronic_1');
  assert.equal(model.detail.work.dailyActions[0].agendaId, 'ag-new');
  assert.equal(model.detail.work.daily.actions, undefined);
  assert.equal(model.detail.work.obligations.activeAgenda[0].id, 'ag-visible');
  assert.equal(model.detail.work.obligations.activeGoals[0].id, 'goal-visible');
  assert.equal(model.detail.work.obligations.latestAgendaById, undefined);
  assert.equal(model.detail.work.summary.activeTotal, 2);
  assert.equal(model.detail.resolutions.recent[0].id, 'resolved_1');
  assert.equal(model.detail.resolutions.recent[0].evidence.receiptId, 'ev_resolved_1');
  assert.equal(model.detail.insights.activeCommitments[0].id, 'continuity');
  assert.equal(model.detail.insights.trendMetrics.pendingAgenda, 145);
  assert.equal(model.detail.insights.ledgerTail[0].event, 'good_life.evaluated');
  assert.equal(model.detail.insights.ledgerTail[0].at, '2026-05-08T13:42:00.000Z');
  assert.equal(model.detail.insights.ledgerTail[0].mode, 'learn');
  assert.equal(model.detail.insights.ledgerTail[0].evidence, undefined);
  assert.equal(model.ledgerTail[0].evidence, undefined);
});

test('Good Life operator answer includes active work and review-needed goals', () => {
  const obligations = buildGoodLifeObligationSnapshot({
    goals: {
      active: [
        ['goal_force', {
          id: 'goal_force',
          description: 'Produce outputs/digest-6382.md',
          status: 'active',
          source: { origin: 'force-output', label: 'force-output' },
          progress: 0,
          createdAt: '2026-05-07T23:00:00.000Z',
        }],
      ],
    },
    now: NOW,
  });
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState(),
    obligations,
    liveProblems: [],
    now: NOW,
  });

  assert.equal(model.work.activeGoals, 1);
  assert.equal(model.work.goalsNeedingReview, 1);
  assert.equal(model.work.status, 'review');
  assert.match(model.work.statusText, /review recommended: force-output goal has no observable progress/);
  assert.ok(model.operatorAnswer.some((line) => line.includes('Active work: 1; 1 goal(s) need operator review; top review goal: goal_force - Produce outputs/digest-6382.md')));
  assert.match(model.operatorHandoff.situation, /No active live problems/);
  assert.match(model.operatorHandoff.userAction, /review recommended/);
  assert.equal(model.operatorHandoff.needsUser, false);
});

test('Good Life operator handoff names issue, repair path, and required user action', () => {
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState({
      evidence: {
        liveProblems: { open: 1, chronic: 0, resolved: 0, unverifiable: 0, total: 1 },
      },
    }),
    liveProblems: [
      {
        id: 'bridge_auth',
        state: 'open',
        claim: 'OAuth bridge needs a user approval decision',
        openedAt: '2026-05-08T13:00:00.000Z',
        stepIndex: 1,
        remediation: [
          { type: 'dispatch_to_agent', args: { budgetHours: 2 } },
          { type: 'request_user_input', args: { text: 'Approve the OAuth bridge import in Settings.' } },
        ],
      },
    ],
    now: NOW,
  });

  assert.equal(model.operatorHandoff.status, 'Needs jtr');
  assert.equal(model.operatorHandoff.needsUser, true);
  assert.match(model.operatorHandoff.situation, /OAuth bridge needs a user approval decision/);
  assert.match(model.operatorHandoff.repair, /Next repair step: request_user_input/);
  assert.match(model.operatorHandoff.userAction, /Approve the OAuth bridge import/);
  assert.deepEqual(model.operatorHandoff.evidence[0], {
    label: 'Live registry',
    value: '1 open / 0 chronic',
    detail: '1 needs user intervention',
  });
});

test('Good Life operator handoff summarizes recent verified fixes when clear', () => {
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState(),
    liveProblems: [
      {
        id: 'runtime_fixed',
        state: 'resolved',
        claim: 'Runtime probe recovered',
        resolvedAt: '2026-05-08T13:44:00.000Z',
        fixRecipe: { summary: 'Restarted the scoped dashboard process and verified /api/good-life.' },
        lastResult: { detail: '200 response in 34ms' },
        evidence: { receiptId: 'ev_runtime_fixed', result: 'pass' },
      },
    ],
    now: NOW,
  });

  assert.equal(model.operatorHandoff.status, 'Clear');
  assert.equal(model.operatorHandoff.needsUser, false);
  assert.match(model.operatorHandoff.situation, /No active live problems/);
  assert.match(model.operatorHandoff.repair, /Restarted the scoped dashboard process/);
  assert.match(model.operatorHandoff.userAction, /No user action needed/);
  assert.equal(model.operatorHandoff.evidence[1].label, 'Latest resolution');
  assert.equal(model.operatorHandoff.evidence[1].value, 'runtime_fixed');
});

test('Good Life operator surfaces exhausted self-maintenance budget as paused autonomy', () => {
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState({
      summary: 'learn - no critical drift; pursue learning progress while staying useful (usefulness:watch)',
      policy: {
        mode: 'learn',
        reason: 'no critical drift; pursue learning progress while staying useful',
        actionCard: {
          intent: 'learn',
          goodLifeLanes: ['usefulness'],
          evidenceRequired: true,
          riskTier: 0,
          reversible: true,
          expectedOutcome: 'new learning-progress evidence is produced and grounded',
          stopCondition: 'finding is crystallized or discarded with evidence',
        },
      },
      lanes: {
        viability: { status: 'healthy', reasons: ['core engine evidence is flowing'] },
        usefulness: { status: 'watch', reasons: ['usefulness must be proven by visible progress'] },
      },
      evidence: {
        liveProblems: { open: 0, chronic: 0, resolved: 0, unverifiable: 0, total: 0 },
        goals: { open: 0, total: 0 },
        agenda: { pending: 0 },
      },
    }),
    regulator: {
      daily: {
        date: '2026-05-08',
        selfMaintenanceActions: 4,
        actions: [
          { at: '2026-05-08T09:00:00.000Z', agendaId: 'ag-learn-1', mode: 'learn', category: 'grounded-learning' },
          { at: '2026-05-08T10:00:00.000Z', agendaId: 'ag-rest-1', mode: 'rest', category: 'reduces-friction' },
          { at: '2026-05-08T11:00:00.000Z', agendaId: 'ag-learn-2', mode: 'learn', category: 'grounded-learning' },
          { at: '2026-05-08T12:00:00.000Z', agendaId: 'ag-rest-2', mode: 'rest', category: 'reduces-friction' },
        ],
      },
    },
    liveProblems: [],
    obligations: { activeAgenda: [], activeGoals: [], counts: { activeAgenda: 0, activeGoals: 0, activeGoalsTrusted: true } },
    now: NOW,
  });

  assert.equal(model.autonomyBudget.exhausted, true);
  assert.equal(model.autonomyBudget.used, 4);
  assert.equal(model.autonomyBudget.limit, 4);
  assert.equal(model.operatorBrief.status, 'Paused');
  assert.match(model.operatorBrief.headline, /self-maintenance budget is spent/);
  assert.match(model.operatorHandoff.repair, /self-maintenance budget is 4\/4/);
  assert.match(model.operatorHandoff.userAction, /No user action needed/);
  assert.equal(model.operatorHandoff.evidence[1].label, 'Autonomy budget');
  assert.match(model.operatorAnswer.find((line) => line.startsWith('Autonomy budget:')), /4\/4 self-maintenance actions used/);
  assert.equal(model.detail.work.daily.selfMaintenanceLimit, 4);
  assert.equal(model.detail.work.daily.selfMaintenanceExhausted, true);
  assert.equal(model.detail.insights.autonomyBudget.status, 'exhausted');
});

test('Good Life operator does not present active learn work as working when budget is exhausted', () => {
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState({
      summary: 'learn - no critical drift; pursue learning progress while staying useful (usefulness:watch)',
      policy: {
        mode: 'learn',
        reason: 'no critical drift; pursue learning progress while staying useful',
        actionCard: {
          intent: 'learn',
          goodLifeLanes: ['usefulness'],
          evidenceRequired: true,
          riskTier: 0,
          reversible: true,
          expectedOutcome: 'new learning-progress evidence is produced and grounded',
          stopCondition: 'finding is crystallized or discarded with evidence',
        },
      },
      lanes: {
        usefulness: { status: 'watch', reasons: ['usefulness must be proven by visible progress'] },
      },
      evidence: {
        liveProblems: { open: 0, chronic: 0, resolved: 0, unverifiable: 0, total: 0 },
        goals: { open: 1, total: 1 },
        agenda: { pending: 0 },
      },
    }),
    regulator: {
      daily: {
        date: '2026-05-08',
        actions: [
          { at: '2026-05-08T09:00:00.000Z', agendaId: 'ag-learn-1', mode: 'learn', category: 'grounded-learning' },
          { at: '2026-05-08T10:00:00.000Z', agendaId: 'ag-rest-1', mode: 'rest', category: 'reduces-friction' },
          { at: '2026-05-08T11:00:00.000Z', agendaId: 'ag-learn-2', mode: 'learn', category: 'grounded-learning' },
          { at: '2026-05-08T12:00:00.000Z', agendaId: 'ag-rest-2', mode: 'rest', category: 'reduces-friction' },
        ],
      },
    },
    liveProblems: [],
    obligations: {
      activeAgenda: [],
      activeGoals: [{
        id: 'synthesis_7004',
        description: 'Consolidate recent cognitive work into a comprehensive knowledge report.',
        rawDescription: 'Consolidate recent cognitive work into a comprehensive knowledge report.',
        status: 'active',
        source: 'system_scheduler',
        progress: 0.42,
        createdAt: NOW,
        review: { recommended: false, required: false },
      }],
      counts: { activeAgenda: 0, activeGoals: 1, activeGoalsShown: 1, activeGoalsTrusted: true },
    },
    now: NOW,
  });

  assert.equal(model.operatorBrief.status, 'Paused');
  assert.match(model.operatorBrief.next, /1 active work item waiting/);
  assert.equal(model.operatorBrief.target.tab, 'work');
  assert.match(model.operatorDigest.currentWork, /^Paused by daily budget:/);
  assert.match(model.operatorDigest.userAction, /self-maintenance is paused by daily budget/);
  assert.match(model.operatorHandoff.repair, /self-maintenance budget is 4\/4/);
});

test('Good Life operator shows repair mode bypasses spent self-maintenance budget', () => {
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState({
      summary: 'repair - critical viability drift',
      policy: {
        mode: 'repair',
        reason: 'critical viability drift',
        actionCard: {
          intent: 'repair',
          goodLifeLanes: ['viability'],
          evidenceRequired: true,
          riskTier: 1,
          reversible: true,
          expectedOutcome: 'verified system evidence returns to healthy bounds',
          stopCondition: 'verifier passes or repair path escalates',
        },
      },
      lanes: {
        viability: { status: 'critical', reasons: ['1 unresolved live problem'] },
      },
      evidence: {
        liveProblems: { open: 1, chronic: 0, resolved: 0, unverifiable: 0, total: 1 },
      },
    }),
    regulator: {
      daily: {
        date: '2026-05-08',
        selfMaintenanceActions: 5,
        actions: [],
      },
    },
    liveProblems: [
      { id: 'engine_repair', state: 'open', claim: 'Engine repair needed', remediation: [{ type: 'dispatch_to_worker' }] },
    ],
    now: NOW,
  });

  assert.equal(model.autonomyBudget.exhausted, false);
  assert.equal(model.autonomyBudget.bypassed, true);
  assert.equal(model.autonomyBudget.status, 'bypassed');
  assert.match(model.autonomyBudget.reason, /repair work can still run/);
  assert.equal(model.operatorBrief.status, 'Repairing');
});

test('Good Life operator budget excludes repair/help bypass actions from self-maintenance usage', () => {
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState({
      summary: 'rest - pressure is easing',
      policy: {
        mode: 'rest',
        reason: 'reduce loop pressure while preserving obligations',
        actionCard: {
          intent: 'rest',
          goodLifeLanes: ['friction'],
          evidenceRequired: true,
          riskTier: 0,
          reversible: true,
          expectedOutcome: 'lower loop pressure',
          stopCondition: 'obligations preserved',
        },
      },
      lanes: {
        friction: { status: 'watch', reasons: ['loop pressure is high'] },
      },
      evidence: {
        liveProblems: { open: 0, chronic: 0, resolved: 0, unverifiable: 0, total: 0 },
      },
    }),
    regulator: {
      daily: {
        date: '2026-05-08',
        selfMaintenanceActions: 7,
        actions: [
          { at: '2026-05-08T09:00:00.000Z', agendaId: 'ag-learn-1', mode: 'learn', category: 'grounded-learning' },
          { at: '2026-05-08T09:10:00.000Z', agendaId: 'ag-repair-1', mode: 'repair', category: 'resolves-drift' },
          { at: '2026-05-08T09:20:00.000Z', agendaId: 'ag-help-1', mode: 'help', category: 'visible-progress' },
          { at: '2026-05-08T09:30:00.000Z', agendaId: 'ag-repair-2', mode: 'repair', category: 'resolves-drift', budgetedSelfMaintenance: false },
          { at: '2026-05-08T09:40:00.000Z', agendaId: 'ag-rest-1', mode: 'rest', category: 'reduces-friction' },
        ],
      },
    },
    liveProblems: [],
    obligations: { activeAgenda: [], activeGoals: [], counts: { activeAgenda: 0, activeGoals: 0, activeGoalsTrusted: true } },
    now: NOW,
  });

  assert.equal(model.autonomyBudget.used, 2);
  assert.equal(model.autonomyBudget.bypassUsed, 3);
  assert.equal(model.autonomyBudget.exhausted, false);
  assert.equal(model.autonomyBudget.status, 'available');
  assert.match(model.autonomyBudget.reason, /3 repair\/help actions bypassed/);
  assert.equal(model.operatorBrief.status, 'Clear');
  assert.equal(model.detail.work.daily.selfMaintenanceActions, 2);
  assert.equal(model.detail.work.daily.bypassActions, 3);
});

test('Good Life operator answer names reviewed goal before first active goal', () => {
  const obligations = buildGoodLifeObligationSnapshot({
    goals: {
      active: [
        ['goal_recent', {
          id: 'goal_recent',
          description: 'Recently created active goal',
          status: 'active',
          source: { origin: 'follow_up', label: 'follow-up' },
          progress: 0,
          createdAt: '2026-05-09T14:50:00.000Z',
        }],
        ['goal_force', {
          id: 'goal_force',
          description: 'Produce outputs/digest-6382.md',
          status: 'active',
          source: { origin: 'force-output', label: 'force-output' },
          progress: 0,
          createdAt: '2026-05-07T23:00:00.000Z',
        }],
      ],
    },
    now: NOW,
  });
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState(),
    obligations,
    liveProblems: [],
    now: NOW,
  });

  assert.equal(model.work.activeGoals, 2);
  assert.equal(model.work.goalsNeedingReview, 1);
  const line = model.operatorAnswer.find((entry) => entry.includes('goal(s) need operator review'));
  assert.match(line, /top review goal: goal_force - Produce outputs\/digest-6382\.md/);
  assert.doesNotMatch(line, /top goal goal_recent/);
});

test('Good Life operator answer includes agenda rows needing review', () => {
  const obligations = buildGoodLifeObligationSnapshot({
    agendaRows: [
      {
        type: 'add',
        id: 'ag-old-good-life',
        record: {
          status: 'candidate',
          content: 'Diagnose Good Life repair drift',
          sourceSignal: 'good-life',
          topicTags: ['good-life', 'good-life:repair'],
          createdAt: '2026-05-08T11:30:00.000Z',
        },
      },
    ],
    now: NOW,
  });
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState(),
    obligations,
    liveProblems: [],
    now: NOW,
  });

  assert.equal(model.work.activeAgenda, 1);
  assert.equal(model.work.agendaNeedingReview, 1);
  assert.ok(model.operatorAnswer.some((line) => line.includes('Active work: 1; 1 agenda row(s) need review; top agenda ag-old-good-life')));
});

test('Good Life operator answer exposes latest recommended worker route', () => {
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState(),
    regulator: {
      'repair:viability:critical': {
        at: NOW,
        agendaId: 'ag-worker-route',
        mode: 'repair',
        summary: 'repair - critical viability drift',
        workerRoute: {
          worker: 'systems',
          reason: 'system viability needs host/process evidence',
        },
      },
    },
    obligations: {
      activeAgenda: [{
        id: 'ag-worker-route',
        status: 'candidate',
        content: 'Repair viability drift',
        workerRoute: {
          worker: 'systems',
          reason: 'system viability needs host/process evidence',
        },
      }],
      activeGoals: [],
      latestAgendaById: {
        'ag-worker-route': { status: 'candidate', updatedAt: NOW },
      },
      counts: { activeAgenda: 1, activeGoals: 0 },
    },
    liveProblems: [],
    now: NOW,
  });

  assert.equal(model.latestRegulatorAction.workerRoute.worker, 'systems');
  assert.ok(model.operatorAnswer.some((line) => line.includes('Worker route: systems - system viability needs host/process evidence')));
  assert.deepEqual(model.operatorBrief.target, {
    tab: 'work',
    id: 'ag-worker-route',
    label: 'Open systems',
    worker: 'systems',
  });
});

test('Good Life operator brief uses inferred worker route for fresh agenda rows', () => {
  const obligations = buildGoodLifeObligationSnapshot({
    agendaRows: [
      {
        type: 'add',
        id: 'ag-fresh-good-life-rest',
        record: {
          status: 'candidate',
          content: 'Diagnose Good Life friction drift and reduce loop pressure',
          sourceSignal: 'good-life',
          topicTags: ['good-life', 'good-life:friction', 'mode:rest'],
          createdAt: '2026-05-08T13:30:00.000Z',
        },
      },
    ],
    now: NOW,
  });
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState(),
    obligations,
    liveProblems: [],
    now: NOW,
  });

  assert.equal(model.operatorBrief.status, 'Working');
  assert.deepEqual(model.operatorBrief.target, {
    tab: 'work',
    id: 'ag-fresh-good-life-rest',
    label: 'Open systems',
    worker: 'systems',
  });
});

test('Good Life operator answer hides worker route for stale latest agenda action', () => {
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState(),
    regulator: {
      'repair:viability:critical': {
        at: NOW,
        agendaId: 'ag-worker-route',
        mode: 'repair',
        summary: 'repair - critical viability drift',
        workerRoute: {
          worker: 'systems',
          reason: 'system viability needs host/process evidence',
        },
      },
    },
    obligations: {
      activeAgenda: [],
      activeGoals: [],
      latestAgendaById: {
        'ag-worker-route': { status: 'stale', updatedAt: NOW },
      },
      counts: { activeAgenda: 0, activeGoals: 0 },
    },
    liveProblems: [],
    now: NOW,
  });

  assert.equal(model.latestRegulatorAction.agendaStatus, 'stale');
  assert.equal(model.work.activeTotal, 0);
  assert.equal(model.operatorAnswer.some((line) => line.includes('Worker route: systems')), false);
  assert.notEqual(model.operatorBrief.target.worker, 'systems');
  assert.notEqual(model.operatorBrief.target.label, 'Open systems');
});

test('Good Life operator brief ignores stale latest worker route when active goals remain', () => {
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState(),
    regulator: {
      'repair:viability:critical': {
        at: NOW,
        agendaId: 'ag-worker-route',
        mode: 'repair',
        summary: 'repair - critical viability drift',
        workerRoute: {
          worker: 'systems',
          reason: 'system viability needs host/process evidence',
        },
      },
    },
    obligations: {
      activeAgenda: [],
      activeGoals: [{
        id: 'goal-visible-progress',
        description: 'Produce visible progress from current evidence',
        status: 'active',
        createdAt: NOW,
      }],
      latestAgendaById: {
        'ag-worker-route': { status: 'stale', updatedAt: NOW },
      },
      counts: { activeAgenda: 0, activeGoals: 1 },
    },
    liveProblems: [],
    now: NOW,
  });

  assert.equal(model.work.activeTotal, 1);
  assert.equal(model.operatorBrief.next, 'Top goal: goal-visible-progress - Produce visible progress from current evidence');
  assert.deepEqual(model.operatorBrief.target, {
    tab: 'work',
    id: 'goal-visible-progress',
    label: 'Review Work',
    worker: null,
  });
});

test('Good Life operator brief includes active goal artifact status', () => {
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState(),
    obligations: {
      activeAgenda: [],
      activeGoals: [{
        id: 'goal-output',
        description: 'Produce outputs/digest-6427.md',
        rawDescription: 'Produce outputs/digest-6427.md. Synthesize current evidence.',
        artifact: {
          relativePath: 'outputs/digest-6427.md',
          exists: false,
        },
        status: 'active',
        source: 'force-output',
        createdAt: NOW,
        ageMin: 60,
      }],
      counts: { activeAgenda: 0, activeGoals: 1 },
    },
    liveProblems: [],
    now: NOW,
  });

  assert.equal(model.operatorBrief.next, 'Top goal: goal-output - Produce outputs/digest-6427.md; artifact pending: outputs/digest-6427.md; review in 11h');
  assert.equal(model.work.status, 'working');
  assert.equal(model.work.statusText, 'artifact pending: outputs/digest-6427.md; review in 11h');
  assert.equal(model.work.topGoal.artifactStatus, 'artifact pending: outputs/digest-6427.md; review in 11h');
  assert.ok(model.operatorAnswer.some((line) => line.includes('artifact pending: outputs/digest-6427.md; review in 11h')));
});

test('Good Life operator digest names top active goal when no artifact is pending', () => {
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState(),
    obligations: {
      activeAgenda: [],
      activeGoals: [{
        id: 'synthesis_7004',
        description: 'Consolidate recent cognitive work into a comprehensive knowledge report.',
        rawDescription: 'Consolidate recent cognitive work into a comprehensive knowledge report.',
        status: 'active',
        source: 'system_scheduler',
        progress: 0.42,
        createdAt: NOW,
        review: { recommended: false, required: false },
      }],
      counts: { activeAgenda: 0, activeGoals: 1, activeGoalsShown: 1, activeGoalsTrusted: true },
    },
    liveProblems: [],
    now: NOW,
  });

  assert.match(model.operatorDigest.currentWork, /synthesis_7004/);
  assert.match(model.operatorDigest.currentWork, /Consolidate recent cognitive work/);
  assert.notEqual(model.operatorDigest.currentWork, 'autonomous work active; no user intervention needed yet');
});

test('Good Life operator marks superseded repair agenda for review when registry is clear', () => {
  const model = buildGoodLifeOperatorModel({
    state: goodLifeState({
      policy: {
        mode: 'learn',
        reason: 'no critical drift; pursue learning progress while staying useful',
        actionCard: {
          intent: 'learn',
          expectedOutcome: 'new learning-progress evidence is produced and grounded',
          stopCondition: 'finding is crystallized or discarded with evidence',
        },
      },
      evidence: {
        liveProblems: { open: 0, chronic: 0, resolved: 13, unverifiable: 0, total: 13 },
      },
    }),
    obligations: {
      activeAgenda: [{
        id: 'ag-repair-old',
        status: 'candidate',
        content: 'Diagnose Good Life repair drift',
        sourceSignal: 'good-life',
        topicTags: ['good-life', 'good-life:repair', 'worker:systems'],
        temporalContext: {
          policy: 'repair',
          workerRoute: {
            worker: 'systems',
            reason: 'system viability needs host/process evidence',
          },
        },
        workerRoute: {
          worker: 'systems',
          reason: 'system viability needs host/process evidence',
        },
      }],
      activeGoals: [],
      latestAgendaById: {
        'ag-repair-old': { status: 'candidate', updatedAt: NOW },
      },
      counts: { activeAgenda: 1, activeGoals: 0 },
    },
    liveProblems: [],
    now: NOW,
  });

  const row = model.detail.work.obligations.activeAgenda[0];
  assert.equal(model.work.agendaNeedingReview, 1);
  assert.equal(row.review.recommended, true);
  assert.match(row.review.reason, /superseded by current learn mode/);
  assert.ok(model.operatorAnswer.some((line) => line.includes('1 agenda row(s) need review')));
  assert.deepEqual(model.operatorBrief.target, {
    tab: 'work',
    id: 'ag-repair-old',
    label: 'Review Work',
    worker: null,
  });
  assert.match(model.operatorBrief.next, /superseded by current learn mode/);
});
