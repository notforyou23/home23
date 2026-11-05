const assert = require('node:assert/strict');
const test = require('node:test');

const { ConfigValidator } = require('../../../engine/src/core/config-validator');

function baseConfig(parallelBranches) {
  return {
    architecture: {
      reasoning: {
        mode: 'quantum',
        parallelBranches,
      },
    },
  };
}

function validate(config) {
  return new ConfigValidator(config, {
    info() {},
    warn() {},
    error() {},
  }).validate();
}

test('ConfigValidator accepts single-branch quantum pressure mode', () => {
  const result = validate(baseConfig(1));

  assert.equal(result.valid, true);
  assert.deepEqual(result.warnings, []);
  assert.ok(result.info.includes('✓ Quantum reasoning: single-branch pressure mode'));
});

test('ConfigValidator still warns for unsupported quantum branch counts', () => {
  const result = validate(baseConfig(0));

  assert.equal(result.valid, true);
  assert.match(result.warnings.join('\n'), /outside supported range \(1-10\)/);
});
