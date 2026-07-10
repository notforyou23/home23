# Brain Provider Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make COSMO query, PGS, and Home23 synthesis operations terminal-honest, cancellable, source-pinned, durable, and read-only when they target another brain.

**Architecture:** Provider clients return one normalized completion envelope and propagate a shared abort signal plus real provider-activity callbacks. Query and PGS execute against the immutable memory pin supplied by the prerequisite memory-source plan; cross-brain work writes only to requester-owned operation scratch. The prerequisite authority/coordinator plan owns operation identity and durable state, while small worker adapters in COSMO and the resident dashboard translate coordinator work into QueryEngine, PGSEngine, and SynthesisAgent calls.

**Tech Stack:** Node.js CommonJS, Node test runner, COSMO's Express 4.22, OpenAI SDK, Anthropic SDK, filesystem-backed operation scratch, existing Home23 durable-write utilities.

## Global Constraints

- Preserve existing agent-facing tool names and current text-oriented results; structured operation metadata is additive.
- The caller's own brain is the default. Explicit sibling-agent and completed-research targets are read-only.
- Do not expose cross-brain targeting until prerequisite catalog, capability, coordinator, source-pin, and no-write tests pass.
- Do not mutate another brain's base, delta, ANN, metadata, PGS sessions, partition cache, query cache, synthesis receipts, exports, or agency state.
- Long query operations pin one immutable source revision. PGS retries and synthesis use that same revision.
- Provider completion requires a valid terminal event, a normal finish reason, nonempty content, and no stream/provider error.
- Heartbeats do not count as provider activity. Provider adapters call `onProviderActivity` only for provider-originated events.
- Explicit cancellation propagates one `AbortSignal` through worker, QueryEngine, PGS, and provider clients.
- Cancelled and failed PGS partitions remain retryable and are never marked searched.
- If PGS sweeps succeed and final synthesis fails, return terminal state `partial` with the successful sweeps; never write a success receipt.
- Own-brain synthesis writes only after a source-revision compare-and-swap. A changed source returns `source_changed` without overwriting newer state.
- Existing direct `/query` and `/query/stream` endpoints remain compatibility adapters.
- Runtime operation and scratch files remain ignored installation state.
- Any change under `cosmo23/` must be recorded in `docs/design/COSMO23-VENDORED-PATCHES.md`.
- Execute this plan only in the clean isolated worktree created by `superpowers:using-git-worktrees`; never execute it in the primary live checkout. Before every task, require a named branch, `GIT_DIR != GIT_COMMON`, an empty global task index, and no unrelated working-tree changes.
- Preserve all pre-existing staged and working-tree changes in the primary checkout. In the isolated worktree, stage and commit only the exact paths named by each task, inspect the cached name list and patch, and require the index/worktree to be empty again after each task commit.
- Tasks 1-6 are strict TDD: change only the named test/fixture files first, run the task's focused command, and record the expected behavioral failure before touching production. Implement only after that red receipt; rerun the identical command to green before committing. Task 7 is verification/documentation closeout and does not invent a synthetic red test.
- Vendored patch numbers are reserved across the ordered plans: Patch 47 authority/catalog/capability worker, Patch 48 unified source truth/streaming memory, Patch 49 this provider/query/PGS/synthesis plan, and Patch 50 agent/tool integration only if that plan has a distinct COSMO change. Do not reuse or renumber these entries independently.

Run this preflight before Task 1 and repeat it before every later task. A failure is a stop condition, not permission to clean, reset, stash, or absorb another checkout's work:

```bash
GIT_DIR=$(cd "$(git rev-parse --git-dir)" && pwd -P)
GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" && pwd -P)
BRANCH=$(git branch --show-current)
test -n "$BRANCH"
test "$GIT_DIR" != "$GIT_COMMON"
git diff --cached --quiet
test -z "$(git status --porcelain)"
```

Expected: every command exits 0. Before each commit, run `git diff --check`, stage only the task's declared paths, run `git diff --cached --name-only` and `git diff --cached -- <task paths>`, then use `git commit --only <task paths>`. Afterward, both `git diff --cached --quiet` and `test -z "$(git status --porcelain)"` must pass.

## Prerequisite Interfaces

This plan starts only after the authority/coordinator and memory-source plans export these exact contracts. If their filenames differ, align the import paths before Task 1; do not create a competing coordinator or source store.

```js
// Supplied by the prerequisite authority/coordinator plan.
// engine/src/dashboard/brain-operations/coordinator.js
class BrainOperationCoordinator {
  constructor({ requesterAgent, store, catalog, worker, sourcePins, clock, timers, limits }) {}
  start({ requestId, operationType, target, parameters }) {}
  status(operationId) {}
  attach(operationId, { attachmentId, signal, onEvent }) {}
  detach(operationId, { attachmentId, reason }) {}
  cancel(operationId) {}
  reconcile() {}
  stop() {}
}

// The coordinator's injected worker adapter must provide this local-executor
// seam in addition to its protected COSMO start/status/events/result/cancel API.
// Add this seam to the authority-plan adapter before beginning Task 6.
class BrainOperationWorkerAdapter {
  registerLocalExecutor(operationType, executor) {}
}

// A factory receives one canonical, requester-derived context.
// Neither requesterAgent nor scratchDir comes from an agent-supplied request body.
/**
 * @typedef {'search'|'graph'|'status'|'query'|'pgs'|'graph_export'|'synthesis'|
 *   'research_compile'|'research_launch'|'research_continue'|'research_stop'|
 *   'research_watch'|'research_intelligence'|'ad_hoc_export'} BrainOperationType
 */
/**
 * @typedef {object} OperationWorkerContext
 * @property {string} operationId
 * @property {BrainOperationType} operationType
 * @property {string} requesterAgent
 * @property {
 *   | {domain:'brain',brainId:string,canonicalRoot:string,accessMode:'own'|'read-only',ownerAgent:string|null,route:string,kind:string,lifecycle:string,catalogRevision:string,mutationBoundaries:Array<{kind:string,path:string}>}
 *   | {domain:'owned-run',runId:string,canonicalRoot:string,accessMode:'own',ownerAgent:string,runState:string}
 *   | {domain:'requester',requesterAgent:string}
 * } target
 * @property {object} parameters
 * @property {string} scratchDir
 * @property {OperationScratchQuota|null} scratchQuota
 * @property {AbortSignal} signal
 * @property {PinnedMemorySource|null} sourcePin
 * @property {(event:object)=>void} reportEvent
 */

/**
 * @typedef {object} OperationWorkerResult
 * @property {'complete'|'partial'|'failed'|'cancelled'} state
 * @property {object|null} result
 * @property {object|null} error
 * @property {object|null} sourceEvidence
 * @property {{scratchPath:string,mediaType:'application/x-ndjson',contentEncoding:'identity',bytes:number,sha256:string}|null} [resultArtifact]
 */

// Supplied by the prerequisite memory-source plan.
/**
 * @typedef {object} OperationScratchQuota
 * @property {(bytes:number,kind:string)=>Promise<void>} claim
 * @property {(bytes:number,kind:string)=>Promise<void>} release
 * @property {()=>Promise<object>} reconcile
 * @property {(root:string)=>Promise<boolean>} assertOperationRoot
 * @property {()=>Promise<void>} close
 */
/**
 * @typedef {object} PinnedMemorySource
 * @property {number} revision
 * @property {object} evidence
 * @property {{version:1,canonicalRoot:string,generation:string,baseRevision:number,cutoffRevision:number,summary:{nodeCount:number,edgeCount:number,clusterCount:number},activeBase:{nodes:{file:string,count:number,bytes:number},edges:{file:string,count:number,bytes:number}},activeDelta:{epoch:string,file:string,fromRevision:number,toRevision:number,count:number,committedBytes:number}}} descriptor
 * @property {(options?:object)=>AsyncIterable<object>} iterateNodes
 * @property {(options?:object)=>AsyncIterable<object>} iterateEdges
 * @property {(options?:{signal?:AbortSignal})=>Promise<object>} summarize
 * @property {(query:string,options?:object)=>Promise<object>} searchKeyword
 * @property {(extra?:object)=>object} getEvidence
 * @property {()=>Promise<boolean>} isCurrent
 * @property {(commit:()=>Promise<any>)=>Promise<{committed:boolean,reason?:string,value?:any}>} compareAndSwap
 * @property {()=>Promise<void>} release
 */
```

The standard executor context and result above are the only shapes used by local synthesis, COSMO Query, COSMO PGS, source exports, and research operations. `sourcePin` is non-null only when the shared authority row has `requiresSourcePin:true`; requester/run-control types such as `research_launch`, `research_continue`, `research_stop`, and `research_watch` receive `sourcePin:null`, must reject a caller-supplied descriptor, and never open or release a source pin. Query, PGS, synthesis, search, graph/status, graph export, research intelligence, and research compile require the verified source pin declared by their shared authority row.

`resultArtifact` is null for normal JSON results. A worker may return either `result` or `resultArtifact`, never both. The only supported artifact envelope is the foundation contract for a trusted `graph_export` worker-generated, uncompressed NDJSON file beneath that exact operation's canonical scratch root: `{scratchPath,mediaType:'application/x-ndjson',contentEncoding:'identity',bytes,sha256}`. The public request cannot supply any artifact field or path. Before terminal transition, the coordinator rejects artifacts from every other operation type, validates nonnegative integer bytes plus lowercase SHA-256, independently lstat/realpath-checks a regular nonsymlink `scratchPath` under the durable operation scratch directory, and calls `store.adoptResultArtifact(operationId,{expectedVersion,scratchPath,mediaType,contentEncoding,bytes,sha256})`. The store repeats the boundary/hash checks. Neither layer materializes the file; the coordinator never persists or publishes `scratchPath`, and public state exposes only the opaque result handle plus `{mediaType,contentEncoding,bytes,sha256}`. Invalid artifacts fail as `worker_result_invalid`. Query, PGS, synthesis, and run-control executors always return `resultArtifact:null`.

The prerequisite coordinator canonicalizes a query request with PGS enabled to durable `operationType: 'pgs'` before authorization/store/worker dispatch and removes that routing hint from canonical parameters. Executors consume `context.operationType`; they never infer query versus PGS from a caller-controlled parameter, and they overwrite any legacy `parameters.enablePGS` value at the QueryEngine call. Capability target binding is the authority-plan tuple, not an executor-specific shortcut: `targetDomain:'brain'` carries only `targetBrainId` plus canonical root; `targetDomain:'owned-run'` carries only `targetRunId` plus canonical root; and `targetDomain:'requester'` carries only `targetRequesterAgent === requesterAgent` with canonical root null. Every unused target ID is exactly null. The generic worker compares the complete tuple against the durable operation row and freshly resolved canonical metadata before opening a source or invoking any executor. The source-evidence field named `targetKind` remains the resident/research catalog classification and must never be reused as the capability-domain field. Source-requiring executors return the canonical numeric source envelope after execution:

The authority plan's durable split is binding here: `requestParameters` contains only normalized caller intent, while trusted executor `parameters` contains server-resolved provider/model pairs and other injected execution values. Provider/model injection and later catalog drift never alter idempotency identity. The coordinator calls the prerequisite store `create()` and starts/pins work only when it returns `{created:true}`; `{created:false}` attaches to the existing record and must not open another source pin or provider call. This plan does not define another operation record, idempotency formula, or caller-controlled execution-parameter path.

```js
const sourceEvidence = sourcePin.getEvidence({
  selectedAgent: context.target.ownerAgent,
  selectedBrain: context.target.brainId,
  route: context.target.route || 'brain-operation-worker',
});
assert.equal(Number.isSafeInteger(sourceEvidence.baseWatermark.revision), true);
assert.equal(Number.isSafeInteger(sourceEvidence.deltaWatermark.revision), true);
assert.equal(
  sourceEvidence.indexWatermark.builtFromRevision === null ||
    Number.isSafeInteger(sourceEvidence.indexWatermark.builtFromRevision),
  true,
);
```

Do not replace this envelope with `{ revision }`, string revisions, or an executor-specific evidence shape. Query, PGS, and synthesis executors do not close an injected pin.

Before Task 3, align the prerequisite source implementation with the declared cancellation contract: `iterateNodes({signal})`, `iterateEdges({signal})`, `summarize({signal})`, and `searchKeyword(query,{signal})` check the signal during real file iteration and rethrow the exact `signal.reason` unchanged. Their catch blocks may classify storage/parse failures as unavailable, but must never convert cancellation into empty/degraded evidence. The portable pin contract deliberately exposes only bounded iterators and scalar helpers; it never exposes a QueryEngine reader, a full graph loader, or a query-state materializer.

The public numeric-v1 descriptor is the only source-location data crossing from the dashboard coordinator to COSMO. `descriptor.version` is the number `1`, never the string `'1'`. The protected worker start request carries `sourcePinDescriptor`; its fresh signed capability carries the durable `sourcePinDigest`; and the durable coordinator record remains authoritative for both. `BrainOperationWorker` is constructed with the prerequisite `sourcePins` provider, canonicalizes and hashes the request descriptor, requires that digest to equal both the capability and durable record, verifies the complete capability target tuple, opens the process-local reader pin only for a shared authority row with `requiresSourcePin:true`, and passes the resulting local pin object to the executor. No operation request carries a caller-controlled digest.

Every process-local pin directory has this one canonical shape, which is intentionally beneath the operation-level directory scanned by the prerequisite source discovery:

```text
instances/<requester>/runtime/brain-operations/<operationId>/pins/<processIdentity>
```

`processIdentity` is a trusted safe segment derived once at worker startup from PID plus the same process-start/boot identity recorded inside pin metadata; it never comes from an HTTP body or capability. Add these helpers beside `BrainOperationWorker` and inject the stable identity into the worker constructor:

```js
const crypto = require('node:crypto');
const path = require('node:path');

function createProcessPinIdentity({ pid = process.pid, processStartIdentity }) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !processStartIdentity) {
    throw Object.assign(new Error('process pin identity unavailable'), {
      code: 'source_unavailable', retryable: true,
    });
  }
  const digest = crypto.createHash('sha256')
    .update(String(pid)).update('\0').update(String(processStartIdentity))
    .digest('hex').slice(0, 20);
  return `cosmo-${pid}-${digest}`;
}

function operationRootFromScratch(derivedScratchDir) {
  if (path.basename(derivedScratchDir) !== 'scratch' ||
      path.basename(path.dirname(derivedScratchDir)) === '') {
    throw Object.assign(new Error('invalid operation scratch directory'), {
      code: 'invalid_request', retryable: false,
    });
  }
  return path.dirname(derivedScratchDir);
}
```

Open conditionally from the already verified shared authority row:

```js
let sourcePin = null;
let scratchQuota = null;
if (verifiedPolicy.requiresSourcePin === true) {
  const summary = request.sourcePinDescriptor?.summary;
  if (request.sourcePinDescriptor?.version !== 1 ||
      ![summary?.nodeCount, summary?.edgeCount, summary?.clusterCount]
        .every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw Object.assign(new Error('source pin descriptor/version/summary is invalid'), {
      code: 'invalid_request',
    });
  }
  const operationRoot = operationRootFromScratch(derivedScratchDir);
  scratchQuota = await createOperationScratchQuota({ operationRoot, signal: controller.signal });
  try {
    sourcePin = await this.sourcePins.openPinnedSource(request.sourcePinDescriptor, {
    expectedCanonicalRoot: verifiedCapability.canonicalRoot,
    expectedRevision: request.sourcePinDescriptor.cutoffRevision,
    expectedDigest: verifiedCapability.sourcePinDigest,
    operationId: verifiedCapability.operationId,
    requesterAgent: verifiedCapability.requesterAgent,
    operationRoot,
    lockRoot: path.join(this.home23Root, 'runtime', 'brain-source-locks'),
    processIdentity: this.processIdentity,
    scratchQuota,
    identity: {
      requesterAgent: verifiedCapability.requesterAgent,
      targetDomain: verifiedCapability.targetDomain,
      targetBrainId: verifiedCapability.targetBrainId,
      targetRunId: verifiedCapability.targetRunId,
      targetRequesterAgent: verifiedCapability.targetRequesterAgent,
    },
      signal: controller.signal,
    });
  } catch (error) {
    await scratchQuota.close();
    throw error;
  }
} else if (request.sourcePinDescriptor !== null && request.sourcePinDescriptor !== undefined) {
  throw Object.assign(new Error('source pin is forbidden for this operation type'), {
    code: 'invalid_request', retryable: false,
  });
}

// Store this same process-local handle on OperationWorkerContext and close the
// handle (not the durable ledger) in the memoized terminal cleanup after the
// source pin and SQLite statements are closed.
```

`openPinnedSource()` itself derives `<operationRoot>/pins/<processIdentity>`; no caller may pass a leaf `pinDirectory`. This is important: the prerequisite `discoverOperationPinFiles(home23Root)` enumerates exactly `instances/*/runtime/brain-operations/*/pins/*/*.json`, so worker pins opened through any parallel layout would be invisible to retirement and stale-pin recovery. Reject a caller-supplied descriptor whose canonical root, numeric revision, generation, file set, or descriptor digest differs from the capability-bound durable operation record. `expectedDigest` is mandatory at every open; absence is `source_changed`, never permission to trust a recomputed descriptor alone. An executor never accepts a raw manifest path directly from the public request body. Extend the prerequisite pin test to call real global discovery after the worker opens a pin and assert it finds exactly the leaf `.../<operationId>/pins/<processIdentity>` directory and its pin file; after terminal release neither remains. Source discovery traverses this one declared process-identity level and no arbitrary recursive descendants.

For a manifestless monolithic legacy research source, `sourcePins.pin(canonicalRoot, operationId)` streams a bounded immutable projection into `instances/<requester>/runtime/brain-operations/<operationId>/source-projections/<generation>`. Its public descriptor remains the exact numeric-version-1 shape above, retains the **target** `canonicalRoot`, and names only generated basenames; it never exposes `projectionRoot`. The trusted coordinator pin record maps that descriptor to the requester-owned physical projection. `sourcePins.openPinnedSource()` resolves that trusted record, verifies the projection realpath is under the requester operation directory, and opens it while retaining target identity/evidence. COSMO never rereads the mutable legacy target snapshot during the operation.

Pin ownership is explicit and tested:

- The dashboard coordinator owns its requester pin and calls `sourcePins.releaseOperationPins(operationId)` exactly once after a durable terminal transition or failed start, never on attachment detach/reconnect.
- `BrainOperationWorker` owns the process-local pin returned by `openPinnedSource()` and calls `sourcePin.release()` exactly once from its terminal/failure/cancellation cleanup, including a synchronous executor throw and worker interruption; it does not release on caller detach.
- A non-source operation receives `sourcePin:null`, opens no process pin directory, and its release closure is a no-op.
- Query, PGS, and synthesis executors do not release an injected pin. A helper that opens a pin itself closes only that locally owned pin in `finally`.

The prerequisite worker implements one idempotent closure per process-local pin and every terminal path awaits that closure; individual executors never duplicate it:

```js
let releasePromise = null;
function releaseProcessPinOnce() {
  if (!releasePromise) {
    releasePromise = sourcePin
      ? Promise.resolve().then(() => sourcePin.release())
      : Promise.resolve();
  }
  return releasePromise;
}
```

Complete, partial, failed, cancelled, synchronous executor throw, and orderly worker-stop/interruption paths all call `releaseProcessPinOnce()`. Attachment detach calls neither this closure nor coordinator pin release. Align the prerequisite worker before Task 5 if it lacks an orderly local stop/interruption cleanup seam; crash recovery still relies on the prerequisite stale-pin pruning plus coordinator reconciliation.

The prerequisite COSMO worker is constructed with an executor registry rather than embedding query execution directly in `server/index.js`:

```js
// cosmo23/server/lib/brain-operation-worker.js
// `processStartIdentity` is the trusted OS process-start/boot identity used by
// shared/memory-source pin metadata; it is resolved once during COSMO startup.
const processIdentity = createProcessPinIdentity({
  pid: process.pid,
  processStartIdentity,
});
const worker = new BrainOperationWorker({
  home23Root,
  capabilityKey,
  nonceStore,
  catalog,
  sourcePins,
  processIdentity,
  executors: new Map([
    ['query', queryOperationExecutor],
    ['pgs', queryOperationExecutor],
  ]),
  clock,
});
```

---

### Task 1: Normalize Provider Completion and Model Capabilities

**Files:**
- Create: `cosmo23/lib/provider-completion.js`
- Modify: `cosmo23/server/config/model-catalog.js:3-330`
- Create: `tests/cosmo23/provider-completion.test.cjs`
- Modify: `tests/cosmo23/query-engine-runtime.test.cjs`

**Interfaces:**
- Consumes: Raw provider result fields: content, terminal event, finish reason, provider error, usage, provider, and model.
- Produces: `normalizeProviderCompletion(input)`, `requireCompleteProviderResult(input)`, `ProviderCompletionError`, `normalizeProviderConfig(providerId, provider)`, `validateSelectableModelCapabilities(catalog)`, and strict `getModelCapabilities(catalog, providerId, modelId)`.

Every selectable chat model in every configured provider must resolve to positive safe-integer `maxOutputTokens` and `providerStallMs`. Built-in provider entries declare `executionDefaults`; model entries may narrow either value. Catalog load upgrades the repository's known legacy built-ins by applying those built-in defaults, then validates every selectable chat model. A custom provider or a custom model with neither a model value nor an explicit provider default is invalid and blocks readiness/save. Embedding-only models are excluded. No runtime call is allowed to invent a timeout or output-token fallback.

- [ ] **Step 1: Write the failing provider-completion contract tests**

Create `tests/cosmo23/provider-completion.test.cjs` with the complete matrix:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ProviderCompletionError,
  normalizeProviderCompletion,
  requireCompleteProviderResult,
} = require('../../cosmo23/lib/provider-completion');

const base = {
  provider: 'openai',
  model: 'gpt-5.4-mini',
  content: 'Grounded answer',
  terminalReceived: true,
  finishReason: 'completed',
  hadError: false,
  usage: { input_tokens: 10, output_tokens: 4 },
};

test('normal terminal response is complete', () => {
  const result = normalizeProviderCompletion(base);
  assert.equal(result.status, 'complete');
  assert.equal(result.error, null);
});

for (const [name, patch, expectedStatus, expectedCode] of [
  ['missing terminal', { terminalReceived: false }, 'partial', 'provider_incomplete'],
  ['responses incomplete', { finishReason: 'response.incomplete' }, 'partial', 'provider_incomplete'],
  ['chat length', { finishReason: 'length' }, 'partial', 'provider_incomplete'],
  ['anthropic max tokens', { finishReason: 'max_tokens' }, 'partial', 'provider_incomplete'],
  ['partial stream error', { hadError: true, error: { message: 'socket reset' } }, 'partial', 'provider_failed'],
  ['empty normal response', { content: '' }, 'failed', 'provider_incomplete'],
  ['error payload', { content: '[Error: provider returned no content]' }, 'failed', 'provider_failed'],
]) {
  test(name, () => {
    const result = normalizeProviderCompletion({ ...base, ...patch });
    assert.equal(result.status, expectedStatus);
    assert.equal(result.error.code, expectedCode);
  });
}

test('requireCompleteProviderResult throws typed error for partial completion', () => {
  assert.throws(
    () => requireCompleteProviderResult({ ...base, finishReason: 'length' }),
    error => error instanceof ProviderCompletionError && error.code === 'provider_incomplete',
  );
});

test('status-labeled envelopes are normalized and revalidated', () => {
  assert.throws(
    () => requireCompleteProviderResult({ ...base, status: 'complete', content: '', terminalReceived: false }),
    error => error instanceof ProviderCompletionError && error.code === 'provider_incomplete',
  );
});
```

Extend `tests/cosmo23/query-engine-runtime.test.cjs`:

```js
const {
  flattenCatalogModels,
  getModelCapabilities,
  validateSelectableModelCapabilities,
} = require('../../cosmo23/server/config/model-catalog');

test('model catalog preserves declared provider execution capabilities', () => {
  const catalog = loadModelCatalogSync();
  const capabilities = getModelCapabilities(catalog, 'minimax', 'MiniMax-M3');
  assert.equal(capabilities.maxOutputTokens, 32768);
  assert.equal(capabilities.providerStallMs, 900000);
});

test('capability lookup uses provider plus model rather than model alone', () => {
  const catalog = { version: 1, providers: {
    openai: { models: [{ id: 'shared-model', maxOutputTokens: 12000,
      providerStallMs: 120000, transport: 'responses' }] },
    minimax: { models: [{ id: 'shared-model', maxOutputTokens: 32768,
      providerStallMs: 900000, transport: 'anthropic-messages' }] },
  } };
  assert.deepEqual(getModelCapabilities(catalog, 'openai', 'shared-model'), {
    maxOutputTokens: 12000, providerStallMs: 120000,
  });
  assert.deepEqual(getModelCapabilities(catalog, 'minimax', 'shared-model'), {
    maxOutputTokens: 32768, providerStallMs: 900000,
  });
});

test('every selectable built-in chat model has valid execution capabilities', () => {
  const catalog = loadModelCatalogSync();
  assert.doesNotThrow(() => validateSelectableModelCapabilities(catalog));
  for (const model of flattenCatalogModels(catalog).filter(entry => entry.kind === 'chat')) {
    const capabilities = getModelCapabilities(catalog, model.provider, model.id);
    assert.equal(Number.isSafeInteger(capabilities.maxOutputTokens), true);
    assert.equal(capabilities.maxOutputTokens > 0, true);
    assert.equal(Number.isSafeInteger(capabilities.providerStallMs), true);
    assert.equal(capabilities.providerStallMs > 0, true);
    assert.equal(new Set(['responses', 'chat-completions', 'anthropic-messages',
      'codex-responses']).has(model.transport), true);
  }
});

