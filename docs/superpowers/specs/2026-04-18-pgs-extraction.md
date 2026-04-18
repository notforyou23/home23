# PGS Extraction & Adapter — Design Spec

**Date:** 2026-04-18
**Status:** drafting; Phase 3 prerequisite of the thinking-machine-cycle rebuild
**Author:** claude + jtr
**Parent:** `2026-04-18-thinking-machine-cycle.md` (Phase 3 blocker)
**Scope:** new `engine/src/cognition/pgs-adapter.js`, unified-client integration as sweep/synthesis provider, graph-format converter, token-budget + availability gating. Does not modify `cosmo23/pgs-engine/` itself.

---

## Problem

The thinking-machine-cycle spec (Phase 3: Connect) treats PGS as a first-class "always-on" phase of the autonomous pipeline. Today:

- PGS lives in `cosmo23/pgs-engine/` as a standalone npm-packaged engine.
- It's called *lazy-loaded from the dashboard query API* (not the engine cognitive loop).
- It requires explicit `sweepProvider` + `synthesisProvider` (LLM providers with `generate()` methods) passed to its constructor.
- It expects a specific graph format (TBD exactly — see *Graph Format* below).
- The dashboard gates it behind `enablePGSByDefault` in `home.yaml.query`, defaulting false.

The parent spec's Phase 3 description assumes PGS is callable from `engine/src/cognition/` with a simple `(thought, graphSnapshot) → {perspectives, candidateEdges, connectionNotes}` contract. That contract doesn't exist yet. This spec defines it.

---

## Goals

