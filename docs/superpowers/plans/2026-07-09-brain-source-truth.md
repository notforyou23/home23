# Brain Source Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one crash-safe, revisioned, portable base-plus-delta memory source that Home23 engine persistence, dashboard search, bounded graph/status routes, MCP, COSMO, and ANN validation all use without false-empty results or full-graph materialization.

**Architecture:** A dependency-light CommonJS library under `shared/memory-source/` owns the manifest format, streaming JSONL I/O, revision pinning, base-plus-delta projection, evidence envelopes, bounded graph sampling/export, and writer transactions. Engine, dashboard, MCP, COSMO, and Evobrew keep thin path/domain adapters; no consumer independently reconstructs source truth. Existing resident sidecars and monolithic research snapshots are streamed into immutable numeric-v1 projections beneath the authenticated requester's operation runtime; neither legacy form is materialized in memory, read as an authoritative format-v0 source, or rewritten in place.

**Tech Stack:** Node.js 18+ CommonJS modules for portable runtime code, Node streams/readline/zlib/fs, the existing root `better-sqlite3` runtime dependency only for operation-private bounded spill stores, Node test runner, Express route adapters, hnswlib-node behind dependency injection, TypeScript only where existing agent consumers require it.

## Global Constraints

- Implement this plan **only** in the clean isolated worktree created by the execution index and `superpowers:using-git-worktrees`; read `AGENTS.md`, `AGENTS.local.md`, and `docs/design/COSMO23-VENDORED-PATCHES.md` there before implementation. Never execute a task or commit from the live primary checkout.
- Before every task, require `git status --short` to show no pre-existing changes and `git diff --cached --quiet` to prove an empty index. If either check fails, stop and repair the isolated worktree; do not absorb, stage, or commit another task's work.
- Do not delete, rewrite in place, or migrate live brain data destructively. Legacy files remain readable and the first safe rewrite establishes the manifest.
- Keep `instances/`, local `config/*.yaml` and `config/*.json`, `ecosystem.config.cjs`, runtime manifests/pins, indexes, logs, caches, and operation state ignored and out of Git.
- Do not run `pm2 stop all`, `pm2 delete all`, destructive Git cleanup, or broad restarts.
- The shared library uses Node built-ins except for the existing root
  `better-sqlite3` dependency in `overlay-store.cjs`. No other third-party
  dependency is allowed, and it must not import Home23 engine runtime code.
- Every delta record carries an epoch, strictly increasing sequence/revision, and operation type.
- A full rewrite writes and fsyncs versioned base files plus the next delta epoch before atomically switching the manifest.
- Old source files remain until the manifest switch succeeds and no active reader pin protects them. Reader/writer locks live only under ignored `<home23Root>/runtime/brain-source-locks/<sha256(canonicalRoot)>`; no lock, pin, cache, projection, or temp file is ever created under a target brain.
- All source-operation private files share one aggregate 8-GiB default scratch
  quota covering SQLite database/journal/temp bytes, immutable projections,
  graph export temp/final bytes, and other source scratch. Lower per-record and
  per-component limits still apply; crossing any limit is nonretryable
  `result_too_large` with cleanup, never an OOM or disk-fill retry loop.
- ANN is fresh only when `ann.builtFromRevision === currentRevision`; mtime and file size are diagnostics, not authority.
- Embeddings remain optional. Keyword retrieval must work when embeddings are unavailable, dimension-mismatched, stale, or noise-filtered.
- Only `sourceHealth: "healthy"` plus `matchOutcome: "corpus_empty"` may be described as an empty brain.
- Cross-brain reads never mutate access counts, weights, base/delta files, ANN metadata, caches, or target runtime state.
- Graph defaults are 250 nodes and 1,000 edges; server maxima are 2,000 nodes and 8,000 edges, with independent retained-byte and response caps. `full=1` returns typed `result_too_large`.
- One operation `AbortSignal` reaches JSONL/decompression streams, overlays, iterators, search, status, graph, export, MCP, and executors. No layer catches or translates `AbortError` into source degradation.
- Every operation result carries canonical requester/target/brain identity from resolved operation context; request parameters never supply evidence identity. Catalog and evidence `mutationBoundaries` are named `{kind,path}` objects and contain all seven kinds: `brain`, `run`, `pgs`, `session`, `cache`, `export`, and `agency`.
- All changes under `cosmo23/` receive focused tests and a matching entry in `docs/design/COSMO23-VENDORED-PATCHES.md`.
- Each task starts red, reaches green on its focused command, runs `git diff --check`, and commits only the paths named by that task.
- Because the worktree and index start clean, commit blocks stage the exact task paths normally, run `git diff --cached --check`, inspect the **full** `git diff --cached`, and use an ordinary `git commit -m ...`. Immediately after each commit, require `git status --short` to be empty. Do not use `git commit --only`, path-limited cached review, or a commit from the live checkout.

## File and Responsibility Map

- Create `shared/memory-source/contracts.cjs`: stable source-health, match-outcome, revision, ID, edge-key, evidence, and manifest contracts.
- Create `shared/memory-source/jsonl.cjs`: bounded streaming JSONL/gzip readers and atomic gzip writers.
- Create `shared/memory-source/manifest.cjs`: manifest read/validation, atomic manifest write, and side-effect-free production source selection.
- Create `shared/memory-source/legacy-projection.cjs`: streaming immutable numeric-v1 projection for legacy resident sidecars under requester operation runtime.
- Create `shared/memory-source/pins.cjs`: durable operation-owned coordinator pin/mapping, separate requester-owned per-process reader pins, exact global operation-pin discovery, stale-process-pin pruning, and the ignored global reader/writer lock keyed by canonical-root hash.
- Create `shared/memory-source/reader.cjs`: revision pinning and the logical base-plus-delta node/edge view.
- Create `shared/memory-source/legacy-snapshot.cjs`: bounded streaming projection of monolithic legacy research snapshots into requester operation scratch.
- Create `shared/memory-source/writer.cjs`: exclusive writer lock, delta transaction, full rewrite transaction, ANN watermark CAS, and safe retirement.
- Create `shared/memory-source/graph.cjs`: strict integer graph limit validation and deterministic binary-heap top-K node/edge sampling.
- Create `shared/memory-source/mcp-tools.cjs`: MCP-facing keyword/statistics/graph operations over the same logical source.
- Create `shared/memory-source/index.cjs`: public exports only; consumers do not reach into internal modules.
- Create `engine/src/core/memory-persistence.js`: engine adapter that commits/loads revisions and clears dirty state only after commit.
- Create `engine/src/dashboard/memory-search.js`: ANN freshness validation, semantic/keyword fallback, evidence, and match classification.
- Create `engine/src/dashboard/brain-source-api.js`: resident status/graph routes over the shared source.
- Create `engine/src/dashboard/brain-operations/graph-export-executor.js`: cancellable full logical graph streaming into requester-owned result storage.
- Create `engine/src/dashboard/mcp-availability.js`: configured-port MCP health and proxy admission.
- Create `cosmo23/server/lib/brain-source-router.js`: arbitrary-brain status/graph routes without `loadBrainState()`.
- Create `cosmo23/lib/memory-source-adapter.js`: manifest/sidecar discovery plus bounded streaming legacy research projection into requester-owned operation scratch.
- Modify `engine/src/core/memory-sidecar.js`: compatibility exports delegating to the shared source.
- Modify `engine/src/core/orchestrator.js`: call the engine persistence adapter on save/load.
- Modify `engine/src/core/brain-persistence-guard.js`: use authoritative source summary/evidence.
- Modify `engine/src/core/brain-snapshot.js`: record manifest revision/evidence as advisory diagnostics.
- Modify `engine/src/core/brain-backups.js`: copy one pinned manifest generation and its named files.
- Modify `engine/src/merge/build-ann-index.js`: build from a pinned logical source and CAS the ANN watermark.
- Modify `engine/src/dashboard/server.js`: register source/search/MCP adapters and remove unsafe inline implementations.
- Modify `cosmo23/lib/memory-sidecar.js` and `evobrew/lib/memory-sidecar.js`: hydrate through the portable logical reader.
- Modify internal, HTTP, and stdio MCP surfaces in `engine/` and `cosmo23/engine/`: delegate memory operations to `mcp-tools.cjs`.
- Modify `cli/lib/generate-ecosystem.js`: start or explicitly disable each agent-scoped MCP service.
- Modify `engine/src/memory/network-memory.js` and `cosmo23/engine/src/memory/network-memory.js`: ordered embedding batches and explicit access mutation.

---

### Task 1: Portable Contracts and Streaming JSONL Primitives

**Files:**
- Create: `shared/memory-source/contracts.cjs`
- Create: `shared/memory-source/confined-file.cjs`
- Create: `shared/memory-source/jsonl.cjs`
- Create: `shared/memory-source/index.cjs`
- Test: `tests/shared/memory-source-contracts.test.js`

**Interfaces:**
- Consumes: Node built-ins plus the prerequisite `shared/brain-operations/canonical-json.cjs` from Authority Task 2.
- Produces: `SOURCE_HEALTH`, `MATCH_OUTCOME`, `normalizeRevision(value)`, `normalizeId(value)`, `edgeKeyFor(edge)`, `canonicalJson(value)`, `sourceDescriptorDigest(descriptor)`, `classifyMatchOutcome(input)`, `createEvidence(input)`, `enrichEvidenceIdentity(evidence, canonicalIdentity)`, abort/error/diagnostic helpers, confined stable regular-file open helpers, `readJsonl(filePath, options)`, and `writeJsonlGzAtomic(filePath, records, options)`.

- [ ] **Step 1: Write the failing contract and streaming tests**

Create `tests/shared/memory-source-contracts.test.js` with:

~~~js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const {
  SOURCE_HEALTH,
  MATCH_OUTCOME,
  normalizeRevision,
  normalizeId,
  edgeKeyFor,
  canonicalJson,
  sourceDescriptorDigest,
  classifyMatchOutcome,
  createDiagnosticRing,
  createEvidence,
  isTypedMemorySourceError,
  normalizeKeywordTokens,
  enrichEvidenceIdentity,
  readJsonl,
  writeJsonlGzAtomic,
} = require('../../shared/memory-source');

test('normalizes revisions and graph identifiers without conflating invalid values', () => {
  assert.equal(normalizeRevision('17'), 17);
  assert.equal(normalizeRevision(-1), null);
  assert.equal(normalizeId(4), '4');
  assert.equal(normalizeId('4'), '4');
  assert.equal(edgeKeyFor({ source: 9, target: '2' }), '2->9');
});

test('hashes a source descriptor from recursively key-sorted canonical JSON', () => {
  const descriptor = {
    version: 1,
    canonicalRoot: '/real/instances/jerry/brain',
    generation: 'g1',
    baseRevision: 2,
    cutoffRevision: 5,
    activeBase: { edges: { file: 'edges.gz' }, nodes: { file: 'nodes.gz' } },
    activeDelta: { committedBytes: 7, file: 'delta.jsonl', epoch: 'e1', toRevision: 5 },
  };
  assert.equal(canonicalJson(descriptor), canonicalJson({
    cutoffRevision: 5,
    generation: 'g1',
    version: 1,
    activeDelta: { toRevision: 5, epoch: 'e1', file: 'delta.jsonl', committedBytes: 7 },
    canonicalRoot: '/real/instances/jerry/brain',
    activeBase: { nodes: { file: 'nodes.gz' }, edges: { file: 'edges.gz' } },
    baseRevision: 2,
  }));
  assert.match(sourceDescriptorDigest(descriptor), /^sha256:[a-f0-9]{64}$/);
});

test('classifies empty only from healthy complete authoritative coverage', () => {
  assert.equal(classifyMatchOutcome({
    sourceHealth: SOURCE_HEALTH.HEALTHY,
    authoritativeTotal: 0,
    returnedTotal: 0,
    completeCoverage: true,
  }), MATCH_OUTCOME.CORPUS_EMPTY);
  assert.equal(classifyMatchOutcome({
    sourceHealth: SOURCE_HEALTH.DEGRADED,
    authoritativeTotal: 0,
    returnedTotal: 0,
    completeCoverage: false,
  }), MATCH_OUTCOME.UNKNOWN);
  assert.equal(classifyMatchOutcome({
    sourceHealth: SOURCE_HEALTH.HEALTHY,
    authoritativeTotal: 8,
    returnedTotal: 0,
    filteredTotal: 2,
    completeCoverage: true,
  }), MATCH_OUTCOME.FILTERED);
});

test('creates a complete additive evidence envelope with canonical identity', () => {
  const evidence = createEvidence({
    selectedAgent: 'jerry',
    selectedBrain: 'brain-jerry',
    identity: {
      requesterAgent: 'ada', targetAgent: 'jerry', brainId: 'brain-jerry',
      canonicalRoot: '/real/instances/jerry/brain', catalogRevision: 'catalog-17',
      kind: 'agent', sourceType: 'memory-manifest', accessMode: 'sibling',
      operationId: 'op-17',
    },
    route: 'shared-memory-source',
    implementation: 'manifest-v1',
    sourceHealth: 'healthy',
    matchOutcome: 'matches',
    baseRevision: 10,
    deltaRevision: 12,
    deltaApplied: 2,
    annBuiltFromRevision: 12,
    annFresh: true,
    filters: { tag: 'conversation' },
    limits: { topK: 5 },
    authoritativeTotals: { nodes: 20, edges: 30 },
    returnedTotals: { nodes: 2, edges: 0 },
  });
  assert.equal(evidence.baseWatermark.revision, 10);
  assert.equal(evidence.deltaWatermark.revision, 12);
  assert.equal(evidence.indexWatermark.fresh, true);
  assert.deepEqual(evidence.filters, { tag: 'conversation' });
  assert.equal(evidence.identity.requesterAgent, 'ada');
  assert.equal(evidence.identity.targetAgent, 'jerry');
  assert.equal(evidence.identity.catalogRevision, 'catalog-17');
});

test('identity enrichment preserves evidence and rejects canonical mismatch', () => {
  const evidence = createEvidence({ baseRevision: 10, deltaRevision: 12, sourceHealth: 'healthy' });
  const identity = {
    requesterAgent: 'ada', targetAgent: null, brainId: 'research-r1',
    canonicalRoot: '/real/runs/r1', catalogRevision: 'catalog-19', kind: 'research',
    sourceType: 'legacy-research-projection', accessMode: 'completed-research',
    operationId: 'op-r1',
  };
  const enriched = enrichEvidenceIdentity(evidence, identity);
  assert.equal(enriched.baseWatermark.revision, 10);
  assert.equal(enriched.identity.kind, 'research');
  assert.throws(() => enrichEvidenceIdentity(enriched, {
    ...identity, canonicalRoot: '/real/runs/r2',
  }), error => error.code === 'source_changed');
});

test('round-trips gzip JSONL without full-array serialization', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'memory-source-jsonl-'));
  const out = join(dir, 'nodes.jsonl.gz');
  await writeJsonlGzAtomic(out, [{ id: 1 }, { id: 2 }]);
  const rows = [];
  for await (const row of readJsonl(out, { gzip: true })) rows.push(row);
  assert.deepEqual(rows, [{ id: 1 }, { id: 2 }]);
  await assert.rejects(readFile(out + '.tmp'));
});

test('aborting a JSONL iterator destroys the stream and preserves AbortError', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'memory-source-abort-'));
  const out = join(dir, 'nodes.jsonl.gz');
  await writeJsonlGzAtomic(out, Array.from({ length: 1000 }, (_, id) => ({ id })));
  const controller = new AbortController();
  const iterator = readJsonl(out, { gzip: true, signal: controller.signal });
  assert.equal((await iterator.next()).done, false);
  controller.abort(Object.assign(new Error('cancelled'), { name: 'AbortError', code: 'cancelled' }));
  await assert.rejects(iterator.next(), error => error.name === 'AbortError');
});

test('caps decompressed bytes and a single JSONL record before parsing', async () => {
  const fixture = await writeHighlyCompressibleJsonlRecord({ conceptBytes: 8 * 1024 * 1024 });
  await assert.rejects(
    collect(readJsonl(fixture, { gzip: true, maxRecordBytes: 64 * 1024 })),
    error => error.code === 'result_too_large' && error.limitKind === 'record',
  );
  await assert.rejects(
    collect(readJsonl(fixture, { gzip: true, maxDecompressedBytes: 32 * 1024 })),
    error => error.code === 'result_too_large' && error.limitKind === 'decompressed',
  );
});
~~~

- [ ] **Step 2: Run the test and verify the red state**

Run:

~~~bash
node --test --test-concurrency=1 tests/shared/memory-source-contracts.test.js
~~~

Expected: FAIL with `Cannot find module '../../shared/memory-source'`.

- [ ] **Step 3: Implement the stable contracts**

Create `shared/memory-source/contracts.cjs` with:

~~~js
'use strict';

const SOURCE_HEALTH = Object.freeze({
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNAVAILABLE: 'unavailable',
});

const MATCH_OUTCOME = Object.freeze({
  MATCHES: 'matches',
  NO_MATCH: 'no_match',
  FILTERED: 'filtered',
  CORPUS_EMPTY: 'corpus_empty',
  UNKNOWN: 'unknown',
});

function normalizeRevision(value) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

function normalizeId(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function normalizeKeywordTokens(query) {
  if (typeof query !== 'string' || !query.trim()) {
    throw Object.assign(new Error('query_invalid'), { code: 'invalid_request' });
  }
  const raw = query.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}_:-]+/gu) || [];
  const words = [...new Set(raw)];
  if (words.length < 1 || words.length > 64
      || words.some(word => Buffer.byteLength(word, 'utf8') > 256)) {
    throw Object.assign(new Error('query_invalid'), { code: 'invalid_request' });
  }
  return words;
}

function invalidBoundedInteger(name, value) {
  return Object.assign(new Error(name + ' must be a finite bounded integer'), {
    code: 'invalid_request', status: 400, field: name, value,
  });
}

function parseBoundedInteger(value, { name, defaultValue, min, max }) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw invalidBoundedInteger(name, value);
  }
  if (typeof value === 'string' && !/^(0|[1-9]\d*)$/.test(value)) {
    throw invalidBoundedInteger(name, value);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw invalidBoundedInteger(name, value);
  }
  return parsed;
}

function edgeKeyFor(edge) {
  const source = normalizeId(edge?.source ?? edge?.from);
  const target = normalizeId(edge?.target ?? edge?.to);
  return [source, target].sort((a, b) => a.localeCompare(b)).join('->');
}

const {
  canonicalJson,
  canonicalSha256,
} = require('../brain-operations/canonical-json.cjs');

function sourceDescriptorDigest(descriptor) {
  return 'sha256:' + canonicalSha256(descriptor);
}

function isAbortError(error, signal) {
  return signal?.aborted === true || error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason || Object.assign(new Error('cancelled'), {
    name: 'AbortError', code: 'cancelled',
  });
}

function rethrowAbort(error, signal) {
  if (isAbortError(error, signal)) {
    throw signal?.reason || error || Object.assign(new Error('cancelled'), {
      name: 'AbortError', code: 'cancelled',
    });
  }
}

const TYPED_MEMORY_SOURCE_CODES = new Set([
  'invalid_request', 'invalid_memory_source', 'source_unavailable',
  'source_changed', 'source_busy', 'source_stale', 'result_too_large',
  'source_operation_required', 'cancelled',
]);

function isTypedMemorySourceError(error) {
  return typeof error?.code === 'string' && TYPED_MEMORY_SOURCE_CODES.has(error.code);
}

function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let low = 0; let high = Math.min(value.length, maxBytes);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, mid), 'utf8') <= maxBytes) low = mid;
    else high = mid - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1])) low -= 1;
  return value.slice(0, low);
}

function createDiagnosticRing({ maxEntries = 64, maxBytes = 32 * 1024,
  maxEntryBytes = 512 } = {}) {
  const entries = [];
  let retainedBytes = 0;
  let dropped = 0;
  let sawDegradation = false;
  return Object.freeze({
    push(value) {
      const text = truncateUtf8(String(value), maxEntryBytes);
      if (/_parse_error|revision_gap|source_missing|source_unavailable/.test(text)) {
        sawDegradation = true;
      }
      const bytes = Buffer.byteLength(text, 'utf8');
      if (entries.length >= maxEntries || retainedBytes + bytes > maxBytes) {
        dropped += 1;
        return entries.length;
      }
      entries.push(text); retainedBytes += bytes; return entries.length;
    },
    some(predicate) { return entries.some(predicate); },
    snapshot() { return Object.freeze([...entries]); },
    get length() { return entries.length + dropped; },
    get dropped() { return dropped; },
    get sawDegradation() { return sawDegradation; },
  });
}

function classifyMatchOutcome({
  sourceHealth,
  authoritativeTotal,
  returnedTotal,
  filteredTotal = 0,
  completeCoverage = false,
}) {
  if (returnedTotal > 0) return MATCH_OUTCOME.MATCHES;
  if (sourceHealth !== SOURCE_HEALTH.HEALTHY || !completeCoverage) {
    return MATCH_OUTCOME.UNKNOWN;
  }
  if (authoritativeTotal === 0) return MATCH_OUTCOME.CORPUS_EMPTY;
  if (filteredTotal > 0) return MATCH_OUTCOME.FILTERED;
  return MATCH_OUTCOME.NO_MATCH;
}

function canonicalEvidenceIdentity(identity) {
  if (!identity) return null;
  return Object.freeze({
    requesterAgent: identity.requesterAgent || null,
    targetAgent: identity.targetAgent || null,
    brainId: identity.brainId || null,
    canonicalRoot: identity.canonicalRoot || null,
    catalogRevision: typeof identity.catalogRevision === 'string'
      ? identity.catalogRevision : null,
    kind: identity.kind || null,
    sourceType: identity.sourceType || null,
    accessMode: identity.accessMode || null,
    operationId: identity.operationId || null,
  });
}

function createEvidence(input = {}) {
  return {
    selectedAgent: input.selectedAgent || null,
    selectedBrain: input.selectedBrain || null,
    route: input.route || 'shared-memory-source',
    implementation: input.implementation || 'manifest-v1',
    identity: canonicalEvidenceIdentity(input.identity),
    baseWatermark: {
      revision: normalizeRevision(input.baseRevision),
      file: input.baseFile || null,
    },
    deltaWatermark: {
      revision: normalizeRevision(input.deltaRevision),
      epoch: input.deltaEpoch || null,
      appliedRecords: Number(input.deltaApplied || 0),
    },
    indexWatermark: {
      builtFromRevision: normalizeRevision(input.annBuiltFromRevision),
      fresh: input.annFresh === true,
    },
    filters: input.filters || {},
    limits: input.limits || {},
    authoritativeTotals: input.authoritativeTotals || { nodes: null, edges: null },
    returnedTotals: input.returnedTotals || { nodes: 0, edges: 0 },
    mutationBoundaries: Object.freeze([...(input.mutationBoundaries || [])]),
    sourceHealth: input.sourceHealth || SOURCE_HEALTH.UNAVAILABLE,
    matchOutcome: input.matchOutcome || MATCH_OUTCOME.UNKNOWN,
    fallback: input.fallback || null,
    freshness: input.freshness || 'known',
    diagnostics: Object.freeze(Array.isArray(input.diagnostics) ? [...input.diagnostics] : []),
    diagnosticsDropped: Number.isSafeInteger(input.diagnosticsDropped)
      ? input.diagnosticsDropped : 0,
  };
}

function enrichEvidenceIdentity(evidence, identity) {
  if (!identity?.requesterAgent || !identity?.brainId || !identity?.canonicalRoot ||
      !identity?.catalogRevision || typeof identity.catalogRevision !== 'string' || !identity?.kind ||
      !identity?.sourceType || !identity?.accessMode || !identity?.operationId) {
    throw Object.assign(new Error('canonical evidence identity required'), { code: 'invalid_request' });
  }
  const normalized = canonicalEvidenceIdentity(identity);
  const prior = evidence?.identity;
  if (prior && [
    'requesterAgent', 'targetAgent', 'brainId', 'canonicalRoot', 'catalogRevision',
    'kind', 'sourceType', 'accessMode', 'operationId',
  ].some(key => prior[key] !== null && prior[key] !== normalized[key])) {
    throw Object.assign(new Error('evidence identity mismatch'), { code: 'source_changed' });
  }
  return Object.freeze({
    ...evidence,
    selectedAgent: normalized.targetAgent,
    selectedBrain: normalized.brainId,
    identity: normalized,
  });
}

module.exports = {
  SOURCE_HEALTH,
  MATCH_OUTCOME,
  normalizeRevision,
  normalizeId,
  normalizeKeywordTokens,
  parseBoundedInteger,
  edgeKeyFor,
  canonicalJson,
  sourceDescriptorDigest,
  isAbortError,
  throwIfAborted,
  rethrowAbort,
  isTypedMemorySourceError,
  createDiagnosticRing,
  classifyMatchOutcome,
  createEvidence,
  enrichEvidenceIdentity,
};
~~~

- [ ] **Step 4: Implement streaming JSONL I/O and public exports**

Create `shared/memory-source/confined-file.cjs` first. Its
`openConfinedRegularFile(root,file,options)` and
`assertStableOpenedFile(opened)` helpers lstat every path, reject symlinks and
non-regular files, realpath root and file, require strict descendant
containment, open with `O_NOFOLLOW` (fail closed when the platform cannot
provide equivalent no-follow behavior), compare lstat/fstat device and inode,
and re-fstat after use. It supports bounded optional absence but never follows
an optional link. With `optional:true`, an actual lstat `ENOENT` returns exact
`null`; every other condition is an error. `probeConfinedRegularFiles()` uses
that result so manifestless fallback never depends on catching a remapped I/O
error. Multi-file assertions accept per-file `expectedBytes`, `minimumBytes`,
and `allowEmpty` rules and return stable open identities. `readConfinedFile()`
stats before allocation and refuses a
file over the supplied byte cap. Link/escape/type/stability failures are typed
nonretryable `invalid_memory_source`; missing/I/O failures are retryable
`source_unavailable`; abort and existing typed limit errors remain unchanged.
Tests race a basename replacement between lstat/open and read, cover a symlink
inside the root pointing both inside and outside it, and require failure before
any bytes are parsed or written.

Create `shared/memory-source/jsonl.cjs` with:

~~~js
'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const zlib = require('node:zlib');
const { once } = require('node:events');
const { StringDecoder } = require('node:string_decoder');
const {
  createEvidence, isTypedMemorySourceError, rethrowAbort, throwIfAborted,
} = require('./contracts.cjs');
const {
  openConfinedRegularFile, assertStableOpenedFile, createConfinedExclusiveFile,
} = require('./confined-file.cjs');

function limitError(limitKind, limit) {
  return Object.assign(new Error(`memory source ${limitKind} limit exceeded`), {
    code: 'result_too_large', status: 413, retryable: false, limitKind, limit,
  });
}

async function* readJsonl(filePath, options = {}) {
  throwIfAborted(options.signal);
  const opened = await openConfinedRegularFile(
    options.confinedRoot || require('node:path').dirname(filePath), filePath,
    { flags: fs.constants.O_RDONLY, maxBytes: options.maxInputBytes },
  );
  const stat = opened.stat;
  if (options.expectedInputBytes !== undefined
      && (!Number.isSafeInteger(options.expectedInputBytes)
        || options.expectedInputBytes < 0
        || Number(stat.size) !== options.expectedInputBytes)) {
    await opened.handle.close();
    throw Object.assign(new Error('authoritative JSONL size mismatch'), {
      code: 'source_unavailable', retryable: true,
    });
  }
  const inputBytes = options.byteLimit === undefined ? Number(stat.size) : options.byteLimit;
  if (!Number.isSafeInteger(inputBytes) || inputBytes < 0) {
    await opened.handle.close();
    throw Object.assign(new Error('invalid JSONL byte limit'), { code: 'invalid_request' });
  }
  if (inputBytes > Number(stat.size)) {
    await opened.handle.close();
    throw Object.assign(new Error('committed JSONL prefix is truncated'), {
      code: 'source_unavailable', retryable: true,
    });
  }
  const maxRecordBytes = options.maxRecordBytes ?? 16 * 1024 * 1024;
  const maxDecompressedBytes = options.maxDecompressedBytes ?? 2 * 1024 * 1024 * 1024;
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes <= 0 ||
      !Number.isSafeInteger(maxDecompressedBytes) || maxDecompressedBytes <= 0) {
    throw Object.assign(new Error('invalid JSONL byte limits'), { code: 'invalid_request' });
  }
  if (inputBytes === 0) {
    if (options.gzip) {
      await opened.handle.close();
      throw Object.assign(new Error('gzip base is empty'), {
        code: 'source_unavailable', retryable: true,
      });
    }
    if (options.expectedRecordCount !== undefined && options.expectedRecordCount !== 0) {
      await opened.handle.close();
      throw Object.assign(new Error('authoritative JSONL count mismatch'), {
        code: 'source_unavailable', retryable: true,
      });
    }
    await assertStableOpenedFile(opened);
    await opened.handle.close();
    return;
  }
  const input = fs.createReadStream(null, {
    fd: opened.handle.fd, autoClose: false, start: 0, end: inputBytes - 1,
  });
  const decoded = options.gzip ? input.pipe(zlib.createGunzip()) : input;
  const abort = () => {
    const reason = options.signal.reason || Object.assign(new Error('cancelled'), { name: 'AbortError' });
    decoded.destroy(reason);
    input.destroy(reason);
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  let lineNumber = 0;
  let recordCount = 0;
  let decodedBytes = 0;
  let bufferedBytes = 0;
  let pending = '';
  const decoder = new StringDecoder('utf8');
  const parseLine = line => {
    lineNumber += 1;
    if (!line) return null;
    try { return JSON.parse(line); }
    catch (error) {
      if (options.onParseError) {
        options.onParseError({ error, lineNumber, filePath });
        return null;
      }
      throw Object.assign(new Error('authoritative JSONL record is malformed'), {
        code: 'source_unavailable', retryable: true, cause: error,
      });
    }
  };
  try {
    for await (const chunk of decoded) {
      throwIfAborted(options.signal);
      decodedBytes += chunk.length;
      if (decodedBytes > maxDecompressedBytes) {
        throw limitError('decompressed', maxDecompressedBytes);
      }
      pending += decoder.write(chunk);
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        if (Buffer.byteLength(line) > maxRecordBytes) throw limitError('record', maxRecordBytes);
        const record = parseLine(line);
        if (record !== null) { recordCount += 1; yield record; }
      }
      bufferedBytes = Buffer.byteLength(pending);
      if (bufferedBytes > maxRecordBytes) throw limitError('record', maxRecordBytes);
    }
    pending += decoder.end();
    if (Buffer.byteLength(pending) > maxRecordBytes) throw limitError('record', maxRecordBytes);
    if (options.requireCompletePrefix && pending.length > 0) {
      throw Object.assign(new Error('committed JSONL prefix ends mid-record'), {
        code: 'source_unavailable', retryable: true,
      });
    }
    if (pending.replace(/\r$/, '')) {
      const record = parseLine(pending.replace(/\r$/, ''));
      if (record !== null) { recordCount += 1; yield record; }
    }
    if (options.expectedRecordCount !== undefined
        && recordCount !== options.expectedRecordCount) {
      throw Object.assign(new Error('authoritative JSONL count mismatch'), {
        code: 'source_unavailable', retryable: true,
      });
    }
    await assertStableOpenedFile(opened);
  } catch (error) {
    rethrowAbort(error, options.signal);
    if (isTypedMemorySourceError(error)) throw error;
    throw Object.assign(new Error('authoritative JSONL source is unreadable'), {
      code: 'source_unavailable', retryable: true, cause: error,
    });
  } finally {
    options.signal?.removeEventListener('abort', abort);
    decoded.destroy();
    input.destroy();
    await opened.handle.close();
  }
}

