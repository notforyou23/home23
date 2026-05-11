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

test('Good Life snapshot summarizes memory topology openness', () => {
  const memory = {
    nodes: new Map([
      ['n1', { cluster: 1 }],
      ['n2', { cluster: 1 }],
      ['n3', { cluster: 2 }],
      ['n4', { cluster: 2 }],
      ['n5', { cluster: 3 }],
    ]),
    edges: new Map([
      ['n1->n2', { source: 'n1', target: 'n2', type: 'associative' }],
      ['n3->n4', { source: 'n3', target: 'n4', type: 'associative' }],
      ['n2->n3', { source: 'n2', target: 'n3', type: 'bridge' }],
    ]),
    clusters: new Map([
      [1, new Set(['n1', 'n2'])],
      [2, new Set(['n3', 'n4'])],
      [3, new Set(['n5'])],
    ]),
  };

  const snapshot = buildGoodLifeSnapshot({ memory });

  assert.equal(snapshot.memory.nodes, 5);
  assert.equal(snapshot.memory.edges, 3);
  assert.deepEqual(snapshot.memory.topology, {
    schema: 'home23.memory-topology-posture.v1',
    sourceIssues: [72],
    clusters: 3,
    bridgeEdges: 1,
    associativeEdges: 2,
    averageDegree: 1.2,
    bridgeRatio: 0.333,
    orphanNodes: 1,
    orphanRatio: 0.2,
    largestClusterSize: 2,
    largestClusterShare: 0.4,
    posture: 'open',
    reasons: ['multiple anchor regions connected by bridge edges'],
  });
});

