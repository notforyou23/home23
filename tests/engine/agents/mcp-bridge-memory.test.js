import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const { MCPBridge: EngineMCPBridge } = require('../../../engine/src/agents/mcp-bridge');
const { MCPBridge: CosmoMCPBridge } = require('../../../cosmo23/engine/src/agents/mcp-bridge');
const {
  appendMemoryRevision,
  rewriteMemoryBase,
} = require('../../../shared/memory-source');
const {
  MAX_STATE_COMPRESSED_BYTES,
} = require('../../../shared/memory-source/mcp-bridge-adapter.cjs');

const implementations = [
  ['engine', EngineMCPBridge],
  ['cosmo23', CosmoMCPBridge],
];

const logger = { warn() {}, debug() {}, error() {} };

async function createFixture({ withManifest = true } = {}) {
  const home23Root = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-mcp-bridge-'));
  const brainDir = path.join(home23Root, 'instances', 'jerry', 'brain');
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  await fsp.mkdir(brainDir, { recursive: true });
  await fsp.writeFile(path.join(brainDir, 'state.json.gz'), gzipSync(JSON.stringify({
    cycleCount: 7,
    currentMode: 'focus',
    cognitiveState: { energy: 0.8 },
    memory: { nodes: [], edges: [], clusters: [] },
    goals: { active: [{ id: 'g1' }], completed: [], archived: [] },
    journal: [{ entry: 'one' }],
    activeAgents: [{ id: 'worker-1' }],
  })));
  if (withManifest) {
    await rewriteMemoryBase(brainDir, {
      nodes: [
        { id: 'base', concept: 'base knowledge', tag: 'fact', activation: 0.4, weight: 0.6, cluster: 'c1' },
        { id: 'tombstone', concept: 'obsolete canary', tag: 'stale', activation: 0.9, weight: 0.9, cluster: 'c1' },
      ],
      edges: [{ source: 'base', target: 'tombstone', weight: 0.5 }],
      summary: { nodeCount: 2, edgeCount: 1, clusterCount: 1 },
    }, { lockRoot });
    await appendMemoryRevision(brainDir, {
      nodes: [{
        id: 'delta',
        concept: 'delta route watermark canary',
        tag: 'canary',
        activation: 1,
        weight: 1,
        cluster: 'c2',
      }],
      removedNodeIds: ['tombstone'],
    }, {
      lockRoot,
      summary: { nodeCount: 2, edgeCount: 0, clusterCount: 2 },
    });
  }
  const canonicalRoot = await fsp.realpath(brainDir);
  const brainSourceContext = Object.freeze({
    home23Root,
    requesterAgent: 'jerry',
    brainDir,
    async resolveTargetContext(selector) {
      assert.deepEqual(selector, {});
      return {
        catalogRevision: 'catalog-test-1',
        accessMode: 'own',
        target: {
          id: 'brain-jerry',
          ownerAgent: 'jerry',
          canonicalRoot,
          kind: 'resident',
          sourceType: 'memory-manifest',
        },
      };
    },
  });
  return {
    home23Root,
    brainDir,
    brainSourceContext,
    async cleanup() { await fsp.rm(home23Root, { recursive: true, force: true }); },
  };
}

