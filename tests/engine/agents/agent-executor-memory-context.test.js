import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const engineExecutorModule = require('../../../engine/src/agents/agent-executor');
const cosmoExecutorModule = require('../../../cosmo23/engine/src/agents/agent-executor');
const { rewriteMemoryBase } = require('../../../shared/memory-source');
const {
  createMemoryDeltaOverlayCache,
} = require('../../../engine/src/dashboard/memory-delta-overlay-cache');

const implementations = [
  ['engine', engineExecutorModule],
  ['cosmo23', cosmoExecutorModule],
];

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

function executorConfig(logsDir) {
  return {
    logsDir,
    coordinator: { maxConcurrent: 2 },
    frontierGate: { enabled: false },
  };
}

function executorSubsystems(brainSourceContext) {
  return {
    memory: { embed: async () => null },
    goals: { archivedGoals: [], completedGoals: [] },
    pathResolver: null,
    ...(brainSourceContext ? { brainSourceContext } : {}),
  };
}

async function createResidentFixture() {
  const createdRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-executor-mcp-'));
  const home23Root = await fsp.realpath(createdRoot);
  const brainDir = path.join(home23Root, 'instances', 'jerry', 'brain');
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  await fsp.mkdir(brainDir, { recursive: true });
  await rewriteMemoryBase(brainDir, {
    nodes: [{
      id: 'executor-canary',
      concept: 'executor bridge route watermark',
      tag: 'canary',
      activation: 1,
      weight: 1,
      cluster: 'executor',
    }],
    edges: [],
    summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
  }, { lockRoot });
  return {
    home23Root,
    brainDir,
    async cleanup() {
      await fsp.rm(home23Root, { recursive: true, force: true });
    },
  };
}

async function inventory(root) {
  const entries = [];
  async function walk(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      entries.push(path.relative(root, absolute));
      if (entry.isDirectory()) await walk(absolute);
    }
  }
  await walk(root);
  return entries.sort();
}

for (const [name, module] of implementations) {
  test(`${name} AgentExecutor forwards its exact trusted resident source context`, async (t) => {
    const fixture = await createResidentFixture();
    t.after(fixture.cleanup);
    const brainSourceContext = module.createTrustedAgentBrainSourceContext({
      home23Root: fixture.home23Root,
      requesterAgent: 'jerry',
      brainDir: fixture.brainDir,
      sourceKind: 'resident',
    });
    const before = await inventory(fixture.brainDir);

    const executor = new module.AgentExecutor(
      executorSubsystems(brainSourceContext),
      executorConfig(fixture.brainDir),
      logger,
    );

    const trusted = executor.mcpBridge.memoryAdapter.trustedContext;
    assert.equal(trusted.home23Root, fixture.home23Root);
    assert.equal(trusted.requesterAgent, 'jerry');
    assert.equal(trusted.brainDir, fixture.brainDir);
    assert.equal(trusted.resolveTargetContext, brainSourceContext.resolveTargetContext);
    assert.equal(Object.isFrozen(trusted), true);

    const result = await executor.mcpBridge.query_memory('route watermark', 5);
    assert.equal(result.ok, true);
    assert.equal(result.totalNodes, 1);
    assert.equal(result.resultsFound, 1);
    assert.equal(result.results[0].id, 'executor-canary');
    const selected = await trusted.resolveTargetContext({});
    assert.equal(selected.accessMode, 'own');
    assert.equal(selected.target.ownerAgent, 'jerry');
    assert.equal(selected.target.canonicalRoot, fixture.brainDir);
    assert.deepEqual(await inventory(fixture.brainDir), before);

    const operationsRoot = path.join(
      fixture.home23Root,
      'instances',
      'jerry',
      'runtime',
      'brain-operations',
    );
    const operationEntries = await fsp.readdir(operationsRoot).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    assert.deepEqual(operationEntries, []);
  });

  test(`${name} AgentExecutor preserves construction compatibility but fails closed without context`, async (t) => {
    const fixture = await createResidentFixture();
    t.after(fixture.cleanup);
    const executor = new module.AgentExecutor(
      executorSubsystems(null),
      executorConfig(fixture.brainDir),
      logger,
    );

    const result = await executor.mcpBridge.query_memory('route watermark', 5);
    assert.equal(result.ok, false);
    assert.equal(result.totalNodes, null);
    assert.equal(result.resultsFound, null);
    assert.equal(result.evidence.sourceHealth, 'unavailable');
    assert.equal(result.error.code, 'mcp_source_context_required');
  });

  test(`${name} trusted context helper rejects cross-layout resident sources`, async (t) => {
    const fixture = await createResidentFixture();
    t.after(fixture.cleanup);
    const otherBrain = path.join(fixture.home23Root, 'instances', 'other', 'brain');
    await fsp.mkdir(otherBrain, { recursive: true });
    assert.throws(
      () => module.createTrustedAgentBrainSourceContext({
        home23Root: fixture.home23Root,
        requesterAgent: 'jerry',
        brainDir: otherBrain,
        sourceKind: 'resident',
      }),
      (error) => error.code === 'mcp_source_context_required',
    );
  });
}