async function writeJsonlGzAtomic(filePath, records, options = {}) {
  await fsp.mkdir(require('node:path').dirname(filePath), { recursive: true });
  const tmpPath = filePath + '.' + process.pid + '.' + Date.now() + '.tmp';
  const gzip = zlib.createGzip({ level: options.level ?? zlib.constants.Z_BEST_SPEED });
  const output = fs.createWriteStream(tmpPath, { flags: 'wx' });
  const abort = () => {
    const reason = options.signal.reason || Object.assign(new Error('cancelled'), { name: 'AbortError' });
    gzip.destroy(reason);
    output.destroy(reason);
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  gzip.pipe(output);
  let count = 0;
  try {
    for await (const record of records) {
      throwIfAborted(options.signal);
      const serialized = JSON.stringify(record);
      const maxRecordBytes = options.maxRecordBytes ?? 16 * 1024 * 1024;
      if (Buffer.byteLength(serialized) > maxRecordBytes) {
        throw limitError('record', maxRecordBytes);
      }
      if (!gzip.write(serialized + '\n')) await once(gzip, 'drain');
      count += 1;
    }
    gzip.end();
    await once(output, 'close');
    const handle = await fsp.open(tmpPath, 'r');
    await handle.sync();
    await handle.close();
    const bytes = (await fsp.stat(tmpPath)).size;
    await fsp.rename(tmpPath, filePath);
    return { count, bytes };
  } catch (error) {
    gzip.destroy();
    output.destroy();
    await fsp.rm(tmpPath, { force: true });
    rethrowAbort(error, options.signal);
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
}

module.exports = { limitError, readJsonl, writeJsonlGzAtomic };
~~~

Create `shared/memory-source/index.cjs` with:

~~~js
'use strict';

module.exports = {
  ...require('./contracts.cjs'),
  ...require('./confined-file.cjs'),
  ...require('./jsonl.cjs'),
};
~~~

- [ ] **Step 5: Run the focused test and inspect formatting**

Run:

~~~bash
node --test --test-concurrency=1 tests/shared/memory-source-contracts.test.js
git diff --check -- shared/memory-source tests/shared/memory-source-contracts.test.js
~~~

Expected: all focused contract tests pass; `git diff --check` prints nothing.

- [ ] **Step 6: Commit only the primitive contract paths**

~~~bash
git diff --cached --quiet
git add -- shared/memory-source/contracts.cjs shared/memory-source/confined-file.cjs shared/memory-source/jsonl.cjs shared/memory-source/index.cjs tests/shared/memory-source-contracts.test.js
git diff --cached --check
git diff --cached
git commit -m "feat(memory): add portable source contracts"
git status --short
~~~

### Task 2: Pinned Base-Plus-Delta Logical Reader

**Files:**
- Create: `shared/memory-source/manifest.cjs`
- Create: `shared/memory-source/legacy-projection.cjs`
- Create: `shared/memory-source/overlay-store.cjs`
- Create: `shared/memory-source/scratch-quota.cjs`
- Create: `shared/memory-source/operation-context.cjs`
- Create: `shared/memory-source/pins.cjs`
- Create: `shared/memory-source/reader.cjs`
- Modify: `shared/memory-source/index.cjs`
- Test: `tests/shared/memory-source-reader.test.js`
- Test: `tests/shared/memory-source-adapters.test.js`
- Test: `tests/shared/memory-source-pin.test.js`

**Interfaces:**
- Consumes: Task 1 `readJsonl`, revision/ID helpers, evidence types, Plan A `buildCanonicalCatalog()`, an authenticated requester operation root, and ignored global `lockRoot` derived by trusted Home23 configuration.
- Produces: `readManifest(brainDir)`, `validateManifest(manifest)`, `resolveMemorySourceSelection(canonicalRoot)`, `enumerateMemoryMutationBoundaries(canonicalRoot, {manifest,kind,extra})`, `createOperationScratchQuota(options)`, `createBoundedOverlayStore(options)`, `createInstalledLocalSourceContext(options)`, `withEphemeralMemorySource(options, callback)`, `projectLegacyResidentSidecars(input)`, `openMemorySource(brainDir, {operationId?, requesterAgent?, identity?, signal?, mutationBoundaries?, operationRoot?,lockRoot?,scratchQuota?})`, `pinOperationSource(input)`, `openPinnedSource(descriptor, expectations)`, `createMemorySourcePinProvider({home23Root, requesterAgent})`, `withMemorySourceLock(canonicalRoot, {lockRoot}, callback)`, `discoverOperationPinFiles(home23Root)`, `pruneStalePins(home23Root, {getOperationState,isProcessAlive,clock})`, and a pinned source object exposing `descriptor`, numeric `revision`, `evidence`, named `mutationBoundaries`, `getMutationBoundaries()`, `isCurrent()`, `compareAndSwap(commit)`, raw `iterateNodes()`, raw `iterateEdges()`, scalar-only `summarize()`, byte/key-bounded `summarizeBreakdowns()`, `searchKeyword()`, `getEvidence()`, idempotent `release()`, and `close()`.

The provider boundary is deliberately smaller than the reader boundary. `createMemorySourcePinProvider(...).pin(canonicalRoot, operationId)` is idempotent by operation ID and returns **exactly** `{descriptor,digest}`. It never returns a source, iterator, `close`, `release`, evidence, or any private path. `digest` is exactly `sourceDescriptorDigest(descriptor)`, namely lowercase `sha256:<64 hex>` over recursively key-sorted canonical JSON. The foundation coordinator alone calls `store.attachSourcePin(...)`; the source provider has no store dependency and no `attachSourcePin` method.

The cross-process descriptor is data, not a caller-selected path:

~~~js
{
  version: 1,
  canonicalRoot: '/real/instances/jerry/brain',
  generation: 'g1',
  baseRevision: 2,
  cutoffRevision: 5,
  activeBase: {
    nodes: { file: 'memory-nodes.base-2.jsonl.gz', count: 138900, bytes: 73400320 },
    edges: { file: 'memory-edges.base-2.jsonl.gz', count: 454900, bytes: 125829120 },
  },
  activeDelta: {
    epoch: 'e3',
    file: 'memory-delta.e3.jsonl',
    fromRevision: 3,
    committedBytes: 1234,
    toRevision: 5,
    count: 3,
  },
  summary: { nodeCount: 139000, edgeCount: 455000, clusterCount: 120 },
}
~~~

The public descriptor carries only bounded scalar base count/byte and delta
range/count/cutoff fields plus the three bounded scalar summary fields; it never
carries unbounded tag/cluster maps or a physical path. `validateManifest()`
requires every scalar to be a nonnegative safe integer and requires the delta
range/count to match base/current revision. Writers and legacy projectors
compute them before publish. This lets open/pin verify physical integrity and
lets Query/PGS obtain authoritative totals without rescanning merely to count.

`openPinnedSource()` must require/reconcile a caller-created process quota handle for the exact trusted operation root, realpath and compare `expectedCanonicalRoot`, compare numeric `expectedRevision`, reject absolute/traversal filenames, read only through the descriptor cutoff, and create its own operation-scoped reader pin at `<requester-operation-root>/pins/<processIdentity>/<canonical-root-hash>.json`. The process identity directory is derived from PID plus OS process-start/boot identity, not caller input. It never accepts a manifest, quota, lock, projection, or pin path from a public request and never writes inside the target brain.

- [ ] **Step 1: Write failing base-plus-delta and legacy tests**

Create `tests/shared/memory-source-reader.test.js` with tests using temporary gzip sidecars and this manifest fixture:

~~~js
const manifest = {
  formatVersion: 1,
  generation: 'g1',
  baseRevision: 2,
  currentRevision: 5,
  activeDeltaEpoch: 'e3',
  activeBase: {
    nodes: { file: 'memory-nodes.base-2.jsonl.gz', count: 2, bytes: 0 },
    edges: { file: 'memory-edges.base-2.jsonl.gz', count: 1, bytes: 0 },
  },
  activeDelta: {
    epoch: 'e3',
    file: 'memory-delta.e3.jsonl',
    fromRevision: 3,
    toRevision: 5,
    count: 3,
    committedBytes: 0,
  },
  ann: { indexFile: null, metaFile: null, builtFromRevision: 2 },
  summary: { nodeCount: 2, edgeCount: 0, clusterCount: 1 },
};
~~~

The fixture helper writes the node/edge gzip files and committed delta first,
then replaces each placeholder `bytes:0`/`committedBytes:0` with the exact
physical stat/cutoff before writing the manifest. A zero-byte gzip is used only
by the explicit corruption test and is never a valid empty-base fixture.

The test body must:

~~~js
test('projects base plus ordered delta upserts and tombstones at one pinned revision', async () => {
  const dir = await createManifestFixture(manifest, {
    nodes: [
      { id: 1, concept: 'old', tag: 'base', cluster: 4 },
      { id: 2, concept: 'deleted', tag: 'base', cluster: '4' },
    ],
    edges: [{ source: 1, target: 2, weight: 0.5 }],
    delta: [
      { epoch: 'e3', sequence: 1, revision: 3, op: 'upsert_node', record: { id: 1, concept: 'updated', tag: 'updated', cluster: '4' } },
      { epoch: 'e3', sequence: 2, revision: 4, op: 'remove_node', id: 2 },
      { epoch: 'e3', sequence: 3, revision: 5, op: 'upsert_node', record: { id: 3, concept: 'new canary', tag: 'new', cluster: 4 } },
    ],
  });
  const source = await openMemorySource(dir);
  const nodes = [];
  const edges = [];
  for await (const node of source.iterateNodes()) nodes.push(node);
  for await (const edge of source.iterateEdges()) edges.push(edge);
  assert.deepEqual(nodes.map(node => [String(node.id), node.concept]), [['1', 'updated'], ['3', 'new canary']]);
  assert.deepEqual(edges, []);
  assert.equal(source.getEvidence().sourceHealth, 'healthy');
  assert.equal(source.getEvidence().deltaWatermark.appliedRecords, 3);
  await source.close();
});

test('ignores bytes beyond the committed delta cutoff', async () => {
  const source = await openFixtureWithCommittedAndOrphanRecords();
  const concepts = [];
  for await (const node of source.iterateNodes()) concepts.push(node.concept);
  assert.deepEqual(concepts, ['committed']);
  await source.close();
});

test('legacy resident sidecars stream into an immutable numeric-v1 requester projection', async () => {
  const fixture = await openLegacyFixture([]);
  const source = fixture.source;
  const summary = await source.summarize();
  assert.equal(summary.nodes, 0);
  assert.equal(source.descriptor.version, 1);
  assert.equal(Number.isSafeInteger(source.descriptor.cutoffRevision), true);
  assert.equal(source.getEvidence({ completeCoverage: true }).sourceHealth, 'degraded');
  assert.equal(source.getEvidence({ completeCoverage: true }).matchOutcome, 'unknown');
  assert.match(source.manifest.sourceMode, /^legacy_projection$/);
  assert.equal(source.physicalFiles.every(file => file.startsWith(fixture.operationProjectionRoot)), true);
  assert.equal(fixture.targetWrites.length, 0);
  await source.close();
});

test('summary stays scalar and optional breakdowns are byte and key bounded', async () => {
  const source = await openHugeTagAndClusterFixture();
  assert.deepEqual(await source.summarize(), {
    nodes: source.descriptor.summary.nodeCount,
    edges: source.descriptor.summary.edgeCount,
    clusters: source.descriptor.summary.clusterCount,
  });
  const breakdowns = await source.summarizeBreakdowns({ maxKeys: 100, maxBytes: 64 * 1024 });
  assert.equal(breakdowns.tags, null);
  assert.equal(breakdowns.clusterTotals, null);
  assert.equal(breakdowns.omitted, true);
  assert.equal(breakdowns.scannedNodes, source.descriptor.summary.nodeCount);
  assert.equal(source.maxBreakdownKeys <= 100, true);
  await source.close();
});

test('a missing active base is unavailable rather than empty', async () => {
  const source = await openFixtureWithMissingBase();
  assert.equal(source.getEvidence().sourceHealth, 'unavailable');
  assert.equal(source.getEvidence().matchOutcome, 'unknown');
  await source.close();
});
~~~

Create `tests/shared/memory-source-adapters.test.js` with one manifest fixture and one legacy-resident-sidecar fixture passed through thin engine-style and COSMO-style path resolvers; assert identical node IDs, totals, deterministic safe-integer revisions, and evidence. Monkeypatch `readFile` and every array-materializing seam to throw for the large legacy fixture; both node and edge sidecars must cross through streaming iterators with bounded retained buffers.

The adapter suite also table-tests `resolveMemorySourceSelection(canonicalRoot)`. It is a side-effect-free production resolver used by the later persistence verifier and returns `{authority,canonicalRoot,targetFiles,manifest}` where `authority` is exactly `manifest-v1`, `legacy-resident-sidecars`, `legacy-research-snapshot`, or `unavailable`; `targetFiles` contains the exact canonical manifest generation files (delta with committed-byte cutoff), exact legacy sidecars/snapshot selected by the reader, and advisory `brain-snapshot.json` when present. It never creates a lock/pin/projection and never follows a symlink outside the target.

The same suite asserts `getMutationBoundaries()` returns a sorted object array whose members are exactly `{kind,path}` and whose kind set is exactly `brain`, `run`, `pgs`, `session`, `cache`, `export`, and `agency`. Every `path` is a canonical absolute target path. `brain`/`run` cover the manifest, active base, committed delta, ANN index/meta, snapshot metadata, and legacy state/run metadata; the remaining named roots cover PGS, sessions, caches, exports, and agency data even when absent. It must not include the global lock root, requester pins, operation scratch/projection, or result storage. This exact read-only inventory is what the foundation catalog publishes for live before/after hashing.

Create `tests/shared/memory-source-pin.test.js` with a requester-owned operation root and an ignored global `lockRoot`, both outside the target brain. First call `createMemorySourcePinProvider(...).pin(canonicalRoot, operationId)` and assert `Object.keys(result).sort()` is exactly `['descriptor','digest']`, the result has no open source/iterator/close/release field, and `digest === sourceDescriptorDigest(descriptor)`. The call atomically persists `<operationRoot>/coordinator-source-pin.json`, whose private record contains the descriptor, digest, canonical target, protected filenames/cutoff, and native physical root or legacy projection mapping. That coordinator record and any projection are outside the target. It remains durable across process restart, caller detachment, and a simulated lost response after its atomic rename.

Race 32 first calls, recreate the provider, and repeat the call after an injected post-rename lost response. Every call must return the byte-identical descriptor/digest, produce one coordinator record, and increment no record/version counter after the first durable publish. Switch the current manifest after the first response and prove the retry still returns the original descriptor/digest and retirement retains that generation. A pre-existing record with different canonical root, operation owner, descriptor, digest, projection mapping, or missing protected files fails typed `source_pin_conflict`/`source_changed`; it never silently repins to current truth. Assert the provider exposes no `attachSourcePin`: the foundation store attachment is a separate atomic step.

Then create `scratchQuota = await createOperationScratchQuota({operationRoot})` and call `openPinnedSource(descriptor, { expectedCanonicalRoot, expectedRevision, expectedDigest, operationId, operationRoot, lockRoot, scratchQuota })`. Assert it validates the quota/root and private coordinator record before opening and writes exactly one **separate process-local** pin at `<operationRoot>/pins/<processIdentity>/<canonical-root-hash>.json`. `release()` removes exactly that process pin and its empty process directory but leaves `coordinator-source-pin.json` and quota ledger protecting/accounting for the generation; close the quota handle separately. Caller detachment leaves both pins present; idempotent terminal `releaseOperationPins(operationId)` removes the coordinator record, process-pin tree, and operation-owned projection only after all local readers are closed. Capture a descriptor, switch the current manifest to a new generation, and prove the old pinned descriptor still reads while protected. Reject a missing quota, quota for another root/max, descriptor version other than numeric `1`, digest mismatch, absolute/traversal filenames, wrong canonical root, wrong numeric revision, untrusted operation/lock roots, a missing coordinator mapping, and missing retired files before any query/provider call.

Add deterministic lock-race tests with barriers injected into `pinCurrentManifest()` and `retireUnpinnedSources()`: retirement obtains the global shared lock first and the opener retries against the post-retirement manifest; the opener obtains it first and retirement observes the visible per-process pin and retains every descriptor file. Also switch the manifest between the first read and pin write and assert the half-open pin is removed and retried. Hash the complete target tree before and after lock acquisition and prove no target file or target-local lock is created, omitted, or specially excluded from comparison.

Use a temporary Home23 root with coordinator pins in two requester agents and two process-identity directories per operation to prove global discovery matches durable `instances/*/runtime/brain-operations/operations/*/coordinator-source-pin.json` and `instances/*/runtime/brain-operations/operations/*/pins/*/*.json`, plus the explicitly supported legacy/standalone flat equivalents beneath `brain-operations/*/` (excluding the `operations` container itself). Retirement treats both record forms as protection. Stale recovery deletes a process pin only when its recorded PID/process-start identity is dead **and** `getOperationState(operationId)` is terminal or absent; coordinator pins are released only through idempotent terminal operation cleanup. A dead PID attached to a nonterminal operation remains until coordinator reconciliation marks it `interrupted`, after which terminal cleanup and the next prune remove the coordinator/process records.

Add cancellation tests that abort during committed-delta overlay and midway through a base iterator. Assert the next iterator step rejects with `AbortError`, record-consumption counters stop increasing, and evidence is not rewritten to `sourceHealth: 'unavailable'`. Inject a real node/edge read failure after at least one emitted record and assert the next iterator step rejects with typed retryable `source_unavailable`, evidence becomes unavailable/unknown, and search/query never reports a partial result or false empty source.

Table-test committed-delta corruption before any search/query assertion: missing
delta (including a declared empty delta), physical size below committedBytes,
cutoff in the middle of a JSON record, malformed committed JSON, wrong epoch,
wrong first/last revision, skipped/duplicate revision or sequence, record count
mismatch, and manifest from/to/count inconsistent with base/current revision.
Every case must reject with typed retryable `source_unavailable`, set evidence
to unavailable/unknown, close/delete any partial overlay, and make it impossible
to report partial matches, `no_match`, or `corpus_empty`. Bytes strictly after a
valid committed cutoff remain ignored as an uncommitted crash tail.

Feed a manifest larger than 1 MiB and one carrying tag/cluster maps or unknown
nested objects. Drive the diagnostic helper with more than 10,000 entries and
multi-megabyte error messages, then exercise the same helper through repeated
legacy-fallback diagnostics. Manifest read rejects before allocation beyond
the cap; evidence retains at most 64 diagnostics/32 KiB plus an exact dropped
count and remains degraded/unknown rather than growing with the input.

For manifest, native base/delta/ANN, legacy sidecar, and legacy research
snapshot paths, replace each basename with an inside-root and outside-root
symlink at discovery, between lstat/open, and before writer append. All reads
and writes fail before crossing the link; the outside file hash is unchanged.

For each node and edge base independently, test a zero-byte file, truncated
gzip member, physical compressed size smaller/larger than manifest bytes, and a
valid gzip containing fewer/more complete records than manifest count. Pin/open
rejects size/empty corruption before status can be ok; a complete scan verifies
the record count at EOF. Every mismatch is unavailable/unknown and cannot
produce healthy `no_match` or `corpus_empty`. A consumer that intentionally
stops an iterator early never claims complete coverage.

Add an adversarial keyword fixture containing 10,000 maximum-size records with large embeddings/metadata/text. `searchKeyword({topK:100})` must retain only bounded projected fields, omit embeddings, cap any one returned projection at 256 KiB and the complete JSON result at 8 MiB, keep deterministic best candidates with a fixed-size heap, and report truncation/omission in evidence. It may not retain the original node object. A result that cannot preserve its ID plus bounded match text fails typed `result_too_large`; it never grows until V8 OOM.

Add a short-token canary whose only match is `AI` and assert keyword search and
the public search service return it with complete-coverage evidence. A query
containing only punctuation/whitespace rejects as `invalid_request` before the
first source record is consumed. One- and two-character Unicode/alphanumeric
tokens are supported; token count and per-token UTF-8 bytes remain bounded.

Add a committed-delta fixture large enough to exceed an 8-MiB in-memory
overlay. With a trusted requester `operationRoot`, prove the reader spills into
one private SQLite overlay beneath `<operationRoot>/overlay/`, keeps JS overlay
retention below 16 MiB, returns the exact final logical nodes/edges, and removes
the database/WAL/SHM on `close()`. Hash the target before/after. Repeat without
an operation root and require typed `source_operation_required` at the spill
threshold—not an OOM or partial result. Set a tiny `maxOverlayDiskBytes` and a
separate tiny aggregate operation scratch quota; each requires typed 413
`result_too_large` plus cleanup. Race concurrent quota claims and prove the
aggregate never crosses its ceiling. Abort during spill/import and
iteration; statement processing stops, the error remains `AbortError`, and
private files are removed.

Use one quota instance across overlay, resident projection, research projection,
and graph export. Make each component individually fit while their combined
bytes exceed the injected aggregate ceiling; the crossing write fails before
disk growth with nonretryable `result_too_large`, all partial files are cleaned,
and the target hash is unchanged. Repeat with SQLite journal growth and a
parallel projection/export claim race. No SQLite file-backed temp directory may
exist because `temp_store=MEMORY` is mandatory.

Test `withEphemeralMemorySource()` with native, legacy resident, and legacy
research fixtures. It derives—not accepts—one safe operation ID/root and the
global lock root from trusted `home23Root` plus `requesterAgent`; realpaths the
target; proves operation/lock roots do not cross the target; passes the
operation context to `openMemorySource()`; and in nested `finally` blocks closes
the source before recursively removing only that operation root. Cover callback
success, source-open failure, callback failure, abort, spill database, and
legacy projection. The target hash is identical and no operation directory
survives.

Test `createInstalledLocalSourceContext()` against a configured resident agent,
the one exact active research run, a completed run, an unrelated resident, and
duplicate/symlink spellings. It reads only trusted installation/env/config
inputs, builds a fresh Plan A canonical catalog per resolution, and selects by
realpath equality with the process `brainDir`, never display name or caller
selector. A resident matches only its configured owner and returns
`accessMode:'own'`; an active research run matches only the injected canonical
`activeRunPath` and returns `accessMode:'owned-run'`; completed, unavailable,
unowned, ambiguous, or root-mismatched contexts fail closed. Assert no catalog,
target, or source mutation and no config contents in logs.

- [ ] **Step 2: Run both reader suites and verify the red state**

Run:

~~~bash
node --test --test-concurrency=1 tests/shared/memory-source-reader.test.js tests/shared/memory-source-adapters.test.js tests/shared/memory-source-pin.test.js
~~~

Expected: FAIL because `openMemorySource` and `readManifest` are not exported.

- [ ] **Step 3: Implement manifest validation and legacy projection**

Create `shared/memory-source/manifest.cjs` with:

~~~js
'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { normalizeRevision } = require('./contracts.cjs');
const {
  openConfinedRegularFile, assertStableOpenedFile, assertConfinedRegularFiles,
  probeConfinedRegularFiles, assertConfinedDirectory,
  createConfinedExclusiveFile, rejectExistingSymlink,
} = require('./confined-file.cjs');

const MANIFEST_FILE = 'memory-manifest.json';
const MAX_MANIFEST_BYTES = 1024 * 1024;

function manifestPath(brainDir) {
  return path.join(brainDir, MANIFEST_FILE);
}

function validateManifest(manifest) {
  if (!manifest || manifest.formatVersion !== 1) throw new Error('unsupported_memory_manifest');
  const baseRevision = normalizeRevision(manifest.baseRevision);
  const currentRevision = normalizeRevision(manifest.currentRevision);
  if (baseRevision === null || currentRevision === null || currentRevision < baseRevision) {
    throw new Error('invalid_memory_revision');
  }
  if (!manifest.generation || !manifest.activeBase?.nodes?.file || !manifest.activeBase?.edges?.file) {
    throw new Error('invalid_memory_manifest_files');
  }
  if (!manifest.activeDelta?.file || manifest.activeDelta.epoch !== manifest.activeDeltaEpoch) {
    throw new Error('invalid_memory_delta_epoch');
  }
  const expectedCount = currentRevision - baseRevision;
  if (manifest.activeDelta.fromRevision !== baseRevision + 1
      || manifest.activeDelta.toRevision !== currentRevision
      || manifest.activeDelta.count !== expectedCount
      || !Number.isSafeInteger(manifest.activeDelta.count)
      || manifest.activeDelta.count < 0) {
    throw new Error('invalid_memory_delta_range');
  }
  for (const file of [
    manifest.activeBase.nodes.file,
    manifest.activeBase.edges.file,
    manifest.activeDelta.file,
    manifest.ann?.indexFile,
    manifest.ann?.metaFile,
  ].filter(Boolean)) {
    if (path.isAbsolute(file) || path.basename(file) !== file || file === '.' || file === '..') {
      throw new Error('invalid_memory_manifest_path');
    }
  }
  if (!Number.isSafeInteger(manifest.activeDelta.committedBytes) ||
      manifest.activeDelta.committedBytes < 0) {
    throw new Error('invalid_memory_delta_cutoff');
  }
  for (const field of ['nodeCount', 'edgeCount', 'clusterCount']) {
    if (!Number.isSafeInteger(manifest.summary?.[field]) || manifest.summary[field] < 0) {
      throw new Error('invalid_memory_summary');
    }
  }
  return manifest;
}

// validateManifest() also applies assertExactKeys() to the top level and to
// activeBase.nodes, activeBase.edges, activeDelta, ann, and summary. Summary
// has exactly nodeCount, edgeCount, and clusterCount safe-integer scalars;
// tag/cluster maps and unknown nested data are rejected. Base count/byte and
// delta byte/range fields are nonnegative safe integers, while epochs,
// generation, and timestamps are bounded strings. openConfinedRegularFile()
// maps link/escape/type/stability failures to invalid_memory_source and
// ordinary missing/I/O failures to retryable source_unavailable; it preserves
// already typed limit and cancellation errors unchanged.

async function readManifest(brainDir) {
  let opened;
  try {
    opened = await openConfinedRegularFile(brainDir, manifestPath(brainDir), {
      flags: fs.constants.O_RDONLY, maxBytes: MAX_MANIFEST_BYTES, optional: true,
    });
    if (opened === null) return null;
    const parsed = JSON.parse(await opened.handle.readFile('utf8'));
    await assertStableOpenedFile(opened);
    return validateManifest(parsed);
  } finally {
    await opened?.handle.close();
  }
}

async function findLegacyResidentSidecars(brainDir) {
  const files = {
    nodes: path.join(brainDir, 'memory-nodes.jsonl.gz'),
    edges: path.join(brainDir, 'memory-edges.jsonl.gz'),
    delta: path.join(brainDir, 'memory-delta.jsonl'),
  };
  const present = await probeConfinedRegularFiles(brainDir, [files.nodes, files.edges]);
  return present ? files : null;
}

async function resolveMemorySourceSelection(brainDir) {
  const canonicalRoot = await fsp.realpath(brainDir);
  const manifest = await readManifest(canonicalRoot);
  const advisorySnapshot = path.join(canonicalRoot, 'brain-snapshot.json');
  if (manifest) {
    return {
      authority: 'manifest-v1', canonicalRoot, manifest,
      targetFiles: [
        { role: 'manifest', path: manifestPath(canonicalRoot) },
        { role: 'nodes', path: path.join(canonicalRoot, manifest.activeBase.nodes.file) },
        { role: 'edges', path: path.join(canonicalRoot, manifest.activeBase.edges.file) },
        {
          role: 'delta', path: path.join(canonicalRoot, manifest.activeDelta.file),
          committedBytes: manifest.activeDelta.committedBytes,
        },
        ...(manifest.ann?.indexFile ? [{ role: 'ann-index', path: path.join(canonicalRoot, manifest.ann.indexFile) }] : []),
        ...(manifest.ann?.metaFile ? [{ role: 'ann-meta', path: path.join(canonicalRoot, manifest.ann.metaFile) }] : []),
        { role: 'snapshot-advisory', path: advisorySnapshot, optional: true },
      ],
    };
  }
  const resident = await findLegacyResidentSidecars(canonicalRoot);
  if (resident) {
    return {
      authority: 'legacy-resident-sidecars', canonicalRoot, manifest: null,
      targetFiles: [
        { role: 'legacy-nodes', path: resident.nodes },
        { role: 'legacy-edges', path: resident.edges },
        { role: 'legacy-delta', path: resident.delta, optional: true },
        { role: 'snapshot-advisory', path: advisorySnapshot, optional: true },
      ],
    };
  }
  for (const name of ['state.json.gz', 'state.json']) {
    const stateFile = path.join(canonicalRoot, name);
    try {
      const opened = await openConfinedRegularFile(canonicalRoot, stateFile, {
        flags: fs.constants.O_RDONLY, optional: true,
      });
      if (opened === null) continue;
      await opened.handle.close();
      return {
        authority: 'legacy-research-snapshot', canonicalRoot, manifest: null,
        targetFiles: [
          { role: 'legacy-state', path: stateFile },
          { role: 'snapshot-advisory', path: advisorySnapshot, optional: true },
        ],
      };
    } catch (error) { throw error; }
  }
  return { authority: 'unavailable', canonicalRoot, manifest: null, targetFiles: [] };
}

module.exports = {
  MANIFEST_FILE, manifestPath, validateManifest, readManifest,
  findLegacyResidentSidecars, resolveMemorySourceSelection,
};
~~~

Create `shared/memory-source/scratch-quota.cjs` with
`createOperationScratchQuota({operationRoot,maxBytes=8*1024*1024*1024,signal})`.
It realpaths one trusted requester operation root, rejects links, and exposes
serialized `claim(bytes,kind)`, `release(bytes,kind)`, `reconcile()`, and a
bounded counting transform/writer, plus `assertOperationRoot(root)` and
handle-only `close()`. Claims fail before crossing the aggregate
ceiling. Process-local handles coordinate through one atomic, fsynced
`.scratch-quota.json` ledger and bounded `.scratch-quota.lock` inside that
operation root; the ledger/lock bytes count toward the quota, carry the exact
operation-root identity and maximum, and are never caller-selectable. A stale
lock is recovered only after its recorded process identity is proven dead.
Reconciliation recursively lstats without following links and counts
every private file, including SQLite journals/temp, projection attempts, and
graph-export temp/final files; it runs at construction, after every 64 MiB of
claims, and before final publish. Concurrent claims from two processes prove
the logical total never crosses the cap. Cleanup releases only bytes actually
removed, and any mismatch fails closed as nonretryable `result_too_large`.

Create `shared/memory-source/overlay-store.cjs`. It starts with byte-accounted
Maps/Sets capped at 8 MiB, then atomically spills the exact latest node/edge
upserts and tombstones into `better-sqlite3` under a trusted operation-owned
`overlay/` directory. Tables use primary keys and prepared upsert/delete
statements; WAL is disabled (`journal_mode=DELETE`), `temp_store=MEMORY`, and
database/journal growth is claimed from the shared operation quota in addition
to the component's default 2-GiB ceiling. It exposes lookup methods and streaming ordered
upsert iterators without returning arrays. Each delta record is capped by
`readJsonl`; the store never retains a raw record after application. It checks
cancellation between statements, closes before cleanup, and owns idempotent
`close()` that deletes only its operation-private database/journal. If no trusted
operation root exists, exceeding the in-memory threshold throws
`source_operation_required`. Export `createBoundedOverlayStore()` through the
shared index and add the root `better-sqlite3` dependency to its focused tests'
dependency check (it is already a root runtime dependency).

Create `shared/memory-source/operation-context.cjs` with
`withEphemeralMemorySource({brainDir,home23Root,requesterAgent,identity,signal,
prefix='local',uuid=randomUUID}, callback)`. Validate `home23Root` as an
absolute trusted root, requester/prefix as safe path segments, and UUID output
as a safe suffix. Derive the operation root only as
`<home23Root>/instances/<requesterAgent>/runtime/brain-operations/<prefix>-<uuid>`
and the lock root only as `<home23Root>/runtime/brain-source-locks`; reject any
target crossing before `mkdir`. Call `openMemorySource()` with that exact
context plus one `createOperationScratchQuota()` instance and never expose
operation/lock/quota selection to HTTP/MCP/tool input.
Require the input identity to contain the canonical target fields but no
caller-chosen `operationId`; derive the effective identity as
`{...identity,operationId}` and pass that both to the source and to callback
`(source,{operationId,operationRoot,lockRoot,scratchQuota,identity:effectiveIdentity})`.
Close the source, then remove the operation root in nested `finally` blocks.
Export this helper from the shared index. Foundation durable operations create
the same quota once from their durable operation root and pass it through worker
context; they do not call this ephemeral helper.

Also export `createInstalledLocalSourceContext({home23Root,requesterAgent,
brainDir,activeRunPath=null,env=process.env,buildCatalog=buildCanonicalCatalog})`.
It derives canonical `instancesRoot`, local `cosmo23/runs`, normalized
`COSMO_REFERENCE_RUNS_PATHS`, and configured agents from
`config/agents.json`; no public/tool argument can override those roots. Its
`resolveTargetContext({})` builds a fresh Plan A catalog, finds exactly one entry
whose canonical root equals the real process brain root, applies the
resident/active-run ownership rules above, and returns frozen
`{catalogRevision,target,accessMode}`. Any nonempty selector is
`invalid_request`. Return the trusted bundle
`{home23Root,requesterAgent,brainDir,resolveTargetContext}` for AgentExecutor,
MCPBridge, HTTP, and stdio construction.

Create `shared/memory-source/legacy-projection.cjs` with `projectLegacyResidentSidecars({canonicalRoot,operationRoot,scratchQuota,signal,maxDeltaRecords,maxRecordBytes,maxOverlayDiskBytes})`. It must:

1. Realpath the target and trusted operation root, require the operation root to be outside the target, and create temporary files only below `<operationRoot>/source-projections/.tmp-*`.
2. Stable-stat the legacy node/edge sidecars and optional committed delta, then stream their raw/logical bytes into SHA-256 without `readFile`, `gunzip(Buffer)`, a full-array parse, or target writes. Apply the delta through `createBoundedOverlayStore()`; record count, in-memory bytes, per-record bytes, and spill-disk bytes are all independently capped. Never build unbounded delta maps.
3. Stream the base node and edge iterators a second time, applying the bounded overlay and writing directly with backpressure to temporary gzip JSONL base files. Claim every compressed output byte from the shared scratch quota before write. Append remaining upserts, produce an empty committed v1 delta, and never retain a full node or edge collection.
4. Re-stat every source file. On a change, remove the temporary projection and retry from the new fingerprint up to the bounded retry count; repeated change returns typed retryable `source_changed`.
5. Derive `revision = Number.parseInt(sha256.slice(0, 13), 16)`, prove it is a nonnegative safe integer, set both base/current revision to that value, and name the immutable generation `legacy-<first-20-hex>`. Atomically publish beneath `<operationRoot>/source-projections/<generation>` using no-overwrite creation. A collision is reusable only after its manifest and content digest match.
6. Return a format-v1 descriptor whose public `canonicalRoot` remains the target root, whose physical projection root remains only in the trusted coordinator pin record, and whose evidence is degraded/freshness-unknown. No format-v0 descriptor is ever returned or accepted.

- [ ] **Step 4: Implement the pinned logical reader**

Create `shared/memory-source/pins.cjs` first. It is the **only** owner of the reader/writer lock. `withMemorySourceLock(canonicalRoot, {lockRoot}, fn)` canonicalizes the target, hashes that canonical string with SHA-256, and acquires `<lockRoot>/<canonical-root-sha256>` as an atomic directory with bounded retry/jitter and owner metadata (`pid`, process-start/boot identity, `createdAt`). Make lock publication crash-safe: create a unique sibling candidate directory, atomically write/fsync its owner record, fsync the candidate, and only then rename it to the final hash path; an existing final path means contention. A crash may leave a non-authoritative candidate that bounded cleanup can remove, but can never expose a final lock without valid owner identity. Tests inject faults before owner rename, after owner fsync, and before final-directory rename; none may produce a permanent ownerless final lock.

Trusted adapters derive `lockRoot` as the ignored global `<home23Root>/runtime/brain-source-locks`; public input can never select it. Require `lockRoot` to be outside `canonicalRoot`. Lock recovery may remove an abandoned published lock only after validating its owner record and proving that exact process identity is dead; a missing/corrupt final owner fails closed for operator repair rather than guessing. Timeout is a typed retryable `source_busy`. `writer.cjs` imports this function and must not define a second lock. Because the lock is outside the target, complete target-tree hashes have no lock exclusion and an unexpected target-local `.memory-source.lock` fails the no-write test.

`pinOperationSource({canonicalRoot,operationRoot,operationId,requesterAgent,lockRoot,scratchQuota,signal})` is the coordinator/provider pin primitive. It requires a reconciled quota handle bound to the same operation root, canonicalizes the root, validates the trusted requester operation directory outside the target, and takes the shared external lock. If `<operationRoot>/coordinator-source-pin.json` already exists, it validates owner/path identity, canonical descriptor digest, protected files/cutoff, source fingerprint, and any projection realpath, then returns exactly its stored `{descriptor,digest}` without opening a source or changing the file. Otherwise it resolves a native numeric-v1 manifest or builds the immutable resident-sidecar projection with that quota, validates stable stats, constructs the public descriptor, computes `sourceDescriptorDigest(descriptor)`, and atomically/fsync publishes one private coordinator record. The private record may contain `physicalRoot`, `projectionRoot`, `sourceFingerprint`, and protected filenames; none appears in the return value. Still under the lock it rechecks native manifest identity or legacy fingerprint before publish. An injected failure before rename leaves no record; a lost response after rename is recovered by the next identical call. Because retirement takes this same lock and discovers coordinator records, the returned descriptor's generation is protected across crash before foundation `attachSourcePin()`.

For a native generation, pinning opens every manifest/base/delta/ANN file with
the shared confined no-follow helper while holding the external lock, records
device/inode/size identity in the private coordinator record, and rechecks it
before publish. `openPinnedSource()` repeats those checks and streams through
the already validated file handles; it never validates one path and later
reopens a replacement pathname. Legacy projection/snapshot discovery applies
the same no-follow stable-handle rule to every source file. Writer append opens
the active delta `O_RDWR|O_NOFOLLOW`, verifies the recorded inode and committed
size, writes by explicit offset, and rechecks the pathname/inode before manifest
publish; it never uses `a+` or follows a basename link.

`pinCurrentManifest()` and `pinManifestDescriptor()` are process-reader primitives, not coordinator attachment primitives. They atomically write `<operationRoot>/pins/<processIdentity>/<canonical-root-hash>.json` only when a caller actually opens a source. The process record contains `canonicalRoot`, `operationId`, `requesterAgent`, `generation`, numeric revision, exact base/delta/ANN filenames and committed cutoff, PID/process-start/boot identity, `createdAt`, and `heartbeatAt`. `pinManifestDescriptor()` first validates the capability descriptor and expected digest against `coordinator-source-pin.json`, then writes/rechecks the separate process pin under the same external lock. Retirement therefore sees both durable coordinator protection and every live process reader.

`discoverOperationPinFiles(home23Root)` enumerates exactly the durable `<home23Root>/instances/*/runtime/brain-operations/operations/*/coordinator-source-pin.json` and `.../operations/*/pins/*/*.json` records plus explicitly supported legacy/standalone flat records beneath `brain-operations/*/`; it does not recursively scan arbitrary runtime directories and never treats the `operations` container as a flat operation. It validates requester/operation/process identities against their canonical containing paths before returning records. `pruneStalePins(home23Root, {getOperationState,isProcessAlive,clock})` removes only process pins when both the recorded process identity is dead and the operation is terminal or absent. Coordinator pins are not age/PID-pruned; the pin provider's idempotent `releaseOperationPins(operationId)` removes the coordinator record, process tree, and private projection only after terminal reconciliation. Detachment/reconnect never calls either release path.

`resolvePinnedPhysicalRoot()` reads only the trusted `coordinator-source-pin.json` under that exact requester operation, verifies its descriptor/digest against the capability-derived expectations, returns `{physicalRoot,sourceFingerprint}`, and validates that native sources resolve to the target while legacy projections resolve beneath that operation's `source-projections/`. It never accepts either value from a descriptor or request. The process pin records do not carry or choose a projection mapping.

At production dashboard startup, first run the foundation coordinator's interrupted-operation reconciliation, then call `sourcePins.recoverPins({getOperationState,isProcessAlive,clock})`, then admit new operations or run retirement. Add an integration test with a dead worker/nonterminal record proving the first pass retains its pin, reconciliation marks `interrupted`, and the second pass removes it. Validate `operationId` as one safe path segment before deriving pin/release paths.

Create `shared/memory-source/reader.cjs` with these concrete rules:

~~~js
'use strict';

const fsp = require('node:fs').promises;
const path = require('node:path');
const { readJsonl } = require('./jsonl.cjs');
const { createBoundedOverlayStore, createEmptyOverlayStore } = require('./overlay-store.cjs');
const { createOperationScratchQuota } = require('./scratch-quota.cjs');
const {
  readManifest, validateManifest, findLegacyResidentSidecars, resolveMemorySourceSelection,
} = require('./manifest.cjs');
const {
  projectLegacyResidentSidecars, verifyLegacySourceFingerprint,
} = require('./legacy-projection.cjs');
const {
  pinCurrentManifest, pinManifestDescriptor, resolvePinnedPhysicalRoot,
  pinOperationSource, releaseOperationSource, pruneStalePins, validateOperationId,
} = require('./pins.cjs');
const {
  SOURCE_HEALTH,
  MATCH_OUTCOME,
  normalizeId,
  edgeKeyFor,
  classifyMatchOutcome,
  createEvidence,
  sourceDescriptorDigest,
  rethrowAbort,
  throwIfAborted,
} = require('./contracts.cjs');

function activeFiles(manifest) {
  return [
    manifest.activeBase.nodes.file,
    manifest.activeBase.edges.file,
    manifest.activeDelta.file,
    manifest.ann?.indexFile,
    manifest.ann?.metaFile,
  ].filter(Boolean);
}

function enumerateMemoryMutationBoundaries(canonicalRoot, {
  manifest, kind = 'resident', extra = [],
} = {}) {
  const standard = new Map([
    ['brain', '.'],
    ['run', '.'],
    ['pgs', 'pgs-sessions'],
    ['session', 'sessions'],
    ['cache', 'cache'],
    ['export', 'exports'],
    ['agency', 'agency'],
  ]);
  const overrides = new Map();
  for (const boundary of extra) {
    if (!boundary || !standard.has(boundary.kind) || typeof boundary.path !== 'string' ||
        overrides.has(boundary.kind)) {
      throw Object.assign(new Error('exactly one known path per mutation boundary kind required'), {
        code: 'invalid_request',
      });
    }
    overrides.set(boundary.kind, boundary.path);
  }
  const candidates = [...standard].map(([boundaryKind, defaultPath]) => ({
    kind: boundaryKind,
    path: overrides.get(boundaryKind) || defaultPath,
  }));
  const normalized = candidates.map(boundary => {
    if (!boundary || typeof boundary.kind !== 'string' || typeof boundary.path !== 'string') {
      throw Object.assign(new Error('named mutation boundary required'), { code: 'invalid_request' });
    }
    const absolute = path.resolve(canonicalRoot, boundary.path);
    const crossing = path.relative(canonicalRoot, absolute);
    if (crossing === '..' || crossing.startsWith('..' + path.sep) || path.isAbsolute(crossing)) {
      throw Object.assign(new Error('mutation boundary escapes target root'), {
        code: 'invalid_request',
      });
    }
    return Object.freeze({ kind: boundary.kind, path: absolute });
  });
  const result = normalized.sort((a, b) =>
    a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path));
  const kinds = new Set(result.map(value => value.kind));
  for (const required of standard.keys()) {
    if (!kinds.has(required)) throw new Error('missing_mutation_boundary:' + required);
  }
  if (result.length !== 7 || kinds.size !== 7) throw new Error('invalid_mutation_boundary_cardinality');
  return Object.freeze(result);
}

async function loadOverlay(brainDir, manifest, diagnostics, {
  signal, operationRoot = null, maxOverlayMemoryBytes = 8 * 1024 * 1024,
  maxOverlayDiskBytes = 2 * 1024 * 1024 * 1024, scratchQuota,
} = {}) {
  throwIfAborted(signal);
  const overlay = await createBoundedOverlayStore({
    operationRoot, signal, scratchQuota, maxMemoryBytes: maxOverlayMemoryBytes,
    maxDiskBytes: maxOverlayDiskBytes,
  });
  let appliedRecords = 0;
  let expectedRevision = manifest.baseRevision === null ? null : manifest.baseRevision + 1;
  let expectedSequence = 1;
  const deltaPath = path.join(brainDir, manifest.activeDelta.file);
  try {
    for await (const entry of readJsonl(deltaPath, {
      byteLimit: manifest.activeDelta.committedBytes,
      requireCompletePrefix: true,
      allowTrailingBytes: true,
      confinedRoot: brainDir,
      signal,
    })) {
      throwIfAborted(signal);
      if (entry.epoch !== manifest.activeDeltaEpoch
          || entry.revision !== expectedRevision
          || entry.sequence !== expectedSequence) {
        throw Object.assign(new Error('committed delta is not contiguous'), {
          code: 'source_unavailable', retryable: true,
        });
      }
      expectedRevision += 1;
      expectedSequence += 1;
      await overlay.apply(entry);
      appliedRecords += 1;
    }
    if (appliedRecords !== manifest.activeDelta.count
        || expectedRevision !== manifest.currentRevision + 1
        || expectedSequence !== manifest.activeDelta.count + 1) {
      throw Object.assign(new Error('committed delta is incomplete'), {
        code: 'source_unavailable', retryable: true,
      });
    }
  } catch (error) {
    rethrowAbort(error, signal);
    await overlay.close();
    if (isTypedMemorySourceError(error)) throw error;
    throw Object.assign(new Error('committed delta is unreadable'), {
      code: 'source_unavailable', retryable: true, cause: error,
    });
  }
  return Object.assign(overlay, { appliedRecords });
}

async function openMemorySource(brainDir, options = {}) {
  throwIfAborted(options.signal);
  const canonicalRoot = await fsp.realpath(brainDir).catch(() => path.resolve(brainDir));
  const diagnostics = createDiagnosticRing({
    maxEntries: 64, maxBytes: 32 * 1024, maxEntryBytes: 512,
  });
  let manifest;
  let pinFile = null;
  let sourceRoot = canonicalRoot;
  let legacyFingerprint = options.legacySourceFingerprint || null;
  let health = SOURCE_HEALTH.HEALTHY;
  try {
    if (options.pinnedManifest) {
      manifest = validateManifest(options.pinnedManifest);
      sourceRoot = options.physicalProjectionRoot || canonicalRoot;
      pinFile = options.operationRoot
        ? await pinManifestDescriptor({
            brainDir: sourceRoot,
            canonicalRoot,
            operationRoot: options.operationRoot,
            lockRoot: options.lockRoot,
            operationId: options.operationId,
            requesterAgent: options.requesterAgent,
            manifest,
            expectedDigest: options.expectedDigest,
          })
        : null;
    } else if (options.operationRoot && await readManifest(canonicalRoot)) {
      ({ manifest, pinFile } = await pinCurrentManifest({
        brainDir: canonicalRoot,
        operationRoot: options.operationRoot,
        lockRoot: options.lockRoot,
        operationId: options.operationId,
        requesterAgent: options.requesterAgent,
      }));
    } else {
      manifest = await readManifest(canonicalRoot);
      if (!manifest) {
        const legacyFiles = await findLegacyResidentSidecars(canonicalRoot);
        if (legacyFiles) {
          if (!options.operationRoot || !options.lockRoot) {
            throw Object.assign(new Error('requester operation projection required'), {
              code: 'source_operation_required',
            });
          }
          const projection = await projectLegacyResidentSidecars({
            canonicalRoot,
            operationRoot: options.operationRoot,
            scratchQuota: options.scratchQuota,
            signal: options.signal,
          });
          manifest = projection.manifest;
          sourceRoot = projection.projectionRoot;
          legacyFingerprint = projection.sourceFingerprint;
          ({ pinFile } = await pinManifestDescriptor({
            brainDir: sourceRoot,
            canonicalRoot,
            operationRoot: options.operationRoot,
            lockRoot: options.lockRoot,
            operationId: options.operationId,
            requesterAgent: options.requesterAgent,
            manifest,
            projectionRoot: sourceRoot,
            expectedDigest: options.expectedDigest,
          }));
        }
      }
    }
  } catch (error) {
    rethrowAbort(error, options.signal);
    if (isTypedMemorySourceError(error)
        && !['source_unavailable', 'invalid_memory_source'].includes(error.code)) {
      throw error;
    }
    manifest = null;
    health = SOURCE_HEALTH.UNAVAILABLE;
    diagnostics.push('manifest_error:' + error.message);
  }
  if (!manifest && health !== SOURCE_HEALTH.UNAVAILABLE) {
    health = SOURCE_HEALTH.UNAVAILABLE;
    diagnostics.push('authoritative_source_missing');
  }
  if (manifest?.sourceMode === 'legacy_projection') {
    health = SOURCE_HEALTH.DEGRADED;
    diagnostics.push('legacy_source_projection');
  }
  if (manifest) {
    try {
      await assertConfinedRegularFiles(sourceRoot, [
        { path: path.join(sourceRoot, manifest.activeBase.nodes.file),
          expectedBytes: manifest.activeBase.nodes.bytes, allowEmpty: false },
        { path: path.join(sourceRoot, manifest.activeBase.edges.file),
          expectedBytes: manifest.activeBase.edges.bytes, allowEmpty: false },
        { path: path.join(sourceRoot, manifest.activeDelta.file),
          minimumBytes: manifest.activeDelta.committedBytes, allowEmpty: true },
        ...[manifest.ann?.indexFile, manifest.ann?.metaFile].filter(Boolean)
          .map(file => ({ path: path.join(sourceRoot, file), allowEmpty: false })),
      ]);
    } catch (error) {
      rethrowAbort(error, options.signal);
      health = SOURCE_HEALTH.UNAVAILABLE;
      diagnostics.push('active_source_unavailable:' + error.message);
    }
  }
  const mutationBoundaries = options.mutationBoundaries
    ? enumerateMemoryMutationBoundaries(canonicalRoot, {
        manifest: null,
        extra: options.mutationBoundaries.map(boundary => ({
          kind: boundary.kind,
          path: path.relative(canonicalRoot, boundary.path),
        })),
      })
    : enumerateMemoryMutationBoundaries(canonicalRoot, {
        manifest, kind: options.identity?.kind,
  });
  let appliedRecords = 0;
  let overlayPromise = null;
  let openedOverlay = null;
  async function getOverlay(signal) {
    if (!manifest) return createEmptyOverlayStore();
    try {
      overlayPromise ||= loadOverlay(sourceRoot, manifest, diagnostics, {
        signal, operationRoot: options.operationRoot,
        scratchQuota: options.scratchQuota,
        maxOverlayMemoryBytes: options.maxOverlayMemoryBytes,
        maxOverlayDiskBytes: options.maxOverlayDiskBytes,
      });
      const overlay = await overlayPromise;
      throwIfAborted(signal);
      openedOverlay = overlay;
      appliedRecords = Math.max(appliedRecords, overlay.appliedRecords);
      return overlay;
    } catch (error) {
      rethrowAbort(error, signal);
      if (['source_unavailable', 'source_changed', 'invalid_memory_source'].includes(error?.code)) {
        health = SOURCE_HEALTH.UNAVAILABLE;
        diagnostics.push('delta_read_error:' + error.message);
      }
      if (isTypedMemorySourceError(error)) throw error;
      health = SOURCE_HEALTH.UNAVAILABLE;
      diagnostics.push('delta_read_error:' + error.message);
      throw Object.assign(new Error('authoritative delta source became unavailable'), {
        code: 'source_unavailable', retryable: true, cause: error,
      });
    }
  }

  async function* iterateNodes(iterOptions = {}) {
    if (!manifest) return;
    throwIfAborted(iterOptions.signal);
    if (iterOptions.filter !== undefined && typeof iterOptions.filter !== 'function') {
      throw Object.assign(new Error('filter_invalid'), { code: 'invalid_request' });
    }
    const overlay = await getOverlay(iterOptions.signal);
    try {
      const baseNodes = readJsonl(path.join(sourceRoot, manifest.activeBase.nodes.file), {
        gzip: true,
        confinedRoot: sourceRoot,
        expectedInputBytes: manifest.activeBase.nodes.bytes,
        expectedRecordCount: manifest.activeBase.nodes.count,
        signal: iterOptions.signal,
      });
      for await (const node of baseNodes) {
        throwIfAborted(iterOptions.signal);
        const id = normalizeId(node.id);
        if (overlay.hasRemovedNode(id) || overlay.hasNodeUpsert(id)) continue;
        if (!iterOptions.filter || iterOptions.filter(node)) yield node;
      }
      for await (const node of overlay.iterateNodeUpserts({ signal: iterOptions.signal })) {
        throwIfAborted(iterOptions.signal);
        if (!iterOptions.filter || iterOptions.filter(node)) yield node;
      }
    } catch (error) {
      rethrowAbort(error, iterOptions.signal);
      if (error?.code === 'source_unavailable' || error?.code === 'invalid_memory_source') {
        health = SOURCE_HEALTH.UNAVAILABLE;
        diagnostics.push('node_read_error:' + error.message);
      }
      throw error;
    }
  }

  async function* iterateEdges(iterOptions = {}) {
    if (!manifest) return;
    throwIfAborted(iterOptions.signal);
    if (iterOptions.filter !== undefined && typeof iterOptions.filter !== 'function') {
      throw Object.assign(new Error('filter_invalid'), { code: 'invalid_request' });
    }
    const overlay = await getOverlay(iterOptions.signal);
    const eligible = edge => {
      const source = normalizeId(edge.source ?? edge.from);
      const target = normalizeId(edge.target ?? edge.to);
      return !overlay.hasRemovedNode(source) && !overlay.hasRemovedNode(target);
    };
    try {
      const baseEdges = readJsonl(path.join(sourceRoot, manifest.activeBase.edges.file), {
        gzip: true,
        confinedRoot: sourceRoot,
        expectedInputBytes: manifest.activeBase.edges.bytes,
        expectedRecordCount: manifest.activeBase.edges.count,
        signal: iterOptions.signal,
      });
      for await (const edge of baseEdges) {
        throwIfAborted(iterOptions.signal);
        const key = edgeKeyFor(edge);
        if (overlay.hasRemovedEdge(key) || overlay.hasEdgeUpsert(key) || !eligible(edge)) continue;
        if (!iterOptions.filter || iterOptions.filter(edge)) yield edge;
      }
      for await (const edge of overlay.iterateEdgeUpserts({ signal: iterOptions.signal })) {
        throwIfAborted(iterOptions.signal);
        if (eligible(edge) && (!iterOptions.filter || iterOptions.filter(edge))) yield edge;
      }
    } catch (error) {
      rethrowAbort(error, iterOptions.signal);
      if (error?.code === 'source_unavailable' || error?.code === 'invalid_memory_source') {
        health = SOURCE_HEALTH.UNAVAILABLE;
        diagnostics.push('edge_read_error:' + error.message);
      }
      throw error;
    }
  }

  async function summarize({ signal } = {}) {
    throwIfAborted(signal);
    if (!descriptor?.summary) {
      throw Object.assign(new Error('bounded authoritative summary unavailable'), {
        code: 'source_unavailable', retryable: true,
      });
    }
    return {
      nodes: descriptor.summary.nodeCount,
      edges: descriptor.summary.edgeCount,
      clusters: descriptor.summary.clusterCount,
    };
  }

  async function summarizeBreakdowns({
    signal, maxKeys = 10000, maxBytes = 1024 * 1024,
  } = {}) {
    validateBreakdownLimits({ maxKeys, maxBytes });
    const state = createBoundedBreakdownState({ maxKeys, maxBytes });
    let scannedNodes = 0;
    let activationSum = 0;
    let weightSum = 0;
    const mostAccessed = createFixedTopK(5);
    const highestActivation = createFixedTopK(5);
    for await (const node of iterateNodes({ signal })) {
      throwIfAborted(signal);
      scannedNodes += 1;
      const activation = finiteNumberOrZero(node.activation);
      const weight = finiteNumberOrZero(node.weight);
      activationSum += activation;
      weightSum += weight;
      const preview = projectBoundedStatisticNode(node, { maxConceptBytes: 400 });
      mostAccessed.offer({ node: preview, score: finiteNonnegativeIntegerOrZero(node.accessCount), tieKey: normalizeId(node.id) }, {
        maxRetainedBytes: 32 * 1024,
      });
      highestActivation.offer({ node: preview, score: activation, tieKey: normalizeId(node.id) }, {
        maxRetainedBytes: 32 * 1024,
      });
      // Each scalar is validated/capped before it can become a key. Once either
      // map crosses the shared key/byte budget, discard both maps and continue
      // only the scalar scan count; never return partial maps as exact.
      if (!state.omitted && !state.increment({
        tag: boundedBreakdownKey(node.tag ?? 'unknown'),
        cluster: node.cluster == null ? null : boundedBreakdownKey(normalizeId(node.cluster)),
      })) state.omitAndFree();
    }
    return {
      tags: state.omitted ? null : state.tags,
      clusterTotals: state.omitted ? null : state.clusterTotals,
      omitted: state.omitted,
      scannedNodes,
      averageActivation: scannedNodes ? activationSum / scannedNodes : 0,
      averageWeight: scannedNodes ? weightSum / scannedNodes : 0,
      mostAccessedNodes: mostAccessed.sorted().map(item => item.node),
      highestActivationNodes: highestActivation.sorted().map(item => item.node),
    };
  }

  async function searchKeyword(query, searchOptions = {}) {
    throwIfAborted(searchOptions.signal);
    const words = normalizeKeywordTokens(query);
    const limit = Math.max(1, Math.min(100, Number(searchOptions.topK || 10)));
    const candidates = createFixedTopK(limit);
    let retainedBytes = 0;
    let searched = 0;
    let filtered = 0;
    for await (const node of iterateNodes({ signal: searchOptions.signal })) {
      throwIfAborted(searchOptions.signal);
      searched += 1;
      if (searchOptions.tag && node.tag !== searchOptions.tag) {
        filtered += 1;
        continue;
      }
      // Scan concept/tag/tags independently in bounded chunks with overlap for
      // the longest word. Never join or lowercase the full record and never
      // inspect embeddings, vectors, metadata, or unknown nested fields.
      const matched = matchKeywordFields(node, words, {
        chunkBytes: 64 * 1024,
        maxFieldBytes: 16 * 1024 * 1024,
      });
      if (!matched) continue;
      const projected = projectBoundedSearchNode(node, {
        maxRecordBytes: 256 * 1024,
        omit: ['embedding'],
      });
      retainedBytes = candidates.offer({ node: projected, score: matched / words.length }, {
        maxRetainedBytes: 8 * 1024 * 1024,
      });
    }
    const response = {
      results: candidates.sorted().map(item => ({
        ...item.node, similarity: item.score, retrievalMode: 'keyword',
      })),
      searched, filtered, retainedBytes,
    };
    if (Buffer.byteLength(JSON.stringify(response)) > 8 * 1024 * 1024) {
      throw Object.assign(new Error('keyword result exceeds byte limit'), {
        code: 'result_too_large', status: 413, retryable: false,
      });
    }
    return response;
  }

  function getEvidence(extra = {}) {
    const completeCoverage = extra.completeCoverage === true && diagnostics.length === 0;
    const authoritativeTotals = extra.authoritativeTotals || {
      nodes: manifest?.summary?.nodeCount ?? null,
      edges: manifest?.summary?.edgeCount ?? null,
    };
    const returnedTotals = extra.returnedTotals || { nodes: 0, edges: 0 };
    const effectiveHealth = extra.sourceHealth || (diagnostics.sawDegradation
      ? SOURCE_HEALTH.DEGRADED
      : health);
    const matchOutcome = extra.matchOutcome || classifyMatchOutcome({
      sourceHealth: effectiveHealth,
      authoritativeTotal: authoritativeTotals.nodes,
      returnedTotal: returnedTotals.nodes,
      filteredTotal: extra.filteredTotal || 0,
      completeCoverage,
    });
    return createEvidence({
      ...extra,
      identity: extra.identity || options.identity || null,
      sourceHealth: effectiveHealth,
      matchOutcome: manifest?.sourceMode === 'legacy_projection' && matchOutcome === MATCH_OUTCOME.CORPUS_EMPTY
        ? MATCH_OUTCOME.UNKNOWN : matchOutcome,
      baseRevision: manifest?.baseRevision,
      baseFile: manifest?.activeBase?.nodes?.file,
      deltaRevision: manifest?.currentRevision,
      deltaEpoch: manifest?.activeDeltaEpoch,
      deltaApplied: extra.deltaApplied ?? appliedRecords,
      annBuiltFromRevision: manifest?.ann?.builtFromRevision,
      annFresh: manifest?.ann?.builtFromRevision === manifest?.currentRevision,
      authoritativeTotals,
      returnedTotals,
      mutationBoundaries,
      freshness: manifest?.sourceMode === 'legacy_projection'
        ? 'unknown' : 'known',
      diagnostics: diagnostics.snapshot(),
      diagnosticsDropped: diagnostics.dropped,
    });
  }

  const descriptor = manifest ? {
    version: 1,
    canonicalRoot,
    generation: manifest.generation,
    sourceMode: manifest.sourceMode || 'memory_manifest',
    baseRevision: manifest.baseRevision,
    cutoffRevision: manifest.currentRevision,
    activeBase: manifest.activeBase,
    activeDelta: {
      epoch: manifest.activeDelta.epoch,
      file: manifest.activeDelta.file,
      fromRevision: manifest.activeDelta.fromRevision,
      committedBytes: manifest.activeDelta.committedBytes,
      toRevision: manifest.activeDelta.toRevision,
      count: manifest.activeDelta.count,
    },
    summary: {
      nodeCount: manifest.summary.nodeCount,
      edgeCount: manifest.summary.edgeCount,
      clusterCount: manifest.summary.clusterCount,
    },
  } : null;

  async function isCurrent() {
    if (!manifest) return false;
    if (manifest.sourceMode === 'legacy_projection') {
      return verifyLegacySourceFingerprint(canonicalRoot, legacyFingerprint);
    }
    const current = await readManifest(canonicalRoot).catch(() => null);
    return current?.generation === manifest.generation &&
      current?.currentRevision === manifest.currentRevision;
  }

  let released = false;
  async function release() {
    if (released) return;
    released = true;
    if (openedOverlay) await openedOverlay.close();
    if (pinFile) {
      await fsp.rm(pinFile, { force: true });
      await fsp.rmdir(path.dirname(pinFile)).catch(error => {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
      });
    }
  }

  async function compareAndSwap(commit) {
    if (!manifest || manifest.formatVersion !== 1 || manifest.sourceMode === 'legacy_projection') {
      return { committed: false, reason: 'source_changed' };
    }
    const { compareAndSwapSourceRevision } = require('./writer.cjs');
    return compareAndSwapSourceRevision(canonicalRoot, {
      expectedGeneration: manifest.generation,
      expectedRevision: manifest.currentRevision,
      lockRoot: options.lockRoot,
      commit,
    });
  }

  return {
    brainDir,
    manifest,
    revision: manifest?.currentRevision ?? null,
    descriptor,
    evidence: getEvidence(),
    mutationBoundaries,
    getMutationBoundaries: () => [...mutationBoundaries],
    files: manifest ? activeFiles(manifest) : [],
    physicalFiles: manifest ? activeFiles(manifest).map(file => path.join(sourceRoot, file)) : [],
    isCurrent,
    compareAndSwap,
    iterateNodes,
    iterateEdges,
    summarize,
    summarizeBreakdowns,
    searchKeyword,
    getEvidence,
    release,
    close: release,
  };
}

async function openPinnedSource(descriptor, expectations = {}) {
  throwIfAborted(expectations.signal);
  if (!expectations.scratchQuota
      || await expectations.scratchQuota.assertOperationRoot(expectations.operationRoot) !== true) {
    throw Object.assign(new Error('operation scratch quota required'), {
      code: 'source_operation_required', retryable: false,
    });
  }
  await expectations.scratchQuota.reconcile();
  const canonicalRoot = await fsp.realpath(expectations.expectedCanonicalRoot);
  const digest = sourceDescriptorDigest(descriptor);
  if (descriptor?.version !== 1 || canonicalRoot !== descriptor?.canonicalRoot ||
      !Number.isSafeInteger(descriptor?.cutoffRevision) ||
      descriptor.cutoffRevision !== expectations.expectedRevision ||
      !Number.isSafeInteger(descriptor?.summary?.nodeCount) || descriptor.summary.nodeCount < 0 ||
      !Number.isSafeInteger(descriptor?.summary?.edgeCount) || descriptor.summary.edgeCount < 0 ||
      !Number.isSafeInteger(descriptor?.summary?.clusterCount) || descriptor.summary.clusterCount < 0 ||
      digest !== expectations.expectedDigest) {
    throw Object.assign(new Error('Pinned source descriptor mismatch'), { code: 'source_changed' });
  }
  for (const file of [
    descriptor.activeBase?.nodes?.file,
    descriptor.activeBase?.edges?.file,
    descriptor.activeDelta?.file,
  ]) {
    if (!file || path.isAbsolute(file) || path.basename(file) !== file) {
      throw Object.assign(new Error('Pinned source file is invalid'), { code: 'invalid_request' });
    }
  }
  const pinnedManifest = {
    formatVersion: 1,
    generation: descriptor.generation,
    sourceMode: descriptor.sourceMode || 'memory_manifest',
    baseRevision: descriptor.baseRevision,
    currentRevision: descriptor.cutoffRevision,
    activeDeltaEpoch: descriptor.activeDelta.epoch,
    activeBase: descriptor.activeBase,
    activeDelta: descriptor.activeDelta,
    ann: { indexFile: null, metaFile: null, builtFromRevision: null },
    summary: descriptor.summary,
  };
  const pinnedLocation = await resolvePinnedPhysicalRoot({
    descriptor,
    canonicalRoot,
    operationRoot: expectations.operationRoot,
    operationId: expectations.operationId,
    requesterAgent: expectations.requesterAgent,
    expectedDigest: digest,
  });
  return openMemorySource(canonicalRoot, {
    pinnedManifest,
    physicalProjectionRoot: pinnedLocation.physicalRoot,
    legacySourceFingerprint: pinnedLocation.sourceFingerprint || null,
    operationId: expectations.operationId,
    requesterAgent: expectations.requesterAgent,
    operationRoot: expectations.operationRoot,
    lockRoot: expectations.lockRoot,
    scratchQuota: expectations.scratchQuota,
    expectedDigest: digest,
    identity: expectations.identity,
    signal: expectations.signal,
  });
}

function createMemorySourcePinProvider({ home23Root, requesterAgent }) {
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  const operationRootFor = operationId => path.join(
    home23Root, 'instances', requesterAgent, 'runtime',
    'brain-operations', 'operations', validateOperationId(operationId),
  );
  return {
    pin: async (canonicalRoot, operationId) => {
      const operationRoot = operationRootFor(operationId);
      const scratchQuota = await createOperationScratchQuota({ operationRoot });
      try {
        return await pinOperationSource({
          canonicalRoot, operationId, requesterAgent, operationRoot, lockRoot,
          scratchQuota,
        });
      } finally {
        await scratchQuota.close(); // closes this handle; ledger/files remain
      }
    },
    openPinnedSource: (descriptor, expectations) => openPinnedSource(descriptor, {
      ...expectations,
      operationRoot: operationRootFor(expectations.operationId),
      lockRoot,
    }),
    recoverPins: dependencies => pruneStalePins(home23Root, dependencies),
    releaseOperationPins: operationId => releaseOperationSource({
      operationId,
      requesterAgent,
      operationRoot: operationRootFor(operationId),
      lockRoot,
    }),
  };
}

module.exports = {
  enumerateMemoryMutationBoundaries,
  openMemorySource,
  resolveMemorySourceSelection,
  pinOperationSource,
  openPinnedSource,
  createMemorySourcePinProvider,
};
~~~

Implement every referenced bounded helper in `reader.cjs` and unit-test it
directly through the public reader. `validateBreakdownLimits()` accepts only
positive safe integers up to 10,000 keys and 1 MiB. A breakdown key is a scalar
string of at most 4 KiB. `createBoundedBreakdownState()` maintains exact
incremental serialized-byte accounting; crossing either shared cap immediately
sets `omitted:true` and releases both maps. `matchKeywordFields()` accepts only
`concept`, scalar `tag`, and scalar members of `tags`, scans each string in
64-KiB lowercase windows with overlap of `longestWord.length - 1`, and rejects
a source field over the JSONL record cap rather than joining/copying it.
`projectBoundedSearchNode()` emits a fixed scalar result schema, truncates only
display text on a UTF-8 boundary with explicit `textTruncated:true`, preserves
and validates the complete ID, and omits embeddings/vectors/metadata/unknown
keys. `createFixedTopK()` owns both count and retained-byte limits, stores the
projection rather than the original record, and evicts the deterministic worst
candidate until both limits hold. No helper may call `loadAll()`, spread a raw
source record, or represent omitted data as an exact empty map.
`projectBoundedStatisticNode()` emits only `{concept,conceptTruncated,
accessCount,activation,weight}` with a 400-byte UTF-8 concept preview; both
five-item statistics heaps share the same deterministic tie-breaking and never
retain the source record. Numeric sums accept finite values only and tests cover
NaN/Infinity without allowing them into JSON.

- [ ] **Step 5: Export the reader and run the contract tests**

Append these exports to `shared/memory-source/index.cjs`:

~~~js
Object.assign(module.exports,
  require('./manifest.cjs'),
  require('./legacy-projection.cjs'),
  require('./overlay-store.cjs'),
  require('./scratch-quota.cjs'),
  require('./operation-context.cjs'),
  require('./pins.cjs'),
  require('./reader.cjs')
);
~~~

Run:

~~~bash
node --test --test-concurrency=1 tests/shared/memory-source-contracts.test.js tests/shared/memory-source-reader.test.js tests/shared/memory-source-adapters.test.js tests/shared/memory-source-pin.test.js
~~~

Expected: all contract, projection, legacy, unavailable, pin, and adapter parity tests pass.

- [ ] **Step 6: Commit the reader**

~~~bash
git diff --cached --quiet
git add -- shared/memory-source/manifest.cjs shared/memory-source/legacy-projection.cjs shared/memory-source/overlay-store.cjs shared/memory-source/scratch-quota.cjs shared/memory-source/operation-context.cjs shared/memory-source/pins.cjs shared/memory-source/reader.cjs shared/memory-source/index.cjs tests/shared/memory-source-reader.test.js tests/shared/memory-source-adapters.test.js tests/shared/memory-source-pin.test.js
git diff --cached --check
git diff --cached
git commit -m "feat(memory): read pinned logical revisions"
git status --short
~~~

### Task 3: Crash-Safe Manifest Writer and ANN Watermark CAS

**Files:**
- Create: `shared/memory-source/writer.cjs`
- Modify: `shared/memory-source/manifest.cjs`
- Modify: `shared/memory-source/index.cjs`
- Test: `tests/shared/memory-source-writer.test.js`

**Interfaces:**
- Consumes: Task 2 manifest schema, active reader pin files, and atomic gzip writer.
- Produces: `appendMemoryRevision(brainDir, immutableChanges, {lockRoot,summary,...})`, `rewriteMemoryBase(brainDir, capturedView, {lockRoot,...})`, `advanceAnnBuiltFromRevision(brainDir, {lockRoot,...})`, `compareAndSwapSourceRevision(brainDir, {lockRoot,...})`, and `retireUnpinnedSources(brainDir, {home23Root,lockRoot,pinFiles?})`. `capturedView` is an immutable `{nodes,edges,summary}` snapshot, never a live `NetworkMemory`. Production always derives `lockRoot` and pin discovery from trusted `home23Root`; injected pin files are test-only.

- [ ] **Step 1: Write failing transaction and crash-window tests**

Create `tests/shared/memory-source-writer.test.js` with injected fault hooks named `afterBaseFiles`, `afterDeltaFsync`, and `beforeManifestRename`. Its fixture binds every writer call to a temporary ignored-global `lockRoot` outside the target; the abbreviated calls below use that bound fixture wrapper and never rely on a target-local or implicit lock. Cover:

~~~js
test('a failed full rewrite leaves the old manifest and delta authoritative', async () => {
  const dir = await createCommittedFixture();
  await assert.rejects(rewriteMemoryBase(dir, replacementCapturedView(), {
    faultAt: 'beforeManifestRename',
  }), /injected:beforeManifestRename/);
  const source = await openMemorySource(dir);
  assert.deepEqual(await concepts(source), ['old committed canary']);
  await source.close();
});

test('uncommitted appended bytes are ignored and truncated by the next append', async () => {
  const dir = await createCommittedFixture();
  await assert.rejects(appendMemoryRevision(dir, {
    nodes: [{ id: 'orphan', concept: 'must not cross' }],
  }, { faultAt: 'afterDeltaFsync' }), /injected:afterDeltaFsync/);
  await appendMemoryRevision(dir, {
    nodes: [{ id: 'committed', concept: 'new committed canary' }],
  });
  const source = await openMemorySource(dir);
  assert.deepEqual(await concepts(source), ['old committed canary', 'new committed canary']);
  await source.close();
});

test('delta records carry one epoch and strictly increasing sequence and revision', async () => {
  const dir = await createCommittedFixture();
  const result = await appendMemoryRevision(dir, {
    nodes: [{ id: 'n2' }, { id: 'n3' }],
    removedNodeIds: ['n1'],
  });
  assert.equal(result.fromRevision + 2, result.toRevision);
  assert.deepEqual((await readCommittedDelta(dir)).map(row => row.sequence), [1, 2, 3]);
});

test('ANN completion advances only its built-from watermark', async () => {
  const dir = await createCommittedFixture();
  const before = await readManifest(dir);
  const result = await advanceAnnBuiltFromRevision(dir, {
    expectedGeneration: before.generation,
    builtFromRevision: before.currentRevision,
    indexFile: 'memory-ann.' + before.currentRevision + '.index',
    metaFile: 'memory-ann.' + before.currentRevision + '.meta.json',
  });
  assert.equal(result.manifest.currentRevision, before.currentRevision);
  assert.equal(result.manifest.ann.builtFromRevision, before.currentRevision);
});

test('derived-state compare-and-swap rejects a newer source revision', async () => {
  const dir = await createCommittedFixture();
  const pinned = await openMemorySource(dir);
  await appendMemoryRevision(dir, { nodes: [{ id: 'newer', concept: 'newer source' }] });
  let writes = 0;
  const result = await compareAndSwapSourceRevision(dir, {
    expectedGeneration: pinned.manifest.generation,
    expectedRevision: pinned.revision,
    commit: async () => { writes += 1; },
  });
  assert.equal(result.committed, false);
  assert.equal(result.reason, 'source_changed');
  assert.equal(writes, 0);
  await pinned.close();
});

test('retirement preserves files named by an active reader pin', async () => {
  const dir = await createCommittedFixture();
  const runtime = await createRequesterRuntimeFixture();
  const pinned = await openMemorySource(dir, {
    operationRoot: runtime.operationRoot, lockRoot: runtime.lockRoot,
    operationId: 'op-pin-retain', requesterAgent: 'ada',
  });
  await rewriteMemoryBase(dir, replacementCapturedView(), { lockRoot: runtime.lockRoot });
  const protectedResult = await retireUnpinnedSources(dir, {
    home23Root: runtime.home23Root, lockRoot: runtime.lockRoot,
  });
  assert.equal(protectedResult.retired.includes(pinned.manifest.activeBase.nodes.file), false);
  await pinned.close();
  const releasedResult = await retireUnpinnedSources(dir, {
    home23Root: runtime.home23Root, lockRoot: runtime.lockRoot,
  });
  assert.equal(releasedResult.retired.includes(pinned.manifest.activeBase.nodes.file), true);
});

test('pin creation and retirement serialize on one lock and recheck source truth', async () => {
  const fixture = await createRetirementRaceFixture();
  await fixture.holdRetirementAfterLock();
  const opening = fixture.openRequesterPin();
  await fixture.switchManifestAndFinishRetirement();
  const pinned = await opening;
  assert.equal(pinned.descriptor.generation, fixture.newGeneration);
  assert.equal(await fixture.allDescriptorFilesExist(pinned.descriptor), true);
  assert.equal(fixture.halfWrittenPins, 0);
});

test('global retirement honors pins owned by every requester agent', async () => {
  const fixture = await createMultiRequesterPinFixture(['ada', 'bob']);
  const result = await retireUnpinnedSources(fixture.brainDir, {
    home23Root: fixture.home23Root, lockRoot: fixture.lockRoot,
  });
  assert.deepEqual(result.retired, fixture.onlyUnpinnedFiles);
  assert.equal(fixture.targetBrainContainsPins, false);
});

test('global lock never mutates or disappears from the target-tree inventory', async () => {
  const fixture = await createCommittedFixtureWithGlobalRuntime();
  const before = await hashCompleteTargetTree(fixture.brainDir);
  await withMemorySourceLock(fixture.brainDir, { lockRoot: fixture.lockRoot }, async () => {
    assert.equal(await pathExists(path.join(fixture.lockRoot, fixture.rootHash)), true);
  });
  assert.equal(await pathExists(path.join(fixture.lockRoot, fixture.rootHash)), false);
  assert.deepEqual(await hashCompleteTargetTree(fixture.brainDir), before);
  assert.equal(before.some(row => row.excludedForLock), false);
});

test('stale pin pruning waits for both dead process identity and terminal operation', async () => {
  const fixture = await createStalePinFixture({ processAlive: false, operationState: 'running' });
  assert.equal((await fixture.prune()).removed.length, 0);
  fixture.operationState = 'interrupted';
  assert.deepEqual((await fixture.prune()).removed, [fixture.pinFile]);
});

test('full rewrite consumes one immutable captured view after lock waits', async () => {
  const fixture = await createWriterBarrierFixture();
  const capturedView = fixture.captureView();
  const writing = rewriteMemoryBase(fixture.brainDir, capturedView, {
    lockRoot: fixture.lockRoot,
    beforeLock: fixture.waitBeforeLock,
  });
  fixture.mutateLiveMemoryAndOriginalRecords();
  fixture.releaseLock();
  const result = await writing;
  assert.deepEqual(await fixture.readGenerationNodes(result.manifest), capturedView.nodes);
  assert.deepEqual(result.manifest.summary, capturedView.summary);
  assert.equal(await fixture.generationContainsPostCaptureMutation(result.manifest), false);
});
~~~

- [ ] **Step 2: Run the writer suite and verify the red state**

Run:

~~~bash
node --test --test-concurrency=1 tests/shared/memory-source-writer.test.js
~~~

Expected: FAIL because writer functions are not exported.

- [ ] **Step 3: Add atomic manifest writing**

Add to `shared/memory-source/manifest.cjs`:

~~~js
async function fsyncDirectory(dir) {
  const handle = await fsp.open(dir, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeManifestAtomic(brainDir, manifest) {
  validateManifest(manifest);
  const encoded = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  if (encoded.length > MAX_MANIFEST_BYTES) {
    throw Object.assign(new Error('memory manifest limit exceeded'), {
      code: 'result_too_large', status: 413, retryable: false,
    });
  }
  await assertConfinedDirectory(brainDir, brainDir);
  const destination = manifestPath(brainDir);
  await rejectExistingSymlink(destination);
  const tmp = destination + '.' + process.pid + '.' + Date.now() + '.tmp';
  const opened = await createConfinedExclusiveFile(brainDir, tmp);
  const handle = opened.handle;
  try {
    await handle.writeFile(encoded);
    await handle.sync();
    await assertStableOpenedFile(opened);
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, destination);
  await fsyncDirectory(brainDir);
  return manifest;
}
~~~

Export `writeManifestAtomic` and `fsyncDirectory`.

- [ ] **Step 4: Implement the writer transaction**

Create `shared/memory-source/writer.cjs` with:

~~~js
'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { limitError, writeJsonlGzAtomic } = require('./jsonl.cjs');
const { readManifest, writeManifestAtomic, fsyncDirectory } = require('./manifest.cjs');
const { openConfinedRegularFile, assertStableOpenedFile } = require('./confined-file.cjs');
const { withMemorySourceLock, discoverOperationPinFiles } = require('./pins.cjs');

function inject(options, point) {
  if (options.faultAt === point) throw new Error('injected:' + point);
}

function* changeRecords(changes) {
  for (const record of changes.nodes || []) yield { op: 'upsert_node', record };
  for (const record of changes.edges || []) yield { op: 'upsert_edge', record };
  for (const id of changes.removedNodeIds || []) yield { op: 'remove_node', id };
  for (const key of changes.removedEdgeKeys || []) yield { op: 'remove_edge', key };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateScalarSummaryOnly(summary) {
  if (!summary || Object.keys(summary).sort().join(',') !==
      'clusterCount,edgeCount,nodeCount') throw new Error('captured_summary_required');
  const copy = {};
  for (const field of ['nodeCount', 'edgeCount', 'clusterCount']) {
    if (!Number.isSafeInteger(summary[field]) || summary[field] < 0) {
      throw new Error('captured_summary_invalid');
    }
    copy[field] = summary[field];
  }
  return Object.freeze(copy);
}

function normalizeCapturedChanges(changes) {
  const source = changes || {};
  const copy = {};
  let count = 0; let bytes = 0;
  for (const key of ['nodes', 'edges', 'removedNodeIds', 'removedEdgeKeys']) {
    const rows = Array.isArray(source[key]) ? source[key] : [];
    copy[key] = rows.map(row => {
      const cloned = cloneJson(row);
      const encodedBytes = Buffer.byteLength(JSON.stringify(cloned), 'utf8');
      if (encodedBytes > 16 * 1024 * 1024) throw limitError('delta_record', 16 * 1024 * 1024);
      count += 1; bytes += encodedBytes;
      if (count > 100_000 || bytes > 512 * 1024 * 1024) {
        throw limitError('delta_commit', 512 * 1024 * 1024);
      }
      return cloned;
    });
  }
  return Object.freeze(copy);
}

async function appendMemoryRevision(brainDir, changes, options = {}) {
  // Copy before the first await. Lock contention cannot expose later live-memory
  // mutation through a caller-owned changes/summary object.
  const capturedChanges = normalizeCapturedChanges(changes);
  const capturedSummary = options.summary
    ? validateScalarSummaryOnly(options.summary) : null;
  await options.beforeLock?.();
  return withMemorySourceLock(brainDir, { lockRoot: options.lockRoot }, async () => {
    const manifest = await readManifest(brainDir);
    if (!manifest) throw new Error('memory_manifest_required');
    const deltaPath = path.join(brainDir, manifest.activeDelta.file);
    const committedBytes = Number(manifest.activeDelta.committedBytes || 0);
    const openedDelta = await openConfinedRegularFile(brainDir, deltaPath, {
      flags: fs.constants.O_RDWR,
    });
    const deltaHandle = openedDelta.handle;
    if (Number(openedDelta.stat.size) < committedBytes) {
      await deltaHandle.close();
      throw Object.assign(new Error('committed delta is truncated'), {
        code: 'source_unavailable', retryable: true,
      });
    }
    let revision = manifest.currentRevision;
    let sequence = Number(manifest.activeDelta.count || 0);
    let writeOffset = committedBytes;
    const recordCount = ['nodes','edges','removedNodeIds','removedEdgeKeys']
      .reduce((sum, key) => sum + capturedChanges[key].length, 0);
    try {
      await deltaHandle.truncate(committedBytes);
      for (const record of changeRecords(capturedChanges)) {
        revision += 1;
        sequence += 1;
        const encoded = Buffer.from(JSON.stringify({
          epoch: manifest.activeDeltaEpoch,
          sequence,
          revision,
          ...record,
        }) + '\n');
        await deltaHandle.write(encoded, 0, encoded.length, writeOffset);
        writeOffset += encoded.length;
      }
      await deltaHandle.sync();
      await assertStableOpenedFile(openedDelta, { allowSizeChange: true });
    } finally {
      await deltaHandle.close();
    }
    inject(options, 'afterDeltaFsync');
    const bytes = (await fsp.stat(deltaPath)).size;
    const next = {
      ...manifest,
      currentRevision: revision,
      activeDelta: {
        ...manifest.activeDelta,
        toRevision: revision,
        count: sequence,
        committedBytes: bytes,
      },
      summary: capturedSummary || manifest.summary,
      updatedAt: new Date().toISOString(),
    };
    inject(options, 'beforeManifestRename');
    await writeManifestAtomic(brainDir, next);
    return {
      epoch: next.activeDeltaEpoch,
      fromRevision: manifest.currentRevision + (recordCount ? 1 : 0),
      toRevision: revision,
      count: recordCount,
      bytes,
      manifest: next,
    };
  });
}

function validateCapturedScalarSummary(summary, nodes, edges) {
  if (!summary || Object.keys(summary).sort().join(',') !==
      'clusterCount,edgeCount,nodeCount') throw new Error('captured_summary_required');
  for (const field of ['nodeCount', 'edgeCount', 'clusterCount']) {
    if (!Number.isSafeInteger(summary[field]) || summary[field] < 0) {
      throw new Error('captured_summary_invalid');
    }
  }
  if (summary.nodeCount !== nodes.length || summary.edgeCount !== edges.length
      || summary.clusterCount > summary.nodeCount) {
    throw new Error('captured_summary_mismatch');
  }
  return Object.freeze({ ...summary });
}

// The engine adapter captures this three-scalar summary in the same synchronous
// memory snapshot as nodes/edges. It obtains clusterCount from NetworkMemory's
// existing scalar cluster index; this writer never reconstructs an unbounded
// tag/cluster map and never publishes either map in the manifest.

function cloneJsonRecord(record) {
  return JSON.parse(JSON.stringify(record));
}

function normalizeCapturedView(input) {
  if (!input || !Array.isArray(input.nodes) || !Array.isArray(input.edges)) {
    throw new Error('immutable_captured_view_required');
  }
  // This synchronous copy happens before the first await/lock acquisition. The
  // transaction below never observes the caller's live memory or record objects.
  const nodes = input.nodes.map(cloneJsonRecord);
  const edges = input.edges.map(cloneJsonRecord);
  const derivedSummary = validateCapturedScalarSummary(input.summary, nodes, edges);
  return Object.freeze({
    nodes: Object.freeze(nodes.map(Object.freeze)),
    edges: Object.freeze(edges.map(Object.freeze)),
    summary: Object.freeze(derivedSummary),
  });
}

async function rewriteMemoryBase(brainDir, capturedView, options = {}) {
  const view = normalizeCapturedView(capturedView);
  await options.beforeLock?.();
  return withMemorySourceLock(brainDir, { lockRoot: options.lockRoot }, async () => {
    const previous = await readManifest(brainDir);
    const baseRevision = (previous?.currentRevision || 0) + 1;
    const generation = 'g-' + baseRevision + '-' + randomUUID();
    const epoch = 'e-' + (baseRevision + 1) + '-' + randomUUID();
    const nodeFile = 'memory-nodes.base-' + baseRevision + '.jsonl.gz';
    const edgeFile = 'memory-edges.base-' + baseRevision + '.jsonl.gz';
    const deltaFile = 'memory-delta.' + epoch + '.jsonl';
    const nodes = await writeJsonlGzAtomic(path.join(brainDir, nodeFile), view.nodes, options);
    const edges = await writeJsonlGzAtomic(path.join(brainDir, edgeFile), view.edges, options);
    const deltaHandle = await fsp.open(path.join(brainDir, deltaFile), 'wx');
    await deltaHandle.sync();
    await deltaHandle.close();
    await fsyncDirectory(brainDir);
    inject(options, 'afterBaseFiles');
    const manifest = {
      formatVersion: 1,
      generation,
      baseRevision,
      currentRevision: baseRevision,
      activeDeltaEpoch: epoch,
      activeBase: {
        nodes: { file: nodeFile, count: nodes.count, bytes: nodes.bytes },
        edges: { file: edgeFile, count: edges.count, bytes: edges.bytes },
      },
      activeDelta: {
        epoch,
        file: deltaFile,
        fromRevision: baseRevision + 1,
        toRevision: baseRevision,
        count: 0,
        committedBytes: 0,
      },
      ann: previous?.ann || { indexFile: null, metaFile: null, builtFromRevision: null },
      summary: view.summary,
      baseWrittenAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    inject(options, 'beforeManifestRename');
    await writeManifestAtomic(brainDir, manifest);
    return { baseRevision, deltaEpoch: epoch, nodes, edges, manifest };
  });
}

async function advanceAnnBuiltFromRevision(brainDir, update) {
  return withMemorySourceLock(brainDir, { lockRoot: update.lockRoot }, async () => {
    const manifest = await readManifest(brainDir);
    if (!manifest || manifest.generation !== update.expectedGeneration) {
      return { advanced: false, reason: 'source_changed', manifest };
    }
    if (!Number.isSafeInteger(update.builtFromRevision) || update.builtFromRevision > manifest.currentRevision) {
      throw new Error('invalid_ann_built_from_revision');
    }
    const next = {
      ...manifest,
      ann: {
        indexFile: update.indexFile,
        metaFile: update.metaFile,
        builtFromRevision: update.builtFromRevision,
      },
      updatedAt: new Date().toISOString(),
    };
    await writeManifestAtomic(brainDir, next);
    return { advanced: true, manifest: next };
  });
}

async function compareAndSwapSourceRevision(brainDir, update) {
  return withMemorySourceLock(brainDir, { lockRoot: update.lockRoot }, async () => {
    const manifest = await readManifest(brainDir);
    if (!manifest ||
        manifest.generation !== update.expectedGeneration ||
        manifest.currentRevision !== update.expectedRevision) {
      return { committed: false, reason: 'source_changed', manifest };
    }
    const value = await update.commit(manifest);
    return { committed: true, manifest, value };
  });
}

async function retireUnpinnedSources(brainDir, options = {}) {
  return withMemorySourceLock(brainDir, { lockRoot: options.lockRoot }, async () => {
    // The manifest and every global pin are read only after acquiring the same
    // lock used by pinCurrentManifest()/pinManifestDescriptor().
    const current = await readManifest(brainDir);
    if (!current) return { retired: [], retained: [], reason: 'manifest_missing' };
    const canonicalRoot = await fsp.realpath(brainDir);
    const pinFiles = options.pinFiles || await discoverOperationPinFiles(options.home23Root);
    const protectedFiles = new Set([
      current.activeBase.nodes.file,
      current.activeBase.edges.file,
      current.activeDelta.file,
      current.ann?.indexFile,
      current.ann?.metaFile,
      'memory-manifest.json',
    ].filter(Boolean));
    for (const pinFile of pinFiles) {
      try {
        const pin = JSON.parse(await fsp.readFile(pinFile, 'utf8'));
        if (pin.canonicalRoot !== canonicalRoot) continue;
        for (const file of pin.files || []) protectedFiles.add(file);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    const beforeDelete = await readManifest(brainDir);
    if (!beforeDelete || beforeDelete.generation !== current.generation ||
        beforeDelete.currentRevision !== current.currentRevision) {
      return { retired: [], retained: [], reason: 'source_changed', retryable: true };
    }
    const retired = [];
    const retained = [];
    for (const name of await fsp.readdir(brainDir)) {
      if (!/^memory-(nodes|edges)\.base-|^memory-delta\.e-|^memory-ann\.\d+\./.test(name)) continue;
      if (protectedFiles.has(name)) {
        retained.push(name);
      } else {
        // name came from readdir and must remain a basename; never accept a
        // caller-supplied retirement path.
        await fsp.rm(path.join(canonicalRoot, name), { force: true });
        retired.push(name);
      }
    }
    return { retired, retained };
  });
}

module.exports = {
  appendMemoryRevision,
  rewriteMemoryBase,
  advanceAnnBuiltFromRevision,
  compareAndSwapSourceRevision,
  retireUnpinnedSources,
  normalizeCapturedView,
  summarizeCapturedRecords,
};
~~~

- [ ] **Step 5: Export, run writer plus reader tests, and commit**

Add `require('./writer.cjs')` to `shared/memory-source/index.cjs`, then run:

~~~bash
node --test --test-concurrency=1 tests/shared/memory-source-contracts.test.js tests/shared/memory-source-reader.test.js tests/shared/memory-source-writer.test.js
git diff --check -- shared/memory-source tests/shared
~~~

Expected: all tests pass; each injected fault preserves one complete authoritative generation.

Commit:

~~~bash
git diff --cached --quiet
git add -- shared/memory-source/writer.cjs shared/memory-source/manifest.cjs shared/memory-source/index.cjs tests/shared/memory-source-writer.test.js
git diff --cached --check
git diff --cached
git commit -m "feat(memory): commit revisioned source manifests"
git status --short
~~~

### Task 4: Engine Persistence, Load, Guard, Snapshot, and Backup Integration

**Files:**
- Create: `engine/src/core/memory-persistence.js`
- Modify: `engine/src/memory/network-memory.js:40-55`
- Modify: `engine/src/memory/network-memory.js:540-639`
- Modify: `engine/src/core/memory-sidecar.js`
- Modify: `engine/src/core/orchestrator.js:7141-7353`
- Modify: `engine/src/core/orchestrator.js:7533-7589`
- Modify: `engine/src/core/brain-persistence-guard.js`
- Modify: `engine/src/core/brain-snapshot.js`
- Modify: `engine/src/core/brain-backups.js`
- Test: `tests/engine/core/memory-persistence.test.js`
- Test: `tests/engine/memory/network-memory-persistence-generation.test.js`
- Test: `tests/engine/core/memory-sidecar.test.cjs`
- Test: `tests/engine/core/brain-persistence-guard.test.js`
- Test: `tests/engine/core/brain-backups.test.cjs`

**Interfaces:**
- Consumes: Task 3 reader/writer transactions.
- Produces: `persistMemoryRevision(input)`, `loadMemoryRevision(brainDir)`, `capturePersistenceSnapshot()`, `markPersistenceCleanIfGeneration(expectedGeneration)`, and compatibility sidecar functions. Every accepted mutation and snapshot capture crosses the same synchronous, no-yield persistence barrier. A capture returns one deeply immutable `{generation,changes,fullView,summary}`; a save clears dirty sets only after a durable commit **and** a generation CAS proves no later mutation was accepted. Neither full rewrite nor delta-summary construction may inspect live memory after capture.

- [ ] **Step 1: Write failing engine adapter tests**

Create `tests/engine/core/memory-persistence.test.js` with:

~~~js
test('writer failure preserves dirty persistence changes', async () => {
  const memory = createTrackedMemory([{ id: 'n1', concept: 'canary' }]);
  await assert.rejects(persistMemoryRevision({
    brainDir: '/unused',
    memory,
    writer: {
      readManifest: async () => ({ currentRevision: 1 }),
      appendMemoryRevision: async () => { throw new Error('disk full'); },
      rewriteMemoryBase: async () => { throw new Error('not expected'); },
    },
  }), /disk full/);
  assert.equal(memory.hasPersistenceChanges(), true);
});

test('successful delta commit clears dirty persistence changes after generation CAS', async () => {
  const events = [];
  const memory = createTrackedMemory([{ id: 'n1', concept: 'canary' }], events);
  const result = await persistMemoryRevision({
    brainDir: '/unused',
    memory,
    writer: {
      readManifest: async () => ({ currentRevision: 1, updatedAt: new Date().toISOString() }),
      appendMemoryRevision: async () => {
        events.push('committed');
        return { manifest: { currentRevision: 2 }, count: 1 };
      },
      rewriteMemoryBase: async () => { throw new Error('not expected'); },
    },
  });
  assert.equal(result.manifest.currentRevision, 2);
  assert.deepEqual(events, ['captured:1', 'committed', 'clean-if:1']);
});

test('a mutation accepted behind the persistence barrier cannot be marked clean', async () => {
  const barrier = createBarrier();
  const memory = createTrackedMemory([{ id: 'n1', concept: 'first' }]);
  const saving = persistMemoryRevision({
    brainDir: '/unused', memory,
    writer: writerThatWaitsAfterSnapshot(barrier),
  });
  await barrier.snapshotCaptured;
  memory.upsertNode({ id: 'n2', concept: 'accepted while commit was pending' });
  barrier.releaseCommit();
  const first = await saving;
  assert.equal(first.cleaned, false);
  assert.equal(memory.hasPersistenceChanges(), true);
  const second = await persistMemoryRevision({
    brainDir: '/unused', memory, writer: collectingWriter(),
  });
  assert.deepEqual(second.persistedChanges.nodes.map(node => node.id).sort(), ['n1', 'n2']);
  assert.equal(second.cleaned, true);
});

test('full rewrite persists one immutable generation while live memory advances', async () => {
  const barrier = createBarrier();
  const memory = createTrackedMemory([{ id: 'n1', concept: 'captured' }]);
  const writer = fullRewriteWriterThatExposesView(barrier);
  const saving = persistMemoryRevision({
    brainDir: '/unused', memory, forceFull: true, writer,
  });
  const captured = await barrier.rewriteReceived;
  assert.equal(Object.isFrozen(captured.nodes), true);
  assert.equal(Object.isFrozen(captured.nodes[0]), true);
  memory.upsertNode({ id: 'n2', concept: 'post-capture' });
  barrier.releaseCommit();
  const result = await saving;
  assert.deepEqual(captured.nodes.map(node => node.id), ['n1']);
  assert.deepEqual(result.manifest.summary, {
    nodeCount: 1, edgeCount: 0, clusterCount: 0,
  });
  assert.equal(result.cleaned, false);
  assert.equal(memory.hasPersistenceChanges(), true);
});

test('delta manifest summary comes from the captured generation, not live memory', async () => {
  const barrier = createBarrier();
  const memory = createTrackedMemory([{ id: 'n1', concept: 'captured' }]);
  const saving = persistMemoryRevision({
    brainDir: '/unused', memory,
    writer: appendWriterThatExposesSummary(barrier),
  });
  const received = await barrier.appendReceived;
  memory.upsertNode({ id: 'n2', concept: 'post-capture' });
  barrier.releaseCommit();
  const result = await saving;
  assert.deepEqual(received.summary, {
    nodeCount: 1, edgeCount: 0, clusterCount: 0,
  });
  assert.deepEqual(result.manifest.summary, received.summary);
  assert.equal(result.cleaned, false);
});
~~~

Create `tests/engine/memory/network-memory-persistence-generation.test.js` and table-test node insert/update/delete, edge insert/delete, and explicit access mutation. Every accepted mutation must increase `persistenceGeneration`. `capturePersistenceSnapshot()` returns the exact current generation plus deeply cloned/frozen changes, full node/edge view, and a summary derived inside the same barrier. Mutate the original record objects and live maps immediately after capture and prove no captured record or summary changes. `markPersistenceCleanIfGeneration(oldGeneration)` returns `false` and leaves every dirty/tombstone set intact after any intervening mutation; the current generation returns `true` and clears them. The same-id-twice case is required because set cardinality does not reveal a second accepted mutation. Add a barrier-spy test proving every accepted mutator, capture, and clean-CAS enters the same no-yield barrier and no capture path invokes an async/user callback while it is held.

Continue `tests/engine/core/memory-persistence.test.js` with:

~~~js
test('engine load materializes the exact logical revision', async () => {
  const dir = await createBaseDeltaFixture();
  const loaded = await loadMemoryRevision(dir);
  assert.deepEqual(loaded.nodes.map(node => node.concept), ['updated', 'delta-only']);
  assert.equal(loaded.evidence.sourceHealth, 'healthy');
});

test('a successful full rewrite schedules production retirement with global pin discovery', async () => {
  const scheduled = [];
  const calls = [];
  await persistMemoryRevision({
    brainDir: '/brain', home23Root: '/home23', memory: createTrackedMemory([]),
    forceFull: true,
    schedule: task => scheduled.push(task),
    retireUnpinnedSources: async (brainDir, options) => calls.push([brainDir, options]),
    writer: successfulFullRewriteWriter(),
  });
  assert.equal(scheduled.length, 1);
  await scheduled[0]();
  assert.deepEqual(calls, [['/brain', {
    home23Root: '/home23', lockRoot: '/home23/runtime/brain-source-locks',
  }]]);
});
~~~

Extend existing guard and backup tests to assert the manifest summary wins over advisory `brain-snapshot.json`, and a backup contains `memory-manifest.json` plus every active file named by that pinned manifest.

- [ ] **Step 2: Run focused engine persistence tests and verify red**

Run:

~~~bash
node --test --test-concurrency=1 tests/engine/core/memory-persistence.test.js tests/engine/memory/network-memory-persistence-generation.test.js tests/engine/core/memory-sidecar.test.cjs tests/engine/core/brain-persistence-guard.test.js tests/engine/core/brain-backups.test.cjs
~~~

Expected: FAIL because `memory-persistence.js` does not exist and backups do not include manifest-named files.

- [ ] **Step 3: Add the dirty-generation CAS and implement the engine persistence adapter**

In `engine/src/memory/network-memory.js`, initialize `this.persistenceGeneration = 0` and one synchronous `withPersistenceBarrier(callback)` guard. Audit every accepted node/edge insert, update, delete, and explicit access mutation so the complete state mutation, dirty/tombstone update, and generation advance happen inside that same no-yield guard even when the same ID was already dirty. Do not advance it for rejected/no-op/read-only work. The guard must reject accidental re-entry and callbacks returning a promise; production records are plain JSON data, and no getter/plugin/user callback runs inside it. Add local deep JSON clone/freeze and `summarizePersistenceView(nodes,edges)` helpers and:

~~~js
capturePersistenceSnapshot() {
  return this.withPersistenceBarrier(() => {
    const fullView = {
      nodes: [...this.nodes.values()].map(deepCloneJsonRecord),
      edges: [...this.edges.values()].map(deepCloneJsonRecord),
    };
    const changes = deepCloneJsonRecord(this.getPersistenceChanges());
    const summary = summarizePersistenceView(fullView.nodes, fullView.edges);
    return deepFreezeJson({
      generation: this.persistenceGeneration,
      changes,
      fullView,
      summary,
    });
  });
}

markPersistenceCleanIfGeneration(expectedGeneration) {
  return this.withPersistenceBarrier(() => {
    if (!Number.isSafeInteger(expectedGeneration) ||
        this.persistenceGeneration !== expectedGeneration) return false;
    this.markPersistenceClean();
    return true;
  });
}
~~~

Keep `consumePersistenceChanges()` only as a deprecated compatibility wrapper; production persistence must never call it because clearing before durable commit violates the CAS contract. Snapshot capture is synchronous and performs no await, so an accepted mutation is wholly before or wholly after the captured generation. All later writer awaits consume only the frozen snapshot.

Create `engine/src/core/memory-persistence.js`:

~~~js
'use strict';

const path = require('node:path');
const fsp = require('node:fs').promises;
const { randomUUID } = require('node:crypto');
const {
  openMemorySource,
  resolveMemorySourceSelection,
  readManifest,
  appendMemoryRevision,
  rewriteMemoryBase,
  retireUnpinnedSources,
} = require('../../../shared/memory-source');

function scheduleSourceRetirement({
  brainDir, home23Root, lockRoot, retire = retireUnpinnedSources,
  schedule = queueMicrotask, logger = console,
}) {
  schedule(async () => {
    try {
      await retire(brainDir, { home23Root, lockRoot });
    } catch (error) {
      logger.warn?.('Memory source retirement deferred', { brainDir, error: error.message });
    }
  });
}

async function persistMemoryRevision({
  brainDir,
  memory,
  forceFull = false,
  fullRewriteIntervalMs = 6 * 60 * 60 * 1000,
  home23Root = path.resolve(__dirname, '../../..'),
  gzipLevel,
  schedule = queueMicrotask,
  retireUnpinnedSources: retire = retireUnpinnedSources,
  logger = console,
  writer = { readManifest, appendMemoryRevision, rewriteMemoryBase },
}) {
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  const snapshot = memory.capturePersistenceSnapshot();
  const manifest = await writer.readManifest(brainDir);
  const ageMs = manifest?.baseWrittenAt ? Date.now() - Date.parse(manifest.baseWrittenAt) : Infinity;
  const rewrite = forceFull || !manifest || !Number.isFinite(ageMs) || ageMs >= fullRewriteIntervalMs;
  let result;
  if (rewrite) {
    result = await writer.rewriteMemoryBase(brainDir, {
      nodes: snapshot.fullView.nodes,
      edges: snapshot.fullView.edges,
      summary: snapshot.summary,
    }, {
      level: gzipLevel, lockRoot,
    });
  } else if (snapshot.changes.nodes.length || snapshot.changes.edges.length ||
             snapshot.changes.removedNodeIds.length || snapshot.changes.removedEdgeKeys.length) {
    result = await writer.appendMemoryRevision(brainDir, snapshot.changes, {
      lockRoot,
      summary: snapshot.summary,
    });
  } else {
    result = { manifest, count: 0, mode: 'reused' };
  }
  const committed = Boolean(result?.manifest && (rewrite || result.count > 0));
  const cleaned = committed
    ? memory.markPersistenceCleanIfGeneration(snapshot.generation)
    : false;
  if (rewrite && result?.manifest) {
    scheduleSourceRetirement({
      brainDir, home23Root, lockRoot, retire, schedule, logger,
    });
  }
  return {
    ...result,
    mode: rewrite ? 'full' : (result.count > 0 ? 'delta' : 'reused'),
    cleaned,
    persistedGeneration: snapshot.generation,
    persistedChanges: snapshot.changes,
  };
}

async function loadMemoryRevision(brainDir, {
  home23Root = path.resolve(__dirname, '../../..'),
  requesterAgent,
  operationId = null,
} = {}) {
  if (!requesterAgent) throw new Error('requester_agent_required');
  const ownsOperationRoot = operationId === null;
  const effectiveOperationId = operationId || ('internal-load-' + randomUUID());
  const sourceSelection = await resolveMemorySourceSelection(brainDir);
  const operationRoot = path.join(
    home23Root, 'instances', requesterAgent, 'runtime',
    'brain-operations', effectiveOperationId,
  );
  const source = await openMemorySource(brainDir, {
    requesterAgent,
    operationId: effectiveOperationId,
    operationRoot,
    lockRoot: path.join(home23Root, 'runtime', 'brain-source-locks'),
  });
  try {
    const nodes = [];
    const edges = [];
    for await (const node of source.iterateNodes()) nodes.push(node);
    for await (const edge of source.iterateEdges()) edges.push(edge);
    const summary = await source.summarize();
    return {
      nodes,
      edges,
      summary,
      revision: source.revision,
      sourceSelection,
      evidence: source.getEvidence({
        completeCoverage: true,
        authoritativeTotals: { nodes: summary.nodes, edges: summary.edges },
        returnedTotals: { nodes: nodes.length, edges: edges.length },
      }),
    };
  } finally {
    await source.close();
    if (ownsOperationRoot) {
      await fsp.rm(operationRoot, { recursive: true, force: true });
    }
  }
}

module.exports = { persistMemoryRevision, loadMemoryRevision, scheduleSourceRetirement };
~~~

- [ ] **Step 4: Convert the legacy sidecar module into a compatibility adapter**

Retain `writeJsonlGz`, `readJsonlGz`, fixed legacy path helpers, and typed-array serialization for existing callers/tests. Replace `writeMemorySidecars`, `appendMemoryDelta`, `readMemorySidecars`, and `readMemoryDeltas` internals with calls through `memory-persistence.js` or `shared/memory-source`, while preserving their old return shapes.

The compatibility full-write function must synchronously capture one immutable view before its first await. If `memory.capturePersistenceSnapshot` exists, use `snapshot.fullView` plus `snapshot.summary`; otherwise `captureCompatibilityView(memory)` synchronously clones the plain node/edge records and derives its summary. It must be:

~~~js
async function writeMemorySidecars(brainDir, memory, options = {}) {
  const snapshot = memory.capturePersistenceSnapshot?.();
  const view = snapshot ? {
    nodes: snapshot.fullView.nodes,
    edges: snapshot.fullView.edges,
    summary: snapshot.summary,
  } : captureCompatibilityView(memory);
  const result = await rewriteMemoryBase(brainDir, view, options);
  return {
    mode: 'full',
    revision: result.manifest.currentRevision,
    manifest: result.manifest,
    nodes: { file: result.manifest.activeBase.nodes.file, ...result.nodes },
    edges: { file: result.manifest.activeBase.edges.file, ...result.edges },
  };
}
~~~

It must not remove `memory-delta.jsonl` before manifest commit and must never hand live maps/arrays to the async writer.

- [ ] **Step 5: Delegate orchestrator save and load**

In `engine/src/core/orchestrator.js`, replace the sidecar branch at lines 7141-7265 with:

~~~js
const { persistMemoryRevision } = require('./memory-persistence');
const persistence = await persistMemoryRevision({
  brainDir: this.logsDir,
  home23Root: this.home23Root || path.resolve(__dirname, '../../..'),
  memory: this.memory,
  fullRewriteIntervalMs: this.config?.persistence?.memorySidecarFullRewriteIntervalMs,
  gzipLevel: this.config?.persistence?.memorySidecarGzipLevel,
});
sidecarsWritten = {
  mode: persistence.mode,
  manifest: persistence.manifest,
  revision: persistence.manifest?.currentRevision ?? null,
  nodes: {
    count: expectedNodes,
    bytes: persistence.manifest?.activeBase?.nodes?.bytes || 0,
  },
  edges: {
    count: expectedEdges,
    bytes: persistence.manifest?.activeBase?.edges?.bytes || 0,
  },
};
state.memory = { ...state.memory, nodes: [], edges: [] };
~~~

At lines 7533-7589, replace independent base/delta maps with:

~~~js
const { loadMemoryRevision } = require('./memory-persistence');
const loadedMemory = await loadMemoryRevision(this.logsDir, {
  home23Root: this.home23Root || path.resolve(__dirname, '../../..'),
  requesterAgent: this.agentName || process.env.HOME23_AGENT,
});
state.memory.nodes = loadedMemory.nodes;
state.memory.edges = loadedMemory.edges;
this.logger?.info?.('Memory revision loaded', {
  revision: loadedMemory.revision,
  nodes: loadedMemory.nodes.length,
  edges: loadedMemory.edges.length,
  sourceHealth: loadedMemory.evidence.sourceHealth,
});
~~~

- [ ] **Step 6: Make guard, snapshot, and backup revision-aware**

Change `resolveKnownGoodNodeCount()` to open the source and return:

~~~js
{
  count: summary.nodes,
  source: evidence.sourceHealth === 'healthy' ? 'memory-manifest' : 'memory-legacy',
  revision: source.revision,
  evidence,
}
~~~

Extend `brain-snapshot.json` writes with `memoryRevision`, `baseRevision`, `deltaEpoch`, and `sourceHealth`, while keeping it advisory.

Change `maybeBackup()` to:

1. Create a private requester-owned backup operation root, derive the ignored global lock root, and open/pin `openMemorySource(brainDir, {requesterAgent,operationId,operationRoot,lockRoot})`. This is required for safe legacy resident projection on an existing install.
2. Copy `state.json.gz`, `brain-snapshot.json`, `memory-manifest.json`, and every file returned by the source pin.
3. Write `backup-manifest.json` containing the source generation/revision and copied filenames.
4. Rename the temporary backup directory.
5. Close the source pin and remove the private backup operation root in `finally`.

- [ ] **Step 7: Run focused persistence verification and commit**

Run:

~~~bash
node --test --test-concurrency=1 tests/engine/core/memory-persistence.test.js tests/engine/memory/network-memory-persistence-generation.test.js tests/engine/core/memory-sidecar.test.cjs tests/engine/core/brain-persistence-guard.test.js tests/engine/core/brain-backups.test.cjs
git diff --check -- engine/src/core tests/engine/core
~~~

Expected: all focused tests pass, including dirty-state ordering and coherent pinned backups.

Commit:

~~~bash
git diff --cached --quiet
git add -- engine/src/core/memory-persistence.js engine/src/memory/network-memory.js engine/src/core/memory-sidecar.js engine/src/core/orchestrator.js engine/src/core/brain-persistence-guard.js engine/src/core/brain-snapshot.js engine/src/core/brain-backups.js tests/engine/core/memory-persistence.test.js tests/engine/memory/network-memory-persistence-generation.test.js tests/engine/core/memory-sidecar.test.cjs tests/engine/core/brain-persistence-guard.test.js tests/engine/core/brain-backups.test.cjs
git diff --cached --check
git diff --cached
git commit -m "fix(memory): persist crash-safe logical revisions"
git status --short
~~~

### Task 5: ANN Freshness and Honest Dashboard Search

**Files:**
- Create: `engine/src/dashboard/memory-search.js`
- Modify: `engine/src/merge/build-ann-index.js`
- Modify: `engine/src/dashboard/server.js:6942-7317`
- Test: `tests/engine/dashboard/memory-search.test.js`
- Create: `tests/engine/dashboard/memory-search-heap-probe.cjs`
- Test: `tests/engine/merge/build-ann-index.test.js`

**Interfaces:**
- Consumes: Task 2 `withEphemeralMemorySource()`/pinned readers, Task 3 `advanceAnnBuiltFromRevision()`, Plan A coordinator `resolveTargetContext()`, and existing provenance/salience scoring.
- Produces: `createMemorySearchService(options).search(request)` and an ANN metadata file pinned to a manifest generation/revision.

- [ ] **Step 1: Write failing stale-index and fallback tests**

Create `tests/engine/dashboard/memory-search.test.js` with an injected fake ANN and embedding client:

~~~js
test('stale ANN cannot hide a new delta keyword canary', async () => {
  const fixture = await createSearchFixture({
    baseRevision: 4,
    currentRevision: 5,
    annBuiltFromRevision: 4,
    deltaNodes: [{ id: 'canary', concept: 'route-watermark-canary' }],
  });
  const service = createMemorySearchService({
    brainDir: fixture.dir,
    embedQuery: async () => [1, 0],
    loadAnn: async () => fixture.annReturningNoHits,
  });
  const result = await service.search({ query: 'route-watermark-canary', topK: 5 });
  assert.equal(result.results[0].id, 'canary');
  assert.equal(result.evidence.sourceHealth, 'degraded');
  assert.equal(result.evidence.matchOutcome, 'matches');
  assert.equal(result.evidence.indexWatermark.fresh, false);
  assert.equal(result.evidence.fallback.route, 'logical-keyword-scan');
});

test('a delta tombstone suppresses an ANN label', async () => {
  const service = await serviceWithStaleAnnHitAndDeltaDelete('deleted');
  const result = await service.search({ query: 'deleted canary' });
  assert.equal(result.results.some(row => row.id === 'deleted'), false);
});

test('dimension mismatch and embedding failure use keyword retrieval', async () => {
  const mismatch = await searchWith({ queryEmbedding: [1, 0], annDimension: 3 });
  assert.equal(mismatch.evidence.fallback.reason, 'embedding_dimension_mismatch');
  const unavailable = await searchWith({ embedError: new Error('offline') });
  assert.equal(unavailable.results[0].retrievalMode, 'keyword');
});

test('semantic vectors and the final merged response are byte bounded', async () => {
  await assert.rejects(searchWith({ queryEmbedding: new Array(8193).fill(0) }),
    error => error.code === 'result_too_large');
  const malformed = await searchWith({ queryEmbedding: [1, NaN] });
  assert.equal(malformed.evidence.fallback.reason, 'embedding_invalid');
  await assert.rejects(searchWithNearLimitSemanticAndKeywordRows({ responseBytes: 16 * 1024 * 1024 + 1 }),
    error => error.code === 'result_too_large');
});

test('noise-filtered semantic candidates are supplemented by exact keyword results', async () => {
  const result = await searchNoiseFixture('exact-canary');
  assert.equal(result.results.some(row => row.concept.includes('exact-canary')), true);
  assert.equal(result.evidence.fallback.reason, 'semantic_noise_filtered');
});

test('healthy empty, healthy no-match, and degraded unknown remain distinct', async () => {
  assert.equal((await searchFixture({ healthy: true, nodes: [] })).evidence.matchOutcome, 'corpus_empty');
  assert.equal((await searchFixture({ healthy: true, nodes: [{ id: 1, concept: 'other' }] })).evidence.matchOutcome, 'no_match');
  assert.equal((await searchFixture({ healthy: false, nodes: [] })).evidence.matchOutcome, 'unknown');
});

test('search cancellation is never converted into embedding fallback or source unavailable', async () => {
  const controller = new AbortController();
  const fixture = searchFixtureThatAbortsDuringLogicalScan(controller);
  await assert.rejects(
    fixture.service.search({ query: 'canary', signal: controller.signal }),
    error => error.name === 'AbortError',
  );
  assert.equal(fixture.recordsConsumed, fixture.recordsAtAbort);
  assert.equal(fixture.fallbacksRecorded, 0);
});

test('compatibility search derives canonical own-target identity and private scratch', async () => {
  const fixture = await createCompatibilitySearchFixture();
  const result = await fixture.service.search({ query: 'canary', topK: 5 });
  assert.equal(fixture.resolveCalls, 1);
  assert.equal(result.evidence.identity.requesterAgent, fixture.requesterAgent);
  assert.equal(result.evidence.identity.brainId, fixture.target.id);
  assert.match(result.evidence.identity.operationId, /^dashboard-search-/);
  assert.equal(fixture.operationRoot.startsWith(fixture.target.canonicalRoot), false);
  assert.equal(await pathExists(fixture.operationRoot), false);
  await assert.rejects(
    fixture.service.search({ query: 'canary', identity: { requesterAgent: 'mallory' } }),
    error => error.code === 'invalid_request',
  );
});
~~~

Add a million-node stale-ANN semantic-scan fixture with adversarial large embeddings/text. Require a fixed-size candidate heap capped at `min(1000,max(100,topK*4))`, bounded projected fields with embeddings omitted, aggregate retained bytes at most 8 MiB, and peak heap growth at most 192 MiB in an `--expose-gc` child probe. The test must throw if production retains a full node or appends all above-threshold matches to an array.

Create `tests/engine/merge/build-ann-index.test.js` proving the builder:

- Calls `withEphemeralMemorySource()` once and its callback receives one pinned
  source; it never calls `openMemorySource()` or a full loader directly.
- Indexes the pinned logical nodes, including delta upserts and excluding tombstones.
- Writes versioned temp index/meta files before rename.
- Calls `advanceAnnBuiltFromRevision` with the pinned generation and revision.
- Leaves the ANN watermark stale if source generation changes before CAS.

- [ ] **Step 2: Run focused search/index tests and verify red**

Run:

~~~bash
node --test --test-concurrency=1 tests/engine/dashboard/memory-search.test.js tests/engine/merge/build-ann-index.test.js
node --expose-gc tests/engine/dashboard/memory-search-heap-probe.cjs
~~~

Expected: FAIL because `memory-search.js` does not exist and the builder uses sidecar mtime rather than revisions.

- [ ] **Step 3: Implement the search service**

Create `engine/src/dashboard/memory-search.js` with this public structure:

~~~js
'use strict';

const {
  withEphemeralMemorySource, classifyMatchOutcome, parseBoundedInteger,
  normalizeKeywordTokens, rethrowAbort, throwIfAborted,
} = require('../../../shared/memory-source');
const { classifyMemoryProvenance, scoreMemorySalience } = require('../memory/provenance-salience');

function createMemorySearchService({
  brainDir, home23Root, requesterAgent, resolveTargetContext,
  embedQuery, loadAnn, logger = console,
  withEphemeralSource = withEphemeralMemorySource,
}) {
  async function executeSearch(source, {
    query, topK = 10, minSimilarity = 0.4, noiseFloor = 0.55,
    tag = null, signal, identity,
  }) {
    throwIfAborted(signal);
    normalizeKeywordTokens(query); // before ANN/embed/provider work
    const limit = parseBoundedInteger(topK, {
      name: 'topK', defaultValue: 10, min: 1, max: 100,
    });
      const summary = await source.summarize({ signal });
      const manifest = source.manifest;
      const annFresh = manifest?.formatVersion === 1 &&
        manifest.ann?.builtFromRevision === manifest.currentRevision;
      let queryEmbedding = null;
      let fallback = null;
      try {
        queryEmbedding = await embedQuery(query, { signal });
        if (Array.isArray(queryEmbedding) && queryEmbedding.length > 8192) {
          throw Object.assign(new Error('query embedding exceeds dimension limit'), {
            code: 'result_too_large', status: 413, retryable: false,
          });
        }
        if (!Array.isArray(queryEmbedding) || !queryEmbedding.length
            || queryEmbedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
          queryEmbedding = null;
          fallback = { route: 'logical-keyword-scan', reason: 'embedding_invalid', completeness: 'complete' };
        }
      } catch (error) {
        rethrowAbort(error, signal);
        if (error.code === 'result_too_large') throw error;
        fallback = { route: 'logical-keyword-scan', reason: 'embedding_unavailable', completeness: 'complete' };
      }

      const candidateLimit = Math.min(1000, Math.max(100, limit * 4));
      const semantic = createBoundedCandidateHeap({
        maxCount: candidateLimit,
        maxBytes: 8 * 1024 * 1024,
        maxRecordBytes: 256 * 1024,
      });
      if (queryEmbedding && annFresh) {
        const ann = await loadAnn(manifest.ann, { signal });
        if (ann && ann.dimension === queryEmbedding.length) {
          for (const hit of ann.search(queryEmbedding, candidateLimit)) {
            throwIfAborted(signal);
            if (tag && hit.node.tag !== tag) continue;
            if (hit.similarity < minSimilarity) continue;
            const provenance = classifyMemoryProvenance(hit.node);
            semantic.offer({
              ...projectBoundedSearchNode(hit.node, { omit: ['embedding'] }),
              similarity: hit.similarity,
              retrievalScore: scoreMemorySalience(hit.node, hit.similarity),
              sourceClass: provenance.sourceClass,
              retrievalMode: 'semantic-ann',
            });
          }
        } else {
          fallback = { route: 'logical-keyword-scan', reason: 'embedding_dimension_mismatch', completeness: 'complete' };
        }
      } else if (queryEmbedding && !annFresh) {
        fallback = { route: 'logical-source-scan', reason: 'ann_stale', completeness: 'complete' };
      }

      if (queryEmbedding && (!annFresh || fallback?.reason === 'embedding_dimension_mismatch')) {
        for await (const node of source.iterateNodes({ signal, filter: candidate => !tag || candidate.tag === tag })) {
          throwIfAborted(signal);
          if (!Array.isArray(node.embedding) || node.embedding.length !== queryEmbedding.length) continue;
          const similarity = cosineSimilarity(queryEmbedding, node.embedding);
          if (similarity >= minSimilarity) {
            semantic.offer({
              ...projectBoundedSearchNode(node, { omit: ['embedding'] }),
              similarity,
              retrievalScore: scoreMemorySalience(node, similarity),
              retrievalMode: 'semantic-scan',
            });
          }
        }
      }

      const semanticCandidates = semantic.sorted().slice(0, limit);
      const semanticTop = semanticCandidates.filter(row => Number(row.similarity || 0) >= noiseFloor);
      const keyword = await source.searchKeyword(query, { topK: limit, tag, signal });
      const exactMissing = keyword.results.some(row => !semanticTop.some(existing => String(existing.id) === String(row.id)));
      if (semanticCandidates.length > 0 && semanticTop.length === 0 && keyword.results.length > 0 && !fallback) {
        fallback = { route: 'logical-keyword-scan', reason: 'semantic_noise_filtered', completeness: 'complete' };
      } else if (exactMissing && !fallback) {
        fallback = { route: 'logical-keyword-supplement', reason: 'exact_canary_missing', completeness: 'complete' };
      }
      const merged = new Map();
      for (const row of [...semanticTop, ...keyword.results]) merged.set(String(row.id), row);
      const results = Array.from(merged.values()).slice(0, limit);
      const sourceHealth = source.getEvidence().sourceHealth === 'healthy' && fallback ? 'degraded' : source.getEvidence().sourceHealth;
      const matchOutcome = classifyMatchOutcome({
        sourceHealth,
        authoritativeTotal: summary.nodes,
        returnedTotal: results.length,
        filteredTotal: keyword.filtered,
        completeCoverage: true,
      });
      const response = {
        query,
        results,
        stats: { totalSearched: summary.nodes, totalMatched: results.length, retrievalMode: fallback ? 'hybrid' : 'semantic-ann' },
        evidence: source.getEvidence({
          identity,
          sourceHealth,
          matchOutcome,
          completeCoverage: true,
          filters: { tag },
          limits: { topK: limit },
          authoritativeTotals: { nodes: summary.nodes, edges: summary.edges },
          returnedTotals: { nodes: results.length, edges: 0 },
          fallback,
        }),
      };
      if (Buffer.byteLength(JSON.stringify(response), 'utf8') > 16 * 1024 * 1024) {
        throw Object.assign(new Error('search response exceeds byte limit'), {
          code: 'result_too_large', status: 413, retryable: false,
        });
      }
      return response;
  }

  async function search(request) {
    throwIfAborted(request.signal);
    normalizeKeywordTokens(request.query); // before target/source/provider work
    if (request.sourcePin) {
      if (!request.identity?.operationId) {
        throw Object.assign(new Error('pinned operation identity required'), {
          code: 'invalid_request',
        });
      }
      return executeSearch(request.sourcePin, request);
    }
    if (request.identity !== undefined) {
      throw Object.assign(new Error('compatibility identity is server-derived'), {
        code: 'invalid_request',
      });
    }
    const resolved = await resolveTargetContext({});
    const target = resolved.target;
    if (target.canonicalRoot !== await require('node:fs').promises.realpath(brainDir)) {
      throw Object.assign(new Error('local catalog target/source mismatch'), {
        code: 'source_changed', retryable: true,
      });
    }
    const identity = {
      requesterAgent,
      targetAgent: target.ownerAgent,
      brainId: target.id,
      canonicalRoot: target.canonicalRoot,
      catalogRevision: resolved.catalogRevision,
      kind: target.kind,
      sourceType: target.sourceType,
      accessMode: resolved.accessMode,
    };
    return withEphemeralSource({
      brainDir, home23Root, requesterAgent, identity,
      signal: request.signal, prefix: 'dashboard-search',
    }, (source, context) => executeSearch(source, {
      ...request, identity: context.identity,
    }));
  }
  return { search };
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

module.exports = { createMemorySearchService, cosineSimilarity };
~~~

- [ ] **Step 4: Make ANN build and dashboard route revision-aware**

Refactor `engine/src/merge/build-ann-index.js` so `build(brainDir, deps = {})`:

1. Resolves the canonical own target through injected
   `resolveTargetContext({})`, verifies its root equals `brainDir`, and opens one
   pinned source through `withEphemeralMemorySource()` using prefix
   `ann-build`. This gives a large delta a private spill area; it never opens a
   path-only unpinned source.
2. Streams `source.iterateNodes()`.
3. Writes `memory-ann.<revision>.index.tmp` and `memory-ann.<revision>.meta.json.tmp`.
4. Fsyncs and renames both.
5. Calls:

~~~js
await advanceAnnBuiltFromRevision(brainDir, {
  expectedGeneration: source.manifest.generation,
  builtFromRevision: source.revision,
  indexFile,
  metaFile,
  lockRoot: path.join(home23Root, 'runtime', 'brain-source-locks'),
});
~~~

Metadata must include `generation`, `builtFromRevision`, `dimension`, `count`, provider/model identity, and labels.
The entire stream/index/CAS sequence runs inside the helper callback. Cleanup
closes the source before removing private scratch on success, stale-CAS, abort,
or failure. ANN temp/final files are the only authorized target writes and are
covered by the persistence writer/CAS tests.

In `engine/src/dashboard/server.js`, instantiate the service once with
`brainDir:this.logsDir`, `home23Root:this.getHome23Root()`,
`requesterAgent:this.getHome23AgentName()`, and
`resolveTargetContext: selector => this.brainOperationCoordinator.resolveTargetContext(selector)`.
Each short HTTP request creates an `AbortController`, aborts it on request
close, and passes only sanitized search parameters plus the signal. The service
resolves canonical own-target identity and ephemeral operation context; never
use body identity fields. Replace `handleMemorySearch` with:

~~~js
const controller = new AbortController();
req.once('close', () => controller.abort(Object.assign(new Error('client disconnected'), {
  name: 'AbortError', code: 'cancelled',
})));
const result = await this.memorySearchService.search({
  ...pickSearchParameters(req.body),
  signal: controller.signal,
});
if (result.evidence.sourceHealth === 'unavailable') {
  return res.status(503).json({ ok: false, error: { code: 'source_unavailable' }, ...result });
}
return res.json(result);
~~~

The route's error middleware maps `AbortError`/`code: 'cancelled'` to the typed cancelled response and does not log or return `source_unavailable`. Remove the inline ANN mtime cache and base-only keyword/semantic scans.

- [ ] **Step 5: Run focused tests and commit explicit paths**

Run:

~~~bash
node --test --test-concurrency=1 tests/engine/dashboard/memory-search.test.js tests/engine/merge/build-ann-index.test.js tests/shared/memory-source-reader.test.js
node --expose-gc tests/engine/dashboard/memory-search-heap-probe.cjs
git diff --check -- engine/src/dashboard/memory-search.js engine/src/merge/build-ann-index.js engine/src/dashboard/server.js tests/engine/dashboard/memory-search.test.js tests/engine/dashboard/memory-search-heap-probe.cjs tests/engine/merge/build-ann-index.test.js
~~~

Expected: all tests pass; no stale ANN-only result is possible.

Commit:

~~~bash
git diff --cached --quiet
git add -- engine/src/dashboard/memory-search.js engine/src/merge/build-ann-index.js engine/src/dashboard/server.js tests/engine/dashboard/memory-search.test.js tests/engine/dashboard/memory-search-heap-probe.cjs tests/engine/merge/build-ann-index.test.js
git diff --cached --check
git diff --cached
git commit -m "fix(memory): validate ANN against source revisions"
git status --short
~~~

### Task 6: Deterministic Bounded Graph and Status Routes

**Files:**
- Create: `shared/memory-source/graph.cjs`
- Create: `shared/memory-source/legacy-snapshot.cjs`
- Modify: `shared/memory-source/index.cjs`
- Create: `engine/src/dashboard/brain-source-api.js`
- Create: `engine/src/dashboard/brain-operations/source-executors.js`
- Create: `engine/src/dashboard/brain-operations/graph-export-executor.js`
- Create: `cosmo23/server/lib/brain-source-router.js`
- Create: `cosmo23/lib/memory-source-adapter.js`
- Modify: `engine/src/dashboard/server.js:2400-2555`
- Modify: `engine/src/dashboard/home23-brain-map.js:438`
- Modify: `engine/src/dashboard/server.js:10932-10985`
- Modify: `cosmo23/server/index.js:1940-1999`
- Modify: `cosmo23/lib/memory-sidecar.js`
- Modify: `cosmo23/engine/src/core/orchestrator.js`
- Modify: `cosmo23/engine/src/merge/merge-engine.js`
- Modify: `evobrew/lib/memory-sidecar.js`
- Test: `tests/shared/memory-source-graph.test.js`
- Test: `tests/shared/memory-source-graph-heap-probe.cjs`
- Test: `tests/engine/dashboard/brain-source-api.test.js`
- Test: `tests/engine/dashboard/home23-brain-map.test.js`
- Test: `tests/engine/dashboard/brain-source-executors.test.js`
- Test: `tests/engine/dashboard/brain-graph-export.test.js`
- Test: `tests/engine/dashboard/brain-source-mutation-boundary.test.js`
- Test: `tests/cosmo23/brain-source-router.test.cjs`
- Test: `tests/cosmo23/legacy-research-memory-source.test.cjs`
- Test: `tests/cosmo23/research-memory-manifest.test.cjs`
- Test: `tests/cosmo23/memory-sidecar.test.cjs`
- Test: `tests/evobrew/memory-sidecar.test.cjs`

**Interfaces:**
- Consumes: Task 2 source iterator/evidence, Task 5 `createMemorySearchService()`, and the authority plan's `BrainOperationWorkerAdapter.registerLocalExecutor()`.
- Produces: `parseBoundedInteger(value, rules)`, `sampleMemoryGraph(source, {nodeLimit,edgeLimit,...})`, `projectLegacyResearchSnapshot(input)`, `createBrainSourceService(options)`, `createSourceOperationExecutors(options)`, resident `/home23/api/brain/status` and `/home23/api/brain/graph`, COSMO `/api/brain/:name/status` and bounded graph routes, and local operation executors named `search`, `status`, `graph`, and asynchronous `graph_export`.

- [ ] **Step 1: Write failing large-fixture bounded-read tests**

Create a synthetic source whose `iterateNodes()` yields 100,000 nodes and whose `loadAll()` throws. Assert:

~~~js
test('samples a large source within node and edge caps without unbounded loading', async () => {
  const source = syntheticStreamingSource({ nodes: 100000, edges: 300000 });
  const result = await sampleMemoryGraph(source, { nodeLimit: 250, edgeLimit: 1000 });
  assert.equal(result.nodes.length <= 250, true);
  assert.equal(result.edges.length <= 1000, true);
  assert.equal(result.meta.authoritativeNodeCount, 100000);
  assert.equal(result.meta.returnedNodeCount, result.nodes.length);
  assert.equal(source.loadAllCalls, 0);
  assert.equal(result.meta.maxNodeHeapSize, 250);
  assert.equal(result.meta.maxEdgeHeapSize <= 1000, true);
  assert.equal(result.meta.heapComparisons < 12_000_000, true);
});

test('normalizes numeric cluster filters and produces a deterministic pinned sample', async () => {
  const source = clusterFixture([4, '4', 5]);
  const first = await sampleMemoryGraph(source, { clusterId: '4', nodeLimit: 2, edgeLimit: 2 });
  const second = await sampleMemoryGraph(source, { clusterId: 4, nodeLimit: 2, edgeLimit: 2 });
  assert.deepEqual(first.nodes.map(row => row.id), second.nodes.map(row => row.id));
  assert.equal(first.nodes.every(row => String(row.cluster) === '4'), true);
});

test('rejects full graph compatibility requests', async () => {
  const response = await requestResidentGraph({ full: '1' });
  assert.equal(response.status, 413);
  assert.equal(response.body.error.code, 'result_too_large');
});

test('COSMO graph route does not call queryEngine.loadBrainState', async () => {
  const response = await requestCosmoGraph({
    queryEngine: { loadBrainState() { throw new Error('unbounded loader invoked'); } },
    brainDir: await createManifestGraphFixture(),
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.meta.returnedNodeCount <= 250, true);
});

test('graph limits require finite bounded integers', async () => {
  for (const [name, value] of [
    ['nodeLimit', NaN], ['nodeLimit', Infinity], ['nodeLimit', 1.5],
    ['nodeLimit', '1.5'], ['nodeLimit', 0], ['nodeLimit', 2001],
    ['edgeLimit', -1], ['edgeLimit', 2.25], ['edgeLimit', 8001],
  ]) {
    await assert.rejects(
      sampleMemoryGraph(syntheticStreamingSource({ nodes: 1, edges: 0 }), { [name]: value }),
      error => error.code === 'invalid_request' && error.status === 400,
    );
  }
  assert.equal((await sampleMemoryGraph(syntheticStreamingSource({ nodes: 1, edges: 0 }), {
    nodeLimit: '1', edgeLimit: '0',
  })).edges.length, 0);
});

test('graph cancellation stops node and edge consumption and remains AbortError', async () => {
  const controller = new AbortController();
  const source = abortingGraphSource(controller, { abortAfterNodes: 75 });
  await assert.rejects(
    sampleMemoryGraph(source, { nodeLimit: 10, edgeLimit: 20, signal: controller.signal }),
    error => error.name === 'AbortError',
  );
  assert.equal(source.recordsConsumed, source.recordsAtAbort);
});
~~~

Add adversarial byte-bound cases, not only record-count cases. A graph node
containing a multi-megabyte embedding, nested metadata, or concept and an edge
containing a large metadata object must never be retained verbatim. Assert that
the sampler projects records through the exact graph-safe scalar schemas below,
omits embeddings and unknown/nested fields, caps any single projected node at
128 KiB and edge at 32 KiB, keeps retained node bytes at or below 16 MiB and
edge bytes at or below 8 MiB, and keeps serialized cluster totals at or below
1 MiB/10,000 keys. If exact cluster totals cross either bound, the sampler must
free the partial map and return `clusters:null` plus
`meta.clusterTotalsOmitted:true`; it must never label `{}` as exact totals. The
entire serialized JSON response is capped at 32 MiB. A projection or final
envelope that cannot meet these limits fails with typed 413
`result_too_large`; it is never silently returned over the cap.

Create `tests/shared/memory-source-graph-heap-probe.cjs`. In a child process
started with `--max-old-space-size=192 --expose-gc`, stream one million nodes
and three million edges, including periodic maximum-sized projected values and
huge discarded embeddings/metadata generated one record at a time. Assert the
call completes, `maxNodeHeapSize <= 2000`, `maxEdgeHeapSize <= 8000`, retained
byte counters never exceed their caps, the returned JSON is at most 32 MiB, and
peak `heapUsed` sampled during both node and edge iteration stays below 160 MiB.
The fixture itself must not prebuild either collection.

Add coordinator-executor tests that register `search`, `status`, `graph`, and `graph_export`, invoke each with canonical operation context, and require the standard envelope:

~~~js
{
  state: 'complete',
  result: { bounded: true },
  error: null,
  sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'matches' },
}
~~~

For direct resident status/graph compatibility routes, inject the real
coordinator `resolveTargetContext({})` seam. Assert one fresh resolution per
request, canonical source-root equality before open, a derived
`dashboard-source-<uuid>` evidence operation ID, private source/overlay scratch
cleanup, and rejection of any body/query identity, requester, target, root,
catalog revision, or operation ID. A catalog/source mismatch is retryable
`source_changed` before iteration.

For `graph_export`, require `result:null` and a separate trusted top-level `resultArtifact` with **exactly** `{scratchPath,mediaType:'application/x-ndjson',contentEncoding:'identity',bytes,sha256}`. The descriptor is produced only by the registered local executor, is persisted separately by the operation store, and is never accepted from request parameters or nested inside caller-controlled `result`. Export counts/revision live only under `sourceEvidence.graphExport = {nodeCount,edgeCount,sourceRevision}`; no counts, summary, metadata, or artifact information appears in `result`.

Table-test own-agent, sibling-agent, and completed-research targets. For every result, assert identity contains exactly the context-derived `requesterAgent`, nullable `targetAgent`, `brainId`, target `canonicalRoot`, stable catalog-revision string, `kind`, `sourceType`, `accessMode`, and `operationId`, with compatibility aliases matching target—not requester. The test must fail if an executor reads any identity from `parameters`, if source descriptor/root and target context differ, if graph/status invokes an unbounded loader, or if `graph_export` accepts caller `outputPath`, `scratchDir`, requester, operation, root, or evidence fields. Make `brainSourceService.status()` return `{ok:false,evidence:{sourceHealth:'unavailable',matchOutcome:'unknown'}}`; the operation executor must return terminal `failed` with typed retryable `source_unavailable`, null result, and the evidence. Feed that record through the real brain_status tool adapter and assert `is_error:true` rather than a success-looking JSON body. Abort separately during overlay, search, status, graph, and export; every executor returns `{state:'cancelled', error:{code:'cancelled'}}`, consumes no later records, and never converts cancellation into `source_unavailable`.

Create `tests/engine/dashboard/brain-source-mutation-boundary.test.js`. For own-agent, sibling-agent, and completed-research fixtures, assert the catalog exposes `{kind,path}` objects for all seven required kinds, then take byte hashes plus file stats for every complete boundary tree before and after each regular source operation: search, status, graph, and graph export. Assert every target boundary is byte-identical; the global lock root is outside every target and no target path is excluded from hashing; per-process pins are created only beneath `<requester-operation>/pins/<processIdentity>`; search/status/graph create no scratch files; graph export changes only requester-owned result storage. Repeat the same inventory assertion for MCP in Task 7.

Create `tests/engine/dashboard/brain-graph-export.test.js` around the real local executor and operation store. It must prove: a capability-verified requester can stream the complete pinned logical graph as uncompressed NDJSON; a mismatched target/root/revision, missing pin, forged output path, non-`jsonl` format, or caller-supplied `resultArtifact` fails before opening an output; the local executor returns `result:null`, exact trusted top-level `resultArtifact:{scratchPath,mediaType:'application/x-ndjson',contentEncoding:'identity',bytes,sha256}`, and counts/revision only in `sourceEvidence.graphExport`; keys `storage`, `relativePath`, `format`, and `retentionClass` are absent; result-plus-artifact is rejected; the protected client sees only its opaque result handle, path-free artifact metadata, and evidence, never `scratchPath`; target boundaries are unchanged; exact write backpressure is honored; abort removes the temp output; and operation GC keeps the large result through day 7, removes result/scratch after day 7, retains terminal metadata through day 30, and never collects a nonterminal export. Explicit user export through the foundation endpoint accepts only `{format:'jsonl'}`, creates a separate requester-owned `.jsonl` copy, and is the only path that outlives large-result retention.

Create `tests/cosmo23/legacy-research-memory-source.test.cjs` before implementation. Generate a large streaming `state.json.gz` fixture with braces/quotes/escaped Unicode/nested arrays inside records, and monkeypatch `fs.promises.readFile`, `zlib.gunzip`, and any whole-snapshot/full-graph parser seam to throw if used. Assert every node/edge crosses, the largest retained parser buffer is at most one `maxRecordBytes` record plus one input chunk, the immutable projection manifest is numeric version 1, its deterministic digest-derived revision is a safe integer, its descriptor keeps the target canonical root, and every generated projection/pin file is under requester operation runtime. Run the same invariants against the Task 2 resident-sidecar projector. Inject a tiny decompression cap to prove decompressed—not compressed—bytes trip `result_too_large`; abort mid-gunzip and assert record counts stop; mutate source stat during the first attempt and prove a clean retry; mutate every attempt and get `source_changed`; hash the target before/after every case.

Create `tests/cosmo23/research-memory-manifest.test.cjs` before changing persistence. Save a normal new research run and a merged run, then assert each writes `memory-manifest.json`, versioned base files, an empty committed delta, numeric revisions, and healthy source evidence before the compressed state is replaced with an empty memory shell. Inject a manifest write failure and prove the original full state remains recoverable rather than being truncated.

Extend `tests/engine/dashboard/home23-brain-map.test.js` to prove the installed
dashboard requests `nodeLimit=2000&edgeLimit=8000` (never the now-invalid legacy
2500/10000 pair), accepts the compatibility `success` and `meta` aliases from
the same bounded response, and renders a limited graph without requesting
`full=1`.

- [ ] **Step 2: Run bounded graph suites and verify red**

Run:

~~~bash
node --test --test-concurrency=1 \
  tests/shared/memory-source-graph.test.js \
  tests/engine/dashboard/brain-source-api.test.js \
  tests/engine/dashboard/home23-brain-map.test.js \
  tests/engine/dashboard/brain-source-executors.test.js \
  tests/engine/dashboard/brain-graph-export.test.js \
  tests/engine/dashboard/brain-source-mutation-boundary.test.js \
  tests/cosmo23/brain-source-router.test.cjs \
  tests/cosmo23/legacy-research-memory-source.test.cjs \
  tests/cosmo23/research-memory-manifest.test.cjs
node --max-old-space-size=192 --expose-gc tests/shared/memory-source-graph-heap-probe.cjs
~~~

Expected: FAIL because graph sampler, heap probe, export executor, legacy streaming projection, and route/persistence adapters do not exist.

- [ ] **Step 3: Implement deterministic bounded sampling**

Create `shared/memory-source/graph.cjs`:

~~~js
'use strict';

const { normalizeId, parseBoundedInteger } = require('./contracts.cjs');

function nodeRank(node) {
  const accessed = Date.parse(node.accessed || node.created || '') || 0;
  return Number(node.activation || 0) * 3 +
    Number(node.weight || 0) * 2 +
    Math.log1p(Number(node.accessCount || 0)) +
    accessed / 1e15;
}

function resultTooLarge(subject) {
  return Object.assign(new Error(subject + ' exceeds the bounded graph budget'), {
    code: 'result_too_large', status: 413,
  });
}

function canonicalByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function invalidSource(field) {
  return Object.assign(new Error(field + ' is not a bounded graph scalar'), {
    code: 'source_invalid', status: 422, field,
  });
}

function assertPlainJsonRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw invalidSource(field);
  }
}

function boundedIdentifier(value, maxBytes, field) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > maxBytes) {
    throw invalidSource(field);
  }
  return value;
}

function boundedUtf8Text(value, maxBytes) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (Buffer.byteLength(text) <= maxBytes) return { value: text, truncated: false };
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  if (low && /[\uD800-\uDBFF]/.test(text[low - 1])) low -= 1;
  return { value: text.slice(0, low), truncated: true };
}

function boundedOptionalText(value, maxBytes) {
  if (value == null) return null;
  const bounded = boundedUtf8Text(value, maxBytes);
  if (bounded.truncated) throw invalidSource('date');
  return bounded.value;
}

function finiteNumberOrZero(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function finiteNonnegativeIntegerOrZero(value) {
  const number = Number(value ?? 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

// These are the complete public projection schemas. Unknown keys, embeddings,
// vectors, and nested metadata never enter the heap. IDs are validated rather
// than truncated. Concept text is UTF-8 truncated on a code-point boundary and
// advertises that fact with conceptTruncated.
function projectGraphNode(node) {
  assertPlainJsonRecord(node, 'node');
  const id = boundedIdentifier(normalizeId(node.id), 4096, 'node.id');
  const concept = boundedUtf8Text(node.concept ?? '', 64 * 1024);
  const row = {
    id,
    concept: concept.value,
    conceptTruncated: concept.truncated,
    tag: boundedIdentifier(String(node.tag ?? 'general'), 1024, 'node.tag'),
    weight: finiteNumberOrZero(node.weight),
    activation: finiteNumberOrZero(node.activation),
    cluster: node.cluster == null ? null
      : boundedIdentifier(normalizeId(node.cluster), 4096, 'node.cluster'),
    created: boundedOptionalText(node.created, 128),
    accessed: boundedOptionalText(node.accessed, 128),
    accessCount: finiteNonnegativeIntegerOrZero(node.accessCount),
  };
  if (canonicalByteLength(row) > 128 * 1024) throw resultTooLarge('projected graph node');
  return row;
}

function projectGraphEdge(edge, { sourceId, targetId }) {
  assertPlainJsonRecord(edge, 'edge');
  const row = {
    source: boundedIdentifier(sourceId, 4096, 'edge.source'),
    target: boundedIdentifier(targetId, 4096, 'edge.target'),
    weight: finiteNumberOrZero(edge.weight),
    type: boundedIdentifier(String(edge.type ?? 'associative'), 1024, 'edge.type'),
  };
  if (canonicalByteLength(row) > 32 * 1024) throw resultTooLarge('projected graph edge');
  return row;
}

// Keep an exact byte count without serializing/copying the whole map on each
// source row. Return false before adding a new key/count that crosses either cap.
function incrementClusterTotal(state, cluster) {
  const key = cluster == null ? 'unclustered' : String(cluster);
  const previous = state.totals[key] || 0;
  const next = previous + 1;
  const pairBytes = count => canonicalByteLength(key) + 1 + Buffer.byteLength(String(count));
  const nextBytes = state.bytes - (previous ? pairBytes(previous) : 0) +
    pairBytes(next) + (!previous && state.keys ? 1 : 0);
  if ((!previous && state.keys === 10000) || nextBytes > 1024 * 1024) return false;
  state.totals[key] = next;
  state.bytes = nextBytes;
  if (!previous) state.keys += 1;
  return true;
}

// Root is the worst retained item. Each accepted candidate costs O(log K);
// final sorting costs O(K log K), so a scan is O(N log K) and O(K) memory.
class BoundedTopK {
  constructor(limit, isBetter, { maxBytes, sizeOf }) {
    this.limit = limit;
    this.isBetter = isBetter;
    this.maxBytes = maxBytes;
    this.sizeOf = sizeOf;
    this.heap = [];
    this.retainedBytes = 0;
    this.maxRetainedBytes = 0;
    this.comparisons = 0;
    this.maxSize = 0;
  }
  worse(a, b) {
    this.comparisons += 1;
    return this.isBetter(b, a);
  }
  swap(a, b) {
    [this.heap[a], this.heap[b]] = [this.heap[b], this.heap[a]];
  }
  siftUp(index) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.worse(this.heap[index], this.heap[parent])) break;
      this.swap(index, parent);
      index = parent;
    }
  }
  siftDown(index) {
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let worst = index;
      if (left < this.heap.length && this.worse(this.heap[left], this.heap[worst])) worst = left;
      if (right < this.heap.length && this.worse(this.heap[right], this.heap[worst])) worst = right;
      if (worst === index) return;
      this.swap(index, worst);
      index = worst;
    }
  }
  popWorst() {
    const worst = this.heap[0];
    const tail = this.heap.pop();
    if (this.heap.length) {
      this.heap[0] = tail;
      this.siftDown(0);
    }
    return worst;
  }
  push(value) {
    if (this.limit === 0) return;
    const bytes = this.sizeOf(value);
    if (bytes > this.maxBytes) throw resultTooLarge('projected graph record');
    value = { ...value, __retainedBytes: bytes };
    this.heap.push(value);
    this.retainedBytes += bytes;
    this.siftUp(this.heap.length - 1);
    while (this.heap.length > this.limit || this.retainedBytes > this.maxBytes) {
      const removed = this.popWorst();
      this.retainedBytes -= removed.__retainedBytes;
    }
    this.maxSize = Math.max(this.maxSize, this.heap.length);
    this.maxRetainedBytes = Math.max(this.maxRetainedBytes, this.retainedBytes);
  }
  sorted() {
    return [...this.heap].sort((a, b) => {
      if (this.isBetter(a, b)) return -1;
      if (this.isBetter(b, a)) return 1;
      return 0;
    });
  }
}

async function sampleMemoryGraph(source, options = {}) {
  const { throwIfAborted } = require('./contracts.cjs');
  throwIfAborted(options.signal);
  if (options.full === true || options.full === '1' || options.full === 'true') {
    const error = new Error('full graph requires asynchronous export');
    error.code = 'result_too_large';
    error.status = 413;
    throw error;
  }
  const rawNodeLimit = Object.prototype.hasOwnProperty.call(options, 'nodeLimit')
    ? options.nodeLimit : options.limit;
  const nodeLimit = parseBoundedInteger(rawNodeLimit, {
    name: 'nodeLimit', defaultValue: 250, min: 1, max: 2000,
  });
  const edgeLimit = parseBoundedInteger(options.edgeLimit, {
    name: 'edgeLimit', defaultValue: 1000, min: 0, max: 8000,
  });
  const clusterId = options.clusterId === null || options.clusterId === undefined ? null : normalizeId(options.clusterId);
  const minWeight = Number(options.minWeight ?? 0);
  if (!Number.isFinite(minWeight)) {
    throw Object.assign(new Error('minWeight must be finite'), {
      code: 'invalid_request', status: 400, field: 'minWeight', value: options.minWeight,
    });
  }
  const selected = new BoundedTopK(nodeLimit, (a, b) =>
    a.rank > b.rank || (a.rank === b.rank &&
      normalizeId(a.node.id).localeCompare(normalizeId(b.node.id)) < 0), {
        maxBytes: 16 * 1024 * 1024,
        sizeOf: item => canonicalByteLength(item.node),
      });
  let clusterState = { totals: Object.create(null), bytes: 2, keys: 0 };
  let clusterTotalsOmitted = false;
  for await (const node of source.iterateNodes({ signal: options.signal })) {
    throwIfAborted(options.signal);
    assertPlainJsonRecord(node, 'node');
    const projectedCluster = node.cluster == null ? null
      : boundedIdentifier(normalizeId(node.cluster), 4096, 'node.cluster');
    if (!clusterTotalsOmitted) {
      if (!incrementClusterTotal(clusterState, projectedCluster)) {
        clusterState = null;
        clusterTotalsOmitted = true;
      }
    }
    if (clusterId !== null && normalizeId(node.cluster) !== clusterId) continue;
    const projected = projectGraphNode(node); // exact scalar schema; no embedding/metadata
    selected.push({ node: projected, rank: nodeRank(projected) });
  }
  const nodes = selected.sorted().map(item => item.node);
  const ids = new Set(nodes.map(node => normalizeId(node.id)));
  const edges = new BoundedTopK(edgeLimit, (a, b) =>
    Number(a.weight || 0) > Number(b.weight || 0) ||
    (Number(a.weight || 0) === Number(b.weight || 0) &&
      (a.source + '->' + a.target).localeCompare(b.source + '->' + b.target) < 0), {
        maxBytes: 8 * 1024 * 1024,
        sizeOf: canonicalByteLength,
      });
  for await (const edge of source.iterateEdges({ signal: options.signal })) {
    throwIfAborted(options.signal);
    const sourceId = normalizeId(edge.source ?? edge.from);
    const targetId = normalizeId(edge.target ?? edge.to);
    if (!ids.has(sourceId) || !ids.has(targetId) || Number(edge.weight || 0) < minWeight) continue;
    edges.push(projectGraphEdge(edge, { sourceId, targetId }));
  }
  const edgeRows = edges.sorted().map(({ __retainedBytes, ...edge }) => edge);
  const summary = await source.summarize({ signal: options.signal });
  const response = {
    success: true,
    nodes,
    edges: edgeRows,
    clusters: clusterState?.totals || null,
    meta: {
      revision: source.revision,
      authoritativeNodeCount: summary.nodes,
      authoritativeEdgeCount: summary.edges,
      returnedNodeCount: nodes.length,
      returnedEdgeCount: edgeRows.length,
      // Existing dashboard compatibility aliases are values from the same
      // authoritative source and bounded selection, never separately loaded.
      nodeCount: summary.nodes,
      edgeCount: summary.edges,
      displayedNodeCount: nodes.length,
      displayedEdgeCount: edgeRows.length,
      clusterCount: summary.clusters,
      limited: nodes.length < summary.nodes || edgeRows.length < summary.edges,
      maxNodeHeapSize: selected.maxSize,
      maxEdgeHeapSize: edges.maxSize,
      maxNodeRetainedBytes: selected.maxRetainedBytes,
      maxEdgeRetainedBytes: edges.maxRetainedBytes,
      clusterTotalsOmitted,
      heapComparisons: selected.comparisons + edges.comparisons,
    },
    evidence: source.getEvidence({
      completeCoverage: true,
      filters: { clusterId, minWeight },
      limits: { nodeLimit, edgeLimit },
      authoritativeTotals: { nodes: summary.nodes, edges: summary.edges },
      returnedTotals: { nodes: nodes.length, edges: edgeRows.length },
      matchOutcome: nodes.length ? 'matches' : undefined,
    }),
  };
  if (canonicalByteLength(response) > 32 * 1024 * 1024) {
    throw resultTooLarge('graph response');
  }
  return response;
}

module.exports = {
  BoundedTopK, parseBoundedInteger, sampleMemoryGraph, nodeRank,
  projectGraphNode, projectGraphEdge,
};
~~~

Export it from `shared/memory-source/index.cjs`.

- [ ] **Step 4: Implement resident status/graph service and narrow dashboard registration**

Create `engine/src/dashboard/brain-source-api.js`:

~~~js
'use strict';

const express = require('express');
const {
  sampleMemoryGraph, enrichEvidenceIdentity, withEphemeralMemorySource,
  throwIfAborted,
} = require('../../../shared/memory-source');

function requestAbortController(req) {
  const controller = new AbortController();
  req.once('close', () => controller.abort(Object.assign(
    new Error('request closed'), { name: 'AbortError', code: 'cancelled' },
  )));
  return controller;
}

function pickGraphParameters(query = {}) {
  return {
    nodeLimit: query.nodeLimit ?? query.limit,
    edgeLimit: query.edgeLimit,
    clusterId: query.clusterId,
    minWeight: query.minWeight,
    full: query.full,
  };
}

function createBrainSourceService({
  brainDir, home23Root, requesterAgent, resolveTargetContext,
  withEphemeralSource = withEphemeralMemorySource,
}) {
  async function withSource(sourcePin, { signal, identity }, callback) {
    if (sourcePin) {
      if (!identity?.operationId) {
        throw Object.assign(new Error('pinned operation identity required'), {
          code: 'invalid_request',
        });
      }
      return callback(sourcePin, { identity });
    }
    if (identity !== undefined) {
      throw Object.assign(new Error('compatibility identity is server-derived'), {
        code: 'invalid_request',
      });
    }
    const resolved = await resolveTargetContext({});
    const target = resolved.target;
    const canonicalBrainDir = await require('node:fs').promises.realpath(brainDir);
    if (target.canonicalRoot !== canonicalBrainDir) {
      throw Object.assign(new Error('local catalog target/source mismatch'), {
        code: 'source_changed', retryable: true,
      });
    }
    const baseIdentity = {
      requesterAgent,
      targetAgent: target.ownerAgent,
      brainId: target.id,
      canonicalRoot: target.canonicalRoot,
      catalogRevision: resolved.catalogRevision,
      kind: target.kind,
      sourceType: target.sourceType,
      accessMode: resolved.accessMode,
    };
    return withEphemeralSource({
      brainDir, home23Root, requesterAgent, identity: baseIdentity,
      signal, prefix: 'dashboard-source',
    }, callback);
  }
  return {
    async status({ sourcePin = null, signal, identity } = {}) {
      throwIfAborted(signal);
      return withSource(sourcePin, { signal, identity }, async (source, context) => {
        const effectiveIdentity = context.identity;
        const summary = await source.summarize({ signal });
        const evidence = enrichEvidenceIdentity(source.getEvidence({
          completeCoverage: true,
          authoritativeTotals: { nodes: summary.nodes, edges: summary.edges },
        }), effectiveIdentity);
        return {
          ok: evidence.sourceHealth !== 'unavailable',
          summary,
          evidence,
        };
      });
    },
    async graph(options = {}) {
      const { sourcePin = null, signal, identity, ...graphOptions } = options;
      throwIfAborted(signal);
      return withSource(sourcePin, { signal, identity }, async (source, context) => {
        const result = await sampleMemoryGraph(source, { ...graphOptions, signal });
        result.evidence = enrichEvidenceIdentity(result.evidence, context.identity);
        return result;
      });
    },
  };
}

function createBrainSourceRouter(options) {
  const router = express.Router();
  const service = createBrainSourceService(options);
  router.get('/status', async (req, res) => {
    const controller = requestAbortController(req);
    try {
      const result = await service.status({
        signal: controller.signal,
      });
      res.status(result.ok ? 200 : 503).json(result);
    } catch (error) {
      const cancelled = controller.signal.aborted || error.name === 'AbortError';
      res.status(cancelled ? 499 : (error.status || 500)).json({
        ok: false,
        error: { code: cancelled ? 'cancelled' : (error.code || 'source_unavailable'), message: error.message },
      });
    }
  });
  router.get('/graph', async (req, res) => {
    const controller = requestAbortController(req);
    try {
      res.json(await service.graph({
        ...pickGraphParameters(req.query),
        signal: controller.signal,
      }));
    } catch (error) {
      const cancelled = controller.signal.aborted || error.name === 'AbortError';
      res.status(cancelled ? 499 : (error.status || 500)).json({
        ok: false,
        error: { code: cancelled ? 'cancelled' : (error.code || 'source_unavailable'), message: error.message },
      });
    }
  });
  return router;
}

module.exports = { createBrainSourceService, createBrainSourceRouter };
~~~

Create `engine/src/dashboard/brain-operations/source-executors.js`:

~~~js
'use strict';

const { isAbortError, throwIfAborted } = require('../../../../shared/memory-source');

function canonicalIdentity(context) {
  if (!context.sourcePin || context.sourcePin.descriptor?.canonicalRoot !== context.target?.canonicalRoot) {
    throw Object.assign(new Error('operation source pin does not match canonical target'), {
      code: 'source_changed',
    });
  }
  return {
    requesterAgent: context.requesterAgent,
    targetAgent: context.target.ownerAgent || null,
    brainId: context.target.brainId,
    canonicalRoot: context.target.canonicalRoot,
    catalogRevision: context.target.catalogRevision,
    kind: context.target.kind,
    sourceType: context.sourcePin.manifest?.sourceMode === 'legacy_projection'
      ? 'legacy-projection' : 'memory-manifest',
    accessMode: context.target.accessMode,
    operationId: context.operationId,
  };
}

async function execute(context, fn) {
  try {
    throwIfAborted(context.signal);
    return await fn(canonicalIdentity(context));
  } catch (error) {
    if (isAbortError(error, context.signal)) {
      return {
        state: 'cancelled', result: null,
        error: { code: 'cancelled', message: error.message, retryable: true },
        sourceEvidence: context.sourcePin?.getEvidence() || null,
      };
    }
    return {
      state: 'failed', result: null,
      error: { code: error.code || 'source_unavailable', message: error.message, retryable: error.retryable !== false },
      sourceEvidence: context.sourcePin?.getEvidence() || null,
    };
  }
}

function createSourceOperationExecutors({
  searchService, brainSourceService, graphExportExecutor,
}) {
  const complete = (result, sourceEvidence) => ({
    state: 'complete', result, error: null, sourceEvidence,
  });
  return new Map([
    ['search', context => execute(context, async identity => {
      const { query, topK, minSimilarity, noiseFloor, tag } = context.parameters;
      const result = await searchService.search({
        query, topK, minSimilarity, noiseFloor, tag,
        sourcePin: context.sourcePin, signal: context.signal, identity,
      });
      return complete(result, result.evidence);
    })],
    ['status', context => execute(context, async identity => {
      const result = await brainSourceService.status({
        sourcePin: context.sourcePin, signal: context.signal, identity,
      });
      if (!result.ok || result.evidence?.sourceHealth === 'unavailable') {
        return {
          state: 'failed', result: null,
          error: { code: 'source_unavailable', message: 'Authoritative brain source is unavailable', retryable: true },
          sourceEvidence: result.evidence,
        };
      }
      return complete(result, result.evidence);
    })],
    ['graph', context => execute(context, async identity => {
      const { nodeLimit, limit, edgeLimit, clusterId, minWeight, full } = context.parameters;
      const result = await brainSourceService.graph({
        nodeLimit: nodeLimit ?? limit, edgeLimit, clusterId, minWeight, full,
        sourcePin: context.sourcePin, signal: context.signal, identity,
      });
      return complete(result, result.evidence);
    })],
    ['graph_export', context => execute(context, async identity => {
      const exported = await graphExportExecutor({ ...context, identity });
      return {
        state: 'complete',
        result: null,
        resultArtifact: exported.resultArtifact,
        error: null,
        sourceEvidence: exported.evidence,
      };
    })],
  ]);
}

module.exports = { canonicalIdentity, createSourceOperationExecutors };
~~~

Create `engine/src/dashboard/brain-operations/graph-export-executor.js`. `createGraphExportExecutor({home23Root, operationStore, clock})` validates that the worker-derived `scratchDir` realpaths beneath:

~~~text
<home23Root>/instances/<requesterAgent>/runtime/brain-operations/operations/<operationId>/scratch
~~~

It rejects `outputPath`, `resultPath`, `scratchDir`, requester, operation, root, identity, target, `resultArtifact`, and any format other than omitted/`jsonl` in `parameters`; requires a source pin matching canonical target root/revision; and never accepts a destination from parameters. It streams tagged records from `sourcePin.iterateNodes({signal})` and `sourcePin.iterateEdges({signal})` directly as **uncompressed** newline-delimited JSON into `scratch/results/graph-<operationId>.jsonl.tmp`, awaiting every `drain`. The record forms are `{type:'node',record}` and `{type:'edge',record}`. The executor receives the operation's shared scratch quota; before each write it claims the exact encoded bytes, so the aggregate 8-GiB default, the 2-GiB graph-artifact ceiling, and any lower injected test ceiling cover projection, overlay, temp, and final graph bytes together. It checks `throwIfAborted(signal)` before open, before every claim/write, and after each drain; abort or quota failure destroys the stream, removes the temp file, releases only removed bytes, and never exposes a partial artifact. Success reconciles the quota, ends the stream, fsyncs the file, atomically renames it, fsyncs the result directory, and returns `{result:null,evidence,resultArtifact}`. `evidence` extends canonical source evidence with `graphExport:{nodeCount,edgeCount,sourceRevision}`; this is the only location for export counts/revision. `resultArtifact` is this exact trusted internal descriptor and has no other keys:

~~~js
{
  scratchPath: finalScratchPath,
  mediaType: 'application/x-ndjson',
  contentEncoding: 'identity',
  bytes,
  sha256,
}
~~~

The operation store consumes only the trusted top-level field from its in-process registered executor, requires `result === null`, rejects any extra artifact key, verifies the artifact realpath/size/hash under that operation's scratch directory, adopts it into private result storage, generates its protected requester-bound result handle, and applies the foundation contract: large result/scratch expires after seven days; terminal metadata expires after 30 days; nonterminal operations are never collected. Public status/result metadata strips `scratchPath` and exposes only `{mediaType,contentEncoding,bytes,sha256}` plus the opaque handle and source evidence. An explicit foundation export accepts only `jsonl` for graph artifacts and copies it byte-for-byte to a separately authorized requester-owned `.jsonl` destination; graph export itself never writes outside operation scratch.

Register all four entries through the prerequisite `workerAdapter.registerLocalExecutor()` during dashboard startup. The service methods accept the already pinned source from operation context and do not release it; the prerequisite worker releases its process pin exactly once at durable terminal cleanup.

Register it once:

~~~js
this.app.use('/home23/api/brain', createBrainSourceRouter({
  brainDir: this.logsDir,
  home23Root: this.getHome23Root(),
  requesterAgent: this.getHome23AgentName(),
  resolveTargetContext: selector => this.brainOperationCoordinator.resolveTargetContext(selector),
}));
~~~

Delete the old inline `/home23/api/brain/graph` handler. Make `getFastMemoryGraphSummary()` call `service.status()` and map its authoritative summary.
Change `engine/src/dashboard/home23-brain-map.js` to request
`/home23/api/brain/graph?nodeLimit=2000&edgeLimit=8000`; the interactive map has
no synchronous full-graph escape hatch.

- [ ] **Step 5: Implement the COSMO route adapter and portable hydration wrappers**

Create `shared/memory-source/legacy-snapshot.cjs` with:

~~~js
async function projectLegacyResearchSnapshot({
  canonicalRoot,
  stateFile,
  operationRoot,
  operationId,
  requesterAgent,
  scratchQuota,
  signal,
  maxDecompressedBytes = 2 * 1024 * 1024 * 1024,
  maxRecordBytes = 16 * 1024 * 1024,
  maxAttempts = 3,
}) {
  // Returns { descriptor, projectionRoot, mutationBoundaries, evidence }.
}
~~~

`operationRoot` is derived from the authenticated requester/operation by the coordinator; it is not accepted from an agent request. Realpath durable coordinator work beneath `<home23Root>/instances/<requester>/runtime/brain-operations/operations/<operationId>` and create only `source-projections/<generation>` there. Standalone compatibility contexts may retain their separate flat roots but are not BrainOperationStore records. The shared lock remains under `<home23Root>/runtime/brain-source-locks/<canonical-root-hash>` and the process pin remains under `<operationRoot>/pins/<processIdentity>/<canonical-root-hash>.json`. Never create a projection, pin, lock, cache, or temp file under the target research run.

For each bounded attempt:

1. `stat(stateFile, {bigint:true})` and capture `dev`, `ino`, `size`, `mtimeNs`, and `ctimeNs`.
2. Open one `createReadStream`; if gzip, pipe through `createGunzip`; then pipe through a counting `Transform` that aborts with typed `result_too_large` once **decompressed** bytes exceed `maxDecompressedBytes`. Hash the decompressed bytes with SHA-256 while they pass.
3. Feed chunks to a built-in incremental JSON state machine that locates only the top-level `memory.nodes` and `memory.edges` arrays. It tracks object/array depth, quoted strings, escapes, and Unicode escapes; emits one complete array element at a time; caps the per-element accumulator at `maxRecordBytes`; and `JSON.parse`s only that one record. Keys or braces inside strings and nested arrays cannot change parser state.
4. Stream emitted records, with write-backpressure, into requester-owned temporary node/edge gzip JSONL files while computing counts/summary. Claim every compressed output byte from the shared operation scratch quota before write. Never call `readFile(stateFile)`, `gunzip(Buffer)`, `JSON.parse` on the snapshot, or retain either array.
5. Re-stat the source and compare all captured fields. On mismatch, destroy streams, remove that attempt's projection, and retry from a fresh stat. After `maxAttempts`, return typed retryable `source_changed`.
6. Derive numeric revision as `Number.parseInt(sha256Digest.slice(0, 13), 16)` (at most 52 bits and therefore a safe integer), set generation to `legacy-` plus the first 20 digest hex characters, rename sidecars to generation-qualified basenames, create an empty committed delta, then atomically/fsync write a format-v1 projection manifest with `sourceMode:'legacy_projection'`. Mark evidence degraded and freshness unknown.

Cancellation is checked before open, on every decompressed chunk, before every emitted record/write, after each drain, before stable-stat comparison, and before manifest rename. Every catch first rethrows abort; cleanup removes requester temp/projection files only. A decompression or aggregate scratch cap failure is `result_too_large`, not `source_unavailable`, and leaves the target snapshot byte-identical.

Export `projectLegacyResearchSnapshot` from `shared/memory-source/index.cjs`; consumers never import its internal file directly.

Extend `pinOperationSource()` without changing the provider's public interface. Resolution order is: target numeric-v1 manifest; legacy resident sidecars through Task 2's streaming immutable projector; then a research `state.json.gz`/`state.json` through the projector above. It never returns a direct format-v0 source. For all three authorities, `pin()` still returns exactly `{descriptor,digest}` and an identical operation-ID retry reads the already-durable coordinator record instead of reopening/projecting current truth. The public descriptor keeps the prerequisite provider shape and the **target** `canonicalRoot`, numeric `baseRevision`/`cutoffRevision`, generated base filenames, and empty generated delta. The private `<operationRoot>/coordinator-source-pin.json`—never the descriptor—stores `projectionRoot`, original source fingerprint, and protected projection files; its projection root must realpath beneath that requester's operation root. It is atomically published under the external lock only after stable-stat verification, so a crash/lost response leaves either no mapping or one reusable immutable mapping. `openPinnedSource()` finds that trusted coordinator record by operation owner plus canonical root/generation/revision/digest, validates it against the descriptor and requester operation directory, creates a separate process pin under `<operationRoot>/pins/<processIdentity>/`, and opens the projection as the physical root while retaining target canonical root in descriptor/evidence. This preserves the provider contract; no projection path crosses a public or protected request. `isCurrent()` re-stats the original source fingerprint. Process-pin and terminal release rules remain identical.

Create `cosmo23/lib/memory-source-adapter.js` as path/domain glue only. `openCosmoMemorySource(brainDir, {operationRoot,operationId,requesterAgent,lockRoot,signal,identity})` prefers an existing numeric-v1 manifest, then calls `projectLegacyResidentSidecars()` for resident sidecars, then calls `projectLegacyResearchSnapshot()` for `state.json.gz` or `state.json`. It passes a sorted named `mutationBoundaries` object array containing every required kind—`brain`, `run`, `pgs`, `session`, `cache`, `export`, and `agency`—with canonical target paths. Requester pins/projection/results and the global lock root are not target boundaries. It never reads or parses a complete state snapshot itself.

Create `cosmo23/server/lib/brain-source-router.js` as an Express router factory receiving `resolveBrainBySelector` and `getRunsOptions`. It resolves `brain.path`, derives requester operation scratch and canonical identity from authenticated server context, opens that directory with `openCosmoMemorySource`, and uses the same status/sample functions with the request signal. It never calls `getQueryEngine()` or `loadBrainState()`, never accepts scratch/identity/root from query parameters, and maps abort to `cancelled` rather than unavailable.

Replace the inline COSMO graph route with:

~~~js
app.use(createBrainSourceRouter({
  resolveBrainBySelector,
  getRunsOptions: async () => ({
    localRunsPath: LOCAL_RUNS_PATH,
    referenceRunsPaths: getReferenceRunsPaths(),
    activeRunPath: activeContext?.runPath || null,
  }),
}));
~~~

Add `persistResearchMemoryRevision(runDir, memory, options)` to `cosmo23/lib/memory-sidecar.js`. Before its first await it synchronously deep-clones/freeze-captures `{nodes,edges,summary}` from the research memory; it delegates that immutable view—not live `memory`—to `rewriteMemoryBase()` and returns the committed manifest with numeric revision. In `cosmo23/engine/src/core/orchestrator.js::saveState()`, capture once, commit the memory manifest/base/delta **before** compressing state, then compress a copy from that same captured generation whose `memory.nodes`/`memory.edges` are empty while retaining captured scalar memory metadata. In `cosmo23/engine/src/merge/merge-engine.js::saveMergedRun()`, do the same before `saveCompressedState()`. Only empty the compressed copy after the manifest commit returns. If manifest persistence fails, preserve and save the original full captured state (and surface degraded diagnostics) so research memory is never lost. Add a barrier test that mutates the live research graph while the writer waits and proves manifest sidecars, manifest summary, and compressed empty-shell metadata all describe the pre-mutation captured generation; the later mutation remains dirty for the next save. Successful new and merged research runs therefore emit manifests directly and bypass legacy projection.

Update `hydrateStateMemory(brainDir, state, options)` to call `openCosmoMemorySource` with `options.signal` and requester operation context, materialize the pinned logical nodes/edges only for this compatibility API, include evidence/mutation boundaries, and close the pin in `finally`. Update `evobrew/lib/memory-sidecar.js` to open an existing manifest/sidecar or use `projectLegacyResearchSnapshot()` from the source file into caller-owned operation scratch; it no longer passes a materialized graph into the shared reader. Preserve current public function names and return fields.

- [ ] **Step 6: Run all graph/hydration tests and commit**

Run:

~~~bash
node --test --test-concurrency=1 \
  tests/shared/memory-source-graph.test.js \
  tests/engine/dashboard/brain-source-api.test.js \
  tests/engine/dashboard/home23-brain-map.test.js \
  tests/engine/dashboard/brain-source-executors.test.js \
  tests/engine/dashboard/brain-graph-export.test.js \
  tests/engine/dashboard/brain-source-mutation-boundary.test.js \
  tests/engine/dashboard/dashboard-state-summary.test.js \
  tests/cosmo23/brain-source-router.test.cjs \
  tests/cosmo23/legacy-research-memory-source.test.cjs \
  tests/cosmo23/research-memory-manifest.test.cjs \
  tests/cosmo23/memory-sidecar.test.cjs \
  tests/evobrew/memory-sidecar.test.cjs
node --max-old-space-size=192 --expose-gc tests/shared/memory-source-graph-heap-probe.cjs
git diff --check -- shared/memory-source engine/src/dashboard cosmo23/server cosmo23/lib evobrew/lib tests/shared tests/engine/dashboard tests/cosmo23 tests/evobrew
~~~

Expected: all tests pass; the large fixture stays within heap caps, every abort remains cancelled, export writes only requester result storage, legacy projection never materializes a snapshot, and all target mutation boundaries are unchanged.

Commit:

~~~bash
git diff --cached --quiet
git add -- shared/memory-source/graph.cjs shared/memory-source/legacy-snapshot.cjs shared/memory-source/pins.cjs shared/memory-source/index.cjs engine/src/dashboard/brain-source-api.js engine/src/dashboard/brain-operations/source-executors.js engine/src/dashboard/brain-operations/graph-export-executor.js engine/src/dashboard/server.js engine/src/dashboard/home23-brain-map.js cosmo23/server/lib/brain-source-router.js cosmo23/server/index.js cosmo23/lib/memory-source-adapter.js cosmo23/lib/memory-sidecar.js cosmo23/engine/src/core/orchestrator.js cosmo23/engine/src/merge/merge-engine.js evobrew/lib/memory-sidecar.js tests/shared/memory-source-graph.test.js tests/shared/memory-source-graph-heap-probe.cjs tests/engine/dashboard/brain-source-api.test.js tests/engine/dashboard/home23-brain-map.test.js tests/engine/dashboard/brain-source-executors.test.js tests/engine/dashboard/brain-graph-export.test.js tests/engine/dashboard/brain-source-mutation-boundary.test.js tests/engine/dashboard/dashboard-state-summary.test.js tests/cosmo23/brain-source-router.test.cjs tests/cosmo23/legacy-research-memory-source.test.cjs tests/cosmo23/research-memory-manifest.test.cjs tests/cosmo23/memory-sidecar.test.cjs tests/evobrew/memory-sidecar.test.cjs
git diff --cached --check
git diff --cached
git commit -m "fix(memory): bound graph and stream exports"
git status --short
~~~

### Task 7: MCP Base-Plus-Delta Consistency

**Files:**
- Create: `shared/memory-source/mcp-tools.cjs`
- Modify: `shared/memory-source/index.cjs`
- Modify: `engine/src/agents/mcp-bridge.js`
- Modify: `engine/src/agents/agent-executor.js`
- Modify: `engine/src/index.js`
- Modify: `engine/mcp/http-server.js`
- Modify: `engine/mcp/stdio-server.js`
- Modify: `engine/mcp/dashboard-graph.html`
- Modify: `cosmo23/engine/src/agents/mcp-bridge.js`
- Modify: `cosmo23/engine/src/agents/agent-executor.js`
- Modify: `cosmo23/engine/src/index.js`
- Modify: `cosmo23/engine/src/worker/orchestrator-worker.js`
- Modify: `cosmo23/engine/mcp/http-server.js`
- Modify: `cosmo23/engine/mcp/stdio-server.js`
- Modify: `cosmo23/engine/mcp/dashboard-graph.html`
- Test: `tests/engine/agents/mcp-bridge-memory.test.js`
- Test: `tests/engine/agents/agent-executor-memory-context.test.js`
- Test: `tests/engine/mcp/memory-tools.test.js`
- Test: `tests/cosmo23/mcp-memory-tools.test.cjs`
- Test: `tests/cosmo23/agent-executor-memory-context.test.cjs`
- Modify: `engine/tests/unit/agent-executor-review.test.js`
- Modify: `cosmo23/engine/tests/unit/agent-executor-review.test.js`
- Modify: `cosmo23/engine/tests/unit/agent-executor-guided.test.js`

**Interfaces:**
- Consumes: Task 2 keyword/source summary and installed local-source context, Task 6 bounded graph sampler, Plan A canonical catalog through an injected resident/owned-run resolver, and trusted process configuration for `home23Root` plus `requesterAgent`.
- Produces: `createMemoryTools({brainDir,home23Root,requesterAgent,readScalarState,logger})` with `queryMemory()`, `getMemoryStatistics()`, `getMemoryGraph()`, and `checkReadiness()`.

- [ ] **Step 1: Write failing parity and unavailable-source tests**

Use one manifest fixture with an empty inline state shell, one base node, one delta canary, and one tombstone. Assert all three adapters return the delta canary, exclude the tombstone, and expose identical revisions/totals.

Also assert `get_memory_statistics` preserves the established fields
`totalNodes`, `totalEdges`, numeric `clusters`, `nodesByTag`,
`averageActivation`, `averageWeight`, `mostAccessedNodes`, and
`highestActivationNodes` without materializing the graph. When tag/cluster
breakdown limits are crossed, the maps are `null` and
`breakdownsOmitted:true`; scalar totals/averages/top-five projections remain
honest. Test both dashboard-graph HTML files request a bounded positive
`limit:2000, edgeLimit:8000`, never legacy `limit:0`.

Create both AgentExecutor construction tests around the production constructors,
not only direct MCPBridge fixtures. Pass a trusted `brainSourceContext` through
`phase2bSubsystems`, assert AgentExecutor forwards its exact
`home23Root/requesterAgent/brainDir/resolveTargetContext` into MCPBridge, and
invoke one memory query to prove the resolver selects that exact local source.
Missing/malformed context must fail production construction with
`mcp_source_context_required` before an agent starts. Cover the resident
`engine/src/index.js` path and all COSMO context/worker construction paths; the
active-run fixture resolves `accessMode:'owned-run'`. Update existing direct
AgentExecutor unit fixtures with an explicit trusted stub context so no test
passes accidentally through an implicit default.

~~~js
test('MCP never translates source read failure into zero nodes', async () => {
  const tools = createMemoryTools({
    brainDir: '/missing',
    home23Root: fixture.home23Root,
    requesterAgent: 'ada',
    resolveTargetContext: fixture.resolveTargetContext,
    readScalarState: async () => ({ cycleCount: 7, memory: { nodes: [], edges: [] } }),
  });
  const result = await tools.queryMemory({ query: 'anything', limit: 5 });
  assert.equal(result.ok, false);
  assert.equal(result.evidence.sourceHealth, 'unavailable');
  assert.equal(result.evidence.matchOutcome, 'unknown');
  assert.equal(result.totalNodes, null);
});

test('MCP graph applies both node and edge caps', async () => {
  const fixture = await createLargeFixture();
  const tools = createMemoryTools({
    brainDir: fixture.brainDir, home23Root: fixture.home23Root, requesterAgent: 'ada',
    resolveTargetContext: fixture.resolveTargetContext,
  });
  const result = await tools.getMemoryGraph({ nodeLimit: 20, edgeLimit: 40 });
  assert.equal(result.nodes.length <= 20, true);
  assert.equal(result.edges.length <= 40, true);
  assert.equal(result.evidence.authoritativeTotals.nodes, 10000);
});

test('MCP cancellation remains AbortError and stops source consumption', async () => {
  const controller = new AbortController();
  const fixture = createAbortingMemoryToolsFixture(controller);
  await assert.rejects(
    fixture.tools.queryMemory({ query: 'canary', signal: controller.signal }),
    error => error.name === 'AbortError',
  );
  assert.equal(fixture.recordsConsumed, fixture.recordsAtAbort);
});

test('production MCP bridges forward the operation signal for query and statistics', async () => {
  for (const createBridge of [createEngineBridgeFixture, createCosmoBridgeFixture]) {
    for (const method of ['query_memory', 'get_memory_statistics']) {
      const controller = new AbortController();
      const fixture = createBridge({ abortDuring: method, signal: controller.signal });
      await assert.rejects(
        method === 'query_memory'
          ? fixture.bridge.query_memory('canary', 5, { signal: controller.signal })
          : fixture.bridge.get_memory_statistics({ signal: controller.signal }),
        error => error === controller.signal.reason || error.name === 'AbortError',
      );
      assert.equal(fixture.signalSeen, controller.signal);
      assert.equal(fixture.recordsConsumed, fixture.recordsAtAbort);
    }
  }
});

test('MCP projects legacy sidecars only in a trusted ephemeral operation', async () => {
  const fixture = await createLargeLegacyResidentFixture();
  const tools = createMemoryTools({
    brainDir: fixture.brainDir,
    home23Root: fixture.home23Root,
    requesterAgent: 'ada',
    resolveTargetContext: fixture.resolveTargetContext,
    withEphemeralSource: fixture.observeAndDelegateEphemeralSource,
  });
  const before = await hashCompleteTargetTree(fixture.brainDir);
  const result = await tools.getMemoryStatistics();
  assert.equal(result.ok, true);
  assert.equal(result.totalNodes, fixture.nodeCount);
  assert.equal(fixture.observedProjectionManifest.formatVersion, 1);
  assert.equal(Number.isSafeInteger(fixture.observedProjectionManifest.currentRevision), true);
  assert.match(fixture.observedProcessPin,
    /brain-operations\/mcp-[^/]+\/pins\/[^/]+\/[^/]+\.json$/);
  assert.equal(fixture.observedOperationRoot.startsWith(fixture.brainDir), false);
  assert.equal(fixture.observedLockRoot.startsWith(fixture.brainDir), false);
  assert.deepEqual(await hashCompleteTargetTree(fixture.brainDir), before);
  assert.equal(await pathExists(fixture.observedOperationRoot), false);
});

test('MCP readiness fails closed when trusted ephemeral context cannot be established', async () => {
  const tools = createMemoryTools({
    brainDir: legacyFixture.brainDir,
    home23Root: legacyFixture.home23Root,
    requesterAgent: 'ada',
    resolveTargetContext: legacyFixture.resolveTargetContext,
    withEphemeralSource: async () => { throw new Error('runtime read only'); },
  });
  const readiness = await tools.checkReadiness();
  assert.equal(readiness.ok, false);
  assert.equal(readiness.evidence.sourceHealth, 'unavailable');
  assert.equal(await pathExists(legacyFixture.targetLocalLock), false);
});
~~~

Extend the Task 6 mutation-boundary table with `queryMemory`, `getMemoryStatistics`, and `getMemoryGraph` through internal, HTTP, and stdio adapters. Hash the canonical target inventory before/after and assert no base/delta/ANN/metadata/research boundary changes. During every read, instrument one trusted ephemeral root at `<home23Root>/instances/<requesterAgent>/runtime/brain-operations/mcp-<uuid>`, the external global lock, an immutable numeric-v1 legacy projection when needed, and a process pin at `pins/<processIdentity>/<root-hash>.json`. In `finally`, assert the source closes and the entire ephemeral root disappears. No projection, pin, lock, temp, or cache may appear under the target.

- [ ] **Step 2: Run MCP memory tests and verify red**

Run:

~~~bash
node --test --test-concurrency=1 tests/engine/agents/mcp-bridge-memory.test.js tests/engine/agents/agent-executor-memory-context.test.js tests/engine/mcp/memory-tools.test.js tests/cosmo23/mcp-memory-tools.test.cjs tests/cosmo23/agent-executor-memory-context.test.cjs
~~~

Expected: FAIL because `createMemoryTools` does not exist, current bridges hydrate only fixed base files, and production AgentExecutor construction has no trusted source-context dependency.

- [ ] **Step 3: Implement shared MCP memory tools**

Create `shared/memory-source/mcp-tools.cjs`:

~~~js
'use strict';

const path = require('node:path');
const { withEphemeralMemorySource } = require('./operation-context.cjs');
const { sampleMemoryGraph } = require('./graph.cjs');
const { createEvidence, parseBoundedInteger, rethrowAbort, throwIfAborted } = require('./contracts.cjs');

function createMemoryTools({
  brainDir, home23Root, requesterAgent, readScalarState = async () => ({}),
  resolveTargetContext, logger = console,
  withEphemeralSource = withEphemeralMemorySource,
}) {
  if (!path.isAbsolute(home23Root || '') ||
      !/^[a-z0-9][a-z0-9_-]*$/i.test(requesterAgent || '') ||
      typeof resolveTargetContext !== 'function') {
    throw Object.assign(new Error('trusted MCP source context required'), {
      code: 'mcp_source_context_required',
    });
  }
  async function withSource(fn, { signal, identity } = {}) {
    throwIfAborted(signal);
    if (identity !== undefined) {
      throw Object.assign(new Error('MCP identity is server-derived'), {
        code: 'invalid_request',
      });
    }
    let lastEvidence = null;
    try {
      const resolved = await resolveTargetContext({});
      const target = resolved.target;
      const canonicalBrainDir = await require('node:fs').promises.realpath(brainDir);
      if (target.canonicalRoot !== canonicalBrainDir) {
        throw Object.assign(new Error('MCP catalog target/source mismatch'), {
          code: 'source_changed', retryable: true,
        });
      }
      const baseIdentity = {
        requesterAgent,
        targetAgent: target.ownerAgent,
        brainId: target.id,
        canonicalRoot: target.canonicalRoot,
        catalogRevision: resolved.catalogRevision,
        kind: target.kind,
        sourceType: target.sourceType,
        accessMode: resolved.accessMode,
      };
      return await withEphemeralSource({
        brainDir, home23Root, requesterAgent, identity: baseIdentity, signal, prefix: 'mcp',
      }, async source => {
        lastEvidence = source.getEvidence();
        if (lastEvidence.sourceHealth === 'unavailable') {
          return {
            ok: false, totalNodes: null,
            evidence: source.getEvidence({ matchOutcome: 'unknown' }),
            error: { code: 'source_unavailable', retryable: true },
          };
        }
        try { return await fn(source); }
        catch (error) {
          error.sourceEvidence = source.getEvidence();
          throw error;
        }
      });
    } catch (error) {
      rethrowAbort(error, signal);
      logger.warn?.('[MCP memory] source read failed', { error: error.message });
      const code = error.code || 'source_unavailable';
      return {
        ok: false,
        totalNodes: null,
        evidence: error.sourceEvidence || lastEvidence ||
          createEvidence({ sourceHealth: 'unavailable', matchOutcome: 'unknown' }),
        error: {
          code, message: error.message, status: error.status || null,
          retryable: error.retryable === true,
        },
      };
    }
  }

  return {
    async checkReadiness({ signal, identity } = {}) {
      return withSource(async source => {
        const summary = await source.summarize({ signal });
        return {
          ok: true,
          sourceHealth: source.getEvidence().sourceHealth,
          revision: source.revision,
          totals: { nodes: summary.nodes, edges: summary.edges },
          evidence: source.getEvidence({
            completeCoverage: true,
            authoritativeTotals: { nodes: summary.nodes, edges: summary.edges },
          }),
        };
      }, { signal, identity });
    },
    async queryMemory({ query, limit = 10, tag = null, signal, identity }) {
      const topK = parseBoundedInteger(limit, {
        name: 'limit', defaultValue: 10, min: 1, max: 100,
      });
      return withSource(async source => {
        const summary = await source.summarize({ signal });
        const match = await source.searchKeyword(query, { topK, tag, signal });
        return {
          ok: true,
          query,
          resultsFound: match.results.length,
          totalNodes: summary.nodes,
          results: match.results,
          evidence: source.getEvidence({
            completeCoverage: true,
            filters: { tag },
            limits: { topK },
            authoritativeTotals: { nodes: summary.nodes, edges: summary.edges },
            returnedTotals: { nodes: match.results.length, edges: 0 },
            filteredTotal: match.filtered,
          }),
        };
      }, { signal, identity });
    },
    async getMemoryStatistics({ signal, identity } = {}) {
      return withSource(async source => {
        const summary = await source.summarize({ signal });
        const breakdowns = await source.summarizeBreakdowns({
          signal, maxKeys: 10000, maxBytes: 1024 * 1024,
        });
        return {
          ok: true,
          totalNodes: summary.nodes,
          totalEdges: summary.edges,
          clusters: summary.clusters,
          nodesByTag: breakdowns.tags,
          clusterTotals: breakdowns.clusterTotals,
          breakdownsOmitted: breakdowns.omitted,
          averageActivation: breakdowns.averageActivation.toFixed(3),
          averageWeight: breakdowns.averageWeight.toFixed(3),
          mostAccessedNodes: breakdowns.mostAccessedNodes,
          highestActivationNodes: breakdowns.highestActivationNodes,
          evidence: source.getEvidence({
            completeCoverage: true,
            authoritativeTotals: { nodes: summary.nodes, edges: summary.edges },
          }),
        };
      }, { signal, identity });
    },
    async getMemoryGraph({ nodeLimit = 200, edgeLimit = 800, clusterId = null, signal, identity } = {}) {
      nodeLimit = parseBoundedInteger(nodeLimit, {
        name: 'nodeLimit', defaultValue: 200, min: 1, max: 2000,
      });
      edgeLimit = parseBoundedInteger(edgeLimit, {
        name: 'edgeLimit', defaultValue: 800, min: 0, max: 8000,
      });
      return withSource(source => sampleMemoryGraph(source, {
        nodeLimit, edgeLimit, clusterId, signal,
      }), { signal, identity });
    },
    async getSystemState() {
      const scalar = await readScalarState();
      const memory = await this.getMemoryStatistics();
      return { ...scalar, memory };
    },
  };
}

module.exports = { createMemoryTools };
~~~

Export it from `shared/memory-source/index.cjs`.

- [ ] **Step 4: Delegate every MCP memory entry point**

In each internal `MCPBridge` constructor, create:

~~~js
this.memoryTools = createMemoryTools({
  brainDir: this.logsDir,
  home23Root: this.home23Root,
  requesterAgent: this.agentName,
  resolveTargetContext: this.resolveTargetContext,
  readScalarState: () => this.readSystemStateShell(),
  logger: this.logger,
});
~~~

The bridge constructor first copies and freezes these fields from its named
`brainSourceContext` option; it never reads them from a tool call. The two
AgentExecutor constructors use:

~~~js
const brainSourceContext = assertBrainSourceContext(
  phase2bSubsystems.brainSourceContext,
);
this.mcpBridge = new MCPBridge(config.logsDir, logger, {
  brainSourceContext,
  clusterStateStore: null, // COSMO only; root engine omits this key
});
~~~

`assertBrainSourceContext()` requires absolute canonical roots, safe requester,
`brainDir === config.logsDir` after realpath, and a function resolver. The
bridge invokes that resolver per memory call and verifies its target root again.

Change `readSystemState()` to read scalar state only; remove base-sidecar hydration. Delegate:

~~~js
query_memory(query, limit = 10, { signal, identity } = {}) {
  return this.memoryTools.queryMemory({ query, limit, signal, identity });
}

get_memory_statistics({ signal, identity } = {}) {
  return this.memoryTools.getMemoryStatistics({ signal, identity });
}

get_memory_graph(nodeLimit = 200, { edgeLimit = Math.min(nodeLimit * 4, 8000), signal, identity } = {}) {
  return this.memoryTools.getMemoryGraph({
    nodeLimit, edgeLimit, signal, identity,
  });
}
~~~

Add an explicit `resolveTargetContext` constructor dependency to both internal
MCP bridges. Change AgentExecutor to require
`phase2bSubsystems.brainSourceContext` and pass that exact frozen bundle into
MCPBridge (the COSMO bridge keeps `clusterStateStore` as a separate named
option; do not overload positional arguments). In `engine/src/index.js`, both
COSMO `engine/src/index.js` context paths, and
`cosmo23/engine/src/worker/orchestrator-worker.js`, call
`createInstalledLocalSourceContext()` from trusted config/env before constructing
AgentExecutor and include it in `phase2bSubsystems`. Resident engine paths use
their configured brain directory; COSMO paths pass the canonical active run as
`activeRunPath`. No AgentExecutor derives identity from a mission/tool request.

In standalone HTTP and stdio servers, construct the same installed local-source
bundle using only process-derived `HOME23_ROOT`, `HOME23_AGENT`, canonical
runtime/run roots, ignored configured-agent list, and active-run metadata. Its
closure accepts only `{}`, builds a fresh catalog per call, and returns exact
`{catalogRevision,target,accessMode}`. Instantiate the
shared tools from trusted `COSMO_RUNTIME_DIR`, `HOME23_ROOT` (or the server
module's canonical repo root), and `HOME23_AGENT`; fail startup/readiness with
`mcp_source_context_required` if any context or resolver cannot be derived.
Replace only the `query_memory`, `get_memory_statistics`, and
`get_memory_graph` switch branches. HTTP derives an abort signal from request
close; stdio accepts the worker-owned operation signal when invoked through the
durable bridge. Keep transport framing unchanged. Every bridge derives
canonical own-target identity through that resolver, never tool arguments.
Each call receives a fresh ephemeral operation context and its `finally`
cleanup; existing legacy sidecar installs therefore project and answer honestly
instead of failing for lack of operation scratch.

In both HTTP servers, add the health route used by generated runtime probes:

~~~js
app.get('/health', async (_req, res) => {
  const memory = await memoryTools.checkReadiness();
  res.status(memory.ok && memory.sourceHealth !== 'unavailable' ? 200 : 503).json({
    ok: memory.ok && memory.sourceHealth !== 'unavailable',
    protocolVersion: '2025-03-26',
    sourceHealth: memory.evidence?.sourceHealth || memory.sourceHealth || 'unavailable',
    revision: memory.revision ?? null,
  });
});
~~~

Update every HTTP/stdio MCP tool schema and description from “complete memory
graph” to “bounded memory graph sample with authoritative totals.” Preserve
`limit` as the node-limit compatibility name, but require an integer from 1 to
2000; add optional integer `edgeLimit` from 0 to 8000. A `limit` of zero,
fraction, infinity, numeric junk, or an over-limit value returns typed
`invalid_request`; it never means “all.” Update both `dashboard-graph.html`
copies to request `{limit:2000,edgeLimit:8000}` and render the authoritative
totals/limited flag. Full graph access is the asynchronous foundation
`graph_export` operation only.

- [ ] **Step 5: Run adapter parity tests and commit**

Run:

~~~bash
node --test --test-concurrency=1 tests/engine/agents/mcp-bridge-memory.test.js tests/engine/agents/agent-executor-memory-context.test.js tests/engine/mcp/memory-tools.test.js tests/cosmo23/mcp-memory-tools.test.cjs tests/cosmo23/agent-executor-memory-context.test.cjs engine/tests/unit/agent-executor-review.test.js cosmo23/engine/tests/unit/agent-executor-review.test.js cosmo23/engine/tests/unit/agent-executor-guided.test.js
git diff --check -- shared/memory-source engine/src/agents engine/src/index.js engine/mcp cosmo23/engine/src/agents cosmo23/engine/src/index.js cosmo23/engine/src/worker/orchestrator-worker.js cosmo23/engine/mcp tests/engine/agents tests/engine/mcp tests/cosmo23 engine/tests/unit cosmo23/engine/tests/unit
~~~

Expected: all adapters return the same delta canary, tombstone behavior, totals, revision, and failure evidence.

Commit:

~~~bash
git diff --cached --quiet
git add -- shared/memory-source/mcp-tools.cjs shared/memory-source/index.cjs engine/src/agents/mcp-bridge.js engine/src/agents/agent-executor.js engine/src/index.js engine/mcp/http-server.js engine/mcp/stdio-server.js engine/mcp/dashboard-graph.html cosmo23/engine/src/agents/mcp-bridge.js cosmo23/engine/src/agents/agent-executor.js cosmo23/engine/src/index.js cosmo23/engine/src/worker/orchestrator-worker.js cosmo23/engine/mcp/http-server.js cosmo23/engine/mcp/stdio-server.js cosmo23/engine/mcp/dashboard-graph.html tests/engine/agents/mcp-bridge-memory.test.js tests/engine/agents/agent-executor-memory-context.test.js tests/engine/mcp/memory-tools.test.js tests/cosmo23/mcp-memory-tools.test.cjs tests/cosmo23/agent-executor-memory-context.test.cjs engine/tests/unit/agent-executor-review.test.js cosmo23/engine/tests/unit/agent-executor-review.test.js cosmo23/engine/tests/unit/agent-executor-guided.test.js
git diff --cached --check
git diff --cached
git commit -m "fix(memory): unify MCP logical source reads"
git status --short
~~~

### Task 8: Agent-Scoped MCP Runtime Availability

**Files:**
- Create: `engine/src/dashboard/mcp-availability.js`
- Modify: `cli/lib/generate-ecosystem.js:157-222`
- Modify: `engine/mcp/http-server.js`
- Modify: `cosmo23/engine/mcp/http-server.js`
- Modify: `engine/src/dashboard/server.js:3635-3697`
- Modify: `engine/src/dashboard/server.js:8605-8676`
- Test: `tests/engine/cli-onboarding.test.js`
- Test: `tests/engine/dashboard/mcp-availability.test.js`
- Test: `tests/engine/mcp/http-loopback.test.js`
- Test: `tests/cosmo23/mcp-http-loopback.test.cjs`

**Interfaces:**
- Consumes: configured per-agent `ports.mcp`, `agent.config.mcp?.enabled`, and trusted `MCP_HTTP_HOST`.
- Produces: a loopback-only `home23-<agent>-mcp` PM2 app when enabled and `probeMcpAvailability({port, fetchImpl, timeoutMs})` for honest dashboard advertisement/proxy admission.

- [ ] **Step 1: Write failing generated-runtime and configured-port tests**

Add to onboarding tests:

~~~js
test('ecosystem generation starts one isolated MCP service per enabled agent', () => {
  const ecosystem = generateFixtureEcosystem([
    { name: 'ada', ports: { mcp: 6103 } },
    { name: 'bob', ports: { mcp: 6203 }, mcp: { enabled: false } },
  ]);
  const ada = ecosystem.apps.find(app => app.name === 'home23-ada-mcp');
  assert.equal(ada.script, 'mcp/http-server.js');
  assert.equal(ada.env.MCP_HTTP_PORT, '6103');
  assert.equal(ada.env.MCP_HTTP_HOST, '127.0.0.1');
  assert.equal(ada.env.HOME23_ROOT, fixture.home23Root);
  assert.match(ada.env.COSMO_RUNTIME_DIR, /instances\/ada\/brain$/);
  assert.equal(ecosystem.apps.some(app => app.name === 'home23-bob-mcp'), false);
});
~~~

Create availability tests:

~~~js
test('probes the configured port rather than hardcoded legacy ports', async () => {
  const calls = [];
  const result = await probeMcpAvailability({
    port: 6103,
    fetchImpl: async url => {
      calls.push(url);
      return {
        ok: true,
        json: async () => ({
          ok: true, protocolVersion: '2025-03-26', sourceHealth: 'healthy',
        }),
      };
    },
  });
  assert.deepEqual(calls, ['http://127.0.0.1:6103/health']);
  assert.equal(result.available, true);
});

test('disabled or unreachable MCP is not advertised or proxied', async () => {
  assert.deepEqual(await probeMcpAvailability({ enabled: false, port: 6103 }), {
    available: false,
    endpoint: null,
    reason: 'mcp_disabled',
  });
});

test('legacy source is advertised only after ephemeral projection readiness passes', async () => {
  const unhealthy = await probeMcpAvailability({
    port: 6103,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        ok: false, protocolVersion: '2025-03-26', sourceHealth: 'unavailable',
      }),
    }),
  });
  assert.equal(unhealthy.available, false);
  assert.equal(unhealthy.reason, 'mcp_source_unavailable');
});
~~~

