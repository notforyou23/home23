'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');

function readJson(...parts) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, ...parts), 'utf8'));
}

test('standalone Cosmo owns one Node-floor-compatible Undici transport', async (t) => {
  const cosmoPackage = readJson('package.json');
  const cosmoLock = readJson('package-lock.json');
  const installed = readJson('node_modules', 'undici', 'package.json');

  assert.equal(cosmoPackage.dependencies.undici, '6.21.3');
  assert.equal(cosmoLock.packages[''].dependencies.undici, '6.21.3');
  assert.equal(cosmoLock.packages['node_modules/undici'].version, '6.21.3');
  assert.equal(installed.version, '6.21.3');
  assert.equal(installed.engines.node, '>=18.17');
  assert.equal(cosmoPackage.engines.node, '>=18.17.0');

  const { Agent } = require('undici');
  const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  t.after(() => dispatcher.close());
  assert.equal(typeof dispatcher.dispatch, 'function');
});
