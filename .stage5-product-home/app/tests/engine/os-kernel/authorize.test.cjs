'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OsKernelStore } = require('../../../engine/src/os-kernel/store.js');
const { ACTION_CLASSES } = require('../../../engine/src/os-kernel/schemas.js');
const { activateGoal, authorizeAction } = require('../../../engine/src/os-kernel/authorize.js');

test('activateGoal refuses when active WIP at cap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-kernel-'));
  const store = new OsKernelStore({ brainDir: dir, wipActiveMax: 1 });
  const a = store.createGoal({
    title: 'A', owner: 'jerry', deliverable: 'a.md',
    acceptanceTest: { type: 'manual' }, status: 'queued',
  });
  const b = store.createGoal({
    title: 'B', owner: 'jerry', deliverable: 'b.md',
    acceptanceTest: { type: 'manual' }, status: 'queued',
  });
  activateGoal(store, a.id);
  assert.throws(() => activateGoal(store, b.id), /WIP|cap/i);
});

test('authorizeAction: destructive needs_you, draft allowed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-kernel-'));
  const store = new OsKernelStore({ brainDir: dir });
  const goal = store.createGoal({
    title: 'Gate test', owner: 'jerry', deliverable: 'out.md',
    acceptanceTest: { type: 'manual' },
  });
  const destructive = authorizeAction(store, {
    goalId: goal.id,
    actionClass: ACTION_CLASSES.DESTRUCTIVE,
    capabilityId: 'shell.rm',
    preview: 'rm -rf tmp/',
  });
  assert.equal(destructive.allowed, false);
  assert.equal(destructive.reason, 'needs_you');

  const draft = authorizeAction(store, {
    goalId: goal.id,
    actionClass: ACTION_CLASSES.DRAFT,
    capabilityId: 'file.write',
  });
  assert.equal(draft.allowed, true);
});
