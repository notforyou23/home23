# Brain Retrieval Grounding Repair Implementation Plan

Date: 2026-07-14
Design: `docs/superpowers/specs/2026-07-14-brain-retrieval-grounding-design.md`

## Current measured baseline

- Jerry manifest: native manifest-v1, revision gap 14,228 records, 142,910 nodes, 468,959 edges, 30 clusters.
- Jerry ANN: revision 1891463280844112; current source revision 1891463280858340.
- Distinct delta-upserted nodes: 2,736; all have embeddings.
- Opening the ephemeral authoritative source and rebuilding its 195 MB overlay took 21.3 seconds before search.
- Current stale route performs a full semantic source scan and another keyword traversal.
- Cluster 1 contains 119,179 current live nodes and mixes operational, historical, synthesized, and external material.

## Task 1: Incremental manifest delta overlay cache

**Files**

- Create: `engine/src/dashboard/memory-delta-overlay-cache.js`
- Modify: `shared/memory-source/jsonl.cjs`
- Modify: `shared/memory-source/manifest.cjs`
- Test: `tests/engine/dashboard/memory-delta-overlay-cache.test.js`
- Test: `tests/shared/memory-source-jsonl.test.js`

**Contract**

Create a dashboard-owned derived cache under requester runtime, never under the target brain. It is keyed by canonical root, generation, active delta epoch, delta file identity, and committed byte cutoff. It stores latest node upserts and node tombstones; edge-only revisions advance coverage without invalidating node vectors.

The refresh path validates the manifest, stable nonsymlink delta identity, contiguous epoch/sequence/revision, and complete committed prefix. An unchanged key is O(1). A larger committed cutoff imports only the appended complete JSONL range. Generation, epoch, file identity, cutoff regression, a gap, or a malformed record invalidates the cache and performs a bounded rebuild. Concurrent refreshes serialize; readers receive immutable snapshot views. Disk and record limits reuse the shared source limits.

**TDD sequence**

1. Add failing tests for first load, O(1) reuse, suffix-only extension, edge-only revisions, same-ID replacement, tombstone, epoch invalidation, corrupt/gapped suffix, abort, concurrent refresh, and requester-owned placement.
2. Run the focused tests and record the expected red failures.
3. Implement the smallest parser/cache surface.
4. Run focused tests and `git diff --check`.

## Task 2: ANN plus delta search coverage

**Files**

- Modify: `engine/src/dashboard/memory-search.js`
- Modify: `shared/ann-label-contract.cjs`
- Modify: `tests/engine/dashboard/memory-search.test.js`
- Modify: `tests/engine/dashboard/memory-search-heap-probe.cjs`
- Modify: `tests/shared/ann-label-contract.test.cjs`

**Contract**

Load an ANN from the same generation when `baseRevision <= builtFromRevision <= currentRevision`. Suppress ANN labels for every node changed or removed in the cached overlay, exact-score current delta upserts, and merge through one bounded candidate heap. Edge-only delta records do not force node rescoring.

Keyword supplementation is overlay-first and then uses bounded ANN labels. A full logical source scan occurs only when ANN/metadata is missing, corrupt, dimension-incompatible, or an explicit exhaustive/absence-proof request requires it. Every response reports indexed revision, covered-through revision, delta records, distinct changed/upserted/removed nodes, route, completeness, and stage timings.

Extend ANN labels only with bounded retrieval-domain, authority-class, semantic-time, status, and evidence-presence summaries. Full source chains are post-hydrated from the delta record when available or exposed as bounded refs already present in the label; never embed unbounded provenance in the ANN metadata.

**TDD sequence**

1. Replace the stale-ANN/full-scan expectation with failing overlay cases: delta-only canary, updated-ID shadow, tombstone, edge-only revision, ANN keyword plus delta keyword, explicit exhaustive fallback, timing evidence, and no base iteration on the common route.
2. Run focused tests red.
3. Implement using Task 1 snapshots.
4. Run focused search/heap/label tests green.

## Task 3: Publish bridgeable ANN revisions and truthful rebuild receipts

**Files**

