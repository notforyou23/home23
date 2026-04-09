# PGS Engine — Partitioned Graph Synthesis

**Coverage-optimized query architecture for large knowledge graphs.**

PGS solves a problem that every RAG system has: it doesn't know what it doesn't know. Standard retrieval grabs the top-K most similar nodes and feeds them to an LLM. What about the other 95% of your graph? What connections span across distant clusters? What's completely absent from the results?

PGS answers these questions. It partitions your knowledge graph using community detection, sweeps each partition at full fidelity with structured prompts, then synthesizes across all outputs — discovering cross-domain connections, reporting explicit absences, and identifying convergent findings that no single-pass query can detect.

## Quick Start

```bash
npm install pgs-engine
```

### Explore the included brain (no API key needed)

```bash
node examples/explore-brain.js
```

This loads a real research brain (586 nodes of conformal field theory research) and shows the partition structure — communities, keywords, adjacencies — all computed algorithmically, no LLM calls.

### Run your first PGS query

```bash
OPENAI_API_KEY=sk-... node examples/with-openai.js
```

This runs a full PGS query against the physics2 brain: partition, route, sweep, synthesize. You'll see structured absence reporting and cross-partition discovery in action.

## What Makes PGS Different

### 1. Structured Absence Reporting

Every other retrieval system tells you what it found. PGS also tells you what it searched and **did NOT find.** When multiple partitions independently report "no findings for X," that's high-confidence evidence of a knowledge gap.

### 2. Cross-Partition Discovery

Each partition sweep flags connections to adjacent partitions ("Node 42's discussion of renormalization has structural parallels to the operator algebra in Partition P-3"). The synthesis phase chases these flags, evaluating whether the connections are genuine and substantive. Flat vector search has no mechanism for this.

### 3. Novelty on Demand

Ask PGS for novelty and it finds it every time, because it examines every partition at full fidelity. Things that are low-similarity to the query but high-importance within their partition surface in PGS but never appear in top-K retrieval.

### 4. Coverage Guarantees

Session tracking means you know exactly what percentage of the graph has been examined. Run a query in `full` mode, then `continue` to sweep the remaining partitions. You'll know precisely what was covered and what wasn't.

### 5. The Layered Search Pattern

The gold pattern: run a standard top-K query first (fast, context-setting), then feed that context into a PGS pass. The standard query tells PGS what's already known; PGS finds what isn't. This is nearly recursive — PGS continue/targeted modes let you drill deeper each pass.

## API

### Constructor

```js
const { PGSEngine } = require('pgs-engine');

const engine = new PGSEngine({
  // Required: LLM providers
  sweepProvider,          // Cheaper/faster model, called N times in parallel
  synthesisProvider,      // Best model, called once for cross-domain synthesis

  // Optional
  embeddingProvider,      // For query routing (without it, sweeps all partitions)
  storage,                // Session/cache persistence (default: in-memory)
  config,                 // Override defaults (see Configuration below)
  onEvent,                // Global event listener
});
```

### Provider Interfaces

**LLMProvider** (both sweep and synthesis):
```js
{
  generate: async ({
    instructions,      // System prompt
    input,             // User content (graph nodes, query)
    maxTokens,         // Response token budget
    reasoningEffort,   // 'low' | 'medium' | 'high' (advisory)
    onChunk,           // Streaming callback (optional)
  }) => ({ content: string })
}
```

**EmbeddingProvider** (optional):
```js
{
  embed: async (text) => number[] | null,  // Returns embedding vector
  dimensions: number                        // Output dimensions (e.g., 512, 1536)
}
```

**StorageProvider** (optional):
```js
{
  read: async (key) => string | null,      // Read JSON string by key
  write: async (key, data) => void         // Write JSON string
}
```

### Full Pipeline

