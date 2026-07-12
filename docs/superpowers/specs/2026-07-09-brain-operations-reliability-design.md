# Brain Operations Reliability and Cross-Brain Read Design

**Date:** 2026-07-09
**Status:** Implemented and live-verified on 2026-07-10; see `docs/receipts/2026-07-09-brain-tools-hardening.md`
**Author:** Codex + jtr
**Supersedes in part:** docs/superpowers/specs/2026-04-19-brain-tools-rework-design.md
**Related:** docs/design/COSMO23-VENDORED-PATCHES.md, docs/design/STEP16-AGENT-COSMO-TOOLKIT-DESIGN.md

## Summary

Home23 agents cannot reliably use all of their brain and research tools today. The failures are not one timeout bug. The current call chain has fixed caller deadlines, no shared cancellation contract, stale route caching, unsafe full-graph reads, inconsistent cross-brain schemas, source layers that can omit deltas, and provider/PGS failures that are sometimes promoted as successful answers or empty brains.

This design keeps the current agent-facing tool names while placing them behind one shared brain-operation layer. The layer resolves the target for each operation, distinguishes the caller's own brain from an explicitly selected read-only brain, exposes long work as durable operations with progress and reconnectable results, and returns source evidence with every retrieval result. Memory, graph, query, synthesis, research, and MCP paths must use honest result states rather than collapsing failure into success or zero.

The approved cross-brain policy is:

- The caller's own brain is the default.
- Any COSMO-discovered sibling-agent brain or completed research brain may be selected explicitly for read-only operations.
- Unknown or ambiguous targets fail closed.
- Cross-brain operations cannot mutate the target brain, agency state, caches, access metadata, synthesis state, or research processes.

## Confirmed Failure Evidence

The design responds to reproduced failures in the live Jerry installation and source-level defects:

- A July 9 PGS query ran for 207.2 seconds and completed all four sweeps. Final GPT synthesis returned an incomplete response with no content, but PGS returned an HTTP-success answer containing an error string.
- The immediate non-PGS fallback was abandoned by brain_query at exactly its fixed 120-second deadline.
- brain_memory_graph requested the full memory graph. On Jerry's roughly 139,000-node and 455,000-edge brain, the dashboard exhausted its 2 GB heap and restarted.
- brain_synthesize failed immediately afterward because the dashboard had restarted.
- brain_status also requests the full graph after fetching state.
- A fresh read-only baseline on July 10 caught `home23-cosmo23` after repeated sidecar hydration at about 3.9 GiB reported V8 heap, 99.8% heap use, and 99.9% CPU; `/api/health`, `/api/status`, and `/` all returned no response within their 3–5 second probes. The error log then recorded `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`; PM2 restarted the crashed process once, after which `/api/health` returned in about 4 ms and reported heap fell to about 24 MiB. This proves the current failure can starve the control plane and crash even when PM2 initially says `online`.
- research_search_all_brains silently drops per-brain timeouts and can report no relevant findings when every target failed.
- Multiple non-Anthropic tool-loop branches record is_error tool results as success.
- Dashboard search can serve an ANN built from an older base while ignoring newer delta upserts and deletes.
- MCP routes can read intentionally empty inline state and claim a sidecar-backed brain is empty.
- The Home23 query facade allows a caller-supplied brain identifier to disagree with the selected agent.
- Provider stream implementations do not consistently require a terminal success event or reject incomplete/token-limited responses.
- Client disconnects and agent timeouts do not cancel server/provider work, so expensive operations continue after the caller has stopped waiting.

These receipts invalidate two assumptions in the April brain-tool design: non-streaming calls are not sufficient for agent use, and the full /api/memory graph route is not safe.

## Goals

- Make every resident brain and research tool honest, target-aware, cancellable, and observable.
- Let an agent read its own brain by default and explicitly query any discovered sibling or completed research brain.
- Let valid long-running queries and PGS work continue while verified progress or heartbeats arrive.
- Preserve long-operation results across caller disconnects and reconnects.
- Propagate explicit cancellation through the agent, HTTP layer, COSMO, PGS, and provider.
- Stop reporting failed routes as empty brains or failed model responses as successful answers.
- Serve retrieval from an authoritative base-plus-delta view and expose source/index watermarks.
- Bound graph and status calls on the server before materializing results.
- Preserve current tool names and text-oriented responses for existing prompts and SOUL files.
- Add deterministic delayed-response, cancellation, source-truth, graph-scale, provider-terminal, and cross-brain tests.
- Finish with scoped live verification and a dated durable receipt.

