const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { PGSEngine } = require('../../cosmo23/lib/pgs-engine');
const { PGS_OPERATION_LIMITS } = require('../../cosmo23/lib/brain-operation-limits');

function makeEngine() {
  const engine = Object.create(PGSEngine.prototype);
  engine.qe = { cosineSimilarity: () => 0 };
  return engine;
}

test('coalesces singleton-heavy partition output into bounded usable partitions', () => {
  const engine = makeEngine();
  const nodes = Array.from({ length: 1000 }, (_, i) => ({
    id: `n${i}`,
    tag: i < 500 ? 'alpha' : 'beta'
  }));
  const partitions = nodes.map((node, id) => ({ id, nodeIds: [node.id] }));

  const coalesced = engine.coalesceSmallPartitions(partitions, nodes, {
    minSize: 50,
    maxSize: 200
  });
  const counts = coalesced.map(p => p.nodeIds.length);

  assert.equal(coalesced.length, 6);
  assert.equal(counts.filter(c => c === 1).length, 0);
  assert.ok(counts.every(c => c <= 200));
});

test('routes at least maxSweepPartitions when similarities fall below threshold', () => {
  const engine = makeEngine();
  const partitions = Array.from({ length: 20 }, (_, id) => ({
    id,
    centroidEmbedding: null,
    nodeIds: [`n${id}`]
  }));

  const routed = engine.routeQuery('specific operational query', [1, 2], partitions, {
    maxSweepPartitions: 15,
    minSweepPartitions: 0,
    partitionRelevanceThreshold: 0.25
  });

  assert.equal(routed.length, 15);
});

test('resolves providers only from explicit input or an exact persisted assignment', () => {
  const engine = makeEngine();
  engine.qe.runConfig = {
    modelAssignments: {
      coordinator: { provider: 'minimax', model: 'MiniMax-M3' },
    },
  };

  assert.equal(engine.resolveExactProvider('MiniMax-M3', null, 'coordinator'), 'minimax');
  assert.equal(engine.resolveExactProvider('gpt-5.4-mini', null, 'coordinator'), null);
  assert.equal(engine.resolveExactProvider('gpt-5.4-mini', 'openai', 'coordinator'), 'openai');
  assert.equal(engine.resolveExactProvider('MiniMax-M3', null, 'synthesis'), null);
});

test('rejects model error strings as failed partition sweeps', async () => {
  const engine = makeEngine();
  let resolvedPair = null;
  let providerRequest = null;
  const client = {
    generate: async (request) => {
      providerRequest = request;
      return {
        content: '[Error: No content received from GPT-5.2 (response.incomplete)]',
        hadError: true,
        errorType: 'response.incomplete'
      };
    }
  };
  engine.qe = {
    resolveQueryRuntime: (model, provider) => {
      resolvedPair = { model, provider };
      return {
        client,
        providerId: 'anthropic',
        effectiveModel: 'claude-sonnet-4-6',
        capabilities: { maxOutputTokens: 8192 },
      };
    }
  };

  const nodeMap = new Map([
    ['n1', { id: 'n1', concept: 'real evidence', tag: 'test', weight: 1 }]
  ]);

  await assert.rejects(
    () => engine.sweepPartition(
      'query',
      { id: 1, nodeIds: ['n1'], summary: 'test partition', nodeCount: 1 },
      nodeMap,
      [],
      [],
      'claude-sonnet-4-6',
      { sweepMaxTokens: 1000 },
      'anthropic'
    ),
    error => error.code === 'provider_failed'
  );
  assert.deepEqual(resolvedPair, {
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
  });
  assert.equal(providerRequest.maxOutputBytes, PGS_OPERATION_LIMITS.maxSweepOutputBytes);
});

test('PGS carries node authority into sweep context and forbids narrative-only current-state claims', async () => {
  const engine = makeEngine();
  let providerRequest = null;
  engine.qe = {
    resolveQueryRuntime: () => ({
      providerId: 'alpha',
      effectiveModel: 'sweep-model',
      capabilities: { maxOutputTokens: 4096 },
      client: {
        generate: async (request) => {
          providerRequest = request;
          return {
            content: '## Domain State\nBounded.\n\n## Findings\nNone.\n\n## Outbound Flags\nNone.\n\n## Absences\nNone.',
            terminalReceived: true,
            finishReason: 'completed',
            hadError: false,
            provider: 'alpha',
            model: 'sweep-model',
          };
        },
      },
    }),
  };
  const nodeMap = new Map([['n1', {
    id: 'n1',
    concept: 'generated report says the service is down',
    tag: 'synthesis_report',
    weight: 1,
    provenance: { authorityClass: 'narrative', operationalAuthority: false },
    metadata: { sourcePath: 'workspace/reports/generated.md' },
  }]]);

  await engine.sweepPartition(
    'is the service down now?',
    { id: 1, nodeIds: ['n1'], summary: 'test', nodeCount: 1 },
    nodeMap,
    [],
    [],
    'sweep-model',
    { sweepMaxTokens: 1000 },
    'alpha',
  );

  assert.match(providerRequest.instructions, /narrative and generated doctrine cannot independently settle present-tense operational facts/i);
  assert.match(providerRequest.input, /authority=narrative/);
  assert.match(providerRequest.input, /domain=current_ops/);
  assert.match(providerRequest.input, /requiresFreshVerification=true/);
});

