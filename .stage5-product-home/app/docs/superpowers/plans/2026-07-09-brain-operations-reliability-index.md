# Brain Operations Reliability Execution Index

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the approved Brain Operations Reliability and Cross-Brain Read design as one test-driven program without losing the dependency order or weakening any failure, source-truth, or read-only invariant at subsystem seams.

**Architecture:** Four implementation plans land in a deliberate order around one durable dashboard coordinator. The authority plan establishes identity and operation truth; the source plan establishes immutable revisioned reads; the provider plan makes query, PGS, and synthesis terminal-honest; the agent plan moves every caller onto that protocol and performs the only final live rollout.

**Tech Stack:** Node.js CommonJS and TypeScript, node:test, Vitest, Express/SSE, atomic JSON/JSONL persistence, PM2-scoped live verification.

## Authority Documents

- Design authority: `docs/superpowers/specs/2026-07-09-brain-operations-reliability-design.md`
- Plan A: `docs/superpowers/plans/2026-07-09-brain-authority-operations-foundation.md`
- Plan B: `docs/superpowers/plans/2026-07-09-brain-source-truth.md`
- Plan C: `docs/superpowers/plans/2026-07-09-brain-provider-execution.md`
- Plan D: `docs/superpowers/plans/2026-07-09-brain-agent-integration-rollout.md`

The design wins over any accidental plan wording. This index controls inter-plan order. Each detailed plan controls the exact files, RED/GREEN commands, and task commit.

## Program Constraints

- Execute only in the clean isolated worktree created with `superpowers:using-git-worktrees`.
- Preserve all pending local work in the primary checkout. Never copy ignored runtime state into the worktree or commit it.
- Use strict TDD for every production behavior: write the focused failing test, observe the expected failure, implement the minimum behavior, observe GREEN, then broaden regression coverage.
- Use a fresh implementation subagent for each detailed task, followed by a fresh task-review subagent. Resolve every review finding and re-review before advancing.
- Keep `.superpowers/sdd/progress.md` as the durable task ledger. Record task number, commit, RED evidence, GREEN evidence, review result, and next dependency.
- Before each task, require no staged changes and no unaccounted working-tree changes. Stage only the task's declared paths, inspect `git diff --cached --check` and `git diff --cached`, then commit with explicit path arguments.
- Never run broad PM2 stop/delete/restart commands. No live restart occurs until isolated real-brain load verification succeeds and the final rollout task authorizes the exact named processes.
- Do not write through a foreign brain path. Cross-brain operations may write only to requester-owned operation state/scratch.
- Do not accept zero results without source evidence proving the authoritative route, revision, and filters used.

## Canonical Cross-Plan Contract

Every plan must preserve these names:

    POST /home23/api/brain-operations
    GET  /home23/api/brain-operations/catalog
    GET  /home23/api/brain-operations?state=nonterminal
    GET  /home23/api/brain-operations/:operationId
    GET  /home23/api/brain-operations/:operationId/events?after=<sequence>&attachmentId=<id>
    GET  /home23/api/brain-operations/:operationId/result
    POST /home23/api/brain-operations/:operationId/cancel
    POST /home23/api/brain-operations/:operationId/detach
    POST /home23/api/brain-operations/:operationId/export

Start request:

    {
      requestId,
      operationType,
      target: { agent?, brainId? } | { runId } | omitted,
      parameters
    }

The caller never supplies `requesterAgent` or `idempotencyKey`. The dashboard derives requester identity and computes idempotency. Brain-domain operations accept only `{agent?,brainId?}` and omission means the requester's own resident brain. Owned-run operations require exactly one non-empty canonical `{runId}` with no omission, wildcard, `brainId` alias, or extra field. Requester-domain operations require target omission.

