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
    'tests/cosmo23/brain-operation-runtime.test.cjs',
    'tests/cosmo23/brain-operation-worker.test.cjs',
    'tests/cosmo23/bounded-json.test.cjs',
    'tests/cosmo23/cluster-aware-memory-persistence.test.cjs',
    'tests/cosmo23/cluster-snapshot-merger-parity.test.cjs',
    'tests/cosmo23/codex-responses-client.test.cjs',
    'tests/cosmo23/cross-brain-readonly.test.cjs',
    'tests/cosmo23/legacy-query-operation-adapter.test.cjs',
    'tests/cosmo23/mcp-http-loopback.test.cjs',
    'tests/cosmo23/mcp-memory-tools.test.cjs',
    'tests/cosmo23/network-memory-embedding-batch.test.cjs',
    'tests/cosmo23/pgs-cancellation.test.cjs',
    'tests/cosmo23/pgs-retry-state.test.cjs',
    'tests/cosmo23/pgs-source-pin.test.cjs',
    'tests/cosmo23/pinned-pgs-store.test.cjs',
    'tests/cosmo23/pinned-query-projection.test.cjs',
    'tests/cosmo23/provider-input-boundaries.test.cjs',
    'tests/cosmo23/query-engine-provider-ownership.test.cjs',
    'tests/cosmo23/query-engine-mutation-boundary.test.cjs',
    'tests/cosmo23/query-engine-runtime.test.cjs',
    'tests/cosmo23/query-engine-source-pin.test.cjs',
    'tests/cosmo23/research-memory-manifest.test.cjs',
    'tests/cosmo23/package-test-registration.test.cjs',
    'tests/shared/memory-source-pin.test.js',
    'tests/shared/memory-source-scratch-quota.test.js',
  ]) {
    assert.equal(command.split(file).length - 1, 1, `${file} registration count`);
  }
});