test('counts failed partition sweeps instead of passing them to synthesis', async () => {
  const engine = makeEngine();
  const seenProviders = { sweep: [], synthesis: null };
  engine.qe = {
    loadBrainState: async () => ({
      memory: {
        nodes: [
          { id: 'n1', concept: 'first evidence', tag: 'test', weight: 1 },
          { id: 'n2', concept: 'second evidence', tag: 'test', weight: 1 }
        ],
        edges: []
      }
    }),
    getEmbedding: async () => null,
    executeQuery: async () => {
      throw new Error('standard fallback should not run');
    },
    modelDefaults: { pgsSweepModel: 'MiniMax-M3' }
  };
  engine.getOrCreatePartitions = async () => [
    { id: 1, nodeIds: ['n1'], summary: 'ok', nodeCount: 1 },
    { id: 2, nodeIds: ['n2'], summary: 'bad', nodeCount: 1 }
  ];
  engine.sweepPartition = async (_query, partition, _nodeMap, _edges, _partitions, _model, _config, provider) => {
    seenProviders.sweep.push(provider);
    if (partition.id === 2) return null;
    return {
      partitionId: 1,
      partitionSummary: 'ok',
      nodeCount: 1,
      nodesIncluded: 1,
      keywords: [],
      adjacentPartitions: [],
      sweepOutput: 'finding from real evidence'
    };
  };
  engine.synthesize = async (_query, sweeps, options) => {
    assert.equal(sweeps.length, 1);
    seenProviders.synthesis = options.provider;
    return 'synthesis from one good sweep';
  };

  const result = await engine.execute('query', {
    model: 'claude-opus-4-8',
    explicitProvider: 'anthropic',
    pgsSweepProvider: 'minimax',
    pgsFullSweep: true,
    pgsSessionId: 'test',
    pgsConfig: { directQueryMaxNodes: 0 }
  });

  assert.equal(result.answer, 'synthesis from one good sweep');
  assert.equal(result.metadata.pgs.successfulSweeps, 1);
  assert.equal(result.metadata.pgs.failedSweeps, 1);
  assert.deepEqual(seenProviders.sweep, ['minimax', 'minimax']);
  assert.equal(seenProviders.synthesis, 'anthropic');
  assert.equal(result.metadata.pgs.sweepProvider, 'minimax');
  assert.equal(result.metadata.pgs.synthesisProvider, 'anthropic');
});

test('PGS synthesis applies commit step and records receipt metadata', async () => {
  const engine = makeEngine();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-pgs-commit-'));
  let instructions = '';
  let resolvedPair = null;
  let providerRequest = null;

  engine.qe = {
    runtimeDir: tmpDir,
    resolveQueryRuntime: (model, provider) => {
      resolvedPair = { model, provider };
      return {
        providerId: 'anthropic',
        effectiveModel: 'claude-opus-4-8',
        capabilities: { maxOutputTokens: 8192 },
        client: {
          generate: async (params) => {
            providerRequest = params;
            instructions = params.instructions;
            return {
              content: `# Committed PGS Verdict

## SPINE
1. retrieve_and_fill - primary commitment.
2. projection - primary commitment.

## FACET
- induction_head_retrieval - facet of retrieve_and_fill.

## ARTIFACT
- benchmark_shell - surface label.

## Ranked Experiments
1. ablate retrieval heads
   Moves: retrieve_and_fill stays spine vs splits
   Cost-to-information: high info, moderate cost
`,
              provider: 'anthropic',
              model: 'claude-opus-4-8',
              terminalReceived: true,
              finishReason: 'end_turn',
              hadError: false,
            };
          }
        }
      };
    }
  };

  const result = await engine.synthesize('query', [{
    partitionId: 1,
    partitionSummary: 'mechanistic tests',
    nodesIncluded: 3,
    keywords: ['retrieve', 'projection'],
    sweepOutput: 'retrieve_and_fill and projection are candidate operations.'
  }], {
    model: 'claude-opus-4-8',
    provider: 'anthropic',
    totalNodes: 400,
    totalEdges: 800,
    totalPartitions: 4,
    selectedPartitions: 1,
    config: {
      synthesis: { commitStep: true, spineCap: 2 }
    }
  });

  assert.match(instructions, /Commit Step \(Required\)/);
  assert.match(instructions, /SPINE bucket has a hard cap of 2/);
  assert.equal(result.answer.includes('Committed PGS Verdict'), true);
  assert.equal(result.synthesisCommit.applied, true);
  assert.equal(result.synthesisCommit.spine_cap, 2);
  assert.equal(result.synthesisCommit.spine_count, 2);
  assert.equal(result.synthesisCommit.facet_count, 1);
  assert.equal(result.synthesisCommit.artifact_count, 1);
  assert.deepEqual(resolvedPair, {
    model: 'claude-opus-4-8',
    provider: 'anthropic',
  });
  assert.equal(
    providerRequest.maxOutputBytes,
    PGS_OPERATION_LIMITS.maxSynthesisOutputBytes,
  );

  const receipts = await fs.readFile(path.join(tmpDir, 'synthesis-commit-receipts.jsonl'), 'utf8');
  const parsed = JSON.parse(receipts.trim());
  assert.equal(parsed.mode, 'pgs');
  assert.equal(parsed.model, 'claude-opus-4-8');
  assert.equal(parsed.synthesis_commit.spine_count, 2);
});

