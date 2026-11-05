# Outage keyword scan vs context-search deadline

Status: **not established on a larger brain.** The two-document Linux
fixture and the new two-node unit tests do not prove the scan finishes
inside the turn enrichment deadline.

## What the follow-up changed

Context-fast still skips a full logical scan when the encoder works and
ANN is missing (`ann_missing`, `completeness: incomplete`). When the
encoder is unavailable or invalid, context-fast now allows the same
keyword-only `runLogicalSourceScan` used by default search.

That scan is a **two-pass full iterate** of `source.iterateNodes`
(candidates, then authority). Result heaps are bounded
(`maxCount <= 1000`, `MAX_HEAP_BYTES = 8 MiB`, `MAX_RECORD_BYTES = 256 KiB`).
Those bounds cap retained candidates, not how many nodes are visited.

## What bounds time

`memory-search.js` has **no internal wall-clock budget** for this scan.
It only cooperates with `request.signal` via `throwIfAborted` per node.

Callers:

| Path | Bound | Notes |
|---|---|---|
| Comment in `memory-search.js` | “2s deadline” | Reason context-fast exists; not an implemented timer |
| `assembleContext` | `BRAIN_SEARCH_TIMEOUT_MS = 8_000` plus the turn signal | Live pre-turn path |
| `searchContext` HTTP | `statusReadMs ?? 10_000` | Aborts the request; server `requestAbortController` then cancels the scan |
| Dashboard `/api/memory/search` | client disconnect / abort only | No extra 2s server timer |

If the scan overruns, the caller gets `TimeoutError` /
`context_enrichment_timeout` (or HTTP `cancelled`), **not** partial
Memory Lite hits. Cancellation is fail-closed; it is not a bounded
degraded result.

## Evidence that exists

- Two-node context-outage unit test: hydro lexical hit in ~50–180 ms.
- Default-mode in-memory two-pass with >5000 unrelated events: ~1.3 s
  in this session; not context-outage, not on-disk, not a deadline
  assertion.
- Million-candidate heap test: ANN path, explicitly **without** a
  logical base scan.

## Remaining limitation

On a large on-disk brain, encoder outage in `mode=context` can start a
full two-pass walk that is only heap-bounded and abort-cooperative.
Whether that finishes before the 8 s enrichment / 10 s HTTP deadline is
**unproven**. That is why context-fast originally refused the scan.

Do not treat the two-document Linux home as proof. A large-brain timing
measurement is unfinished and is not part of this transfer.
