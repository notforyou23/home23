# Durable PGS Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver durable, bounded PGS sessions with cumulative levels, real continuation/reuse, isolated targeted scopes, and complete Query-tab controls.

**Architecture:** A server-authorized per-agent session database stores the pinned projection and sweep ledger once, while each brain operation retains its own events and result artifact. The immutable session binding includes the exact query, source, sweep pair, limits, prompt version, and selection policy; operation attempts add monotonic scopes and synthesize only their eligible outputs.

**Tech Stack:** Node.js CommonJS, Express, better-sqlite3, Home23 brain-operation coordinator/worker, JSON Schema, browser JavaScript, Node test runner.

## Global Constraints

- Local PGS session state stays under ignored `instances/<agent>/runtime/` and never enters Git.
- No public request may supply or derive a filesystem path.
- No continuation may silently fall back to fresh work.
- Levels are cumulative: skim 10%, sample 25%, deep 50%, full 100%.
- Successful sweeps are reused only with an exact immutable binding.
- Targeted synthesis includes only the requested target scope.
- One session database is reused without per-continuation graph copies.
- All filesystem mutation remains inside the selected agent's authorized runtime boundary.
- Existing direct Query, brain-tool, MCP, export, chat, and manifest-v1 behavior must not regress.

---

### Task 1: Session Binding and Cumulative Scope Ledger

**Files:**
- Modify: `cosmo23/pgs-engine/src/pinned-store.js`
- Modify: `cosmo23/pgs-engine/src/pinned-operation.js`
- Modify: `tests/cosmo23/helpers/pinned-pgs-fixture.cjs`
- Modify: `tests/cosmo23/pinned-pgs-store.test.cjs`
- Modify: `tests/cosmo23/pgs-source-pin.test.cjs`
- Modify: `tests/cosmo23/pgs-retry-state.test.cjs`

**Interfaces:**
- Consumes: pinned source descriptor/revision, exact sweep pair, exact query, store limits.
- Produces: schema-v3 session binding; deterministic coverage ordinals; scope-filtered selection/listing/counting; metadata for reused/new/scoped/global work.

- [ ] Write failing store and engine tests for exact query binding, schema-v2 refusal, round-robin cumulative 10/25/50/100 selection, no duplicate successful work, target filtering, and scoped synthesis.
- [ ] Run the focused tests and confirm failures are caused by missing binding/scope behavior.
- [ ] Add canonical query bytes/digest, normalization version, prompt version, selection-policy version, and work-unit coverage ordinals to the store schema and binding validation.
- [ ] Add exact scope plans for named levels and explicit partition IDs, with monotonic union/expansion validation and bounded target lists.
- [ ] Change selection and result construction to use cumulative total-work targets, scope-filtered successes, and separate scoped/global coverage fields.
- [ ] Run the focused tests until they pass, then run cancellation and source-pin suites.

### Task 2: Protected Cross-Operation Session Authority

**Files:**
- Create: `engine/src/dashboard/brain-operations/pgs-session-authority.js`
- Modify: `engine/src/dashboard/brain-operations/coordinator.js`
- Modify: `engine/src/dashboard/brain-operations/operation-store.js`
- Modify: `engine/src/dashboard/brain-operations/worker-adapter.js`
- Modify: `cosmo23/server/lib/brain-operation-worker.js`
- Modify: `cosmo23/server/lib/query-operation-worker.js`
- Test: `tests/engine/dashboard/pgs-session-authority.test.cjs`
- Test: `tests/engine/dashboard/brain-operation-coordinator.test.js`
- Test: `tests/cosmo23/query-operation-worker.test.cjs`

**Interfaces:**
- Consumes: current operation record, prior operation ID, requester/owner identity, selected agent runtime root.
- Produces: opaque session ID and validated worker capability containing coordinator-owned session authority; exclusive session lease; `continuableUntil`.

- [ ] Write failing tests for same-owner continuation, cross-owner denial, missing/expired state, exact binding mismatch, exclusive writer conflict, path replacement, symlink/hard-link rejection, and process-loss continuation.
- [ ] Run the focused tests and confirm the new authority is absent.
- [ ] Implement per-agent session creation/resolution with opaque IDs, exact directory/file identity capture, exclusive lock/lease, quota reconciliation, and scoped expiration cleanup.
- [ ] Extend coordinator launch/recovery to authorize `continueFromOperationId`, resolve the lineage's session root, and pass only a coordinator-issued capability to the worker.
- [ ] Separate current-operation receipt scratch from PGS session storage so continuations mutate one protected database without copying it.
- [ ] Run the focused tests until they pass and verify unrelated operation types cannot obtain a PGS session capability.

### Task 3: Facade, Worker, Schema, and Result Contract

**Files:**
- Modify: `contracts/schemas/query.schema.json`
- Modify: `engine/src/dashboard/home23-query-api.js`
- Modify: `cosmo23/server/lib/query-operation-worker.js`
- Modify: `engine/src/dashboard/brain-operations/operation-model-resolver.js`
- Modify: `tests/contracts/query-facade-route.test.cjs`
- Modify: `tests/cosmo23/query-operation-worker.test.cjs`
- Modify: `tests/engine/dashboard/brain-operation-routes.test.js`

