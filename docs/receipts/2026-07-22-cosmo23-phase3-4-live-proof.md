# COSMO23 Parity Phases 3 + 4 — Live Proof Receipt (2026-07-22)

**Program:** docs/superpowers/specs/2026-07-21-cosmo23-parity-program-design.md, Phases 3 + 4
**Plan:** docs/superpowers/plans/2026-07-22-cosmo23-parity-phase3-4.md
**Commits under proof:** 6e9f1617 → 81f6b2d8 (11 feature commits + doc + composition fix on main)

Phases 3 and 4 shipped together (big-bang parity, disjoint file-sets, orchestrator
wiring + test registration serialized). This receipt records what was proven live on
the real engine + server, and — honestly — what was proven by battery because it ships
default-off.

## The default-off honesty up front

Phase 3's graph-intelligence gates are **config-gated, default off**, and Phase 4's
governance is **observe-only until a budget or tracker is present**. That is the design:
cosmo23 boots byte-for-byte on its legacy path unless an operator arms a knob. So the
live proof has two halves:

- **Default path, live:** what runs on every boot with nothing armed — the streamed
  writer (C3), streamed latent-dataset counting (C6), the operator routes (D5), and the
  vitals regulator in observe-only mode (D1). These were exercised by the real
  clean-boot + hydration + round-trip below.
- **Armed features:** delta compaction (C4) armed for the delta-chain round-trip; the
  spend meter + budget (D2) armed for the self-park drill. The remaining default-off
  gates — anti-slop intake (C1), research GC + governor (C2), community detection (C5),
  consolidation-sleep policy (D4) — were proven by unit arming tests + the mutation
  battery, not by a live armed run. Called out plainly so the receipt claims only what
  was exercised.

## What was proven, live, on the real engine + server

### 1. Clean boot with all 11 features present, legacy path unperturbed
cosmo23 restarted (scoped `pm2 restart home23-cosmo23`, engine idle, standalone load
test green first) with every Phase 3/4 module loaded. `/api/status` healthy, no lane
engaged, no park/wedge state — the default-off contract holding: the new code is in the
process, dormant, and the legacy save/load path is unchanged.

### 2. Large-brain hydration through the streamed writer (C3 + C4, live)
A ~12k-node finale brain was persisted through the production writer
(`persistResearchState` → per-record capture, no full-graph strings at save time — the
C3 change that gave the ~7000× peak-string reduction) and hydrated back on continuation:
manifest sidecars → `🧠 Memory hydrated from manifest sidecars`, node count preserved.
C3 is on the default path; this is the same code every saveState now uses.

### 3. Delta-chain round-trip (C4, armed)
With `deltaCompaction` armed, a base + delta chain was written and replayed: the base
revision plus appended delta records hydrate to the identical graph, `baseWrittenAt`
gating the compaction boundary. Round-trip verified node-for-node against the pre-save
graph — the delta path does not lose or double-count records across the base boundary.

### 4. Spend self-park (D2 + D1 + D5, armed) — the Phase 4 capstone
A run was launched with a deliberately tight token budget (`spend.maxTokens`) and left
to work. The regulator did exactly what governance is for:

- The spend meter accumulated real usage across the LLM clients; RunVitals computed the
  utilization ratio and drove the spend lane to **critical** past `criticalRatio`.
- The run **self-parked**: `.park.json` written with
  `reason: spend_critical, lane: spend, utilization: 1.329, resumable: true,
  exitCode: 81` — the deliberate governance exit (81), distinct from the watchdog's 86.
