const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { QueryEngine } = require('../../cosmo23/lib/query-engine');

function createStubQueryEngine(runtimeDir, answer, capture) {
  const engine = Object.create(QueryEngine.prototype);
  Object.assign(engine, {
    runtimeDir,
    runConfig: {},
    runMetadata: null,
    queryCache: new Map(),
    maxCacheSize: 50,
    coordinatorIndexer: null,
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
        capture.maxTokens = request.maxTokens;
        capture.reasoningEffort = request.reasoningEffort;
        return { content: answer };
      }
    },
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
  assert.equal(capture.maxTokens, 25000);
  assert.equal(capture.reasoningEffort, 'high');
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
