/**
 * Unit tests for PlanScheduler
 * Tests task selection, prioritization, and work-stealing logic
 */

const { expect, assert } = require('chai');
const PlanScheduler = require('../../src/planning/plan-scheduler');

describe('PlanScheduler', () => {
  let scheduler;
  let mockLogger;
  let mockStateStore;
  let activePlan;
  let runnableTasks;
  let allTasks;
  let claimMap;
  let releaseCalls;

  beforeEach(() => {
    activePlan = { id: 'plan:main', status: 'ACTIVE' };
    runnableTasks = [];
    allTasks = [];
    claimMap = new Map();
    releaseCalls = [];

    mockLogger = {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {}
    };

    mockStateStore = {
      getPlan: async (planId) => (planId === 'plan:main' ? activePlan : null),
      listRunnableTasks: async () => runnableTasks,
      claimTask: async (taskId) => {
        if (claimMap.has(taskId)) {
          const handler = claimMap.get(taskId);
          return typeof handler === 'function' ? handler() : handler;
        }
        return true;
      },
      listTasks: async (planId, filter) => {
        const tasks = allTasks.length ? allTasks : runnableTasks;
        // Apply filter if provided (for IN_PROGRESS check)
        if (filter && filter.state) {
          return tasks.filter(t =>
            t.state === filter.state &&
            (!filter.claimedBy || t.claimedBy === filter.claimedBy)
          );
        }
        return tasks;
      },
      releaseTask: async (taskId, owner) => {
        releaseCalls.push({ taskId, owner });
        return true;
      }
    };

    scheduler = new PlanScheduler(
      mockStateStore,
      'instance-1',
      {
        planning: {
          scheduler: {
            specializationEnabled: true,
            claimTtlMs: 600000,
            stealThresholdMs: 60000
          }
        }
      },
      mockLogger
    );
  });

  describe('nextRunnableTask', () => {
    it('returns null when no active plan exists', async () => {
      activePlan.status = 'PAUSED';
      const result = await scheduler.nextRunnableTask();
      expect(result).to.equal(null);
    });

    it('returns null when planner does not find tasks', async () => {
      runnableTasks = [];
      const result = await scheduler.nextRunnableTask();
      expect(result).to.equal(null);
    });

    it('selects task with highest priority when claims succeed', async () => {
      runnableTasks = [
        { id: 'task-low', priority: 5, tags: [], deadline: null },
        { id: 'task-high', priority: 10, tags: [], deadline: null },
        { id: 'task-mid', priority: 8, tags: [], deadline: null }
      ];

      const result = await scheduler.nextRunnableTask();
      expect(result.id).to.equal('task-high');
    });

    it('continues to next task when claim fails', async () => {
      runnableTasks = [
        { id: 'task-high', priority: 10, tags: [], deadline: null },
        { id: 'task-low', priority: 5, tags: [], deadline: null }
      ];

      claimMap.set('task-high', false);
      claimMap.set('task-low', true);

      const result = await scheduler.nextRunnableTask();
      expect(result.id).to.equal('task-low');
    });

    it('boosts tasks matching specialization profile', async () => {
      runnableTasks = [
        { id: 'task-general', priority: 8, tags: [], deadline: null },
        { id: 'task-special', priority: 6, tags: ['code_execution'], deadline: null }
      ];

      const profile = {
        boost: 3,
        baseline: 1,
        penalty: 0.5,
        agentTypes: new Set(['code_execution'])
      };

      const result = await scheduler.nextRunnableTask(profile);
      expect(result.id).to.equal('task-special');
    });

    it('applies urgency multiplier for overdue deadlines', async () => {
      const overdue = Date.now() - 7 * 24 * 60 * 60 * 1000;

      runnableTasks = [
        { id: 'task-regular', priority: 9, tags: [], dueDate: null },
        { id: 'task-urgent', priority: 6, tags: [], dueDate: overdue }
      ];

      const result = await scheduler.nextRunnableTask();
      expect(result.id).to.equal('task-urgent');
    });
  });

  describe('specialization weighting', () => {
    it('returns baseline weight when no profile is set', () => {
      expect(scheduler.getSpecializationWeight({})).to.equal(1);
    });

    it('boosts tasks that match specialization domains', () => {
      scheduler.specializationProfile = {
        baseline: 1,
        boost: 4,
        domains: new Set(['research'])
      };

      const weight = scheduler.getSpecializationWeight({ tags: ['research'] });
      expect(weight).to.equal(4);
    });

    it('penalizes tasks from avoided agent types', () => {
      scheduler.specializationProfile = {
        baseline: 1,
        penalty: 0.5,
        agentTypes: new Set(['analysis']),
        avoidAgentTypes: new Set(['operations'])
      };

      const weight = scheduler.getSpecializationWeight({ tags: ['operations'] });
      expect(weight).to.equal(0.5);
    });
  });

  describe('urgency multiplier', () => {
    it('returns 1 when no deadline provided', () => {
      expect(scheduler.calculateUrgencyMultiplier({})).to.equal(1);
    });

    it('returns value greater than 1 for overdue deadlines', () => {
      const overdue = Date.now() - 24 * 60 * 60 * 1000;
      const multiplier = scheduler.calculateUrgencyMultiplier({ dueDate: overdue });
      assert(multiplier > 1);
    });

    it('returns 1 for future deadlines', () => {
      const future = Date.now() + 30 * 24 * 60 * 60 * 1000;
      expect(scheduler.calculateUrgencyMultiplier({ dueDate: future })).to.equal(1);
    });
  });

  describe('work stealing helpers', () => {
    it('identifies tasks with expired claims as stealable', () => {
      const expiredTask = {
        id: 'expired',
        state: 'IN_PROGRESS',
        claimedBy: 'other-instance',
        claimExpires: Date.now() - 1000,
        tags: []
      };

      const stealable = scheduler.findStealableTasks([expiredTask]);
      expect(stealable).to.have.lengthOf(1);
      expect(stealable[0].id).to.equal('expired');
    });

    it('ignores tasks claimed by current instance', () => {
      const task = {
        id: 'ours',
        state: 'CLAIMED',
        claimedBy: 'instance-1',
        claimExpires: Date.now() - 1000,
        tags: []
      };

      const stealable = scheduler.findStealableTasks([task]);
      expect(stealable).to.have.lengthOf(0);
    });

    it('respects steal threshold for soon-to-expire tasks', () => {
      const soon = {
        id: 'soon',
        state: 'CLAIMED',
        claimedBy: 'other-instance',
        claimExpires: Date.now() + 500,
        tags: []
      };

      const later = {
        id: 'later',
        state: 'CLAIMED',
        claimedBy: 'other-instance',
        claimExpires: Date.now() + 120000,
        tags: []
      };

      const stealable = scheduler.findStealableTasks([soon, later]);
      expect(stealable.map(t => t.id)).to.deep.equal(['soon']);
    });
  });
});