- `/api/status` recognized it as **parked, not wedged/crashed**: `parked: true`,
  `intents: ['run_parked']` (D5's derived operator intent), `.clean_shutdown` present —
  an honest, intentional pause, not a failure.

### 5. Operator resume round-trip (D5, live)
`POST /api/resume` on the parked run: `success: true, resumed: true`. `.park.json`
archived to `.park.json.last` (evidence preserved, the sentinel-style discipline),
the run relaunched via the continuation path — `lifecycle: running, activeRun: true,
parked: false`. Then a clean operator stop: `not_running` branch, `parkCleared: true`,
final state `idle, wedged: false, parked: false`. Park → resume → stop, all three
transitions honest and final.

### 6. The live proof caught a real composition bug (the reason this leg mattered)
Before the fix, the exact same tight-budget run **never parked** — it blew straight
through the budget. Two D1/D2 parallel-extraction seams had silently disconnected the
regulator from the meter:

1. D1's constructor placeholder `this.spendMeter = null` ran **after** D2's real
   `getSpendMeter()` binding and nulled it — the vitals `spendProvider` always saw null.
2. RunVitals read `snapshot.totalTokens`, but the meter nests usage under
   `snapshot.totals.totalTokens` (USD under `snapshot.usd`) — so even when wired, the
   ratio was never computed and the lane stayed `unpriced`/ok.

All 16 offline unit tests missed it: the fixtures encoded the wrong flat snapshot shape,
so they agreed with the bug. Only a live run with a real meter could surface it.
**Fix (81f6b2d8):** removed the stale placeholders, corrected the shape read, bridged
the `progressAssessor` to D3's `progressLane.getLane()`, added real-SpendMeter
integration tests, and corrected the 6 wrong fixtures. Re-verified end-to-end after the
fix: critical (166% of budget) → PARK, warn (83%) → pacing engaged. That verified
behavior is what produced the park in §4.

## Gates passed before / around the live proof

- **cosmo23 engine mocha:** 1088 passing.
- **Governance + Phase-3 suites** green, including the 2 new real-SpendMeter integration
  tests and singleton isolation via `resetSpendMeterForTests()`.
- **Standalone load tests** (the sacred pre-restart rule): real legacy brains load
  `inline` intact; the seeded 12k finale brain hydrates from manifest; the delta-chain
  brain round-trips — all before any engine restart.
- **Mutation battery 5/5 killed**, each suite red under its mutation and green on a
  verified-clean revert:
  1. anti-slop intake rejects a hallucinated tool-call transcript (C1),
  2. GC never prunes a protected-tag node (C2),
  3. delta compaction respects the `baseWrittenAt` boundary (C4),
  4. community detection is a pure relabel — never a node move (C5),
  5. spend lane parks at `criticalRatio`, paces at `warnRatio` (D1/D2).

## Honest notes on method

- **Default-off is a feature, not a gap.** The graph-intelligence gates ship dormant by
  design; arming them per-brain is an operator decision. Their invariants are pinned by
  the mutation battery and unit arming tests rather than a live armed run — this receipt
  does not claim live production exercise for C1/C2/C5/D4.
- **Budget was set deliberately tight** to force the park inside a short run. The meter
  measured real token usage from real LLM calls; the budget is the only synthetic input.
- **Drill runs were removed after the proof** (`phase34-finale-large-brain`,
  `phase4-governance-proof-*`); the server was returned to default config and verified
  idle afterward. No temporary governance/spend config was left in
  `cosmo23/.cosmo23-config/config.json`.
- **The composition bug is the headline.** A big-bang parallel extraction is exactly
  where wiring seams hide, and the offline suite was complicit because its fixtures
  matched the wrong shape. The live park drill is what made the two systems actually
  touch. This is the second time in the program a live drill caught what green unit
  suites missed (Phase 2's catalog-relaunch bug was the first) — the pattern is the
  point.

## Phase 3 + 4 commit ledger

**Phase 3 (graph intelligence):** 6e9f1617 (C3 per-record capture, ~7000× peak-string
reduction) · 591731d3 (C6 streamed latent-dataset line count, was quadratic) · 21a5988d
(C1 anti-slop node-intake gate, default off) · 8b8a58a0 (C2 research-timescale GC +
enforcing governor, default off) · 4c889c08 (C4 delta compaction, gated default off) ·
acc3fc8f (C5 in-cycle community detection, gated default off).

**Phase 4 (native governance):** 442de4dc (D5 operator rails — derived intents,
parked-run recognition, /api/resume; Patch 72) · 1484a10d (D2 spend metering across LLM
clients + budget) · a26f7714 (D3 progress lane — commitments + starvation detection) ·
8c8fb218 (D1 run vitals + regulator with spend/progress park) · 460faa53 (D4
policy-driven consolidation sleep, default legacy mode).

**Doc + fix:** 189417ae (Phase 3/4 config knobs + `.spend.json`/`.park.json` state
rows) · **81f6b2d8** (composition fix — the live-proof finding).

## Program status

All four parity phases are shipped and live-proven end-to-end:
Phase 1 (kill -9 hydration), Phase 2 (SIGSTOP wedge drill), Phase 3 (streamed writer +
delta round-trip, gates dormant-by-default), Phase 4 (spend self-park → resume → stop).
Commits are on `main`, **not pushed** — push remains jtr's call.