Add `tests/engine/mcp/http-loopback.test.js` and `tests/cosmo23/mcp-http-loopback.test.cjs`. Refactor each HTTP server to export `startMcpHttpServer({host,port})` without auto-start when imported. Start on port `0` with `host:'127.0.0.1'`, wait for `listening`, and assert `server.address().address === '127.0.0.1'` before declaring it enabled. Assert omitted host also resolves to `127.0.0.1`, and reject `0.0.0.0`, `::`, a hostname, or any non-loopback address with typed `invalid_mcp_host` before `listen()`.

- [ ] **Step 2: Run MCP runtime tests and verify red**

Run:

~~~bash
node --test --test-concurrency=1 tests/engine/cli-onboarding.test.js tests/engine/dashboard/mcp-availability.test.js tests/engine/mcp/http-loopback.test.js tests/cosmo23/mcp-http-loopback.test.cjs
~~~

Expected: FAIL because no MCP app or availability helper exists.

- [ ] **Step 3: Generate isolated MCP apps**

Inside the per-agent loop in `cli/lib/generate-ecosystem.js`, after the dashboard definition and before the harness definition, emit:

~~~js
if (agent.config.mcp?.enabled !== false) {
  lines.push('    {');
  lines.push("      name: 'home23-" + agent.name + "-mcp',");
  lines.push("      script: 'mcp/http-server.js',");
  lines.push('      cwd: ENGINE,');
  lines.push("      autorestart: true, watch: false, merge_logs: true,");
  lines.push("      out_file: " + logsDir + " + '/mcp-out.log',");
  lines.push("      error_file: " + logsDir + " + '/mcp-err.log',");
  lines.push("      env: { ...commonEnv, HOME23_ROOT: ROOT, HOME23_AGENT: '" + agent.name + "', COSMO_RUNTIME_DIR: " + brainDir + ", MCP_HTTP_HOST: '127.0.0.1', MCP_HTTP_PORT: '" + mcpPort + "', INSTANCE_ID: 'home23-" + agent.name + "' },");
  lines.push('    },');
}
~~~

