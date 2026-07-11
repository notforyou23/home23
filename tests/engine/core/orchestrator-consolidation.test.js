import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Orchestrator } = require('../../../engine/src/core/orchestrator.js');

function makeLogger() {
  const entries = [];
  return {
    entries,
    info(message, data) { entries.push({ level: 'info', message, data }); },
    warn(message, data) { entries.push({ level: 'warn', message, data }); },
    error(message, data) { entries.push({ level: 'error', message, data }); },
    debug(message, data) { entries.push({ level: 'debug', message, data }); },
  };
}

function consolidation(id) {
  return {
    consolidated: `Durable consolidated memory ${id} with enough semantic detail`,
    reasoning: null,
    sourceNodes: [`source-${id}`],
    model: 'test-model',
    compost: { mode: 'ready', sourceNodes: [`source-${id}`] },
  };
}

test('performMemoryConsolidation excludes failed summary creation and partial finalization from success counts', async () => {
  const logger = makeLogger();
  const consolidations = [consolidation('missing'), consolidation('partial'), consolidation('accepted')];
  const createdNodes = [null, { id: 'summary-partial' }, { id: 'summary-accepted' }];
  const finalizationCalls = [];
  const orchestrator = Object.create(Orchestrator.prototype);
  Object.assign(orchestrator, {
    logger,
    memory: {
      async addNode() { return createdNodes.shift(); },
    },
    summarizer: {
      async consolidateMemories() { return consolidations; },
      finalizeConsolidationCompost(_memory, cons, options) {
        finalizationCalls.push({ cons, options });
        if (options.summaryNodeId === 'summary-partial') {
          return { mode: 'partial', reason: 'source_identity_changed', removedSourceNodes: 0, skippedSourceNodes: 1 };
        }
        return { mode: 'apply', removedSourceNodes: 1, skippedSourceNodes: 0 };
      },
    },
    getMemoryCompostOptions() {
      return { mode: 'apply', confirmedDryRunAt: '2026-07-11T00:00:00.000Z' };
    },
  });

  const result = await orchestrator.performMemoryConsolidation();

  assert.deepEqual(result, { created: 1, skipped: 2 });
  assert.equal(finalizationCalls.length, 2);
  assert.deepEqual(finalizationCalls.map((call) => call.options.summaryNodeId), [
    'summary-partial',
    'summary-accepted',
  ]);
  const completion = logger.entries.find((entry) => entry.message === 'Consolidation complete (GPT-5.5)');
  assert.deepEqual(completion?.data, { created: 1, skipped: 2 });
  assert.equal(
    logger.entries.some((entry) => entry.level === 'warn' && entry.data?.reason === 'summary_node_creation_failed'),
    true,
  );
  assert.equal(
    logger.entries.some((entry) => entry.level === 'warn' && entry.data?.reason === 'source_identity_changed'),
    true,
  );
});

test('deep sleep caller does not finalize or log a consolidation whose summary node was not created', async () => {
  const logger = makeLogger();
  let finalizeCalls = 0;
  const orchestrator = Object.create(Orchestrator.prototype);
  Object.assign(orchestrator, {
    config: {
      execution: {
        dreamModeSettings: {
          disableConsolidationRateLimit: true,
          dreamsPerCycle: -1,
        },
      },
      architecture: {
        goals: { maxGoals: 0 },
        temporal: { dreamRewiring: false },
      },
    },
    logger,
    journal: [],
    lastSummarization: 0,
    cycleCount: 1,
    temporal: {
      lastConsolidationTime: null,
      minConsolidationInterval: 0,
      enterDreamMode() {},
      exitDreamMode() {},
    },
    memory: {
      async addNode() { return null; },
    },
    summarizer: {
      async consolidateMemories() { return [consolidation('deep-sleep')]; },
      finalizeConsolidationCompost() {
        finalizeCalls += 1;
        return { mode: 'blocked', reason: 'summary_node_not_found' };
      },
      garbageCollect() { return 0; },
    },
    getMemoryCompostOptions() {
      return { mode: 'apply', confirmedDryRunAt: '2026-07-11T00:00:00.000Z' };
    },
    goalCapture: {
      async analyzeJournalForGoals() { return []; },
    },
    goals: {
      getGoals() { return []; },
    },
    stateModulator: {
      getState() { return { mood: 0.5, energy: 1, curiosity: 0.5 }; },
      updateState() {},
    },
    async saveState() { return { saved: true }; },
  });

  await orchestrator.performDeepSleepConsolidation();

  assert.equal(finalizeCalls, 0);
  assert.equal(logger.entries.some((entry) => entry.message === '✓ Consolidated (GPT-5.5)'), false);
  assert.equal(
    logger.entries.some((entry) => entry.level === 'warn' && entry.data?.reason === 'summary_node_creation_failed'),
    true,
  );
});
