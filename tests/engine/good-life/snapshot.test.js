import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildGoodLifeSnapshot } = require('../../../engine/src/good-life/snapshot.js');

test('Good Life snapshot excludes its own diagnostic live-problems from viability counts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-good-life-snapshot-'));
  try {
    writeFileSync(join(dir, 'live-problems.json'), JSON.stringify({
      problems: [
        {
          id: 'agenda_ag-good-life',
          state: 'open',
          claim: 'Agenda action: Diagnose Good Life repair drift using instances/jerry/brain/good-life-state.json',
        },
        {
          id: 'agenda_ag-real',
          state: 'open',
          claim: 'Agenda action: Check what process started around the CPU signal',
        },
      ],
    }));

    const snapshot = buildGoodLifeSnapshot({ runtimeRoot: dir });
    assert.equal(snapshot.liveProblems.open, 1);
    assert.equal(snapshot.liveProblems.total, 1);
    assert.equal(snapshot.liveProblems.goodLifeDiagnostics, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Good Life agenda summary counts latest item status, not raw JSONL events', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-good-life-agenda-'));
  try {
    const rows = [
      { type: 'add', id: 'ag-1', record: { status: 'candidate', content: 'first' } },
      { type: 'status', id: 'ag-1', status: 'stale' },
      { type: 'add', id: 'ag-2', record: { status: 'candidate', content: 'second' } },
      { type: 'status', id: 'ag-2', status: 'surfaced' },
      { type: 'add', id: 'ag-3', record: { status: 'candidate', content: 'third' } },
      { type: 'status', id: 'ag-3', status: 'acted_on' },
      { type: 'add', id: 'ag-4', record: { status: 'candidate', content: 'fourth' } },
    ];
    writeFileSync(join(dir, 'agenda.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);

    const snapshot = buildGoodLifeSnapshot({ runtimeRoot: dir });
    assert.equal(snapshot.agenda.pending, 2);
    assert.equal(snapshot.agenda.candidate, 1);
    assert.equal(snapshot.agenda.surfaced, 1);
    assert.equal(snapshot.agenda.stale, 1);
    assert.equal(snapshot.agenda.actedOn, 1);
    assert.equal(snapshot.agenda.sampled, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Good Life goal summary does not count completed goals still present in active storage as open', () => {
  const goals = {
    getGoals() {
      return [
        { id: 'goal-active', status: 'active', progress: 0.25 },
        { id: 'goal-completed-status', status: 'completed', progress: 0.925, completedAt: Date.now() },
        { id: 'goal-complete-status', status: 'complete' },
        { id: 'goal-completed-flag', status: 'active', completed: true },
        { id: 'goal-progress-done', status: 'active', progress: 1 },
        { id: 'goal-archived', status: 'archived' },
      ];
    },
  };

  const snapshot = buildGoodLifeSnapshot({ runtimeRoot: '', goals });

  assert.deepEqual(snapshot.goals, {
    open: 1,
    complete: 5,
    total: 6,
  });
});

test('Good Life goal summary includes active goal obligations from brain snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-good-life-snapshot-'));
  try {
    writeFileSync(join(dir, 'brain-snapshot.json'), JSON.stringify({
      goalCounts: { active: 3, completed: 7, archived: 2 },
      activeGoalSummaries: [
        { id: 'goal-a', status: 'active', progress: 0.2 },
        { id: 'goal-b', status: 'active', progress: 0.4 },
        { id: 'goal-c', status: 'active', progress: 0.6 },
      ],
    }));
    const goals = {
      getGoals() {
        return [
          { id: 'goal-a', status: 'active', progress: 0.2 },
          { id: 'goal-b', status: 'active', progress: 0.4 },
        ];
      },
    };

    const snapshot = buildGoodLifeSnapshot({ runtimeRoot: dir, goals });

    assert.deepEqual(snapshot.goals, {
      open: 3,
      complete: 7,
      total: 10,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Good Life snapshot includes latest machine host pressure evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-good-life-snapshot-'));
  try {
    const channelsDir = join(dir, 'channels');
    writeFileSync(join(dir, '.keep'), '');
    mkdirSync(channelsDir, { recursive: true });
    writeFileSync(join(channelsDir, 'machine.cpu.jsonl'), `${JSON.stringify({
      payload: { at: '2026-05-10T08:54:40.024Z', loadAvg: [10.348, 7.56, 6.69], cpuCount: 10 },
    })}\n`);
    writeFileSync(join(channelsDir, 'machine.memory.jsonl'), `${JSON.stringify({
      payload: { at: '2026-05-10T08:54:40.024Z', total: 17179869184, free: 372604928, freePct: 2.2 },
    })}\n`);
    writeFileSync(join(channelsDir, 'machine.swap.jsonl'), `${JSON.stringify({
      payload: {
        at: '2026-05-10T08:54:11.692Z',
        swap: { totalMb: 8192, usedMb: 7502.75, usedPct: 91.6 },
      },
    })}\n`);
    writeFileSync(join(channelsDir, 'machine.disk.jsonl'), `${JSON.stringify({
      payload: { at: '2026-05-10T08:52:09.784Z', mount: '/', usagePct: 32 },
    })}\n`);

    const snapshot = buildGoodLifeSnapshot({ runtimeRoot: dir });

    assert.equal(snapshot.host.cpu.loadRatio, 1.03);
    assert.equal(snapshot.host.memory.freePct, 2.2);
    assert.equal(snapshot.host.swap.usedPct, 91.6);
    assert.equal(snapshot.host.disk.usagePct, 32);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Good Life action summary prefers structured recent failure counter over prose mentions', () => {
  const snapshot = buildGoodLifeSnapshot({
    runtimeRoot: '',
    orchestrator: {
      journal: [
        {
          thought: 'The forrest engine timeout problem is resolved and the system is healthy.',
          cognitiveState: { recentFailures: 0 },
        },
        {
          thought: 'No current operational issues require action. NO_ACTION',
          cognitiveState: { recentFailures: 0 },
        },
      ],
    },
  });

  assert.equal(snapshot.actions.recentFailures, 0);
});

test('Good Life action summary treats structured recent failures as a window delta', () => {
  const snapshot = buildGoodLifeSnapshot({
    runtimeRoot: '',
    orchestrator: {
      journal: [
        { thought: 'older state', cognitiveState: { recentFailures: 5 } },
        { thought: 'latest state', cognitiveState: { recentFailures: 6 } },
      ],
    },
  });

  assert.equal(snapshot.actions.recentFailures, 1);
});

test('Good Life action summary fallback ignores resolved failure mentions', () => {
  const snapshot = buildGoodLifeSnapshot({
    runtimeRoot: '',
    orchestrator: {
      journal: [
        { thought: 'The engine timeout problem is resolved and the system is healthy.' },
        { thought: 'A worker failed to complete the current action.' },
      ],
    },
  });

  assert.equal(snapshot.actions.recentFailures, 1);
});