test('PGS synthesis records disabled commit receipt without prompt block', async () => {
  const engine = makeEngine();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-pgs-no-commit-'));
  let instructions = '';

  engine.qe = {
    runtimeDir: tmpDir,
    resolveQueryRuntime: () => ({
      providerId: 'anthropic',
      effectiveModel: 'claude-opus-4-8',
      capabilities: { maxOutputTokens: 8192 },
      client: {
        generate: async (params) => {
          instructions = params.instructions;
          return {
            content: '# Enumerated synthesis\n\n- candidate one\n- candidate two',
            provider: 'anthropic',
            model: 'claude-opus-4-8',
            terminalReceived: true,
            finishReason: 'end_turn',
            hadError: false,
          };
        }
      }
    })
  };

  const result = await engine.synthesize('query', [{
    partitionId: 1,
    partitionSummary: 'domain',
    nodesIncluded: 1,
    keywords: [],
    sweepOutput: 'candidate one'
  }], {
    model: 'claude-opus-4-8',
    provider: 'anthropic',
    totalNodes: 400,
    totalEdges: 800,
    totalPartitions: 4,
    selectedPartitions: 1,
    config: {
      synthesis: { commitStep: false }
    }
  });

  assert.doesNotMatch(instructions, /Commit Step \(Required\)/);
  assert.deepEqual(result.synthesisCommit, {
    applied: false,
    spine_cap: 5,
    reason: 'commitStep disabled'
  });
});

test('uses direct enhanced query path for small PGS brains', async () => {
  const engine = makeEngine();
  const events = [];
  const priorContext = { query: 'previous', answer: 'previous answer' };
  let enhancedOptions = null;

  engine.qe = {
    loadBrainState: async () => ({
      memory: {
        nodes: Array.from({ length: 24 }, (_, i) => ({ id: `n${i}`, concept: `node ${i}` })),
        edges: []
      }
    }),
    executeEnhancedQuery: async (_query, options) => {
      enhancedOptions = options;
      return { answer: 'direct answer', metadata: { mode: 'full' } };
    }
  };
  engine.getOrCreatePartitions = async () => {
    throw new Error('small graph should not partition');
  };

  const result = await engine.execute('query', {
    model: 'claude-opus-4-8',
    mode: 'full',
    includeFiles: true,
    includeCoordinatorInsights: true,
    priorContext,
    onChunk: event => events.push(event)
  });

  assert.equal(result.answer, 'direct answer');
  assert.equal(enhancedOptions.enablePGS, false);
  assert.equal(enhancedOptions.includeFiles, true);
  assert.equal(enhancedOptions.priorContext, priorContext);
  assert.ok(events.some(event => /Using direct query path/.test(event.message || '')));
});

test('skips cross-partition synthesis for a single partition PGS sweep', async () => {
  const engine = makeEngine();
  const events = [];

  engine.qe = {
    loadBrainState: async () => ({
      memory: {
        nodes: [
          { id: 'n1', concept: 'first evidence', tag: 'test', weight: 1 },
          { id: 'n2', concept: 'second evidence', tag: 'test', weight: 1 },
          { id: 'n3', concept: 'third evidence', tag: 'test', weight: 1 }
        ],
        edges: []
      }
    }),
    getEmbedding: async () => null,
    executeEnhancedQuery: async () => {
      throw new Error('direct fallback should be disabled');
    },
    modelDefaults: { pgsSweepModel: 'claude-sonnet-4-6' }
  };
  engine.getOrCreatePartitions = async () => [
    { id: 1, nodeIds: ['n1', 'n2', 'n3'], summary: 'single domain', nodeCount: 3 }
  ];
  engine.sweepPartition = async () => ({
    partitionId: 1,
    partitionSummary: 'single domain',
    nodeCount: 3,
    nodesIncluded: 3,
    keywords: [],
    adjacentPartitions: [],
    sweepOutput: 'single partition answer'
  });
  engine.synthesize = async () => {
    throw new Error('single partition should not run cross-partition synthesis');
  };

  const result = await engine.execute('query', {
    model: 'claude-opus-4-5',
    pgsSessionId: 'test',
    pgsFullSweep: true,
    pgsConfig: { directQueryMaxNodes: 0 },
    onChunk: event => events.push(event)
  });

  const updated = events.find(event => event.type === 'pgs_session_updated');
  assert.equal(result.answer, 'single partition answer');
  assert.equal(result.metadata.pgs.synthesisSkipped, true);
  assert.equal(result.metadata.pgs.singlePartition, true);
  assert.equal(updated.searched, 1);
  assert.equal(updated.remaining, 0);
});