- Modify: `shared/memory-source/writer.cjs`
- Modify: `engine/src/merge/build-ann-index.js`
- Modify: `scripts/rebuild-ann-indexes.sh`
- Modify: `tests/shared/memory-source-writer.test.js`
- Modify: `tests/engine/merge/build-ann-index.test.js`
- Modify: `tests/scripts/rebuild-ann-indexes.test.cjs`

**Contract**

Allow ANN revision R to publish when the generation/base/epoch are unchanged, the active delta bridges R through current C, and publication does not regress a newer ANN. Reject generation/epoch changes, missing coverage, or regression. The builder reports `fresh` or `overlay-covered`; it never prints a stale success.

The wrapper prints a bounded JSON receipt per agent with built revision, current revision, bridgeable gap, index count, stage durations, and semantic coverage. Any attempted build that fails to publish/validate exits nonzero. Sustained-gap alert state is stored in ignored requester runtime and alerts after the configured consecutive threshold; a single ordinary lag is not an alarm.

**TDD sequence**

1. Add failing tests for same-generation advance publication, newer-index regression refusal, epoch change rejection, structured wrapper receipt, and semantic failure propagation.
2. Run red; implement; run green.

## Task 4: Shared retrieval authority profile and ranking

**Files**

- Modify: `engine/src/memory/provenance-salience.js`
- Modify: `engine/src/memory/network-memory.js`
- Modify: `engine/src/memory/active-clusters.js`
- Modify: `engine/src/cognition/discovery-engine.js`
- Modify: `tests/engine/memory/provenance-salience.test.js`
- Modify: `tests/engine/memory/network-memory-temporal.test.js`
- Create: `tests/engine/memory/active-clusters.test.js`
- Create: `tests/engine/cognition/discovery-engine-authority.test.js`

**Contract**

Add pure `classifyMemoryDomain`, `classifyClaimAuthority`, `projectSourceChain`, and `scoreMemoryAuthority` functions. All retrieval paths use them. Semantic time prefers source/assertion/report/resolution time over ingestion creation time. The four domains are current_ops, closed_incidents, project_history, and external_intake. The six public provenance classes are verified_current_state, jtr_correction, artifact_log, worker_receipt, generated_doctrine, and narrative.

Current-state intent demotes project history and external intake. History/recurrence intent may retrieve them. External intake has short decay. Unknown/generated report material cannot receive present-tense authority. Active-cluster and discovery selection apply the same eligibility policy so access recency/orphan age cannot bypass it.

**TDD sequence**

1. Add the four acceptance canaries and route-bypass tests red.
2. Implement the pure profile/scorer.
3. Integrate network query, active clusters, discovery, and Task 2 search.
4. Run focused suites green.

## Task 5: Closure receipts become negative active-state evidence

**Files**

- Modify: `engine/src/goals/goal-curator.js`
- Create: `tests/engine/goals/goal-curator-resolution.test.js`
- Extend: `tests/engine/memory/network-memory-temporal.test.js`

**Contract**

Completion and archive emit a goal-resolution receipt even when no narrative exists. Retrieval builds a bounded closure index by goal/incident/source references. A newer verified closure annotates or suppresses the older open-alarm candidate for current-state intent; the closure itself remains eligible and ranks first for resolution/recurrence intent.

Write failing tests first, implement, and run focused suites.

## Task 6: Preserve provenance on future ingestion and generated content

**Files**

- Modify: `engine/src/ingestion/document-feeder.js`
- Modify: `engine/src/ingestion/document-compiler.js`
- Modify: `engine/src/ingestion/ingestion-manifest.js`
- Modify: `engine/src/channels/memory-ingest.cjs`
- Modify: `src/agent/memory-objects.ts`
- Modify: `src/types.ts`
- Modify: `tests/engine/ingestion/document-feeder-policy.test.js`
- Modify: `tests/engine/ingestion/ingestion-manifest-mutation-barrier.test.js`
- Modify: `tests/engine/channels/memory-ingest.test.js`

**Contract**

