# Context-outage scan budget

Date: 2026-09-11  
Branch: `home23-agent/owned-embedder-stage5-verify`  
Follows: `309f565f` / `1905b579` (outage keyword fallback).  
Does **not** replace Linux install revision `be625487` or rewrite that transfer.

Measured attention calibration and Stage 6 remain unfinished / NO-GO.

## What was inspected

| Mechanism | Bound | Outage scan used it? |
|---|---|---|
| Context-fast ANN miss | Skip `iterateNodes` entirely | Preserved. Unrelated to encoder outage. |
| `runLogicalSourceScan` heaps | `maxCount ≤ 1000`, 8 MiB / 256 KiB | Caps retained rows, not visits. |
| `assembleContext` | `BRAIN_SEARCH_TIMEOUT_MS = 8_000` + turn signal | Abort → `TimeoutError`, no partial hits. |
| `searchContext` HTTP | `statusReadMs ?? 10_000` | Aborts the request; server cancels. |
| `/api/memory/search` | `requestAbortController` on client close | Cancel, not a degraded result. |
| `throwIfAborted` per node | Cooperative only | Kept. Budget exhaustion is separate. |

`309f565f` made context-outage use the same two-pass full iterate as default
search. Visit count on a 301-node on-disk fixture was **602** (two full
passes). That is unbounded relative to the turn path.

## Contract after this commit

Applies **only** when `mode=context`, `exhaustive` is not true, and
fallback reason is `embedding_unavailable` or `embedding_invalid`.

| Budget | Default | Test override |
|---|---|---|
| Node visits across both passes | `4000` | `contextOutageScanVisitBudget` (1…4000) |
| Wall time from budget arming | `1500` ms | `contextOutageScanDeadlineMs` (0…60000) |

When either budget hits:

- Stop pass 1; skip pass 2 if already exhausted.
- Return any keyword hits already found.
- `evidence.fallback.reason` stays `embedding_unavailable` / `embedding_invalid`.
- `evidence.fallback.completeness` becomes `incomplete`.
- `evidence.completeCoverage` is `false`.
- `evidence.sourceHealth` stays `degraded`.
- `evidence.fallback.scan` records `{ visitBudget, visits, exhausted, exhaustedBy }`.

Caller abort still **throws**. It is not rewritten into an incomplete
success. Default (non-context) search ignores these budgets. Context-fast
ANN-missing still does not scan.

HTTP `pickSearchParameters` does not forward the test-only budget fields.
Production context-outage uses the defaults above.

## Verification (not wall-clock benchmarks)

On-disk `rewriteMemoryBase` fixtures, 301 nodes (300 filler + hydro).
Visit counts from a wrapper around `iterateNodes` (gzip jsonl reader).

| Case | Result |
|---|---|
| Late hydro, visit budget 40 | `visits` 40–41; hydro absent; `scan.exhaustedBy=visit_budget`; incomplete / degraded |
| Early hydro, visit budget 40 | hydro returned; still incomplete (corpus not fully walked) |
| Deadline `0` | `visits ≤ 1`; hydro absent; `exhaustedBy=deadline` |
| Default mode + same 301-node disk + budget 40 / deadline 0 | `visits ≥ 301`; hydro found; completeness complete |
| ANN missing, encoder up | `scans === 0` (existing test) |
| Abort after 12 on-disk yields | `AbortError` / `cancelled`; not a success payload |
| Two-node lexical outage | still complete coverage (corpus fits the budget) |

Full `tests/engine/dashboard/memory-search.test.js`: 67 pass after the change.

## Remaining limitation

`4000` / `1500ms` are a responsiveness policy, not a measured calibration
against a live large home. A pathological record size could still spend
most of 1500 ms on fewer than 4000 visits. That is accepted for this
scoped follow-up.