## Non-goals

- Cross-brain writes, synthesis, research-process control, access reinforcement, or agency assimilation.
- A broad redesign of the COSMO or Home23 dashboard user interfaces.
- Destructive migration or rewriting of existing brain data.
- Treating embeddings as a prerequisite; Memory Lite and keyword retrieval remain supported.
- Removing legacy query endpoints in the same change. They become compatibility adapters.
- Adding external multi-tenant authorization. This design enforces Home23's local agent/brain authority boundary.
- Guaranteeing that an external provider can never hang. The contract makes hangs observable, cancellable, detachable, and bounded.

## Architecture

### Shared client

brain.ts, research.ts, and automatic context assembly will use a shared BrainOperationsClient instead of constructing independent fetch calls and deadlines.

The client owns:

- Live target resolution.
- Request validation and limits.
- Combined abort signals.
- Streaming event parsing.
- Heartbeat and reconnect behavior.
- Typed result/error parsing.
- Explicit output truncation and result handles.
- Consistent source evidence.

ToolContext will no longer treat a brainRoute resolved once at harness startup as permanent truth. It will expose the caller identity and a resolver/client capable of refreshing routes at operation time.

### Coordinator and trust boundary

The requester agent's dashboard is the canonical BrainOperationCoordinator for every agent-initiated operation, including COSMO query/PGS work and dashboard synthesis. The dashboard process derives requester identity from its own configured instance; requester identity is never accepted from an agent-supplied body, query string, or header.

For COSMO work, the coordinator issues a short-lived signed capability containing:

- Requester agent.
- Target domain and exactly one canonical brain, owned-run, or requester identity;
  brain/run domains also bind the canonical root.
- Access mode and allowed operation type.
- Operation ID, expiry, and nonce.

Setup generates a local internal capability key in ignored installation state and injects it only into the relevant dashboard and COSMO processes. COSMO validates the signature, expiry, target, and operation on every start, status, stream, result, and cancel request. Canonical stored-result export is separately authorized and performed only by the requester dashboard; COSMO exposes no internal worker export endpoint. Operation IDs and result handles are not bearer credentials. Legacy direct COSMO routes remain compatibility surfaces but are not used to authorize new cross-brain agent operations.

The coordinator owns the canonical operation record. COSMO and synthesis workers report monotonic, operation-scoped events back to it; they do not create a second competing source of operation truth.

### Target resolution

Tools accept one optional target:

    target: { agent?: string, brainId?: string }

Resolution rules:

1. With no target, select the exact live catalog entry mapped to the calling agent.
2. With agent only, select that catalog entry's selected brain.
3. With brainId only, select that exact discovered brain.
4. With both, require the catalog to prove they refer to the same brain.
5. Reject unknown, ambiguous, mismatched, or unavailable targets.
6. Never silently substitute the caller's brain for a bad target.

Positive catalog results may be cached briefly. Empty/unavailable discovery is not cached permanently. A route mismatch, 404, connection error, COSMO startup, or import change forces one fresh resolution before failure is returned.

The resolved target includes:

- Caller agent.
- Target agent when applicable.
- Brain identifier and display name.
- Brain type: resident or completed research.
- Lifecycle state; active research brains are not eligible as completed research targets.
- Canonical root/source identifier.
- Route and catalog revision.
- Access mode: own or read-only.

Targeting is enabled only after COSMO exposes a canonical catalog schema with catalogRevision, unique ID, displayName, ownerAgent when applicable, kind, lifecycle, canonicalRoot, sourceType, nodeCount, modifiedAt, and route. Duplicate display names remain discoverable but cannot be selected by name alone.

### Authority enforcement

Authority is enforced on both client and server. The server does not trust a caller-supplied combination of agent and brainId.

Allowed read-only cross-brain operations:

- Search.
- Query, including PGS over existing content.
- Query export.
- Status and health.
- Bounded graph/sample reads.
- Existing brain summary and intelligence-section reads.

Disallowed cross-brain effects:

- Synthesis or reclustering.
- Research launch, continue, stop, or mutation.
- Agency assimilation.
- Query-cache writes into the target.
- Access-count or weight reinforcement.
- Brain content or metadata writes.

Operation receipts may be written to the requester's runtime operation store because they describe the request, not a mutation of the target brain.

Read-only execution uses a requester-owned scratch overlay. Cross-brain PGS partition caches, session state, synthesis receipts, follow-up context, query cache entries, and other derived files may be read from the target only when they match the pinned source revision and are safe immutable inputs; all new writes go under the requester operation directory. Cross-brain query export writes to the requester operation result store and, on explicit export, to the requester's workspace brain-exports directory. It never writes into the target brain's export directory.