Do not change local `ecosystem.config.cjs` in this task; tests exercise generation in a temporary root.

In both HTTP servers, bind explicitly before the service can be advertised:

~~~js
const host = options.host ?? process.env.MCP_HTTP_HOST ?? '127.0.0.1';
if (host !== '127.0.0.1' && host !== '::1') {
  throw Object.assign(new Error('MCP HTTP must bind to loopback'), {
    code: 'invalid_mcp_host',
  });
}
const server = app.listen(options.port ?? Number(process.env.MCP_HTTP_PORT), host);
return server;
~~~

Availability is false until the listener is actually up on a loopback address and its `/health` response proves the shared source opened through a trusted ephemeral context. A legacy-sidecar agent must pass the real immutable projection/process-pin/finally-cleanup readiness path; a missing operation context, target write, projection failure, unavailable source, or cleanup failure leaves `/health` at 503 and the dashboard must not advertise/proxy MCP.

- [ ] **Step 4: Implement honest availability and proxy admission**

Create `engine/src/dashboard/mcp-availability.js`:

~~~js
'use strict';

async function probeMcpAvailability({ enabled = true, port, fetchImpl = fetch, timeoutMs = 1500 }) {
  if (!enabled) return { available: false, endpoint: null, reason: 'mcp_disabled' };
  const endpoint = 'http://127.0.0.1:' + port + '/mcp';
  try {
    const response = await fetchImpl('http://127.0.0.1:' + port + '/health', {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { available: false, endpoint: null, reason: 'mcp_unhealthy' };
    const body = await response.json();
    if (body?.protocolVersion !== '2025-03-26' || body?.ok !== true ||
        body?.sourceHealth === 'unavailable') {
      return { available: false, endpoint: null, reason: 'mcp_source_unavailable' };
    }
    return { available: true, endpoint, reason: null };
  } catch (error) {
    return { available: false, endpoint: null, reason: 'mcp_unreachable', detail: error.message };
  }
}

module.exports = { probeMcpAvailability };
~~~

Replace hardcoded lsof checks for 3346/3347 with this configured-port probe. Before proxying `/api/mcp`, probe availability and return HTTP 503 with `{error:{code:"source_unavailable"},mcp}` when unavailable.

- [ ] **Step 5: Run tests and commit explicit runtime paths**

Run:

~~~bash
node --test --test-concurrency=1 tests/engine/cli-onboarding.test.js tests/engine/dashboard/mcp-availability.test.js tests/engine/mcp/http-loopback.test.js tests/cosmo23/mcp-http-loopback.test.cjs
git diff --check -- cli/lib/generate-ecosystem.js engine/mcp/http-server.js cosmo23/engine/mcp/http-server.js engine/src/dashboard/mcp-availability.js engine/src/dashboard/server.js tests/engine/cli-onboarding.test.js tests/engine/dashboard/mcp-availability.test.js tests/engine/mcp/http-loopback.test.js tests/cosmo23/mcp-http-loopback.test.cjs
~~~

Expected: all runtime generation and availability tests pass.

Commit:

~~~bash
git diff --cached --quiet
git add -- cli/lib/generate-ecosystem.js engine/mcp/http-server.js cosmo23/engine/mcp/http-server.js engine/src/dashboard/mcp-availability.js engine/src/dashboard/server.js tests/engine/cli-onboarding.test.js tests/engine/dashboard/mcp-availability.test.js tests/engine/mcp/http-loopback.test.js tests/cosmo23/mcp-http-loopback.test.cjs
git diff --cached --check
git diff --cached
git commit -m "fix(mcp): bind agent-scoped service to loopback"
git status --short
~~~

### Task 9: Ordered Embedding Batches and Explicit Access Mutation

**Files:**
- Modify: `engine/src/memory/network-memory.js:23-267`
- Modify: `engine/src/memory/network-memory.js:820-972`
- Modify: `cosmo23/engine/src/memory/network-memory.js:23-266`
- Modify: `cosmo23/engine/src/memory/network-memory.js:809-950`
- Test: `tests/engine/memory/network-memory-embedding-batch.test.js`
- Test: `tests/engine/memory/network-memory-access.test.js`
- Test: `tests/cosmo23/network-memory-embedding-batch.test.cjs`

**Interfaces:**
- Consumes: existing `NetworkMemory` API.
- Produces: backward-compatible `constructor(config, logger, deps = {})`, `prepareEmbeddingText(text)`, exactly ordered `embedBatch(texts)`, `recordNodeAccess(nodeIds, options)`, and `query(queryText, topK, {markAccess})`.

- [ ] **Step 1: Write failing batch and no-write tests**

Create an injected embedding client that returns two vectors in one successful batch and records every call:

~~~js
test('successful batch returns one ordered vector per input without fallback calls', async () => {
  const calls = [];
  const memory = createMemory({
    getEmbeddingClient: () => ({
      embeddings: {
        create: async request => {
          calls.push(request.input);
          return { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] };
        },
      },
    }),
  });
  assert.deepEqual(await memory.embedBatch(['a', 'b']), [[1, 0], [0, 1]]);
  assert.equal(calls.length, 1);
});

test('batch fallback requests only missing response indexes', async () => {
  const calls = [];
  const memory = createPartiallyMissingBatchMemory(calls);
  const result = await memory.embedBatch(['a', 'b']);
  assert.deepEqual(result, [[1, 0], [0, 1]]);
  assert.deepEqual(calls, [['a', 'b'], 'b']);
});

test('read-only query does not mutate access metadata or persistence revision', async () => {
  const memory = populatedMemory();
  const before = snapshotAccessAndRevision(memory);
  const result = await memory.query('canary', 5, { markAccess: false });
  assert.equal(result.length > 0, true);
  assert.deepEqual(snapshotAccessAndRevision(memory), before);
});

test('own-brain semantic query mutates the stored node and marks it dirty', async () => {
  const memory = populatedMemory();
  const stored = memory.nodes.get('n1');
  await memory.query('canary', 5, { markAccess: true });
  assert.equal(stored.accessCount, 1);
  assert.equal(memory.dirtyNodeIds.has('n1'), true);
});
~~~

- [ ] **Step 2: Run batch/access tests and verify red**

Run:

~~~bash
node --test --test-concurrency=1 tests/engine/memory/network-memory-embedding-batch.test.js tests/engine/memory/network-memory-access.test.js tests/cosmo23/network-memory-embedding-batch.test.cjs
~~~

Expected: FAIL because the undefined `precision` triggers duplicate fallback calls and `query` has no access option.

- [ ] **Step 3: Inject the embedding client and unify text preparation**

Change both constructors:

~~~js
constructor(config, logger, deps = {}) {
  this.config = config;
  this.logger = logger;
  this.getEmbeddingClient = deps.getEmbeddingClient || getEmbeddingClient;
  // retain the remaining existing initialization unchanged
}
~~~

Add:

~~~js
prepareEmbeddingText(text) {
  const value = String(text || '');
  if (this.tokenizer) {
    const tokens = this.tokenizer.encode(value);
    const maxTokens = this.isOllamaEmbeddingEndpoint() ? 512 : 8000;
    if (tokens.length > maxTokens) {
      const decoded = this.tokenizer.decode(tokens.slice(0, maxTokens));
      return typeof decoded === 'string' ? decoded : new TextDecoder().decode(decoded);
    }
  }
  const maxChars = this.isOllamaEmbeddingEndpoint() ? 2000 : 30000;
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}
~~~

Use `this.getEmbeddingClient()` and `prepareEmbeddingText()` in both `embed()` and `embedBatch()`.

- [ ] **Step 4: Implement ordered batch validation and targeted fallback**

Replace `embedBatch()` in both copies with:

~~~js
async embedBatch(texts) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const output = new Array(texts.length).fill(null);
  const batchSize = 2048;
  for (let offset = 0; offset < texts.length; offset += batchSize) {
    const original = texts.slice(offset, offset + batchSize);
    const input = original.map(text => this.prepareEmbeddingText(text));
    const missing = new Set(input.map((_text, index) => index));
    try {
      const response = await this.getEmbeddingClient().embeddings.create(this.buildEmbeddingCreateParams(input));
      for (const item of response?.data || []) {
        if (!Number.isInteger(item.index) || item.index < 0 || item.index >= input.length || !Array.isArray(item.embedding)) continue;
        output[offset + item.index] = item.embedding;
        missing.delete(item.index);
      }
    } catch (error) {
      this.logger?.warn?.('Batch embedding failed; retrying inputs individually', { error: error.message, batchSize: input.length });
    }
    for (const index of missing) {
      output[offset + index] = await this.embed(original[index]);
    }
  }
  return output;
}
~~~

