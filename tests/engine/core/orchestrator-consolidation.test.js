import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Orchestrator } = require('../../../engine/src/core/orchestrator.js');
const { Orchestrator: CosmoOrchestrator } = require('../../../cosmo23/engine/src/core/orchestrator.js');
const { MemorySummarizer } = require('../../../engine/src/memory/summarizer.js');
const { MemorySummarizer: CosmoMemorySummarizer } = require('../../../cosmo23/engine/src/memory/summarizer.js');

function makeLogger() {
  const entries = [];
  return {
    entries,
    info(message, data) { entries.push({ level: 'info', message, data }); },
    warn(message, data) { entries.push({ level: 'warn', message, data }); },
    error(message, data) { entries.push({ level: 'error', message, data }); },
    debug(message, data) { entries.push({ level: 'debug', message, data }); },
  };
}

function consolidation(id) {
  return {
    consolidated: `Durable consolidated memory ${id} with enough semantic detail`,
    reasoning: null,
    sourceNodes: [`source-${id}`],
    model: 'test-model',
    compost: { mode: 'ready', sourceNodes: [`source-${id}`] },
  };
}

function exactConsolidation(sources) {
  const candidate = {
    consolidated: 'Durable exact-identity consolidated memory with enough semantic detail',
    reasoning: null,
    sourceNodes: sources.map((node) => node.id),
    model: 'test-model',
    compost: { mode: 'ready', sourceNodes: sources.map((node) => node.id) },
  };
  Object.defineProperty(candidate, 'sourceIdentityTokens', {
    enumerable: false,
    value: new Map(sources.map((node) => [node.id, node])),
  });
  Object.defineProperty(candidate, 'consolidationTimestamp', {
    enumerable: false,
    value: '2026-07-11T12:00:00.000Z',
  });
  return candidate;
}

function publicationMemory(sources, events) {
  const nodes = new Map(sources.map((node) => [node.id, node]));
  return {
    nodes,
    async addNode(content, tag) {
      events.push('summary:add');
      const summary = { id: 'stored-summary', concept: content, tag, metadata: {} };
      nodes.set(summary.id, summary);
      return summary;
    },
    patchNodes(entries) {
      events.push('sources:commit');
      const updated = [];
      for (const entry of entries) {
        const stored = nodes.get(entry.nodeId);
        if (!stored || stored !== entry.expectedNode) continue;
        Object.assign(stored, entry.patch);
        updated.push(stored);
      }
      return { updated: updated.length, nodes: updated };
    },
    patchNode(nodeId, patch, options = {}) {
      events.push('summary:patch');
      const stored = nodes.get(nodeId);
      if (!stored || (options.expectedNode && stored !== options.expectedNode)) return null;
      Object.assign(stored, patch);
      return stored;
    },
    removeNodes(nodeIds) {
      events.push('sources:remove');
      let removedNodes = 0;
      for (const nodeId of nodeIds) {
        if (nodes.delete(nodeId)) removedNodes += 1;
      }
      return { removedNodes, removedEdges: 0 };
    },
  };
}

for (const mode of ['off', 'dry-run', 'apply']) {
  test(`root consolidation commits source markers after stored summary creation in ${mode} mode`, async () => {
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
    const events = [];
    const sources = ['source-a', 'source-b', 'source-c'].map((id) => ({
      id,
      concept: `durable ${id}`,
    }));
    const memory = publicationMemory(sources, events);
    const orchestrator = Object.create(Orchestrator.prototype);
    Object.assign(orchestrator, {
      logger: makeLogger(),
      memory,
      summarizer: new MemorySummarizer({}, makeLogger(), {}),
    });

    const publication = await orchestrator._publishConsolidationSummary(
      exactConsolidation(sources),
      '[CONSOLIDATED] durable exact-identity consolidated memory',
      {
        mode,
        confirmedDryRunAt: mode === 'apply' ? '2026-07-11T11:00:00.000Z' : null,
      },
    );

    assert.equal(publication.published, true);
    assert.equal(publication.mode, mode);
    assert.deepEqual(events.slice(0, 2), ['summary:add', 'sources:commit']);
    if (mode === 'apply') {
      assert.ok(sources.every((node) => !memory.nodes.has(node.id)));
    } else {
      assert.ok(sources.every((node) => (
        typeof memory.nodes.get(node.id).consolidatedAt === 'string'
        && Number.isFinite(Date.parse(memory.nodes.get(node.id).consolidatedAt))
      )));
    }
  });
}

