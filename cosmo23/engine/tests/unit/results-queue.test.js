const { expect } = require('chai');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const { AgentResultsQueue } = require('../../src/agents/results-queue');

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {}
};

describe('AgentResultsQueue history lookups', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-results-queue-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns integrated history for recent results and task-scoped lookups', async () => {
    const queue = new AgentResultsQueue(tmpDir, logger);
    await queue.initialize();
    await queue.enqueue({
      agentId: 'agent-1',
      agentType: 'ResearchAgent',
      status: 'completed',
      mission: { goalId: 'goal-1', taskId: 'task:phase1' },
      results: []
    });

    await queue.markIntegrated('agent-1');

    expect(queue.getPending()).to.have.length(0);
    expect(queue.getRecent()).to.have.length(1);
    expect(queue.getResultsForTask('task:phase1').map(result => result.agentId)).to.deep.equal(['agent-1']);
  });
});
