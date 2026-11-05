import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const memorySensor = require('../../../engine/src/sensors/stock/memory.js');

test('memory sensor labels macOS raw free memory with swap pressure', () => {
  const value = memorySensor._test.formatValue({
    freeGB: 0.4,
    totalGB: 16,
    freePercent: 2,
    swap: { usedPercent: 87 },
  });

  assert.equal(value, 'raw free 0.4 GB (2% of 16) · swap 87% used');
});

test('memory sensor keeps portable free-memory wording without swap data', () => {
  const value = memorySensor._test.formatValue({
    freeGB: 4.5,
    totalGB: 16,
    freePercent: 28,
    swap: null,
  });

  assert.equal(value, '4.5 GB free (28% of 16)');
});
