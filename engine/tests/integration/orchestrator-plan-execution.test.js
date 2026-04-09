/**
 * Integration test for orchestrator plan-driven execution
 * Tests task selection, execution, and acceptance validation flow
 */

const assert = require('node:assert/strict');
const { tmpdir } = require('os');
const { join } = require('path');
const { rm } = require('fs/promises');
const FilesystemStateStore = require('../../src/cluster/backends/filesystem-state-store.js');
const PlanScheduler = require('../../src/planning/plan-scheduler.js');
const AcceptanceValidator = require('../../src/planning/acceptance-validator.js');

describe('Orchestrator Plan Execution Integration', () => {
  let stateStore;
  let scheduler;
  let validator;
  let testDir;
  
  const mockLogger = {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: ()=> {}
  };
  
  before(async () => {
    testDir = join(tmpdir(), `cosmo-orch-test-${Date.now()}`);
    stateStore = new FilesystemStateStore({
      fsRoot: testDir
    }, mockLogger);
    await stateStore.connect();
    
    scheduler = new PlanScheduler(stateStore, 'test-instance', {}, mockLogger);
    
    const mockAgentExecutor = {
      spawnAgent: async () => ({ agentId: 'mock-qa', results: [] })
    };
    validator = new AcceptanceValidator(mockAgentExecutor, mockLogger);
    
    // Set up test plan and milestone
    await stateStore.createPlan({
      id: 'plan:main',
      title: 'Integration Test Plan',
      status: 'ACTIVE',
      version: 1,
      createdAt: new Date().toISOString()
    });
    
    await stateStore.upsertMilestone({
      id: 'milestone:integration',
      planId: 'plan:main',
      title: 'Test Milestone',
      order: 1,
      status: 'ACTIVE',
      createdAt: new Date().toISOString()
    });
  });
  
  after(async () => {
    await stateStore.disconnect();
    await rm(testDir, { recursive: true, force: true });
  });

  describe('Task selection and claiming', () => {
    it('should select highest priority task', async () => {
      // Create tasks
      await stateStore.upsertTask({
        id: 'task:low',
      planId: 'plan:main',
        milestoneId: 'milestone:integration',
        title: 'Low Priority',
        state: 'PENDING',
        priority: 3,
        deps: [],
        acceptanceCriteria: [],
        createdAt: new Date().toISOString()
      });
      
      await stateStore.upsertTask({
        id: 'task:high',
      planId: 'plan:main',
        milestoneId: 'milestone:integration',
        title: 'High Priority',
        state: 'PENDING',
        priority: 10,
        deps: [],
        acceptanceCriteria: [],
        createdAt: new Date().toISOString()
      });
      
      const selected = await scheduler.nextRunnableTask();
      assert(selected);
      assert.equal(selected.id, 'task:high');

      const claimedTask = await stateStore.getTask('task:high');
      assert.equal(claimedTask.state, 'CLAIMED');
      assert.equal(claimedTask.claimedBy, 'test-instance');
    });

    it('should respect task dependencies', async () => {
      await stateStore.upsertTask({
        id: 'task:dependency',
        planId: 'plan:main',
        milestoneId: 'milestone:integration',
        title: 'Depends on Others',
        state: 'PENDING',
        priority: 10,
        deps: ['task:prereq'],
        acceptanceCriteria: [],
        createdAt: new Date().toISOString()
      });
      
      await stateStore.upsertTask({
        id: 'task:prereq',
        planId: 'plan:main',
        milestoneId: 'milestone:integration',
        title: 'Prerequisite',
        state: 'PENDING',
        priority: 5,
        deps: [],
        acceptanceCriteria: [],
        createdAt: new Date().toISOString()
      });
      
      const selected = await scheduler.nextRunnableTask();
      assert(selected);
      assert.equal(selected.id, 'task:prereq');
    });
  });

  describe('Task execution lifecycle', () => {
    it('should transition through states correctly', async () => {
      const taskId = 'task:lifecycle';
      
      // Create task
      await stateStore.upsertTask({
        id: taskId,
        planId: 'plan:main',
        milestoneId: 'milestone:integration',
        title: 'Lifecycle Test',
        state: 'PENDING',
        priority: 5,
        deps: [],
        acceptanceCriteria: [],
        createdAt: new Date().toISOString()
      });
      
      // Claim
      await stateStore.claimTask(taskId, 'test-instance', 60000);
      let task = await stateStore.getTask(taskId);
      assert.equal(task.state, 'CLAIMED');
      assert.equal(task.claimedBy, 'test-instance');
      
      // Start
      await stateStore.startTask(taskId, 'test-instance');
      task = await stateStore.getTask(taskId);
      assert.equal(task.state, 'IN_PROGRESS');
      assert(task.updatedAt);
      
      // Complete
      await stateStore.completeTask(taskId);
      task = await stateStore.getTask(taskId);
      assert.equal(task.state, 'DONE');
    });
  });

  describe('Acceptance validation', () => {
    it('should validate literal criteria', async () => {
      const criteria = [
        {
          type: 'literal',
          pattern: 'success indicator'
        }
      ];
      
      const artifacts = [
        {
          type: 'result',
          content: 'The task completed with success indicator present'
        }
      ];
      
      const validation = await validator.checkAll(criteria, artifacts);
      assert.equal(validation.passed, true);
    });

    it('should fail when criteria not met', async () => {
      const criteria = [
        {
          type: 'literal',
          pattern: 'required output'
        }
      ];
      
      const artifacts = [
        {
          type: 'result',
          content: 'The task completed but without the required part'
        }
      ];
      
      const validation = await validator.checkAll(criteria, artifacts);
      assert.equal(validation.passed, false);
      assert(validation.failures.length > 0);
    });
  });

  describe('Milestone completion check', () => {
    it('should detect when all milestone tasks are done', async () => {
      const milestoneId = 'milestone:completion';
      const planId = 'plan:main';
      
      // Create milestone
      await stateStore.upsertMilestone({
        id: milestoneId,
        planId,
        title: 'Completion Test',
        order: 2,
        status: 'ACTIVE',
        createdAt: new Date().toISOString()
      });
      
      // Create 2 tasks
      await stateStore.upsertTask({
        id: 'task:m1',
        planId,
        milestoneId,
        title: 'Milestone Task 1',
        state: 'PENDING',
        priority: 5,
        deps: [],
        acceptanceCriteria: [],
        createdAt: new Date().toISOString()
      });
      
      await stateStore.upsertTask({
        id: 'task:m2',
        planId,
        milestoneId,
        title: 'Milestone Task 2',
        state: 'PENDING',
        priority: 5,
        deps: [],
        acceptanceCriteria: [],
        createdAt: new Date().toISOString()
      });
      
      // Complete both tasks
      await stateStore.claimTask('task:m1', 'test', 60000);
      await stateStore.startTask('task:m1', 'test');
      await stateStore.completeTask('task:m1');
      
      await stateStore.claimTask('task:m2', 'test', 60000);
      await stateStore.startTask('task:m2', 'test');
      await stateStore.completeTask('task:m2');
      
      // Check if all tasks done
      const tasks = await stateStore.listTasks(planId, { milestoneId });
      const allDone = tasks.every(t => t.state === 'DONE');
      
      assert.equal(allDone, true);
      
      // Advance milestone
      await stateStore.advanceMilestone(planId, milestoneId);
      const milestone = await stateStore.getMilestone(milestoneId);
      assert.equal(milestone.status, 'COMPLETED');
    });
  });

  describe('Work stealing', () => {
    it('should identify stealable tasks', async () => {
      const oldTime = new Date(Date.now() - 20 * 60 * 1000); // 20 mins ago
      
      await stateStore.upsertTask({
        id: 'task:stale',
        planId: 'plan:main',
        milestoneId: 'milestone:integration',
        title: 'Stale Task',
        state: 'IN_PROGRESS',
        claimedBy: 'other-instance',
        claimExpires: oldTime.getTime(),
        priority: 5,
        deps: [],
        acceptanceCriteria: [],
        createdAt: new Date().toISOString()
      });
      
      const tasks = await stateStore.listTasks('plan:main');
      const stealable = scheduler.findStealableTasks(tasks);
      
      // Should find the stale task
      const found = stealable.find(t => t.id === 'task:stale');
      assert(found, 'Should find stale task as stealable');
    });
  });
});

