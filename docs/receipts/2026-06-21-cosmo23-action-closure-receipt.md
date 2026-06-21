# COSMO23 Action Closure Receipt — 2026-06-21

## Scope

Reviewed COSMO23's role in Home23, the `jerrysideshows` run, and the query
exports under:

- `cosmo23/runs/jerrysideshows`
- `cosmo23/runs/jerrysideshows/exports`

The repair targets the underlying closure problem: COSMO23 could identify the
needed work but still mark tasks complete without the required artifact, and
source-required research could degrade into absence prose instead of a hard
blocked state.

## Live State

- Home23 PM2 family was online.
- Jerry state API reported `cycle=29693 nodes=115045`.
- COSMO23 API was reachable and idle: `running=False activeRun=False`.
- After patch load, `pm2 restart home23-cosmo23` was run by process name only.
  PM2 reported `home23-cosmo23` online; `/api/status` was reachable with
  `success=true`, `lifecycle=idle`, and `activeRun=false`.

## Run Evidence

- `run.json`: original topic `jerry Garcia side project show details`, created
  `2026-06-02T21:59:18.588Z`.
- `run-metadata.json`: continued on `2026-06-21T14:26:49.384Z` as
  `jerry Garcia side project show anecdotes`, `enableWebSearch=true`,
  `enableDirectAction=false`, `enableIDEFirst=true`, `primaryProvider=ollama-cloud`.
- `state.json.gz`: `cycle=135`, `memory.nodes=972`, `memory.edges=4147`.
- `outputs/show-details.json`: valid JSON with 31 show records across 10
  projects.
- `outputs/legion-of-mary-shows-raw.json`: 78 Legion of Mary rows.
- `outputs/side-projects-catalog.json`: 10 project records, but invalid JSON.
- Missing deliverables:
  - `outputs/jerry-garcia-side-projects-shows.md`
  - `outputs/garcia_side_projects_show_list.md`
  - `outputs/raw-anecdotes/web-search-results.json`
  - `outputs/raw-anecdotes/archive-org-comments.json`
- `tasks/task:synthesis_final.json`: `state=DONE`, `artifacts=[]`,
  `producedArtifacts=[]`, with deliverable spec requiring
  `jerry-garcia-side-projects-shows.md`.
- Archived `done_task:synthesis_final.json`: completed using IDE log/summary
  artifacts, not the required markdown deliverable.

## Export Evidence

- `query_2026-06-02T23-05-24_do_we_have_show_specific_info_.md`: data exists,
  final synthesis markdown missing.
- `query_2026-06-21T14-58-52_do_we_have_fan_anecdotes__.md`: zero fan
  anecdotes after many cycles and agents.
- `query_2026-06-21T14-59-47_wow.md`: graph mapped where anecdotes might live
  but extracted none.
- `query_2026-06-21T15-00-42_is_there_nothing_in_the_research_at_all_.md`:
  zero fan anecdotes, interview quotes, or narrative excerpts; web search
  failed with `400 invalid_request_error: function name or parameters is empty
  (2013)` in retrieved run evidence.

## Root Cause

Two closure gates were too weak:

1. `PlanExecutor.validateTaskOutput()` accepted any artifact in `outputs/` when
   acceptance criteria existed. It did not enforce `metadata.expectedOutput` or
   `metadata.deliverableSpec`.
2. `PlanExecutor.completeTask()` dropped validated artifacts when
   `TaskStateQueue` was present, enqueuing only an artifact count.

Research had a separate fail-open path:

3. `ResearchAgent` could continue to LLM knowledge fallback when all web
   searches failed, even for missions that explicitly required source URLs,
   forum anecdotes, citations, or Archive.org/review-thread retrieval.

## Changes

- `cosmo23/engine/src/core/plan-executor.js`
  - Enforces expected output files from `metadata.expectedOutput`,
    `metadata.deliverableSpec`, task deliverables, and `@outputs/...` paths in
    acceptance criteria.
  - Fails validation when named outputs are absent or empty.
  - Adds present expected outputs as `expected_output_contract` artifacts.
  - Forwards `artifacts` and `producedArtifacts` through queued completion.
  - Resolves the output root through a guarded helper so missing aliases fail
    validation cleanly instead of throwing.
- `cosmo23/engine/src/agents/research-agent.js`
  - Tracks search failures.
  - Fails closed for source-required missions when every search fails or no
    source URLs are found.
  - Keeps knowledge fallback available for non-source-required exploratory
    missions.
- `docs/design/COSMO23-VENDORED-PATCHES.md`
  - Adds Patch 27.
- `docs/superpowers/plans/2026-06-21-cosmo23-action-closure.md`
  - Durable implementation plan.

## Verification

Red tests observed before implementation:

- `npx mocha cosmo23/engine/tests/unit/plan-executor-execution-types.test.js`
  failed because unrelated output files passed validation and queued completion
  dropped artifact arrays.
- `npx mocha cosmo23/engine/tests/unit/research-agent-handoff.test.js` failed
  because source-required search failure reached knowledge fallback.

Passing checks after implementation:

```bash
npx mocha cosmo23/engine/tests/unit/plan-executor-execution-types.test.js cosmo23/engine/tests/unit/research-agent-handoff.test.js
```

Result: 18 passing.

```bash
node --test --test-concurrency=1 tests/cosmo23/pgs-engine.test.cjs tests/cosmo23/query-engine-context.test.cjs tests/cosmo23/query-engine-runtime.test.cjs tests/cosmo23/anthropic-client-request.test.cjs tests/cosmo23/synthesis-config-generator.test.cjs
```

Result: 36 passing.

```bash
node -c cosmo23/engine/src/core/plan-executor.js
node -c cosmo23/engine/src/agents/research-agent.js
```

Result: both syntax checks passed.

```bash
git diff --check -- cosmo23/engine/src/core/plan-executor.js cosmo23/engine/src/agents/research-agent.js cosmo23/engine/tests/unit/plan-executor-execution-types.test.js cosmo23/engine/tests/unit/research-agent-handoff.test.js docs/design/COSMO23-VENDORED-PATCHES.md docs/superpowers/plans/2026-06-21-cosmo23-action-closure.md docs/receipts/2026-06-21-cosmo23-action-closure-receipt.md
```

Result: no whitespace errors.
