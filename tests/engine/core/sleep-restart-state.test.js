import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Orchestrator } = require('../../../engine/src/core/orchestrator.js');
const { TemporalRhythms } = require('../../../engine/src/temporal/rhythms.js');
const { StateCompression } = require('../../../engine/src/core/state-compression.js');

const logger = { info() {}, warn() {}, error() {}, debug() {} };

async function reloadSleepState({ completed, completedAt = null, noticePassRun = false }) {
  const logsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-sleep-restart-'));
  try {
    const state = {
      cycleCount: 24,
      journal: [],
      temporal: {
        state: 'sleeping',
        fatigue: 0.4,
        sleepCycles: 1,
        lastSleepCycle: 20,
        lastConsolidationTime: completedAt,
      },
      cognitiveState: { mode: 'sleeping', energy: 0.2 },
      sleepSession: {
        active: true,
        startCycle: 21,
        consolidationRun: completed,
        noticePassRun,
      },
    };
    await StateCompression.saveCompressed(path.join(logsDir, 'state.json'), state, { compress: true });
    const orchestrator = Object.create(Orchestrator.prototype);
    Object.assign(orchestrator, {
      logsDir,
      logger,
      config: {},
      memory: { nodes: new Map(), edges: new Map() },
      temporal: new TemporalRhythms({ temporal: {} }, logger),
      stateModulator: { state: { mode: 'active', energy: 1 } },
      sleepSession: { active: false, startCycle: null, consolidationRun: false, noticePassRun: false, minimumCycles: 3 },
      replayAgentJournals: async () => [],
    });
    await orchestrator.loadState();
    assert.equal(orchestrator.cycleCount, 24);
    return orchestrator;
  } finally {
    await fs.rm(logsDir, { recursive: true, force: true });
  }
}

test('restart in sleep restores completed consolidation and leaves notice pass eligible', async () => {
  const completedAt = Date.now() - 60_000;
  const orchestrator = await reloadSleepState({ completed: true, completedAt });
  assert.equal(orchestrator.sleepSession.active, true);
  assert.equal(orchestrator.sleepSession.startCycle, 21);
  assert.equal(orchestrator.sleepSession.consolidationRun, true);
  assert.equal(orchestrator.sleepSession.noticePassRun, false);
  assert.equal(orchestrator.temporal.lastConsolidationTime, completedAt);
  assert.equal(orchestrator.temporal.getStats().lastConsolidationTime, completedAt);
  const result = await orchestrator.performDeepSleepConsolidation();
  assert.equal(result.deferred, true);
  assert.equal(result.reason, 'rate_limit');
});

test('restart after interrupted consolidation leaves it eligible to retry', async () => {
  const orchestrator = await reloadSleepState({ completed: false });
  assert.equal(orchestrator.sleepSession.active, true);
  assert.equal(orchestrator.sleepSession.consolidationRun, false);
  assert.equal(orchestrator.temporal.lastConsolidationTime, null);
  orchestrator.journal = [];
  orchestrator.summarizer = {
    async consolidateMemories() { throw new Error('interrupted consolidation'); },
  };
  orchestrator.memory = { nodes: new Map(), edges: new Map() };
  orchestrator.getMemoryCompostOptions = () => ({ mode: 'off' });
  await assert.rejects(orchestrator.performDeepSleepConsolidation(), /interrupted consolidation/);
  assert.equal(orchestrator.temporal.lastConsolidationTime, null);
  assert.equal(orchestrator.sleepSession.consolidationRun, false);
});
