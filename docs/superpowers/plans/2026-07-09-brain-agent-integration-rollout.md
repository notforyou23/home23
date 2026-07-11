# Brain Agent Integration Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every Home23 agent-facing brain, research, automatic-retrieval, and turn entrypoint onto the approved durable brain-operation protocol so long work waits on verified activity, cross-brain reads stay read-only, and failures can never masquerade as success or an empty brain.

**Architecture:** The requester agent's dashboard remains the trusted BrainOperationCoordinator supplied by the prerequisite server plan. A typed `BrainOperationsClient` in the harness resolves targets through that coordinator, starts or attaches to durable operations, parses monotonic SSE events, renews the agent turn's activity lease, and returns typed results with source evidence and result handles. Brain/research/context tools become thin formatters over that client, while one central tool-result adapter makes all provider loops report `is_error` honestly and mark any shortened display explicitly.

**Tech Stack:** TypeScript, Node.js 20+ fetch/AbortSignal/Web Streams, Express, Server-Sent Events, `node:test`, `tsx`, JSON Schema contracts, CommonJS dashboard compatibility adapters, PM2-scoped live verification.

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-09-brain-operations-reliability-design.md` exactly; this plan implements only the agent-integration and rollout slice.
- Treat the canonical catalog, trusted requester identity, signed capabilities, durable coordinator routes, authoritative memory-source evidence, bounded graph routes, and normalized provider/PGS operation results as prerequisite interfaces supplied by the other implementation plans.
- Do not expose public cross-brain `target` arguments until prerequisite server authority, capability, requester-owned storage, and no-write tests pass.
- No target means the calling agent's exact resident brain; explicit sibling-agent and completed-research targets are read-only; unknown, ambiguous, active-research, mismatched, or unavailable targets fail closed.
- `brain_synthesize` remains own-brain only. Cross-brain reads cannot mutate target base, delta, ANN, metadata, PGS/session, cache, synthesis, export, or agency state.
- Operation states are `queued`, `running`, `complete`, `partial`, `failed`, `cancelled`, and `interrupted`; detachment is an attachment state, never an operation terminal state.
- Ordinary query attachment wait defaults to 90 minutes; PGS and synthesis attachment waits default to six hours; 60 seconds without an event triggers bounded status/reconnect, not immediate operation cancellation.
- Client transport bounds are separate from operation bounds: opening an SSE connection/receiving headers defaults to 10 seconds and a status/result JSON read defaults to 10 seconds. A bounded transport failure detaches the caller attachment and leaves the durable operation authoritative.
- A recoverable SSE silence, clean EOF, authenticated `event_gap`, or transient stream failure performs a bounded authoritative status read and may reconnect repeatedly until the one attachment deadline. Every recovery either advances the authoritative cursor or waits an injected bounded reconnect delay, so it cannot duplicate the start request or spin on immediate EOF.
- Only validated monotonic operation activity may renew a turn lease. Provider stall and server execution deadlines remain independent hard bounds.
- Query text is limited to 12,000 characters, prior context to 20,000 characters, `topK` to 1-100, graph samples to the prerequisite server's published bounded limits, and PGS sweep fraction to `(0, 1]`.
- Presence is significant at every public boundary. An omitted optional `target` is valid where the authority matrix permits it; a present `target:null`, empty object, array, unknown/extra selector field, non-string selector, wildcard, or whitespace-only identifier is `invalid_request`. Numeric limits reject `null`, strings, booleans, `NaN`, infinities, fractions where integers are required, and out-of-range values rather than defaulting or clamping them. Tool JSON Schemas use `additionalProperties:false`, and the executable adapters repeat these checks because direct tests and internal callers can bypass schema validation.
- Existing tool names and text-oriented responses remain compatible. Structured metadata and result handles are additive.
- Existing `/query`, `/query/stream`, `/home23/api/query/run`, and `/home23/api/query/export` remain compatibility adapters; new agent tools use `/home23/api/brain-operations`.
- Use test-driven development: write one focused failing test, run it and confirm the expected failure, implement the minimum behavior, rerun focused tests, then commit.
- Deterministic waiting tests use injected clocks, deferred promises, and controlled `ReadableStream` inputs. They do not use real `setTimeout`, `setImmediate`, polling micro-sleeps, or wall-clock HTTP timing; in-process HTTP is reserved for route-shape tests that do not assert timing.
- Preserve all existing runtime data and all pre-existing staged/working-tree changes. Never stage `instances/`, local `config/*.yaml`/`*.json`, `ecosystem.config.cjs`, logs, caches, receipts containing secrets, or operation runtime state.
- Do not run `pm2 stop all`, `pm2 delete all`, destructive Git cleanup, or a shared COSMO restart while a research run or brain operation is active.
- The live acceptance projection storm is current authority: 255 immediate `dashboard-source-<uuid>` roots consumed about 36.10 GiB and drove the filesystem to 99% because every concurrent `withEphemeralMemorySource()` compatibility request built its own full legacy projection. Both resident engines were already stopped and quiesced by the persistence/acceptance gate. The emergency response then issued exactly `pm2 stop home23-jerry-dash` and, later, `pm2 stop home23-forrest-dash`; those two dashboard stops are the recorded deviation from the original one-start-only PM2 plan, not permission for any broad or additional stop. The final pre-start state is still the four exact engine/dashboard rows stopped with PID zero, but the receipt must preserve that differing provenance.
- Do not restart a live resident engine until Task 8 Step 2A has run the production load path read-only against that exact brain, proved nonzero authoritative manifest-or-stream counts plus before/after hash agreement, recorded `brain-snapshot.json` only as advisory evidence, and exercised the production save path only against an external guarded temporary clone.
- Execute this plan in a clean isolated worktree created with `superpowers:using-git-worktrees`, on branch `codex/brain-agent-migration`, from the commit containing all four approved plans. The approved implementation used the isolated integration worktree `.worktrees/brain-agent-migration`; the commands below use that canonical branch name. At task start, `test -z "$(git status --porcelain)"` and `git diff --cached --quiet` must both pass. Do not execute implementation tasks in the live installation's already-modified worktree.
- Before every commit, require a clean index, stage only the paths named in that task with `git add -- <paths>`, run `git diff --cached --check`, inspect `git diff --cached -- <paths>`, and commit those explicit paths. A task may not absorb a file changed outside its own RED/GREEN cycle. After the commit, `test -z "$(git status --porcelain)"` must pass before the next task starts.
- The isolated worktree contains no ignored `instances/`, local config, secrets, or `ecosystem.config.cjs`; never run existing-install migration there and never point PM2 at it. Prefer an exact fast-forward so the live checkout equals the remotely read-back tested implementation commit. A reviewed combined live deployment may preserve pending tracked work only through Task 8's three-way/object-ID procedure: prove the primary index is byte/object-identical, run the complete verification matrix on the combined bytes, and record `live tree = pushed feature + preserved pending work`. Never stash, copy wholesale, discard, or rewrite the primary index. An unresolved semantic overlap stops prepare/restart. Ignored runtime state stays only in the live checkout.

---

## Prior-Plan Interface Contract

This plan starts only after the prerequisite plans expose the following HTTP contract from the requester dashboard:

```text
GET  /home23/api/brain-operations/catalog
GET  /home23/api/brain-operations?state=nonterminal
POST /home23/api/brain-operations
GET  /home23/api/brain-operations/:operationId
GET  /home23/api/brain-operations/:operationId/events?after=17&attachmentId=<id>
GET  /home23/api/brain-operations/:operationId/result
POST /home23/api/brain-operations/:operationId/cancel
POST /home23/api/brain-operations/:operationId/detach
POST /home23/api/brain-operations/:operationId/export
```

The only accepted start body is:

```ts
export interface StartBrainOperationRequest {
  requestId: string;
  operationType: string;
  target?: { agent?: string; brainId?: string } | { runId: string };
  parameters: Record<string, unknown>;
}
```

For a brain-domain operation, omitted `target` is preserved as omitted so the requester dashboard resolves its current resident brain from its own configured authority. An owned-run operation instead requires exactly `{runId}`; requester-domain operations require omission. The harness never sends `requesterAgent`, `canonicalRoot`, `accessMode`, or `idempotencyKey`; server idempotency is derived from dashboard requester identity plus `requestId` plus `operationType`. `attachmentId` is generated once per wait, is required only on the events query and detach body, and is reused across reconnects. `resultHandle` is descriptive metadata, not authorization: result reads always use the requester-authorized `GET /:operationId/result` route. For a `graph_export`, that route returns only the handle plus `resultArtifact {mediaType,contentEncoding:'identity',bytes,sha256}` metadata and never graph bytes; explicit requester-authorized `POST /:operationId/export` streams/copies the artifact to requester-owned output.

The catalog response must contain:

```ts
export interface BrainCatalogEntry {
  id: string;
  displayName: string;
  ownerAgent: string | null;
  kind: 'resident' | 'research';
  lifecycle: 'resident' | 'active' | 'completed' | 'unavailable';
  canonicalRoot: string;
  sourceType: string;
  nodeCount: number | null;
  modifiedAt: string;
  route: string;
  mutationBoundaries: Array<{
    kind: 'brain' | 'run' | 'pgs' | 'session' | 'cache' | 'export' | 'agency';
    path: string;
  }>;
}

export interface BrainCatalog {
  catalogRevision: string;
  brains: BrainCatalogEntry[];
}
```

Every catalog entry has exactly one entry for each of the seven kinds and no extra kind. For a resident target, `canonicalRoot`, the `brain` boundary path, and the `run` boundary path are the same canonical brain directory beneath `instances`; no resident boundary may broaden to the containing agent instance directory, whose live logs and conversations are outside the target graph and would make a read-only proof meaningless. For a research target, `canonicalRoot` and the `run` boundary are the canonical completed-run root, while `brain` is the canonical memory-source root named by that run. Duplicate physical paths across named kinds are intentional and must retain both names. Every boundary is recursively inventoried, including nested unknown extensions, extensionless files, newly added paths, symlinks as links without following them, and an explicit absent-root record when the boundary does not exist.

Operation status and record-shaped events use this complete canonical public shape:

```ts
export type BrainOperationState =
  | 'queued'
  | 'running'
  | 'complete'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface BrainOperationRecord {
  operationId: string;
  requestId: string;
  operationType: string;
  requestParameters: Record<string, unknown>;
  parameters: Record<string, unknown>;
  canonicalEvidence: boolean;
  recordVersion: number;
  eventSequence: number;
  requesterAgent: string;
  target:
    | {
        domain: 'brain';
        brainId: string;
        ownerAgent: string | null;
        displayName: string;
        kind: 'resident' | 'research';
        lifecycle: 'resident' | 'active' | 'completed' | 'unavailable';
        catalogRevision: string;
        route: string;
        canonicalRoot: string;
        accessMode: 'own' | 'read-only';
        mutationBoundaries: Array<{
          kind: 'brain' | 'run' | 'pgs' | 'session' | 'cache' | 'export' | 'agency';
          path: string;
        }>;
      }
    | {
        domain: 'owned-run';
        runId: string;
        canonicalRoot: string;
        ownerAgent: string;
        runState: string;
        catalogRevision: string;
        route: string;
        mutationBoundaries: Array<{
          kind: 'brain' | 'run' | 'pgs' | 'session' | 'cache' | 'export' | 'agency';
          path: string;
        }>;
      }
    | { domain: 'requester'; requesterAgent: string };
  state: BrainOperationState;
  phase: string | null;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  lastProviderActivityAt: string | null;
  lastProgressAt: string | null;
  result: Record<string, unknown> | null;
  resultHandle: string | null;
  resultArtifact: { mediaType: string; contentEncoding: 'identity'; bytes: number; sha256: string } | null;
  error: { code: string; message: string; retryable: boolean } | null;
  sourceEvidence: Record<string, unknown> | null;
  sourcePinDescriptor: Record<string, unknown> | null;
  sourcePinDigest: string | null;
  sourcePinReleasedAt: string | null;
  resultExpiresAt: string | null;
  resultExpiredAt: string | null;
  metadataExpiresAt: string | null;
}

export interface BrainOperationResultEnvelope {
  operationId: string;
  state: BrainOperationState;
  result: Record<string, unknown> | null;
  resultHandle: string | null;
  resultArtifact: { mediaType: string; contentEncoding: 'identity'; bytes: number; sha256: string } | null;
  error: { code: string; message: string; retryable: boolean } | null;
  sourceEvidence: Record<string, unknown> | null;
}
```

These are the complete Plan A public names, not a convenience subset. `requestParameters` is normalized caller intent; `parameters` is the trusted executor input and may contain server-selected values. All client/test fixtures must use `satisfies BrainOperationRecord` through one helper and populate every field, including the full canonical brain target, timestamps, nullable pin digest/release marker, and retention timestamps. No `as BrainOperationRecord`, partial intersection, or optional public field may hide contract drift. A capped event journal additionally emits this notification union member:

```ts
export interface BrainOperationEventGap {
  type: 'event_gap';
  operationId: string;
  oldestSequence: number;
  latestSequence: number;
  currentStatus: BrainOperationRecord;
}

export type BrainOperationEvent = BrainOperationRecord | BrainOperationEventGap;
```

`event_gap` explicitly denies contiguous replay. It is not operation activity and cannot renew a turn lease. The client validates its operation ID, integer range, embedded status identity, and monotonic relationship to the requested cursor, then performs a bounded canonical status read before advancing `after` to that returned status's retained `eventSequence`. The authenticated status must be at least `latestSequence`; a running status reconnects for future events, while a terminal status is followed by the protected result read. A malformed/regressive gap or a status behind the advertised retained cursor is `operation_event_gap_invalid` and detaches rather than guessing continuity.

The coordinator derives requester identity from its configured dashboard instance. Its persisted status record is the current authority for execution state; SSE events are monotonic notifications and the result route is the current authority for terminal payloads. The client in this plan never sends an authoritative requester field and never talks directly to COSMO operation endpoints.

## File Structure

- `src/agent/brain-operations/types.ts` — agent-side catalog, target, operation, retrieval-evidence, wait, and typed-error interfaces.
- `src/agent/brain-operations/sse.ts` — dependency-free SSE frame parser with monotonic operation-event validation.
- `src/agent/brain-operations/input-validation.ts` — shared exact-object, provider-pair, text, and finite numeric validation used by client and tool adapters.
- `src/agent/brain-operations/client.ts` — coordinator HTTP client, target refresh, request-ID-deduplicated start, bounded connect/status/result reads, wait/reconnect/detach/cancel, and short-operation helpers.
- `tests/helpers/brain-operation-record.ts` — the one complete compile-checked canonical operation fixture builder used by client, brain-tool, and research-tool tests.
- `src/agent/activity-lease.ts` — injected-clock renewable inactivity lease with a separate immutable hard deadline.
- `src/agent/turn-entrypoint.ts` — one tracked-and-awaited wrapper for main chat, Evobrew, cron, subagent, and worker entrypoints.
- `src/agent/cron-brain-query.ts` — validates scheduled no-tools brain queries, resolves exact model-alias provider/model pairs, starts one durable operation, and renders complete/detached/partial/failed authority honestly.
- `src/agent/tool-result.ts` — one truthful registry execution/result-display path shared by every model provider branch.
- `src/agent/types.ts` — additive `ToolResult` metadata/result handle/artifact and `ToolContext` brain-operation/activity interfaces.
- `src/agent/tools/brain.ts` — existing six brain tools rewritten as client adapters.
- `src/agent/tools/research.ts` — existing eleven research tools rewritten as client adapters with bounded concurrency and requester-owned output.
- `cosmo23/server/lib/research-run-operation-adapter.js`, `cosmo23/server/lib/research-compile-provider-adapter.js`, `cosmo23/server/lib/research-operation-executors.js`, `cosmo23/server/index.js` — Patch 50 concrete run/process state adapter, exact private compile/provider adapter, research operation backends, and worker registration.
- `src/agent/context-assembly.ts` — automatic own-brain retrieval through the shared client, retaining local triggers during remote degradation.
- `src/agent/loop.ts` — activity-leased `runWithTurn`, central tool execution, and shared-client context wiring.
- `src/home.ts`, `src/agent/tools/cron.ts`, `src/routes/evobrew-bridge.ts`, `src/agent/tools/subagent.ts`, `src/workers/runner.ts` — common tracked turn lifecycle at every entrypoint plus the durable 5,400-second-default cron query boundary.
- `engine/src/dashboard/home23-query-api.js` — compatibility-only validation and forwarding through the coordinator rather than arbitrary COSMO brain IDs.
- `contracts/schemas/query.schema.json` — compatibility limit/error/result-handle schema.
- `package.json` — explicitly includes new agent tests in `npm test`.
- `tests/agent/brain-operations-client.test.ts` — deterministic transport/wait/reconnect/cancel tests.
- `tests/agent/turn-activity-lease.test.ts`, `tests/agent/turn-entrypoints.test.ts`, `tests/agent/turn-entrypoint-callers.test.ts`, `tests/agent/tools/cron.test.ts` — renewable turn lease, entrypoint convergence, and durable scheduled-query contract tests.
- `tests/agent/tool-result.test.ts` — provider-independent result truth and truncation tests.
- `tests/agent/tools/brain.test.ts`, `tests/agent/tools/research.test.ts` — agent tool contract regressions.
- `tests/cosmo23/research-compile-provider-adapter.test.cjs`, `tests/cosmo23/research-operation-executors.test.cjs` — exact provider selection/no-query-fallback plus requester ownership, cursor, exact-section, and requester-output backend regressions.
- `tests/engine/dashboard/brain-operation-routes.test.js` — real-store large result/artifact handle and canonical export route regressions.
- `tests/agent/context-brain-retrieval.test.ts` — topK, source-state, and local-trigger preservation regressions.
- `tests/contracts/query-facade-route.test.cjs` — compatibility request limits, target mismatch, and HTTP-200 error rejection.
- `scripts/live-brain-tools-smoke.mjs` — imports the built agent client and real brain-tool executors, starts/attaches through the requester dashboard, records SSE activity, and waits with the production 90-minute/six-hour policy.
- `scripts/hash-brain-boundaries.mjs` — inventories every regular file under the named target mutation boundaries while excluding only requester-owned operation pins/scratch.
- `scripts/sample-process-memory.mjs` — samples fresh V8 heap/PID/restart metrics for every named dashboard/COSMO target during graph, Direct Query, and PGS canaries.
- `scripts/guarded-pm2-save.mjs` — creates unique dry-run/apply `dump.pm2` backups, freezes and excludes PM2 modules from application-dump equality, enforces a monotonic unrelated restart baseline, saves, verifies, and restores the apply backup on a failed postcondition.
- `scripts/cleanup-orphan-brain-projections.mjs` — performs manifest-driven, operator-approved cleanup of exact orphan dashboard projection roots while preserving brain and nonselected operation-boundary hashes.
- `scripts/verify-live-deployment-tree.mjs` — builds/seals an external three-way expected tree and compares live working bytes without touching the live index.
- `scripts/verify-brain-persistence.mjs` — streams the complete logical source through the production source reader against a named live brain under explicit heap/RSS bounds, proves authoritative manifest or legacy base-plus-committed-delta count/hash agreement while treating snapshots as advisory, exercises only the change-only production save path against an exact external byte clone, and confines full-rewrite load/write/reload proof to a bounded representative clone.
- `tests/scripts/live-brain-tools-smoke.test.cjs`, `tests/scripts/hash-brain-boundaries.test.cjs`, `tests/scripts/sample-process-memory.test.cjs`, `tests/scripts/verify-brain-persistence.test.cjs`, `tests/scripts/guarded-pm2-save.test.cjs`, `tests/scripts/cleanup-orphan-brain-projections.test.cjs`, `tests/scripts/verify-live-deployment-tree.test.cjs` — controlled fixtures for terminal waits, boundary completeness, revision-change detection, fresh multi-process heap thresholds, live-load immutability, temp-clone-only saves, safe PM2 resurrection-state updates, manifest-bound orphan cleanup, and external expected-tree proof.
- `shared/memory-source/operation-context.cjs` — admits only one compatibility source projection per canonical brain across processes before UUID/scratch allocation and identity-binds cleanup quarantine.
- `tests/shared/memory-source-operation-context.test.js`, `tests/engine/dashboard/brain-source-api.test.js`, `tests/engine/dashboard/memory-search.test.js`, `tests/cosmo23/brain-source-router.test.cjs` — compatibility admission concurrency/abort/path-turnover and retryable HTTP-503 boundary regressions.
- `src/agents/system-prompt.ts`, `engine/src/dashboard/home23-query.js` — durable 90-minute/six-hour wait and reattachment guidance without fixed PGS estimates.
- `tests/agent/tools/brain.test.ts`, `tests/dashboard/operator-ui.test.js` — runtime-prompt and dashboard-copy regressions for durable wait semantics.
- `docs/design/COSMO23-VENDORED-PATCHES.md`, `docs/design/STEP16-AGENT-COSMO-TOOLKIT-DESIGN.md` — durable design/patch documentation.
- `docs/receipts/2026-07-09-brain-tools-hardening.md` — final test and live evidence receipt, created only after acceptance commands run.

---

### Task 1: Build the Shared BrainOperationsClient

**Files:**
- Create: `src/agent/brain-operations/types.ts`
- Create: `src/agent/brain-operations/sse.ts`
- Create: `src/agent/brain-operations/input-validation.ts`
- Create: `src/agent/brain-operations/client.ts`
- Create: `tests/helpers/manual-clock.ts`
- Create: `tests/helpers/brain-operation-record.ts`
- Create: `tests/agent/brain-operations-client.test.ts`
- Modify: `tests/engine/dashboard/brain-operation-routes.test.js`
- Modify: `src/agent/types.ts:21-56`
- Modify: `src/home.ts:42, 298-326`

**Interfaces:**
- Consumes: the prerequisite coordinator HTTP routes and `BrainCatalog`/`BrainOperationRecord` contract above.
- Produces: `BrainOperationsClient`, `BrainTargetSelector`, `ResolvedBrainTarget`, `OperationActivity`, `BrainOperationResult`, and additive `ToolContext.brainOperations`/`ToolContext.onOperationActivity` fields used by Tasks 2, 4, 5, and 6.

- [ ] **Step 1: Add failing deterministic SSE/activity tests**

Create `tests/helpers/manual-clock.ts`:

```ts
export class ManualClock {
  nowMs = 0;
  tasks = new Map<number, { at: number; fn: () => void }>();
  nextId = 1;
  now = (): number => this.nowMs;
  setTimeout = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.nowMs + ms, fn });
    return id;
  };
  clearTimeout = (id: number): void => { this.tasks.delete(id); };
  advance(ms: number): void {
    this.nowMs += ms;
    while (true) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= this.nowMs)
        .sort((a, b) => a[1].at - b[1].at);
      if (!due.length) break;
      for (const [id, task] of due) {
        this.tasks.delete(id);
        task.fn();
      }
    }
  }
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
```

Create `tests/agent/brain-operations-client.test.ts` with a controlled stream. This file must not call real `setTimeout`, `setImmediate`, `sleep`, or an HTTP server whose wall clock controls the assertion:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrainOperationsClient } from '../../src/agent/brain-operations/client.js';
import { parseOperationEvents } from '../../src/agent/brain-operations/sse.js';
import { ManualClock, deferred, flushMicrotasks } from '../helpers/manual-clock.js';
import type {
  BrainOperationEvent, BrainOperationRecord,
} from '../../src/agent/brain-operations/types.js';

const OPAQUE_RESULT_HANDLE = 'brres_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function record(
  operationId: string,
  eventSequence: number,
  state: BrainOperationRecord['state'],
  result: Record<string, unknown> | null = null,
): BrainOperationRecord {
  return {
    operationId,
    requestId: `request-${operationId}`,
    operationType: 'query',
    requestParameters: { query: 'fixture query' },
    parameters: { query: 'fixture query' },
    canonicalEvidence: true,
    recordVersion: eventSequence,
    eventSequence,
    requesterAgent: 'jerry',
    target: {
      domain: 'brain',
      brainId: 'brain-jerry', ownerAgent: 'jerry', displayName: 'Jerry',
      kind: 'resident', lifecycle: 'resident', catalogRevision: 'catalog-fixture',
      route: '/api/brain/brain-jerry', canonicalRoot: '/fixture/jerry', accessMode: 'own',
      mutationBoundaries: [
        { kind: 'brain', path: '/fixture/jerry' }, { kind: 'run', path: '/fixture/jerry' },
        { kind: 'pgs', path: '/fixture/jerry/pgs-sessions' },
        { kind: 'session', path: '/fixture/jerry/sessions' },
        { kind: 'cache', path: '/fixture/jerry/cache' },
        { kind: 'export', path: '/fixture/jerry/exports' },
        { kind: 'agency', path: '/fixture/jerry/agency' },
      ],
    },
    state,
    phase: state === 'complete' ? 'done' : 'provider',
    startedAt: '2026-07-09T12:00:00.000Z',
    updatedAt: `2026-07-09T12:00:0${eventSequence}.000Z`,
    completedAt: state === 'complete' ? `2026-07-09T12:00:0${eventSequence}.000Z` : null,
    lastProviderActivityAt: `2026-07-09T12:00:0${eventSequence}.000Z`,
    lastProgressAt: null,
    result,
    resultHandle: state === 'complete' ? OPAQUE_RESULT_HANDLE : null,
    error: null,
    sourceEvidence: null,
    resultArtifact: null,
    sourcePinDescriptor: null,
    sourcePinDigest: null,
    sourcePinReleasedAt: null,
    resultExpiresAt: null,
    resultExpiredAt: null,
    metadataExpiresAt: null,
  };
}

function controlledStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const opened = deferred<void>();
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      opened.resolve(undefined);
    },
  });
  const encoder = new TextEncoder();
  return {
    body,
    opened: opened.promise,
    frame(value: BrainOperationEvent, terminated = true) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}${terminated ? '\n\n' : ''}`));
    },
    raw(value: string) { controller.enqueue(encoder.encode(value)); },
    close() { controller.close(); },
  };
}

test('verified operation events keep a query attachment alive beyond the old fixed deadline', async () => {
  const activities: number[] = [];
  const clock = new ManualClock();
  const sse = controlledStream();
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (init?.method === 'POST') {
      return new Response(JSON.stringify(record('op-1', 0, 'queued')), { status: 200 });
    }
    if (parsed.pathname.endsWith('/result')) {
      const terminal = record('op-1', 4, 'complete', { answer: 'delayed answer' });
      return new Response(JSON.stringify({ operationId: terminal.operationId, state: terminal.state,
        result: terminal.result, resultHandle: terminal.resultHandle, resultArtifact: null,
        error: null, sourceEvidence: null }), { status: 200 });
    }
    assert.match(String(url), /events\?after=0&attachmentId=attachment-1$/);
    return new Response(sse.body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const client = new BrainOperationsClient({
    baseUrl: 'http://fixture',
    callerAgent: 'jerry',
    fetchImpl,
    inactivityMs: 20,
    queryWaitMs: 200,
    attachmentIdFactory: () => 'attachment-1',
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onActivity: (activity) => activities.push(activity.sequence),
  });
  const pending = client.query({ query: 'wait for it', mode: 'quick' });
  await sse.opened;
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    clock.advance(12);
    sse.frame(record('op-1', sequence, 'running'));
    await flushMicrotasks();
  }
  clock.advance(12);
  sse.frame(record('op-1', 4, 'complete', { answer: 'delayed answer' }));
  sse.close();
  const result = await pending;
  assert.equal(result.state, 'complete');
  assert.equal(result.result?.answer, 'delayed answer');
  assert.equal(result.resultHandle, OPAQUE_RESULT_HANDLE);
  assert.deepEqual(activities, [1, 2, 3, 4]);
});

test('SSE parser flushes one valid final frame when EOF has no blank-line terminator', async () => {
  const sse = controlledStream();
  const clock = new ManualClock();
  const parsed: BrainOperationRecord[] = [];
  const pending = (async () => {
    for await (const event of parseOperationEvents(sse.body, 'op-final', 0, {
      inactivityMs: 20, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    })) {
      if ('type' in event) throw new Error('unexpected gap');
      parsed.push(event);
    }
  })();
  await sse.opened;
  sse.frame(record('op-final', 1, 'complete', { answer: 'final frame' }), false);
  sse.close();
  await pending;
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.result?.answer, 'final frame');
});
```

- [ ] **Step 2: Run the test and verify the expected RED failure**

Run:

```bash
node --import tsx --test --test-concurrency=1 tests/agent/brain-operations-client.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/agent/brain-operations/client.js`; after a delimiter-only parser exists, the final-frame test must remain RED until EOF flushing is implemented.

- [ ] **Step 3: Define the exact client-side types**

Create `src/agent/brain-operations/types.ts`:

```ts
export type BrainTargetSelector = { agent?: string; brainId?: string };
export type OwnedRunTargetSelector = { runId: string };

export type BrainOperationState =
  | 'queued' | 'running' | 'complete' | 'partial'
  | 'failed' | 'cancelled' | 'interrupted';

export type AttachmentState = 'attached' | 'detached' | 'closed';

export interface BrainCatalogEntry {
  id: string;
  displayName: string;
  ownerAgent: string | null;
  kind: 'resident' | 'research';
  lifecycle: 'resident' | 'active' | 'completed' | 'unavailable';
  canonicalRoot: string;
  sourceType: string;
  nodeCount: number | null;
  modifiedAt: string;
  route: string;
  mutationBoundaries: Array<{
    kind: 'brain' | 'run' | 'pgs' | 'session' | 'cache' | 'export' | 'agency';
    path: string;
  }>;
}

export interface BrainCatalog {
  catalogRevision: string;
  brains: BrainCatalogEntry[];
}

export interface ResolvedBrainTarget extends BrainCatalogEntry {
  accessMode: 'own' | 'read-only';
  catalogRevision: string;
}

export interface CanonicalBrainOperationTarget {
  domain: 'brain';
  brainId: string;
  ownerAgent: string | null;
  displayName: string;
  kind: 'resident' | 'research';
  lifecycle: 'resident' | 'active' | 'completed' | 'unavailable';
  catalogRevision: string;
  route: string;
  canonicalRoot: string;
  accessMode: 'own' | 'read-only';
  mutationBoundaries: BrainCatalogEntry['mutationBoundaries'];
}

export interface OperationActivity {
  source: 'brain_operation';
  operationId: string;
  sequence: number;
  state: BrainOperationState;
  phase: string | null;
  updatedAt: string;
  lastProviderActivityAt: string | null;
}

export interface BrainOperationRecord {
  operationId: string;
  requestId: string;
  operationType: string;
  requestParameters: Record<string, unknown>;
  parameters: Record<string, unknown>;
  canonicalEvidence: boolean;
  recordVersion: number;
  eventSequence: number;
  requesterAgent: string;
  target:
    | CanonicalBrainOperationTarget
    | { domain: 'owned-run'; runId: string; canonicalRoot: string;
        ownerAgent: string; runState: string; catalogRevision: string; route: string;
        mutationBoundaries: BrainCatalogEntry['mutationBoundaries'] }
    | { domain: 'requester'; requesterAgent: string };
  state: BrainOperationState;
  phase: string | null;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  lastProviderActivityAt: string | null;
  lastProgressAt: string | null;
  result: Record<string, unknown> | null;
  resultHandle: string | null;
  resultArtifact: { mediaType: string; contentEncoding: 'identity'; bytes: number; sha256: string } | null;
  error: { code: string; message: string; retryable: boolean } | null;
  sourceEvidence: Record<string, unknown> | null;
  sourcePinDescriptor: Record<string, unknown> | null;
  sourcePinDigest: string | null;
  sourcePinReleasedAt: string | null;
  resultExpiresAt: string | null;
  resultExpiredAt: string | null;
  metadataExpiresAt: string | null;
}

export interface BrainOperationEventGap {
  type: 'event_gap';
  operationId: string;
  oldestSequence: number;
  latestSequence: number;
  currentStatus: BrainOperationRecord;
}

export type BrainOperationEvent = BrainOperationRecord | BrainOperationEventGap;

export interface BrainOperationResultEnvelope {
  operationId: string;
  state: BrainOperationState;
  result: Record<string, unknown> | null;
  resultHandle: string | null;
  resultArtifact: { mediaType: string; contentEncoding: 'identity'; bytes: number; sha256: string } | null;
  error: { code: string; message: string; retryable: boolean } | null;
  sourceEvidence: Record<string, unknown> | null;
}

export interface BrainOperationResult extends BrainOperationRecord {
  attachmentState: AttachmentState;
}

export interface SynthesisStateResponse {
  ready: boolean;
  requestedGenerationMarker: string | null;
  currentGenerationMarker: string | null;
  markerStatus: 'unrequested' | 'matched' | 'changed' | 'absent';
  latestOperation: BrainOperationRecord | null;
  activeOperation: BrainOperationRecord | null;
}

export interface BrainQueryRequest {
  requestId?: string;
  target?: BrainTargetSelector;
  query: string;
  mode?: 'quick' | 'full' | 'expert' | 'dive';
  modelSelection?: { provider: string; model: string };
  enablePGS?: boolean;
  pgsConfig?: { sweepFraction?: number };
  pgsSweep?: { provider: string; model: string };
  pgsSynth?: { provider: string; model: string };
  enableSynthesis?: boolean;
  includeOutputs?: boolean;
  includeThoughts?: boolean;
  includeCoordinatorInsights?: boolean;
  allowActions?: boolean;
  pgsMode?: 'full';
  priorContext?: { query: string; answer: string } | null;
}
```

Copy the complete canonical names above into `tests/helpers/brain-operation-record.ts` and export `makeBrainOperationRecord(overrides)`, `canonicalCatalogEntry(agent)`, `canonicalBrainTarget(agent,accessMode)`, `canonicalResearchTarget(brainId)`, and `canonicalOwnedRunTarget(runId)`. `canonicalCatalogEntry()` returns the exact `BrainCatalogEntry` shape and is the only catalog-row fixture used below. The brain target helpers return the full Plan A shape, including `domain:'brain'`, all seven named boundaries, and the resident/completed-research lifecycle fields. The owned-run helper returns `domain:'owned-run'` plus exact `runId`, `canonicalRoot`, `ownerAgent`, `runState`, `catalogRevision`, `route`, and all seven named `mutationBoundaries`; it may not hide future fields behind `Record<string,unknown>`. The default record literal must use `satisfies BrainOperationRecord`; override merging is explicit per top-level field and target variant, never a permissive deep `as` cast. Import every helper explicitly in the client, brain-tool, and research-tool suites so the snippets below compile and future Plan A fields cause compile failures in all three suites. Query provider overrides use only exact nested `{provider,model}` pairs: `modelSelection` for Direct Query and `pgsSweep`/`pgsSynth` for PGS. Reject model-only, provider-only, flat `model`/`provider`, and all legacy `pgsSweepModel`/`pgsSweepProvider`/`pgsSynthModel`/`pgsSynthProvider` spellings. Omission asks the coordinator for its trusted server default; synthesis never accepts any caller provider/model field.

- [ ] **Step 4: Implement SSE parsing and the minimum start/wait client**

Create the minimum `src/agent/brain-operations/sse.ts` parser and reject an operation ID or sequence mismatch. Step 8 replaces its read loop with the deadline-aware final implementation after expanded RED tests cover CRLF and a terminal frame without a trailing blank line:

```ts
import type { BrainOperationEvent, BrainOperationEventGap, BrainOperationRecord } from './types.js';

export interface OperationEventReadOptions {
  signal?: AbortSignal;
  inactivityMs?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
}

function readWithInactivity(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: OperationEventReadOptions,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;
  const inactivityMs = options.inactivityMs ?? 60_000;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      options.signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(options.signal?.reason ?? new Error('operation_event_aborted')));
    const timer = setTimer(
      () => finish(() => reject(Object.assign(new Error('operation_event_inactive'), { code: 'operation_event_inactive' }))),
      inactivityMs,
    );
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

export async function* parseOperationEvents(
  body: ReadableStream<Uint8Array>,
  operationId: string,
  after: number,
  options: OperationEventReadOptions = {},
): AsyncGenerator<BrainOperationEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastSequence = after;
  const parseFrame = (frame: string): BrainOperationEvent | null => {
    const payload = frame.replace(/\r\n/g, '\n').split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!payload || payload === '[DONE]') return null;
    const event = JSON.parse(payload) as BrainOperationEvent;
    if ('type' in event && event.type === 'event_gap') {
      const gap = event as BrainOperationEventGap;
      if (gap.operationId !== operationId
          || !Number.isSafeInteger(gap.oldestSequence)
          || !Number.isSafeInteger(gap.latestSequence)
          || gap.oldestSequence <= lastSequence
          || gap.oldestSequence > gap.latestSequence
          || !gap.currentStatus
          || gap.currentStatus.operationId !== operationId
          || !Number.isSafeInteger(gap.currentStatus.eventSequence)
          || gap.currentStatus.eventSequence < gap.latestSequence
          || gap.currentStatus.eventSequence <= lastSequence) {
        throw Object.assign(new Error('operation_event_gap_invalid'), {
          code: 'operation_event_gap_invalid',
        });
      }
      lastSequence = gap.currentStatus.eventSequence;
      return gap;
    }
    if (event.operationId !== operationId) throw new Error('operation_event_mismatch');
    if (!Number.isInteger(event.eventSequence) || event.eventSequence <= lastSequence) {
      throw new Error('operation_event_out_of_order');
    }
    lastSequence = event.eventSequence;
    return event;
  };
  try {
    while (true) {
      const { done, value } = await readWithInactivity(reader, options);
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseFrame(frame);
        if (event) {
          yield event;
          // A gap ends this attachment. Only a bounded canonical status read may
          // choose the cursor for the next attachment.
          if ('type' in event && event.type === 'event_gap') return;
        }
        boundary = buffer.indexOf('\n\n');
      }
      if (done) {
        const finalEvent = parseFrame(buffer);
        if (finalEvent) yield finalEvent;
        buffer = '';
        break;
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
```

A gap is yielded for recovery but never passed to `onActivity`. Step 8 handles both an SSE gap and a bounded typed HTTP `event_gap` response through the same `validateEventGapEnvelope()` plus authenticated `statusOrDetach()` path.

Create `src/agent/brain-operations/client.ts` with constructor options, `query()`, `start()`, and `wait()` matching this signature:

```ts
import { randomUUID } from 'node:crypto';
import { parseOperationEvents } from './sse.js';
import type {
  BrainOperationEventGap, BrainOperationRecord, BrainOperationResult, BrainOperationResultEnvelope,
  BrainQueryRequest, OperationActivity, SynthesisStateResponse,
} from './types.js';

const TERMINAL = new Set(['complete', 'partial', 'failed', 'cancelled', 'interrupted']);

export class BrainOperationsClient {
  constructor(private readonly options: {
    baseUrl: string;
    callerAgent: string;
    fetchImpl?: typeof fetch;
    inactivityMs?: number;
    connectMs?: number;
    statusReadMs?: number;
    resultReadMs?: number;
    shortWaitMs?: number;
    catalogTtlMs?: number;
    queryWaitMs?: number;
    pgsWaitMs?: number;
    reconnectDelayMs?: number;
    maxErrorBodyBytes?: number;
    attachmentIdFactory?: () => string;
    now?: () => number;
    setTimeout?: (fn: () => void, ms: number) => unknown;
    clearTimeout?: (id: unknown) => void;
    onActivity?: (activity: OperationActivity) => void;
  }) {}

  private get fetchImpl(): typeof fetch { return this.options.fetchImpl ?? fetch; }
  private get now(): () => number { return this.options.now ?? Date.now; }

  withActivityHandler(onActivity: (activity: OperationActivity) => void): BrainOperationsClient {
    return new BrainOperationsClient({ ...this.options, onActivity });
  }

  async query(request: BrainQueryRequest, signal?: AbortSignal): Promise<BrainOperationResult> {
    const started = await this.start(request.enablePGS ? 'pgs' : 'query', request, signal);
    return this.wait(started.operationId, {
      signal,
      waitMs: request.enablePGS
        ? (this.options.pgsWaitMs ?? 6 * 60 * 60 * 1000)
        : (this.options.queryWaitMs ?? 90 * 60 * 1000),
    });
  }

  async start(
    operationType: string,
    parameters: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<BrainOperationRecord> {
    const requestId = typeof parameters.requestId === 'string' ? parameters.requestId : randomUUID();
    const target = parameters.target;
    const operationParameters = { ...parameters };
    delete operationParameters.requestId;
    delete operationParameters.target;
    const response = await this.fetchImpl(`${this.options.baseUrl}/home23/api/brain-operations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationType, requestId, target, parameters: operationParameters }),
      signal,
    });
    return this.readRecord(response);
  }

  async wait(
    operationId: string,
    options: { signal?: AbortSignal; waitMs: number },
  ): Promise<BrainOperationResult> {
    const deadline = this.now() + options.waitMs;
    const attachmentId = this.options.attachmentIdFactory?.() ?? randomUUID();
    let after = 0;
    while (this.now() < deadline) {
      const response = await this.fetchImpl(
        `${this.options.baseUrl}/home23/api/brain-operations/${encodeURIComponent(operationId)}/events?after=${after}&attachmentId=${encodeURIComponent(attachmentId)}`,
        { signal: options.signal },
      );
      if (!response.ok || !response.body) throw new Error(`source_unavailable: HTTP ${response.status}`);
      for await (const event of parseOperationEvents(response.body, operationId, after, {
        signal: options.signal,
        inactivityMs: this.options.inactivityMs ?? 60_000,
        setTimeout: this.options.setTimeout,
        clearTimeout: this.options.clearTimeout,
      })) {
        after = event.eventSequence;
        this.options.onActivity?.({
          source: 'brain_operation', operationId, sequence: after, state: event.state,
          phase: event.phase, updatedAt: event.updatedAt,
          lastProviderActivityAt: event.lastProviderActivityAt,
        });
        if (TERMINAL.has(event.state)) return { ...event, attachmentState: 'closed' };
      }
    }
    const status = await this.getOperation(operationId, options.signal);
    if (!TERMINAL.has(status.state)) {
      await this.detach(operationId, attachmentId, 'wait_deadline').catch(() => undefined);
    }
    return { ...status, attachmentState: TERMINAL.has(status.state) ? 'closed' : 'detached' };
  }

  async getOperation(operationId: string, signal?: AbortSignal): Promise<BrainOperationRecord> {
    return this.readRecord(await this.fetchImpl(
      `${this.options.baseUrl}/home23/api/brain-operations/${encodeURIComponent(operationId)}`,
      { signal },
    ));
  }

  private async readRecord(response: Response): Promise<BrainOperationRecord> {
    const text = await response.text();
    const body = text ? JSON.parse(text) as BrainOperationRecord & { success?: boolean; error?: unknown } : null;
    if (!response.ok || !body || body.success === false || !body.operationId) {
      throw new Error(`brain_operation_error: ${body?.error || `HTTP ${response.status}`}`);
    }
    return body;
  }
}
```

The minimum code above gets the first test green. Before leaving Task 1, extend it in the next steps rather than inventing tool behavior here.

- [ ] **Step 5: Run the first test and verify GREEN**

Run:

```bash
node --import tsx --test --test-concurrency=1 tests/agent/brain-operations-client.test.ts
```

Expected: PASS, 2 tests, including the unterminated-final-frame regression.

- [ ] **Step 6: Add failing reconnect, detach, cancellation, and error-body tests**

Append separate reconnect, detach, cancellation, error-body, CRLF, final-frame-without-blank-line, and short-operation disconnect tests to `tests/agent/brain-operations-client.test.ts`. Reuse `ManualClock` and controlled promises; the final test file must contain no real `setTimeout`, `setInterval`, or production-duration sleep:

```ts
test('stream silence performs a bounded status read and reconnects from the last sequence', async () => {
  let starts = 0;
  let statusReads = 0;
  let secondAttachments = 0;
  const clock = new ManualClock();
  const first = controlledStream();
  const second = controlledStream();
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (init?.method === 'POST') {
      starts += 1;
      return new Response(JSON.stringify(record('op-reconnect', 0, 'queued')), { status: 200 });
    }
    if (parsed.pathname.endsWith('/events') && parsed.searchParams.get('after') === '0') {
      return new Response(first.body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (parsed.pathname.endsWith('/op-reconnect')) {
      statusReads += 1;
      return new Response(JSON.stringify(record('op-reconnect', 1, 'running')), { status: 200 });
    }
    if (parsed.pathname.endsWith('/events') && parsed.searchParams.get('after') === '1') {
      secondAttachments += 1;
      return new Response(second.body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('', { status: 404 });
  };
  const client = new BrainOperationsClient({
    baseUrl: 'http://fixture', callerAgent: 'jerry', fetchImpl,
    inactivityMs: 10, reconnectDelayMs: 1, queryWaitMs: 200,
    attachmentIdFactory: () => 'attachment-r',
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  const pending = client.query({ query: 'reconnect', mode: 'quick' });
  await first.opened;
  first.frame(record('op-reconnect', 1, 'running'));
  await flushMicrotasks();
  clock.advance(11);
  await flushMicrotasks();
  clock.advance(1);
  await flushMicrotasks();
  await second.opened;
  second.frame(record('op-reconnect', 2, 'complete', { answer: 'reattached' }));
  second.close();
  const result = await pending;
  assert.equal(result.result?.answer, 'reattached');
  assert.equal(starts, 1);
  assert.equal(statusReads, 1);
  assert.equal(secondAttachments, 1);
});

test('attachment deadline detaches while the durable operation remains running and readable', async () => {
  let statusReads = 0;
  let detachCalls = 0;
  const clock = new ManualClock();
  const streamOpened = deferred<ReadableStreamDefaultController<Uint8Array>>();
  const running = record('op-detach', 1, 'running');
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (init?.method === 'POST' && parsed.pathname.endsWith('/detach')) {
      detachCalls += 1;
      return new Response(JSON.stringify(running), { status: 200 });
    }
    if (init?.method === 'POST') {
      return new Response(JSON.stringify(record('op-detach', 0, 'queued')), { status: 200 });
    }
    if (parsed.pathname.endsWith('/events') && parsed.searchParams.get('after') === '0') {
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(running)}\n\n`));
        streamOpened.resolve(controller);
      } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    statusReads += 1;
    return new Response(JSON.stringify(running), { status: 200 });
  };
  const client = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry', fetchImpl,
    inactivityMs: 2, queryWaitMs: 5,
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  const pending = client.query({ query: 'detach', mode: 'quick' });
  await streamOpened.promise;
  clock.advance(6);
  await Promise.resolve();
  await Promise.resolve();
  const result = await pending;
  assert.equal(result.attachmentState, 'detached');
  assert.equal(result.state, 'running');
  assert.equal((await client.getOperation('op-detach')).state, 'running');
  assert.equal(detachCalls, 1);
  assert.ok(statusReads >= 1);
});

test('one of two attachments detaches while the other receives terminal progress', async () => {
  const clock = new ManualClock();
  const streams = [controlledStream(), controlledStream()];
  const calls: string[] = [];
  const fetchImpl = createTwoAttachmentFetch({ operationId: 'op-shared', streams, calls });
  let attachment = 0;
  const client = new BrainOperationsClient({
    baseUrl: 'http://fixture', callerAgent: 'jerry', fetchImpl,
    attachmentIdFactory: () => `attachment-${++attachment}`,
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  const initial = record('op-shared', 0, 'queued');
  const shortAttachment = client.wait('op-shared', {
    operationType: 'query', initial, waitMs: 5,
  });
  const longAttachment = client.wait('op-shared', {
    operationType: 'query', initial, waitMs: 50,
  });
  await Promise.all(streams.map(stream => stream.opened));
  streams[0]!.frame(record('op-shared', 1, 'running'));
  streams[1]!.frame(record('op-shared', 1, 'running'));
  await flushMicrotasks();
  clock.advance(6);
  await flushMicrotasks();
  const detached = await shortAttachment;
  streams[1]!.frame(record('op-shared', 2, 'complete', { answer: 'still running' }));
  streams[1]!.close();
  const completed = await longAttachment;
  assert.equal(detached.attachmentState, 'detached');
  assert.equal(completed.state, 'complete');
  assert.equal(completed.result?.answer, 'still running');
  assert.equal(calls.filter(path => path.endsWith('/detach')).length, 1);
  assert.equal(calls.filter(path => path.endsWith('/cancel')).length, 0);
});

test('research stop remains attached beyond the old 30 second cutoff', async () => {
  const clock = new ManualClock();
  const sse = controlledStream();
  let settled = false;
  const fetchImpl = createSingleOperationFetch({
    operationId: 'op-stop', operationType: 'research_stop', sse,
    terminalResult: { stopped: true },
  });
  const client = new BrainOperationsClient({
    baseUrl: 'http://fixture', callerAgent: 'jerry', fetchImpl,
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    inactivityMs: 60_000, pgsWaitMs: 6 * 60 * 60_000,
  });
  const pending = client.stopResearch({ target: { runId: 'run-owned' } })
    .finally(() => { settled = true; });
  await sse.opened;
  sse.frame(record('op-stop', 1, 'running'));
  await flushMicrotasks();
  clock.advance(31_000);
  await flushMicrotasks();
  assert.equal(settled, false);
  sse.frame(record('op-stop', 2, 'complete', { stopped: true }));
  sse.close();
  assert.equal((await pending).state, 'complete');
});

test('explicit operator cancellation posts cancel and returns cancelled', async () => {
  let cancelCalls = 0;
  const controller = new AbortController();
  const sse = controlledStream();
  const cancelled = {
    ...record('op-cancel', 2, 'cancelled'),
    phase: 'cancelled',
    error: { code: 'cancelled', message: 'operator stop', retryable: false },
  };
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (init?.method === 'POST' && parsed.pathname.endsWith('/cancel')) {
      cancelCalls += 1;
      return new Response(JSON.stringify(cancelled), { status: 200 });
    }
    if (init?.method === 'POST') {
      return new Response(JSON.stringify(record('op-cancel', 0, 'queued')), { status: 200 });
    }
    if (parsed.pathname.endsWith('/events')) {
      return new Response(sse.body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (parsed.pathname.endsWith('/result')) {
      return new Response(JSON.stringify(cancelled), { status: 200 });
    }
    return new Response('', { status: 404 });
  };
  const client = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry', fetchImpl });
  const pending = client.query({ query: 'cancel', mode: 'quick' }, controller.signal);
  await sse.opened;
  sse.frame(record('op-cancel', 1, 'running'));
  await flushMicrotasks();
  controller.abort(Object.assign(new Error('operator_stop'), { code: 'operator_stop' }));
  const result = await pending;
  assert.equal(result.state, 'cancelled');
  assert.equal(cancelCalls, 1);
});

test('SSE connect/header deadline detaches a durable operation after a bounded status read', async () => {
  const clock = new ManualClock();
  const neverHeaders = deferred<Response>();
  let detachCalls = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (init?.method === 'POST' && parsed.pathname.endsWith('/detach')) {
      detachCalls += 1;
      return new Response(JSON.stringify(record('op-connect', 1, 'running')), { status: 200 });
    }
    if (init?.method === 'POST') {
      return new Response(JSON.stringify(record('op-connect', 0, 'queued')), { status: 200 });
    }
    if (parsed.pathname.endsWith('/events')) return neverHeaders.promise;
    if (parsed.pathname.endsWith('/op-connect')) {
      return new Response(JSON.stringify(record('op-connect', 1, 'running')), { status: 200 });
    }
    return new Response('', { status: 404 });
  };
  const client = new BrainOperationsClient({
    baseUrl: 'http://fixture', callerAgent: 'jerry', fetchImpl,
    connectMs: 10, statusReadMs: 10, queryWaitMs: 100,
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  const pending = client.query({ query: 'connect deadline' });
  await flushMicrotasks();
  clock.advance(11);
  await flushMicrotasks();
  const result = await pending;
  assert.equal(result.attachmentState, 'detached');
  assert.equal(result.state, 'running');
  assert.equal(detachCalls, 1);
});

test('status body-read deadline detaches instead of waiting forever after SSE silence', async () => {
  const clock = new ManualClock();
  const sse = controlledStream();
  const statusStarted = deferred<void>();
  const neverStatus = deferred<Response>();
  let detachCalls = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (init?.method === 'POST' && parsed.pathname.endsWith('/detach')) {
      detachCalls += 1;
      return new Response(JSON.stringify(record('op-status-timeout', 1, 'running')), { status: 200 });
    }
    if (init?.method === 'POST') {
      return new Response(JSON.stringify(record('op-status-timeout', 0, 'queued')), { status: 200 });
    }
    if (parsed.pathname.endsWith('/events')) {
      return new Response(sse.body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    statusStarted.resolve(undefined);
    return neverStatus.promise;
  };
  const client = new BrainOperationsClient({
    baseUrl: 'http://fixture', callerAgent: 'jerry', fetchImpl,
    inactivityMs: 10, connectMs: 10, statusReadMs: 10, queryWaitMs: 100,
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  const pending = client.query({ query: 'status deadline' });
  await sse.opened;
  sse.frame(record('op-status-timeout', 1, 'running'));
  await flushMicrotasks();
  clock.advance(11);
  await statusStarted.promise;
  clock.advance(11);
  await flushMicrotasks();
  const result = await pending;
  assert.equal(result.attachmentState, 'detached');
  assert.equal(detachCalls, 1);
});

test('HTTP 200 error envelopes are rejected as operation failures', async () => {
    const client = new BrainOperationsClient({ baseUrl: 'http://unused', callerAgent: 'jerry', fetchImpl: async () =>
    new Response(JSON.stringify({ success: false, error: { code: 'provider_failed' } }), { status: 200 }) });
  await assert.rejects(client.start('query', { query: 'x' }), /brain_operation_error/);
});

test('bounded non-2xx JSON preserves the typed coordinator error', async () => {
  const client = new BrainOperationsClient({ baseUrl: 'http://unused', callerAgent: 'jerry',
    fetchImpl: async () => new Response(JSON.stringify({ error: {
      code: 'target_not_available', message: 'research run is active', retryable: true,
    } }), { status: 409, headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(client.start('query', { query: 'x' }), (error: unknown) => {
    const typed = error as { code?: string; message?: string; retryable?: boolean; httpStatus?: number };
    assert.equal(typed.code, 'target_not_available');
    assert.equal(typed.message, 'research run is active');
    assert.equal(typed.retryable, true);
    assert.equal(typed.httpStatus, 409);
    return true;
  });
});

test('oversized, malformed, or stalled non-2xx bodies stay bounded and typed', async () => {
  let cancelled = false;
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(64 * 1024 + 1)); },
    cancel() { cancelled = true; },
  });
  const largeClient = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry',
    fetchImpl: async () => new Response(oversized, { status: 502 }) });
  await assert.rejects(largeClient.start('query', { query: 'x' }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'error_body_too_large');
    assert.equal((error as { httpStatus?: number }).httpStatus, 502);
    return true;
  });
  assert.equal(cancelled, true);

  const malformedClient = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry',
    fetchImpl: async () => new Response('{not-json', { status: 503 }) });
  await assert.rejects(malformedClient.start('query', { query: 'x' }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'source_unavailable');
    assert.equal((error as { httpStatus?: number }).httpStatus, 503);
    assert.match((error as Error).message, /\{not-json/);
    return true;
  });

  const clock = new ManualClock(); let stalledCancelled = false; let fetches = 0;
  const stalledClient = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry',
    statusReadMs: 10, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    fetchImpl: async () => {
      fetches += 1;
      return new Response(new ReadableStream<Uint8Array>({
        cancel() { stalledCancelled = true; },
      }), { status: 503 });
    } });
  const stalled = stalledClient.start('query', { query: 'x' });
  await flushMicrotasks(); clock.advance(11); await flushMicrotasks();
  await assert.rejects(stalled, (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'error_body_timeout');
    assert.equal((error as { httpStatus?: number }).httpStatus, 503);
    return true;
  });
  assert.equal(stalledCancelled, true);
  assert.equal(fetches, 1, 'a received non-2xx response is not a lost-start retry');
});

test('only exact target or untyped route-not-found errors refresh the catalog', async () => {
  for (const fixture of [
    { status: 409, code: 'target_not_found', refresh: true },
    { status: 409, code: 'target_not_available', refresh: true },
    { status: 409, code: 'target_mismatch', refresh: true },
    { status: 409, code: 'target_ambiguous', refresh: true },
    { status: 404, code: null, refresh: true },
    { status: 404, code: 'access_denied', refresh: false },
    { status: 403, code: 'access_denied', refresh: false },
    { status: 400, code: 'invalid_request', refresh: false },
    { status: 502, code: 'provider_failed', refresh: false },
  ]) {
    let catalogs = 0; let starts = 0;
    const client = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry',
      fetchImpl: async (url, init) => {
        if (String(url).endsWith('/catalog')) {
          catalogs += 1;
          return new Response(JSON.stringify({ catalogRevision: `c${catalogs}`,
            brains: [canonicalCatalogEntry('forrest')] }), { status: 200 });
        }
        assert.equal(init?.method, 'POST'); starts += 1;
        const body = fixture.code ? { error: { code: fixture.code, message: fixture.code } } : {};
        return new Response(JSON.stringify(body), { status: fixture.status });
      } });
    await assert.rejects(client.start('query', { target: { agent: 'forrest' }, query: 'x' }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, fixture.code || 'route_not_found');
        assert.equal((error as { httpStatus?: number }).httpStatus, fixture.status);
        return true;
      });
    assert.equal(catalogs, fixture.refresh ? 2 : 1);
    assert.equal(starts, fixture.refresh ? 2 : 1);
  }
});

test('event_gap reloads canonical status and resumes from its sequence without renewing activity', async () => {
  const fixture = createEventGapFetch({ operationId: 'op-gap', delivery: 'sse',
    gap: { oldestSequence: 10, latestSequence: 20 }, terminalSequence: 21 });
  const activities: number[] = [];
  const client = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry',
    fetchImpl: fixture.fetchImpl, attachmentIdFactory: () => 'attachment-gap',
    onActivity: (activity) => activities.push(activity.sequence) });
  const result = await client.query({ query: 'gap' });
  assert.equal(result.state, 'complete');
  assert.deepEqual(fixture.afterValues, [0, 20]);
  assert.deepEqual(fixture.attachmentIds, ['attachment-gap', 'attachment-gap']);
  assert.deepEqual(activities, [21]);
  assert.equal(fixture.detachCalls, 0);

  const httpFixture = createEventGapFetch({ operationId: 'op-gap-http', delivery: 'http',
    gap: { oldestSequence: 10, latestSequence: 20 }, terminalSequence: 21 });
  const httpClient = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry',
    fetchImpl: httpFixture.fetchImpl, attachmentIdFactory: () => 'attachment-gap-http' });
  assert.equal((await httpClient.query({ query: 'gap-http' })).state, 'complete');
  assert.deepEqual(httpFixture.afterValues, [0, 20]);
});

test('malformed or regressive event_gap detaches instead of fabricating continuity', async () => {
  for (const mutate of [
    (gap: any) => { gap.operationId = 'wrong'; },
    (gap: any) => { gap.oldestSequence = 1.5; },
    (gap: any) => { gap.oldestSequence = 22; gap.latestSequence = 20; },
    (gap: any) => { gap.currentStatus.eventSequence = 19; },
    (gap: any) => { gap.currentStatus.eventSequence = -1; },
  ]) {
    const fixture = createEventGapFetch({ operationId: 'op-bad-gap', delivery: 'sse',
      gap: { oldestSequence: 10, latestSequence: 20 }, terminalSequence: 21, mutate });
    const activities: number[] = [];
    const client = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry',
      fetchImpl: fixture.fetchImpl, onActivity: (activity) => activities.push(activity.sequence) });
    const result = await client.query({ query: 'bad-gap' });
    assert.equal(result.attachmentState, 'detached');
    assert.equal(fixture.detachReasons.at(-1), 'operation_event_gap_invalid');
    assert.deepEqual(activities, []);
  }
});

test('repeated recoverable reconnect cycles continue until the attachment deadline without another start', async () => {
  const clock = new ManualClock();
  const fixture = createRepeatedRecoveryFetch({ operationId: 'op-many', clock, cycles: [
    { kind: 'inactive', event: record('op-many', 1, 'running'), statusSequence: 1 },
    { kind: 'gap', oldestSequence: 2, latestSequence: 5, statusSequence: 5 },
    { kind: 'eof', statusSequence: 5 },
    { kind: 'terminal', event: record('op-many', 6, 'complete', { answer: 'after recoveries' }) },
  ] });
  const client = new BrainOperationsClient({
    baseUrl: 'http://fixture', callerAgent: 'jerry', fetchImpl: fixture.fetchImpl,
    inactivityMs: 10, reconnectDelayMs: 2, queryWaitMs: 200,
    attachmentIdFactory: () => 'attachment-many',
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  const pending = client.query({ query: 'survive repeated recovery' });
  await fixture.driveInactiveCycle();
  clock.advance(2); await flushMicrotasks();
  await fixture.driveGapCycle();
  await fixture.driveImmediateEofCycle();
  await flushMicrotasks();
  assert.equal(fixture.eventRequests.length, 3,
    'same-cursor EOF must wait instead of opening an immediate fourth stream');
  clock.advance(2); await flushMicrotasks();
  await fixture.driveTerminalCycle();
  assert.equal((await pending).result?.answer, 'after recoveries');
  assert.equal(fixture.startCalls, 1);
  assert.deepEqual(fixture.eventRequests.map((call) => call.after), [0, 1, 5, 5]);
  assert.deepEqual(new Set(fixture.eventRequests.map((call) => call.attachmentId)),
    new Set(['attachment-many']));
});

test('present-null, extra target fields, nonfinite limits, and partial provider pairs fail locally', async () => {
  let fetches = 0;
  const client = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry',
    fetchImpl: async () => { fetches += 1; throw new Error('fetch forbidden'); } });
  const invalid = [
    { target: null, query: 'x' }, { target: {}, query: 'x' }, { target: [], query: 'x' },
    { target: { agent: 'forrest', extra: true }, query: 'x' }, { target: { agent: ' ' }, query: 'x' },
    { target: { brainId: '*' }, query: 'x' }, { target: { brainId: null }, query: 'x' },
    { target: { agent: 'forrest', brainId: false }, query: 'x' },
    { query: 'x', modelSelection: null }, { query: 'x', modelSelection: { provider: 'openai' } },
    { query: 'x', modelSelection: { provider: 'openai', model: 'gpt', extra: true } },
    { query: 'x', provider: 'openai' }, { query: 'x', pgsSweepModel: 'gpt' },
    { query: 'x'.repeat(12_001) },
    { query: 'x', priorContext: { query: 'q', answer: 'a'.repeat(20_001) } },
  ];
  for (const value of invalid) await assert.rejects(client.start('query', value as never), /invalid/i);
  for (const topK of [null, '10', false, NaN, Infinity, -1, 0, 1.5, 101]) {
    await assert.rejects(client.start('search', { query: 'x', topK } as never), /invalid/i);
  }
  for (const [field, value] of [
    ['nodeLimit', null], ['nodeLimit', '25'], ['nodeLimit', NaN], ['nodeLimit', Infinity],
    ['nodeLimit', 1.5], ['nodeLimit', 0], ['nodeLimit', 8_001],
    ['edgeLimit', false], ['edgeLimit', 0], ['edgeLimit', 32_001],
  ] as const) {
    await assert.rejects(client.start('graph', { [field]: value } as never), /invalid/i);
  }
  for (const pgsConfig of [null, [], { extra: true }, { sweepFraction: 0.5, extra: true }]) {
    await assert.rejects(client.start('pgs', { query: 'x', pgsConfig } as never), /invalid/i);
  }
  for (const sweepFraction of [null, '0.5', false, NaN, Infinity, 0, -0.1, 1.1]) {
    await assert.rejects(client.start('pgs', {
      query: 'x', pgsConfig: { sweepFraction },
    } as never), /invalid/i);
  }
  assert.equal(fetches, 0);
});

test('lost start response retries once with the identical requestId and body', async () => {
  const bodies: string[] = [];
  const calls: string[] = [];
  let catalogReads = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/catalog')) {
      calls.push('catalog');
      catalogReads += 1;
      if (catalogReads > 1) throw new Error('catalog drift must not precede stable POST retry');
      return new Response(JSON.stringify({ catalogRevision: 'c1',
        brains: [canonicalCatalogEntry('forrest')] }), { status: 200 });
    }
    calls.push('post');
    bodies.push(String(init?.body));
    if (bodies.length === 1) {
      throw Object.assign(new TypeError('connection reset after server commit'), { code: 'ECONNRESET' });
    }
    return new Response(JSON.stringify(record('op-idempotent', 1, 'queued')), { status: 200 });
  };
  const client = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry', fetchImpl });
  const started = await client.start('query', {
    requestId: 'request-stable', target: { agent: 'forrest' }, query: 'x',
  });
  assert.equal(started.operationId, 'op-idempotent');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1], bodies[0]);
  assert.equal(JSON.parse(bodies[0]!).requestId, 'request-stable');
  assert.deepEqual(calls, ['catalog', 'post', 'post']);
});

test('owned-run operations send exactly one runId target and never consult brain catalog', async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body || '{}')));
    return new Response(JSON.stringify(record('op-run', 0, 'queued')), { status: 200 });
  };
  const client = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry', fetchImpl });
  await client.start('research_watch', { target: { runId: 'run-owned' }, after: 0 });
  assert.deepEqual(bodies[0]?.target, { runId: 'run-owned' });
  assert.deepEqual(bodies[0]?.parameters, { after: 0 });
  for (const target of [undefined, {}, { runId: '' }, { brainId: 'brain-r1' },
    { runId: '*' }, { runId: 'run-owned', brainId: 'brain-r1' }]) {
    await assert.rejects(
      client.start('research_watch', { ...(target ? { target } : {}), after: 0 } as never),
      /owned_run_target_requires_exact_run_id/,
    );
  }
  assert.equal(bodies.length, 1);
});

test('large canonical results are read by operation route and export never resubmits answer bytes', async () => {
  const answer = 'x'.repeat(1_000_000);
  let exportBody: Record<string, unknown> | null = null;
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/result')) {
      return new Response(JSON.stringify({ operationId: 'op-large', result: { answer },
        resultHandle: OPAQUE_RESULT_HANDLE, error: null, sourceEvidence: { sourceHealth: 'healthy' } }));
    }
    if (parsed.pathname.endsWith('/export')) {
      exportBody = JSON.parse(String(init?.body || '{}'));
      return new Response(JSON.stringify({ operationId: 'op-large', exportedTo: '/requester/export.md' }));
    }
    return new Response('', { status: 404 });
  };
  const client = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry', fetchImpl });
  const result = await client.getResult('op-large');
  assert.equal((result.result as { answer: string }).answer.length, 1_000_000);
  await client.exportResult({ operationId: 'op-large', resultHandle: OPAQUE_RESULT_HANDLE, format: 'markdown' });
  assert.equal('answer' in (exportBody || {}), false);
  assert.equal('resultHandle' in (exportBody || {}), false);
  await assert.rejects(
    client.exportResult({ operationId: 'op-large', format: 'markdown', answer } as never),
    /canonical_export_requires_operation_id/,
  );
});

test('short operation disconnect cancels work while durable query disconnect detaches', async () => {
  const calls: string[] = [];
  const streams = [controlledStream(), controlledStream()];
  let startIndex = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    calls.push(parsed.pathname);
    if (init?.method === 'POST' && parsed.pathname.endsWith('/cancel')) {
      return new Response(JSON.stringify(record('op-short', 2, 'cancelled')), { status: 200 });
    }
    if (init?.method === 'POST' && parsed.pathname.endsWith('/detach')) {
      return new Response(JSON.stringify(record('op-durable', 2, 'running')), { status: 200 });
    }
    if (init?.method === 'POST') {
      const operationId = startIndex++ === 0 ? 'op-short' : 'op-durable';
      return new Response(JSON.stringify(record(operationId, 0, 'queued')), { status: 200 });
    }
    if (parsed.pathname.includes('/op-short/events')) {
      return new Response(streams[0]!.body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (parsed.pathname.includes('/op-durable/events')) {
      return new Response(streams[1]!.body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (parsed.pathname.includes('/op-short/result')) {
      return new Response(JSON.stringify(record('op-short', 2, 'cancelled')), { status: 200 });
    }
    return new Response('', { status: 404 });
  };
  const client = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry', fetchImpl });
  const searchAbort = new AbortController();
  const search = client.search({ query: 'short' }, searchAbort.signal);
  await streams[0]!.opened;
  searchAbort.abort(Object.assign(new Error('transport_disconnect'), { code: 'transport_disconnect' }));
  await search;
  const queryAbort = new AbortController();
  const query = client.query({ query: 'durable' }, queryAbort.signal);
  await streams[1]!.opened;
  queryAbort.abort(Object.assign(new Error('transport_disconnect'), { code: 'transport_disconnect' }));
  await query;
  assert.equal(calls.filter(path => path.endsWith('/cancel')).length, 1);
  assert.equal(calls.filter(path => path.endsWith('/detach')).length, 1);
});

test('SSE accepts CRLF and parses a terminal final frame without a trailing blank line', async () => {
  const sse = controlledStream();
  const clock = new ManualClock();
  const events: Array<[number, string]> = [];
  const pending = (async () => {
    for await (const event of parseOperationEvents(sse.body, 'op-final', 0, {
      inactivityMs: 20, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    })) {
      if ('type' in event) throw new Error('unexpected gap');
      events.push([event.eventSequence, event.state]);
    }
  })();
  await sse.opened;
  sse.raw(`data: ${JSON.stringify(record('op-final', 1, 'running'))}\r\n\r\n`);
  sse.raw(`data: ${JSON.stringify(record('op-final', 2, 'complete'))}`);
  sse.close();
  await pending;
  assert.deepEqual(events, [[1, 'running'], [2, 'complete']]);
});

test('synthesisStatus without an operation ID performs only the exact synthesis-state GET', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const client = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: String(init?.method || 'GET') });
      return new Response(JSON.stringify({ ready: true, requestedGenerationMarker: 'g1',
        currentGenerationMarker: 'g2', markerStatus: 'changed', latestOperation: null,
        activeOperation: null }));
    } });
  const value = await client.synthesisStatus({ generationMarker: 'g1' });
  assert.deepEqual(value, { ready: true, requestedGenerationMarker: 'g1',
    currentGenerationMarker: 'g2', markerStatus: 'changed', latestOperation: null,
    activeOperation: null });
  assert.deepEqual(calls, [{
    url: 'http://fixture/api/synthesis/state?generationMarker=g1', method: 'GET',
  }]);
  await assert.rejects(client.synthesisStatus({ generationMarker: ' '.repeat(2) }), /generationMarker_invalid/);
  assert.equal(calls.length, 1);
});

test('PGS resume derives its six-hour wait from authenticated status and survives beyond 90 minutes', async () => {
  const clock = new ManualClock(); const sse = controlledStream(); let starts = 0;
  const running = { ...record('op-resume-pgs', 1, 'running'), operationType: 'pgs' };
  const terminal = { ...record('op-resume-pgs', 2, 'complete', { answer: 'late PGS' }), operationType: 'pgs' };
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (init?.method === 'POST') { starts += 1; return new Response('', { status: 500 }); }
    if (parsed.pathname.endsWith('/result')) return new Response(JSON.stringify({
      operationId: terminal.operationId, state: terminal.state, result: terminal.result,
      resultHandle: terminal.resultHandle, resultArtifact: null, error: null, sourceEvidence: null,
    }));
    if (parsed.pathname.endsWith('/events')) return new Response(sse.body,
      { headers: { 'content-type': 'text/event-stream' } });
    return new Response(JSON.stringify(running));
  };
  const client = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry', fetchImpl,
    inactivityMs: 2 * 60 * 60_000, queryWaitMs: 90 * 60_000, pgsWaitMs: 6 * 60 * 60_000,
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  const pending = client.resumeOperation('op-resume-pgs'); await sse.opened;
  clock.advance(91 * 60_000); await flushMicrotasks();
  sse.frame(terminal); sse.close();
  assert.equal((await pending).result?.answer, 'late PGS');
  assert.equal(starts, 0);
});
```

Define `createTwoAttachmentFetch()`, `createSingleOperationFetch()`, and `createRepeatedRecoveryFetch()` beside `controlledStream()` with no wall-clock timers; they serve distinct attachment streams, authoritative status/result routes (including `/result` for every terminal heartbeat fixture), and record detach/cancel calls. Add this exact gap fixture beside them:

```ts
function createEventGapFetch(options: {
  operationId: string; delivery: 'sse' | 'http';
  gap: { oldestSequence: number; latestSequence: number }; terminalSequence: number;
  mutate?: (gap: BrainOperationEventGap) => void;
}) {
  const afterValues: number[] = []; const attachmentIds: string[] = [];
  const detachReasons: string[] = []; let detachCalls = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (init?.method === 'POST' && parsed.pathname.endsWith('/detach')) {
      detachCalls += 1; detachReasons.push(JSON.parse(String(init.body)).reason);
      return new Response(JSON.stringify(record(options.operationId, 20, 'running')));
    }
    if (init?.method === 'POST') {
      return new Response(JSON.stringify(record(options.operationId, 0, 'queued')));
    }
    if (parsed.pathname.endsWith('/result')) {
      return new Response(JSON.stringify({ operationId: options.operationId, state: 'complete',
        result: { answer: 'after gap' }, resultHandle: OPAQUE_RESULT_HANDLE,
        resultArtifact: null, error: null, sourceEvidence: null }));
    }
    if (parsed.pathname.endsWith(`/${options.operationId}`)) {
      return new Response(JSON.stringify(record(options.operationId, 20, 'running')));
    }
    if (parsed.pathname.endsWith('/events')) {
      const after = Number(parsed.searchParams.get('after')); afterValues.push(after);
      attachmentIds.push(String(parsed.searchParams.get('attachmentId')));
      if (after === 0) {
        const gap: BrainOperationEventGap = { type: 'event_gap', operationId: options.operationId,
          oldestSequence: options.gap.oldestSequence, latestSequence: options.gap.latestSequence,
          currentStatus: record(options.operationId, options.gap.latestSequence, 'running') };
        options.mutate?.(gap);
        if (options.delivery === 'http') return new Response(JSON.stringify({ error: {
          code: 'event_gap', message: 'journal compacted', retryable: true, details: gap,
        } }), { status: 409 });
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(gap)}\n\n`));
          controller.close();
        } }), { headers: { 'content-type': 'text/event-stream' } });
      }
      const terminal = record(options.operationId, options.terminalSequence, 'complete', { answer: 'after gap' });
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(terminal)}\n\n`));
        controller.close();
      } }), { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('', { status: 404 });
  };
  return { fetchImpl, afterValues, attachmentIds, detachReasons,
    get detachCalls() { return detachCalls; } };
}
```

The repeated-recovery fixture advances only through its explicit driver methods and injected `ManualClock`. Each test asserts request counts and exact paths so duplicate starts, immediate reconnect spin, attachment cross-talk, wrong cursors, a result synthesized from the terminal SSE frame instead of `/result`, or a hidden 30-second stop cutoff cannot pass.

Append this real-store/router regression to the prerequisite `tests/engine/dashboard/brain-operation-routes.test.js`; do not mock its result or export methods:

```js
test('large durable result reloads by operation route and canonical export rejects caller bytes', async () => {
  const fixture = await makeRouteFixture();
  const operation = await fixture.coordinator.start({
    requestId: 'large-result-route', operationType: 'query',
    parameters: { query: 'large result fixture' },
  });
  const answer = 'durable-result-byte\n'.repeat(80_000);
  await fixture.worker.complete(operation.operationId, {
    state: 'complete', result: { answer }, error: null,
    sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'matches' },
  });
  const status = await fixture.store.get(operation.operationId);
  assert.equal(typeof status.resultHandle, 'string');
  assert.match(status.resultHandle, /^brres_[A-Za-z0-9_-]{32}$/);
  assert.equal(status.resultHandle.includes(operation.operationId), false);
  assert.doesNotMatch(status.resultHandle, /[\\/]/);
  assert.equal(status.result, null);

  const loaded = await getJson(fixture.app,
    `/home23/api/brain-operations/${operation.operationId}/result`);
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.result.answer.length, answer.length);
  assert.equal(loaded.body.resultHandle, status.resultHandle);

  const exported = await postJson(fixture.app,
    `/home23/api/brain-operations/${operation.operationId}/export`,
    { format: 'markdown', resultHandle: status.resultHandle });
  assert.equal(exported.status, 200);
  assert.equal(await fixture.readExport(exported.body.exportedTo), answer);

  const forged = await postJson(fixture.app,
    `/home23/api/brain-operations/${operation.operationId}/export`,
    { format: 'markdown', answer: 'forged caller bytes' });
  assert.equal(forged.status, 400);
  assert.equal(forged.body.error.code, 'canonical_export_forbids_inline_result');
});

test('graph artifact result route returns metadata and handle but never graph bytes', async () => {
  const fixture = await makeRouteFixture();
  const operation = await fixture.coordinator.start({
    requestId: 'graph-artifact-route', operationType: 'graph_export',
    parameters: { format: 'jsonl' },
  });
  const graphBytes = Buffer.from('{"node":{"id":"n1"}}\n'.repeat(100_000));
  await fixture.worker.completeArtifact(operation.operationId, {
    scratchPath: await fixture.writeOperationScratch(operation.operationId, 'graph.jsonl', graphBytes),
    mediaType: 'application/x-ndjson', contentEncoding: 'identity',
    bytes: graphBytes.length, sha256: fixture.sha256(graphBytes),
  });
  const status = await fixture.store.get(operation.operationId);
  assert.equal(typeof status.resultHandle, 'string');
  assert.match(status.resultHandle, /^brres_[A-Za-z0-9_-]{32}$/);
  assert.equal(status.resultHandle.includes(operation.operationId), false);
  assert.doesNotMatch(status.resultHandle, /[\\/]/);
  assert.equal(status.resultArtifact.bytes, graphBytes.length);
  assert.equal(status.resultArtifact.contentEncoding, 'identity');
  assert.match(status.resultArtifact.sha256, /^[a-f0-9]{64}$/);

  const loaded = await getJson(fixture.app,
    `/home23/api/brain-operations/${operation.operationId}/result`);
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.result, null);
  assert.equal(loaded.body.resultHandle, status.resultHandle);
  assert.deepEqual(loaded.body.resultArtifact, status.resultArtifact);
  assert.equal(JSON.stringify(loaded.body).includes('"node"'), false);

  const exported = await postJson(fixture.app,
    `/home23/api/brain-operations/${operation.operationId}/export`,
    { format: 'jsonl' });
  assert.equal(exported.status, 200);
  const copied = await fixture.readExportBuffer(exported.body.exportedTo);
  assert.equal(copied.length, graphBytes.length);
  assert.equal(fixture.sha256(copied), status.resultArtifact.sha256);
});
```

`makeRouteFixture()` is the prerequisite route suite's real temporary `BrainOperationStore` plus real router; its worker fixture completes through the coordinator transition and `readExport()` reads the requester workspace file. This regression remains RED until large-result spill/reload and canonical export validation exist.

- [ ] **Step 7: Run the expanded test and verify RED for missing reconnect/cancel behavior**

Run:

```bash
node --import tsx --test --test-concurrency=1 tests/agent/brain-operations-client.test.ts
```

Expected: the heartbeat test passes; reconnect and operator-cancel tests fail because `wait()` does not yet perform inactivity recovery or POST cancel.

- [ ] **Step 8: Complete client target, reconnect, detach, and cancellation behavior**

Replace the signature-only sketch with these executable public adapters inside `BrainOperationsClient`:

```ts
private catalogCache: BrainCatalog | null = null;
private catalogCachedAt = 0;

async getCatalog(options: { forceRefresh?: boolean } = {}): Promise<BrainCatalog> {
  const ttl = this.options.catalogTtlMs ?? 30_000;
  if (this.catalogCache && !options.forceRefresh && this.now() - this.catalogCachedAt < ttl) {
    return this.catalogCache;
  }
  const value = await this.requestJson<BrainCatalog>('/home23/api/brain-operations/catalog', {}, {
    code: 'catalog_timeout', timeoutMs: this.options.statusReadMs ?? 10_000,
  });
  if (!value.catalogRevision || !Array.isArray(value.brains)) throw new Error('catalog_invalid');
  if (value.brains.length > 0) {
    this.catalogCache = value;
    this.catalogCachedAt = this.now();
  } else {
    this.catalogCache = null;
    this.catalogCachedAt = 0;
  }
  return value;
}

private invalidateCatalog(): void {
  this.catalogCache = null;
  this.catalogCachedAt = 0;
}

async listNonterminal(signal?: AbortSignal): Promise<BrainOperationRecord[]> {
  const value = await this.requestJson<{ operations: BrainOperationRecord[] }>(
    '/home23/api/brain-operations?state=nonterminal', {},
    { code: 'status_timeout', timeoutMs: this.options.statusReadMs ?? 10_000, signal },
  );
  return Array.isArray(value.operations) ? value.operations : [];
}

async resolveTarget(target?: BrainTargetSelector): Promise<ResolvedBrainTarget> {
  const resolveFrom = (catalog: BrainCatalog): ResolvedBrainTarget => {
    const keys = target && typeof target === 'object' && !Array.isArray(target)
      ? Object.keys(target).sort() : [];
    if (target !== undefined && (!target || typeof target !== 'object' || Array.isArray(target)
        || keys.length < 1 || keys.some((key) => key !== 'agent' && key !== 'brainId')
        || (!target.agent && !target.brainId)
        || (target.agent !== undefined && (typeof target.agent !== 'string'
          || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(target.agent)))
        || (target.brainId !== undefined && (typeof target.brainId !== 'string'
          || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(target.brainId))))) {
      throw Object.assign(new Error('invalid target selector'), { code: 'invalid_request' });
    }
    const byAgent = (target?.agent || !target) ? catalog.brains.filter((brain) =>
      brain.kind === 'resident' && brain.ownerAgent === (target?.agent || this.options.callerAgent)) : [];
    const byId = target?.brainId ? catalog.brains.filter((brain) => brain.id === target.brainId) : [];
    const unique = (matches: BrainCatalogEntry[], missing: boolean): BrainCatalogEntry | null => {
      if (matches.length > 1) throw Object.assign(new Error('target_ambiguous'), { code: 'target_ambiguous' });
      if (missing && matches.length === 0) throw Object.assign(new Error('target_not_found'), { code: 'target_not_found' });
      return matches[0] || null;
    };
    const agentBrain = unique(byAgent, Boolean(target?.agent) || !target) ;
    const idBrain = unique(byId, Boolean(target?.brainId));
    if (agentBrain && idBrain && agentBrain.id !== idBrain.id) {
      throw Object.assign(new Error('target_mismatch'), { code: 'target_mismatch' });
    }
    const brain = idBrain || agentBrain;
    if (!brain) throw Object.assign(new Error('target_not_found'), { code: 'target_not_found' });
    const eligible = (brain.kind === 'resident' && brain.lifecycle === 'resident')
      || (brain.kind === 'research' && brain.lifecycle === 'completed');
    if (!eligible) throw Object.assign(new Error('target_not_available'), { code: 'target_not_available' });
    return { ...brain,
      accessMode: brain.kind === 'resident' && brain.ownerAgent === this.options.callerAgent
        ? 'own' : 'read-only',
      catalogRevision: catalog.catalogRevision };
  };
  try {
    return resolveFrom(await this.getCatalog());
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (!['target_not_found', 'target_not_available', 'target_mismatch', 'target_ambiguous'].includes(code || '')) {
      throw error;
    }
    this.invalidateCatalog();
    return resolveFrom(await this.getCatalog({ forceRefresh: true }));
  }
}

withActivityHandler(onActivity: (activity: OperationActivity) => void): BrainOperationsClient {
  return new BrainOperationsClient({ ...this.options, onActivity });
}

async search(request: Record<string, unknown>, signal?: AbortSignal) {
  return this.runShort('search', request, signal);
}
async graph(request: Record<string, unknown>, signal?: AbortSignal) {
  return this.runShort('graph', request, signal);
}
async status(request: Record<string, unknown>, signal?: AbortSignal) {
  return this.runShort('status', request, signal);
}
async watchResearch(request: {
  target: { runId: string }; after: number; limit?: number; filter?: string;
}, signal?: AbortSignal) {
  return this.runShort('research_watch', request, signal);
}
async readIntelligence(request: Record<string, unknown>, signal?: AbortSignal) {
  return this.runShort('research_intelligence', request, signal);
}
async graphExport(request: Record<string, unknown>, signal?: AbortSignal) {
  return this.runDurable('graph_export', request, this.options.queryWaitMs ?? 90 * 60_000, signal);
}
async synthesize(request: Record<string, unknown>, signal?: AbortSignal) {
  return this.runDurable('synthesis', request, this.options.pgsWaitMs ?? 6 * 60 * 60_000, signal);
}
async synthesisStatus(
  request: { operationId?: string; generationMarker?: string }, signal?: AbortSignal,
) {
  if (request.operationId) {
    const status = await this.getOperation(request.operationId, signal);
    if (status.operationType !== 'synthesis') throw Object.assign(
      new Error('operation_type_mismatch'), { code: 'operation_type_mismatch' });
    if (!TERMINAL.has(status.state)) return { ...status, attachmentState: 'detached' };
    return { ...status, ...(await this.getResult(request.operationId, signal)), attachmentState: 'closed' };
  }
  if (request.generationMarker !== undefined
      && (typeof request.generationMarker !== 'string' || !request.generationMarker.trim()
        || request.generationMarker.length > 256)) {
    throw Object.assign(new Error('generationMarker_invalid'), { code: 'invalid_request' });
  }
  const query = request.generationMarker
    ? `?generationMarker=${encodeURIComponent(request.generationMarker)}` : '';
  return this.requestJson<SynthesisStateResponse>(`/api/synthesis/state${query}`, {}, {
    code: 'synthesis_status_timeout', timeoutMs: this.options.statusReadMs ?? 10_000, signal,
  });
}
async reattachSynthesis(operationId: string, signal?: AbortSignal) {
  const status = await this.getOperation(operationId, signal);
  if (status.operationType !== 'synthesis') throw Object.assign(
    new Error('operation_type_mismatch'), { code: 'operation_type_mismatch' });
  return this.resumeOperation(operationId, signal);
}
async compile(request: Record<string, unknown>, signal?: AbortSignal) {
  return this.runDurable('research_compile', request, this.options.pgsWaitMs ?? 6 * 60 * 60_000, signal);
}
async stopResearch(request: { target: { runId: string } }, signal?: AbortSignal) {
  return this.runDurable('research_stop', request, this.options.pgsWaitMs ?? 6 * 60 * 60_000, signal);
}
async launchResearch(request: Record<string, unknown>, signal?: AbortSignal) {
  return this.runDurable('research_launch', request, this.options.pgsWaitMs ?? 6 * 60 * 60_000, signal);
}
async continueResearch(request: {
  target: { runId: string }; context?: string; cycles?: number;
  primaryModel?: string; primaryProvider?: string;
}, signal?: AbortSignal) {
  return this.runDurable('research_continue', request, this.options.pgsWaitMs ?? 6 * 60 * 60_000, signal);
}

async exportAdHocResult(
  request: { query: string; answer: string; format: string; metadata?: Record<string, unknown> },
  signal?: AbortSignal,
) {
  const operation = await this.runDurable(
    'ad_hoc_export', request, this.options.queryWaitMs ?? 90 * 60_000, signal,
  );
  return this.unwrap(operation);
}
```

Use this executable operation classification in the same module; `query()` selects `pgs` only when `enablePGS === true`:

```ts
const DURABLE_OPERATION_TYPES = new Set([
  'query', 'pgs', 'synthesis', 'research_compile', 'research_stop',
  'research_launch', 'research_continue', 'graph_export', 'ad_hoc_export',
]);
const OWNED_RUN_OPERATION_TYPES = new Set([
  'research_continue', 'research_stop', 'research_watch',
]);

const MAX_ERROR_BODY_BYTES = 64 * 1024;

function exactProviderModelPair(value: unknown, field: string): { provider: string; model: string } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'model,provider') {
    throw Object.assign(new Error(`${field}_requires_exact_provider_model`), { code: 'invalid_request' });
  }
  const pair = value as { provider?: unknown; model?: unknown };
  if (typeof pair.provider !== 'string' || !pair.provider.trim()
      || typeof pair.model !== 'string' || !pair.model.trim()) {
    throw Object.assign(new Error(`${field}_requires_exact_provider_model`), { code: 'invalid_request' });
  }
  return { provider: pair.provider, model: pair.model };
}

function finiteInteger(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw Object.assign(new Error(`${field}_invalid`), { code: 'invalid_request' });
  }
  return value;
}

function validateCallerParameters(operationType: string, parameters: Record<string, unknown>): void {
  const allowed: Record<string, ReadonlySet<string>> = {
    query: new Set(['requestId','target','query','mode','modelSelection','enableSynthesis',
      'includeOutputs','includeThoughts','includeCoordinatorInsights','allowActions','priorContext','topK']),
    pgs: new Set(['requestId','target','query','mode','pgsMode','pgsConfig','pgsSweep','pgsSynth','priorContext']),
    synthesis: new Set(['requestId','trigger','reason']),
    search: new Set(['requestId','target','query','topK','tag']),
    graph: new Set(['requestId','target','nodeLimit','edgeLimit','tag','clusterId','minWeight']),
    status: new Set(['requestId','target','view','generationMarker']),
  };
  const keys = allowed[operationType];
  if (keys) for (const key of Object.keys(parameters)) {
    if (!keys.has(key)) throw Object.assign(new Error(`${key}_invalid`), { code: 'invalid_request' });
  }
  for (const forbidden of ['model', 'provider', 'pgsSweepModel', 'pgsSweepProvider',
    'pgsSynthModel', 'pgsSynthProvider']) {
    if (Object.prototype.hasOwnProperty.call(parameters, forbidden)) {
      throw Object.assign(new Error(`${forbidden}_invalid`), { code: 'invalid_request' });
    }
  }
  const modelSelection = exactProviderModelPair(parameters.modelSelection, 'modelSelection');
  const pgsSweep = exactProviderModelPair(parameters.pgsSweep, 'pgsSweep');
  const pgsSynth = exactProviderModelPair(parameters.pgsSynth, 'pgsSynth');
  if (operationType === 'query' && (pgsSweep || pgsSynth)) throw new Error('invalid_request');
  if (operationType === 'pgs' && modelSelection) throw new Error('invalid_request');
  if (operationType === 'synthesis' && (modelSelection || pgsSweep || pgsSynth)) throw new Error('invalid_request');
  finiteInteger(parameters.topK, 'topK', 1, 100);
  finiteInteger(parameters.nodeLimit, 'nodeLimit', 1, 2_000);
  finiteInteger(parameters.edgeLimit, 'edgeLimit', 1, 8_000);
  if (parameters.query !== undefined
      && (typeof parameters.query !== 'string' || !parameters.query.trim() || parameters.query.length > 12_000)) {
    throw Object.assign(new Error('query_invalid'), { code: 'invalid_request' });
  }
  if (parameters.priorContext !== undefined && parameters.priorContext !== null) {
    const prior = parameters.priorContext as Record<string, unknown>;
    if (!prior || typeof prior !== 'object' || Array.isArray(prior)
        || Object.keys(prior).some((key) => key !== 'query' && key !== 'answer')
        || typeof prior.query !== 'string' || typeof prior.answer !== 'string'
        || prior.query.length + prior.answer.length > 20_000) {
      throw Object.assign(new Error('priorContext_invalid'), { code: 'invalid_request' });
    }
  }
  if (parameters.pgsConfig !== undefined) {
    const config = parameters.pgsConfig as Record<string, unknown>;
    if (!config || typeof config !== 'object' || Array.isArray(config)
        || Object.keys(config).some((key) => key !== 'sweepFraction')) {
      throw Object.assign(new Error('pgsConfig_invalid'), { code: 'invalid_request' });
    }
    if (config.sweepFraction !== undefined
        && (typeof config.sweepFraction !== 'number' || !Number.isFinite(config.sweepFraction)
          || config.sweepFraction <= 0 || config.sweepFraction > 1)) {
      throw Object.assign(new Error('sweepFraction_invalid'), { code: 'invalid_request' });
    }
  }
}

async query(request: BrainQueryRequest, signal?: AbortSignal): Promise<BrainOperationResult> {
  const operationType = request.enablePGS === true ? 'pgs' : 'query';
  const { enablePGS: _routingOnly, ...parameters } = request;
  const waitMs = operationType === 'pgs'
    ? (this.options.pgsWaitMs ?? 6 * 60 * 60_000)
    : (this.options.queryWaitMs ?? 90 * 60_000);
  return this.runDurable(operationType, parameters, waitMs, signal);
}
```

Place `exactProviderModelPair`, `optionalFiniteInteger` (the same safe-integer behavior as `finiteInteger`, returning undefined only for true omission), exact-key validation, and bounded-text validation in `input-validation.ts`; import them into the client, `brain.ts`, and `research.ts`. The inline definitions show the required behavior, not permission to maintain divergent copies.

Replace the minimum `start()`/`wait()` implementation with these executable helpers. This is the implementation seam the RED tests above exercise:

```ts
private async runShort(
  operationType: string,
  parameters: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const started = await this.start(operationType, parameters, signal);
  return this.unwrap(await this.wait(started.operationId, {
    operationType, initial: started, signal,
    waitMs: this.options.shortWaitMs ?? 5 * 60_000,
  }));
}

private async runDurable(
  operationType: string,
  parameters: Record<string, unknown>,
  waitMs: number,
  signal?: AbortSignal,
): Promise<BrainOperationResult> {
  const started = await this.start(operationType, parameters, signal);
  return this.wait(started.operationId, { operationType, initial: started, signal, waitMs });
}

private unwrap(operation: BrainOperationResult): Record<string, unknown> {
  if (['failed', 'cancelled', 'interrupted'].includes(operation.state)) {
    const error = Object.assign(
      new Error(operation.error?.message || operation.state),
      { code: operation.error?.code || 'brain_operation_failed', operation },
    );
    throw error;
  }
  return {
    ...(operation.result || {}),
    operationId: operation.operationId,
    state: operation.state,
    attachmentState: operation.attachmentState,
    resultHandle: operation.resultHandle,
    resultArtifact: operation.resultArtifact,
    sourceEvidence: operation.sourceEvidence,
  };
}

async start(
  operationType: string,
  parameters: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<BrainOperationRecord> {
  if ('requesterAgent' in parameters || 'idempotencyKey' in parameters
      || 'canonicalRoot' in parameters || 'accessMode' in parameters) {
    throw new Error('authoritative_fields_forbidden');
  }
  validateCallerParameters(operationType, parameters);
  const requestId = typeof parameters.requestId === 'string' ? parameters.requestId : randomUUID();
  const targetPresent = Object.prototype.hasOwnProperty.call(parameters, 'target');
  const target = parameters.target as BrainTargetSelector | { runId: string } | undefined;
  const ownedRun = OWNED_RUN_OPERATION_TYPES.has(operationType);
  if (ownedRun) {
    const keys = target && typeof target === 'object' && !Array.isArray(target)
      ? Object.keys(target).sort() : [];
    const runId = (target as { runId?: unknown } | undefined)?.runId;
    if (keys.length !== 1 || keys[0] !== 'runId'
        || typeof runId !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
      throw Object.assign(new Error('owned_run_target_requires_exact_run_id'), { code: 'invalid_request' });
    }
  } else if (targetPresent) {
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      throw Object.assign(new Error('target_invalid'), { code: 'invalid_request' });
    }
    const keys = Object.keys(target).sort();
    if (keys.length < 1 || keys.some((key) => key !== 'agent' && key !== 'brainId')) {
      throw Object.assign(new Error('target_invalid'), { code: 'invalid_request' });
    }
    await this.resolveTarget(target as BrainTargetSelector);
  }
  const operationParameters = { ...parameters };
  delete operationParameters.requestId;
  delete operationParameters.target;
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationType, requestId, ...(target ? { target } : {}), parameters: operationParameters }),
  };
  const deadline = { code: 'operation_start_timeout', timeoutMs: this.options.statusReadMs ?? 10_000, signal };
  try {
    return await this.requestJson<BrainOperationRecord>('/home23/api/brain-operations', init, deadline);
  } catch (error) {
    const typed = error as { code?: string; httpStatus?: number };
    const code = typed.code;
    const lostResponse = error instanceof TypeError
      || ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'operation_start_timeout'].includes(code || '');
    if (lostResponse && !typed.httpStatus && !signal?.aborted) {
      // This byte-identical POST happens before any catalog/config refresh. Plan A's requester-scoped
      // idempotency precheck finds the durable record without consulting drift-prone authority.
      return this.requestJson<BrainOperationRecord>('/home23/api/brain-operations', init, deadline);
    }
    const refreshable = ['target_not_found', 'target_not_available', 'target_mismatch',
      'target_ambiguous'].includes(code || '') || code === 'route_not_found';
    if (refreshable && !ownedRun) {
      this.invalidateCatalog();
      await this.resolveTarget(target as BrainTargetSelector | undefined);
      return this.requestJson<BrainOperationRecord>('/home23/api/brain-operations', init, deadline);
    }
    throw error;
  }
}

async wait(
  operationId: string,
  options: {
    operationType: string;
    initial: BrainOperationRecord;
    signal?: AbortSignal;
    waitMs: number;
  },
): Promise<BrainOperationResult> {
  const attachmentId = this.options.attachmentIdFactory?.() ?? randomUUID();
  const setTimer = this.options.setTimeout ?? setTimeout;
  const clearTimer = this.options.clearTimeout ?? clearTimeout;
  const deadlineController = new AbortController();
  const deadlineTimer = setTimer(() => deadlineController.abort(
    Object.assign(new Error('wait_deadline'), { code: 'wait_deadline' }),
  ), options.waitMs);
  const attachmentSignal = options.signal
    ? AbortSignal.any([options.signal, deadlineController.signal])
    : deadlineController.signal;
  let after = options.initial.eventSequence || 0;
  let last = options.initial;

  const detachLast = async (reason: string): Promise<BrainOperationResult> => {
    await this.detach(operationId, attachmentId, reason).catch(() => undefined);
    return { ...last, attachmentState: 'detached' };
  };
  const canonicalTerminal = async (status: BrainOperationRecord): Promise<BrainOperationResult> => {
    const payload = await this.getResult(operationId, options.signal?.aborted ? undefined : options.signal);
    return { ...status, ...payload, attachmentState: 'closed' } as BrainOperationResult;
  };
  const pauseBeforeReconnect = (): Promise<void> => new Promise((resolve, reject) => {
    const delayMs = Math.max(1, this.options.reconnectDelayMs ?? 250);
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      attachmentSignal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(attachmentSignal.reason));
    const timer = setTimer(() => finish(() => resolve()), delayMs);
    if (attachmentSignal.aborted) { onAbort(); return; }
    attachmentSignal.addEventListener('abort', onAbort, { once: true });
  });
  const statusOrDetach = async (
    reason: string,
    retainedAtLeast = after,
  ): Promise<BrainOperationResult | null> => {
    try {
      const priorCursor = after;
      const status = await this.getOperation(operationId, attachmentSignal);
      if (!Number.isSafeInteger(status.eventSequence)
          || status.eventSequence < retainedAtLeast
          || status.eventSequence < priorCursor) {
        return detachLast(reason === 'event_gap'
          ? 'operation_event_gap_invalid' : 'operation_status_regressed');
      }
      last = status;
      // Advance only after the bounded authenticated status read succeeds.
      after = status.eventSequence;
      if (TERMINAL.has(status.state)) return canonicalTerminal(status);
      // Repeated recoveries are allowed until the attachment deadline. If the
      // canonical cursor did not advance, an injected delay prevents immediate
      // EOF/error loops from consuming CPU forever.
      if (after === priorCursor) await pauseBeforeReconnect();
      return null;
    } catch {
      if (attachmentSignal.aborted) return handleAbort();
      return detachLast(reason);
    }
  };
  const handleAbort = async (): Promise<BrainOperationResult> => {
    try {
      const status = await this.getOperation(operationId);
      last = status;
      if (TERMINAL.has(status.state)) return canonicalTerminal(status);
    } catch {
      // The action below is still authoritative; detach/cancel endpoints perform their own CAS.
    }
    const reason = attachmentSignal.reason as { code?: string; message?: string } | undefined;
    const code = reason?.code || reason?.message || 'transport_disconnect';
    if (code === 'operator_stop' || !DURABLE_OPERATION_TYPES.has(options.operationType)) {
      const cancelled = await this.cancel(operationId);
      return canonicalTerminal(cancelled);
    }
    return detachLast(code === 'wait_deadline' ? 'wait_deadline' : 'transport_disconnect');
  };

  try {
    while (true) {
    if (attachmentSignal.aborted) return handleAbort();
    let response: Response;
    let gapRecovered = false;
    try {
      response = await this.requestResponse(
        `/home23/api/brain-operations/${encodeURIComponent(operationId)}/events?after=${after}&attachmentId=${encodeURIComponent(attachmentId)}`,
        {}, { code: 'operation_connect_timeout', timeoutMs: this.options.connectMs ?? 10_000, signal: attachmentSignal },
      );
      if (!response.ok) await this.throwHttpError(response, {
        code: 'operation_connect_timeout', timeoutMs: this.options.connectMs ?? 10_000,
        signal: attachmentSignal,
      });
    } catch (error) {
      if (attachmentSignal.aborted) return handleAbort();
      if ((error as { code?: string }).code === 'event_gap') {
        let gap: BrainOperationEventGap;
        try { gap = this.validateEventGapEnvelope(operationId, after, error); }
        catch { return detachLast('operation_event_gap_invalid'); }
        const terminalOrDetached = await statusOrDetach('event_gap', gap.latestSequence);
        if (terminalOrDetached) return terminalOrDetached;
        continue;
      }
      const typed = error as { code?: string; httpStatus?: number };
      const recoverable = !typed.httpStatus || typed.httpStatus >= 500
        || ['operation_connect_timeout', 'source_unavailable'].includes(typed.code || '');
      if (!recoverable) return detachLast(typed.code || 'event_transport_error');
      const terminalOrDetached = await statusOrDetach('connect_or_header_timeout');
      if (terminalOrDetached) return terminalOrDetached;
      continue;
    }

    try {
      if (!response.body) throw new Error('operation_event_body_missing');
      for await (const event of parseOperationEvents(response.body, operationId, after, {
        signal: attachmentSignal,
        inactivityMs: this.options.inactivityMs ?? 60_000,
        setTimeout: this.options.setTimeout,
        clearTimeout: this.options.clearTimeout,
      })) {
        if ('type' in event && event.type === 'event_gap') {
          const terminalOrDetached = await statusOrDetach('event_gap', event.latestSequence);
          if (terminalOrDetached) return terminalOrDetached;
          gapRecovered = true;
          await response.body.cancel('event_gap_reconnect').catch(() => undefined);
          break;
        }
        last = event;
        after = event.eventSequence;
        this.options.onActivity?.({
          source: 'brain_operation', operationId, sequence: after, state: event.state,
          phase: event.phase, updatedAt: event.updatedAt,
          lastProviderActivityAt: event.lastProviderActivityAt,
        });
        if (TERMINAL.has(event.state)) return canonicalTerminal(event);
      }
    } catch (error) {
      if (attachmentSignal.aborted) return handleAbort();
      const code = (error as { code?: string }).code;
      if (['operation_event_gap_invalid', 'operation_event_mismatch',
        'operation_event_out_of_order'].includes(code || (error as Error).message)) {
        return detachLast(code || (error as Error).message);
      }
      const terminalOrDetached = await statusOrDetach(
        code === 'operation_event_inactive' ? 'status_read_timeout' : 'event_transport_error',
      );
      if (terminalOrDetached) return terminalOrDetached;
      continue;
    }

    if (gapRecovered) continue;
    const terminalOrDetached = await statusOrDetach('event_eof');
    if (terminalOrDetached) return terminalOrDetached;
    continue;
    }
  } finally {
    clearTimer(deadlineTimer);
  }
}

async getOperation(operationId: string, signal?: AbortSignal): Promise<BrainOperationRecord> {
  return this.requestJson<BrainOperationRecord>(
    `/home23/api/brain-operations/${encodeURIComponent(operationId)}`, {},
    { code: 'status_timeout', timeoutMs: this.options.statusReadMs ?? 10_000, signal },
  );
}

async getResult(operationId: string, signal?: AbortSignal): Promise<BrainOperationResultEnvelope> {
  return this.requestJson<BrainOperationResultEnvelope>(
    `/home23/api/brain-operations/${encodeURIComponent(operationId)}/result`, {},
    { code: 'result_timeout', timeoutMs: this.options.resultReadMs ?? 10_000, signal },
  );
}

async resumeOperation(
  operationId: string,
  signal?: AbortSignal,
): Promise<BrainOperationResult> {
  const initial = await this.getOperation(operationId, signal);
  if (TERMINAL.has(initial.state)) {
    const payload = await this.getResult(operationId, signal);
    return { ...initial, ...payload, attachmentState: 'closed' };
  }
  const sixHour = new Set([
    'pgs', 'synthesis', 'research_compile', 'research_stop',
    'research_launch', 'research_continue', 'research_watch',
  ]).has(initial.operationType);
  const ninetyMinute = new Set(['query', 'graph_export', 'ad_hoc_export']).has(initial.operationType);
  const waitMs = sixHour
    ? (this.options.pgsWaitMs ?? 6 * 60 * 60_000)
    : ninetyMinute
      ? (this.options.queryWaitMs ?? 90 * 60_000)
      : (this.options.shortWaitMs ?? 5 * 60_000);
  return this.wait(operationId, { operationType: initial.operationType, waitMs, initial, signal });
}

async inspectOperation(
  operationId: string,
  action: 'status' | 'result' | 'cancel',
  signal?: AbortSignal,
): Promise<BrainOperationRecord | BrainOperationResultEnvelope> {
  if (!/^brop_[A-Za-z0-9_-]{32}$/.test(operationId)) throw new Error('operation_id_invalid');
  if (action === 'status') return this.getOperation(operationId, signal);
  if (action === 'result') return this.getResult(operationId, signal);
  const cancelled = await this.cancel(operationId, signal);
  return TERMINAL.has(cancelled.state) ? this.getResult(operationId, signal) : cancelled;
}

async detach(
  operationId: string,
  attachmentId: string,
  reason: string,
  signal?: AbortSignal,
): Promise<BrainOperationRecord> {
  return this.requestJson<BrainOperationRecord>(
    `/home23/api/brain-operations/${encodeURIComponent(operationId)}/detach`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attachmentId, reason }),
    }, { code: 'detach_timeout', timeoutMs: this.options.statusReadMs ?? 10_000, signal },
  );
}

async cancel(operationId: string, signal?: AbortSignal): Promise<BrainOperationRecord> {
  return this.requestJson<BrainOperationRecord>(
    `/home23/api/brain-operations/${encodeURIComponent(operationId)}/cancel`, { method: 'POST' },
    { code: 'cancel_timeout', timeoutMs: this.options.statusReadMs ?? 10_000, signal },
  );
}

async exportResult(
  request: { operationId: string; resultHandle?: string; format: string; metadata?: Record<string, unknown> },
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if ('answer' in request || !request.operationId) throw new Error('canonical_export_requires_operation_id');
  const { operationId, resultHandle: _descriptiveOnly, ...exportOptions } = request;
  return this.requestJson<Record<string, unknown>>(
    `/home23/api/brain-operations/${encodeURIComponent(operationId)}/export`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(exportOptions),
    }, { code: 'export_timeout', timeoutMs: this.options.resultReadMs ?? 10_000, signal },
  );
}

private async requestResponse(
  pathname: string,
  init: RequestInit,
  deadline: { code: string; timeoutMs: number; signal?: AbortSignal },
): Promise<Response> {
  const response = await this.withDeadline(deadline, (signal) => this.fetchImpl(
    `${this.options.baseUrl}${pathname}`, { ...init, signal },
  ));
  return response;
}

private async requestJson<T>(
  pathname: string,
  init: RequestInit,
  deadline: { code: string; timeoutMs: number; signal?: AbortSignal },
): Promise<T> {
  const response = await this.requestResponse(pathname, init, deadline);
  if (!response.ok) await this.throwHttpError(response, deadline);
  let text: string;
  try {
    text = await this.withDeadline(deadline, () => response.text());
  } catch (error) {
    await response.body?.cancel(error).catch(() => undefined);
    throw error;
  }
  const body = text ? JSON.parse(text) as T & { success?: boolean;
    error?: { code?: string; message?: string; retryable?: boolean } } : null;
  if (!body || body.success === false || ('error' in body && body.error && !(body as BrainOperationRecord).operationId)) {
    throw Object.assign(new Error(body?.error?.message || 'brain_operation_error'), {
      code: body?.error?.code || 'brain_operation_error',
      retryable: body?.error?.retryable === true,
    });
  }
  return body;
}

private async throwHttpError(
  response: Response,
  deadline: { code: string; timeoutMs: number; signal?: AbortSignal },
): Promise<never> {
  let text: string;
  try {
    text = await this.withDeadline({ ...deadline, code: 'error_body_timeout' }, async (signal) => {
      if (!response.body) return '';
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const cancelBlockedRead = () => { void reader.cancel(signal.reason).catch(() => undefined); };
      signal.addEventListener('abort', cancelBlockedRead, { once: true });
      try {
        while (true) {
          if (signal.aborted) throw signal.reason;
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > (this.options.maxErrorBodyBytes ?? MAX_ERROR_BODY_BYTES)) {
            await reader.cancel('error_body_too_large').catch(() => undefined);
            throw Object.assign(new Error('error_body_too_large'), {
              code: 'error_body_too_large', httpStatus: response.status,
            });
          }
          chunks.push(value);
        }
        return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
      } finally {
        signal.removeEventListener('abort', cancelBlockedRead);
        reader.releaseLock();
      }
    });
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      code: (error as { code?: string }).code || 'error_body_timeout',
      httpStatus: response.status,
      retryable: response.status >= 500,
    });
  }
  let envelope: { error?: { code?: unknown; message?: unknown; retryable?: unknown; details?: unknown } } = {};
  try { envelope = text ? JSON.parse(text) : {}; } catch { /* bounded fallback below */ }
  const error = envelope.error;
  const code = typeof error?.code === 'string' && error.code
    ? error.code : response.status === 404 ? 'route_not_found' : 'source_unavailable';
  const message = typeof error?.message === 'string' && error.message
    ? error.message : `HTTP ${response.status}${text ? `: ${text.slice(0, 512)}` : ''}`;
  throw Object.assign(new Error(message), {
    code, httpStatus: response.status,
    retryable: typeof error?.retryable === 'boolean' ? error.retryable : response.status >= 500,
    details: error?.details,
  });
}

private validateEventGapEnvelope(
  operationId: string,
  after: number,
  input: BrainOperationEventGap | { details?: unknown },
): BrainOperationEventGap {
  const raw = ('type' in input ? input : input.details) as Partial<BrainOperationEventGap> | undefined;
  const gap = raw?.type === 'event_gap'
    ? raw : ({ ...raw, type: 'event_gap' } as Partial<BrainOperationEventGap>);
  if (gap.operationId !== operationId
      || !Number.isSafeInteger(gap.oldestSequence)
      || !Number.isSafeInteger(gap.latestSequence)
      || Number(gap.oldestSequence) <= after
      || Number(gap.oldestSequence) > Number(gap.latestSequence)
      || gap.currentStatus?.operationId !== operationId
      || !Number.isSafeInteger(gap.currentStatus.eventSequence)
      || gap.currentStatus.eventSequence < Number(gap.latestSequence)) {
    throw Object.assign(new Error('operation_event_gap_invalid'), { code: 'operation_event_gap_invalid' });
  }
  return gap as BrainOperationEventGap;
}

private withDeadline<T>(
  deadline: { code: string; timeoutMs: number; signal?: AbortSignal },
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const setTimer = this.options.setTimeout ?? setTimeout;
  const clearTimer = this.options.clearTimeout ?? clearTimeout;
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      deadline.signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => {
      const reason = deadline.signal?.reason ?? Object.assign(new Error('aborted'), { code: 'aborted' });
      controller.abort(reason);
      finish(() => reject(reason));
    };
    const timer = setTimer(() => {
      const error = Object.assign(new Error(deadline.code), { code: deadline.code });
      controller.abort(error);
      finish(() => reject(error));
    }, deadline.timeoutMs);
    if (deadline.signal?.aborted) { onAbort(); return; }
    deadline.signal?.addEventListener('abort', onAbort, { once: true });
    run(controller.signal).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}
```

Define `validateEventGap()` as the one validator used by both parser and HTTP recovery; it applies the exact monotonic/range checks in Step 6 and never calls `onActivity`. Define the operation-ID grammar from Plan A's shared contract rather than hard-coding a second incompatible regular expression if Plan A exports one.

The code preserves omitted targets, never sends authority fields, retries a lost start response at most once with a byte-identical body/request ID **before** any catalog refresh, performs bounded inactivity/gap reconnects, enforces the attachment deadline even while a stream read is blocked, reuses one attachment ID, and always reloads terminal bytes from the protected result route. Non-2xx bodies are streamed through `MAX_ERROR_BODY_BYTES`; bounded typed `{error:{code,message,retryable,details}}` fields survive intact, while oversized/malformed bodies cannot consume unbounded memory. Add deterministic client tests for the 30-second positive-catalog TTL, no caching of an empty catalog, own and explicit refresh, `target_mismatch` versus `target_not_available` versus `target_not_found`, one route-404 refresh, and the coordinator's independent target re-resolution. Parsed HTTP/application failures other than the named route/target refresh conditions are never start-retried. Add a fake-clock `shortWaitMs` test proving a short operation cancels at its smaller bound while the query/PGS defaults remain 90 minutes/six hours. Add status/result/cancel/resume tests proving an operation detached at a caller wait deadline remains actionable by the same requester, another requester is denied by the server, resume uses a new attachment without a second start, cancel is explicit, and terminal result always comes from the protected result route.

- [ ] **Step 9: Wire additive ToolContext fields**

Modify `src/agent/types.ts`:

```ts
import type { BrainOperationsClient } from './brain-operations/client.js';
import type { OperationActivity } from './brain-operations/types.js';

export interface ToolResult {
  content: string;
  media?: MediaAttachment[];
  is_error?: boolean;
  resultHandle?: string;
  metadata?: Record<string, unknown>;
}

export interface TurnRuntimeContext {
  turnId: string;
  abortController: AbortController;
  signal: AbortSignal;
  brainOperations: BrainOperationsClient;
  onOperationActivity: (activity: OperationActivity) => void;
}

export interface ToolContext {
  scheduler: CronScheduler | null;
  ttsService: TTSService | null;
  browser: BrowserController | null;
  projectRoot: string;
  enginePort: number;
  agentName: string;
  cosmo23BaseUrl: string;
  brainRoute: string | null;
  workspacePath: string;
  tempDir: string;
  contextManager: ContextManagerRef;
  subAgentTracker: SubAgentTracker;
  chatId: string;
  telegramAdapter: TelegramAdapterRef | null;
  runAgentLoop: AgentLoopRunner | null;
  workerConnectorBaseUrl?: string;
  fetch?: typeof fetch;
  onEvent?: AgentEventCallback;
  conversationHistory?: { append(chatId: string, records: unknown[]): void };
  abortSignal?: AbortSignal;
  brainOperations: BrainOperationsClient;
  onOperationActivity?: (activity: OperationActivity) => void;
  turnRuntime: TurnRuntimeContext | null;
}
```

Keep `brainRoute` and `abortSignal` temporarily as deprecated compatibility fields until their old consumers are removed; do not let new code read them. Tool execution during a turn requires nonnull `turnRuntime`, and tools use `ctx.turnRuntime.signal` plus `ctx.turnRuntime.brainOperations`. The startup/base context has `turnRuntime:null`; it is never mutated in place to represent a turn.

- [ ] **Step 10: Construct the shared client in `src/home.ts`**

Import `BrainOperationsClient`, construct it against the requester dashboard, and add it to `toolContext`:

```ts
import { BrainOperationsClient } from './agent/brain-operations/client.js';

const brainOperations = new BrainOperationsClient({
  baseUrl: `http://127.0.0.1:${DASHBOARD_PORT}`,
  callerAgent: agentName,
});

const toolContext: ToolContext = {
  scheduler: null,
  ttsService,
  browser,
  projectRoot: PROJECT_ROOT,
  enginePort: DASHBOARD_PORT,
  agentName,
  cosmo23BaseUrl,
  brainRoute,
  workspacePath,
  tempDir,
  contextManager,
  subAgentTracker,
  chatId: '',
  telegramAdapter: null,
  runAgentLoop: null,
  brainOperations,
  turnRuntime: null,
};
```

The dashboard port is requester-bound, so the harness does not send a requester identity. Leave the old startup `resolveBrainRoute()` call in place only until Task 4 removes the last compatibility consumer.

- [ ] **Step 11: Run focused client tests and TypeScript build**

Run:

```bash
node --import tsx --test --test-concurrency=1 tests/agent/brain-operations-client.test.ts
node --test --test-concurrency=1 tests/engine/dashboard/brain-operation-routes.test.js
npm run build
```

Expected: all client tests PASS; TypeScript build PASS.

- [ ] **Step 12: Commit only the shared-client paths**

```bash
git diff --cached --quiet
git add -- src/agent/brain-operations/types.ts src/agent/brain-operations/sse.ts src/agent/brain-operations/input-validation.ts src/agent/brain-operations/client.ts src/agent/types.ts src/home.ts tests/helpers/manual-clock.ts tests/helpers/brain-operation-record.ts tests/agent/brain-operations-client.test.ts tests/engine/dashboard/brain-operation-routes.test.js
git diff --cached --check
git diff --cached -- src/agent/brain-operations/types.ts src/agent/brain-operations/sse.ts src/agent/brain-operations/input-validation.ts src/agent/brain-operations/client.ts src/agent/types.ts src/home.ts tests/helpers/manual-clock.ts tests/helpers/brain-operation-record.ts tests/agent/brain-operations-client.test.ts tests/engine/dashboard/brain-operation-routes.test.js
git commit --only src/agent/brain-operations/types.ts src/agent/brain-operations/sse.ts src/agent/brain-operations/input-validation.ts src/agent/brain-operations/client.ts src/agent/types.ts src/home.ts tests/helpers/manual-clock.ts tests/helpers/brain-operation-record.ts tests/agent/brain-operations-client.test.ts tests/engine/dashboard/brain-operation-routes.test.js -m "feat: add shared brain operations client"
```

---

### Task 2: Add Activity-Leased Turns and One Common Entrypoint

**Files:**
- Create: `src/agent/activity-lease.ts`
- Create: `src/agent/turn-entrypoint.ts`
- Create: `src/agent/cron-brain-query.ts`
- Create: `tests/agent/turn-activity-lease.test.ts`
- Create: `tests/agent/turn-entrypoints.test.ts`
- Create: `tests/agent/turn-entrypoint-callers.test.ts`
- Modify: `src/agent/loop.ts:29-34, 604-738, 1044-1052`
- Modify: `src/home.ts:298-326, 411-414, 480-524, 681-740`
- Modify: `src/agent/tools/cron.ts`
- Modify: `src/agents/system-prompt.ts`
- Modify: `src/routes/evobrew-bridge.ts:147-224`
- Modify: `src/agent/tools/subagent.ts:23-106`
- Modify: `src/workers/runner.ts:190-235`
- Modify: `tests/agent/chat-turn-janitor-timeout.test.ts:82-119`
- Modify: `tests/agent/evobrew-bridge.test.ts:6-13, 37-119`
- Modify: `tests/agent/tools/cron.test.ts`

**Interfaces:**
- Consumes: `OperationActivity` and `ToolContext.onOperationActivity` from Task 1.
- Produces: `ActivityLease.observe()`, `ActivityLease.close()`, and `executeTrackedTurn()` used by all interactive/background agent entrypoints, plus `runCronBrainQuery()` for one durable scheduled query with exact model binding and truthful terminal rendering.

- [ ] **Step 1: Write failing deterministic lease tests**

Create `tests/agent/turn-activity-lease.test.ts` with an injected manual scheduler:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityLease } from '../../src/agent/activity-lease.js';

class ManualClock {
  nowMs = 0;
  tasks = new Map<number, { at: number; fn: () => void }>();
  nextId = 1;
  now = (): number => this.nowMs;
  setTimeout = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.nowMs + ms, fn });
    return id;
  };
  clearTimeout = (id: number): void => { this.tasks.delete(id); };
  advance(ms: number): void {
    this.nowMs += ms;
    const due = [...this.tasks.entries()].filter(([, task]) => task.at <= this.nowMs);
    for (const [id, task] of due) { this.tasks.delete(id); task.fn(); }
  }
}

test('monotonic brain-operation activity renews inactivity without moving the hard deadline', () => {
  const clock = new ManualClock();
  const expirations: string[] = [];
  const lease = new ActivityLease({
    inactivityMs: 15,
    hardDurationMs: 60,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onExpire: (reason) => expirations.push(reason),
  });
  lease.start();
  clock.advance(10);
  assert.equal(lease.observe({ operationId: 'op-1', sequence: 1 }), true);
  clock.advance(10);
  assert.equal(expirations.length, 0);
  assert.equal(lease.observe({ operationId: 'op-1', sequence: 2 }), true);
  clock.advance(39);
  assert.deepEqual(expirations, ['inactivity_timeout']);
});

test('duplicate or regressed operation sequence cannot renew the lease', () => {
  const clock = new ManualClock();
  const expirations: string[] = [];
  const lease = new ActivityLease({ inactivityMs: 10, hardDurationMs: 100,
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    onExpire: (reason) => expirations.push(reason) });
  lease.start();
  assert.equal(lease.observe({ operationId: 'op-1', sequence: 2 }), true);
  clock.advance(8);
  assert.equal(lease.observe({ operationId: 'op-1', sequence: 2 }), false);
  clock.advance(3);
  assert.deepEqual(expirations, ['inactivity_timeout']);
});

test('verified activity never moves the immutable hard deadline', () => {
  const clock = new ManualClock();
  const expirations: string[] = [];
  const lease = new ActivityLease({ inactivityMs: 10, hardDurationMs: 30,
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    onExpire: (reason) => expirations.push(reason) });
  lease.start();
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    clock.advance(8);
    assert.equal(lease.observe({ operationId: 'op-hard', sequence }), true);
  }
  clock.advance(6);
  assert.deepEqual(expirations, ['hard_timeout']);
});
```

- [ ] **Step 2: Run the lease test and verify RED**

```bash
node --import tsx --test --test-concurrency=1 tests/agent/turn-activity-lease.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `activity-lease.js`.

- [ ] **Step 3: Implement ActivityLease**

Create `src/agent/activity-lease.ts`:

```ts
export type LeaseExpiryReason = 'inactivity_timeout' | 'hard_timeout';

export class ActivityLease {
  private inactivityTimer: unknown;
  private hardTimer: unknown;
  private closed = false;
  private readonly lastSequence = new Map<string, number>();

  constructor(private readonly options: {
    inactivityMs: number;
    hardDurationMs: number;
    now: () => number;
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (id: unknown) => void;
    onExpire: (reason: LeaseExpiryReason) => void;
  }) {}

  start(): void {
    this.armInactivity();
    this.hardTimer = this.options.setTimeout(() => this.expire('hard_timeout'), this.options.hardDurationMs);
  }

  observe(activity: { operationId: string; sequence: number }): boolean {
    if (this.closed || !Number.isInteger(activity.sequence)) return false;
    const previous = this.lastSequence.get(activity.operationId) ?? 0;
    if (activity.sequence <= previous) return false;
    this.lastSequence.set(activity.operationId, activity.sequence);
    this.armInactivity();
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.inactivityTimer !== undefined) this.options.clearTimeout(this.inactivityTimer);
    if (this.hardTimer !== undefined) this.options.clearTimeout(this.hardTimer);
  }

  private armInactivity(): void {
    if (this.inactivityTimer !== undefined) this.options.clearTimeout(this.inactivityTimer);
    this.inactivityTimer = this.options.setTimeout(() => this.expire('inactivity_timeout'), this.options.inactivityMs);
  }

  private expire(reason: LeaseExpiryReason): void {
    if (this.closed) return;
    this.close();
    this.options.onExpire(reason);
  }
}
```

- [ ] **Step 4: Run lease tests and verify GREEN**

```bash
node --import tsx --test --test-concurrency=1 tests/agent/turn-activity-lease.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Write failing common-entrypoint tests**

Create `tests/agent/turn-entrypoints.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTrackedTurn } from '../../src/agent/turn-entrypoint.js';

test('executeTrackedTurn awaits the runWithTurn response and never calls raw run', async () => {
  let rawRunCalls = 0;
  const agent = {
    run: async () => { rawRunCalls += 1; throw new Error('raw run forbidden'); },
    runWithTurn: async () => ({
      turnId: 'turn-1',
      response: Promise.resolve({ text: 'done', model: 'test', toolCallCount: 0, durationMs: 1 }),
    }),
  };
  const result = await executeTrackedTurn(agent as never, 'chat-1', 'hello');
  assert.equal(result.turnId, 'turn-1');
  assert.equal(result.response.text, 'done');
  assert.equal(rawRunCalls, 0);
});
```

Update `tests/agent/evobrew-bridge.test.ts` so `makeFakeAgent()` exposes `runWithTurn` but deliberately throws from `run`; assert the bridge still completes and forwards its `onEvent` callback.

Before production edits, add `tests/agent/turn-entrypoint-callers.test.ts`. Read `src/home.ts`, `src/routes/evobrew-bridge.ts`, `src/agent/tools/subagent.ts`, and `src/workers/runner.ts`; assert the main message, cron agent turn, Evobrew, subagent, and worker paths either call `executeTrackedTurn` or use the injected `ctx.runAgentLoop`, and reject raw `agent.run()`/independent `Promise.race` watchdogs at those call sites. For the cron `payload.kind === 'query'` branch, require `runCronBrainQuery(brainOperations, ...)` and reject the legacy `queryEngine()`/`/api/query` path.

Extend `tests/agent/tools/cron.test.ts` before production edits. Use an injected `BrainOperationsClient.query` seam to prove one scheduled invocation starts at most one durable operation; the default mode is `quick`; a named model alias becomes its exact `{provider,model}` `modelSelection`; complete answers render directly; a detached queued/running result retains the exact operation ID and reattachment instruction without claiming failure or starting a duplicate; a useful partial requires both answer and typed error; failed/cancelled/expired results throw their typed authority; invalid mode or alias fails before dispatch; and cron tool/system-prompt descriptions advertise durable no-tools queries with the 5,400-second ordinary attachment default rather than the legacy 120-second cutoff. Also add the fake-clock operation-activity regression described in Step 10 to `tests/agent/chat-turn-janitor-timeout.test.ts` now, before changing `runWithTurn`.

- [ ] **Step 6: Run entrypoint tests and verify RED**

```bash
node --import tsx --test --test-concurrency=1 \
  tests/agent/turn-entrypoints.test.ts \
  tests/agent/turn-entrypoint-callers.test.ts \
  tests/agent/chat-turn-janitor-timeout.test.ts \
  tests/agent/evobrew-bridge.test.ts \
  tests/agent/tools/cron.test.ts \
  tests/workers/runner.test.ts
```

Expected: the new entrypoint test fails with missing `turn-entrypoint.js`; Evobrew fails because the bridge calls raw `run()`; cron fails because `cron-brain-query.js` is missing and the query branch still uses the legacy 120-second `queryEngine()` path.

- [ ] **Step 7: Implement the tracked entrypoint wrapper**

Create `src/agent/turn-entrypoint.ts`:

```ts
import type { AgentLoop } from './loop.js';
import type { AgentEventCallback, AgentResponse } from './types.js';
import type { MediaAttachment } from '../types.js';

export async function executeTrackedTurn(
  agent: Pick<AgentLoop, 'runWithTurn'>,
  chatId: string,
  userText: string,
  options: {
    media?: MediaAttachment[];
    onEvent?: AgentEventCallback;
    inactivityMs?: number;
    hardDurationMs?: number;
  } = {},
): Promise<{ turnId: string; response: AgentResponse }> {
  const started = await agent.runWithTurn(chatId, userText, {
    media: options.media,
    onEvent: options.onEvent,
    inactivityMs: options.inactivityMs,
    hardDurationMs: options.hardDurationMs,
  });
  return { turnId: started.turnId, response: await started.response };
}
```

- [ ] **Step 8: Replace the fixed runWithTurn wall watchdog with ActivityLease**

In `src/agent/loop.ts`, extend `runWithTurn` options without breaking `maxDurationMs` callers:

```ts
opts: {
  turnId?: string;
  media?: MediaAttachment[];
  onEvent?: AgentEventCallback;
  modelOverride?: { model: string; provider?: string };
  inactivityMs?: number;
  hardDurationMs?: number;
  maxDurationMs?: number; // compatibility alias for inactivityMs
  firstTokenTimeoutMs?: number;
}
```

Use numeric defaults `inactivityMs = opts.inactivityMs ?? opts.maxDurationMs ?? 15 * 60 * 1000` and `hardDurationMs = opts.hardDurationMs ?? 8 * 60 * 60 * 1000`. Construct `ActivityLease` before calling `run()`. Build the per-run callback and client before `runContext`:

```ts
const onOperationActivity = (activity: OperationActivity): void => {
  if (lease.observe(activity)) {
    persistAndFanOut({
      type: 'status',
      status: 'brain_operation_active',
      message: `${activity.operationId} ${activity.state} ${activity.phase || ''}`.trim(),
    });
  }
};
const runBrainOperations = this.toolContext.brainOperations.withActivityHandler(onOperationActivity);
const turnRuntime: TurnRuntimeContext = {
  turnId,
  abortController: ac,
  signal: ac.signal,
  brainOperations: runBrainOperations,
  onOperationActivity,
};
const runContext: ToolContext = {
  ...this.toolContext,
  chatId,
  onEvent,
  conversationHistory: this.history,
  abortSignal: ac.signal,
  onOperationActivity,
  brainOperations: runBrainOperations,
  turnRuntime,
};
```

This per-run client sends verified events to the current turn rather than a startup-global callback. `abortController`, signal, activity handler, and bound client are allocated once per `runWithTurn` and passed as one immutable runtime object to context assembly and every registry execution. They are never stored back onto `this.toolContext`. Add a concurrent-two-turn test that captures both registry contexts, proves distinct controllers/signals/client instances and turn IDs, routes each operation activity only to its own lease, aborts one without aborting the other, and observes `this.toolContext.turnRuntime === null` throughout. Add a timeout test proving the exact captured controller is aborted and the provider/tool sees its signal. The source-level entrypoint check is not a substitute for these behavioral assertions.

On inactivity expiry, set the existing terminal override to `turn_timeout` and abort the agent run; on hard expiry, use `turn_hard_timeout`. Close the lease in `finally`. Keep first-token diagnostics independent.

- [ ] **Step 9: Migrate every raw entrypoint**

Use `executeTrackedTurn()` at these call sites:

```ts
// src/home.ts main message handler
const { response: result } = await executeTrackedTurn(agent, message.chatId, text, { media: message.media });

// src/home.ts subagent/worker wiring
toolContext.runAgentLoop = async (_systemPrompt, userMessage, _tools, ctx) =>
  (await executeTrackedTurn(agent, ctx.chatId, userMessage)).response;

// src/home.ts cron agentTurn
const { response: result } = await executeTrackedTurn(agent, cronChatId, resolvedMessage, {
  hardDurationMs: (job.payload.timeoutSeconds ?? 21_600) * 1000,
});

// src/home.ts cron query: one durable coordinator operation, never legacy queryEngine()/api/query
const querySignal = AbortSignal.timeout((job.payload.timeoutSeconds ?? 5_400) * 1000);
const result = await runCronBrainQuery(brainOperations, job.payload, MODEL_ALIASES, querySignal);

// src/routes/evobrew-bridge.ts
const { response: result } = await executeTrackedTurn(config.agent, chatId, enrichedMessage, { onEvent });
```

Delete the cron-agent-turn-specific `Promise.race` timeout and its separate `agent.stop()` path. Keep explicit job timeout as the common hard deadline. Replace the cron query branch's direct `queryEngine()`/legacy `/api/query` request and 120-second default with `runCronBrainQuery()`, a default 5,400-second attachment signal, and the exact `MODEL_ALIASES` provider/model pair. The helper starts at most one durable operation and preserves the returned operation ID/state through complete, detached, partial, and typed-failure rendering. Update `cron_schedule` and system-prompt descriptions so agents do not expect a lightweight 120-second query. `src/agent/tools/subagent.ts` and `src/workers/runner.ts` continue using `ctx.runAgentLoop`, which is now backed by the tracked helper.

- [ ] **Step 10: Confirm the prewritten call-site and runWithTurn regressions are now green**

Do not add tests after the production migration. Re-run the Step 5 tests that were already RED: the chat-turn fake-clock case injects operation activities through the captured `run()` event context, advances beyond 15 minutes, proves the turn remains pending until activity stops, and asserts `activity_deadline_at`, `hard_deadline_at`, and the correct timeout code. The caller test must now prove every named entrypoint converged and the cron query branch no longer calls `queryEngine`; the cron tests must prove exact alias binding, 5,400-second guidance, and honest complete/detached/partial/failed outcomes.

- [ ] **Step 11: Run all turn/entrypoint tests and build**

```bash
node --import tsx --test --test-concurrency=1 \
  tests/agent/turn-activity-lease.test.ts \
  tests/agent/turn-entrypoints.test.ts \
  tests/agent/turn-entrypoint-callers.test.ts \
  tests/agent/chat-turn-janitor-timeout.test.ts \
  tests/agent/evobrew-bridge.test.ts \
  tests/agent/tools/cron.test.ts \
  tests/workers/runner.test.ts
npm run build
```

Expected: all focused tests PASS; build PASS.

- [ ] **Step 12: Commit only turn-lifecycle paths**

```bash
git diff --cached --quiet
git add -- src/agent/activity-lease.ts src/agent/turn-entrypoint.ts src/agent/cron-brain-query.ts src/agent/loop.ts src/home.ts src/agent/tools/cron.ts src/agents/system-prompt.ts src/routes/evobrew-bridge.ts src/agent/tools/subagent.ts src/workers/runner.ts tests/agent/turn-activity-lease.test.ts tests/agent/turn-entrypoints.test.ts tests/agent/turn-entrypoint-callers.test.ts tests/agent/chat-turn-janitor-timeout.test.ts tests/agent/evobrew-bridge.test.ts tests/agent/tools/cron.test.ts
git diff --cached --check
git diff --cached -- src/agent/activity-lease.ts src/agent/turn-entrypoint.ts src/agent/cron-brain-query.ts src/agent/loop.ts src/home.ts src/agent/tools/cron.ts src/agents/system-prompt.ts src/routes/evobrew-bridge.ts src/agent/tools/subagent.ts src/workers/runner.ts tests/agent/turn-activity-lease.test.ts tests/agent/turn-entrypoints.test.ts tests/agent/turn-entrypoint-callers.test.ts tests/agent/chat-turn-janitor-timeout.test.ts tests/agent/evobrew-bridge.test.ts tests/agent/tools/cron.test.ts
git commit --only src/agent/activity-lease.ts src/agent/turn-entrypoint.ts src/agent/cron-brain-query.ts src/agent/loop.ts src/home.ts src/agent/tools/cron.ts src/agents/system-prompt.ts src/routes/evobrew-bridge.ts src/agent/tools/subagent.ts src/workers/runner.ts tests/agent/turn-activity-lease.test.ts tests/agent/turn-entrypoints.test.ts tests/agent/turn-entrypoint-callers.test.ts tests/agent/chat-turn-janitor-timeout.test.ts tests/agent/evobrew-bridge.test.ts tests/agent/tools/cron.test.ts -m "fix: route scheduled brain queries through durable operations"
```

---

### Task 3: Centralize Truthful Tool Results and Explicit Truncation

**Files:**
- Create: `src/agent/tool-result.ts`
- Create: `tests/agent/tool-result.test.ts`
- Create: `tests/agent/tool-result-provider-branches.test.ts`
- Modify: `src/agent/loop.ts:31-32, 1320-1337, 1516-1527, 1733-1750, 1864-1913`

**Interfaces:**
- Consumes: additive `ToolResult.resultHandle` and `ToolResult.metadata` from Task 1.
- Produces: `executeAndFormatTool()` returning truthful model/event renderings used by every provider branch.

- [ ] **Step 1: Write failing result-honesty tests**

Create `tests/agent/tool-result.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeAndFormatTool } from '../../src/agent/tool-result.js';

test('is_error always produces an unsuccessful tool event', async () => {
  const events: Array<Record<string, unknown>> = [];
  const registry = { execute: async () => ({ content: 'provider failed', is_error: true }) };
  const rendered = await executeAndFormatTool({
    registry: registry as never, name: 'brain_query', input: {}, context: {} as never,
    onEvent: (event) => events.push(event as unknown as Record<string, unknown>),
    modelLimit: 4000, eventLimit: 4000,
  });
  assert.equal(rendered.success, false);
  assert.equal(rendered.result.is_error, true);
  assert.equal(events[0]?.success, false);
});

test('shortened brain output names truncation and the full result handle', async () => {
  const registry = { execute: async () => ({
    content: 'x'.repeat(1000), resultHandle: 'brres_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    metadata: { operationId: 'op-42' },
  }) };
  const rendered = await executeAndFormatTool({
    registry: registry as never, name: 'brain_query', input: {}, context: {} as never,
    modelLimit: 160, eventLimit: 180,
  });
  assert.match(rendered.modelContent, /OUTPUT TRUNCATED/);
  assert.match(rendered.modelContent, /brres_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
  assert.equal(rendered.modelContent.length, 160);
  assert.equal(rendered.eventContent.length, 180);
  assert.equal(rendered.success, true);
});

test('display limits are strict finite safe integers and too-small recoverable markers fail closed', async () => {
  const registry = { execute: async () => ({ content: '😀'.repeat(200),
    resultHandle: 'brres_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', metadata: { operationId: 'op-limit' } }) };
  for (const value of [NaN, Infinity, 1.5, -1, 20]) {
    await assert.rejects(executeAndFormatTool({ registry: registry as never, name: 'brain_query',
      input: {}, context: {} as never, onEvent: () => {}, modelLimit: value, eventLimit: 180 }),
    /display_limit_invalid|recoverable_marker_too_large/);
  }
  const rendered = await executeAndFormatTool({ registry: registry as never, name: 'brain_query',
    input: {}, context: {} as never, onEvent: () => {}, modelLimit: 160, eventLimit: 180 });
  assert.equal(rendered.modelContent.length, 160);
  assert.equal(rendered.eventContent.length, 180);
  assert.match(rendered.modelContent, /OUTPUT TRUNCATED/);
  assert.match(rendered.eventContent, /op-limit/);
  assert.equal(/\uD83D$/.test(rendered.modelContent), false);
});
```

- [ ] **Step 2: Run and verify RED**

```bash
node --import tsx --test --test-concurrency=1 tests/agent/tool-result.test.ts
```

Expected: FAIL with missing `tool-result.js`.

- [ ] **Step 3: Implement the central adapter**

Create `src/agent/tool-result.ts`:

```ts
import type { BrainOperationResult } from './brain-operations/types.js';
import type { ToolRegistry } from './tools/index.js';
import type { AgentEventCallback, ToolContext, ToolResult } from './types.js';

export function recoverableExcerpt(
  content: string,
  limit: number,
  reference: { resultHandle?: string | null; operationId?: string | null },
): string {
  if (!Number.isSafeInteger(limit) || limit < 128) throw new Error('tool_display_limit_invalid');
  if (content.length <= limit) return content;
  const locator = [reference.resultHandle ? `handle=${reference.resultHandle}` : null,
    reference.operationId ? `operation=${reference.operationId}` : null]
    .filter(Boolean).join(' ') || 'no durable reference';
  const marker = `\n\n[OUTPUT TRUNCATED; full result: ${locator}]`;
  if (marker.length > limit) throw new Error('tool_display_limit_too_small_for_reference');
  const prefixLength = limit - marker.length;
  let prefix = content.slice(0, prefixLength);
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = `${prefix.slice(0, -1)}…`;
  return `${prefix}${marker}`;
}

function isTypedTerminalError(error: BrainOperationResult['error']): boolean {
  return Boolean(error && typeof error.code === 'string' && error.code.trim()
    && typeof error.message === 'string' && error.message.trim()
    && typeof error.retryable === 'boolean');
}

export function operationToolResult(operation: BrainOperationResult): ToolResult {
  const answer = typeof operation.result?.answer === 'string' ? operation.result.answer : '';
  const sweepOutputs = Array.isArray(operation.result?.sweepOutputs)
    ? operation.result.sweepOutputs as Array<Record<string, unknown>> : [];
  const pgs = operation.result?.metadata && typeof operation.result.metadata === 'object'
    ? (operation.result.metadata as { pgs?: Record<string, unknown> }).pgs : undefined;
  const successfulSweeps = pgs?.successfulSweeps;
  const retryablePartitions = pgs?.retryablePartitions;
  const validSweep = (sweep: Record<string, unknown>) =>
    Object.keys(sweep).sort().join(',') === 'model,output,partitionId,provider,workUnitId'
    && ['workUnitId','partitionId','output','provider','model'].every((key) =>
      typeof sweep[key] === 'string' && Boolean((sweep[key] as string).trim()));
  const validRetryable = Array.isArray(retryablePartitions)
    && retryablePartitions.every((value) => typeof value === 'string' && Boolean(value.trim()))
    && new Set(retryablePartitions).size === retryablePartitions.length
    && retryablePartitions.every((value, index) => index === 0 || retryablePartitions[index - 1] < value);
  const typedPartialError = isTypedTerminalError(operation.error);
  const isPgsPartial = operation.state === 'partial' && operation.operationType === 'pgs';
  const isQueryPartial = operation.state === 'partial' && operation.operationType === 'query';
  const usefulPgsPartial = isPgsPartial && sweepOutputs.length > 0
    && typeof successfulSweeps === 'number' && Number.isSafeInteger(successfulSweeps)
    && successfulSweeps >= 0 && successfulSweeps === sweepOutputs.length
    && sweepOutputs.every(validSweep) && validRetryable && typedPartialError;
  const usefulQueryPartial = isQueryPartial && Boolean(answer.trim()) && typedPartialError;
  const usefulPartial = usefulPgsPartial || usefulQueryPartial;
  const invalidPartial = operation.state === 'partial' && !usefulPartial;
  const useful = answer.trim() || (sweepOutputs.length
    ? sweepOutputs.map((sweep, index) => `Sweep ${index + 1}: ${String(sweep.output || '')}`).join('\n')
    : JSON.stringify(operation.result || {}));
  const stateLine = `operation=${operation.operationId} state=${operation.state}`;
  const errorLine = operation.error
    ? `\n${operation.error.code}: ${operation.error.message} (retryable=${operation.error.retryable})` : '';
  if (operation.state === 'failed' || operation.state === 'cancelled' || operation.state === 'interrupted') {
    return { content: `${stateLine}\n${operation.error?.code || 'operation_failed'}: ${operation.error?.message || 'No result'}`,
      is_error: true, resultHandle: operation.resultHandle || undefined,
      metadata: { operationId: operation.operationId, state: operation.state,
        classification: operation.operationType === 'pgs' ? 'all_failed' : operation.state,
        pgs, sweepOutputs, error: operation.error,
        resultArtifact: operation.resultArtifact, sourceEvidence: operation.sourceEvidence } };
  }
  const detachedGuidance = operation.attachmentState === 'detached' && operation.state === 'running'
    ? `\nDetached from wait; the durable operation is still running. Resume with brain_status {action:"wait",operationId:"${operation.operationId}"}.`
    : '';
  return { content: `${invalidPartial ? 'invalid_partial_result: malformed partial payload' : useful}`
      + `${invalidPartial ? '' : errorLine}\n\n---\n[${stateLine}]${detachedGuidance}`,
    is_error: invalidPartial ? true : undefined,
    resultHandle: operation.resultHandle || undefined,
    metadata: { operationId: operation.operationId, state: operation.state,
      classification: usefulPartial ? 'useful_partial' : invalidPartial ? 'invalid_partial_result'
        : operation.state,
      pgs, sweepOutputs, error: operation.error, resultArtifact: operation.resultArtifact,
      sourceEvidence: operation.sourceEvidence } };
}

function visibleContent(result: ToolResult, limit: number): string {
  const operationId = typeof result.metadata?.operationId === 'string'
    ? result.metadata.operationId : null;
  return recoverableExcerpt(result.content, limit, {
    resultHandle: result.resultHandle, operationId,
  });
}

export async function executeAndFormatTool(input: {
  registry: ToolRegistry;
  name: string;
  input: Record<string, unknown>;
  context: ToolContext;
  onEvent?: AgentEventCallback;
  modelLimit: number;
  eventLimit: number;
}): Promise<{
  result: ToolResult;
  modelContent: string;
  eventContent: string;
  success: boolean;
}> {
  const result = await input.registry.execute(input.name, input.input, input.context);
  const success = result.is_error !== true;
  const modelContent = visibleContent(result, input.modelLimit);
  const eventContent = visibleContent(result, input.eventLimit);
  input.onEvent?.({ type: 'tool_result', tool: input.name, result: eventContent, success });
  return { result, modelContent, eventContent, success };
}
```

- [ ] **Step 4: Run adapter tests and verify GREEN**

```bash
node --import tsx --test --test-concurrency=1 tests/agent/tool-result.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Add the provider-loop convergence assertion before editing provider branches**

Append to `tests/agent/tool-result.test.ts`:

```ts
import { readFileSync } from 'node:fs';

test('provider branches cannot bypass centralized tool result execution', () => {
  const source = readFileSync(new URL('../../src/agent/loop.ts', import.meta.url), 'utf8');
  assert.equal((source.match(/registry\.execute\(/g) || []).length, 0);
  assert.ok((source.match(/executeAndFormatTool\(/g) || []).length >= 4);
  assert.doesNotMatch(source, /tool_result[^\n]+success:\s*true/);
});
```

- [ ] **Step 6: Run the convergence assertion and verify RED**

```bash
node --import tsx --test --test-concurrency=1 tests/agent/tool-result.test.ts
```

Expected: the three adapter tests pass and `provider branches cannot bypass...` fails because `src/agent/loop.ts` still contains direct `registry.execute()` calls and hard-coded success events. Do not edit any provider branch until this RED output is captured.

Also create `tests/agent/tool-result-provider-branches.test.ts` before production edits. Its deterministic branch harness must drive one local tool call through each actual loop transport branch—`openai-codex`, `xai`, generic OpenAI-compatible (`openai`), Ollama chat (`ollama-cloud`), Anthropic SDK (`anthropic`), and Anthropic-compatible SDK (`minimax`)—with injected fake stream/SDK transports and a registry returning `{content:'typed failure',is_error:true}`. For every row assert: one registry call receives that turn's nonnull `turnRuntime`; the emitted `tool_result` event has `success:false`; the provider's next request contains its native error representation (Anthropic `is_error:true`, other branches the centralized error content); no success event is emitted; and no real network/credential is used. Assert the enumerated provider set equals the configured loop branch set so adding a branch without a row fails. Run this file with Step 6 and require RED for every bypassing branch; source regex convergence remains a supplemental guard, not the behavioral proof.

- [ ] **Step 7: Route every provider branch through the adapter**

In `src/agent/loop.ts`, replace each direct `registry.execute()` plus hardcoded event with this exact call:

```ts
const executed = await executeAndFormatTool({
  registry: this.registry,
  name: toolName,
  input: toolInput,
  context: runContext,
  onEvent,
  modelLimit: MODEL_TOOL_RESULT_LIMIT_CHARS,
  eventLimit: TOOL_EVENT_RESULT_LIMIT_CHARS,
});
```

Use `executed.modelContent` in OpenAI/Codex/xAI/Ollama tool outputs. For Anthropic tool-result blocks, set `is_error: true` when `executed.result.is_error === true`. Delete the three current `success: true` emissions around lines 1331, 1522, and 1744 and the separate Anthropic success calculation around line 1902.

- [ ] **Step 8: Run tool and provider regressions**

```bash
node --import tsx --test --test-concurrency=1 tests/agent/tool-result.test.ts tests/agent/loop-provider-error.test.ts
node --import tsx --test --test-concurrency=1 tests/agent/tool-result-provider-branches.test.ts
npm run build
```

Expected: all tests PASS; build PASS.

- [ ] **Step 9: Commit only tool-result paths**

```bash
git diff --cached --quiet
git add -- src/agent/tool-result.ts src/agent/loop.ts tests/agent/tool-result.test.ts tests/agent/tool-result-provider-branches.test.ts
git diff --cached --check
git diff --cached -- src/agent/tool-result.ts src/agent/loop.ts tests/agent/tool-result.test.ts tests/agent/tool-result-provider-branches.test.ts
git commit --only src/agent/tool-result.ts src/agent/loop.ts tests/agent/tool-result.test.ts tests/agent/tool-result-provider-branches.test.ts -m "fix: report tool failures consistently"
```

---

### Task 4: Migrate the Six Brain Tools

**Files:**
- Modify: `src/agent/tools/brain.ts:1-517`
- Modify: `tests/agent/tools/brain.test.ts:1-end`
- Modify: `tests/engine/dashboard/brain-operation-routes.test.js`
- Modify: `src/agent/tools/index.ts:13, 118-123`
- Modify: `src/home.ts:298-326`

**Interfaces:**
- Consumes: `ToolContext.brainOperations`, `BrainOperationsClient.search/query/graph/status/synthesize/exportResult`, typed operation states, source evidence, and requester-owned result handles.
- Produces: existing six tool names with own-brain compatibility and optional
  read-only target for brain_search, brain_query, brain_memory_graph, and
  brain_status. brain_query_export is requester-operation/requester-output
  bound and rejects target; brain_synthesize remains own-brain only.

- [ ] **Step 1: Add failing target and bounded-route tests**

Extend `tests/agent/tools/brain.test.ts` with a client stub rather than replacing global fetch. Update its `makeCtx()` so the supplied operation client is installed at `turnRuntime.brainOperations`, while the base `ToolContext.brainOperations` is a distinct throwing sentinel. Give the runtime a real `AbortController`, its exact signal, turn ID, and activity callback. This makes every test fail if a migrated tool accidentally reaches the startup-global client or deprecated abort field:

```ts
function completeOperation(
  operationId: string,
  answer: string,
  extraResult: Record<string, unknown> = {},
): BrainOperationResult {
  return makeBrainOperationRecord({
    operationId, state: 'complete', phase: 'done',
    result: { answer, ...extraResult },
    resultHandle: 'brres_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'matches' },
    attachmentState: 'closed',
  });
}

function failedOperation(operationId: string, code: string): BrainOperationResult {
  return {
    ...completeOperation(operationId, ''), state: 'failed', result: null, resultHandle: null,
    error: { code, message: `${code} fixture`, retryable: true },
    sourceEvidence: { sourceHealth: 'unavailable', matchOutcome: 'unknown' },
  };
}

test('brain_query forwards an explicit sibling target and returns operation provenance', async () => {
  let request: Record<string, unknown> | null = null;
  const ctx = makeCtx({
    brainOperations: {
      query: async (value: Record<string, unknown>) => {
        request = value;
        return makeBrainOperationRecord({
          operationId: 'op-sibling', requestId: 'req-1', state: 'complete', phase: 'done',
          target: canonicalBrainTarget('forrest', 'read-only'),
          result: { answer: 'Forrest answer' },
          resultHandle: 'brres_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'matches' },
          attachmentState: 'closed',
        });
      },
    },
  });
  const result = await brainQueryTool.execute({
    query: 'what did Forrest learn?', target: { agent: 'forrest' }, mode: 'quick',
  }, ctx);
  assert.deepEqual(request?.target, { agent: 'forrest' });
  assert.match(result.content, /Forrest answer/);
  assert.equal(result.resultHandle, 'brres_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(result.metadata?.operationId, 'op-sibling');
});

test('brain_memory_graph delegates bounded node and edge limits without fetching api memory', async () => {
  let request: Record<string, unknown> | null = null;
  const result = await brainMemoryGraphTool.execute({ topN: 25 }, makeCtx({
    brainOperations: { graph: async (value: Record<string, unknown>) => {
      request = value;
      return { nodes: [], edges: [], meta: { nodeCount: 139000, edgeCount: 455000 } };
    } },
  }));
  assert.equal(request?.nodeLimit, 25);
  assert.equal(request?.edgeLimit, 100);
  assert.match(result.content, /139000/);
});

test('brain_memory_graph full export is a durable requester-owned graph_export operation', async () => {
  let exported: Record<string, unknown> | null = null;
  const operation = completeOperation('op-graph-export', '', { format: 'jsonl' });
  operation.result = null;
  operation.resultArtifact = { mediaType: 'application/x-ndjson', contentEncoding: 'identity', bytes: 1048576,
    sha256: 'a'.repeat(64) };
  const result = await brainMemoryGraphTool.execute({ exportFull: true, format: 'jsonl' }, makeCtx({
    brainOperations: { graphExport: async (value: Record<string, unknown>) => {
      exported = value;
      return operation;
    } },
  }));
  assert.equal(exported?.format, 'jsonl');
  assert.equal(result.resultHandle, 'brres_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal((result.metadata?.resultArtifact as { bytes: number }).bytes, 1048576);
  assert.doesNotMatch(result.content, /nodes|edges/);
  assert.match(result.content, /requester-owned/i);
});

test('brain_synthesize rejects a cross-brain target before starting an operation', async () => {
  const result = await brainSynthesizeTool.execute({ action: 'run', target: { agent: 'forrest' } }, makeCtx());
  assert.equal(result.is_error, true);
  assert.match(result.content, /own brain only/i);
});

test('brain_query_export rejects target instead of silently ignoring it', async () => {
  let downstreamCalls = 0;
  const result = await brainQueryExportTool.execute({
    operationId: 'op-existing', target: { agent: 'forrest' }, format: 'markdown',
  }, makeCtx({ brainOperations: {
    exportResult: async () => { downstreamCalls += 1; throw new Error('must not run'); },
  } }));
  assert.equal(result.is_error, true);
  assert.equal(downstreamCalls, 0);
  assert.match(result.content, /invalid_request/);
});
```

- [ ] **Step 2: Run and verify RED**

```bash
node --import tsx --test --test-concurrency=1 tests/agent/tools/brain.test.ts
```

Expected: target/result-handle assertions fail; graph test fails because the tool still fetches `/api/memory`; synthesis schema/guard is absent.

- [ ] **Step 3: Add the remaining failing result-state tests before editing `brain.ts`**

Append these tests now, while production still uses the old fetch paths:

```ts
test('typed coordinator failure is an error and never an empty-brain claim', async () => {
  const result = await brainQueryTool.execute({ query: 'x' }, makeCtx({ brainOperations: {
    query: async () => failedOperation('op-fail', 'source_unavailable'),
  } }));
  assert.equal(result.is_error, true);
  assert.match(result.content, /source_unavailable/);
  assert.doesNotMatch(result.content, /empty brain/i);
});

test('PGS partial preserves useful sweep output and result handle', async () => {
  const partial = completeOperation('op-partial', '');
  partial.state = 'partial';
  partial.result = {
    answer: null,
    sweepOutputs: [{ workUnitId: 'sweep-1-u1', partitionId: 'sweep-1',
      output: 'successful sweep evidence', provider: 'minimax', model: 'MiniMax-M3' }],
    metadata: { pgs: { successfulSweeps: 1, retryablePartitions: ['sweep-2'] } },
  };
  partial.error = { code: 'provider_incomplete', message: 'final synthesis truncated', retryable: true };
  partial.resultHandle = 'brres_cccccccccccccccccccccccccccccccc';
  const result = await brainQueryTool.execute({ query: 'x', enablePGS: true }, makeCtx({
    brainOperations: { query: async () => partial },
  }));
  assert.equal(result.is_error, undefined);
  assert.match(result.content, /successful sweep evidence/);
  assert.equal(result.metadata?.state, 'partial');
  assert.equal(result.metadata?.classification, 'useful_partial');
  assert.equal((result.metadata?.pgs as { successfulSweeps: number }).successfulSweeps, 1);
  assert.deepEqual((result.metadata?.pgs as { retryablePartitions: string[] }).retryablePartitions, ['sweep-2']);
  assert.match(result.content, /provider_incomplete/);
  assert.equal(result.resultHandle, 'brres_cccccccccccccccccccccccccccccccc');
});

test('PGS request excludes query-only false defaults and preserves exact sweep fraction', async () => {
  let request: Record<string, unknown> | null = null;
  const operation = completeOperation('op-pgs-projection', 'answer'); operation.operationType = 'pgs';
  await brainQueryTool.execute({ query: 'x', mode: 'quick', enablePGS: true,
    pgsConfig: { sweepFraction: 0.25 } }, makeCtx({ brainOperations: {
      query: async (value: Record<string, unknown>) => { request = value; return operation; },
    } }));
  assert.deepEqual(request, { query: 'x', mode: 'quick', enablePGS: true,
    pgsMode: 'full', pgsConfig: { sweepFraction: 0.25 } });
  for (const key of ['modelSelection','enableSynthesis','includeOutputs','includeThoughts',
    'includeCoordinatorInsights','allowActions']) assert.equal(key in (request || {}), false);
});

test('PGS with no useful sweeps is all_failed and is_error true', async () => {
  const failed = failedOperation('op-pgs-all-failed', 'provider_failed');
  failed.operationType = 'pgs';
  failed.result = { answer: null, sweepOutputs: [],
    metadata: { pgs: { successfulSweeps: 0, retryablePartitions: ['sweep-1', 'sweep-2'] } } };
  const result = await brainQueryTool.execute({ query: 'x', enablePGS: true }, makeCtx({
    brainOperations: { query: async () => failed },
  }));
  assert.equal(result.is_error, true);
  assert.equal(result.metadata?.classification, 'all_failed');
  assert.match(result.content, /provider_failed/);
});

test('malformed PGS partials fail closed as invalid_partial_result', async () => {
  const baseResult = { answer: null, sweepOutputs: [{ workUnitId: 'u1', partitionId: 'p1',
    output: 'useful', provider: 'minimax', model: 'MiniMax-M3' }],
    metadata: { pgs: { successfulSweeps: 1, retryablePartitions: ['p2', 'p3'] } } };
  for (const mutate of [
    (value: any) => { value.metadata.pgs.successfulSweeps = '1'; },
    (value: any) => { value.metadata.pgs.successfulSweeps = NaN; },
    (value: any) => { value.metadata.pgs.successfulSweeps = -1; },
    (value: any) => { value.sweepOutputs[0].output = ''; },
    (value: any) => { delete value.sweepOutputs[0].provider; },
    (value: any) => { value.metadata.pgs.retryablePartitions = ['p3', 'p2']; },
    (value: any) => { value.metadata.pgs.retryablePartitions = ['p2', 'p2']; },
  ]) {
    const operation = completeOperation('op-invalid-partial', ''); operation.state = 'partial';
    operation.result = structuredClone(baseResult); operation.error = {
      code: 'provider_incomplete', message: 'truncated', retryable: true };
    mutate(operation.result);
    const result = await brainQueryTool.execute({ query: 'x', enablePGS: true }, makeCtx({
      brainOperations: { query: async () => operation },
    }));
    assert.equal(result.is_error, true);
    assert.equal(result.metadata?.classification, 'invalid_partial_result');
    assert.match(result.content, /invalid_partial_result/);
  }
  const missingError = completeOperation('op-invalid-error', ''); missingError.state = 'partial';
  missingError.result = structuredClone(baseResult); missingError.error = null;
  const result = await brainQueryTool.execute({ query: 'x', enablePGS: true }, makeCtx({
    brainOperations: { query: async () => missingError },
  }));
  assert.equal(result.metadata?.classification, 'invalid_partial_result');
  assert.equal(result.is_error, true);
});

test('direct query partial preserves a nonempty answer plus typed terminal error', async () => {
  const operation = completeOperation('op-query-partial', 'useful direct-query answer');
  operation.operationType = 'query'; operation.state = 'partial';
  operation.error = { code: 'provider_incomplete', message: 'provider stream ended', retryable: true };
  const result = await brainQueryTool.execute({ query: 'x' }, makeCtx({ brainOperations: {
    query: async () => operation,
  } }));
  assert.equal(result.is_error, undefined);
  assert.equal(result.metadata?.classification, 'useful_partial');
  assert.match(result.content, /useful direct-query answer/);
  assert.match(result.content, /provider_incomplete/);
  assert.deepEqual(result.metadata?.error, operation.error);
  assert.deepEqual(result.metadata?.sourceEvidence, operation.sourceEvidence);
});

test('direct query partial without both nonempty answer and typed error fails closed', async () => {
  for (const mutate of [
    (operation: BrainOperationResult) => { operation.result = { answer: '   ' }; },
    (operation: BrainOperationResult) => { operation.error = null; },
    (operation: BrainOperationResult) => { operation.error = {
      code: 'provider_incomplete', message: '', retryable: true }; },
  ]) {
    const operation = completeOperation('op-query-partial-invalid', 'answer');
    operation.operationType = 'query'; operation.state = 'partial';
    operation.error = { code: 'provider_incomplete', message: 'ended', retryable: true };
    mutate(operation);
    const result = await brainQueryTool.execute({ query: 'x' }, makeCtx({ brainOperations: {
      query: async () => operation,
    } }));
    assert.equal(result.is_error, true);
    assert.equal(result.metadata?.classification, 'invalid_partial_result');
    assert.match(result.content, /invalid_partial_result/);
  }
});

test('detached query remains running and exposes its operation ID', async () => {
  const running = completeOperation('op-running', '');
  running.state = 'running';
  running.attachmentState = 'detached';
  const result = await brainQueryTool.execute({ query: 'x' }, makeCtx({
    brainOperations: { query: async () => running },
  }));
  assert.match(result.content, /op-running/);
  assert.match(result.content, /running/);
  assert.match(result.content, /brain_status.*wait/i);
  assert.doesNotMatch(result.content, /complete/i);
});

test('brain_synthesize returns the new generation marker from its own-brain operation', async () => {
  let request: Record<string, unknown> | null = null;
  const operation = completeOperation('op-synthesis', 'synthesis complete', {
    generationMarker: 'generation-2026-07-09T12:00:00Z',
  });
  const result = await brainSynthesizeTool.execute({ action: 'run' }, makeCtx({
    brainOperations: { synthesize: async (value: Record<string, unknown>) => {
      request = value;
      return operation;
    } },
  }));
  assert.equal('provider' in (request || {}), false);
  assert.equal('model' in (request || {}), false);
  assert.match(result.content, /generation-2026-07-09T12:00:00Z/);
  assert.equal(result.metadata?.operationId, 'op-synthesis');
});

test('brain_synthesize status/reattach never starts a second synthesis and source_changed is a failed code', async () => {
  let starts = 0; const statusRequests: Record<string, unknown>[] = []; const reattached: string[] = [];
  const sourceChanged = failedOperation('op-source-changed', 'source_changed');
  sourceChanged.operationType = 'synthesis';
  const ctx = makeCtx({ brainOperations: {
    synthesize: async () => { starts += 1; return completeOperation('unexpected', 'unexpected'); },
    synthesisStatus: async (request: Record<string, unknown>) => {
      statusRequests.push(request); return { ready: true, requestedGenerationMarker: 'g1',
        currentGenerationMarker: 'g2', markerStatus: 'changed', latestOperation: null,
        activeOperation: null };
    },
    reattachSynthesis: async (operationId: string) => { reattached.push(operationId); return sourceChanged; },
  } });
  const status = await brainSynthesizeTool.execute({ action: 'status', generationMarker: 'g1' }, ctx);
  assert.deepEqual(statusRequests, [{ generationMarker: 'g1' }]);
  assert.match(status.content, /currentGenerationMarker.*g2/s);
  assert.match(status.content, /markerStatus.*changed/s);
  const resumed = await brainSynthesizeTool.execute({ action: 'reattach', operationId: 'op-source-changed' }, ctx);
  assert.deepEqual(reattached, ['op-source-changed']);
  assert.equal(resumed.is_error, true);
  assert.match(resumed.content, /source_changed/);
  assert.doesNotMatch(resumed.content, /generation.*complete/i);
  assert.equal(starts, 0);
});

test('brain_status exposes actionable status, result, wait, and explicit cancel by operation ID', async () => {
  const inspected: string[] = []; const resumed: string[] = [];
  const running = completeOperation('op-control', ''); running.state = 'running';
  running.attachmentState = 'detached';
  const ctx = makeCtx({ brainOperations: {
    inspectOperation: async (operationId: string, action: string) => {
      inspected.push(`${operationId}:${action}`);
      return action === 'result' ? { operationId, state: 'complete', result: { answer: 'stored' } }
        : { ...running, state: action === 'cancel' ? 'cancelled' : 'running' };
    },
    resumeOperation: async (operationId: string) => { resumed.push(operationId); return running; },
  } });
  for (const action of ['status', 'result', 'cancel'] as const) {
    await brainStatusTool.execute({ operationId: 'op-control', action }, ctx);
  }
  const waited = await brainStatusTool.execute({ operationId: 'op-control', action: 'wait' }, ctx);
  assert.deepEqual(inspected, ['op-control:status', 'op-control:result', 'op-control:cancel']);
  assert.deepEqual(resumed, ['op-control']);
  assert.match(waited.content, /still running|Detached/i);
  assert.deepEqual(Object.keys((brainStatusTool.input_schema as any).properties)
    .filter((key) => ['operationType','waitMs'].includes(key)), []);
});

test('brain_status renders authoritative summary totals without graph arrays', async () => {
  const result = await brainStatusTool.execute({}, makeCtx({ brainOperations: {
    status: async () => ({ memory: { nodeCount: 139000, edgeCount: 455000 },
      sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'matches' } }),
  } }));
  assert.match(result.content, /139000/);
  assert.match(result.content, /455000/);
  assert.doesNotMatch(result.content, /"nodes":\s*\[/);
});

test('omitted target stays omitted so the coordinator selects the exact own brain', async () => {
  let request: Record<string, unknown> | null = null;
  await brainQueryTool.execute({ query: 'own brain' }, makeCtx({ brainOperations: {
    query: async (value: Record<string, unknown>) => {
      request = value;
      return completeOperation('op-own', 'own');
    },
  } }));
  assert.equal(request?.target, undefined);
});
```

Before production edits, append a separate CommonJS route test to `tests/engine/dashboard/brain-operation-routes.test.js` using its real `makeRouteFixture({synthesisSelection:{provider:'openai',model:'gpt-synth'}})`. Start `{operationType:'synthesis',requestId:'trusted-synthesis',parameters:{action:'run'}}`; assert the worker context receives trusted `provider:'openai'` and `model:'gpt-synth'`, the capability remains type `synthesis`, and caller-supplied provider/model is rejected. This route test, not the TypeScript tool stub, proves trusted provider selection.

Run the focused test again. Expected: these result-state, status, and synthesis assertions are RED in addition to Step 2. Capture this RED output before editing `src/agent/tools/brain.ts`.

- [ ] **Step 4: Add one reusable target schema and import the shared formatter**

At the top of `src/agent/tools/brain.ts`, import the single formatter from Task 3 and define the target parser:

```ts
import { operationToolResult } from '../tool-result.js';

const targetSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent: { type: 'string', minLength: 1 },
    brainId: { type: 'string', minLength: 1 },
  },
} as const;

function targetFrom(input: Record<string, unknown>): { agent?: string; brainId?: string } | undefined {
  if (!Object.prototype.hasOwnProperty.call(input, 'target')) return undefined;
  const value = input.target;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_request');
  const keys = Object.keys(value).sort();
  if (keys.length < 1 || keys.some((key) => key !== 'agent' && key !== 'brainId')) {
    throw new Error('invalid_request');
  }
  const target = value as { agent?: unknown; brainId?: unknown };
  if (target.agent !== undefined && (typeof target.agent !== 'string' || !target.agent.trim())) {
    throw new Error('invalid_request');
  }
  if (target.brainId !== undefined && (typeof target.brainId !== 'string' || !target.brainId.trim())) {
    throw new Error('invalid_request');
  }
  return target as { agent?: string; brainId?: string };
}
```

Task 3's exported `operationToolResult()` is the only operation-result classifier used by both `brain.ts` and `research.ts`. For `operationType:'pgs'`, it requires the canonical PGS partial shape exactly: `result.answer` may be null while `result.sweepOutputs[]` contains useful work, `result.metadata.pgs.successfulSweeps` must first narrow with `typeof === 'number'` and then be a nonnegative safe integer equal to the output count, `retryablePartitions` remains sorted/unique, and the typed terminal partial error is visible. For `operationType:'query'`, a partial is useful only when it has a nonempty answer and the same typed terminal error; it does not need or receive the PGS sweep-shape test. Any other partial is `invalid_partial_result` with `is_error:true`. A useful partial is `useful_partial` without `is_error`; zero useful PGS sweeps is terminal `failed`/`all_failed` with `is_error:true`. Never coerce `successfulSweeps`, fabricate an answer string, scrape sweep evidence out of prose, or drop retryable partition/error/provenance metadata. The shared display limiter may shorten rendered text only with the operation/result reference still visible.

- [ ] **Step 5: Rewrite each tool with executable client adapters**

Keep the existing tool names/descriptions, set `additionalProperties:false` on every top-level and nested schema, add `target: targetSchema` only to brain_search, brain_query, brain_memory_graph, and brain_status, add `operationId`/`resultHandle` to export while explicitly omitting/rejecting target there, and add `exportFull?: boolean` plus the sole full-graph format `format?: 'jsonl'` to `brain_memory_graph`. `brain_query` exposes only exact nested `modelSelection`, `pgsSweep`, and `pgsSynth` objects, each requiring exactly nonempty `provider` and `model`; remove every flat/legacy model shortcut. `brain_status` additively accepts an operation-control branch containing only `{operationId,action:'status'|'result'|'wait'|'cancel'}`; `operationType`, `waitMs`, and every other caller wait-policy field are forbidden. `brain_synthesize` accepts `run`, `status` (optional operation ID or generation marker), or `reattach` (required operation ID) and no provider/model/target. Reject `json`, legacy `full`, present-null/extra targets, invalid/nonfinite inline limits, partial provider pairs, and any request that combines `exportFull:true` with inline sample selectors. Import `hasOwn`, `requiredBoundedText`, `optionalBoundedText`, `optionalBoolean`, `optionalEnum`, and `optionalJsonObject` from the one shared `input-validation.ts`; each returns `undefined` only for true omission and rejects present null/wrong types. `optionalJsonObject` also rejects cycles, non-JSON/nonfinite leaves, excessive depth, and encoded content over its byte bound. Executable adapters use these plus strict finite validators and never truthiness coercion, `String(value)`, `Number(value) || default`, or clamping. Replace their execute bodies with these functions:

```ts
function toolFailure(label: string, error: unknown): ToolResult {
  const code = typeof error === 'object' && error && 'code' in error
    ? String((error as { code: unknown }).code) : 'brain_operation_error';
  const message = error instanceof Error ? error.message : String(error);
  return { content: `${label}: ${code}: ${message}`, is_error: true,
    metadata: { code, sourceHealth: code === 'source_unavailable' ? 'unavailable' : 'unknown' } };
}

function boundedJson(label: string, value: Record<string, unknown>): ToolResult {
  return { content: `${label}\n${JSON.stringify(value, null, 2)}`,
    resultHandle: typeof value.resultHandle === 'string' ? value.resultHandle : undefined,
    metadata: { operationId: value.operationId, state: value.state,
      sourceEvidence: value.sourceEvidence } };
}

function operationControlResult(
  action: string,
  value: BrainOperationRecord | BrainOperationResultEnvelope,
): ToolResult {
  const failed = ['failed', 'cancelled', 'interrupted'].includes(value.state);
  const running = value.state === 'queued' || value.state === 'running';
  return {
    content: `${failed ? `${value.error?.code}: ${value.error?.message}` : JSON.stringify(value.result || {})}\n`
      + `operation=${value.operationId} state=${value.state}`
      + (running ? `\nUse brain_status {action:"wait",operationId:"${value.operationId}"} to reattach,`
        + ` or action:"cancel" to stop it.` : ''),
    is_error: failed || undefined,
    resultHandle: value.resultHandle || undefined,
    metadata: { action, operationId: value.operationId, state: value.state,
      error: value.error, sourceEvidence: value.sourceEvidence,
      resultArtifact: value.resultArtifact },
  };
}

async function executeBrainSearch(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    const topK = optionalFiniteInteger(input.limit, 'limit', 1, 100) ?? 10;
    const value = await ctx.turnRuntime!.brainOperations.search({
      ...(targetFrom(input) ? { target: targetFrom(input) } : {}),
      query: requiredBoundedText(input.query, 'query', 12_000),
      topK,
      ...(hasOwn(input, 'tag') ? { tag: optionalBoundedText(input.tag, 'tag', 256)! } : {}),
    }, ctx.turnRuntime!.signal);
    return boundedJson('brain_search', value);
  } catch (error) { return toolFailure('brain_search', error); }
}

async function executeBrainQuery(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    const enablePGS = optionalBoolean(input.enablePGS, 'enablePGS') ?? false;
    const pgsOnly = ['pgsMode','pgsConfig','pgsSweep','pgsSynth'];
    const directOnly = ['modelSelection','enableSynthesis','includeOutputs','includeThoughts',
      'includeCoordinatorInsights','allowActions'];
    if ((!enablePGS && pgsOnly.some((key) => hasOwn(input, key)))
        || (enablePGS && directOnly.some((key) => hasOwn(input, key)))) throw new Error('invalid_request');
    const mode = optionalEnum(input.mode, 'mode', ['quick','full','expert','dive'] as const)
      ?? DEFAULT_BRAIN_QUERY_MODE;
    for (const key of ['enableSynthesis','includeOutputs','includeThoughts',
      'includeCoordinatorInsights','allowActions'] as const) optionalBoolean(input[key], key);
    const operation = await ctx.turnRuntime!.brainOperations.query({
      ...(targetFrom(input) ? { target: targetFrom(input) } : {}),
      query: requiredBoundedText(input.query, 'query', 12_000),
      mode,
      ...(input.priorContext !== undefined ? { priorContext: input.priorContext } : {}),
      ...(enablePGS ? {
        enablePGS: true,
        pgsMode: optionalEnum(input.pgsMode, 'pgsMode', ['full'] as const) ?? 'full',
        ...(input.pgsConfig !== undefined ? { pgsConfig: input.pgsConfig } : {}),
        ...(hasOwn(input, 'pgsSweep') ? { pgsSweep: exactProviderModelPair(input.pgsSweep, 'pgsSweep') } : {}),
        ...(hasOwn(input, 'pgsSynth') ? { pgsSynth: exactProviderModelPair(input.pgsSynth, 'pgsSynth') } : {}),
      } : {
        ...(hasOwn(input, 'modelSelection')
          ? { modelSelection: exactProviderModelPair(input.modelSelection, 'modelSelection') } : {}),
        ...(hasOwn(input, 'enableSynthesis')
          ? { enableSynthesis: optionalBoolean(input.enableSynthesis, 'enableSynthesis')! } : {}),
        ...(hasOwn(input, 'includeOutputs')
          ? { includeOutputs: optionalBoolean(input.includeOutputs, 'includeOutputs')! } : {}),
        ...(hasOwn(input, 'includeThoughts')
          ? { includeThoughts: optionalBoolean(input.includeThoughts, 'includeThoughts')! } : {}),
        ...(hasOwn(input, 'includeCoordinatorInsights')
          ? { includeCoordinatorInsights: optionalBoolean(
              input.includeCoordinatorInsights, 'includeCoordinatorInsights')! } : {}),
        ...(hasOwn(input, 'allowActions')
          ? { allowActions: optionalBoolean(input.allowActions, 'allowActions')! } : {}),
      }),
    }, ctx.turnRuntime!.signal);
    return operationToolResult(operation);
  } catch (error) { return toolFailure('brain_query', error); }
}

async function executeBrainExport(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    if (hasOwn(input, 'target')) throw new Error('invalid_request');
    const format = optionalEnum(input.format, 'format', ['markdown','json'] as const) ?? 'markdown';
    const canonical = hasOwn(input, 'operationId');
    if (canonical && (hasOwn(input, 'query') || hasOwn(input, 'answer'))) throw new Error('invalid_request');
    if (!canonical && (!hasOwn(input, 'query') || !hasOwn(input, 'answer')
        || hasOwn(input, 'resultHandle'))) throw new Error('invalid_request');
    const metadata = optionalJsonObject(input.metadata, 'metadata', 32_000);
    const value = canonical
      ? await ctx.turnRuntime!.brainOperations.exportResult({
          operationId: requiredBoundedText(input.operationId, 'operationId', 256),
          ...(hasOwn(input, 'resultHandle')
            ? { resultHandle: optionalBoundedText(input.resultHandle, 'resultHandle', 256)! } : {}),
          format,
          ...(metadata ? { metadata } : {}),
        }, ctx.turnRuntime!.signal)
      : await ctx.turnRuntime!.brainOperations.exportAdHocResult({
          query: requiredBoundedText(input.query, 'query', 12_000),
          answer: requiredBoundedText(input.answer, 'answer', 2_000_000), format,
          metadata: { ...(metadata || {}), canonicalEvidence: false },
        }, ctx.turnRuntime!.signal);
    return boundedJson('brain_query_export', value);
  } catch (error) { return toolFailure('brain_query_export', error); }
}

async function executeBrainGraph(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const target = targetFrom(input);
  try {
    const exportFull = optionalBoolean(input.exportFull, 'exportFull') ?? false;
    if (exportFull) {
      if (['topN','tag'].some((key) => hasOwn(input, key))) throw new Error('invalid_request');
      const operation = await ctx.turnRuntime!.brainOperations.graphExport({
        ...(target ? { target } : {}),
        format: optionalEnum(input.format, 'format', ['jsonl'] as const) ?? 'jsonl',
      }, ctx.turnRuntime!.signal);
      const rendered = operationToolResult(operation);
      rendered.content += '\nFull graph stored in requester-owned operation result storage.';
      return rendered;
    }
    const nodeLimit = optionalFiniteInteger(input.topN, 'topN', 1, 100) ?? 25;
    const value = await ctx.turnRuntime!.brainOperations.graph({
      ...(target ? { target } : {}), nodeLimit,
      edgeLimit: Math.min(nodeLimit * 4, 400),
      ...(hasOwn(input, 'tag') ? { tag: optionalBoundedText(input.tag, 'tag', 256)! } : {}),
    }, ctx.turnRuntime!.signal);
    return boundedJson('brain_memory_graph', value);
  } catch (error) { return toolFailure('brain_memory_graph', error); }
}

async function executeBrainSynthesis(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (Object.prototype.hasOwnProperty.call(input, 'target')) {
    return { content: 'brain_synthesize is own brain only.', is_error: true };
  }
  try {
    const action = optionalEnum(input.action, 'action', ['run','status','reattach'] as const) ?? 'run';
    if (action === 'status') {
      const value = await ctx.turnRuntime!.brainOperations.synthesisStatus({
        ...(hasOwn(input, 'operationId')
          ? { operationId: optionalBoundedText(input.operationId, 'operationId', 256)! } : {}),
        ...(hasOwn(input, 'generationMarker')
          ? { generationMarker: optionalBoundedText(input.generationMarker, 'generationMarker', 256)! } : {}),
      }, ctx.turnRuntime!.signal);
      return 'operationId' in value && 'state' in value
        ? operationToolResult(value as BrainOperationResult)
        : boundedJson('brain_synthesis_status', value as Record<string, unknown>);
    }
    if (action === 'reattach') {
      const operationId = requiredBoundedText(input.operationId, 'operationId', 256);
      return operationToolResult(await ctx.turnRuntime!.brainOperations.reattachSynthesis(
        operationId, ctx.turnRuntime!.signal));
    }
    return operationToolResult(await ctx.turnRuntime!.brainOperations.synthesize({
      trigger: optionalBoundedText(input.trigger, 'trigger', 256) ?? 'tool',
      ...(hasOwn(input, 'reason') ? { reason: optionalBoundedText(input.reason, 'reason', 4_000)! } : {}),
    }, ctx.turnRuntime!.signal));
  } catch (error) { return toolFailure('brain_synthesize', error); }
}

async function executeBrainStatus(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    if (hasOwn(input, 'operationId')) {
      const operationId = requiredBoundedText(input.operationId, 'operationId', 256);
      const action = optionalEnum(input.action, 'action', ['status','result','wait','cancel'] as const) ?? 'status';
      const value = action === 'wait'
        ? await ctx.turnRuntime!.brainOperations.resumeOperation(operationId, ctx.turnRuntime!.signal)
        : await ctx.turnRuntime!.brainOperations.inspectOperation(operationId, action, ctx.turnRuntime!.signal);
      return 'attachmentState' in value
        ? operationToolResult(value as BrainOperationResult)
        : operationControlResult(action, value);
    }
    return boundedJson('brain_status', await ctx.turnRuntime!.brainOperations.status(
      targetFrom(input) ? { target: targetFrom(input) } : {}, ctx.turnRuntime!.signal,
    ));
  } catch (error) { return toolFailure('brain_status', error); }
}
```

The `brain_synthesize` schema keeps `run` and `status` compatible and adds `reattach`; `operationId` is required only for `reattach`, while `status` accepts an optional exact operation ID or generation marker. `action:'status'` calls only `synthesisStatus()` and can never call `synthesize()`/`start('synthesis')`. `action:'reattach'` resumes only the exact persisted synthesis operation, and `run` is the sole action that starts one. Assign these functions to the six `ToolDefinition.execute` fields. Delete `summarizeMemoryGraphCounts`, every raw `fetch`, `ctx.brainRoute`, `AbortSignal.timeout`, `/api/memory`, and every local `.slice()` truncation. The central Task 3 adapter is the only display truncation layer, so an oversized canonical query remains recoverable by operation ID/result handle.

- [ ] **Step 6: Run brain tool tests and build**

```bash
node --import tsx --test --test-concurrency=1 tests/agent/tools/brain.test.ts
node --test --test-concurrency=1 tests/engine/dashboard/brain-operation-routes.test.js
npm run build
```

Expected: all brain tool tests PASS; build PASS.

- [ ] **Step 7: Commit only brain-tool paths from the clean isolated worktree**

```bash
git diff --cached --quiet
git add -- src/agent/tools/brain.ts src/agent/tools/index.ts src/home.ts tests/agent/tools/brain.test.ts tests/engine/dashboard/brain-operation-routes.test.js
git diff --cached --check
git diff --cached -- src/agent/tools/brain.ts src/agent/tools/index.ts src/home.ts tests/agent/tools/brain.test.ts tests/engine/dashboard/brain-operation-routes.test.js
git commit --only src/agent/tools/brain.ts src/agent/tools/index.ts src/home.ts tests/agent/tools/brain.test.ts tests/engine/dashboard/brain-operation-routes.test.js -m "fix: route brain tools through durable operations"
```

---

### Task 5: Migrate and Harden the Research Toolkit

**Files:**
- Create: `cosmo23/server/lib/research-run-operation-adapter.js`
- Create: `cosmo23/server/lib/research-pinned-source-reader.js`
- Create: `cosmo23/server/lib/research-requester-output-writer.js`
- Create: `cosmo23/server/lib/research-compile-provider-adapter.js`
- Create: `cosmo23/server/lib/research-operation-executors.js`
- Create: `tests/cosmo23/research-run-operation-adapter.test.cjs`
- Create: `tests/cosmo23/research-pinned-source-reader.test.cjs`
- Create: `tests/cosmo23/research-requester-output-writer.test.cjs`
- Create: `tests/cosmo23/research-compile-provider-adapter.test.cjs`
- Create: `tests/cosmo23/research-operation-executors.test.cjs`
- Modify: `cosmo23/server/index.js`
- Modify: `cosmo23/server/config/model-catalog.js`
- Modify: `cosmo23/server/providers/registry.js`
- Modify: `src/agent/tools/research.ts:1-1003`
- Modify: `tests/agent/tools/research.test.ts:1-end`
- Modify: `docs/design/STEP16-AGENT-COSMO-TOOLKIT-DESIGN.md`

**Interfaces:**
- Consumes: canonical catalog fields, the authority plan's exact COSMO worker executor registry, an exact private provider-client resolver/completion validator, and `BrainOperationsClient` query/graph/compile/stop short-read interfaces.
- Produces: server executors named `research_launch`, `research_continue`, `research_stop`, `research_watch`, `research_intelligence`, and `research_compile`; plus eleven existing `research_*` tools with visible per-brain outcomes, bounded concurrency, exact cursors/sections, run-owner enforcement, and requester-owned compile output.

- [ ] **Step 0: Add and verify the missing research-operation backend mapping**

Create all five focused backend tests named in the file map first. The run-adapter test uses the actual dependency shape exported by `cosmo23/server/index.js`, not a fictional `createOwnedRun()` process-manager method. It injects `runManager.createRun`, the existing `processManager.startMCPServer/startMainDashboard/startCOSMO/stopAll/getStatus/getLogs`, extracted `launchPreparedResearch`, `getActiveContext`, `setActiveContext`, `loadCanonicalRunMetadata`, `writeCanonicalRunMetadataAtomic`, an injected clock, and a requester workspace resolver. Prove the adapter:

- derives `<home23Root>/instances/<requester>/workspace/research-runs/<runId>` server-side, rejects symlinks/path escape, calls the real run manager, and atomically persists `{runId,ownerAgent,operationId,state:'starting',createdAt}` before the first process start call;
- transitions `starting -> active -> stopping -> stopped` with durable timestamps, and `starting/active -> failed` with a typed error when launch/process exit fails; reload after every transition and assert the exact canonical record drives `resolveOwnedRun()`;
- permits continue only from `paused|failed|completed`, persists all explicit option overrides before launch, and never mutates owner/run identity;
- stops only when the exact canonical run matches the current active context, writes `stopping` before `stopAll()`, waits through the actual process-status adapter until children are down, honors AbortSignal without claiming stopped, and clears active context only after the durable stopped transition;
- watches the exact run's bounded log ring with the supplied cursor/filter and reports the canonical state; it never substitutes whichever run happens to be active; and
- handles concurrent launch/continue/stop calls with one per-run lock and deterministic `run_state_conflict`, with no duplicate spawn or stale state overwrite.

Refactor the existing `launchResearch()` body just enough to export/inject `launchPreparedResearch()`—the same config generation, runtime link, metadata, and `startProcessesForRun()` path used by `/api/launch`. Do not duplicate a second launcher in the new adapter. `cosmo23/server/index.js` constructs `researchRunAdapter` explicitly from these real dependencies and passes that object as `processManager`/`resolveOwnedRun` to the executors. There is no free `researchDependencies` placeholder.

Implement `cosmo23/server/lib/research-pinned-source-reader.js` over only the canonical `PinnedMemorySource` surface: `summarize`, `searchKeyword`, `iterateNodes`, `iterateEdges`, and `getEvidence`. Export `readPinnedIntelligence(sourcePin,selection,{signal,maxNodes,maxEdges,maxBytes})`; it abort-checks while iterating, applies exact `kind/section/sectionId/include` selection to projected node metadata/content, enforces bounded records/bytes, and returns `{content,selection,summary,evidence}`. It never accesses a target path, materializes a graph, or calls an invented `readIntelligenceSection`. Its focused test supplies exactly those five methods plus throwing getters for undeclared methods/paths and covers resident, legacy projection, completed research, exact section, missing section, cancellation, and limits.

Implement `cosmo23/server/lib/research-requester-output-writer.js` as the concrete producer of `createRequesterOutputWriter({home23Root,requesterAgent,operationId,signal})`. It derives the requester workspace server-side, performs the no-symlink/realpath/device/inode checks below, and returns only the relative-basename atomic writer. `cosmo23/server/config/model-catalog.js` exports `resolveExactConfiguredPair(catalog,configuredAgents,'agents.research-synthesis')`, validating exactly one configured `{provider,model}` without model-only inference. `cosmo23/server/providers/registry.js` adds `getExact(provider,model)`, verifying that exact provider owns and can serve that exact model without fallback. `cosmo23/server/index.js` passes its already-loaded Home23 `agents.research-synthesis` configuration into the catalog resolver and constructs the reader, writer, registry lookup, and compile adapter explicitly.

Implement `cosmo23/server/lib/research-compile-provider-adapter.js` as the production `createResearchCompileProviderAdapter({resolveConfiguredPair,getExactProviderClient,requireCompleteProviderResult,getModelCapabilities})` factory. Its returned `compileSectionWithProvider({context,sectionContent,sectionSelection,writer})` requires `context.operationType === 'research_compile'`, a verified source pin, a prevalidated requester writer, and no caller provider/model/output path. Resolve exactly `{provider,model}` and obtain catalog-derived `providerStallMs`. Emit `provider_selected`, wrapped `provider_activity`, and `provider_call_terminal` with `phase:'research_compile'` and exact singleton `providerCallId:'research_compile'`; child event fields cannot overwrite the outer type, and terminal outcome is exactly `complete|failed|cancelled` from `finally`. A child timestamp is copied only to bounded diagnostic `providerEventAt` when it is a valid ISO string of at most 64 characters; never emit child `at` or use it for activity/stall timers. Coordinator-local receipt time and monotonic arrival order remain authoritative. Validate a nonempty normal completion, then ask only `writer.writeAtomic(<server-generated-relative-name>, bytes)` to persist output. The returned result includes exact provider/model, relative requester path, section selector, and source evidence. Cancellation, incomplete/error payloads, missing/ambiguous pairs, provider mismatch, absolute/traversal filenames, writer symlink swaps, or paths outside the prevalidated requester root fail typed before terminal success and never touch target state.

The compile-adapter test gives two providers the same model label and proves the configured provider alone is called; asserts exact model propagation, output bytes/boundary, the exact selected/activity/terminal triplet for complete/failure/cancellation, and zero public-query-executor calls. It supplies a writer that rejects absolute/traversal names and a symlink-swap sentinel. The executor test then injects this real adapter factory result rather than a stub and proves `research_compile` remains its operation/capability type from registry lookup through result—never `query` relabeling.

In that focused test emit child timestamps one year behind, one year ahead, malformed, and over 64 characters. Assert arrival order remains selected/activity/terminal, every event keeps `providerCallId:'research_compile'`, skewed valid values appear only as `providerEventAt`, malformed/oversized values are omitted, no event exposes child `at`, and the injected coordinator receipt clock—not child time—drives activity/stall assertions.

In the executor test, inject that concrete adapter, a pinned-source reader, a prevalidated requester writer factory, and private compile/provider adapter, then prove:

~~~js
const executors = createResearchOperationExecutors({
  processManager,
  resolveOwnedRun,
  readPinnedIntelligence,
  createRequesterOutputWriter,
  compileSectionWithProvider,
});
assert.deepEqual([...executors.keys()].sort(), [
  'research_compile', 'research_continue', 'research_intelligence',
  'research_launch', 'research_stop', 'research_watch',
]);
~~~

The test must prove `research_launch` forwards every approved public launch option without inventing a caller path/owner, injects the existing trusted internal defaults `enableWebSearch:true`, `enableCodingAgents:false`, `enableAgentRouting:true`, and `enableMemoryGovernance:true` only inside the server run adapter, and durably writes canonical `ownerAgent=context.requesterAgent` plus stable run ID before spawning. Tool/route tests reject those four booleans and invented `enableDebate`/`enableSynthesis` as public input. Require continue/stop/watch to carry an exact `{runId}` target; reject omission, wildcard, `brainId` alias, extra selector fields, and a run whose canonical `ownerAgent` differs from `context.requesterAgent`; preserve the exact watch cursor; and assert the public query executor is never called with `operationType:'research_compile'`. For `research_intelligence` and `research_compile`, provide a fake `context.sourcePin` exposing only canonical `summarize/searchKeyword/iterateNodes/iterateEdges/getEvidence`; any undeclared method or target-path access throws. Assert exact selection/cursor/signal through `readPinnedIntelligence`. Abort before and during a deferred iterator and prove no provider/writer call. Before a non-cancelled compile provider call, require `createRequesterOutputWriter()` to have lstat/realpath-validated every existing requester workspace component as a non-symlink, opened the output directory without following a link, and returned a relative-name-only atomic writer; make prevalidation fail and prove zero provider calls. The private compile adapter receives that writer, never an `outputRoot` string, and a path escape/symlink swap is rejected. Run all five tests and confirm RED:

~~~bash
node --test --test-concurrency=1 tests/cosmo23/research-run-operation-adapter.test.cjs tests/cosmo23/research-pinned-source-reader.test.cjs tests/cosmo23/research-requester-output-writer.test.cjs tests/cosmo23/research-compile-provider-adapter.test.cjs tests/cosmo23/research-operation-executors.test.cjs
node --test --test-concurrency=1 tests/engine/dashboard/brain-operation-routes.test.js
~~~

Expected: FAIL because the executor module does not exist.

Implement this adapter contract in `cosmo23/server/lib/research-operation-executors.js`:

~~~js
'use strict';

function failure(code, message, retryable = false) {
  return { state: 'failed', result: null,
    error: { code, message, retryable }, sourceEvidence: null };
}

function createResearchOperationExecutors({
  processManager,
  resolveOwnedRun,
  readPinnedIntelligence,
  createRequesterOutputWriter,
  compileSectionWithProvider,
}) {
  async function ownedRun(context) {
    const keys = context.target && typeof context.target === 'object' && !Array.isArray(context.target)
      ? Object.keys(context.target).sort() : [];
    const runId = context.target?.runId;
    if (keys.length !== 1 || keys[0] !== 'runId' || typeof runId !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
      return { error: failure('invalid_request', 'Exact research runId target is required') };
    }
    const run = await resolveOwnedRun({ runId, requesterAgent: context.requesterAgent });
    if (!run) return { error: failure('target_not_found', `Unknown research run: ${runId}`) };
    if (!run.ownerAgent || run.ownerAgent !== context.requesterAgent) {
      return { error: failure('access_denied', 'Research run belongs to another requester') };
    }
    return { run };
  }

  return new Map([
    ['research_launch', async (context) => {
      const runId = `research-${context.operationId}`;
      const metadata = await processManager.createOwnedRun({
        runId,
        ownerAgent: context.requesterAgent,
        topic: String(context.parameters.topic || ''),
        parameters: context.parameters,
      });
      await processManager.start(metadata.runId, { signal: context.signal });
      return { state: 'complete', result: { runId: metadata.runId, ownerAgent: metadata.ownerAgent },
        error: null, sourceEvidence: null };
    }],
    ['research_continue', async (context) => {
      const selected = await ownedRun(context);
      if (selected.error) return selected.error;
      const result = await processManager.continue(selected.run.runId, context.parameters, { signal: context.signal });
      return { state: 'complete', result, error: null, sourceEvidence: null };
    }],
    ['research_stop', async (context) => {
      const selected = await ownedRun(context);
      if (selected.error) return selected.error;
      const result = await processManager.stopAndWait(selected.run.runId, { signal: context.signal });
      return { state: result.terminal ? 'complete' : 'partial', result, error: null, sourceEvidence: null };
    }],
    ['research_watch', async (context) => {
      const selected = await ownedRun(context);
      if (selected.error) return selected.error;
      const after = Number.isInteger(context.parameters.after) ? context.parameters.after : 0;
      const result = await processManager.watch(selected.run.runId, { after,
        limit: context.parameters.limit, filter: context.parameters.filter });
      return { state: 'complete', result: { ...result, latest: result.latest },
        error: null, sourceEvidence: null };
    }],
    ['research_intelligence', async (context) => {
      context.signal.throwIfAborted();
      if (!context.sourcePin) return failure('source_pin_required', 'Pinned source is required');
      const result = await readPinnedIntelligence(context.sourcePin, {
        kind: 'intelligence', include: context.parameters.include,
      }, { signal: context.signal, maxNodes: 2_000, maxEdges: 8_000, maxBytes: 8 * 1024 * 1024 });
      context.signal.throwIfAborted();
      return { state: 'complete', result, error: null, sourceEvidence: context.sourcePin.getEvidence() };
    }],
    ['research_compile', async (context) => {
      const selection = {
        kind: context.parameters.kind,
        section: context.parameters.section,
        sectionId: context.parameters.sectionId,
      };
      context.signal.throwIfAborted();
      if (!context.sourcePin) return failure('source_pin_required', 'Pinned source is required');
      const section = await readPinnedIntelligence(context.sourcePin, selection, {
        signal: context.signal, maxNodes: 2_000, maxEdges: 8_000, maxBytes: 8 * 1024 * 1024,
      });
      context.signal.throwIfAborted();
      if (!section) return failure('section_not_found', 'Requested intelligence section was not found');
      const outputWriter = await createRequesterOutputWriter({
        requesterAgent: context.requesterAgent,
        operationId: context.operationId,
        signal: context.signal,
      });
      context.signal.throwIfAborted();
      const compiled = await compileSectionWithProvider({
        context, sectionContent: section.content, sectionSelection: selection,
        writer: outputWriter,
      });
      return compiled;
    }],
  ]);
}

module.exports = { createResearchOperationExecutors };
~~~

`research-run-operation-adapter.js` is the concrete executable contract described above. Its `createOwnedRun()`, `start()`, `continue()`, `stopAndWait()`, `watch()`, and `resolveOwnedRun()` methods wrap the current launcher/process APIs; no executor relies on an undefined dependency bundle. `resolveOwnedRun()` always re-reads canonical metadata for the exact supplied run ID; no operation infers a current run. A missing, wildcard, `brainId`, extra-field, unknown, ambiguous-owner, or different-owner selector fails before process mutation.

`createRequesterOutputWriter()` derives the workspace from trusted server configuration, lstat/realpath-checks every existing component, rejects any symlink/non-directory, opens the final directory with no-follow semantics, rechecks device/inode before rename, and exposes only `writeAtomic(relativeBasename, bytes)`; it rejects separators, traversal, absolute names, and post-validation swaps. It is created **before** provider compilation. `compileSectionWithProvider()` is a private adapter, not the public query executor: it receives the already authorized `research_compile` context/source pin and the capability writer, invokes provider completion with a private query projection, and never receives a raw output root or target path. Cancellation is checked before/after pinned reads, writer creation, and provider completion; a cancelled read cannot produce output or provider work.

In `cosmo23/server/index.js`, register every backend by merging the maps before constructing the one fully configured worker:

~~~js
const { createResearchRunOperationAdapter } = require('./lib/research-run-operation-adapter');
const { readPinnedIntelligence } = require('./lib/research-pinned-source-reader');
const { createRequesterOutputWriter: createResearchRequesterOutputWriter } =
  require('./lib/research-requester-output-writer');
const { createResearchCompileProviderAdapter } = require('./lib/research-compile-provider-adapter');
const { createResearchOperationExecutors } = require('./lib/research-operation-executors');
const { resolveExactConfiguredPair } = require('./config/model-catalog');
const researchRunAdapter = createResearchRunOperationAdapter({
  home23Root, runManager, processManager, launchPreparedResearch,
  getActiveContext: () => activeContext,
  setActiveContext: (value) => { activeContext = value; },
  loadCanonicalRunMetadata, writeCanonicalRunMetadataAtomic, clock,
});
const compileSectionWithProvider = createResearchCompileProviderAdapter({
  resolveConfiguredPair: () => resolveExactConfiguredPair(
    modelCatalog, configuredAgents, 'agents.research-synthesis'),
  getExactProviderClient: (provider, model) => providerRegistry.getExact(provider, model),
  requireCompleteProviderResult,
  getModelCapabilities: (provider, model) => modelCatalog.getCapabilities(provider, model),
});
const researchExecutors = createResearchOperationExecutors({
  processManager: researchRunAdapter,
  resolveOwnedRun: researchRunAdapter.resolveOwnedRun,
  readPinnedIntelligence,
  createRequesterOutputWriter: (request) => createResearchRequesterOutputWriter({ home23Root, ...request }),
  compileSectionWithProvider,
});
const executors = new Map([...queryOperationExecutors, ...researchExecutors]);
const brainOperationWorker = new BrainOperationWorker({
  home23Root, capabilityKey, nonceStore, catalog, sourcePins, executors, clock,
});
~~~

Run all five tests again. Expected: PASS, then include the reader, writer, both adapters, all five tests, exact catalog/registry producers, executor, and registration paths in this task's explicit-path commit.

- [ ] **Step 1: Add failing catalog and multi-brain outcome tests**

Update the research suite's `makeCtx()` with the same per-turn rule as Task 4: the requested client belongs to `turnRuntime.brainOperations`; the base context holds a distinct throwing sentinel; a supplied test controller determines `turnRuntime.abortController` and `turnRuntime.signal`. The cancellation test must pass the controller through this helper rather than constructing an incomplete runtime object. Assert at least once that the sentinel receives zero calls.

Extend `tests/agent/tools/research.test.ts`:

```ts
function canonicalResearch(id: string, displayName: string): BrainCatalogEntry {
  return { id, displayName, ownerAgent: 'jerry', kind: 'research', lifecycle: 'completed',
    canonicalRoot: `/tmp/${id}`, sourceType: 'local', nodeCount: 10,
    modifiedAt: '2026-07-09T12:00:00.000Z', route: `/api/brain/${id}`,
    mutationBoundaries: [
      { kind: 'brain', path: `/tmp/${id}` }, { kind: 'run', path: `/tmp/${id}` },
      { kind: 'pgs', path: `/tmp/${id}/pgs-sessions` }, { kind: 'session', path: `/tmp/${id}/sessions` },
      { kind: 'cache', path: `/tmp/${id}/cache` }, { kind: 'export', path: `/tmp/${id}/exports` },
      { kind: 'agency', path: `/tmp/${id}/agency` },
    ] };
}

function completeOperation(
  operationId: string,
  answer: string,
  extraResult: Record<string, unknown> = {},
): BrainOperationResult {
  return makeBrainOperationRecord({
    operationId, state: 'complete', phase: 'done',
    target: canonicalResearchTarget('brain-r1'),
    result: { answer, ...extraResult },
    resultHandle: 'brres_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'matches' },
    attachmentState: 'closed',
  });
}

function failedOperation(operationId: string, code: string): BrainOperationResult {
  return { ...completeOperation(operationId, ''), state: 'failed', result: null, resultHandle: null,
    error: { code, message: `${code} fixture`, retryable: true },
    sourceEvidence: { sourceHealth: 'unavailable', matchOutcome: 'unknown' } };
}

test('research_list_brains renders canonical catalog fields', async () => {
  const result = await listBrainsTool.execute({}, makeCtx({ brainOperations: {
    getCatalog: async () => ({ catalogRevision: 'catalog-7', brains: [{
      id: 'brain-r1', displayName: 'Research One', ownerAgent: 'jerry', kind: 'research',
      lifecycle: 'completed', canonicalRoot: '/tmp/r1', sourceType: 'local', nodeCount: 42,
      modifiedAt: '2026-07-09T12:00:00.000Z', route: '/api/brain/brain-r1',
      mutationBoundaries: [
        { kind: 'brain', path: '/tmp/r1' }, { kind: 'run', path: '/tmp/r1' },
        { kind: 'pgs', path: '/tmp/r1/pgs-sessions' }, { kind: 'session', path: '/tmp/r1/sessions' },
        { kind: 'cache', path: '/tmp/r1/cache' }, { kind: 'export', path: '/tmp/r1/exports' },
        { kind: 'agency', path: '/tmp/r1/agency' },
      ],
    }] }),
  } }));
  assert.match(result.content, /Research One/);
  assert.match(result.content, /42 nodes/);
  assert.match(result.content, /completed/);
  assert.match(result.content, /catalog-7/);
});

test('research_search_all_brains reports one outcome per target and never hides failures', async () => {
  const ctx = makeCtx({ brainOperations: {
    getCatalog: async () => ({ catalogRevision: 'c1', brains: [
      canonicalResearch('brain-a', 'A'), canonicalResearch('brain-b', 'B'),
    ] }),
    query: async (request: Record<string, unknown>) => {
      const target = request.target as { brainId?: string } | undefined;
      return target?.brainId === 'brain-a'
        ? completeOperation('op-a', 'A found evidence')
        : failedOperation('op-b', 'provider_failed');
    },
  } });
  const result = await searchAllBrainsTool.execute({ query: 'evidence', topN: 2 }, ctx);
  assert.match(result.content, /A found evidence/);
  assert.match(result.content, /brain-b.*provider_failed/is);
  assert.match(result.content, /partial/i);
  assert.doesNotMatch(result.content, /no relevant findings/i);
  const outcomes = result.metadata?.outcomes as Array<Record<string, unknown>>;
  assert.equal(outcomes[0]?.operationId, 'op-a');
  assert.equal(outcomes[0]?.resultHandle, 'brres_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(outcomes[0]?.catalogRevision, 'c1');
  assert.deepEqual(outcomes[0]?.sourceEvidence, { sourceHealth: 'healthy', matchOutcome: 'matches' });
});

test('research query reuses the shared direct-query partial classifier', async () => {
  const valid = completeOperation('op-research-partial', 'useful research answer');
  valid.operationType = 'query'; valid.state = 'partial';
  valid.error = { code: 'provider_incomplete', message: 'ended early', retryable: true };
  const ctx = makeCtx({ brainOperations: { query: async () => valid } });
  const useful = await queryBrainTool.execute({ brainId: 'brain-r1', query: 'x' }, ctx);
  assert.equal(useful.is_error, undefined);
  assert.equal(useful.metadata?.classification, 'useful_partial');
  assert.match(useful.content, /useful research answer/);
  assert.match(useful.content, /provider_incomplete/);

  valid.result = { answer: '' };
  const invalid = await queryBrainTool.execute({ brainId: 'brain-r1', query: 'x' }, ctx);
  assert.equal(invalid.is_error, true);
  assert.equal(invalid.metadata?.classification, 'invalid_partial_result');
});

test('research query separates direct and PGS parameters and rejects present-null pairs', async () => {
  const requests: Record<string, unknown>[] = [];
  const ctx = makeCtx({ brainOperations: { query: async (request: Record<string, unknown>) => {
    requests.push(request); return completeOperation('op-query-shape', 'ok');
  } } });
  await queryBrainTool.execute({ brainId: 'brain-r1', query: 'direct' }, ctx);
  assert.deepEqual(requests[0], {
    target: { brainId: 'brain-r1' }, query: 'direct', mode: 'quick', enablePGS: false,
  });
  await queryBrainTool.execute({ brainId: 'brain-r1', query: 'pgs', enablePGS: true,
    pgsConfig: { sweepFraction: 0.25 } }, ctx);
  assert.deepEqual(requests[1], { target: { brainId: 'brain-r1' }, query: 'pgs',
    mode: 'quick', enablePGS: true, pgsMode: 'full', pgsConfig: { sweepFraction: 0.25 } });
  for (const invalid of [
    { brainId: 'brain-r1', query: 'x', modelSelection: null },
    { brainId: 'brain-r1', query: 'x', enablePGS: true, pgsSweep: null },
    { brainId: 'brain-r1', query: 'x', enablePGS: true, pgsSynth: null },
    { brainId: 'brain-r1', query: 'x', enablePGS: true, pgsConfig: null },
  ]) {
    const before = requests.length;
    const result = await queryBrainTool.execute(invalid, ctx);
    assert.equal(result.is_error, true);
    assert.equal(requests.length, before);
  }
});

test('search-all forwards exact Direct Query and PGS provider shapes to every selected brain', async () => {
  const requests: Record<string, unknown>[] = [];
  const ctx = makeCtx({ brainOperations: {
    getCatalog: async () => ({ catalogRevision: 'pair-catalog', brains: [
      canonicalResearch('brain-a', 'A'), canonicalResearch('brain-b', 'B'),
    ] }),
    query: async (request: Record<string, unknown>) => {
      requests.push(request); return completeOperation(`op-${requests.length}`, 'ok');
    },
  } });
  await searchAllBrainsTool.execute({ query: 'x', topN: 2, enablePGS: true,
    pgsConfig: { sweepFraction: 0.25 },
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    pgsSynth: { provider: 'anthropic', model: 'claude-sonnet-4-7' } }, ctx);
  assert.equal(requests.length, 2);
  for (const request of requests) assert.deepEqual({ ...request, target: undefined }, {
    target: undefined, query: 'x', mode: 'quick', enablePGS: true, pgsMode: 'full',
    pgsConfig: { sweepFraction: 0.25 },
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    pgsSynth: { provider: 'anthropic', model: 'claude-sonnet-4-7' },
  });
  requests.length = 0;
  await searchAllBrainsTool.execute({ query: 'direct', topN: 2,
    modelSelection: { provider: 'xai', model: 'grok-4' } }, ctx);
  assert.equal(requests.length, 2);
  for (const request of requests) assert.deepEqual({ ...request, target: undefined }, {
    target: undefined, query: 'direct', mode: 'quick', enablePGS: false,
    modelSelection: { provider: 'xai', model: 'grok-4' },
  });
  for (const invalid of [
    { query: 'x', modelSelection: null },
    { query: 'x', modelSelection: { provider: 'xai' } },
    { query: 'x', modelSelection: { model: 'grok-4' } },
    { query: 'x', enablePGS: true, pgsSweep: null },
    { query: 'x', enablePGS: true, pgsSweep: { provider: 'minimax' } },
    { query: 'x', enablePGS: true, pgsSweep: { model: 'MiniMax-M3' } },
    { query: 'x', enablePGS: true, pgsSynth: null },
    { query: 'x', enablePGS: true, pgsSynth: { provider: 'anthropic' } },
    { query: 'x', enablePGS: true, pgsSynth: { model: 'claude-sonnet-4-7' } },
    { query: 'x', enablePGS: true, pgsConfig: null },
  ]) {
    const before = requests.length;
    const result = await searchAllBrainsTool.execute(invalid, ctx);
    assert.equal(result.is_error, true);
    assert.equal(requests.length, before);
  }
});
```

- [ ] **Step 2: Run and verify RED**

```bash
node --import tsx --test --test-concurrency=1 tests/agent/tools/research.test.ts
```

Expected: catalog field test fails because current tool reads obsolete `source/updatedAt`; multi-brain test fails because current code uses global fetch, sequential deadlines, and silently drops failures.

- [ ] **Step 3: Add the remaining cursor, stop, graph-limit, compile-section, and all-failed tests**

Append these before editing `research.ts`:

```ts
test('research_watch_run round-trips cursor 847 unchanged', async () => {
  let afterSeen: number | null = null;
  let runSeen: string | null = null;
  const ctx = makeCtx({ brainOperations: { watchResearch: async (request: {
    after: number; target: { runId: string };
  }) => {
    afterSeen = request.after;
    runSeen = request.target.runId;
    return { latest: 847, logs: [], active: true };
  } } });
  const first = await watchRunTool.execute({ runId: 'run-owned', after: 0 }, ctx);
  assert.match(first.content, /Cursor:\*\* 847/);
  await watchRunTool.execute({ runId: 'run-owned', after: 847 }, ctx);
  assert.equal(afterSeen, 847);
  assert.equal(runSeen, 'run-owned');
});

test('research_get_brain_graph sends server-side limits', async () => {
  let request: Record<string, unknown> | null = null;
  await getBrainGraphTool.execute({ brainId: 'brain-a', limit: 40 }, makeCtx({
    brainOperations: { graph: async (value: Record<string, unknown>) => {
      request = value;
      return { nodes: [], edges: [], clusters: [], meta: { nodeCount: 5000, edgeCount: 9000 } };
    } },
  }));
  assert.equal(request?.nodeLimit, 40);
  assert.equal(request?.edgeLimit, 80);
});

test('research_compile_section sends the exact section selector and requester path', async () => {
  let request: Record<string, unknown> | null = null;
  const ctx = makeCtx({ workspacePath: '/tmp/requester/workspace', brainOperations: {
    compile: async (value: Record<string, unknown>) => {
      request = value;
      return completeOperation('op-compile', 'compiled section', {
        path: '/tmp/requester/workspace/research/section.md',
      });
    },
  } });
  const result = await compileSectionTool.execute({
    brainId: 'brain-a', section: 'goal', sectionId: 'goal-7', focus: 'facts only',
  }, ctx);
  assert.equal(request?.kind, 'section');
  assert.equal(request?.section, 'goal');
  assert.equal(request?.sectionId, 'goal-7');
  assert.match(result.content, /\/tmp\/requester\/workspace\/research\/section\.md/);
});

test('research_stop forwards the canonical run selector and renders durable terminal shutdown', async () => {
  let request: Record<string, unknown> | null = null;
  const result = await stopRunTool.execute({ runId: 'run-owned' }, makeCtx({ brainOperations: {
    stopResearch: async (value: Record<string, unknown>) => {
      request = value;
      return completeOperation('op-stop', 'stopped');
    },
  } }));
  assert.deepEqual(request?.target, { runId: 'run-owned' });
  assert.match(result.content, /stopped/);
  assert.doesNotMatch(result.content, /30 second|timed out/i);
});

test('research_continue forwards only the exact canonical run target', async () => {
  let request: Record<string, unknown> | null = null;
  await continueRunTool.execute({ runId: 'run-owned', context: 'resume' }, makeCtx({ brainOperations: {
    continueResearch: async (value: Record<string, unknown>) => {
      request = value;
      return completeOperation('op-continue', 'continued');
    },
  } }));
  assert.deepEqual(request?.target, { runId: 'run-owned' });
  assert.equal('brainId' in (request || {}), false);
});

test('research_search_all_brains reports all_failed with every error code', async () => {
  const ctx = makeCtx({ brainOperations: {
    getCatalog: async () => ({ catalogRevision: 'c2', brains: [
      canonicalResearch('brain-a', 'A'), canonicalResearch('brain-b', 'B'),
    ] }),
    query: async (request: Record<string, unknown>) => {
      const target = request.target as { brainId?: string } | undefined;
      return target?.brainId === 'brain-a'
        ? failedOperation('op-a', 'source_unavailable')
        : failedOperation('op-b', 'provider_failed');
    },
  } });
  const result = await searchAllBrainsTool.execute({ query: 'missing evidence', topN: 2 }, ctx);
  assert.match(result.content, /all_failed/);
  assert.match(result.content, /source_unavailable/);
  assert.match(result.content, /provider_failed/);
  assert.equal(result.is_error, true);
  assert.doesNotMatch(result.content, /no relevant findings|launch new research/i);
});

test('research launch and continue preserve every existing approved option', async () => {
  let launched: Record<string, unknown> | null = null; let continued: Record<string, unknown> | null = null;
  const ctx = makeCtx({ brainOperations: {
    launchResearch: async (request: Record<string, unknown>) => {
      launched = request; return completeOperation('op-launch', 'launched');
    },
    continueResearch: async (request: Record<string, unknown>) => {
      continued = request; return completeOperation('op-continue', 'continued');
    },
  } });
  const options = { topic: 't', context: 'c', cycles: 4, explorationMode: 'autonomous',
    analysisDepth: 'deep', maxConcurrent: 2, primaryModel: 'm1', primaryProvider: 'p1',
    fastModel: 'm2', fastProvider: 'p2', strategicModel: 'm3', strategicProvider: 'p3' };
  await launchTool.execute(options, ctx);
  assert.deepEqual(launched, options);
  await continueRunTool.execute({ runId: 'run-owned', context: 'more' }, ctx);
  assert.deepEqual(continued, { target: { runId: 'run-owned' }, context: 'more' });
  for (const invalid of [
    { ...options, cycles: Infinity }, { ...options, maxConcurrent: 1.5 },
    { ...options, analysisDepth: 3 }, { ...options, explorationMode: 'broad' },
    { ...options, primaryProvider: null }, { ...options, owner: 'forrest' },
    { ...options, runRoot: '/tmp/escape' }, { ...options, enableWebSearch: false },
    { ...options, enableDebate: true }, { ...options, enableSynthesis: true },
    { topic: 't', primaryModel: 'duplicate-label' },
    { topic: 't', primaryProvider: 'provider-only' },
    { topic: 't', fastModel: 'duplicate-label' },
    { topic: 't', strategicProvider: 'provider-only' },
    { ...options, unknown: true },
  ]) {
    const before = launched;
    const result = await launchTool.execute(invalid, ctx);
    assert.equal(result.is_error, true);
    assert.equal(launched, before);
  }
  for (const invalid of [
    { runId: 'run-owned', primaryModel: 'duplicate-label' },
    { runId: 'run-owned', primaryProvider: 'provider-only' },
  ]) {
    const before = continued;
    const result = await continueRunTool.execute(invalid, ctx);
    assert.equal(result.is_error, true);
    assert.equal(continued, before);
  }
});

test('continue stop and watch reject noncanonical run selectors before any client call', async () => {
  let calls = 0;
  const ctx = makeCtx({ brainOperations: {
    continueResearch: async () => { calls += 1; return completeOperation('bad', 'bad'); },
    stopResearch: async () => { calls += 1; return completeOperation('bad', 'bad'); },
    watchResearch: async () => { calls += 1; return { latest: 0, logs: [] }; },
  } });
  const tools = [continueRunTool, stopRunTool, watchRunTool];
  for (const tool of tools) {
    for (const invalid of [{}, { runId: null }, { runId: {} }, { runId: '*' },
      { runId: '   ' }, { runId: 'run-ok', brainId: 'brain-alias' }]) {
      const result = await tool.execute(invalid as never, ctx);
      assert.equal(result.is_error, true);
      assert.equal(calls, 0);
    }
  }
});

test('search-all selects only capped eligible completed research targets with bounded provenance', async () => {
  const completed = Array.from({ length: 25 }, (_, index) => ({
    ...canonicalResearch(`brain-${String(index).padStart(2, '0')}`, `Brain ${index}`),
    modifiedAt: `2026-07-${String((index % 9) + 1).padStart(2, '0')}T12:00:00.000Z`,
  })).reverse();
  const gate = deferred<void>(); const threeStarted = deferred<void>();
  let active = 0; let peak = 0; const selected: string[] = [];
  const pending = searchAllBrainsTool.execute({ query: 'evidence', topN: 20 }, makeCtx({ brainOperations: {
    getCatalog: async () => ({ catalogRevision: 'catalog-bounded', brains: [
      { ...canonicalResearch('resident', 'Resident'), kind: 'resident', lifecycle: 'resident' },
      { ...canonicalResearch('active', 'Active'), lifecycle: 'active' },
      { ...canonicalResearch('unavailable', 'Unavailable'), lifecycle: 'unavailable' }, ...completed,
    ] }),
    query: async (request: Record<string, unknown>) => {
      const id = (request.target as { brainId: string }).brainId; selected.push(id);
      active += 1; peak = Math.max(peak, active); if (selected.length === 3) threeStarted.resolve();
      await gate.promise; active -= 1;
      return completeOperation(`op-${id}`, 'x'.repeat(10_000));
    },
  } }));
  await threeStarted.promise; assert.equal(peak, 3); gate.resolve();
  const result = await pending;
  assert.equal(selected.length, 20);
  assert.equal(selected.includes('resident'), false);
  assert.equal(selected.includes('active'), false);
  assert.equal(selected.includes('unavailable'), false);
  const outcomes = result.metadata?.outcomes as Array<Record<string, unknown>>;
  assert.equal(outcomes.length, 20);
  assert.equal(outcomes.every((row) => row.operationId && row.resultHandle && row.sourceEvidence), true);
  assert.equal(JSON.stringify(outcomes).includes('x'.repeat(1_000)), false);
});

test('search-all with no completed research targets is an explicit no_eligible_targets error', async () => {
  const result = await searchAllBrainsTool.execute({ query: 'x' }, makeCtx({ brainOperations: {
    getCatalog: async () => ({ catalogRevision: 'empty-catalog', brains: [
      { ...canonicalResearch('active', 'Active'), lifecycle: 'active' },
    ] }),
  } }));
  assert.equal(result.is_error, true);
  assert.match(result.content, /no_eligible_targets/);
  assert.equal(result.metadata?.catalogRevision, 'empty-catalog');
  assert.equal(result.metadata?.selectedCount, 0);
});

test('search-all cancellation stops after three claimed targets and preserves exact abort identity', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('turn_cancelled'), { code: 'turn_cancelled' });
  const threeStarted = deferred<void>(); const seenSignals: AbortSignal[] = [];
  const selected: string[] = []; const caught: unknown[] = [];
  const pending = searchAllBrainsTool.execute({ query: 'x', topN: 20 }, makeCtx({
    turnAbortController: controller, brainOperations: {
      getCatalog: async () => ({ catalogRevision: 'cancel-catalog', brains: Array.from(
        { length: 20 }, (_, index) => canonicalResearch(`brain-${index}`, `Brain ${index}`)) }),
      query: async (request: Record<string, unknown>, signal: AbortSignal) => {
        selected.push((request.target as { brainId: string }).brainId); seenSignals.push(signal);
        if (selected.length === 3) threeStarted.resolve();
        try { await new Promise((_, reject) => signal.addEventListener('abort',
          () => reject(signal.reason), { once: true })); } catch (error) { caught.push(error); throw error; }
        throw new Error('unreachable');
      },
    } }));
  await threeStarted.promise; controller.abort(reason);
  const result = await pending;
  assert.equal(result.is_error, true);
  assert.match(result.content, /turn_cancelled/);
  assert.equal(selected.length, 3);
  assert.equal(seenSignals.every((signal) => signal === controller.signal), true);
  assert.equal(caught.length, 3);
  assert.equal(caught.every((error) => error === reason), true);
});
```

- [ ] **Step 4: Run the complete research-tool suite and verify RED**

```bash
node --import tsx --test --test-concurrency=1 tests/agent/tools/research.test.ts
```

Expected: catalog, multi-brain outcome, cursor, graph-limit, exact-section, exact continue/stop run target, durable-stop, and all-failed tests are RED. Capture this output before changing `research.ts`.

- [ ] **Step 5: Replace independent fetch plumbing with the shared client**

Delete `getCosmoBase()`, `fetchJson()`, and all raw fetch calls from `research.ts`. Add these executable helpers, then assign the named functions to the eleven existing `ToolDefinition.execute` fields:

```ts
import { operationToolResult, recoverableExcerpt } from '../tool-result.js';

const SEARCH_ALL_MAX_TARGETS = 20;
const SEARCH_ALL_CONCURRENCY = 3;

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

async function boundedMap<T, R>(items: T[], concurrency: number, signal: AbortSignal,
  run: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      throwIfAborted(signal);
      if (cursor >= items.length) return;
      const index = cursor++;
      const value = await run(items[index]!);
      throwIfAborted(signal);
      output[index] = value;
    }
  });
  await Promise.all(workers);
  return output;
}

function researchError(error: unknown): { code: string; message: string } {
  return {
    code: typeof error === 'object' && error && 'code' in error
      ? String((error as { code: unknown }).code) : 'research_operation_failed',
    message: error instanceof Error ? error.message : String(error),
  };
}

async function executeListBrains(_input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    const catalog = await ctx.turnRuntime!.brainOperations.getCatalog();
    const limit = optionalFiniteInteger(_input.limit, 'limit', 1, 100) ?? 20;
    const includeReferences = _input.includeReferences !== false;
    const selected = catalog.brains
      .filter((brain) => includeReferences || brain.sourceType === 'local')
      .slice(0, limit);
    const lines = selected.map((brain) =>
      `${brain.displayName} (${brain.id}) — ${brain.lifecycle} — ${brain.nodeCount ?? '?'} nodes`);
    return { content: `Catalog ${catalog.catalogRevision}\n${lines.join('\n')}` };
  } catch (error) { const e = researchError(error); return { content: `${e.code}: ${e.message}`, is_error: true }; }
}

function exactPgsConfig(value: unknown): { sweepFraction?: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_request');
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'sweepFraction')) throw new Error('invalid_request');
  if (!hasOwn(value as Record<string, unknown>, 'sweepFraction')) return {};
  const sweepFraction = (value as { sweepFraction?: unknown }).sweepFraction;
  if (typeof sweepFraction !== 'number' || !Number.isFinite(sweepFraction)
      || sweepFraction <= 0 || sweepFraction > 1) throw new Error('invalid_request');
  return { sweepFraction };
}

function researchQueryParameters(input: Record<string, unknown>): Record<string, unknown> {
  const enablePGS = optionalBoolean(input.enablePGS, 'enablePGS') ?? false;
  const request: Record<string, unknown> = {
    query: requiredBoundedText(input.query, 'query', 12_000),
    mode: optionalEnum(input.mode, 'mode', ['quick','full','expert','dive'] as const) ?? 'quick',
    enablePGS,
  };
  if (enablePGS) {
    if (hasOwn(input, 'modelSelection')) throw new Error('invalid_request');
    request.pgsMode = 'full';
    if (hasOwn(input, 'pgsConfig')) request.pgsConfig = exactPgsConfig(input.pgsConfig);
    if (hasOwn(input, 'pgsSweep')) request.pgsSweep = exactProviderModelPair(input.pgsSweep, 'pgsSweep');
    if (hasOwn(input, 'pgsSynth')) request.pgsSynth = exactProviderModelPair(input.pgsSynth, 'pgsSynth');
  } else {
    if (hasOwn(input, 'pgsConfig') || hasOwn(input, 'pgsSweep') || hasOwn(input, 'pgsSynth')) {
      throw new Error('invalid_request');
    }
    if (hasOwn(input, 'modelSelection')) {
      request.modelSelection = exactProviderModelPair(input.modelSelection, 'modelSelection');
    }
  }
  return request;
}

async function executeQueryBrain(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    const allowed = new Set(['brainId','query','mode','enablePGS','modelSelection',
      'pgsConfig','pgsSweep','pgsSynth']);
    if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error('invalid_request');
    const brainId = requiredBoundedText(input.brainId, 'brainId', 128);
    return operationToolResult(await ctx.turnRuntime!.brainOperations.query({
      target: { brainId }, ...researchQueryParameters(input),
    }, ctx.turnRuntime!.signal));
  } catch (error) { const e = researchError(error); return { content: `${e.code}: ${e.message}`, is_error: true }; }
}

async function executeSearchAll(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
  const signal = ctx.turnRuntime!.signal; throwIfAborted(signal);
  const allowed = new Set(['query','mode','topN','enablePGS','modelSelection',
    'pgsConfig','pgsSweep','pgsSynth']);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error('invalid_request');
  const queryParameters = researchQueryParameters(input);
  const catalog = await ctx.turnRuntime!.brainOperations.getCatalog(); throwIfAborted(signal);
  const topN = optionalFiniteInteger(input.topN, 'topN', 1, SEARCH_ALL_MAX_TARGETS) ?? 5;
  const selected = catalog.brains
    .filter((brain) => brain.kind === 'research' && brain.lifecycle === 'completed')
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.id.localeCompare(b.id))
    .slice(0, topN);
  if (selected.length === 0) return { content: 'no_eligible_targets: catalog has no completed research brains',
    is_error: true, metadata: { aggregate: 'no_eligible_targets', catalogRevision: catalog.catalogRevision,
      selectedCount: 0, outcomes: [] } };
  const outcomes = await boundedMap(selected, SEARCH_ALL_CONCURRENCY, signal, async (brain) => {
    throwIfAborted(signal);
    try {
      const operation = await ctx.turnRuntime!.brainOperations.query({
        target: { brainId: brain.id }, ...queryParameters,
      }, signal);
      throwIfAborted(signal);
      const classified = operationToolResult(operation);
      const classification = String(classified.metadata?.classification || operation.state);
      const useful = classified.is_error !== true &&
        (operation.state === 'complete' || classification === 'useful_partial');
      return { brainId: brain.id, displayName: brain.displayName,
        catalogRevision: catalog.catalogRevision, state: operation.state,
        classification, useful,
        operationId: operation.operationId, resultHandle: operation.resultHandle,
        sourceEvidence: operation.sourceEvidence, error: operation.error,
        excerpt: recoverableExcerpt(classified.content, 4_000, {
          operationId: operation.operationId, resultHandle: operation.resultHandle,
        }) };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      return { brainId: brain.id, displayName: brain.displayName,
        catalogRevision: catalog.catalogRevision, state: 'failed', operationId: null,
        classification: 'failed', useful: false,
        resultHandle: null, sourceEvidence: null, error: researchError(error), excerpt: '' };
    }
  });
  const useful = outcomes.filter((item) => item.useful).length;
  const aggregate = useful === outcomes.length && outcomes.every((item) => item.state === 'complete')
    ? 'complete' : useful > 0 ? 'partial' : 'all_failed';
  return { content: `${aggregate}\n${outcomes.map((item) =>
    `${item.brainId}: ${item.state}: ${item.excerpt || item.error?.code || 'no answer'}`).join('\n')}`,
    is_error: aggregate === 'all_failed' || undefined,
    metadata: { aggregate, selectedCount: selected.length,
      outcomes: outcomes.map(({ excerpt: _displayOnly, useful: _internal, ...provenance }) => provenance) } };
  } catch (error) {
    const e = researchError(error); return { content: `${e.code}: ${e.message}`, is_error: true,
      metadata: { code: e.code } };
  }
}

function approvedLaunchOptions(input: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set(['topic','context','cycles','explorationMode','analysisDepth',
    'maxConcurrent','primaryModel','primaryProvider','fastModel','fastProvider',
    'strategicModel','strategicProvider']);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error('invalid_request');
  if (typeof input.topic !== 'string' || !input.topic.trim() || input.topic.length > 12_000) {
    throw new Error('invalid_request');
  }
  const output: Record<string, unknown> = { topic: input.topic };
  if (input.context !== undefined) {
    if (typeof input.context !== 'string' || !input.context.trim() || input.context.length > 20_000) {
      throw new Error('invalid_request');
    }
    output.context = input.context;
  }
  if (input.explorationMode !== undefined) {
    if (input.explorationMode !== 'guided' && input.explorationMode !== 'autonomous') {
      throw new Error('invalid_request');
    }
    output.explorationMode = input.explorationMode;
  }
  if (input.analysisDepth !== undefined) {
    if (input.analysisDepth !== 'shallow' && input.analysisDepth !== 'normal'
        && input.analysisDepth !== 'deep') throw new Error('invalid_request');
    output.analysisDepth = input.analysisDepth;
  }
  for (const key of ['cycles','maxConcurrent'] as const) {
    if (input[key] !== undefined) output[key] = optionalFiniteInteger(input[key], key, 1,
      key === 'cycles' ? 10_000 : 64);
  }
  copyExactProviderOverride(input, output, 'primaryModel', 'primaryProvider');
  copyExactProviderOverride(input, output, 'fastModel', 'fastProvider');
  copyExactProviderOverride(input, output, 'strategicModel', 'strategicProvider');
  return output;
}

function copyExactProviderOverride(input: Record<string, unknown>, output: Record<string, unknown>,
  modelKey: string, providerKey: string): void {
  const hasModel = hasOwn(input, modelKey);
  const hasProvider = hasOwn(input, providerKey);
  if (hasModel !== hasProvider) throw new Error('invalid_request');
  if (!hasModel) return;
  if (typeof input[modelKey] !== 'string' || !(input[modelKey] as string).trim()
      || typeof input[providerKey] !== 'string' || !(input[providerKey] as string).trim()) {
    throw new Error('invalid_request');
  }
  output[modelKey] = input[modelKey];
  output[providerKey] = input[providerKey];
}

function approvedContinueOptions(input: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set(['runId','context','cycles','primaryModel','primaryProvider']);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error('invalid_request');
  if (typeof input.runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.runId)) {
    throw new Error('invalid_request');
  }
  const output: Record<string, unknown> = {};
  if (input.context !== undefined) {
    if (typeof input.context !== 'string' || !input.context.trim() || input.context.length > 20_000) {
      throw new Error('invalid_request');
    }
    output.context = input.context;
  }
  if (input.cycles !== undefined) output.cycles = optionalFiniteInteger(input.cycles, 'cycles', 1, 10_000);
  copyExactProviderOverride(input, output, 'primaryModel', 'primaryProvider');
  return output;
}

function exactRunId(input: Record<string, unknown>, allowedKeys: ReadonlySet<string>): string {
  if (Object.keys(input).some((key) => !allowedKeys.has(key))
      || !hasOwn(input, 'runId') || typeof input.runId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.runId)) {
    throw new Error('invalid_request');
  }
  return input.runId;
}

async function executeLaunch(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try { return operationToolResult(await ctx.turnRuntime!.brainOperations.launchResearch(
    approvedLaunchOptions(input), ctx.turnRuntime!.signal)); }
  catch (error) { const e = researchError(error); return { content: `${e.code}: ${e.message}`, is_error: true }; }
}

async function executeContinue(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try { const options = approvedContinueOptions(input); const runId = exactRunId(input,
    new Set(['runId','context','cycles','primaryModel','primaryProvider']));
    return operationToolResult(await ctx.turnRuntime!.brainOperations.continueResearch({
    target: { runId }, ...options,
  }, ctx.turnRuntime!.signal)); }
  catch (error) { const e = researchError(error); return { content: `${e.code}: ${e.message}`, is_error: true }; }
}

async function executeStop(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try { const runId = exactRunId(input, new Set(['runId']));
    return operationToolResult(await ctx.turnRuntime!.brainOperations.stopResearch({
    target: { runId },
  }, ctx.turnRuntime!.signal)); }
  catch (error) { const e = researchError(error); return { content: `${e.code}: ${e.message}`, is_error: true }; }
}

async function executeWatch(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    const runId = exactRunId(input, new Set(['runId','after','limit','filter']));
    const value = await ctx.turnRuntime!.brainOperations.watchResearch({
      target: { runId },
      after: optionalFiniteInteger(input.after, 'after', 0, Number.MAX_SAFE_INTEGER) ?? 0,
      limit: optionalFiniteInteger(input.limit, 'limit', 1, 500),
      ...(hasOwn(input, 'filter')
        ? { filter: requiredBoundedText(input.filter, 'filter', 256) } : {}),
    }, ctx.turnRuntime!.signal);
    return { content: `**Cursor:** ${value.latest}\n${JSON.stringify(value.logs || [], null, 2)}` };
  } catch (error) { const e = researchError(error); return { content: `${e.code}: ${e.message}`, is_error: true }; }
}

async function executeSummary(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try { return { content: JSON.stringify(await ctx.turnRuntime!.brainOperations.readIntelligence({
    target: { brainId: requiredBoundedText(input.brainId, 'brainId', 128) }, include: input.include,
  }, ctx.turnRuntime!.signal), null, 2) }; }
  catch (error) { const e = researchError(error); return { content: `${e.code}: ${e.message}`, is_error: true }; }
}

async function executeGraph(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const nodeLimit = optionalFiniteInteger(input.limit, 'limit', 1, 2_000) ?? 250;
  try { return { content: JSON.stringify(await ctx.turnRuntime!.brainOperations.graph({
    target: { brainId: requiredBoundedText(input.brainId, 'brainId', 128) }, nodeLimit,
    edgeLimit: Math.min(8_000, nodeLimit * 2), clusterId: input.clusterId,
    minWeight: input.minWeight,
  }, ctx.turnRuntime!.signal), null, 2) }; }
  catch (error) { const e = researchError(error); return { content: `${e.code}: ${e.message}`, is_error: true }; }
}

async function executeCompileBrain(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try { return operationToolResult(await ctx.turnRuntime!.brainOperations.compile({
    target: { brainId: requiredBoundedText(input.brainId, 'brainId', 128) }, kind: 'brain', focus: input.focus,
  }, ctx.turnRuntime!.signal)); }
  catch (error) { const e = researchError(error); return { content: `${e.code}: ${e.message}`, is_error: true }; }
}

async function executeCompileSection(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try { return operationToolResult(await ctx.turnRuntime!.brainOperations.compile({
    target: { brainId: requiredBoundedText(input.brainId, 'brainId', 128) }, kind: 'section',
    section: input.section, sectionId: input.sectionId, focus: input.focus,
  }, ctx.turnRuntime!.signal)); }
  catch (error) { const e = researchError(error); return { content: `${e.code}: ${e.message}`, is_error: true }; }
}
```

Use `executeListBrains`, `executeQueryBrain`, `executeSearchAll`, `executeLaunch`, `executeContinue`, `executeStop`, `executeWatch`, `executeSummary`, `executeGraph`, `executeCompileBrain`, and `executeCompileSection` directly. No adapter forwards `owner: ctx.agentName`; the dashboard derives requester identity, and the per-brain callback converts every rejection into an explicit failed outcome.

Preserve the existing public research launch surface exactly: `topic`, `context`, `cycles`, `explorationMode`, `analysisDepth`, `maxConcurrent`, `primaryModel`/`primaryProvider`, `fastModel`/`fastProvider`, and `strategicModel`/`strategicProvider`. Preserve the current launcher's trusted internal `enableWebSearch:true`, `enableCodingAgents:false`, `enableAgentRouting:true`, and `enableMemoryGovernance:true` defaults in executor parameters, but do not add them—or invented `enableDebate`/`enableSynthesis` fields—to the public tool schema. Continue preserves its existing context/cycles/primary override behavior but changes identity from ambiguous `brainId` to canonical `runId`; omitted overrides remain omitted so canonical run settings are reused. Set `additionalProperties:false` on every research schema and nested object, use the shared strict validators, and never coerce/default a present invalid value.

`research_query_brain` and search-all use only the Plan A nested query/PGS provider pairs. Search-all filters to eligible `kind:'research',lifecycle:'completed'` catalog rows, sorts deterministically, caps `topN` at `SEARCH_ALL_MAX_TARGETS`, and limits concurrency. Every selected target produces one outcome carrying catalog revision, target identity, operation ID, state/error, result handle, and source evidence. Aggregate display uses `recoverableExcerpt`; aggregate metadata never duplicates full answers. `all_failed` is an error, `partial` remains useful but visibly incomplete, and neither may say no findings.

Make non-empty `runId` required in the schemas for `research_continue`, `research_stop`, and `research_watch_run`; remove any `brainId` alias from those schemas. Each adapter must map it to the operation target exactly as `{target:{runId}}`. Add schema, client, route, and tool tests proving exact forwarding and rejecting omission, wildcard, empty ID, extra target fields, `brainId`, ambiguous/missing canonical owner metadata, and a different owner before process-manager invocation.

- [ ] **Step 6: Stop automatic agency mutation on read tools**

Delete `assimilateResearchOutput()` and its four read-call sites. Delete the local `writeWorkspaceFile()` helper: compile bytes and paths now come only from the requester-authorized durable `research_compile` backend. Add this source assertion before deleting them, run it RED, then keep it as a regression:

```ts
test('read-only research adapters contain no agency assimilation or local workspace writes', () => {
  const source = readFileSync(new URL('../../../src/agent/tools/research.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /assimilateResearchOutput/);
  assert.doesNotMatch(source, /writeWorkspaceFile/);
  assert.doesNotMatch(source, /process\.env|process\.cwd\(\)/);
});
```

- [ ] **Step 7: Implement exact cursor/section/result behavior**

Wire the Step 3 functions into the definitions exactly:

```ts
listBrainsTool.execute = executeListBrains;
queryBrainTool.execute = executeQueryBrain;
searchAllBrainsTool.execute = executeSearchAll;
launchTool.execute = executeLaunch;
continueRunTool.execute = executeContinue;
stopRunTool.execute = executeStop;
watchRunTool.execute = executeWatch;
getBrainSummaryTool.execute = executeSummary;
getBrainGraphTool.execute = executeGraph;
compileBrainTool.execute = executeCompileBrain;
compileSectionTool.execute = executeCompileSection;
```

If the exported definitions remain object literals, place each function name in its existing `execute:` property rather than assigning after declaration. Do not duplicate handler bodies.

- [ ] **Step 8: Update Step 16 design documentation**

Add a dated reliability addendum to `docs/design/STEP16-AGENT-COSMO-TOOLKIT-DESIGN.md` recording the shared client, canonical catalog fields, durable long operations, bounded concurrency, explicit per-brain outcomes, requester-owned compiles, and removal of automatic agency writes from read-only calls.

- [ ] **Step 9: Run focused tests and build**

```bash
node --test --test-concurrency=1 tests/cosmo23/research-run-operation-adapter.test.cjs tests/cosmo23/research-pinned-source-reader.test.cjs tests/cosmo23/research-requester-output-writer.test.cjs tests/cosmo23/research-compile-provider-adapter.test.cjs tests/cosmo23/research-operation-executors.test.cjs
node --import tsx --test --test-concurrency=1 tests/agent/tools/research.test.ts
npm run build
```

Expected: all research tests PASS; build PASS.

- [ ] **Step 10: Commit only research paths**

```bash
git diff --cached --quiet
git add -- cosmo23/server/lib/research-run-operation-adapter.js cosmo23/server/lib/research-pinned-source-reader.js cosmo23/server/lib/research-requester-output-writer.js cosmo23/server/lib/research-compile-provider-adapter.js cosmo23/server/lib/research-operation-executors.js cosmo23/server/config/model-catalog.js cosmo23/server/providers/registry.js cosmo23/server/index.js src/agent/tools/research.ts tests/cosmo23/research-run-operation-adapter.test.cjs tests/cosmo23/research-pinned-source-reader.test.cjs tests/cosmo23/research-requester-output-writer.test.cjs tests/cosmo23/research-compile-provider-adapter.test.cjs tests/cosmo23/research-operation-executors.test.cjs tests/agent/tools/research.test.ts docs/design/STEP16-AGENT-COSMO-TOOLKIT-DESIGN.md
git diff --cached --check
git diff --cached -- cosmo23/server/lib/research-run-operation-adapter.js cosmo23/server/lib/research-pinned-source-reader.js cosmo23/server/lib/research-requester-output-writer.js cosmo23/server/lib/research-compile-provider-adapter.js cosmo23/server/lib/research-operation-executors.js cosmo23/server/config/model-catalog.js cosmo23/server/providers/registry.js cosmo23/server/index.js src/agent/tools/research.ts tests/cosmo23/research-run-operation-adapter.test.cjs tests/cosmo23/research-pinned-source-reader.test.cjs tests/cosmo23/research-requester-output-writer.test.cjs tests/cosmo23/research-compile-provider-adapter.test.cjs tests/cosmo23/research-operation-executors.test.cjs tests/agent/tools/research.test.ts docs/design/STEP16-AGENT-COSMO-TOOLKIT-DESIGN.md
git commit --only cosmo23/server/lib/research-run-operation-adapter.js cosmo23/server/lib/research-pinned-source-reader.js cosmo23/server/lib/research-requester-output-writer.js cosmo23/server/lib/research-compile-provider-adapter.js cosmo23/server/lib/research-operation-executors.js cosmo23/server/config/model-catalog.js cosmo23/server/providers/registry.js cosmo23/server/index.js src/agent/tools/research.ts tests/cosmo23/research-run-operation-adapter.test.cjs tests/cosmo23/research-pinned-source-reader.test.cjs tests/cosmo23/research-requester-output-writer.test.cjs tests/cosmo23/research-compile-provider-adapter.test.cjs tests/cosmo23/research-operation-executors.test.cjs tests/agent/tools/research.test.ts docs/design/STEP16-AGENT-COSMO-TOOLKIT-DESIGN.md -m "fix: make research tools target aware and honest"
```

---

### Task 6: Move Automatic Context Retrieval and Compatibility Limits onto the Contract

**Files:**
- Create: `tests/agent/context-brain-retrieval.test.ts`
- Modify: `src/agent/context-assembly.ts:19-74, 288-375, 453-499`
- Modify: `src/agent/loop.ts:883-920`
- Modify: `tests/agent/context-worker-runs.test.ts:38-85`
- Create: `engine/src/dashboard/brain-operations/compatibility-adapter.js`
- Modify: `engine/src/dashboard/home23-query-api.js:6-11, 215-271, 306-405`
- Modify: `tests/contracts/query-facade-route.test.cjs:1-end`
- Modify: `contracts/schemas/query.schema.json:57-215`

**Interfaces:**
- Consumes: `BrainOperationsClient.search`, source-health/match-outcome evidence, coordinator limits, and requester-bound target resolution.
- Produces: truthful pre-turn memory posture and compatibility routes that cannot bypass target or size validation.

- [ ] **Step 1: Write failing automatic-retrieval tests**

Create `tests/agent/context-brain-retrieval.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleContext } from '../../src/agent/context-assembly.js';
import { deferred, flushMicrotasks } from '../helpers/manual-clock.js';

test('automatic retrieval sends topK and keeps local trigger matches when remote search fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'context-brain-'));
  const workspace = join(root, 'instances', 'jerry', 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'RECENT.md'), '# Recent\nLocal surface');
  let searchRequest: Record<string, unknown> | null = null;
  try {
    const result = await assembleContext('remember canary', 'chat-1', [], {
      workspacePath: workspace,
      brainDir: join(root, 'instances', 'jerry', 'brain'),
      enginePort: 5002,
      sessionId: 'chat-1',
      signal: AbortSignal.timeout(1_000),
      brainOperations: { search: async (request: Record<string, unknown>, signal: AbortSignal) => {
        searchRequest = request;
        assert.equal(signal.aborted, false);
        throw new Error('source_unavailable: dashboard memory route');
      } } as never,
      triggerIndex: { evaluate: () => [{
        memoryId: 'm1',
        memory: { title: 'Canary', statement: 'local trigger survives', confidence: { score: 0.9 } },
        trigger: { trigger_type: 'keyword', condition: 'canary' },
      }] } as never,
    });
    assert.equal(searchRequest?.topK, 8);
    assert.equal('limit' in (searchRequest || {}), false);
    assert.match(result.block, /local trigger survives/);
    assert.match(result.block, /dashboard memory route/);
    assert.doesNotMatch(result.block, /will succeed/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent context retrieval keeps per-turn clients, signals, and cancellation isolated', async () => {
  const root = mkdtempSync(join(tmpdir(), 'context-turns-'));
  const workspace = join(root, 'workspace'); mkdirSync(workspace, { recursive: true });
  const controllers = [new AbortController(), new AbortController()];
  const calls: Array<{ turn: number; signal: AbortSignal }> = [];
  const release = [deferred<Record<string, unknown>>(), deferred<Record<string, unknown>>()];
  try {
    const pending = controllers.map((controller, turn) => assembleContext(`turn ${turn}`, `chat-${turn}`, [], {
      workspacePath: workspace, brainDir: join(root, `brain-${turn}`), enginePort: 5002,
      sessionId: `chat-${turn}`, signal: controller.signal,
      brainOperations: { search: async (_request: Record<string, unknown>, signal: AbortSignal) => {
        calls.push({ turn, signal });
        return Promise.race([release[turn]!.promise, new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
      } } as never, triggerIndex: { evaluate: () => [] } as never,
    }));
    await flushMicrotasks();
    const reason = Object.assign(new Error('cancel turn zero'), { code: 'turn_cancelled' });
    controllers[0]!.abort(reason);
    release[1]!.resolve({ results: [{ id: 'turn-one-only' }],
      sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'matches' } });
    const [first, second] = await Promise.all(pending);
    assert.equal(calls[0]!.signal, controllers[0]!.signal);
    assert.equal(calls[1]!.signal, controllers[1]!.signal);
    assert.notEqual(calls[0]!.signal, calls[1]!.signal);
    assert.match(first.block, /turn_cancelled|cancel turn zero/);
    assert.match(second.block, /turn-one-only/);
    assert.equal(controllers[1]!.signal.aborted, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run and verify RED**

```bash
node --import tsx --test --test-concurrency=1 tests/agent/context-brain-retrieval.test.ts
```

Expected: FAIL because `AssemblyConfig` lacks `brainOperations`; current request uses `limit`; degraded output drops trigger text and promises direct calls will succeed.

- [ ] **Step 3: Inject the shared client and preserve independent evidence axes**

Extend `AssemblyConfig`:

```ts
brainOperations: Pick<BrainOperationsClient, 'search'>;
signal: AbortSignal;
```

Replace `searchBrain(query, enginePort)` with:

```ts
const retrieval = await config.brainOperations.search(
  { query: searchQuery, topK: BRAIN_SEARCH_LIMIT }, config.signal);
brainCues = Array.isArray(retrieval.results) ? retrieval.results as BrainSearchResult[] : [];
sourceHealth = String(retrieval.sourceEvidence?.sourceHealth || 'unavailable');
matchOutcome = String(retrieval.sourceEvidence?.matchOutcome || 'unknown');
```

Evaluate local triggers regardless of remote outcome. In degraded output, add trigger matches to `pieces`, state the exact failed route/error, and use: `Retry the operation or inspect brain_status; success is not yet established.` Remove the current claim that longer direct timeouts “will succeed.” Use `corpus_empty` only for `sourceHealth==='healthy' && matchOutcome==='corpus_empty'`; otherwise use `no_match`, `filtered`, `degraded`, or `unknown` exactly.

- [ ] **Step 4: Pass the client from AgentLoop**

At `src/agent/loop.ts` context assembly call, add:

```ts
brainOperations: runContext.turnRuntime!.brainOperations,
signal: runContext.turnRuntime!.signal,
```

The startup-global `this.toolContext.brainOperations` is forbidden at this call site. The immutable per-turn runtime created by `runWithTurn` is the only authority for retrieval client, activity callback, and cancellation signal; concurrent turns cannot renew or abort one another.

Change degraded logging from generic `brain unreachable` to the route/source state returned by assembly.

Update every direct `assembleContext()` fixture in `tests/agent/context-worker-runs.test.ts` with a healthy empty client stub:

```ts
brainOperations: {
  search: async (_request, signal) => ({
    results: [],
    sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'no_match' },
  }),
} as never,
signal: new AbortController().signal,
```

- [ ] **Step 5: Run automatic-retrieval tests and existing context tests**

```bash
node --import tsx --test --test-concurrency=1 tests/agent/context-brain-retrieval.test.ts tests/agent/context-worker-runs.test.ts
```

Expected: PASS.

- [ ] **Step 6: Add failing compatibility-limit and target-mismatch tests**

Append to `tests/contracts/query-facade-route.test.cjs`:

```js
const COMPAT_OPERATION_ID = 'brop_' + 'c'.repeat(32);

function canonicalCompatBoundaries(root) {
  return [
    { kind: 'brain', path: root }, { kind: 'run', path: root },
    { kind: 'pgs', path: `${root}/pgs-sessions` }, { kind: 'session', path: `${root}/sessions` },
    { kind: 'cache', path: `${root}/cache` }, { kind: 'export', path: `${root}/exports` },
    { kind: 'agency', path: `${root}/agency` },
  ];
}

function canonicalCompatRecord(overrides = {}) {
  return {
    operationId: COMPAT_OPERATION_ID, requestId: 'request-compat', operationType: 'query',
    requestParameters: { query: 'x' }, parameters: { query: 'x' }, canonicalEvidence: true,
    recordVersion: 1, eventSequence: 0, requesterAgent: 'jerry',
    target: { domain: 'brain', brainId: 'brain-jerry', ownerAgent: 'jerry',
      displayName: 'Jerry Brain', kind: 'resident', lifecycle: 'resident',
      catalogRevision: 'catalog-compat', route: '/api/brain/brain-jerry',
      canonicalRoot: '/fixture/jerry', accessMode: 'own',
      mutationBoundaries: canonicalCompatBoundaries('/fixture/jerry') },
    state: 'queued', phase: null, startedAt: null, updatedAt: '2026-07-09T12:00:00.000Z',
    completedAt: null, lastProviderActivityAt: null, lastProgressAt: null,
    result: null, resultHandle: null, resultArtifact: null, error: null, sourceEvidence: null,
    sourcePinDescriptor: null, sourcePinDigest: null, sourcePinReleasedAt: null,
    resultExpiresAt: null, resultExpiredAt: null, metadataExpiresAt: null,
    ...overrides,
  };
}

function makeQueryApp({ onForward = () => {}, adapter = {} } = {}) {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use('/home23/api/query', createQueryApiRouter({
    getDefaultAgent: () => 'jerry',
    resolveAgent: () => 'jerry',
    catalogProvider: async () => ({
      agent: 'jerry', available: true, reason: null,
      selectedBrain: { id: 'brain-jerry', routeKey: 'brain-jerry', displayName: 'Jerry Brain' },
      brains: [{ id: 'brain-jerry', routeKey: 'brain-jerry', displayName: 'Jerry Brain' }],
      models: [{ id: 'gpt-5.5', provider: 'openai' }], defaults: { model: 'gpt-5.5', mode: 'quick' },
      endpoints: { run: '/home23/api/query/run', stream: '/home23/api/query/stream', export: '/home23/api/query/export' },
      cosmo: { apiReachable: true, running: false, activeRun: false }, streaming: true,
      limits: { maxQueryChars: 12000, maxPriorContextChars: 20000 }, lastRouteError: null,
    }),
    operationAdapter: {
      start: async (request) => {
        calls.push('start'); onForward(request);
        return canonicalCompatRecord({ state: 'queued', eventSequence: 0 });
      },
      attachAndWait: async (operation, options) => {
        calls.push('attachAndWait');
        assert.equal(operation.operationId, COMPAT_OPERATION_ID);
        assert.ok(options.attachmentId);
        assert.equal(options.waitMs, 5_400_000);
        return canonicalCompatRecord({ state: 'complete', eventSequence: 3, result: null });
      },
      getResult: async (operationId) => {
        calls.push('getResult');
        return { operationId, state: 'complete', result: { answer: 'ok' },
          resultHandle: 'brres_dddddddddddddddddddddddddddddddd', resultArtifact: null,
          error: null, sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'matches' } };
      },
      detach: async () => { calls.push('detach'); },
      exportStored: async (request) => {
        calls.push('exportStored'); onForward(request);
        return { success: true, exportedTo: '/requester/brain-exports/result.md',
          resultHandle: 'brres_dddddddddddddddddddddddddddddddd' };
      },
      ...adapter,
    },
  }));
  return { app, calls };
}

async function postRaw(app, pathname, body) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve); server.once('error', reject);
  });
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, text: await response.text() };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function parseSseData(text) {
  return text.replace(/\r\n/g, '\n').split('\n\n').flatMap((frame) => {
    const data = frame.split('\n').filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart()).join('\n');
    return data && data !== '[DONE]' ? [JSON.parse(data)] : [];
  });
}

test('query facade rejects one character beyond published query and prior-context limits', async () => {
  const forwarded = [];
  const { app } = makeQueryApp({ onForward: request => forwarded.push(request) });
  const tooLongQuery = await postJson(app, '/home23/api/query/run', {
    query: 'q'.repeat(12001), modelSelection: { provider: 'openai', model: 'gpt-5.5' },
    mode: 'quick', enablePGS: false,
  });
  assert.equal(tooLongQuery.status, 413);
  assert.equal(tooLongQuery.body.error.code, 'invalid_request');
  const tooLongPrior = await postJson(app, '/home23/api/query/run', {
    query: 'ok', modelSelection: { provider: 'openai', model: 'gpt-5.5' },
    mode: 'quick', enablePGS: false,
    priorContext: { query: 'p', answer: 'a'.repeat(20001) },
  });
  assert.equal(tooLongPrior.status, 413);
  assert.equal(forwarded.length, 0);
});

test('compatibility facade rejects agent and brain mismatch instead of forwarding arbitrary target', async () => {
  const response = await postJson(makeQueryApp().app, '/home23/api/query/run?agent=jerry', {
    brainId: 'brain-forrest', query: 'x',
    modelSelection: { provider: 'openai', model: 'gpt-5.5' }, mode: 'quick', enablePGS: false,
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'target_mismatch');
});

test('compatibility run performs durable start, attach/wait, then protected result read', async () => {
  const fixture = makeQueryApp();
  const response = await postJson(fixture.app, '/home23/api/query/run', {
    query: 'x', modelSelection: { provider: 'openai', model: 'gpt-5.5' },
    mode: 'quick', enablePGS: false,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(fixture.calls, ['start', 'attachAndWait', 'getResult']);
  assert.equal(response.body.operationId, COMPAT_OPERATION_ID);
  assert.equal(response.body.answer, 'ok');
});

test('compatibility PGS selects six-hour attachment policy and forwards progress beyond 120 seconds', async () => {
  let now = 0; const progress: number[] = [];
  const fixture = makeQueryApp({ adapter: {
    start: async () => ({ ...canonicalCompatRecord({ state: 'queued', eventSequence: 0 }),
      operationType: 'pgs' }),
    attachAndWait: async (_operation, options) => {
      assert.equal(options.waitMs, 21_600_000);
      options.onEvent(canonicalCompatRecord({ state: 'running', eventSequence: 1 })); progress.push(now);
      now += 121_000;
      options.onEvent(canonicalCompatRecord({ state: 'running', eventSequence: 2 })); progress.push(now);
      return canonicalCompatRecord({ state: 'complete', eventSequence: 3, result: null });
    },
  } });
  const response = await postJson(fixture.app, '/home23/api/query/run', {
    query: 'x', enablePGS: true, pgsConfig: { sweepFraction: 0.25 },
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    pgsSynth: { provider: 'anthropic', model: 'claude-sonnet-4-7' }, mode: 'quick',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(progress, [0, 121_000]);
  assert.equal(response.body.answer, 'ok');
});

test('compatibility detach is honest and remains actionable', async () => {
  let resultReads = 0; let detaches = 0;
  const fixture = makeQueryApp({ adapter: {
    attachAndWait: async () => ({ ...canonicalCompatRecord({ state: 'running', eventSequence: 2 }),
      attachmentState: 'detached' }),
    getResult: async () => { resultReads += 1; throw new Error('result must not be read'); },
    detach: async () => { detaches += 1; },
  } });
  const response = await postJson(fixture.app, '/home23/api/query/run', {
    query: 'x', modelSelection: { provider: 'openai', model: 'gpt-5.5' },
    mode: 'quick', enablePGS: false,
  });
  assert.equal(response.status, 202);
  assert.equal(response.body.operationId, COMPAT_OPERATION_ID);
  assert.equal(response.body.state, 'running');
  assert.equal(response.body.detached, true);
  assert.match(JSON.stringify(response.body), /status|result|cancel|resume/);
  assert.equal('answer' in response.body, false);
  assert.equal(resultReads, 0);
  assert.equal(detaches, 0, 'adapter already returned an authoritative detached state');
});

test('compatibility stream attaches to events and terminal bytes come only from result', async () => {
  let resultReads = 0;
  const fixture = makeQueryApp({ adapter: {
    attachAndWait: async (operation, options) => {
      options.onEvent(canonicalCompatRecord({ state: 'running', eventSequence: 1 }));
      options.onEvent(canonicalCompatRecord({ state: 'complete', eventSequence: 2, result: null }));
      return canonicalCompatRecord({ state: 'complete', eventSequence: 2, result: null });
    },
    getResult: async (operationId) => { resultReads += 1; return { operationId, state: 'complete',
      result: { answer: 'protected bytes' }, resultHandle: 'brres_dddddddddddddddddddddddddddddddd',
      resultArtifact: null, error: null, sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'matches' } }; },
  } });
  const response = await postRaw(fixture.app, '/home23/api/query/stream', {
    query: 'x', modelSelection: { provider: 'openai', model: 'gpt-5.5' }, mode: 'quick', enablePGS: false,
  });
  assert.equal(response.status, 200);
  const rows = parseSseData(response.text);
  assert.deepEqual(rows.filter((row) => row.eventSequence).map((row) => row.eventSequence), [1, 2]);
  assert.equal(rows.at(-1).answer, 'protected bytes');
  assert.equal(resultReads, 1);
  assert.equal(fixture.calls.filter((call) => call === 'start').length, 1);
});
```

- [ ] **Step 7: Run compatibility tests and verify RED**

```bash
node --test --test-concurrency=1 tests/contracts/query-facade-route.test.cjs
```

Expected: over-limit requests currently forward; mismatched brain ID currently forwards to COSMO, so both new tests FAIL.

- [ ] **Step 8: Make compatibility routes validate then call the coordinator**

In `engine/src/dashboard/home23-query-api.js`:

```js
const MAX_QUERY_CHARS = 12000;
const MAX_PRIOR_CONTEXT_CHARS = 20000;

function validateCompatibilityRequest(body, selectedBrain) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, code: 'invalid_request', message: 'request body must be an object' };
  }
  if (typeof body.query !== 'string') {
    return { status: 400, code: 'invalid_request', message: 'query must be a string' };
  }
  const query = body.query;
  if (!query.trim()) return { status: 400, code: 'invalid_request', message: 'query is required' };
  if (query.length > MAX_QUERY_CHARS) return { status: 413, code: 'invalid_request', message: `query exceeds ${MAX_QUERY_CHARS} characters` };
  let prior = '';
  if (Object.prototype.hasOwnProperty.call(body, 'priorContext')) {
    const value = body.priorContext;
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some((key) => key !== 'query' && key !== 'answer')
        || typeof value.query !== 'string' || typeof value.answer !== 'string') {
      return { status: 400, code: 'invalid_request', message: 'priorContext is invalid' };
    }
    prior = value.query + value.answer;
  }
  if (prior.length > MAX_PRIOR_CONTEXT_CHARS) return { status: 413, code: 'invalid_request', message: `priorContext exceeds ${MAX_PRIOR_CONTEXT_CHARS} characters` };
  if (Object.prototype.hasOwnProperty.call(body, 'brainId')
      && (typeof body.brainId !== 'string' || !body.brainId.trim())) {
    return { status: 400, code: 'invalid_request', message: 'brainId is invalid' };
  }
  if (body.brainId && body.brainId !== selectedBrain?.id && body.brainId !== selectedBrain?.routeKey) {
    return { status: 400, code: 'target_mismatch', message: 'agent and brainId do not select the same canonical brain' };
  }
  // Apply the shared strict exact-object/numeric validators. Query accepts optional modelSelection;
  // PGS accepts optional pgsSweep and pgsSynth. Reject flat model/provider/legacy PGS spellings,
  // present-null/extra targets, nonfinite limits, unknown keys, and partial/extra provider pairs.
  return null;
}
```

Implement `engine/src/dashboard/brain-operations/compatibility-adapter.js` over the same local `BrainOperationCoordinator`/store reader as the public routes. Its exact interface is `start(request)`, `attachAndWait(record,{attachmentId,signal,waitMs,onEvent})`, `getResult(operationId)`, `detach(operationId,attachmentId,reason)`, and `exportStored(request)`. The route selects `waitMs=5_400_000` for Direct Query and `waitMs=21_600_000` for PGS from the canonical operation type; callers cannot override it. `start()` may return only the canonical queued/running record. `attachAndWait()` uses a durable attachment, monotonic event/status recovery, and returns status only; terminal bytes always come from `getResult()`. A disconnect or attachment deadline detaches the durable query/PGS operation, never cancels it, and returns HTTP 202 actionable running state. Export reloads stored canonical bytes or starts the explicit noncanonical `ad_hoc_export`; it never accepts inline answer bytes as canonical evidence.

After validation, use that adapter rather than direct `${cosmoBaseUrl}/api/brain/:id/query` or `export-query`. `/run` performs start -> attach/wait -> protected result; `/stream` performs start -> attach/monotonic events -> protected result and detaches on disconnect; `/export` authorizes the stored operation before export. Reject an HTTP-200 `error`, `success:false`, failed operation state, or missing terminal content. A detached operation returns HTTP 202 with operation ID/state and exact resume/status/result/cancel guidance, never a success-looking empty answer. Preserve dry-run behavior without provider execution.

Add optional `catalogProvider` and `operationAdapter` dependencies to `createQueryApiRouter(options)` for deterministic contract tests. Production construction must supply the real local compatibility adapter; delete the `startOperation`/`exportOperation` terminal-result shortcut so a test cannot bypass attachment and protected result read.

- [ ] **Step 9: Extend query schema with typed compatibility failures and result handles**

In `contracts/schemas/query.schema.json`, define the exact nested query/PGS provider pairs with `additionalProperties:false`; reject every flat/legacy spelling. Add `operationId`, canonical `state`, `attachmentState`, `detached`, `resultHandle`, `resultArtifact`, `sourceEvidence`, resume/status/result/cancel guidance, and structured `{ code, message, retryable }` error fields to query run/stream/export responses. The schema must distinguish terminal success/partial, actionable HTTP-202 detached running, and typed terminal failure; it may not require an answer on detached/failure output.

- [ ] **Step 10: Run context, compatibility, and contract suites**

```bash
node --import tsx --test --test-concurrency=1 tests/agent/context-brain-retrieval.test.ts tests/agent/context-worker-runs.test.ts
node --test --test-concurrency=1 tests/contracts/query-facade-route.test.cjs
npm run test:contracts
npm run build
```

Expected: all PASS.

- [ ] **Step 11: Commit only context/compatibility paths**

```bash
git diff --cached --quiet
git add -- src/agent/context-assembly.ts src/agent/loop.ts engine/src/dashboard/brain-operations/compatibility-adapter.js engine/src/dashboard/home23-query-api.js tests/agent/context-brain-retrieval.test.ts tests/agent/context-worker-runs.test.ts tests/contracts/query-facade-route.test.cjs contracts/schemas/query.schema.json
git diff --cached --check
git diff --cached -- src/agent/context-assembly.ts src/agent/loop.ts engine/src/dashboard/brain-operations/compatibility-adapter.js engine/src/dashboard/home23-query-api.js tests/agent/context-brain-retrieval.test.ts tests/agent/context-worker-runs.test.ts tests/contracts/query-facade-route.test.cjs contracts/schemas/query.schema.json
git commit --only src/agent/context-assembly.ts src/agent/loop.ts engine/src/dashboard/brain-operations/compatibility-adapter.js engine/src/dashboard/home23-query-api.js tests/agent/context-brain-retrieval.test.ts tests/agent/context-worker-runs.test.ts tests/contracts/query-facade-route.test.cjs contracts/schemas/query.schema.json -m "fix: align context and query adapters with brain operations"
```

---

### Task 7: Register the Integration Tests and Record Vendored Changes

**Files:**
- Modify: `package.json`
- Modify: `docs/design/COSMO23-VENDORED-PATCHES.md`

**Interfaces:**
- Consumes: all focused tests from Tasks 1-6 and prerequisite-plan COSMO changes.
- Produces: `npm test` coverage for every new agent regression and durable vendored-patch documentation. The spec remains approved-but-not-implemented until Task 8 succeeds live.

- [ ] **Step 1: Prove the current aggregate test command omits new tests**

Run:

```bash
node <<'NODE'
const script = require('./package.json').scripts.test;
for (const file of [
  'tests/agent/brain-operations-client.test.ts',
  'tests/agent/turn-activity-lease.test.ts',
  'tests/agent/turn-entrypoints.test.ts',
  'tests/agent/turn-entrypoint-callers.test.ts',
  'tests/agent/tools/cron.test.ts',
  'tests/agent/tool-result.test.ts',
  'tests/agent/tool-result-provider-branches.test.ts',
  'tests/agent/tools/brain.test.ts',
  'tests/agent/tools/research.test.ts',
  'tests/agent/context-brain-retrieval.test.ts',
  'tests/cosmo23/research-run-operation-adapter.test.cjs',
  'tests/cosmo23/research-pinned-source-reader.test.cjs',
  'tests/cosmo23/research-requester-output-writer.test.cjs',
  'tests/cosmo23/research-compile-provider-adapter.test.cjs',
  'tests/cosmo23/research-operation-executors.test.cjs',
  'tests/engine/dashboard/brain-operation-routes.test.js',
  'tests/engine/agents/agent-executor-memory-context.test.js',
  'tests/cosmo23/agent-executor-memory-context.test.cjs',
]) {
  const count = script.split(file).length - 1;
  if (count !== 1) { console.error(`${file}: expected once, found ${count}`); process.exitCode = 1; }
}
NODE
```

Expected: exit 1 and one `missing ...` line per unregistered test.

- [ ] **Step 2: Add every new test explicitly to `package.json`**

Insert these paths into the existing `node --import tsx --test --test-concurrency=1` list without converting unrelated test commands:

```text
tests/agent/brain-operations-client.test.ts
tests/agent/turn-activity-lease.test.ts
tests/agent/turn-entrypoints.test.ts
tests/agent/turn-entrypoint-callers.test.ts
tests/agent/tools/cron.test.ts
tests/agent/tool-result.test.ts
tests/agent/tool-result-provider-branches.test.ts
tests/agent/tools/brain.test.ts
tests/agent/tools/research.test.ts
tests/agent/context-brain-retrieval.test.ts
tests/cosmo23/research-run-operation-adapter.test.cjs
tests/cosmo23/research-pinned-source-reader.test.cjs
tests/cosmo23/research-requester-output-writer.test.cjs
tests/cosmo23/research-compile-provider-adapter.test.cjs
tests/cosmo23/research-operation-executors.test.cjs
tests/engine/dashboard/brain-operation-routes.test.js
tests/engine/agents/agent-executor-memory-context.test.js
tests/cosmo23/agent-executor-memory-context.test.cjs
```

Place TypeScript and CommonJS tests in the appropriate existing aggregate command while preserving `--test-concurrency=1`; the invariant is that each path appears exactly once in `scripts.test`, not that unlike runtimes share one invocation. Existing paths in the list still require the exact-once check so an edit cannot accidentally drop or duplicate their behavioral coverage.

- [ ] **Step 3: Re-run registration proof**

Run the Step 1 command again.

Expected: exit 0 with no output.

- [ ] **Step 4: Document every prerequisite COSMO vendored patch**

Preserve the reserved sequence: Patch 47 is authority/catalog/worker, Patch 48 is source truth, and Patch 49 is provider/PGS execution, each documented by its owning prerequisite plan. This agent-integration plan adds Patch 50 only because Task 5 introduces the distinct vendored run adapter, private compile/provider adapter, research executors, and exact registration in `cosmo23/server/index.js`. Patch 50 must list exactly those research backend files, requester ownership/read-only behavior, the three focused research backend test commands, and their observed pass totals. Do not restate 47-49, renumber them, or claim commands that were not run.

- [ ] **Step 5: Run focused aggregate and full build/test/contracts**

```bash
node --import tsx --test --test-concurrency=1 \
  tests/agent/brain-operations-client.test.ts \
  tests/agent/turn-activity-lease.test.ts \
  tests/agent/turn-entrypoints.test.ts \
  tests/agent/turn-entrypoint-callers.test.ts \
  tests/agent/tools/cron.test.ts \
  tests/agent/tool-result.test.ts \
  tests/agent/tool-result-provider-branches.test.ts \
  tests/agent/context-brain-retrieval.test.ts \
  tests/agent/tools/brain.test.ts \
  tests/agent/tools/research.test.ts
node --test --test-concurrency=1 tests/cosmo23/research-run-operation-adapter.test.cjs tests/cosmo23/research-pinned-source-reader.test.cjs tests/cosmo23/research-requester-output-writer.test.cjs tests/cosmo23/research-compile-provider-adapter.test.cjs tests/cosmo23/research-operation-executors.test.cjs
npm run build
npm test
npm run test:contracts
```

Expected: every command exits 0. Record exact totals for the receipt; do not copy historical totals.

- [ ] **Step 6: Run portability and diff checks**

```bash
git diff --check
git ls-files -ci --exclude-standard
if git archive HEAD | tar -tf - | rg '^(instances/|config/(home|targets|secrets)\.yaml$|config/(cron-jobs|agents)\.json$|ecosystem\.config\.cjs$)'; then
  echo 'Refusing release: archive contains local installation state' >&2
  exit 1
fi
```

Expected: `git diff --check` exits 0; both separation searches print nothing. If a search finds a tracked local-state path, stop and repair that specific tracking issue without deleting the local file.

- [ ] **Step 7: Commit package and durable design docs**

```bash
git diff --cached --quiet
git add -- package.json docs/design/COSMO23-VENDORED-PATCHES.md
git diff --cached --check
git diff --cached -- package.json docs/design/COSMO23-VENDORED-PATCHES.md
git commit --only package.json docs/design/COSMO23-VENDORED-PATCHES.md -m "docs: record brain operation hardening"
```

---

### Task 8: Perform Scoped Live Acceptance and Write the Receipt

**Files:**
- Create: `scripts/live-brain-tools-smoke.mjs`
- Create: `scripts/hash-brain-boundaries.mjs`
- Create: `scripts/sample-process-memory.mjs`
- Create: `scripts/verify-brain-persistence.mjs`
- Create: `scripts/guarded-pm2-save.mjs`
- Create: `scripts/cleanup-orphan-brain-projections.mjs`
- Create: `scripts/verify-live-deployment-tree.mjs`
- Create: `tests/scripts/live-brain-tools-smoke.test.cjs`
- Create: `tests/scripts/hash-brain-boundaries.test.cjs`
- Create: `tests/scripts/sample-process-memory.test.cjs`
- Create: `tests/scripts/verify-brain-persistence.test.cjs`
- Create: `tests/scripts/guarded-pm2-save.test.cjs`
- Create: `tests/scripts/cleanup-orphan-brain-projections.test.cjs`
- Create: `tests/scripts/verify-live-deployment-tree.test.cjs`
- Create/verify: `src/agent/cron-brain-query.ts`
- Modify: `src/home.ts`
- Modify: `src/agent/tools/cron.ts`
- Modify: `shared/memory-source/operation-context.cjs`
- Modify: `engine/src/dashboard/brain-source-api.js`
- Modify: `engine/src/dashboard/server.js`
- Modify: `cosmo23/server/lib/brain-source-router.js`
- Modify: `src/agents/system-prompt.ts`
- Modify: `engine/src/dashboard/home23-query.js`
- Modify: `tests/shared/memory-source-operation-context.test.js`
- Modify: `tests/engine/dashboard/brain-source-api.test.js`
- Modify: `tests/engine/dashboard/memory-search.test.js`
- Modify: `tests/cosmo23/brain-source-router.test.cjs`
- Modify: `tests/agent/tools/brain.test.ts`
- Modify: `tests/agent/tools/cron.test.ts`
- Modify: `tests/agent/turn-entrypoint-callers.test.ts`
- Modify: `tests/dashboard/operator-ui.test.js`
- Modify: `docs/design/COSMO23-VENDORED-PATCHES.md`
- Modify local-only: `/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/SOUL.md`
- Modify local-only: `/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/LEARNINGS.md`
- Modify local-only: `/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/MEMORY.md`
- Create: `docs/receipts/2026-07-09-brain-tools-hardening.md`
- Modify: `package.json`
- Modify: `docs/superpowers/specs/2026-07-09-brain-operations-reliability-design.md:3-7`

**Interfaces:**
- Consumes: verified implementation, the recorded two-dashboard emergency-stop deviation plus two already-quiesced engines, named PM2 processes, public dashboard operation routes, canonical catalog, source evidence, requester-owned operation receipts, and configured healthy providers.
- Produces: cross-process canonical-source admission, a tested manifest-driven orphan cleaner, corrected portable/live wait guidance, tested acceptance helpers, and a dated evidence receipt with incident/cleanup totals, exact test totals, process/restart facts, heap bound, actual agent-client/tool-path own/sibling/research canaries, no-write proof, PGS/synthesis outcome, and Git/push state.

- [ ] **Step 0: Build the live-verification helpers under deterministic tests**

Write the seven helper fixture tests before the scripts. `live-brain-tools-smoke.test.cjs` launches a controlled coordinator, imports the built `BrainOperationsClient` plus the real brain-tool executors, advances controlled SSE operations through delayed progress, reconnect, complete, partial, and typed failure, and proves the 90-minute/six-hour production policies are selected without sleeping. It also covers authoritative multi-operation canary/own JSONL with selected-last validation, a large pinned PGS transcript with canonical null-answer/sweepOutputs partials, a wholly isolated controlled-provider fixture, exact 3000-ms lifecycle delay, isolated synthesis disconnect/reconnect, MCP source-revision parity, typed MCP-disabled/unreachable outcomes, and dual zero policy: degraded legacy `absence_unprovable` plus strict healthy manifest `no_match`, with distinct durable operation IDs. `hash-brain-boundaries.test.cjs` proves every nested regular file, including unknown extensions, extensionless files, and files added after the fixture starts, is recursively inventoried; symlinks are recorded but not followed; all seven required named boundaries (`brain`, `run`, `pgs`, `session`, `cache`, `export`, `agency`) are present exactly once even when a root is absent; duplicate physical paths retain separate named records; a resident fixture maps both `brain` and `run` to its canonical brain root rather than the parent agent instance; a research fixture maps `run` to its canonical run root; requester-owned external pin/scratch paths are outside the target inventory; and a revision/stat/file-set change during a sibling run produces `target_changed_concurrently` rather than a false no-write pass. `sample-process-memory.test.cjs` proves per-target peak V8 used-heap, metric freshness, restart delta, and PID replacement calculations from injected dashboard/COSMO samples. `verify-brain-persistence.test.cjs` uses temporary manifest and legacy-sidecar fixtures plus injected filesystem/persistence seams to prove all of the following:

- read-only mode resolves exactly `path.join(home23Root, 'instances', agent, 'brain')`, streams every logical node and edge through production `openMemorySource()` with external requester-owned scratch, hashes the complete logical streams, retains only the largest single representative record of each kind, and accepts counts that equal the authoritative format-v1 manifest summary or, for a legacy source, the production stream assembled from its selected base plus committed delta prefix;
- a format-v1 manifest and its selected generation are strict source authority. `brain-snapshot.json` is advisory for **both** formats: missing, invalid, stale, zero, or disagreeing snapshot counts are recorded as typed snapshot status/gap evidence but never fail an otherwise valid legacy or manifest stream solely because the snapshot differs. A legacy stream has degraded health and unknown freshness, and no snapshot may replace its base-plus-committed-delta authority;
- the exact manifest generation files (including only the committed delta prefix for source authority), complete physical legacy files selected by the production source resolver, and `brain-snapshot.json` are byte-hashed before and after streaming; any revision, file-set, or byte change is reported as `source_changed_concurrently`, never a false read-only pass;
- a 100,000-node/300,000-edge child probe runs with `--max-old-space-size=96`, an independent 80-MiB observed-heap ceiling, and no full materializer;
- temp-save mode refuses a destination equal to, beneath, or symlinked into the Home23 root or either live brain; copies every selected physical source file byte-for-byte into a fresh external `mkdtemp` clone; calls production `persistMemoryRevision({ forceFull:false, fullRewriteIntervalMs:Number.MAX_SAFE_INTEGER })` with one clone-only canary whose full-view accessor throws; stream-reads that canary and exact new counts back; and separately runs production force-full/load/reload only on two bounded records derived from the largest real-shaped live node/edge records; and
- the receipt states explicitly that full-live `forceFull` was not attempted because duplicating a multi-gigabyte resident graph on this host is unsafe; the real full-scale load proof is the later scoped engine boot and readiness check; and
- guarded cleanup can remove only the exact generated clone, while the original source inventory and hashes remain byte-identical even when clone persistence or cleanup fails.

`guarded-pm2-save.test.cjs` uses fixture `jlist`, PM2 module rows, and `dump.pm2` documents plus an injected `pm2 save` runner. It proves a distinct mode-0600 `wx` byte backup is made for every dry-run and apply attempt before mutation; PM2 module rows are classified, excluded from the application dump comparison, and frozen across the operation; all remaining live and dump entries (including non-Home23 apps) are normalized and compared; duplicate names, stopped/errored entries, or unrelated identity/config/status/PID/uptime drift refuse the save; an unrelated restart baseline is monotonic and may not decrease or advance after the immediate pre-save freeze; only the exact allowlisted brain processes may show the already-proved refresh transition; post-save dump equals the captured frozen application table; and any postcondition failure atomically restores the apply attempt's own backup and exits nonzero.

`cleanup-orphan-brain-projections.test.cjs` proves dry-run selects only immediate `dashboard-source-<uuid>` roots beneath the explicit Jerry/Forrest operation roots; requires one canonical nonsymlink Home23 root, an explicit safe agent set, all four exact engine/dashboard PM2 rows stopped with PID zero, and explicit monitored ports that equal the union of those stopped rows' `REALTIME_PORT`, `DASHBOARD_PORT`, and `MCP_HTTP_PORT` environment authority. Protected listener ports must be disjoint and their exact port/PID/command/boot/process-start inventory is identity-bound across approval, each mutation, and final readback; any monitored listener, unaccounted listener, PM2/env disagreement, unknown/open FD state, or live/unknown owner blocks selection. It excludes rather than deletes malformed, external-root, symlink, hardlink, cross-device, wrong-owner/mode, live-owner, unknown-owner, and open-FD candidates; writes a mode-0600 full-manifest receipt outside `instances`; records per-candidate logical bytes and `st_blocks*512` allocated bytes plus filesystem available bytes; and requires a separate SHA-256 approval-scope token plus bounded explicit approval actor/text and canonical UTC approval timestamp no earlier than the checksum-bound dry-run `createdAt`. That approval scope binds the canonical home, brain, and operations-root identities; exact eligible and excluded classifications, root identities, candidate trees/bytes/owners, immediate nonselected names/root identities, PM2 rows/port bindings, and protected-listener identities. Apply integrity-checks the complete captured manifest and mandatory approval-scope digest/token, runs a fresh full preflight, and refuses any approval-scope difference before mutation; only protected brain and ordinary nonselected **content bytes** plus filesystem telemetry may legitimately differ before apply, while the fresh full snapshots become the apply-start boundary baseline. Receipt/manifest inputs and final readback are identity-bound and capped at 64 MiB. Apply writes a per-candidate `pending` intent before mutation, then routes candidate/quarantine `mkdir`, `rename`, `rm`, and `rmdir` only through scope-checked wrappers that record an intent and exactly one completed/failed/unknown outcome; separately identity-bound receipt publication is never represented as part of that candidate audit. It creates a random same-parent mode-0700 exclusive quarantine container, refuses any pre-existing/raced child destination, renames only the still identity-matching candidate, rechecks owner/listener/FD authority immediately before rename **and again before removal**, rehashes quarantine, and retains changed quarantine as `partial`. Post-removal uncertainty is reported only as `removed_postcondition_failed` or `removal_state_unknown`. Its terminal receipt includes both full preflight digests plus the approval-scope digest, selected/removed byte totals, pre/post `statfs` and available-byte delta, explicit apply-start/after brain and every nonselected-root hashes, protected membership/root-identity proof, the candidate/quarantine mutation audit, separate receipt-publication evidence, and final PM2/listener/open-FD gates. Content-only changes by the required online protected writers are reported truthfully as `concurrentContentDrift` and do not make cleanup partial because every candidate/quarantine mutation is path-disjoint and eligible trees exclude symlinks/hardlinks; missing, replaced, unreadable, or membership-changed protected roots, mutation-scope violations, or runtime-gate drift remain partial/failing evidence.

`memory-source-operation-context.test.js` reproduces the storm with mixed dashboard, MCP, and COSMO callers and proves one nonwaiting admission per canonical source across both same-process concurrency and a child process. Admission is acquired before UUID, operation-root, scratch-quota, format classification, or projection; every contender gets retryable `source_busy`; different canonical brains remain independent; exact abort reasons and callback failures release the lock; canonical nonsymlink ancestry keeps operation roots inside the explicit Home23 root and outside the target brain; and cleanup quarantines/removes only the captured dev/inode while preserving a replacement or renamed-away root and failing closed on path turnover. The dashboard brain-source, dashboard memory-search, and COSMO router tests require `{code:'source_busy',retryable:true}` to remain HTTP 503 rather than becoming an empty result or generic 500. `brain.test.ts` requires the portable runtime prompt to state ordinary 90-minute and PGS/synthesis six-hour waits plus operation-ID reattachment and rejects the old `~500ms`, `1-6 min`, and `5-10+ min` claims. `operator-ui.test.js` requires durable/reattachable PGS copy and rejects fixed `1-3 min`, `3-6 min`, and `5-10+ min` estimates.

`cron.test.ts` and `turn-entrypoint-callers.test.ts` prove `payload.kind === 'query'` leaves the legacy `/api/query`/`queryEngine()` 120-second boundary and uses one `BrainOperationsClient` durable query with a 5,400-second default attachment signal. They require exact model-alias provider/model binding, complete/detached/useful-partial/typed-failure truth, retained operation-ID reattachment guidance, no duplicate start, and matching cron/system-prompt descriptions.

`verify-live-deployment-tree.test.cjs` creates base/feature/live fixture repositories with staged, unstaged, deleted, newly tracked, colliding-untracked, and unrelated-untracked paths. It proves `prepare` writes only an external expected tree plus one `{path,baseOid,featureOid,liveHash,mergedHash,resolution}` row per pending path; conflicts block sealing; `seal` produces a Git tree OID; `verify` recomputes the exact live working-tree OID while leaving `.git/index` byte-identical; one-byte drift/deletion/path-set change fails; and unrelated untracked hashes remain equal.

Run and confirm RED because the scripts do not exist:

```bash
node --test --test-concurrency=1 tests/scripts/live-brain-tools-smoke.test.cjs tests/scripts/hash-brain-boundaries.test.cjs tests/scripts/sample-process-memory.test.cjs tests/scripts/verify-brain-persistence.test.cjs tests/scripts/guarded-pm2-save.test.cjs tests/scripts/cleanup-orphan-brain-projections.test.cjs tests/scripts/verify-live-deployment-tree.test.cjs
node --test --test-concurrency=1 tests/shared/memory-source-operation-context.test.js tests/engine/dashboard/brain-source-api.test.js tests/engine/dashboard/memory-search.test.js tests/cosmo23/brain-source-router.test.cjs
node --import tsx --test --test-concurrency=1 tests/agent/tools/brain.test.ts tests/agent/tools/cron.test.ts tests/agent/turn-entrypoint-callers.test.ts
node --test --test-concurrency=1 tests/dashboard/operator-ui.test.js
```

Implement the receipt-producing acceptance helpers as importable modules with small CLI wrappers. Except for the separately authorized pre-acceptance orphan cleaner described below, every helper requires `--receipt-run-dir`, `--receipt-run-id`, and `--authority live|isolated-controlled`; it realpaths a nonsymlink dedicated run directory, reads the immutable mode-0600 `run-authority.json` from that exact root, writes only beneath it, and includes the exact run ID, authority, implementation commit, hostname, started/completed timestamps, and artifact SHA-256 in every JSON/JSONL row. `run-authority.json` is the **sole** run/commit/tree/hostname authority. CLI/environment values are only redundant assertions: if `HOME23_RECEIPT_IMPLEMENTATION_COMMIT` or any equivalent flag is present, it must byte-equal `run-authority.json.implementationCommit` or the helper fails with `receipt_implementation_commit_mismatch`. Missing authority, conflicting run ID/authority, invalid tree/commit OIDs, or any helper-local competing commit/tree truth is a hard failure.

Every helper test builds a canonical `run-authority.json`, proves its commit/tree fields propagate unchanged to all output rows, and separately supplies a conflicting environment/CLI commit to require `receipt_implementation_commit_mismatch` before any output or runtime action. Isolated-controlled fixtures reuse the same run-authority commit/tree identity and vary only row authority.

The smoke script must use production client/tool code, wait through SSE rather than shell polling, support `--query-wait-ms 5400000` and `--pgs-wait-ms 21600000`, emit one JSONL row per operation, and offer `--controlled-provider` only inside a separately launched isolated fixture. Receipt authority may be supplied by the three exact CLI flags or the equivalent `HOME23_RECEIPT_RUN_DIR`, `HOME23_RECEIPT_RUN_ID`, and `HOME23_RECEIPT_AUTHORITY` environment variables; missing/conflicting values fail, and implementation identity still comes only from `run-authority.json`. Its scenario enum is exactly `discover-canary`, `own`, `direct-query`, `sibling`, `completed-research`, `completed-research-compile`, `canonical-export`, `pgs`, `large-pgs-isolated`, `graph`, `negative-targets`, `detach-reattach`, `cancel`, `restart-reconcile`, `zero-result`, `synthesis-reconnect`, `mcp-parity`, `mcp-unavailable`, and `verify-receipts`; every query/compile scenario requires `--canary-receipt` and reuses its exact query/source revision. `discover-canary` and `own` deliberately create multiple durable operations, so their output contains one canonical terminal row for **each** operation and the selected scenario summary is the last row. Every consumer parses and validates all rows (including uniqueness and exactly one terminal per operation) before selecting `.at(-1)`; `JSON.parse(file)` or `find(...)` is forbidden for multi-operation receipts. `canonical-export` requires an existing operation receipt and calls the protected export route without resubmitting answer bytes. The negative/lifecycle scenarios use controlled or provider-free operations and still pass through the production coordinator/client/store. The isolated lifecycle fixture delays completion by exactly `3000` milliseconds under fake/controlled providers so detach, cancellation, and restart happen before terminal state without a long real wait. `--list-healthy-models --base-url <cosmo>` emits one JSON object containing explicitly probed Direct Query `modelSelection`, PGS `pgsSweep`, and PGS `pgsSynth` exact pairs or exits with typed `no_healthy_provider`.

Each durable operation emits exactly one canonical final row with
`receiptKind:'operation-terminal'`, terminal `state`,
`protectedResultRead:true`, requester, authority, and either the authorized live
dashboard endpoint or a nonempty retained `isolatedStore`. SSE/progress rows use
`receiptKind:'operation-event'` and can never serve as identity/readback
authority. Duplicate terminal rows or conflicting requester/authority/store
metadata for one operation are a hard receipt failure.

Every successful or partial provider-backed receipt also requires an exact
provider-terminal identity and pair. Query events must equal
`result.metadata.provider/model`; research-compile and synthesis events must
equal `result.provider/model`. Every PGS sweep event remains bound to its exact
work-unit output pair, and the `pgs_synthesis` terminal must equal the exact
requested `pgsSynth` pair carried through the scenario. A missing pair, a
nonempty but different provider/model, or a phase/call-ID mismatch is
`provider_terminal_unproven`; provider prose cannot substitute for that proof.

For live PGS, require a catalog/source receipt proving at least `PGS_LARGE_MIN_NODES=100000` authoritative nodes and run the configured provider on that pinned source; a 10% fraction without the size gate is not a large acceptance. If either the size gate or healthy external provider is unavailable, do **not** point a controlled provider at any live brain. Generate a 100,000-node/300,000-edge numeric-v1 source under an external `mktemp -d`, start a separate temp Home23 root with isolated requester dashboard and COSMO processes on allocated loopback ports, use isolated secrets/runtime/scratch, run `large-pgs-isolated`, capture both isolated PIDs, then guardedly stop its processes while retaining the proved fixture root and durable operation store through Step 11 protected readback. Record basename, device/inode, authority, requester, store root, and stopped PIDs; guarded removal is permitted only after every fixture operation rereads successfully. Its authority is `isolated-controlled` and the final receipt must say the live-provider large-PGS gate did not pass.

The isolated large-PGS launcher injects its exact controlled
`{provider:'controlled',model:'controlled-pgs'}` sweep and synthesis pairs into
the request and receipt-validation path; it may not rely on an implicit server
default that the acceptance helper cannot independently bind.

The boundary script accepts `--catalog`, one target selector, and `--phase before|after|compare`; it validates exactly seven named entries and the resident/research root rules above, then recursively emits sorted boundary/path/type/size/mtime/SHA-256 records plus explicit absent-root records and the source manifest revision. If two kinds name the same root it walks the root once but emits records under both kinds. It never broadens a resident root to the containing agent instance and never follows a symlink.

The sampler accepts two or more named targets (`--target dashboard=pm2:home23-jerry-dash`, `--target cosmo=pm2:home23-cosmo23`, or isolated `pid+metrics` targets), launches the exact command after `--`, and polls each target's V8 used-heap, PID, restart count, and metric update timestamp. Every metrics request records request-start and response-completion bounds, uses response completion as `observedAt`, and requires the server metric timestamp to fall within that request window plus the published tolerance; a legitimate server timestamp produced after request start is never misclassified as negative-age stale. Response bodies are bounded before parsing. A proof needs baseline plus at least two in-window samples whose metric timestamps advance and are no older than `--max-metric-age-ms`; cached/pre-command PM2 values are rejected. It writes the `runtime-memory-evidence-v2` per-target baseline/maximum/growth/restart/PID/freshness schema and exits nonzero on missing/stale samples, PID replacement, restart delta, or `--max-heap-growth-mib 256` excess. Use this around graph, Direct Query, and PGS—not graph alone—and sample both the requester dashboard and COSMO that actually execute each command.

The persistence verifier accepts `--mode read-only|temp-save-clone`, `--home23-root`, `--agent`, `--brain`, `--temp-root`, `--max-heap-used-mib`, `--max-rss-mib`, and `--output`. The external temp root is mandatory in both modes so legacy projection/scratch never lands in the live installation. It realpaths the named source and requires it to equal the expected live agent brain. Read-only mode invokes the production streaming source reader, hashes and counts the complete logical node/edge streams, compares the revision and totals with `memory-manifest.json.summary` when present, and then re-resolves and re-hashes the source. For legacy input, the authoritative logical view is the production reader's selected base plus committed delta prefix; `brain-snapshot.json` remains advisory even when present. The verifier records snapshot state (`valid`, `invalid`, or `missing`), `matchesStreamed:true|false|null`, and explicit count/revision/generation gaps but does not fail a valid stream solely for snapshot disagreement. It emits the selected authority, revision, streamed/manifest/snapshot totals and status, complete sorted before/after hashes, logical hashes, observed heap/RSS peaks and limits, `fullMaterializerUsed:false`, and `unchanged:true`; a concurrent legitimate writer still makes this attempt fail and must be retried only after the engine is quiet.

Temp-save mode first performs the same live streaming proof, then creates its own unpredictable clone beneath the supplied external temp root, copies the full physical bytes of every selected source file plus the advisory snapshot, and checks source/clone identities and SHA-256 values before importing `persistMemoryRevision`. It supplies a change-only memory facade whose full materializer throws, appends one clone-only canary without a periodic rewrite, stream-reads the committed clone, and proves exactly one new node and no target mutation. It then force-rewrites and production-reloads only a bounded two-node/one-edge representative clone derived from the largest real live records. It refuses any writer path inside `home23Root`, records `sourceBrainDir`, `writeBrainDir`, copy hashes, canary evidence, bounded-force-full evidence, and the explicit full-live prohibition, and uses prefix/device/inode checks for guarded cleanup. It never passes a live path to `persistMemoryRevision` and leaves the external temp root empty.

`guarded-pm2-save.mjs` accepts `--dump ~/.pm2/dump.pm2`, `--allow-changed <exact comma-list>`, `--ecosystem <absolute ecosystem.config.cjs>`, `--expected-configured <exact comma-list>`, `--restart-baseline <Step-3 after-stability.json>`, `--mode dry-run|apply`, and the receipt-run authority arguments. The expected list must equal every required/optional allowlisted ecosystem row that exists exactly once. It captures `pm2 jlist` immediately before each attempt, classifies PM2 modules separately, requires their identity/status/PID/restart projection to remain frozen, excludes them from the application dump equality set, and requires every expected application exactly once and online. It normalizes each application entry's name/cardinality/status/PID/restart/uptime/script/cwd/namespace/exec mode/instances/args/interpreter/node args and environment **key names only**. For unrelated applications, restart counters must be greater than or equal to the earlier rollout baseline and frozen between the attempt's immediate pre/post samples; identity/config/status/PID/uptime may not drift. Any missing expected row, unrelated difference, duplicate, stopped/errored entry, module movement, counter regression, table change between frozen pre/post snapshots, or missing dump blocks `pm2 save`. A new allowlisted row absent from the old dump is accepted only when its script/cwd/namespace/exec mode/instances/args/interpreter/node args exactly match normalized ecosystem authority. Every dry-run and apply attempt creates its own unpredictable mode-0600 `wx` backup path and refuses reuse; dry-run proves all preconditions without invoking `pm2 save`, while apply invokes exactly `pm2 save`, validates the new dump against the frozen live application table and module freeze, and atomically restores only that apply attempt's backup on any failed postcondition. It never prints environment values.

`withEphemeralMemorySource()` must acquire an immediate, nonwaiting cross-process admission lock keyed by the exact canonical brain under `<home23Root>/runtime/brain-source-compatibility-admission-locks` **before** calling the UUID factory, creating an operation root/quota, classifying manifest versus legacy format, or opening/projecting the source. All dashboard-source, MCP, and COSMO compatibility opens share that canonical-source lock, including sources that presently appear manifest-v1 so a format transition cannot race admission. A contender returns `source_busy` with `retryable:true`; the dashboard brain-source route, dashboard memory-search boundary, and COSMO brain-source router preserve that error as HTTP 503. The admitted call returns its exact abort/callback error and releases the lock in `finally`; different canonical brain roots remain independent.

Operation scratch ancestry is created one component at a time beneath the canonical nonsymlink Home23 root and must remain outside the canonical target brain. Cleanup captures the owned operation root's dev/inode, revalidates every ancestor, renames only that identity to a same-parent unique quarantine, verifies the pathname was not replaced, and removes only the quarantined identity. A pre-existing root returns retryable `source_busy`; symlink ancestry, renamed-away roots, or path turnover fail closed without adopting, crossing into, or deleting another owner's bytes.

The cron `kind:'query'` branch must call `runCronBrainQuery(brainOperations, payload, MODEL_ALIASES, signal)` and must not call `queryEngine()` or the legacy `/api/query` facade. Its default attachment signal is exactly `5_400_000` ms unless the job supplies `timeoutSeconds`. The adapter validates a bounded nonempty message and one of `quick|full|expert|dive`, maps a named alias to its exact nonempty `{provider,model}` pair, and invokes `BrainOperationsClient.query()` once. A complete result requires a nonempty answer; queued/running returns an honest still-running reattachment message with the exact operation ID; partial requires both useful answer and typed error; failed/cancelled/expired throws the operation's typed code and ID. Cron tool and system-prompt descriptions state durable no-tools query and the 5,400-second ordinary contract, never the legacy 120-second expectation.

`cleanup-orphan-brain-projections.mjs` has a separate two-phase safety interface because it is used to clear the incident before disk/memory/full-suite gates. Dry-run requires `--home-root <canonical absolute root>`, repeated `--agent`, repeated `--port`, optional repeated disjoint `--protected-port`, and a new absolute `--receipt`; the explicit monitored ports are redundant assertions and must exactly equal the stopped PM2 rows' derived environment union. Apply additionally requires `--apply --manifest <mode-0600 dry-run receipt> --approval-token APPLY-ORPHAN-BRAIN-PROJECTIONS:<approvalScopeSha256> --approval-actor <trimmed bounded actor> --approval-text <exact reviewed approval> --approval-at <canonical UTC ISO timestamp>` plus a second new receipt. The checksum-bound dry-run receipt must contain the full manifest digest, mandatory `approvalScopeSha256`, its matching token, and canonical `createdAt`; apply rejects an approval time earlier than that `createdAt`. It selects only immediate `dashboard-source-<uuid>` children, requires the exact four engine/dashboard PM2 rows stopped with PID zero, binds any protected listener inventory by exact port/PID/command/boot/process-start identity, and uses captured scratch-owner/process-start identities plus open-FD inspection. Its immutable manifest includes selected/excluded/nonselected roots, each candidate tree digest and logical/allocated byte total, PM2 port bindings, listener/FD gates, exact brain/nonselected before hashes, and an explicit exclusion record for every root that is not independently safe to remove; mutable filesystem statistics remain receipt telemetry outside the deletion approval scope. Apply requires exact manifest-bound agents/ports/approval-scope token and explicit post-preflight approval record, reruns a fresh full preflight, and requires the fresh approval-scope digest to remain identical even though protected content bytes and filesystem telemetry may advance. The fresh manifest becomes the apply-start boundary authority. It writes a pending candidate intent, uses a random same-parent mode-0700 exclusive quarantine container, refuses destination races, rechecks safety again before removal, and routes candidate/quarantine `mkdir`, `rename`, `rm`, and `rmdir` only through scope-checked audited wrappers with intent plus one completed/failed/unknown outcome. Receipt publication remains separately named mode-0600 bounded identity/readback evidence. The terminal receipt writes explicit brain/nonselected after hashes alongside their fresh apply-start values, requires zero structural scope drift with protected root identities and membership intact, and reconciles any identity-stable content change exactly through `concurrentContentDrift`. Receipt/manifest reads are bounded to 64 MiB and identity-checked through final readback. The final receipt must reconcile selected versus removed bytes, pre/post filesystem available bytes, and final PM2/listener/open-FD evidence; `removed_postcondition_failed` and `removal_state_unknown` are truthful partial failures. The tool never treats an excluded root as removable, never broadens to another operation name, and never runs without fresh operator approval after the dry-run summary is shown. The reviewed live expectation is 248 eligible and seven exclusions—six hardlink-pair crash-window roots plus one zero candidate—and any different fresh classification requires renewed review rather than forced cleanup.

The portable runtime prompt must say ordinary query attachments wait up to 90 minutes, PGS/synthesis attachments wait up to six hours while verified activity continues, and a detached caller preserves the operation ID and uses `brain_status` wait/result rather than restarting. The query dashboard describes PGS as durable/reattachable and says large runs may take hours; it contains no fixed minute estimate. The live Jerry `SOUL.md`, `LEARNINGS.md`, and `MEMORY.md` receive the same dated correction idempotently before Jerry restarts; historical notes may remain only beneath an explicit top-of-file supersession.

`verify-live-deployment-tree.mjs` has `prepare`, `seal`, and `verify` modes, accepts explicit base/feature/live/audit paths, uses only an external expected directory and external `GIT_INDEX_FILE`, and emits the expected/actual tree OIDs plus index/untracked hashes. It never writes the live checkout or live index.

Rerun all four focused commands above; expected: all PASS. Add all seven helper test paths to `npm test` and prove each path appears exactly once in the script string. The admission, HTTP-503, runtime-prompt, durable-cron, entrypoint-caller, and dashboard-copy paths also remain explicit focused commands even when a broader test glob covers them.

```bash
node - <<'NODE'
const script = require('./package.json').scripts.test;
for (const file of [
  'tests/scripts/live-brain-tools-smoke.test.cjs',
  'tests/scripts/hash-brain-boundaries.test.cjs',
  'tests/scripts/sample-process-memory.test.cjs',
  'tests/scripts/verify-brain-persistence.test.cjs',
  'tests/scripts/guarded-pm2-save.test.cjs',
  'tests/scripts/cleanup-orphan-brain-projections.test.cjs',
  'tests/scripts/verify-live-deployment-tree.test.cjs',
  'tests/agent/tools/cron.test.ts',
  'tests/agent/turn-entrypoint-callers.test.ts',
]) {
  const count = script.split(file).length - 1;
  if (count !== 1) throw new Error(`${file} registered ${count} times`);
}
NODE
```

- [ ] **Step 0B: Commit/push the focused storm remediation, then reconcile stopped live bytes without losing pending work**

In the isolated worktree, run the bounded pre-cleanup regression matrix, then commit only the explicit remediation/helper/package paths and push the feature branch. Full gates remain deferred to Step 0D because running them at 99-percent disk use is itself unsafe:

The filesystem is already 99% used from the proved projection storm. Do **not** run the full prerequisite matrices, build, aggregate test, contracts, heap probes, or any other disk/memory-heavy gate until Step 0D completes the approved cleanup. Define the exact A-C groups now for the post-cleanup gate, but before committing run only the bounded storm/admission/cleanup/prompt/UI regressions shown after the arrays.

```bash
A_TESTS=(
  tests/cosmo23/brain-catalog-contract.test.cjs tests/cosmo23/brain-operation-worker.test.cjs
  tests/cli/brain-operations-capability.test.js tests/cli/brain-operations-list.test.js
  tests/engine/cli-onboarding.test.js tests/engine/dashboard/brain-operation-authority.test.js
  tests/engine/dashboard/brain-operation-capability.test.js tests/engine/dashboard/brain-operation-coordinator.test.js
  tests/engine/dashboard/brain-operation-exporter.test.js tests/engine/dashboard/brain-operation-routes.test.js
  tests/engine/dashboard/brain-operation-store.test.js
  tests/shared/memory-source-adapters.test.js tests/shared/memory-source-contracts.test.js
  tests/shared/memory-source-pin.test.js tests/shared/memory-source-reader.test.js tests/shared/memory-source-writer.test.js
)
B_TESTS=(
  tests/cosmo23/brain-source-router.test.cjs tests/cosmo23/legacy-research-memory-source.test.cjs
  tests/cosmo23/mcp-http-loopback.test.cjs tests/cosmo23/mcp-memory-tools.test.cjs
  tests/cosmo23/memory-sidecar.test.cjs tests/cosmo23/network-memory-embedding-batch.test.cjs
  tests/cosmo23/research-memory-manifest.test.cjs tests/engine/agents/mcp-bridge-memory.test.js
  tests/cosmo23/agent-executor-memory-context.test.cjs
  tests/engine/agents/agent-executor-memory-context.test.js
  tests/engine/core/brain-backups.test.cjs tests/engine/core/brain-persistence-guard.test.js
  tests/engine/core/memory-persistence.test.js tests/engine/core/memory-sidecar.test.cjs
  tests/engine/dashboard/brain-graph-export.test.js tests/engine/dashboard/brain-source-api.test.js
  tests/engine/dashboard/brain-source-executors.test.js tests/engine/dashboard/brain-source-mutation-boundary.test.js
  tests/engine/dashboard/dashboard-state-summary.test.js tests/engine/dashboard/mcp-availability.test.js
  tests/engine/dashboard/memory-search.test.js tests/engine/mcp/http-loopback.test.js
  tests/engine/mcp/memory-tools.test.js tests/engine/memory/network-memory-access.test.js
  tests/engine/memory/network-memory-embedding-batch.test.js
  tests/engine/memory/network-memory-persistence-generation.test.js tests/engine/merge/build-ann-index.test.js
  tests/evobrew/memory-sidecar.test.cjs tests/shared/memory-source-graph.test.js
  tests/shared/memory-source-operation-context.test.js
)
C_TESTS=(
  tests/cosmo23/anthropic-client-request.test.cjs tests/cosmo23/brain-operation-worker.test.cjs
  tests/cosmo23/chat-completions-terminal.test.cjs tests/cosmo23/codex-responses-client.test.cjs
  tests/cosmo23/cross-brain-readonly.test.cjs tests/cosmo23/gpt5-client-stream.test.cjs
  tests/cosmo23/pgs-cancellation.test.cjs tests/cosmo23/pgs-engine.test.cjs
  tests/cosmo23/pgs-retry-state.test.cjs tests/cosmo23/pgs-source-pin.test.cjs
  tests/cosmo23/pinned-pgs-store.test.cjs tests/cosmo23/pinned-query-projection.test.cjs
  tests/cosmo23/provider-completion.test.cjs tests/cosmo23/query-engine-context.test.cjs
  tests/cosmo23/query-engine-mutation-boundary.test.cjs tests/cosmo23/query-engine-runtime.test.cjs
  tests/cosmo23/query-engine-source-pin.test.cjs tests/cosmo23/query-operation-worker.test.cjs
  tests/engine/dashboard/brain-synthesis-operation.test.js tests/engine/dashboard/runtime-health.test.js
  tests/engine/synthesis/synthesis-agent.test.js
  tests/engine/synthesis/synthesis-provider-registry.test.js
)
node --test --test-concurrency=1 \
  tests/scripts/cleanup-orphan-brain-projections.test.cjs \
  tests/shared/memory-source-operation-context.test.js \
  tests/engine/dashboard/brain-source-api.test.js \
  tests/engine/dashboard/memory-search.test.js \
  tests/cosmo23/brain-source-router.test.cjs
node --import tsx --test --test-concurrency=1 \
  tests/agent/tools/brain.test.ts tests/agent/tools/cron.test.ts \
  tests/agent/turn-entrypoint-callers.test.ts
node --test --test-concurrency=1 tests/dashboard/operator-ui.test.js
```

An absent path, skipped unexpected test, or nonzero focused result blocks the remediation commit. This is the sole disk-pressure exception to the normal pre-commit full matrix: Step 0D must run A-C, all seven helper tests, build, aggregate test, contracts, and portability on both the isolated commit and final combined live bytes after cleanup and before any prepare/restart.

```bash
git diff --cached --quiet
IMPLEMENTATION_PATHS=(
  package.json
  shared/memory-source/operation-context.cjs
  engine/src/dashboard/brain-source-api.js engine/src/dashboard/server.js
  cosmo23/server/lib/brain-source-router.js
  src/agent/cron-brain-query.ts src/home.ts src/agent/tools/cron.ts
  src/agents/system-prompt.ts engine/src/dashboard/home23-query.js
  scripts/live-brain-tools-smoke.mjs scripts/hash-brain-boundaries.mjs
  scripts/sample-process-memory.mjs scripts/verify-brain-persistence.mjs
  scripts/guarded-pm2-save.mjs scripts/cleanup-orphan-brain-projections.mjs
  scripts/verify-live-deployment-tree.mjs
  tests/scripts/live-brain-tools-smoke.test.cjs tests/scripts/hash-brain-boundaries.test.cjs
  tests/scripts/sample-process-memory.test.cjs tests/scripts/verify-brain-persistence.test.cjs
  tests/scripts/verify-brain-persistence-heap-probe.cjs tests/scripts/guarded-pm2-save.test.cjs
  tests/scripts/cleanup-orphan-brain-projections.test.cjs
  tests/scripts/verify-live-deployment-tree.test.cjs
  tests/shared/memory-source-operation-context.test.js
  tests/engine/dashboard/brain-source-api.test.js tests/engine/dashboard/memory-search.test.js
  tests/cosmo23/brain-source-router.test.cjs tests/agent/tools/brain.test.ts
  tests/agent/tools/cron.test.ts tests/agent/turn-entrypoint-callers.test.ts
  tests/dashboard/operator-ui.test.js
  docs/design/COSMO23-VENDORED-PATCHES.md
)
git add -- "${IMPLEMENTATION_PATHS[@]}"
git diff --cached --check
git diff --cached -- "${IMPLEMENTATION_PATHS[@]}"
git commit --only "${IMPLEMENTATION_PATHS[@]}" -m "fix: serialize compatibility brain projections"
git push -u origin codex/brain-agent-migration
IMPLEMENTATION_PUSH_COMMIT=$(git rev-parse HEAD)
git fetch origin codex/brain-agent-migration
test "$IMPLEMENTATION_PUSH_COMMIT" = "$(git rev-parse origin/codex/brain-agent-migration)"
```

Before touching the primary live checkout, capture its branch/status, cached diff, working diff, and untracked-name inventory to a timestamped operator-only directory outside Git; do not copy ignored secrets or runtime data. Use this exact preflight:

```bash
ISOLATED_ROOT=$(pwd -P)
LIVE_ROOT=/Users/jtr/_JTR23_/release/home23
SYSTEM_TMPDIR=$(cd "${TMPDIR:-/tmp}" && pwd -P)
DEPLOY_AUDIT=$(mktemp -d "$SYSTEM_TMPDIR/home23-brain-deploy-$(date +%Y%m%dT%H%M%S).XXXXXX")
git -C "$LIVE_ROOT" status --short --branch > "$DEPLOY_AUDIT/status-before.txt"
git -C "$LIVE_ROOT" ls-files -s > "$DEPLOY_AUDIT/index-before.txt"
git -C "$LIVE_ROOT" diff --cached --binary > "$DEPLOY_AUDIT/cached-before.patch"
git -C "$LIVE_ROOT" diff --binary > "$DEPLOY_AUDIT/working-before.patch"
git -C "$LIVE_ROOT" ls-files --others --exclude-standard > "$DEPLOY_AUDIT/untracked-before.txt"
git -C "$LIVE_ROOT" ls-files --others --exclude-standard -z | xargs -0 -I{} sh -c \
  'test ! -f "$1" || shasum -a 256 "$1"' _ "$LIVE_ROOT/{}" > "$DEPLOY_AUDIT/untracked-hashes-before.txt"
LIVE_BASE=$(git -C "$LIVE_ROOT" merge-base HEAD "$IMPLEMENTATION_PUSH_COMMIT")
git -C "$ISOLATED_ROOT" diff --name-only "$LIVE_BASE" "$IMPLEMENTATION_PUSH_COMMIT" | sort -u > "$DEPLOY_AUDIT/feature-paths.txt"
{ git -C "$LIVE_ROOT" diff --name-only; git -C "$LIVE_ROOT" diff --cached --name-only; git -C "$LIVE_ROOT" ls-files --others --exclude-standard; } | sort -u > "$DEPLOY_AUDIT/pending-paths.txt"
comm -12 "$DEPLOY_AUDIT/feature-paths.txt" "$DEPLOY_AUDIT/pending-paths.txt" > "$DEPLOY_AUDIT/overlap-paths.txt"
```

If the live tracked tree is clean and no untracked path collides with a feature path, use the ordinary fast-forward path. Do not run the external deployment-tree verifier in this case: its pre-deployment index seal is intentionally stable, while a legitimate fast-forward replaces the index. Prove the new tracked tree directly from the pushed commit and record both the expected and actual tree OIDs:

```bash
if git -C "$LIVE_ROOT" diff --quiet \
    && git -C "$LIVE_ROOT" diff --cached --quiet \
    && test ! -s "$DEPLOY_AUDIT/overlap-paths.txt"; then
  DEPLOYMENT_MODE=fast-forward
  git -C "$LIVE_ROOT" merge --ff-only "$IMPLEMENTATION_PUSH_COMMIT"
  test "$(git -C "$LIVE_ROOT" rev-parse HEAD)" = "$IMPLEMENTATION_PUSH_COMMIT"
  EXPECTED_LIVE_TREE=$(git -C "$ISOLATED_ROOT" rev-parse "$IMPLEMENTATION_PUSH_COMMIT^{tree}")
  ACTUAL_LIVE_TREE=$(git -C "$LIVE_ROOT" rev-parse "HEAD^{tree}")
  test "$EXPECTED_LIVE_TREE" = "$ACTUAL_LIVE_TREE"
  git -C "$LIVE_ROOT" diff --quiet
  git -C "$LIVE_ROOT" diff --cached --quiet
  git -C "$LIVE_ROOT" ls-files -s > "$DEPLOY_AUDIT/index-after.txt"
  git -C "$LIVE_ROOT" ls-files --others --exclude-standard -z | xargs -0 -I{} sh -c \
    'test ! -f "$1" || shasum -a 256 "$1"' _ "$LIVE_ROOT/{}" > "$DEPLOY_AUDIT/untracked-hashes-after.txt"
  cmp "$DEPLOY_AUDIT/untracked-hashes-before.txt" "$DEPLOY_AUDIT/untracked-hashes-after.txt"
  export DEPLOYMENT_MODE IMPLEMENTATION_PUSH_COMMIT EXPECTED_LIVE_TREE ACTUAL_LIVE_TREE
  node - "$DEPLOY_AUDIT/clean-fast-forward.json" <<'NODE'
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], `${JSON.stringify({
  mode: process.env.DEPLOYMENT_MODE,
  implementationCommit: process.env.IMPLEMENTATION_PUSH_COMMIT,
  expectedTree: process.env.EXPECTED_LIVE_TREE,
  actualTree: process.env.ACTUAL_LIVE_TREE,
  indexTransitionExpected: true,
}, null, 2)}\n`);
NODE
else
  DEPLOYMENT_MODE=combined
fi
```

If `DEPLOYMENT_MODE=combined`, preserve pending work without stashing, resetting, checking out, copying wholesale, or touching the index. Run `verify-live-deployment-tree.mjs prepare` against the exact base, pushed feature, and live bytes. A reported conflict is a hard stop; the current helper has no authenticated conflict-resolution mode, so do not claim that an externally edited resolution is sealed. For a conflict-free combined tree, inspect every generated `{path,baseOid,featureOid,liveHash,mergedHash,resolution}` row, then seal it:

```bash
if test "$DEPLOYMENT_MODE" = combined; then
  node "$ISOLATED_ROOT/scripts/verify-live-deployment-tree.mjs" prepare \
    --base "$LIVE_BASE" --feature "$IMPLEMENTATION_PUSH_COMMIT" \
    --live-root "$LIVE_ROOT" --audit-dir "$DEPLOY_AUDIT"
  node "$ISOLATED_ROOT/scripts/verify-live-deployment-tree.mjs" seal \
    --base "$LIVE_BASE" --feature "$IMPLEMENTATION_PUSH_COMMIT" \
    --live-root "$LIVE_ROOT" --audit-dir "$DEPLOY_AUDIT"
  EXPECTED_LIVE_TREE=$(node -p "require(process.argv[1]).expectedTree" "$DEPLOY_AUDIT/deployment-tree.json")
fi
```

For a conflict-free combined deployment only, apply the reviewed generated hunks to live working files with `apply_patch`, never to the live index. Then let the helper build a second external index from the resulting live working bytes and exact expected path set, save `ACTUAL_LIVE_TREE`, and require exact equality. Also require the live cached index bytes and unrelated untracked hashes to remain unchanged. A prose claim such as `feature + pending work` without the two equal Git tree OIDs is not acceptance:

```bash
if test "$DEPLOYMENT_MODE" = combined; then
  git -C "$LIVE_ROOT" ls-files -s > "$DEPLOY_AUDIT/index-after.txt"
  git -C "$LIVE_ROOT" diff --cached --binary > "$DEPLOY_AUDIT/cached-after.patch"
  cmp "$DEPLOY_AUDIT/index-before.txt" "$DEPLOY_AUDIT/index-after.txt"
  cmp "$DEPLOY_AUDIT/cached-before.patch" "$DEPLOY_AUDIT/cached-after.patch"
  node "$ISOLATED_ROOT/scripts/verify-live-deployment-tree.mjs" verify \
    --base "$LIVE_BASE" --feature "$IMPLEMENTATION_PUSH_COMMIT" \
    --live-root "$LIVE_ROOT" --audit-dir "$DEPLOY_AUDIT"
  ACTUAL_LIVE_TREE=$(node -p "require(process.argv[1]).actualTree" "$DEPLOY_AUDIT/deployment-tree.json")
  test "$EXPECTED_LIVE_TREE" = "$ACTUAL_LIVE_TREE"
fi
git -C "$LIVE_ROOT" ls-files --others --exclude-standard -z | xargs -0 -I{} sh -c \
  'test ! -f "$1" || shasum -a 256 "$1"' _ "$LIVE_ROOT/{}" > "$DEPLOY_AUDIT/untracked-hashes-after.txt"
cmp "$DEPLOY_AUDIT/untracked-hashes-before.txt" "$DEPLOY_AUDIT/untracked-hashes-after.txt"
cd "$LIVE_ROOT"
git diff --check
```

The receipt must name `fast-forward` or `combined`, record `EXPECTED_LIVE_TREE == ACTUAL_LIVE_TREE`, the pushed feature/base OIDs, the focused pre-cleanup totals, the explicit full-matrix deferral reason `projection_storm_disk_99_percent`, and unchanged unrelated-untracked proof. A clean fast-forward records the expected index transition plus clean worktree/index afterward. A conflict-free combined deployment records every generated merge row plus the object-identical pre/post index proof. Any merge conflict stops deployment. These commands run in the actual live checkout; do not run `brain-operations prepare` or point PM2 at the isolated worktree.

- [ ] **Step 0C: Initialize one dedicated authority-tagged receipt run directory**

Create this once in the live checkout before the first operational observation. Deployment staging remains external and pre-authority; every acceptance artifact produced after this step is written directly beneath `live/` or `isolated-controlled/`. System temporary space is used only for disposable fixture/clone roots whose resulting evidence is copied and hashed into this authority tree.

```bash
cd /Users/jtr/_JTR23_/release/home23
LIVE_ROOT=$(pwd -P)
SYSTEM_TMPDIR=$(cd "${TMPDIR:-/tmp}" && pwd -P)
RECEIPT_RUN_ID=$(node -e "console.log(require('node:crypto').randomUUID())")
RECEIPT_RUN_DIR="$LIVE_ROOT/runtime/brain-acceptance/$RECEIPT_RUN_ID"
LIVE_RECEIPT_DIR="$RECEIPT_RUN_DIR/live"
ISOLATED_RECEIPT_DIR="$RECEIPT_RUN_DIR/isolated-controlled"
umask 077
mkdir -p "$LIVE_RECEIPT_DIR" "$ISOLATED_RECEIPT_DIR"
test "$(cd "$RECEIPT_RUN_DIR" && pwd -P)" = "$RECEIPT_RUN_DIR"
test ! -L "$RECEIPT_RUN_DIR"
git check-ignore -q "$RECEIPT_RUN_DIR"
export RECEIPT_RUN_ID RECEIPT_RUN_DIR LIVE_RECEIPT_DIR ISOLATED_RECEIPT_DIR \
  IMPLEMENTATION_PUSH_COMMIT EXPECTED_LIVE_TREE ACTUAL_LIVE_TREE SYSTEM_TMPDIR
export HOME23_RECEIPT_RUN_DIR="$RECEIPT_RUN_DIR"
export HOME23_RECEIPT_RUN_ID="$RECEIPT_RUN_ID"
export HOME23_RECEIPT_AUTHORITY=live
export HOME23_RECEIPT_IMPLEMENTATION_COMMIT="$IMPLEMENTATION_PUSH_COMMIT"
node - "$RECEIPT_RUN_DIR" "$RECEIPT_RUN_DIR/run-authority.json" <<'NODE'
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const [rootArgument, output] = process.argv.slice(2);
const root = fs.realpathSync(rootArgument);
const stat = fs.lstatSync(rootArgument);
const oid = /^[a-f0-9]{40}$/;
if (stat.isSymbolicLink() || !stat.isDirectory() || root !== rootArgument
    || output !== path.join(root, 'run-authority.json')
    || !oid.test(process.env.IMPLEMENTATION_PUSH_COMMIT || '')
    || !oid.test(process.env.EXPECTED_LIVE_TREE || '')
    || !oid.test(process.env.ACTUAL_LIVE_TREE || '')
    || process.env.EXPECTED_LIVE_TREE !== process.env.ACTUAL_LIVE_TREE
    || process.env.HOME23_RECEIPT_IMPLEMENTATION_COMMIT !== process.env.IMPLEMENTATION_PUSH_COMMIT
    || process.env.HOME23_RECEIPT_RUN_DIR !== root
    || process.env.HOME23_RECEIPT_RUN_ID !== process.env.RECEIPT_RUN_ID
    || process.env.HOME23_RECEIPT_AUTHORITY !== 'live') {
  throw new Error('run_authority_precondition_invalid');
}
const record = {
  schemaVersion: 1,
  receiptRunId: process.env.RECEIPT_RUN_ID,
  authority: 'live',
  implementationCommit: process.env.IMPLEMENTATION_PUSH_COMMIT,
  expectedLiveTree: process.env.EXPECTED_LIVE_TREE,
  actualLiveTree: process.env.ACTUAL_LIVE_TREE,
  hostname: os.hostname(),
  startedAt: new Date().toISOString(),
};
const descriptor = fs.openSync(output,
  fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
  0o600);
try {
  fs.writeFileSync(descriptor, JSON.stringify(record, null, 2) + '\n');
  fs.fsyncSync(descriptor);
} finally {
  fs.closeSync(descriptor);
}
const written = fs.lstatSync(output);
if (!written.isFile() || written.isSymbolicLink() || (written.mode & 0o777) !== 0o600
    || fs.realpathSync(output) !== output) throw new Error('run_authority_write_invalid');
NODE
```

`run-authority.json` is created once and is the strict, immutable, sole authority for receipt run ID, implementation commit, expected/actual live tree, and hostname. All helper invocations inherit the exact assertions above or pass equivalent run-directory/run-ID/authority flags, but every helper must reread the file and derive `implementationCommit` from it. An asserted commit mismatch is `receipt_implementation_commit_mismatch`; helpers never fall back to `HEAD`, an environment value, or their own tree observation. This applies equally when `HOME23_RECEIPT_AUTHORITY=isolated-controlled`: isolated operation authority changes, but run/commit/tree identity does not. Every helper-produced JSON/JSONL row must match the file's run ID and implementation commit, and every terminal operation row must carry both.

Raw PM2/curl/TAP output is named directly under `$LIVE_RECEIPT_DIR`; disposable external clones use `$SYSTEM_TMPDIR` explicitly. Isolated commands set `HOME23_RECEIPT_AUTHORITY=isolated-controlled` and name outputs directly under `$ISOLATED_RECEIPT_DIR`. Raw third-party captures that cannot embed fields are classified `kind:'raw'` in the final artifact manifest and receive run ID/authority/implementation commit on that entry through their directory plus `run-authority.json`. Build exactly one immutable `artifact-manifest.json` only in Step 15, after fixture cleanup, guarded PM2 save, all final TAP/readback artifacts, and status-push evidence already exist. Its builder recursively hashes every regular file without following symlinks, excluding only the manifest and detached digest while constructing them, validates every machine receipt against `run-authority.json`, then writes `artifact-manifest.json` atomically and `artifact-manifest.sha256` over its final bytes. The separate `--verify-artifact-manifest` mode is read-only and must not write an output inside the run root. No acceptance artifact may be added after that final path-set seal. A reused path, pre-existing file, outside realpath, symlink, mixed run ID, mismatched implementation commit, or missing authority stops acceptance.

- [ ] **Step 0D: Clean the proved projection storm under explicit approval, correct live guidance, then run deferred full gates**

First record—do not replay—the differing stop provenance: Jerry and Forrest engines were already stopped/quiesced by the persistence/acceptance gate, then the emergency response issued exactly `pm2 stop home23-jerry-dash` and later `pm2 stop home23-forrest-dash`. The exact Jerry/Forrest engines and dashboards must now each exist once with `status:'stopped'` and PID zero; the two harnesses and shared COSMO must each exist once and online. Capture MCP and every unrelated row as found. The cleaner derives and binds each selected agent's realtime, dashboard, and MCP HTTP ports from the stopped engine/dashboard PM2 environment; the explicit six-port assertion below must equal that union, and none may have a listener. These are read-only observations; do not issue another stop, restart, delete, or broad PM2 command:

```bash
cd "$LIVE_ROOT"
df -Pk "$LIVE_ROOT" > "$LIVE_RECEIPT_DIR/disk-before-orphan-cleanup.txt"
df -h "$LIVE_ROOT" > "$LIVE_RECEIPT_DIR/disk-before-orphan-cleanup-human.txt"
pm2 jlist | node -e '
let input="";
process.stdin.on("data", chunk => { input += chunk; }).on("end", () => {
  const names = new Set([
    "home23-jerry", "home23-jerry-dash", "home23-jerry-harness", "home23-jerry-mcp",
    "home23-forrest", "home23-forrest-dash", "home23-forrest-harness", "home23-forrest-mcp",
    "home23-cosmo23",
  ]);
  const rows = JSON.parse(input).filter(row => names.has(row.name)).map(row => ({
    name: row.name, pid: Number(row.pid || 0), status: row.pm2_env.status,
    restarts: row.pm2_env.restart_time, uptime: row.pm2_env.pm_uptime,
    script: row.pm2_env.pm_exec_path || null, cwd: row.pm2_env.pm_cwd || null,
  })).sort((left, right) => left.name.localeCompare(right.name));
  process.stdout.write(JSON.stringify(rows, null, 2));
});
' > "$LIVE_RECEIPT_DIR/pm2-emergency-deviation-observed.json"
node - "$LIVE_RECEIPT_DIR/pm2-emergency-deviation-observed.json" \
  "$RECEIPT_RUN_DIR/run-authority.json" \
  "$LIVE_RECEIPT_DIR/emergency-stop-deviation.json" <<'NODE'
const fs = require('node:fs');
const [stateFile, authorityFile, output] = process.argv.slice(2);
const rows = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const authority = JSON.parse(fs.readFileSync(authorityFile, 'utf8'));
const byName = new Map();
for (const row of rows) {
  if (byName.has(row.name)) throw new Error(`duplicate PM2 row ${row.name}`);
  byName.set(row.name, row);
}
const stopped = ['home23-jerry','home23-jerry-dash','home23-forrest','home23-forrest-dash'];
const online = ['home23-jerry-harness','home23-forrest-harness','home23-cosmo23'];
for (const name of stopped) {
  const row = byName.get(name);
  if (!row || row.status !== 'stopped' || row.pid !== 0) throw new Error(`${name} not exactly stopped`);
}
for (const name of online) {
  const row = byName.get(name);
  if (!row || row.status !== 'online' || !(row.pid > 0)) throw new Error(`${name} not online`);
}
fs.writeFileSync(output, `${JSON.stringify({
  schemaVersion: 1, receiptRunId: authority.receiptRunId,
  implementationCommit: authority.implementationCommit, authority: 'live',
  reason: 'compatibility_projection_storm_disk_99_percent',
  observedRootCount: 255, observedBytesGiB: 36.10,
  priorGateState: {
    alreadyStopped: ['home23-jerry','home23-forrest'],
  },
  priorEmergencyMutations: [
    'pm2 stop home23-jerry-dash',
    'pm2 stop home23-forrest-dash',
  ],
  replayed: false,
  stopped: stopped.map(name => byName.get(name)),
  requiredOnline: online.map(name => byName.get(name)),
  mcpObserved: ['home23-jerry-mcp','home23-forrest-mcp']
    .map(name => byName.get(name)).filter(Boolean),
}, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
NODE
for port in 5001 5002 5003 5011 5012 5015; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN \
      > "$LIVE_RECEIPT_DIR/listener-${port}-before-orphan-cleanup.txt" 2>&1; then
    echo "Refusing cleanup: listener remains on $port" >&2
    exit 1
  else
    test "$?" -eq 1
    test ! -s "$LIVE_RECEIPT_DIR/listener-${port}-before-orphan-cleanup.txt"
  fi
done
lsof -nP -iTCP:5013 -sTCP:LISTEN \
  > "$LIVE_RECEIPT_DIR/protected-listener-5013-before-orphan-cleanup.txt"
test "$(lsof -nP -t -iTCP:5013 -sTCP:LISTEN | sort -u | wc -l | tr -d ' ')" = 1
```

Run the portable cleaner from the exact isolated implementation commit. Its dry-run is nonmutating and must report exactly 255 immediate dashboard-source UUID candidates in total. The now-reviewed live expectation is 248 eligible and seven excluded: six internal hardlink-pair crash-window roots plus one zero candidate. Treat those numbers as a review expectation, not permission to coerce classification: any different preflight stops for renewed operator review. Selected allocated bytes should reconcile to approximately 38.67 decimal GB (about 36.0 GiB), consistent with the earlier approximately 36.10-GiB incident observation. The receipt must retain every excluded root's exact path, reason, dev/inode where available, and nonselected tree hash.

```bash
CLEANUP_PREFLIGHT="$LIVE_RECEIPT_DIR/orphan-projection-cleanup-preflight.json"
CLEANUP_PREFLIGHT_SUMMARY="$LIVE_RECEIPT_DIR/orphan-projection-cleanup-preflight-summary.json"
node "$ISOLATED_ROOT/scripts/cleanup-orphan-brain-projections.mjs" \
  --home-root "$LIVE_ROOT" --agent jerry --agent forrest \
  --port 5001 --port 5002 --port 5003 --port 5011 --port 5012 --port 5015 \
  --protected-port 5013 \
  --receipt "$CLEANUP_PREFLIGHT" | tee "$CLEANUP_PREFLIGHT_SUMMARY"
node - "$CLEANUP_PREFLIGHT" "$LIVE_RECEIPT_DIR/orphan-projection-cleanup-review.json" <<'NODE'
const fs = require('node:fs');
const [preflightFile, output] = process.argv.slice(2);
const receipt = JSON.parse(fs.readFileSync(preflightFile, 'utf8'));
const agents = receipt.manifest?.agents || [];
const eligible = agents.flatMap(agent => agent.eligible || []);
const excluded = agents.flatMap(agent => agent.excluded || []);
const selectedBytes = receipt.manifest?.candidateBytes || {};
const selectedAllocatedBytes = BigInt(selectedBytes.allocatedBytes || '-1');
const selectedAllocatedGB = Number(selectedAllocatedBytes) / 1e9;
const selectedAllocatedGiB = Number(selectedAllocatedBytes) / (1024 ** 3);
const protectedListeners = receipt.manifest?.listeners || [];
if (receipt.status !== 'dry_run'
    || receipt.kind !== 'home23-orphan-brain-projection-cleanup'
    || receipt.manifest?.kind !== 'home23-orphan-brain-projection-preflight'
    || JSON.stringify(receipt.manifest.selectedAgents) !== JSON.stringify(['forrest','jerry'])
    || JSON.stringify(receipt.manifest.ports) !== JSON.stringify([5001,5002,5003,5011,5012,5015])
    || JSON.stringify(receipt.manifest.protectedPorts) !== JSON.stringify([5013])
    || eligible.length !== 248 || excluded.length !== 7
    || eligible.length + excluded.length !== 255
    || selectedBytes.count !== eligible.length
    || !/^\d+$/.test(selectedBytes.logicalBytes || '')
    || !/^\d+$/.test(selectedBytes.allocatedBytes || '')
    || selectedAllocatedGB < 38.4 || selectedAllocatedGB > 38.9
    || excluded.filter(candidate => candidate.reasons?.includes('hardlink_rejected')).length !== 6
    || protectedListeners.length !== 1 || protectedListeners[0].port !== 5013
    || !(protectedListeners[0].pid > 0) || !protectedListeners[0].command
    || !protectedListeners[0].processIdentity?.bootToken
    || !protectedListeners[0].processIdentity?.processStartToken
    || !/^\d+$/.test(receipt.filesystem?.availableBytes || '')
    || !/^[a-f0-9]{64}$/.test(receipt.manifestSha256 || '')
    || !/^[a-f0-9]{64}$/.test(receipt.approvalScopeSha256 || '')
    || receipt.approvalToken !== `APPLY-ORPHAN-BRAIN-PROJECTIONS:${receipt.approvalScopeSha256}`
    || typeof receipt.createdAt !== 'string'
    || new Date(receipt.createdAt).toISOString() !== receipt.createdAt
    || agents.some(agent => !agent.brain?.treeSha256)
    || excluded.some(candidate => !(agents.find(agent => agent.agent === candidate.agent)?.nonselected || [])
      .some(row => row.name === candidate.name && Boolean(row.treeSha256)))) {
  throw new Error('orphan cleanup preflight does not match audited incident');
}
const review = {
  manifestSha256: receipt.manifestSha256,
  approvalScopeSha256: receipt.approvalScopeSha256,
  approvalToken: receipt.approvalToken,
  candidateCount: eligible.length + excluded.length,
  eligibleCount: eligible.length,
  excludedCount: excluded.length,
  selectedBytes,
  selectedAllocatedGB: Number(selectedAllocatedGB.toFixed(3)),
  selectedAllocatedGiB: Number(selectedAllocatedGiB.toFixed(3)),
  filesystemBefore: receipt.filesystem,
  pm2PortBindings: receipt.manifest.pm2PortBindings,
  protectedListeners,
  exclusions: excluded.map(candidate => ({
    agent: candidate.agent, name: candidate.name, path: candidate.path,
    identity: candidate.identity || null, reasons: candidate.reasons,
  })),
  brainBefore: agents.map(agent => ({ agent: agent.agent,
    path: agent.brain.path, treeSha256: agent.brain.treeSha256 })),
  nonselectedBefore: agents.flatMap(agent => agent.nonselected.map(row => ({
    agent: agent.agent, name: row.name, path: row.path, treeSha256: row.treeSha256,
    logicalBytes: row.tree?.logicalBytes, allocatedBytes: row.tree?.allocatedBytes,
  }))),
};
fs.writeFileSync(output, `${JSON.stringify(review, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
NODE
```

**Stop here and request explicit operator approval.** Show the operator both the full manifest SHA-256 and the deletion-authorizing approval-scope SHA-256/token, the reviewed `248 remove / 7 exclude / 255 total` split, approximately 38.67-GB selected allocation, every excluded root/reason (including six hardlink-pair crash-window roots and the zero candidate), four stopped PM2 rows with their differing provenance, the exact protected-5013 port/PID/command/boot/process-start identity, filesystem-before evidence, and brain/nonselected hashes. Approval of the plan, the two earlier dashboard stops, or a generic “continue” does not authorize apply. The resumed acceptance turn must capture the exact approval-scope token, trimmed bounded operator actor, exact approval text, and canonical UTC received-at timestamp no earlier than the dry-run receipt's `createdAt`. Do not derive the token, invent approval text, or populate an actor/time before an explicit approval message exists.

Only after that approval, supply the four exact captured fields and run apply with byte-identical explicit agents, monitored ports, and protected port:

```bash
test -n "${OPERATOR_APPROVED_CLEANUP_TOKEN:?explicit digest-bound operator approval required}"
test -n "${OPERATOR_CLEANUP_APPROVAL_ACTOR:?explicit operator actor required}"
test -n "${OPERATOR_CLEANUP_APPROVAL_TEXT:?exact operator approval text required}"
test -n "${OPERATOR_CLEANUP_APPROVAL_AT:?operator approval ISO timestamp required}"
test "$OPERATOR_APPROVED_CLEANUP_TOKEN" = \
  "$(node -p "require(process.argv[1]).approvalToken" "$CLEANUP_PREFLIGHT")"
CLEANUP_APPLY="$LIVE_RECEIPT_DIR/orphan-projection-cleanup-apply.json"
node "$ISOLATED_ROOT/scripts/cleanup-orphan-brain-projections.mjs" \
  --home-root "$LIVE_ROOT" --agent jerry --agent forrest \
  --port 5001 --port 5002 --port 5003 --port 5011 --port 5012 --port 5015 \
  --protected-port 5013 \
  --apply --manifest "$CLEANUP_PREFLIGHT" \
  --approval-token "$OPERATOR_APPROVED_CLEANUP_TOKEN" \
  --approval-actor "$OPERATOR_CLEANUP_APPROVAL_ACTOR" \
  --approval-text "$OPERATOR_CLEANUP_APPROVAL_TEXT" \
  --approval-at "$OPERATOR_CLEANUP_APPROVAL_AT" \
  --receipt "$CLEANUP_APPLY" \
  | tee "$LIVE_RECEIPT_DIR/orphan-projection-cleanup-apply-summary.json"
node - "$CLEANUP_PREFLIGHT" "$CLEANUP_APPLY" \
  "$OPERATOR_CLEANUP_APPROVAL_ACTOR" "$OPERATOR_CLEANUP_APPROVAL_TEXT" \
  "$OPERATOR_CLEANUP_APPROVAL_AT" <<'NODE'
const fs = require('node:fs');
const [preflightFile, applyFile, approvalActor, approvalText, approvalAt] = process.argv.slice(2);
const before = JSON.parse(fs.readFileSync(preflightFile, 'utf8'));
const after = JSON.parse(fs.readFileSync(applyFile, 'utf8'));
const eligible = before.manifest.agents.flatMap(agent => agent.eligible);
const excluded = before.manifest.agents.flatMap(agent => agent.excluded);
const expectedExcludedPaths = excluded.map(row => row.path).sort();
const actualExcludedPaths = (after.exclusions || []).map(row => row.path).sort();
const boundaries = Array.isArray(after.preservedBoundaries) ? after.preservedBoundaries : [];
const expectedContentDrift = boundaries
  .filter(row => row.identityUnchanged === true && row.contentUnchanged === false)
  .map(row => `${row.agent}:${row.kind === 'brain' ? 'brain' : row.name}`).sort();
const reportedContentDrift = Array.isArray(after.concurrentContentDrift)
  ? [...after.concurrentContentDrift].sort() : null;
const audit = after.mutationAudit;
const auditAttempts = new Map();
for (const event of audit?.events || []) {
  if (!auditAttempts.has(event.attemptId)) auditAttempts.set(event.attemptId, []);
  auditAttempts.get(event.attemptId).push(event);
}
const mutationAuditComplete = audit?.kind === 'home23-candidate-quarantine-mutation-audit'
  && audit.scope === 'candidate-and-quarantine-paths-only'
  && audit.status === 'passed' && audit.violations?.length === 0
  && audit.events.length === eligible.length * 8 && auditAttempts.size === eligible.length * 4
  && [...auditAttempts.values()].every(events => events.length === 2
    && events[0].phase === 'intent' && events[1].phase === 'outcome'
    && events[1].outcome === 'completed');
if (after.status !== 'completed' || after.manifestSha256 !== before.manifestSha256
    || after.approvalScopeSha256 !== before.approvalScopeSha256
    || after.approvalToken !== before.approvalToken
    || !/^[a-f0-9]{64}$/.test(after.applyPreflightManifestSha256 || '')
    || after.results?.length !== eligible.length
    || after.results.some(row => row.status !== 'removed')
    || after.results.some(row => row.quarantineContainer && fs.existsSync(row.quarantineContainer))
    || JSON.stringify(actualExcludedPaths) !== JSON.stringify(expectedExcludedPaths)
    || after.approval?.actor !== approvalActor || after.approval?.text !== approvalText
    || after.approval?.approvedAt !== approvalAt
    || new Date(approvalAt).toISOString() !== approvalAt
    || Date.parse(approvalAt) < Date.parse(before.createdAt)
    || JSON.stringify(after.candidateBytes?.selected) !== JSON.stringify(before.manifest.candidateBytes)
    || JSON.stringify(after.candidateBytes?.removed) !== JSON.stringify(before.manifest.candidateBytes)
    || !after.filesystemBefore || !after.filesystemAfter
    || !(BigInt(after.filesystemAvailableDeltaBytes || '0') > 0n)
    || after.boundaryDrift?.length !== 0
    || boundaries.some(row => !row.before?.treeSha256 || !row.after?.treeSha256
      || row.identityUnchanged !== true
      || row.unchanged !== (row.identityUnchanged && row.contentUnchanged))
    || !Array.isArray(after.protectedMembership)
    || after.protectedMembership.length !== before.manifest.agents.length
    || after.protectedMembership.some(row => row.unchanged !== true)
    || JSON.stringify(reportedContentDrift) !== JSON.stringify(expectedContentDrift)
    || !mutationAuditComplete
    || after.receiptPublicationEvidence?.kind
      !== 'home23-identity-bound-cleanup-receipt-publication'
    || after.finalRuntime?.pm2?.status !== 'passed'
    || after.finalRuntime?.listeners?.status !== 'passed'
    || after.finalRuntime?.openFileDescriptors?.status !== 'passed'
    || after.finalRuntime.openFileDescriptors.entries.length < 255
    || !boundaries.some(row => row.kind === 'brain' && row.agent === 'jerry')
    || !boundaries.some(row => row.kind === 'brain' && row.agent === 'forrest')
    || excluded.some(candidate => !boundaries.some(row =>
      row.kind === 'nonselected' && row.path === candidate.path))) {
  throw new Error('orphan cleanup apply proof incomplete');
}
const remainingCandidates = before.manifest.agents.flatMap(agent => {
  const names = fs.readdirSync(agent.operationsRoot.path);
  return names.filter(name => /^dashboard-source-[a-f0-9-]{36}$/.test(name))
    .map(name => `${agent.agent}:${name}`);
}).sort();
const expectedRemaining = excluded.map(row => `${row.agent}:${row.name}`).sort();
if (JSON.stringify(remainingCandidates) !== JSON.stringify(expectedRemaining)) {
  throw new Error('eligible root remained or an excluded root disappeared');
}
NODE
df -Pk "$LIVE_ROOT" > "$LIVE_RECEIPT_DIR/disk-after-orphan-cleanup.txt"
df -h "$LIVE_ROOT" > "$LIVE_RECEIPT_DIR/disk-after-orphan-cleanup-human.txt"
DISK_AVAILABLE_KIB=$(awk 'NR == 2 { print $4 }' "$LIVE_RECEIPT_DIR/disk-after-orphan-cleanup.txt")
DISK_USED_PERCENT=$(awk 'NR == 2 { gsub(/%/, "", $5); print $5 }' \
  "$LIVE_RECEIPT_DIR/disk-after-orphan-cleanup.txt")
test "$DISK_AVAILABLE_KIB" -ge $((20 * 1024 * 1024))
test "$DISK_USED_PERCENT" -le 97
memory_pressure -Q > "$LIVE_RECEIPT_DIR/memory-pressure-after-orphan-cleanup.txt"
MEMORY_FREE_PERCENT=$(node -e '
const text=require("node:fs").readFileSync(process.argv[1],"utf8");
const match=text.match(/memory free percentage:\s*(\d+)%/i);
if(!match)process.exit(1);process.stdout.write(match[1]);
' "$LIVE_RECEIPT_DIR/memory-pressure-after-orphan-cleanup.txt")
test "$MEMORY_FREE_PERCENT" -ge 40
```

Correct Jerry's live local guidance while his engine/dashboard remain stopped. Back up the three exact ignored files outside the repository, mode 0600. If the exact correction already exists, do not duplicate it; otherwise use `apply_patch` to insert the following authority text once. `SOUL.md` keeps it in the Brain tools paragraph; `LEARNINGS.md` and `MEMORY.md` place it immediately after their H1 so it supersedes historical duration notes without rewriting history:

```markdown
Ordinary durable query attachments may wait up to 90 minutes. PGS and synthesis attachments may wait up to six hours while verified operation progress continues. A transport loss or attachment deadline can detach the caller without cancelling the durable operation: preserve the exact operation ID and use `brain_status {action:"wait",operationId:"..."}` or `action:"result"`; never start a duplicate or infer failure from stale timing. Only explicit cancellation cancels the operation, and degraded zero evidence is not proof of an empty brain.
```

```bash
JERRY_GUIDANCE_BACKUP=$(mktemp -d "$SYSTEM_TMPDIR/home23-jerry-guidance-$RECEIPT_RUN_ID.XXXXXX")
chmod 700 "$JERRY_GUIDANCE_BACKUP"
JERRY_GUIDANCE_FILES=(
  "$LIVE_ROOT/instances/jerry/workspace/SOUL.md"
  "$LIVE_ROOT/instances/jerry/workspace/LEARNINGS.md"
  "$LIVE_ROOT/instances/jerry/workspace/MEMORY.md"
)
for file in "${JERRY_GUIDANCE_FILES[@]}"; do
  cp -p "$file" "$JERRY_GUIDANCE_BACKUP/$(basename "$file")"
  chmod 600 "$JERRY_GUIDANCE_BACKUP/$(basename "$file")"
done
shasum -a 256 "${JERRY_GUIDANCE_FILES[@]}" \
  > "$LIVE_RECEIPT_DIR/jerry-guidance-before.sha256.txt"
# Use apply_patch here only if the exact authority text is absent; never bulk-rewrite these files.
node - "${JERRY_GUIDANCE_FILES[@]}" <<'NODE'
const fs = require('node:fs');
const [soulFile, learningsFile, memoryFile] = process.argv.slice(2);
const soul = fs.readFileSync(soulFile, 'utf8');
const learnings = fs.readFileSync(learningsFile, 'utf8');
const memory = fs.readFileSync(memoryFile, 'utf8');
for (const [name, text] of [['SOUL', soul], ['LEARNINGS', learnings], ['MEMORY', memory]]) {
  if (!/ordinary (?:durable )?query attachments may wait up to 90 minutes/i.test(text)
      || !/PGS and synthesis attachments may wait up to six hours/i.test(text)
      || !/brain_status[^\n]*(?:action[=:]?["`]?wait|action `wait`)/i.test(text)
      || !/never start a duplicate/i.test(text)) throw new Error(`${name} durable wait correction missing`);
}
if (learnings.indexOf('Brain Operations Are Durable') < 0
    || learnings.indexOf('Brain Operations Are Durable') > learnings.indexOf('2026-04-14: Brain Tool Selection')) {
  throw new Error('LEARNINGS supersession is not ahead of historical timing notes');
}
if (memory.indexOf('Brain Tool Timing and Reattachment Correction') < 0
    || memory.indexOf('Brain Tool Timing and Reattachment Correction') > memory.indexOf('2026-04-14: Brain Tool Stack')) {
  throw new Error('MEMORY supersession is not ahead of historical timing notes');
}
NODE
shasum -a 256 "${JERRY_GUIDANCE_FILES[@]}" \
  > "$LIVE_RECEIPT_DIR/jerry-guidance-after.sha256.txt"
```

Now—and only now—run every deferred gate first from the clean isolated commit and then from the sealed combined live bytes. Save TAP/output and exit nonzero under `pipefail`; a cleanup pass cannot substitute for any test:

```bash
set -o pipefail
cd "$ISOLATED_ROOT"
node --test --test-concurrency=1 "${A_TESTS[@]}" | tee "$LIVE_RECEIPT_DIR/isolated-plan-a.tap"
node --test --test-concurrency=1 "${B_TESTS[@]}" | tee "$LIVE_RECEIPT_DIR/isolated-plan-b.tap"
node --test --test-concurrency=1 "${C_TESTS[@]}" | tee "$LIVE_RECEIPT_DIR/isolated-plan-c.tap"
node --test --test-concurrency=1 \
  tests/scripts/live-brain-tools-smoke.test.cjs tests/scripts/hash-brain-boundaries.test.cjs \
  tests/scripts/sample-process-memory.test.cjs tests/scripts/verify-brain-persistence.test.cjs \
  tests/scripts/guarded-pm2-save.test.cjs tests/scripts/cleanup-orphan-brain-projections.test.cjs \
  tests/scripts/verify-live-deployment-tree.test.cjs \
  | tee "$LIVE_RECEIPT_DIR/isolated-plan-d-helpers.tap"
node --import tsx --test --test-concurrency=1 \
  tests/agent/tools/brain.test.ts tests/agent/tools/cron.test.ts \
  tests/agent/turn-entrypoint-callers.test.ts \
  | tee "$LIVE_RECEIPT_DIR/isolated-agent-brain-cron.tap"
node --test --test-concurrency=1 tests/dashboard/operator-ui.test.js \
  | tee "$LIVE_RECEIPT_DIR/isolated-dashboard-copy.tap"
npm run build | tee "$LIVE_RECEIPT_DIR/isolated-build.txt"
npm test | tee "$LIVE_RECEIPT_DIR/isolated-npm-test.tap"
npm run test:contracts | tee "$LIVE_RECEIPT_DIR/isolated-contracts.tap"
git diff --check

cd "$LIVE_ROOT"
node --test --test-concurrency=1 "${A_TESTS[@]}" | tee "$LIVE_RECEIPT_DIR/live-plan-a.tap"
node --test --test-concurrency=1 "${B_TESTS[@]}" | tee "$LIVE_RECEIPT_DIR/live-plan-b.tap"
node --test --test-concurrency=1 "${C_TESTS[@]}" | tee "$LIVE_RECEIPT_DIR/live-plan-c.tap"
node --test --test-concurrency=1 \
  tests/scripts/live-brain-tools-smoke.test.cjs tests/scripts/hash-brain-boundaries.test.cjs \
  tests/scripts/sample-process-memory.test.cjs tests/scripts/verify-brain-persistence.test.cjs \
  tests/scripts/guarded-pm2-save.test.cjs tests/scripts/cleanup-orphan-brain-projections.test.cjs \
  tests/scripts/verify-live-deployment-tree.test.cjs \
  | tee "$LIVE_RECEIPT_DIR/live-plan-d-helpers.tap"
node --import tsx --test --test-concurrency=1 \
  tests/agent/tools/brain.test.ts tests/agent/tools/cron.test.ts \
  tests/agent/turn-entrypoint-callers.test.ts \
  | tee "$LIVE_RECEIPT_DIR/live-agent-brain-cron.tap"
node --test --test-concurrency=1 tests/dashboard/operator-ui.test.js \
  | tee "$LIVE_RECEIPT_DIR/live-dashboard-copy.tap"
npm run build | tee "$LIVE_RECEIPT_DIR/live-build.txt"
npm test | tee "$LIVE_RECEIPT_DIR/live-npm-test.tap"
npm run test:contracts | tee "$LIVE_RECEIPT_DIR/live-contracts.tap"
git diff --check
```

Expected: the reviewed live preflight selects 248 roots and excludes seven, cleanup reclaims approximately 38.67 decimal GB of selected allocation, and every excluded root—including all six hardlink-pair crash-window roots and the zero candidate—retains its approved identity and protected membership. Zero structural scope drift is mandatory: Home23/brain/operations/nonselected root identities and immediate protected membership stay intact. Identity-stable brain/nonselected content written by required online protected writers may advance; every such before/after digest difference must reconcile exactly to `concurrentContentDrift`, and no unreported content difference is accepted. Selected/removed byte aggregates agree; all candidate/quarantine mutation attempts have intent plus completed outcomes; separately named receipt-publication evidence passes; `statfs` records positive recovered capacity; final PM2/protected-listener/open-FD gates pass; adequate disk/memory headroom is restored; and all deferred gates pass before any prepare or start. Any different live classification, structural drift, partial/removal-unknown state, or mutation-audit failure stops for review. The external guidance backups remain retained for operator recovery through final acceptance; do not copy their contents or absolute paths into Git.

- [ ] **Step 1: Capture pre-rollout process, listener, and source truth**

Run and save the exact output for the receipt:

```bash
pm2 jlist | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const p of JSON.parse(s).filter(p=>['home23-jerry','home23-jerry-dash','home23-jerry-harness','home23-jerry-mcp','home23-forrest','home23-forrest-dash','home23-forrest-harness','home23-forrest-mcp','home23-cosmo23'].includes(p.name))) console.log(JSON.stringify({name:p.name,status:p.pm2_env.status,pid:p.pid,restarts:p.pm2_env.restart_time,uptime:p.pm2_env.pm_uptime}))})" | tee "$LIVE_RECEIPT_DIR/pm2-before.raw.ndjson"
lsof -nP -iTCP:5002 -sTCP:LISTEN | tee "$LIVE_RECEIPT_DIR/listener-5002-before.txt"
lsof -nP -iTCP:5012 -sTCP:LISTEN | tee "$LIVE_RECEIPT_DIR/listener-5012-before.txt"
lsof -nP -iTCP:5003 -sTCP:LISTEN | tee "$LIVE_RECEIPT_DIR/listener-5003-before.txt"
lsof -nP -iTCP:5013 -sTCP:LISTEN | tee "$LIVE_RECEIPT_DIR/listener-5013-before.txt"
lsof -nP -iTCP:5015 -sTCP:LISTEN | tee "$LIVE_RECEIPT_DIR/listener-5015-before.txt"
lsof -nP -iTCP:43210 -sTCP:LISTEN | tee "$LIVE_RECEIPT_DIR/listener-43210-before.txt"
curl -fsS http://127.0.0.1:43210/api/status | tee "$LIVE_RECEIPT_DIR/cosmo-status-initial.json"
EMPIRE_5013_BEFORE=$(lsof -nP -t -iTCP:5013 -sTCP:LISTEN | sort -u)
test -n "$EMPIRE_5013_BEFORE"
test "$(printf '%s\n' "$EMPIRE_5013_BEFORE" | wc -l | tr -d ' ')" = 1
ps -p "$EMPIRE_5013_BEFORE" -o pid=,command= > "$LIVE_RECEIPT_DIR/listener-5013-unrelated-before.txt"
if lsof -nP -iTCP:5015 -sTCP:LISTEN > "$LIVE_RECEIPT_DIR/listener-5015-pre-prepare.txt"; then
  echo 'Refusing rollout: reviewed Forrest MCP port 5015 is occupied' >&2
  exit 1
fi
export EMPIRE_5013_BEFORE
```

Expected before the single combined refresh: `home23-jerry`,
`home23-jerry-dash`, `home23-forrest`, and `home23-forrest-dash` each remain
exactly stopped with PID zero, with the engines attributed to the earlier
persistence/acceptance gate and only the dashboards attributed to the recorded
emergency deviation;
`home23-jerry-harness`, `home23-forrest-harness`, and `home23-cosmo23` each
remain online. Do not start any of the four stopped rows during observation,
cleanup, local guidance correction, or preparation. Record each MCP
process/listener exactly as found. A configured-enabled MCP process may still
be absent or stopped at this pre-migration point, but Step 3 must start it
exactly once and Step 4 must prove its loopback listener is owned by the named
PID. A conflicting listener or a configured MCP that remains absent after
refresh is a rollout failure. An intentionally disabled MCP remains absent with
typed disabled authority. Do not require the new coordinator route from the
stopped old dashboard processes.

For this installation, preserve the unrelated `empire-dashboard` listener on
5013 and set only `instances/forrest/config.yaml` → `ports.mcp` to 5015 before
running preparation. This ignored per-agent config is the local port authority;
do not hand-edit the four generated ecosystem rows. Capture only the secret-free
`ports` projection before and after the one-line local change, require
`bridge:5014` to remain unchanged, and re-run `lsof` immediately before prepare
to prove 5015 is still free. `brain-operations prepare` then regenerates the
ignored ecosystem atomically from that authority. A newly occupied 5015 blocks
the rollout and requires another reviewed free loopback port; it never permits
stopping or replacing the unrelated 5013 owner.

Perform and receipt that one local authority change before the first prepare
command. The full mode-0600 backup stays outside the receipt tree; only the
secret-free four-port projections and hashes enter the live receipt. A missing
`lsof`, any stderr, or any 5015 listener blocks the change:

```bash
set -euo pipefail
FORREST_CONFIG="$LIVE_ROOT/instances/forrest/config.yaml"
FORREST_CONFIG_BACKUP="$SYSTEM_TMPDIR/home23-forrest-config-$RECEIPT_RUN_ID.yaml"
test ! -e "$FORREST_CONFIG_BACKUP"
test ! -L "$FORREST_CONFIG_BACKUP"
cp -p "$FORREST_CONFIG" "$FORREST_CONFIG_BACKUP"
chmod 600 "$FORREST_CONFIG_BACKUP"
FORREST_CONFIG_BACKUP_SHA256=$(shasum -a 256 "$FORREST_CONFIG_BACKUP" | awk 'NR == 1 { print $1 }')
test "${#FORREST_CONFIG_BACKUP_SHA256}" -eq 64
export FORREST_CONFIG FORREST_CONFIG_BACKUP FORREST_CONFIG_BACKUP_SHA256

if lsof -nP -iTCP:5015 -sTCP:LISTEN \
    > "$LIVE_RECEIPT_DIR/listener-5015-immediate-pre-config.txt" \
    2> "$LIVE_RECEIPT_DIR/listener-5015-immediate-pre-config.stderr.txt"; then
  echo 'port 5015 became occupied before the Forrest config change' >&2
  exit 1
else
  LSOF_5015_STATUS=$?
  if test "$LSOF_5015_STATUS" -ne 1; then
    echo "lsof failed while checking port 5015 (status $LSOF_5015_STATUS)" >&2
    exit "$LSOF_5015_STATUS"
  fi
  test ! -s "$LIVE_RECEIPT_DIR/listener-5015-immediate-pre-config.txt"
  test ! -s "$LIVE_RECEIPT_DIR/listener-5015-immediate-pre-config.stderr.txt"
fi

node - "$FORREST_CONFIG" \
  "$LIVE_RECEIPT_DIR/forrest-ports-before.json" \
  "$LIVE_RECEIPT_DIR/forrest-ports-after.json" <<'NODE'
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const [file, beforeOutput, afterOutput] = process.argv.slice(2);
const stat = fs.lstatSync(file, { bigint: true });
if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file) {
  throw new Error('forrest_config_identity_invalid');
}
const raw = fs.readFileSync(file, 'utf8');
const before = yaml.load(raw) || {};
const projection = (value) => {
  const ports = value?.ports;
  if (!ports || Array.isArray(ports) || typeof ports !== 'object') {
    throw new Error('forrest_ports_invalid');
  }
  const result = Object.fromEntries(['engine', 'dashboard', 'mcp', 'bridge']
    .map((key) => [key, Number(ports[key])]));
  if (Object.values(result).some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new Error('forrest_ports_invalid');
  }
  return result;
};
assert.deepEqual(projection(before), {
  engine: 5011, dashboard: 5012, mcp: 5013, bridge: 5014,
});
fs.writeFileSync(beforeOutput, `${JSON.stringify({ ports: projection(before) }, null, 2)}\n`, {
  flag: 'wx', mode: 0o600,
});

const lines = raw.split(/(?<=\n)/);
const text = (line) => line.replace(/\r?\n$/, '');
const portsLines = lines.map((line, index) => ({ line: text(line), index }))
  .filter(({ line }) => /^(\s*)ports:\s*(?:#.*)?$/.test(line));
if (portsLines.length !== 1) throw new Error('forrest_ports_block_ambiguous');
const portsIndex = portsLines[0].index;
const portsIndent = /^(\s*)/.exec(portsLines[0].line)[1].length;
let blockEnd = lines.length;
for (let index = portsIndex + 1; index < lines.length; index += 1) {
  const line = text(lines[index]);
  if (!line.trim() || /^\s*#/.test(line)) continue;
  if (/^(\s*)/.exec(line)[1].length <= portsIndent) { blockEnd = index; break; }
}
const matches = [];
for (let index = portsIndex + 1; index < blockEnd; index += 1) {
  const match = /^(\s*mcp:\s*)5013(\s*(?:#.*)?)(\r?\n)?$/.exec(lines[index]);
  if (match) matches.push({ index, match });
}
if (matches.length !== 1) throw new Error('forrest_mcp_port_line_ambiguous');
const [{ index, match }] = matches;
lines[index] = `${match[1]}5015${match[2]}${match[3] || ''}`;
const nextRaw = lines.join('');
const expected = structuredClone(before);
expected.ports.mcp = 5015;
assert.deepEqual(yaml.load(nextRaw), expected);
assert.deepEqual(projection(expected), {
  engine: 5011, dashboard: 5012, mcp: 5015, bridge: 5014,
});

const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
let descriptor;
try {
  descriptor = fs.openSync(temporary, 'wx', Number(stat.mode & 0o777n));
  fs.writeFileSync(descriptor, nextRaw, 'utf8');
  fs.fsyncSync(descriptor);
  fs.closeSync(descriptor);
  descriptor = undefined;
  const current = fs.lstatSync(file, { bigint: true });
  if (current.dev !== stat.dev || current.ino !== stat.ino
      || fs.readFileSync(file, 'utf8') !== raw) {
    throw new Error('forrest_config_changed_concurrently');
  }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
} finally {
  if (descriptor !== undefined) fs.closeSync(descriptor);
  fs.rmSync(temporary, { force: true });
}
assert.deepEqual(yaml.load(fs.readFileSync(file, 'utf8')), expected);
fs.writeFileSync(afterOutput, `${JSON.stringify({ ports: projection(expected) }, null, 2)}\n`, {
  flag: 'wx', mode: 0o600,
});
NODE
shasum -a 256 "$FORREST_CONFIG_BACKUP" "$FORREST_CONFIG" \
  > "$LIVE_RECEIPT_DIR/forrest-config-before-after.sha256.txt"

if lsof -nP -iTCP:5015 -sTCP:LISTEN \
    > "$LIVE_RECEIPT_DIR/listener-5015-immediate-pre-prepare.txt" \
    2> "$LIVE_RECEIPT_DIR/listener-5015-immediate-pre-prepare.stderr.txt"; then
  echo 'port 5015 became occupied before brain-operations prepare' >&2
  exit 1
else
  LSOF_5015_STATUS=$?
  if test "$LSOF_5015_STATUS" -ne 1; then
    echo "lsof failed while rechecking port 5015 (status $LSOF_5015_STATUS)" >&2
    exit "$LSOF_5015_STATUS"
  fi
  test ! -s "$LIVE_RECEIPT_DIR/listener-5015-immediate-pre-prepare.txt"
  test ! -s "$LIVE_RECEIPT_DIR/listener-5015-immediate-pre-prepare.stderr.txt"
fi
```

Do not attach an `EXIT` trap that deletes `FORREST_CONFIG_BACKUP`. Any failure
after the ignored config mutation and before preparation/restart acceptance must
stop under the strict shell settings above and retain that mode-0600 external
backup for operator recovery. Keep the exported path and digest until the sole
guarded retention verification in Step 12. No automated success or failure path
deletes it; the operator removes it only after the final pushed acceptance is
confirmed from the durable receipt.

Back up the ignored ecosystem file without exposing secrets, then exercise the idempotent existing-install migration supplied by the authority plan:

```bash
cd /Users/jtr/_JTR23_/release/home23
test -d instances/jerry/brain
test -d instances/forrest/brain
test -f ecosystem.config.cjs
cp ecosystem.config.cjs "$LIVE_RECEIPT_DIR/home23-ecosystem-before-brain-operations.cjs"
node cli/home23.js brain-operations prepare --dry-run | tee "$LIVE_RECEIPT_DIR/prepare-before.json"
node cli/home23.js brain-operations prepare | tee "$LIVE_RECEIPT_DIR/prepare-applied.json"
node cli/home23.js brain-operations prepare --dry-run | tee "$LIVE_RECEIPT_DIR/prepare-stale-live-env.json"
```

Expected: the first dry run names only prospective capability/permission/ecosystem changes through Plan A's exact fields. Apply creates or repairs the one installation-shared ignored capability key with restrictive permissions and regenerates ignored `ecosystem.config.cjs` only when required; it does not restart PM2. The second dry run requires `keyCreated:false`, `keyWouldBeCreated:false`, `permissionsRepaired:false`, `permissionsWouldBeRepaired:false`, `ecosystemRegenerated:false`, and `ecosystemWouldChange:false`, but must continue to report `restartRequired:true`, `liveEnvVerified:true`, and the exact `changedProcessNames` until Step 3 loads the new environment. Do not invent a `filesystemChanged` field. The command never prints capability material. Compare the regenerated file structurally with the backup and record only process names and environment key names, never secret values. Confirm the generated Jerry and Forrest harness tool registries contain the brain tools and that the coordinator capability environment key name is present for the named dashboard/worker pairs. After Step 3, a final dry run must preserve all six false change fields plus `changedProcessNames:[]`, `restartRequired:false`, and `liveEnvVerified:true`.

- [ ] **Step 2: Prove COSMO is safe to restart**

Inspect `/api/status` plus the durable stores before any restart, then use the requester-authorized routes after restart:

```bash
curl -fsS http://127.0.0.1:43210/api/status > "$LIVE_RECEIPT_DIR/cosmo-status-before.json"
node - "$LIVE_RECEIPT_DIR/cosmo-status-before.json" <<'NODE'
const fs = require('node:fs');
const status = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (status.running !== false || status.activeRun !== false || status.lifecycle !== 'idle') {
  console.error(JSON.stringify({ code: 'cosmo_not_idle', running: status.running,
    activeRun: status.activeRun, lifecycle: status.lifecycle, runId: status.runId || null }));
  process.exit(1);
}
console.log(JSON.stringify({ code: 'cosmo_idle', running: status.running,
  activeRun: status.activeRun, lifecycle: status.lifecycle }));
NODE
node cli/home23.js brain-operations list --state nonterminal --all-requesters
```

The CLI uses the same store reader and prints operation ID/requester/state without capability bytes. Continue only if COSMO reports no active research run and the durable list contains no `queued` or `running` operation. If either is active, do not restart; record the operation/run ID and reattach until it becomes terminal. Never infer safety from an absent directory or a failed list/read request. After restart, cross-check the CLI output against `GET /home23/api/brain-operations?state=nonterminal` on each requester dashboard.

- [ ] **Step 2A: Prove the new engine persistence paths preserve both actual live brains before any engine restart**

This is a hard restart gate, not an optional diagnostic. Run the new engine load path read-only against Jerry's and Forrest's actual brain directories while both engines remain exactly stopped after cleanup; the stopped state supplies a quiet source window but never substitutes for the load proof. Then exercise the new save path only against guarded temporary clones outside the Home23 tree:

```bash
cd /Users/jtr/_JTR23_/release/home23
LIVE_ROOT=$(pwd -P)
PERSISTENCE_AUDIT="$LIVE_RECEIPT_DIR/persistence"
mkdir -p "$PERSISTENCE_AUDIT"
PERSISTENCE_CLONE_ROOT=$(mktemp -d "$SYSTEM_TMPDIR/home23-brain-persistence-clones.XXXXXX")

node --max-old-space-size=768 scripts/verify-brain-persistence.mjs \
  --mode read-only --home23-root "$LIVE_ROOT" --agent jerry \
  --brain "$LIVE_ROOT/instances/jerry/brain" --temp-root "$PERSISTENCE_CLONE_ROOT" \
  --max-heap-used-mib 640 --max-rss-mib 1536 \
  --output "$PERSISTENCE_AUDIT/jerry-live-load.json"
node --max-old-space-size=768 scripts/verify-brain-persistence.mjs \
  --mode read-only --home23-root "$LIVE_ROOT" --agent forrest \
  --brain "$LIVE_ROOT/instances/forrest/brain" --temp-root "$PERSISTENCE_CLONE_ROOT" \
  --max-heap-used-mib 640 --max-rss-mib 1536 \
  --output "$PERSISTENCE_AUDIT/forrest-live-load.json"

node --max-old-space-size=768 scripts/verify-brain-persistence.mjs \
  --mode temp-save-clone --home23-root "$LIVE_ROOT" --agent jerry \
  --brain "$LIVE_ROOT/instances/jerry/brain" --temp-root "$PERSISTENCE_CLONE_ROOT" \
  --max-heap-used-mib 640 --max-rss-mib 1536 \
  --output "$PERSISTENCE_AUDIT/jerry-temp-save.json"
node --max-old-space-size=768 scripts/verify-brain-persistence.mjs \
  --mode temp-save-clone --home23-root "$LIVE_ROOT" --agent forrest \
  --brain "$LIVE_ROOT/instances/forrest/brain" --temp-root "$PERSISTENCE_CLONE_ROOT" \
  --max-heap-used-mib 640 --max-rss-mib 1536 \
  --output "$PERSISTENCE_AUDIT/forrest-temp-save.json"
node -e "if (require('node:fs').readdirSync(process.argv[1]).length) process.exit(1)" "$PERSISTENCE_CLONE_ROOT"
rmdir "$PERSISTENCE_CLONE_ROOT"

node - "$LIVE_ROOT" \
  "$PERSISTENCE_AUDIT/jerry-live-load.json" "$PERSISTENCE_AUDIT/forrest-live-load.json" \
  "$PERSISTENCE_AUDIT/jerry-temp-save.json" "$PERSISTENCE_AUDIT/forrest-temp-save.json" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [home23Root, ...files] = process.argv.slice(2);
for (const file of files) {
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (receipt.ok !== true || receipt.unchanged !== true) throw new Error(`persistence proof failed: ${file}`);
  if (!Number.isSafeInteger(receipt.streamed?.nodes) || receipt.streamed.nodes <= 0
      || !Number.isSafeInteger(receipt.streamed?.edges) || receipt.streamed.edges < 0) {
    throw new Error(`invalid authoritative graph count: ${file}`);
  }
  if (receipt.streamed.nodes !== receipt.expected.nodes || receipt.streamed.edges !== receipt.expected.edges) {
    throw new Error(`authoritative count mismatch: ${file}`);
  }
  if (receipt.snapshot?.requiredForAcceptance !== false
      || !['valid','invalid','missing'].includes(receipt.snapshot?.status)
      || ![true,false,null].includes(receipt.snapshot?.matchesStreamed)) {
    throw new Error(`snapshot was not recorded as advisory: ${file}`);
  }
  if (receipt.fullMaterializerUsed !== false || receipt.streamed.resources?.peakHeapUsedMiB > 640
      || receipt.streamed.resources?.peakRssMiB > 1536) {
    throw new Error(`streaming resource contract failed: ${file}`);
  }
  if (receipt.selectedAuthority === 'legacy-resident-sidecars'
      && (receipt.streamed.sourceHealth !== 'degraded'
        || receipt.streamed.freshness !== 'unknown'
        || receipt.expectedAuthority !== 'streamed-logical-source'
        || receipt.streamed.implementation !== 'legacy-resident-sidecar-projection'
        || receipt.snapshot?.notRequiredReason
          !== 'legacy-resident-sidecars-stream-includes-committed-delta')) {
    throw new Error(`legacy source provenance mismatch: ${file}`);
  }
  if (receipt.selectedAuthority === 'manifest-v1'
      && (receipt.streamed.freshness !== 'known'
        || receipt.streamed.implementation !== 'manifest-v1'
        || receipt.expectedAuthority !== 'manifest-v1-summary'
        || !Number.isSafeInteger(receipt.sourceRevision))) {
    throw new Error(`manifest source freshness mismatch: ${file}`);
  }
  if (receipt.mode === 'temp-save-clone-safe') {
    const relative = path.relative(home23Root, receipt.writeBrainDir);
    if (!relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error(`clone writer entered Home23 tree: ${file}`);
    }
    if (receipt.clone?.loaded?.nodes !== receipt.streamed.nodes + 1
        || receipt.clone?.loaded?.edges !== receipt.streamed.edges
        || receipt.clone?.canaryMatches !== 1 || receipt.clone?.fullMaterializerUsed !== false) {
      throw new Error(`clone delta/readback mismatch: ${file}`);
    }
    if (receipt.clone.copiedFiles.some((row) => row.sourceSha256 !== row.destinationSha256)
        || receipt.boundedForceFull?.persistedMode !== 'full'
        || receipt.boundedForceFull?.loaded?.nodes !== 2
        || receipt.boundedForceFull?.loaded?.edges !== 1
        || receipt.liveForceFull?.attempted !== false || receipt.cloneRemoved !== true) {
      throw new Error(`bounded force-full or guarded-copy proof failed: ${file}`);
    }
  } else if (receipt.mode !== 'read-only-stream') {
    throw new Error(`unexpected persistence mode: ${file}`);
  }
}
console.log(JSON.stringify({ code: 'live_persistence_gate_passed', receipts: files }));
NODE
```

For a format-v1 source, `expected` must come from `memory-manifest.json.summary`; the helper must also require the manifest revision selected before streaming, the production source revision, and the revision re-read afterward to be identical. For a legacy source with no committed manifest, `expected` is the complete production stream assembled from the selected base plus the committed delta prefix, and the receipt must report that implementation explicitly with degraded health and unknown freshness. `brain-snapshot.json` is advisory for both formats: record its presence/validity, totals, revision/generation when available, and `matchesStreamed`, but a missing, stale, invalid, zero, or disagreeing snapshot alone is **not** a restart blocker and never becomes count authority. The authoritative streamed node total must be nonzero; edge totals must be safe nonnegative integers.

Each live-load receipt must contain the complete sorted source inventory and hashes from before and after the bounded production stream and prove them identical. Each temp-save receipt must prove the writer received only its external clone realpath, every copied physical file matched byte-for-byte, one change-only canary survived production delta save plus full streaming readback, the bounded representative force-full load/write/reload passed, and the original live source inventory/hashes remained identical. Full-live force-full is deliberately prohibited; the later named engine restart and readiness check is the full-scale boot proof. If any command observes concurrent source movement, wait for that named engine to become quiet and repeat the entire named-agent proof; do not waive or hand-edit the receipt. **Do not restart Jerry or Forrest unless all four machine-read receipts pass.** Never invoke the production save API with either live brain path.

- [ ] **Step 3: Refresh only the exact affected PM2 allowlist**

The declared engine, dashboard, harness, MCP, and COSMO files affect these exact nine possible live process names. Installed PM2 implements `start <ecosystem> --only <names> --update-env` by restarting existing matched process IDs with the regenerated environment and starting matched ecosystem apps that are missing; it does not merely leave existing apps alone. Use that scoped behavior in one combined command after the idle checks and all four Step 2A persistence receipts pass. First capture a secret-free all-process baseline and prove the literal allowlist/config selection:

```bash
cd /Users/jtr/_JTR23_/release/home23
PM2_ONLY='home23-cosmo23,home23-jerry,home23-forrest,home23-jerry-dash,home23-forrest-dash,home23-jerry-harness,home23-forrest-harness,home23-jerry-mcp,home23-forrest-mcp'
PM2_SCOPE_AUDIT="${PERSISTENCE_AUDIT:-$LIVE_RECEIPT_DIR/home23-pm2-scope-$(date +%Y%m%dT%H%M%S)}"
mkdir -p "$PM2_SCOPE_AUDIT"
PM2_PROJECTION='let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const norm=v=>v==null?null:Array.isArray(v)?v.map(norm):typeof v==="object"?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,norm(x)])):v;const rows=JSON.parse(s).map(p=>{const e=p.pm2_env||{};return{name:p.name,pid:p.pid,status:e.status,restarts:e.restart_time,uptime:e.pm_uptime,script:e.pm_exec_path||null,cwd:e.pm_cwd||null,namespace:e.namespace||"default",execMode:e.exec_mode||null,instances:e.instances??null,args:norm(e.args),interpreter:e.exec_interpreter||null,nodeArgs:norm(e.node_args),envKeys:Object.keys(e.env&&typeof e.env==="object"?e.env:{}).sort()}}).sort((a,b)=>a.name.localeCompare(b.name));process.stdout.write(JSON.stringify(rows,null,2))})'
export PM2_PROJECTION
pm2 jlist | node -e "$PM2_PROJECTION" > "$PM2_SCOPE_AUDIT/before.json"
node - "$PM2_ONLY" <<'NODE' > "$PM2_SCOPE_AUDIT/configured-selection.json"
const path = require('node:path');
const expected = [
  'home23-cosmo23', 'home23-jerry', 'home23-forrest',
  'home23-jerry-dash', 'home23-forrest-dash',
  'home23-jerry-harness', 'home23-forrest-harness',
  'home23-jerry-mcp', 'home23-forrest-mcp',
];
const actual = process.argv[2].split(',');
if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('PM2 allowlist is not exact');
if (actual.some((name) => name === 'all' || name === 'delete') || new Set(actual).size !== actual.length) {
  throw new Error('broad, destructive, or duplicate PM2 selector');
}
const ecosystem = require(path.resolve('ecosystem.config.cjs'));
const apps = Array.isArray(ecosystem.apps) ? ecosystem.apps : [];
const counts = new Map();
for (const app of apps) counts.set(app.name, (counts.get(app.name) || 0) + 1);
for (const name of expected.slice(0, 7)) {
  if (counts.get(name) !== 1) throw new Error(`missing or duplicate required ecosystem app: ${name}`);
}
for (const name of expected) if ((counts.get(name) || 0) > 1) throw new Error(`duplicate ecosystem app: ${name}`);
const configured = expected.filter((name) => counts.get(name) === 1);
console.log(JSON.stringify({ allowlist: actual, configured }, null, 2));
NODE
node - "$PM2_SCOPE_AUDIT/before.json" <<'NODE'
const fs = require('node:fs');
const rows = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const grouped = new Map();
for (const row of rows) grouped.set(row.name, [...(grouped.get(row.name) || []), row]);
for (const name of ['home23-jerry','home23-jerry-dash','home23-forrest','home23-forrest-dash']) {
  const values = grouped.get(name) || [];
  if (values.length !== 1 || values[0].status !== 'stopped' || values[0].pid !== 0) {
    throw new Error(`${name} lost the exact pre-start stopped baseline`);
  }
}
for (const name of ['home23-jerry-harness','home23-forrest-harness','home23-cosmo23']) {
  const values = grouped.get(name) || [];
  if (values.length !== 1 || values[0].status !== 'online' || !(values[0].pid > 0)) {
    throw new Error(`${name} lost the required online baseline`);
  }
}
NODE

memory_pressure -Q > "$PM2_SCOPE_AUDIT/memory-pressure-before-refresh.txt"
MEMORY_FREE_PERCENT=$(node -e '
const text = require("node:fs").readFileSync(process.argv[1], "utf8");
const match = text.match(/memory free percentage:\s*(\d+)%/i);
if (!match) process.exit(1);
process.stdout.write(match[1]);
' "$PM2_SCOPE_AUDIT/memory-pressure-before-refresh.txt")
if [ "$MEMORY_FREE_PERCENT" -lt 40 ]; then
  echo "Refusing simultaneous scoped refresh: only ${MEMORY_FREE_PERCENT}% system memory free" >&2
  exit 1
fi

pm2 start ecosystem.config.cjs --only "$PM2_ONLY" --update-env

pm2 jlist | node -e "$PM2_PROJECTION" > "$PM2_SCOPE_AUDIT/after-immediate.json"
node - "$PM2_SCOPE_AUDIT/before.json" "$PM2_SCOPE_AUDIT/after-immediate.json" "$PM2_SCOPE_AUDIT/configured-selection.json" <<'NODE'
const fs = require('node:fs');
const [beforeFile, afterFile, selectionFile] = process.argv.slice(2);
const before = JSON.parse(fs.readFileSync(beforeFile, 'utf8'));
const after = JSON.parse(fs.readFileSync(afterFile, 'utf8'));
const { configured } = JSON.parse(fs.readFileSync(selectionFile, 'utf8'));
const configuredSet = new Set(configured);
const group = (rows) => rows.reduce((map, row) => map.set(row.name, [...(map.get(row.name) || []), row]), new Map());
const beforeByName = group(before);
const afterByName = group(after);
for (const name of configured) {
  const prior = beforeByName.get(name) || [];
  const current = afterByName.get(name) || [];
  if (prior.length > 1 || current.length !== 1) throw new Error(`${name} duplicate or missing after scoped start`);
  if (current[0].status !== 'online') throw new Error(`${name} is not online`);
  if (prior.length === 0) {
    if (current[0].restarts !== 0) throw new Error(`${name} new-process restart baseline is not zero`);
  } else if (prior[0].status === 'online') {
    if (current[0].pid === prior[0].pid || current[0].uptime === prior[0].uptime) {
      throw new Error(`${name} online process was not restarted`);
    }
    if (current[0].restarts !== prior[0].restarts + 1) throw new Error(`${name} restart delta is not one`);
  } else if (prior[0].status === 'stopped') {
    if (current[0].restarts !== prior[0].restarts) {
      throw new Error(`${name} stopped-process start changed restart counter`);
    }
  } else {
    throw new Error(`${name} has unsupported pre-refresh state ${prior[0].status}`);
  }
}
const configIdentity = ({ name, pid, status, restarts, uptime, ...identity }) => identity;
for (const row of before) {
  if (configuredSet.has(row.name)) continue;
  const current = afterByName.get(row.name) || [];
  if (current.length !== 1 || current[0].restarts < row.restarts
      || current[0].restarts !== row.restarts
      || current[0].pid !== row.pid || current[0].status !== row.status
      || current[0].uptime !== row.uptime
      || JSON.stringify(configIdentity(current[0])) !== JSON.stringify(configIdentity(row))) {
    throw new Error(`unrelated PM2 process changed: ${row.name}`);
  }
}
for (const row of after) {
  if (!beforeByName.has(row.name) && !configuredSet.has(row.name)) {
    throw new Error(`unexpected PM2 process added: ${row.name}`);
  }
}
console.log(JSON.stringify({ code: 'pm2_exact_scope_passed', configured }));
NODE
pm2 jlist | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const names=['home23-jerry-mcp','home23-forrest-mcp'];const rows=JSON.parse(s).filter(p=>names.includes(p.name)).map(p=>({name:p.name,pid:p.pid,status:p.pm2_env.status,host:p.pm2_env.MCP_HTTP_HOST,port:Number(p.pm2_env.MCP_HTTP_PORT)})).sort((a,b)=>a.name.localeCompare(b.name));if(rows.length!==2||rows.some(r=>r.status!=='online'||r.host!=='127.0.0.1'))process.exit(1);process.stdout.write(JSON.stringify(rows,null,2))})" > "$PM2_SCOPE_AUDIT/mcp-processes.json"
JERRY_MCP_PID=$(node -p "require(process.argv[1]).find(row => row.name === 'home23-jerry-mcp').pid" "$PM2_SCOPE_AUDIT/mcp-processes.json")
FORREST_MCP_PID=$(node -p "require(process.argv[1]).find(row => row.name === 'home23-forrest-mcp').pid" "$PM2_SCOPE_AUDIT/mcp-processes.json")
test "$(lsof -nP -t -iTCP:5003 -sTCP:LISTEN | sort -u)" = "$JERRY_MCP_PID"
test "$(lsof -nP -t -iTCP:5015 -sTCP:LISTEN | sort -u)" = "$FORREST_MCP_PID"
lsof -nP -a -p "$JERRY_MCP_PID" -iTCP:5003 -sTCP:LISTEN > "$PM2_SCOPE_AUDIT/listener-5003-after.txt"
lsof -nP -a -p "$FORREST_MCP_PID" -iTCP:5015 -sTCP:LISTEN > "$PM2_SCOPE_AUDIT/listener-5015-after.txt"
rg -F '127.0.0.1:5003 (LISTEN)' "$PM2_SCOPE_AUDIT/listener-5003-after.txt"
rg -F '127.0.0.1:5015 (LISTEN)' "$PM2_SCOPE_AUDIT/listener-5015-after.txt"
EMPIRE_5013_AFTER=$(lsof -nP -t -iTCP:5013 -sTCP:LISTEN | sort -u)
test "$EMPIRE_5013_AFTER" = "$EMPIRE_5013_BEFORE"
ps -p "$EMPIRE_5013_AFTER" -o pid=,command= > "$PM2_SCOPE_AUDIT/listener-5013-unrelated-after.txt"
cmp "$LIVE_RECEIPT_DIR/listener-5013-unrelated-before.txt" "$PM2_SCOPE_AUDIT/listener-5013-unrelated-after.txt"

JERRY_DASH_PID=$(node -p "require(process.argv[1]).find(row => row.name === 'home23-jerry-dash').pid" "$PM2_SCOPE_AUDIT/after-immediate.json")
FORREST_DASH_PID=$(node -p "require(process.argv[1]).find(row => row.name === 'home23-forrest-dash').pid" "$PM2_SCOPE_AUDIT/after-immediate.json")
COSMO_PID=$(node -p "require(process.argv[1]).find(row => row.name === 'home23-cosmo23').pid" "$PM2_SCOPE_AUDIT/after-immediate.json")
test "$(lsof -nP -t -iTCP:5002 -sTCP:LISTEN | sort -u)" = "$JERRY_DASH_PID"
test "$(lsof -nP -t -iTCP:5012 -sTCP:LISTEN | sort -u)" = "$FORREST_DASH_PID"
test "$(lsof -nP -t -iTCP:43210 -sTCP:LISTEN | sort -u)" = "$COSMO_PID"
curl -fsS http://127.0.0.1:5002/home23/api/brain-operations/catalog \
  > "$PM2_SCOPE_AUDIT/jerry-catalog-immediate.json"
curl -fsS http://127.0.0.1:5012/home23/api/brain-operations/catalog \
  > "$PM2_SCOPE_AUDIT/forrest-catalog-immediate.json"
curl -fsS http://127.0.0.1:43210/api/status \
  > "$PM2_SCOPE_AUDIT/cosmo-status-immediate.json"
for port in 5002 5012 5003 5015 43210; do
  lsof -nP -t -iTCP:"$port" -sTCP:LISTEN | sort -u \
    > "$PM2_SCOPE_AUDIT/listener-${port}-immediate.pid"
done

sleep 15
pm2 jlist | node -e "$PM2_PROJECTION" > "$PM2_SCOPE_AUDIT/after-stability.json"
node - "$PM2_SCOPE_AUDIT/after-immediate.json" "$PM2_SCOPE_AUDIT/after-stability.json" <<'NODE'
const fs = require('node:fs');
const [immediateFile, stableFile] = process.argv.slice(2);
const immediate = JSON.parse(fs.readFileSync(immediateFile, 'utf8'));
const stable = JSON.parse(fs.readFileSync(stableFile, 'utf8'));
if (JSON.stringify(stable) !== JSON.stringify(immediate)) {
  throw new Error('PM2 identity/PID/restart state changed during delayed stability window');
}
NODE
curl -fsS http://127.0.0.1:5002/home23/api/brain-operations/catalog \
  > "$PM2_SCOPE_AUDIT/jerry-catalog-stable.json"
curl -fsS http://127.0.0.1:5012/home23/api/brain-operations/catalog \
  > "$PM2_SCOPE_AUDIT/forrest-catalog-stable.json"
curl -fsS http://127.0.0.1:43210/api/status \
  > "$PM2_SCOPE_AUDIT/cosmo-status-stable.json"
for port in 5002 5012 5003 5015 43210; do
  lsof -nP -t -iTCP:"$port" -sTCP:LISTEN | sort -u \
    > "$PM2_SCOPE_AUDIT/listener-${port}-stable.pid"
  cmp "$PM2_SCOPE_AUDIT/listener-${port}-immediate.pid" \
    "$PM2_SCOPE_AUDIT/listener-${port}-stable.pid"
done
node - "$PM2_SCOPE_AUDIT/jerry-catalog-stable.json" \
  "$PM2_SCOPE_AUDIT/forrest-catalog-stable.json" \
  "$PM2_SCOPE_AUDIT/cosmo-status-stable.json" <<'NODE'
const fs = require('node:fs');
const [jerryFile, forrestFile, cosmoFile] = process.argv.slice(2);
for (const file of [jerryFile, forrestFile]) {
  const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!catalog.catalogRevision || !Array.isArray(catalog.brains)) {
    throw new Error(`dashboard readiness failed: ${file}`);
  }
}
const cosmo = JSON.parse(fs.readFileSync(cosmoFile, 'utf8'));
if (typeof cosmo.running !== 'boolean' || typeof cosmo.lifecycle !== 'string') {
  throw new Error('COSMO delayed readiness failed');
}
NODE
node cli/home23.js brain-operations prepare --dry-run | tee "$LIVE_RECEIPT_DIR/prepare-after-refresh.json"
```

The one literal `pm2 start ... --only "$PM2_ONLY" --update-env` line above is the only planned mutating PM2 command after the recorded cleanup. The two exact emergency dashboard stops remain a named incident deviation and are not replayed or disguised; the two engines were already quiesced by the persistence/acceptance gate, and no broad mutation occurred. Do not split the combined start into sequential restarts, substitute `restart`, use `all`, or invoke `delete`. Immediately before it, both engines and both dashboards must still be stopped/PID-zero while both harnesses and COSMO are online. The fresh system-memory gate must show at least 40% free before the combined refresh; otherwise defer without restarting. A configured allowlisted process must be online exactly once. State-aware restart truth is exact: each of the four prior `stopped` engine/dashboard rows becomes online with restart delta `0`; the prior-online harness/COSMO rows get new PID/uptime and restart delta `+1`; and each configured MCP row follows its own observed state (`+1` online, `0` stopped, baseline `0` absent/new). Any other prior state blocks the refresh. The secret-free projection includes script, cwd, namespace, exec mode, instances, args, interpreter, node args, and sorted environment **key names**, and every configured row must match regenerated ecosystem authority after refresh.

Every unrelated row, including the exact 5013 listener PID/command, must retain identity/config/status/PID/uptime. Its restart counter is compared from the immediate pre-refresh monotonic baseline: it may never decrease and may not advance during the refresh or the delayed stability window. The five named listeners must remain bound to the same refreshed PIDs, both dashboard catalogs and COSMO readiness must succeed immediately and again after 15 seconds, and all refreshed PM2 PIDs/restart counts must remain unchanged through that delayed check. Concurrent unrelated movement or post-restart churn fails this proof and must be investigated rather than waived.

Immediately re-run `node cli/home23.js brain-operations prepare --dry-run`, save it in `$LIVE_RECEIPT_DIR/prepare-after-refresh.json`, and require `keyCreated:false`, `keyWouldBeCreated:false`, `permissionsRepaired:false`, `permissionsWouldBeRepaired:false`, `ecosystemRegenerated:false`, `ecosystemWouldChange:false`, `changedProcessNames:[]`, `restartRequired:false`, and `liveEnvVerified:true`. Do not assert an undefined aggregate `filesystemChanged`. Inspect the two MCP PM2 environments without printing secrets and require `MCP_HTTP_HOST=127.0.0.1`; `lsof` must show ports 5003 and 5015 bound only to loopback and owned by the named MCP PIDs. Port 5015 is Forrest's operator-selected local MCP authority because the unrelated `empire-dashboard` owns 5013; that unrelated process must remain unchanged. If MCP is intentionally disabled for an agent, its catalog/runtime must explicitly advertise disabled and the live matrix expects typed unavailable instead of starting a listener; a configured enabled MCP process may not be omitted.

- [ ] **Step 4: Re-read process/listener truth after restart**

Repeat Step 1 and run these exact requester-authorized reads:

```bash
curl -fsS http://127.0.0.1:5002/home23/api/brain-operations/catalog > "$LIVE_RECEIPT_DIR/jerry-brain-catalog.json"
curl -fsS 'http://127.0.0.1:5002/home23/api/brain-operations?state=nonterminal' > "$LIVE_RECEIPT_DIR/jerry-brain-nonterminal.json"
curl -fsS http://127.0.0.1:5012/home23/api/brain-operations/catalog > "$LIVE_RECEIPT_DIR/forrest-brain-catalog.json"
curl -fsS 'http://127.0.0.1:5012/home23/api/brain-operations?state=nonterminal' > "$LIVE_RECEIPT_DIR/forrest-brain-nonterminal.json"
node - "$LIVE_RECEIPT_DIR/jerry-brain-catalog.json" "$LIVE_RECEIPT_DIR/forrest-brain-catalog.json" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const required = new Set(['brain','run','pgs','session','cache','export','agency']);
for (const file of process.argv.slice(2)) {
  const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!catalog.catalogRevision || !Array.isArray(catalog.brains)) throw new Error(`invalid catalog ${file}`);
  for (const brain of catalog.brains) {
    const boundaries = brain.mutationBoundaries || [];
    const byKind = new Map(boundaries.map((value) => [value.kind, value.path]));
    if (boundaries.length !== 7 || byKind.size !== 7) throw new Error(`${brain.id} invalid boundary cardinality`);
    const kinds = new Set(byKind.keys());
    for (const kind of required) if (!kinds.has(kind)) throw new Error(`${brain.id} missing ${kind}`);
    if (brain.kind === 'resident') {
      if (byKind.get('brain') !== brain.canonicalRoot || byKind.get('run') !== brain.canonicalRoot) {
        throw new Error(`${brain.id} resident brain/run root mismatch`);
      }
      const agentInstance = path.dirname(brain.canonicalRoot);
      if (boundaries.some((value) => value.path === agentInstance)) {
        throw new Error(`${brain.id} boundary broadened to agent instance`);
      }
    } else if (brain.kind === 'research') {
      if (byKind.get('run') !== brain.canonicalRoot) throw new Error(`${brain.id} research run root mismatch`);
      const relativeBrain = path.relative(brain.canonicalRoot, byKind.get('brain'));
      if (path.isAbsolute(relativeBrain) || relativeBrain.startsWith('..' + path.sep)) {
        throw new Error(`${brain.id} research brain escaped run root`);
      }
    }
  }
  if (/capability|nonce|secret|key/i.test(JSON.stringify(catalog))) throw new Error(`secret-like field in ${file}`);
}
NODE
node - "$LIVE_RECEIPT_DIR/jerry-brain-nonterminal.json" "$LIVE_RECEIPT_DIR/forrest-brain-nonterminal.json" <<'NODE'
const fs = require('node:fs');
for (const file of process.argv.slice(2)) {
  const body = JSON.parse(fs.readFileSync(file, 'utf8'));
  const active = (body.operations || []).filter((op) => op.state === 'queued' || op.state === 'running');
  if (active.length) { console.error(JSON.stringify(active)); process.exit(1); }
}
NODE
```

Expected: every configured allowlisted process remains online exactly once with the state-aware Step 3 transition: the two engines/two dashboards started from the recorded stopped baseline at delta `0`, the prior-online harnesses/COSMO restarted at `+1`, and each MCP row matches its own observed state (`+1`, `0`, or new baseline `0`). The immediate/delayed PM2 projections prove no subsequent PID or restart movement. Every unrelated row remains identity/config/status/PID/uptime-stable with a nondecreasing counter that did not advance after the immediate baseline. Listeners belong to the refreshed named PIDs; `/api/status`, both catalogs, both current-authority operation listings, and the generated harness brain-tool registries are healthy at immediate and delayed readback. Catalog entries expose all canonical `mutationBoundaries` and no capability bytes.

- [ ] **Step 5: Run the actual agent-client and brain-tool own-brain canaries**

Discover the canary from the authoritative pinned source before asking a query; do not invent or seed a phrase and then claim retrieval works:

```bash
node scripts/live-brain-tools-smoke.mjs \
  --base-url http://127.0.0.1:5002 --caller-agent jerry \
  --scenario discover-canary \
  --output "$LIVE_RECEIPT_DIR/brain-own-canary.jsonl"
node - "$LIVE_RECEIPT_DIR/brain-own-canary.jsonl" "$RECEIPT_RUN_DIR/run-authority.json" <<'NODE'
const fs = require('node:fs');
const [canaryFile, authorityFile] = process.argv.slice(2);
const authority = JSON.parse(fs.readFileSync(authorityFile, 'utf8'));
const rows = fs.readFileSync(canaryFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
if (rows.length < 2) throw new Error('discover-canary did not emit every operation terminal');
const operationIds = new Set();
for (const row of rows) {
  if (row.receiptKind !== 'operation-terminal' || row.scenario !== 'discover-canary'
      || row.protectedResultRead !== true || !row.operationId || operationIds.has(row.operationId)
      || row.receiptRunId !== authority.receiptRunId || row.authority !== 'live'
      || row.implementationCommit !== authority.implementationCommit) {
    throw new Error('discover-canary operation receipt set invalid');
  }
  operationIds.add(row.operationId);
}
const canary = rows.at(-1);
if (!canary.query || !canary.nodeId || !Number.isSafeInteger(canary.sourceRevision)) process.exit(1);
const evidence = canary.sourceEvidence;
const authoritativeNodes = evidence?.authoritativeTotals?.nodes;
const returnedNodes = evidence?.returnedTotals?.nodes;
const exactPositive = evidence?.matchOutcome === 'matches'
  && Number.isSafeInteger(authoritativeNodes) && authoritativeNodes > 0
  && Number.isSafeInteger(returnedNodes) && returnedNodes > 0
  && returnedNodes <= authoritativeNodes;
const healthy = canary.sourceHealth === 'healthy'
  && evidence?.sourceHealth === 'healthy'
  && exactPositive;
const degradedExactMatch = canary.sourceHealth === 'degraded'
  && evidence?.sourceHealth === 'degraded'
  && evidence.freshness === 'unknown'
  && exactPositive;
if (!healthy && !degradedExactMatch) process.exit(1);
if (evidence?.selectedBrain !== canary.selectedBrain) process.exit(1);
const evidenceRevision = [
  evidence?.revision,
  evidence?.sourceRevision,
  evidence?.deltaWatermark?.revision,
  evidence?.baseWatermark?.revision,
  evidence?.identity?.revision,
].find(Number.isSafeInteger);
if (evidenceRevision !== canary.sourceRevision) process.exit(1);
console.log(JSON.stringify({ query: canary.query, nodeId: canary.nodeId,
  sourceRevision: canary.sourceRevision, sourceHealth: canary.sourceHealth,
  matchOutcome: evidence.matchOutcome, freshness: evidence.freshness }));
NODE
node scripts/live-brain-tools-smoke.mjs \
  --base-url http://127.0.0.1:5002 --caller-agent jerry --scenario own \
  --canary-receipt "$LIVE_RECEIPT_DIR/brain-own-canary.jsonl" \
  --query-wait-ms 5400000 --pgs-wait-ms 21600000 \
  --output "$LIVE_RECEIPT_DIR/brain-own.jsonl"
node - "$LIVE_RECEIPT_DIR/brain-own.jsonl" "$RECEIPT_RUN_DIR/run-authority.json" <<'NODE'
const fs = require('node:fs');
const [receiptFile, authorityFile] = process.argv.slice(2);
const authority = JSON.parse(fs.readFileSync(authorityFile, 'utf8'));
const rows = fs.readFileSync(receiptFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
if (rows.length !== 4) throw new Error(`own emitted ${rows.length} terminal rows, expected four`);
const operationIds = new Set();
for (const row of rows) {
  if (row.receiptKind !== 'operation-terminal' || row.scenario !== 'own'
      || row.protectedResultRead !== true || row.requesterAgent !== 'jerry'
      || !row.operationId || operationIds.has(row.operationId)
      || row.receiptRunId !== authority.receiptRunId || row.authority !== 'live'
      || row.implementationCommit !== authority.implementationCommit) {
    throw new Error('own operation receipt set invalid');
  }
  operationIds.add(row.operationId);
}
const selected = rows.at(-1);
if (selected.operationType !== 'query' || !selected.canaryNodeId
    || !Number.isSafeInteger(selected.canarySourceRevision)) {
  throw new Error('own selected-last query receipt invalid');
}
NODE
node scripts/sample-process-memory.mjs \
  --target dashboard=pm2:home23-jerry-dash --target cosmo=pm2:home23-cosmo23 \
  --metric runtime-memory-evidence-v2 --interval-ms 250 --max-metric-age-ms 5000 \
  --max-heap-growth-mib 256 --output "$LIVE_RECEIPT_DIR/brain-direct-query-heap.json" -- \
  node scripts/live-brain-tools-smoke.mjs \
    --base-url http://127.0.0.1:5002 --caller-agent jerry --scenario direct-query \
    --canary-receipt "$LIVE_RECEIPT_DIR/brain-own-canary.jsonl" \
    --query-wait-ms 5400000 --output "$LIVE_RECEIPT_DIR/brain-direct-query.jsonl"
node scripts/live-brain-tools-smoke.mjs \
  --base-url http://127.0.0.1:5012 --caller-agent forrest \
  --scenario discover-canary \
  --output "$LIVE_RECEIPT_DIR/brain-forrest-owned-canary.jsonl"
node - "$LIVE_RECEIPT_DIR/brain-forrest-owned-canary.jsonl" \
  "$RECEIPT_RUN_DIR/run-authority.json" <<'NODE'
const fs = require('node:fs');
const [receiptFile, authorityFile] = process.argv.slice(2);
const authority = JSON.parse(fs.readFileSync(authorityFile, 'utf8'));
const rows = fs.readFileSync(receiptFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const operationIds = new Set();
if (rows.length < 2) process.exit(1);
for (const row of rows) {
  if (row.receiptKind !== 'operation-terminal' || row.scenario !== 'discover-canary'
      || row.requesterAgent !== 'forrest' || row.protectedResultRead !== true
      || !row.operationId || operationIds.has(row.operationId)
      || row.receiptRunId !== authority.receiptRunId || row.authority !== 'live'
      || row.implementationCommit !== authority.implementationCommit) process.exit(1);
  operationIds.add(row.operationId);
}
const selected = rows.at(-1);
if (!selected.query || !selected.nodeId || !Number.isSafeInteger(selected.sourceRevision)) process.exit(1);
NODE
```

The Jerry discovery scenario selects a stable unique token from a bounded authoritative source read and records its node ID plus revision. The `own` scenario imports the built `BrainOperationsClient` and invokes the real `brain_search`, `brain_status`, bounded `brain_memory_graph`, and `brain_query` executors with omitted targets using that exact token. The separately sampled `direct-query` scenario proves the exact durable query route on the same canary. The provider-free Forrest-owned discovery runs before Forrest's Step 7 BEFORE hashes so Step 11 has a real terminal operation owned by the Forrest requester without contaminating the later no-write window. Both dashboard and COSMO metric series must be fresh, retain their PIDs, show zero restart delta, and stay within the heap bound. Positive canaries must be complete and target-identical. Healthy and degraded sources both require match outcome exactly `matches`, positive safe-integer authoritative and returned node totals, returned totals no larger than authority, and selected brain plus revision equal to the canary. A legacy projection additionally requires both receipt and evidence to say degraded and freshness exactly unknown. No unknown-match or zero-total evidence may pass. Only healthy complete coverage may prove no-match or corpus-empty. A typed failure is recorded as a failure, never rendered as success or an empty brain.

- [ ] **Step 6: Resolve exact sibling and completed-research targets**

Resolve one exact deterministic, completed, nonempty research ID from the saved catalog and reject active/unavailable/zero-node entries. A research brain may legitimately have `ownerAgent:null`; owner presence is not an availability gate. Do not start discovery or query operations until the BEFORE inventories in Step 7 exist:

```bash
node - "$LIVE_RECEIPT_DIR/jerry-brain-catalog.json" \
  "$LIVE_RECEIPT_DIR/research-target-selection.json" \
  "$RECEIPT_RUN_DIR/run-authority.json" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [catalogFile, output, authorityFile] = process.argv.slice(2);
const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
const authority = JSON.parse(fs.readFileSync(authorityFile, 'utf8'));
const required = new Set(['brain','run','pgs','session','cache','export','agency']);
const matches = catalog.brains.filter((brain) => {
  if (brain.kind !== 'research' || brain.lifecycle !== 'completed'
      || !Number.isSafeInteger(brain.nodeCount) || brain.nodeCount <= 0
      || typeof brain.id !== 'string' || !brain.id
      || typeof brain.canonicalRoot !== 'string' || !path.isAbsolute(brain.canonicalRoot)
      || !(brain.ownerAgent === null
        || (typeof brain.ownerAgent === 'string' && brain.ownerAgent.trim()))) return false;
  const boundaries = brain.mutationBoundaries || [];
  const kinds = new Set(boundaries.map((boundary) => boundary.kind));
  if (boundaries.length !== 7 || kinds.size !== 7
      || [...required].some((kind) => !kinds.has(kind))) return false;
  try {
    const stat = fs.lstatSync(brain.canonicalRoot);
    return stat.isDirectory() && !stat.isSymbolicLink()
      && fs.realpathSync(brain.canonicalRoot) === brain.canonicalRoot;
  } catch {
    return false;
  }
}).sort((left, right) => left.id.localeCompare(right.id));
if (matches.length < 1) throw new Error('no deterministic completed nonempty research target');
if (matches.some((brain, index) => index > 0 && brain.id === matches[index - 1].id)) {
  throw new Error('ambiguous duplicate research target ID');
}
const selected = matches[0];
fs.writeFileSync(output, `${JSON.stringify({
  schemaVersion: 1,
  receiptRunId: authority.receiptRunId,
  implementationCommit: authority.implementationCommit,
  authority: 'live',
  catalogRevision: catalog.catalogRevision,
  brainId: selected.id,
  ownerAgent: selected.ownerAgent,
  nodeCount: selected.nodeCount,
  canonicalRoot: selected.canonicalRoot,
  selectionOrder: 'brain-id-ascending',
}, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
NODE
RESEARCH_BRAIN_ID=$(node -p "require(process.argv[1]).brainId" \
  "$LIVE_RECEIPT_DIR/research-target-selection.json")
test -n "$RESEARCH_BRAIN_ID"
export RESEARCH_BRAIN_ID
```

Expected: the selected research entry is the first stable ID in the filtered catalog, is completed, canonical/available, has a positive safe-integer node count, and exposes all seven named mutation boundaries. Its owner is recorded exactly and may be null. Unknown, active, duplicate-ID ambiguous, unavailable, or zero-node selection is an explicit typed failure. Canary discovery, query, and PGS all run between the BEFORE and AFTER inventories in Step 7.

- [ ] **Step 7: Prove all cross-brain mutation boundaries remain unchanged**

Capture both BEFORE inventories first, then run canary discovery, query, and PGS through the real client/tool path, then capture and compare AFTER inventories:

```bash
CATALOG="$LIVE_RECEIPT_DIR/jerry-brain-catalog.json"
PM2_FORREST_PROJECTION='let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const rows=JSON.parse(s).filter(p=>p.name==="home23-forrest").map(p=>{const e=p.pm2_env||{};return{name:p.name,pid:p.pid,status:e.status,restarts:e.restart_time,uptime:e.pm_uptime,script:e.pm_exec_path||null,cwd:e.pm_cwd||null,namespace:e.namespace||"default",execMode:e.exec_mode||null,instances:e.instances??null,args:e.args??null,interpreter:e.exec_interpreter||null,nodeArgs:e.node_args??null,envKeys:Object.keys(e.env&&typeof e.env==="object"?e.env:{}).sort()}});process.stdout.write(JSON.stringify(rows,null,2))})'
pm2 jlist | node -e "$PM2_FORREST_PROJECTION" \
  > "$LIVE_RECEIPT_DIR/forrest-engine-before-pause.json"
node -e "const rows=require(process.argv[1]);if(rows.length!==1||rows[0].status!=='online'||!(rows[0].pid>0))process.exit(1)" \
  "$LIVE_RECEIPT_DIR/forrest-engine-before-pause.json"
FORREST_RESUME_REQUIRED=1
resume_forrest_engine() {
  if [ "${FORREST_RESUME_REQUIRED:-0}" -eq 1 ]; then
    FORREST_CURRENT_STATUS=$(pm2 jlist | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const rows=JSON.parse(s).filter(p=>p.name==="home23-forrest");process.stdout.write(rows.length===1?String(rows[0].pm2_env.status):"missing")})')
    if [ "$FORREST_CURRENT_STATUS" != online ]; then pm2 start home23-forrest >/dev/null; fi
  fi
}
trap resume_forrest_engine EXIT
trap 'resume_forrest_engine; exit 129' HUP
trap 'resume_forrest_engine; exit 130' INT
trap 'resume_forrest_engine; exit 143' TERM
pm2 stop home23-forrest
pm2 jlist | node -e "$PM2_FORREST_PROJECTION" \
  > "$LIVE_RECEIPT_DIR/forrest-engine-paused.json"
node - "$LIVE_RECEIPT_DIR/forrest-engine-before-pause.json" \
  "$LIVE_RECEIPT_DIR/forrest-engine-paused.json" \
  "$RECEIPT_RUN_DIR/run-authority.json" \
  "$LIVE_RECEIPT_DIR/forrest-engine-pause-receipt.json" <<'NODE'
const fs = require('node:fs');
const [beforeFile, pausedFile, authorityFile, output] = process.argv.slice(2);
const before = JSON.parse(fs.readFileSync(beforeFile, 'utf8'));
const paused = JSON.parse(fs.readFileSync(pausedFile, 'utf8'));
const authority = JSON.parse(fs.readFileSync(authorityFile, 'utf8'));
if (before.length !== 1 || paused.length !== 1 || before[0].status !== 'online'
    || paused[0].status !== 'stopped' || paused[0].restarts !== before[0].restarts) {
  throw new Error('Forrest pause transition invalid');
}
fs.writeFileSync(output, `${JSON.stringify({
  schemaVersion: 1, receiptRunId: authority.receiptRunId,
  implementationCommit: authority.implementationCommit, authority: 'live',
  processName: 'home23-forrest', before: before[0], paused: paused[0],
  pausedAt: new Date().toISOString(), requiredThrough: 'boundary-compare-complete',
}, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
NODE
node scripts/hash-brain-boundaries.mjs --catalog "$CATALOG" --target-agent forrest \
  --require brain,run,pgs,session,cache,export,agency --phase before \
  --output "$LIVE_RECEIPT_DIR/forrest-boundaries-before.json"
node scripts/hash-brain-boundaries.mjs --catalog "$CATALOG" --target-brain "$RESEARCH_BRAIN_ID" \
  --require brain,run,pgs,session,cache,export,agency --phase before \
  --output "$LIVE_RECEIPT_DIR/research-boundaries-before.json"

node scripts/live-brain-tools-smoke.mjs --base-url http://127.0.0.1:5002 --caller-agent jerry \
  --scenario discover-canary --target-agent forrest \
  --output "$LIVE_RECEIPT_DIR/brain-forrest-canary.jsonl"
node scripts/live-brain-tools-smoke.mjs --base-url http://127.0.0.1:5002 --caller-agent jerry \
  --scenario discover-canary --target-brain "$RESEARCH_BRAIN_ID" \
  --output "$LIVE_RECEIPT_DIR/brain-research-canary.jsonl"
node - "$RECEIPT_RUN_DIR/run-authority.json" \
  "$LIVE_RECEIPT_DIR/brain-forrest-canary.jsonl" \
  "$LIVE_RECEIPT_DIR/brain-research-canary.jsonl" <<'NODE'
const fs = require('node:fs');
const [authorityFile, ...files] = process.argv.slice(2);
const authority = JSON.parse(fs.readFileSync(authorityFile, 'utf8'));
for (const file of files) {
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  if (rows.length < 2) throw new Error(`incomplete discover-canary receipt: ${file}`);
  const operationIds = new Set();
  for (const row of rows) {
    if (row.receiptKind !== 'operation-terminal' || row.scenario !== 'discover-canary'
        || row.protectedResultRead !== true || !row.operationId || operationIds.has(row.operationId)
        || row.receiptRunId !== authority.receiptRunId || row.authority !== 'live'
        || row.implementationCommit !== authority.implementationCommit) {
      throw new Error(`invalid discover-canary operation set: ${file}`);
    }
    operationIds.add(row.operationId);
  }
  const selected = rows.at(-1);
  if (!selected.query || !selected.nodeId || !Number.isSafeInteger(selected.sourceRevision)) {
    throw new Error(`invalid selected-last canary: ${file}`);
  }
}
NODE
node scripts/live-brain-tools-smoke.mjs --base-url http://127.0.0.1:5002 --caller-agent jerry \
  --scenario sibling --target-agent forrest \
  --canary-receipt "$LIVE_RECEIPT_DIR/brain-forrest-canary.jsonl" \
  --query-wait-ms 5400000 --output "$LIVE_RECEIPT_DIR/brain-sibling.jsonl"
node scripts/live-brain-tools-smoke.mjs --base-url http://127.0.0.1:5002 --caller-agent jerry \
  --scenario completed-research --target-brain "$RESEARCH_BRAIN_ID" \
  --canary-receipt "$LIVE_RECEIPT_DIR/brain-research-canary.jsonl" \
  --query-wait-ms 5400000 --output "$LIVE_RECEIPT_DIR/brain-research.jsonl"
node scripts/live-brain-tools-smoke.mjs --base-url http://127.0.0.1:5002 --caller-agent jerry \
  --scenario completed-research-compile --target-brain "$RESEARCH_BRAIN_ID" \
  --canary-receipt "$LIVE_RECEIPT_DIR/brain-research-canary.jsonl" \
  --query-wait-ms 5400000 --output "$LIVE_RECEIPT_DIR/brain-research-compile.jsonl"
node scripts/live-brain-tools-smoke.mjs --base-url http://127.0.0.1:5002 --caller-agent jerry \
  --scenario canonical-export --operation-receipt "$LIVE_RECEIPT_DIR/brain-research.jsonl" \
  --format markdown --output "$LIVE_RECEIPT_DIR/brain-research-export.jsonl"
PROVIDER_SELECTION_TMP="$LIVE_RECEIPT_DIR/.brain-provider-selection.$$.tmp"
PROVIDER_ERROR_TXT="$LIVE_RECEIPT_DIR/brain-provider-selection-error.txt"
if node scripts/live-brain-tools-smoke.mjs --list-healthy-models \
    --base-url http://127.0.0.1:43210 \
    > "$PROVIDER_SELECTION_TMP" 2> "$PROVIDER_ERROR_TXT"; then
  node -e "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))" "$PROVIDER_SELECTION_TMP"
  mv "$PROVIDER_SELECTION_TMP" "$LIVE_RECEIPT_DIR/brain-provider-selection.json"
  rm -f "$PROVIDER_ERROR_TXT"
  PROVIDER_EXIT=0
else
  PROVIDER_EXIT=$?
  rm -f "$PROVIDER_SELECTION_TMP"
  test -s "$PROVIDER_ERROR_TXT" || node -e \
    "require('node:fs').writeFileSync(process.argv[1], 'provider probe exited without stderr\n')" \
    "$PROVIDER_ERROR_TXT"
  export PROVIDER_EXIT PROVIDER_ERROR_TXT
  node - "$LIVE_RECEIPT_DIR/brain-provider-limitation.json" \
    "$RECEIPT_RUN_DIR/run-authority.json" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [output, authorityFile] = process.argv.slice(2);
const authority = JSON.parse(fs.readFileSync(authorityFile, 'utf8'));
fs.writeFileSync(output, `${JSON.stringify({
  schemaVersion: 1,
  receiptRunId: authority.receiptRunId,
  implementationCommit: authority.implementationCommit,
  authority: 'live',
  code: 'no_healthy_provider',
  exitCode: Number(process.env.PROVIDER_EXIT),
  stderrArtifact: path.basename(process.env.PROVIDER_ERROR_TXT),
}, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
NODE
fi
LARGE_PGS_TARGET=$(node - "$CATALOG" "$RESEARCH_BRAIN_ID" <<'NODE'
const fs = require('node:fs');
const [catalogFile, researchId] = process.argv.slice(2);
const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
const eligible = catalog.brains.filter((brain) =>
  Number.isSafeInteger(brain.nodeCount) && brain.nodeCount >= 100000
  && ((brain.kind === 'resident' && brain.ownerAgent === 'forrest')
    || (brain.kind === 'research' && brain.lifecycle === 'completed' && brain.id === researchId)))
  .sort((left, right) => left.id.localeCompare(right.id));
if (eligible.length) process.stdout.write(JSON.stringify({
  brainId: eligible[0].id, nodeCount: eligible[0].nodeCount,
  authority: 'read-only',
}));
NODE
)
if [ "${PROVIDER_EXIT:-0}" -eq 0 ] && [ -n "$LARGE_PGS_TARGET" ]; then
  PGS_TARGET_ID=$(node -p "JSON.parse(process.argv[1]).brainId" "$LARGE_PGS_TARGET")
  PGS_TARGET_NODES=$(node -p "JSON.parse(process.argv[1]).nodeCount" "$LARGE_PGS_TARGET")
  PGS_CANARY="$LIVE_RECEIPT_DIR/brain-forrest-canary.jsonl"
  if [ "$PGS_TARGET_ID" = "$RESEARCH_BRAIN_ID" ]; then
    PGS_CANARY="$LIVE_RECEIPT_DIR/brain-research-canary.jsonl"
  fi
  PGS_SWEEP_SELECTION=$(node -p "JSON.stringify(require(process.argv[1]).pgsSweep)" "$LIVE_RECEIPT_DIR/brain-provider-selection.json")
  PGS_SYNTH_SELECTION=$(node -p "JSON.stringify(require(process.argv[1]).pgsSynth)" "$LIVE_RECEIPT_DIR/brain-provider-selection.json")
  node scripts/sample-process-memory.mjs \
    --target dashboard=pm2:home23-jerry-dash --target cosmo=pm2:home23-cosmo23 \
    --metric runtime-memory-evidence-v2 --interval-ms 1000 --max-metric-age-ms 5000 \
    --max-heap-growth-mib 256 --output "$LIVE_RECEIPT_DIR/brain-pgs-heap.json" -- \
    node scripts/live-brain-tools-smoke.mjs --base-url http://127.0.0.1:5002 --caller-agent jerry \
      --scenario pgs --target-brain "$PGS_TARGET_ID" --require-authoritative-nodes "$PGS_TARGET_NODES" \
      --canary-receipt "$PGS_CANARY" \
      --sweep-fraction 0.10 --pgs-sweep-selection "$PGS_SWEEP_SELECTION" \
      --pgs-synth-selection "$PGS_SYNTH_SELECTION" --pgs-wait-ms 21600000 \
      --sse-output "$LIVE_RECEIPT_DIR/brain-pgs-events.jsonl" \
      --output "$LIVE_RECEIPT_DIR/brain-pgs.jsonl"
  PGS_RECEIPT="$LIVE_RECEIPT_DIR/brain-pgs.jsonl"
  PGS_EVENTS="$LIVE_RECEIPT_DIR/brain-pgs-events.jsonl"
  PGS_AUTHORITY=live
else
  ISOLATED_PGS_ROOT=$(mktemp -d "$SYSTEM_TMPDIR/home23-large-pgs-isolated.XXXXXX")
  HOME23_RECEIPT_AUTHORITY=isolated-controlled node scripts/live-brain-tools-smoke.mjs \
    --scenario large-pgs-isolated --isolated-fixture "$ISOLATED_PGS_ROOT" \
    --synthetic-nodes 100000 --synthetic-edges 300000 --controlled-provider \
    --pgs-wait-ms 21600000 \
    --sse-output "$RECEIPT_RUN_DIR/isolated-controlled/brain-large-pgs-events.jsonl" \
    --heap-output "$RECEIPT_RUN_DIR/isolated-controlled/brain-large-pgs-heap.json" \
    --output "$RECEIPT_RUN_DIR/isolated-controlled/brain-large-pgs.jsonl"
  PGS_RECEIPT="$RECEIPT_RUN_DIR/isolated-controlled/brain-large-pgs.jsonl"
  PGS_EVENTS="$RECEIPT_RUN_DIR/isolated-controlled/brain-large-pgs-events.jsonl"
  PGS_AUTHORITY=isolated-controlled
fi
export PGS_RECEIPT
export PGS_EVENTS
export PGS_AUTHORITY

node scripts/hash-brain-boundaries.mjs --catalog "$CATALOG" --target-agent forrest \
  --require brain,run,pgs,session,cache,export,agency --phase after \
  --output "$LIVE_RECEIPT_DIR/forrest-boundaries-after.json"
node scripts/hash-brain-boundaries.mjs --catalog "$CATALOG" --target-brain "$RESEARCH_BRAIN_ID" \
  --require brain,run,pgs,session,cache,export,agency --phase after \
  --output "$LIVE_RECEIPT_DIR/research-boundaries-after.json"
node scripts/hash-brain-boundaries.mjs --phase compare \
  --before "$LIVE_RECEIPT_DIR/forrest-boundaries-before.json" \
  --after "$LIVE_RECEIPT_DIR/forrest-boundaries-after.json" \
  --output "$LIVE_RECEIPT_DIR/forrest-boundaries-compare.json"
node scripts/hash-brain-boundaries.mjs --phase compare \
  --before "$LIVE_RECEIPT_DIR/research-boundaries-before.json" \
  --after "$LIVE_RECEIPT_DIR/research-boundaries-after.json" \
  --output "$LIVE_RECEIPT_DIR/research-boundaries-compare.json"
node - "$RECEIPT_RUN_DIR/run-authority.json" \
  "$LIVE_RECEIPT_DIR/forrest-boundaries-compare.json" \
  "$LIVE_RECEIPT_DIR/research-boundaries-compare.json" <<'NODE'
const fs = require('node:fs');
const [authorityFile, ...files] = process.argv.slice(2);
const authority = JSON.parse(fs.readFileSync(authorityFile, 'utf8'));
for (const file of files) {
  const compared = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (compared.phase !== 'compare' || compared.unchanged !== true
      || compared.receiptRunId !== authority.receiptRunId
      || compared.implementationCommit !== authority.implementationCommit
      || compared.authority !== 'live') throw new Error(`boundary compare receipt invalid: ${file}`);
}
NODE
pm2 start home23-forrest
pm2 jlist | node -e "$PM2_FORREST_PROJECTION" \
  > "$LIVE_RECEIPT_DIR/forrest-engine-resumed.json"
node - "$LIVE_RECEIPT_DIR/forrest-engine-before-pause.json" \
  "$LIVE_RECEIPT_DIR/forrest-engine-paused.json" \
  "$LIVE_RECEIPT_DIR/forrest-engine-resumed.json" \
  "$RECEIPT_RUN_DIR/run-authority.json" \
  "$LIVE_RECEIPT_DIR/forrest-engine-resume-receipt.json" <<'NODE'
const fs = require('node:fs');
const [beforeFile, pausedFile, resumedFile, authorityFile, output] = process.argv.slice(2);
const before = JSON.parse(fs.readFileSync(beforeFile, 'utf8'))[0];
const paused = JSON.parse(fs.readFileSync(pausedFile, 'utf8'))[0];
const resumed = JSON.parse(fs.readFileSync(resumedFile, 'utf8'))[0];
const authority = JSON.parse(fs.readFileSync(authorityFile, 'utf8'));
if (!before || !paused || !resumed || paused.status !== 'stopped'
    || resumed.status !== 'online' || !(resumed.pid > 0) || resumed.pid === before.pid
    || resumed.restarts !== paused.restarts) throw new Error('Forrest resume transition invalid');
fs.writeFileSync(output, `${JSON.stringify({
  schemaVersion: 1, receiptRunId: authority.receiptRunId,
  implementationCommit: authority.implementationCommit, authority: 'live',
  processName: 'home23-forrest', before, paused, resumed,
  resumedAt: new Date().toISOString(), comparesPersisted: [
    'live/forrest-boundaries-compare.json', 'live/research-boundaries-compare.json'],
}, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
NODE
FORREST_RESUMED_PID=$(node -p "require(process.argv[1])[0].pid" \
  "$LIVE_RECEIPT_DIR/forrest-engine-resumed.json")
test "$(lsof -nP -t -iTCP:5011 -sTCP:LISTEN | sort -u)" = "$FORREST_RESUMED_PID"
curl -fsS http://127.0.0.1:5012/home23/api/brain-operations/catalog \
  > "$LIVE_RECEIPT_DIR/forrest-catalog-after-resume.json"
FORREST_RESUME_REQUIRED=0
trap - EXIT HUP INT TERM
```

Expected: Forrest's engine is stopped before either BEFORE inventory and remains stopped through both persisted, validated compare receipts; an EXIT/signal trap resumes only that exact process on failure, and success clears the trap only after explicit resume/listener/readiness proof. Both compare commands exit 0 with unchanged source revision and byte-identical recursive inventories across every named boundary, including unknown/new nested files and unchanged absent-root records. Forrest's duplicate resident `brain`/`run` root is represented under both names but never broadened to the containing agent instance. A live large-PGS target is restricted to Forrest or the selected completed-research brain, so the operation is necessarily enclosed by that target's BEFORE/AFTER inventory; if neither cross-brain target meets the size/provider gate, use the wholly isolated fallback instead of weakening the proof with an own-brain target. If Forrest changes independently, the helper returns `target_changed_concurrently`; resume Forrest, wait for one verified idle window, and repeat the complete pause-BEFORE-operation-AFTER-compare-resume sequence once. Confirm new pins, scratch, result files, cache, and exports exist only beneath Jerry's requester-owned `instances/jerry/runtime/brain-operations` or explicit Jerry workspace export path. Never exclude a target file or treat concurrent mutation as success. The isolated fallback must not create any operation/pin/scratch entry in Jerry, Forrest, or live COSMO.

- [ ] **Step 8: Run one scoped PGS canary through the real wait path**

The PGS operation was started and polled between hashes in Step 7. Validate its exact SSE and protected-result receipts:

```bash
node - "$PGS_EVENTS" "$PGS_RECEIPT" "$RECEIPT_RUN_DIR/run-authority.json" <<'NODE'
const fs = require('node:fs');
const events = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const receipts = fs.readFileSync(process.argv[3], 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const authority = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
if (!events.some((event) => event.type === 'heartbeat' || event.type === 'progress' || event.type === 'pgs_phase')) process.exit(1);
for (let index = 1; index < events.length; index += 1) {
  if (!(events[index].eventSequence > events[index - 1].eventSequence)) process.exit(1);
}
const operationIds = new Set();
for (const row of receipts) {
  if (row.receiptKind !== 'operation-terminal' || !row.operationId || operationIds.has(row.operationId)
      || row.protectedResultRead !== true || row.receiptRunId !== authority.receiptRunId
      || row.implementationCommit !== authority.implementationCommit) process.exit(1);
  operationIds.add(row.operationId);
}
const terminal = receipts.at(-1);
if (!terminal || !['complete','partial'].includes(terminal.state)) process.exit(1);
const sweepOutputs = terminal.result?.sweepOutputs || [];
const successfulSweepCount = terminal.result?.metadata?.pgs?.successfulSweeps;
if (terminal.state === 'partial' && !(Array.isArray(sweepOutputs)
    && sweepOutputs.length > 0 && successfulSweepCount === sweepOutputs.length)) process.exit(1);
if (terminal.providerTerminalValidated !== true) process.exit(1);
console.log(JSON.stringify({ operationId: terminal.operationId, state: terminal.state,
  successfulSweeps: successfulSweepCount || 0, sweepOutputs: sweepOutputs.length }));
NODE
```

Require the terminal receipt's `authoritativeNodeCount >= 100000`, source pin descriptor/digest, authority tag equal to `$PGS_AUTHORITY`, and a two-process heap receipt with fresh dashboard/COSMO metrics, unchanged PIDs, and zero restart deltas. For `live`, require the explicitly probed external provider pairs and record this as the live large-PGS pass. For `isolated-controlled`, require the synthetic size/count/hash, isolated temp Home23 root, allocated loopback ports, both isolated PIDs, guarded process shutdown with the durable store retained for Step 11, and unchanged live PM2/catalog/target hashes; record the live size/provider blocker and do not claim a live-provider pass. Successful sweeps must remain in a partial result if synthesis fails, and no complete/success marker may exist for incomplete synthesis.

- [ ] **Step 9: Verify synthesis reconnect on an isolated fixture brain**

Run the helper's isolated production coordinator/worker fixture; it creates a temporary brain, never registers Jerry's live brain, and prints the exact fixture path it owns:

```bash
SYNTH_FIXTURE_ROOT=$(mktemp -d "$SYSTEM_TMPDIR/home23-synthesis-canary.XXXXXX")
HOME23_RECEIPT_AUTHORITY=isolated-controlled node scripts/live-brain-tools-smoke.mjs \
  --scenario synthesis-reconnect --isolated-fixture "$SYNTH_FIXTURE_ROOT" \
  --fixture-agent brain-ops-canary --controlled-provider \
  --fixture-operation-delay-ms 3000 --pgs-wait-ms 21600000 \
  --sse-output "$RECEIPT_RUN_DIR/isolated-controlled/brain-synthesis-events.jsonl" \
  --output "$RECEIPT_RUN_DIR/isolated-controlled/brain-synthesis.jsonl"
node - "$SYNTH_FIXTURE_ROOT" "$RECEIPT_RUN_DIR/isolated-controlled/brain-synthesis.jsonl" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = fs.realpathSync(process.argv[2]);
if (!path.basename(root).startsWith('home23-synthesis-canary.')) process.exit(1);
const receipts = fs.readFileSync(process.argv[3], 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const terminal = receipts.at(-1);
if (terminal.state !== 'complete' || terminal.protectedResultRead !== true
    || terminal.providerTerminalValidated !== true) process.exit(1);
if (terminal.coordinatorRestarted !== true || terminal.storeReloaded !== true
    || terminal.reattachedTerminal !== true) process.exit(1);
if (terminal.coordinatorRestartsAfter !== terminal.coordinatorRestartsBefore + 1
    || !['running','complete'].includes(terminal.reconciledState)
    || !Number.isSafeInteger(terminal.reattachAttempts)
    || !Array.isArray(terminal.detachedStates)) process.exit(1);
const provider = terminal.providerTerminalStoreEvidence;
if (provider?.provider !== 'controlled' || provider?.model !== 'controlled-synthesis'
    || provider?.providerCallId !== 'synthesis' || provider?.outcome !== 'complete') process.exit(1);
if (typeof terminal.generationMarker !== 'string' || !terminal.generationMarker) process.exit(1);
console.log(JSON.stringify({ fixtureRoot: root, operationId: terminal.operationId,
  state: terminal.state, generationMarker: terminal.generationMarker,
  coordinatorRestarts: [terminal.coordinatorRestartsBefore, terminal.coordinatorRestartsAfter],
  reattachAttempts: terminal.reattachAttempts }));
NODE
export SYNTH_FIXTURE_ROOT
```

The controlled fixture must delay completion, drop an attachment, replace/recreate the dashboard coordinator over the same durable store, and reattach by the exact operation ID after restart. It records one and only one synthesis start; every protected status/result/reattach read uses the exact persisted operation and cannot start provider work. This rollout command proves the complete controlled-provider path with durable provider-terminal store evidence. Typed provider failure and source-CAS conflict remain mandatory deterministic engine-suite gates; do not claim the live command exercised modes the helper does not expose. `source_changed` is never an execution state: it is canonical `state:'failed'` plus `error:{code:'source_changed',retryable:true}` and cannot publish a generation marker. Retain the stopped fixture store until Step 11's protected readback; only then may guarded cleanup remove the exact `mktemp` root whose basename, device/inode, and receipt ownership were proved. A stale prior generation presented as new fails the gate.

- [ ] **Step 10: Prove bounded graph heap and restart behavior under sampling**

Sample fresh V8 `Used Heap Size` metrics from both the requester dashboard and COSMO around the exact graph command; RSS alone or a stale PM2 metric is not accepted as heap evidence:

```bash
node scripts/sample-process-memory.mjs \
  --target dashboard=pm2:home23-jerry-dash --target cosmo=pm2:home23-cosmo23 \
  --metric runtime-memory-evidence-v2 --interval-ms 250 --max-metric-age-ms 5000 \
  --max-heap-growth-mib 256 \
  --output "$LIVE_RECEIPT_DIR/brain-graph-heap.json" -- \
  node scripts/live-brain-tools-smoke.mjs \
    --base-url http://127.0.0.1:5002 --caller-agent jerry --scenario graph \
    --node-limit 250 --edge-limit 1000 \
    --output "$LIVE_RECEIPT_DIR/brain-graph.jsonl"
node - "$LIVE_RECEIPT_DIR/brain-graph-heap.json" "$LIVE_RECEIPT_DIR/brain-graph.jsonl" <<'NODE'
const fs = require('node:fs');
const heap = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (heap.metric !== 'runtime-memory-evidence-v2' || !Array.isArray(heap.targets)
    || heap.targets.map((target) => target.name).sort().join(',') !== 'cosmo,dashboard') process.exit(1);
for (const target of heap.targets) {
  if (target.samples.length < 3 || target.metricFresh !== true || target.pidChanged
      || target.restartDelta !== 0 || target.maxSampledV8HeapGrowthMiB > 256) process.exit(1);
}
const receipt = fs.readFileSync(process.argv[3], 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).at(-1);
if (receipt.returnedTotals.nodes > 250 || receipt.returnedTotals.edges > 1000) process.exit(1);
if (!(receipt.authoritativeTotals.nodes >= receipt.returnedTotals.nodes)) process.exit(1);
console.log(JSON.stringify({ targets: heap.targets.map((target) => ({ name: target.name,
  baselineV8HeapUsedMiB: target.baselineV8HeapUsedMiB,
  maxSampledV8HeapUsedMiB: target.maxSampledV8HeapUsedMiB,
  maxSampledV8HeapGrowthMiB: target.maxSampledV8HeapGrowthMiB,
  restartDelta: target.restartDelta,
  pid: target.pid, metricFresh: target.metricFresh })) }));
NODE
```

Expected: both relevant processes have restart delta zero, PID unchanged, at least three samples with advancing in-window metric timestamps, bounded graph totals, and peak used-heap growth no greater than 256 MiB. Apply the same validator to the Direct Query and PGS heap receipts from Steps 5 and 7. A missing/stale metric, missing sample, unknown executing process, or PID change is a failed proof, not a pass.

- [ ] **Step 10a: Prove MCP parity or honest unavailability**

Use the exact authoritative own-brain canary/revision from Step 5:

```bash
node scripts/live-brain-tools-smoke.mjs \
  --base-url http://127.0.0.1:5002 --caller-agent jerry --scenario mcp-parity \
  --canary-receipt "$LIVE_RECEIPT_DIR/brain-own-canary.jsonl" \
  --output "$LIVE_RECEIPT_DIR/brain-mcp.jsonl" || MCP_EXIT=$?
MCP_CONFIGURED=$(node -e "const e=require('./ecosystem.config.cjs');process.stdout.write(String(e.apps.some(a=>a.name==='home23-jerry-mcp'&&a.autostart!==false)))")
if [ "$MCP_CONFIGURED" = true ] && [ "${MCP_EXIT:-0}" -ne 0 ]; then exit "$MCP_EXIT"; fi
if [ "${MCP_EXIT:-0}" -ne 0 ]; then
  node scripts/live-brain-tools-smoke.mjs \
    --base-url http://127.0.0.1:5002 --caller-agent jerry --scenario mcp-unavailable \
    --expect-reason mcp_disabled,mcp_unreachable,mcp_unhealthy \
    --output "$LIVE_RECEIPT_DIR/brain-mcp-unavailable.jsonl"
fi
```

When the generated Jerry config says MCP is enabled, `MCP_EXIT` must be zero and the named loopback MCP process/listener must exist; `mcp_unreachable` is a rollout failure, not an accepted limitation. Its `query_memory` result and `brain_search` result must report the same selected brain, source revision, source health, and canary node ID; identical ranking beyond that canary is unnecessary. Only an explicitly disabled config may take `mcp-unavailable`, in which case the dashboard must avoid advertising/proxying MCP and return `mcp_disabled`. A false empty result or generic HTTP failure is never an unavailable pass.

- [ ] **Step 10b: Exercise negative authority, detach/cancel, restart reconciliation, and dual zero-result behavior**

Run the remaining required scenarios through the tested helper:

```bash
node scripts/live-brain-tools-smoke.mjs --scenario negative-targets \
  --base-url http://127.0.0.1:5002 --caller-agent jerry \
  --expect-codes target_not_found,target_not_available,target_mismatch,target_ambiguous,access_denied \
  --output "$LIVE_RECEIPT_DIR/brain-negative-targets.jsonl"
LIFECYCLE_FIXTURE_ROOT=$(mktemp -d "$SYSTEM_TMPDIR/home23-operation-lifecycle.XXXXXX")
HOME23_RECEIPT_AUTHORITY=isolated-controlled node scripts/live-brain-tools-smoke.mjs --scenario detach-reattach \
  --isolated-fixture "$LIFECYCLE_FIXTURE_ROOT" --controlled-provider \
  --fixture-operation-delay-ms 3000 \
  --output "$RECEIPT_RUN_DIR/isolated-controlled/brain-detach-reattach.jsonl"
HOME23_RECEIPT_AUTHORITY=isolated-controlled node scripts/live-brain-tools-smoke.mjs --scenario cancel \
  --isolated-fixture "$LIFECYCLE_FIXTURE_ROOT" --controlled-provider \
  --fixture-operation-delay-ms 3000 \
  --output "$RECEIPT_RUN_DIR/isolated-controlled/brain-cancel.jsonl"
HOME23_RECEIPT_AUTHORITY=isolated-controlled node scripts/live-brain-tools-smoke.mjs --scenario restart-reconcile \
  --isolated-fixture "$LIFECYCLE_FIXTURE_ROOT" --controlled-provider \
  --fixture-operation-delay-ms 3000 \
  --output "$RECEIPT_RUN_DIR/isolated-controlled/brain-restart-reconcile.jsonl"
ZERO_TOKEN="home23-zero-$(date +%s)-$RANDOM-$RANDOM"
ZERO_TAG="home23-zero-tag-$(date +%s)-$RANDOM-$RANDOM"
export ZERO_TOKEN ZERO_TAG
node scripts/live-brain-tools-smoke.mjs --scenario zero-result \
  --base-url http://127.0.0.1:5002 --caller-agent jerry \
  --query "$ZERO_TOKEN" --tag "$ZERO_TAG" --zero-policy degraded-unprovable \
  --output "$LIVE_RECEIPT_DIR/brain-zero-unprovable.jsonl"
ZERO_FIXTURE_ROOT=$(mktemp -d "$SYSTEM_TMPDIR/home23-zero-manifest.XXXXXX")
HOME23_RECEIPT_AUTHORITY=isolated-controlled node scripts/live-brain-tools-smoke.mjs \
  --scenario zero-result --isolated-fixture "$ZERO_FIXTURE_ROOT" --controlled-provider \
  --query "$ZERO_TOKEN" --tag "$ZERO_TAG" --zero-policy healthy-no-match \
  --output "$RECEIPT_RUN_DIR/isolated-controlled/brain-zero-proven.jsonl"
node - "$LIFECYCLE_FIXTURE_ROOT" "$ZERO_FIXTURE_ROOT" \
  "$RECEIPT_RUN_DIR/run-authority.json" \
  "$RECEIPT_RUN_DIR/isolated-controlled/brain-detach-reattach.jsonl" \
  "$RECEIPT_RUN_DIR/isolated-controlled/brain-cancel.jsonl" \
  "$RECEIPT_RUN_DIR/isolated-controlled/brain-restart-reconcile.jsonl" \
  "$LIVE_RECEIPT_DIR/brain-zero-unprovable.jsonl" \
  "$RECEIPT_RUN_DIR/isolated-controlled/brain-zero-proven.jsonl" \
  "$LIVE_RECEIPT_DIR/brain-zero-dual-proof.json" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [lifecycleRoot, zeroRoot, authorityFile, detachFile, cancelFile, restartFile,
  liveZeroFile, isolatedZeroFile, output] = process.argv.slice(2);
const fixture = fs.realpathSync(lifecycleRoot);
const zeroFixture = fs.realpathSync(zeroRoot);
if (!path.basename(fixture).startsWith('home23-operation-lifecycle.')
    || !path.basename(zeroFixture).startsWith('home23-zero-manifest.')) process.exit(1);
const authority = JSON.parse(fs.readFileSync(authorityFile, 'utf8'));
const readValidated = (file, expectedAuthority) => {
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const operationIds = new Set();
  for (const row of rows) {
    if (row.receiptKind !== 'operation-terminal' || row.protectedResultRead !== true
        || !row.operationId || operationIds.has(row.operationId)
        || row.receiptRunId !== authority.receiptRunId
        || row.implementationCommit !== authority.implementationCommit
        || row.authority !== expectedAuthority) process.exit(1);
    operationIds.add(row.operationId);
  }
  return rows.at(-1);
};
const detached = readValidated(detachFile, 'isolated-controlled');
if (detached.detachedState !== 'running' || detached.reattachedTerminal !== true) process.exit(1);
const cancelled = readValidated(cancelFile, 'isolated-controlled');
if (cancelled.state !== 'cancelled' || cancelled.providerAbortObserved !== true) process.exit(1);
const reconciled = readValidated(restartFile, 'isolated-controlled');
if (!reconciled.storeReloaded || !['running','interrupted'].includes(reconciled.reconciledState)) process.exit(1);
const liveZero = readValidated(liveZeroFile, 'live');
if (liveZero.sourceHealth !== 'degraded' || liveZero.sourceEvidence?.freshness !== 'unknown'
    || liveZero.matchOutcome !== 'unknown' || liveZero.completeCoverage !== true
    || liveZero.authoritativeTotal <= 0 || liveZero.absenceProven !== false
    || liveZero.emptyBrainClaimAllowed !== false
    || liveZero.classification !== 'absence_unprovable'
    || liveZero.sourceEvidence?.implementation !== 'legacy-resident-sidecar-projection'
    || liveZero.sourceEvidence?.filters?.tag !== process.env.ZERO_TAG) process.exit(1);
const isolatedZero = readValidated(isolatedZeroFile, 'isolated-controlled');
if (isolatedZero.sourceHealth !== 'healthy' || isolatedZero.sourceEvidence?.freshness !== 'known'
    || isolatedZero.matchOutcome !== 'no_match' || isolatedZero.completeCoverage !== true
    || isolatedZero.authoritativeTotal <= 0
    || isolatedZero.sourceEvidence?.implementation !== 'manifest-v1'
    || isolatedZero.sourceEvidence?.filters?.tag !== process.env.ZERO_TAG
    || isolatedZero.operationId === liveZero.operationId) process.exit(1);
fs.writeFileSync(output, `${JSON.stringify({
  schemaVersion: 1, receiptRunId: authority.receiptRunId,
  implementationCommit: authority.implementationCommit, authority: 'live',
  uniqueQuery: process.env.ZERO_TOKEN, uniqueTag: process.env.ZERO_TAG,
  live: { operationId: liveZero.operationId, classification: liveZero.classification,
    absenceProven: liveZero.absenceProven, emptyBrainClaimAllowed: liveZero.emptyBrainClaimAllowed },
  isolatedControlled: { operationId: isolatedZero.operationId,
    sourceHealth: isolatedZero.sourceHealth, matchOutcome: isolatedZero.matchOutcome },
}, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
NODE
export LIFECYCLE_FIXTURE_ROOT ZERO_FIXTURE_ROOT
```

Retain the stopped lifecycle and strict-manifest zero fixtures through Step 11 readback, then clean each with the same basename/device/inode/receipt guard as Step 9. The exact 3000-ms controlled delay must keep detach/cancel/restart operations nonterminal long enough to exercise their lifecycle action. Detach must leave the durable job running and reattach to its terminal result; cancel must reach the provider signal; restart reconciliation must reload the real durable store and either reattach a proved worker or mark an orphan interrupted with partial artifacts. The live legacy route is required to prove only `absence_unprovable`—never no-match or empty—while the isolated healthy manifest route separately proves strict no-match over a nonempty, fully searched authority. Persist and later read back both distinct operation IDs. Negative tests do not invoke a paid provider.

- [ ] **Step 11: Write the pre-push receipt with observed evidence only**

Build one explicit identity manifest inside `RECEIPT_RUN_DIR`. Separate Jerry-live, Forrest-live, and isolated-controlled operation IDs with their exact receipt paths, run ID, authority, requester, and authorized endpoint/store. Re-read Jerry IDs only through Jerry, Forrest IDs only through Forrest, and fixture IDs only through their retained isolated durable stores; never send a fixture ID to a live dashboard. Prove unauthenticated/wrong-requester live reads are rejected and compare source evidence with the named JSONL receipt. A missing, duplicate-category, mismatched, or nonterminal receipt blocks completion.

Run the readback against every operation ID emitted by the smoke receipts:

```bash
node - "$RECEIPT_RUN_DIR" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = fs.realpathSync(process.argv[2]);
const authorityPath = path.join(root, 'run-authority.json');
const authorityStat = fs.lstatSync(authorityPath);
const runAuthority = JSON.parse(fs.readFileSync(authorityPath, 'utf8'));
if (!authorityStat.isFile() || authorityStat.isSymbolicLink()
    || fs.realpathSync(authorityPath) !== authorityPath
    || (authorityStat.mode & 0o777) !== 0o600
    || runAuthority.receiptRunId !== process.env.RECEIPT_RUN_ID
    || !/^[a-f0-9]{40}$/.test(runAuthority.implementationCommit || '')
    || runAuthority.expectedLiveTree !== runAuthority.actualLiveTree
    || (process.env.HOME23_RECEIPT_IMPLEMENTATION_COMMIT
      && process.env.HOME23_RECEIPT_IMPLEMENTATION_COMMIT !== runAuthority.implementationCommit)) {
  throw new Error('run-authority.json is not the sole valid identity authority');
}
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const candidate = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`receipt symlink: ${candidate}`);
    if (entry.isDirectory()) walk(candidate);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(candidate);
  }
}
walk(root);
const manifest = { schemaVersion: 1, receiptRunId: runAuthority.receiptRunId,
  implementationCommit: runAuthority.implementationCommit,
  authorities: ['live','isolated-controlled'], auditRoot: root, createdAt: new Date().toISOString(),
  groups: { jerryLive: [], forrestLive: [], isolatedControlled: [] } };
const seen = new Map();
const observedOperationIds = new Set();
let terminalRowCount = 0;
for (const file of files) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const value = JSON.parse(line);
    if (value.receiptRunId !== runAuthority.receiptRunId) throw new Error(`run ID mismatch: ${file}`);
    if (value.implementationCommit !== runAuthority.implementationCommit) {
      throw new Error(`implementation commit mismatch: ${file}`);
    }
    if (!['live','isolated-controlled'].includes(value.authority)) throw new Error(`authority missing: ${file}`);
    if (!value.operationId) continue;
    observedOperationIds.add(value.operationId);
    if (value.receiptKind !== 'operation-terminal') continue;
    terminalRowCount += 1;
    if (!['complete','partial','failed','cancelled','interrupted'].includes(value.state)
        || value.protectedResultRead !== true) {
      throw new Error(`invalid terminal operation receipt: ${file}`);
    }
    const group = value.authority === 'isolated-controlled' ? 'isolatedControlled'
      : value.requesterAgent === 'forrest' ? 'forrestLive'
      : value.requesterAgent === 'jerry' ? 'jerryLive' : null;
    if (!group) throw new Error(`unknown live requester: ${value.requesterAgent}`);
    if (group === 'isolatedControlled' &&
        (typeof value.isolatedStore !== 'string' || !value.isolatedStore.trim())) {
      throw new Error(`isolated operation lacks retained store: ${value.operationId}`);
    }
    if (group !== 'isolatedControlled' &&
        (typeof value.authorizedEndpoint !== 'string' || !value.authorizedEndpoint.trim()
          || value.isolatedStore != null)) {
      throw new Error(`live operation authority metadata invalid: ${value.operationId}`);
    }
    const prior = seen.get(value.operationId);
    if (prior) throw new Error(`duplicate terminal operation receipt: ${value.operationId}`);
    const identity = { group, authority: value.authority,
      requesterAgent: value.requesterAgent || null,
      isolatedStore: value.isolatedStore || null,
      authorizedEndpoint: value.authorizedEndpoint || null };
    seen.set(value.operationId, identity);
    manifest.groups[group].push({ operationId: value.operationId,
      authority: identity.authority, requesterAgent: identity.requesterAgent,
      implementationCommit: runAuthority.implementationCommit,
      receipt: path.relative(root, file), isolatedStore: identity.isolatedStore,
      authorizedEndpoint: identity.authorizedEndpoint });
  }
}
for (const operationId of observedOperationIds) {
  if (!seen.has(operationId)) throw new Error(`operation lacks canonical terminal receipt: ${operationId}`);
}
if (!manifest.groups.jerryLive.length || !manifest.groups.forrestLive.length
    || !manifest.groups.isolatedControlled.length) {
  throw new Error('identity manifest lacks Jerry, Forrest, or isolated operation IDs');
}
if (terminalRowCount !== seen.size || observedOperationIds.size !== seen.size) {
  throw new Error('not every observed operation has exactly one canonical terminal row');
}
const readSelectedLast = (relative) => {
  const rows = fs.readFileSync(path.join(root, relative), 'utf8')
    .trim().split('\n').filter(Boolean).map(JSON.parse);
  if (!rows.length || rows.some((row) => row.receiptKind !== 'operation-terminal')) {
    throw new Error(`invalid operation receipt set: ${relative}`);
  }
  return rows.at(-1);
};
const liveZero = readSelectedLast('live/brain-zero-unprovable.jsonl');
const isolatedZero = readSelectedLast('isolated-controlled/brain-zero-proven.jsonl');
if (liveZero.operationId === isolatedZero.operationId
    || seen.get(liveZero.operationId)?.group !== 'jerryLive'
    || seen.get(isolatedZero.operationId)?.group !== 'isolatedControlled') {
  throw new Error('dual zero operation identities missing or misgrouped');
}
manifest.dualZeroOperationIds = {
  liveAbsenceUnprovable: liveZero.operationId,
  isolatedHealthyNoMatch: isolatedZero.operationId,
};
fs.writeFileSync(path.join(root, 'operation-identity-manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
NODE
node scripts/live-brain-tools-smoke.mjs --scenario verify-receipts \
  --base-url http://127.0.0.1:5002 --caller-agent jerry \
  --forrest-base-url http://127.0.0.1:5012 --cosmo-base-url http://127.0.0.1:43210 \
  --identity-manifest "$RECEIPT_RUN_DIR/operation-identity-manifest.json" \
  --smoke-root "$RECEIPT_RUN_DIR" \
  --output "$RECEIPT_RUN_DIR/live/brain-receipt-verification.jsonl"
```

Expected: all Jerry/Forrest status-result reads match terminal durable authority and source evidence; isolated IDs match their retained stores; Forrest rejects Jerry-owned operation IDs; COSMO rejects every unauthenticated protected status/result/control attempt; and the receipt verifier exits 0 without printing secrets. Only after this verification may the isolated fixture helpers perform their already-guarded cleanup and append cleanup receipts with `authority:'isolated-controlled'`. Do not build an artifact manifest yet: cleanup, Step 12 PM2-save evidence, status-push readback, and final TAP artifacts must exist before the one immutable Step 15 seal.

Return explicitly to the isolated feature worktree before creating or committing portable evidence:

```bash
cd "$ISOLATED_ROOT"
test "$(git branch --show-current)" = codex/brain-agent-migration
test "$(pwd -P)" != "$LIVE_ROOT"
```

All remaining portable Git edits/commits/pushes occur here. The primary live checkout remains deployment state: a clean fast-forward has an intentional index transition to the exact implementation tree, while a combined deployment preserves its pre-deployment index byte-for-byte. Evidence is read only from the dedicated authority-tagged `$RECEIPT_RUN_DIR`; its path set is sealed once in Step 15. Do not rescan an arbitrary `${TMPDIR}` glob or hand-select favorable receipts.

Leave the approved spec status unchanged in this step. It cannot say `Implemented` until the receipt exists, final verification passes, and the verified portable commit has been pushed and read back from `origin` in Step 14. An external provider outage may be recorded as a typed limitation only when the controlled-provider path proves the implementation and every local safety/authority/no-write test passes.

Create `docs/receipts/2026-07-09-brain-tools-hardening.md` with these concrete headings:

```markdown
# Brain Tools Hardening Receipt — 2026-07-09

## Scope and commits
## Receipt run identity, authority tags, and artifact-manifest digest
## External three-way expected/actual live tree and preserved-index proof
## Projection-storm root cause, 255 roots, 36.10 GiB, and 99-percent disk evidence
## Two-dashboard emergency-stop deviation, already-quiesced engines, and preserved online harness/COSMO state
## Cross-process canonical-source admission and retryable HTTP-503 boundaries
## Manifest-driven orphan cleanup approval, seven reviewed exclusions, byte/statfs proof, and final runtime gates
## Post-cleanup disk/memory headroom
## Portable runtime prompt, dashboard PGS copy, and live Jerry guidance correction
## Durable cron-query coordinator migration, 5,400-second default, and truthful terminal rendering
## Full Plan A-C prerequisite matrix
## Focused test commands and exact totals
## Build, full test, contract, and portability results
## Pre/post PM2 process and listener truth
## Existing-install capability and ecosystem migration
## Pre-restart Jerry/Forrest live-load and temp-clone save proof
## Catalog and source watermarks
## Jerry own-brain canaries
## Forrest sibling read-only canary and target hash proof
## Completed research-brain canary and target hash proof
## Large PGS progress, heap/PID/restart proof, and live vs isolated authority
## Isolated synthesis operation
## Direct Query and bounded graph dashboard/COSMO heap/PID/restart proof
## MCP parity or typed unavailability
## Negative authority, detach/reattach, cancel, restart reconciliation, and dual zero-result proof
## External provider limitations
## Guarded PM2 dump backup, full-table comparison, save, and readback
## Final portable Git/remote-main state and preserved dirty live checkout
```

Populate every section with the exact commands, timestamps, operation IDs, result states, watermarks, per-process fresh metric windows, PIDs, restart counts, authority tags, and outputs observed in Steps 0B-10b. Include `EXPECTED_LIVE_TREE == ACTUAL_LIVE_TREE`, either the clean fast-forward index-transition proof or combined deployment original-index hashes, receipt run ID, final artifact-manifest digest when available, and exact Plan A-C group totals. The incident/cleanup sections must name the per-request full legacy projection root cause; 255 total immediate dashboard-source roots; approximately 36.10 GiB; original 99-percent disk state; engines already quiesced by the persistence/acceptance gate; the two exact later emergency dashboard stops; final four-row stopped/PID-zero state; still-online harness/COSMO rows; the six-port PM2-env-derived monitored union; protected 5013 port/PID/command/boot/process-start identity; dry-run full-manifest and approval-scope digests; exact approval-scope token/actor/text/time and dry-run `createdAt`; reviewed 248 removed and seven excluded; approximately 38.67 decimal GB selected/removed allocation; all six retained hardlink-pair crash-window roots plus the zero candidate with reason/identity; selected/removed logical and allocated totals; pre/post `statfs` and available-byte delta; every fresh apply-start/after brain and nonselected digest; zero structural scope drift with root identities and membership intact; exact `concurrentContentDrift` reconciliation for any identity-stable protected content advances; the candidate/quarantine mutation audit and separately named receipt-publication evidence; final PM2/listener/open-FD gates; and post-cleanup disk/memory gates. Record any `removed_postcondition_failed` or `removal_state_unknown` as a partial failure, never as reclaimed success. Record that no broad PM2 mutation occurred and that the single combined start used stopped delta `0` for both engines/dashboards. Record portable prompt/UI test totals and only local Jerry guidance relative paths plus before/after SHA-256 values—never the files' contents or external backup path. Record the durable cron focused command and exact total, the removal of legacy `queryEngine()`/`/api/query`, the 5,400-second default, exact alias pair forwarding, one-operation dispatch, and complete/detached/partial/typed-failed rendering evidence. The lifecycle section must reproduce each exact Step 10b command and observed result, name every negative error code, and list the detach, reattach terminal, cancel, restart-reconcile, live `absence_unprovable`, and isolated healthy `no_match` operation IDs with their identity-manifest groups. State `not run` or the typed external blocker for any unavailable provider check; never infer a pass. If PGS used isolated control, say explicitly that live-provider large PGS did not pass. In the final Git section record the exact Step 0B implementation commit and remote readback; do not predict the later status/receipt commit hashes. For the retained private Forrest recovery backup, the tracked receipt records only `live/forrest-config-backup-retention.json`, `live/forrest-config-backup-retention-readback.json`, the backup basename, and its SHA-256. Never copy the absolute external backup path or any config bytes into a tracked file.

- [ ] **Step 12: Re-run final verification after writing the receipt**

```bash
npm run build
npm test
npm run test:contracts
node --test --test-concurrency=1 tests/scripts/live-brain-tools-smoke.test.cjs tests/scripts/hash-brain-boundaries.test.cjs tests/scripts/sample-process-memory.test.cjs tests/scripts/verify-brain-persistence.test.cjs tests/scripts/guarded-pm2-save.test.cjs tests/scripts/cleanup-orphan-brain-projections.test.cjs tests/scripts/verify-live-deployment-tree.test.cjs
node --test --test-concurrency=1 tests/shared/memory-source-operation-context.test.js tests/engine/dashboard/brain-source-api.test.js tests/engine/dashboard/memory-search.test.js tests/cosmo23/brain-source-router.test.cjs
node --import tsx --test --test-concurrency=1 tests/agent/tools/brain.test.ts tests/agent/tools/cron.test.ts tests/agent/turn-entrypoint-callers.test.ts
node --test --test-concurrency=1 tests/dashboard/operator-ui.test.js
test "$(awk 'NR == 2 { print $4 }' "$LIVE_RECEIPT_DIR/disk-after-orphan-cleanup.txt")" -ge $((20 * 1024 * 1024))
git diff --check
git ls-files -ci --exclude-standard
if git archive HEAD | tar -tf - | rg '^(instances/|config/(home|targets|secrets)\.yaml$|config/(cron-jobs|agents)\.json$|ecosystem\.config\.cjs$)'; then
  echo 'Refusing release: archive contains local installation state' >&2
  exit 1
fi
```

Repeat the exact A_TESTS/B_TESTS/C_TESTS block from Step 0B against these final implementation-plus-receipt bytes as well. Expected: all A-D groups, build/test/contracts/helper tests, and diff check exit 0; separation searches print nothing. Re-read both requester catalogs/list routes, COSMO status, named PM2 rows/listeners, and generated harness tool registries once more. Record fresh totals in the receipt run; historical Step 0B totals are not a substitute.

After those live readbacks pass, persist only the verified named PM2 table for reboot resurrection:

```bash
set -euo pipefail
PM2_CONFIGURED=$(node -e '
const fs = require("node:fs");
const { configured } = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (!Array.isArray(configured) || !configured.length) throw new Error("configured PM2 list missing");
process.stdout.write(configured.join(","));
' "$PM2_SCOPE_AUDIT/configured-selection.json")
PM2_SAVE_RESTART_BASELINE="$PM2_SCOPE_AUDIT/after-stability.json"
node scripts/guarded-pm2-save.mjs \
  --dump "$HOME/.pm2/dump.pm2" --allow-changed "$PM2_ONLY" \
  --ecosystem "$LIVE_ROOT/ecosystem.config.cjs" --expected-configured "$PM2_CONFIGURED" \
  --restart-baseline "$PM2_SAVE_RESTART_BASELINE" --mode dry-run \
  --receipt-run-dir "$RECEIPT_RUN_DIR" --receipt-run-id "$RECEIPT_RUN_ID" \
  --authority live --output "$RECEIPT_RUN_DIR/live/guarded-pm2-save-dry-run.json"
node scripts/guarded-pm2-save.mjs \
  --dump "$HOME/.pm2/dump.pm2" --allow-changed "$PM2_ONLY" \
  --ecosystem "$LIVE_ROOT/ecosystem.config.cjs" --expected-configured "$PM2_CONFIGURED" \
  --restart-baseline "$PM2_SAVE_RESTART_BASELINE" --mode apply \
  --receipt-run-dir "$RECEIPT_RUN_DIR" --receipt-run-id "$RECEIPT_RUN_ID" \
  --authority live --output "$RECEIPT_RUN_DIR/live/guarded-pm2-save-apply.json"
node - "$RECEIPT_RUN_DIR/run-authority.json" \
  "$RECEIPT_RUN_DIR/live/guarded-pm2-save-dry-run.json" \
  "$RECEIPT_RUN_DIR/live/guarded-pm2-save-apply.json" <<'NODE'
const fs = require('node:fs');
const [authorityFile, dryFile, applyFile] = process.argv.slice(2);
const authority = JSON.parse(fs.readFileSync(authorityFile, 'utf8'));
const dry = JSON.parse(fs.readFileSync(dryFile, 'utf8'));
const applied = JSON.parse(fs.readFileSync(applyFile, 'utf8'));
for (const [row, mode, invoked] of [[dry, 'dry-run', false], [applied, 'apply', true]]) {
  if (row.mode !== mode || row.pm2SaveInvoked !== invoked || row.ok !== true
      || row.receiptRunId !== authority.receiptRunId
      || row.implementationCommit !== authority.implementationCommit
      || row.authority !== 'live' || row.moduleRowsExcluded !== true
      || row.moduleRowsFrozen !== true || row.unrelatedRestartBaselineMonotonic !== true
      || row.unrelatedRowsFrozen !== true || row.backupMode !== '0600'
      || row.backupCreatedExclusively !== true || !row.backupBasename) process.exit(1);
}
if (dry.backupBasename === applied.backupBasename
    || dry.backupSha256 !== applied.backupSha256) process.exit(1);
NODE
test -n "${FORREST_CONFIG_BACKUP:-}"
test -n "${FORREST_CONFIG_BACKUP_SHA256:-}"
node - "$FORREST_CONFIG_BACKUP" "$SYSTEM_TMPDIR" "$RECEIPT_RUN_ID" \
  "$FORREST_CONFIG_BACKUP_SHA256" \
  "$LIVE_RECEIPT_DIR/forrest-config-backup-retention.json" \
  "$LIVE_RECEIPT_DIR" "$RECEIPT_RUN_DIR/run-authority.json" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const [file, temporaryRoot, receiptRunId, expectedSha256, output, receiptRoot, authorityFile] =
  process.argv.slice(2);
const authority = JSON.parse(fs.readFileSync(authorityFile, 'utf8'));
const MAX_BACKUP_BYTES = 16 * 1024 * 1024;
const canonicalTemporaryRoot = fs.realpathSync(temporaryRoot);
const canonicalReceiptRoot = fs.realpathSync(receiptRoot);
const expectedPath = path.join(
  canonicalTemporaryRoot,
  `home23-forrest-config-${receiptRunId}.yaml`,
);
if (temporaryRoot !== canonicalTemporaryRoot
    || receiptRoot !== canonicalReceiptRoot
    || file !== expectedPath
    || output !== path.join(canonicalReceiptRoot, 'forrest-config-backup-retention.json')
    || fs.realpathSync(path.dirname(file)) !== canonicalTemporaryRoot
    || fs.realpathSync(path.dirname(output)) !== canonicalReceiptRoot
    || authority.receiptRunId !== receiptRunId
    || !/^[a-f0-9]{40}$/.test(authority.implementationCommit || '')
    || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
  throw new Error('forrest_config_backup_retention_authority_invalid');
}
const sameIdentity = (left, right) => left && right
  && left.dev === right.dev && left.ino === right.ino;
const syncDirectory = (directory) => {
  const handle = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
};
const readOpened = (descriptor, size) => {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = fs.readSync(descriptor, bytes, offset, size - offset, offset);
    if (count === 0) throw new Error('forrest_config_backup_short_read');
    offset += count;
  }
  return bytes;
};
const inspectBackup = () => {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(file, { bigint: true });
    if (!opened.isFile() || named.isSymbolicLink() || !sameIdentity(opened, named)
        || fs.realpathSync(file) !== file
        || (opened.mode & 0o777n) !== 0o600n || opened.nlink !== 1n
        || (typeof process.getuid === 'function' && opened.uid !== BigInt(process.getuid()))
        || opened.size < 1n || opened.size > BigInt(MAX_BACKUP_BYTES)) {
      throw new Error('forrest_config_backup_retention_identity_invalid');
    }
    const bytes = readOpened(descriptor, Number(opened.size));
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== expectedSha256) {
      throw new Error('forrest_config_backup_retention_digest_mismatch');
    }
    const finalNamed = fs.lstatSync(file, { bigint: true });
    if (!sameIdentity(opened, finalNamed) || finalNamed.nlink !== 1n) {
      throw new Error('forrest_config_backup_retention_changed_concurrently');
    }
    return {
      dev: opened.dev,
      ino: opened.ino,
      size: Number(opened.size),
      sha256,
    };
  } finally {
    fs.closeSync(descriptor);
  }
};
const before = inspectBackup();
const record = {
  schemaVersion: 1,
  receiptRunId,
  implementationCommit: authority.implementationCommit,
  authority: 'live',
  backupDisposition: 'retained-private-recovery',
  backupRetained: true,
  automaticDeletion: false,
  retentionPolicy: 'operator-removes-only-after-final-acceptance',
  temporaryRoot: canonicalTemporaryRoot,
  backupPath: file,
  backupBasename: path.basename(file),
  backupSha256: before.sha256,
  backupBytes: before.size,
  backupMode: '0600',
  verifiedAt: new Date().toISOString(),
};
const encoded = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
let outputDescriptor;
let outputIdentity = null;
try {
  outputDescriptor = fs.openSync(
    output,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | fs.constants.O_NOFOLLOW,
    0o600,
  );
  outputIdentity = fs.fstatSync(outputDescriptor, { bigint: true });
  fs.writeFileSync(outputDescriptor, encoded);
  fs.fsyncSync(outputDescriptor);
  fs.closeSync(outputDescriptor);
  outputDescriptor = undefined;
  syncDirectory(canonicalReceiptRoot);

  const after = inspectBackup();
  if (before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.sha256 !== after.sha256) {
    throw new Error('forrest_config_backup_retention_changed_concurrently');
  }
  const receiptDescriptor = fs.openSync(
    output,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const receiptStat = fs.fstatSync(receiptDescriptor, { bigint: true });
    const receiptNamed = fs.lstatSync(output, { bigint: true });
    if (!receiptStat.isFile() || receiptNamed.isSymbolicLink()
        || !sameIdentity(receiptStat, receiptNamed)
        || !sameIdentity(receiptStat, outputIdentity)
        || (receiptStat.mode & 0o777n) !== 0o600n || receiptStat.nlink !== 1n
        || receiptStat.size !== BigInt(encoded.length)
        || fs.realpathSync(output) !== output
        || !readOpened(receiptDescriptor, encoded.length).equals(encoded)
        || !sameIdentity(fs.lstatSync(output, { bigint: true }), receiptStat)) {
      throw new Error('forrest_config_backup_retention_receipt_invalid');
    }
  } finally {
    fs.closeSync(receiptDescriptor);
  }
} catch (error) {
  try {
    const current = fs.lstatSync(output, { bigint: true });
    if (sameIdentity(current, outputIdentity)) {
      fs.unlinkSync(output);
      syncDirectory(canonicalReceiptRoot);
    }
  } catch (cleanupError) {
    if (cleanupError.code !== 'ENOENT') error.receiptCleanupError = cleanupError;
  }
  throw error;
} finally {
  if (outputDescriptor !== undefined) fs.closeSync(outputDescriptor);
}
NODE
test -f "$FORREST_CONFIG_BACKUP"
test "$(shasum -a 256 "$FORREST_CONFIG_BACKUP" | awk 'NR == 1 { print $1 }')" = \
  "$FORREST_CONFIG_BACKUP_SHA256"
```

The helper must back up the exact dump bytes/mode into a new exclusive path before **each** dry-run/apply attempt, compare the full application live/dump tables, exclude PM2 module rows from dump equality while freezing their secret-free identity/status/PID/restart projection, and refuse any unrelated drift before mutation. The dry-run and apply backup basenames must differ; each captures the same pre-save dump digest, so any reused path or differing pre-save bytes blocks apply. `PM2_CONFIGURED` contains all seven always-configured names plus exactly the enabled MCP rows present once in the regenerated ecosystem. The Step 3 delayed snapshot is the monotonic unrelated restart baseline: later counters may be higher before the attempt, but never lower, and the attempt freezes the immediately observed value. Post-save it requires every expected process exactly once/online with normalized ecosystem identity, the new dump equal to the frozen live application table, modules still frozen, unchanged unrelated normalized rows, no duplicate/stopped/errored application entry, and unchanged live PIDs/restart counts across the save. A failed postcondition restores the apply attempt's own backup atomically and blocks completion; never leave a partially verified resurrection file. After successful save, the retention verifier proves the external Forrest-config backup's canonical parent, exact generated name, regular-file identity, single-link mode, owner, bounded size, captured bytes, and digest before and after creating a mode-0600 receipt. It never renames, links, truncates, or deletes the backup. The receipt records the exact retained path and the explicit policy `operator-removes-only-after-final-acceptance`; any validation or receipt-write failure removes only its exact owned receipt and leaves the backup untouched. Recheck the exported path, mode, owner, size, and digest immediately before the final artifact seal. Keep the absolute recovery path only in the ignored runtime retention/readback receipts. The tracked closeout names those receipt paths relative to the ignored run root plus the backup basename and digest, never the absolute recovery path; the operator reads the local runtime receipt before removing the backup after final pushed acceptance.

- [ ] **Step 13: Commit, push, and read back the verified live receipt before changing status**

The implementation/helper branch was already pushed and read back in Step 0B. After Steps 1-12 succeed, put that verified implementation hash and all observed live evidence in the receipt while leaving the spec status approved/not implemented. Commit and push the receipt alone:

```bash
git diff --cached --quiet
git add -- docs/receipts/2026-07-09-brain-tools-hardening.md
git diff --cached --check
git diff --cached -- docs/receipts/2026-07-09-brain-tools-hardening.md
git commit --only docs/receipts/2026-07-09-brain-tools-hardening.md -m "docs: record live brain reliability acceptance"
git push origin codex/brain-agent-migration
RECEIPT_PUSH_COMMIT=$(git rev-parse HEAD)
git fetch origin codex/brain-agent-migration
test "$RECEIPT_PUSH_COMMIT" = "$(git rev-parse origin/codex/brain-agent-migration)"
```

Expected: the live receipt exists on the remote and the spec still does not claim implementation.

- [ ] **Step 14: Mark the spec implemented only after receipt push/readback**

Append `RECEIPT_PUSH_COMMIT` and its successful remote readback to the receipt. Only now change the spec header to `**Status:** Implemented; live acceptance evidence in docs/receipts/2026-07-09-brain-tools-hardening.md`. Before committing, run the full A-C arrays, Plan D focused suites, build, `npm test`, contracts, helper tests, diff/portability checks **after both authority files contain their final intended text**. Record the fresh totals/hashes in a precreated `Post-authority-file verification` receipt section, then repeat the same matrix once after that insertion so verification is later than the receipt/spec bytes it attests. Any failure reverts neither file automatically; fix it and rerun before status can be committed.

Then commit and push those two authority files:

```bash
git diff --cached --quiet
git add -- docs/superpowers/specs/2026-07-09-brain-operations-reliability-design.md docs/receipts/2026-07-09-brain-tools-hardening.md
git diff --cached --check
git diff --cached -- docs/superpowers/specs/2026-07-09-brain-operations-reliability-design.md docs/receipts/2026-07-09-brain-tools-hardening.md
git commit --only docs/superpowers/specs/2026-07-09-brain-operations-reliability-design.md docs/receipts/2026-07-09-brain-tools-hardening.md -m "docs: mark brain operations implementation verified"
git push origin codex/brain-agent-migration
STATUS_PUSH_COMMIT=$(git rev-parse HEAD)
git fetch origin codex/brain-agent-migration
test "$STATUS_PUSH_COMMIT" = "$(git rev-parse origin/codex/brain-agent-migration)"
```

Expected: the implemented status first exists only after live evidence, final verification, implementation push/readback, and receipt push/readback.

- [ ] **Step 15: Record the status-push readback in the receipt**

Append `STATUS_PUSH_COMMIT` plus its remote equality proof. Because this changes the receipt again, repeat the full A-C arrays, Plan D focused suites, build, `npm test`, contracts, all seven helper tests, diff/portability checks, and authority-link/readback validation after the addendum is present. Save every post-addendum TAP/hash beneath the dedicated receipt run. When—and only when—no further run artifact remains to be written, build the one immutable artifact manifest and verify it through the read-only CLI mode:

```bash
test -n "${FORREST_CONFIG_BACKUP:-}"
test -n "${FORREST_CONFIG_BACKUP_SHA256:-}"
test -n "${SYSTEM_TMPDIR:-}"
test -n "${RECEIPT_RUN_ID:-}"
test -n "${RECEIPT_RUN_DIR:-}"
test -n "${LIVE_RECEIPT_DIR:-}"
node - "$LIVE_RECEIPT_DIR/forrest-config-backup-retention.json" \
  "$LIVE_RECEIPT_DIR/forrest-config-backup-retention-readback.json" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const [receiptPath, output] = process.argv.slice(2);
const requiredEnvironment = [
  'FORREST_CONFIG_BACKUP',
  'FORREST_CONFIG_BACKUP_SHA256',
  'SYSTEM_TMPDIR',
  'RECEIPT_RUN_ID',
  'RECEIPT_RUN_DIR',
  'LIVE_RECEIPT_DIR',
];
if (requiredEnvironment.some((name) => typeof process.env[name] !== 'string'
    || process.env[name].length === 0)) {
  throw new Error('forrest_config_backup_retention_environment_invalid');
}
const sameIdentity = (left, right) => left && right
  && left.dev === right.dev && left.ino === right.ino;
const syncDirectory = (directory) => {
  const handle = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
};
const readOpened = (descriptor, size) => {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = fs.readSync(descriptor, bytes, offset, size - offset, offset);
    if (count === 0) throw new Error('forrest_config_backup_retention_short_read');
    offset += count;
  }
  return bytes;
};
const readBoundedReceipt = () => {
  const descriptor = fs.openSync(
    receiptPath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(receiptPath, { bigint: true });
    if (!opened.isFile() || named.isSymbolicLink() || !sameIdentity(opened, named)
        || opened.nlink !== 1n || (opened.mode & 0o777n) !== 0o600n
        || opened.size < 1n || opened.size > 64n * 1024n
        || fs.realpathSync(receiptPath) !== receiptPath) {
      throw new Error('forrest_config_backup_retention_receipt_invalid');
    }
    const bytes = readOpened(descriptor, Number(opened.size));
    const finalOpened = fs.fstatSync(descriptor, { bigint: true });
    const finalNamed = fs.lstatSync(receiptPath, { bigint: true });
    if (!sameIdentity(finalOpened, opened) || finalOpened.size !== opened.size
        || !sameIdentity(finalNamed, opened) || finalNamed.nlink !== 1n) {
      throw new Error('forrest_config_backup_retention_receipt_changed');
    }
    return {
      value: JSON.parse(bytes.toString('utf8')),
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  } finally {
    fs.closeSync(descriptor);
  }
};
const retentionReceipt = readBoundedReceipt();
const receipt = retentionReceipt.value;
const canonicalTemporaryRoot = fs.realpathSync(process.env.SYSTEM_TMPDIR);
const canonicalReceiptRunRoot = fs.realpathSync(process.env.RECEIPT_RUN_DIR);
const canonicalReceiptRoot = fs.realpathSync(process.env.LIVE_RECEIPT_DIR);
const runAuthority = JSON.parse(fs.readFileSync(
  path.join(canonicalReceiptRunRoot, 'run-authority.json'), 'utf8'));
const expectedBackupPath = path.join(
  canonicalTemporaryRoot,
  `home23-forrest-config-${process.env.RECEIPT_RUN_ID}.yaml`,
);
if (process.env.SYSTEM_TMPDIR !== canonicalTemporaryRoot
    || process.env.RECEIPT_RUN_DIR !== canonicalReceiptRunRoot
    || process.env.LIVE_RECEIPT_DIR !== canonicalReceiptRoot
    || path.dirname(canonicalReceiptRoot) !== canonicalReceiptRunRoot
    || receiptPath !== path.join(
      canonicalReceiptRoot,
      'forrest-config-backup-retention.json',
    )
    || output !== path.join(
      canonicalReceiptRoot,
      'forrest-config-backup-retention-readback.json',
    )
    || process.env.FORREST_CONFIG_BACKUP !== expectedBackupPath
    || !/^[a-f0-9]{64}$/.test(process.env.FORREST_CONFIG_BACKUP_SHA256)
    || receipt.schemaVersion !== 1
    || receipt.receiptRunId !== process.env.RECEIPT_RUN_ID
    || receipt.receiptRunId !== runAuthority.receiptRunId
    || receipt.implementationCommit !== runAuthority.implementationCommit
    || receipt.authority !== 'live'
    || receipt.backupDisposition !== 'retained-private-recovery'
    || receipt.backupRetained !== true
    || receipt.automaticDeletion !== false
    || receipt.retentionPolicy !== 'operator-removes-only-after-final-acceptance'
    || receipt.temporaryRoot !== canonicalTemporaryRoot
    || receipt.backupPath !== expectedBackupPath
    || receipt.backupBasename !== path.basename(expectedBackupPath)
    || receipt.backupSha256 !== process.env.FORREST_CONFIG_BACKUP_SHA256
    || receipt.backupMode !== '0600'
    || !Number.isSafeInteger(receipt.backupBytes) || receipt.backupBytes < 1
    || receipt.backupBytes > 16 * 1024 * 1024
    || typeof receipt.verifiedAt !== 'string'
    || Number.isNaN(Date.parse(receipt.verifiedAt))) {
  throw new Error('forrest_config_backup_retention_receipt_invalid');
}
const descriptor = fs.openSync(
  receipt.backupPath,
  fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
);
let opened;
let bytes;
try {
  opened = fs.fstatSync(descriptor, { bigint: true });
  const named = fs.lstatSync(receipt.backupPath, { bigint: true });
  if (!opened.isFile() || named.isSymbolicLink() || !sameIdentity(opened, named)
      || opened.size !== BigInt(receipt.backupBytes)
      || (opened.mode & 0o777n) !== 0o600n || opened.nlink !== 1n
      || (typeof process.getuid === 'function' && opened.uid !== BigInt(process.getuid()))
      || fs.realpathSync(receipt.backupPath) !== receipt.backupPath) {
    throw new Error('forrest_config_backup_retention_readback_failed');
  }
  bytes = readOpened(descriptor, receipt.backupBytes);
  const finalOpened = fs.fstatSync(descriptor, { bigint: true });
  const finalNamed = fs.lstatSync(receipt.backupPath, { bigint: true });
  if (!finalOpened.isFile() || finalNamed.isSymbolicLink()
      || !sameIdentity(finalOpened, opened) || finalOpened.size !== opened.size
      || !sameIdentity(finalNamed, opened) || finalNamed.size !== opened.size
      || (finalNamed.mode & 0o777n) !== 0o600n || finalNamed.nlink !== 1n
      || (typeof process.getuid === 'function' && finalNamed.uid !== BigInt(process.getuid()))
      || fs.realpathSync(receipt.backupPath) !== receipt.backupPath
      || crypto.createHash('sha256').update(bytes).digest('hex')
        !== process.env.FORREST_CONFIG_BACKUP_SHA256) {
    throw new Error('forrest_config_backup_retention_readback_failed');
  }
} finally {
  fs.closeSync(descriptor);
}
(async () => {
  const { receiptContext, writeJsonReceipt } =
    await import('./scripts/lib/brain-acceptance-common.mjs');
  const context = await receiptContext({
    'receipt-run-dir': process.env.RECEIPT_RUN_DIR,
    'receipt-run-id': process.env.RECEIPT_RUN_ID,
    authority: 'live',
  }, process.env);
  await writeJsonReceipt(context, output, {
    helper: 'forrest-config-backup-retention',
    scenario: 'final-readback',
    receiptKind: 'retained-backup-readback',
    protectedResultRead: false,
    backupDisposition: receipt.backupDisposition,
    backupRetained: true,
    automaticDeletion: false,
    retentionPolicy: receipt.retentionPolicy,
    backupPath: receipt.backupPath,
    backupBasename: receipt.backupBasename,
    backupSha256: receipt.backupSha256,
    backupBytes: receipt.backupBytes,
    backupMode: receipt.backupMode,
    backupDev: String(opened.dev),
    backupIno: String(opened.ino),
    retentionReceiptBasename: path.basename(receiptPath),
    retentionReceiptSha256: retentionReceipt.sha256,
    verifiedAt: new Date().toISOString(),
  });
  syncDirectory(canonicalReceiptRoot);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
NODE
test -f "$LIVE_RECEIPT_DIR/forrest-config-backup-retention-readback.json"
test -f "$FORREST_CONFIG_BACKUP"
test "$(shasum -a 256 "$FORREST_CONFIG_BACKUP" | awk 'NR == 1 { print $1 }')" = \
  "$FORREST_CONFIG_BACKUP_SHA256"
node scripts/live-brain-tools-smoke.mjs --scenario verify-receipts \
  --build-artifact-manifest --smoke-root "$RECEIPT_RUN_DIR" \
  --output "$RECEIPT_RUN_DIR/artifact-manifest.json"
ARTIFACT_VERIFY=$(node scripts/live-brain-tools-smoke.mjs --scenario verify-receipts \
  --verify-artifact-manifest \
  --artifact-manifest "$RECEIPT_RUN_DIR/artifact-manifest.json")
node -e 'const row=JSON.parse(process.argv[1]);if(row.ok!==true||row.receiptKind!=="artifact-manifest-verification"||!row.manifestSha256)process.exit(1)' "$ARTIFACT_VERIFY"
ARTIFACT_MANIFEST_DIGEST=$(node -p "JSON.parse(process.argv[1]).manifestSha256" "$ARTIFACT_VERIFY")
export ARTIFACT_MANIFEST_DIGEST
```

Use `apply_patch` to append that exact digest and the successful read-only verification result to the receipt. Do not create another file beneath `$RECEIPT_RUN_DIR` after the manifest is sealed. A subsequent need for operational evidence invalidates the seal and requires a fresh dedicated receipt run, not overwriting the manifest. Then commit the receipt-only addendum, push, and verify once more:

```bash
git diff --cached --quiet
rg -F "$ARTIFACT_MANIFEST_DIGEST" docs/receipts/2026-07-09-brain-tools-hardening.md
git add -- docs/receipts/2026-07-09-brain-tools-hardening.md
git diff --cached --check
git diff --cached -- docs/receipts/2026-07-09-brain-tools-hardening.md
git commit --only docs/receipts/2026-07-09-brain-tools-hardening.md -m "docs: record brain reliability push readback"
git push origin codex/brain-agent-migration
FINAL_RECEIPT_COMMIT=$(git rev-parse HEAD)
git fetch origin codex/brain-agent-migration
test "$FINAL_RECEIPT_COMMIT" = "$(git rev-parse origin/codex/brain-agent-migration)"
git show "origin/codex/brain-agent-migration:docs/superpowers/specs/2026-07-09-brain-operations-reliability-design.md" | rg -F '**Status:** Implemented'
git show "origin/codex/brain-agent-migration:docs/receipts/2026-07-09-brain-tools-hardening.md" | rg -F "$STATUS_PUSH_COMMIT"
test -z "$(git status --porcelain)"
```

- [ ] **Step 16: Advance remote `main` from the clean feature worktree while preserving the dirty live checkout**

This installation is the audited combined-deployment deviation: the primary live checkout intentionally carries the reviewed implementation bytes plus the operator's unrelated `engine/src/circulatory/sweeper.js` work, while its index/local `main` remain at their pre-deployment state. Do **not** merge, checkout, switch, stash, reset, stage, commit, or push from `$LIVE_ROOT`. Remote `main` receives only portable feature history from the clean isolated worktree. Capture the entire live status/index/working diff plus the sweeper digest before and after the remote-only push; any byte or index movement is a hard stop.

```bash
cd "$ISOLATED_ROOT"
test "$(git branch --show-current)" = codex/brain-agent-migration
test -z "$(git status --porcelain)"
test "$FINAL_RECEIPT_COMMIT" = "$(git rev-parse HEAD)"
SWEEPER_PATH=engine/src/circulatory/sweeper.js
test -f "$LIVE_ROOT/$SWEEPER_PATH"
LIVE_HEAD_BEFORE_MAIN_PUSH=$(git -C "$LIVE_ROOT" rev-parse HEAD)
SWEEPER_SHA256_BEFORE_MAIN_PUSH=$(shasum -a 256 "$LIVE_ROOT/$SWEEPER_PATH" | awk 'NR == 1 { print $1 }')
git -C "$LIVE_ROOT" status --porcelain=v1 --untracked-files=all \
  > "$DEPLOY_AUDIT/live-status-before-main-push.txt"
git -C "$LIVE_ROOT" ls-files -s > "$DEPLOY_AUDIT/live-index-before-main-push.txt"
git -C "$LIVE_ROOT" diff --cached --binary > "$DEPLOY_AUDIT/live-cached-before-main-push.patch"
git -C "$LIVE_ROOT" diff --binary > "$DEPLOY_AUDIT/live-working-before-main-push.patch"
git -C "$LIVE_ROOT" ls-files --others --exclude-standard -z | xargs -0 -I{} sh -c \
  'test ! -f "$1" || shasum -a 256 "$1"' _ "$LIVE_ROOT/{}" \
  > "$DEPLOY_AUDIT/live-untracked-before-main-push.sha256"
rg -F "$SWEEPER_PATH" "$DEPLOY_AUDIT/live-status-before-main-push.txt"

git fetch origin main codex/brain-agent-migration
test "$FINAL_RECEIPT_COMMIT" = "$(git rev-parse origin/codex/brain-agent-migration)"
REMOTE_MAIN_BEFORE=$(git rev-parse origin/main)
git merge-base --is-ancestor "$REMOTE_MAIN_BEFORE" "$FINAL_RECEIPT_COMMIT"
git push origin "$FINAL_RECEIPT_COMMIT:refs/heads/main"
REMOTE_MAIN_AFTER=$(git ls-remote --exit-code origin refs/heads/main | awk 'NR == 1 { print $1 }')
test "$REMOTE_MAIN_AFTER" = "$FINAL_RECEIPT_COMMIT"
MAIN_INTEGRATION_COMMIT="$REMOTE_MAIN_AFTER"

test "$(git -C "$LIVE_ROOT" rev-parse HEAD)" = "$LIVE_HEAD_BEFORE_MAIN_PUSH"
test "$(shasum -a 256 "$LIVE_ROOT/$SWEEPER_PATH" | awk 'NR == 1 { print $1 }')" = \
  "$SWEEPER_SHA256_BEFORE_MAIN_PUSH"
git -C "$LIVE_ROOT" status --porcelain=v1 --untracked-files=all \
  > "$DEPLOY_AUDIT/live-status-after-main-push.txt"
git -C "$LIVE_ROOT" ls-files -s > "$DEPLOY_AUDIT/live-index-after-main-push.txt"
git -C "$LIVE_ROOT" diff --cached --binary > "$DEPLOY_AUDIT/live-cached-after-main-push.patch"
git -C "$LIVE_ROOT" diff --binary > "$DEPLOY_AUDIT/live-working-after-main-push.patch"
git -C "$LIVE_ROOT" ls-files --others --exclude-standard -z | xargs -0 -I{} sh -c \
  'test ! -f "$1" || shasum -a 256 "$1"' _ "$LIVE_ROOT/{}" \
  > "$DEPLOY_AUDIT/live-untracked-after-main-push.sha256"
cmp "$DEPLOY_AUDIT/live-status-before-main-push.txt" "$DEPLOY_AUDIT/live-status-after-main-push.txt"
cmp "$DEPLOY_AUDIT/live-index-before-main-push.txt" "$DEPLOY_AUDIT/live-index-after-main-push.txt"
cmp "$DEPLOY_AUDIT/live-cached-before-main-push.patch" "$DEPLOY_AUDIT/live-cached-after-main-push.patch"
cmp "$DEPLOY_AUDIT/live-working-before-main-push.patch" "$DEPLOY_AUDIT/live-working-after-main-push.patch"
cmp "$DEPLOY_AUDIT/live-untracked-before-main-push.sha256" \
  "$DEPLOY_AUDIT/live-untracked-after-main-push.sha256"
export MAIN_INTEGRATION_COMMIT SWEEPER_PATH SWEEPER_SHA256_BEFORE_MAIN_PUSH LIVE_HEAD_BEFORE_MAIN_PUSH
```

Expected: `origin/main` advances by an ordinary non-force fast-forward from the isolated feature worktree, while the live local HEAD/index/status/working diff/untracked hashes and sweeper SHA-256 remain byte-identical. The live checkout is intentionally **not** made clean and its local `main` is intentionally **not** advanced in this rollout.

- [ ] **Step 17: Record the first `main` readback and perform the final documentation closeout**

Remain in the isolated feature worktree. Use `apply_patch` to append `MAIN_INTEGRATION_COMMIT`, its `origin/main` equality proof, the preserved live/sweeper deviation, and the final artifact-manifest digest to the receipt, and update `.superpowers/sdd/progress.md` to the observed completed state. This docs-only addendum creates no new runtime acceptance artifact and therefore does not invalidate the sealed artifact manifest. Commit only those portable authority/status paths, push the feature branch, then advance remote `main` from this same clean feature worktree by explicit non-force SHA refspec. Never merge into the live checkout.

```bash
cd "$ISOLATED_ROOT"
test "$(git branch --show-current)" = codex/brain-agent-migration
rg -F "$MAIN_INTEGRATION_COMMIT" docs/receipts/2026-07-09-brain-tools-hardening.md
rg -F "$ARTIFACT_MANIFEST_DIGEST" docs/receipts/2026-07-09-brain-tools-hardening.md
git add -- docs/receipts/2026-07-09-brain-tools-hardening.md .superpowers/sdd/progress.md
git diff --cached --check
git commit --only docs/receipts/2026-07-09-brain-tools-hardening.md .superpowers/sdd/progress.md -m "docs: close out brain reliability rollout"
CLOSEOUT_COMMIT=$(git rev-parse HEAD)
git push origin codex/brain-agent-migration
git fetch origin codex/brain-agent-migration main
test "$CLOSEOUT_COMMIT" = "$(git rev-parse origin/codex/brain-agent-migration)"
REMOTE_MAIN_BEFORE_CLOSEOUT=$(git rev-parse origin/main)
test "$REMOTE_MAIN_BEFORE_CLOSEOUT" = "$MAIN_INTEGRATION_COMMIT"
git merge-base --is-ancestor "$REMOTE_MAIN_BEFORE_CLOSEOUT" "$CLOSEOUT_COMMIT"
git push origin "$CLOSEOUT_COMMIT:refs/heads/main"
test "$CLOSEOUT_COMMIT" = "$(git ls-remote --exit-code origin refs/heads/main | awk 'NR == 1 { print $1 }')"
git fetch origin main codex/brain-agent-migration
test "$CLOSEOUT_COMMIT" = "$(git rev-parse origin/main)"
test "$CLOSEOUT_COMMIT" = "$(git rev-parse origin/codex/brain-agent-migration)"
git show "origin/main:docs/superpowers/specs/2026-07-09-brain-operations-reliability-design.md" | rg -F '**Status:** Implemented'
git show "origin/main:docs/receipts/2026-07-09-brain-tools-hardening.md" | rg -F "$MAIN_INTEGRATION_COMMIT"
git show "origin/main:docs/receipts/2026-07-09-brain-tools-hardening.md" | rg -F "$ARTIFACT_MANIFEST_DIGEST"
test -z "$(git status --porcelain)"
test "$(git -C "$LIVE_ROOT" rev-parse HEAD)" = "$LIVE_HEAD_BEFORE_MAIN_PUSH"
test "$(shasum -a 256 "$LIVE_ROOT/$SWEEPER_PATH" | awk 'NR == 1 { print $1 }')" = \
  "$SWEEPER_SHA256_BEFORE_MAIN_PUSH"
git -C "$LIVE_ROOT" status --porcelain=v1 --untracked-files=all \
  > "$DEPLOY_AUDIT/live-status-after-closeout-push.txt"
git -C "$LIVE_ROOT" ls-files -s > "$DEPLOY_AUDIT/live-index-after-closeout-push.txt"
git -C "$LIVE_ROOT" diff --cached --binary > "$DEPLOY_AUDIT/live-cached-after-closeout-push.patch"
git -C "$LIVE_ROOT" diff --binary > "$DEPLOY_AUDIT/live-working-after-closeout-push.patch"
git -C "$LIVE_ROOT" ls-files --others --exclude-standard -z | xargs -0 -I{} sh -c \
  'test ! -f "$1" || shasum -a 256 "$1"' _ "$LIVE_ROOT/{}" \
  > "$DEPLOY_AUDIT/live-untracked-after-closeout-push.sha256"
cmp "$DEPLOY_AUDIT/live-status-before-main-push.txt" "$DEPLOY_AUDIT/live-status-after-closeout-push.txt"
cmp "$DEPLOY_AUDIT/live-index-before-main-push.txt" "$DEPLOY_AUDIT/live-index-after-closeout-push.txt"
cmp "$DEPLOY_AUDIT/live-cached-before-main-push.patch" "$DEPLOY_AUDIT/live-cached-after-closeout-push.patch"
cmp "$DEPLOY_AUDIT/live-working-before-main-push.patch" "$DEPLOY_AUDIT/live-working-after-closeout-push.patch"
cmp "$DEPLOY_AUDIT/live-untracked-before-main-push.sha256" \
  "$DEPLOY_AUDIT/live-untracked-after-closeout-push.sha256"
```

Expected: both remote refs equal `CLOSEOUT_COMMIT`, while the live checkout remains intentionally dirty with its original local HEAD/index and byte-identical sweeper plus all other preserved pending state. Never stage, discard, merge over, or otherwise normalize unrelated primary live-checkout state.

---

## Self-Review Checklist

- [ ] Every approved agent-facing tool name remains present and compatible without `target`.
- [ ] Public target schemas are enabled only after prerequisite authority/no-write tests pass.
- [ ] Shared client covers target refresh, request-ID-deduplicated start without a caller `idempotencyKey`, SSE activity, inactivity recovery, reconnect, detach, cancel, result handles/artifact metadata, and HTTP-200 errors.
- [ ] Controlled-clock tests prove connect/header/status-read bounds and the SSE parser flushes one valid unterminated final frame without real timing sleeps.
- [ ] Main chat, chat-turn, Evobrew, cron, subagent, worker, and live-problem entrypoints use the common tracked lifecycle.
- [ ] Cron `kind:'query'` uses one durable `BrainOperationsClient` operation with a 5,400-second default, exact model-alias pair, honest detached/partial/failed authority, and no legacy `/api/query` call or duplicate start.
- [ ] All provider branches use one truthful tool-result helper; no branch hardcodes success for `is_error`.
- [ ] Brain query output never silently slices; shortened display contains a durable result handle.
- [ ] Brain graph/status never use `/api/memory` or client-side full graph materialization.
- [ ] Graph export `GET result` returns only handle/artifact metadata; explicit authorized export copies/streams bytes and verifies SHA-256.
- [ ] Multi-brain search returns one outcome per selected brain and cannot claim absence when any route failed.
- [ ] Read-only research calls do not perform agency assimilation; compile/export output belongs to requester paths.
- [ ] Context retrieval uses `topK`, keeps local triggers during degradation, and never promises an unverified retry will succeed.
- [ ] Compatibility query/export adapters enforce published limits and canonical target agreement before forwarding.
- [ ] New tests are included in `npm test`.
- [ ] Vendored COSMO changes, approved spec status, full verification, live canaries, heap proof, and target hash proof are recorded durably.
- [ ] Immutable `run-authority.json` is the sole run/commit/tree identity; every machine receipt and every operation terminal row matches it, and a redundant commit mismatch fails typed before action.
- [ ] Cross-process compatibility admission is acquired by canonical source before UUID/scratch/projection, and dashboard brain-source, memory-search, and COSMO boundaries preserve retryable `source_busy` as HTTP 503.
- [ ] The portable orphan cleaner requires the exact four-row stopped state with correct gate-versus-emergency provenance; explicit ports equal to the six-port PM2 env union; protected 5013 is disjoint and process-identity-bound; approval includes the mandatory approval-scope digest/token plus trimmed actor, exact text, canonical post-preflight time, and full-manifest integrity; an exclusive private quarantine refuses destination races; every candidate/quarantine mutation has audited intent plus one terminal outcome while receipt publication remains separate evidence; reviewed 248/7 classification and selected/removed byte/statfs evidence reconcile; zero structural scope drift keeps root identities and membership intact; any identity-stable protected content changes reconcile exactly to `concurrentContentDrift`; and final PM2/listener/FD gates pass before full gates run.
- [ ] Portable runtime prompt, dashboard PGS copy, and live Jerry SOUL/LEARNINGS/MEMORY all teach 90-minute ordinary and six-hour PGS/synthesis wait/reattach semantics without current fixed-duration promises.
- [ ] Manifest summary or legacy base-plus-committed-delta stream is authoritative; every legacy snapshot is advisory and legacy zero is recorded only as `absence_unprovable`.
- [ ] Discover/own multi-operation JSONL validates every unique terminal before selecting the last row; the identity manifest includes all terminals and both distinct live/isolated zero operation IDs.
- [ ] BEFORE/AFTER inventories cover brain, run, PGS, session, cache, export, and agency boundaries with discovery/query/PGS start-and-poll between them.
- [ ] Forrest remains paused through both persisted boundary compares and is resumed with exact listener/readiness proof.
- [ ] Live acceptance proves PGS SSE progress, isolated synthesis reconnect, V8 used-heap growth at most 256 MiB, and MCP parity or typed unavailability.
- [ ] PM2 refresh uses state-aware restart deltas plus delayed listener/readiness stability; guarded save freezes/excludes modules and uses unique dry-run/apply backups with a monotonic unrelated baseline.
- [ ] Both engines and dashboards remain exactly stopped/PID-zero through cleanup and prepare, harnesses/COSMO remain online, the two already-quiesced engines and two later emergency dashboard stops are recorded with correct provenance, and only the single scoped combined start follows.
- [ ] Remote `main` is fast-forwarded from the clean feature worktree while the intentionally dirty live HEAD/index/diff and sweeper bytes remain unchanged.
- [ ] Only explicit portable paths are committed and pushed; runtime state and unrelated user changes remain untouched.
