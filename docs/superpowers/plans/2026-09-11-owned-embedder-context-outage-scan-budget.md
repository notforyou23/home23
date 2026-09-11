# Context-outage scan budget

Date: 2026-09-11  
Branch: `home23-agent/owned-embedder-stage5-verify`  
Follows: `309f565f` / `1905b579` (outage keyword fallback), then `5e567a8f`
(visit/deadline budgets). Caller-abort fd follow-up: `2ce5bda5`.
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
| `throwIfAborted` per node | Cooperative after each yield | Kept. Budget exhaustion is separate. |
| Caller abort during a pending read | `readJsonl` abort listener closes a dup'd stream fd, then `destroy()` | Unblocks an in-flight positioned read. Does not `Promise.race` an abandoned scan. Already-buffered gzip inflate can still finish the current chunk. |

`309f565f` made context-outage use the same two-pass full iterate as default
search. Visit count on a 301-node on-disk fixture was **602** (two full
passes). That is unbounded relative to the turn path.

## Contract after this commit

Applies **only** when `mode=context`, `exhaustive` is not true, and
fallback reason is `embedding_unavailable` or `embedding_invalid`.

| Budget | Default | Test override |
|---|---|---|
| Node visits across both passes | `4000` | `contextOutageScanVisitBudget` (1…4000) |
| Cooperative deadline after each yielded node | `1500` ms | `contextOutageScanDeadlineMs` (0…60000) |

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

The 1500 ms figure is **not** a hard mid-await ceiling. `consumeLogicalVisit`
samples `performance.now()` only after `iterateNodes` yields a node. A slow
gzip/jsonl chunk can overrun that mark before the next check. Caller abort is
a different path: it is wired into `readJsonl`, which closes the stream’s
dup’d fd and then destroys the streams so the same generator/finally releases
handles. That unblocks a pending positioned read. It does not invent a
`Promise.race` that leaves the scan running.

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

Author `memory-search.test.js` at `5e567a8f`: 67 local. Grok Bot at that
revision: **65 pass / 2 fail** (isolated ANN worker; missing `hnswlib-node`
addon after `--ignore-scripts`). Those two failures are not passing
verification.

## Remaining limitation

`4000` visits and the cooperative 1500 ms check are a responsiveness policy,
not a measured calibration against a live large home. A pathological record
can still spend most of that window on one pending inflate/read before the
next yield. Caller abort can interrupt a pending positioned read; it cannot
preempt CPU already spent inflating the current chunk. Large-brain
wall-clock remains unproven.