This removes the undefined `precision` reference and never appends duplicate vectors.

- [ ] **Step 5: Centralize access mutation and add the read-only option**

Add:

~~~js
recordNodeAccess(nodeIds, { weightBoost = 0.05 } = {}) {
  for (const id of nodeIds) {
    const stored = this.nodes.get(id);
    if (!stored) continue;
    stored.accessed = new Date();
    stored.accessCount = Number(stored.accessCount || 0) + 1;
    stored.weight = Math.min(1, Number(stored.weight || 0) + weightBoost);
    this.markNodeDirty(id);
  }
}
~~~

Change `query` to `async query(queryText, topK = 5, options = {})`. Remove mutations of spread copies and call:

~~~js
if (options.markAccess !== false) {
  this.recordNodeAccess(results.map(node => node.id), { weightBoost: 0.1 });
}
~~~

Change `queryByKeyword` to call the same helper when `options.markAccess !== false`. Shared source/MCP/cross-brain reads do not instantiate this mutable path; any own-brain operation that explicitly uses it passes `markAccess: true`.

- [ ] **Step 6: Run tests, document the COSMO patch, and commit**

Run:

~~~bash
node --test --test-concurrency=1 tests/engine/memory/network-memory-embedding-batch.test.js tests/engine/memory/network-memory-access.test.js tests/cosmo23/network-memory-embedding-batch.test.cjs
git diff --check -- engine/src/memory/network-memory.js cosmo23/engine/src/memory/network-memory.js tests/engine/memory tests/cosmo23
~~~

