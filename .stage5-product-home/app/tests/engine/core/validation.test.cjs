const assert = require('node:assert/strict');
const test = require('node:test');

const { validateAndClean } = require('../../../engine/src/core/validation');

test('validateAndClean allows operational timeout discussion', () => {
  const result = validateAndClean(
    'No new timeout warning appeared in the last Forrest cycle after the routing fix.'
  );

  assert.equal(result.valid, true);
});

test('validateAndClean still rejects raw timeout error artifacts', () => {
  const result = validateAndClean('request timeout after 30000ms while fetching model output');

  assert.equal(result.valid, false);
  assert.match(result.reason, /timeout/i);
});
