# CLAUDE.md — Memory & Query System (lib/ + engine/src/memory/)

This file provides guidance to Claude Code (claude.ai/code) when working on the COSMO 2.3 memory, query, and semantic search subsystems.

---

## System Map

```
lib/query-engine.js         ← Main orchestrator (QueryEngine class)
lib/brain-query-engine.js   ← Thin wrapper for .brain packages
    ├── loadBrainState()      reads state.json.gz
    ├── queryMemory()         hybrid semantic + keyword scorer
    ├── queryThoughts()       hybrid scorer over thoughts.jsonl
    └── buildContext()        assembles LLM prompt context
        ├── lib/pgs-engine.js              Partitioned Graph Synthesis
        ├── lib/coordinator-indexer.js     Coordinator review index
        ├── lib/evidence-analyzer.js       Evidence scoring (opt-in)
        ├── lib/insight-synthesizer.js     Pattern detection (opt-in)
        ├── lib/query-suggestions.js       Suggestion generation
        ├── lib/brain-semantic-search.js   Semantic search for .brain packages
        └── lib/brain-exporter.js          Export brain to MD/BibTeX/JSON

engine/src/memory/network-memory.js   ← Live knowledge graph (during runs)
engine/src/memory/summarizer.js       ← Memory consolidation (during runs)
```

---

## Knowledge Graph Architecture (NetworkMemory)

**File:** `engine/src/memory/network-memory.js`

### Node Structure
```js
{ id, concept, summary, keyPhrase, tag, embedding (Float32[512]),
  activation (0-1), cluster, weight (0-1), created, accessed, accessCount,
  consolidatedAt, sourceRuns, mergedAt, domain }
```

Node IDs can be numeric OR string (merged brains use `"{prefix}_{n}"`). Always use `String(id)` for comparisons.

### Quality Gate
`classifyContent()` runs before every `addNode()`. Nodes classified as `operational` or `garbage` are silently dropped. Null embeddings also rejected.

### Edge Types (Graph-RAG)
`ASSOCIATIVE`, `BRIDGE`, `TRIGGERED_BY`, `CAUSED_BY`, `RESOLVED_BY`, `CONTRADICTS`, `VALIDATES`, `REFINES`, `SYNTHESIZES`, `SUPERSEDES`, `DEPENDS_ON`, `EXECUTED_BY`, `PRODUCED`. Auto-inferred from tag combinations via `inferEdgeType()`.

### Graph Growth
1. `addNode(concept, tag)` → quality gate → embed (512-dim) → `formInitialConnections()` (top 3 nodes with similarity > 0.5) → `assignToCluster()`
2. Re-activation reinforces edges via Hebbian learning (weight capped at 1.0)

### Spreading Activation
BFS from seed node, activation decays by `edge.weight * decayFactor`. Used in live-run queries.

---

## Memory Consolidation (MemorySummarizer)

**File:** `engine/src/memory/summarizer.js`

### Summarization
Triggered when journal ≥ 20 entries. GPT-5.2 at `reasoningEffort: 'low'`. Excludes operational details, includes discoveries and connections. Supports up to 3 levels of recursive hierarchical summarization.

### Consolidation
Triggered when nodes ≥ 10. Greedy clustering at cosine similarity ≥ 0.75. Clusters with ≥ 3 members synthesized by GPT-5.2. Source nodes stamped with `consolidatedAt` to prevent re-processing.

### Garbage Collection
Ultra-conservative: NEVER deletes nodes with `consolidatedAt`, `sourceRuns`, `mergedAt`, or protected tags (`agent_insight`, `breakthrough`, `synthesis`, `goal`, `milestone`, etc.). Only deletes if weight < 0.01 AND not accessed in ≥ 730 days.

---

## Query Engine

**File:** `lib/query-engine.js`

### Construction
`new QueryEngine(runtimeDir, openaiKey)`. Loads `state.json.gz`, `thoughts.jsonl`, `run-metadata.json`. Without `openaiKey`, semantic search disabled but keyword search works.

### `queryMemory()` Scoring
```
semanticScore = cosineSimilarity(query, node) * 100
keywordScore  = exact-phrase (+50) + word matches (+3 * weight), capped at 100
combinedScore = semantic * 0.7 + keyword * 0.3
              *= (0.5 + activation * weight)   // importance multiplier
```

Tag boosts: `agent_finding` x1.5, `breakthrough` x1.6, `research` x1.4. Penalties: `agent_insight` x0.6, `meta` x0.5. Multi-source validation: +15% per additional source run.

### Query Modes

| Mode | reasoningEffort | maxTokens | Node Limit |
|---|---|---|---|
| `quick` | low | 10000 | 150 |
| `full` | medium | 20000 | 400 |
| `expert` | high | 30000 | 800 |
| `dive` | high | 32000 | 1000 |

Each mode has a distinct system prompt. Merged brains get 1.3x node limit boost.