for (const [name, Bridge] of implementations) {
  test(`${name} MCP bridge reads canonical base plus delta instead of the empty state shell`, async (t) => {
    const fixture = await createFixture();
    t.after(fixture.cleanup);
    const bridge = new Bridge(fixture.brainDir, logger, {
      brainSourceContext: fixture.brainSourceContext,
    });

    const query = await bridge.query_memory('route watermark canary', 5);
    assert.equal(query.ok, true);
    assert.equal(query.totalNodes, 2);
    assert.equal(query.resultsFound, 1);
    assert.equal(query.results[0].id, 'delta');
    assert.equal(query.results.some((row) => row.id === 'tombstone'), false);
    assert.equal(query.evidence.sourceHealth, 'healthy');
    assert.equal(query.evidence.deltaWatermark.appliedRecords, 2);
    assert.equal(query.evidence.identity.requesterAgent, 'jerry');
    assert.equal(query.evidence.identity.targetAgent, 'jerry');
    assert.equal(query.evidence.identity.brainId, 'brain-jerry');
    assert.equal(query.evidence.identity.catalogRevision, 'catalog-test-1');
    assert.equal(query.evidence.identity.kind, 'resident');
    assert.equal(query.evidence.identity.sourceType, 'memory-manifest');
    assert.equal(query.evidence.identity.accessMode, 'own');
    assert.match(query.evidence.identity.operationId, /^mcp-/);

    const statistics = await bridge.get_memory_statistics();
    assert.equal(statistics.ok, true);
    assert.equal(statistics.totalNodes, 2);
    assert.equal(statistics.totalEdges, 0);
    assert.equal(statistics.clusters, 2);
    assert.equal(statistics.evidence.authoritativeTotals.nodes, 2);
    if (statistics.breakdownsOmitted) {
      assert.equal(statistics.averageActivation, null);
      assert.equal(statistics.averageWeight, null);
    }

    const system = await bridge.get_system_state();
    assert.equal(system.stateAvailable, true);
    assert.equal(system.cycle, 7);
    assert.equal(system.memory.totalNodes, 2);
    assert.equal(system.memory.totalEdges, 0);
    assert.deepEqual(system.goals, { active: 1, completed: 0, archived: 0 });

    const graph = await bridge.get_memory_graph(1, { edgeLimit: 0 });
    assert.equal(graph.success, true);
    assert.equal(graph.nodes.length, 1);
    assert.equal(graph.edges.length, 0);
    assert.equal(graph.stats.totalNodes, 2);
    assert.equal(graph.stats.returnedNodes, 1);
    assert.equal(graph.evidence.limits.nodeLimit, 1);
    assert.equal(graph.evidence.limits.edgeLimit, 0);

    await assert.rejects(
      () => bridge.get_memory_graph(0),
      (error) => error.code === 'invalid_request' && error.field === 'nodeLimit',
    );
    await assert.rejects(
      () => bridge.get_memory_graph({ limit: 1, full: true }),
      (error) => error.code === 'result_too_large' && error.status === 413,
    );
  });

  test(`${name} MCP bridge reports unavailable source as unknown, never as zero`, async (t) => {
    const fixture = await createFixture({ withManifest: false });
    t.after(fixture.cleanup);
    const bridge = new Bridge(fixture.brainDir, logger, {
      brainSourceContext: fixture.brainSourceContext,
    });

    const query = await bridge.query_memory('anything', 5);
    assert.equal(query.ok, false);
    assert.equal(query.totalNodes, null);
    assert.equal(query.resultsFound, null);
    assert.equal(query.results, null);
    assert.equal(query.evidence.sourceHealth, 'unavailable');
    assert.equal(query.evidence.matchOutcome, 'unknown');
    assert.equal(query.evidence.identity.requesterAgent, 'jerry');
    assert.equal(query.evidence.identity.brainId, 'brain-jerry');
    assert.equal(query.evidence.identity.accessMode, 'own');

    const statistics = await bridge.get_memory_statistics();
    assert.equal(statistics.ok, false);
    assert.equal(statistics.totalNodes, null);
    assert.equal(statistics.totalEdges, null);
    assert.equal(statistics.clusters, null);

    const graph = await bridge.get_memory_graph(10);
    assert.equal(graph.success, false);
    assert.equal(graph.nodes, null);
    assert.equal(graph.edges, null);
    assert.equal(graph.stats.totalNodes, null);

    const system = await bridge.get_system_state();
    assert.equal(system.stateAvailable, true);
    assert.equal(system.memory.ok, false);
    assert.equal(system.memory.totalNodes, null);
    assert.equal(system.memory.evidence.matchOutcome, 'unknown');
  });

  test(`${name} MCP bridge forwards cancellation and supported tag filters exactly`, async (t) => {
    const fixture = await createFixture({ withManifest: false });
    t.after(fixture.cleanup);
    const reason = Object.assign(new Error('cancelled by operation'), {
      name: 'AbortError',
      code: 'cancelled',
    });
    const controller = new AbortController();
    let observed = null;
    const memoryTools = {
      async queryMemory(request) {
        observed = request;
        if (request.signal?.aborted) throw request.signal.reason;
        return { ok: true, query: request.query, resultsFound: 0, totalNodes: 1, results: [], evidence: {} };
      },
      async getMemoryStatistics() {
        return { ok: true, totalNodes: 1, totalEdges: 0, clusters: 0, evidence: {} };
      },
      async getMemoryGraph() {
        return { success: true, nodes: [], edges: [], clusters: {}, meta: {}, evidence: {} };
      },
    };
    const bridge = new Bridge(fixture.brainDir, logger, { memoryTools });

    await bridge.query_memory('tagged', 3, { tag: 'fact' });
    assert.equal(observed.query, 'tagged');
    assert.equal(observed.limit, 3);
    assert.equal(observed.tag, 'fact');

    controller.abort(reason);
    await assert.rejects(
      () => bridge.query_memory('cancel', 2, { signal: controller.signal }),
      (error) => error === reason,
    );
    assert.equal(observed.signal, controller.signal);

    await assert.rejects(
      () => bridge.get_memory_statistics({ identity: { requesterAgent: 'spoofed' } }),
      (error) => error.code === 'invalid_request',
    );
  });
}