Expected: all tests pass; one successful batch makes one provider call and read-only access makes no mutation.

Commit:

~~~bash
git diff --cached --quiet
git add -- engine/src/memory/network-memory.js cosmo23/engine/src/memory/network-memory.js tests/engine/memory/network-memory-embedding-batch.test.js tests/engine/memory/network-memory-access.test.js tests/cosmo23/network-memory-embedding-batch.test.cjs
git diff --cached --check
git diff --cached
git commit -m "fix(memory): order embeddings and gate access writes"
git status --short
~~~

### Task 10: Source-Truth Integration Verification and Durable Documentation

**Files:**
- Modify: `docs/design/COSMO23-VENDORED-PATCHES.md`
- Verify: all files from Tasks 1-9
- Handoff only: `scripts/verify-brain-persistence.mjs` and `tests/scripts/verify-brain-persistence.test.cjs` are created by the integrated rollout plan, not this task.

**Interfaces:**
- Consumes: every source-truth task.
- Produces: green offline source-truth verification, a COSMO vendored-patch record, and exact production load/save seams for the integrated rollout's isolated live-read/temp-clone persistence gate. This source plan neither creates the final receipt nor waits for live runtime availability.

- [ ] **Step 1: Run the complete source-truth focused matrix**

~~~bash
node --test --test-concurrency=1 \
  tests/shared/memory-source-contracts.test.js \
  tests/shared/memory-source-reader.test.js \
  tests/shared/memory-source-adapters.test.js \
  tests/shared/memory-source-pin.test.js \
  tests/shared/memory-source-writer.test.js \
  tests/shared/memory-source-graph.test.js \
  tests/engine/core/memory-persistence.test.js \
  tests/engine/memory/network-memory-persistence-generation.test.js \
  tests/engine/core/memory-sidecar.test.cjs \
  tests/engine/core/brain-persistence-guard.test.js \
  tests/engine/core/brain-backups.test.cjs \
  tests/engine/cli-onboarding.test.js \
  tests/engine/dashboard/memory-search.test.js \
  tests/engine/dashboard/brain-source-api.test.js \
  tests/engine/dashboard/brain-source-executors.test.js \
  tests/engine/dashboard/brain-graph-export.test.js \
  tests/engine/dashboard/brain-source-mutation-boundary.test.js \
  tests/engine/dashboard/dashboard-state-summary.test.js \
  tests/engine/dashboard/mcp-availability.test.js \
  tests/engine/mcp/http-loopback.test.js \
  tests/engine/merge/build-ann-index.test.js \
  tests/engine/agents/mcp-bridge-memory.test.js \
  tests/engine/agents/agent-executor-memory-context.test.js \
  tests/engine/mcp/memory-tools.test.js \
  tests/engine/memory/network-memory-embedding-batch.test.js \
  tests/engine/memory/network-memory-access.test.js \
  tests/cosmo23/brain-source-router.test.cjs \
  tests/cosmo23/legacy-research-memory-source.test.cjs \
  tests/cosmo23/research-memory-manifest.test.cjs \
  tests/cosmo23/memory-sidecar.test.cjs \
  tests/cosmo23/mcp-memory-tools.test.cjs \
  tests/cosmo23/agent-executor-memory-context.test.cjs \
  tests/cosmo23/mcp-http-loopback.test.cjs \
  tests/cosmo23/network-memory-embedding-batch.test.cjs \
  tests/evobrew/memory-sidecar.test.cjs
