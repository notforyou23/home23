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
    'tests/cosmo23/brain-snapshot-guard.test.cjs',
    'tests/cosmo23/bounded-json.test.cjs',
    'tests/cosmo23/ingestion-pending-jsonl.test.cjs',
    'tests/cosmo23/ingestion-pending-queue-pin.test.cjs',
    'tests/cosmo23/latent-dataset-streamed-count.test.cjs',
    'tests/cosmo23/cluster-aware-memory-persistence.test.cjs',
    'tests/cosmo23/cluster-snapshot-merger-parity.test.cjs',
    'tests/cosmo23/crash-recovery-scalar-checkpoints.test.cjs',
    'tests/cosmo23/cycle-watchdog.test.cjs',
    'tests/cosmo23/codex-responses-client.test.cjs',
    'tests/cosmo23/cross-brain-readonly.test.cjs',
    'tests/cosmo23/graceful-shutdown-honesty.test.cjs',
    'tests/cosmo23/resource-backpressure.test.cjs',
    'tests/cosmo23/engine-heartbeat.test.cjs',
    'tests/cosmo23/legacy-query-operation-adapter.test.cjs',
    'tests/cosmo23/managed-query-defaults.test.cjs',
    'tests/cosmo23/public-query-exact-pair.test.cjs',
    'tests/cosmo23/mcp-http-loopback.test.cjs',
    'tests/cosmo23/mcp-memory-tools.test.cjs',
    'tests/cosmo23/network-memory-embedding-batch.test.cjs',
    'tests/cosmo23/node-intake-gate.test.cjs',
    'tests/cosmo23/memory-gc-governor.test.cjs',
    'tests/cosmo23/research-memory-delta-compaction.test.cjs',
    'tests/cosmo23/community-detection.test.cjs',
    'tests/cosmo23/spend-meter.test.cjs',
    'tests/cosmo23/progress-lane-starvation.test.cjs',
    'tests/cosmo23/run-vitals-governance.test.cjs',
    'tests/cosmo23/sleep-policy.test.cjs',
    'tests/cosmo23/pgs-cancellation.test.cjs',
    'tests/cosmo23/brain-backups.test.cjs',
    'tests/cosmo23/pgs-engine.test.cjs',
    'tests/cosmo23/pgs-retry-state.test.cjs',
    'tests/cosmo23/pgs-source-pin.test.cjs',
    'tests/cosmo23/pinned-pgs-store.test.cjs',
    'tests/cosmo23/pinned-query-projection.test.cjs',
    'tests/cosmo23/provider-input-boundaries.test.cjs',
    'tests/cosmo23/provider-record-sanitizer.test.cjs',
    'tests/cosmo23/query-engine-provider-ownership.test.cjs',
    'tests/cosmo23/query-engine-mutation-boundary.test.cjs',
    'tests/cosmo23/query-pgs-no-hardcoded-selection.test.cjs',
    'tests/cosmo23/query-engine-runtime.test.cjs',
    'tests/cosmo23/query-engine-source-pin.test.cjs',
    'tests/cosmo23/query-operation-worker.test.cjs',
    'tests/cosmo23/research-memory-manifest.test.cjs',
    'tests/cosmo23/memory-sidecar-streamed-capture.test.cjs',
    'tests/cosmo23/run-sentinel.test.cjs',
    'tests/cosmo23/operator-intents.test.cjs',
    'tests/cosmo23/state-hydration.test.cjs',
    'tests/cosmo23/runtime-dependency-compatibility.test.cjs',
    'tests/cosmo23/state-compression-atomicity.test.cjs',
    'tests/cosmo23/event-ledger-hygiene.test.cjs',
    'tests/cosmo23/package-test-registration.test.cjs',
    'tests/security/child-process-env.test.ts',
    'tests/security/cosmo-child-process-env.test.cjs',
    'tests/security/cosmo-data-acquisition-boundary.test.cjs',
    'tests/security/engine-child-process-env.test.cjs',
    'tests/shared/ann-label-contract.test.cjs',
    'tests/shared/memory-authority-attestation.test.cjs',
    'tests/shared/memory-authority.test.cjs',
    'tests/shared/memory-source-contracts.test.js',
    'tests/shared/memory-source-reader.test.js',
    'tests/shared/memory-source-pin.test.js',
    'tests/shared/memory-source-scratch-quota.test.js',
  ]) {
    assert.equal(command.split(file).length - 1, 1, `${file} registration count`);
  }
});