Research launch, continue, and stop are process mutations governed by research-run ownership, not by the cross-brain read target. They require the requester to match the run owner recorded in canonical run metadata. Compiling another brain is a read-only operation whose output belongs to the requester.

### Operation lifecycle

Long query, PGS, synthesis, stop, and compile work use a durable operation record. Compatibility endpoints may wait for an operation, but the shared client uses the operation protocol directly.

The server operation API provides:

- Start operation and return an operation ID.
- Read current status/result.
- Stream progress and heartbeat events.
- Cancel explicitly.
- Reattach after a transport or caller disconnect.

The public operation routes are exactly the `/home23/api/brain-operations`
catalog/start/status/events/result/cancel/detach/export routes defined by the
execution index. Protected worker routes remain internal. All long-operation
implementations share one durable execution state machine:

- queued
- running
- complete
- partial
- failed
- cancelled
- interrupted

complete, partial, failed, cancelled, and interrupted are terminal. Detachment is not an execution state; each caller attachment separately records attached, detached, or closed while the underlying operation may remain running. A two-client operation may therefore continue for one attached caller after another detaches.

Each record contains:

- Operation and request identifiers.
- Caller and resolved target.
- Operation type and sanitized parameters.
- State, phase, and progress counters.
- Started, updated, and completed timestamps.
- Provider/model identity.
- Result or result handle.
- Typed error and retryability.
- Source evidence.

Canonical durable records live under instances/<requester>/runtime/brain-operations/operations/<operationId>/, which is ignored installation state. `instances/<requester>/runtime/brain-operations/` is the BrainOperationStore root; standalone or compatibility memory-source contexts may use separate flat sibling directories but are not durable store records. Each durable operation directory holds an atomic status record, bounded event journal, result or result handle, worker references, and requester-owned scratch data. Records are written by temp-file plus rename under a per-operation lock and carry a monotonically increasing record version and event sequence.

The operation store is a reliability and logical-authority boundary inside one
local Home23 installation, not an operating-system sandbox against another
process running as the same user. It rejects caller-selected paths, static or
persisting symlinks, noncanonical ancestors, and identity changes observed
during an operation. A deliberately malicious same-UID process that can rename
an ancestor away, substitute another tree for one pathname lookup, restore the
original ancestor, and directly edit ignored runtime state is outside the
approved threat model; that process already has equivalent direct write access
to every Home23 runtime file. Enforcing authority against such a process would
require a separate OS identity or a native dirfd-relative filesystem service
and is the external multi-tenant/privilege-separation work excluded above.

Operation start requires a caller-scoped idempotency key derived from request ID plus operation type. Retrying a lost start response returns the same operation rather than launching duplicate provider work. Terminal-state transitions are compare-and-swap and immutable. If completion commits first, a later cancel reports the completed result; if cancellation commits first, later worker completion cannot overwrite it.

On coordinator startup, every queued or running record is reconciled with its recorded worker:

- Reattach when the worker proves the same operation is still active.
- Otherwise request best-effort worker cancellation, retain partial artifacts, and atomically mark the operation interrupted and retryable.

Terminal metadata is retained for 30 days by default. Large result/scratch artifacts are retained for seven days unless explicitly exported. Garbage collection skips nonterminal operations and is configurable. Runtime operation files are never added to Git.

### Waiting policy

Waiting is based on verified operation activity, not a fixed 60- or 120-second fetch timeout.

- The server emits a heartbeat at least every 10 seconds for queued and running operations, including operation ID, monotonic event sequence, state, phase, updatedAt, lastProviderActivityAt, and lastProgressAt.
- The client treats 60 seconds without an event as a transport-health failure, attempts a bounded status read and reconnect, and only then returns source unavailable while marking that caller attachment detached.
- Ordinary query attachments have a configurable default wait deadline of 90 minutes; the default server execution deadline is two hours.
- PGS and synthesis attachments have a configurable default wait deadline of six hours; the default server execution deadline is eight hours.
- Reaching an attachment wait deadline detaches only that caller. Reaching the server execution deadline cancels worker/provider work and terminalizes the operation with operation_timeout.
- Short search/status/graph operations keep smaller configurable bounds because they have no legitimate multi-hour execution path.
- Heartbeats prove transport/worker liveness but do not by themselves prove provider progress. Provider adapters update lastProviderActivityAt from real provider events. Provider-specific stall bounds are configurable and enforced separately from the hard execution deadline.
- Stall tracking is per active provider call. Query/synthesis/compile use stable
  singleton IDs; every PGS sweep and final synthesis has its own ID. Only a
  matching authenticated provider-activity event renews that call from local
  receipt/monotonic time; child timestamps and transport heartbeats are
  diagnostic and cannot hide a silent sibling call.

