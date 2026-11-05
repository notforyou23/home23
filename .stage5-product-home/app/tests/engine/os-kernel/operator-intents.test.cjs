'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OsKernelStore } = require('../../../engine/src/os-kernel/store.js');
const { createFromFuseNotify } = require('../../../engine/src/os-kernel/operator-intents.js');

test('createFromFuseNotify builds open intent with checklist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-kernel-'));
  const store = new OsKernelStore({ brainDir: dir });
  const intent = createFromFuseNotify(store, {
    problemId: 'jerry_harness_online',
    agent: 'jerry',
    title: 'Harness down',
    why: 'Channels are down after pm2 restart failed',
    evidence: 'pm2_status fail',
    checklist: ['Confirm process name', 'Click Restart harness', 'Mark done if verifier green'],
    safeAction: { id: 'restart_pm2', label: 'Restart harness', args: { name: 'home23-jerry-harness' } },
  });
  assert.equal(intent.status, 'open');
  assert.equal(intent.safe_action.id, 'restart_pm2');
});
