# COSMO23 Action Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent COSMO23 guided runs from marking tasks complete when required output files are missing, and prevent failed web/tool actions from being converted into successful-looking research artifacts.

**Architecture:** Keep COSMO23's existing guided planner, artifact registry, and TaskStateQueue. Tighten the execution boundary: task validation must check the task's explicit `metadata.expectedOutput` and final `metadata.deliverableSpec`, and queued task completion must carry the artifact closure that was validated. Research agents must return a failed or blocked result when every requested search fails instead of fabricating a successful fallback.

**Tech Stack:** Node.js CommonJS, Mocha/Chai unit tests under `cosmo23/engine/tests/unit`, COSMO23 vendored source under `cosmo23/engine/src`.

## Global Constraints

- Preserve existing Home23/COSMO23 vendored patch contracts in `docs/design/COSMO23-VENDORED-PATCHES.md`.
- Do not restart all PM2 processes; if runtime restart is needed, restart only `home23-cosmo23`.
- Do not discard existing uncommitted Home23/Codex work.
- Use TDD: add failing regression tests before production code.

---

### Task 1: Enforce Expected Output Contracts

**Files:**
- Modify: `cosmo23/engine/src/core/plan-executor.js`
- Modify: `cosmo23/engine/tests/unit/plan-executor-execution-types.test.js`

**Interfaces:**
- Consumes: `this.activeTask.metadata.expectedOutput`, `this.activeTask.metadata.deliverableSpec`, `this.pathResolver.resolve('@outputs')`.
- Produces: `PlanExecutor.validateTaskOutput()` returns `passed: false` with `reason` naming missing expected output files when required files are absent.

- [ ] **Step 1: Write failing tests**

Add tests that instantiate `PlanExecutor` with a temp output directory and verify:

```js
const task = {
  id: 'task:synthesis_final',
  title: 'Assemble Final Deliverable',
  acceptanceCriteria: [{ type: 'qa', rubric: 'Final deliverable exists at @outputs/jerry-garcia-side-projects-shows.md' }],
  metadata: {
    expectedOutput: '@outputs/jerry-garcia-side-projects-shows.md',
    deliverableSpec: { filename: 'jerry-garcia-side-projects-shows.md', location: '@outputs/' }
  }
};
```

With only unrelated `summary.json` present in `@outputs`, `validateTaskOutput([])` must fail. After creating `jerry-garcia-side-projects-shows.md`, it must pass and return that file as a required artifact.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx mocha cosmo23/engine/tests/unit/plan-executor-execution-types.test.js
```

Expected: the new missing-output test fails because current validation accepts unrelated artifacts.

- [ ] **Step 3: Implement validation**

Add a helper in `PlanExecutor` that parses comma-separated expected output strings and deliverable specs, resolves `@outputs/...` through `pathResolver`, checks file existence and size, and requires those files to be present before generic artifacts can satisfy acceptance criteria.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npx mocha cosmo23/engine/tests/unit/plan-executor-execution-types.test.js
```

Expected: all PlanExecutor tests pass.

### Task 2: Preserve Validated Artifacts Through TaskStateQueue

**Files:**
- Modify: `cosmo23/engine/src/core/plan-executor.js`
- Modify: `cosmo23/engine/tests/unit/plan-executor-execution-types.test.js`

**Interfaces:**
- Consumes: `PlanExecutor.completeTask(task, artifacts)`.
- Produces: `TaskStateQueue.enqueue({ type: 'COMPLETE_TASK', artifacts, producedArtifacts })`.

- [ ] **Step 1: Write failing test**

Add a test with a fake `taskStateQueue.enqueue` spy and call:

```js
await pe.completeTask({ id: 'task:phase1', title: 'Phase 1' }, [{ path: 'required.md', artifactId: 'artifact_1' }]);
```

The queued event must include `artifacts` and `producedArtifacts` with the required artifact.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx mocha cosmo23/engine/tests/unit/plan-executor-execution-types.test.js
```

Expected: the new queue test fails because current queue completion drops artifact arrays.

- [ ] **Step 3: Implement queue forwarding**

Pass `artifacts` and `producedArtifacts: artifacts` into the queued `COMPLETE_TASK` event.

- [ ] **Step 4: Run test to verify it passes**

Run the same Mocha command and verify all tests pass.

### Task 3: Fail Closed When Research Search Produces No Sources

**Files:**
- Modify: `cosmo23/engine/src/agents/research-agent.js`
- Modify: `cosmo23/engine/tests/unit/research-agent-handoff.test.js`

**Interfaces:**
- Consumes: `ResearchAgent.performLocalWebSearch()` and `ResearchAgent.execute()` search result collection.
- Produces: explicit failed/blocked search result metadata when every search fails or returns zero source URLs.

- [ ] **Step 1: Write failing tests**

Add unit coverage that stubs local web search failure and verifies the agent does not return `success: true` when no sources or URLs were found for a source-required mission.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx mocha cosmo23/engine/tests/unit/research-agent-handoff.test.js
```

Expected: the new test fails because current local search returns prose like `Search failed...` and the agent can continue to synthesize.

- [ ] **Step 3: Implement fail-closed search accounting**

Track failed/empty searches separately from successful searches. If every requested search failed or returned no source URLs, return `success: false`, `status: 'blocked_search_failed'`, and an evidence payload listing attempted queries and errors.

- [ ] **Step 4: Run focused tests**

Run:

```bash
npx mocha cosmo23/engine/tests/unit/research-agent-handoff.test.js
```

Expected: all ResearchAgent tests pass.

### Task 4: Verify COSMO23 Regression Surface

**Files:**
- Modify: `docs/design/COSMO23-VENDORED-PATCHES.md`

**Interfaces:**
- Consumes: test results from Tasks 1-3.
- Produces: Patch note documenting output-contract validation and search fail-closed behavior.

- [ ] **Step 1: Run focused regression suite**

Run:

```bash
npx mocha cosmo23/engine/tests/unit/plan-executor-execution-types.test.js cosmo23/engine/tests/unit/research-agent-handoff.test.js
node --test --test-concurrency=1 tests/cosmo23/artifact-loop.test.cjs tests/cosmo23/query-engine-context.test.cjs tests/cosmo23/query-engine-runtime.test.cjs
```

- [ ] **Step 2: Syntax check modified files**

Run:

```bash
node -c cosmo23/engine/src/core/plan-executor.js
node -c cosmo23/engine/src/agents/research-agent.js
```

- [ ] **Step 3: Add vendored patch note**

Append a concise Patch 27 entry covering the root issue and verification commands.
