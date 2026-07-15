// A thought that produced a goal is an EVENT -- something happened.
// A thought that produced nothing is a loop ticking. It leaves no trace.
// A thought whose productivity was never MEASURED is UNKNOWN -- and unknown
// must never be silently read as unproductive.
//
// This file tests the productivity gate added in orchestrator.js:
//   shouldPersistThought()      -- pure decision (see orchestrator.js)
//   Orchestrator#_processCapturedGoals()  -- computes goalWasProduced
//   Orchestrator#_persistThoughtNode()    -- gated memory.addNode() for the thought
//   Orchestrator#_persistReasoningNode()  -- gated memory.addNode() for [REASONING]
//
// Harness style matches tests/engine/core/orchestrator-consolidation.test.js:
// Object.create(Orchestrator.prototype) + Object.assign minimal collaborators,
// exercise real instance methods -- no reinvented mock framework.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Orchestrator, shouldPersistThought } = require('../../../engine/src/core/orchestrator.js');

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

// A goals subsystem stub that mimics IntrinsicGoalSystem.addGoal()'s real
// contract: returns a goal object on success, null on any rejection
// (invalid data, duplicate, doneWhen gate, etc.) -- never throws for a
// rejection, and callers must treat null as "not produced".
function makeGoalsStub({ maxGoals = 10, addGoalResult = (data) => ({ id: 'goal_1', ...data }) } = {}) {
  const active = [];
  return {
    maxGoals,
    getGoals() { return active; },
    addGoal(data) {
      const result = typeof addGoalResult === 'function' ? addGoalResult(data) : addGoalResult;
      if (result) active.push(result);
      return result;
    },
  };
}

function makeOrchestrator({ goals, memoryAddNode, cycleCount = 1 } = {}) {
  const logger = makeLogger();
  const addedNodes = [];
  const memory = {
    async addNode(content, tag) {
      if (memoryAddNode) return memoryAddNode(content, tag);
      const node = { id: `node_${addedNodes.length + 1}`, content, tag };
      addedNodes.push(node);
      return node;
    },
  };
  const orchestrator = Object.create(Orchestrator.prototype);
  Object.assign(orchestrator, {
    logger,
    memory,
    goals: goals || makeGoalsStub(),
    evaluation: null,
    goalCurator: null,
    cycleCount,
    config: { architecture: { goals: { maxGoals: (goals || makeGoalsStub()).maxGoals } } },
  });
  return { orchestrator, logger, addedNodes, memory };
}

const LONG_THOUGHT = 'A sufficiently long and benign hypothesis text used to satisfy the content validator minimum length requirement for storage.';
const LONG_REASONING = 'A sufficiently long chain of reasoning that clears the >100 character threshold imposed on [REASONING] nodes before they may be persisted to the brain.';

// ---------------------------------------------------------------------------
// shouldPersistThought() -- the pure decision function
// ---------------------------------------------------------------------------

test('shouldPersistThought: goal produced, capture ran -> persist', () => {
  assert.equal(
    shouldPersistThought({ shouldSkipGoalCapture: false, goalWasProduced: true }),
    true
  );
});

test('shouldPersistThought: capture ran, no goal produced -> do not persist', () => {
  assert.equal(
    shouldPersistThought({ shouldSkipGoalCapture: false, goalWasProduced: false }),
    false
  );
});

test('shouldPersistThought: capture SKIPPED -> do not persist, regardless of any stray productivity value', () => {
  // shouldSkipGoalCapture must win outright: if capture never ran, there is
  // no honest goalWasProduced signal, and the skip branch must not be
  // bypassed even if a caller (incorrectly) passed goalWasProduced: true.
  assert.equal(
    shouldPersistThought({ shouldSkipGoalCapture: true, goalWasProduced: true }),
    false
  );
  assert.equal(
    shouldPersistThought({ shouldSkipGoalCapture: true, goalWasProduced: false }),
    false
  );
});

// ---------------------------------------------------------------------------
// Orchestrator#_processCapturedGoals() -- the productivity signal itself
// ---------------------------------------------------------------------------