**Interfaces:**
- Consumes: `pgsMode`, `pgsLevel`, optional `continueFromOperationId`, optional `targetPartitionIds`, exact sweep/synthesis pairs.
- Produces: validated operation parameters and terminal/detached envelopes with session lineage, scoped/global coverage, reuse counts, continuation eligibility, and canonical result identity.

- [ ] Write failing contract tests for every valid mode/level combination and every forbidden field combination.
- [ ] Verify the tests fail because only `full` mode and raw fractions are currently accepted.
- [ ] Replace client-defined `sweepFraction` with server-defined named level mapping and add bounded continuation/target fields.
- [ ] Preserve exact provider/model pairs and authorize prior operation linkage before worker execution.
- [ ] Validate all returned coverage/session fields and retain canonical operation/result handles through history and export.
- [ ] Run contract, facade, route, and worker tests until they pass.

### Task 4: Query Tab PGS Controls and Durable Operation Actions

**Files:**
- Modify: `engine/src/dashboard/home23-query.js`
- Modify: `engine/src/dashboard/home23-dashboard.html`
- Modify: `tests/engine/dashboard/home23-query-client.test.cjs`

**Interfaces:**
- Consumes: catalog defaults, canonical PGS request/result contract, status/events/result/cancel routes.
- Produces: named level controls; fresh/continue/targeted modes; partition target input; Continue, Reattach, Cancel, and Start Fresh actions; honest coverage rendering.

- [ ] Write failing client tests for request construction, mode-dependent fields, operation identity retention, partial rendering, detached reattachment, cancellation, and scoped/global coverage labels.
- [ ] Verify failures against the current full-only mode and obsolete result renderer.
- [ ] Implement mode/level controls and require a selected prior continuable PGS operation for continuation.
- [ ] Add bounded target entry for targeted mode and display server validation errors without starting fallback work.
- [ ] Render reused/new/pending work, requested-scope completion, full coverage, session expiry, and canonical operation ID.
- [ ] Rename the progress toggle honestly and wire reattach/cancel using existing durable routes.
- [ ] Run client and facade tests until they pass.

### Task 5: Capacity, Failure Recovery, and Cleanup

**Files:**
- Modify: `cosmo23/pgs-engine/src/pinned-store.js`
- Modify: `cosmo23/pgs-engine/src/pinned-operation.js`
- Modify: `engine/src/dashboard/brain-operations/pgs-session-authority.js`
- Modify: `tests/cosmo23/pgs-cancellation.test.cjs`
- Modify: `tests/cosmo23/pgs-retry-state.test.cjs`
- Modify: `tests/cosmo23/pgs-source-pin.test.cjs`
- Modify: `tests/engine/dashboard/pgs-session-authority.test.cjs`

**Interfaces:**
- Consumes: bounded batches, session quota, cancellation/provider failures, session retention clock.
- Produces: resumable validated sweep state, bounded full coverage beyond one batch, and exact cleanup receipts.

- [ ] Write failing tests for more than 256 work units, cancellation between batches, retryable provider failures, synthesis failure, interrupted worker continuation, quota exhaustion, and expired-session cleanup.
- [ ] Confirm failures identify current one-batch and operation-local limits.
- [ ] Iterate bounded work snapshots until the requested cumulative scope is complete or a retryable boundary is reached, committing each settled batch before advancing.
- [ ] Preserve successful sweep state across cancellation/failure while preventing false completion receipts.
- [ ] Add exact bounded cleanup that removes only expired session-owned files and reports reclaimed bytes.
- [ ] Run capacity, cancellation, retry, store, and authority suites until they pass.

### Task 6: Broad Regression and Live Acceptance

**Files:**
- Modify: `docs/design/COSMO23-VENDORED-PATCHES.md`
- Create: `docs/receipts/2026-07-12-durable-pgs-sessions.md`
- Modify test fixtures that construct model capabilities without `contextWindowTokens`.

**Interfaces:**
- Consumes: completed PGS implementation and current live Jerry/Forrest manifest-v1 brains.
- Produces: broad green test/build evidence and a dated live receipt.

- [ ] Update controlled test model fixtures to include exact `contextWindowTokens` capabilities without weakening production validation.
- [ ] Run all focused PGS, Query facade/client, coordinator, brain-tool, MCP, chat, source, and export suites.
- [ ] Run `npm run build`, `npm run test:contracts`, and `npm test`; record exact counts and failures.
- [ ] Restart only the scoped COSMO/dashboard/harness processes required by changed runtime code; do not restart healthy engines or MCP unless live evidence requires it.
- [ ] Run a live fractional Jerry PGS operation, continue it to a higher level, prove reused versus new work, run an isolated targeted operation, and prove detach/reattach/cancel behavior without a full-cost 100% provider run.
- [ ] Verify Jerry and Forrest direct Query, agent brain tools, MCP health, Brain Map source evidence, chat history reconciliation, canonical export, PM2 state, and disk/session quotas.
- [ ] Run `git diff --check` and write the dated receipt with operation IDs, source revisions, coverage counts, process IDs, storage bytes, and any explicitly deferred cost-heavy check.