~~~

Expected: every named test passes with no real network/provider dependency. The barrier test proves a mutation accepted after capture but before durable commit cannot be marked clean.

Run the adversarial search heap probe separately so its child-process peak is not hidden by earlier allocations:

~~~bash
node --expose-gc tests/engine/dashboard/memory-search-heap-probe.cjs
~~~

Expected: one JSON metrics line, full million-node coverage, bounded candidate/result bytes, and peak heap growth at most 192 MiB.

- [ ] **Step 2: Run build, repository, contract, and portability verification**

~~~bash
npm run build
npm test
npm run test:contracts
git ls-files -ci --exclude-standard
git archive HEAD | tar -tf - | rg '^(instances/|config/(home|targets|cron-jobs)\.yaml|ecosystem\.config\.cjs)'
git diff --check
~~~

Expected:

- Build passes.
- Full test and contract suites pass.
- `git ls-files -ci --exclude-standard` prints nothing.
- Git archive command prints nothing.
- `git diff --check` prints nothing.

- [ ] **Step 3: Add the COSMO vendored-patch record**

Append a dated patch entry describing:

- COSMO graph/status moving to `shared/memory-source`.
- Base-plus-delta hydration.
- Bounded server-side graph limits and `full=1` rejection.
- MCP source parity.
- Ordered embedding batch repair.
- Loopback-only MCP binding.
- Immutable numeric-v1 legacy resident/research projections and the external global lock root.
- Exact focused commands and pass counts from Steps 1-2.