The agent's turn controller must cooperate with long tools. Verified operation events renew the turn activity lease. All entry points, including main chat, Evobrew bridge, and cron execution, must use the same turn/tool lifecycle rather than bypassing it with raw agent.run calls.

### Cancellation policy

- Explicit user/operator cancellation always cancels the durable operation and propagates a combined AbortSignal through server, query engine, PGS partitions, and provider clients.
- A short, non-durable operation is cancelled when its client disconnects.
- A durable PGS or synthesis operation is detached, not cancelled, by an accidental transport disconnect.
- Ordinary durable query, compile, and stop operations follow the same detach-on-disconnect rule; their hard execution deadlines still apply.
- Cancelled or failed PGS partitions remain retryable and are not marked searched.
- Provider calls receive bounded request settings in addition to the propagated signal.

## Source Truth and Retrieval Evidence

### Authoritative memory view

All memory consumers use one dependency-light streaming library under shared/memory-source/ that is portable across the Home23 engine, dashboard, MCP, and bundled standalone COSMO without importing engine runtime code. It produces the current logical view from:

1. The latest base sidecar.
2. All later delta upserts and updates.
3. Delta tombstones/deletes.

The portable module owns format parsing, revision comparison, bounded iteration, delta application, and evidence generation. Engine and COSMO adapters own only path discovery and domain-specific projection. Shared contract fixtures must produce identical results through every adapter.

All streaming boundaries cap compressed input selection, decompressed bytes,
one record, retained projections, scratch/disk use, and final response bytes.
A large committed delta spills into requester-operation SQLite rather than an
unbounded JavaScript Map. An oversized/corrupt source fails typed before V8 heap
exhaustion; it never becomes a partial empty result.

One aggregate 8-GiB default quota covers all source-operation scratch,
including SQLite/journals, immutable legacy projections, PGS projection state,
and graph-export temp/final files; lower component ceilings still apply.
Manifest reads are capped at 1 MiB with exactly three scalar summary fields.
Every source file is opened as a stable nonsymlink regular file confined to its
canonical root. The committed delta prefix must exist and exactly match its
declared epoch, first/last revision, sequence, record count, and byte cutoff;
missing, malformed, gapped, or truncated committed data is unavailable/unknown,
never healthy partial coverage.

Authoritative ordering uses a versioned manifest/epoch transaction:

- The manifest names the active base files, baseRevision, active delta epoch, currentRevision, and ANN builtFromRevision.
- Every delta record carries its epoch, strictly increasing sequence/revision, and operation type.
- A full rewrite takes the writer lock, captures cutoff revision R, writes and fsyncs versioned base files representing R, opens the next delta epoch for writes after R, then atomically switches the manifest.
- Old base/delta files are retired only after the manifest switch and after active readers no longer pin them.
- ANN build completion atomically advances only annBuiltFromRevision; it cannot claim a revision it did not index.

This ordering prevents the current crash window in which a delta is removed before the corresponding base/snapshot becomes authoritative.

Legacy files without an explicit manifest remain readable, but file identity, modification time, and size are only diagnostic fingerprints. They report source health degraded and freshness unknown, and cannot support a corpus_empty claim. The next safe rewrite/reindex establishes a manifest without deleting user data.

ANN search is usable only when its built-from watermark covers the authoritative revision. When it is behind, the implementation must either overlay current delta changes and tombstones safely or mark the ANN stale and use a source scan. It may not return stale ANN results as the only truth.

Semantic results are supplemented by keyword results when:

- Embeddings are unavailable.
- Embedding dimensions do not match.
- The ANN is stale.
- Semantic candidates are all noise-filtered.
- An exact keyword canary is otherwise absent.

MCP, dashboard search, automatic context retrieval, graph/status summaries, and agent tools must use this same logical-source contract.

Long query, PGS, and synthesis operations pin one immutable manifest revision and delta cutoff at start. All retries and partition caches for that operation use the same snapshot. Compaction retains pinned files until readers release them. Own-brain synthesis applies derived state with a revision compare-and-swap; if the source changed, it finishes as source_changed without overwriting newer brain state.

### Evidence envelope

Every retrieval response carries:

