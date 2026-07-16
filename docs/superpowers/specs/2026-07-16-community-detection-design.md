# Graph Community Detection for Agent Brains — Design

**Date:** 2026-07-16
**Status:** Approved by jtr (approach + design sections), pending spec review
**Owner:** Home23 engine (`engine/src/memory/`), applies to every agent identically

## 1. Problem

Every Home23 brain to date has all nodes in a single cluster (`"1"`). Nothing in the
engine has ever partitioned an existing cluster:

- `engine/src/memory/recluster.js` only assigns **unclustered** nodes (neighbor-vote +
  connected components). On a fully-clustered brain it reports nothing to do.
- The brain map rendered one green ball until 2026-07-16, when a tag-grouping
  fallback shipped (`home23-brain-map.js`, `useTagCommunities`). That is a rendering
  workaround, not organization.
- PGS partitioning (`shared/memory-source/pgs-partitions.cjs`) keys partitions off
  `node.cluster` → one partition holds essentially the whole brain (~24% skew noted
  in the retrieval investigation).
- `active-clusters.js` ("recent active knowledge clusters" cognition context) and
  `conversation-salience.js` (per-cluster salience scoring) are structurally
  meaningless with one cluster.

The fix: engine-level community detection that assigns cluster ids from actual edge
structure — organic, stable, agent-agnostic, persisted through the standard delta
layer, consumed downstream with zero changes.

## 2. Decisions (made with jtr, 2026-07-16)

| Decision | Choice |
|---|---|
| Algorithm | **Seeded label propagation** (approach A). Louvain/Leiden rejected (heavier, churny between runs, no quality edge at 23k nodes). Embedding clustering rejected (ignores edge structure; duplicates ANN). |
| Cadence | **Nightly + manual.** Scheduled nightly pass per agent at 03:45 ET (before the 04:30 ANN rebuild), plus on-demand via admin endpoint. |
| Granularity | **Organic with a floor.** No target community count. Communities smaller than `minCommunitySize` (default 12) fold into their best-connected neighbor. Genuinely isolated components survive at any size — they are real islands. |
| Honesty | If the graph is one dense blob, report 1–2 communities and say so. No faked granularity (no-backend-magic rule). |
| Event rule | A run that moves zero nodes produces **no receipt, no apply, no persistence generation advance**. |
| Scope | Any agent: the driver loops `instances/*/config.yaml`. jerry and forrest first, future agents automatically. |

## 3. Component 1 — planner: `engine/src/memory/community-detection.js`

Pure module, no side effects, mirroring `recluster.js`'s exports shape.

```
planMemoryCommunities(memory, options = {}) -> plan
```

**Options** (all defaulted, all overridable):
- `maxIterations` (default 20)
- `bridgeVote` (default `memory?.config?.spreading?.bridgeTraversalFactor ?? 0.2`) —
  the same discount `planMemoryRecluster` already applies to `type === 'bridge'`
  edges (Watts–Strogatz dream-rewiring shortcuts must whisper, not fuse communities)
- `minCommunitySize` (default 12)
- `minEdgeWeight` (default 0) — optional noise floor; edges below it don't vote

**Seeding (stability first):**
1. If the brain already has **more than one** distinct non-null cluster id, seed each
   node's label from `node.cluster`. Subsequent nightly runs therefore only move
   nodes whose neighborhood genuinely changed.
2. Otherwise (virgin one-cluster or unclustered brain), seed by `node.tag`: nodes
   sharing a tag start with a shared label (tags are honest provenance — the map's
   tag-fallback showed these are the natural constellations). Untagged nodes seed as
   singletons (own node id).