for (const implementation of [
  { name: 'root', Orchestrator, MemorySummarizer },
  { name: 'COSMO', Orchestrator: CosmoOrchestrator, MemorySummarizer: CosmoMemorySummarizer },
]) {
  test(`${implementation.name} consolidation replacement race leaves all current sources unmarked`, async () => {
    const logger = makeLogger();
    const sources = ['source-a', 'source-b', 'source-c'].map((id) => ({
      id,
      concept: `durable ${id}`,
    }));
    const replacement = { id: sources[0].id, concept: 'replacement during summary embedding' };
    const events = [];
    const memory = publicationMemory(sources, events);
    const originalAddNode = memory.addNode;
    memory.addNode = async (...args) => {
      const summary = await originalAddNode(...args);
      memory.nodes.set(replacement.id, replacement);
      return summary;
    };
    const orchestrator = Object.create(implementation.Orchestrator.prototype);
    Object.assign(orchestrator, {
      logger,
      memory,
      summarizer: new implementation.MemorySummarizer({}, logger, {}),
    });

    const publication = implementation.name === 'root'
      ? await orchestrator._publishConsolidationSummary(
        exactConsolidation(sources),
        '[CONSOLIDATED] replacement-race summary',
        { mode: 'off', confirmedDryRunAt: null },
      )
      : await orchestrator._publishConsolidationSummary(
        exactConsolidation(sources),
        '[CONSOLIDATED] replacement-race summary',
      );

    assert.equal(publication.published, false);
    assert.equal(publication.reason, 'source_identity_changed');
    assert.equal(publication.summaryNodeId, 'stored-summary');
    assert.equal(memory.nodes.get(replacement.id), replacement);
    assert.equal(replacement.consolidatedAt, undefined);
    assert.ok(sources.slice(1).every((node) => node.consolidatedAt === undefined));
    assert.equal(events.includes('sources:commit'), false);
  });
}

for (const implementation of [
  { name: 'root', Orchestrator },
  { name: 'COSMO', Orchestrator: CosmoOrchestrator },
]) {
  test(`${implementation.name} consolidation catches summary creation errors before marker commit`, async () => {
    const logger = makeLogger();
    let markerCommitCalls = 0;
    const orchestrator = Object.create(implementation.Orchestrator.prototype);
    Object.assign(orchestrator, {
      logger,
      memory: {
        async addNode() { throw new Error('controlled_summary_failure'); },
      },
      summarizer: {
        commitConsolidationSources() {
          markerCommitCalls += 1;
          return { committed: true };
        },
        finalizeConsolidationCompost() {
          throw new Error('finalization_must_not_run');
        },
      },
    });

    const publication = implementation.name === 'root'
      ? await orchestrator._publishConsolidationSummary(
        consolidation('throw'),
        '[CONSOLIDATED] controlled throw',
        { mode: 'off', confirmedDryRunAt: null },
      )
      : await orchestrator._publishConsolidationSummary(
        consolidation('throw'),
        '[CONSOLIDATED] controlled throw',
      );

    assert.equal(publication.published, false);
    assert.equal(publication.reason, 'summary_node_creation_failed');
    assert.equal(markerCommitCalls, 0);
  });
}

test('performMemoryConsolidation excludes failed summary creation and partial finalization from success counts', async () => {
  const logger = makeLogger();
  const consolidations = [consolidation('missing'), consolidation('partial'), consolidation('accepted')];
  const createdNodes = [null, { id: 'summary-partial' }, { id: 'summary-accepted' }];
  const finalizationCalls = [];
  const orchestrator = Object.create(Orchestrator.prototype);
  Object.assign(orchestrator, {
    logger,
    memory: {
      async addNode() { return createdNodes.shift(); },
    },
    summarizer: {
      async consolidateMemories() { return consolidations; },
      commitConsolidationSources() {
        return { committed: true, mode: 'apply', updatedSourceNodes: 1, skippedSourceNodes: 0 };
      },
      finalizeConsolidationCompost(_memory, cons, options) {
        finalizationCalls.push({ cons, options });
        if (options.summaryNodeId === 'summary-partial') {
          return { mode: 'partial', reason: 'source_identity_changed', removedSourceNodes: 0, skippedSourceNodes: 1 };
        }
        return { mode: 'apply', removedSourceNodes: 1, skippedSourceNodes: 0 };
      },
    },
    getMemoryCompostOptions() {
      return { mode: 'apply', confirmedDryRunAt: '2026-07-11T00:00:00.000Z' };
    },
  });

  const result = await orchestrator.performMemoryConsolidation();

  assert.deepEqual(result, { created: 1, skipped: 2 });
  assert.equal(finalizationCalls.length, 2);
  assert.deepEqual(finalizationCalls.map((call) => call.options.summaryNodeId), [
    'summary-partial',
    'summary-accepted',
  ]);
  const completion = logger.entries.find((entry) => entry.message === 'Consolidation complete (GPT-5.5)');
  assert.deepEqual(completion?.data, { created: 1, skipped: 2 });
  assert.equal(
    logger.entries.some((entry) => entry.level === 'warn' && entry.data?.reason === 'summary_node_creation_failed'),
    true,
  );
  assert.equal(
    logger.entries.some((entry) => entry.level === 'warn' && entry.data?.reason === 'source_identity_changed'),
    true,
  );
});