- Selected agent and brain.
- Route and retrieval implementation.
- Base watermark.
- Delta watermark and applied record count.
- ANN/index watermark and freshness.
- Active filters and limits.
- Authoritative totals.
- Returned/sample totals.
- Source health and match outcome.
- Fallback route and completeness when degraded.

Human-readable tool text summarizes this evidence. Structured metadata remains available for programmatic checks.

### Source health and match outcome

Retrieval uses two independent axes.

Source health:

- healthy: manifest, base, delta cutoff, and selected retrieval route are internally consistent.
- degraded: a fallback returned useful coverage while a preferred layer was stale or failed.
- unavailable: the route could not establish a readable source.

Match outcome:

- matches: one or more eligible results were found.
- no_match: a healthy route completely searched a verified nonempty eligible corpus and found no result.
- filtered: candidates existed but active scope/filter rules excluded them.
- corpus_empty: the healthy authoritative pre-filter corpus total is exactly zero.
- unknown: coverage was insufficient to make a match or emptiness claim.

Only the combination healthy plus corpus_empty may be described to an agent as an empty brain. A degraded fallback with hits is degraded plus matches. A degraded fallback without complete coverage is degraded plus unknown, not no_match. An HTTP-200 body containing an error cannot be interpreted as an empty or successful result.

### Bounded graph and status

brain_memory_graph and brain_status will never fetch /api/memory to count the graph.

- Status reads summary metadata and source health.
- Graph reads require server-side node and edge limits with safe maximums.
- Inline graph maxima are 2,000 nodes and 8,000 edges, with independent
  16-MiB node, 8-MiB edge, 1-MiB cluster-breakdown, and 32-MiB response caps.
- The server obtains summary metadata and a bounded sample through streaming/indexed reads before full graph deserialization or object materialization.
- Responses include authoritative total counts separately from returned sample counts.
- Numeric and string cluster identifiers are normalized before filtering.
- Arbitrary COSMO brain graph routes receive the same server-side limits and evidence as resident dashboard routes.
- The compatibility full=1 escape hatch is rejected or clamped. A true full graph is available only as a durable asynchronous file export into requester-owned storage.
- The default sample is deterministic for a pinned revision: stream/select the requested cluster and ranking into a bounded top-K node set, then stream edges and retain at most edgeLimit edges whose endpoints are in the selected set. Authoritative node/edge/cluster counts come from the pinned manifest's three bounded scalar summary fields. Optional tag/cluster breakdowns use a key/byte-bounded streaming count and become explicit `null`/omitted when they cannot remain exact; an empty map never stands in for omitted totals.

### MCP

HTTP MCP and internal MCPBridge hydrate the same base-plus-delta logical view. Read failures return unavailable with evidence, never totalNodes zero.

Every MCP/AgentExecutor construction receives an explicit trusted local source
context. Resident processes resolve their configured resident root; active
research processes may resolve only their exact owned active run. Each read
uses a requester-owned ephemeral operation root and cleans it in `finally`.
Caller/tool fields cannot choose requester, catalog identity, source root,
projection, lock, or scratch. `limit:0` is no longer an unlimited graph request.

Generated runtime configuration must either:

- Start the intended agent-scoped MCP service and advertise its endpoint, or
- Advertise MCP as unavailable and avoid proxying to a nonexistent listener.

## Provider and PGS Completion Contract

All provider adapters normalize their final response into:

- Text/content.
- terminalReceived.
- finishReason or stopReason.
- hadError and typed error.
- usage.
- model and provider.

A query is complete only when:

- The expected terminal event was received.
- No stream/provider error occurred.
- The finish reason represents normal completion.
- Content is nonempty.
- The response is not an error payload.

Premature EOF, response.incomplete, finish_reason length, stop_reason max_tokens, and partial text followed by a stream error are partial or failed, never complete. Error-string detection is a final defensive check, not the primary completion mechanism.

Provider identity remains explicit when model identifiers overlap. PGS sweep and synthesis calls preserve the chosen provider rather than re-inferring from model name. Provider token ceilings come from declared provider/model capabilities; MiniMax must not inherit an unrelated 8,192-token fallback clamp.

PGS validates each sweep and the final synthesis using the same provider contract. If useful sweeps succeeded but final synthesis failed:

- The operation state is partial.
- Successful sweep outputs and evidence remain available.
- Failed/cancelled partitions remain retryable.
- No success receipt or done state is written.

Direct Query applies the same validation before caching a result.

## Agent-Facing Tool Contract

Existing names remain:

