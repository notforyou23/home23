'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OsKernelStore } = require('../../../engine/src/os-kernel/store.js');
const { buildActionReceipt } = require('../../../engine/src/os-kernel/receipts.js');

test('completeGoal accepts receipt with artifact hash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-kernel-'));
  const deliverable = path.join(dir, 'out.md');
  fs.writeFileSync(deliverable, 'done\n');
  const store = new OsKernelStore({ brainDir: dir });
  const goal = store.createGoal({
    title: 'Ship note',
    owner: 'jerry',
    deliverable,
    acceptanceTest: { type: 'file_exists', args: { path: deliverable } },
  });
  const receipt = buildActionReceipt({
    brainDir: dir,
    goalId: goal.id,
    actionClass: 'draft',
    artifactPath: deliverable,
    testResult: { ok: true, detail: 'file_exists' },
    outcome: 'pass',
  });
  store.completeGoal(goal.id, { receiptId: receipt.id, receipt });
  assert.equal(store.getGoal(goal.id).status, 'complete');
});
