# Shakedown Codex Automation Cutover Record

Date: 2026-07-25. Plan: Task 5 of `docs/superpowers/plans/2026-07-25-shakedown-jerry-proposer.md`.

## The two formerly-ACTIVE automations

| Codex automation ID | Was | Replacement Home23 cron job | Rollback |
| --- | --- | --- | --- |
| `shakedown-show-detail-enrichment-ops` | ACTIVE daily 15:00 until the 2026-07-24 halt; PAUSED since | `shakedown-collection-daily` (daily 15:00 ET, exec, timeout 1800s) | Set that exact ID's `status` back to ACTIVE in `~/.codex/automations/shakedown-show-detail-enrichment-ops/automation.toml` and disable the cron job |
| `shakedown-publishing-pipeline-scan` | ACTIVE daily 09:30 until the halt; PAUSED since | `shakedown-publish-scan` (daily 09:30 ET, exec, timeout 600s) | Same pattern for `shakedown-publishing-pipeline-scan`; disable the cron job |

Supporting jobs also registered: `shakedown-operator-check` (07:00), `shakedown-editorial-leads` (15:30).

## Parity evidence

Both replacements run the *same fixed entrypoints* the Codex automations ran — the agent layer
contributed narration only (verified in OPERATIONS.md, "Script vs judgment").

- **Collection lane**: supervised runs 2026-07-25 produced receipts structurally identical to the
  last Codex run (2026-07-22): 10 shows, 0 semantic, 1,781 metadata-only changes; verification
  passed; `waiting_for_batch_pair`; `discovery.replayVerified: true`. Receipts:
  `daily-collection-2026-07-25T16-19-18.521Z.json`, `...T16-25-48.246Z.json` vs Codex's
  `daily-collection-2026-07-22T19-03-36.330Z.json`.
- **Scan lane**: 2026-07-25 manual `pipeline:scan` receipt (`runs/2026-07-25T14-58-17-255Z-scan.json`)
  matches the counts trajectory in the Codex automation's memory.md (total 25, alreadyOwnedLive 6,
  alreadyDistributed 24).

- [ ] First cron-fired collection receipt (expected 2026-07-25 ~19:06Z) confirmed same shape,
      `nextRunAtMs` advanced. ← final stamp for this record

## The 19 never-migrated automations

Remain PAUSED and defined in `~/.codex/automations/`. Per the 2026-07-25 design they are NOT
migrated; any revival is deliberate, one at a time, as a Lane 1 script. No definition deleted.

## Codex authority state (context)

2026-07-25: all 38 Codex project trust entries set `untrusted`; the global and per-project
`approval_policy = "never"` lines removed; publishing Chrome supervisor disabled and its
debug-port browser killed. Pre-change config preserved at
`~/codex-forensics-20260724/state/config.toml.pre-untrust-20260725`.