- brain_search
- brain_query
- brain_query_export
- brain_memory_graph
- brain_synthesize
- brain_status
- research_list_brains
- research_query_brain
- research_search_all_brains
- research_launch
- research_continue
- research_stop
- research_watch_run
- research_get_brain_summary
- research_get_brain_graph
- research_compile_brain
- research_compile_section

Behavior changes:

- The four target-selecting read tools—brain_search, brain_query,
  brain_memory_graph, and brain_status—accept the optional target.
  brain_query_export is bound to an already-authorized requester operation (or
  requester-owned ad-hoc content) and rejects target; brain_synthesize stays
  own-brain only.
- brain_query reports progress, operation ID, and complete/partial/typed-failure status.
- brain_query and the tool-loop formatter never silently slice an answer. A shortened display includes a clear truncation marker and result/export handle.
- brain_status and brain_memory_graph use bounded summary routes.
- research_list_brains maps COSMO's real nodes, sourceType, and modifiedDate fields.
- research_search_all_brains uses bounded concurrency and returns an outcome for every selected brain.
- Multi-brain search cannot say no findings when any target failed or timed out.
- research_watch_run round-trips the server's cursor.
- research_stop follows durable shutdown state for the server's full shutdown window.
- research_compile_section reads the requested section before compiling it.
- Read-only research calls do not perform unbounded agency writes.

Automatic context retrieval:

- Sends topK rather than the obsolete limit field.
- Preserves successful local trigger matches when remote memory retrieval fails.
- Names the actual failed route/state.
- Does not promise a direct tool call will succeed.

Every model-provider branch records success false when a tool returns is_error. The tool registry and turn controller enforce this centrally so adding a provider cannot reintroduce false success.

## Compatibility

- Existing tool calls without target continue to address the caller's own brain.
- Existing text results remain readable by current prompts.
- New structured metadata is additive.
- Existing /query and /query/stream routes remain as adapters while agent tools move to the operation protocol.
- Existing sidecars and deltas require no destructive migration.
- Missing manifests remain readable in degraded/freshness-unknown mode until a safe rewrite establishes authoritative revisions.
- Runtime operation state remains ignored.
- COSMO vendored patch documentation must be updated for all changes under cosmo23.

## Error and Limit Contract

Request validation rejects:

- Query or prior-context text beyond the published maximum.
- Invalid topK, node limit, edge limit, mode, model/provider pairing, or target.
- Mismatched agent and brain identifiers.
- Public brain-operation JSON bodies over 1 MiB, protected internal worker-start
  bodies over 2 MiB, and protected internal cancel/control bodies over 256 KiB.
  These strict parsers are mounted before any legacy broad dashboard parser, so
  an over-budget request is rejected without first being retained by that parser.

Transport and application errors use appropriate non-2xx status codes for direct APIs. Compatibility endpoints that cannot change status immediately must still return a typed non-success envelope that tools reject.

Typed failures include:

- invalid_request
- target_not_found
- target_mismatch
- access_denied
- source_unavailable
- source_stale
- provider_incomplete
- provider_failed
- operation_timeout
- cancelled
- interrupted
- source_changed
- result_too_large

Errors state whether retry, reconnect, fallback, or operator intervention is appropriate.

## Implementation Sequence Constraints

The public tool surface must not expose cross-brain targeting until its server-side authority and no-write guarantees exist. Implementation order is therefore constrained:

1. Add the canonical catalog schema, unique resolution, requester identity, internal capability verification, and requester-owned operation coordinator.
2. Add the revisioned manifest writer transaction and crash tests before any route claims authoritative source freshness.
3. Add the portable streaming memory-source loader and shared adapter contract tests.
4. Move dashboard search, graph/status, MCP, COSMO graph/search, and ANN validation onto that source contract.
5. Normalize provider terminal results, explicit provider identity, provider stall bounds, and AbortSignal propagation.
6. Add durable query/PGS/synthesis operations, idempotency, restart reconciliation, attachment handling, and pinned source revisions.
7. Move every agent entry point onto the common activity-leased turn lifecycle.
8. Rework brain/research/context tools and only then enable optional target arguments.
9. Run focused/full verification and the scoped live rollout.

Compatibility adapters may land earlier but must remain disabled for cross-brain use until steps 1 through 8 pass their authority and mutation-boundary tests.

## Test Strategy

Implementation follows test-driven development. Each confirmed defect receives a failing regression test before production code changes.

### Deterministic timing tests

Tests use injected timing values, controlled promises, fake clocks where appropriate, and local in-process HTTP/SSE servers. They do not wait 60 or 120 real seconds.

Required cases:

- Heartbeats keep an operation alive beyond the old deadline.
- Silence expires the inactivity lease and triggers status/reconnect.
- One of two attached clients detaches at its wait deadline while the operation keeps running and the second client continues receiving progress.
- A caller detaches at its wait deadline while the durable operation remains readable.
- The server execution deadline aborts a still-running worker and provider.
- Heartbeat-only liveness does not hide a provider stall.
- Explicit cancellation aborts underlying provider work.
- Short-operation disconnect aborts underlying work.
- Durable PGS disconnect does not cancel the job.
- Reconnect resumes the same operation without duplicate execution.
- A repeated start with the same requester-scoped idempotency key returns the same operation.
- Cancel-versus-complete races produce exactly one immutable terminal state.
- Restart reconciliation reattaches a verified live worker or marks direct query, PGS, and synthesis operations interrupted while retaining partial artifacts.
- Operation activity renews runWithTurn beyond 15 minutes under a fake clock, while silence still expires it.
- Main chat, Evobrew bridge, subagent, and cron entry points all use the common turn lifecycle.
- Long stop remains pending through the old 30-second cutoff.
- brain_synthesize polls by operation/generation marker through delayed completion, typed failure, disconnect/reattach, and dashboard restart using an isolated mutable fixture.

### Provider and PGS tests

- OpenAI partial text followed by stream error.
- Missing terminal event.
- response.incomplete.
- Chat finish_reason length.
- Anthropic-compatible EOF without message_stop.
- stop_reason max_tokens.
- Raw Codex SSE timeout, cancellation, terminal validation, and chunk field normalization.
- Explicit provider identity for duplicate model IDs.
- MiniMax capability-based token limit.
- PGS final synthesis failure after successful sweeps.
- Failed/cancelled PGS partitions remain retryable.
- Direct Query does not cache incomplete/error results.
- Long operations remain pinned to their starting source revision.
- Synthesis compare-and-swap returns source_changed instead of overwriting a newer revision.

### Source-truth tests

- Base sidecar plus delta upsert, update, and delete.
- Crash-injection at every manifest/rewrite step leaves either the old epoch or the new epoch authoritative, never a missing delta window.
- Concurrent delta writes across compaction receive ordered revisions and remain visible.
- Legacy no-manifest data reports degraded plus freshness unknown and cannot claim corpus_empty.
- Stale ANN plus a new exact-keyword canary.
- Deleted objects absent from ANN-backed results.
- Embedding failure, noise filtering, and dimension mismatch keyword fallback.
- Independent source-health and match-outcome combinations, including degraded plus matches and degraded plus unknown.
- Evidence watermarks and active filters in each response.
- MCP reads sidecar-plus-delta data when inline state arrays are empty.
- Batch embedding success returns one ordered vector per input with no duplicate fallback calls.
- Semantic access reinforcement updates the stored own-brain node, while cross-brain read-only queries do not.
- Highly compressible oversized JSONL records/decompressed streams fail at the
  byte boundary; a large committed delta spills outside the target and cleans
  up on success, failure, and cancellation.
- Million-node/three-million-edge graph/query/PGS probes run under explicit
  small V8 heaps without a full materializer, or fail at the first typed byte
  quota rather than exhausting the process.

### Target and tool tests

- Own-brain default.
- Sibling agent selection.
- Completed research brain selection.
- Canonical catalog owner/kind/lifecycle/revision fields.
- Active research brains excluded from completed-research targeting.
- Duplicate names, unknown, ambiguous, mismatched, and stale target routes.
- Expired, replayed, operation-mismatched, requester-mismatched, and target-mismatched internal capabilities rejected on every operation endpoint.
- An operation ID or result handle without requester authorization rejected.
- Cross-brain mutation rejection.
- Before/after hashes and stats prove cross-brain direct query, PGS, compile, and export do not change target base, delta, ANN, metadata, PGS/session, cache, synthesis, export, or agency files; only requester-owned operation/workspace paths may change.
- Research continue/stop reject a requester that does not own the run.
- HTTP-200 error bodies rejected.
- Server-bounded graph sample against a large synthetic fixture whose unbounded loader throws if invoked.
- full=1 is clamped/rejected and full export is asynchronous.
- Numeric cluster filtering.
- Brain-list response contract.
- Multi-brain complete, partial, and all-failed results.
- Watch cursor round-trip.
- Compile-section source fetch.
- Context topK and local-trigger preservation.
- All provider loops mark is_error as unsuccessful.
- Output truncation marker and result handle.

### Focused and full verification

Run the smallest focused suites during implementation, then:

