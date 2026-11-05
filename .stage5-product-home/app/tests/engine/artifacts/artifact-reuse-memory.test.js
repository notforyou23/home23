// Governing rule (jtr, 2026-07-15): "something happened" -> event, worth
// keeping. "A loop ticked" -> not an event, no record. markConsumed() is
// called by agent-executor.js#enrichMissionWithArtifacts for every
// predecessor artifact attached to a spawned mission -- unconditionally,
// once per (artifact, downstream mission) pair, regardless of whether the
// downstream mission does anything with it. That is a loop ticking, not an
// event. The durable "who reused this" bookkeeping belongs on the artifact
// registry record (registry.markReused() / record.reusedBy) and must keep
// working; only the permanent `artifact_reuse` memory-graph node goes away.
//
// Harness style matches tests/engine/core/thought-persistence.test.js:
// minimal collaborator stubs, exercise the real instance method.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ArtifactLifecycle } = require('../../../engine/src/artifacts/artifact-lifecycle.js');

function makeRegistry(record) {
  const markReusedCalls = [];
  return {
    markReusedCalls,
    async markReused(artifactId, consumer) {
      markReusedCalls.push({ artifactId, consumer });
      record.reusedBy = [...(record.reusedBy || []), { agentId: consumer.agentId || null }];
      record.status = 'reused';
      return record;
    },
  };
}

function makeMemory() {
  const addedNodes = [];
  const addedEdges = [];
  return {
    addedNodes,
    addedEdges,
    async addNode(input) {
      addedNodes.push(input);
      return { id: `n${addedNodes.length}`, ...input };
    },
    addEdge(...args) {
      addedEdges.push(args);
    },
  };
}

test('markConsumed records reuse on the artifact registry without writing a memory node', async () => {
  const record = { id: 'art_1', memoryMirrorNodeId: 'n_mirror' };
  const registry = makeRegistry(record);
  const memory = makeMemory();
  const lifecycle = new ArtifactLifecycle({ registry, memory, logger: { warn() {} } });

  const result = await lifecycle.markConsumed('art_1', {
    agentId: 'agent_2',
    goalId: 'goal_9',
    reason: 'mission_predecessor_context',
  });

  // Registry-level bookkeeping still happens -- this is what downstream
  // code (tests/engine/artifacts/artifact-loop.test.js, ArtifactRegistry
  // consumers) actually reads.
  assert.equal(registry.markReusedCalls.length, 1);
  assert.equal(registry.markReusedCalls[0].artifactId, 'art_1');
  assert.equal(result.reusedBy.length, 1);
  assert.equal(result.status, 'reused');

  // No permanent artifact_reuse memory node or edge -- this is the
  // sediment being closed.
  assert.equal(memory.addedNodes.length, 0);
  assert.equal(memory.addedEdges.length, 0);
});

test('markConsumed returns null and never touches memory when the artifact does not exist', async () => {
  const registry = { markReusedCalls: [], async markReused() { return null; } };
  const memory = makeMemory();
  const lifecycle = new ArtifactLifecycle({ registry, memory, logger: { warn() {} } });

  const result = await lifecycle.markConsumed('missing', { agentId: 'agent_x' });

  assert.equal(result, null);
  assert.equal(memory.addedNodes.length, 0);
});
