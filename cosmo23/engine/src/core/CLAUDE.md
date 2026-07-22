# CLAUDE.md — Engine Runtime (engine/src/core/)

This file provides guidance to Claude Code (claude.ai/code) when working on the COSMO 2.3 engine runtime.

---

## Purpose

`engine/src/core/` is the nervous system of COSMO 2.3. It contains the main cognitive loop, guided-run planner, LLM abstraction layer, lifecycle management, config loading/validation, and resilience infrastructure. This directory is NOT the place for agent logic, memory algorithms, or domain-specific tools — those live in `engine/src/agents/`, `engine/src/memory/`, and `engine/src/goals/`.

---

## The Runtime Cycle — `orchestrator.js`

### Entry Point

`Orchestrator.start()` sets `this.running = true`, launches background pollers (`startImmediateActionPoller`, `startGuardianControlPoller`), then enters a `while (this.running)` loop calling `runCycleWithWatchdog()` each iteration (which runs `executeCycle()` under the CycleWatchdog's hard abandonment deadline — never `executeCycle()` directly). A `false` return (breaker pause / abandoned cycle) skips post-cycle work including the maxCycles/maxRuntimeMinutes checks — bounded overshoot, self-correcting on the first settled cycle. Inter-cycle sleep is computed by `calculateNextInterval()`.

### `executeCycle()` Phase Order

**Phase 0 — Pre-cycle bookkeeping:** Increment `cycleCount`. If `consolidationMode`, run `performDeepSleepConsolidation()` and return early. Start cycle timeout timer. Emit `cycleStart`.

**Phase 0a — Input queues:** Every 3 cycles: poll `topicQueue`. Every 2 cycles: poll `pollActionQueue()` for MCP-injected actions.

**Phase 1 — Temporal rhythms:** `temporal.update()`, `oscillator.update()`. Wake from sleep if conditions met.

**Phase 2 — Agent result processing:** `agentExecutor.processCompletedResults()`. Record completions in `executiveRing`. Process handoff requests.

**Phase 3 — Plan executor tick:** `planExecutor.tick(cycleCount)`. If `action === 'PLAN_COMPLETED'`, handle auto-next plans. Sets `planExecutorHandled = true` to gate legacy plan path.

**Phase 4 — Task state queue flush:** `taskStateQueue.processAll()` — serializes queued task-state mutations after both agent results and PlanExecutor decisions.

**Phase 5 — Introspection and routing (every 3 cycles):** `introspection.scan()` then `integrate()`. Update `realityLayer`. Score routing hints. Auto-spawn from hints if enabled AND not guided-exclusive.

**Phase 6 — Memory governance (every 20 cycles):** `memoryGovernor.evaluate()` — advisory prune candidate identification.

**Phase 7 — Strategic goal tracking:** `coordinator.strategicTracker.checkProgress()`.

**Phase 8 — Meta-coordinator review (scheduled):** Gates on `coordinator.shouldRunReview(cycle)`. Calls `runMetaCoordinatorReview()`.

**Phase 9 — Emergency coordinator review:** Fires if no review scheduled AND goals exist AND no active agents AND 10+ cycles since last review.

**Phase 10 — Action coordinator:** `actionCoordinator.shouldTrigger(cycle)` → `runActionCoordinatorCycle()`.

**Phase 11 — Sleep management:** Cognitive fatigue or temporal rhythm triggers sleep. Active plans override sleep skip. Safety net: 50 cycles forces wake.

**Phase 12 — Environment sensing:** `environment.pollSensors()`.

**Phase 13 — Executive ring decision:** `executiveRing.decideCycleAction()` can set `executiveSkipSpawning = true`.

**Phase 14 — Autonomous goal execution (GUIDED GATE):** Only runs when `isGuidedExclusiveRun()` returns false. Spawns strategic goals and execution agents.

**Phase 15 — Thought generation:** Role-based LLM calls. In guided mode, skipped until `guidedPlanReady`.

**End of cycle:** Cancel cycle timer. `saveState()` runs the every-cycle save-safety guard, then `persistResearchState()` commits the memory graph as an immutable manifest generation (`memory-manifest.json` + base sidecars) and writes a manifest-backed shell to `state.json.gz` (atomic tmp + fsync + rename); on success it stamps `brain-snapshot.json`, writes `cosmo-progress.md`, and fires an interval-gated backup check (`maybeBackupBrain`, non-blocking). Emit `cycleComplete`.

---

## Guided vs Autonomous Mode

### Execution Mode Resolution

`lib/execution-mode.js`: `normalizeExecutionMode()` always returns `effectiveMode: 'guided-exclusive'` when `explorationMode === 'guided'`. The old `mixed`/`strict` distinction is deprecated.

`isGuidedExclusiveRun()` checks are at four positions:
1. Autonomous goal spawning skipped
2. Routing auto-spawn skipped
3. Log message on cycle 1
4. Goal exhaustion halt check skipped

### `GuidedModePlanner.planMission()` — Startup Planner

Called once during engine startup when `explorationMode === 'guided'`.

**State machine:**
- Plan COMPLETED (all tasks/milestones DONE) → return `{ planComplete: true, spawnAgents: false }`
- Plan ACTIVE with active work → `performStateAudit()` to repair state, resume without regenerating
- Plan exists but no active work/agents → archive old plan, regenerate
- No plan → generate fresh

**Fresh plan generation:**
1. `analyzeAvailableResources()` — checks MCP tools
2. `parseTaskPhases()` — extracts structured phases from config context
3. `buildPlanningContext()` — queries memory for related past work (brain-informed planning)
4. `generateMissionPlan()` — single LLM call producing agent missions and deliverable spec

**Plan persistence:** One `Plan` object with `id: 'plan:main'`, N `Milestone` objects (`ms:phase1`, `ms:phase2`...), N `Task` objects with sequential deps. Phase 1 starts ACTIVE; all others LOCKED.

**Deferred spawn:** `plan._deferredSpawn` ensures agents aren't spawned until after plan display.

### `PlanExecutor` — Plan Authority

Called every cycle via `planExecutor.tick(cycleCount)`:
1. `sync()` — re-reads plan, phases, tasks, agents from state store
2. `checkPhase()` — activate next LOCKED phase if current is complete
3. `checkTask()` — find highest-priority PENDING task with deps met, start it
4. `checkAgent()` — spawn agent if active task has none assigned (timeout: 12 min default)
5. On completion: `validateTaskOutput()` scans results + artifacts + disk. Max retries: 3.

---

## Unified Client — LLM Abstraction

### Class Hierarchy
`GPT5Client` (Responses API) → `UnifiedClient` (adds routing)

### Provider Initialization
OpenAI (default), xAI (`providers.xai.enabled`), Anthropic via OAuth (`providers.anthropic.enabled` — OAuth-only, no API key), Local Ollama (`providers.local.enabled` or `LLM_BACKEND=local`), Ollama Cloud (`providers.ollama-cloud.enabled` — uses `ChatCompletionsClient` pointed at `ollama.com/v1`, empty model mapping, no GPT→llama remapping), OpenAI Codex (`providers.openai-codex.enabled` — triggers lazy Codex client init via `_ensureCodexClient()`, OAuth JWT only, no API key), MCP servers.

**No hardcoded model names** in agents or coordinators. All model fallbacks use `this.config.models.primary`, `.fast`, `.strategicModel`, `.coordinatorStrategic`, etc. The base clients (`gpt5-client.js`, `chat-completions-client.js`) retain last-resort defaults but callers should always pass a model via the assignment system.

### Model Assignment Routing
`getModelAssignment(component, purpose)` priority: `config.modelAssignments["component.purpose"]` → `["component"]` → `["default"]` → `null` (use GPT5Client). Zero-config guarantee: `new UnifiedClient(null, logger)` behaves identically to `new GPT5Client(logger)`.

Provider routing by assignment: `openai-codex` provider tag routes to `generateCodex()` which uses a dedicated Codex SDK client with OAuth JWT auth (standard OpenAI API, no custom base URL). `openai-codex` and `openai` are independent clients — both can be active simultaneously with different model sets.

### xAI Notes
- `grok-4` does NOT accept `reasoning_effort` (always automatic). Only `grok-4.20-0309-reasoning*` accepts it.
- Web search uses `search_parameters: { mode: 'auto' }`.
- If `aggregatedText` is empty but `reasoningSummary` exists, reasoning content is returned as the response.

---

## Config Loading

### Path Resolution
`ConfigLoader` resolves: constructor arg → `$COSMO_RUNTIME_PATH/config.yaml` → `engine/src/runtime/config.yaml` (local dev fallback). Format: YAML.

### Required Sections
`architecture`, `models`, `execution`, `logging`, `dashboard`. Within `architecture`: `roleSystem`, `memory`, `reasoning`, `creativity`, `goals`, `thermodynamic`, `environment`, `temporal`, `cognitiveState`, `reflection`.

### Key Config Fields

| Path | Effect |
|---|---|
| `architecture.roleSystem.explorationMode` | `'guided'` or `'autonomous'` — determines entire execution mode |
| `architecture.roleSystem.guidedFocus.domain` | Topic label for guided runs |
| `architecture.roleSystem.guidedFocus.context` | Task phases or free-form instructions |
| `models.primary` | e.g., `'gpt-5.5'` |
| `execution.maxCycles` | Loop termination limit |
| `execution.maxRuntimeMinutes` | Wall-clock termination |
| `execution.consolidationMode` | Perpetual sleep/consolidation |
| `timeouts.cycleTimeoutMs` | Default 60000 (60s) per-cycle; also feeds the watchdog hard deadline (sanitized at every read — garbage values fall back to 60000) |
| `heartbeat.intervalMs` | Heartbeat interval stamps, default 15000 (15s) |
| `watchdog.hardMultiplier` / `watchdog.minHardTimeoutMs` | Hard abandonment deadline = max(cycleTimeoutMs × 3, 600000 (10 min)) |
| `watchdog.tripThreshold` | Consecutive cycle failures that trip the breaker, default 3 (hard timeouts + critical stalls trip immediately) |
| `watchdog.cooloffMs` | Breaker-open pause before the revive probe, default 900000 (15 min) |
| `watchdog.criticalStallMs` | Sustained-critical backpressure + zero-agents window before a `critical_stall` trip, default 600000 (10 min) |
| `watchdog.countSoftTimeouts` | Count settled-but-slow cycles as breaker failures, default false |
| `watchdog.restartExitCode` | Supervisor-restart escalation exit code, default 86, clamped 1..255 (codes wrap mod 256 at the OS) |
| `watchdog.pauseSleepMs` | Sleep granularity while the breaker is open, default 5000 |
| `resources.rssBudgetMb` | RSS backpressure budget, default 4096 |
| `resources.backpressure.*` | Hysteresis enter/exit thresholds: elevated 0.70/0.60, critical 0.85/0.75; `heapMinTotalMb` (512) — the heap leg gates heapUsed against min(floor, 0.5 × heap_size_limit), so small `--max-old-space-size` limits keep the heap leg armed |
| `ledger.maxBytes` | Event ledger rotation threshold, default 52428800 (50MB) |
| `ledger.keepRolls` | Gzipped ledger rolls kept after rotation, default 5 |
| `shutdownSaveTimeoutMs` | Bound on the final shutdown save, default 60000 (60s) |
| `shutdownInProgressSaveTimeoutMs` | Grace when shutdown joins an already-in-progress save with durable state on disk, default 15000 (15s) |
| `shutdownTelemetryTimeoutMs` | Bound on telemetry cleanup during shutdown, default 5000 (5s) |
| `shutdownDeadlineMarginMs` | Room reserved before the hard-kill when deriving the shutdown deadline, default 5000, clamped [5s, shutdownTimeout/2] |
| `shutdownLedgerTimeoutMs` | Bound on the event-ledger close during shutdown, default 5000 (5s) |
| `backups.intervalMs` | Brain backup interval, default 21600000 (6h) |
| `backups.retention` | Backups kept after rotation, default 2 |
| `backups.minFreeBytes` | Free-disk floor below which backups are skipped, default 4294967296 (4GB) |
| `memory.deltaCompaction.enabled` | Fix 3.4 gate, default false — armed saves append changes-only manifest deltas instead of rewriting the full base sidecars every cycle |
| `memory.deltaCompaction.minNodes` | Node floor below which saves stay full-rewrite even when enabled, default 10000 |
| `memory.deltaCompaction.fullRewriteIntervalMs` | Max base age before an armed save rebases with a full rewrite (folds the delta chain back in), default 21600000 (6h) |
| `recovery.checkpointInterval` | Cycles between checkpoints, default 5 |
| `planning.maxRetries` | PlanExecutor task retry limit, default 3 |
| `governance.sleepPolicy.mode` | Consolidation trigger authority: `legacy` (default — dual-system fatigue/rhythm trigger, bit-identical) or `policy` (idle / post-milestone triggers, Component 4.4) |
| `governance.sleepPolicy.idleCycles` | Policy mode: consecutive cycles with zero new agent spawns AND zero task completions before idle-triggered consolidation, default 10 |
| `governance.sleepPolicy.minGapCycles` | Policy mode: minimum cycles between policy-triggered consolidations, default 30 |
| `planning.agentTimeout` | Default 720000 (12 min) |
| `cluster.enabled` | Multi-instance cooperative mode |
| `capabilities.enabled` | Direct tool access |
| `executiveRing.enabled` | ExecutiveCoordinator (dlPFC layer) |

Note: `sentinel.*` settings and the `COSMO23_SENTINEL_*` env overrides are SERVER-side config (`cosmo23/server/index.js`, Patch 71 in `docs/design/COSMO23-VENDORED-PATCHES.md`) — the engine never reads them.

### Validator
`ConfigValidator` is non-breaking: produces `{ valid, warnings, errors, info }` but never throws. Errors indicate invalid cluster backends, bad capabilities modes, malformed booleans.

---

## Resilience

### Crash Recovery (`crash-recovery-manager.js`)
Marker-file protocol: `.clean_shutdown` file is removed at startup, written at clean shutdown. Detection covers BOTH `state.json.gz` AND `state.json` (`detectCrash()`): marker missing AND either state artifact present → crash detected.

Checkpoints are written every N cycles (default 5) atomically (temp file + rename) and are **scalar-only** (`buildCheckpointState()` in orchestrator.js): `cycleCount`, journal tail, `lastSummarization`, `guidedMissionPlan`, `completionTracker`, plus a `memorySummary` of node/edge/cluster counts — never the graph (full-graph checkpoints were the multi-hundred-MB JSON.stringify bug). Each checkpoint gets a `checkpoint-N_audit.json` tamper-evidence sidecar; audit sidecars are excluded from recovery candidates and are deleted together with their checkpoint during rotation.

Recovery tries checkpoints newest-first, and recovery **ALWAYS runs `loadState()`** (`restoreFromPersistence()`): a recovered checkpoint is applied strictly as a scalar overlay — only fields strictly fresher than what `loadState()` restored — and NEVER as a memory source. A legacy full-graph checkpoint's memory payload is logged and ignored. Skipping `loadState()` after checkpoint recovery is the memory=0 bug class.

### Load Path (`state-hydration.js`)
Manifest-backed saves store an EMPTY memory shell inside `state.json.gz` (`memorySource: 'manifest'`). `loadState()` hydrates the shell back through the streaming sidecar reader (`hydrateOrchestratorState()` → `lib/memory-sidecar.hydrateStateMemory`) before any import — never a single-string JSON parse of sidecar files.

**BRAIN_LOAD_EMPTY contract (fail-loud):** if `brain-snapshot.json` / `memory-manifest.json` / shell counters expect nodes > 0 but the loaded+hydrated graph has 0 nodes, an error with `code: 'BRAIN_LOAD_EMPTY'` is thrown. `loadState()` matches it code-first (message-prefix `BRAIN_LOAD_EMPTY` as fallback for message-wrapping intermediaries) and re-throws — the error propagates out of `initialize()`, the process exits 1, and the run is visible as failed. The brain stays intact on disk; the engine must NOT continue as a fresh brain. Documented gap: a legacy run dir with no snapshot AND no manifest has nothing to detect against — it boots fresh.

### Heartbeat (`heartbeat.js`)
`<logsDir>/.heartbeat`, written tmp+rename every `heartbeat.intervalMs` (default 15s) plus at cycle start/end. **Liveness vs progress:** `ts` freshness = event loop alive (interval stamps keep it fresh); `lastCycleEndTs` freshness = cycles actually completing. A hung LLM await keeps `ts` fresh while `lastCycleEndTs` goes stale — wedge detection (the server-side run sentinel) keys on PROGRESS, never liveness. Watchdog phases `breaker_cooloff` / `revive_probe` mark deliberate non-cycling (cooloff time is not wedge time). Stale-stamp rejection: a late end-stamp from a watchdog-abandoned cycle (older cycle number) never overwrites newer progress — a false-recovery signal would mask a wedge.

### Timeout Protection (`cycle-watchdog.js` + `timeout-manager.js`)
**Cycle-level (ACTS — Fix 2.2):** `runCycleWithWatchdog()` races every cycle against the hard abandonment deadline `max(cycleTimeoutMs × watchdog.hardMultiplier, watchdog.minHardTimeoutMs)`. A cycle past the deadline is ABANDONED at the boundary — contained: the orphan promise blocks new cycles until it settles (in-flight LLM calls cannot be aborted). Hard timeouts and sustained-critical stalls trip the circuit breaker immediately; `watchdog.tripThreshold` consecutive cycle errors trip it too. An open breaker pauses cycling for `watchdog.cooloffMs`, then runs exactly one revive probe (success closes, failure re-trips). An orphan still pending when cooloff expires escalates to a supervisor restart: `restartRequested` persisted to `.watchdog.json` first, bounded `stop()`, then exit `watchdog.restartExitCode` (86). Breaker state survives restarts via `.watchdog.json`. The legacy timeout-manager cycle timer (`startCycleTimer()`) still exists and is monitoring-only.
**Operation-level:** timeout-manager remains authoritative — `wrapWithTimeout(promise, timeoutMs)` rejects on timeout with `error.code = 'OPERATION_TIMEOUT'`.

### Event Ledger (`event-ledger.js`)
Hash-chained append-only `events.jsonl` (seq survives restarts by re-reading the tail). Rotates when a write would exceed `ledger.maxBytes` (default 50MB): renamed to `events-<stamp>.jsonl`, gzipped asynchronously to `events-<stamp>.jsonl.gz`, newest `ledger.keepRolls` (default 5) gzipped rolls kept. A broken chain tail is preserved aside as `events-<stamp>.unchained.jsonl`, never silently dropped. Shutdown close is bounded by `shutdownLedgerTimeoutMs`.

### Graceful Shutdown (`graceful-shutdown-handler.js`)
Listens on SIGINT, SIGTERM, SIGHUP. Idempotent. Sequence:
1. Wait for active agents (up to 150s)
2. Stop orchestrator (`orchestrator.stop()` performs the bounded final save itself via `saveStateForShutdown()` and records the result in `shutdownStateResult`)
3. Dump final state — only if the orchestrator didn't already handle it
4. Mark clean shutdown — **ONLY when the final save result is `saved === true`.** A refused, failed, or timed-out save leaves the marker DIRTY so the next boot runs crash recovery and re-hydrates from the durable sidecars. `saved: 'existing'` (save timed out but a durable state artifact is on disk, reason `shutdown_save_timeout_existing_state`) ALSO stays dirty.
5. Run custom cleanup tasks
6. Cleanup resources, exit

The shutdown save is bounded (`shutdownSaveTimeoutMs`, default 60s; 15s grace when joining an already-in-progress save with durable state on disk). **Alert-worthy signal:** `shutdown_save_timeout_existing_state` recurring in logs means the brain has outgrown the 60s shutdown save bound.

**Budget-derived bounds:** the historical per-step defaults (150s agent wait + 60s save + 5s telemetry + …) sum past the 180s hard-kill, so a slow shutdown used to be killed mid-save. Every bound now derives from ONE deadline: `shutdownDeadline = shutdownStartTime + shutdownTimeout − margin`, where the margin (`shutdownDeadlineMarginMs`, default 5000) is clamped to [5s, shutdownTimeout/2]. Each bounded step caps its timeout at the remaining budget (its configured default stays a ceiling), so the worst case finishes — or times out honestly — before the hard-kill fires. A non-finite deadline (garbage `shutdownTimeoutMs`) makes every consumer fall back to its configured default (`shutdownBudgetMs`).

Hard-timeout kills process at 180s. Must exceed agent wait timeout (150s).

---

## Path Resolution (`path-resolver.js`)

| Prefix | Resolved to |
|---|---|
| `@outputs` | `<runtimeRoot>/outputs` |
| `@exports` | `<runtimeRoot>/exports` |
| `@coordinator` | `<runtimeRoot>/coordinator` |
| `@state` | `<runtimeRoot>` |
| `@logs` | `config.logsDir` |

Also strips leading `runtime/` (a known GPT-5.2 hallucination). MCP accessibility check: `isPathAccessibleViaMCP(targetPath)` verifies path is within allowed directories.

---

## Spawn Gate (`spawn-gate.js`)

`SpawnGate.evaluate(missionSpec)` runs before every agent spawn. Checks memory similarity (cosine >= 0.9) and result history (Jaccard >= 0.55). If either fires, task is BLOCKED. Bypass with `missionSpec.metadata.disableSpawnGate = true`.

---

## State Files

| File | Contents |
|---|---|
| `state.json` / `state.json.gz` | Serialized runtime state (gzip, atomic tmp + fsync + rename; reads tolerate trailing garbage via first-gzip-member salvage). Manifest-backed saves carry an EMPTY memory shell with authoritative counts (`memorySource: 'manifest'`); legacy runs carry the full inline graph |
| `memory-manifest.json` + `memory-nodes.jsonl.gz` / `memory-edges.jsonl.gz` | Immutable manifest generation + base sidecars — the authoritative memory graph for manifest-backed runs; hydrated back on load via the streaming reader |
| `brain-snapshot.json` | Last known-good node/edge counts, stamped after every successful save. Save-guard baseline (top precedence) + fail-loud load check. ALSO the operator escape hatch: a legitimate >50% prune of a >100-node brain is refused every cycle — the intended intervention is editing this file's counts down |
| `cosmo-progress.md` | Human-readable progress log |
| `checkpoints/checkpoint-{cycle}.json` | Scalar-only checkpoint (memorySummary counts, no graph) at cycle boundaries (last 3 kept); its `checkpoint-{cycle}_audit.json` sidecar rotates with it |
| `backups/backup-<stamp>/` | Interval-gated coherent brain backups (6h default, retention 2), copied under the memory-source write lock with a 4GB + projected-copy-size disk floor; stale `backup-*.tmp` staging dirs are swept. Restore note: a backup can pair manifest revision R+1 with a shell/snapshot from R — benign, the manifest is authoritative for hydration |
| `.clean_shutdown` | Clean shutdown marker (written ONLY after a confirmed final save) |
| `.pause_requested` | Pause signal from external control |
| `.heartbeat` | Liveness/progress stamp `{ ts, pid, cycle, lastCycleStartTs, lastCycleEndTs, phase }`, tmp+rename, every `heartbeat.intervalMs` + cycle boundaries |
| `.watchdog.json` | Circuit-breaker state (tmp+rename), survives restarts; `restartRequested` persisted before exit-86 escalation, cleared only by the first successful cycle |
| `.sentinel.json` (+ `.sentinel.json.last`) | SERVER-side remediation-ladder state for the run (written by `cosmo23/server/lib/run-sentinel.js`, not the engine); archived to `.last` on user stop — evidence is never silently deleted |
| `events.jsonl` + `events-<stamp>.jsonl.gz` | Hash-chained event ledger + gzipped rotation rolls (`ledger.maxBytes` / `ledger.keepRolls`); broken-chain tails preserved as `events-<stamp>.unchained.jsonl` |
| `outputs/` | Agent deliverables |
| `coordinator/` | Review plans, strategic snapshots |

Save guard (every save, `brain-snapshot.js`): the known-good baseline resolves snapshot → manifest → streamed sidecar count → legacy inline state; a save dropping a >100-node brain below 50% of that baseline is refused with a structured result (`reason: 'catastrophic_node_drop'`). Existing-but-unreadable state fails closed as `persistence_guard_failed` — mapping it to "fresh" would bless an overwrite of a real brain. The old cycles-0-1 guard was dead code (it read `state.json` while saves write `state.json.gz`). The in-memory memoized baseline is refreshed ONLY by a successful save; its provenance can read `'last-save'` when the post-save `brain-snapshot.json` stamp failed (no snapshot exists on disk, so the cache is never labeled with a source that isn't really there — orchestrator.js `_knownGoodCache`).

---

## Critical Invariants

1. **Guided exclusivity blocks autonomous spawning.** Check `isGuidedExclusiveRun()` before any new spawning code.
2. **`plan:main` is the canonical plan key.** Exactly one active plan at a time.
3. **Tasks use `taskId` for agent correlation, not `goalId`.** Since the Jan 2026 rebuild.
4. **SpawnGate runs before every agent spawn.**
5. **Checkpoint writes are atomic** (temp file + rename).
6. **Shutdown timeout (180s) must exceed agent wait timeout (150s).**
7. **Save-safety guard runs on EVERY save** — `brain-snapshot.json` is the known-good baseline; a save dropping a >100-node brain below 50% is refused with a structured result (brain-snapshot.js). Baseline resolution: snapshot → manifest → sidecar count → legacy inline; existing-but-unreadable state fails closed as `persistence_guard_failed`.
8. **Deferred spawn must happen after plan display.**

---

## Testing

Run from `engine/` directory:

```bash
npm run test:unit            # tests/unit/**/*.test.js (10s timeout)
npm run test:integration     # tests/integration/**/*.test.js (30s timeout)
npm run test:single-instance # Unit + single-instance tests (60s)

# Single test:
npx mocha tests/unit/guided-mode-planner.test.js --timeout 10000
```

Key test files for this directory:
- `tests/unit/guided-mode-planner.test.js`
- `tests/unit/spawn-gate.test.js`
- `tests/unit/orchestrator-guided-continuation.test.js`
- `tests/unit/timeout-manager.test.js`
- `tests/unit/graceful-shutdown-handler.test.js`
- `tests/unit/crash-recovery-manager.test.js`
- `tests/unit/path-resolver.test.js`
- `tests/integration/orchestrator-plan-execution.test.js`
- `tests/single-instance/crash-recovery.test.js`

Phase 1 persistence-integrity suites live in the Home23 root harness (run from the repo root with `npm test`): `tests/cosmo23/state-compression-atomicity.test.cjs`, `brain-snapshot-guard.test.cjs`, `graceful-shutdown-honesty.test.cjs`, `crash-recovery-scalar-checkpoints.test.cjs`, `state-hydration.test.cjs`, `brain-backups.test.cjs`.

Phase 2 self-awareness suites (also Home23 root harness): `tests/cosmo23/engine-heartbeat.test.cjs`, `event-ledger-hygiene.test.cjs`, `resource-backpressure.test.cjs`, `cycle-watchdog.test.cjs`, `run-sentinel.test.cjs`.

---

## Common Pitfalls

1. **Guided mode does NOT allow `mixed` execution.** `normalizeExecutionMode()` always returns `guided-exclusive`.
2. **Plan not created if `stateStore` is null.** Plan is generated in memory but never persisted.
3. **Cycle timeouts now ACT — but only at the hard deadline, and nothing aborts an in-flight LLM call.** `timeout-manager`'s cycle timer is still monitoring-only, and there is no AbortSignal plumbing. What changed (Fix 2.2): at `max(cycleTimeoutMs × 3, 10 min)` the CycleWatchdog abandons the cycle at the boundary (orphan contained — no new cycle until it settles), trips the breaker, and escalates a never-settling orphan to a supervisor restart (exit 86).
4. **xAI `grok-4` crashes if `reasoning_effort` is passed.** Guard at `unified-client.js:404`.
5. **Sleep blocks plan execution** unless `activePlan.status === 'ACTIVE'` in ClusterStateStore.
6. **`UnifiedClient` with no `modelAssignments`** silently falls to `super.generate()` — this is by design.
