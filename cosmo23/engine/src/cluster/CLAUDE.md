# CLAUDE.md — Cluster System (engine/src/cluster/)

This file provides guidance to Claude Code (claude.ai/code) when working on the COSMO 2.3 multi-instance coordination and clustering subsystem.

---

## Architecture Overview

Two operating modes, selected via `cluster.enabled` in `config.yaml`:

**Single-instance** (`cluster.enabled: false`): A `FilesystemStateStore` is always initialized for Plan/Task/Milestone storage. No leader election, no CRDT merging.

**Multi-instance** (`cluster.enabled: true`): Two backends:
- `redis` — active/active CRDT model, all instances write concurrently, leader merges per cycle
- `filesystem` — single-writer lease model, only leader commits state

```
ClusterCoordinator          (review barrier, role assignment, governance)
      |
ClusterStateStore           (backend-agnostic façade)
      |
RedisStateStore             FilesystemStateStore
      |                             |
RedisClusterOrchestrator    FilesystemClusterOrchestrator
      |                             |
HealthMonitor               LeaderElection (FS)
CRDTMerger                  Reconciler
IdempotencyTracker          FilesystemHelpers
```

`ClusterAwareMemory` wraps `NetworkMemory` with proxy instrumentation — transparent in single-instance mode, emits diffs in cluster mode.

---

## Leader Election

### Redis Backend
Fencing token model: atomically increment `cosmo:leader:epoch`, then `SET cosmo:leader:holder NX` with TTL. Renewal via `leader_renew.lua` Lua script (atomic token check + lease extension). Default lease: 15000ms, renewal: 5000ms.

### Filesystem Backend
O_EXCL file lock at `control/leader.lock` with term monotonicity. `CURRENT_EPOCH` file is monotonically increasing — writes with old terms are rejected. Default lease: 5000ms, renewal: 1000ms, grace: 2000ms.

---

## State Stores

### Redis Keys
- `cosmo:memory:<nodeId>` — memory nodes (MessagePack + optional gzip)
- `cosmo:diff:<cycle>:<instanceId>` — per-instance cycle diffs
- `cosmo:merged:<cycle>` — merged state (1-hour TTL)
- `cosmo:goal:<goalId>` — goal hash with claim tracking
- `cosmo:health:<instanceId>` — health beacons
- `cosmo:leader:{holder,token,epoch}` — leader state
- `cosmo:ready:<cycle>` — cycle barrier readiness set
- `cosmo:applied:diffs` — idempotency set (7-day TTL)
- `cosmo:cluster:sync` — pub/sub for cycle proceed signals

Lua scripts: `goal_claim.lua` (atomic claim), `leader_renew.lua` (lease extension), `apply_merge.lua` (idempotent diff application).

### Filesystem Layout
```
control/leader.lock, CURRENT_EPOCH, CURRENT_SEQ
epochs/E<n>/diffs/, snapshot.json
goals/pending/, assigned/<instanceId>/, complete/, locks/
instances/<instanceId>/
applied/<diff_id>          (idempotency markers)
governance/plans/, milestones/, tasks/
```

### Consistency
- **Redis:** Active/active eventual consistency. Leader merges diffs per cycle. Window of divergence between diff submission and merge application.
- **Filesystem:** Single-writer. Stronger consistency, lower availability.

---

## Goal Allocation (`goal-allocator.js`)

`effectivePriority = basePriority + (age / agingHalfLifeMs)` — aging prevents starvation. Claims via `stateStore.claimGoal()` with TTL (default 10 min). Work-stealing for expired claims.

### Specialization
Per-instance profiles with `agentTypes`, `domains`, `tags`, `keywords` (boosted) and `avoid*` lists (penalized). `getSpecializationWeight(goal)` returns multiplier clamped to [0.3, 3.0].

---

## Cluster Coordinator (`cluster-coordinator.js`)

Orchestrates the **review barrier** before meta-coordinator reviews:

1. Compute quorum: `max(minQuorum, ceil(clusterSize * 0.67))`
2. Governance pre-check (may force skip/proceed)
3. Milestone gate check (blocks if tasks open)
4. Record readiness
5. Await barrier (poll 500ms, timeout 60s)
6. Role assignment (author, critic, synthesizer)
7. Create review plan

---

## CRDT Merging (`backends/crdt-merger.js`)

Three proven-convergent CRDT types:

- **LWW Register:** Higher timestamp wins. Tie: higher instanceId wins. Tombstones participate.
- **OR-Set:** Simple union (add-wins, no deletion).
- **PN-Counter:** Per-instance increments/decrements maps, component-wise max merge.

