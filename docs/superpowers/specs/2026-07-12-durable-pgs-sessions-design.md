# Durable PGS Sessions Design

**Date:** 2026-07-12
**Status:** Approved

## Objective

Make every PGS mode honest, durable, efficient, and usable from the Home23 Query tab. PGS must support cumulative coverage levels, continuation that reuses already completed sweeps, explicit targeted scopes, durable reconnect/cancel behavior, and bounded local storage without copying a large graph projection for every continuation.

## Current Failure

The pinned PGS implementation safely stores work units and completed sweeps in SQLite, but the database lives in one operation's private scratch directory. A fractional operation becomes terminal `partial`; a new operation gets a new scratch directory and cannot use the prior ledger. The store binding also omits the query even though sweep outputs are query-specific, so exposing reuse without a stronger binding could mix answers from different questions. The current fraction is applied to remaining work rather than total work, and its lexicographic ordering biases early levels toward the first partitions.

## User Contract

PGS exposes two separate controls:

- **Coverage level:** `skim` = 10%, `sample` = 25%, `deep` = 50%, `full` = 100% of eligible work units.
- **Session mode:** `fresh`, `continue`, or `targeted`.

Levels are cumulative targets. A `sample` session followed by `deep` executes only the additional work needed to reach 50%. A later `full` continuation executes only the remaining work. Coverage selection is deterministic and round-robin across partitions so early levels represent the graph rather than one lexical cluster.

`fresh` creates a new durable session. `continue` requires a prior PGS operation ID from the same owner and session lineage, reuses its successful sweeps, and may only expand cumulative coverage or retry unfinished work. `targeted` requires an explicit bounded list of canonical partition IDs and synthesizes only outputs in that requested scope. A targeted continuation may monotonically add targets; it cannot silently remove or substitute prior targets.

## Durable Session Authority

One protected PGS session database is reused across its operation lineage. The session root is created under ignored local runtime state for the selected agent and is addressed only by a server-issued opaque session ID. Public requests never supply filesystem paths. The operation coordinator authorizes access using the prior operation record and passes a validated session capability to the worker.

The session database is never copied into each continuation operation. Operations keep their own event/result/receipt artifacts, while the session database owns the graph projection, work-unit ledger, successful sweep outputs, and immutable binding. An exclusive session lock prevents concurrent continuation writers. Readers validate the exact regular-file and directory identities before and after access. Missing, replaced, symlinked, hard-linked, corrupt, or concurrently owned session state fails closed.

Sessions have a bounded retention policy. The API reports `continuableUntil`; expired sessions are unavailable for continuation and are removed only by the scoped session cleanup path. Quota accounting includes the session database and its SQLite sidecars. Cleanup never follows links or leaves the selected agent's runtime boundary.

The session authority runs that same bounded cleanup once at authority startup
and hourly while the authority is resident, using an unref'd timer that cannot
keep the process alive and an explicit stop hook that drains in-flight cleanup.
This makes expiration autonomous even when PGS is idle. Internal storage status
reports only bounded aggregate facts: session count, active count, actual bytes,
configured maxima and headroom, and the next expiry.

A new session is not reusable merely because its database file exists. The
pinned store marks the projection usable only after the complete projection,
schema, binding, quota, and identity checks succeed. Closing a newly created
session before that mark discards only its exact identity-checked database,
SQLite sidecars, lease, and authority anchor. Continuations and any successfully
published fresh projection are never eligible for this initialization discard.

## Immutable Binding

The session schema version is bumped. A reusable session is bound to:

- canonical query bytes and SHA-256 digest;
- query-normalization version;
- pinned source descriptor digest and exact source revision;
- exact sweep provider/model pair;
- work-unit-defining limits;
- sweep prompt contract version;
- coverage-selection policy version.

The synthesis provider/model is recorded per operation because changing it does not invalidate query-specific sweep outputs. Reuse with any incompatible immutable binding is rejected with a typed mismatch; it never starts fresh silently. Existing schema-v2 operation-local stores are not reusable sessions.

## Scope and Coverage Model

Every work unit receives a stable coverage ordinal produced by round-robin traversal of partition IDs and each partition's unit index. A level scope selects the first `ceil(totalWorkUnits * fraction)` ordinals. A targeted scope selects all work units belonging to the validated partition IDs.

