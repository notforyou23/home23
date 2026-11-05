const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { verifiers } = require('../../../engine/src/live-problems/verifiers.js');

test('accepted rebuild floor ignores all-time high-water regression', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-'));
  fs.writeFileSync(path.join(dir, 'brain-high-water.json'), JSON.stringify({
    maxNodeCount: 40000,
    acceptedMaxNodeCount: 28000,
  }));
  const memory = { nodes: { size: 29000 } };
  const r = verifiers.node_count_stable({ dropThreshold: 0.1, minBaseline: 100 }, { memory, brainDir: dir });
  assert.equal(r.ok, true, r.detail);
});

test('regression still fails without accepted rebuild annotation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-'));
  fs.writeFileSync(path.join(dir, 'brain-high-water.json'), JSON.stringify({ maxNodeCount: 40000 }));
  const memory = { nodes: { size: 29000 } };
  const r = verifiers.node_count_stable({ dropThreshold: 0.1, minBaseline: 100 }, { memory, brainDir: dir });
  assert.equal(r.ok, false);
});