test('COSMO AgentExecutor accepts only an explicitly owned local run context', async (t) => {
  const createdRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-executor-run-'));
  const home23Root = await fsp.realpath(createdRoot);
  t.after(() => fsp.rm(home23Root, { recursive: true, force: true }));
  const runDir = path.join(home23Root, 'cosmo23', 'runs', 'owned-run-1');
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  await fsp.mkdir(runDir, { recursive: true });
  await rewriteMemoryBase(runDir, {
    nodes: [{ id: 'owned-canary', concept: 'owned run canary', cluster: 'run' }],
    edges: [],
    summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
  }, { lockRoot });

  const context = cosmoExecutorModule.createTrustedAgentBrainSourceContext({
    home23Root,
    requesterAgent: 'jerry',
    brainDir: runDir,
    sourceKind: 'owned-run',
  });
  const resolved = await context.resolveTargetContext({});
  assert.equal(resolved.accessMode, 'owned-run');
  assert.equal(resolved.target.ownerAgent, 'jerry');
  assert.equal(resolved.target.canonicalRoot, runDir);

  const executor = new cosmoExecutorModule.AgentExecutor(
    executorSubsystems(context),
    executorConfig(runDir),
    logger,
  );
  const query = await executor.mcpBridge.query_memory('owned run', 5);
  assert.equal(query.ok, true);
  assert.equal(query.results[0].id, 'owned-canary');
});

test('engine AgentExecutor forwards the process-owned overlay provider into its MCP bridge', async (t) => {
  const fixture = await createResidentFixture();
  t.after(fixture.cleanup);
  const brainSourceContext = engineExecutorModule.createTrustedAgentBrainSourceContext({
    home23Root: fixture.home23Root,
    requesterAgent: 'jerry',
    brainDir: fixture.brainDir,
    sourceKind: 'resident',
  });
  const provider = createMemoryDeltaOverlayCache({
    cacheRoot: path.join(fixture.home23Root, 'instances', 'jerry', 'runtime', 'cache'),
  });
  let refreshes = 0;
  const observedProvider = {
    async refresh(input) {
      refreshes += 1;
      return provider.refresh(input);
    },
  };
  const executor = new engineExecutorModule.AgentExecutor({
    ...executorSubsystems(brainSourceContext),
    nodeOverlayProvider: observedProvider,
  }, executorConfig(fixture.brainDir), logger);

  const result = await executor.mcpBridge.query_memory('route watermark', 5);
  assert.equal(result.ok, true);
  assert.equal(refreshes, 1);
});

test('engine composition creates one requester-scoped overlay provider and injects it', async () => {
  const source = await fsp.readFile(
    path.join(process.cwd(), 'engine', 'src', 'index.js'),
    'utf8',
  );
  assert.match(source, /const resolvedNodeOverlayProvider = createMemoryDeltaOverlayCache\(\{/);
  assert.match(source, /'instances',\s*requesterAgent,\s*'runtime',\s*'cache'/);
  assert.match(source, /nodeOverlayProvider = resolvedNodeOverlayProvider/);
  assert.match(
    source,
    /new AgentExecutor\(\s*\{ memory, goals, pathResolver, brainSourceContext, nodeOverlayProvider \}/,
  );
});