test('_processCapturedGoals: addGoal() returning a goal marks the thought productive', async () => {
  const { orchestrator } = makeOrchestrator({ goals: makeGoalsStub() });
  const produced = await orchestrator._processCapturedGoals([
    { text: 'Investigate the recurring feeder backlog spike', source: 'test' },
  ]);
  assert.equal(produced, true);
});

test('_processCapturedGoals: no captured candidates -> not productive', async () => {
  const { orchestrator } = makeOrchestrator({ goals: makeGoalsStub() });
  const produced = await orchestrator._processCapturedGoals([]);
  assert.equal(produced, false);
});

test('_processCapturedGoals: a candidate DROPPED at maxGoals does not count as produced', async () => {
  // Cap is reached before this candidate is evaluated -- addGoal() is never
  // even called, matching the real orchestrator.js guard order.
  let addGoalCalls = 0;
  const goals = makeGoalsStub({ maxGoals: 1 });
  const originalAddGoal = goals.addGoal.bind(goals);
  goals.addGoal = (data) => { addGoalCalls += 1; return originalAddGoal(data); };
  // Pre-fill to the cap.
  goals.addGoal({ description: 'Existing goal already at cap' });
  addGoalCalls = 0; // reset counter after the setup call

  const { orchestrator } = makeOrchestrator({ goals });
  const produced = await orchestrator._processCapturedGoals([
    { text: 'A second candidate that should be dropped at the cap', source: 'test' },
  ]);

  assert.equal(produced, false);
  assert.equal(addGoalCalls, 0, 'addGoal must not be called once maxGoals is reached');
});

test('_processCapturedGoals: addGoal() rejecting internally (e.g. duplicate/doneWhen gate) does not count as produced', async () => {
  // capturedGoals.length > 0 is NOT the signal -- addGoal() returning null
  // (a legitimate internal rejection, distinct from the maxGoals guard)
  // must also not count as productive.
  const goals = makeGoalsStub({ addGoalResult: () => null });
  const { orchestrator } = makeOrchestrator({ goals });
  const produced = await orchestrator._processCapturedGoals([
    { text: 'A candidate addGoal will reject internally', source: 'test' },
  ]);
  assert.equal(produced, false);
});

test('_processCapturedGoals: invalid captured text is skipped and does not count as produced', async () => {
  const goals = makeGoalsStub();
  const { orchestrator } = makeOrchestrator({ goals });
  const produced = await orchestrator._processCapturedGoals([
    { text: 'too short', source: 'test' }, // < 10 chars after trim is fine here it's borderline; use explicit short
    { text: 'Error: something failed upstream', source: 'test' }, // contains 'Error:'
  ]);
  assert.equal(produced, false);
});

// ---------------------------------------------------------------------------
// Orchestrator#_persistThoughtNode() -- the gated write
// ---------------------------------------------------------------------------

test('a thought that created a goal persists', async () => {
  const { orchestrator, addedNodes } = makeOrchestrator();
  const thought = { hypothesis: LONG_THOUGHT };
  const role = { id: 'analyst' };

  const goalWasProduced = await orchestrator._processCapturedGoals([
    { text: 'Investigate the recurring feeder backlog spike', source: 'test' },
  ]);
  const verdict = shouldPersistThought({ shouldSkipGoalCapture: false, goalWasProduced });
  const { memoryNode } = await orchestrator._persistThoughtNode(thought, role, verdict, false);

  assert.equal(verdict, true);
  assert.ok(memoryNode, 'expected a memory node to be created');
  assert.equal(addedNodes.length, 1);
  assert.equal(addedNodes[0].tag, 'analyst');
});

test('a thought that created no goal leaves no node', async () => {
  const { orchestrator, addedNodes } = makeOrchestrator();
  const thought = { hypothesis: LONG_THOUGHT };
  const role = { id: 'critic' };

  // Capture ran (shouldSkipGoalCapture=false) but produced nothing.
  const goalWasProduced = await orchestrator._processCapturedGoals([]);
  const verdict = shouldPersistThought({ shouldSkipGoalCapture: false, goalWasProduced });
  const { memoryNode } = await orchestrator._persistThoughtNode(thought, role, verdict, false);

  assert.equal(verdict, false);
  assert.equal(memoryNode, null);
  assert.equal(addedNodes.length, 0);
});

