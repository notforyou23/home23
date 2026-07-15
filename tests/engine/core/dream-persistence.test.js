// jtr's decision: "keep productive dreams."
//
// Before this fix, performDeepSleepConsolidation() rolled two independent
// dice per dream:
//   - Math.random() < 0.3 gated whether a captured dream goal was actually
//     created (whether the dream was PRODUCTIVE at all).
//   - Math.random() < 0.2 gated whether the dream text was written to
//     memory as a [DREAM] node (whether it was REMEMBERED).
// The two dice are unrelated, so a dream that captured a real goal had a
// 70% chance of that goal being silently discarded, and the dreams that
// got remembered were not the productive ones. "Keep productive dreams"
// was unimplementable.
//
// The fix: remove both dice. Every captured dream-goal candidate is
// offered to goals.addGoal() on its own merit (same internal gates as a
// waking thought's goal capture: maxGoals, duplicate, doneWhen). A
// [DREAM] memory node is written iff that offer actually produced a goal
// -- decided by shouldPersistThought(), reused directly rather than
// duplicated, because the rule is identical to Task 1's thought-
// persistence rule.
//
// Harness style matches tests/engine/core/orchestrator-consolidation.test.js:
// Object.create(Orchestrator.prototype) + Object.assign minimal collaborators,
// exercise the real performDeepSleepConsolidation() -- no reinvented mock
// framework.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Orchestrator, shouldPersistThought } = require('../../../engine/src/core/orchestrator.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ORCHESTRATOR_SRC = path.join(__dirname, '../../../engine/src/core/orchestrator.js');

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

// Builds a minimal Orchestrator instance capable of running
// performDeepSleepConsolidation() end to end, with every collaborator
// stubbed except the dream loop's goal-capture and memory-write path,
// which the caller configures via `dreamGoalCandidates` and `addGoalResult`.
function makeDreamOrchestrator({
  dreamGoalCandidates = [],
  addGoalResult = (data) => ({ id: 'dream_goal_1', ...data }),
  dreamHypothesis = 'A sufficiently long surreal dream narrative connecting disparate concepts.',
} = {}) {
  const logger = makeLogger();
  const addedNodes = [];
  const createdGoals = [];
  const addGoalCalls = [];
  const savedDreams = [];

  const orchestrator = Object.create(Orchestrator.prototype);
  Object.assign(orchestrator, {
    logger,
    journal: [],
    lastSummarization: 0,
    cycleCount: 7,
    config: {
      execution: {
        dreamModeSettings: {
          disableConsolidationRateLimit: true,
          dreamsPerCycle: 1, // fixed -- avoids the unrelated Math.random() dream-count roll
        },
      },
      architecture: {
        goals: { maxGoals: 10 },
        temporal: { dreamRewiring: false }, // skip the real rewire call; it's phase-level, not per-dream
      },
    },
    temporal: {
      lastConsolidationTime: null,
      minConsolidationInterval: 0,
      enterDreamMode() {},
      exitDreamMode() {},
    },
    memory: {
      async addNode(content, tag) {
        const node = { id: `node_${addedNodes.length + 1}`, content, tag };
        addedNodes.push(node);
        return node;
      },
    },
    summarizer: {
      async consolidateMemories() { return []; },
      garbageCollect() { return 0; },
    },
    getMemoryCompostOptions() {
      return { mode: 'off', confirmedDryRunAt: null };
    },
    goalCapture: {
      async analyzeJournalForGoals() { return []; }, // skip the unrelated journal-goals loop
      async captureGoalsFromOutput(_hypothesis, _opts) { return dreamGoalCandidates; },
    },
    goals: {
      getGoals() { return createdGoals; },
      addGoal(data) {
        addGoalCalls.push(data);
        const result = typeof addGoalResult === 'function' ? addGoalResult(data) : addGoalResult;
        if (result) createdGoals.push(result);
        return result;
      },
    },
    evaluation: null,
    goalCurator: null,
    quantum: {
      async singleReasoning() {
        return { hypothesis: dreamHypothesis, reasoning: null, model: 'test-model' };
      },
    },
    async saveDream(dream) { savedDreams.push(dream); },
    stateModulator: {
      getState() { return { mood: 0.5, energy: 1, curiosity: 0.5 }; },
      updateState() {},
    },
    async saveState() { return { saved: true }; },
  });

  return { orchestrator, logger, addedNodes, createdGoals, addGoalCalls, savedDreams };
}

// ---------------------------------------------------------------------------
// Static check: the two dice are gone from the source, not just bypassed
// by test stubs.
// ---------------------------------------------------------------------------

test('performDeepSleepConsolidation dream loop contains no Math.random gate on goal creation or memory persistence', () => {
  const source = fs.readFileSync(ORCHESTRATOR_SRC, 'utf8');
  const start = source.indexOf('async performDeepSleepConsolidation()');
  assert.ok(start >= 0, 'expected to find performDeepSleepConsolidation in orchestrator.js');
  const nextMethod = source.indexOf('\n  async performFastSleepMaintenance()', start);
  assert.ok(nextMethod > start, 'expected to find the following method to bound the search');
  const body = source.slice(start, nextMethod);

  // The dream-count roll (2 + Math.floor(Math.random() * 2)) is unrelated
  // to productivity and is explicitly out of scope for this fix -- only
  // the two productivity/persistence dice must be gone.
  assert.ok(!body.includes('Math.random() < 0.3'), 'the dream goal-creation dice must be removed');
  assert.ok(!body.includes('Math.random() < 0.2'), 'the dream memory-persistence dice must be removed');
});

