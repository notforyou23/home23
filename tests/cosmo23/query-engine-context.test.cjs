const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { QueryEngine } = require('../../cosmo23/lib/query-engine');
const {
  MAX_VERIFIED_CONTEXT_UTF16,
  vectors: verifiedContextVectors,
} = require('../helpers/query-verified-follow-up-context-vectors.cjs');

const VERIFIED_SECTION_LABEL = '# Verified Prior Conversation\n\n';

function createStubQueryEngine(runtimeDir, answer, capture) {
  const engine = Object.create(QueryEngine.prototype);
  Object.assign(engine, {
    runtimeDir,
    runConfig: {},
    runMetadata: null,
    queryCache: new Map(),
    maxCacheSize: 50,
    coordinatorIndexer: null,
    requireCompleteProviderResult: value => value,
    performanceMetrics: {
      cacheHits: 0,
      cacheMisses: 0,
      queriesProcessed: 0,
      avgQueryTime: 0,
      enhancementUsage: {
        evidence: 0,
        synthesis: 0,
        coordinator: 0,
        followUps: 0
      }
    },
    contextTracker: {
      createSession: () => ({ sessionId: 'test-session', context: {} }),
      addToSession: () => ({ sessionId: 'test-session', context: {} })
    }
  });

  engine.resolveQueryRuntime = () => ({
    client: {
      generate: async (request) => {
        capture.instructions = request.instructions;
        capture.input = request.input;
        capture.maxOutputTokens = request.maxOutputTokens;
        capture.reasoningEffort = request.reasoningEffort;
        return {
          content: answer,
          terminalReceived: true,
          finishReason: 'completed',
          hadError: false,
          provider: 'openai',
          model: 'gpt-5.5',
        };
      }
    },
    capabilities: { maxOutputTokens: 25000, providerStallMs: 900000 },
    providerId: 'openai',
    providerLabel: 'OpenAI',
    effectiveModel: 'gpt-5.5',
    isClaudeModel: false,
    isLocalModel: false,
    isXaiModel: false,
    isCodex: false
  });
  engine.loadBrainState = async () => ({ cycleCount: 1, memory: { nodes: [], edges: [] }, goals: { active: [] } });
  engine.loadThoughts = async () => [];
  engine.loadMetrics = async () => null;
  engine.getLatestReport = async () => null;
  engine.queryMemory = async () => [];
  engine.queryThoughts = async () => [];
  engine.buildContext = () => '# Test context';

  return engine;
}

function substantialPinnedAnswer() {
  const headings = [
    '# Findings', '# Evidence and inference', '# Themes', '# Non-obvious connections',
    '# Convergence', '# Contradictions', '# Confidence', '# Actionable implications',
    '# Gaps and unresolved questions',
    'Projection limits: this uses the retained prompt subset, not the entire brain.',
  ].join('\n\n');
  return `${headings}\n\n${'Detailed supported analysis. '.repeat(240)}`;
}

function createPinnedPromptHarness(answers = ['pinned answer']) {
  const calls = [];
  const client = {
    providerId: 'alpha',
    async generate(options) {
      calls.push(options);
      return {
        content: answers[Math.min(calls.length - 1, answers.length - 1)],
        terminalReceived: true,
        finishReason: 'completed',
        hadError: false,
        provider: 'alpha',
        model: 'answer-model',
      };
    },
  };
  const engine = new QueryEngine({
    operationMode: true,
    providerRegistry: { get: () => client },
    modelCatalog: {
      version: 1,
      providers: {
        alpha: { models: [{
          id: 'answer-model',
          kind: 'chat',
          contextWindowTokens: 256_000,
          maxOutputTokens: 50_000,
          providerStallMs: 900_000,
          transport: 'responses',
        }] },
      },
      defaults: {},
    },
  });
  engine.projectPinnedQuery = async () => ({
    sourceRevision: 17,
    summary: { nodeCount: 1, edgeCount: 0, clusterCount: 0 },
    nodes: [{ id: 'verified-node', content: 'Current verified evidence.' }],
    nodeAuthorities: [{
      id: 'verified-node',
      authorityClass: 'artifact_log',
      retrievalDomain: 'current_ops',
      requiresFreshVerification: false,
      sourceChain: [{ kind: 'artifact', ref: 'artifact:verified-node' }],
    }],
    edges: [],
    stats: {
      nodesScanned: 1,
      edgesScanned: 0,
      nodesRetained: 1,
      edgesRetained: 0,
      droppedForByteBudget: 0,
      byteBudgetTruncated: false,
    },
    sourceEvidence: {
      sourceHealth: 'healthy',
      freshness: 'known',
      deltaWatermark: { revision: 17 },
    },
  });
  return { engine, calls };
}

