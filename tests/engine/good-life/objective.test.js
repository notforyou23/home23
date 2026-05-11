import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { GoodLifeObjective } = require('../../../engine/src/good-life/objective.js');

test('GoodLifeObjective treats critical evidence as repair policy', () => {
  const objective = new GoodLifeObjective();
  const evaluation = objective.evaluate({
    now: '2026-05-01T14:00:00.000Z',
    liveProblems: { open: 1, chronic: 0 },
    crystallization: { lastReceiptAt: '2026-05-01T13:59:00.000Z' },
    memory: { nodes: 10, edges: 20 },
  });

  assert.equal(evaluation.schema, 'home23.good-life.v1');
  assert.equal(evaluation.lanes.viability.status, 'critical');
  assert.equal(evaluation.policy.mode, 'repair');
  assert.equal(evaluation.policy.actionCard.intent, 'repair');
  assert.equal(evaluation.policy.actionCard.reversible, true);
});

test('GoodLifeObjective selects learning progress when no drift is critical', () => {
  const objective = new GoodLifeObjective();
  const evaluation = objective.evaluate({
    now: '2026-05-01T14:00:00.000Z',
    liveProblems: { open: 0, chronic: 0 },
    crystallization: { lastReceiptAt: '2026-05-01T13:59:00.000Z' },
    memory: { nodes: 100, edges: 180 },
    discovery: { queueDepth: 4 },
  });

  assert.equal(evaluation.lanes.viability.status, 'healthy');
  assert.equal(evaluation.lanes.development.status, 'healthy');
  assert.equal(evaluation.policy.mode, 'learn');
  assert.match(evaluation.summary, /learn/);
});

test('GoodLifeObjective accepts numeric useful-output timestamps', () => {
  const objective = new GoodLifeObjective();
  const evaluation = objective.evaluate({
    now: '2026-05-01T14:00:00.000Z',
    liveProblems: { open: 0, chronic: 0 },
    crystallization: { lastReceiptAt: '2026-05-01T13:59:00.000Z' },
    memory: { nodes: 100, edges: 180 },
    publish: { lastUsefulOutputAt: Date.parse('2026-04-30T13:00:00.000Z') },
  });

  assert.equal(evaluation.lanes.usefulness.status, 'strained');
  assert.equal(evaluation.policy.mode, 'help');
});

test('GoodLifeObjective treats host resource pressure as friction drift', () => {
  const objective = new GoodLifeObjective();
  const evaluation = objective.evaluate({
    now: '2026-05-10T08:55:00.000Z',
    liveProblems: { open: 0, chronic: 0 },
    crystallization: { lastReceiptAt: '2026-05-10T08:54:00.000Z' },
    memory: { nodes: 100, edges: 180 },
    host: {
      cpu: { loadRatio: 1.04 },
      swap: { usedPct: 91.6 },
      disk: { usagePct: 32 },
    },
  });

  assert.equal(evaluation.lanes.viability.status, 'healthy');
  assert.equal(evaluation.lanes.friction.status, 'strained');
  assert.match(evaluation.lanes.friction.reasons.join(' '), /host load 104% of cores/);
  assert.match(evaluation.lanes.friction.reasons.join(' '), /host swap 92% used/);
  assert.equal(evaluation.policy.mode, 'rest');
  assert.equal(evaluation.evidence.host.swap.usedPct, 91.6);
});

test('GoodLifeObjective preserves PM2 runtime-change evidence', () => {
  const objective = new GoodLifeObjective();
  const pm2 = {
    recentHome23Changes: 3,
    invalidRestartCounters: 1,
    processes: [
      { name: 'home23-jerry-dash', changes: 2, lastChangeStatus: 'online', lastRestartCount: 952 },
    ],
  };
  const evaluation = objective.evaluate({
    now: '2026-05-10T09:20:00.000Z',
    liveProblems: { open: 0, chronic: 0 },
    crystallization: { lastReceiptAt: '2026-05-10T09:19:00.000Z' },
    memory: { nodes: 100, edges: 180 },
    pm2,
  });

  assert.deepEqual(evaluation.evidence.pm2, pm2);
});