test('Good Life snapshot caps stale cluster membership before topology share math', () => {
  const memory = {
    nodes: new Map(Array.from({ length: 20 }, (_, index) => [`n${index}`, { cluster: 1 }])),
    edges: new Map([
      ['n1->n2', { source: 'n1', target: 'n2', type: 'associative' }],
    ]),
    clusters: new Map([
      [1, new Set(Array.from({ length: 40 }, (_, index) => `n${index}`))],
    ]),
  };

  const snapshot = buildGoodLifeSnapshot({ memory });

  assert.equal(snapshot.memory.topology.largestClusterSize, 20);
  assert.equal(snapshot.memory.topology.largestClusterShare, 1);
  assert.match(snapshot.memory.topology.reasons.join(' '), /cluster membership count exceeds current node count/);
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
    writeFileSync(join(channelsDir, 'machine.process.jsonl'), `${JSON.stringify({
      payload: {
        at: '2026-05-10T08:54:42.000Z',
        topCpuPct: 25,
        totalCpuPctTopN: 40,
        topRssBytes: 1073741824,
        totalRssBytesTopN: 2147483648,
        processes: [{ command: 'node engine/src/index.js', pm2Name: 'home23-forrest', cpuPct: 25 }],
        memoryProcesses: [{ command: 'node engine/src/index.js', pm2Name: 'home23-jerry', rssBytes: 1073741824, memPct: 6.3 }],
      },
    })}\n`);
    writeFileSync(join(channelsDir, 'machine.disk.jsonl'), `${JSON.stringify({
      payload: { at: '2026-05-10T08:52:09.784Z', mount: '/', usagePct: 32 },
    })}\n`);

    const snapshot = buildGoodLifeSnapshot({ runtimeRoot: dir });

    assert.equal(snapshot.host.cpu.loadRatio, 1.03);
    assert.equal(snapshot.host.memory.freePct, 2.2);
    assert.equal(snapshot.host.swap.usedPct, 91.6);
    assert.equal(snapshot.host.process.topMemoryProcess.pm2Name, 'home23-jerry');
    assert.equal(snapshot.host.process.topMemoryProcess.rssBytes, 1073741824);
    assert.equal(snapshot.host.disk.usagePct, 32);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Good Life snapshot summarizes recent PM2 restart observations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-good-life-snapshot-'));
  try {
    const channelsDir = join(dir, 'channels');
    mkdirSync(channelsDir, { recursive: true });
    const rows = [
      {
        payload: {
          name: 'home23-jerry-dash',
          status: 'online',
          restartCount: 951,
          prevRestartCount: 950,
          topology: { family: 'home23', role: 'agent-dashboard' },
          at: '2026-05-10T09:13:00.000Z',
        },
      },
      {
        payload: {
          name: 'home23-jerry-dash',
          status: 'online',
          restartCount: 952,
          prevRestartCount: 951,
          topology: { family: 'home23', role: 'agent-dashboard' },
          at: '2026-05-10T09:17:00.000Z',
        },
      },
      {
        payload: {
          name: 'home23-forrest-dash',
          status: 'online',
          restartCount: null,
          rawRestartCount: '171111111111111111111111',
          topology: { family: 'home23', role: 'agent-dashboard' },
          at: '2026-05-10T09:18:00.000Z',
        },
      },
      {
        payload: {
          name: 'external-tool',
          status: 'online',
          restartCount: 2,
          prevRestartCount: 1,
          topology: { family: null, role: 'external-workload' },
          at: '2026-05-10T09:19:00.000Z',
        },
      },
    ];
    writeFileSync(join(channelsDir, 'os.pm2.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);

    const snapshot = buildGoodLifeSnapshot({ runtimeRoot: dir });

    assert.equal(snapshot.pm2.recentHome23Changes, 3);
    assert.equal(snapshot.pm2.invalidRestartCounters, 1);
    assert.equal(snapshot.pm2.processes[0].name, 'home23-jerry-dash');
    assert.equal(snapshot.pm2.processes[0].changes, 2);
    assert.equal(snapshot.pm2.processes[0].lastRestartCount, 952);
    assert.equal(snapshot.pm2.processes[1].name, 'home23-forrest-dash');
    assert.equal(snapshot.pm2.processes[1].lastRestartCount, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Good Life snapshot includes current Home23 PM2 offline counts', () => {
  const snapshot = buildGoodLifeSnapshot({
    runtimeRoot: '',
    currentPm2List: [
      {
        name: 'home23-jerry',
        pm2_env: {
          status: 'online',
          restart_time: 18,
          pm_exec_path: '/Users/jtr/_JTR23_/release/home23/engine/src/index.js',
        },
      },
      {
        name: 'home23-jerry-dash',
        pm2_env: {
          status: 'stopped',
          restart_time: 955,
          pm_exec_path: '/Users/jtr/_JTR23_/release/home23/engine/src/dashboard/server.js',
        },
      },
      {
        name: 'home23-forrest-dash',
        pm2_env: {
          status: 'online',
          restart_time: '171111111111111111111111',
          pm_exec_path: '/Users/jtr/_JTR23_/release/home23/engine/src/dashboard/server.js',
        },
      },
      {
        name: 'external-tool',
        pm2_env: { status: 'stopped', restart_time: 2 },
      },
    ],
  });

  assert.equal(snapshot.pm2.currentTotal, 3);
  assert.equal(snapshot.pm2.offline, 1);
  assert.equal(snapshot.pm2.invalidCurrentRestartCounters, 1);
  assert.deepEqual(snapshot.pm2.offlineProcesses.map((p) => p.name), ['home23-jerry-dash']);
  assert.equal(snapshot.pm2.current.find((p) => p.name === 'home23-forrest-dash').restartCount, null);
});

test('Good Life snapshot summarizes harness scheduler job state from sibling conversations folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-good-life-scheduler-'));
  try {
    const brainDir = join(dir, 'brain');
    const conversationsDir = join(dir, 'conversations');
    mkdirSync(brainDir, { recursive: true });
    mkdirSync(conversationsDir, { recursive: true });
    writeFileSync(join(conversationsDir, 'cron-jobs.json'), JSON.stringify({
      jobs: [
        {
          id: 'cron-ok',
          name: 'Useful publishing job',
          enabled: true,
          state: {
            lastStatus: 'ok',
            consecutiveErrors: 0,
            lastRunAtMs: Date.parse('2026-05-11T13:00:00.000Z'),
            nextRunAtMs: Date.parse('2026-05-11T14:00:00.000Z'),
            lastDurationMs: 1200,
          },
        },
        {
          id: 'cron-bad',
          name: 'Health freshness job',
          enabled: true,
          state: {
            lastStatus: 'error',
            consecutiveErrors: 3,
            lastRunAtMs: Date.parse('2026-05-11T12:00:00.000Z'),
            lastDurationMs: 45000,
          },
        },
        {
          id: 'cron-disabled',
          name: 'Old disabled job',
          enabled: false,
          state: { lastStatus: 'error', consecutiveErrors: 99 },
        },
      ],
    }));

    const snapshot = buildGoodLifeSnapshot({ runtimeRoot: brainDir });

    assert.equal(snapshot.scheduler.totalJobs, 3);
    assert.equal(snapshot.scheduler.enabledJobs, 2);
    assert.equal(snapshot.scheduler.okJobs, 1);
    assert.equal(snapshot.scheduler.failingJobs, 1);
    assert.equal(snapshot.scheduler.maxConsecutiveErrors, 3);
    assert.equal(snapshot.scheduler.worstJobs[0].name, 'Health freshness job');
    assert.equal(snapshot.scheduler.path, join(conversationsDir, 'cron-jobs.json'));
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