function pinnedOptions(vector, mode = 'quick') {
  return {
    sourcePin: {
      revision: 17,
      descriptor: { cutoffRevision: 17 },
      async summarize() { return { nodeCount: 1, edgeCount: 0, clusterCount: 0 }; },
    },
    modelSelection: { provider: 'alpha', model: 'answer-model' },
    mode,
    signal: new AbortController().signal,
    verifiedConversationContext: { version: 1, exchanges: vector.exchanges },
  };
}

test('operation Query renders one canonical verified section in initial and expansion prompts', async () => {
  const harness = createPinnedPromptHarness(['thin first answer', substantialPinnedAnswer()]);

  await harness.engine.executeQuery(
    'What changed?', pinnedOptions(verifiedContextVectors.simple, 'dive'),
  );

  assert.equal(harness.calls.length, 2);
  const prompts = harness.calls.map(call => JSON.parse(call.input));
  for (const prompt of prompts) {
    assert.equal(
      prompt.verifiedPriorConversation,
      `${VERIFIED_SECTION_LABEL}${verifiedContextVectors.simple.rendered}`,
    );
    assert.equal(JSON.stringify(prompt).includes('operationId'), false);
    assert.equal(JSON.stringify(prompt).includes('resultVersion'), false);
    assert.equal(JSON.stringify(prompt).includes('_queryFollowUpContext'), false);
    assert.equal(
      Object.keys(prompt).indexOf('verifiedPriorConversation'),
      Object.keys(prompt).indexOf('priorContext') + 1,
    );
  }
});

test('operation Query preserves Task 3 UTF-16 vectors and exact JSON byte framing', async () => {
  for (const vector of [
    verifiedContextVectors.simple,
    verifiedContextVectors.exactBoundary,
    verifiedContextVectors.emoji,
  ]) {
    const harness = createPinnedPromptHarness();
    const result = await harness.engine.executeQuery('What changed?', pinnedOptions(vector));
    assert.equal(harness.calls.length, 1);
    const prompt = JSON.parse(harness.calls[0].input);
    assert.equal(prompt.verifiedPriorConversation, `${VERIFIED_SECTION_LABEL}${vector.rendered}`);
    assert.equal(prompt.verifiedPriorConversation.slice(VERIFIED_SECTION_LABEL.length).length, vector.utf16);
    assert.equal(
      result.metadata.promptBytes,
      Buffer.byteLength(harness.calls[0].instructions + harness.calls[0].input, 'utf8'),
    );
  }
  assert.equal(verifiedContextVectors.exactBoundary.utf16, MAX_VERIFIED_CONTEXT_UTF16);
});

test('quick query mode stays bounded on large brains', () => {
  const limit = QueryEngine.calculateMemoryNodeLimit({
    mode: 'quick',
    totalNodes: 56210,
    isMergedBrain: false,
    model: 'claude-opus-4-8'
  });

  assert.equal(limit, 50);
});

test('direct full query mode preserves the old bounded query contract', () => {
  const limit = QueryEngine.calculateMemoryNodeLimit({
    mode: 'full',
    totalNodes: 56210,
    isMergedBrain: false,
    model: 'claude-opus-4-8'
  });

  assert.equal(limit, 400);
});

test('direct query modes stay bounded while PGS owns large graph coverage', () => {
  const base = { totalNodes: 56210, isMergedBrain: true, model: 'claude-opus-4-8' };

  assert.equal(QueryEngine.calculateMemoryNodeLimit({ ...base, mode: 'deep' }), 400);
  assert.equal(QueryEngine.calculateMemoryNodeLimit({ ...base, mode: 'report' }), 600);
  assert.equal(QueryEngine.calculateMemoryNodeLimit({ ...base, mode: 'expert' }), 800);
  assert.equal(QueryEngine.calculateMemoryNodeLimit({ ...base, mode: 'dive' }), 1000);
});

test('current Claude family query models keep deep context instead of falling to safety caps', () => {
  assert.equal(QueryEngine.resolveModelMaxNodes('claude-sonnet-4-7'), 3000);
  assert.equal(QueryEngine.resolveModelMaxNodes('claude-opus-4-8'), 4200);
  assert.equal(QueryEngine.resolveModelMaxNodes('claude-sonnet-4-8'), 3000);
});

test('current Grok family query models use the xAI context profile', () => {
  assert.equal(QueryEngine.resolveModelMaxNodes('grok-4.3'), 2800);
  assert.equal(QueryEngine.resolveModelMaxNodes('grok-4.5'), 2800);
  assert.equal(QueryEngine.resolveModelContextWindow('grok-4.5'), 128000);
});

