import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ThinkingMachine } = require('../../../engine/src/cognition/thinking-machine.js');
const { Orchestrator } = require('../../../engine/src/core/orchestrator.js');

const logger = { info() {}, warn() {}, error() {} };

test('publish hooks bound after thinking-machine construction observe the next cycle', async () => {
  const publications = [];
  const machine = new ThinkingMachine({
    unifiedClient: {},
    memory: {},
    discoveryEngine: { pop: () => [] },
    logger,
  });

  machine.deepDive = {
    async think() {
      return {
        text: 'A completed thought long enough to pass the empty-output guard and reach the publish hooks.',
        referencedNodes: [],
        usage: {},
      };
    },
  };
  machine.pgsAdapter = {
    async connect() {
      return {
        available: false,
        note: 'not needed for publish-hook regression',
        perspectives: [],
        candidateEdges: [],
        connectionNotes: [],
        usage: {},
      };
    },
  };
  machine.critique = {
    async evaluate() {
      return {
        verdict: 'keep',
        confidence: 0.9,
        gaps: [],
        rationale: 'publish this thought',
      };
    },
  };

  const orchestrator = Object.create(Orchestrator.prototype);
  orchestrator.thinkingMachine = machine;
  orchestrator.setStep24Hooks({
    onCycleComplete: async (event) => publications.push({ type: 'cycle', event }),
    onCriticVerdict: async (event) => publications.push({ type: 'verdict', event }),
  });

  await machine._runCycle({
    signal: 'publish-hook-regression',
    score: 0.9,
    rationale: 'late-bound publisher',
  });

  assert.deepEqual(publications.map(({ type }) => type), ['cycle', 'verdict']);
  assert.equal(publications[0].event.cycleIndex, 1);
  assert.equal(publications[0].event.verdict, 'keep');
  assert.equal(publications[1].event.verdict, 'keep');
  assert.equal(publications[1].event.thought, 'A completed thought long enough to pass the empty-output guard and reach the publish hooks.');
});