test('missing, invalid, and ambiguous model selections are typed failures', () => {
  const catalog = { version: 1, providers: {
    a: { executionDefaults: { maxOutputTokens: 100, providerStallMs: 1000,
      transport: 'chat-completions' },
      models: [{ id: 'shared', kind: 'chat' }] },
    b: { executionDefaults: { maxOutputTokens: 200, providerStallMs: 2000,
      transport: 'chat-completions' },
      models: [{ id: 'shared', kind: 'chat' }, { id: 'bad', kind: 'chat', maxOutputTokens: 0 }] },
  } };
  assert.throws(() => getModelCapabilities(catalog, null, 'shared'), error => error.code === 'model_ambiguous');
  assert.throws(() => getModelCapabilities(catalog, 'a', 'missing'), error => error.code === 'model_not_found');
  assert.throws(() => getModelCapabilities(catalog, 'b', 'bad'), error => error.code === 'model_capability_invalid');
});

test('valid custom providers survive an atomic save and reload', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-'));
  const catalogPath = path.join(root, 'model-catalog.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  process.env.COSMO23_MODEL_CATALOG_PATH = catalogPath;
  t.after(() => delete process.env.COSMO23_MODEL_CATALOG_PATH);
  const saved = saveModelCatalogSync({ version: 1, providers: {
    acme: {
      label: 'Acme',
      executionDefaults: {
        maxOutputTokens: 4096, providerStallMs: 120000,
        transport: 'chat-completions',
      },
      models: [{ id: 'shared-model', kind: 'chat' }],
    },
  } });
  assert.equal(saved.providers.acme.models[0].provider, 'acme');
  assert.deepEqual(loadModelCatalogSync().providers.acme.models[0],
    saved.providers.acme.models[0]);
});

test('present invalid custom catalogs fail closed on save and load', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-invalid-'));
  const catalogPath = path.join(root, 'model-catalog.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  process.env.COSMO23_MODEL_CATALOG_PATH = catalogPath;
  t.after(() => delete process.env.COSMO23_MODEL_CATALOG_PATH);
  const invalid = { version: 1, providers: {
    acme: { models: [{ id: 'missing-capabilities', kind: 'chat' }] },
  } };
  assert.throws(() => saveModelCatalogSync(invalid),
    error => error.code === 'model_capability_invalid');
  assert.equal(fs.existsSync(catalogPath), false);
  fs.writeFileSync(catalogPath, JSON.stringify(invalid));
  assert.throws(() => loadModelCatalogSync(),
    error => error.code === 'model_capability_invalid');
  fs.writeFileSync(catalogPath, '{not json');
  assert.throws(() => loadModelCatalogSync(),
    error => error.code === 'model_catalog_invalid');
});
```

Import `fs`, `os`, `path`, `loadModelCatalogSync`, and `saveModelCatalogSync` for these executable cases. Tests must restore the environment even after an assertion failure. A present corrupt or capability-invalid file is a readiness failure; only an absent file receives built-ins.

- [ ] **Step 2: Run the tests and verify the red state**

Run:

```bash
node --test --test-concurrency=1 \
  tests/cosmo23/provider-completion.test.cjs \
  tests/cosmo23/query-engine-runtime.test.cjs
```

Expected: FAIL with `Cannot find module '../../cosmo23/lib/provider-completion'`; after that module exists but before the catalog change, the capability test must fail because `maxOutputTokens` is undefined.

- [ ] **Step 3: Implement the normalized completion module**

Create `cosmo23/lib/provider-completion.js`:

```js
'use strict';

const NORMAL_FINISH_REASONS = new Set(['completed', 'stop', 'end_turn', 'stop_sequence']);
const ABNORMAL_FINISH_REASONS = new Set([
  'response.incomplete', 'response.failed', 'response.cancelled',
  'length', 'max_tokens', 'cancelled', 'failed',
]);

class ProviderCompletionError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ProviderCompletionError';
    this.code = code;
    this.retryable = options.retryable !== false;
    this.status = options.status || 'failed';
    this.result = options.result || null;
  }
}

function isErrorPayload(content) {
  return /^\s*\[Error:/i.test(String(content || ''));
}

function normalizeProviderCompletion(input = {}) {
  const content = String(input.content || '').trim();
  const finishReason = input.finishReason == null ? null : String(input.finishReason);
  const terminalReceived = input.terminalReceived === true;
  const hadError = input.hadError === true;
  const abnormal = finishReason && ABNORMAL_FINISH_REASONS.has(finishReason);
  const normal = finishReason && NORMAL_FINISH_REASONS.has(finishReason);
  const errorPayload = isErrorPayload(content);

  let status = 'complete';
  let code = null;
  if (hadError || errorPayload) {
    status = content && !errorPayload ? 'partial' : 'failed';
    code = 'provider_failed';
  } else if (!terminalReceived || abnormal || !normal || !content) {
    status = content ? 'partial' : 'failed';
    code = 'provider_incomplete';
  }

  return {
    status,
    content,
    terminalReceived,
    finishReason,
    hadError,
    error: code ? {
      code,
      message: input.error?.message || input.errorType || `Provider ended with ${finishReason || 'no terminal event'}`,
      retryable: input.retryable !== false,
    } : null,
    usage: input.usage || null,
    provider: input.provider || null,
    model: input.model || null,
    responseId: input.responseId || null,
    reasoning: input.reasoning || null,
    output: input.output || null,
    webSearchSources: input.webSearchSources || [],
    citations: input.citations || [],
  };
}

function requireCompleteProviderResult(input) {
  // Never trust a caller-supplied status. Normalize the raw terminal fields on
  // every boundary so `{status:'complete'}` cannot bless missing content or a
  // missing/abnormal terminal event.
  const result = normalizeProviderCompletion(input);
  if (result.status !== 'complete') {
    throw new ProviderCompletionError(
      result.error?.code || 'provider_failed',
      result.error?.message || 'Provider did not complete normally',
      { retryable: result.error?.retryable, status: result.status, result },
    );
  }
  return result;
}

module.exports = {
  ProviderCompletionError,
  normalizeProviderCompletion,
  requireCompleteProviderResult,
};
```

In `cosmo23/server/config/model-catalog.js`, declare built-in provider defaults, merge them into every selectable model during normalization, and reject an invalid catalog before it becomes selectable:

```js
const BUILTIN_EXECUTION_DEFAULTS = Object.freeze({
  openai:        { maxOutputTokens: 32768, providerStallMs: 900000, transport: 'responses' },
  'openai-codex':{ maxOutputTokens: 32768, providerStallMs: 900000, transport: 'codex-responses' },
  anthropic:     { maxOutputTokens:  8192, providerStallMs: 900000, transport: 'anthropic-messages' },
  minimax:       { maxOutputTokens: 32768, providerStallMs: 900000, transport: 'anthropic-messages' },
  xai:           { maxOutputTokens:  8192, providerStallMs: 900000, transport: 'chat-completions' },
  'ollama-cloud':{ maxOutputTokens:  8192, providerStallMs: 900000, transport: 'chat-completions' },
});

const EXECUTION_TRANSPORTS = new Set([
  'responses', 'chat-completions', 'anthropic-messages', 'codex-responses',
]);

// Attach the matching defaults to each of the six built-in provider rows.
// A model entry may narrow/raise a reviewed value explicitly; unknown/custom
// providers get no implicit values and therefore fail validation when absent.

function positiveSafeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function capabilityError(providerId, modelId, field) {
  return Object.assign(new Error(`Invalid ${field} for ${providerId}/${modelId}`), {
    code: 'model_capability_invalid', retryable: false,
  });
}

function normalizeProviderConfig(providerId, provider) {
  const defaults = provider.executionDefaults || {};
  return {
    ...provider,
    models: (provider.models || []).map(entry => {
      if ((entry.kind || 'chat') !== 'chat') return normalizeModelEntry(entry, providerId);
      const maxOutputTokens = positiveSafeInteger(entry.maxOutputTokens ?? defaults.maxOutputTokens);
      const providerStallMs = positiveSafeInteger(entry.providerStallMs ?? defaults.providerStallMs);
      const transport = entry.transport ?? defaults.transport;
      if (!maxOutputTokens) throw capabilityError(providerId, entry.id, 'maxOutputTokens');
      if (!providerStallMs) throw capabilityError(providerId, entry.id, 'providerStallMs');
      if (!EXECUTION_TRANSPORTS.has(transport)) {
        throw capabilityError(providerId, entry.id, 'transport');
      }
      return { ...normalizeModelEntry(entry, providerId), maxOutputTokens, providerStallMs,
        transport };
    }),
  };
}

function validateSelectableModelCapabilities(catalog) {
  for (const model of flattenCatalogModels(catalog).filter(entry => entry.kind === 'chat')) {
    if (!positiveSafeInteger(model.maxOutputTokens)) {
      throw capabilityError(model.provider, model.id, 'maxOutputTokens');
    }
    if (!positiveSafeInteger(model.providerStallMs)) {
      throw capabilityError(model.provider, model.id, 'providerStallMs');
    }
    if (!EXECUTION_TRANSPORTS.has(model.transport)) {
      throw capabilityError(model.provider, model.id, 'transport');
    }
  }
  return catalog;
}

function getModelCapabilities(catalog, providerId, modelId) {
  const models = flattenCatalogModels(catalog || loadModelCatalogSync())
    .filter(entry => entry.id === modelId && entry.kind === 'chat');
  if (!providerId && models.length > 1) {
    throw Object.assign(new Error(`Model ${modelId} is ambiguous`), {
      code: 'model_ambiguous', retryable: false,
    });
  }
  const model = models.find(entry => !providerId || entry.provider === providerId);
  if (!model) {
    throw Object.assign(new Error(`Unknown model ${providerId || '?'}/${modelId}`), {
      code: 'model_not_found', retryable: false,
    });
  }
  if (!positiveSafeInteger(model.maxOutputTokens) ||
      !positiveSafeInteger(model.providerStallMs) ||
      !EXECUTION_TRANSPORTS.has(model.transport)) {
    throw capabilityError(model.provider, model.id, 'execution capabilities');
  }
  return {
    maxOutputTokens: model.maxOutputTokens,
    providerStallMs: model.providerStallMs,
  };
}
```

Normalize provider entries on both built-in load and saved custom-catalog load, call `validateSelectableModelCapabilities()` before returning or saving the catalog, and export all three helpers. Iterate the sorted union of built-in and custom provider IDs rather than only `Object.keys(BUILTIN_MODEL_CATALOG.providers)`. Existing built-in catalogs are upgraded in memory from the reviewed built-in provider defaults; custom entries are retained byte-semantically but never silently given a generic default. A custom provider may inherit only its own explicit `executionDefaults`.

`loadModelCatalogSync()` falls back to normalized built-ins only when the catalog path is absent. If a present file cannot be read/parsed, wrap it as nonretryable `model_catalog_invalid`; if normalization/capability validation fails, preserve the original typed error. `saveModelCatalogSync()` validates the complete normalized catalog before creating a temp file, writes and fsyncs that sibling temp, atomically renames, fsyncs the directory, and leaves the prior catalog byte-identical on validation or pre-rename failure. Add a lost-write crash point and prove reload returns either the complete old file or complete new file, never built-ins substituted for a broken custom file.

- [ ] **Step 4: Run the focused suite and verify green**

Run the Step 2 command again.

Expected: all provider-completion and query-runtime tests PASS.

- [ ] **Step 5: Commit only the Task 1 paths**

```bash
git add -- cosmo23/lib/provider-completion.js \
  cosmo23/server/config/model-catalog.js \
  tests/cosmo23/provider-completion.test.cjs \
  tests/cosmo23/query-engine-runtime.test.cjs
git diff --cached --check
git diff --cached -- \
  cosmo23/lib/provider-completion.js \
  cosmo23/server/config/model-catalog.js \
  tests/cosmo23/provider-completion.test.cjs \
  tests/cosmo23/query-engine-runtime.test.cjs
git commit --only \
  cosmo23/lib/provider-completion.js \
  cosmo23/server/config/model-catalog.js \
  tests/cosmo23/provider-completion.test.cjs \
  tests/cosmo23/query-engine-runtime.test.cjs \
  -m "fix: normalize brain provider completion"
```

### Task 2: Propagate Cancellation and Terminal Events Through Provider Clients

**Files:**
- Create: `cosmo23/lib/codex-responses-client.js`
- Create: `cosmo23/lib/provider-execution.js`
- Create: `cosmo23/lib/brain-provider-client-registry.js`
- Modify: `cosmo23/lib/gpt5-client.js:36-280`
- Modify: `cosmo23/lib/anthropic-client.js:174-300,650-810,980-1005`
- Modify: `cosmo23/engine/src/core/chat-completions-client.js:263-529`
- Modify: `cosmo23/engine/src/core/unified-client.js`
- Create: `tests/cosmo23/gpt5-client-stream.test.cjs`
- Create: `tests/cosmo23/chat-completions-terminal.test.cjs`
- Create: `tests/cosmo23/codex-responses-client.test.cjs`
- Create: `tests/cosmo23/brain-provider-client-registry.test.cjs`
- Modify: `tests/cosmo23/anthropic-client-request.test.cjs`
- Modify: `cosmo23/engine/tests/unit/unified-client-provider-errors.test.js`

**Interfaces:**
- Consumes: `normalizeProviderCompletion()` and catalog-derived maximum output tokens from Task 1.
- Produces: Provider `generate(options)` implementations accepting `signal`, `onProviderActivity`, and a positive catalog-derived `maxOutputTokens`; `CodexResponsesClient.generate(options)`; and one `createBrainProviderClientRegistry(dependencies)` factory used by COSMO Query/PGS, the dashboard operation-model resolver, and resident synthesis.

Each adapter maps `maxOutputTokens` to its native request field (`max_output_tokens` for Responses, `max_tokens` for Chat Completions/Anthropic) and never substitutes a generic numeric fallback. The caller supplies the capability for the selected `(providerId, modelId)` pair; model ID alone is not sufficient.

Provider identity belongs to the client instance. `GPT5Client` accepts a fixed canonical `providerId` (default `openai`) and reports that value; an xAI Responses instance is constructed with `providerId:'xai'` and can never report OpenAI. `ChatCompletionsClient` requires a nonempty canonical `config.providerId` at construction. `AnthropicClient` already retains its fixed provider ID. `CodexResponsesClient` is fixed to `openai-codex`. No adapter infers identity from a model label.

`createBrainProviderClientRegistry({catalog,providerConfig,credentialsProviders,fetchImpl,logger,pairFactories})` creates at most one normalized client per configured `(provider,model)` pair in that process, exposes exact `get(providerId,modelId)`, `has(providerId,modelId)`, `availability(providerId,modelId)`, and `assertPairAvailable(providerId,modelId)`, and never routes by model alone. Built-in pair factories cover OpenAI Responses, xAI Responses/Chat Completions according to explicit catalog/config transport metadata, Anthropic, MiniMax's Anthropic-compatible endpoint, Ollama Cloud/OpenAI-compatible endpoints, and raw OpenAI Codex. Custom providers are available only when a startup-injected exact-pair factory/client is registered; retaining a catalog row does not invent a protocol. The dashboard and COSMO each construct their one process-local registry from the same canonical catalog/config/credential readers. The registry never calls a provider during availability validation.

- [ ] **Step 1: Write failing terminal, abort, and activity tests**

The three new test files must use controlled async iterators. The core test shape is:

```js
test('premature EOF is partial and provider deltas are the only activity', async () => {
  const activity = [];
  client.client = {
    responses: {
      stream: async (_payload, requestOptions) => {
        assert.equal(requestOptions.signal, controller.signal);
        return (async function* () {
          yield { type: 'response.output_text.delta', delta: 'partial' };
        })();
      },
    },
  };

  const result = await client.generate({
    input: 'question',
    maxOutputTokens: 256,
    signal: controller.signal,
    onProviderActivity: event => activity.push(event.type),
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.terminalReceived, false);
  assert.deepEqual(activity, ['response.output_text.delta']);
});
```

Add provider-specific cases:

- GPT: `response.incomplete`, partial text followed by iterator error, and `response.completed`.
- Chat Completions: `finish_reason: length`, iterator EOF without finish reason, and `finish_reason: stop`.
- Anthropic: EOF without `message_stop`, `stop_reason: max_tokens`, and normal `message_stop` with `end_turn`.
- Codex: raw SSE `response.completed`, `response.incomplete`, reader rejection, signal passed to fetch, and normalized `content` delta field.
- Every adapter: missing, zero, fractional, or unsafe `maxOutputTokens` fails with `model_capability_invalid` before credentials/network/provider work.

For `CodexResponsesClient`, make the ordering observable with counters. The raw adapter treats `maxOutputTokens` as the already-resolved capability for the fixed `openai-codex` provider and validates the nonempty model, exact provider identity, positive safe-integer token capability, and pre-aborted signal before calling `credentialsProvider`. Prove each invalid value leaves both `credentialCalls` and `fetchCalls` at zero. Also prove `credentialsProvider` receives `{signal}` and `fetchImpl` receives the same signal.

Add exact-identity Codex races at every awaited boundary: credentials resolution/rejection, fetch resolution/rejection, non-2xx `response.text()`, and `reader.read()`. In each test, abort with the sentinel immediately before that controlled promise resolves or rejects and require `error === reason`. The credential and fetch fakes deliberately return an ordinary error after abort so the test proves cancellation wins classification. A pre-aborted call must not invoke credentials at all.

The Codex terminal matrix must assert the complete normalized envelope, not only content: a nonempty `response.completed` is `complete` and survives `requireCompleteProviderResult()` revalidation; `response.incomplete` is `partial`; EOF without a terminal event is `partial`; `response.completed` with empty content is `failed`; malformed EOF JSON is `partial` or `failed` according to retained content and has `provider_failed`; and a reader failure never fabricates `terminalReceived:true`.

For every provider, use a sentinel `const reason = Object.assign(new Error('operator cancelled'), { code: 'cancelled' })`, abort with that object, and require identity rather than merely an `AbortError` name:

```js
const pending = client.generate({
  /* controlled blocking iterator */, maxOutputTokens: 256, signal: controller.signal,
});
controller.abort(reason);
await assert.rejects(pending, error => error === reason);
```

Anthropic needs separate exact-identity cases at all four boundaries that previously converted or retried aborts: `_streamResponseWithWebSearch`, the outer `generate` catch, the provider/web-search fallback catch, and `generateWithRetry` before and during backoff. Each controlled adapter throws a different ordinary error in its non-abort control case so the tests prove only cancellation bypasses `_buildErrorResponse`, fallback, and retry.

Extend `tests/cosmo23/anthropic-client-request.test.cjs` so `messages.stream` captures its second argument and asserts the supplied signal.

Use this complete controlled iterator in all three test files (copy it locally so each test remains independently runnable):

```js
async function* controlledEvents(events, terminalError = null) {
  for (const event of events) yield event;
  if (terminalError) throw terminalError;
}
```

In `tests/cosmo23/gpt5-client-stream.test.cjs`, use this complete executable matrix:

```js
const terminalCases = [
  {
    name: 'normal completion',
    events: [
      { type: 'response.output_text.delta', delta: 'answer' },
      { type: 'response.completed', response: { id: 'r1', model: 'gpt-5.4-mini' } },
    ],
    expected: { status: 'complete', terminalReceived: true },
  },
  {
    name: 'terminal token limit',
    events: [
      { type: 'response.output_text.delta', delta: 'partial' },
      { type: 'response.incomplete', response: { id: 'r2', model: 'gpt-5.4-mini' } },
    ],
    expected: { status: 'partial', terminalReceived: true, code: 'provider_incomplete' },
  },
  {
    name: 'premature EOF',
    events: [{ type: 'response.output_text.delta', delta: 'partial' }],
    expected: { status: 'partial', terminalReceived: false, code: 'provider_incomplete' },
  },
  {
    name: 'partial text then stream error',
    events: [{ type: 'response.output_text.delta', delta: 'partial' }],
    terminalError: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
    expected: { status: 'partial', terminalReceived: false, code: 'provider_failed' },
  },
];

for (const row of terminalCases) {
  test(`GPT Responses: ${row.name}`, async () => {
    const controller = new AbortController();
    const activity = [];
    const client = new GPT5Client();
    client.client = { responses: { stream: async (_payload, requestOptions) => {
      assert.equal(requestOptions.signal, controller.signal);
      return controlledEvents(row.events, row.terminalError);
    } } };
    const result = await client.generate({
      input: 'question', maxOutputTokens: 256, signal: controller.signal,
      onProviderActivity: event => activity.push(event.type),
    });
    assert.equal(result.status, row.expected.status);
    assert.equal(result.terminalReceived, row.expected.terminalReceived);
    if (row.expected.code) assert.equal(result.error.code, row.expected.code);
    assert.deepEqual(activity, row.events.map(event => event.type));
  });
}
```

In `tests/cosmo23/chat-completions-terminal.test.cjs`, use the same loop with these exact rows and client setup:

```js
const chatCases = [
  { name: 'normal completion', chunks: [
    { id: 'c1', model: 'local', choices: [{ delta: { content: 'answer' }, finish_reason: null }] },
    { id: 'c1', model: 'local', choices: [{ delta: {}, finish_reason: 'stop' }] },
  ], expected: { status: 'complete', terminalReceived: true } },
  { name: 'terminal token limit', chunks: [
    { choices: [{ delta: { content: 'partial' }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'length' }] },
  ], expected: { status: 'partial', terminalReceived: true, code: 'provider_incomplete' } },
  { name: 'premature EOF', chunks: [
    { choices: [{ delta: { content: 'partial' }, finish_reason: null }] },
  ], expected: { status: 'partial', terminalReceived: false, code: 'provider_incomplete' } },
  { name: 'partial text then stream error', chunks: [
    { choices: [{ delta: { content: 'partial' }, finish_reason: null }] },
  ], terminalError: new Error('socket reset'),
     expected: { status: 'partial', terminalReceived: false, code: 'provider_failed' } },
];

for (const row of chatCases) {
  test(`Chat Completions: ${row.name}`, async () => {
    const controller = new AbortController();
    const client = new ChatCompletionsClient({
      providerId: 'test-openai-compatible', supportsStreaming: true,
    });
    client.client = { chat: { completions: { create: async (_payload, requestOptions) => {
      assert.equal(requestOptions.signal, controller.signal);
      return controlledEvents(row.chunks, row.terminalError);
    } } } };
    const result = await client.generate({
      input: 'question', maxOutputTokens: 256, signal: controller.signal,
    });
    assert.equal(result.status, row.expected.status);
    assert.equal(result.terminalReceived, row.expected.terminalReceived);
    if (row.expected.code) assert.equal(result.error.code, row.expected.code);
  });
}
```

Create `tests/cosmo23/brain-provider-client-registry.test.cjs` with controlled pair factories. Assert two catalog rows sharing `model:'shared-model'` return distinct exact-provider clients; OpenAI and xAI Responses completions report their fixed instance provider; MiniMax never becomes Anthropic; unavailable credentials leave the exact pair absent with typed `provider_unavailable`; and an unregistered custom-provider protocol stays unavailable. Construct the real registry's Codex entry with a fake credentials provider/fetch implementation and prove `registry.get('openai-codex','gpt-5.5')` is a `CodexResponsesClient`, observes the same signal, and returns `provider:'openai-codex'`. Enumerate every production `new ChatCompletionsClient(...)` call in the Task 2-owned `cosmo23/engine/src/core/unified-client.js`; the test fails if any resulting instance lacks the expected fixed provider ID. Task 3's QueryEngine source-pin test owns the later assertion that `cosmo23/lib/query-engine.js` contains no production provider constructor or inline Codex transport, so Task 2 can turn green without editing an undeclared path.

In `tests/cosmo23/anthropic-client-request.test.cjs`, test `_streamResponseWithWebSearch` with the complete rows below and separately keep the `messages.stream` request-options signal assertion around `generate()`:

```js
const anthropicCases = [
  { name: 'normal completion', events: [
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ], expected: { status: 'complete', terminalReceived: true } },
  { name: 'terminal token limit', events: [
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ], expected: { status: 'partial', terminalReceived: true, code: 'provider_incomplete' } },
  { name: 'premature EOF', events: [
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
  ], expected: { status: 'partial', terminalReceived: false, code: 'provider_incomplete' } },
  { name: 'partial text then stream error', events: [
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
  ], terminalError: new Error('socket reset'),
     expected: { status: 'partial', terminalReceived: false, code: 'provider_failed' } },
];

for (const row of anthropicCases) {
  test(`Anthropic: ${row.name}`, async () => {
    const client = Object.create(AnthropicClient.prototype);
    client.logger = null;
    client.providerId = 'anthropic';
    client._getModelFromOptions = () => 'claude-sonnet-4-6';
    const result = await client._streamResponseWithWebSearch(
      controlledEvents(row.events, row.terminalError),
      { model: 'claude-sonnet-4-6', onProviderActivity() {} },
    );
    assert.equal(result.status, row.expected.status);
    assert.equal(result.terminalReceived, row.expected.terminalReceived);
    if (row.expected.code) assert.equal(result.error.code, row.expected.code);
  });
}
```

In `tests/cosmo23/codex-responses-client.test.cjs`, make one response body end with the terminal frame **without** a final blank-line delimiter:

```js
function makeRawCodexClient(body, expectedSignal, counters = {}) {
  return new CodexResponsesClient({
    fetchImpl: async (_url, init) => {
      counters.fetchCalls = (counters.fetchCalls || 0) + 1;
      assert.equal(init.signal, expectedSignal);
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
    credentialsProvider: async options => {
      counters.credentialCalls = (counters.credentialCalls || 0) + 1;
      assert.equal(options.signal, expectedSignal);
      return { accessToken: 'test', accountId: 'acct' };
    },
  });
}

test('validates Codex capability and a pre-aborted signal before credentials', async () => {
  for (const maxOutputTokens of [undefined, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const counters = {};
    const controller = new AbortController();
    const client = makeRawCodexClient(new ReadableStream(), controller.signal, counters);
    await assert.rejects(
      client.generate({
        provider: 'openai-codex', model: 'gpt-5.4-mini', input: [],
        maxOutputTokens, signal: controller.signal,
      }),
      error => error.code === 'model_capability_invalid',
    );
    assert.equal(counters.credentialCalls || 0, 0);
    assert.equal(counters.fetchCalls || 0, 0);
  }

  const reason = Object.assign(new Error('operator cancelled'), { code: 'cancelled' });
  const counters = {};
  const controller = new AbortController();
  controller.abort(reason);
  await assert.rejects(
    makeRawCodexClient(new ReadableStream(), controller.signal, counters).generate({
      provider: 'openai-codex', model: 'gpt-5.4-mini', input: [],
      maxOutputTokens: 256, signal: controller.signal,
    }),
    error => error === reason,
  );
  assert.equal(counters.credentialCalls || 0, 0);
  assert.equal(counters.fetchCalls || 0, 0);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

for (const boundary of ['credentials', 'fetch', 'error-body', 'reader']) {
  test(`Codex rethrows the exact reason when abort races ${boundary} await`, async () => {
    const controller = new AbortController();
    const reason = Object.assign(new Error('operator cancelled'), { code: 'cancelled' });
    const gate = deferred();
    const started = deferred();
    const credentialsProvider = async options => {
      assert.equal(options.signal, controller.signal);
      if (boundary === 'credentials') {
        started.resolve();
        return gate.promise;
      }
      return { accessToken: 'test', accountId: 'acct' };
    };
    const fetchImpl = async (_url, init) => {
      assert.equal(init.signal, controller.signal);
      if (boundary === 'fetch') {
        started.resolve();
        return gate.promise;
      }
      if (boundary === 'error-body') {
        return {
          ok: false, status: 503,
          text() { started.resolve(); return gate.promise; },
        };
      }
      return {
        ok: true,
        body: { getReader() { return {
          read() {
            if (boundary === 'reader') {
              started.resolve();
              return gate.promise;
            }
            return Promise.resolve({ done: true });
          },
          releaseLock() {},
        }; } },
      };
    };
    const pending = new CodexResponsesClient({
      credentialsProvider, fetchImpl,
    }).generate({
      provider: 'openai-codex', model: 'gpt-5.4-mini', input: [],
      maxOutputTokens: 256, signal: controller.signal,
    });
    await started.promise;
    controller.abort(reason);
    gate.reject(new Error(`ordinary ${boundary} failure after abort`));
    await assert.rejects(pending, error => error === reason);
  });
}

test('flushes a terminal SSE frame left in the EOF buffer', async () => {
  const signalController = new AbortController();
  const bytes = new TextEncoder().encode(
    'data: {"type":"response.output_text.delta","delta":"answer"}\n\n' +
    'data: {"type":"response.completed","response":{"id":"codex-1"}}',
  );
  const body = new ReadableStream({
    start(controller) { controller.enqueue(bytes); controller.close(); },
  });
  const client = makeRawCodexClient(body, signalController.signal);
  const result = await client.generate({
    provider: 'openai-codex', model: 'gpt-5.4-mini', input: [], maxOutputTokens: 256,
    signal: signalController.signal,
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.content, 'answer');
  assert.equal(result.terminalReceived, true);
});

test('accepts CRLF SSE delimiters split across byte chunks', async () => {
  const signalController = new AbortController();
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"type":"response.output_text.delta","delta":"answer"}\r',
    '\n\r\ndata: {"type":"response.completed","response":{"id":"codex-2"}}\r',
    '\n\r\n',
  ].map(value => encoder.encode(value));
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const result = await makeRawCodexClient(body, signalController.signal).generate({
    provider: 'openai-codex', model: 'gpt-5.4-mini', input: [], maxOutputTokens: 256,
    signal: signalController.signal,
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.content, 'answer');
  assert.equal(result.terminalReceived, true);
});

test('invalid JSON in the EOF frame is a terminal-honest partial failure', async () => {
  const signalController = new AbortController();
  const bytes = new TextEncoder().encode(
    'data: {"type":"response.output_text.delta","delta":"kept"}\n\n' +
    'data: {"type":"response.completed"',
  );
  const body = new ReadableStream({
    start(controller) { controller.enqueue(bytes); controller.close(); },
  });
  const result = await makeRawCodexClient(body, signalController.signal).generate({
    provider: 'openai-codex', model: 'gpt-5.4-mini', input: [], maxOutputTokens: 256,
    signal: signalController.signal,
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.content, 'kept');
  assert.equal(result.terminalReceived, false);
  assert.equal(result.error.code, 'provider_failed');
});

test('a completed event without content fails the terminal contract', async () => {
  const signalController = new AbortController();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        'data: {"type":"response.completed","response":{"id":"codex-empty"}}\n\n',
      ));
      controller.close();
    },
  });
  const result = await makeRawCodexClient(body, signalController.signal).generate({
    provider: 'openai-codex', model: 'gpt-5.4-mini', input: [],
    maxOutputTokens: 256, signal: signalController.signal,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.terminalReceived, true);
  assert.equal(result.error.code, 'provider_incomplete');
});
```

These cases jointly prove LF, split CRLF, EOF flush, and malformed-tail terminal honesty without network access.

- [ ] **Step 2: Run the new tests and verify the red state**

Run:

```bash
node --test --test-concurrency=1 \
  tests/cosmo23/gpt5-client-stream.test.cjs \
  tests/cosmo23/chat-completions-terminal.test.cjs \
  tests/cosmo23/codex-responses-client.test.cjs \
  tests/cosmo23/brain-provider-client-registry.test.cjs \
  tests/cosmo23/anthropic-client-request.test.cjs
npm --prefix cosmo23/engine run test:unit
```

Expected: FAIL because `codex-responses-client.js` and `brain-provider-client-registry.js` do not exist, current clients omit request signals/fixed pair identity, and current EOF paths report `hadError: false` or lack `terminalReceived`.

- [ ] **Step 3: Implement abort-aware provider calls and normalization**

Create `cosmo23/lib/provider-execution.js` exactly as follows and import it from all three provider clients:

```js
'use strict';

function abortReason(signal) {
  if (signal?.aborted) return signal.reason;
  return Object.assign(new Error('Aborted'), {
    name: 'AbortError', code: 'cancelled',
  });
}

function abortableDelay(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(abortReason(signal));
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function reportProviderActivity(callback, event) {
  callback?.({ type: event?.type || 'provider_event', at: new Date().toISOString() });
}

function requireMaxOutputTokens(value, provider, model) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw Object.assign(new Error(`Missing output capability for ${provider}/${model}`), {
      code: 'model_capability_invalid', retryable: false,
    });
  }
  return value;
}

module.exports = {
  abortReason, abortableDelay, reportProviderActivity, requireMaxOutputTokens,
};
```

Every adapter checks `signal.aborted` immediately before and after credentials lookup, SDK stream creation, fetch, non-stream response creation, fallback selection, and retry classification. Wrap creation awaits as well as iterator reads: if the signal is aborted, throw `signal.reason` exactly; if a provider throws an `AbortError` while the signal is not aborted, rethrow that provider error unchanged. This prevents cancellation during connection setup from bypassing the inner stream catch.

In `cosmo23/lib/gpt5-client.js`, preserve the existing `new GPT5Client(logger)` call shape and add an optional second constructor argument `{providerId='openai',clientOptions=null}`. Validate `providerId` as a nonempty safe provider ID, assign it once, and never mutate it during a call. Extend the `generate()` destructure with `signal = null`, `onProviderActivity = null`, and `maxOutputTokens = null`, pass `signal` as SDK request options, and replace the current stream-processing/result-return block with this executable block:

```js
const { normalizeProviderCompletion } = require('./provider-completion');
const {
  abortReason, abortableDelay, reportProviderActivity, requireMaxOutputTokens,
} = require('./provider-execution');
```

```js
const requestPayload = {
  ...payload,
  max_output_tokens: requireMaxOutputTokens(maxOutputTokens, this.providerId, model),
};
const stream = await this.client.responses.stream(requestPayload, signal ? { signal } : undefined);
let aggregatedText = '';
let reasoningSummary = '';
let finalResponse = null;
let terminalReceived = false;
let finishReason = null;
let hadError = false;
let streamError = null;
let webSearchSources = [];
let citations = [];

try {
  for await (const event of stream) {
    reportProviderActivity(onProviderActivity, event);
    if (event.type === 'response.output_text.delta') {
      aggregatedText += event.delta || '';
      if (event.delta) onChunk?.({ type: 'chunk', text: event.delta });
    } else if (event.type === 'response.output_text.done' && event.text) {
      aggregatedText = event.text;
    } else if (event.type === 'response.reasoning_summary_text.delta') {
      reasoningSummary += event.delta || '';
    } else if (event.type === 'response.completed') {
      terminalReceived = true;
      finishReason = 'completed';
      finalResponse = event.response || finalResponse;
      if (!aggregatedText) aggregatedText = this.extractTextFromResponse(finalResponse);
      const extracted = this.extractWebSearchData(finalResponse);
      webSearchSources = extracted.sources;
      citations = extracted.citations;
    } else if (['response.incomplete', 'response.failed', 'response.cancelled'].includes(event.type)) {
      terminalReceived = true;
      finishReason = event.type;
      hadError = event.type !== 'response.incomplete';
      finalResponse = event.response || finalResponse;
      streamError = event.error || event.response?.error || null;
    } else if (event.type === 'response.created') {
      finalResponse = event.response || finalResponse;
    }
  }
} catch (error) {
  if (signal?.aborted) throw abortReason(signal);
  if (error?.name === 'AbortError') throw error;
  hadError = true;
  streamError = error;
}

return normalizeProviderCompletion({
  content: aggregatedText,
  reasoning: reasoningSummary,
  terminalReceived,
  finishReason,
  hadError,
  error: streamError,
  responseId: finalResponse?.id,
  usage: finalResponse?.usage,
  output: finalResponse?.output,
  webSearchSources,
  citations,
  provider: this.providerId,
  model: finalResponse?.model || model,
});
```

Delete the old reasoning-as-content and `[Error: ...]` success-looking fallbacks. In both retry branches replace the timer promise with `await abortableDelay(backoff, options.signal)`, and make retry success `result.status === 'complete'`; a partial result may be returned only after retries are exhausted and retains its typed envelope.

In `cosmo23/engine/src/core/chat-completions-client.js`, add these imports, pass the whole options object into both helpers, and replace the call sites/signatures exactly:

```js
const { normalizeProviderCompletion } = require('../../../lib/provider-completion');
const {
  abortReason, abortableDelay, reportProviderActivity, requireMaxOutputTokens,
} = require('../../../lib/provider-execution');
```

```js
return this.supportsStreaming
  ? this.generateStreaming(payload, model, options)
  : this.generateNonStreaming(payload, model, options);

async generateStreaming(payload, originalModel, options = {}) {
  const { signal = null, onChunk = null, onProviderActivity = null,
    maxOutputTokens = null } = options;
  const requestPayload = {
    ...payload,
    max_tokens: requireMaxOutputTokens(
      maxOutputTokens, this.config.providerId, originalModel,
    ),
  };
  const stream = await this.client.chat.completions.create(
    requestPayload,
    signal ? { signal } : undefined,
  );
  let content = '';
  let reasoning = '';
  let terminalReceived = false;
  let finishReason = null;
  let hadError = false;
  let streamError = null;
  const toolCalls = [];
  let responseId = null;
  let responseModel = requestPayload.model;
  let usage = null;
  try {
    for await (const chunk of stream) {
      reportProviderActivity(onProviderActivity, { type: 'chat.completion.chunk' });
      responseId = chunk.id || responseId;
      responseModel = chunk.model || responseModel;
      usage = chunk.usage || usage;
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) {
        content += choice.delta.content;
        onChunk?.({ type: 'chunk', text: choice.delta.content });
      }
      if (choice?.delta?.reasoning) reasoning += choice.delta.reasoning;
      mergeToolCallDeltas(toolCalls, choice?.delta?.tool_calls || []);
      if (choice?.finish_reason) {
        terminalReceived = true;
        finishReason = choice.finish_reason;
      }
    }
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    if (error?.name === 'AbortError') throw error;
    hadError = true;
    streamError = error;
  }
  if (!content && reasoning) content = reasoning;
  return normalizeProviderCompletion({
    content, terminalReceived, finishReason, hadError, error: streamError,
    responseId, model: responseModel, provider: this.config.providerId,
    usage: usage ? { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens } : null,
    output: toolCalls.length ? toolCalls.map(tc => ({
      type: 'function_call', id: tc.id, name: tc.name, arguments: tc.arguments,
    })) : null,
  });
}

async generateNonStreaming(payload, originalModel, options = {}) {
  const maxOutputTokens = options.maxOutputTokens;
  const response = await this.client.chat.completions.create(
    { ...payload, stream: false,
      max_tokens: requireMaxOutputTokens(
        maxOutputTokens, this.config.providerId, originalModel,
      ) },
    options.signal ? { signal: options.signal } : undefined,
  );
  reportProviderActivity(options.onProviderActivity, { type: 'chat.completion' });
  const choice = response.choices?.[0];
  return normalizeProviderCompletion({
    content: choice?.message?.content || choice?.message?.reasoning || '',
    terminalReceived: Boolean(choice?.finish_reason),
    finishReason: choice?.finish_reason || null,
    hadError: false,
    responseId: response.id,
    model: response.model || originalModel,
    provider: this.config.providerId,
    usage: response.usage,
    output: choice?.message?.tool_calls || null,
  });
}
```

Require a nonempty canonical `config.providerId` when constructing `ChatCompletionsClient`; do not infer provider identity from the model string or substitute a generic compatibility label.

Update every production constructor in `cosmo23/engine/src/core/unified-client.js`: local/OpenAI-compatible uses `providerId:'local'`, Ollama Cloud uses `providerId:'ollama-cloud'`, and any other compatibility client uses its exact configured provider key. Update its focused provider-error tests so construction itself proves the IDs. Task 3 updates QueryEngine's remaining constructors and removes its inline Codex fetch path in favor of the shared registry; no unchecked constructor may be deferred to broad verification.

Add this module-local helper immediately above the class; the replacement block above calls it directly:

```js
function mergeToolCallDeltas(toolCalls, deltas) {
  for (const delta of deltas) {
    const index = Number.isInteger(delta.index) ? delta.index : 0;
    if (!toolCalls[index]) {
      toolCalls[index] = {
        id: delta.id || `call_${index}`,
        name: delta.function?.name || '',
        arguments: '',
      };
    }
    if (delta.id) toolCalls[index].id = delta.id;
    if (delta.function?.name) toolCalls[index].name = delta.function.name;
    if (delta.function?.arguments) toolCalls[index].arguments += delta.function.arguments;
  }
}
```

Replace both retry timers with `abortableDelay(backoff, options.signal)` and require `result.status === 'complete'` before declaring retry success.

In `cosmo23/lib/anthropic-client.js`, add these imports, pass request options at the SDK boundary, and record terminal state in the existing streaming method:

```js
const { normalizeProviderCompletion } = require('./provider-completion');
const {
  abortReason, abortableDelay, reportProviderActivity, requireMaxOutputTokens,
} = require('./provider-execution');
```

```js
const maxOutputTokens = options.maxOutputTokens;
const requestWithCapabilities = {
  ...requestParams,
  max_tokens: requireMaxOutputTokens(
    maxOutputTokens, this.providerId || 'anthropic', options.model,
  ),
};
const stream = await this.anthropic.messages.stream(
  requestWithCapabilities,
  options.signal ? { signal: options.signal } : undefined,
);
return this._streamResponse(stream, options);
```

At the top of `_streamResponseWithWebSearch`, add:

```js
let terminalReceived = false;
let finishReason = null;
let hadError = false;
let streamError = null;
```

Inside its event loop, call `reportProviderActivity(options.onProviderActivity, event)` before the type switch. In `message_delta`, set `finishReason = event.delta?.stop_reason || finishReason`; in `message_stop`, set `terminalReceived = true`. Use this exact catch so cancellation propagates while other reader errors preserve partial content:

```js
} catch (error) {
  if (options.signal?.aborted) throw abortReason(options.signal);
  if (error?.name === 'AbortError') throw error;
  hadError = true;
  streamError = error;
}
```

Replace the final response object with:

```js
return normalizeProviderCompletion({
  content: textContent,
  reasoning: thinkingContent || null,
  terminalReceived,
  finishReason,
  hadError,
  error: streamError,
  responseId,
  model: model || this._getModelFromOptions(options),
  provider: this.providerId || 'anthropic',
  usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  output: toolCalls.length ? toolCalls : null,
  webSearchSources,
  citations,
});
```

Replace both retry timers with `abortableDelay(backoff, options.signal)` and require `result.status === 'complete'` for success. Keep `_buildErrorResponse` only for non-stream compatibility callers, but make it return `normalizeProviderCompletion({ content: '', terminalReceived: false, hadError: true, error, provider: this.providerId || 'anthropic' })`.

Do not stop at the inner stream catch. At the top of every Anthropic outer, fallback, and retry catch, run this guard before logging, fallback selection, `_buildErrorResponse`, or delay:

```js
function rethrowCancellation(error, signal) {
  if (signal?.aborted) throw abortReason(signal);
  if (error?.name === 'AbortError') throw error;
}

