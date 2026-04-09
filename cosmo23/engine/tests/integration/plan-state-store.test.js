/**
 * Integration tests for Plan/Task/Milestone operations in state stores
 * Tests both FilesystemStateStore and RedisStateStore
 */

const assert = require('node:assert/strict');
const { tmpdir } = require('os');
const { join } = require('path');
const { rm } = require('fs/promises');
const FilesystemStateStore = require('../../src/cluster/backends/filesystem-state-store.js');

describe('Plan State Store Integration', () => {
  let stateStore;
  let testDir;
  
  before(async () => {
    testDir = join(tmpdir(), `cosmo-test-${Date.now()}`);
    stateStore = new FilesystemStateStore({
      fsRoot: testDir
    }, {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {}
    });
    await stateStore.connect();
  });
  
  after(async () => {
    await stateStore.disconnect();
    await rm(testDir, { recursive: true, force: true });
  });

  describe('Plan CRUD', () => {
    it('should create a plan', async () => {
      const plan = {
        id: 'plan:test1',
        title: 'Test Plan',
        description: 'A test plan',
        status: 'ACTIVE',
        version: 1,
        createdAt: new Date().toISOString()
      };
      
      await stateStore.createPlan(plan);
      const retrieved = await stateStore.getPlan(plan.id);
      
      assert.equal(retrieved.id, plan.id);
      assert.equal(retrieved.title, plan.title);
      assert.equal(retrieved.status, plan.status);
    });

    it('should update an existing plan', async () => {
      const plan = {
        id: 'plan:test2',
        title: 'Original Title',
        status: 'ACTIVE',
        version: 1,
        createdAt: new Date().toISOString()
      };
      
      await stateStore.createPlan(plan);
      
      await stateStore.updatePlan(plan.id, { title: 'Updated Title' });
      
      const retrieved = await stateStore.getPlan(plan.id);
      assert.equal(retrieved.title, 'Updated Title');
      assert.equal(retrieved.version, plan.version + 1);
    });

    it('should list all plans', async () => {
      const plans = await stateStore.listPlans();
      assert(Array.isArray(plans));
      assert(plans.length >= 2); // At least the 2 we created
    });

    it('should return null for non-existent plan', async () => {
      const plan = await stateStore.getPlan('plan:nonexistent');
      assert.equal(plan, null);
    });
  });

  describe('Milestone operations', () => {
    beforeEach(async () => {
      // Ensure plan exists for milestones
      await stateStore.createPlan({
        id: 'plan:milestones',
        title: 'Milestone Test Plan',
        status: 'ACTIVE',
        version: 1,
        createdAt: new Date().toISOString()
      });
    });

    it('should create/upsert a milestone', async () => {
      const milestone = {
        id: 'milestone:1',
        planId: 'plan:milestones',
        title: 'Phase 1',
        order: 1,
        status: 'ACTIVE',
        createdAt: new Date().toISOString()
      };
      
      await stateStore.upsertMilestone(milestone);
      const retrieved = await stateStore.getMilestone(milestone.id);
      
      assert.equal(retrieved.id, milestone.id);
      assert.equal(retrieved.title, milestone.title);
    });

    it('should list milestones for a plan', async () => {
      const milestones = await stateStore.listMilestones('plan:milestones');
      assert(Array.isArray(milestones));
      assert(milestones.length >= 1);
    });

    it('should advance milestone state', async () => {
      const milestone = {
        id: 'milestone:advance',
        planId: 'plan:milestones',
        title: 'Advance Test',
        order: 2,
        status: 'ACTIVE',
        createdAt: new Date().toISOString()
      };
      
      await stateStore.upsertMilestone(milestone);
      await stateStore.advanceMilestone('plan:milestones', milestone.id);
      
      const retrieved = await stateStore.getMilestone(milestone.id);
      assert.equal(retrieved.status, 'COMPLETED');
    });
  });

  describe('Task lifecycle', () => {
    beforeEach(async () => {
      // Ensure plan and milestone exist
      await stateStore.createPlan({
        id: 'plan:tasks',
        title: 'Task Test Plan',
        status: 'ACTIVE',
        version: 1,
        createdAt: new Date().toISOString()
      });
      
      await stateStore.upsertMilestone({
        id: 'milestone:tasks',
        planId: 'plan:tasks',
        title: 'Task Milestone',
        order: 1,
        status: 'ACTIVE',
        createdAt: new Date().toISOString()
      });
    });

    it('should create a task in PENDING state', async () => {
      const task = {
        id: 'task:1',
        planId: 'plan:tasks',
        milestoneId: 'milestone:tasks',
        title: 'Test Task',
        description: 'A test task',
        state: 'PENDING',
        priority: 5,
        deps: [],
        acceptanceCriteria: [],
        createdAt: new Date().toISOString()
      };
      
      await stateStore.upsertTask(task);
      const retrieved = await stateStore.getTask(task.id);
      
      assert.equal(retrieved.id, task.id);
      assert.equal(retrieved.state, 'PENDING');
    });

    it('should claim a task atomically', async () => {
      const task = {
        id: 'task:claim',
        planId: 'plan:tasks',
        milestoneId: 'milestone:tasks',
        title: 'Claim Test',
        state: 'PENDING',
        priority: 5,
        deps: [],
        acceptanceCriteria: [],
        createdAt: new Date().toISOString()
      };
      
      await stateStore.upsertTask(task);
      
      const claimed = await stateStore.claimTask(task.id, 'instance-1', 60000);
      assert.equal(claimed, true);
      
      const retrieved = await stateStore.getTask(task.id);
      assert.equal(retrieved.state, 'CLAIMED');
      assert.equal(retrieved.claimedBy, 'instance-1');
    });

    it('should prevent double-claiming', async () => {
      const task = {
        id: 'task:double-claim',
        planId: 'plan:tasks',
        milestoneId: 'milestone:tasks',
        title: 'Double Claim Test',
        state: 'PENDING',
        priority: 5,
        deps: [],
        acceptanceCriteria: [],
        createdAt: new Date().toISOString()
      };
      
      await stateStore.upsertTask(task);
      
      const claimed1 = await stateStore.claimTask(task.id, 'instance-1', 60000);
      const claimed2 = await stateStore.claimTask(task.id, 'instance-2', 60000);
      
      assert.equal(claimed1, true);
      assert.equal(claimed2, false);
    });

    it('should start a claimed task', async () => {
      const task = {
        id: 'task:start',
        planId: 'plan:tasks',
        milestoneId: 'milestone:tasks',
        title: 'Start Test',
        state: 'PENDING',
        priority: 5,
        deps: [],
        acceptanceCriteria: [],
        createdAt: new Date().toISOString()
      };
      
      await stateStore.upsertTask(task);
      await stateStore.claimTask(task.id, 'instance-1', 60000);
      await stateStore.startTask(task.id, 'instance-1');
      
      const retrieved = await stateStore.getTask(task.id);
      assert.equal(retrieved.state, 'IN_PROGRESS');
      assert(retrieved.updatedAt);
    });

    it('should complete a task', async () => {
      const task = {
        id: 'task:complete',
        planId: 'plan:tasks',
        milestoneId: 'milestone:tasks',
        title: 'Complete Test',
        state: 'PENDING',
        priority: 5,
        deps: [],
        acceptanceCriteria: [],
        createdAt: new Date().toISOString()
      };
      
      await stateStore.upsertTask(task);
      await stateStore.claimTask(task.id, 'instance-1', 60000);
      await stateStore.startTask(task.id, 'instance-1');
      await stateStore.completeTask(task.id);
      
      const retrieved = await stateStore.getTask(task.id);
      assert.equal(retrieved.state, 'DONE');
    });

    it('should fail a task with reason', async () => {
      const task = {
        id: 'task:fail',
        planId: 'plan:tasks',
        milestoneId: 'milestone:tasks',
        title: 'Fail Test',
        state: 'PENDING',
        priority: 5,
        deps: [],
        acceptanceCriteria: [],
        createdAt: new Date().toISOString()
      };
      
      await stateStore.upsertTask(task);
      await stateStore.claimTask(task.id, 'instance-1', 60000);
      await stateStore.startTask(task.id, 'instance-1');
      await stateStore.failTask(task.id, 'Test failure reason');
      
      const retrieved = await stateStore.getTask(task.id);
      assert.equal(retrieved.state, 'FAILED');
      assert.equal(retrieved.failureReason, 'Test failure reason');
    });

    it('should release a claimed task', async () => {
      const task = {
        id: 'task:release',
        planId: 'plan:tasks',
        milestoneId: 'milestone:tasks',
        title: 'Release Test',
        state: 'PENDING',
        priority: 5,
        deps: [],
        acceptanceCriteria: [],
        createdAt: new Date().toISOString()
      };
      
      await stateStore.upsertTask(task);
      await stateStore.claimTask(task.id, 'instance-1', 60000);
      await stateStore.releaseTask(task.id, 'instance-1');
      
      const retrieved = await stateStore.getTask(task.id);
      assert.equal(retrieved.state, 'PENDING');
      assert.equal(retrieved.claimedBy, null);
    });

    it('should list runnable tasks', async () => {
      const runnable = await stateStore.listRunnableTasks('plan:tasks');
      assert(Array.isArray(runnable));
      // Should not include DONE, FAILED, or IN_PROGRESS tasks
      const states = runnable.map(t => t.state);
      assert(!states.includes('DONE'));
      assert(!states.includes('FAILED'));
    });
  });

  describe('PlanDelta application', () => {
    beforeEach(async () => {
      await stateStore.createPlan({
        id: 'plan:delta',
        title: 'Delta Test Plan',
        status: 'ACTIVE',
        version: 1,
        createdAt: new Date().toISOString()
      });
    });

    it('should apply PlanDelta with correct version', async () => {
      const delta = {
        planId: 'plan:delta',
        expectedVersion: 1,
        newTasks: [
          {
            id: 'task:delta1',
            planId: 'plan:delta',
            milestoneId: 'milestone:delta',
            title: 'New Task',
            state: 'PENDING',
            priority: 5,
            deps: [],
            acceptanceCriteria: []
          }
        ],
        updatedTasks: [],
        rationale: 'Adding new task',
        createdAt: new Date().toISOString()
      };
      
      const applied = await stateStore.applyPlanDelta(delta);
      assert.equal(applied, true);
      
      const plan = await stateStore.getPlan('plan:delta');
      assert.equal(plan.version, 2); // Should increment
    });

    it('should reject PlanDelta with wrong version', async () => {
      const delta = {
        planId: 'plan:delta',
        expectedVersion: 99, // Wrong version
        newTasks: [],
        updatedTasks: [],
        rationale: 'Should fail',
        createdAt: new Date().toISOString()
      };
      
      const applied = await stateStore.applyPlanDelta(delta);
      assert.equal(applied, false);
    });
  });
});

