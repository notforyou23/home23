# COSMO23 Parity — Phases 3+4 Combined Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Appendices carry the complete change specs; this plan is the choreography.

**Goal:** Phase 3 (graph intelligence: anti-slop intake gates, research-timescale decay/GC + governor enforcement, streamed capture, config-gated delta compaction + community detection, ingestion-ceiling fix) and Phase 4 (native governance: spend meter, vitals/regulator with park, progress lane, sleep policy, operator rails) — executed as two interleaved lanes converging on ONE combined live proof.

**Appendices:** `2026-07-22-cosmo23-parity-phase3/spec-C1..C6.md`, `2026-07-22-cosmo23-parity-phase4/spec-D1..D5.md`. Validation status: C1/C3/C4/C5/D1/D4 applied-to-live-tree-and-reverted (receipts in each); C2/D2/D3/D5 scratchpad-mirror validated. Apply by exact TEXT anchor; re-grep every anchor at apply time (hot tree); each appendix lists its trailing-whitespace traps and apply-order constraints.

## Execution schedule (conflict-driven)

`orchestrator.js` is touched by C1, C2, C4, C5, D1, D2, D3, D4 — those tasks NEVER run concurrently with each other. `package.json` + `tests/cosmo23/package-test-registration.test.cjs` are touched by ALL tasks — **commits are serialized by the controller** (paired tasks: second implementer holds its commit until the controller releases it, then rebuilds registration blobs from live HEAD and verifies post-commit that all previously-registered suites survive).

- **Round 1 (parallel):** C3 (streamed capture; lib/memory-sidecar.js only) ∥ C6 (latent-projector fix + audit pins)
- **Round 2 (parallel):** C1 (anti-slop gate; network-memory + orchestrator + new module) ∥ D5 (operator rails; server-only — lands Patch 72's API-surface half; sentinel-skips-parked; /api/resume)
- **Sequential (each with review overlap allowed):** C2 (decay/governor) → C4 (delta compaction, gated) → C5 (community detection, gated) → D2 (spend meter — appends launch-key paragraph to Patch 72) → D3 (progress lane) → D1 (vitals/regulator + park engine-half; aligns lane-handle with D3's `orchestrator.progressLane`) → D4 (sleep policy; aligns `_governanceCriticalLanes` probe to D1's landed handle)
- **Doc/sweep task:** config-knob + State Files doc pass (memory.intake/gc/governor, governance.*, spend.*, .park.json/.spend.json rows), engine mocha sweep, CLAUDE.md truth — collected in ONE task at the end to avoid the parallel-CLAUDE.md collision the extractors warned about (C4/D4 carry CLAUDE.md hunks — those two apply their own hunks; the doc task reconciles).
- **Gates:** full npm test; standalone load tests (manifest + legacy brains); mutation battery: intake-gate strip disabled → C1 suite red; GC criteria inverted → C2 red; delta gate forced-on-below-threshold → C4 red; lane critical mapping broken → D1 red; park-file write skipped → D5's sentinel-skip test red.
- **Combined live proof:** (1) seeded large manifest brain (production writer, ≥12k nodes) + gates ON (intake/gc/delta/community armed via run config) → run cycles → verify delta appends (manifest revisions advance without full rewrites), intake-gate counters in stats, community relabel ledger event; kill -9 mid-delta-chain → restart → hydration replays chain to full counts (THE delta-safety proof). (2) governance drill: launch with spend.maxTokens tiny → run parks itself (exit 81, .park.json, parked:true in status, run_parked intent) → POST /api/resume → run resumes via continuation → then /api/stop finality. Receipt + memory update.

## Cross-task contracts (from the extractors' own negotiation — enforce at dispatch)
1. **Patch 72 is SHARED:** D5 lands the entry (API surface); D2 appends its launch-key paragraph to the SAME entry (renumber if 72 gets claimed by an outside session first).
2. **Lane handle alignment:** D3 exposes `orchestrator.progressLane.getLane()`; D1's regulator consumes it and exposes the regulator handle; D4's `_governanceCriticalLanes()` probes `researchRegulator`/`governanceRegulator` with `getLaneStates()`/`getLanes()` — whoever lands later aligns in their single helper edit point.
3. **`memory:` config block is shared by C1 (intake), C2 (gc/governor), C4 (deltaCompaction), C5 (communityDetection)** — later tasks MERGE under the one top-level key, never duplicate the block.
4. **C4's stricter-than-donor CAS** (full rewrite per boot) and C3's per-record capture are order-independent (validated on both file variants) — but both touch memory-sidecar.js: C3 lands first (Round 1), C4 re-greps.
5. Ledger event names are namespaced and already chosen per appendix (memory_intake_gate, memory_delta_compaction, community detection events, governance_*, sleep_policy_consolidation, progress_lane_transition) — no renaming.
6. All engine work: NO patch-log entries (doctrine); D5+D2's server surface: the ONE Patch 72 entry.
7. Every implementer: surgical registration staging, rebuild-from-live-HEAD at commit time, post-commit verify prior registrations survive, NEVER git stash.