// generate(), generateWithRetry(), web-search fallback, and every alternate
// streaming/non-streaming catch:
catch (error) {
  rethrowCancellation(error, options.signal);
  // Existing non-cancellation classification/fallback follows.
}
```

`generateWithRetry()` also calls `rethrowCancellation(null, options.signal)` before each attempt, immediately after each returned result, before deciding whether a partial result is retryable, and immediately after `abortableDelay()`. Pass the original `options.signal` through every web-search, fallback, streaming, and non-streaming helper. These checks make an abort that races a provider response or retry decision retain the exact caller-owned reason.

In `AnthropicClient._getMaxTokensForModel`, remove model-name fallbacks entirely; the selected catalog row is authoritative:

```js
_getMaxTokensForModel(model) {
  const declared = Number(this.config?.maxOutputTokens);
  return requireMaxOutputTokens(
    declared, this.providerId || 'anthropic', model,
  );
}
```

Create `cosmo23/lib/codex-responses-client.js` as the single raw SSE parser:

```js
'use strict';

const {
  normalizeProviderCompletion,
  requireCompleteProviderResult,
} = require('./provider-completion');
const { requireMaxOutputTokens } = require('./provider-execution');

function typed(code, message, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason;
}

async function awaitWithCancellation(start, signal) {
  throwIfAborted(signal);
  let removeAbort = () => {};
  try {
    const operation = Promise.resolve().then(start);
    const result = signal
      ? await Promise.race([
          operation,
          new Promise((_, reject) => {
            const abort = () => reject(signal.reason);
            if (signal.aborted) {
              abort();
            } else {
              signal.addEventListener('abort', abort, { once: true });
              removeAbort = () => signal.removeEventListener('abort', abort);
            }
          }),
        ])
      : await operation;
    throwIfAborted(signal);
    return result;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw error;
  } finally {
    removeAbort();
  }
}

class CodexResponsesClient {
  constructor({ fetchImpl = fetch, credentialsProvider }) {
    this.fetchImpl = fetchImpl;
    this.credentialsProvider = credentialsProvider;
    this.providerId = 'openai-codex';
  }

  async generate({ provider, model, instructions, input, maxOutputTokens,
    signal, onChunk, onProviderActivity }) {
    if (provider !== this.providerId || provider !== 'openai-codex') {
      throw typed('provider_model_mismatch', 'Codex requires provider openai-codex');
    }
    if (typeof model !== 'string' || model.trim() === '') {
      throw typed('model_not_found', 'Codex model is required');
    }
    const outputTokens = requireMaxOutputTokens(
      maxOutputTokens, this.providerId, model,
    );
    throwIfAborted(signal);

    const credentials = await awaitWithCancellation(
      () => this.credentialsProvider({ signal }), signal,
    );
    if (!credentials?.accessToken) {
      throw typed('provider_unavailable', 'Codex credentials are unavailable', true);
    }
    const response = await awaitWithCancellation(() => this.fetchImpl(
      'https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        'content-type': 'application/json',
        'chatgpt-account-id': credentials.accountId || '',
        'openai-beta': 'responses=experimental',
        originator: 'cosmo',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model, store: false, stream: true, instructions, input,
        max_output_tokens: outputTokens,
      }),
      signal,
    }), signal);
    if (!response.ok) {
      const body = await awaitWithCancellation(() => response.text(), signal);
      throw typed('provider_failed', `Codex ${response.status}: ${body.slice(0, 200)}`, true);
    }
    if (!response.body?.getReader) {
      throw typed('provider_failed', 'Codex response body is not a readable stream', true);
    }

    let content = '';
    let terminalReceived = false;
    let finishReason = null;
    let hadError = false;
    let error = null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const processFrame = frame => {
      throwIfAborted(signal);
      for (const line of frame.split(/\r?\n/).filter(value => value.startsWith('data:'))) {
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        const event = JSON.parse(raw);
        onProviderActivity?.({ type: event.type, at: new Date().toISOString() });
        if (event.type === 'response.output_text.delta') {
          const delta = event.delta || event.content || '';
          content += delta;
          if (delta) onChunk?.({ type: 'chunk', text: delta });
        } else if (event.type === 'response.completed') {
          terminalReceived = true;
          finishReason = 'completed';
        } else if (['response.incomplete', 'response.failed', 'response.cancelled'].includes(event.type)) {
          terminalReceived = true;
          finishReason = event.type;
          hadError = event.type !== 'response.incomplete';
          error = event.error || event.response?.error || null;
        }
      }
      throwIfAborted(signal);
    };

    const drainDelimitedFrames = () => {
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || '';
      for (const frame of frames) processFrame(frame);
    };

    try {
      while (true) {
        const next = await awaitWithCancellation(() => reader.read(), signal);
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        drainDelimitedFrames();
      }
      buffer += decoder.decode();
      drainDelimitedFrames();
      if (buffer.trim()) processFrame(buffer);
      buffer = '';
    } catch (streamError) {
      if (signal?.aborted) throw signal.reason;
      if (streamError?.name === 'AbortError') throw streamError;
      hadError = true;
      error = streamError;
    } finally {
      try {
        reader.releaseLock();
      } catch (releaseError) {
        if (signal?.aborted) throw signal.reason;
        throw releaseError;
      }
    }

    throwIfAborted(signal);
    const normalized = normalizeProviderCompletion({
      content, terminalReceived, finishReason, hadError, error,
      provider: this.providerId, model,
    });
    return normalized.status === 'complete'
      ? requireCompleteProviderResult(normalized)
      : normalized;
  }
}

module.exports = { CodexResponsesClient };
```

The EOF flush is required: a valid terminal event in the final unterminated frame must be observed, while malformed leftover JSON must be caught and normalized as `provider_failed`. Reader/parse errors retain prior text in an honest partial result. `awaitWithCancellation()` is mandatory for every await in this raw client (credentials, fetch, non-2xx body, and reader); it checks before starting, races the shared signal, checks after resolution, converts a rejection that raced an abort to the exact `signal.reason`, and removes its listener. The signal is also passed into both credential and fetch layers so they can stop their own work. A provider `AbortError` while the caller signal is not aborted propagates unchanged. A fetch/read cancellation never fabricates a terminal event. Finally, a nominally complete normalized result is passed through `requireCompleteProviderResult()` again, while honest partial/failed envelopes remain available to retry policy.

Create `cosmo23/lib/brain-provider-client-registry.js` with an exact pair key and no model-only lookup:

```js
'use strict';

const { getModelCapabilities } = require('../server/config/model-catalog');