Use additive `home23.node-provenance.v1` metadata. Compiled synthesis, generated reports, Query/PGS prose, and narrative summaries are always narrative unless a separate adopted-doctrine receipt justifies generated_doctrine. Preserve raw source path/hash, generation method, semantic event time, source/evidence refs, derived node IDs, scope, expiry, operational-authority boolean, and fresh-verification requirement within bounded limits.

Direct current observations require verifier evidence to become verified_current_state. jtr corrections are authoritative for intent/preferences/scoped semantic correction but still cannot certify volatile machine state without a live verifier.

Write failing policy/persistence tests first, then implement without rewriting existing live nodes.

## Task 7: Query, PGS, notebook, MCP, and agent-tool parity

**Files**

- Modify: `cosmo23/lib/query-engine.js`
- Modify: `cosmo23/lib/pgs-engine.js`
- Modify: `engine/src/dashboard/query-notebook-service.js`
- Modify: `shared/memory-source/mcp-tools.cjs`
- Modify: `src/agent/tools/brain.ts`
- Test: matching Query/PGS/notebook/MCP/agent brain-tool suites

**Contract**

Preserve the bounded provenance/domain/source-chain and index-coverage evidence through every adapter. Query/PGS prompts state that narrative/generated doctrine cannot independently settle present-tense operational facts. “Canonical” continues to mean pinned/selected operation output, never verified claim authority. Existing response fields remain backward compatible; new evidence is additive.

Write failing parity tests first, implement, and run all matching focused suites.

## Task 8: Non-destructive provenance and compost audit

**Files**

- Create: `scripts/audit-brain-provenance.cjs`
- Create: `tests/scripts/audit-brain-provenance.test.cjs`
- Modify: `package.json`

**Contract**

Open a pinned source read-only, retain a bounded high-activation heap plus mandatory risk strata, and write a requester-owned JSONL report keyed by source revision, node ID, and content hash. Include proposed class/domain, reason, confidence, missing evidence, and review requirement. Never invoke query/access mutation, patch/remove a node, rewrite a base, or alter a cluster.

Run it against Jerry and Forrest in dry-run mode after tests. Existing consolidation compost remains dry-run only in this rollout; no node deletion is authorized.

## Task 9: State projection, automated verification, live acceptance, and receipt

**Files**

- Modify: `engine/src/dashboard/server.js`
- Modify/create focused state projection test
- Create: `docs/receipts/2026-07-14-brain-retrieval-grounding.md`
- Create: `.verification/brain-retrieval-grounding/<dated evidence files>` (ignored runtime evidence)

**Contract and sequence**

1. Fix `/api/state` to use manifest summary clusterCount when the optional snapshot omits it.
2. Run the smallest focused suites after each task.
3. Run `npm run build`, `npm run test:contracts`, the complete brain/search/Query/PGS suites, then `npm test` with required workspace dependency roots.
4. Capture before/after source-open and search stage timings without mutating brain content.
5. Build and publish bridgeable ANN indexes only after code tests pass. Preserve prior ANN files and manifest evidence.
6. Restart only engines/dashboards/harnesses/MCP processes whose loaded code changed; never use broad PM2 commands.
7. Run wait-aware live canaries for recent claim, corrected claim, closure receipt, and old archive against Jerry and Forrest. Verify dashboard, MCP, agent brain tools, Query, and every PGS mode preserve the evidence envelope.
8. Run provenance/compost audits dry-run only and record counts.
9. Write a dated receipt with exact commits, routes, revisions, latency, process state, test counts, retained negative evidence, and remaining limits.

## Parallel execution boundary

After this plan is committed:

- Subagent A owns Tasks 1-3 (index/cache/builder) in one coherent slice.
- Subagent B owns Tasks 4-5 and the Task 9 cluster-count projection (authority/closure/state).
- Subagent C owns Task 6 and Task 8 (future provenance plus read-only audit).
- The integration owner reviews and lands each slice, then completes Task 7 and live acceptance because those depend on the first three slices.

Agents must not edit the user-owned `scripts/refresh-synthesis.cjs`, `.system-verifier/`, or unrelated `.verification/` content. Each implementation task follows red-green TDD and receives a spec-compliance review followed by a code-quality review before integration.
