# Owner recall calibration

Lead: Codex. Source: this Home23 checkout, branch
`fix/owner-recall-calibration`, starting commit
`5498186927adde6600afa4ed09f1dee4f73adfe9`.

Scope: calibrate semantic retrieval for the exact owned ONNX noprefix model
without changing its recipe, and make existing owner conversation knowledge
available through `brain_search`. Other embedding providers retain their defaults.

Authorization: source edits and isolated tests only. Do not access the live home,
run PM2, commit, push, or print secrets. Existing dependency symlinks are preserved.

Ownership:

- Calibration worker: canonical memory search, source executor, regression tests.
- Dashboard worker: HTTP parameter defaults and route regression tests.
- Owner recall worker: existing harness federation, owner record matching,
  and regression tests.
- Lead: integration review, relevant suites, documentation and final report.

Decision: extend the existing merged relationship retrieval path. Owner knowledge
stays in its authoritative stores; existing entries need no graph backfill or
re-embedding. Include date and quoted evidence matching, with status, privacy,
target and result-limit rules preserved.

The owned query embedder uses the canonical runtime identity
`owned-onnx:owned-nomic-v1.5-onnx-fp32-mean-noprefix:768`. Its default semantic gate
is `max(0.40, top raw similarity - 0.10)`. Both bounded semantic candidate heaps
retain raw similarity before authority ranking. Finite explicit noise thresholds
retain flat overrides. Missing or malformed thresholds use the model policy.
Other providers retain their previous defaults. POST no longer injects the flat
floor; GET retains its legacy `minSimilarity: 0.1` and forwards explicit floors.
The owned policy still applies its absolute `0.40` floor on GET.

Owner recall reads existing ledger entries and approved durable owner facts.
There is no backfill command, graph mutation, or re-embedding step. Deploying the
source changes makes the existing records eligible for merged recall. Relative
dates use the harness process's local calendar. Recall returns distilled owner
knowledge, not a reconstruction of the full transcript.

Changed source files:

- `engine/src/dashboard/memory-search.js`
- `engine/src/dashboard/server.js`
- `src/agent/owner-conversation-recall.ts`
- `src/agent/relationship-ledger.ts`
- `src/agent/memory-objects.ts`
- `src/agent/tools/brain.ts`

Changed tests:

- `tests/engine/dashboard/memory-search.test.js`
- `tests/engine/dashboard/memory-search-embedding.test.js`
- `tests/engine/dashboard/brain-source-executors.test.js`
- `tests/engine/dashboard/memory-search-routes.test.js`
- `tests/agent/tools/brain.test.ts`
- `tests/agent/relationship-ledger.test.ts`

`source-executors.js` already forwards omitted thresholds correctly; its new test
covers the real source executor without changing that file. This handoff is the
thirteenth task file. Dependency symlinks remain unrelated and untracked.

## Verification

Run commands from the checkout root. All data fixtures use temporary directories.

```sh
node --test --test-concurrency=1 tests/engine/dashboard/memory-search.test.js tests/engine/dashboard/memory-search-embedding.test.js tests/engine/dashboard/brain-source-executors.test.js tests/engine/dashboard/memory-search-routes.test.js tests/engine/dashboard/memory-delta-overlay-cache.test.js
```

170 passed, zero failures. This includes ANN, logical scan, delta overlays,
source executor, dashboard parameters, saturation and other-provider regressions.

```sh
node --test --test-concurrency=1 tests/engine/memory/embedding-provider.test.js tests/engine/memory/network-memory-embedder-id.test.js tests/engine/dashboard/owned-embedding-settings.test.js
```

49 passed, zero failures. Existing recipe and vector-space compatibility checks
remain passing.

```sh
node --import tsx --test --test-concurrency=1 tests/agent/owner-distill.test.ts tests/agent/relationship-ledger.test.ts tests/agent/owner-personal-context.test.ts tests/agent/memory-objects-provenance.test.ts tests/agent/tools/brain.test.ts
```

135 passed, zero failures. The new tests reproduce missing recall before the
implementation and verify morning recaps, Oct 14 quote-only facts, fresh reads,
read-only distill-to-search integration, no duplicate replay, privacy/status,
scoping, result limits, snippets and completed-search recovery.

```sh
node --test tests/engine/package-test-registration.test.cjs
node node_modules/typescript/bin/tsc --noEmit
git diff --check
```

