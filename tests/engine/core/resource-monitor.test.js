import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ResourceMonitor } = require('../../../engine/src/core/resource-monitor.js');

function withFakeNow(value, fn) {
  const realNow = Date.now;
  Date.now = () => value;
  try {
    return fn();
  } finally {
    Date.now = realNow;
  }
}

test('ResourceMonitor calculates CPU from the interval delta, not cumulative process CPU', () => {
  const warnings = [];
  const monitor = new ResourceMonitor(
    { resources: { cpuWarningThreshold: 0.9 } },
    { warn: (message, data) => warnings.push({ message, data }), error: () => {}, info: () => {} }
  );

  monitor.lastCheck = 1_000;
  monitor.lastCPUUsage = { user: 4_000_000, system: 0 };

  const percent = withFakeNow(2_000, () => (
    monitor.calculateCPUPercent({ user: 4_100_000, system: 0 })
  ));

  assert.equal(percent, 10);
  assert.deepEqual(warnings, []);
});