test('COSMO performMemoryConsolidation counts only stored summaries with committed source markers', async () => {
  const logger = makeLogger();
  const consolidations = [consolidation('missing'), consolidation('partial'), consolidation('accepted')];
  const createdNodes = [null, { id: 'summary-partial' }, { id: 'summary-accepted' }];
  const commitCalls = [];
  const orchestrator = Object.create(CosmoOrchestrator.prototype);
  Object.assign(orchestrator, {
    logger,
    memory: {
      async addNode() { return createdNodes.shift(); },
    },
    summarizer: {
      async consolidateMemories() { return consolidations; },
      commitConsolidationSources(_memory, candidate) {
        commitCalls.push(candidate);
        if (candidate.sourceNodes[0] === 'source-partial') {
          return {
            committed: false,
            mode: 'partial',
            reason: 'source_identity_changed',
            updatedSourceNodes: 0,
            skippedSourceNodes: 1,
          };
        }
        return { committed: true, mode: 'apply', updatedSourceNodes: 1, skippedSourceNodes: 0 };
      },
    },
  });

  const result = await orchestrator.performMemoryConsolidation();

  assert.deepEqual(result, { created: 1, skipped: 2 });
  assert.equal(commitCalls.length, 2);
  assert.deepEqual(commitCalls.map((candidate) => candidate.sourceNodes[0]), [
    'source-partial',
    'source-accepted',
  ]);
  assert.equal(
    logger.entries.some((entry) => entry.level === 'warn' && entry.data?.reason === 'summary_node_creation_failed'),
    true,
  );
  assert.equal(
    logger.entries.some((entry) => entry.level === 'warn' && entry.data?.reason === 'source_identity_changed'),
    true,
  );
  assert.deepEqual(
    logger.entries.find((entry) => entry.message === 'Consolidation complete (GPT-5.2)')?.data,
    { created: 1, skipped: 2 },
  );
});

test('deep sleep caller does not finalize or log a consolidation whose summary node was not created', async () => {
  const logger = makeLogger();
  let finalizeCalls = 0;
  const orchestrator = Object.create(Orchestrator.prototype);
  Object.assign(orchestrator, {
    config: {
      execution: {
        dreamModeSettings: {
          disableConsolidationRateLimit: true,
          dreamsPerCycle: -1,
        },
      },
      architecture: {
        goals: { maxGoals: 0 },
        temporal: { dreamRewiring: false },
      },
    },
    logger,
    journal: [],
    lastSummarization: 0,
    cycleCount: 1,
    temporal: {
      lastConsolidationTime: null,
      minConsolidationInterval: 0,
      enterDreamMode() {},
      exitDreamMode() {},
    },
    memory: {
      async addNode() { return null; },
    },
    summarizer: {
      async consolidateMemories() { return [consolidation('deep-sleep')]; },
      commitConsolidationSources() {
        return { committed: true, mode: 'apply', updatedSourceNodes: 1, skippedSourceNodes: 0 };
      },
      finalizeConsolidationCompost() {
        finalizeCalls += 1;
        return { mode: 'blocked', reason: 'summary_node_not_found' };
      },
      garbageCollect() { return 0; },
    },
    getMemoryCompostOptions() {
      return { mode: 'apply', confirmedDryRunAt: '2026-07-11T00:00:00.000Z' };
    },
    goalCapture: {
      async analyzeJournalForGoals() { return []; },
    },
    goals: {
      getGoals() { return []; },
    },
    stateModulator: {
      getState() { return { mood: 0.5, energy: 1, curiosity: 0.5 }; },
      updateState() {},
    },
    async saveState() { return { saved: true }; },
  });

  await orchestrator.performDeepSleepConsolidation();

  assert.equal(finalizeCalls, 0);
  assert.equal(logger.entries.some((entry) => entry.message === '✓ Consolidated (GPT-5.5)'), false);
  assert.equal(
    logger.entries.some((entry) => entry.level === 'warn' && entry.data?.reason === 'summary_node_creation_failed'),
    true,
  );
});