**Propagation:** iterate nodes in ascending sorted id order (string compare of
`String(id)`), asynchronous updates (each node sees neighbors' current labels).
Each node adopts the label with the highest summed incoming vote:
`vote = edge.weight × (edge.type === 'bridge' ? bridgeVote : 1)`, both directions
of each edge counted for both endpoints. Ties break to the **smallest label**
(string compare). Stop at zero moves in a full pass or at `maxIterations`.
Asynchronous sorted-order updates + deterministic tie-breaking make the result
reproducible and prevent the bipartite oscillation label propagation is prone to
under synchronous updates. The plan records `converged: boolean` and `iterations`.

**Floor:** repeatedly fold any community with fewer than `minCommunitySize` members
into the neighboring community with the highest total connecting edge weight
(bridge discount still applied). A small community with **no** external edges is a
real island and survives.

**Id stability:** map each detected community to the prior cluster id from which it
inherited the **plurality** of its members. Each prior id is claimable by only one
community (largest overlap wins; ties break to the community with more members,
then smallest member id). Unmatched communities get `clusterId: null` in the plan —
fresh ids are allocated at apply time by the memory API, never invented by the
planner.

**Plan shape:**
```js
{
  communityCount, movedNodes, unchanged,          // unchanged === (movedNodes === 0)
  converged, iterations,
  communities: [{ clusterId /* number|null */, members: [nodeId, ...] }],
  sizes: [{ clusterId, size }],                    // sorted desc
  sample: [{ id, from, to, preview }],             // first 20 moved nodes
}
```

## 4. Component 2 — mutation: `NetworkMemory.applyCommunityPlan(plan)`

New method in `engine/src/memory/network-memory.js`, immediately after
`applyReclusterPlan` (~line 1355), following its exact discipline:

1. **No-op guard before the barrier:** if no member's current `node.cluster`
   differs from its community's target, return
   `{ movedNodes: 0, createdClusters: 0, communityCount }` **without** entering the
   persistence barrier or advancing the generation.
2. Under `withPersistenceBarrier`:
   - for each community: `clusterId = plan.clusterId ?? this._allocateClusterIdUnsafe()`
     (allocation also `_advancePersistenceGenerationUnsafe`, matching
     `applyReclusterPlan`);
   - for each member whose cluster differs: `this._moveNodeToClusterUnsafe(nodeId, clusterId)`
     — which maintains the `clusters` map, deletes emptied clusters, and marks the
     node dirty so the change is captured as an ordinary **delta record**
     (`upsert_node`), surviving the 6-hour rebase, restart, and cold load.
3. Return `{ movedNodes, createdClusters, communityCount }`.

No new persistence machinery. `manifest.summary.clusterCount` updates on the next
save automatically.

`recluster.js`-style wrapper in the new module:
`applyMemoryCommunities(memory, plan)` throws `memory_communities_mutation_api_required`
if the method is missing (matches `applyMemoryRecluster`'s guard pattern).

## 5. Component 3 — endpoint + nightly driver

**Endpoint** in `engine/src/realtime/websocket-server.js`, sibling of
`/admin/memory/cleanup/recluster` (~line 620): `/admin/memory/cleanup/communities`.
- `GET` or `POST mode=dry-run` → plan stats (counts, sizes, sample, converged),
  never mutates.
- `POST mode=apply` → `this._backupBrainSidecars('brain-communities')` →
  `applyMemoryCommunities` → `orchestrator.saveState()` → receipt
  `{ ok, mode, backup, movedNodes, createdClusters, communityCount, converged }`.
- If the dry-run plan has `unchanged: true`, apply returns without backup, save, or
  receipt content beyond `{ ok: true, unchanged: true }` (event rule).
- Query/body passthrough for `minCommunitySize`, `maxIterations` (bounded:
  1 ≤ maxIterations ≤ 100, 2 ≤ minCommunitySize ≤ 500).

**Driver** `scripts/run-community-detection.sh` (the `rebuild-ann-indexes.sh`
shape): loop `instances/*/config.yaml`, read `ports.engine` (realtime port), for
each agent: GET dry-run → if `unchanged` or `movedNodes === 0`, print one skip line
and continue (silent success, loud failure); else POST apply and print one line
with `movedNodes/communityCount`. Engine unreachable or 503 source-busy → log,
non-zero exit only on hard failure (the ANN script's `record_health` receipt
pattern is reused if convenient, else one JSON line per agent).

**Cron:** one entry in `config/cron-jobs.json`, id `community-detection-nightly`,
`45 3 * * *` America/New_York, `kind: exec`,
`bash scripts/run-community-detection.sh`, `delivery.mode: failures` — before the
04:30 ANN rebuild so the map and PGS are coherent by morning. Manual anytime via
the endpoint.

## 6. Downstream — explicitly zero changes

| Consumer | Effect |
|---|---|
| PGS (`pgs-partitions.cjs` `partitionIdForNode`) | Partitions become `c-<communityId>` on the next listing. No code change. |
| Brain map (`home23-brain-map.js`, shipped 2026-07-16) | Auto-switches from tag-grouping to real clusters when `clusterCount > 1`. No code change. |
| `active-clusters.js` | "Top recent clusters" context becomes a real signal. No code change. |
| `conversation-salience.js` | Per-cluster salience becomes meaningful. No code change. |
| New nodes intraday | Born `cluster: null` (`network-memory.js:787`), participate in the next nightly pass as singleton seeds and get adopted by their neighborhood. Interim: map's existing fallback handles null; PGS hashes null-cluster nodes into `h-` buckets for at most a day. Accepted. |

## 7. Failure handling and risks

- **Dense blob:** 1–2 communities is honest output; report it, don't tune it away.
- **First apply is large:** repartitioning jerry moves ~22.7k nodes → ~22.7k delta
  records in one append. The delta layer handles this routinely (rebuild wrote
  913k); the next 6-hour rebase folds it. Not a risk, just a visible bump.
- **Source lock busy:** the endpoint apply path runs in-engine (no external lock
  contention); `saveState` uses the existing writer path. The driver treats a busy
  engine as skip-and-log, retry next night.
- **Oscillation:** prevented by asynchronous sorted-order updates + iteration cap;
  `converged: false` in the receipt flags pathological graphs for review.
- **Rollback:** sidecar backup taken before every apply; restore = standard sidecar
  restore. Worst case the old one-cluster world returns, which is today's state.
- **Engine restart mid-apply:** all mutation under the persistence barrier; a crash
  before save loses only the in-memory move (re-runnable), never corrupts the
  committed manifest/delta chain.

## 8. Testing (house rules: TDD, mutation testing, live dry-run gate)

**Planner unit tests** (`tests/engine/memory/community-detection.test.js`):
1. Two dense components joined only by `bridge` edges → 2 communities (bridge
   discount respected); same graph with bridges retyped `associative` at weight 1 →
   1 community (proves the discount is load-bearing).
2. Floor: a 5-node appendage wired to a 50-node core folds into the core; a 5-node
   island with no external edges survives.
3. Tag seeding on a virgin one-cluster brain reproduces tag groups when edges agree
   with tags.
4. Stability: run twice — second run seeded from first run's assignment moves zero
   nodes on an unchanged graph, and community ids are identical.
5. Id stability: grow one community, re-run → it keeps its cluster id; a genuinely
   new dense component gets `clusterId: null`.
6. Determinism: identical input → identical plan across repeated calls.

**Mutation tests:** break the bridge discount, the tie-break, and the plurality id
mapping — the corresponding tests must fail (this project's standing rule after
four weakened-implementation escapes).

**NetworkMemory tests** (extend `tests/engine/memory/` suite): apply moves nodes,
marks them dirty (persistence snapshot contains the moves), maintains `clusters`
map coherence, deletes emptied clusters; empty plan does not advance the
persistence generation; fresh-id communities allocate via `_allocateClusterIdUnsafe`.

**Endpoint test:** dry-run never mutates; apply produces backup + receipt;
`unchanged` plan short-circuits.

**Live gate before first production apply:** run the endpoint dry-run against
jerry's real brain, review community count / sizes / samples with jtr, then apply.
Verify after: map switches off tag-fallback, `clusterCount > 1` in the manifest,
PGS partition listing shows the communities, cognition context block lists real
clusters. Then enable the cron; forrest is covered automatically on the next
nightly run (his rebuild brain is small; early runs will find few communities and
that is correct).

## 9. Out of scope

- Changing PGS work-unit sizing or cross-partition synthesis (separate retrieval
  spec, already queued).
- Real-time incremental community maintenance (nightly + null-adoption is enough;
  revisit only if intraday staleness demonstrably hurts).
- Any UI beyond what the map auto-switch already shipped.
- Louvain/Leiden upgrade — only if label propagation's output is demonstrably poor
  on real brains (converged:false, or absurd size skew), measured not assumed.
