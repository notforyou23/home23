# COSMO23 Parity Program — Design

**Date:** 2026-07-21
**Status:** Approved by jtr (scope, edit policy, approach, and all four section decisions confirmed in session)
**Approach:** Big-bang parity — one spec, one program, four dependency-ordered phases

## Why

COSMO23 is the parent system — the outward-looking autonomous research engine that Home23
was born from. Over months of live operation, Home23's engine accumulated real, battle-tested
improvements (paid for in incidents: the lost brain, jerry's 913k-op delta, forrest's OOM,
the V8 string-limit crises). This program brings the improvements that apply to an
outward-looking research system back into `cosmo23/`.

A full mapping (3 parallel readers + synthesis, 2026-07-21) found the urgent fact: cosmo23's
**save** path was modernized during the Patch 49–70 arc — every cycle now routes through
`persistResearchState()` which commits a manifest/sidecar generation and writes
`state.json.gz` as an **empty shell** (`nodes: [], edges: []`) — but its **load, crash-recovery,
and shutdown** paths are still the pre-fix ancestors of every persistence bug Home23 already
fixed. The first restart of a run that saved through the manifest path boots with 0 nodes,
and the next save clobbers the brain. cosmo23 is idle as of this writing; Phase 1 must land
before the next research launch.

All divergence claims below were verified by reading cosmo23's actual source in this session
(not taken from subagent output alone).

## Doctrine change (approved)

**cosmo23 is now a first-class editable engine**, superseding the "surgical HOME23 PATCH
entries only" rule — the same transition `engine/` made on 2026-07-15. Specifically:

- Structural engine improvements land as normal code with normal tests. No per-change patch
  entries, no standalone-COSMO compatibility shims unless they are cheap.
- The `HOME23 PATCH` log (`docs/design/COSMO23-VENDORED-PATCHES.md`, currently through
  Patch 70) remains **only** for integration-boundary changes: config plumbing, OAuth,
  env-var contracts, and server API surfaces that Home23/agents depend on.
- Upstream COSMO resync is accepted as dead; cosmo23 updates only via `home23 update`.
- Home23's sacred persistence rules now extend to cosmo23: standalone load test before any
  engine restart after persistence-adjacent changes; node-count verification after.

This doctrine gets written into the patches-doc preamble and `CLAUDE.local.md` as part of
Phase 1 delivery.

## Program structure

One program, four phases, ordered by dependency (load-side guards must exist before delta
chains multiply the blast radius of load bugs; monitoring should exist before governance
acts on its signals). Each phase ends with a live proof on a real small research run.

---

## Phase 1 — Persistence integrity

Closes the live restart data-loss race. All items have battle-tested Home23 donors.

### 1.1 loadState hydration + fail-loud empty-brain guard
- **Bug (verified):** `cosmo23/engine/src/core/orchestrator.js` loadState (~8433–8480)
  imports only inline `state.memory.nodes/edges` — which are now permanently empty shells
  once `persistResearchState` commits a manifest (`cosmo23/lib/memory-sidecar.js:124–137`
  `memoryShell`). No `hydrateStateMemory`/`loadMemoryRevision` reference exists in the
  engine's load path.
- **Fix:** detect manifest/sidecar generations on load and hydrate through the shared
  reader (`cosmo23/lib/memory-sidecar.js` `hydrateStateMemory` already exists for the query
  side; the engine gets the same, streaming, never single-string). Add the fail-loud guard:
  if the persisted record (brain-snapshot / manifest totals) says N>0 nodes and the loader
  produced 0, **halt the engine** instead of proceeding as a fresh brain.
- **Donor:** `engine/src/core/orchestrator.js:7691–7734`.

### 1.2 Brain-snapshot sidecar + every-cycle save-safety guard
- **Bug (verified):** the only anti-overwrite guard runs at `cycleCount <= 1`, and reads
  uncompressed `state.json` (`orchestrator.js:8071`) while saves write `state.json.gz` —
  the read throws, the catch proceeds with the save. Dead code; no node-loss protection
  after cycle 1.
