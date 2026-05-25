import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { verifyArtifactLoop } = require('../../../engine/src/artifacts/artifact-loop-verifier.js');
const { ArtifactRegistry } = require('../../../engine/src/artifacts/artifact-registry.js');
const { Capabilities } = require('../../../engine/src/core/capabilities.js');

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

test('ArtifactRegistry emits agency receipts when artifact-producing organs register verified pursuit-bound files', async () => {
  const logsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-artifact-register-agency-'));
  const outputDir = path.join(logsDir, 'outputs', 'capabilities');
  await fs.mkdir(outputDir, { recursive: true });
  const artifactPath = path.join(outputDir, 'bounded-change.md');
  await fs.writeFile(artifactPath, 'Verifier-backed bounded change.', 'utf8');
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
      kind: 'capability_output',
      status: 'committed',
      producer: 'capabilities',
      pursuitId: 'ap_capability',
      agency: {
        desiredChangedFuture: 'Capability output proves the resident pursuit changed local state.',
      },
      verifierStatus: 'pass',
      verifierRef: 'capability-verifier:1',
      changedFuture: 'Capability artifact verifier passed at registration time.',
    });

    assert.equal(packets.length, 1);
    assert.equal(artifact.metadata.agency.pursuitId, 'ap_capability');
    assert.equal(artifact.metadata.agency.verifierStatus, 'pass');
    assert.equal(packets[0].source, 'artifacts.registry');
    assert.equal(packets[0].kind, 'artifact_verifier_receipt');
    assert.equal(packets[0].pursuitId, 'ap_capability');
    assert.equal(packets[0].consequenceStatus, 'closed');
    assert.match(packets[0].summary, /artifact_registered/);
    assert.equal(packets[0].evidence.some(item => item.type === 'verifier_receipt' && item.ref === 'capability-verifier:1'), true);
  } finally {
    await fs.rm(logsDir, { recursive: true, force: true });
  }
});

test('Capabilities forwards resident pursuit verifier metadata to the artifact registry', async () => {
  const calls = [];
  const capabilities = Object.create(Capabilities.prototype);
  capabilities.artifactRegistry = {
    async registerFile(input) {
      calls.push(input);
      return { id: 'art_capability' };
    },
  };
  capabilities.logger = { warn() {} };

  const record = await capabilities.registerWrittenArtifact('/tmp/home23-capability.md', 'verified body output', {
    artifactKind: 'capability_output',
    artifactStatus: 'committed',
    agentId: 'jerry',
    agentType: 'operator',
    goalId: 'goal_step28',
    taskId: 'task_artifact_binding',
    agency: {
      pursuitId: 'ap_capability',
      desiredChangedFuture: 'Capability write closes the resident pursuit.',
    },
    artifactVerifierStatus: 'pass',
    artifactVerifierRef: 'capability-write:verifier',
    artifactChangedFuture: 'Capability write produced a verifier-backed artifact.',
  });

  assert.equal(record.id, 'art_capability');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].producer, 'capabilities');
  assert.equal(calls[0].agency.pursuitId, 'ap_capability');
  assert.equal(calls[0].agency.verifierStatus, 'pass');
  assert.equal(calls[0].agency.verifierRef, 'capability-write:verifier');
  assert.equal(calls[0].agency.changedFuture, 'Capability write produced a verifier-backed artifact.');
});