test('large Anthropic query contexts are capped before provider streaming', () => {
  const engine = Object.create(QueryEngine.prototype);
  const hugeNodes = Array.from({ length: 1000 }, (_, i) => ({
    id: `n${i}`,
    concept: `node ${i} ` + 'dense research finding. '.repeat(500),
    score: 1,
    semanticScore: 1,
    keywordScore: 1
  }));

  const context = engine.buildContext(
    {
      cycleCount: 1,
      memory: { nodes: hugeNodes, edges: [] },
      goals: { active: [] }
    },
    hugeNodes,
    [],
    null,
    null,
    'dive',
    null,
    'claude-opus-4-8'
  );

  assert.ok(context.length <= QueryEngine.resolveContextCharLimit('claude-opus-4-8', 'dive'));
  assert.match(context, /Context budget reached/);
});

test('large GPT-5.5 query contexts are capped before Codex/OpenAI provider calls', () => {
  const engine = Object.create(QueryEngine.prototype);
  const hugeNodes = Array.from({ length: 1000 }, (_, i) => ({
    id: `g${i}`,
    concept: `gpt node ${i} ` + 'dense research finding. '.repeat(500),
    score: 1,
    semanticScore: 1,
    keywordScore: 1
  }));

  const context = engine.buildContext(
    {
      cycleCount: 1,
      memory: { nodes: hugeNodes, edges: [] },
      goals: { active: [] }
    },
    hugeNodes,
    [],
    null,
    null,
    'dive',
    null,
    'gpt-5.5'
  );

  assert.ok(context.length <= QueryEngine.resolveContextCharLimit('gpt-5.5', 'dive'));
  assert.match(context, /Context budget reached/);
});

test('full query mode uses the deep answer contract', async () => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-query-full-depth-'));
  const capture = {};
  const engine = createStubQueryEngine(runtimeDir, 'full answer', capture);

  await engine.executeQuery('explain the research', {
    mode: 'full'
  });

  assert.match(capture.instructions, /COMPLETE DEEP ACCESS/);
  assert.equal(capture.maxOutputTokens, 25000);
  assert.equal(capture.reasoningEffort, 'high');
});

test('legacy internal Query path renders verified context without exposing private authority', async () => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-query-verified-context-'));
  const capture = {};
  const engine = createStubQueryEngine(runtimeDir, 'verified answer', capture);

  await engine.executeQuery('What changed?', {
    mode: 'quick',
    verifiedConversationContext: {
      version: 1,
      exchanges: verifiedContextVectors.simple.exchanges,
    },
  });

  assert.match(
    capture.input,
    new RegExp(`${VERIFIED_SECTION_LABEL}${verifiedContextVectors.simple.rendered}`),
  );
  assert.equal(capture.input.includes('operationId'), false);
  assert.equal(capture.input.includes('resultVersion'), false);
});

test('dive query prompt includes commit step and records synthesis receipt when enabled', async () => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-query-commit-'));
  const capture = {};
  const answer = `# Verdict

## SPINE
- retrieval - primary.

## FACET
- template completion - sub-case.

## ARTIFACT
- benchmark shell - surface.

## Ranked Experiments
1. ablate retrieval mechanism
   Moves: retrieval remains spine or demotes to artifact
   Cost-to-information: high info, low cost`;
  const engine = createStubQueryEngine(runtimeDir, answer, capture);

  const result = await engine.executeQuery('commit the synthesis', {
    mode: 'dive',
    synthesis: { commitStep: true, spineCap: 2 }
  });

  assert.match(capture.instructions, /Commit Step \(Required\)/);
  assert.match(capture.instructions, /hard cap of 2/);
  assert.equal(result.metadata.synthesis_commit.applied, true);
  assert.equal(result.metadata.synthesis_commit.spine_count, 1);

  const receiptPath = path.join(runtimeDir, 'synthesis-commit-receipts.jsonl');
  const receiptLines = (await fs.readFile(receiptPath, 'utf8')).trim().split('\n');
  assert.equal(receiptLines.length, 1);
  assert.equal(JSON.parse(receiptLines[0]).synthesis_commit.applied, true);
});

test('dive query prompt omits commit block and records disabled receipt when disabled', async () => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-query-no-commit-'));
  const capture = {};
  const engine = createStubQueryEngine(runtimeDir, '# Normal synthesis', capture);

  const result = await engine.executeQuery('normal synthesis', {
    mode: 'dive',
    synthesis: { commitStep: false }
  });

  assert.doesNotMatch(capture.instructions, /Commit Step \(Required\)/);
  assert.deepEqual(result.metadata.synthesis_commit, {
    applied: false,
    spine_cap: 5,
    reason: 'commitStep disabled'
  });
});
