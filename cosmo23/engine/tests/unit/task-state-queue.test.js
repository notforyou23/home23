const { expect } = require('chai');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const { TaskStateQueue } = require('../../src/cluster/task-state-queue');

function logger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  };
}

describe('TaskStateQueue replay safety', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-state-queue-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('persists processed flags so events do not replay after restart', async () => {
    const queue = new TaskStateQueue(tmpDir, logger());
    await queue.initialize();
    await queue.enqueue({
      type: 'UPDATE_TASK',
      taskId: 'task:phase1',
      task: {
        id: 'task:phase1',
        planId: 'plan:main',
        title: 'Current task',
        state: 'PENDING',
        createdAt: 2000
      }
    });

    const writes = [];
    const stateStore = {
      getPlan: async () => ({ id: 'plan:main', createdAt: 1000 }),
      upsertTask: async task => {
        writes.push(task);
        return true;
      }
    };

    await queue.processAll(stateStore, null);

    const restarted = new TaskStateQueue(tmpDir, logger());
    await restarted.initialize();

    expect(writes).to.have.length(1);
    expect(restarted.getPending()).to.have.length(0);
  });

  it('skips stale task events queued before the current plan was created', async () => {
    const queue = new TaskStateQueue(tmpDir, logger());
    await queue.initialize();
    await queue.enqueue({
      type: 'UPDATE_TASK',
      taskId: 'task:phase1',
      task: {
        id: 'task:phase1',
        planId: 'plan:main',
        title: 'Old web research task',
        state: 'DONE',
        createdAt: 1000
      }
    });

    queue.queue[0].queuedAt = 1000;

    let upsertCalled = false;
    const stateStore = {
      getPlan: async () => ({ id: 'plan:main', createdAt: 2000 }),
      upsertTask: async () => {
        upsertCalled = true;
        return true;
      }
    };

    const result = await queue.processAll(stateStore, null);

    expect(result.processed).to.equal(1);
    expect(upsertCalled).to.equal(false);
    expect(queue.getPending()).to.have.length(0);
  });

  it('rejects COMPLETE_TASK when the named expected output is missing', async () => {
    const queue = new TaskStateQueue(tmpDir, logger());
    await queue.initialize();
    await queue.enqueue({
      type: 'COMPLETE_TASK',
      taskId: 'task:phase1',
      phaseName: 'Write final deliverable',
      source: 'validation_passed'
    });

    let completeCalled = false;
    let failureReason = null;
    const stateStore = {
      getPlan: async () => ({ id: 'plan:main', createdAt: 1000 }),
      getTask: async () => ({
        id: 'task:phase1',
        planId: 'plan:main',
        title: 'Write final deliverable',
        metadata: {
          expectedOutput: '@outputs/final-report.md'
        }
      }),
      completeTask: async () => {
        completeCalled = true;
      },
      failTask: async (_taskId, reason) => {
        failureReason = reason;
      }
    };

    await queue.processAll(stateStore, null);

    expect(completeCalled).to.equal(false);
    expect(failureReason).to.include('Missing expected output');
  });

  it('rejects COMPLETE_TASK when the expected JSON artifact is invalid', async () => {
    const outputDir = path.join(tmpDir, 'outputs');
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, 'bad.json'), '{"entries": [}\n');

    const queue = new TaskStateQueue(tmpDir, logger());
    await queue.initialize();
    await queue.enqueue({
      type: 'COMPLETE_TASK',
      taskId: 'task:phase1',
      phaseName: 'Write JSON',
      artifacts: [{ path: 'outputs/bad.json' }],
      source: 'validation_passed'
    });

    let completeCalled = false;
    let failureReason = null;
    const stateStore = {
      getPlan: async () => ({ id: 'plan:main', createdAt: 1000 }),
      getTask: async () => ({
        id: 'task:phase1',
        planId: 'plan:main',
        title: 'Write JSON',
        metadata: {
          expectedOutput: '@outputs/bad.json'
        }
      }),
      completeTask: async () => {
        completeCalled = true;
      },
      failTask: async (_taskId, reason) => {
        failureReason = reason;
      }
    };

    await queue.processAll(stateStore, null);

    expect(completeCalled).to.equal(false);
    expect(failureReason).to.include('Invalid expected output');
    expect(failureReason).to.include('invalid_json');
  });

  it('allows COMPLETE_TASK only when expected output and source evidence are both valid', async () => {
    const outputDir = path.join(tmpDir, 'outputs', 'raw-anecdotes');
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(
      path.join(outputDir, 'web-search-results.json'),
      JSON.stringify({
        entries: [
          {
            source_url: 'https://example.com/thread',
            anecdote_text: 'A sourced anecdote record.'
          }
        ]
      })
    );

    const queue = new TaskStateQueue(tmpDir, logger());
    await queue.initialize();
    await queue.enqueue({
      type: 'COMPLETE_TASK',
      taskId: 'task:phase1',
      phaseName: 'Acquire sources',
      artifacts: [{ path: 'outputs/raw-anecdotes/web-search-results.json' }],
      researchEvidence: {
        queriesAttempted: 1,
        queriesExecuted: 1,
        sourcesFound: 1,
        successfulSources: 1
      },
      source: 'plan_executor'
    });

    let completeClosure = null;
    let failCalled = false;
    const stateStore = {
      getPlan: async () => ({ id: 'plan:main', createdAt: 1000 }),
      getTask: async () => ({
        id: 'task:phase1',
        planId: 'plan:main',
        title: 'Acquire sources',
        description: 'Execute web_search queries and record source_url evidence.',
        metadata: {
          expectedOutput: '@outputs/raw-anecdotes/web-search-results.json'
        }
      }),
      completeTask: async (_taskId, closure) => {
        completeClosure = closure;
      },
      failTask: async () => {
        failCalled = true;
      }
    };

    await queue.processAll(stateStore, null);

    expect(failCalled).to.equal(false);
    expect(completeClosure).to.not.equal(null);
    expect(completeClosure.artifacts).to.have.length(1);
  });

  it('advances the active milestone immediately after a verified task completion', async () => {
    const outputDir = path.join(tmpDir, 'outputs');
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, 'receipt.md'), '# Receipt\n\nVerified output.\n');

    const queue = new TaskStateQueue(tmpDir, logger());
    await queue.initialize();
    await queue.enqueue({
      type: 'COMPLETE_TASK',
      taskId: 'task:phase1',
      phaseName: 'Acquire sources',
      artifacts: [{ path: 'outputs/receipt.md' }],
      source: 'plan_executor'
    });

    const tasks = [
      {
        id: 'task:phase1',
        planId: 'plan:main',
        milestoneId: 'ms:phase1',
        title: 'Acquire sources',
        state: 'PENDING'
      },
      {
        id: 'task:phase2',
        planId: 'plan:main',
        milestoneId: 'ms:phase2',
        title: 'Validate outputs',
        state: 'PENDING'
      }
    ];
    const milestones = [
      { id: 'ms:phase1', planId: 'plan:main', title: 'Acquire', order: 1, status: 'ACTIVE' },
      { id: 'ms:phase2', planId: 'plan:main', title: 'Validate', order: 2, status: 'LOCKED' }
    ];
    const planUpdates = [];

    const stateStore = {
      getPlan: async () => ({ id: 'plan:main', createdAt: 1000 }),
      getTask: async taskId => tasks.find(task => task.id === taskId),
      listTasks: async () => tasks,
      listMilestones: async () => milestones,
      completeTask: async taskId => {
        const task = tasks.find(item => item.id === taskId);
        task.state = 'DONE';
      },
      failTask: async () => {
        throw new Error('failTask should not be called');
      },
      upsertMilestone: async milestone => {
        const index = milestones.findIndex(item => item.id === milestone.id);
        milestones[index] = milestone;
      },
      updatePlan: async (_planId, patch) => {
        planUpdates.push(patch);
      }
    };

    await queue.processAll(stateStore, null);

    expect(tasks[0].state).to.equal('DONE');
    expect(milestones[0].status).to.equal('COMPLETED');
    expect(milestones[1].status).to.equal('ACTIVE');
    expect(planUpdates[0]).to.deep.equal({ activeMilestone: 'ms:phase2' });
  });
});
