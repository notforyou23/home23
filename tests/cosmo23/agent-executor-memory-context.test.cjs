'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  AgentExecutor,
  createTrustedAgentBrainSourceContext,
} = require('../../cosmo23/engine/src/agents/agent-executor');

const logger = { info() {}, warn() {}, error() {}, debug() {} };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-cosmo-executor-context-'));
  const home23Root = await fs.realpath(root);
  t.after(() => fs.rm(home23Root, { recursive: true, force: true }));
  const brainDir = path.join(home23Root, 'instances', 'jerry', 'brain');
  await fs.mkdir(brainDir, { recursive: true });
  return { home23Root, brainDir };
}

test('COSMO AgentExecutor retains the exact explicit resident source context', async (t) => {
  const fx = await fixture(t);
  const context = createTrustedAgentBrainSourceContext({
    home23Root: fx.home23Root,
    requesterAgent: 'jerry',
    brainDir: fx.brainDir,
    sourceKind: 'resident',
  });
  const executor = new AgentExecutor({
    memory: { embed: async () => null },
    goals: { archivedGoals: [], completedGoals: [] },
    pathResolver: null,
    brainSourceContext: context,
  }, {
    logsDir: fx.brainDir,
    coordinator: { maxConcurrent: 1 },
    frontierGate: { enabled: false },
  }, logger);
  assert.equal(executor.mcpBridge.memoryAdapter.trustedContext.home23Root, context.home23Root);
  assert.equal(executor.mcpBridge.memoryAdapter.trustedContext.requesterAgent, 'jerry');
  assert.equal(executor.mcpBridge.memoryAdapter.trustedContext.brainDir, context.brainDir);
  assert.equal(
    executor.mcpBridge.memoryAdapter.trustedContext.resolveTargetContext,
    context.resolveTargetContext,
  );
  const resolved = await context.resolveTargetContext({});
  assert.equal(resolved.accessMode, 'own');
  assert.equal(resolved.target.ownerAgent, 'jerry');
  assert.equal(resolved.target.canonicalRoot, fx.brainDir);
});

test('COSMO context helper rejects implicit, cross-agent, and selector-derived identity', async (t) => {
  const fx = await fixture(t);
  const other = path.join(fx.home23Root, 'instances', 'cosmo', 'brain');
  await fs.mkdir(other, { recursive: true });
  assert.throws(() => createTrustedAgentBrainSourceContext({
    home23Root: fx.home23Root,
    requesterAgent: 'jerry',
    brainDir: other,
    sourceKind: 'resident',
  }), { code: 'mcp_source_context_required' });
  const context = createTrustedAgentBrainSourceContext({
    home23Root: fx.home23Root,
    requesterAgent: 'jerry',
    brainDir: fx.brainDir,
    sourceKind: 'resident',
  });
  await assert.rejects(context.resolveTargetContext({ brainId: 'other' }), {
    code: 'invalid_request',
  });
});