Canonical operation record:

    {
      operationId,
      requestId,
      operationType,
      requestParameters,
      parameters,
      canonicalEvidence,
      recordVersion,
      eventSequence,
      requesterAgent,
      target:
        | {
            domain: 'brain',
            brainId,
            ownerAgent,
            displayName,
            kind,
            lifecycle,
            catalogRevision,
            route,
            canonicalRoot,
            accessMode,
            mutationBoundaries
          }
        | {
            domain: 'owned-run', runId, canonicalRoot, ownerAgent, runState,
            ...canonicalRunMetadata
          }
        | { domain: 'requester', requesterAgent },
      state,
      phase,
      startedAt,
      updatedAt,
      completedAt,
      lastProviderActivityAt,
      lastProgressAt,
      result,
      resultHandle,
      resultArtifact,
      error,
      sourceEvidence,
      sourcePinDescriptor,
      sourcePinDigest,
      sourcePinReleasedAt,
      resultExpiresAt,
      resultExpiredAt,
      metadataExpiresAt
    }

Canonical executor context and return envelope:

    {
      operationId,
      operationType,
      requesterAgent,
      target,
      parameters,
      scratchDir,
      signal,
      sourcePin: PinnedMemorySource | null,
      reportEvent
    }

    {
      state: 'complete' | 'partial' | 'failed' | 'cancelled',
      result,
      resultArtifact?,
      error,
      sourceEvidence
    }

`query` with `enablePGS: true` is normalized to operation type `pgs`. Operation IDs and result handles are references, never bearer credentials. Capability claims bind requester, `targetDomain`, exactly one canonical brain/run/requester target ID, canonical root where applicable, access mode, operation type/ID, nullable source-pin digest, expiry, and one-use nonce.

Provider selection is pair-shaped and server-validated. Direct query accepts only optional `modelSelection:{provider,model}`; PGS accepts only optional nested `pgsSweep:{provider,model}` and `pgsSynth:{provider,model}`. Omitted pairs come from configured server defaults. Flat/model-only/legacy shortcut fields, ambiguous labels, unavailable clients, and capability-incomplete pairs fail before provider work. The coordinator persists caller-supplied pairs only in `requestParameters`, always persists the validated/defaulted pairs in trusted executor `parameters`, and a lost-response retry retains the original trusted pairs across config drift. Synthesis accepts no caller pair and uses its configured server pair.

Provider-stall authority is per in-flight call. Selected, activity, and terminal events carry one authenticated `providerCallId`; query, synthesis, and research compile use stable singleton IDs, PGS sweeps use `pgs:<workUnitId>`, and PGS final synthesis uses `pgs:synthesis`. Activity renews only its matching timer from local receipt/monotonic clocks—child timestamps are diagnostic—so an active sweep or skewed timestamp cannot conceal a silent sibling. PGS durable work-unit state is only `pending` or `complete`; trusted attempt IDs atomically prevent a same-attempt double launch, while failed, cancelled, crashed, and unstarted work stays pending for a later attempt.

Catalog entries publish server-derived `mutationBoundaries: Array<{kind:'brain'|'run'|'pgs'|'session'|'cache'|'export'|'agency',path:string}>` containing every required kind for complete no-write proofs. Results up to 64 KiB may remain inline; larger canonical bytes are atomically stored under requester operation state and returned through a protected random `brres_` handle. `graph_export` is the only full-graph path; its worker returns `result:null` plus exactly `{scratchPath,mediaType:'application/x-ndjson',contentEncoding:'identity',bytes,sha256}`, which the coordinator adopts before terminal visibility; public metadata never exposes `scratchPath`. PGS useful work is machine-readable as `result.sweepOutputs[]`, with the numeric count and retryable partitions under `result.metadata.pgs`; useful partial output is visible to the agent, while zero useful sweeps is `all_failed` with `is_error:true`. Legacy caller-supplied query/answer export is isolated as `ad_hoc_export` with `canonicalEvidence:false`; canonical export always reloads stored operation bytes after requester authorization.

The source provider's coordinator seam is exactly idempotent `pin(canonicalRoot,operationId) -> {descriptor,digest}`. It durably protects one private requester-owned generation/projection and never returns an open source or attaches the store record. The foundation alone calls atomic `attachSourcePin`; a worker later opens a separate process-identity reader pin. Persistence writers consume one immutable `{generation,changes,fullView,summary}` captured under the same no-yield mutation barrier, so committed bytes and summaries cannot observe different generations.

