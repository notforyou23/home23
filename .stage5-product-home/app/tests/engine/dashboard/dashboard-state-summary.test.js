import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DashboardServer } = require('../../../engine/src/dashboard/server.js');

test('dashboard thought summary reads the latest thought from a large log tail', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-dashboard-summary-'));
  const thoughtsPath = path.join(dir, 'thoughts.jsonl');
  const pad = 'x'.repeat(1024);
  const lines = [];
  for (let i = 0; i < 6000; i += 1) {
    lines.push(JSON.stringify({ cycle: i, role: 'noise', thought: pad }));
  }
  lines.push(JSON.stringify({ cycle: 6000, role: 'curiosity', thought: 'latest useful thought' }));
  await fs.writeFile(thoughtsPath, `${lines.join('\n')}\n`, 'utf8');

  const server = Object.create(DashboardServer.prototype);
  server._thoughtSummaryCache = new Map();
  const summary = await server.getThoughtsSummaryForDir(dir);

  assert.equal(summary.lastThought.cycle, 6000);
  assert.equal(summary.lastThought.thought, 'latest useful thought');
  assert.equal(summary.count, null);
  assert.equal(summary.source, 'tail');
});

test('dashboard home summary falls back to latest cycle when thought count is tail-only', async () => {
  const server = Object.create(DashboardServer.prototype);
  server.getThoughtsSummary = async () => ({
    count: null,
    lastThought: {
      cycle: 6996,
      role: 'analyst',
      thought: 'latest thought',
      timestamp: '2026-05-10T03:12:27.329Z',
      cognitiveState: { energy: 0.42, mode: 'active' },
      oscillatorMode: 'explore',
      model: 'internal',
    },
  });
  server.getFastMemoryGraphSummary = async () => ({ nodes: 10, edges: 20, clusters: 2, source: 'test' });
  server.getFastGoalSummary = async () => ({ active: 1, completed: 2, archived: 3, source: 'test' });

  const summary = await server.buildHomeSummary();

  assert.equal(summary.cycleCount, 6996);
  assert.equal(summary.thoughtCount, 6996);
  assert.equal(summary.lastThoughtText, 'latest thought');
  assert.deepEqual(summary.cognitiveState, { energy: 0.42, mode: 'active' });
  assert.equal(summary.oscillatorMode, 'explore');
  assert.equal(summary.model, 'internal');
});

test('fast graph summary uses manifest cluster count when optional brain snapshot omits it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-dashboard-manifest-summary-'));
  await fs.writeFile(path.join(dir, 'brain-snapshot.json'), JSON.stringify({ nodeCount: 42, edgeCount: 84 }));
  await fs.writeFile(path.join(dir, 'memory-manifest.json'), JSON.stringify({
    schema: 'home23.memory-manifest.v1',
    generation: 'gen-1',
    summary: { nodeCount: 42, edgeCount: 84, clusterCount: 7 },
  }));

  const server = Object.create(DashboardServer.prototype);
  server.logsDir = dir;

  assert.deepEqual(await server.getFastMemoryGraphSummary(), {
    nodes: 42, edges: 84, clusters: 7, source: 'brain-snapshot',
  });
});