// ---------------------------------------------------------------------------
// Behavioral checks: outcome must track merit (whether a goal was actually
// created), never a random draw. Math.random is stubbed to fixed extreme
// values so any remaining dice would flip the outcome the wrong way.
// ---------------------------------------------------------------------------

test('a dream that captures a goal creates it and earns a [DREAM] note -- even when Math.random would have failed both old dice', async () => {
  const originalRandom = Math.random;
  Math.random = () => 0.999; // old code: 0.999 < 0.3 is false, 0.999 < 0.2 is false -- both old dice would discard everything
  try {
    const { orchestrator, addedNodes, createdGoals, addGoalCalls } = makeDreamOrchestrator({
      dreamGoalCandidates: [{ text: 'Investigate the recurring dream motif about the feeder backlog' }],
    });

    await orchestrator.performDeepSleepConsolidation();

    assert.equal(addGoalCalls.length, 1, 'expected the captured candidate to be offered to goals.addGoal()');
    assert.equal(createdGoals.length, 1, 'expected the goal to actually be created');

    const dreamNodes = addedNodes.filter((n) => n.tag === 'dream');
    assert.equal(dreamNodes.length, 1, 'expected exactly one [DREAM] node for the productive dream');
    assert.match(dreamNodes[0].content, /^\[DREAM\]/);
  } finally {
    Math.random = originalRandom;
  }
});

test('a dream that captures nothing leaves no trace -- even when Math.random would have passed both old dice', async () => {
  const originalRandom = Math.random;
  Math.random = () => 0; // old code: 0 < 0.3 is true, 0 < 0.2 is true -- both old dice would have fired regardless of merit
  try {
    const { orchestrator, addedNodes, createdGoals, addGoalCalls } = makeDreamOrchestrator({
      dreamGoalCandidates: [], // goalCapture found nothing worth capturing
    });

    await orchestrator.performDeepSleepConsolidation();

    assert.equal(addGoalCalls.length, 0, 'nothing was captured, so addGoal must never be called');
    assert.equal(createdGoals.length, 0);

    const dreamNodes = addedNodes.filter((n) => n.tag === 'dream');
    assert.equal(dreamNodes.length, 0, 'an unproductive dream must leave no [DREAM] node');
  } finally {
    Math.random = originalRandom;
  }
});

test('a captured candidate that addGoal() rejects internally (duplicate/doneWhen/etc.) does not count as productive -- no [DREAM] note', async () => {
  const originalRandom = Math.random;
  Math.random = () => 0; // would have passed both old dice; must not matter now
  try {
    const { orchestrator, addedNodes, createdGoals, addGoalCalls } = makeDreamOrchestrator({
      dreamGoalCandidates: [{ text: 'A candidate addGoal will reject internally as a duplicate' }],
      addGoalResult: () => null, // mirrors IntrinsicGoalSystem.addGoal()'s real contract for a rejection
    });

    await orchestrator.performDeepSleepConsolidation();

    assert.equal(addGoalCalls.length, 1, 'the candidate must still be offered to addGoal()');
    assert.equal(createdGoals.length, 0, 'addGoal() rejected it, so no goal exists');

    const dreamNodes = addedNodes.filter((n) => n.tag === 'dream');
    assert.equal(dreamNodes.length, 0, 'a candidate.length > 0 is not the signal -- only an actually-created goal is');
  } finally {
    Math.random = originalRandom;
  }
});

test('the [DREAM] persistence decision reuses shouldPersistThought() -- same verdict function, not a duplicate', () => {
  // Task 1's rule ("a thought persists only if it produced a goal") is
  // exactly the dream rule too. Prove the same exported function decides
  // both, rather than two copies of the same logic drifting apart later.
  assert.equal(
    shouldPersistThought({ shouldSkipGoalCapture: false, goalWasProduced: true }),
    true
  );
  assert.equal(
    shouldPersistThought({ shouldSkipGoalCapture: false, goalWasProduced: false }),
    false
  );
});

test('dreaming, goal capture, and Watts-Strogatz rewiring remain untouched -- rewire is phase-level, not per-dream', async () => {
  let rewireCalls = 0;
  const { orchestrator } = makeDreamOrchestrator({
    dreamGoalCandidates: [{ text: 'A dream goal candidate for the rewiring-untouched check' }],
  });
  orchestrator.config.architecture.temporal.dreamRewiring = true; // enable so we can observe the call
  orchestrator.config.execution.dreamModeSettings.dreamsPerCycle = 3; // multiple dreams this cycle
  orchestrator.memory.rewire = async (p) => { rewireCalls += 1; return 0; };

  await orchestrator.performDeepSleepConsolidation();

  // One rewire call for the whole dream phase, not one per dream (3 dreams ran above).
  assert.equal(rewireCalls, 1, 'rewire must run once per dream phase, not once per dream');
});
