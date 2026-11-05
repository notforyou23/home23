import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PlanScheduler = require('../../../engine/src/planning/plan-scheduler.js');

test('PlanScheduler releases own expired in-progress claim before claiming runnable work', async () => {
  const calls = [];
  const logs = [];
  const now = Date.now();
  const task = {
    id: 'task:phase5',
    planId: 'plan:main',
    title: 'Create report',
    state: 'IN_PROGRESS',
    claimedBy: 'home23-forrest',
    claimExpires: now - 1000,
    deps: [],
    priority: 5,
  };

  const stateStore = {
    async getPlan(id) {
      assert.equal(id, 'plan:main');
      return { id, status: 'ACTIVE' };
    },
    async listTasks(planId, filters = {}) {
      calls.push(['listTasks', planId, filters]);
      if (filters.state === 'IN_PROGRESS') {
        return task.state === 'IN_PROGRESS' ? [task] : [];
      }
      return [task];
    },
    async releaseTask(taskId, instanceId) {
      calls.push(['releaseTask', taskId, instanceId]);
      assert.equal(taskId, task.id);
      assert.equal(instanceId, 'home23-forrest');
      task.state = 'PENDING';
      task.claimedBy = null;
      task.claimExpires = null;
      return true;
    },
    async listRunnableTasks(planId) {
      calls.push(['listRunnableTasks', planId]);
      return task.state === 'PENDING' ? [task] : [];
    },
    async claimTask(taskId, instanceId, ttlMs) {
      calls.push(['claimTask', taskId, instanceId, ttlMs]);
      assert.equal(taskId, task.id);
      assert.equal(instanceId, 'home23-forrest');
      assert.equal(ttlMs, 1234);
      task.state = 'CLAIMED';
      task.claimedBy = instanceId;
      task.claimExpires = Date.now() + ttlMs;
      return true;
    },
  };

  const scheduler = new PlanScheduler(
    stateStore,
    'home23-forrest',
    { planning: { scheduler: { claimTtlMs: 1234 } } },
    {
      warn(message, meta) {
        logs.push({ level: 'warn', message, meta });
      },
      info(message, meta) {
        logs.push({ level: 'info', message, meta });
      },
    }
  );

  const result = await scheduler.nextRunnableTask();

  assert.equal(result.id, 'task:phase5');
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['listTasks', 'releaseTask', 'listRunnableTasks', 'claimTask']
  );
  assert.equal(task.state, 'CLAIMED');
  assert.equal(task.claimedBy, 'home23-forrest');
  assert.equal(
    logs.some((entry) => entry.message === '[PlanScheduler] Released expired in-progress task claim'),
    true
  );
  assert.equal(
    logs.some((entry) => entry.message === '[PlanScheduler] Task claimed'),
    true
  );
});

test('PlanScheduler keeps a live in-progress claim instead of releasing it', async () => {
  const calls = [];
  const task = {
    id: 'task:active',
    planId: 'plan:main',
    state: 'IN_PROGRESS',
    claimedBy: 'home23-forrest',
    claimExpires: Date.now() + 60_000,
  };

  const scheduler = new PlanScheduler(
    {
      async getPlan() {
        return { id: 'plan:main', status: 'ACTIVE' };
      },
      async listTasks(planId, filters = {}) {
        calls.push(['listTasks', planId, filters]);
        return filters.state === 'IN_PROGRESS' ? [task] : [];
      },
      async releaseTask() {
        calls.push(['releaseTask']);
        return true;
      },
      async listRunnableTasks() {
        calls.push(['listRunnableTasks']);
        return [];
      },
    },
    'home23-forrest',
    {},
    { debug() {}, error() {} }
  );

  const result = await scheduler.nextRunnableTask();

  assert.equal(result, task);
  assert.deepEqual(calls.map((call) => call[0]), ['listTasks']);
});
