# Query/PGS reliability verification receipt — 2026-07-20

## Scope

This receipt compares the current checkout with the latest GitHub `main`
commits from 2026-07-13 that hardened Query/PGS reliability, then records a
fresh deterministic and live readback of the Query/PGS path.

## Git comparison

- Remote refreshed with `git fetch --prune origin`.
- July 13 reliability tip: `7f5483ef0bd9558850501b147d48f9dac6e1655f`
  (`fix: keep live Query verification wait-aware`).
- `git merge-base --is-ancestor 7f5483ef... HEAD`: exit `0`.
- All 37 July 13 Query/PGS commits from `03859fcd` through `7f5483ef` are
  ancestors of the checkout. No GitHub patch was missing or cherry-picked.
- The checkout contains 123 later commits after `7f5483ef`; it is 68 commits
  ahead of the freshly fetched `origin/main` at `2dc1cd66`.
- Later local work already extends the July 13 regression surface for recovered
  progress, provider-stall continuation, evidence authority, durable sessions,
  and partition coarsening.

## Deterministic verification

Command:

```bash
node --test --test-concurrency=1 \
  tests/scripts/verify-query-notebook-live.test.mjs \
  tests/engine/dashboard/query-progress.test.js \
  tests/engine/dashboard/query-notebook-service.test.js \
  tests/engine/dashboard/pgs-session-authority.test.cjs
```

Result: **80 passed, 0 failed, 0 skipped** in 4.405 seconds.

The matrix includes idempotent starts, activity-aware waits, transient status
failures, signed PGS stall recovery, continuation reuse, monotonic multi-window
progress, recovered settled progress, public projection validation, SSE detach/
reconnect, server-gap recovery, and durable PGS session authority.

`git diff --check`: pass before receipt creation.

## Fresh live Query/PGS readback

The live verifier used Jerry's selected dashboard and the exact catalog pairs:

- Direct Query: `openai-codex / gpt-5.6-terra`
- PGS sweep: `openai-codex / gpt-5.4-mini`
- PGS synthesis: `openai-codex / gpt-5.4-mini`
- PGS level: `skim`

The default 30-second HTTP budget timed out while the current large live source
was being pinned. The accepted operation still completed durably. The verifier
was rerun with its existing bounded `--http-timeout-ms 300000` control. Its
monitoring shell was later interrupted before final JSON assembly, so the proof
below is a fresh protected status/result readback, not a claim that the wrapper
exited successfully.

### Direct Query

- Operation: `brop_p228xoC2MtA_0S65mi8jcpA0DW1oufAc`
- Protected status/result HTTP: `200 / 200`
- State/stage: `complete / terminal`
- Event sequence: `39`
- Result bytes: `5,376`; answer bytes: `3,575`
- Result SHA-256:
  `98bb2eb5f32d5e4b2954311a8e921bcff6bdba4b193f8a59b87bc7db194e82dd`
- Public `queryNotebookStatus` and `queryNotebookResult` schema validation:
  pass.

### PGS

- Operation: `brop_RdRM4vFJ2d6mXeM6caJePXFwl--Zdhzb`
- Protected status/result HTTP: `200 / 200`
- State/stage: `complete / terminal`
- Pinned source: `31,188` nodes / `104,282` edges
- Selected/completed/successful: `112 / 112 / 112`
- Failed/retryable/scope-pending: `0 / 0 / 0`
- Synthesis batches: `8 / 8`
- Coverage: `skim`, fraction `0.1`, scope complete, global full coverage false
  with `1,005` global work units intentionally pending.
- Result bytes: `8,919`; answer bytes: `6,382`
- Result SHA-256:
  `d141ab5bd9fee6296d3bb8a0847803f30567a25996bcdf6bfd0c686137b50b42`
- Public `queryNotebookStatus` and `queryNotebookResult` schema validation:
  pass.
- Authorized follow-up actions include `continueSweep` and `export`.

Current readback after verification: `home23-jerry-dash` and
`home23-cosmo23` are both `online` with PM2 restart count `0`. This records
current state only; it does not claim PID continuity across the run.

## Outcome

No July 13 GitHub reliability commit was missing from the local stack. The
current focused tests preserve and extend those contracts, and fresh protected
readback proves both Direct Query and a real 112-work-unit PGS skim reached
terminal results with exact public projections. The remaining caveat is live
source-pin latency relative to the verifier's default 30-second HTTP budget;
the 300-second bounded invocation completed the operation path, but the wrapper
did not retain its final combined JSON after the monitoring interruption.
