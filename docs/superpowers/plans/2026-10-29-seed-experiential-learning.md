# Seed Experiential Learning Implementation Plan

> **For agentic workers:** execute the owned tasks below in the existing coordinated worktree. The owner has authorized implementation; no additional plan approval is required.

**Execution:** Implemented and verified locally. Runtime activation is a separate operator action; this plan does not authorize it.

**Goal:** Make attributable experience change later decisions through the existing Seed, with reproducible causal evidence and intact history.

**Architecture:** Extend versioned developmental state and receipts with scoped decisions, attributed feedback and per-lesson retention. Runtime selectors capture their choices and consume read-only learned state; ordinary facts remain observations. Historical receipts preserve their original interpretation.

**Tech Stack:** TypeScript, CommonJS shared contracts, Node test runner, existing hash-chain/checkpoint/event-ledger infrastructure.

**Spec:** [Seed experiential learning](../../design/SEED-EXPERIENTIAL-LEARNING.md). The owner authorized all identified learning-loop gaps, rather than only the first outreach pilot.

## Global Constraints

- Preserve the same Seed, history, original receipts, current encoder and single-writer authority.
- Use existing development/event/relationship structures; add no parallel learning service or memory database.
- Require authenticated owner evidence or appropriately scoped observed outcomes; silence and self-assessment cannot become approval.
- Preserve direct replies, Stop, owed Work, critical escalation/recovery and unrelated curiosity.
- Test isolated fixtures with recorded model responses; never mutate the live home to prove a claim.

## Review Focus

- Delayed feedback must credit its original decision rather than later unrelated residue.
- Fresh execution evidence must not prove accomplishment, owner satisfaction or unrelated beliefs.
- Owner instructions persist until revision; inferred lessons stay provisional and scoped.
- Missing/torn feedback coverage must not fabricate current learned authority.
- Same episode/model/prompt controls must distinguish learned decisions from fixed authored policy.

## Task 1: Core learning and evidence contract

Owner: seed_learning_core. Files: substrate source/tests, shared/seed-learning.cjs, shared tests, src/substrate/learning-state.ts.

- [x] Add failing tests for decision-time eligibility, scoped feedback, matched evidence, per-lesson consolidation and restore/replay.
- [x] Implement bounded versioned learning within developmental state and exact applied receipts.
- [x] Export normalization, snapshot and actual-decision evaluation APIs for TS/CJS consumers.
- [x] Preserve legacy accepted semantics; new resolutions distinguish assessment from learning-grade evidence.
- [x] Verify positive/negative outcomes, ambiguity, duplicate evidence, contradictory feedback and unrelated controls.

## Task 2: Authenticated teaching and durable delivery

Owner: seed_teaching_ingress. Files: relationship-ledger.ts, tools/relationship.ts, tools/promote.ts and related tests.

- [x] Add supported attenuation and scoped conduct feedback with exact authenticated source words.
- [x] Preserve target decision/scope/exclusions through existing events.
- [x] Make teaching projection recoverable and deduplicated independently from memory storage.
- [x] Verify agent notes cannot manufacture owner authority and factual promotions do not change conduct.

## Task 3: Engine and outcome consumers

Owner: seed_decision_consumers. Files: engine cognition/outreach/feedback/orchestrator, canonical execution projection and related tests.

- [x] Capture real decisions and feed read-only scoped learning into existing admission.
- [x] Preserve durable reservation identity and original witness through retry.
- [x] Separate execution reliability from accomplishment and owner value.
- [x] Prove an otherwise eligible optional decision changes under targeted ablation; preserve escalation, recovery, health context and direct results.

## Task 4: Foreground relevance and learning

Owner: root. Files: context-assembly.ts, session-bootstrap.ts, seed-now.ts, trigger refresh in AgentLoop and relevant tests.

- [x] Replace unrelated first-turn/cue bypasses with relevant optional operational admission.
- [x] Consume scoped learning at the actual context selector and receipt its decision.
- [x] Select carried expectations/thoughts against the current conversation instead of repeatedly surfacing unrelated operational material.
- [x] Refresh triggered memory from actual store changes without restarting long-lived loops.
- [x] Verify personal conversation, explicit operational requests, short follow-ups, owed work and partial-context recovery.

## Task 5: Integration and proof

Owner: root, with fresh independent review.

- [x] Run focused tests after each owned change, then affected suites/typechecks once integrated.
- [x] Add end-to-end matched tests: authenticated feedback → Seed → actual choice; factual update → relevant knowledge without conduct penalty; witnessed prediction/outcome → original eligible lesson.
- [x] Document exact causal claims and limits, including unchanged critical/unrelated controls.
- [x] Review task-only diff, commit, integrate safely into maintained main, and append land receipts.
- [x] Report source/test/integration status separately from deployment and lived acceptance.