test('COSMO MCP bridge preserves the legacy positional ClusterStateStore constructor', async (t) => {
  const fixture = await createFixture({ withManifest: false });
  t.after(fixture.cleanup);
  const clusterStateStore = { getPlan() {}, getTask() {} };
  const bridge = new CosmoMCPBridge(fixture.brainDir, logger, clusterStateStore);
  assert.equal(bridge.clusterStateStore, clusterStateStore);
  const result = await bridge.query_memory('anything');
  assert.equal(result.ok, false);
  assert.equal(result.totalNodes, null);
  assert.equal(result.error.code, 'mcp_source_context_required');
});

test('supplied brain source context must select the bridge logs directory', async (t) => {
  const fixture = await createFixture({ withManifest: false });
  t.after(fixture.cleanup);
  assert.throws(
    () => new EngineMCPBridge(fixture.brainDir, logger, {
      brainSourceContext: {
        ...fixture.brainSourceContext,
        brainDir: path.join(fixture.home23Root, 'different-brain'),
      },
    }),
    (error) => error.code === 'mcp_source_context_required',
  );
});

test('system state parsing fails bounded while canonical memory truth remains available', async (t) => {
  const fixture = await createFixture({ withManifest: false });
  t.after(fixture.cleanup);
  const handle = await fsp.open(path.join(fixture.brainDir, 'state.json.gz'), 'w');
  await handle.truncate(MAX_STATE_COMPRESSED_BYTES + 1);
  await handle.close();
  const bridge = new EngineMCPBridge(fixture.brainDir, logger, {
    memoryTools: {
      async getMemoryStatistics() {
        return {
          ok: true,
          totalNodes: 9,
          totalEdges: 4,
          clusters: 2,
          nodesByTag: null,
          breakdownsOmitted: true,
          evidence: { sourceHealth: 'healthy', matchOutcome: 'matches' },
        };
      },
    },
  });
  const system = await bridge.get_system_state();
  assert.equal(system.stateAvailable, false);
  assert.equal(system.cycle, null);
  assert.equal(system.memory.totalNodes, 9);
  assert.equal(system.memory.totalEdges, 4);
  assert.equal(system.memory.evidence.sourceHealth, 'healthy');
});

for (const [name, Bridge] of implementations) {
  test(`${name} MCP thought and dream reads use a bounded reverse tail`, async (t) => {
    const fixture = await createFixture({ withManifest: false });
    t.after(fixture.cleanup);
    const largeDiscardedPrefix = Buffer.alloc(9 * 1024 * 1024, 0x78);
    await fsp.writeFile(path.join(fixture.brainDir, 'thoughts.jsonl'), Buffer.concat([
      largeDiscardedPrefix,
      Buffer.from('\n'),
      Buffer.from(`${JSON.stringify({ id: 'recent-1', text: 'recent' })}\n`),
      Buffer.from(`${JSON.stringify({ id: 'dream-1', role: 'dreamer', text: 'dream' })}\n`),
    ]));
    const bridge = new Bridge(fixture.brainDir, logger, {
      brainSourceContext: fixture.brainSourceContext,
    });
    const thoughts = await bridge.get_recent_thoughts(2);
    assert.equal(thoughts.count, 2);
    assert.deepEqual(thoughts.thoughts.map((entry) => entry.id), ['dream-1', 'recent-1']);
    const dreams = await bridge.get_dreams(5);
    assert.equal(dreams.count, 1);
    assert.equal(dreams.dreams[0].id, 'dream-1');
    assert.equal(dreams.coverage, 'bounded-recent-tail');
    assert.equal(dreams.scannedRecentThoughts, 2);
  });
}