test('GoodLifeObjective treats critical host pressure as repair drift', () => {
  const objective = new GoodLifeObjective();
  const evaluation = objective.evaluate({
    now: '2026-05-10T08:55:00.000Z',
    liveProblems: { open: 0, chronic: 0 },
    crystallization: { lastReceiptAt: '2026-05-10T08:54:00.000Z' },
    memory: { nodes: 100, edges: 180 },
    host: {
      swap: { usedPct: 96 },
      disk: { usagePct: 32 },
    },
  });

  assert.equal(evaluation.lanes.viability.status, 'critical');
  assert.match(evaluation.lanes.viability.reasons.join(' '), /host swap 96% used/);
  assert.equal(evaluation.policy.mode, 'repair');
});

test('GoodLifeObjective treats current Home23 PM2 offline state as repair drift', () => {
  const objective = new GoodLifeObjective();
  const evaluation = objective.evaluate({
    now: '2026-05-10T09:35:00.000Z',
    liveProblems: { open: 0, chronic: 0 },
    crystallization: { lastReceiptAt: '2026-05-10T09:34:00.000Z' },
    memory: { nodes: 100, edges: 180 },
    pm2: {
      offline: 1,
      offlineProcesses: [{ name: 'home23-jerry-dash', status: 'stopped' }],
    },
  });

  assert.equal(evaluation.lanes.viability.status, 'critical');
  assert.match(evaluation.lanes.viability.reasons.join(' '), /1 home23 process\(es\) offline/);
  assert.equal(evaluation.policy.mode, 'repair');
});

test('GoodLifeObjective treats failing scheduler jobs as repair drift and preserves evidence', () => {
  const objective = new GoodLifeObjective();
  const scheduler = {
    totalJobs: 5,
    enabledJobs: 4,
    failingJobs: 2,
    maxConsecutiveErrors: 3,
    worstJobs: [
      { name: 'Health freshness job', consecutiveErrors: 3, lastStatus: 'error' },
    ],
  };
  const evaluation = objective.evaluate({
    now: '2026-05-11T13:35:00.000Z',
    liveProblems: { open: 0, chronic: 0 },
    crystallization: { lastReceiptAt: '2026-05-11T13:34:00.000Z' },
    memory: { nodes: 100, edges: 180 },
    scheduler,
  });

  assert.equal(evaluation.lanes.viability.status, 'critical');
  assert.match(evaluation.lanes.viability.reasons.join(' '), /2 failing scheduler job/);
  assert.equal(evaluation.policy.mode, 'repair');
  assert.deepEqual(evaluation.evidence.scheduler, scheduler);
});

test('GoodLifeObjective marks closed memory topology as coherence drift', () => {
  const objective = new GoodLifeObjective();
  const memory = {
    nodes: 120,
    edges: 220,
    topology: {
      schema: 'home23.memory-topology-posture.v1',
      sourceIssues: [72],
      clusters: 4,
      bridgeEdges: 0,
      orphanRatio: 0.02,
      largestClusterShare: 0.62,
      posture: 'closed',
      reasons: ['multiple anchor regions have no bridge edges'],
    },
  };
  const evaluation = objective.evaluate({
    now: '2026-05-11T14:15:00.000Z',
    liveProblems: { open: 0, chronic: 0 },
    crystallization: { lastReceiptAt: '2026-05-11T14:14:00.000Z' },
    memory,
  });

  assert.equal(evaluation.lanes.coherence.status, 'watch');
  assert.match(evaluation.lanes.coherence.reasons.join(' '), /multiple anchor regions have no bridge edges/);
  assert.equal(evaluation.policy.mode, 'learn');
  assert.deepEqual(evaluation.evidence.memory.topology.sourceIssues, [72]);
});
