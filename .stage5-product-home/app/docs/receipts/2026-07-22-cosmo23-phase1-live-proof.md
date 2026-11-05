# COSMO23 Parity Phase 1 — Live Proof Receipt (2026-07-22)

**Program:** docs/superpowers/specs/2026-07-21-cosmo23-parity-program-design.md, Phase 1
**Plan:** docs/superpowers/plans/2026-07-21-cosmo23-parity-phase1.md, Task 10
**Commits under proof:** 55f98ed8 → e6b5ce73 (11 Phase 1 commits on main)

## What was proven, live, on the real engine

**Run:** `phase1-live-proof-round-2-practical-overview-of-cosine-similarity-for-semantic-search`
(brainId `dc15e77b308653fb`, cosmo23 on :43210, engine child `node src/index.js`)

### 1. The restart data-loss race is closed (the phase's core claim)

The run dir was put in the exact bug precondition: `state.json.gz` an empty manifest
shell (`memory.nodes: []`, `memorySource: 'manifest'`), the real graph (300 nodes /
600 seeded edges) living only in manifest sidecars at revision 2. Continuation launch:

```
[2026-07-22T05:44:58.529Z] INFO: 🧠 Memory hydrated from manifest sidecars
  {"source":"manifest","nodes":300,"edges":600,"expectedNodes":300}
```

Pre-phase, this boot loaded 0 nodes and the next save overwrote the brain.

### 2. kill -9 mid-run leaves an honest, recoverable state

Engine child PID identified by cwd (`lsof -d cwd` match on `cosmo23/engine`),
verified as `node src/index.js` (the run's watch-dashboard sibling left alone),
then `kill -9`. Verified after the kill:
- `.clean_shutdown` **absent** (honest crash state; pre-phase shutdown stamped it unconditionally)
- brain intact on disk: manifest revision 2, 300 nodes; brain-snapshot.json 300/600

### 3. Crash detection + recovery + hydration compose

Second continuation after the kill:

```
[2026-07-22T05:46:28.679Z] WARN: 🔄 Crash detected, attempting recovery from checkpoint...
[2026-07-22T05:46:28.679Z] WARN: ⚠️  No checkpoint available, loading from state file only
[2026-07-22T05:46:28.702Z] INFO: 🧠 Memory hydrated from manifest sidecars
  {"source":"manifest","nodes":300,"edges":600,"expectedNodes":300}
```

Pre-phase both bugs compounded: detection checked only `state.json` (gz-only crashed
runs classified as first runs) and checkpoint recovery skipped loadState (memory=0).

### 4. Honest clean finish + the first backup ever landed

The run completed its cycles and stopped cleanly:
- `.clean_shutdown` written at 05:51:02.717 — only after a confirmed `saved === true`
- brain-snapshot.json re-stamped: 300 nodes, generation 3, cycle 5
- `backups/backup-2026-07-22T05-51-02-720Z/` containing the coherent set:
  state.json.gz, memory-manifest.json, memory-nodes.base-3.jsonl.gz,
  memory-edges.base-3.jsonl.gz, memory-delta.e-4-….jsonl, brain-snapshot.json
- Node count preserved EXACTLY through one kill -9 and two restarts: 300 → 300 → 300.
  (Edges 600 → 300: the engine's import deduplicates unordered pairs; the synthetic
  seed contained each pair twice by construction. Not data loss.)

## Honest notes on method

- **The seeded graph.** Both live launch attempts produced 0-node brains because of a
  pre-existing cosmo23 bug: embedding calls 404 (`nomic-embed-text` routed to a
  provider that doesn't serve it) regardless of configured `text-embedding-3-small`,
  so every node is silently dropped (tracked as its own follow-up task). The proof
  graph was therefore seeded through the PRODUCTION writer path
  (`persistResearchState` → `rewriteMemoryBase` → manifest revision 2, then
  `writeSnapshot`) — the identical code path the engine's saveState uses. The
  persistence layer under test cannot distinguish the author of node content.
- **Save cadence finding.** These short guided runs made their only save at shutdown
  (single manifest revision per run). Consequence found live: the fire-and-forget
  backup died with the process ~10ms later and never landed. Fixed during the proof
  (commit e6b5ce73: `stop()` awaits the in-flight backup, bounded 10s) — the finale's
  landed backup is that fix's live verification.
- **First (clean) run of the day** also served as a degenerate-case proof: a 0-node
  brain persisted honestly (manifest 0/0, snapshot cycle 5, truthful clean marker)
  and its continuation booted without tripping BRAIN_LOAD_EMPTY (expected 0 → no
  false alarm).

## Gates passed before the live proof (Task 9)

- Full `npm test` chain: exit 0 (run against the live tree including a concurrent
  session's uncommitted state-compression hardening — coherent together).
- Standalone load test on real brains: 24-node and 299-node legacy inline runs load
  intact (`hydrated:false, source:'inline'`), and the seeded manifest brain loads
  `hydrated:true, 300 nodes`.
- Mutation spot-checks 3/3 killed: guard threshold, shutdown honesty condition,
  BRAIN_LOAD_EMPTY guard — each suite went red under its mutation and green on revert.

## Open follow-ups spawned during the phase (chips)

- cosmo23 embedding routing for non-OpenAI primaries (0-node brains, silent) — severe
- live model-catalog entry fails strict validation (qwen3-next:80b)
- state-compression hardening round 2 (CRC salvage verify, fsync, tmp sweep,
  merge-engine writer) — partially delivered by a concurrent session, uncommitted
- home23 donor's broken gzip salvage back-port
- cosmo23 dashboard shadowed StateCompression require (force-wake route)
