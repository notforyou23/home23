import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration } from '../../../engine/src/util/parse-duration.js';
import { parseCadenceCycles } from '../../../engine/src/util/parse-cadence.js';

test('parseDuration parses s/m/h/d', () => {
  assert.equal(parseDuration('45s'), 45_000);
  assert.equal(parseDuration('30m'), 30 * 60_000);
  assert.equal(parseDuration('48h'), 48 * 3600_000);
  assert.equal(parseDuration('30d'), 30 * 86400_000);
});

test('parseDuration tolerates whitespace and returns 0 for bad input', () => {
  assert.equal(parseDuration('  30m  '), 30 * 60_000);
  assert.equal(parseDuration('bogus'), 0);
  assert.equal(parseDuration(''), 0);
  assert.equal(parseDuration(null), 0);
});

test('parseCadenceCycles parses "50cycles" / "1 cycle"', () => {
  assert.equal(parseCadenceCycles('50cycles'), 50);
  assert.equal(parseCadenceCycles('1 cycle'), 1);
  assert.equal(parseCadenceCycles('100 cycles'), 100);
});

test('parseCadenceCycles returns default 50 on bad input', () => {
  assert.equal(parseCadenceCycles('bogus'), 50);
  assert.equal(parseCadenceCycles(''), 50);
});
