const { expect } = require('chai');

const { waitForPlanningAgents, isPlanningAgentTerminal } = require('../../src/index');

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {}
};

describe('startup planning-agent wait', () => {
  it('flushes task-state events and detects integrated results instead of waiting for timeout', async () => {
    let resultsProcessed = 0;
    let taskQueueProcessed = 0;

    const agentExecutor = {
      registry: {
        getAgentIncludingCompleted: () => ({ status: 'completed' })
      },
      resultsQueue: {
        history: [],
        queue: []
      },
      processCompletedResults: async () => {
        resultsProcessed++;
        agentExecutor.resultsQueue.history.push({
          agentId: 'agent-1',
          integrated: true,
          mission: { taskId: 'task:phase1' }
        });
        return { processed: 1, integrated: 1 };
      }
    };

    const taskStateQueue = {
      processAll: async () => {
        taskQueueProcessed++;
        return { processed: 1 };
      }
    };

    const started = Date.now();
    await waitForPlanningAgents(agentExecutor, ['agent-1'], {
      timeoutMs: 1000,
      logger,
      taskStateQueue,
      clusterStateStore: {},
      orchestrator: {}
    });

    expect(Date.now() - started).to.be.lessThan(500);
    expect(resultsProcessed).to.equal(1);
    expect(taskQueueProcessed).to.equal(1);
  });

  it('recognizes integrated history as terminal even after the active queue is empty', () => {
    const agentExecutor = {
      registry: {
        getAgentIncludingCompleted: () => null
      },
      resultsQueue: {
        history: [{ agentId: 'agent-2', integrated: true }],
        queue: []
      }
    };

    expect(isPlanningAgentTerminal(agentExecutor, 'agent-2')).to.equal(true);
  });
});