Every source stream is bounded by decompressed bytes, record bytes, retained
projection bytes, and final response bytes. Large committed deltas spill into
requester-operation SQLite rather than unbounded Maps; graph samples cap at
2,000 nodes/8,000 edges plus byte ceilings, and full graphs require asynchronous
`graph_export`. Direct dashboard/MCP compatibility reads resolve fresh canonical
local identity and use an ephemeral requester operation root. Production
AgentExecutor call sites must inject this local source context explicitly for
resident and active-owned-run engines; no bridge invents requester/root identity
or treats `limit:0` as an unlimited graph.

The event stream may emit an authenticated `event_gap` with oldest/latest retained sequences and current status. The client validates it, performs a bounded authoritative status read, advances only to that authenticated cursor, and may repeat status/reconnect cycles with a bounded delay until the attachment deadline. A gap never renews the turn lease. Bounded non-2xx error bodies retain typed `{code,message,httpStatus}` so target refresh policy can distinguish mismatch, unavailable, missing, and ambiguity.

`brain_synthesize action:'run'` is the only synthesis-start action. `status` and `reattach` inspect the durable operation/generation marker through delay, disconnect, and dashboard restart without starting provider work. Research compile uses a private exact-provider adapter and requester-writer capability, never a relabeled public Query executor. Agent-scoped MCP legacy reads use a trusted ephemeral requester operation root, numeric-v1 immutable projection, external lock, process pin, and `finally` cleanup before readiness may advertise the listener.

## Required Execution Order

### Phase 0: Isolate and Baseline

- [ ] Create the ignored worktree and feature branch.
- [ ] Install dependencies appropriate to the repository.
- [ ] Run the repository baseline before production edits.
- [ ] If baseline is not green, classify and record every pre-existing failure, stop, and request operator direction; no production task may start from a red baseline.
- [ ] Initialize `.superpowers/sdd/progress.md` with this phase/order and the exact baseline evidence.

### Phase 1: Authority Foundation

- [ ] Plan A, Task 1 — canonical brain catalog.
- [ ] Plan A, Task 2 — capability secret and trust boundary, including safe existing-install upgrade.
- [ ] Plan A, Task 3 — durable operation store.
- [ ] Plan A, Task 4 — dashboard coordinator and public operation routes.

Gate: public source-requiring operation types remain disabled. The coordinator/store/capability tests must be green before source pins are connected.

### Phase 2: Immutable Source Foundation

- [ ] Plan B, Task 1 — portable contracts and streaming JSONL primitives.
- [ ] Plan B, Task 2 — pinned base-plus-delta logical reader.
- [ ] Plan B, Task 3 — crash-safe manifest writer and ANN watermark CAS.

Gate: prove legacy resident sidecars and legacy research monoliths can stream into requester-owned immutable numeric-v1 projections without target writes, and prove the new writer cannot publish a manifest—or clear dirty state—in a way that loses a concurrent accepted mutation.

### Phase 3: Protected Worker Boundary

- [ ] Return to Plan A, Task 5 — capability-protected COSMO worker boundary using the real source-pin provider from Phase 2.
- [ ] Run Plan A acceptance.

Gate: no internal worker endpoint accepts only an operation ID; every endpoint consumes a fresh bound capability; every terminal path releases the process-local pin exactly once.

### Phase 4: Source Truth Integration

- [ ] Plan B, Task 4 — engine save/load/guard/snapshot/backup integration.
- [ ] Plan B, Task 5 — ANN freshness and honest dashboard search.
- [ ] Plan B, Task 6 — deterministic bounded graph and status operations.
- [ ] Plan B, Task 7 — MCP base-plus-delta consistency.
- [ ] Plan B, Task 8 — agent-scoped MCP runtime availability with loopback binding proved before enablement.
- [ ] Plan B, Task 9 — ordered embedding batches and explicit access mutation.
- [ ] Plan B, Task 10 — source-truth integration verification and documentation checkpoint.

Gate: prove the production persistence-selection/load/save seams offline against representative legacy and manifest fixtures, including the external-temp-clone save path. The integrated Phase 8 pre-restart gate owns the read-only live Jerry/Forrest invocation; no source-only task creates a live receipt or waits for runtime availability.

### Phase 5: Provider and Long-Operation Execution