- **Fix:** port `brain-snapshot.js` (tiny always-parseable last-known-good counts, written
  after every successful save) and the save-safety evaluation on **every** save: a save
  representing a catastrophic drop vs. last-known-good is refused with a structured result.
- **Donors:** `engine/src/core/brain-snapshot.js`, `engine/src/core/brain-persistence-guard.js`,
  `engine/src/core/orchestrator.js:7278–7362`.

### 1.3 Graceful-shutdown honesty
- **Bug (verified):** `graceful-shutdown-handler.js:202–207` awaits `dumpState()` then
  **unconditionally** `markCleanShutdown()`; `dumpState` discards the save outcome;
  orchestrator save failures are swallowed (`:8140`). A failed or refused save is stamped
  clean — disabling the crash-recovery path exactly when it is needed.
- **Fix:** `saveState()` returns structured `{saved, reason, currentNodes, existingNodes}`;
  shutdown checks it and leaves the shutdown dirty on failure/refusal; add save re-entrancy
  lock and bounded shutdown save.
- **Donors:** `engine/src/core/graceful-shutdown-handler.js:213–281`,
  `engine/src/core/orchestrator.js` (`_saveStatePromise` ~7201, `saveStateForShutdown` ~8512).

### 1.4 Crash-recovery overhaul
- **Bugs (verified):** (a) crash detection checks only `state.json`, never `.gz`
  (`crash-recovery-manager.js:70–79`) — crashed compressed-state runs are misclassified as
  first runs; (b) when a checkpoint is recovered, `loadState()` is **never called**
  (`orchestrator.js:458–486`) — the jerry 2026-04-17 `memory=0` incident class; (c)
  checkpoints serialize the full graph + embeddings through one `JSON.stringify` every
  5 cycles (`orchestrator.js:3227–3243`, `crash-recovery-manager.js:108`) — V8 string
  ceiling + massive churn.
- **Fix:** detect both state artifacts; **always** run loadState, with a recovered
  checkpoint applied only as a strictly-fresher scalar overlay (cycleCount, journal,
  lastSummarization, guidedMissionPlan, completionTracker — never memory); shrink
  checkpoints to scalars + memory count summary with streaming writer/hasher.
- **Donors:** `engine/src/core/crash-recovery-manager.js:70–87, 115–165, 407`,
  `engine/src/core/orchestrator.js:396–429, 3878–3902`.

### 1.5 Atomic state writes + corrupt-gzip salvage
- **Bug (verified):** `state-compression.js` writes `filepath + '.gz'` in place — a
  mid-write kill leaves a truncated file with no intact predecessor; `loadCompressed` has
  no trailing-garbage salvage.
- **Fix:** unique temp file + rename for all state artifacts; salvage the first valid gzip
  stream on load; structured empty-state fallback instead of silent fresh-brain.
- **Donor:** `engine/src/core/state-compression.js:55–116`.

### 1.6 Wire routine backups
- **Bug (verified):** `rotateBackups(keep 5)` runs after every save but `createBackup` is
  never called on the save path — rotation governs backups that are never created.
- **Fix:** periodic pin-consistent backup (default every 6h, matching Home23's
  `maybeBackup` cadence, plus one before any engine-version migration) — port the
  `brain-backups.js` rotator pattern using coordinator pins from `shared/memory-source/pins.cjs`
  so backups are internally consistent while the engine writes. Backup destination is
  caller-controlled; the "backups never on the Data volume" doctrine applies operationally.
- **Donor:** `engine/src/core/brain-backups.js`.

---

## Phase 2 — Self-awareness

Scoped slice (approved): the run's own health, not a general problem registry. No
targets.yaml / verifier-catalog port.

