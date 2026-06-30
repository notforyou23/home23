# COSMO23 Interactive + Planning Repair Receipt

Date: 2026-06-30

## Trigger

During the live `jerrynotes` run, the Interactive tab told the user the run was
stopped at cycle 7 with 43 nodes / 132 edges, while the live COSMO logs and
`/api/status` showed the run still active. The same run also generated an
initial plan that treated "Avoid all primary sources - search secondary and
forums" as "web search is prohibited."

## Root Causes

1. `/api/interactive/start` reused a server-global `interactiveSession` without
   checking whether it belonged to the current active run.
2. New interactive sessions hydrated a lightweight orchestrator from
   `state.json.gz` once, then prompt/status tools treated those fields as live.
   The hydrated object had no `running` field, so `get_run_status` defaulted to
   `running:false`.
3. `research-contract.js` detected source wording before honoring local-only or
   no-acquisition source scope, leaving local IDE tasks with source-required
   provider hints.
4. `guided-mode-planner.js` used a broad `avoid ... search` no-web regex, so
   "avoid primary sources - search secondary and forums" disabled web research.

## Changes

- Added `cosmo23/server/lib/interactive-live-status.js` to build live
  interactive status from the status contract plus run counters.
- Wired Interactive start/message/status routes to refresh same-run sessions,
  invalidate different-run sessions, validate `sessionId`, and expose live
  context.
- Updated interactive prompt, `get_run_status`, and `brain_stats` to prefer the
  live provider and label the status source/timestamp.
- Made local/no-acquisition source scope a hard override in research contracts,
  including malformed supplied contracts on resumed tasks.
- Updated guided planning so avoiding primary sources remains a secondary/forum
  source-acquisition request, not a no-web request.
- Documented the change as Patch 33 in
  `docs/design/COSMO23-VENDORED-PATCHES.md`.

## Live Actions

- Stopped the bad active `jerrynotes` run through `POST /api/stop`.
- Restarted only `home23-cosmo23` with `pm2 restart home23-cosmo23`.
- Started and stopped a smoke Interactive session on `jerrynotes` after restart
  to verify the new status payload without making an LLM call.

## Verification

Passed:

```bash
npx mocha cosmo23/engine/tests/unit/interactive-session.test.js \
  cosmo23/engine/tests/unit/interactive-live-status.test.js \
  cosmo23/engine/tests/unit/research-contract.test.js \
  cosmo23/engine/tests/unit/source-provider-registry.test.js \
  cosmo23/engine/tests/unit/research-agent-handoff.test.js \
  cosmo23/engine/tests/unit/execution-base-agent.test.js \
  cosmo23/engine/tests/unit/data-acquisition-agent.test.js \
  cosmo23/engine/tests/unit/plan-executor-execution-types.test.js \
  cosmo23/engine/tests/unit/run-commitment-governor.test.js \
  cosmo23/engine/tests/unit/guided-mode-planner.test.js \
  cosmo23/engine/tests/unit/guided-mode-planner-context-detection.test.js \
  --timeout 30000
```

Result: `239 passing`.

```bash
node --test --test-concurrency=1 \
  tests/cosmo23/pgs-engine.test.cjs \
  tests/cosmo23/query-engine-context.test.cjs \
  tests/cosmo23/query-engine-runtime.test.cjs \
  tests/cosmo23/anthropic-client-request.test.cjs \
  tests/cosmo23/anthropic-provider-adapter.test.cjs \
  tests/cosmo23/synthesis-config-generator.test.cjs
```

Result: `38 pass`.

```bash
node --test --test-concurrency=1 \
  cosmo23/server/lib/status-contract.test.js \
  cosmo23/server/lib/brains-router.test.js \
  cosmo23/server/lib/continuation-state.test.js
```

Result: `13 pass`.

Syntax checks passed for the touched runtime files:

```bash
node -c cosmo23/server/lib/interactive-live-status.js
node -c cosmo23/server/index.js
node -c cosmo23/engine/src/interactive/interactive-session.js
node -c cosmo23/engine/src/interactive/interactive-tools.js
node -c cosmo23/engine/src/core/research-contract.js
node -c cosmo23/engine/src/core/guided-mode-planner.js
```

Post-restart live status:

```json
{
  "running": false,
  "activeRun": false,
  "lifecycle": "idle",
  "processStatus": { "running": [], "count": 0 }
}
```

Post-restart planner decision for the exact `jerrynotes` wording:

```json
{
  "threadRelation": "fresh",
  "evidenceMode": "external_gap",
  "webPolicy": "targeted",
  "noWebRequested": false,
  "hasUsableLocalContext": false
}
```

Post-restart Interactive smoke context for `jerrynotes`:

```json
{
  "source": "live_status",
  "running": false,
  "lifecycle": "idle",
  "runName": "jerrynotes",
  "cycle": 14,
  "memoryNodes": 92,
  "memoryEdges": 299
}
```
