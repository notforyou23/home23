// Governing rule (jtr, 2026-07-15): "something happened" -> event, worth
// keeping. "A loop ticked" -> not an event, no record.
//
// TrajectoryForkSystem had two untraced memory.addNode() sites:
//   1. exploreFork() wrote every fork cycle's raw thought to memory,
//      unconditionally, tagged `fork_${depth}`. Fork cycles never run
//      goal-capture, so under shouldPersistThought()'s rule
//      (orchestrator.js) these could never be "productive" -- this was
//      permanent storage of pure scratch exploration.
//   2. completeFork() always ran consolidateFork() (a paid GPT call) and
//      wrote its output as a permanent `fork_consolidation` node whenever a
//      fork produced at least one thought, with no check for whether the
//      fork ever found anything to ground itself in. That mirrors
//      AnalysisAgent's ungrounded-synthesis bug (analysis-agent.js): GPT
//      free-associating from the trigger thought alone, then filing the
//      result forever.
//
// This file tests the fix: raw per-cycle thoughts are never written to
// memory, and completeFork()'s consolidation only runs (and only writes)
// when the fork found real memory context (fork.hadGroundedContext) during
// at least one exploration cycle.
//
// Harness style matches tests/engine/core/thought-persistence.test.js:
// minimal collaborator stubs, exercise the real instance methods.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TrajectoryForkSystem } = require('../../../engine/src/cognition/trajectory-fork.js');

function makeQuantum(hypothesis = 'A plausible exploratory hypothesis about the trigger thought.') {
  return {
    async generateSuperposition() {
      return { branches: [] };
    },
    async collapseSuperposition() {
      return { hypothesis, reasoning: 'because reasons', usedWebSearch: false };
    },
  };
}

function makeMemory(contextByCycle) {
  const addedNodes = [];
  let cycle = 0;
  return {
    addedNodes,
    async query() {
      const result = contextByCycle[cycle] ?? [];
      cycle += 1;
      return result;
    },
    async addNode(content, tag) {
      const node = { id: `n${addedNodes.length + 1}`, content, tag };
      addedNodes.push(node);
      return node;
    },
  };
}

function makeForkSystem({ memory, quantum, cycleLimit = 2 }) {
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const config = { forking: { cycleLimit, maxConcurrent: 3, maxDepth: 2 } };
  const system = new TrajectoryForkSystem(config, { memory, quantum, goals: null }, logger);
  system.sleep = async () => {}; // no real delay in tests
  return system;
}

test('exploreFork never writes raw per-cycle thoughts to memory, grounded or not', async () => {
  const memory = makeMemory([['some relevant context'], ['more context']]);
  const quantum = makeQuantum();
  const system = makeForkSystem({ memory, quantum, cycleLimit: 2 });

  const fork = {
    id: 'fork_1', depth: 1, explorationPrompt: 'Explore: X', thoughts: [], insights: [],
    memoryNodes: [], cyclesCompleted: 0, hadGroundedContext: false,
  };

  await system.exploreFork(fork, { cognitiveState: {} });

  assert.equal(memory.addedNodes.length, 0, 'no fork_N nodes should be written during exploration');
  assert.equal(fork.thoughts.length, 2, 'thoughts still tracked in-memory on the fork object');
  assert.equal(fork.memoryNodes.length, 0);
  assert.equal(fork.hadGroundedContext, true, 'grounding is still tracked for completeFork() to use');
});

test('exploreFork leaves hadGroundedContext false when memory never returns context', async () => {
  const memory = makeMemory([[], []]);
  const quantum = makeQuantum();
  const system = makeForkSystem({ memory, quantum, cycleLimit: 2 });

  const fork = {
    id: 'fork_2', depth: 1, explorationPrompt: 'Explore: Y', thoughts: [], insights: [],
    memoryNodes: [], cyclesCompleted: 0, hadGroundedContext: false,
  };

  await system.exploreFork(fork, { cognitiveState: {} });

  assert.equal(fork.hadGroundedContext, false);
});

test('completeFork does not consolidate or write memory for an ungrounded fork', async () => {
  const memory = makeMemory([[]]);
  const quantum = makeQuantum();
  const system = makeForkSystem({ memory, quantum, cycleLimit: 1 });
  let consolidateCalls = 0;
  system.consolidateFork = async () => { consolidateCalls += 1; return 'a consolidated insight'; };

  const fork = {
    id: 'fork_3', depth: 1, explorationPrompt: 'Explore: Z', thoughts: [], insights: [],
    memoryNodes: [], cyclesCompleted: 0, hadGroundedContext: false, startTime: new Date(),
  };
  system.activeForks.set(fork.id, fork);

  // exploreFork() calls completeFork(forkId, 'completed') itself once its
  // cycle loop ends -- do not call it again here.
  await system.exploreFork(fork, { cognitiveState: {} });

  assert.equal(fork.hadGroundedContext, false);
  assert.equal(consolidateCalls, 0, 'consolidateFork (a paid LLM call) must not run without grounding');
  assert.equal(memory.addedNodes.length, 0, 'no fork_consolidation node for an ungrounded fork');
  assert.equal(fork.consolidation, undefined);
});

test('completeFork consolidates and writes memory once for a fork that found real context', async () => {
  const memory = makeMemory([['grounding context found']]);
  const quantum = makeQuantum();
  const system = makeForkSystem({ memory, quantum, cycleLimit: 1 });
  let consolidateCalls = 0;
  system.consolidateFork = async () => { consolidateCalls += 1; return 'a consolidated insight'; };

  const fork = {
    id: 'fork_4', depth: 1, explorationPrompt: 'Explore: W', thoughts: [], insights: [],
    memoryNodes: [], cyclesCompleted: 0, hadGroundedContext: false, startTime: new Date(),
  };
  system.activeForks.set(fork.id, fork);

  // exploreFork() calls completeFork(forkId, 'completed') itself once its
  // cycle loop ends -- do not call it again here.
  await system.exploreFork(fork, { cognitiveState: {} });

  assert.equal(fork.hadGroundedContext, true);
  assert.equal(consolidateCalls, 1);
  assert.equal(memory.addedNodes.length, 1);
  assert.equal(memory.addedNodes[0].tag, 'fork_consolidation');
  assert.match(memory.addedNodes[0].content, /a consolidated insight/);
});