### 2.1 Heartbeat
Engine child stamps a heartbeat every cycle; the Patch 9 status contract
(`cosmo23/server/lib/status-contract.js`) exposes it — the `lastHeartbeat` field exists
today and is permanently null. A wedged child becomes distinguishable from a slow one.

### 2.2 Cycle watchdog that acts
`timeout-manager.js` currently fires a callback and nothing else — one hung LLM call
stalls the loop forever. Fix: watchdog aborts the hung cycle (AbortController through the
LLM client paths), retries bounded, and a circuit breaker (os-kernel pattern: trip after
repeated failures, 15-minute cool-off, revive probe) stops crash-loops.

### 2.3 Resource enforcement
ResourceMonitor observes heap/CPU but enforces nothing. Fix: heap pressure throttles agent
spawn rate and save cadence; an OOM breaker on the save/rewrite path (forrest's 119k-node
rewrite lesson) falls back to the memory-safe path instead of dying.

### 2.4 Ledger hygiene
`events.jsonl` is unbounded, `eventCount` resets per process (IDs collide across restarts);
thoughts/dreams/voice JSONL grow forever. Fix: rotation/size caps, monotonic cross-restart
IDs, hash-chain continuity on events (donor: `engine/src/core/event-ledger.js` pattern),
same rotation treatment for the other streams.

### 2.5 Wedge → remediate → escalate (scoped)
Server-side detection built on 2.1's heartbeat: wedged/died engine child during an active
run → bounded remediation (restart child, resume run via existing continue machinery) →
escalation surfaced in run status + dashboard on repeated failure. Donor is the
live-problems *pattern* (`engine/src/live-problems/`), not the system.

---

## Phase 3 — Graph intelligence, research-tuned

### 3.1 Anti-slop persistence gates
Hygiene is birth-time-only today (`classifyContent` at addNode). Port the cleanup patterns:
meta-reasoning/preamble stripping, hallucinated-tool-call detection
(`engine/src/cognition/hallucinated-tool-call-detector.js`), node-diet caps at persistence
time. Long autonomous runs currently crystallize LLM slop permanently.

### 3.2 Decay retuned to research timescales
GC requires weight < 0.01 AND 730 days untouched — inert for brains living days-to-weeks.
Retune thresholds for research lifetimes and make `memory-governor.js` enforcing
(`applyPruning=true` with bounded batches) instead of advisory.

### 3.3 Streamed state capture
`persistResearchState` still `JSON.stringify`s the entire state (graph + embeddings) as one
V8 string at capture (`cosmo23/lib/memory-sidecar.js` `jsonCapture`) — the exact ceiling the
sidecars exist to avoid, surviving at the capture step. Replace with changes-only /
streaming capture (donor: `engine/src/core/memory-persistence.js` snapshot capture).

### 3.4 Delta compaction — config-gated (approved)
Today every save is a full O(graph) base rewrite (structurally immune to unbounded deltas,
acceptable at current scale, increasingly wasteful as brains grow). Implement the
delta-append writer consuming NetworkMemory's existing dirty-node/edge sets plus the
`baseWrittenAt` rebase cadence (donor: `memory-persistence.js:232–242`,
`shared/memory-source/writer.cjs:406`, `delta-chain.cjs`) — **gated off by default**,
arming automatically only above a configured node threshold (default: 10,000 nodes).
Lands only after Phase 1 guards exist.

### 3.5 Community detection — config-gated (approved)
cosmo23's `_assignToClusterUnsafe` shares the lineage one-blob bug (first cluster conquers
the graph), feeding consolidation grouping. Port seeded label propagation
(`engine/src/memory/community-detection.js` + `recluster.js`) behind the same size gate.
Read-side PGS already does Louvain + Patch 66 coarsening; this fixes the engine side.

### 3.6 Ingestion pending-queue JSONL
Confirm Patch 67's twin port fully covers cosmo23's feeder pending-queue single-string
save; close any remaining gap in `cosmo23/engine/src/ingestion/`.

