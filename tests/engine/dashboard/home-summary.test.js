import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.OPENAI_API_KEY ||= 'test-key';
const { DashboardServer } = require('../../../engine/src/dashboard/server');

test('home summary reads graph and goal counts from lightweight disk truth', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-dashboard-summary-'));
  fs.writeFileSync(
    path.join(dir, 'brain-snapshot.json'),
    JSON.stringify({ nodeCount: 51_328, edgeCount: 80_230, clusterCount: 7 })
  );
  fs.writeFileSync(
    path.join(dir, 'state.json.gz'),
    zlib.gzipSync(JSON.stringify({
      goals: {
        active: [['goal_1', { id: 'goal_1' }], ['goal_2', { id: 'goal_2' }]],
        completed: [{ id: 'goal_done' }],
        archived: [{ id: 'goal_old' }],
      },
    }))
  );

  const server = Object.create(DashboardServer.prototype);
  server.logsDir = dir;
  const summary = await server.buildHomeSummary();

  assert.deepEqual(summary.memoryGraph, {
    nodes: 51_328,
    edges: 80_230,
    clusters: 7,
    source: 'brain-snapshot',
  });
  assert.deepEqual(summary.goals, {
    active: 2,
    completed: 1,
    archived: 1,
    source: 'state',
  });

  fs.rmSync(dir, { recursive: true, force: true });
});