```js
const result = await engine.execute(query, graph, {
  mode: 'full',            // 'full' | 'continue' | 'targeted'
  sessionId: 'default',    // For session tracking
  fullSweep: false,        // Bypass routing, sweep everything
  sweepFraction: 0.5,      // Sweep 50% of routed partitions
  onEvent: (event) => {},  // Per-query event listener
  onChunk: (text) => {},   // Synthesis token streaming
});

// result = {
//   answer: string,        // The synthesis output
//   metadata: {
//     pgs: {
//       totalNodes: 586,
//       totalEdges: 1931,
//       totalPartitions: 11,
//       sweptPartitions: 3,
//       successfulSweeps: 3,
//       elapsed: '12.3s',
//       searched: 3,
//       remaining: 8
//     }
//   }
// }
```

### Layered Search

```js
const result = await engine.layeredSearch(query, graph, {
  topK: 20,               // Standard query retrieves top-K nodes first
  standardProvider,        // LLM for standard query (defaults to synthesisProvider)
  mode: 'full',
  sessionId: 'default',
  onEvent: (event) => {},
});

// result = {
//   answer: string,          // PGS synthesis (enhanced with standard context)
//   standardAnswer: string,  // What standard retrieval found
//   metadata: {
//     layered: {
//       standardNodesUsed: 20,
//       standardAnswerLength: 2400
//     }
//   }
// }
```

### Composable API

```js
// Step-by-step control over each phase
const partitions = engine.partition(graph);
const routed = await engine.route(query, graph, partitions);
const sweepResult = await engine.sweepPartition(query, routed[0], graph, partitions);
const answer = await engine.synthesize(query, [sweepResult], context);
```

### Graph Format

```js
const graph = {
  nodes: [
    {
      id: 1,                           // string | number (required)
      concept: 'Research finding...',   // string (required: primary text content)
      embedding: [0.1, 0.2, ...],      // number[] | null (pre-computed embedding)
      tag: 'research',                  // string (optional: semantic tag)
      weight: 0.85,                     // number (optional: importance 0-1)
    }
  ],
  edges: [
    {
      source: 1,                       // string | number (required)
      target: 2,                       // string | number (required)
      weight: 0.7,                     // number (optional, default 0.5)
      type: 'associative',             // string (optional)
    }
  ]
};
```

## Configuration

| Parameter | Default | Description |
|---|---|---|
| `maxConcurrentSweeps` | 5 | Parallel LLM calls per sweep batch |
| `minNodesForPgs` | 0 | Minimum graph size (0 = always use PGS) |
| `minCommunitySize` | 30 | Merge communities smaller than this |
| `targetPartitionMax` | 1800 | Split communities larger than this |
| `maxSweepPartitions` | 15 | Maximum partitions to sweep per query |
| `minSweepPartitions` | 0 | Minimum partitions (0 = route by relevance only) |
| `partitionRelevanceThreshold` | 0.25 | Cosine similarity threshold for routing |
| `sweepMaxTokens` | 6000 | Token budget per sweep LLM call |
| `synthesisMaxTokens` | 16000 | Token budget for synthesis LLM call |
| `sweepFraction` | null | Fraction of routed partitions to sweep (0.1-1.0) |

## How It Works

### Phase 0: Partition (cached)

Louvain community detection partitions the graph into topologically meaningful communities. Small communities (<30 nodes) are merged into their most-connected neighbor. Large communities (>1800 nodes) are split via greedy bisection. Each partition is enriched with:

- **Centroid embedding** — element-wise mean of node embeddings (for routing)
- **Keywords** — top terms by document frequency
- **Adjacent partitions** — cross-partition edges (for outbound flags)
- **Quick summary** — top finding + keywords (no LLM call)

### Phase 1: Route

Cosine similarity between the query embedding and partition centroids ranks partitions by relevance. Broad queries ("comprehensive overview," "what's missing") bypass the threshold and sweep broadly. Without an embedding provider, all partitions (up to max) are swept.

### Phase 2: Sweep (parallel)

Each partition gets its own LLM call with **full-fidelity node content** — no compression, no tier reduction. The structured 4-section response contract:

1. **Domain State** — What this partition covers relative to the query
2. **Findings** — Discoveries with Node ID citations
3. **Outbound Flags** — Specific connections to other partitions
4. **Absences** — What was searched for and NOT found

### Phase 3: Synthesize

A single LLM call receives all sweep outputs simultaneously. Four synthesis tasks:

1. **Cross-Domain Connection Discovery** — Chase outbound flags across partitions
2. **Absence Detection** — Aggregate "not found" signals for high-confidence gaps
3. **Convergence Identification** — Independent findings across partitions = strong evidence
4. **Thesis Formation** — Make claims, commit to positions, rank insights

## Provider Examples

### OpenAI

```js
const engine = new PGSEngine({
  sweepProvider: makeOpenAIProvider('gpt-4o-mini'),
  synthesisProvider: makeOpenAIProvider('gpt-4o'),
  embeddingProvider: makeOpenAIEmbeddingProvider(),
});
```

### Anthropic

```js
const engine = new PGSEngine({
  sweepProvider: makeAnthropicProvider('claude-sonnet-4-20250514'),
  synthesisProvider: makeAnthropicProvider('claude-opus-4-20250514'),
});
```

### xAI

```js
const engine = new PGSEngine({
  sweepProvider: makeOpenAICompatibleProvider('https://api.x.ai/v1', XAI_KEY, 'grok-3-mini'),
  synthesisProvider: makeOpenAICompatibleProvider('https://api.x.ai/v1', XAI_KEY, 'grok-3'),
});
```

### Ollama Cloud

```js
const engine = new PGSEngine({
  sweepProvider: makeOpenAICompatibleProvider('https://ollama.com/v1', OLLAMA_KEY, 'qwen3'),
  synthesisProvider: makeOpenAICompatibleProvider('https://ollama.com/v1', OLLAMA_KEY, 'nemotron-3-super'),
});
```

See `examples/` for complete, runnable provider implementations.

## Best Use Cases

**Research Synthesis** — "What do we know about X, what's missing, what's contradictory?" PGS examines every partition, reports findings with citations, flags cross-domain connections, and explicitly identifies absences.

**Novelty Detection** — "What's surprising or unexpected?" Full-fidelity sweeps catch what top-K misses. Low-similarity-to-query but high-importance-in-partition content surfaces.

**Gap Analysis** — "What should we know but don't?" Structured absence aggregation. When 4 of 6 partitions report "no findings on X," that's a high-confidence gap.

**Deep Exploration** — "Tell me everything." Session-based incremental coverage. First pass covers top partitions, continue mode covers the rest. You know exactly what was examined.

**Cross-Domain Discovery** — "How does topic A relate to topic B?" Outbound flags identify connections spanning partition boundaries. The synthesis phase evaluates and follows them.

## Comparison to Existing Approaches

| Feature | Standard RAG | Microsoft GraphRAG | PGS |
|---|---|---|---|
| Retrieval method | Top-K by embedding | Leiden communities + reports | Louvain + full-fidelity sweep |
| Coverage awareness | No | Partial (community reports) | Full (session tracking, %) |
| Absence reporting | No | No | Yes (structured per partition) |
| Cross-domain discovery | No | Via community summaries | Yes (outbound flags + synthesis) |
| Convergence detection | No | No | Yes (independent findings across partitions) |
| Session continuity | No | No | Yes (continue/targeted modes) |
| Build mode | Batch (offline index) | Batch (offline index) | Online (partition at query time) |

## The Architecture Behind PGS

PGS operates on knowledge graphs built by [COSMO](https://github.com/cosmo-project), a research system that uses multi-agent orchestration with spreading-activation memory, Hebbian learning, and state-dependent Watts-Strogatz topology maintenance. The graphs aren't just collections of embeddings — they're structured knowledge with 13 semantic edge types, quality-gated ingestion, temporal decay, and consolidation. PGS was designed to query these rich structures, but works with any graph that has nodes with embeddings and edges with weights.

## License

MIT