function typed(code, message, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

function pairKey(provider, model) {
  if (typeof provider !== 'string' || !provider.trim() ||
      typeof model !== 'string' || !model.trim()) {
    throw typed('provider_model_mismatch', 'Provider and model are required');
  }
  return `${provider.trim()}\0${model.trim()}`;
}

function createBrainProviderClientRegistry({
  catalog, providerConfig = {}, credentialsProviders = {}, fetchImpl = fetch,
  logger = console, pairFactories = {},
}) {
  const clients = new Map();
  const unavailable = new Map();
  for (const [provider, config] of Object.entries(catalog.providers || {}).sort()) {
    for (const row of config.models || []) {
      if ((row.kind || 'chat') !== 'chat') continue;
      const key = pairKey(provider, row.id);
      try {
        getModelCapabilities(catalog, provider, row.id);
        const factory = pairFactories[key] || pairFactories[provider];
        if (typeof factory !== 'function') {
          unavailable.set(key, 'provider factory is not registered');
          continue;
        }
        const client = factory({
          provider, model: row.id, modelConfig: row,
          providerConfig: providerConfig[provider] || {},
          credentialsProvider: credentialsProviders[provider] || null,
          fetchImpl, logger,
        });
        if (!client || typeof client.generate !== 'function') {
          unavailable.set(key, 'provider client is unavailable');
          continue;
        }
        clients.set(key, client);
      } catch (error) {
        unavailable.set(key, error.message);
      }
    }
  }
  function assertPairAvailable(provider, model) {
    getModelCapabilities(catalog, provider, model);
    const key = pairKey(provider, model);
    const client = clients.get(key);
    if (!client) throw typed('provider_unavailable',
      unavailable.get(key) || `Provider unavailable: ${provider}/${model}`, true);
    return client;
  }
  return Object.freeze({
    get: (provider, model) => assertPairAvailable(provider, model),
    has: (provider, model) => clients.has(pairKey(provider, model)),
    availability: (provider, model) => {
      const key = pairKey(provider, model);
      return Object.freeze({ available: clients.has(key), reason: unavailable.get(key) || null });
    },
    assertPairAvailable,
  });
}

module.exports = { createBrainProviderClientRegistry, pairKey };
```

In the same file export `createBuiltInPairFactories(dependencies)`. It explicitly constructs: `GPT5Client(logger,{providerId:'openai'})` for OpenAI Responses; `GPT5Client(logger,{providerId:'xai'})` only for catalog rows whose reviewed `transport` is `responses`; `ChatCompletionsClient({providerId:'xai',...})` for xAI chat rows; `AnthropicClient({providerId:'anthropic',...})`; `AnthropicClient({providerId:'minimax',useOAuthService:false,...})`; `ChatCompletionsClient({providerId:'ollama-cloud',...})`; and fixed-identity `CodexResponsesClient({credentialsProvider,fetchImpl})` for OpenAI Codex. A factory is registered only when the canonical nonsecret credential-readiness reader says that exact provider is configured; it may inspect configuration/OAuth status but never call a provider. Add reviewed `transport` values (`responses`, `chat-completions`, `anthropic-messages`, or `codex-responses`) to built-in provider defaults/model overrides in Task 1 and preserve them through normalization. A missing/unknown transport or missing credential readiness is unavailable; there is no model-name heuristic. Custom exact-pair factories override the built-in table only when injected by trusted startup configuration.

- [ ] **Step 4: Run the provider client suite and verify green**

Run the Step 2 command.

Expected: all provider client tests PASS; no test uses real network or real-time sleeps.

- [ ] **Step 5: Commit only the Task 2 paths**

```bash
git add -- cosmo23/lib/codex-responses-client.js \
  cosmo23/lib/provider-execution.js \
  cosmo23/lib/brain-provider-client-registry.js \
  cosmo23/lib/gpt5-client.js \
  cosmo23/lib/anthropic-client.js \
  cosmo23/engine/src/core/chat-completions-client.js \
  cosmo23/engine/src/core/unified-client.js \
  tests/cosmo23/gpt5-client-stream.test.cjs \
  tests/cosmo23/chat-completions-terminal.test.cjs \
  tests/cosmo23/codex-responses-client.test.cjs \
  tests/cosmo23/brain-provider-client-registry.test.cjs \
  tests/cosmo23/anthropic-client-request.test.cjs \
  cosmo23/engine/tests/unit/unified-client-provider-errors.test.js
git diff --cached --check
git diff --cached -- \
  cosmo23/lib/codex-responses-client.js \
  cosmo23/lib/provider-execution.js \
  cosmo23/lib/brain-provider-client-registry.js \
  cosmo23/lib/gpt5-client.js \
  cosmo23/lib/anthropic-client.js \
  cosmo23/engine/src/core/chat-completions-client.js \
  cosmo23/engine/src/core/unified-client.js \
  tests/cosmo23/gpt5-client-stream.test.cjs \
  tests/cosmo23/chat-completions-terminal.test.cjs \
  tests/cosmo23/codex-responses-client.test.cjs \
  tests/cosmo23/brain-provider-client-registry.test.cjs \
  tests/cosmo23/anthropic-client-request.test.cjs \
  cosmo23/engine/tests/unit/unified-client-provider-errors.test.js
git commit --only \
  cosmo23/lib/codex-responses-client.js \
  cosmo23/lib/provider-execution.js \
  cosmo23/lib/brain-provider-client-registry.js \
  cosmo23/lib/gpt5-client.js \
  cosmo23/lib/anthropic-client.js \
  cosmo23/engine/src/core/chat-completions-client.js \
  cosmo23/engine/src/core/unified-client.js \
  tests/cosmo23/gpt5-client-stream.test.cjs \
  tests/cosmo23/chat-completions-terminal.test.cjs \
  tests/cosmo23/codex-responses-client.test.cjs \
  tests/cosmo23/brain-provider-client-registry.test.cjs \
  tests/cosmo23/anthropic-client-request.test.cjs \
  cosmo23/engine/tests/unit/unified-client-provider-errors.test.js \
  -m "fix: enforce provider terminal and cancellation contract"
```

### Task 3: Build a Bounded, Source-Pinned Query Projection

**Files:**
- Create: cosmo23/lib/brain-operation-limits.js
- Create: cosmo23/lib/pinned-query-projection.js
- Modify: cosmo23/lib/query-engine.js
- Modify: cosmo23/server/index.js
- Create: tests/cosmo23/helpers/brain-operation-fixtures.cjs
- Create: tests/cosmo23/pinned-query-projection.test.cjs
- Create: tests/cosmo23/query-engine-source-pin.test.cjs
- Create: tests/cosmo23/query-engine-mutation-boundary.test.cjs
- Create: tests/cosmo23/query-engine-heap-probe.cjs
- Modify: tests/cosmo23/query-engine-runtime.test.cjs

**Interfaces:**
- Consumes: the injected PinnedMemorySource, requester-owned scratchDir, AbortSignal, exact query provider/model pair, and catalog capabilities.
- Produces: immutable reviewed `QUERY_OPERATION_LIMITS`/`PGS_OPERATION_LIMITS`/`SYNTHESIS_OPERATION_LIMITS`; projectPinnedQuery({sourcePin,query,signal,limits}); QueryEngine.executeQuery(query, options); and QueryEngine.executeEnhancedQuery(query, options) with immutable source evidence, count-and-byte-bounded projection statistics, explicit provider selection, exact cancellation, and resultArtifact:null.

The direct-query path must never build a full legacy state object. projectPinnedQuery() scans portable iterators once, retains at most 4,000 top-scoring nodes and 16,000 connecting edges by default, and returns only that bounded projection. Counts alone are not a memory bound. Create `cosmo23/lib/brain-operation-limits.js` with these frozen production ceilings:

```js
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const QUERY_OPERATION_LIMITS = Object.freeze({
  maxNodes: 4_000,
  maxEdges: 16_000,
  maxRecordBytes: 256 * 1024,
  maxProjectionBytes: 64 * MiB,
  maxPromptBytes: 8 * MiB,
  maxResultBytes: 8 * MiB,
});
const PGS_OPERATION_LIMITS = Object.freeze({
  maxRecordBytes: 256 * 1024,
  maxTransactionRecords: 1_000,
  maxTransactionBytes: 8 * MiB,
  maxScratchBytes: 8 * GiB,
  minFreeScratchBytes: 1 * GiB,
  maxSelectedWorkUnits: 256,
  maxNodesPerWorkUnit: 250,
  maxContextCharsPerWorkUnit: 128_000,
  maxSweepOutputBytes: 256 * 1024,
  maxTotalSweepOutputBytes: 16 * MiB,
  maxSynthesisInputBytes: 16 * MiB,
  maxSynthesisOutputBytes: 2 * MiB,
  maxResultBytes: 24 * MiB,
});
const SYNTHESIS_OPERATION_LIMITS = Object.freeze({
  maxPromptBytes: 8 * MiB,
  maxProviderOutputBytes: 2 * MiB,
  maxBrainStateBytes: 4 * MiB,
});
module.exports = {
  QUERY_OPERATION_LIMITS, PGS_OPERATION_LIMITS, SYNTHESIS_OPERATION_LIMITS,
};
```

Trusted constructor/test injection may lower a value but may never raise it; no request parameter can set these limits. Every byte count is UTF-8 `Buffer.byteLength()` over the exact serialized/prompt/result bytes that cross the next boundary. Exceeding a per-record, retained-projection, prompt, provider-output, scratch, synthesis-input, or terminal-result ceiling throws nonretryable `result_too_large` before the next provider/store boundary and cleans only requester scratch. A source implementation that exposes loadAll(), loadState(), readGraph(), or createPinnedQueryState() is not called. A manifestless legacy source first becomes the prerequisite request-owned streaming projection, then crosses this same iterator path.

- [ ] **Step 1: Create one concrete fixture module and write the red bounded-read tests**

Create tests/cosmo23/helpers/brain-operation-fixtures.cjs. It is shared by Tasks 3-5 and exports these concrete functions; tests must import them rather than refer to unnamed local helpers:

~~~js
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createGzip } = require('node:zlib');
const {
  createMemorySourcePinProvider,
} = require('../../../shared/memory-source/index.cjs');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function writeNdjsonGzip(file, records) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const output = require('node:fs').createWriteStream(file, { flags: 'wx' });
  const gzip = createGzip();
  gzip.pipe(output);
  for await (const record of records) {
    if (!gzip.write(JSON.stringify(record) + '\n')) await once(gzip, 'drain');
  }
  gzip.end();
  await once(output, 'close');
}

async function writeJsonGzip(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const output = require('node:fs').createWriteStream(file, { flags: 'wx' });
  const gzip = createGzip();
  gzip.pipe(output);
  gzip.end(JSON.stringify(value));
  await once(output, 'close');
}

async function createCommittedMemoryFixture(t, options = {}) {
  const home23Root = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-brain-fixture-'));
  const targetKind = options.targetKind || 'resident';
  const targetAgent = options.targetAgent || 'forrest';
  const targetRoot = targetKind === 'completed-research'
    ? path.join(home23Root, 'research', 'runs', options.runId || 'run-forrest-completed')
    : path.join(home23Root, 'instances', targetAgent, 'brain');
  const workspaceRoot = path.join(home23Root, 'instances', targetAgent, 'workspace');
  const requester = options.requesterAgent || 'jerry';
  const operationId = options.operationId || 'op-fixture';
  const operationRoot = path.join(
    home23Root, 'instances', requester, 'runtime', 'brain-operations', operationId,
  );
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  await fs.mkdir(operationRoot, { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(workspaceRoot, 'SOUL.md'), '# Soul\nFixture identity.\n', { flag: 'wx' }),
    fs.writeFile(path.join(workspaceRoot, 'MISSION.md'), '# Mission\nFixture mission.\n', { flag: 'wx' }),
    fs.writeFile(path.join(workspaceRoot, 'BRAIN_INDEX.md'), '# Brain Index\n## Alpha canary\n',
      { flag: 'wx' }),
  ]);

  const nodes = options.nodes || [
    { id: 'n1', type: 'fact', content: 'alpha canary', salience: 0.8 },
    { id: 'n2', type: 'fact', content: 'beta', salience: 0.4 },
  ];
  const edges = options.edges || [{ source: 'n1', target: 'n2', type: 'supports' }];
  if (targetKind === 'completed-research') {
    await writeJsonGzip(path.join(targetRoot, 'state.json.gz'), {
      memory: { nodes, edges },
      metadata: { ownerAgent: targetAgent, status: 'COMPLETED', completedAt: 1 },
    });
  } else if (options.legacy === true) {
    await writeNdjsonGzip(path.join(targetRoot, 'memory-nodes.jsonl.gz'), nodes);
    await writeNdjsonGzip(path.join(targetRoot, 'memory-edges.jsonl.gz'), edges);
    await fs.writeFile(path.join(targetRoot, 'memory-delta.jsonl'), '', { flag: 'wx' });
  } else {
    const nodeBase = path.join(targetRoot, 'memory-nodes.base-1.jsonl.gz');
    const edgeBase = path.join(targetRoot, 'memory-edges.base-1.jsonl.gz');
    await writeNdjsonGzip(nodeBase, nodes);
    await writeNdjsonGzip(edgeBase, edges);
    await fs.writeFile(path.join(targetRoot, 'memory-delta.e1.jsonl'), '', { flag: 'wx' });
    const manifest = {
      formatVersion: 1,
      generation: 'fixture-1',
      baseRevision: 1,
      currentRevision: 1,
      activeDeltaEpoch: 'e1',
      activeBase: {
        nodes: { file: 'memory-nodes.base-1.jsonl.gz', count: nodes.length,
          bytes: (await fs.stat(nodeBase)).size },
        edges: { file: 'memory-edges.base-1.jsonl.gz', count: edges.length,
          bytes: (await fs.stat(edgeBase)).size },
      },
      activeDelta: {
        epoch: 'e1', file: 'memory-delta.e1.jsonl', fromRevision: 2,
        toRevision: 1, count: 0, committedBytes: 0,
      },
      ann: { indexFile: null, metaFile: null, builtFromRevision: null },
      summary: { nodeCount: nodes.length, edgeCount: edges.length, clusterCount: 0 },
    };
    await fs.writeFile(path.join(targetRoot, 'memory-manifest.json'),
      JSON.stringify(manifest) + '\n', { flag: 'wx' });
  }

  const sourcePins = createMemorySourcePinProvider({ home23Root, requesterAgent: requester });
  const coordinatorPin = await sourcePins.pin(targetRoot, operationId);
  const sourcePin = await sourcePins.openPinnedSource(coordinatorPin.descriptor, {
    processIdentity: 'cosmo-999-0123456789abcdef0123',
    operationId,
    requesterAgent: requester,
    expectedCanonicalRoot: await fs.realpath(targetRoot),
    expectedRevision: coordinatorPin.descriptor.cutoffRevision,
    expectedDigest: coordinatorPin.digest,
  });
  const cleanup = async () => {
    await sourcePin.release();
    await sourcePins.releaseOperationPins(operationId);
    await fs.rm(home23Root, { recursive: true, force: true });
  };
  if (t) t.after(cleanup);
  return {
    home23Root, targetRoot, workspaceRoot, targetKind, targetAgent, requester,
    operationId, operationRoot, lockRoot,
    sourcePins, coordinatorPin, sourcePin, cleanup,
  };
}

function createSyntheticPinnedSource({
  nodeCount, edgeCount, revision = 7, nodeFactory = null, edgeFactory = null,
}) {
  let recordsConsumed = 0;
  let maxOutstandingRecords = 0;
  const materializerError = new Error('full materializer forbidden');
  async function* iterateNodes({ signal } = {}) {
    for (let index = 0; index < nodeCount; index += 1) {
      if (signal?.aborted) throw signal.reason;
      recordsConsumed += 1;
      maxOutstandingRecords = Math.max(maxOutstandingRecords, 1);
      yield nodeFactory ? nodeFactory(index) : {
        id: 'n' + index,
        type: 'fact',
        content: index % 997 === 0 ? 'bounded canary ' + index : 'ordinary ' + index,
        salience: (index % 100) / 100,
        clusterId: 'c' + (index % 256),
      };
    }
  }
  async function* iterateEdges({ signal } = {}) {
    for (let index = 0; index < edgeCount; index += 1) {
      if (signal?.aborted) throw signal.reason;
      recordsConsumed += 1;
      maxOutstandingRecords = Math.max(maxOutstandingRecords, 1);
      yield edgeFactory ? edgeFactory(index) : {
        source: 'n' + (index % nodeCount),
        target: 'n' + ((index + 1) % nodeCount),
        type: 'relates',
      };
    }
  }
  return {
    revision,
    descriptor: {
      version: 1, canonicalRoot: '/synthetic', generation: 'synthetic',
      baseRevision: revision, cutoffRevision: revision,
      summary: { nodeCount, edgeCount, clusterCount: Math.min(nodeCount, 256) },
      activeBase: {
        nodes: { file: 'nodes', count: nodeCount, bytes: 1 },
        edges: { file: 'edges', count: edgeCount, bytes: 1 },
      },
      activeDelta: { epoch: '0', file: 'delta', fromRevision: revision + 1,
        toRevision: revision, count: 0, committedBytes: 0 },
    },
    evidence: {
      baseWatermark: { revision }, deltaWatermark: { revision },
      indexWatermark: { builtFromRevision: null },
    },
    iterateNodes,
    iterateEdges,
    async summarize({ signal } = {}) {
      if (signal?.aborted) throw signal.reason;
      return { nodeCount, edgeCount, clusterCount: Math.min(nodeCount, 256) };
    },
    async searchKeyword(query, { topK = 10, signal } = {}) {
      if (signal?.aborted) throw signal.reason;
      const results = [];
      for await (const node of iterateNodes({ signal })) {
        if (String(node.content).includes(String(query))) results.push(node);
        if (results.length >= topK) break;
      }
      return { results };
    },
    async isCurrent() { return true; },
    async compareAndSwap(commit) { return { committed: true, value: await commit() }; },
    loadAll() { throw materializerError; },
    loadState() { throw materializerError; },
    readGraph() { throw materializerError; },
    createPinnedQueryState() { throw materializerError; },
    getEvidence(extra = {}) { return { ...this.evidence, ...extra }; },
    stats() { return { recordsConsumed, maxOutstandingRecords }; },
    async release() {},
  };
}

async function snapshotTreeNoFollow(root) {
  const rows = [];
  async function visit(relative) {
    const absolute = path.join(root, relative);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) {
      rows.push(['symlink', relative, await fs.readlink(absolute)]);
      return;
    }
    if (stat.isDirectory()) {
      rows.push(['directory', relative, stat.mode]);
      for (const name of (await fs.readdir(absolute)).sort()) {
        await visit(path.join(relative, name));
      }
      return;
    }
    if (stat.isFile()) {
      const bytes = await fs.readFile(absolute);
      rows.push([
        'file', relative, stat.mode, stat.size,
        crypto.createHash('sha256').update(bytes).digest('hex'),
      ]);
      return;
    }
    rows.push(['other', relative, stat.mode, stat.size]);
  }
  await visit('.');
  return rows;
}

async function createProtectedReadOnlyFixture(t, {
  operationType, targetKind = 'resident',
}) {
  const memory = await createCommittedMemoryFixture(null, {
    operationId: 'op-' + operationType,
    targetKind,
  });
  const before = await snapshotTreeNoFollow(memory.targetRoot);
  const cleanup = async () => memory.cleanup();
  if (t) t.after(cleanup);
  return {
    ...memory,
    before,
    requesterAgent: memory.requester,
    targetAgent: memory.targetAgent,
    capabilityClaims: {
      operationId: memory.operationId,
      operationType,
      requesterAgent: memory.requester,
      targetDomain: 'brain',
      targetBrainId: memory.targetKind === 'completed-research'
        ? 'research-run-forrest-completed'
        : 'brain-forrest',
      targetRunId: null,
      targetRequesterAgent: null,
      canonicalRoot: await fs.realpath(memory.targetRoot),
      sourcePinDigest: memory.coordinatorPin.digest,
      accessMode: 'read-only',
    },
    async assertTargetUnchanged() {
      require('node:assert/strict').deepEqual(
        await snapshotTreeNoFollow(memory.targetRoot), before,
      );
    },
  };
}

module.exports = {
  createCommittedMemoryFixture,
  createProtectedReadOnlyFixture,
  createSyntheticPinnedSource,
  deferred,
  snapshotTreeNoFollow,
  writeJsonGzip,
  writeNdjsonGzip,
};
~~~

The imports and provider calls above are the prerequisite source-plan contract. Do not create a second source implementation. The synthetic fixture's full-materializer methods intentionally throw while every required portable scalar/iterator method is executable. `expectedRevision` must always come from `coordinatorPin.descriptor.cutoffRevision`, and `expectedDigest` must always be `coordinatorPin.digest`; never hardcode or recompute an unbound expectation. Add assertions for manifest-backed resident, `legacy:true` resident, and `targetKind:'completed-research'` fixtures that `descriptor.version === 1`, `Number.isSafeInteger(descriptor.cutoffRevision)`, descriptor `summary` has nonnegative safe-integer node/edge/cluster counts, `sourcePin.revision === descriptor.cutoffRevision`, `sourceDescriptorDigest(descriptor) === coordinatorPin.digest`, and the exact descriptor revision/digest were passed to `openPinnedSource()`. Query/PGS use those bounded scalar counts (or `sourcePin.summarize()` which returns the same scalars) and never rescan node/edge iterators merely to compute totals. The legacy assertions are essential because requester-owned immutable projections use prerequisite hash-derived numeric revisions and are not guaranteed to be revision 1. Missing/wrong digest must fail before any iterator, engine, or provider call.

Create tests/cosmo23/pinned-query-projection.test.cjs with:

~~~js
test('one-million-node direct query never materializes and stays bounded', async () => {
  const sourcePin = createSyntheticPinnedSource({
    nodeCount: 1_000_000, edgeCount: 3_000_000,
  });
  const projection = await projectPinnedQuery({
    sourcePin, query: 'bounded canary', signal: new AbortController().signal,
    limits: { maxNodes: 4_000, maxEdges: 16_000 },
  });
  assert.equal(projection.nodes.length <= 4_000, true);
  assert.equal(projection.edges.length <= 16_000, true);
  assert.equal(projection.stats.nodesScanned, 1_000_000);
  assert.equal(projection.stats.edgesScanned, 3_000_000);
  assert.equal(projection.stats.maxRetainedNodes <= 4_000, true);
  assert.equal(projection.stats.maxRetainedEdges <= 16_000, true);
  assert.equal(sourcePin.stats().maxOutstandingRecords, 1);
  assert.equal(projection.stats.maxRetainedBytes <= 64 * 1024 * 1024, true);
  assert.equal(sourcePin.stats().recordsConsumed, 4_000_000);
});

test('oversized records and aggregate projection bytes fail before provider work', async () => {
  const oversized = createSyntheticPinnedSource({ nodeCount: 2, edgeCount: 0,
    nodeFactory: index => ({ id: `n${index}`, content: 'x'.repeat(257 * 1024) }) });
  await assert.rejects(projectPinnedQuery({
    sourcePin: oversized, query: 'x', signal: new AbortController().signal,
  }), error => error.code === 'result_too_large');
  const aggregate = createSyntheticPinnedSource({ nodeCount: 300, edgeCount: 0,
    nodeFactory: index => ({ id: `n${index}`, content: 'x'.repeat(64 * 1024) }) });
  await assert.rejects(projectPinnedQuery({
    sourcePin: aggregate, query: 'x', signal: new AbortController().signal,
    limits: { maxProjectionBytes: 2 * 1024 * 1024 },
  }), error => error.code === 'result_too_large');
});

test('legacy request-owned projection crosses only the iterator seam', async () => {
  const fixture = await createCommittedMemoryFixture(t, { legacy: true });
  const projection = await projectPinnedQuery({
    sourcePin: fixture.sourcePin, query: 'alpha canary',
    signal: new AbortController().signal,
  });
  assert.equal(projection.nodes.some(node => node.id === 'n1'), true);
  assert.equal(projection.sourceRevision, fixture.sourcePin.revision);
});

test('completed-research projection crosses the same bounded iterator seam', async t => {
  const fixture = await createCommittedMemoryFixture(t, {
    targetKind: 'completed-research',
  });
  const projection = await projectPinnedQuery({
    sourcePin: fixture.sourcePin, query: 'alpha canary',
    signal: new AbortController().signal,
  });
  assert.equal(projection.nodes.some(node => node.id === 'n1'), true);
  assert.equal(projection.sourceRevision, fixture.coordinatorPin.descriptor.cutoffRevision);
});

test('projection cancellation rejects with the exact reason', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('cancel projection'), { code: 'cancelled' });
  const sourcePin = createSyntheticPinnedSource({ nodeCount: 100_000, edgeCount: 0 });
  const pending = projectPinnedQuery({
    sourcePin, query: 'canary', signal: controller.signal,
    limits: { maxNodes: 4_000, maxEdges: 16_000 },
    onNodeScanned(count) { if (count === 10_000) controller.abort(reason); },
  });
  await assert.rejects(pending, error => error === reason);
  assert.equal(sourcePin.stats().recordsConsumed, 10_000);
});
~~~

Extend `createSyntheticPinnedSource()` with optional `nodeFactory`/`edgeFactory` callbacks used only by byte-limit tests. The `legacy:true` branch above writes the prerequisite legacy resident-sidecar shape with no manifest. `targetKind:'completed-research'` writes the prerequisite monolithic research shape. `sourcePins.pin()` must stream either into the requester-owned immutable projection; the test still receives only a real PinnedMemorySource.

- [ ] **Step 2: Write red mutation, constructor-write, provider-routing, and cancellation tests**

In tests/cosmo23/query-engine-mutation-boundary.test.cjs, snapshot the complete target tree before constructing QueryEngine, then construct and execute a direct read-only query, and compare the complete tree afterward. Repeat with a target containing an unknown file, nested directory, and symlink. snapshotTreeNoFollow() uses lstat and hashes every regular file, records every directory, and records symlink text without following it; it has no allowlist or lock-file exclusion. This catches constructor writes and new or unknown files, not just known mutation boundaries.

In tests/cosmo23/query-engine-source-pin.test.cjs prove:

- QueryEngine construction and execution leave the complete target tree byte-identical.
- Only sourcePin iterators are read; a raw target path and manifest path are rejected.
- Query and enhanced-query never call sourcePin.release().
- Cancellation at projection, provider selection, provider stream, result normalization, and receipt boundary uses assert.rejects(pending, error => error === reason).
- A single serialized node/edge over 256 KiB, projection over 64 MiB, prompt over 8 MiB, or canonical result over 8 MiB fails `result_too_large` before the next provider/cache/result-store boundary. Exact boundary values pass; one byte over fails.
- Controlled provider spies remain at zero for record/projection/prompt overflow, and cache/receipt/result-store spies remain at zero for provider-result overflow.
- Explicit provider/model mismatch fails with provider_model_mismatch before provider work.
- A model ID present under two providers without provider fails with model_ambiguous.
- An explicit provider whose client is unavailable fails provider_unavailable and never falls back to local, another provider, or a model-name heuristic.
- Query and enhanced-query always emit `provider_selected` before each provider call with phase, provider, model, catalog-derived providerStallMs, and exact singleton `providerCallId:'query'`; they emit a matching `provider_call_terminal` from `finally`.
- Provider activity wrapping cannot overwrite the outer event type.

Use this event assertion:

~~~js
assert.deepEqual(events[0], {
  type: 'provider_selected',
  phase: 'query',
  provider: 'minimax',
  model: 'MiniMax-M3',
  providerStallMs: 900000,
  providerCallId: 'query',
});
assert.deepEqual(events[1], {
  type: 'provider_activity',
  phase: 'query',
  provider: 'minimax',
  model: 'MiniMax-M3',
  providerCallId: 'query',
  providerEventType: 'response.output_text.delta',
  providerEventAt: null,
});
assert.deepEqual(events.at(-1), {
  type: 'provider_call_terminal',
  phase: 'query',
  provider: 'minimax',
  model: 'MiniMax-M3',
  providerCallId: 'query',
  outcome: 'complete',
});
assert.equal(events.every(event => event.type !== 'response.output_text.delta'), true);
~~~

- [ ] **Step 3: Run the query tests and record red**

Run:

~~~bash
node --test --test-concurrency=1 \
  tests/cosmo23/pinned-query-projection.test.cjs \
  tests/cosmo23/query-engine-source-pin.test.cjs \
  tests/cosmo23/query-engine-mutation-boundary.test.cjs \
  tests/cosmo23/query-engine-runtime.test.cjs
~~~

Expected: FAIL because pinned-query-projection.js and the explicit execution contract do not exist, current QueryEngine loads mutable/full state, and provider choice may fall back by model.

- [ ] **Step 4: Implement the bounded projection**

Create cosmo23/lib/pinned-query-projection.js. Use a fixed-size min-heap keyed by deterministic tuple score, salience, and node ID. Scan nodes with for await, checking signal.aborted before and after every yielded record. Measure the exact UTF-8 JSON bytes of each yielded record before scoring and reject a record over `maxRecordBytes`. Keep only maxNodes heap entries while maintaining the exact retained-byte total; replacing a heap entry subtracts its bytes before adding the replacement, and exceeding `maxProjectionBytes` is `result_too_large`. After sorting selected nodes, scan edges once and retain only edges whose two endpoints are selected, applying the same per-record and cumulative retained-byte accounting, stopping retention at maxEdges while continuing the scan for honest statistics. Do not accumulate rejected nodes, edges, text, serialized copies, or IDs beyond the selected-ID Set.

The exported result shape is exact:

~~~js
{
  sourceRevision: sourcePin.revision,
  sourceEvidence: sourcePin.getEvidence({ route: 'bounded-query-projection' }),
  nodes: selectedNodes,
  edges: selectedEdges,
  summary: await sourcePin.summarize({ signal }),
  stats: {
    nodesScanned, edgesScanned,
    maxRetainedNodes, maxRetainedEdges,
    maxRetainedBytes, maxRecordBytes, maxProjectionBytes,
    maxNodes, maxEdges,
  },
}
~~~

Scoring is local and bounded: normalize query terms once; award exact token overlap, phrase overlap, and numeric salience; break ties by stable node ID. Reject maxNodes above 4,000, maxEdges above 16,000, maxRecordBytes above 256 KiB, maxProjectionBytes above 64 MiB, or non-positive/non-integer limits with invalid_request. Do not call sourcePin.summarize until after iterator scans and do not treat a summarize abort as degraded evidence. The prerequisite summarize implementation returns the descriptor's bounded scalar summary without iterating; capture source iterator counters before/after summarize and require no additional record consumption.

- [ ] **Step 5: Make provider selection an exact pair and execute only from the projection**

Add one resolver used by both `executeQuery()` and `executeEnhancedQuery()` in `cosmo23/lib/query-engine.js`:

~~~js
function typed(code, message, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

function resolveQueryRuntime({ catalog, providerId, modelId, providerRegistry }) {
  if (!modelId) throw typed('model_not_found', 'Query model is required');
  const matches = flattenCatalogModels(catalog)
    .filter(entry => entry.kind === 'chat' && entry.id === modelId);
  if (!providerId && matches.length > 1) {
    throw typed('model_ambiguous', 'Provider is required for an ambiguous model');
  }
  const selected = matches.find(entry => !providerId || entry.provider === providerId);
  if (!selected) throw typed('provider_model_mismatch', 'Selected provider/model pair is absent');
  const capabilities = getModelCapabilities(catalog, selected.provider, selected.id);
  const client = providerRegistry.assertPairAvailable(selected.provider, selected.id);
  return { providerId: selected.provider, modelId: selected.id, capabilities, client };
}
~~~

The operation protocol requires both provider and model. The compatibility direct endpoint may omit provider only when the catalog has exactly one match for model; it writes the resolved pair into canonical operation parameters before dispatch. It never infers provider from model text or falls back after an explicit selection. QueryEngine receives the one process-local `brainProviderClientRegistry` created at server startup. Remove its constructor-owned GPT5/Anthropic/MiniMax/local/xAI/Ollama provider instances, the special `isCodex` inline credential/fetch/SSE branch, and every xAI `new GPT5Client()` mutation. Any still-supported legacy QueryEngine entry point resolves its exact pair through the injected registry; it cannot construct an alternate client. OpenAI Codex resolves only to the registry's fixed `CodexResponsesClient`; xAI Responses resolves only to a `GPT5Client` constructed with fixed `providerId:'xai'`; all Chat Completions clients carry their exact constructor provider ID. Add production-path spies proving the legacy inline fetch, direct-constructor, and model-name inference paths are unreachable for both direct and enhanced query.

executeQuery() requires sourcePin, query, signal, scratchDir, mutationPolicy, provider, and model. It calls projectPinnedQuery(), converts only that bounded result to the existing graph-domain prompt/state, and passes the same signal to the selected client. Build the prompt through a byte-counting writer; it must never create an intermediate unbounded concatenation, and exactly 8 MiB passes while one byte over fails before the client call. Revalidate every provider response with requireCompleteProviderResult(), even if it already says status:complete, then measure the exact canonical JSON result and reject over 8 MiB before any cache, receipt, or worker return. maxOutputTokens and providerStallMs come only from getModelCapabilities().

Emit outer events without object-spread collision:

~~~js
reportEvent({
  type: 'provider_selected', phase: 'query',
  provider: runtime.providerId, model: runtime.modelId,
  providerStallMs: runtime.capabilities.providerStallMs,
  providerCallId: 'query',
});
const onProviderActivity = child => reportEvent({
  type: 'provider_activity', phase: 'query',
  provider: runtime.providerId, model: runtime.modelId,
  providerCallId: 'query',
  providerEventType: child?.type || 'provider_event',
  providerEventAt: typeof child?.at === 'string' && child.at.length <= 128 ? child.at : null,
});
~~~

`providerEventAt` is bounded diagnostic metadata only. The protected worker and coordinator record activity from their injected local monotonic/receipt clocks; they never parse this field for stall truth. Test past, future, malformed, and missing child timestamps and prove all four renew at the same local receipt time. Wrap the provider await in `try/catch/finally`, preserve exact abort identity, and emit a matching `provider_call_terminal` from `finally` with `providerCallId:'query'` and outcome exactly `complete`, `failed`, or `cancelled`. Never use `{ type:'provider_activity', ...child }`, because child.type would replace the operation event type. Heartbeats remain separate coordinator events and never renew provider activity.

Read-only mode forces allowActions:false, disables every cache/session/receipt/agency write, and uses only requester scratch for any temporary output. Own mode may request mutation only through the separately guarded own-brain commit path. Both return canonical numeric source evidence and resultArtifact:null. Neither executor closes the injected pin.

- [ ] **Step 6: Add and run an offline heap probe**

tests/cosmo23/query-engine-heap-probe.cjs runs in a child process with --expose-gc. It builds the one-million-node/three-million-edge synthetic iterator, constructs the real QueryEngine with an injected exact-pair registry whose controlled client returns a terminal normalized completion, and executes the full operation path through projection, prompt construction, provider validation, canonical result serialization, and worker-envelope mapping. It forces GC before and after, samples process.memoryUsage().heapUsed and rss every 10,000 yielded records and at every later boundary, and prints one JSON line. The parent test requires:

- full materializer methods were never called;
- maxRetainedNodes <= 4,000 and maxRetainedEdges <= 16,000;
- peak heap delta <= 192 MiB;
- peak RSS delta <= 256 MiB; and
- all 4,000,000 records were scanned;
- promptBytes <= 8 MiB, resultBytes <= 8 MiB, and exactly one controlled provider call; and
- the final envelope is complete with `resultArtifact:null` and the pinned numeric evidence.

Run a second adversarial child with 4,000 near-limit nodes plus 16,000 near-limit edges and a near-limit provider response. It must either complete under the same heap/RSS limits while every byte metric stays at/below its ceiling, or fail typed `result_too_large` at the first crossed ceiling with zero later boundary calls. A one-byte-over table test covers each ceiling. Use `setImmediate` to abort an otherwise CPU-ready synthetic scan and prove external event-loop cancellation is observed by identity; `projectPinnedQuery()` cooperatively yields at least every 1,000 records as well as at real stream awaits.

Run:

~~~bash
node --expose-gc tests/cosmo23/query-engine-heap-probe.cjs
node --test --test-concurrency=1 \
  tests/cosmo23/pinned-query-projection.test.cjs \
  tests/cosmo23/query-engine-source-pin.test.cjs \
  tests/cosmo23/query-engine-mutation-boundary.test.cjs \
  tests/cosmo23/query-engine-runtime.test.cjs
~~~

Expected: the probe exits 0 with one JSON metrics line and all focused tests PASS. These are offline synthetic checks; they do not touch PM2 or a live brain.

- [ ] **Step 7: Commit only Task 3 paths**

~~~bash
git add -- cosmo23/lib/brain-operation-limits.js \
  cosmo23/lib/pinned-query-projection.js \
  cosmo23/lib/query-engine.js \
  cosmo23/server/index.js \
  tests/cosmo23/helpers/brain-operation-fixtures.cjs \
  tests/cosmo23/pinned-query-projection.test.cjs \
  tests/cosmo23/query-engine-source-pin.test.cjs \
  tests/cosmo23/query-engine-mutation-boundary.test.cjs \
  tests/cosmo23/query-engine-heap-probe.cjs \
  tests/cosmo23/query-engine-runtime.test.cjs
git diff --cached --check
git diff --cached -- \
  cosmo23/lib/brain-operation-limits.js \
  cosmo23/lib/pinned-query-projection.js \
  cosmo23/lib/query-engine.js \
  cosmo23/server/index.js \
  tests/cosmo23/helpers/brain-operation-fixtures.cjs \
  tests/cosmo23/pinned-query-projection.test.cjs \
  tests/cosmo23/query-engine-source-pin.test.cjs \
  tests/cosmo23/query-engine-mutation-boundary.test.cjs \
  tests/cosmo23/query-engine-heap-probe.cjs \
  tests/cosmo23/query-engine-runtime.test.cjs
git commit --only \
  cosmo23/lib/brain-operation-limits.js \
  cosmo23/lib/pinned-query-projection.js \
  cosmo23/lib/query-engine.js \
  cosmo23/server/index.js \
  tests/cosmo23/helpers/brain-operation-fixtures.cjs \
  tests/cosmo23/pinned-query-projection.test.cjs \
  tests/cosmo23/query-engine-source-pin.test.cjs \
  tests/cosmo23/query-engine-mutation-boundary.test.cjs \
  tests/cosmo23/query-engine-heap-probe.cjs \
  tests/cosmo23/query-engine-runtime.test.cjs \
  -m "fix: bound pinned brain query execution"
~~~

### Task 4: Make PGS Disk-Backed, Retryable, and Terminal-Honest

**Files:**
- Modify: cosmo23/pgs-engine/package.json
- Modify: cosmo23/pgs-engine/package-lock.json
- Modify: cosmo23/pgs-engine/README.md
- Create: cosmo23/pgs-engine/src/pinned-store.js
- Modify: cosmo23/pgs-engine/src/defaults.js
- Modify: cosmo23/pgs-engine/src/partitioner.js
- Modify: cosmo23/pgs-engine/src/sweeper.js
- Modify: cosmo23/pgs-engine/src/synthesizer.js
- Modify: cosmo23/pgs-engine/src/index.js
- Modify: cosmo23/lib/query-engine.js
- Modify: cosmo23/pgs-engine/test/partitioner.test.js
- Modify: cosmo23/pgs-engine/test/sweeper.test.js
- Modify: cosmo23/pgs-engine/test/synthesizer.test.js
- Modify: cosmo23/pgs-engine/test/integration.test.js
- Modify: tests/cosmo23/pgs-engine.test.cjs
- Create: tests/cosmo23/pinned-pgs-store.test.cjs
- Create: tests/cosmo23/pgs-source-pin.test.cjs
- Create: tests/cosmo23/pgs-retry-state.test.cjs
- Create: tests/cosmo23/pgs-cancellation.test.cjs
- Create: tests/cosmo23/pgs-heap-probe.cjs

**Interfaces:**
- Consumes: the same sourcePin and source revision as Query, canonical requester scratchDir, explicit pgsSweep:{provider,model}, explicit pgsSynth:{provider,model}, signal, reportEvent, and mutationPolicy.
- Produces: openPinnedPGSStore({sourcePin,scratchDir,signal,limits}), resumable bounded work units, public machine-readable `result.sweepOutputs`, numeric `result.metadata.pgs.successfulSweeps`, sorted `result.metadata.pgs.retryablePartitions`, applied sweep fraction/selected/pending counts, and complete/partial/failed/cancelled outcomes without target writes.

PGS does not build node or edge arrays. `cosmo23/pgs-engine/src/pinned-store.js` streams the full pinned source into a better-sqlite3 database beneath scratchDir/pgs/<descriptorDigest>-r<revision>/projection.sqlite. Add runtime dependency `"better-sqlite3":"^11.0.0"` to the standalone package, regenerate its own lockfile with `npm --prefix cosmo23/pgs-engine install --package-lock-only --ignore-scripts`, and document the native dependency/Node support in its README. The database is a revision-bound requester scratch projection, not source truth and not a portable pin. Durable operation execution requires the nonnull Foundation/Source `scratchQuota`; package-level legacy array callers use their existing isolated component limit but cannot enter the durable worker path without the aggregate quota.

The maintained PGS package entry point is `cosmo23/pgs-engine/src/index.js`; its production collaborators are `defaults.js`, `partitioner.js`, `sweeper.js`, and `synthesizer.js` in that same directory. Do not create parallel files at `cosmo23/pgs-engine/*.js`, and do not add this operation path to the historical monolith `cosmo23/lib/pgs-engine.js`. Preserve the published graph-array API and its existing tests byte-for-byte in behavior; add a distinct `PGSEngine.runPinnedOperation(options)` method that requires `sourcePin`, requester `scratchDir`, exact provider pairs, signal, mutation policy, and trusted limits. It never guesses the mode from argument shape and the legacy API never silently opens a pinned store. In `cosmo23/lib/query-engine.js`, replace only the durable operation path's `require('./pgs-engine')`/legacy constructor use with the package entry point `require('../pgs-engine/src')` and call `runPinnedOperation()`. The package-local Mocha tests cover both legacy graph-array and new pinned APIs; Home23 Node tests import `../../cosmo23/pgs-engine/src`, never `../../cosmo23/lib/pgs-engine`.

- [ ] **Step 1: Write red store and bounded-memory tests**

The SQLite schema is part of the contract:

~~~sql
CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  partition_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX nodes_partition ON nodes(partition_id, ordinal);
CREATE TABLE edges (
  ordinal INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX edges_source ON edges(source);
CREATE INDEX edges_target ON edges(target);
CREATE TABLE work_units (
  work_unit_id TEXT PRIMARY KEY,
  partition_id TEXT NOT NULL,
  first_ordinal INTEGER NOT NULL,
  last_ordinal INTEGER NOT NULL,
  node_count INTEGER NOT NULL,
  context_chars INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','complete')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  last_attempt_id TEXT,
  last_attempt_at TEXT,
  last_error_json TEXT
);
CREATE TABLE successful_sweeps (
  work_unit_id TEXT PRIMARY KEY,
  partition_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  output_json TEXT NOT NULL,
  completed_at TEXT NOT NULL
);
~~~

Metadata includes schemaVersion, numeric sourceRevision, descriptorDigest, completeProjection, nodeCount, edgeCount, every persistence-affecting `PGS_OPERATION_LIMITS` value, pgsSweepProvider, and pgsSweepModel. descriptorDigest is SHA-256 of canonical JSON for the full source descriptor. Reuse is allowed only when schemaVersion, sourceRevision, descriptorDigest, all limits, and the exact resolved PGS sweep provider/model pair match and completeProjection is true. Otherwise close and atomically remove/rebuild the requester-owned DB. Never reuse by operation ID alone.

Create tests/cosmo23/pinned-pgs-store.test.cjs using createSyntheticPinnedSource({nodeCount:1_000_000,edgeCount:3_000_000}) and importing `openPinnedPGSStore` from `../../cosmo23/pgs-engine/src/pinned-store`. Its full materializer methods throw. Assert exact SQLite row counts, no target writes, deterministic work-unit ordering, max node_count <= 250, max context_chars <= 128,000, max JS retained records <= 250, max transaction bytes <= 8 MiB, and successful reopen only for the exact revision/digest/limits/sweep pair. Change each binding independently and assert rebuild.

Add exact/one-byte-over cases for the 256 KiB serialized record ceiling and an injected lower scratch ceiling. Measure the complete no-follow scratch tree after every transaction, including `projection.sqlite`, `projection.sqlite-wal`, `projection.sqlite-shm`, receipt, and retry files. At the exact ceiling the transaction may commit; one byte over throws `result_too_large`, closes the DB, deletes DB/WAL/SHM/temp files, and leaves the target unchanged. Inject `statfs` showing less than the configured 1 GiB reserve and prove failure before opening SQLite. Production sets SQLite `max_page_count` from the 8 GiB quota, limits each transaction by both 1,000 records and 8 MiB, checkpoints/checks WAL after each transaction, and never relies on a post-hoc main-DB-only size check.

Partition ID is deterministic: use canonical node.clusterId when it is a safe scalar; otherwise use the first 16 hex characters of SHA-256(node.id) modulo 256. Nodes within a partition become work units ordered by node ordinal and bounded by both 250 nodes and 128,000 serialized context characters. Edge context for one work unit is selected by indexed endpoint queries and streamed in capped batches; it is never assembled for the whole graph.

- [ ] **Step 2: Write exact cancellation and retry-state tests**

tests/cosmo23/pgs-cancellation.test.cjs must abort at each named boundary: source partitioning, work-unit load, sweep stream, between parallel batches, final synthesis stream, and atomic receipt write before rename. Every case uses a caller-owned sentinel and:

~~~js
await assert.rejects(pending, error => error === reason);
~~~

The required behavior is identical at every boundary:

1. Stop launching new work immediately.
2. If a provider batch is already running, await only those already-started promises.
3. Persist only successfully completed sweep outputs through a non-cancellable terminal-persistence path.
4. Mark no cancelled/failed/unstarted work unit complete.
5. Remove an unrenamed receipt temp file.
6. Close or interrupt SQLite work.
7. Rethrow the exact signal.reason object.

Terminal persistence receives a snapshot of completed successful outputs and no AbortSignal. It uses a SQLite transaction and atomic temp-file rename so cancellation cannot leave a half receipt. Cancellation is never mapped to partial or failed.

tests/cosmo23/pgs-retry-state.test.cjs proves failed and cancelled work remains pending; complete work is reused only for the exact source revision/digest and exact pgsSweep pair; and a retry launches only pending units. The only durable work-unit states are `pending` and `complete`. Each engine invocation creates a trusted random `attemptId`, snapshots at most 256 pending work-unit IDs in deterministic order once, and never re-enumerates pending rows in that same invocation. Starting one snapshotted unit records `last_attempt_id`, increments `attempt_count`, and records `last_attempt_at` without changing `state`; an ordinary provider failure records a bounded typed `last_error_json` while leaving the row pending; cancellation leaves the row pending and does not replace its prior error; and only a validated useful output may atomically insert `successful_sweeps` plus change that row to complete. A process crash therefore needs no requeue transition, and a newly generated attempt ID may retry the still-pending row. Test a failed first attempt followed by a successful new attempt, a cancelled in-flight attempt, an unstarted row beyond the selected snapshot, two same-attempt enumerations, 32 concurrent same-row claims, and a reopen after crash; every noncomplete row remains pending, exactly one concurrent claim launches, no row launches twice under one attempt ID, and only pending rows launch under the next ID.

PGS selection preserves the validated caller semantic. `pgsConfig` is exactly `{sweepFraction?:number}`; omission becomes `1.0`, while any nonnumber, nonfinite value, zero, or value above one is `invalid_request` before store/provider work. Take the deterministic pending snapshot first, then select the first `max(1,ceil(snapshot.length * sweepFraction))` IDs (or zero when the snapshot is empty). With eight pending units, assert `0.25` selects/claims exactly two, `1.0` selects all eight, and retry uses the same rule over the new deterministic pending snapshot. The receipt/result records the applied fraction plus selected and still-pending work-unit counts. Because unselected rows intentionally remain durable `pending` work for a later attempt, a fractional pass is terminal `partial` unless earlier attempts already completed every unselected row; it cannot masquerade as a full sweep.

Add this exact synthesis-failure matrix:

~~~js
test('failed final synthesis returns partial only when useful sweeps exist', async () => {
  const error = new ProviderCompletionError('provider_incomplete', 'truncated');
  const result = await runPGS({ successfulSweepCount: 3, synthesisError: error });
  assert.equal(result.state, 'partial');
  assert.equal(result.error.code, 'provider_incomplete');
  assert.equal(result.result.sweepOutputs.length, 3);
  assert.equal(result.result.sweepOutputs.every(row =>
    typeof row.workUnitId === 'string' && typeof row.partitionId === 'string' &&
    typeof row.output === 'string'), true);
  assert.equal(result.result.metadata.pgs.successfulSweeps, 3);
  assert.deepEqual(result.result.metadata.pgs.retryablePartitions, []);
  assert.equal(result.result.metadata.pgs.pendingWorkUnits, 0);
  await assert.rejects(fs.stat(result.successReceipt), { code: 'ENOENT' });
});

test('failed final synthesis with no useful sweeps fails the operation', async () => {
  const error = new ProviderCompletionError('provider_failed', 'offline');
  await assert.rejects(
    runPGS({ successfulSweepCount: 0, synthesisError: error }),
    caught => caught === error,
  );
});

test('non-completion synthesis failures are not converted to partial', async () => {
  const error = Object.assign(new Error('invalid synthesis config'), { code: 'invalid_request' });
  await assert.rejects(runPGS({ successfulSweepCount: 2, synthesisError: error }),
    caught => caught === error);
});

test('successful synthesis with retryable selected work is partial', async () => {
  const result = await runPGS({
    selectedWorkUnitCount: 4, successfulSweepCount: 3,
    synthesisAnswer: 'answer from useful work', failedPartitions: ['p4'],
  });
  assert.equal(result.state, 'partial');
  assert.equal(result.result.answer, 'answer from useful work');
  assert.equal(result.error.code, 'pgs_partitions_incomplete');
  assert.equal(result.error.retryable, true);
  assert.deepEqual(result.result.metadata.pgs.retryablePartitions, ['p4']);
  await assert.rejects(fs.stat(result.successReceipt), { code: 'ENOENT' });
});

test('complete requires no durable pending work and final synthesis', async () => {
  const result = await runPGS({
    selectedWorkUnitCount: 4, successfulSweepCount: 4,
    remainingPendingWorkUnitCount: 0, synthesisAnswer: 'complete answer',
  });
  assert.equal(result.state, 'complete');
  assert.deepEqual(result.result.metadata.pgs.retryablePartitions, []);
  assert.equal(result.result.metadata.pgs.pendingWorkUnits, 0);
});

test('zero useful selected work fails with machine-readable retry state', async () => {
  const error = await runPGS({
    selectedWorkUnitCount: 2, successfulSweepCount: 0,
    failedPartitions: ['p2', 'p1'],
  }).then(() => null, caught => caught);
  assert.equal(error.code, 'pgs_all_failed');
  assert.deepEqual(error.result.sweepOutputs, []);
  assert.deepEqual(error.result.metadata.pgs, {
    successfulSweeps: 0,
    retryablePartitions: ['p1', 'p2'],
    sweepFraction: 1,
    selectedWorkUnits: 2,
    pendingWorkUnits: 2,
  });
});
~~~

A useful sweep is a `requireCompleteProviderResult()`-validated, nonempty, schema-valid sweep output committed in `successful_sweeps`. Counts or attempted rows are not useful outputs. Before any complete/partial return, map its rows in deterministic work-unit order to this exact public payload:

~~~js
function toSweepOutput(sweep) {
  return Object.freeze({
    workUnitId: String(sweep.workUnitId),
    partitionId: String(sweep.partitionId),
    output: String(sweep.output).trim(),
    provider: String(sweep.provider),
    model: String(sweep.model),
  });
}
const sweepOutputs = successfulSweeps.map(toSweepOutput);
const retryablePartitions = [...new Set(store.listRetryablePartitions())].sort();
const pgsMetadata = Object.freeze({
  pgs: {
    successfulSweeps: sweepOutputs.length,
    retryablePartitions,
    sweepFraction,
    selectedWorkUnits: selectedWorkUnitCount,
    pendingWorkUnits: store.countPendingWorkUnits(),
  },
});

function resultTooLarge(label, actualBytes, maxBytes) {
  return Object.assign(new Error(`${label} is ${actualBytes} bytes; limit is ${maxBytes}`), {
    code: 'result_too_large', retryable: false, actualBytes, maxBytes,
  });
}

function assertUtf8Bytes(value, maxBytes, label) {
  const actualBytes = Buffer.byteLength(String(value), 'utf8');
  if (actualBytes > maxBytes) throw resultTooLarge(label, actualBytes, maxBytes);
  return actualBytes;
}

function assertCanonicalJsonBytes(value, maxBytes, label) {
  const bytes = canonicalJson(value);
  const actualBytes = Buffer.byteLength(bytes, 'utf8');
  if (actualBytes > maxBytes) throw resultTooLarge(label, actualBytes, maxBytes);
  return bytes;
}

function assertSweepOutputBudgets(outputs, limits) {
  let totalBytes = 0;
  for (const row of outputs) {
    assertUtf8Bytes(row.output, limits.maxSweepOutputBytes, 'PGS sweep output');
    totalBytes += Buffer.byteLength(canonicalJson({ output: row.output }), 'utf8');
    if (totalBytes > limits.maxTotalSweepOutputBytes) {
      throw resultTooLarge('PGS aggregate sweep output', totalBytes,
        limits.maxTotalSweepOutputBytes);
    }
  }
  return totalBytes;
}
~~~

Import `canonicalJson` from the prerequisite shared memory-source module used for descriptor hashing; do not substitute ordinary `JSON.stringify()` for aggregate or terminal-result measurements.

`result.sweepOutputs` is the durable machine-readable payload. `result.metadata.pgs.successfulSweeps`, `selectedWorkUnits`, and `pendingWorkUnits` are nonnegative safe-integer counts; `sweepFraction` is the exact validated `(0,1]` value; and `retryablePartitions` is the sorted unique partition list for every still-pending row, including selected failures and deliberately unselected work. None replaces the output array, and clients never scrape an answer string to recover successful work. Terminal truth is exact: complete requires `pendingWorkUnits === 0` plus complete final synthesis; useful sweeps plus any pending work is partial with `pgs_partitions_incomplete`, even if synthesis produced an answer; useful sweeps plus a `ProviderCompletionError` from synthesis is partial with that provider error; zero useful durable sweeps when selected work exists is failed `pgs_all_failed`; and cancellation always rethrows the exact reason for the common worker terminalizer. A small-graph direct-synthesis path with zero selected work units may complete only when it was explicitly selected before partition execution, the store has zero pending units, and its synthesis completes.

`successful_sweeps.output_json` encodes one exact `{output:string}` value after terminal validation; `listSuccessfulSweeps()` returns that string as `row.output`, so the public mapper has no provider-envelope-dependent nested lookup. Before committing, reject one sweep output over 256 KiB or a cumulative committed-output total over 16 MiB. Snapshot at most 256 work units. Build final synthesis input through a byte-counting writer capped at 16 MiB, reject synthesis content over 2 MiB, and measure the complete canonical terminal JSON at a 24 MiB ceiling before returning it to the foundation store. Add exact-boundary and one-byte-over tests for each limit. Overflow is nonretryable `result_too_large`, writes no success receipt, retains already committed useful rows for a future bounded retry/export, closes scratch cleanly, and never converts to `partial` merely because some useful rows exist.

- [ ] **Step 3: Write exact provider-pair and event tests**

Each PGS operation requires both pairs:

~~~js
{
  pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
  pgsSynth: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
}
~~~

Test independent propagation by assigning duplicate model IDs to different providers and asserting every sweep call receives only pgsSweep while final synthesis receives only pgsSynth. Missing provider, ambiguous model, mismatched pair, missing client, or invalid capabilities is a typed pre-provider failure. An explicit provider never falls back. The small-graph direct-answer path uses pgsSynth, not pgsSweep or Query's pair.

Require one `provider_selected` event and one matching `provider_call_terminal` event for every sweep work unit and final synthesis. Every provider event carries a stable `providerCallId`; PGS sweep calls use the exact key `pgs:<workUnitId>` and the final synthesis call uses `pgs:synthesis`. Selected events contain phase, provider, model, providerStallMs, and workUnitId/partitionId where applicable:

~~~js
{
  type: 'provider_selected',
  phase: 'pgs_sweep',
  provider: 'minimax',
  model: 'MiniMax-M3',
  providerStallMs: 900000,
  providerCallId: 'pgs:p-c17-u0004',
  workUnitId: 'p-c17-u0004',
  partitionId: 'c17',
}
~~~

Provider activity is wrapped with childEventType and cannot overwrite type:

~~~js
reportEvent({
  type: 'provider_activity',
  phase,
  provider,
  model,
  providerCallId,
  workUnitId,
  childEventType: child?.type || 'provider_event',
  providerEventAt: typeof child?.at === 'string' && child.at.length <= 128 ? child.at : null,
});
~~~

In a `finally`, emit `{type:'provider_call_terminal',providerCallId,phase,provider,model,outcome}` where outcome is exactly `complete`, `failed`, or `cancelled`; include the same workUnitId/partitionId for a sweep. Add a test whose child is `{type:'response.output_text.delta'}` and assert the stored outer type remains `provider_activity`. Start two deferred sweep calls concurrently, emit activity for only one, and assert their distinct IDs remain intact through the worker event seam so the coordinator can expire the silent sibling. Feed past, future, malformed, and missing child `at` values; `providerEventAt` may preserve only a bounded string for diagnostics, while worker idle age and coordinator timer renewal use injected local clocks only. Every call uses catalog-derived maxOutputTokens and providerStallMs; no fallback numbers.

Before the red run, update the package-local tests so they target the maintained modules directly: `partitioner.test.js` imports `../src/partitioner`, `sweeper.test.js` imports `../src/sweeper`, `synthesizer.test.js` imports `../src/synthesizer`, and `integration.test.js` imports `../src`. They cover deterministic bounded work-unit identifiers, exact abort identity, fixed sweep/synthesis provider separation, terminal-completion validation, and no in-memory full-graph/session fallback. Update `tests/cosmo23/pgs-engine.test.cjs` to import `../../cosmo23/pgs-engine/src` and assert the same public `sweepOutputs`/numeric metadata contract through the Home23-facing entry point. No test in this task imports `cosmo23/lib/pgs-engine.js`.

- [ ] **Step 4: Run the PGS tests and record red**

Run:

~~~bash
node --test --test-concurrency=1 \
  tests/cosmo23/pgs-engine.test.cjs \
  tests/cosmo23/pinned-pgs-store.test.cjs \
  tests/cosmo23/pgs-source-pin.test.cjs \
  tests/cosmo23/pgs-retry-state.test.cjs \
  tests/cosmo23/pgs-cancellation.test.cjs
npm --prefix cosmo23/pgs-engine test
~~~

Expected: both commands FAIL because `cosmo23/pgs-engine/src/pinned-store.js` and the pinned execution signature do not exist and the current package PGS path materializes graph state, keeps in-memory session/cache state, conflates provider roles, and converts synthesis errors.

- [ ] **Step 5: Implement the revision-bound SQLite projection**

openPinnedPGSStore() must:

1. realpath scratchDir and require it beneath the verified requester operation root;
2. validate/lower trusted limits against `PGS_OPERATION_LIMITS` and reject request-supplied limits;
3. require `statfs(scratchDir).bavail * bsize >= minFreeScratchBytes` before opening;
4. derive the database path only from descriptorDigest and sourcePin.revision;
5. require the trusted operation `scratchQuota`, open with journal_mode=WAL, synchronous=FULL, temp_store=MEMORY, foreign_keys=ON, a busy timeout, and `max_page_count` derived from maxScratchBytes;
6. reject a serialized node/edge over 256 KiB before binding it;
7. insert streamed nodes and edges in transactions capped by both 1,000 records and 8 MiB;
8. claim/checkpoint/reconcile the no-follow DB/WAL/SHM/receipt/retry tree through that same quota after every transaction and fail if the aggregate operation scratch bytes exceed 8 GiB, the component exceeds its lower cap, or the free reserve drops below 1 GiB;
9. maintain only the current transaction plus one work unit in JS;
10. set completeProjection=true only in the final committed metadata transaction; and
11. close and delete incomplete DB/WAL/SHM files on construction failure, quota failure, or cancellation.

Register signal.abort to call db.interrupt(). At every SQLite catch, if signal.aborted rethrow signal.reason; otherwise preserve the storage error. Do not use Array.from(iterator), [...iterator], Promise.all over graph records, or a full partition map.

Expose only bounded methods:

~~~js
{
  sourceRevision,
  descriptorDigest,
  stats,
  snapshotPendingWorkUnits({attemptId, limit}),
  loadWorkUnit(workUnitId, {signal}),
  beginWorkUnitAttempt(workUnitId, {attemptId, provider, model, startedAt}),
  commitSuccessfulSweeps(outputs),
  recordRetryableFailure(workUnitId, error),
  listSuccessfulSweeps(),
  listRetryablePartitions(),
  countPendingWorkUnits(),
  close(),
}
~~~

`snapshotPendingWorkUnits` validates a trusted random attempt ID, returns at most 256 deterministic pending IDs once, and records no state by itself. `loadWorkUnit` returns at most 250 nodes plus indexed/capped edge batches and reports retained-record/character/byte statistics. `beginWorkUnitAttempt` requires a snapshotted pending row not already bearing that attempt ID, validates the supplied provider/model against the database's immutable sweep-pair metadata, increments its attempt count, records the attempt ID and timestamp, retains the prior diagnostic until a new ordinary failure or success replaces it, and never creates a `running` state. Its compare-and-update is atomic, so two concurrent claims for one row and attempt ID yield exactly one launch. `recordRetryableFailure` requires the row still be pending and writes only a bounded `{code,message,retryable:true}` object; it never changes state. Cancellation calls neither failure method nor completion, so it cannot erase the prior diagnostic. Successful sweep persistence is one transaction: validate all output/count byte caps first, insert each exact `{output:string}`, compare-and-change only its matching pending row to complete, and clear that completed row's error. Repeating an identical already-committed work-unit/output tuple after a simulated lost commit response is an idempotent no-op; a different output for a complete row, an unknown row, or any other nonpending mismatch rolls the transaction back as `pgs_state_conflict`. `listRetryablePartitions` derives sorted unique partition IDs from pending rows, including unstarted and previously failed rows, and `countPendingWorkUnits` counts those same rows.

- [ ] **Step 6: Implement batch execution, exact cancellation, and honest synthesis failure**

`cosmo23/pgs-engine/src/index.js` executes one snapshot of at most 256 selected work units in fixed concurrency batches using the reviewed values exported by `src/defaults.js` (default 2, maximum 4). It validates the exact `pgsConfig`, creates one trusted attempt ID, snapshots pending IDs once, applies the deterministic sweep-fraction selection above, and never widens or re-enumerates that set under the same ID. `src/partitioner.js` derives deterministic bounded work-unit metadata without materializing graph-wide arrays, `src/sweeper.js` loads and executes one bounded store work unit at a time, and `src/synthesizer.js` calls only the resolved synthesis adapter and applies the terminal-completion/byte contract. Authoritative total node/edge/cluster counts come from the descriptor/sourcePin bounded scalar summary; PGS does not rescan iterators merely to count. Check `signal.aborted` before launching each unit. Use `Promise.allSettled` only for already-launched work; after it resolves, validate fulfilled provider results with `requireCompleteProviderResult()` into the current at-most-four-result `uncommittedBatch`, then check cancellation. On cancellation, the outer catch persists only that batch and records no failures. Otherwise persist fulfilled useful outputs through the non-cancellable idempotent transaction, clear the array, then record ordinary retryable failures. Never accumulate all selected raw completions in JS.

Wrap the whole loop so cancellation can persist only the current completed useful batch and retain exact identity:

~~~js
const uncommittedBatch = [];
try {
  await runPendingBatches();
  if (signal.aborted) throw signal.reason;
  return await synthesizeCompleteResult();
} catch (error) {
  if (signal.aborted || error === signal.reason) {
    await store.commitSuccessfulSweeps(uncommittedBatch); // no signal; exact replay is idempotent
    uncommittedBatch.length = 0;
    await removeUncommittedReceiptTemp();
    throw signal.reason;
  }
  throw error;
} finally {
  store.close();
}
~~~

Final synthesis catches only `ProviderCompletionError`; derive the public sweep payload before entering `try` so both terminal branches share it:

~~~js
const sweepOutputs = successfulSweeps.map(toSweepOutput);
const retryablePartitions = [...new Set(store.listRetryablePartitions())].sort();
const pendingWorkUnits = store.countPendingWorkUnits();
const metadata = { pgs: {
  successfulSweeps: sweepOutputs.length,
  retryablePartitions,
  sweepFraction,
  selectedWorkUnits: selectedWorkUnitCount,
  pendingWorkUnits,
} };
assertSweepOutputBudgets(sweepOutputs, limits);
if (sweepOutputs.length === 0 && selectedWorkUnitCount > 0) {
  throw Object.assign(new Error('All selected PGS work failed'), {
    code: 'pgs_all_failed', retryable: true,
    result: { answer: null, sweepOutputs, metadata, sourceEvidence },
  });
}
try {
  assertUtf8Bytes(synthRequest.input, limits.maxSynthesisInputBytes, 'PGS synthesis input');
  const completion = requireCompleteProviderResult(await synthClient.generate(synthRequest));
  const answer = completion.content;
  assertUtf8Bytes(answer, limits.maxSynthesisOutputBytes, 'PGS synthesis output');
  const partial = pendingWorkUnits > 0;
  const envelope = {
    state: partial ? 'partial' : 'complete',
    result: { answer, sweepOutputs, metadata, sourceEvidence },
    error: partial ? {
      code: 'pgs_partitions_incomplete',
      message: 'Some PGS work remains pending and retryable',
      retryable: true,
    } : null,
    resultArtifact: null,
  };
  assertCanonicalJsonBytes(envelope.result, limits.maxResultBytes, 'PGS result');
  if (!partial) {
    await writeSuccessReceiptAtomic({ answer, successfulSweeps, sourceEvidence });
  }
  return envelope;
} catch (error) {
  if (signal.aborted) throw signal.reason;
  if (!(error instanceof ProviderCompletionError)) throw error;
  if (successfulSweeps.length === 0) throw error;
  const envelope = {
    state: 'partial',
    result: { answer: null, sweepOutputs, metadata, sourceEvidence },
    error: { code: error.code, message: error.message, retryable: error.retryable },
    resultArtifact: null,
  };
  assertCanonicalJsonBytes(envelope.result, limits.maxResultBytes, 'PGS result');
  return envelope;
}
~~~

`assertSweepOutputBudgets` checks each output at 256 KiB and the cumulative serialized output bytes at 16 MiB without first joining/copying all text. `assertUtf8Bytes` and `assertCanonicalJsonBytes` throw nonretryable `result_too_large`. Do not write a success receipt for any partial/failed/cancelled/overflow outcome. A complete read-only receipt, when the compatibility response requires one, is written only beneath requester scratch. The atomic writer checks cancellation and the complete 8 GiB scratch quota before temp creation, after fsync, and before rename; if aborted/over quota it deletes temp and throws the exact reason/error. Once rename completes, the receipt is complete and cancellation is handled by the worker's terminal ordering.

The small-graph path may skip sweeps, but it still calls the independently resolved pgsSynth pair, emits the selected/activity/terminal sequence with `providerCallId:'pgs:synthesis'`, revalidates completion, preserves source evidence, enforces read-only mutation policy, and uses no Query provider fallback.

- [ ] **Step 7: Prove complete target immutability and bounded heap**

tests/cosmo23/pgs-source-pin.test.cjs table-tests sibling resident and completed-research fixtures, snapshots the complete target tree before constructing PGSEngine and after complete, partial, failed, cancelled, and every quota-failure run. Include unknown files, nested directories, symlinks, caches, PGS/session files, synthesis receipts, exports, and agency state. All rows must remain identical. Assert all SQLite, retry, and receipt files are under requester scratch and neither PGSEngine nor its components release the injected source pin.

tests/cosmo23/pgs-heap-probe.cjs runs under --expose-gc against one million nodes and three million edges through the complete `PGSEngine.runPinnedOperation()` path. Controlled exact-pair sweep/synthesis adapters return terminal normalized content for a trusted-lowered 64-work-unit snapshot, so the probe covers projection build, work-unit loads, concurrent provider batches, durable successful-output reads, final synthesis-input construction, canonical `sweepOutputs`, terminal JSON serialization, and cleanup. It requires full source coverage, max JS retained records <= 1,000 during build and <= 250 during a work unit, peak heap delta <= 256 MiB, peak RSS delta <= 384 MiB, exact SQLite row counts, every scratch/output/input/result metric within its reviewed ceiling, and the correct complete/partial terminal matrix. It deletes its temp DB at exit.

Run a second adversarial probe with near-256-KiB source records and enough controlled sweep outputs to approach 16 MiB aggregate/24 MiB result ceilings. It must remain inside the same memory limits or fail at the first one-byte-over boundary with `result_too_large`, no synthesis/success receipt after an earlier overflow, closed SQLite, and no target write. A low scratch-quota child must include main DB, WAL, and SHM in the reported peak.

Run:

~~~bash
node --expose-gc tests/cosmo23/pgs-heap-probe.cjs
node --test --test-concurrency=1 \
  tests/cosmo23/pgs-engine.test.cjs \
  tests/cosmo23/pinned-pgs-store.test.cjs \
  tests/cosmo23/pgs-source-pin.test.cjs \
  tests/cosmo23/pgs-retry-state.test.cjs \
  tests/cosmo23/pgs-cancellation.test.cjs
npm --prefix cosmo23/pgs-engine test
~~~

Expected: the probe exits 0 with one JSON metrics line; all Node and package-local Mocha tests PASS; no full materializer is called; cancellation identity and retry state are exact.

- [ ] **Step 8: Commit only Task 4 paths**

~~~bash
git add -- cosmo23/pgs-engine/package.json \
  cosmo23/pgs-engine/package-lock.json \
  cosmo23/pgs-engine/README.md \
  cosmo23/pgs-engine/src/pinned-store.js \
  cosmo23/pgs-engine/src/defaults.js \
  cosmo23/pgs-engine/src/partitioner.js \
  cosmo23/pgs-engine/src/sweeper.js \
  cosmo23/pgs-engine/src/synthesizer.js \
  cosmo23/pgs-engine/src/index.js \
  cosmo23/lib/query-engine.js \
  cosmo23/pgs-engine/test/partitioner.test.js \
  cosmo23/pgs-engine/test/sweeper.test.js \
  cosmo23/pgs-engine/test/synthesizer.test.js \
  cosmo23/pgs-engine/test/integration.test.js \
  tests/cosmo23/pgs-engine.test.cjs \
  tests/cosmo23/pinned-pgs-store.test.cjs \
  tests/cosmo23/pgs-source-pin.test.cjs \
  tests/cosmo23/pgs-retry-state.test.cjs \
  tests/cosmo23/pgs-cancellation.test.cjs \
  tests/cosmo23/pgs-heap-probe.cjs
git diff --cached --check
git diff --cached -- \
  cosmo23/pgs-engine/package.json \
  cosmo23/pgs-engine/package-lock.json \
  cosmo23/pgs-engine/README.md \
  cosmo23/pgs-engine/src/pinned-store.js \
  cosmo23/pgs-engine/src/defaults.js \
  cosmo23/pgs-engine/src/partitioner.js \
  cosmo23/pgs-engine/src/sweeper.js \
  cosmo23/pgs-engine/src/synthesizer.js \
  cosmo23/pgs-engine/src/index.js \
  cosmo23/lib/query-engine.js \
  cosmo23/pgs-engine/test/partitioner.test.js \
  cosmo23/pgs-engine/test/sweeper.test.js \
  cosmo23/pgs-engine/test/synthesizer.test.js \
  cosmo23/pgs-engine/test/integration.test.js \
  tests/cosmo23/pgs-engine.test.cjs \
  tests/cosmo23/pinned-pgs-store.test.cjs \
  tests/cosmo23/pgs-source-pin.test.cjs \
  tests/cosmo23/pgs-retry-state.test.cjs \
  tests/cosmo23/pgs-cancellation.test.cjs \
  tests/cosmo23/pgs-heap-probe.cjs
git commit --only \
  cosmo23/pgs-engine/package.json \
  cosmo23/pgs-engine/package-lock.json \
  cosmo23/pgs-engine/README.md \
  cosmo23/pgs-engine/src/pinned-store.js \
  cosmo23/pgs-engine/src/defaults.js \
  cosmo23/pgs-engine/src/partitioner.js \
  cosmo23/pgs-engine/src/sweeper.js \
  cosmo23/pgs-engine/src/synthesizer.js \
  cosmo23/pgs-engine/src/index.js \
  cosmo23/lib/query-engine.js \
  cosmo23/pgs-engine/test/partitioner.test.js \
  cosmo23/pgs-engine/test/sweeper.test.js \
  cosmo23/pgs-engine/test/synthesizer.test.js \
  cosmo23/pgs-engine/test/integration.test.js \
  tests/cosmo23/pgs-engine.test.cjs \
  tests/cosmo23/pinned-pgs-store.test.cjs \
  tests/cosmo23/pgs-source-pin.test.cjs \
  tests/cosmo23/pgs-retry-state.test.cjs \
  tests/cosmo23/pgs-cancellation.test.cjs \
  tests/cosmo23/pgs-heap-probe.cjs \
  -m "fix: make pinned PGS bounded and retryable"
~~~

### Task 5: Connect Query and PGS to the Capability-Protected COSMO Worker

**Files:**
- Modify: config/home.yaml.example
- Create: engine/src/dashboard/yaml-settings-store.js
- Modify: engine/src/dashboard/yaml-write-safety.js
- Modify: engine/src/dashboard/home23-settings-api.js
- Create: engine/src/dashboard/brain-operations/operation-model-resolver.js
- Modify: engine/src/dashboard/server.js
- Create: cosmo23/server/lib/query-operation-worker.js
- Modify: cosmo23/server/lib/brain-operation-worker.js
- Modify: cosmo23/server/lib/brain-operation-routes.js
- Modify: cosmo23/server/index.js
- Modify: tests/cosmo23/helpers/brain-operation-fixtures.cjs
- Create: tests/cosmo23/query-operation-worker.test.cjs
- Create: tests/cosmo23/cross-brain-readonly.test.cjs
- Modify: tests/cosmo23/brain-operation-worker.test.cjs
- Create: tests/engine/dashboard/yaml-settings-store.test.js
- Create: tests/engine/dashboard/brain-operation-model-resolver.test.js
- Modify: tests/engine/dashboard/brain-operation-coordinator.test.js
- Modify: tests/dashboard/yaml-write-safety.test.js

**Interfaces:**
- Consumes: the prerequisite protected worker/coordinator `operationModelResolver` seam, canonical OperationWorkerContext, canonical model catalog, Task 2 exact-pair provider registry, sourcePins provider, Task 3/4 engines, canonical Home23 config, and the shared concrete fixture module.
- Produces: one locked/CAS YAML settings store, `createOperationModelResolver(dependencies)`, pair-shaped query defaults/migration, createQueryOperationExecutor(dependencies), registered query and pgs executors, canonical operation-root process pins, exact worker cleanup, and standard result envelopes with resultArtifact:null.

The fresh-install query defaults in `config/home.yaml.example` are exact pairs:

~~~yaml
query:
  defaultProvider: anthropic
  defaultModel: claude-opus-4-8
  defaultMode: full
  enablePGSByDefault: false
  pgsSweepProvider: minimax
  pgsSweepModel: MiniMax-M3
  pgsSynthProvider: anthropic
  pgsSynthModel: claude-opus-4-8
  pgsDepth: 0.25
~~~

Treat the three persisted slots as the exact pairs `(query.defaultProvider,query.defaultModel)`, `(query.pgsSweepProvider,query.pgsSweepModel)`, and `(query.pgsSynthProvider,query.pgsSynthModel)`. For each pre-upgrade model-only slot, migration adds its provider only when the canonical catalog has exactly one provider for that model and the exact pair is available/capability-complete. A provider-only, ambiguous, missing, or unavailable slot makes brain-provider-operation readiness false; it never falls back by label. Resolve all three candidates first, then persist all missing provider fields in one Task 5 settings-store CAS update, so a crash cannot expose a half-migrated set. An exact lost-CAS retry rereads and revalidates the new bytes. Migration must commit before the real resolver is registered or any query/PGS operation is accepted.

- [ ] **Step 1: Write red settings-store and real operation-model-resolver tests**

Create `tests/engine/dashboard/yaml-settings-store.test.js`. Race 32 updates to different keys through one production store, then prove no update is lost, YAML parses, and every successful write has one new SHA-256 version. Exercise a stale expected version, crash before rename, crash after rename/before directory fsync, concurrent dashboard settings write versus the one-CAS three-pair query-default migration, comment-backup creation, symlinked file/parent rejection, and restart/reload. Assert that migration exposes either the complete old three-slot form or all three validated provider/model pairs, never a partially paired form. The old or new file must be complete at each crash point; the lock anchor lives under ignored runtime, the hidden same-directory temp is always removed, and neither can appear beside a target brain.

Create `tests/engine/dashboard/brain-operation-model-resolver.test.js` around the real resolver and a catalog with duplicate model labels. Assert:

```js
const query = resolver.resolve('query', { query: 'canary' });
assert.deepEqual(query.requestParameters, { query: 'canary' });
assert.deepEqual(query.parameters.modelSelection, {
  provider: 'anthropic', model: 'claude-opus-4-8',
});
const pgs = resolver.resolve('pgs', {
  query: 'canary', pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
});
assert.deepEqual(pgs.requestParameters.pgsSweep,
  { provider: 'minimax', model: 'MiniMax-M3' });
assert.deepEqual(pgs.parameters.pgsSynth,
  { provider: 'anthropic', model: 'claude-opus-4-8' });
```

Table-test omitted defaults, each explicit pair, two providers sharing one model ID, model/provider-only objects, flat `provider`/`model`, every legacy request spelling, extra pair keys, unavailable clients, invalid maxOutputTokens/providerStallMs/transport, and a small-graph PGS fallback. Fail before store create, capability, pin, worker, or provider calls. Start once, change config defaults, simulate a lost response, and retry: the authority plan's durable idempotency precheck returns the original record with its original trusted pairs and makes zero resolver calls. Race 32 byte-equivalent fresh starts whose prechecks all miss: the resolver is pure/deterministic and may run once in each contender before atomic create, but exactly one caller receives `{created:true}` and only that owner pins, attaches the digest, issues a capability, or starts a worker; every `{created:false}` loser returns the winner's durable trusted pairs without overwriting them.

- [ ] **Step 2: Implement the locked/CAS YAML store and resolver**

Create `engine/src/dashboard/yaml-settings-store.js` exporting `createYamlSettingsStore({home23Root,filePath,yaml,logger,crashInjector})`. It derives a SHA-256-named lock anchor beneath `<home23Root>/runtime/settings-locks`, uses `proper-lockfile` on that trusted anchor, rejects symlink/nonregular file components, and exposes `read()` plus `update({expectedVersion,mutate})`. Version is lowercase SHA-256 of the exact current bytes (`sha256:<64 hex>`, with the absent document represented by canonical empty YAML). `expectedVersion` is optional: when supplied it must equal the version reread under the lock or the call fails typed `settings_changed`; when omitted, `mutate` still runs against the latest under-lock document so legacy callers serialize without losing unrelated keys. Under the lock, `update` rereads bytes, performs that optional CAS, parses, passes a deep clone to `mutate`, dumps once, writes/fsyncs a hidden unique sibling temp in the settings file's own directory, renames atomically over the settings file, fsyncs that directory, and returns the new data/version. A crash removes only an unrenamed temp. Preserve the existing comment backup inside the same lock. Make `writeYamlSafely()` and every `home.yaml` read-modify-write in `home23-settings-api.js` delegate to this store so startup migration and UI writes cannot overwrite one another; version-aware routes pass their client version, while legacy routes omit it and mutate only their owned keys.

Create `engine/src/dashboard/brain-operations/operation-model-resolver.js` exporting `createOperationModelResolver({catalog,providerRegistry,queryDefaults})`. `resolve(operationType,requestParameters)` first applies the authority route's exact sanitizer, then accepts only optional `modelSelection` for query or optional `pgsSweep`/`pgsSynth` for PGS. Each pair has exactly two nonempty string keys. Omitted pairs come from the exact configured slots above. For every resolved pair call `getModelCapabilities(catalog,provider,model)` and `providerRegistry.assertPairAvailable(provider,model)`. Return normalized caller intent unchanged except for caller-supplied normalized pairs under `requestParameters`, and always return fully resolved pairs under trusted `parameters`. Freeze both projections. Synthesis and non-provider operations are not resolved here. Dashboard startup migrates legacy defaults through the store, builds one resolver, injects it into `BrainOperationCoordinator`, and keeps provider-backed source operations disabled when migration/registry validation is not ready.

- [ ] **Step 3: Extend the concrete fixture with a real protected-worker harness and write red tests**

Modify tests/cosmo23/helpers/brain-operation-fixtures.cjs to export createProtectedWorkerHarness. It constructs the real BrainOperationWorker with the prerequisite capability signer/validator, nonce store, catalog, createMemorySourcePinProvider(), and a counting wrapper around only sourcePin.release(). Its trusted operationRoot is the one created by createCommittedMemoryFixture(); its processIdentity is a valid startup-scoped identity supplied to the worker; its start request contains the real signed capability and numeric-version-1 descriptor with bounded scalar summary, while the capability and durable record contain the exact matching sourcePinDigest and full targetDomain tuple.

The export returns this exact object; every listed function is implemented in the helper before tests use it:

~~~js
{
  home23Root,
  operationRoot,
  processIdentity,
  sourcePinDescriptor,
  sourcePinDigest,
  validStartRequest,
  startRequest,
  startAndWait,
  cancel,
  stopWorkerOrderly,
  detachAttachment,
  finishExecutor,
  triggerTerminalCleanup,
  finishRelease,
  readTerminal,
  processPinReleaseCalls,
  coordinatorPinReleaseCalls,
  executorPinReleaseCalls,
  openPinnedSourceCalls,
  queryEngineCalls,
  providerCalls,
  processPinDirectory: () => path.join(operationRoot, 'pins', processIdentity),
  cleanup,
}
~~~

The harness's executor receives the real local source pin. executorPinReleaseCalls is instrumentation around a deliberately forbidden executor release seam and remains zero. processPinReleaseCalls wraps the real local pin release; coordinatorPinReleaseCalls wraps sourcePins.releaseOperationPins(). startAndWait drives the real worker route/result seam, not a direct executor invocation. finishExecutor resolves a deferred executor only when a race test asks it to. triggerTerminalCleanup exposes the worker's actual cached release-promise seam for race assertions; it does not implement a second cleanup guard. finishRelease resolves the optional deferred real release, and readTerminal reads the worker's stored terminal result. cleanup waits for worker stop, releases any coordinator-owned pin once, and removes its temp root.

Create tests/cosmo23/query-operation-worker.test.cjs. Test that operationType, not `parameters.enablePGS`, chooses query versus PGS. For query require trusted parameters `{query,modelSelection:{provider,model}}`; flat `parameters.provider`/`parameters.model` are invalid. For PGS require:

~~~js
{
  query: 'question',
  pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
  pgsSynth: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
}
~~~

Table-test the complete trusted parameter projection. For Direct Query, assert the separate first argument is the exact `query` and options preserve only `mode`, bounded `topK`, exact `priorContext`, `enableSynthesis`, `includeOutputs`, `includeThoughts`, `includeCoordinatorInsights`, the resolved model pair, and access-derived `allowActions`. For PGS, assert the separate first argument is the exact `query` and options preserve only `mode`, `pgsMode:'full'`, exact `pgsConfig:{sweepFraction}`, exact independent sweep/synthesis pairs, `priorContext`, and access-derived `allowActions`. The executor also passes sourcePin, scratchDir, signal, reportEvent, mutationPolicy, and derived `enablePGS` without merging or inference. A read-only target always gets `allowActions:false` even if a forged trusted fixture asks for true. Unknown keys, wrong-operation keys, invalid enums/types/ranges, or partial pairs fail before QueryEngine/provider work. Use eight deterministic pending units and prove `sweepFraction:0.25` launches exactly two while `1.0` launches all eight; omission is exactly `1.0`, not a falsy/default coercion.

A PGS partial result stays:

~~~js
{
  state: 'partial',
  result: {
    answer: null,
    sweepOutputs: [
      { workUnitId: 'p1-u1', partitionId: 'p1', output: 'useful evidence',
        provider: 'minimax', model: 'MiniMax-M3' },
    ],
    metadata: { pgs: {
      successfulSweeps: 1,
      retryablePartitions: ['p2'],
      sweepFraction: 1,
      selectedWorkUnits: 2,
      pendingWorkUnits: 1,
    } },
    sourceEvidence: canonicalEvidence,
  },
  error: { code: 'provider_incomplete', message: 'truncated', retryable: true },
  sourceEvidence: canonicalEvidence,
  resultArtifact: null,
}
~~~

Preserve `result.sweepOutputs` byte-for-byte through the worker boundary. `result.metadata.pgs.successfulSweeps`, `selectedWorkUnits`, and `pendingWorkUnits` remain numeric counts, `sweepFraction` remains the exact validated value, and `retryablePartitions` remains the sorted unique retryable list; none replaces the output array or hides it in compatibility text.

Use a sentinel cancellation reason. createQueryOperationExecutor must reject with that exact object so BrainOperationWorker, the single terminal owner, can durably classify cancellation:

~~~js
const pending = executor(context);
controller.abort(reason);
await assert.rejects(pending, error => error === reason);
assert.equal(injectedPinReleaseCalls, 0);
~~~

- [ ] **Step 4: Write red lifecycle, canonical-pin, full-tree, and cleanup-race tests**

Extend tests/cosmo23/brain-operation-worker.test.cjs with the real harness. Cover complete, partial, failed, cancelled, synchronous executor throw, and orderly interrupted stop. Every terminal path releases the process-local pin exactly once; attachment detach releases neither process nor coordinator pin.

The worker pin layout test calls the prerequisite discoverOperationPinFiles(home23Root) while the executor is deferred and requires exactly one file at:

~~~text
instances/<requester>/runtime/brain-operations/<operationId>/pins/<processIdentity>/<canonical-root-hash>.json
~~~

After terminal cleanup the leaf file and empty process directory are absent. The worker calls openPinnedSource(descriptor,{operationRoot,lockRoot,processIdentity,expectedDigest,...}); tests reject any use of pinDirectory or an absent/recomputed/unbound digest. Before pin or scratch creation, it constructs/reconciles a process-local `OperationScratchQuota` handle from the same capability-bound operation root and 8-GiB maximum; the handle joins the coordinator's durable quota ledger and is placed in `OperationWorkerContext`. Table-test capability/durable/request mismatches for descriptor digest, `targetDomain`, each of the three target IDs, every required null field, canonicalRoot, requester, and operation type/ID; every mismatch fails before quota/pin open or executor work. A non-source authority row proves its executor receives `context.sourcePin === null`, `openPinnedSource` is never called, no `pins/` tree is created, cleanup remains a no-op, and a supplied descriptor/digest is rejected before executor work. Cover exact `owned-run` and `requester` tuples in addition to brain so the generic worker cannot regress while Task 5 changes it.

Add these memoized-release races:

~~~js
test('concurrent terminal paths share one release promise', async t => {
  const harness = await createProtectedWorkerHarness(t, {
    terminalState: 'complete', deferRelease: true,
  });
  await harness.startRequest(harness.validStartRequest());
  await harness.finishExecutor();
  const releases = Array.from({ length: 32 }, () => harness.triggerTerminalCleanup());
  assert.equal(new Set(releases).size, 1);
  await harness.finishRelease();
  await Promise.all(releases);
  assert.equal(harness.processPinReleaseCalls(), 1);
});

test('a failed release is shared and never retried', async t => {
  const releaseError = Object.assign(new Error('pin cleanup failed'), {
    code: 'source_cleanup_failed',
  });
  const harness = await createProtectedWorkerHarness(t, { releaseError });
  const results = Array.from({ length: 32 }, () => harness.triggerTerminalCleanup());
  await Promise.all(results.map(promise =>
    assert.rejects(promise, error => error === releaseError)));
  assert.equal(new Set(results).size, 1);
  assert.equal(harness.processPinReleaseCalls(), 1);
  assert.equal((await harness.readTerminal()).error.code, 'source_cleanup_failed');
});
~~~

The second case requires the worker to persist a typed cleanup failure/interrupted state rather than silently report complete while its reader pin may still be live.

Create tests/cosmo23/cross-brain-readonly.test.cjs using createProtectedReadOnlyFixture() from the shared helper plus createProtectedWorkerHarness(). Table-test `targetKind:'resident'` and `targetKind:'completed-research'`. Seed an unknown regular file, a nested directory, and an un-followed symlink. Take snapshotTreeNoFollow(targetRoot) before constructing the real QueryEngine/PGSEngine/worker and after complete, partial, failed, cancelled, and quota-failed query/PGS runs. The full target tree must be identical. This catches constructor writes, new cache/receipt/session/export files, unknown files, and symlink replacement. Assert every SQLite/retry/receipt file is under requester operation scratch.

Advance the source manifest after the coordinator pin but before resolving the deferred worker query. Assert both query and PGS observe only the captured canary/revision and sourcePin.isCurrent() becomes false. The test owns the coordinator pin; the real worker owns its local pin.

- [ ] **Step 5: Run worker/settings/resolver tests and record red**

Run:

~~~bash
node --test --test-concurrency=1 \
  tests/engine/dashboard/yaml-settings-store.test.js \
  tests/engine/dashboard/brain-operation-model-resolver.test.js \
  tests/engine/dashboard/brain-operation-coordinator.test.js \
  tests/dashboard/yaml-write-safety.test.js \
  tests/cosmo23/query-operation-worker.test.cjs \
  tests/cosmo23/brain-operation-worker.test.cjs \
  tests/cosmo23/cross-brain-readonly.test.cjs
~~~

Expected: FAIL because the settings store/model resolver/query-operation-worker are absent, the coordinator has no real resolver registration, the worker does not yet use digest-bound canonical operationRoot process pins in all paths, and cleanup is not a shared promise.

- [ ] **Step 6: Implement the executor without duplicating lifecycle ownership**

createQueryOperationExecutor validates query/PGS parameter shapes, rejects a missing sourcePin, and calls `executeEnhancedQuery(query, options)`. `context.parameters` is the prerequisite coordinator's trusted executor projection, not the durable caller `requestParameters`; the executor never rereads provider/model from raw request intent. It copies no arbitrary parameter object into options. Require an exact operation-specific key allowlist; validate nonempty query up to 12,000 characters, `mode`, exact nullable prior context up to 20,000 characters, strict booleans, safe-integer Query `topK` 1-100, PGS `pgsMode:'full'`, and exact PGS config whose optional finite `sweepFraction` is in `(0,1]`. Map only the declared fields:

~~~js
const options = {
  sourcePin: context.sourcePin,
  scratchDir: context.scratchDir,
  scratchQuota: context.scratchQuota,
  signal: context.signal,
  reportEvent: context.reportEvent,
  enablePGS: context.operationType === 'pgs',
  mode: context.parameters.mode,
  priorContext: context.parameters.priorContext,
  mutationPolicy: context.target.accessMode === 'own' ? 'own' : 'read-only',
  allowActions:
    context.target.accessMode === 'own' && context.parameters.allowActions === true,
  ...(context.operationType === 'query'
    ? {
        provider: context.parameters.modelSelection?.provider,
        model: context.parameters.modelSelection?.model,
        topK: context.parameters.topK,
        enableSynthesis: context.parameters.enableSynthesis === true,
        includeOutputs: context.parameters.includeOutputs === true,
        includeThoughts: context.parameters.includeThoughts === true,
        includeCoordinatorInsights: context.parameters.includeCoordinatorInsights === true,
      }
    : {
        pgsMode: context.parameters.pgsMode,
        pgsConfig: {
          sweepFraction: context.parameters.pgsConfig?.sweepFraction ?? 1.0,
        },
        pgsSweep: {
          provider: context.parameters.pgsSweep?.provider,
          model: context.parameters.pgsSweep?.model,
        },
        pgsSynth: {
          provider: context.parameters.pgsSynth?.provider,
          model: context.parameters.pgsSynth?.model,
        },
      }),
};
return executeEnhancedQuery(context.parameters.query, options);
~~~

The executor does not catch cancellation: if context.signal.aborted or a child throws that reason, rethrow context.signal.reason by identity. It maps ordinary complete/partial results to the standard envelope, attaches canonical sourcePin.getEvidence() after execution, and always returns resultArtifact:null. It never calls sourcePin.release(), sourcePins.releaseOperationPins(), or a target path constructor.

When forwarding child events, construct an explicit outer object. Never spread a child after type. Preserve child type only as childEventType.

- [ ] **Step 7: Make BrainOperationWorker own one memoized release promise**

Modify cosmo23/server/lib/brain-operation-worker.js, not merely the new executor. Replace every boolean release-once helper with:

~~~js
function createReleaseProcessResources(sourcePin, scratchQuota) {
  let releasePromise;
  return function releaseProcessResourcesOnce() {
    if (!releasePromise) {
      releasePromise = Promise.resolve()
        .then(() => sourcePin?.release())
        .then(() => scratchQuota?.close());
    }
    return releasePromise;
  };
}
~~~

Create the closure immediately after the quota/local pin is opened and store the returned promise on the in-flight record. Complete, partial, failed, cancelled, synchronous throw, failed start after quota/pin open, and orderly stop all await the same releaseProcessResourcesOnce(). It closes SQLite/source readers first, then the process pin, then the quota handle; it never deletes the durable quota ledger or coordinator pin. Attachment detach calls none of these release paths. A release rejection is not retried; every waiter observes the same rejection, and terminalization records source_cleanup_failed (or interrupted during orderly stop) before exposing a false success.

Open source pins only through:

~~~js
sourcePins.openPinnedSource(descriptor, {
  operationRoot,
  lockRoot: path.join(home23Root, 'runtime', 'brain-source-locks'),
  processIdentity,
  operationId,
  requesterAgent,
  expectedCanonicalRoot,
  expectedRevision,
  expectedDigest: verifiedCapability.sourcePinDigest,
  identity,
  scratchQuota,
  signal,
});
~~~

Immediately before this call, require `sourceDescriptorDigest(descriptor) === verifiedCapability.sourcePinDigest === durableRecord.sourcePinDigest`, require the descriptor summary/count/revision/root to equal the durable record, and compare the complete verified targetDomain/ID/root tuple with fresh canonical metadata. The worker never derives or passes pinDirectory. Global discovery and retirement therefore see the pin.

- [ ] **Step 8: Register the executor and retain compatibility routes**

In `engine/src/dashboard/server.js`, load the catalog through `cosmo23/server/config/model-catalog.js`, provider settings from canonical `config/home.yaml` plus `config/secrets.yaml`, and Codex credentials only through `cosmo23/engine/src/services/codex-oauth-engine.getCodexCredentials({signal})`. Pass those dependencies to Task 2 `createBuiltInPairFactories()`/`createBrainProviderClientRegistry()` to create the one dashboard process-local exact-pair registry. Complete pair migration through `createYamlSettingsStore()`, create the one `operationModelResolver`, and inject it into the existing BrainOperationCoordinator before enabling query/PGS authority rows. Do not register a placeholder seam. If config migration or any configured default pair is invalid/unavailable, publish typed readiness false and reject query/PGS before `store.create()`; unrelated dashboard routes remain healthy.

In `cosmo23/server/index.js`, create the one COSMO process-local exact-pair registry from the same canonical readers, the one startup processIdentity, and use the prerequisite catalog/capability/nonce/sourcePins instances to register one queryOperationExecutor under query and pgs. The executor and QueryEngine receive this registry; Codex/xAI/Chat compatibility paths do not construct alternate clients. Do not construct a second target resolver, capability validator, catalog, requester-specific source provider, or model-name router.

Compatibility /query and /query/stream canonicalize to a durable operation, resolve provider only if an omitted provider has exactly one model match, write the resolved exact pair to trusted `parameters.modelSelection`, and attach to it while retaining their response shape. They cannot supply raw source paths, descriptor fields, scratchDir, requester identity, idempotency key, pgsSweep provider/model shortcuts, or pgsSynth shortcuts.

When the durable idempotency precheck finds an existing record, these adapters return/attach to it before target, catalog, or model resolution and do not reread changed defaults, repin, rebuild a provider selection, or start an executor. If simultaneous contenders all miss that precheck, each may call the pure resolver once before `store.create()`; every `{created:false}` loser returns the winner's durable record and performs no post-create side effect. Server-resolved provider/model values live only in trusted parameters and are excluded from the authority plan's idempotency projection. The Task 5 coordinator test uses spies to prove the exact paths: sole owner `sanitize/precheck-miss/target/authorize/resolve/create(created:true)/pin/attach-digest/capability/worker`; lost-response duplicate `sanitize/precheck-hit/return`; and concurrent loser `sanitize/precheck-miss/target/authorize/resolve/create(created:false)/return`.

- [ ] **Step 9: Run focused tests and commit Task 5 paths**

Run:

~~~bash
node --test --test-concurrency=1 \
  tests/engine/dashboard/yaml-settings-store.test.js \
  tests/engine/dashboard/brain-operation-model-resolver.test.js \
  tests/engine/dashboard/brain-operation-coordinator.test.js \
  tests/dashboard/yaml-write-safety.test.js \
  tests/cosmo23/query-operation-worker.test.cjs \
  tests/cosmo23/brain-operation-worker.test.cjs \
  tests/cosmo23/cross-brain-readonly.test.cjs \
  tests/cosmo23/query-engine-runtime.test.cjs \
  tests/cosmo23/query-engine-context.test.cjs \
  tests/cosmo23/pgs-engine.test.cjs
~~~

Expected: all listed tests PASS.

~~~bash
git add -- config/home.yaml.example \
  engine/src/dashboard/yaml-settings-store.js \
  engine/src/dashboard/yaml-write-safety.js \
  engine/src/dashboard/home23-settings-api.js \
  engine/src/dashboard/brain-operations/operation-model-resolver.js \
  engine/src/dashboard/server.js \
  cosmo23/server/lib/query-operation-worker.js \
  cosmo23/server/lib/brain-operation-worker.js \
  cosmo23/server/lib/brain-operation-routes.js \
  cosmo23/server/index.js \
  tests/cosmo23/helpers/brain-operation-fixtures.cjs \
  tests/cosmo23/query-operation-worker.test.cjs \
  tests/cosmo23/cross-brain-readonly.test.cjs \
  tests/cosmo23/brain-operation-worker.test.cjs \
  tests/engine/dashboard/yaml-settings-store.test.js \
  tests/engine/dashboard/brain-operation-model-resolver.test.js \
  tests/engine/dashboard/brain-operation-coordinator.test.js \
  tests/dashboard/yaml-write-safety.test.js
git diff --cached --check
git diff --cached -- \
  config/home.yaml.example \
  engine/src/dashboard/yaml-settings-store.js \
  engine/src/dashboard/yaml-write-safety.js \
  engine/src/dashboard/home23-settings-api.js \
  engine/src/dashboard/brain-operations/operation-model-resolver.js \
  engine/src/dashboard/server.js \
  cosmo23/server/lib/query-operation-worker.js \
  cosmo23/server/lib/brain-operation-worker.js \
  cosmo23/server/lib/brain-operation-routes.js \
  cosmo23/server/index.js \
  tests/cosmo23/helpers/brain-operation-fixtures.cjs \
  tests/cosmo23/query-operation-worker.test.cjs \
  tests/cosmo23/cross-brain-readonly.test.cjs \
  tests/cosmo23/brain-operation-worker.test.cjs \
  tests/engine/dashboard/yaml-settings-store.test.js \
  tests/engine/dashboard/brain-operation-model-resolver.test.js \
  tests/engine/dashboard/brain-operation-coordinator.test.js \
  tests/dashboard/yaml-write-safety.test.js
git commit --only \
  config/home.yaml.example \
  engine/src/dashboard/yaml-settings-store.js \
  engine/src/dashboard/yaml-write-safety.js \
  engine/src/dashboard/home23-settings-api.js \
  engine/src/dashboard/brain-operations/operation-model-resolver.js \
  engine/src/dashboard/server.js \
  cosmo23/server/lib/query-operation-worker.js \
  cosmo23/server/lib/brain-operation-worker.js \
  cosmo23/server/lib/brain-operation-routes.js \
  cosmo23/server/index.js \
  tests/cosmo23/helpers/brain-operation-fixtures.cjs \
  tests/cosmo23/query-operation-worker.test.cjs \
  tests/cosmo23/cross-brain-readonly.test.cjs \
  tests/cosmo23/brain-operation-worker.test.cjs \
  tests/engine/dashboard/yaml-settings-store.test.js \
  tests/engine/dashboard/brain-operation-model-resolver.test.js \
  tests/engine/dashboard/brain-operation-coordinator.test.js \
  tests/dashboard/yaml-write-safety.test.js \
  -m "feat: run brain queries as protected operations"
~~~

### Task 6: Make Resident Synthesis a Durable Source-CAS Operation

**Files:**
- Modify: config/home.yaml.example
- Create: engine/src/synthesis/provider-registry.js
- Modify: engine/src/synthesis/synthesis-agent.js
- Create: engine/src/dashboard/brain-operations/synthesis-worker.js
- Modify: engine/src/dashboard/server.js
- Modify: engine/src/circulatory/synthesis-trigger.js
- Rename: tests/engine/synthesis/synthesis-agent.test.cjs to tests/engine/synthesis/synthesis-agent.test.js
- Create: tests/engine/synthesis/synthesis-provider-registry.test.js
- Create: tests/engine/dashboard/brain-synthesis-operation.test.js

**Interfaces:**
- Consumes: canonical model catalog, Task 2 `brainProviderClientRegistry`, Task 5 locked/CAS YAML settings store, canonical home config, Dashboard BrainOperationCoordinator, own-brain source pin with bounded scalar descriptor summary, and AbortSignal.
- Produces: resolveSynthesisConfig(), createSynthesisProviderAdapter(), SynthesisAgent.runOperation(), createSynthesisWorker(), readiness state, durable manual/scheduled operation IDs, and a restart-stable `generationMarker` result/state lookup.

The canonical fresh-install config is:

~~~yaml
synthesis:
  provider: minimax
  model: MiniMax-M3
  intervalHours: 4
~~~

provider and model are a required pair after migration. New environment overrides set both SYNTHESIS_LLM_PROVIDER and SYNTHESIS_LLM_MODEL. The old model-only environment/config form remains compatibility input only and resolves when exactly one catalog provider owns that model ID; provider-only input is always invalid. Ambiguous or absent legacy models block synthesis readiness; they never fall back to Ollama, a base URL heuristic, or a model-name heuristic.

- [ ] **Step 1: Rename the existing test and write red config/registry tests**

Retain every existing synthesis-agent assertion while converting the renamed file to the repository's ESM test pattern.

Create tests/engine/synthesis/synthesis-provider-registry.test.js. Cover:

- fresh config resolves exactly minimax/MiniMax-M3;
- explicit provider/model resolves the exact catalog row and provider client;
- model-only legacy config migrates only when exactly one provider owns it;
- duplicate model IDs produce model_ambiguous;
- provider-only config/env produces synthesis_config_invalid, while model-only legacy input migrates only when unique;
- missing model, unavailable provider client, invalid maxOutputTokens, and invalid providerStallMs fail before provider work;
- saved custom providers follow Task 1 catalog validation;
- the returned normalized config includes migratedFromModelOnly and needsPersistence so the settings layer can save the explicit pair;
- the returned client is the exact Task 2 pair-registry client, not a raw root-engine OpenAI/Anthropic/UnifiedClient path; and
- a controlled real MiniMax-compatible normalized adapter observes the exact AbortSignal, catalog maxOutputTokens, terminal event validation, fixed provider identity, and provider activity callback.

The registry contract is exact:

~~~js
const resolved = resolveSynthesisConfig({
  homeConfig,
  env,
  modelCatalog,
  providerRegistry,
});
assert.deepEqual(resolved.selection, {
  provider: 'minimax',
  model: 'MiniMax-M3',
});
assert.deepEqual(resolved.capabilities, {
  maxOutputTokens: 32768,
  providerStallMs: 900000,
});
assert.equal(resolved.client.generate instanceof Function, true);
~~~

When needsPersistence is true, Dashboard startup calls Task 5's `createYamlSettingsStore(...).update()` under its external lock/CAS to replace the legacy model-only shape with the explicit pair. Race this migration with a settings-route update and prove both survive. If persistence fails or loses a CAS race after bounded retry, synthesis readiness is false and no synthesis operation starts; dashboard health and unrelated routes remain available.

- [ ] **Step 2: Write red source-CAS, exact cancellation, event, route, and schedule tests**

In tests/engine/synthesis/synthesis-agent.test.js, use `createCommittedMemoryFixture(t,{targetAgent:'jerry',requesterAgent:'jerry'})` so the source is the requester's canonical `instances/jerry/brain` and its identity/index inputs are the fixture's canonical `instances/jerry/workspace/{SOUL.md,MISSION.md,BRAIN_INDEX.md}`. Use that real prerequisite source for the CAS race: pin revision N, append N+1 immediately before compareAndSwap(), and assert source_changed with no brain-state write.

Add exact/one-byte-over cases for the 8 MiB prompt, 2 MiB provider output, and 4 MiB canonical brain-state ceilings from `SYNTHESIS_OPERATION_LIMITS`. Oversized identity/index files fail from lstat/bounded-read before allocation/provider work; aggregate search/prompt overflow makes zero provider calls; provider output overflow occurs before JSON parse/CAS; brain-state overflow occurs before durable write. Every overflow is nonretryable `result_too_large`, publishes no marker, and leaves the prior brain-state byte-identical.

Use sentinel cancellation identity at source summarize, each searchKeyword call, provider stream, provider completion validation, JSON extraction boundary, and compare-and-swap boundary:

~~~js
controller.abort(reason);
await assert.rejects(pending, error => error === reason);
assert.equal(injectedPinReleaseCalls, 0);
~~~

SynthesisAgent never closes an injected pin. It checks signal.aborted before and after each awaited source/provider/CAS step and rethrows signal.reason exactly.

Require provider_selected before the provider call:

~~~js
{
  type: 'provider_selected',
  phase: 'synthesis',
  provider: 'minimax',
  model: 'MiniMax-M3',
  providerStallMs: 900000,
  providerCallId: 'synthesis',
  sourceRevision: 51,
}
~~~

Provider activity uses childEventType and explicit fields; a child type cannot overwrite the outer type.

Create tests/engine/dashboard/brain-synthesis-operation.test.js proving:

- only operationType synthesis with target.accessMode own is accepted;
- parameters provider/model must equal the server-resolved pair;
- read-only target, body override, or worker mismatch fails before provider work;
- complete, access-denied, and provider-failure worker results all use the standard envelope with `resultArtifact:null`;
- complete returns exact `result:{generationMarker,generatedAt,sourceRevision,provider,model,operationId,brainStateSha256}`, and failed/cancelled/source_changed returns no generation marker;
- POST /api/synthesis/run returns 202 with {operationId,state:'queued'};
- GET `/api/synthesis/state` accepts either no query or exactly one nonempty UTF-8 `generationMarker` of at most 256 bytes and returns readiness, requester-authenticated latest/active operation summaries, `requestedGenerationMarker`, authoritative `currentGenerationMarker`, and `markerStatus:'unrequested'|'matched'|'changed'|'absent'`;
- while synthesis is active, state continues to report only the last durably committed current marker; a completed synthesis publishes its exact result marker atomically with brain-state, whereas failed, cancelled, interrupted, and `source_changed` operations publish no marker and cannot make a stale requested marker appear matched;
- after dashboard/coordinator restart, the route rebuilds latest/active from the durable requester store, rereads the authoritative brain-state marker, and preserves the same matched/changed/absent answer without starting synthesis;
- restart reconciliation marks in-process synthesis interrupted;
- cancellation reaches the exact agent/provider signal reason;
- scheduled startup and interval callbacks call the same coordinator start function with deterministic request ID synthesis:<UTC-hour-bucket>;
- a rejected scheduled start is awaited/caught, logged once, and recorded as the operation's failed/interrupted state without unhandledRejection;
- readiness false rejects manual and scheduled starts with synthesis_unavailable while dashboard remains healthy.

Capture process.once('unhandledRejection') in the scheduled rejection test and assert it is never called after fake timers drain.

- [ ] **Step 3: Run the synthesis tests and record red**

Run:

~~~bash
node --test --test-concurrency=1 \
  tests/engine/dashboard/yaml-settings-store.test.js \
  tests/engine/dashboard/brain-operation-model-resolver.test.js \
  tests/engine/dashboard/brain-operation-coordinator.test.js \
  tests/dashboard/yaml-write-safety.test.js \
  tests/engine/synthesis/synthesis-provider-registry.test.js \
  tests/engine/synthesis/synthesis-agent.test.js \
  tests/engine/dashboard/brain-synthesis-operation.test.js
~~~

Expected: FAIL because the registry, durable worker, exact config pair, and source-CAS operation do not exist.

- [ ] **Step 4: Implement the canonical synthesis registry and migration**

Create engine/src/synthesis/provider-registry.js. It imports strict getModelCapabilities() and consumes the exact Task 2 `brainProviderClientRegistry` instance created by dashboard startup; it does not import or construct the root-engine raw GPT/OpenAI/Anthropic/UnifiedClient classes, and it never creates clients from baseURL/model guesses. The controlled-adapter test must cross the real Task 2 normalized MiniMax/Anthropic-compatible adapter before it reaches `createSynthesisProviderAdapter`, so a stub-only registry cannot satisfy this task.

~~~js
function typed(code, message, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

function positiveInterval(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 24 * 30) {
    throw typed('synthesis_config_invalid', 'intervalHours must be greater than 0 and no more than 720');
  }
  return number;
}

function resolveSynthesisConfig({
  homeConfig, env = process.env, modelCatalog, providerRegistry,
}) {
  const configured = homeConfig.synthesis || {};
  const envHasProvider = Boolean(env.SYNTHESIS_LLM_PROVIDER);
  const envHasModel = Boolean(env.SYNTHESIS_LLM_MODEL);
  if (envHasProvider && !envHasModel) {
    throw typed('synthesis_config_invalid',
      'SYNTHESIS_LLM_PROVIDER requires SYNTHESIS_LLM_MODEL');
  }

  let provider = envHasModel ? (env.SYNTHESIS_LLM_PROVIDER || null) : configured.provider;
  let model = envHasModel ? env.SYNTHESIS_LLM_MODEL : configured.model;
  let migratedFromModelOnly = false;

  if (!provider && model) {
    const matches = flattenCatalogModels(modelCatalog)
      .filter(row => row.kind === 'chat' && row.id === model);
    if (matches.length !== 1) {
      throw typed(matches.length > 1 ? 'model_ambiguous' : 'model_not_found',
        'Legacy synthesis model does not resolve uniquely');
    }
    provider = matches[0].provider;
    migratedFromModelOnly = true;
  }
  if (!provider && !model) {
    provider = 'minimax';
    model = 'MiniMax-M3';
  }
  if (!provider || !model) {
    throw typed('synthesis_config_invalid', 'Synthesis provider and model are required');
  }

  const capabilities = getModelCapabilities(modelCatalog, provider, model);
  const client = providerRegistry.assertPairAvailable(provider, model);
  return {
    selection: { provider, model },
    capabilities,
    client,
    intervalHours: positiveInterval(configured.intervalHours ?? 4),
    migratedFromModelOnly,
    needsPersistence: !envHasModel && (migratedFromModelOnly ||
      configured.provider !== provider || configured.model !== model),
  };
}
~~~

Export resolveSynthesisConfig and createSynthesisProviderAdapter. The adapter closes over the exact pair/client/capabilities, forwards model, maxOutputTokens, signal, and onProviderActivity, and revalidates the returned envelope with requireCompleteProviderResult(). It does not accept a per-call provider or alternate model.

Dashboard startup resolves this before registering the synthesis worker. It publishes readiness as:

~~~js
{
  ready: true,
  provider: selection.provider,
  model: selection.model,
  providerStallMs: capabilities.providerStallMs,
  error: null,
}
~~~

A typed registry/config failure produces {ready:false,provider:null,model:null,error:{code,message}}. It does not crash the dashboard, but manual/scheduled synthesis start rejects with synthesis_unavailable and the typed cause. Migration persistence occurs through Task 5's locked/CAS settings store before ready becomes true.

- [ ] **Step 5: Implement pinned synthesis and compare-and-swap**

SynthesisAgent.runOperation({operationId,trigger,sourcePin,signal,onEvent}):

1. validates operationId and sourcePin;
2. lstat-validates and bounded-reads identity/index files that belong to the same own agent, rejecting symlinks and any input that would exceed the 8 MiB prompt ceiling before whole-file allocation;
3. obtains scalar stats from sourcePin.summarize({signal}) and requires them to equal the descriptor's bounded safe-integer summary without rescanning either iterator merely to count;
4. runs at most eight sourcePin.searchKeyword(theme,{topK:3,signal}) calls;
5. emits provider_selected with phase synthesis and the registry capabilities;
6. builds the prompt through a UTF-8 byte-counting writer capped at 8 MiB and calls the fixed adapter with the same signal;
7. calls requireCompleteProviderResult() even when the adapter returns status:complete;
8. rejects provider content over 2 MiB before parsing the complete JSON object;
9. captures one generatedAt, builds brain-state with operationId, numeric sourceRevision, provider, model, duration, and parsed synthesis;
10. derives `generationMarker = 'generation-' + sourceRevision + '-' + sha256(operationId + '\0' + generatedAt + '\0' + provider + '\0' + model).slice(0,24)`;
11. adds that marker, computes `brainStateSha256:'sha256:<64 lowercase hex>'` over canonical JSON of the complete state excluding only the hash field itself, and adds the hash;
12. rejects canonical brain-state over 4 MiB; and
13. writes the complete state only inside `sourcePin.compareAndSwap(() => writeFileDurable(...))`, then returns exactly `{generationMarker,generatedAt,sourceRevision,provider,model,operationId,brainStateSha256}`.

Check and rethrow exact cancellation before and after each step. `generationMarker` is never emitted or returned before the durable CAS succeeds. If CAS reports committed:false, throw source_changed and do not overwrite state or expose the prospective marker. Ordinary incomplete/failed completion remains a typed ProviderCompletionError. Neither runOperation nor createSynthesisWorker releases sourcePin. Tests recompute the hash/marker, reload brain-state, restart the dashboard, and require byte-identical result fields.

Emit provider activity safely:

~~~js
onEvent({
  type: 'provider_activity',
  phase: 'synthesis',
  provider: selection.provider,
  model: selection.model,
  providerCallId: 'synthesis',
  childEventType: child?.type || 'provider_event',
  providerEventAt: typeof child?.at === 'string' && child.at.length <= 128 ? child.at : null,
  sourceRevision: sourcePin.revision,
});
~~~

The selected event uses the same `providerCallId:'synthesis'`. `providerEventAt` remains bounded diagnostic data; local injected clocks alone drive idle age and coordinator renewal. Wrap the fixed-adapter await in `try/catch/finally`; preserve exact cancellation and ordinary provider errors, and emit one matching `{type:'provider_call_terminal',phase:'synthesis',provider,model,providerCallId:'synthesis',outcome}` in `finally`. Focused tests defer the adapter, assert the worker status reports that active singleton, feed skewed/malformed child timestamps, emit one activity event, and prove local idle timing plus complete, failure, and cancellation removal through the exact terminal event.

- [ ] **Step 6: Register the durable worker and make schedules rejection-safe**

createSynthesisWorker accepts only `target.domain:'brain'`, own-brain synthesis, and the server-derived provider/model pair. On success it returns the exact runOperation result above in a standard complete envelope with resultArtifact:null. Typed failures expose no result/generation marker; exact cancellation is rethrown to the common worker terminalizer instead of manufacturing a different Error.

Dashboard registers synthesis on the same BrainOperationWorkerAdapter instance used by BrainOperationCoordinator. POST /api/synthesis/run ignores/rejects body provider, model, idempotencyKey, source path, descriptor, requester, and scratch fields. It uses a server request ID and returns the coordinator operation ID.

GET `/api/synthesis/state` is read-only and never calls coordinator start. Reject arrays, duplicate/unknown query keys, empty/whitespace/NUL markers, or a marker over 256 UTF-8 bytes as `invalid_request`. Bind operation reads to the dashboard requester and return only bounded summaries. Read `currentGenerationMarker` from the durably committed own-brain state, not from an active worker event or caller input. Its exact response is:

~~~js
{
  ready: true,
  requestedGenerationMarker: requested || null,
  currentGenerationMarker: committedMarker || null,
  markerStatus: !requested ? 'unrequested'
    : !committedMarker ? 'absent'
    : requested === committedMarker ? 'matched' : 'changed',
  latestOperation: latestAuthorizedSummary || null,
  activeOperation: activeAuthorizedSummary || null,
}
~~~

An active operation never exposes a prospective marker. A complete operation may expose `result.generationMarker` only after the source compare-and-swap and durable brain-state write commit; that marker must equal `currentGenerationMarker`. Failed, partial, cancelled, interrupted, and especially `source_changed` records have no published result marker and leave the prior current marker unchanged. Restart tests recreate the dashboard/coordinator over the same operation store and brain-state file, then prove a stale marker remains `changed`, the committed marker remains `matched`, an absent state is `absent`, an interrupted prior active operation is not reported active, and every state read causes zero pin/provider/start calls.

The route stores trigger as normalized caller `requestParameters`; the configured synthesis pair is injected only into trusted executor `parameters`. It does not contribute to the authority plan's idempotency hash. If coordinator store creation returns created:false, the route returns/attaches to that existing operation without opening a second pin or launching synthesis.

SynthesisAgent.run() becomes only a coordinator-start compatibility wrapper; it never performs old HTTP brain search/provider work and never returns swallowed null.

Both start-on-boot and interval scheduling use an awaited helper:

~~~js
async function startScheduledSynthesis(trigger, now = clock()) {
  const bucket = now.toISOString().slice(0, 13);
  try {
    return await startSynthesisOperation({
      requestId: 'synthesis:' + bucket,
      requestParameters: { trigger },
    });
  } catch (error) {
    logger.error('[synthesis] scheduled start failed', {
      code: error.code || 'synthesis_failed',
      message: error.message,
      requestId: 'synthesis:' + bucket,
    });
    await recordScheduledStartFailure(error, { requestId: 'synthesis:' + bucket });
    return null;
  }
}
~~~

Timer callbacks call void startScheduledSynthesis(...), where the helper itself contains the complete catch shown above. synthesis-trigger.js awaits run() and propagates ordinary caller-visible rejection; it does not add another fire-and-forget chain. Cancellation is already durable through the coordinator and is not logged as a provider failure.

- [ ] **Step 7: Run focused tests and commit Task 6 paths**

Run:

~~~bash
node --test --test-concurrency=1 \
  tests/engine/synthesis/synthesis-provider-registry.test.js \
  tests/engine/synthesis/synthesis-agent.test.js \
  tests/engine/dashboard/brain-synthesis-operation.test.js \
  tests/engine/dashboard/runtime-health.test.js
~~~

Expected: all listed tests PASS; no live provider or real timer is used.

~~~bash
git add -- config/home.yaml.example \
  engine/src/synthesis/provider-registry.js \
  engine/src/synthesis/synthesis-agent.js \
  engine/src/dashboard/brain-operations/synthesis-worker.js \
  engine/src/dashboard/server.js \
  engine/src/circulatory/synthesis-trigger.js \
  tests/engine/synthesis/synthesis-agent.test.js \
  tests/engine/synthesis/synthesis-agent.test.cjs \
  tests/engine/synthesis/synthesis-provider-registry.test.js \
  tests/engine/dashboard/brain-synthesis-operation.test.js
git diff --cached --check
git diff --cached -- \
  config/home.yaml.example \
  engine/src/synthesis/provider-registry.js \
  engine/src/synthesis/synthesis-agent.js \
  engine/src/dashboard/brain-operations/synthesis-worker.js \
  engine/src/dashboard/server.js \
  engine/src/circulatory/synthesis-trigger.js \
  tests/engine/synthesis/synthesis-agent.test.js \
  tests/engine/synthesis/synthesis-agent.test.cjs \
  tests/engine/synthesis/synthesis-provider-registry.test.js \
  tests/engine/dashboard/brain-synthesis-operation.test.js
git commit --only \
  config/home.yaml.example \
  engine/src/synthesis/provider-registry.js \
  engine/src/synthesis/synthesis-agent.js \
  engine/src/dashboard/brain-operations/synthesis-worker.js \
  engine/src/dashboard/server.js \
  engine/src/circulatory/synthesis-trigger.js \
  tests/engine/synthesis/synthesis-agent.test.js \
  tests/engine/synthesis/synthesis-agent.test.cjs \
  tests/engine/synthesis/synthesis-provider-registry.test.js \
  tests/engine/dashboard/brain-synthesis-operation.test.js \
  -m "feat: make brain synthesis a durable operation"
~~~

### Task 7: Offline Regression and Vendored Record

**Files:**
- Modify: `docs/design/COSMO23-VENDORED-PATCHES.md`
- Modify: `docs/superpowers/plans/2026-07-09-brain-provider-execution.md`

**Interfaces:**
- Consumes: Completed Tasks 1-6 and prerequisite authority, coordinator, target, and memory-source suites.
- Produces: One documented vendored patch entry and an offline provider-execution checkpoint. This task never starts/stops/reloads PM2, calls localhost/live routes, invokes a real provider, mutates a live brain, or claims live acceptance/design completion.

- [ ] **Step 1: Run the complete focused provider-execution suite**

```bash
node --test --test-concurrency=1 \
  tests/cosmo23/provider-completion.test.cjs \
  tests/cosmo23/gpt5-client-stream.test.cjs \
  tests/cosmo23/chat-completions-terminal.test.cjs \
  tests/cosmo23/codex-responses-client.test.cjs \
  tests/cosmo23/brain-provider-client-registry.test.cjs \
  tests/cosmo23/anthropic-client-request.test.cjs \
  tests/cosmo23/pinned-query-projection.test.cjs \
  tests/cosmo23/query-engine-source-pin.test.cjs \
  tests/cosmo23/query-engine-mutation-boundary.test.cjs \
  tests/cosmo23/query-engine-runtime.test.cjs \
  tests/cosmo23/query-engine-context.test.cjs \
  tests/cosmo23/pgs-engine.test.cjs \
  tests/cosmo23/pinned-pgs-store.test.cjs \
  tests/cosmo23/pgs-source-pin.test.cjs \
  tests/cosmo23/pgs-retry-state.test.cjs \
  tests/cosmo23/pgs-cancellation.test.cjs \
  tests/cosmo23/brain-operation-worker.test.cjs \
  tests/cosmo23/cross-brain-readonly.test.cjs \
  tests/cosmo23/query-operation-worker.test.cjs

node --test --test-concurrency=1 \
  tests/engine/dashboard/yaml-settings-store.test.js \
  tests/engine/dashboard/brain-operation-model-resolver.test.js \
  tests/engine/dashboard/brain-operation-coordinator.test.js \
  tests/dashboard/yaml-write-safety.test.js \
  tests/engine/synthesis/synthesis-provider-registry.test.js \
  tests/engine/synthesis/synthesis-agent.test.js \
  tests/engine/dashboard/brain-synthesis-operation.test.js \
  tests/engine/dashboard/runtime-health.test.js

npm --prefix cosmo23/pgs-engine test
npm --prefix cosmo23/engine run test:unit
node -e "const p=require('./cosmo23/pgs-engine/package.json'); if(p.dependencies?.['better-sqlite3']!=='^11.0.0') process.exit(1)"
npm --prefix cosmo23/pgs-engine pack --dry-run
```

Expected: every listed Node test and package-local engine/PGS test PASS; the standalone PGS manifest/lock/pack includes its runtime SQLite dependency and both legacy/pinned APIs; no test accesses an external provider or waits on production-duration timers.

Run both synthetic heap probes in fresh child processes so prior tests cannot hide retained memory:

```bash
node --expose-gc tests/cosmo23/query-engine-heap-probe.cjs
node --expose-gc tests/cosmo23/pgs-heap-probe.cjs
```

Expected: query reports peak heap delta <=192 MiB and RSS delta <=256 MiB; PGS reports peak heap delta <=256 MiB and RSS delta <=384 MiB; both scan 1,000,000 nodes plus 3,000,000 edges without calling a full materializer and execute through controlled provider plus terminal-result assembly. Their recorded record/projection/prompt/DB/WAL/SHM/sweep/synthesis/result byte peaks stay within the exact reviewed ceilings, and every one-byte-over adversarial child exits with typed `result_too_large` before a later boundary call.

- [ ] **Step 2: Run mutation-boundary integration tests from the prerequisite plans**

```bash
node --test --test-concurrency=1 \
  tests/cosmo23/brain-operation-worker.test.cjs \
  tests/cosmo23/cross-brain-readonly.test.cjs \
  tests/engine/dashboard/brain-operation-model-resolver.test.js \
  tests/engine/dashboard/brain-operation-coordinator.test.js \
  tests/shared/memory-source-pin.test.js
```

Expected: all tests PASS. The worker proves the complete `targetDomain`/exact-one-ID/root tuple and durable/capability/descriptor digest before opening. The mutation-boundary test uses lstat-based full-tree hashing with no allowlist or exclusion, snapshots resident and completed-research targets before engine construction, and proves every target file, directory, unknown entry, and symlink is identical after cross-brain direct Query and PGS; only requester operation scratch may change.

- [ ] **Step 3: Run build and repository-wide tests**

```bash
npm run build
npm test
npm run test:contracts
```

Expected: all commands exit 0.

- [ ] **Step 4: Record the vendored COSMO patch**

Append one dated patch entry to `docs/design/COSMO23-VENDORED-PATCHES.md` naming these exact behaviors:

```markdown
## Patch 49 — Durable, terminal-honest brain provider execution (2026-07-09)

Provider streams now require a valid terminal event and normal finish reason,
propagate exact cancellation, and expose real provider activity separately from
operation heartbeats. Direct query uses a bounded streaming projection; PGS uses
a revision-bound requester-scratch SQLite projection, bounded work units, and
hard record/scratch/WAL/output/synthesis/result byte quotas. Every source open
binds the durable descriptor digest and complete capability target-domain tuple.
Cross-brain work never writes to the target. Failed final PGS synthesis preserves
machine-readable successful sweeps as partial, while failed/cancelled work stays
retryable and selected failures cannot report complete. Query/PGS defaults use
server-resolved exact provider/model pairs through one normalized registry.
Home23 synthesis uses that registry, a locked/CAS config migration, an own-brain
source-revision compare-and-swap, and a durable generation marker.
```

List every touched `cosmo23/` file and the exact focused commands from Step 1.

- [ ] **Step 5: Record the provider-only offline checkpoint**

Change no checklist item to complete until its command has been run and its expected result observed. After the provider, mutation-boundary, build, and repository suites above have passed, add this provider-plan-local checkpoint:

```markdown
## Provider Execution Checkpoint

- Focused provider/PGS/worker suite: PASS
- Focused synthesis/coordinator suite: PASS
- Cross-brain mutation-boundary suite: PASS
- `npm run build`: PASS
- `npm test`: PASS
- `npm run test:contracts`: PASS
```

This checkpoint is offline evidence for the provider lane only. Do not create, require, or update the cross-plan final receipt, live-acceptance result, or design-spec status here. The integrated agent rollout plan owns live PM2/tool acceptance, the final receipt, and the final design-spec status after all lanes have landed together.

**Live rollout handoff (requirements only; do not execute or mark PASS in this plan):** the integrated rollout must capture baseline COSMO/dashboard PID, PM2 restart count, RSS, and heap; issue one bounded query canary and one scoped PGS canary against the same pinned revision; sample both processes every five seconds through terminal result; and retain operation/provider events. Acceptance requires no dashboard/COSMO restart, Query COSMO peak RSS delta <=256 MiB, PGS COSMO peak RSS delta <=384 MiB, no target-tree hash change, terminal source evidence matching the pinned revision, and RSS returning within 20% of baseline within five minutes. If the deployed PM2 memory ceiling is lower than either delta allowance, the ceiling is authoritative. Those observations belong in the integrated live receipt, never in this provider plan.

- [ ] **Step 6: Commit only documentation paths**

```bash
git add -- docs/design/COSMO23-VENDORED-PATCHES.md \
  docs/superpowers/plans/2026-07-09-brain-provider-execution.md
git diff --cached --check
git diff --cached -- \
  docs/design/COSMO23-VENDORED-PATCHES.md \
  docs/superpowers/plans/2026-07-09-brain-provider-execution.md
git commit --only \
  docs/design/COSMO23-VENDORED-PATCHES.md \
  docs/superpowers/plans/2026-07-09-brain-provider-execution.md \
  -m "docs: record brain provider execution hardening"
```

## Self-Review Checklist

- [ ] Every provider path requires a terminal event and normal finish reason.
- [ ] Every selectable provider/model has validated positive `maxOutputTokens` and `providerStallMs`; missing, invalid, or ambiguous selection is rejected before provider work.
- [ ] Present invalid/custom catalogs fail closed; valid custom rows round-trip atomically and no load silently substitutes built-ins.
- [ ] Query accepts only optional `modelSelection`, PGS only optional nested `pgsSweep`/`pgsSynth`; the real registered resolver injects exact server pairs before create and preserves durable pairs across config drift/lost responses.
- [ ] GPT Responses, Chat Completions, Anthropic, MiniMax, xAI-compatible, Ollama-compatible, and Codex raw SSE paths propagate `AbortSignal`.
- [ ] Every production provider client has fixed instance identity; xAI never reports OpenAI, MiniMax never reports Anthropic, and QueryEngine's production Codex path uses `CodexResponsesClient` rather than inline fetch.
- [ ] Provider activity originates only from provider events; heartbeats cannot conceal a provider stall.
- [ ] Query cache, context session, commit receipt, artifact action, and agency mutation are disabled for read-only targets.
- [ ] Query retains at most 4,000 nodes, 16,000 edges, 64 MiB projection, 8 MiB prompt/result, and never calls a full graph materializer.
- [ ] Query and PGS use one immutable source pin through retries.
- [ ] Every source open passes the durable/capability `expectedDigest`, validates descriptor scalar summary, and compares complete `targetDomain` plus exact-one-ID/null/root tuple before executor work.
- [ ] PGS streams to a revision/digest-bound requester SQLite projection and keeps at most one bounded work unit in JS.
- [ ] PGS enforces 256 KiB records, 8 MiB transactions, 8 GiB complete scratch including WAL/SHM, 1 GiB free reserve, at most 256 selected units, 16 MiB total sweep/synthesis input, 2 MiB synthesis output, and 24 MiB terminal result.
- [ ] PGS writes cross-brain partitions, sessions, receipts, and results only under requester scratch.
- [ ] Failed/cancelled partitions remain retryable.
- [ ] A trusted attempt snapshots pending work once; no failed row relaunches within that attempt, metadata records exact sweep fraction/selected/pending counts, and complete is impossible while any durable work remains pending.
- [ ] Cancellation at partition/sweep/batch/synthesis/receipt boundaries persists only completed work and rethrows the exact `signal.reason`.
- [ ] Successful sweeps survive `ProviderCompletionError` final synthesis as terminal `partial` with explicit `result.sweepOutputs`, numeric `result.metadata.pgs.successfulSweeps`, and sorted retryable partitions; zero useful sweeps or non-completion errors fail.
- [ ] COSMO worker consumes prerequisite capability/target resolution and does not create a second authority path.
- [ ] Source-requiring workers call `openPinnedSource` with canonical operationRoot/processIdentity/expectedDigest so global discovery sees `<operation>/pins/<processIdentity>/*`; non-source workers receive `sourcePin:null` and open no pin.
- [ ] Standard worker results use `resultArtifact:null` unless the trusted graph-export seam adopts uncompressed NDJSON through the foundation store.
- [ ] Synthesis is own-brain only, durable, cancellable, and source-CAS protected.
- [ ] Synthesis emits the coordinator-selected provider/model and trusted catalog `providerStallMs` before its provider call.
- [ ] Synthesis uses the same normalized exact-pair registry, locked/CAS settings migration, byte-bounded prompt/output/state, and publishes a verifiable generation marker only after durable source CAS.
- [ ] Fresh synthesis defaults to `minimax/MiniMax-M3`; legacy model-only config migrates only when unique, readiness blocks invalid pairs, and scheduled rejection is handled without `unhandledRejection`.
- [ ] Compatibility routes remain available without weakening authority.
- [ ] All new `.test.js` files are included by `npm test`; focused `.cjs` COSMO suites are invoked explicitly.
- [ ] `docs/design/COSMO23-VENDORED-PATCHES.md` records every vendored change.
- [ ] Exact-path commits preserve pre-existing staged and working-tree changes.