test('a thought whose goal-capture was SKIPPED is not silently dropped -- it is an explicit, logged, distinguishable decision', async () => {
  const { orchestrator, addedNodes, logger } = makeOrchestrator();
  const thought = { hypothesis: LONG_THOUGHT };
  const role = { id: 'curator' };

  // Capture was SKIPPED -- capturedGoals is [] not because capture ran and
  // found nothing, but because it never ran. _processCapturedGoals is never
  // even invoked in the real orchestrator for this branch (capturedGoals is
  // forced to [] upstream), so goalWasProduced is trivially false here --
  // but the *reason* must be distinguishable in the verdict computation and
  // in the log line, not silently conflated with "ran and found nothing".
  const shouldSkipGoalCapture = true;
  const goalWasProduced = false; // capture never ran; this value must not matter
  const verdict = shouldPersistThought({ shouldSkipGoalCapture, goalWasProduced });
  const { memoryNode } = await orchestrator._persistThoughtNode(thought, role, verdict, shouldSkipGoalCapture);

  assert.equal(verdict, false);
  assert.equal(memoryNode, null);
  assert.equal(addedNodes.length, 0);

  const skipLog = logger.entries.find((e) => e.level === 'debug' && e.data?.goalCaptureSkipped === true);
  assert.ok(skipLog, 'expected a log entry explicitly recording that capture was skipped for this thought');
});

test('valid thought text alone is not enough -- productivity gate still applies', async () => {
  const { orchestrator, addedNodes } = makeOrchestrator();
  const thought = { hypothesis: LONG_THOUGHT };
  const role = { id: 'proposal' };

  const { memoryNode } = await orchestrator._persistThoughtNode(thought, role, false, false);

  assert.equal(memoryNode, null);
  assert.equal(addedNodes.length, 0);
});

test('invalid thought text is rejected independently of the productivity verdict', async () => {
  const { orchestrator, addedNodes, logger } = makeOrchestrator();
  const thought = { hypothesis: 'short' }; // fails validateAndClean's length check
  const role = { id: 'analyst' };

  const { memoryNode } = await orchestrator._persistThoughtNode(thought, role, true, false);

  assert.equal(memoryNode, null);
  assert.equal(addedNodes.length, 0);
  assert.ok(logger.entries.some((e) => e.level === 'warn' && e.message.includes('Skipped invalid thought')));
});

// ---------------------------------------------------------------------------
// Orchestrator#_persistReasoningNode() -- follows the parent thought's verdict
// ---------------------------------------------------------------------------

test('[REASONING] follows the verdict of the thought it belongs to -- persists when the thought was productive', async () => {
  const { orchestrator, addedNodes } = makeOrchestrator();
  const thought = { hypothesis: LONG_THOUGHT, reasoning: LONG_REASONING };

  const node = await orchestrator._persistReasoningNode(thought, true);

  assert.ok(node, 'expected the reasoning node to be created');
  assert.equal(addedNodes.length, 1);
  assert.equal(addedNodes[0].tag, 'reasoning');
});

test('[REASONING] follows the verdict of the thought it belongs to -- does NOT persist when the thought was unproductive, even though the reasoning text itself is perfectly valid', async () => {
  const { orchestrator, addedNodes } = makeOrchestrator();
  const thought = { hypothesis: LONG_THOUGHT, reasoning: LONG_REASONING };

  const node = await orchestrator._persistReasoningNode(thought, false);

  assert.equal(node, null);
  assert.equal(addedNodes.length, 0, 'reasoning text validity alone must not be enough to persist it');
});

test('[REASONING] is not written when there is no reasoning on the thought, regardless of verdict', async () => {
  const { orchestrator, addedNodes } = makeOrchestrator();
  const thought = { hypothesis: LONG_THOUGHT }; // no .reasoning field

  const node = await orchestrator._persistReasoningNode(thought, true);

  assert.equal(node, null);
  assert.equal(addedNodes.length, 0);
});
