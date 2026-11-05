const assert = require('node:assert/strict');
const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const {
  clearLastBrain,
  getRestorableBrainPath,
  rememberLastBrain,
} = require('../../evobrew/server/brain-runtime-state.js');

test('brain runtime state restores only a remembered valid brain inside configured roots', () => {
  const root = join(tmpdir(), `evobrew-brain-state-${Date.now()}`);
  const statePath = join(root, 'runtime-state.json');
  const allowedRoot = join(root, 'brains');
  const brainPath = join(allowedRoot, 'run-a');
  const outsidePath = join(root, 'outside', 'run-b');

  mkdirSync(brainPath, { recursive: true });
  mkdirSync(outsidePath, { recursive: true });
  writeFileSync(join(brainPath, 'state.json.gz'), 'not parsed by this test');
  writeFileSync(join(outsidePath, 'state.json.gz'), 'not parsed by this test');

  try {
    rememberLastBrain(statePath, brainPath);
    assert.equal(getRestorableBrainPath(statePath, [allowedRoot]), brainPath);

    rememberLastBrain(statePath, outsidePath);
    assert.equal(getRestorableBrainPath(statePath, [allowedRoot]), null);

    rememberLastBrain(statePath, brainPath);
    clearLastBrain(statePath);
    assert.equal(getRestorableBrainPath(statePath, [allowedRoot]), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
