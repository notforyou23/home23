'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OsKernelStore } = require('../../../engine/src/os-kernel/store.js');
const { SCHEMA_GOAL } = require('../../../engine/src/os-kernel/schemas.js');

test('OsKernelStore persists goal as queued by default and refuses prose-only complete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-kernel-'));
  const store = new OsKernelStore({ brainDir: dir });
  const goal = store.createGoal({
    title: 'File weekly review',
    owner: 'forrest',
    deliverable: 'instances/forrest/workspace/reports/example.md',
    acceptanceTest: { type: 'file_exists', args: { path: 'instances/forrest/workspace/reports/example.md' } },
  });
  assert.equal(goal.status, 'queued');
  assert.throws(() => store.completeGoal(goal.id, { proseOnly: true }), /receipt/i);
});

test('OsKernelStore createGoal honors an explicit status: active request', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-kernel-'));
  const store = new OsKernelStore({ brainDir: dir });
  const goal = store.createGoal({
    title: 'Urgent goal',
    owner: 'forrest',
    deliverable: 'out.md',
    acceptanceTest: { type: 'manual' },
    status: 'active',
  });
  assert.equal(goal.status, 'active');
});

test('OsKernelStore throws on corrupt goals.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-kernel-'));
  const kernelDir = path.join(dir, 'os-kernel');
  fs.mkdirSync(kernelDir, { recursive: true });
  fs.writeFileSync(path.join(kernelDir, 'goals.json'), '{ not valid json', 'utf8');
  assert.throws(() => new OsKernelStore({ brainDir: dir }), /corrupt goals\.json/i);
});

test('createGoal pins schema even when caller passes schema override', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-kernel-'));
  const store = new OsKernelStore({ brainDir: dir });
  const goal = store.createGoal({
    title: 'Pinned schema',
    owner: 'forrest',
    deliverable: 'out.md',
    acceptanceTest: { type: 'manual' },
    schema: 'evil',
    id: 'evil-id',
    createdAt: '1970-01-01T00:00:00.000Z',
    status: 'complete',
  });
  assert.equal(goal.schema, SCHEMA_GOAL);
  assert.notEqual(goal.id, 'evil-id');
  assert.notEqual(goal.createdAt, '1970-01-01T00:00:00.000Z');
  // 'complete' isn't the one status createGoal will honor from a caller
  // (only 'active' is); pinning falls back to the safe default of 'queued'.
  assert.equal(goal.status, 'queued');
  const reloaded = new OsKernelStore({ brainDir: dir });
  assert.equal(reloaded.getGoal(goal.id).schema, SCHEMA_GOAL);
});

test('reloadIfChanged picks up an external write to goals.json without a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-kernel-'));
  const storeA = new OsKernelStore({ brainDir: dir });
  const goal = storeA.createGoal({
    title: 'Cross-process goal',
    owner: 'forrest',
    deliverable: 'out.md',
    acceptanceTest: { type: 'manual' },
  });

  // Simulate a second process (e.g. the long-lived engine store) holding
  // its own instance opened before storeA's write above.
  const storeB = new OsKernelStore({ brainDir: dir });
  assert.equal(storeB.listGoals().length, 1);

  // storeA mutates again — a different process writing goals.json.
  storeA.setGoalStatus(goal.id, 'active');

  // storeB must observe the external change via its public methods, not
  // just its own reloadIfChanged() call.
  const seenByB = storeB.getGoal(goal.id);
  assert.ok(seenByB, 'storeB should see the goal at all after reload');
  assert.equal(seenByB.status, 'active');
});

test('createAction/completeAction populate listActions for the In Flight -> Verified trail', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-kernel-'));
  const store = new OsKernelStore({ brainDir: dir });

  const running = store.createAction({ kind: 'safe_action', detail: 'reclaim_known_safe_disk' });
  assert.equal(running.status, 'running');
  assert.equal(store.listActions().filter((a) => a.status === 'running').length, 1);

  const completed = store.completeAction(running.id, { detail: 'done' });
  assert.equal(completed.status, 'complete');
  assert.equal(store.listActions().filter((a) => a.status === 'running').length, 0);
  assert.equal(store.listActions().filter((a) => a.status === 'complete').length, 1);

  assert.throws(() => store.completeAction('does-not-exist'), /Action not found/i);
});
