'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OsKernelStore } = require('../../../engine/src/os-kernel/store.js');
const { recordBeliefDelta } = require('../../../engine/src/os-kernel/belief-delta.js');

test('recordBeliefDelta writes claim and outcome', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-kernel-'));
  const store = new OsKernelStore({ brainDir: dir });
  const delta = recordBeliefDelta(store, {
    goalId: 'g1',
    claim: 'harness was down',
    outcome: 'pass',
    revisedBelief: 'harness recovered after pm2 restart',
    evidenceReceiptId: 'r1',
  });
  assert.equal(delta.schema, 'home23.os-kernel.belief-delta.v1');
  assert.equal(delta.claim, 'harness was down');
  assert.equal(delta.outcome, 'pass');
  assert.equal(delta.revisedBelief, 'harness recovered after pm2 restart');
  assert.equal(delta.evidenceReceiptId, 'r1');
  assert.equal(delta.goalId, 'g1');

  const beliefPath = path.join(dir, 'os-kernel', 'belief-deltas.jsonl');
  assert.ok(fs.existsSync(beliefPath));
  const lines = fs.readFileSync(beliefPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const persisted = JSON.parse(lines[0]);
  assert.equal(persisted.id, delta.id);
  assert.equal(persisted.schema, 'home23.os-kernel.belief-delta.v1');
});
