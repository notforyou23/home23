import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { Orchestrator } = require('../../../engine/src/core/orchestrator');

function makeOrchestrator(overrides = {}) {
  const logs = [];
  const calls = [];
  const orchestrator = Object.create(Orchestrator.prototype);
  Object.assign(orchestrator, {
    config: {},
    logger: {
      warn: (message, meta) => logs.push({ level: 'warn', message, meta }),
      info: (message, meta) => logs.push({ level: 'info', message, meta }),
      error: (message, meta) => logs.push({ level: 'error', message, meta }),
    },
    agentExecutor: {
      registry: {
        getAgent: () => null,
        completedAgents: new Map(),
        failedAgents: new Map(),
      },
      resultsQueue: {
        getResultsForGoal: () => [],
      },
    },
    clusterStateStore: {
      async upsertTask(task) {
        calls.push(['upsertTask', task]);
        return true;
      },
      async failTask(taskId, reason) {
        calls.push(['failTask', taskId, reason]);
        return true;
      },
    },
  }, overrides);
  return { orchestrator, logs, calls };
}

test('reconcileTaskAssignmentBeforeSpawn keeps a registered assigned agent', async () => {
  const task = {
    id: 'task:phase5',
    assignedAgentId: 'agent_live',
    metadata: { goalId: 'goal_1' },
  };
  const { orchestrator, calls } = makeOrchestrator({
    agentExecutor: {
      registry: {
        getAgent: (id) => (id === 'agent_live' ? { agentId: id } : null),
        completedAgents: new Map(),
        failedAgents: new Map(),
      },
      resultsQueue: { getResultsForGoal: () => [] },
    },
  });

  const result = await orchestrator.reconcileTaskAssignmentBeforeSpawn(task);

  assert.equal(result, task);
  assert.deepEqual(calls, []);
});

test('reconcileTaskAssignmentBeforeSpawn clears missing assigned agent once for retry', async () => {
  const task = {
    id: 'task:phase5',
    assignedAgentId: 'agent_missing',
    metadata: { goalId: 'goal_1' },
  };
  const { orchestrator, calls, logs } = makeOrchestrator();

  const result = await orchestrator.reconcileTaskAssignmentBeforeSpawn(task);

  assert.equal(result.assignedAgentId, null);
  assert.equal(result.metadata.staleAssignedAgentRetries, 1);
  assert.equal(result.metadata.staleAssignedAgentId, 'agent_missing');
  assert.equal(calls[0][0], 'upsertTask');
  assert.equal(logs.some((entry) => entry.message === '⚠️ Cleared stale task agent assignment for retry'), true);
});

test('reconcileTaskAssignmentBeforeSpawn fails repeatedly stale assigned agent', async () => {
  const task = {
    id: 'task:phase5',
    assignedAgentId: 'agent_missing',
    metadata: {
      goalId: 'goal_1',
      staleAssignedAgentRetries: 1,
    },
  };
  const { orchestrator, calls } = makeOrchestrator();

  const result = await orchestrator.reconcileTaskAssignmentBeforeSpawn(task);

  assert.equal(result.state, 'FAILED');
  assert.equal(calls[0][0], 'failTask');
  assert.equal(calls[0][1], 'task:phase5');
  assert.match(calls[0][2], /Assigned agent agent_missing is missing/);
});

test('getCompletedAgentsForTask matches goal-less final synthesis by taskId', () => {
  const completed = {
    agentId: 'agent_synthesis',
    status: 'completed',
    mission: {
      goalId: null,
      taskId: 'task:synthesis_final',
    },
    results: [{ type: 'deliverable', path: '/tmp/ai-os-research.md' }],
    accomplishment: { accomplished: true },
  };

  const { orchestrator } = makeOrchestrator({
    agentExecutor: {
      registry: {
        getAgent: () => null,
        completedAgents: new Map(),
        failedAgents: new Map(),
      },
      resultsQueue: {
        getResultsForGoal: () => [],
        queue: [],
        history: [completed],
      },
    },
  });

  const matches = orchestrator.getCompletedAgentsForTask({
    id: 'task:synthesis_final',
    metadata: { isFinalSynthesis: true },
  });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].agentId, 'agent_synthesis');
});

test('getCompletedAgentsForTask matches assigned completed agent without goalId', () => {
  const completed = {
    agentId: 'agent_assigned',
    status: 'completed',
    mission: {
      goalId: null,
      taskId: null,
    },
    results: [{ type: 'finding', content: 'done' }],
    accomplishment: { accomplished: true },
  };

  const { orchestrator } = makeOrchestrator({
    agentExecutor: {
      registry: {
        getAgent: () => null,
        completedAgents: new Map([['agent_assigned', completed]]),
        failedAgents: new Map(),
      },
      resultsQueue: {
        getResultsForGoal: () => [],
        queue: [],
        history: [],
      },
    },
  });

  const matches = orchestrator.getCompletedAgentsForTask({
    id: 'task:synthesis_final',
    assignedAgentId: 'agent_assigned',
    metadata: {},
  });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].agentId, 'agent_assigned');
});