### Explicit non-goal: ANN indexing
Not ported (approved). Research brains are orders of magnitude below jerry scale and the
read side was just hardened. Documented arm-trigger: revisit when research brains routinely
exceed ~10k nodes. Same for thinking-machine/DiscoveryEngine — cosmo23's guided-plan
authority owns cognition; no transplant.

---

## Phase 4 — Research governance (native adaptation, approved)

Not a Good Life transplant. A research-native governance layer built on cosmo23's own
run/planner concepts, borrowing Home23 patterns where they fit. Components:

### 4.1 Run vitals + regulator
Per-run lanes computed from existing telemetry: **progress** (artifacts/knowledge added per
cycle window), **spend** (tokens/cost — today unbounded between maxCycles/maxRuntime),
**health** (heartbeat freshness, error/retry rates from Phase 2). A regulator adjusts
pacing (adaptive cycle interval, agent concurrency) within jtr-configured bounds and can
park a run (pause with resumable state) when a lane is critical — e.g. spend ceiling hit,
progress starved, health degraded.

### 4.2 Spend budget
First-class token/cost budget per run: configured at launch (with home-level default),
metered from the unified client, enforced by the regulator (soft warn → hard park).

### 4.3 Commitments + starvation detection
Runs declare deliverables (the guided plan already knows them); a starvation detector
(donor pattern: publish-layer cadence ledger) flags a run cycling without producing —
feeding the progress lane rather than a separate alert channel.

### 4.4 Sleep/wake policy for runs
Consolidation (deep-sleep phases already exist) scheduled by policy — triggered by lane
state and idle detection — instead of fixed cadence.

### 4.5 Operator rails
A Needs-You surface for run-blocking decisions (concept donor: os-kernel OperatorIntents):
when the regulator parks a run or a decision needs jtr, it lands as a typed intent visible
in the COSMO tab / dashboard, not a buried log line. Bounded-autonomy defaults: the
regulator never deletes data, never expands its own budget, and every parking action writes
a receipt into the run's events ledger.

Phase 4 requirements are settled at this level; the implementation plan will finalize lane
thresholds, storage shape (run-local JSON beside existing run state), and API/UI surface —
those are engineering decisions inside this scope, not new scope.

---

## Verification (every phase)

- Unit tests in the existing `tests/cosmo23/` pattern; mutation-testing spot-checks on
  persistence-critical code (house style).
- The patches-doc end-to-end smoke test after each phase that touches launch/save/load.
- Standalone load test + node-count verification before/after any engine restart involving
  persistence changes (sacred rule, now extended to cosmo23).
- Live proof at each phase boundary on a real small research run (5-cycle launch), including
  for Phase 1: kill -9 mid-run → restart → verify full brain hydration and honest crash
  detection; for Phase 4: a run parked by spend ceiling and resumed.
- Phase 1 lands before the next research launch (cosmo23 idle as of 2026-07-21).

## Risks

- **Touching the save/load path is the riskiest work in this repo.** Mitigated by: Phase 1
  is guard-first (fail-loud before any behavior change), standalone load tests gate every
  restart, and cosmo23 is idle during the landing window.
- **Shared-module coupling:** cosmo23 already consumes `shared/memory-source/`; engine-side
  hydration must use the same reader contracts the query side uses (Patch 16 streaming) to
  avoid a second implementation drifting.
- **Governance scope creep:** Phase 4 is the least-precedented layer. The spec pins it to
  five components; anything beyond (multi-run scheduling, cross-run learning) is explicitly
  out of scope for this program.

## Out of scope (for honesty)

Good Life transplant, Universal Channel Bus + typed channels, curator cycle + domain
surfaces, neighbor protocol, pulse remarks, agenda/MotorCortex, agency spine, OS-kernel
control plane, thinking-machine/DiscoveryEngine, ANN indexing, publish layer as-is. These
are organs of a persistent inward-looking agent or scale-triggered items with documented
arm conditions.