Test registration: five passed, zero failures. Typecheck and diff checks passed.

```sh
node --import tsx --test --test-concurrency=1 tests/agent/brain-operations-client.test.ts tests/agent/context-brain-retrieval.test.ts
```

65 passed, three failed. Every failure is `listen EPERM` on `127.0.0.1`, because
the sandbox refuses isolated fixture listeners:

- real client stays attached while a durable legacy source pin is still projecting
- real store, reader, router, and client preserve exact cancel and no-result terminal envelopes
- real coordinator and router detach then reopen the same attachment ID across a compacted gap

```sh
npm run test:contracts
```

27 passed, 44 failed, two skipped. All 44 failures have the same sandbox
`listen EPERM` cause. Those tests stopped at listener setup; their HTTP assertions
remain unverified.

Final integration and pattern review found no remaining actionable defects.
All task changes remain uncommitted on the starting branch and commit, as
requested. No live home access, PM2, or source activation occurred. Owner recall
itself makes no graph writes; test brains were created only in temporary fixtures.
Full `npm test` was not run; the relevant commands above were run directly.

Remaining limits: sandbox listener failures require an environment that permits
isolated localhost fixtures. No real-home retrieval or deployment was performed.
The owner stores retain only the latest quote's evidence date for a deduplicated
statement. Day queries use that timestamp; older overwritten quotes are not
reconstructed. Original creation dates and accumulated references remain metadata.
The owner/operator controls any later source activation; no backfill is necessary.

<details>
<summary>Contract tests that failed at the sandbox listener boundary</summary>

- client capabilities route returns the contract payload
- local HTTP helper binds IPv4 and resolves only after server closure
- respond-async Query start returns durable identity without waiting for provider work
- respond-async Query terminal replay returns the original durable result without attachment
- Query run forwards one valid client request ID unchanged to durable start
- Query run generates its existing compatibility request ID when the client header is absent
- Query run rejects malformed, comma-joined, and duplicate client request IDs before start
- lost-start replay reaches durable idempotency while the live catalog is unavailable
- lost-start replay is not blocked by a renamed live catalog target
- query catalog route validates against the query catalog schema
- query export facade refuses raw COSMO fallback when durable adapter is unavailable
- query run dry-run validates through facade without forwarding to COSMO brain query
- query run facade rejects legacy flat model and PGS spellings before execution
- query run facade does not fall back to raw COSMO when durable adapter is unavailable
- query export dry-run returns export contract shape without writing through COSMO export
- query facade rejects one character beyond published query and prior-context limits
- compatibility facade rejects agent and brain mismatch instead of forwarding arbitrary target
- compatibility facade rejects query/body disagreement and explicit unknown agents before catalog or start
- compatibility run performs durable start, attach/wait, then protected result read
- compatibility facade accepts only the four durable query modes before operation creation
- compatibility PGS selects six-hour attachment policy and forwards progress beyond 120 seconds
- compatibility PGS rejects the unrelated direct-query mode before durable start
- compatibility PGS accepts every named level in fresh, continue, and targeted modes and derives its fraction
- compatibility PGS enforces exact mode-dependent continuation and target fields
- compatibility PGS preserves a useful null-answer partial with sweep output and typed error
- compatibility detach is honest and remains actionable
- compatibility stream attaches to events and terminal bytes come only from result
- compatibility request accepts only exact nested provider pairs and finite numeric controls
- compatibility forwarding strips facade controls and binds the selected canonical target
- compatibility terminal success rejects success false, embedded errors, and missing answer
- compatibility wait and protected result cannot switch operation identity
- compatibility canonical export rejects inline bytes and forwards only stored operation authority
- canonical stored export remains local and works while the live COSMO catalog is unavailable
- query compatibility JSON is bounded before the dashboard broad parser materializes it
- Query PGS partition preflight returns canonical IDs through a durable graph operation
- query compatibility body cap admits the maximum valid ad hoc export aggregate
- compatibility ad hoc export is explicitly noncanonical and independent of COSMO catalog
- compatibility export failures retain typed error and durable operation authority
- catalog capability and compatibility request schemas keep verified follow-ups protected
- query response schema distinguishes terminal, detached, and typed failure shapes
- failed, cancelled, and interrupted durable responses retain actionable operation references
- stream terminal failure retains the durable operation reference in its typed error event
- query stream and export responses validate against typed compatibility schemas
- Query notebook fixtures are locked to actual runtime projections

</details>
