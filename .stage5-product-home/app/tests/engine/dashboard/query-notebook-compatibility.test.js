import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  levelForFraction,
  normalizeNotebookRecordForProjection,
} = require('../../../engine/src/dashboard/query-notebook-compatibility.js');

test('legacy sweep fractions map only exact modern levels', () => {
  assert.equal(levelForFraction(0.10), 'skim');
  assert.equal(levelForFraction(0.25), 'sample');
  assert.equal(levelForFraction(0.50), 'deep');
  assert.equal(levelForFraction(1.0), 'full');
  assert.equal(levelForFraction(0.001), null);
  assert.equal(levelForFraction(0.249999), null);
});

test('missing legacy PGS mode becomes read-only fresh configuration', () => {
  const source = {
    operationType: 'pgs',
    requestParameters: {
      query: 'legacy sample',
      pgsConfig: { sweepFraction: 0.25 },
    },
    notebookResultSummary: null,
  };
  const normalized = normalizeNotebookRecordForProjection(source);
  assert.equal(normalized.record.requestParameters.pgsMode, 'fresh');
  assert.equal(normalized.record.requestParameters.pgsLevel, 'sample');
  assert.equal(normalized.legacyConfiguration, true);
  assert.equal(Object.hasOwn(source.requestParameters, 'pgsMode'), false);
  assert.equal(Object.hasOwn(source.requestParameters, 'pgsLevel'), false);
});