test('fast dashboard summary never opens the authoritative brain source', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-dashboard-summary-'));
  fs.writeFileSync(
    path.join(dir, 'brain-snapshot.json'),
    JSON.stringify({ nodeCount: 51_328, edgeCount: 80_230, clusterCount: 7 })
  );
  let authoritativeReads = 0;
  const server = Object.create(DashboardServer.prototype);
  server.logsDir = dir;
  server.brainSourceService = {
    async status() {
      authoritativeReads += 1;
      return { summary: { nodes: 999_999, edges: 999_999, clusters: 999 } };
    },
  };

  try {
    assert.deepEqual(await server.getFastMemoryGraphSummary(), {
      nodes: 51_328,
      edges: 80_230,
      clusters: 7,
      source: 'brain-snapshot',
    });
    assert.equal(authoritativeReads, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('home summary avoids hydrating memory sidecars for goal counts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-dashboard-summary-'));
  fs.writeFileSync(
    path.join(dir, 'brain-snapshot.json'),
    JSON.stringify({ nodeCount: 61_109, edgeCount: 152_094, clusterCount: 5 })
  );
  fs.writeFileSync(
    path.join(dir, 'state.json.gz'),
    zlib.gzipSync(JSON.stringify({
      memory: { nodes: [], edges: [] },
      goals: {
        active: [{ id: 'goal_1' }],
        completed: [{ id: 'goal_done' }, { id: 'goal_done_2' }],
        archived: [],
      },
    }))
  );
  fs.writeFileSync(path.join(dir, 'memory-nodes.jsonl.gz'), zlib.gzipSync('{"id":"n1","embedding":[1,0]}\n'));
  fs.writeFileSync(path.join(dir, 'memory-edges.jsonl.gz'), zlib.gzipSync('{"source":"n1","target":"n2"}\n'));

  const server = Object.create(DashboardServer.prototype);
  server.logsDir = dir;
  server.logger = console;
  server._stateScalarsCache = null;
  server.loadState = async () => {
    throw new Error('full state hydration should not run for home summary');
  };

  try {
    const summary = await server.buildHomeSummary();

    assert.deepEqual(summary.memoryGraph, {
      nodes: 61_109,
      edges: 152_094,
      clusters: 5,
      source: 'brain-snapshot',
    });
    assert.deepEqual(summary.goals, {
      active: 1,
      completed: 2,
      archived: 0,
      source: 'state',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('home summary reads goal counts from brain snapshot without state parse', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-dashboard-summary-'));
  fs.writeFileSync(
    path.join(dir, 'brain-snapshot.json'),
    JSON.stringify({
      nodeCount: 61_109,
      edgeCount: 152_094,
      clusterCount: 5,
      goalCounts: { active: 17, completed: 3366, archived: 988 },
    })
  );

  const server = Object.create(DashboardServer.prototype);
  server.logsDir = dir;
  server.loadStateScalars = async () => {
    throw new Error('scalar state parse should not run when snapshot has goal counts');
  };

  try {
    const summary = await server.buildHomeSummary();

    assert.deepEqual(summary.goals, {
      active: 17,
      completed: 3366,
      archived: 988,
      source: 'brain-snapshot',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('goals API payload avoids full state memory hydration', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-dashboard-goals-'));
  fs.writeFileSync(
    path.join(dir, 'state.json.gz'),
    zlib.gzipSync(JSON.stringify({
      memory: { nodes: [], edges: [] },
      goals: {
        active: [['goal_1', { id: 'goal_1', description: 'current work' }]],
        completed: [{ id: 'goal_done' }],
        archived: [{ id: 'goal_old' }, { id: 'goal_older' }],
      },
    }))
  );
  fs.writeFileSync(path.join(dir, 'memory-nodes.jsonl.gz'), zlib.gzipSync('{"id":"n1"}\n'));

  const server = Object.create(DashboardServer.prototype);
  server.logsDir = dir;
  server.logger = console;
  server._stateScalarsCache = null;
  server.loadState = async () => {
    throw new Error('full state hydration should not run for /api/goals');
  };

  try {
    const goals = await server.loadGoals();

    assert.equal(goals.source, 'state');
    assert.deepEqual(goals.counts, { active: 1, completed: 1, archived: 2 });
    assert.equal(goals.active[0][0], 'goal_1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('goals API filters completed goals left in active storage', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-dashboard-goals-'));
  fs.writeFileSync(
    path.join(dir, 'state.json.gz'),
    zlib.gzipSync(JSON.stringify({
      goals: {
        active: [
          ['goal_active', { id: 'goal_active', description: 'current work', status: 'active', progress: 0.4 }],
          ['goal_done', { id: 'goal_done', description: 'done but still stored active', status: 'completed', progress: 0.925, completedAt: Date.now() }],
          ['goal_progress_done', { id: 'goal_progress_done', description: 'done by progress', status: 'active', progress: 1 }],
        ],
        completed: [],
        archived: [],
      },
    }))
  );

  const server = Object.create(DashboardServer.prototype);
  server.logsDir = dir;
  server.logger = console;
  server._stateScalarsCache = null;

  try {
    const goals = await server.loadGoals();

    assert.equal(goals.source, 'state');
    assert.deepEqual(goals.counts, { active: 1, completed: 0, archived: 0 });
    assert.deepEqual(goals.active.map(([id]) => id), ['goal_active']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('goals API payload falls back to brain snapshot summaries', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-dashboard-goals-'));
  fs.writeFileSync(
    path.join(dir, 'brain-snapshot.json'),
    JSON.stringify({
      goalCounts: { active: 1, completed: 34, archived: 5 },
      activeGoalSummaries: [{ id: 'goal_7', description: 'snapshot goal' }],
    })
  );

  const server = Object.create(DashboardServer.prototype);
  server.logsDir = dir;
  server.loadStateScalars = async () => ({});
  server.loadState = async () => {
    throw new Error('full state hydration should not run for snapshot fallback');
  };

  try {
    const goals = await server.loadGoals();

    assert.equal(goals.source, 'brain-snapshot');
    assert.deepEqual(goals.counts, { active: 1, completed: 34, archived: 5 });
    assert.equal(goals.active[0][0], 'goal_7');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Good Life snapshot goals trust active summaries over stale snapshot active count', () => {
  const server = Object.create(DashboardServer.prototype);

  const goals = server._goodLifeSnapshotGoals({
    goalCounts: { active: 1, completed: 34, archived: 5 },
    activeGoalSummaries: [],
  });

  assert.deepEqual(goals, {
    active: [],
    counts: { active: 0, completed: 34, archived: 5, shown: 0 },
  });
});

test('Good Life snapshot goals preserve capped active total when summaries hit cap', () => {
  const server = Object.create(DashboardServer.prototype);
  const activeGoalSummaries = Array.from({ length: 12 }, (_, index) => ({
    id: `goal_${index + 1}`,
    description: `Goal ${index + 1}`,
  }));

  const goals = server._goodLifeSnapshotGoals({
    goalCounts: { active: 20, completed: 34, archived: 5 },
    activeGoalSummaries,
  });

  assert.equal(goals.counts.active, 20);
  assert.equal(goals.counts.shown, 12);
  assert.equal(goals.active.length, 12);
});
