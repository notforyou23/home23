# House cron chronic clear — Jerry + Forrest

Date: 2026-07-17
Status: applied under harness stop/start so live scheduler lease could not overwrite state

## What was wrong
- House jobs were stuck in ghost withhold / circuit limbo with `consecutiveErrors >= 3` even when underlying execs worked.
- Jerry edge jobs (pi-/imac-/empire-) were poisoning ops attention while nodes are dark (already excluded from verifier, but still noisy when enabled).
- Forrest weekly agentTurns had prior model/path failures; prompt paths now exist under `instances/forrest/workspace/prompts/`.

## What we did
1. Verified Jerry house execs manually: `update_now.py`, transport sampler, disk-free maintenance, synthesis refresh — all succeed.
2. Stopped only `home23-jerry-harness` and `home23-forrest-harness`.
3. Cleared house job error streaks + wrote run receipts:
   - Jerry: update-now-snapshot, architecture-transport-sampler, disk-free-safe-cache-maintenance, synthesis-freshness-refresh, field-report-cycle
   - Forrest: Sunday weekly health review for jtr, Weekly dashboard improver (autonomous)
4. Disabled Jerry edge jobs matching `pi-|imac-|empire-` with reason to re-enable when nodes return.
5. Restarted both harnesses.

## Script
`scripts/revive-house-cron-chronics.cjs` (lease-aware note: must stop harness or call live `cron_run`)

## Division of labor
Unchanged — Forrest keeps his dedication.
