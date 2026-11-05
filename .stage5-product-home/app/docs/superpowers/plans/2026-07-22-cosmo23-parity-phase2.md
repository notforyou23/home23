# COSMO23 Parity — Phase 2: Self-Awareness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give cosmo23 runs the ability to notice and survive their own failures: heartbeat + wedge detection, a cycle watchdog that acts, resource backpressure, a tamper-evident event ledger, and a server-side remediation sentinel (spec: `docs/superpowers/specs/2026-07-21-cosmo23-parity-program-design.md`, Phase 2) — plus the four deferred Phase 1 polish items.

**Architecture:** Engine-side signals first (heartbeat liveness vs cycle-progress; watchdog/breaker persisted state; backpressure object; hash-chained ledger), then the server-side sentinel that consumes them (detect → bounded stop+relaunch via the live-proved continuation path → additive `wedged` status escalation). Saves stay sacred everywhere: nothing in this phase may skip, degrade, or race a state save.

**Tech Stack:** identical to Phase 1 (node:test `.cjs` suites at repo root, registered twice; cosmo23 engine mocha; cosmo23 first-class editable — ONE patch-log entry this phase, for the sentinel's server-API surface).

---

## How to read this plan

Six appendices in `docs/superpowers/plans/2026-07-22-cosmo23-parity-phase2/` carry the complete change specs (anchors + full code + full test files + API notes): B1 heartbeat, B2 watchdog/breaker, B3 resource enforcement, B4 ledger, B5 sentinel, B6 Phase-1 polish. Validation status: **B3 and B6 were applied to the real tree, suites run green, then byte-reverted**; B1, B2, B4, B5 were validated in scratchpad mirrors (all suites green there). Apply by exact TEXT anchor only; every appendix lists its trailing-whitespace traps and mandates re-running `grep -cF <anchor>` immediately before each edit — **the tree is actively shared with other sessions.**

**Approved design deviations** (argued in the appendices' API notes; do not re-litigate, do flag if the tree contradicts them):
- B2: no hard-abort of in-flight LLM calls (only one client has signal plumbing). Watchdog-at-cycle-boundary with contained abandonment; if the orphaned cycle promise is still pending when cooloff expires → restart escalation (`process.exit(86)`, breaker state persisted, dirty marker → Phase 1 recovery makes this cheap and safe). `watchdog.minHardTimeoutMs` floor default 10min; soft timeouts don't count toward the breaker by default; a hard timeout trips the breaker immediately.
- B3: ResourceMonitor owns the backpressure object; orchestrator aliases it (same instance). Config `resources.rssBudgetMb` (brief's `resourceLimits.*` accepted as fallback spelling). `critical` blocks even strategic-bypass spawns.
- B4: the named event-logger targets are dead code; the ledger is a NEW module `cosmo23/engine/src/core/event-ledger.js` + compat facade over the dead file; chain design is written fresh (neither donor implements H5). thoughts/dreams/voice rotation = documented YAGNI follow-up.
- B5: wedge threshold flat 15min (server can't know cycleTimeoutMs); kill = `ProcessManager.stopAll()` (no engine-only stop exists); relaunch replays `<runDir>/metadata.json` through the INTERNAL `launchResearch({..., brainId})`; escalation = ADDITIVE `health.wedged` + `health.sentinel` fields.
- B6(c): brain-snapshot tier 1 deliberately NOT memoized (operator escape hatch stays live); only expensive tiers cached.

**Cross-task composition rules:**
- Task order below is dependency order: polish → heartbeat → ledger → resource → watchdog → sentinel. B5 deliberately does not touch the `lastHeartbeat: null,` line B1 rewrites — land B1 first.
- Watchdog (Task 5) and resource monitor (Task 4) SHOULD emit durable events via `this.eventLedger?.log(...)` (never awaited in-cycle) — the ledger lands before them for exactly this reason; B2/B3 appendix code already includes these calls where applicable.
- **CONCURRENT-SESSION RECONCILE (Task 1, mandatory first step):** another session has been doing shutdown-deadline budget work in `graceful-shutdown-handler.js`/`orchestrator.js` (observed by B3/B6 agents mid-extraction, including new shutdown-budget tests). Before applying B6(a), diff the current tree state of both files: if equivalent deadline-budget work already landed (committed or uncommitted), SKIP B6(a) (and its tests if present), note it in the commit body, and verify the arithmetic instead (worst case must fit inside the 180s hard-kill). Items (b)/(c)/(d) are unaffected.

**Sacred rule:** unchanged from Phase 1 — standalone load test before any engine restart after persistence-adjacent changes. Tasks 1(b/c) and 5 touch save/shutdown paths; the Task 8 gates apply before the Task 9 live proof.

**Commit style:** one commit per task; cosmo23-native, no patch-log entries EXCEPT Task 6's sentinel entry (text ready in appendix B5 — renumber to the next free patch number at execution time; B5 read 71 as free).

---

### Task 0: Preflight

- [ ] cosmo23 idle (`curl -s localhost:43210/api/status` → `activeRun: False`); if a run is active, STOP and ask.
- [ ] `git log --oneline -5` and `git status --porcelain` — record; identify whether the concurrent shutdown-budget work has landed (grep graceful-shutdown-handler.js for `shutdownDeadline` / budget helpers).
- [ ] Baselines: `node --test --test-concurrency=1 tests/cosmo23/graceful-shutdown-honesty.test.cjs tests/cosmo23/brain-snapshot-guard.test.cjs tests/cosmo23/crash-recovery-scalar-checkpoints.test.cjs tests/cosmo23/brain-backups.test.cjs` (green expected) and `cd cosmo23/engine && npm run test:unit 2>&1 | tail -3` (green expected).

### Task 1: Phase-1 polish pack — appendix B6

Files: `cosmo23/engine/src/core/orchestrator.js`, `cosmo23/engine/src/core/graceful-shutdown-handler.js`, `cosmo23/engine/src/core/brain-snapshot.js`, plus test additions to four EXISTING suites (B6's testFile is the complete replacement for `tests/cosmo23/graceful-shutdown-honesty.test.cjs`; the other three suites' additions are anchored changes). No registrations needed.
- [ ] RECONCILE step for (a) per the composition rule above; then apply (a or skip)/(b)/(c)/(d) per appendix, failing-first where behavior changes (B6 proved 10/13 fail pre-fix).
- [ ] All four suites green + cosmo23 mocha graceful-shutdown/crash-recovery green. Commit: `fix(cosmo23): phase-1 polish — shutdown budget, save TOCTOU, guard memoization, journal overlay atomicity`.

### Task 2: Engine heartbeat + status exposure — appendix B1

Files: `cosmo23/engine/src/core/heartbeat.js` (new), `orchestrator.js` (constructor/start/executeCycle-finally/consolidation-return/stop), `cosmo23/server/lib/status-contract.js` (+ its ad-hoc test file), `cosmo23/server/index.js` (optional /api/status echo), `tests/cosmo23/engine-heartbeat.test.cjs` (new) + registrations.
**Require-depth trap:** status-contract → `../../engine/src/core/heartbeat` (TWO levels; the `../../../` precedent in server/lib resolves to the HOME23 engine — wrong).
- [ ] TDD per appendix; run `node --test cosmo23/server/lib/status-contract.test.js` manually too (unregistered legacy suite — must stay 6/6).
- [ ] Commit: `feat(cosmo23): engine heartbeat (liveness vs cycle progress) + status exposure`.

### Task 3: Event ledger — appendix B4

Files: `cosmo23/engine/src/core/event-ledger.js` (new), `cosmo23/engine/src/event-logger.js` (rewritten as compat facade), `orchestrator.js` wiring (init after telemetry; cycle_start/cycle_complete; close in stop() AFTER save/marker logic), `tests/cosmo23/event-ledger.test.cjs` (new) + registrations.
**Anchor note:** the cycle-complete anchor contains a literal `✓` — copy exactly.
- [ ] TDD per appendix (seq resume, chain verify detects tampering, rotation+gzip+retention, torn-tail handling).
- [ ] Commit: `feat(cosmo23): hash-chained rotating event ledger (seq survives restarts)`.

### Task 4: Resource backpressure — appendix B3

Files: `cosmo23/engine/src/system/resource-monitor.js` (extended), `cosmo23/engine/src/agents/agent-executor.js` (spawn gate + effective concurrency), `orchestrator.js` (alias + injection), `tests/cosmo23/resource-backpressure.test.cjs` (new) + registrations.
**Whitespace traps in agent-executor anchors** (two 4-space-only lines) — appendix lists them.
- [ ] TDD per appendix (hysteresis transitions, critical blocks all spawns incl. strategic, saves-sacred source pin).
- [ ] Commit: `feat(cosmo23): resource backpressure — hysteresis levels gate agent spawns, saves untouched`.

### Task 5: Cycle watchdog + circuit breaker — appendix B2

Files: `cosmo23/engine/src/core/cycle-watchdog.js` (new), `orchestrator.js` (start-loop rewire returning boolean → `continue`; executeCycle outcome plumbing), `tests/cosmo23/cycle-watchdog.test.cjs` (new) + registrations.
- [ ] TDD per appendix (trip/cooloff/revive with fake clock; hard-timeout containment; restart-escalation path asserts persisted `.watchdog.json` + exit backstop wiring via source pin, not by actually exiting).
- [ ] cosmo23 mocha: timeout-manager + orchestrator suites still green.
- [ ] Commit: `feat(cosmo23): cycle watchdog acts — contained abandonment, persisted breaker, restart escalation`.

### Task 6: Run sentinel — appendix B5 (+ patch-log entry)

Files: `cosmo23/server/lib/run-sentinel.js` (new), `cosmo23/server/lib/status-contract.js` (ADDITIVE fields only — do not touch B1's lastHeartbeat line), `cosmo23/server/index.js` (wiring: start with server, stopEngine/relaunch internals, /api/status flattened `wedged`), `tests/cosmo23/run-sentinel.test.cjs` (new) + registrations, `docs/design/COSMO23-VENDORED-PATCHES.md` (append B5's ready-made entry; renumber to next free).
- [ ] TDD per appendix (ladder, bounds, escalation-once, grace periods, TTL prune, 409-race handling, context_without_process path).
- [ ] `node --test cosmo23/server/lib/status-contract.test.js` still 6/6.
- [ ] Commit: `feat(cosmo23): run sentinel — wedge detection, bounded relaunch ladder, additive wedged status (patch NN)`.

### Task 7: Mocha sweep + doc truth

- [ ] `cd cosmo23/engine && npm run test:unit && npm run test:single-instance` — update ONLY assertions encoding pre-Phase-2 behavior; report each.
- [ ] `cosmo23/engine/src/core/CLAUDE.md`: Timeout Protection + Pitfall #3 now describe the acting watchdog; State Files gains `.heartbeat`, `.watchdog.json`, `.sentinel.json` (run dir), `events.jsonl` + rolls; Key Config Fields gains `heartbeat.intervalMs`, `watchdog.*`, `resources.rssBudgetMb` + `resources.backpressure.*`, `ledger.maxBytes/keepRolls`, `shutdownDeadlineMarginMs` (if Task 1(a) applied), sentinel env/config keys noted as server-side. Verify every default at its code site.
- [ ] Commit: `docs(cosmo23): self-awareness invariants + config truth`.

### Task 8: Verification gates

- [ ] Full `npm test` (root) — green.
- [ ] Standalone load test (Phase 1 snippet) on the newest run brain — intact counts.
- [ ] Mutation spot-checks, each mutate→red→revert→green: (1) breaker trip threshold ∞ → watchdog suite red; (2) sentinel maxAttempts unbounded / ladder guard inverted → sentinel suite red; (3) ledger prevHash computed from constant → chain-verify test red; (4) backpressure critical block disabled → resource suite red. `git diff` clean of mutations after.

### Task 9: Live proof

- [ ] Launch a real 4-cycle research run (embeddings fixed at ebd20d2b — expect REAL nodes this time; verify snapshot nodes > 0).
- [ ] While running: `.heartbeat` file present and ticking (ts advances; lastCycleEndTs advances per cycle); `/api/status` shows `lastHeartbeat` non-null + `heartbeat` block + backpressure in engine stats; `events.jsonl` growing with chained records.
- [ ] Wedge drill: `kill -STOP <engine child pid>` (cwd-verified PID discipline from Phase 1). Both signals go stale → sentinel detects after threshold, runs the ladder: stopAll (SIGKILL path since the child is stopped), relaunch continuation, run resumes with hydrated brain. Verify `.sentinel.json` attempt record + recovery reset after cycles resume. (SIGCONT cleanup if anything lingers.)
  **Drill threshold setup:** the sentinel lives in the cosmo23 SERVER process. To lower the threshold for the drill, add the `sentinel:` block (wedgeThresholdMs ~120000, checkIntervalMs ~15000, launchGraceMs ~60000) to the config file the server actually reads (managed: `cosmo23/.cosmo23-config/config.json` — verify via `/api/setup/status` configDir), then restart ONLY that process: `pm2 restart home23-cosmo23` (NEVER bulk pm2 commands — 50+ unrelated processes on this box). Engine must be idle at restart (it is — drill precedes the launch). REVERT the config values and note the revert in the receipt after the drill.
- [ ] Let the run finish: honest marker, ledger `verifyLedgerChain` clean end-to-end, backup landed, node counts preserved.
- [ ] Receipt `docs/receipts/2026-07-22-cosmo23-phase2-live-proof.md` + commit.

## Out of scope (documented follow-ups)
thoughts/dreams/voice rotation (shared-writer refactor + two readers); realtime/event-logger.js dead-code cleanup; hard-abort signal plumbing across the four LLM clients; receipts/evaluation/coordinator queue growth (B4 survey).