The store persists the requested scope for each attempt. Pending counts and synthesis inputs are filtered by that scope. Results distinguish:

- `scopeSuccessfulWorkUnits`, `scopePendingWorkUnits`, and `scopeComplete`;
- `globalCoveredWorkUnits`, `globalPendingWorkUnits`, and `fullCoverage`;
- `reusedWorkUnits` and `newWorkUnits` for the current operation;
- `coverageLevel`, `coverageFraction`, target partition IDs, session ID, source operation ID, and continuation eligibility.

A level or targeted operation may be complete for its requested scope while full-graph coverage remains false. Provider failure or cancellation preserves only validated committed sweeps. Synthesis failure preserves sweep state but publishes no false success receipt.

## API and Query Tab

PGS requests use:

```json
{
  "pgsMode": "fresh | continue | targeted",
  "pgsLevel": "skim | sample | deep | full",
  "continueFromOperationId": "brop_...",
  "targetPartitionIds": ["c-..."],
  "pgsSweep": { "provider": "...", "model": "..." },
  "pgsSynth": { "provider": "...", "model": "..." }
}
```

`continueFromOperationId` is required for `continue` and targeted continuation, forbidden for a new fresh session, and authorized server-side. `targetPartitionIds` is required only for `targeted`. The server derives the numeric coverage fraction from `pgsLevel`; clients do not define arbitrary fractions.

The Query tab exposes named levels and all three modes, retains operation/session identity in history, displays scoped and global coverage separately, and offers Continue, Reattach, Cancel, and Start Fresh actions when valid. “Stream response” is labeled “Show live progress,” because the route streams durable progress events rather than provider tokens. Detached operations remain reconnectable by operation ID.

Agent-tool PGS launches are start-only: `brain_query` returns the queued/running operation ID immediately without holding the chat turn. Agents use nonblocking status checks and fetch the protected result after terminal state; an explicit wait remains available only when blocking is intentional. Chat Stop detaches an attachment and never substitutes for operation cancellation.

## Error Handling

Typed failures cover invalid mode/level combinations, unauthorized or missing prior operations, expired sessions, binding mismatches, target validation, non-monotonic continuation, session conflicts, filesystem identity changes, quota exhaustion, provider failure, cancellation, and result-size limits. No mismatch, missing state, or exhausted target scope falls back to a new full sweep.

Failure, cancellation, interruption, or process shutdown before a fresh
projection becomes reusable triggers exact initialization discard. Once the
projection is marked usable, the ordinary retention and continuation contract
remains authoritative.

## Verification

Tests must prove:

- 10% to 25% to 50% to 100% is cumulative, deterministic, partition-stratified, and runs no successful work unit twice;
- more than 256 work units can reach full coverage over bounded batches;
- continuation works through the real facade/coordinator/worker path after a prior terminal partial result;
- exact query/source/sweep-pair/limits/prompt/policy bindings reuse and every mismatch refuses reuse;
- targeted synthesis includes only eligible target outputs and target-union continuation is monotonic;
- cross-owner continuation, missing state, expiration, symlink/hard-link/path replacement, and concurrent writers fail closed;
- cancellation, provider failure, synthesis failure, and worker interruption retain only valid reusable work;
- receipts and UI rendering distinguish scoped completion from full coverage;
- local session storage and cleanup remain bounded;
- startup and idle janitor cleanup reclaim only expired lease-free sessions,
  stop the unref'd timer explicitly, retry after failure, and expose bounded
  internal authority telemetry including code-safe janitor health (this is not
  a user-visible Query surface yet);
- failed fresh initialization is discarded, while usable fresh sessions and
  every continuation remain retained;
- direct Query, brain tools, MCP, export, chat history, and manifest-v1 source access do not regress.

Live acceptance requires a fresh fractional PGS run against Jerry's manifest-v1 brain, a continuation that reports reused sweeps and executes only new work, a targeted run with isolated synthesis, durable detach/reattach, and current PM2/route health receipts. A live 100% run may be omitted when its provider cost is disproportionate, but the full path must be proven with deterministic integration fixtures and dry-run validation.
