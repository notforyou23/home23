import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { verifyArtifactLoop } = require('../../../engine/src/artifacts/artifact-loop-verifier.js');
const { ArtifactRegistry } = require('../../../engine/src/artifacts/artifact-registry.js');

test('Home23 artifact loop registers files, reuse, committed outputs, and memory promotions', async () => {
  const result = await verifyArtifactLoop();
  try {
    assert.equal(result.status, 'pass');
    assert.equal(result.audit.status, 'pass');
    assert.ok(result.audit.registered >= 3);
    assert.ok(result.audit.memoryArtifacts >= 1);
    assert.ok(result.audit.committed >= 1);
    assert.ok(result.memoryNodes >= 3);
    assert.ok(result.memoryEdges >= 1);
    const raw = JSON.parse(await fs.readFile(result.registryPath, 'utf8'));
    assert.equal(raw.schema, 'home23.artifacts.v1');
    assert.ok(raw.records.some(r => r.id === result.sourceArtifactId && r.reusedBy.length === 1));
    assert.ok(raw.records.some(r => r.id === result.derivedArtifactId && r.status === 'committed'));
  } finally {
    await fs.rm(result.logsDir, { recursive: true, force: true });
  }
});

test('ArtifactRegistry can select reusable goal/task artifacts', async () => {
  const result = await verifyArtifactLoop();
  try {
    const registry = new ArtifactRegistry({ logsDir: result.logsDir });
    await registry.initialize();
    assert.equal(registry.find({ goalId: 'goal_artifact_loop' }).length >= 2, true);
    assert.equal(registry.find({ taskId: 'task_source' }).length, 1);
  } finally {
    await fs.rm(result.logsDir, { recursive: true, force: true });
  }
});

test('ArtifactRegistry emits agency closure receipts for verifier-passed committed artifacts', async () => {
  const logsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-artifact-agency-'));
  const outputDir = path.join(logsDir, 'outputs', 'agency');
  await fs.mkdir(outputDir, { recursive: true });
  const artifactPath = path.join(outputDir, 'receipt.md');
  await fs.writeFile(artifactPath, 'Verified artifact consequence.', 'utf8');
  const packets = [];
  const registry = new ArtifactRegistry({
    logsDir,
    agencyKernel: {
      async intakeWorldStream(packet) {
        packets.push(packet);
        return { decision: { route: packet.consequenceStatus === 'closed' ? 'close' : 'attach' } };
      },
    },
  });
  await registry.initialize();

  try {
    const artifact = await registry.registerFile({
      path: artifactPath,
      kind: 'agency_receipt',
      metadata: {
        agency: {
          pursuitId: 'ap_artifact',
          desiredChangedFuture: 'Artifact verifier proves the pursuit changed future behavior.',
        },
      },
    });

    await registry.promote(artifact.id, 'committed', {
      verifierStatus: 'pass',
      changedFuture: 'Artifact verifier passed and committed the durable receipt.',
    });

    assert.equal(packets.length, 1);
    assert.equal(packets[0].source, 'artifacts.registry');
    assert.equal(packets[0].kind, 'artifact_verifier_receipt');
    assert.equal(packets[0].pursuitId, 'ap_artifact');
    assert.equal(packets[0].consequenceStatus, 'closed');
    assert.match(packets[0].changedFuture, /committed the durable receipt/);
    assert.deepEqual(packets[0].evidence[0].type, 'artifact');
  } finally {
    await fs.rm(logsDir, { recursive: true, force: true });
  }
});