### Merge Pipeline
1. Each instance builds a diff via `ClusterAwareMemory.getCycleDiff(cycle)`
2. Submit diff to state store
3. Mark ready and wait at barrier
4. **Leader:** fetch all diffs, run `MemoryDiffMerger`, publish merged state
5. **Followers:** receive sync signal, apply merged state with tracking suppressed

---

## Cluster-Aware Memory (`cluster-aware-memory.js`)

Proxy wraps `NetworkMemory.nodes`, `edges`, `clusters` Maps. Intercepts `set`, `delete`, `clear`. Each value also proxied for property mutations. Tracking sets: `trackedNodes`, `deletedNodes`, `trackedEdges`, `deletedEdges`.

**Critical:** `fetchMergedState()` must always suppress tracking via `withSuppressedTracking()` AND use `Map.prototype.set.call()` directly. Otherwise incoming state re-emits as new diffs → amplification loop.

---

## Idempotency (`idempotency-tracker.js`)

Diff ID format: `${timestamp}_${cycle}_${instanceId}_${randomHex8}` — time-sortable. In-memory Set (max 10000, evicts oldest 10%). Redis: `cosmo:applied:diffs` set (7-day TTL). Filesystem: sentinel files at `applied/<diff_id>`.

---

## Health Monitoring (`health-monitor.js`)

Async heartbeat loop (3s interval). Beacons on `cosmo:cluster:heartbeats` pub/sub. Failure: 3 missed beats → suspect → unhealthy. Cluster status: healthy (0 unhealthy), degraded (1), critical (2+).

---

## Configuration

```yaml
cluster:
  enabled: false
  backend: none           # 'redis' or 'filesystem'
  instanceCount: 1
  redis:
    url: "redis://localhost:6379"
  filesystem:
    root: "runtime/cluster"
    leaseMs: 5000
  coordinator:
    quorumRatio: 0.67
    minQuorum: 2
    timeoutMs: 60000
    skipOnTimeout: true
  specialization:
    enabled: false
    profiles: {}
```

All instances must have matching `config.yaml` (SHA256 hash validated at startup).

---

## Testing

```bash
cd engine
npm run test:unit              # Cluster unit tests included
npm run test:multi-instance    # Multi-instance tests (120s timeout)
npm run test:integration       # Redis state store test (needs Redis)
```

Key test files:
- `tests/unit/leader-election.test.js` — acquire/renew/release, term monotonicity
- `tests/unit/crdt-merger.test.js` — LWW, OR-Set, PN-Counter convergence
- `tests/unit/cluster-coordinator.test.js` — barrier quorum, roles, governance
- `tests/unit/cluster-aware-memory.test.js` — instrumentation, diff construction
- `tests/unit/goal-allocator.test.js` — claiming, aging, specialization
- `tests/unit/idempotency-tracker.test.js` — dedup, cleanup, export/import
- `tests/multi-instance/goal-claiming.test.js` — zero duplicate claims, fair distribution
- `tests/multi-instance/cluster-memory-sync.test.js` — cross-instance propagation
- `tests/integration/redis-state-store.test.js` — full Redis integration

---

## Key Invariants

1. **Single leader at a time.** Redis: `SET NX` + fencing token. FS: `O_EXCL` + term monotonicity.
2. **Monotonically increasing terms.** Messages from lower terms are discarded.
3. **Exactly-once diff application.** `applied` set/directory checked before processing.
4. **Claim exclusivity.** At most one active claim per goal at any time.
5. **Completed goals are immutable.** Cannot be reclaimed.
6. **Tracking suppressed during state application.** Prevents amplification loops.
7. **Config hash agreement.** All instances must start with identical config.
8. **Quorum ≥ 67% for review.** Default: skip on timeout.

---

## Failure Modes

- **Redis unavailable at startup:** Instance fails to start (no fallback).
- **Redis disconnect during operation:** ioredis retries 3x. After that, instance loses coordination but continues locally.
- **Leader dies (Redis):** Lease expires in 15s. Another instance acquires leadership. Diffs accumulate, cycle barrier may timeout.
- **Leader dies (FS):** Lock expires after lease+grace. New leader increments epoch, old leader's writes fenced.
- **Split-brain (FS):** Prevented by term monotonicity — old leader's renewal fails when epoch advances.
- **Stale goal lock (FS):** Lock age > 30s triggers force-release.
