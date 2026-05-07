# Session 2026-05-07 Handoff

## Headline

COSMO23 Query/PGS was repaired for small completed research runs, the full active Home23 worktree was checkpointed, committed, and pushed, and the agent-facing docs were refreshed so the next session starts from current truth instead of May 1 assumptions.

## What Changed

- `cosmo23/lib/pgs-engine.js`
  - Added `PGS_DIRECT_QUERY_MAX_NODES` / `directQueryMaxNodes` with default `200`.
  - PGS now falls back to direct enhanced Query for small brains instead of partitioning a tiny run.
  - Larger graphs that collapse to one partition now return the single sweep output directly instead of running cross-partition synthesis.
  - Full-mode progress/session accounting now reports selected partitions completed instead of leaving the whole graph listed as remaining.
- `cosmo23/lib/query-engine.js`
  - PGS dispatch passes through output-file, follow-up, prior-context, provider, and model options so the direct fallback preserves normal Query behavior.
- `tests/cosmo23/pgs-engine.test.cjs`
  - Added direct-fallback and single-partition-skip coverage.
- `docs/design/COSMO23-VENDORED-PATCHES.md`
  - Added Patch 20: small-run and single-partition Query/PGS fallback.

## Root Symptom

jtr pasted a COSMO23 Query log where a 24-node / 75-edge completed research brain routed through PGS, loaded one cached partition, spent about 80 seconds sweeping, and then synthesized caveats about having only one successful partition. That is the wrong product behavior: a tiny completed run should use the normal Query path and include run outputs directly.

Exact problematic run located during diagnosis:

- Route key: `5dd6925b26cb08f1`
- Path: `/Users/jtr/_JTR23_/release/home23/cosmo23/runs/which-methodological-choices-in-mechanistic-interpretability-research-are-load-bearing-for-multiple-downstream-results-but-have-never-been-independently-validated`
- Graph: 24 nodes / 75 edges / one partition

## Verification

Passed:

```bash
node --test --test-concurrency=1 tests/cosmo23/pgs-engine.test.cjs
node --test --test-concurrency=1 tests/cosmo23/query-engine-context.test.cjs tests/cosmo23/query-engine-runtime.test.cjs tests/cosmo23/anthropic-client-request.test.cjs
node -c cosmo23/lib/pgs-engine.js
node -c cosmo23/lib/query-engine.js
```

Also verified the exact 24-node run through a no-model smoke path: the PGS request emitted the small-brain fallback event and re-entered direct Query with `enablePGS=false`, while preserving `includeFiles` and prior context.

Scoped runtime action:

```bash
pm2 restart home23-cosmo23
```

## Git State

The active Home23 worktree was cleanly checkpointed after the COSMO23 fix:

- Commit: `6746e86 chore: checkpoint active home23 work`
- Branch: `main`
- Remote: `origin/main`
- Status after push: clean

Important operating rule reinforced by jtr: do not treat Home23 worktree changes as disposable "dirty" files. This repo is built by jtr through agents. Preserve pending local work, inspect overlaps, and only stage/commit deliberately. When jtr asks to get everything checkpointed so the repo is no longer described as dirty, include all intended current work.

## Live State At Handoff

Verified on 2026-05-07 around 10:34 EDT:

- Home23-family PM2 processes online: `home23-jerry`, `home23-jerry-dash`, `home23-jerry-harness`, `home23-forrest`, `home23-forrest-dash`, `home23-forrest-harness`, `home23-dashboard`, `home23-evobrew`, `home23-cosmo23`, `home23-screenlogic`, `home23-chrome-cdp`.
- Jerry `/api/state`: cycle ~6730, brain snapshot ~65.1k nodes / ~110.9k edges.
- Jerry `/api/thinking/stats`: `cognitionMode=legacy_roles`, `thinkingMachineRunning=false`.
- Jerry `/api/live-problems`: 0 open, 0 chronic, 12 resolved.
- Jerry `/api/good-life`: policy `help`; viability healthy; continuity strained; usefulness watch; development/coherence/friction healthy; recovery watch.
- COSMO23 `/api/status`: running; active run `labor23`, brain `e3f63b402a2ff674`, ports `43210` / `43240` / `43244` / `43247`.
- Jerry chat default in `instances/jerry/config.yaml`: `openai-codex / gpt-5.5`.
- Agent tool registry in `src/agent/tools/index.ts`: 48 registered tools.

## Next Watch Items

1. For COSMO23 Query problems, verify the exact route key, run path, graph size, and whether Query is using direct mode or PGS before editing.
2. For small completed runs, expect direct Query behavior. PGS should only add value on larger graphs.
3. For Good Life, the May 1 CPU/contention live problem is no longer open at this handoff; continuity remains strained due to open goals and pending agenda.
4. Keep `.claude` project memory and root `AGENTS.md` / `CLAUDE.md` / `README.md` current after significant live-system changes.