1. Engine autonomous loop can call PGS as part of every deep-thought cycle (Phase 3).
2. Adapter wraps Home23's unified-client as PGS's sweep/synthesis providers so PGS reuses all the multi-provider routing, rate limiting, and fallback logic already built.
3. Graph-format conversion is a single, testable seam (Home23 graph → PGS-expected format).
4. Token budget is enforced per call (cap: 10k input / 3k output across the PGS call).
5. Timeouts handled gracefully (90s hard cap; if PGS doesn't return, Phase 4 proceeds with empty connections).
6. Availability detection — if cosmo23 isn't running / pgs-engine isn't resolvable / the call throws, the phase returns empty and the critique phase is told.

---

## Non-goals

- Modifying `cosmo23/pgs-engine/` itself. It's a clean module; we adapt around it.
- Replacing the dashboard's existing PGS query path. That continues to work as-is for manual jtr queries.
- Caching synthesis across cycles (future work; for now every cycle recomputes).

---

## Adapter Contract

New module: `engine/src/cognition/pgs-adapter.js`

### Public API

```js
const { PGSAdapter } = require('./pgs-adapter');

const adapter = new PGSAdapter({
  unifiedClient,     // Home23's UnifiedClient instance
  logger,
  config,            // base-engine.yaml section
  memoryGraph,       // reference to Home23's NetworkMemory
});

const result = await adapter.connect({
  thought: '...',                 // deep-dive output
  referencedNodes: [...],         // node IDs the thought cites
  temporalContext: {...},         // from Phase 1 substrate
  budget: { maxTokensIn: 10000, maxTokensOut: 3000, timeoutMs: 90000 },
});

// result shape:
// {
//   available: true,
//   perspectives: [{ angle: string, searchResult: Node[] }],
//   candidateEdges: [{ from: NodeId, to: NodeId, rationale: string }],
//   connectionNotes: [{ text: string, nodeIds: NodeId[] }],
//   usage: { inputTokens, outputTokens, durationMs, partitionsTouched },
//   note: null | 'unavailable' | 'timeout' | 'budget_exceeded' | 'no_graph',
// }
```

### Error modes

- **PGS engine not installed / not resolvable** — return `{ available: false, note: 'unavailable', ...empty }`.
- **Graph conversion fails** — return `{ available: false, note: 'no_graph', ...empty }`.
- **Timeout** — abort, return `{ available: false, note: 'timeout', ...partial }`.
- **Budget exceeded mid-call** — abort at phase boundary, return `{ available: false, note: 'budget_exceeded', ...partial }`.
- **Unified-client error from any PGS-internal LLM call** — propagate as sweep/synthesis failure; PGS handles partition-level errors; adapter returns whatever PGS completes.

The adapter *never throws*. Phase 3's contract with Phase 4 is: PGS either succeeds, or returns empty with a note. Critique proceeds either way.

---

## Sweep & Synthesis Provider Wrappers

PGS requires objects exposing `generate({...})` — specifically a method that takes a prompt and returns text output. Home23's `UnifiedClient.generate()` already does this, but PGS's expected shape and UnifiedClient's shape differ slightly:

- UnifiedClient returns `{ content, reasoning, toolCalls, rawContent, ... }` (Phase 4 shape from yesterday's fix).
- PGS likely wants `{ text }` or just the string.

The adapter wraps UnifiedClient in a lightweight interface:

```js
function makeSweepProvider(unifiedClient, modelAssignment) {
  return {
    async generate(opts) {
      const response = await unifiedClient.generate({
        component: 'pgsSweep',
        purpose: 'partition',
        messages: [{ role: 'user', content: opts.prompt }],
        maxTokens: opts.maxTokens ?? 2000,
        temperature: opts.temperature ?? 0.3,
      });
      return { text: response.content || '' };
    },
  };
}
```

Two separate providers because PGS differentiates sweep (cheap, per-partition) from synthesis (more capable, single pass):

- `pgsSweep` model assignment — default MiniMax-M2.7 (cheap, fast, many calls)
- `pgsSynthesis` model assignment — default MiniMax-M2.7 (can be upgraded to higher-reasoning later via Settings → Models)

Both model assignments added to `configs/base-engine.yaml` `modelAssignments` block.

---

## Graph Format

Open question — resolved during implementation kickoff.

PGS's `execute(query, graph)` expects a specific graph shape. Possible formats (from skim of pgs-engine):

- Array of nodes with `{ id, content, embeddings?, edges: [...] }` shape
- Adjacency-list object
- Something specific to pgs-engine's Louvain partitioner

Home23's `NetworkMemory` exposes nodes, edges, and embeddings but in its own format. The adapter needs a converter:

```js
function toPgsGraph(home23Graph, focusNodes) {
  // Option A: full graph — send everything, let PGS partition
  // Option B: focused subgraph — traverse N hops from focusNodes, send that slice
  //   (cheaper, more relevant, but risks losing cross-partition signal that's the whole point of PGS)
  // Decision: Option A, capped at N=5000 nodes. If graph larger, degrade to Option B with N=2 hops.
}
```

Decision during kickoff: read `cosmo23/pgs-engine/src/partitioner.js` and `index.js` to confirm expected input shape. Converter unit-tested against at least one known graph before wiring into the adapter.

---

## Token Budget & Caching

### Per-call budget

| Bound | Default | Rationale |
|-------|--------:|-----------|
| Max input tokens across all PGS LLM calls | 10,000 | Cap on how much graph material gets swept per cycle |
| Max output tokens across all PGS LLM calls | 3,000 | Caps candidate-edge / connection-note volume |
| Hard timeout | 90s | If PGS can't return in 90s, abort (critique proceeds) |
| Max partitions swept | 8 | Controls breadth; beyond this, diminishing returns per cycle |
| Max candidate edges returned | 10 | Critique gets a manageable set, not a flood |

Budgets enforced by the adapter, not PGS itself. Implementation: pre-call audit (estimate prompt tokens), per-phase check (fail early if budget will be exceeded), output truncation.

### Caching (future, not Phase 3)

PGS is expensive. Many cycles may probe the same graph region. A sub-follow-up could cache partition results (Louvain output) keyed on graph hash + timestamp, expiring after M hours. Not Phase 3 scope; noted for the roadmap.

---

## Availability Detection

On adapter construction:

```js
let pgsEngine;
try {
  const pgsModule = require('pgs-engine');
  pgsEngine = new pgsModule.PGSEngine({...});
  this.available = true;
} catch (err) {
  this.logger?.warn('[pgs-adapter] PGS engine unavailable', { reason: err.message });
  this.available = false;
}
```

If `available === false`, every `connect()` call immediately returns `{ available: false, note: 'unavailable', ...empty }`. Logged once at boot, not per-cycle (avoid log spam).

### Dependency wiring

`cosmo23/pgs-engine` is a local directory, not a published npm package. Options:

- **Option A:** Add `"pgs-engine": "file:../cosmo23/pgs-engine"` to engine's package.json. Requires path stability.
- **Option B:** `require()` via absolute path from engine code. Brittle.
- **Option C:** Vendor a copy under `engine/vendor/pgs-engine/`. Duplication, but engine stays self-contained.

Decision during kickoff: lean Option A (file: dependency) for minimal duplication. Path is stable within the Home23 repo.

---

## Observability

Adapter emits structured logs for every call:

- `[pgs-adapter] invoked` — cycle, referenced node count, graph size
- `[pgs-adapter] partition cached` / `[pgs-adapter] partitioning` — cold vs warm
- `[pgs-adapter] sweep complete` — partitions swept, tokens used
- `[pgs-adapter] synthesis complete` — tokens used, candidate edges produced
- `[pgs-adapter] result` — available, note, durationMs, usage

Metrics for dashboard observability panel (per parent spec's Observability section):

- PGS call count / day
- Average duration
- Timeout rate
- Budget-exceeded rate
- Unavailable rate
- Candidate edges produced per cycle (mean, distribution)

---

## Integration Surface

The adapter is constructed by the orchestrator at boot (or lazily on first Phase 3 call) and held on the cognition pipeline instance. Phase 3 calls it:

```js
// inside engine/src/cognition/pipeline.js (future Phase 3 module)
const pgsResult = await this.pgsAdapter.connect({
  thought: deepDiveOutput.text,
  referencedNodes: deepDiveOutput.referencedNodes,
  temporalContext: cycleTemporalContext,
  budget: PGS_DEFAULT_BUDGET,
});

if (!pgsResult.available) {
  this.logger.info('[phase-3] PGS unavailable', { note: pgsResult.note });
}
// Pass pgsResult into Phase 4 critique regardless — critique handles both cases.
```

---

## Failure Modes Covered

| Failure | Adapter behavior |
|---------|------------------|
| pgs-engine module not installed | `available: false, note: unavailable` |
| Graph too large for conversion | degrade to focused subgraph (2-hop from focus nodes) |
| Focus nodes missing from graph | `available: false, note: no_graph` |
| Token budget exceeded mid-call | abort, return partial with `note: budget_exceeded` |
| 90s timeout | abort, return partial with `note: timeout` |
| Sweep or synthesis LLM call fails | PGS internal error handling; adapter returns whatever succeeded |
| Pipeline restarted mid-cycle | stateless; next cycle re-runs |

---

## Implementation Phasing (verification gates, no calendar)

1. **Exploration** — read `cosmo23/pgs-engine/src/index.js`, `partitioner.js`, `sweeper.js`, `synthesizer.js`. Confirm input graph shape, provider interface, failure modes. Unit-test PGSEngine against a tiny synthetic graph to verify it actually runs in-process. **Gate:** we can call PGS from a script and get a result.
2. **Graph converter** — write `toPgsGraph(home23Graph, focusNodes)`. Unit test against Home23's NetworkMemory with a small graph. **Gate:** round-trip test passes; PGS accepts the converted graph.
3. **Provider wrappers** — `makeSweepProvider` / `makeSynthesisProvider` wrapping UnifiedClient. **Gate:** PGS can call generate() through the wrappers and get usable text.
4. **Adapter construction + availability detection** — boot path, graceful unavailable behavior. **Gate:** missing PGS module → `available: false`; present → `available: true`.
5. **Budget + timeout enforcement** — wrap with budget audit and AbortSignal. **Gate:** synthetic over-budget call aborts cleanly.
6. **Observability** — logs and metrics wired. **Gate:** observability panel shows non-zero PGS stats after a Phase 3 test call.

Each gate passes or the adapter isn't done. Build fast and right, fix fast.

---

## Open Decisions

- Graph format specifics (resolve during Phase 1 of this spec's implementation — requires reading pgs-engine source)
- Dependency wiring (file: dep vs vendored copy — lean file: dep)
- Whether to cache partitions across cycles (defer; not Phase 3)
- Whether sweep and synthesis should share a model or split (start same, split later if warranted)

---

## Notes

- This is an adapter spec, not a PGS internals spec. `cosmo23/pgs-engine/` stays untouched.
- If PGS turns out to require modifications to its own code for Home23 autonomous use, that's a separate sub-sub-spec and a much bigger discussion.
- Adapter should feel *boring* — wrap existing tools cleanly, enforce limits, report clearly, never crash the pipeline.
