'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const { Orchestrator } = require('../../src/core/orchestrator');
const { MemorySummarizer } = require('../../src/memory/summarizer');

function logger() {
  const entries = [];
  return {
    entries,
    info(message, data) { entries.push({ level: 'info', message, data }); },
    warn(message, data) { entries.push({ level: 'warn', message, data }); },
    error(message, data) { entries.push({ level: 'error', message, data }); },
    debug(message, data) { entries.push({ level: 'debug', message, data }); },
  };
}

function source(id) {
  return { id, concept: `durable source ${id}`, tag: 'note' };
}

function exactCandidate(sources) {
  const candidate = {
    consolidated: 'Durable consolidated memory with enough semantic detail for validation',
    reasoning: null,
    sourceNodes: sources.map((entry) => entry.id),
    model: 'controlled-model',
  };
  Object.defineProperty(candidate, 'sourceIdentityTokens', {
    value: new Map(sources.map((entry) => [entry.id, entry])),
  });
  Object.defineProperty(candidate, 'consolidationTimestamp', {
    value: '2026-07-11T12:00:00.000Z',
  });
  return candidate;
}

describe('Orchestrator consolidation publication honesty', () => {
  afterEach(() => sinon.restore());

  it('counts only fully published consolidations across null and incomplete writes', async () => {
    const log = logger();
    const candidates = ['null', 'incomplete', 'stored'].map((id) => exactCandidate([source(`source-${id}`)]));
    const addNode = sinon.stub();
    addNode.onCall(0).resolves(null);
    addNode.onCall(1).resolves({ id: 'summary-incomplete' });
    addNode.onCall(2).resolves({ id: 'summary-stored' });
    const markerCommit = sinon.stub();
    markerCommit.onCall(0).returns({
      committed: false,
      mode: 'partial',
      reason: 'source_marker_commit_incomplete',
      updatedSourceNodes: 0,
      skippedSourceNodes: 1,
    });
    markerCommit.onCall(1).returns({
      committed: true,
      mode: 'apply',
      updatedSourceNodes: 1,
      skippedSourceNodes: 0,
    });
    const orchestrator = Object.create(Orchestrator.prototype);
    Object.assign(orchestrator, {
      logger: log,
      memory: { addNode },
      summarizer: {
        consolidateMemories: sinon.stub().resolves(candidates),
        commitConsolidationSources: markerCommit,
      },
    });

    const result = await orchestrator.performMemoryConsolidation();

    expect(result).to.deep.equal({ created: 1, skipped: 2 });
    expect(markerCommit.callCount).to.equal(2);
    const completion = log.entries.find((entry) => entry.message === 'Consolidation complete (GPT-5.2)');
    expect(completion?.data).to.deep.equal({ created: 1, skipped: 2 });
    expect(log.entries.some((entry) => entry.data?.reason === 'summary_node_creation_failed')).to.equal(true);
    expect(log.entries.some((entry) => entry.data?.reason === 'source_marker_commit_incomplete')).to.equal(true);
  });

  it('blocks and logs a replacement race after summary storage', async () => {
    const log = logger();
    const sources = [source('source-a'), source('source-b'), source('source-c')];
    const replacement = source('source-a');
    replacement.concept = 'replacement accepted while summary embedded';
    const nodes = new Map(sources.map((entry) => [entry.id, entry]));
    const patchNodes = sinon.stub();
    const memory = {
      nodes,
      patchNodes,
      addNode: sinon.stub().callsFake(async (content, tag) => {
        const summary = { id: 'stored-summary', concept: content, tag };
        nodes.set(summary.id, summary);
        nodes.set(replacement.id, replacement);
        return summary;
      }),
    };
    const orchestrator = Object.create(Orchestrator.prototype);
    Object.assign(orchestrator, {
      logger: log,
      memory,
      summarizer: new MemorySummarizer({}, log, {}),
    });

    const publication = await orchestrator._publishConsolidationSummary(
      exactCandidate(sources),
      '[CONSOLIDATED] replacement race candidate',
    );

    expect(publication).to.include({
      published: false,
      mode: 'partial',
      reason: 'source_identity_changed',
      summaryNodeId: 'stored-summary',
    });
    expect(patchNodes.called).to.equal(false);
    expect(replacement.consolidatedAt).to.equal(undefined);
    expect(sources.slice(1).every((entry) => entry.consolidatedAt === undefined)).to.equal(true);
    expect(log.entries.some((entry) => entry.data?.reason === 'source_identity_changed')).to.equal(true);
  });

  it('blocks and logs an incomplete exact-identity marker commit', async () => {
    const log = logger();
    const sources = [source('source-a'), source('source-b'), source('source-c')];
    const nodes = new Map(sources.map((entry) => [entry.id, entry]));
    const memory = {
      nodes,
      addNode: sinon.stub().callsFake(async (content, tag) => {
        const summary = { id: 'stored-summary', concept: content, tag };
        nodes.set(summary.id, summary);
        return summary;
      }),
      patchNodes: sinon.stub().returns({ updated: 2, nodes: sources.slice(0, 2) }),
    };
    const orchestrator = Object.create(Orchestrator.prototype);
    Object.assign(orchestrator, {
      logger: log,
      memory,
      summarizer: new MemorySummarizer({}, log, {}),
    });

    const publication = await orchestrator._publishConsolidationSummary(
      exactCandidate(sources),
      '[CONSOLIDATED] incomplete marker candidate',
    );

    expect(publication).to.include({
      published: false,
      mode: 'partial',
      reason: 'source_marker_commit_incomplete',
      summaryNodeId: 'stored-summary',
    });
    expect(log.entries.some((entry) => entry.data?.reason === 'source_marker_commit_incomplete')).to.equal(true);
  });

  it('does not log deep-sleep consolidation success when summary storage returns null', async () => {
    const log = logger();
    const markerCommit = sinon.stub().returns({ committed: true });
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
      logger: log,
      journal: [],
      lastSummarization: 0,
      cycleCount: 1,
      temporal: {
        lastConsolidationTime: null,
        minConsolidationInterval: 0,
        enterDreamMode() {},
        exitDreamMode() {},
      },
      memory: { addNode: sinon.stub().resolves(null) },
      summarizer: {
        consolidateMemories: sinon.stub().resolves([exactCandidate([source('source-sleep')])]),
        commitConsolidationSources: markerCommit,
        garbageCollect: sinon.stub().returns(0),
      },
      stateModulator: {
        getState() { return { mood: 0.5, energy: 1, curiosity: 0.5 }; },
        updateState() {},
      },
      events: { emitEvent() {} },
      saveState: sinon.stub().resolves({ saved: true }),
    });

    await orchestrator.performDeepSleepConsolidation();

    expect(markerCommit.called).to.equal(false);
    expect(log.entries.some((entry) => entry.message === '✓ Consolidated (GPT-5.2)')).to.equal(false);
    expect(log.entries.some((entry) => entry.data?.reason === 'summary_node_creation_failed')).to.equal(true);
  });
});