- [ ] Plan C, Task 1 — normalized provider completion and capabilities.
- [ ] Plan C, Task 2 — cancellation and terminal events through every provider.
- [ ] Plan C, Task 3 — source-pinned mutation-aware QueryEngine.
- [ ] Plan C, Task 4 — retryable read-only PGS with honest partial/failure states.
- [ ] Plan C, Task 5 — query/PGS protected-worker registration.
- [ ] Plan C, Task 6 — durable source-CAS resident synthesis.
- [ ] Plan C, Task 7 — cross-subsystem provider regression and vendored patch record.

Gate: an unterminated final stream frame is parsed; transport heartbeats cannot disguise provider silence; direct Query never materializes the full graph; PGS partitions from the pinned revision through bounded requester-scratch spooling rather than a whole-graph in-memory state; PGS may run for hours without attachment timeout becoming execution failure; failed synthesis cannot become success.

### Phase 6: Agent Migration

- [ ] Plan D, Task 1 — shared BrainOperationsClient with connect/header/status/attachment deadlines and resumable SSE.
- [ ] Plan D, Task 2 — activity-leased turns and one common entrypoint.
- [ ] Plan D, Task 3 — truthful tool results and explicit display truncation.
- [ ] Plan D, Task 4 — migrate all six brain tools.
- [ ] Plan D, Task 5 — migrate and harden the research toolkit.
- [ ] Plan D, Task 6 — move automatic context retrieval and compatibility limits onto the contract.
- [ ] Plan D, Task 7 — register integration tests and record vendored changes.

Gate: no migrated tool directly reads or queries a foreign brain path; all failures surface as `is_error`; automatic context and manual tools share the same source evidence contract.

### Phase 7: Broad Review and Offline Verification

- [ ] Run a fresh full-spec code review across all commits and contracts.
- [ ] Resolve every blocking/high finding and re-run focused tests.
- [ ] Run syntax/type/build checks, full repository tests, contract tests, COSMO suites, and no-write invariants from Plan D.
- [ ] Run `git diff --check`, tracked-local-state checks, and secret/runtime leakage checks.
- [ ] Confirm the approved design spec still says designed/approved, not implemented.

Gate: no live mutation is authorized until all offline verification and review are green.

### Phase 8: Scoped Live Acceptance and Closeout

- [ ] Plan D, Task 8 — execute the scoped live acceptance matrix.
- [ ] Commit/push the green offline branch and reconcile it into the live checkout with the reviewed nonoverlap or temporary three-way procedure while preserving the primary index and pending work.
- [ ] Capture pre-rollout hashes/counts before any named restart.
- [ ] Start/update only exact named Home23 engine/dashboard/harness/COSMO and configured loopback MCP processes required by the plan, only after COSMO idle/operation reconciliation and live read-only persistence gates pass.
- [ ] Prove own-brain, sibling resident-brain, completed research-brain, unknown, unavailable, mismatch, ambiguity, cross-brain no-write, detach/reattach, cancel, restart reconciliation, long PGS, synthesis CAS, MCP parity, bounded graph/query/PGS peak heap without PID replacement, and explicit zero-result canary behavior.
- [ ] Re-read post-rollout counts/hashes and compare against the pre-rollout evidence.
- [ ] Keep every live artifact under one newly created per-rollout audit directory and write an identity manifest separating Jerry-live, Forrest-live, and isolated-fixture operation IDs; never glob stale global temp files or query a fixture ID through a live dashboard.
- [ ] Write the single final dated receipt, then and only then mark the design spec implemented with the receipt path.
- [ ] Run the final verification commands again after receipt/spec edits.
- [ ] Commit portable closeout artifacts and push the feature branch.

## Final Success Conditions

- Every detailed task has RED, GREEN, review, and commit evidence in the SDD ledger.
- All four plan acceptances pass.
- Cross-brain reads are capability-bound, pinned, read-only, and source-evidenced.
- Long provider/PGS operations survive caller wait deadlines and can be reattached without losing durable state.
- Provider failure, cancellation, partial completion, and truncation remain distinguishable end to end.
- Fresh and existing installations both obtain the capability/source machinery safely without destructive setup.
- Live Jerry brain counts remain nonzero and match the expected authoritative snapshot after any scoped rollout restart.
- One final receipt identifies exact commands, results, before/after hashes/counts, operation IDs, and any explicit non-blocking caveats.
- The branch is reviewed, committed, and pushed without absorbing primary-checkout runtime or pending local work.
