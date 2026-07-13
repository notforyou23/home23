const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('legacy Query and PGS execution never select a literal fallback model', () => {
  const query = source('cosmo23/lib/query-engine.js');
  const pgs = source('cosmo23/lib/pgs-engine.js');

  assert.doesNotMatch(query, /model:\s*requestedModel\s*=\s*['"][^'"]+['"]/);
  assert.doesNotMatch(query, /\bmodel\s*=\s*['"][^'"]+['"]\s*,/);
  assert.doesNotMatch(pgs, /\bmodel\s*=\s*['"][^'"]+['"]\s*,/);
});
