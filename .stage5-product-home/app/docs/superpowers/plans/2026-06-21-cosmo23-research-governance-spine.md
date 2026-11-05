# COSMO23 Research Governance Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make COSMO23 detect failed/zero research from the beginning of a guided run, retry or block it in the middle, and stop unproductive runs instead of synthesizing around missing evidence.

**Architecture:** Add a small pure research-contract module used by planner, agents, and PlanExecutor. A task that requires external sources gets a contract before launch; agents expose source/action evidence; PlanExecutor refuses completion and marks the plan blocked when source contracts fail after retries.

**Tech Stack:** Node.js CommonJS, Mocha/Chai tests, existing COSMO23 engine state store and agent classes.

## Global Constraints

- Preserve existing Home23 worktree changes and avoid unrelated refactors.
- Do not mutate historical run artifacts in `cosmo23/runs/`.
- Guided-run behavior changes belong in `cosmo23/engine/src/`, not only wrapper UI/server code.
- Research/source-required tasks must fail closed when source acquisition/search cannot produce evidence.
- Command count, log files, manifests, and generic summaries must not satisfy an external-source task by themselves.
- After verification, restart only `home23-cosmo23` if runtime code changed.

---

### Task 1: Research Contract Classifier

**Files:**
- Create: `cosmo23/engine/src/core/research-contract.js`
- Test: add focused tests in `cosmo23/engine/tests/unit/research-contract.test.js`

**Interfaces:**
- Produces: `deriveResearchContract(input): object`, `taskNeedsResearchContract(task): boolean`, `evaluateResearchEvidence(contract, evidence): object`
- Consumes later from planner, agents, and PlanExecutor.

- [ ] Write failing tests for external-source detection on `web_search`, `source_url`, `archive.org`, forum anecdotes, scraping/fetching, citations, and local-only tasks.
- [ ] Implement `deriveResearchContract()` with stable fields: `required`, `mode`, `requiredEvidence`, `requiredQueries`, `minSuccessfulSources`, `reasonCodes`.
- [ ] Implement `evaluateResearchEvidence()` so zero source/action evidence fails with a concrete blocker, while explicit successful source contact can pass even if extracted entries are empty.
- [ ] Run `npx mocha cosmo23/engine/tests/unit/research-contract.test.js`.

### Task 2: Beginning-of-Run Contract Injection

**Files:**
- Modify: `cosmo23/engine/src/core/guided-mode-planner.js`
- Modify: `cosmo23/engine/src/core/plan-executor.js`
- Test: extend `cosmo23/engine/tests/unit/guided-mode-planner.test.js` and `cosmo23/engine/tests/unit/plan-executor-execution-types.test.js`

**Interfaces:**
- Consumes: `deriveResearchContract()`
- Produces: `task.metadata.researchContract` and `missionSpec.metadata.researchContract`

- [ ] Add tests proving guided planner stores research contracts on source-required generated missions and parsed task phases.
- [ ] Add tests proving PlanExecutor injects a missing contract before agent spawn for existing/resumed tasks.
- [ ] Patch planner task creation and PlanExecutor assignment with the contract helper.
- [ ] Run the focused planner and PlanExecutor tests.

### Task 3: Middle Execution Evidence Enforcement

**Files:**
- Modify: `cosmo23/engine/src/agents/research-agent.js`
- Modify: `cosmo23/engine/src/agents/data-acquisition-agent.js`
- Modify: `cosmo23/engine/src/agents/execution-base-agent.js` if needed for evidence extraction
- Test: extend `cosmo23/engine/tests/unit/research-agent-handoff.test.js` and `cosmo23/engine/tests/unit/data-acquisition-agent.test.js`

**Interfaces:**
- Consumes: `mission.metadata.researchContract`
- Produces: source evidence in agent result metadata/accomplishment metrics

- [ ] Add tests proving ResearchAgent treats `researchContract.required` as source-required even when keywords are not obvious.
- [ ] Add tests proving DataAcquisitionAgent with a required source contract is unaccomplished when it runs commands but acquires/contact zero sources.
- [ ] Patch agents to report/pass source evidence and fail command-count-only accomplishment for source-required work.
- [ ] Run focused agent tests.

### Task 4: End-State Stop/Block Governance

**Files:**
- Modify: `cosmo23/engine/src/core/plan-executor.js`
- Modify: `cosmo23/engine/src/core/run-commitment-governor.js`
- Modify: `cosmo23/engine/src/core/orchestrator.js` only if needed to surface blocked-run receipts
- Test: extend `cosmo23/engine/tests/unit/plan-executor-execution-types.test.js` and `cosmo23/engine/tests/unit/run-commitment-governor.test.js`

**Interfaces:**
- Consumes: failed task/phase state and commitment snapshot
- Produces: plan status `BLOCKED` with blocker reason; governor next action `stop_unproductive_run` / `repair_blocked_research`

- [ ] Add test proving exhausted failed phase updates phase and plan to `BLOCKED`.
- [ ] Add test proving governor recognizes blocked guided plans and refuses more work with a stop/repair next action.
- [ ] Patch PlanExecutor blocked-phase behavior and governor decision logic.
- [ ] Run focused PlanExecutor/governor tests.

### Task 5: Verification and Receipt

**Files:**
- Modify: `docs/design/COSMO23-VENDORED-PATCHES.md`
- Create: `docs/receipts/2026-06-21-cosmo23-research-governance-spine-receipt.md`

- [ ] Run focused Mocha tests for new/changed COSMO23 units.
- [ ] Run existing regression tests from Patch 27.
- [ ] Syntax-check changed runtime files.
- [ ] Restart only `home23-cosmo23`.
- [ ] Record the blocker/root-cause summary, commands, and live status in the receipt.