### Model Routing
Provider inferred from model ID. Clients: `anthropicClient`, `xaiQueryClient`, `localQueryClient`, `gpt5Client`. Auto-fallback to local LLM if OpenAI unavailable.

### Follow-up Queries
When `priorContext = { query, answer }` provided, prepends conversation context (truncated to 50K chars).

### Cache
In-memory LRU (max 50). Key: `stateHash:query:model:mode`. Invalidated when brain state changes.

---

## PGS Engine (Partitioned Graph Synthesis)

**File:** `lib/pgs-engine.js`

For large graphs where a single LLM call can't cover all nodes. Four phases:

### Phase 0: Partition (cached)
Louvain community detection (pure JS, up to 20 iterations). Small communities merged (min 30 nodes). Large communities bisected (max 1800). Cache key: `nodeCount:edgeCount:cycleCount:timestamp`.

### Phase 1: Route
Cosine similarity between query embedding and partition centroid embeddings. Threshold: 0.25. Broad queries (`/comprehensive.*overview/i`) bypass routing.

### Phase 2: Sweep
Batches of 5 concurrent. Sweep model is configurable per-query via `pgsSweepModel` option (UI has dedicated sweep model selector). Falls back to catalog default (`pgsSweepModel` in model-catalog.json), then to the synthesis model. Uses `QueryEngine.resolveQueryRuntime()` for multi-provider routing (supports all providers including Ollama Cloud). Each partition gets full-fidelity node context. Structured 4-section response: Domain State, Findings, Outbound Flags, Absences.

### Phase 3: Synthesize
User's selected synthesis model (separate selector in PGS UI) at `reasoningEffort: 'high'`, 16k tokens. Also routes via `resolveQueryRuntime()`. Cross-domain connection discovery, absence detection, convergence identification, thesis formation.

### Session Tracking
Stored at `pgs-sessions/{sessionId}.json`. Modes: `full` (default), `continue` (unsearched only), `targeted` (re-route among unsearched).

---

## Brain Semantic Search

**File:** `lib/brain-semantic-search.js`

Brute-force cosine similarity over all nodes (no HNSW index). Embeddings cached in-memory, generated lazily on first search. Batch size: 20 nodes, 100ms delay for rate limits. Min similarity: 0.3. Falls back to keyword search on embedding API failure.

---

## Coordinator Indexer

**Files:** `lib/coordinator-indexer.js`, `lib/brain-coordinator-indexer.js`

Indexes coordinator review markdown files (`coordinator/review_*.md`). Extracts insights, recommendations, patterns from sections. Embeddings generated same pipeline (text-embedding-3-small, 512 dims). 5-minute cache. Used by QueryEngine for `coordinatorInsights` metadata.

---

## Evidence Analyzer (`lib/evidence-analyzer.js`)

Opt-in via `includeEvidenceMetrics: true`. Produces: coverage (% of nodes relevant), confidence (activation × weight with tag boosts), consensus (cluster mode — participation rate), temporal analysis (recency bias, distribution), gap detection.

---

## Insight Synthesizer (`lib/insight-synthesizer.js`)

Opt-in via `enableSynthesis: true`. Pure statistical/heuristic, no LLM. Detects: temporal patterns (recurring themes, trends), concept clusters (tag+word overlap), breakthroughs (tag + activation × weight ≥ 0.75).

---

## Query Suggestions (`lib/query-suggestions.js`)

Up to 10 ranked suggestions from 5 categories: temporal, causal, breakthrough, comparative (cluster), meta (coordinator). Max 3 per category. Priority-ranked.

---

## Brain Exporter (`lib/brain-exporter.js`)

Three formats: Markdown (nodes grouped by tag, max 100), BibTeX (single `@misc` entry), JSON (nodes + optional edges, max 1000). Also `exportQueryAnswer()` for wrapping query results.

---

## The Embedding Pipeline

**Model:** `text-embedding-3-small`, 512 dimensions. Locked — not user-configurable in v1.

**Live run:** `addNode()` → `classifyContent()` → truncate to 8k tokens → `openai.embeddings.create()` → `formInitialConnections()` (cosine vs all existing)

**Query-side:** `getEmbedding(query)` → truncate to 8k chars → same model → cosine against all node embeddings (inline from state.json.gz or from embeddings-cache.json)

**PGS:** Same query embedding → cosine against partition centroid embeddings (element-wise mean of node embeddings)

---

## Key Invariants

- **Embeddings can be null.** Always guard `if (!node.embedding)` before cosine similarity.
- **Node IDs are mixed types.** Use `String(id)` for Map lookups.
- **Meta-noise filtered.** Nodes tagged `dream`, `reasoning`, `introspection` excluded in queryMemory.
- **PGS cache is brain-hash-dependent.** Any state change invalidates partitions.
- **GC never runs during query.** Query layer is read-only.
- **Merged brains use stratified sampling** (`getSourceDiverseNodes()`) for balanced representation.
- **Coordinator indexer cache is 5 minutes.** May be stale in long sessions.
