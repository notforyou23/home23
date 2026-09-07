const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
test('Cosmo registers its product and security regression suites', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /tests\/cosmo23\/\*\.test\.cjs/);
  assert.match(pkg.scripts.test, /tests\/security\/\*\.test\.cjs/);
});