test('failed summary creation leaves exact sources eligible and a replacement untouched', async () => {
  const logger = makeLogger();
  const originalSources = ['source-a', 'source-b', 'source-c'].map((id) => ({
    id,
    concept: `durable ${id}`,
  }));
  const replacement = { id: 'source-a', concept: 'replacement accepted during summary creation' };
  const nodes = new Map(originalSources.map((node) => [node.id, node]));
  let markerCommitCalls = 0;
  const orchestrator = Object.create(Orchestrator.prototype);
  Object.assign(orchestrator, {
    logger,
    memory: {
      nodes,
      async addNode() {
        nodes.set(replacement.id, replacement);
        return null;
      },
    },
    summarizer: {
      commitConsolidationSources() {
        markerCommitCalls += 1;
        for (const node of originalSources) node.consolidatedAt = 'stranded';
        return { committed: true };
      },
      finalizeConsolidationCompost() {
        throw new Error('finalization_must_not_run');
      },
    },
  });

  const publication = await orchestrator._publishConsolidationSummary(
    {
      consolidated: 'durable consolidation candidate',
      sourceNodes: originalSources.map((node) => node.id),
    },
    '[CONSOLIDATED] durable consolidation candidate',
    { mode: 'off', confirmedDryRunAt: null },
  );

  assert.equal(publication.published, false);
  assert.equal(publication.reason, 'summary_node_creation_failed');
  assert.equal(markerCommitCalls, 0);
  assert.equal(nodes.get(replacement.id), replacement);
  assert.equal(replacement.consolidatedAt, undefined);
  assert.ok(originalSources.every((node) => node.consolidatedAt === undefined));
});

test('throwing summary creation is a typed non-publication and never commits sources', async () => {
  const logger = makeLogger();
  let commitCalls = 0;
  let finalizeCalls = 0;
  const orchestrator = Object.create(Orchestrator.prototype);
  Object.assign(orchestrator, {
    logger,
    memory: {
      async addNode() {
        throw new Error('embedding_provider_failed');
      },
    },
    summarizer: {
      commitConsolidationSources() {
        commitCalls += 1;
        return { committed: true };
      },
      finalizeConsolidationCompost() {
        finalizeCalls += 1;
        return { mode: 'apply' };
      },
    },
  });

  const publication = await orchestrator._publishConsolidationSummary(
    { sourceNodes: ['source-throw'] },
    '[CONSOLIDATED] provider failure candidate',
    { mode: 'off', confirmedDryRunAt: null },
  );

  assert.deepEqual(publication, {
    published: false,
    mode: 'blocked',
    reason: 'summary_node_creation_failed',
  });
  assert.equal(commitCalls, 0);
  assert.equal(finalizeCalls, 0);
  assert.equal(
    logger.entries.some((entry) => (
      entry.level === 'warn'
      && entry.data?.reason === 'summary_node_creation_failed'
      && entry.data?.error === 'embedding_provider_failed'
    )),
    true,
  );
});

test('replacement during summary creation blocks source markers and compost finalization', async () => {
  const logger = makeLogger();
  const original = { id: 'source-race', concept: 'original source' };
  const replacement = { id: original.id, concept: 'replacement source' };
  const nodes = new Map([[original.id, original]]);
  let finalizeCalls = 0;
  const orchestrator = Object.create(Orchestrator.prototype);
  Object.assign(orchestrator, {
    logger,
    memory: {
      nodes,
      async addNode() {
        nodes.set(replacement.id, replacement);
        return { id: 'summary-race' };
      },
    },
    summarizer: {
      commitConsolidationSources() {
        return {
          committed: false,
          mode: 'partial',
          reason: 'source_identity_changed',
          updatedSourceNodes: 0,
          skippedSourceNodes: 1,
          identityChangedSourceNodes: [original.id],
        };
      },
      finalizeConsolidationCompost() {
        finalizeCalls += 1;
        return { mode: 'apply' };
      },
    },
  });

  const publication = await orchestrator._publishConsolidationSummary(
    { sourceNodes: [original.id] },
    '[CONSOLIDATED] race candidate',
    { mode: 'apply', confirmedDryRunAt: '2026-07-11T00:00:00.000Z' },
  );

  assert.equal(publication.published, false);
  assert.equal(publication.reason, 'source_identity_changed');
  assert.equal(finalizeCalls, 0);
  assert.equal(nodes.get(original.id), replacement);
  assert.equal(replacement.consolidatedAt, undefined);
});
