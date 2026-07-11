'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('default package test authority registers each new lightweight COSMO suite exactly once', () => {
  const packageJson = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../package.json'),
    'utf8',
  ));
  const command = packageJson?.scripts?.test;
  assert.equal(typeof command, 'string');
  for (const file of [
    'tests/cosmo23/bounded-json.test.cjs',
    'tests/cosmo23/cross-brain-readonly.test.cjs',
    'tests/cosmo23/legacy-query-operation-adapter.test.cjs',
    'tests/cosmo23/mcp-http-loopback.test.cjs',
    'tests/cosmo23/mcp-memory-tools.test.cjs',
    'tests/cosmo23/pgs-cancellation.test.cjs',
    'tests/cosmo23/pgs-retry-state.test.cjs',
    'tests/cosmo23/query-engine-provider-ownership.test.cjs',
    'tests/cosmo23/query-engine-mutation-boundary.test.cjs',
    'tests/cosmo23/research-memory-manifest.test.cjs',
    'tests/cosmo23/package-test-registration.test.cjs',
  ]) {
    assert.equal(command.split(file).length - 1, 1, `${file} registration count`);
  }
});