Do not claim live acceptance in this entry.

- [ ] **Step 4: Freeze the production persistence-verifier handoff contract**

Do not create a second verifier in this plan. The integrated rollout creates `scripts/verify-brain-persistence.mjs` and its fixture test. It must consume these exact production seams established here:

- `resolveMemorySourceSelection(canonicalRoot)` for the exact target files, authority kind, manifest generation, and committed delta cutoff selected without writes.
- `loadMemoryRevision(brainDir, {home23Root,requesterAgent,operationId})` for the real read path, returning nonzero loaded node/edge totals, numeric revision, source evidence, and the selection metadata. Its legacy projection, global lock, and process pin are all outside the target and are removed in `finally`.
- `persistMemoryRevision({brainDir,memory,forceFull:true,home23Root})` for the real save path, guarded by dirty-generation CAS and invoked only against the verifier's external temporary clone.

The integrated fixture must cover numeric-v1 manifest and legacy-resident-sidecar inputs, committed-delta-prefix hashing, advisory snapshot agreement, a concurrent source change, source/load count disagreement, mutation-behind-commit barrier behavior, clone-save failure, and guarded cleanup failure. No source task is allowed to call a writer with Jerry's or any other live target path.

The integrated pre-restart read-only gate is exactly:

~~~bash
node scripts/verify-brain-persistence.mjs \
  --mode read-only --home23-root "$LIVE_ROOT" --agent jerry \
  --brain "$LIVE_ROOT/instances/jerry/brain" \
  --output "$PERSISTENCE_AUDIT/jerry-live-load.json"
~~~

It must recursively hash the production-selected source files before and after, follow no symlink, require nonzero authoritative counts plus numeric watermark agreement, emit `unchanged:true`, and perform zero target writes. The integrated rollout owns creation, fixture execution, live invocation for Jerry/Forrest, final receipt, and any resulting failure handling. Offline source completion does **not** wait for that later gate.

- [ ] **Step 5: Inspect the complete task diff and commit**

~~~bash
git diff --check
git diff -- docs/design/COSMO23-VENDORED-PATCHES.md
git diff --cached --quiet
git add -- docs/design/COSMO23-VENDORED-PATCHES.md
git diff --cached --check
git diff --cached
git commit -m "docs(memory): record source-truth verification"
git status --short
~~~

- [ ] **Step 6: Hand off to the integrated live-acceptance plan**

Do not regenerate the live `ecosystem.config.cjs`, restart PM2 processes, rebuild Jerry's ANN, compact Jerry's brain, run `scripts/verify-brain-persistence.mjs` against live state, or run live cross-brain canaries from this source-only plan. The integrated brain-operations rollout performs those actions after authority, operation lifecycle, provider completion, and agent-tool plans are green. Hand off these exact prerequisites:

~~~text
source manifest writer green
portable reader adapter parity green
dashboard ANN/search green
resident and COSMO bounded graph/status green
asynchronous graph_export auth/retention/no-write green
legacy resident and research immutable numeric-v1 streaming projection green
internal/HTTP/stdio MCP parity green
MCP loopback listener green
end-to-end cancellation and canonical mutation-boundary hashing green
embedding/access mutation boundary green
dirty-generation/CAS barrier green
build/full/contracts/portability green
~~~