- npm run build
- npm test
- npm run test:contracts
- Focused COSMO Query, PGS, provider, and server-route suites.
- Fresh-clone/install separation checks.
- Tracked-but-ignored and Git archive checks from AGENTS.md.

## Live Acceptance and Rollout

Live rollout is scoped and non-destructive.

1. Record PM2 table, listener ownership, source watermarks, and current /api/status before restart.
2. Before restarting shared COSMO, prove from fresh status and operation/process records that it is idle with no active research run or durable brain operation. If it is busy, defer the restart rather than interrupting work.
3. Restart only affected named Home23 processes after tests pass.
4. Verify PM2 ownership and saved runtime assumptions without broad stop/delete commands.
5. Run read-only Jerry canaries:
   - Own brain search, query, status, and bounded graph.
   - Explicit sibling-agent read.
   - Explicit completed research-brain read.
   - Exact keyword canary through the same public tool route.
6. Snapshot hashes/stats for all target brain state boundaries, run cross-brain direct and PGS reads, and prove only requester-owned operation/workspace paths changed.
7. Run one deliberately scoped PGS canary using a configured healthy provider only when the pinned live source has at least 100,000 authoritative nodes. If either live size or provider health blocks that proof, record the blocker and run a 100,000-node controlled provider only in a separate isolated Home23 fixture without claiming a live-provider pass. Retain its stopped durable store until protected readback succeeds.
8. Prove PGS progress, operation status, and complete or honest partial result.
9. Exercise synthesis run/status against an isolated fixture or safe dedicated canary brain; do not mutate Jerry's live brain merely to prove polling.
10. Confirm the bounded Jerry graph call does not restart the dashboard and increases peak heap by no more than 256 MB over its pre-call baseline.
11. Read back the durable operation and retrieval evidence receipts.
12. Stage only explicit task paths, inspect the cached diff, and commit without sweeping up the pre-existing dirty/staged worktree.

Write the final evidence to:

    docs/receipts/2026-07-09-brain-tools-hardening.md

The receipt records exact commands, test totals, live process IDs/restart counts, route/status responses, source watermarks, canary outcomes, any unavailable external provider, and final Git commit/push state.

## Acceptance Criteria

The work is complete only when:

- A valid delayed query continues beyond the former fixed deadline while verified activity arrives.
- An explicit cancel stops underlying provider/PGS work.
- A disconnect can reattach to a durable PGS/synthesis result.
- Caller detachment cannot change the durable job state or interrupt another attachment.
- Start retries are idempotent and restart reconciliation cannot leave false-running operations.
- Provider incomplete/error states cannot become successful answers or caches.
- PGS preserves successful sweeps as partial when synthesis fails.
- Graph/status calls use no full materialization, remain within the live 256 MB heap-growth bound at Jerry scale, and do not restart the dashboard.
- Base, delta, and ANN freshness is visible through a crash-safe manifest, and stale/degraded routes cannot claim authoritative empty.
- Long operations use a pinned source revision, and synthesis cannot overwrite a newer revision.
- Own, sibling, and completed-research targets behave according to the approved read-only policy.
- Server-derived requester capabilities protect every operation/result endpoint, and target filesystem proof shows no cross-brain mutation.
- Multi-brain failures remain visible.
- MCP and dashboard retrieval agree on sidecar-backed memory or clearly report unavailability.
- Every production AgentExecutor/MCPBridge call site has a canonical local
  source-context dependency; missing context fails readiness rather than
  claiming zero nodes.
- Existing tool calls remain compatible.
- Focused, full, contract, clean-install, and live acceptance checks pass or any external-provider limitation is explicitly documented.
- The portable implementation, design/plan updates, COSMO vendored-patch record, tests, and verification receipt are committed and pushed without tracked local runtime state.

## Risks and Mitigations

- Long operations can consume provider time or cost. Configurable ceilings, progress visibility, explicit cancellation, and durable detachment bound the risk.
- Server heartbeats can prove liveness without proving useful provider progress. Overall ceilings and provider request bounds prevent infinite success-looking waits.
- Cross-brain queries currently have hidden writes. Server-enforced read-only mode and mutation tests are required before enabling the target option.
- Sidecar/delta/index formats have legacy variants. The loader reports legacy fingerprints as degraded/freshness unknown and avoids destructive migration.
- COSMO is vendored. Changes remain scoped, tested in both Home23 and COSMO suites, and documented in COSMO23-VENDORED-PATCHES.md.
- The work spans several subsystems. Implementation will be split into test-first checkpoints with focused verification before live restart.
