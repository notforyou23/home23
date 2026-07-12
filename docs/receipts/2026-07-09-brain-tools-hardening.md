# Brain Tools Hardening Receipt

Date: 2026-07-10  
Design: `docs/superpowers/specs/2026-07-09-brain-operations-reliability-design.md`  
Branch: `codex/brain-agent-migration`
Scope: Complete Brain Operations Reliability and Cross-Brain Read design, live deployment, and PM2 persistence.

## Result

Implemented the approved design slices needed to make Home23 brain tools more robust for long operations, cross-brain reads, source-backed retrieval, bounded graph access, MCP runtime availability, and read-only memory access.

The implementation keeps existing agent-facing tool names while routing dangerous or stale reads through shared source projections, durable operation authority, bounded graph surfaces, honest error envelopes, and requester-owned scratch/result boundaries.

## Landed changes

- Durable brain operation coordinator and client contracts for long-running work, reconnect, cancellation, authority, source pins, result handles, graph artifacts, and export authorization.
- Source-truth memory reading under `shared/memory-source/`, including base-plus-delta projections, tombstones, source evidence, graph sampling, legacy research snapshot projection, COSMO source adapters, and dashboard/COSMO executor routes.
- ANN/search hardening so stale vector indexes cannot hide newer delta upserts or tombstones, with fallback paths that distinguish healthy empty, no match, degraded unknown, unavailable, and cancelled states.
- Cross-brain read-only boundaries for pinned source search, graph/status/query surfaces, and requester-owned operation/export storage.
- COSMO and Evobrew sidecar hydration changes that read bounded projections instead of materializing unsafe full state.
- MCP runtime availability generation/probing plus loopback-only MCP memory tools backed by the same source-truth reader, including unavailable-source envelopes instead of healthy-zero claims.
- Embedding/access mutation fix: own-brain semantic reads can reinforce access metadata, while read-only semantic and keyword reads do not mutate target brain access metadata or persistence state.
- Optional dependency hardening for OpenAI, MCP SDK, lockfile, dotenv, and related imports so base tests and fresh test environments do not fail before those features are used.

## Integration commits

- `148ed19` `fix(memory): validate ANN against source revisions`
- `121d6b5` `feat(memory): add bounded graph sampler`
- `20faf54` `feat(memory): add resident brain source routes`
- `4e6c106` `feat(memory): register source operation executors`
- `edca883` `feat(memory): project legacy research snapshots`
- `b722375` `fix(memory): route cosmo brain sources through projections`
- `c575802` `fix(engine): lazy-load optional AI dependencies`
- `69f9ea7` `fix(cosmo): lazy-load optional provider dependencies`
- `2110e80` `fix(engine): defer chat completions client construction`
- `66b1759` `fix(mcp): advertise agent runtime availability`
- `80c1c91` `fix(memory): keep read-only searches non-mutating`
- `f70a466` `feat(memory): add shared MCP memory tools`
- `551748c` `fix(mcp): read memory through source tools`
- `a7ba373` `fix(engine): defer optional import dependencies`
- `94abe44` `fix: harden long-running brain operations`
- `a0942ea` `fix: close live brain operation gaps`

## Live defects closed

The live large-brain run exposed defects that deterministic short tests did not:

- A 60-second quiet worker reconnect replayed an already-authenticated `provider_selected` event and failed the provider contract. The coordinator now marks provider events covered by the recovery status snapshot as historical.
- The generic 60-second worker-control deadline expired while COSMO was validly opening a large pinned source. Worker startup now has a distinct 30-minute bound, and uncertain pending starts are cancelled even before a worker reference is published.
- Coordinator shutdown could return while a resolved remote start was still publishing or cancelling, leaving ghost work. Shutdown now tracks the complete start, publication, and cancellation settlement.
- PGS emitted no explicit projection/sweep/synthesis progress, understated pending work by reporting only the bounded 256-unit candidate window, and could skip scratch/database-handle cleanup when progress or close hooks threw. The progress and nested cleanup contracts are now complete and tested.
- Canary discovery used generic boilerplate words and forwarded source-valid tags that exceeded the operation route's 256-character limit. It now derives distinctive numeric/identifier terms and omits only oversized route tags.
- The PM2 persistence guard treated historical dump uptime as current identity and rejected an exact ecosystem-authorized script transition. It now ignores stale runtime timestamps only for pid-less dump comparison and permits a configured row transition only when the live row exactly matches ecosystem authority.

## Verification

Focused verification:

```bash
node --test --test-concurrency=1 tests/cosmo23/brain-source-router.test.cjs tests/cosmo23/memory-sidecar.test.cjs tests/evobrew/memory-sidecar.test.cjs tests/cosmo23/legacy-research-memory-source.test.cjs tests/shared/memory-source-reader.test.js tests/shared/memory-source-graph.test.js tests/engine/dashboard/brain-source-executors.test.js
```

Result: 29 tests passed, 0 failed.

```bash
node --test --test-concurrency=1 tests/engine/dashboard/mcp-proxy-availability.test.cjs tests/cli/brain-operations-capability.test.js tests/engine/core/chat-completions-client.test.js tests/engine/core/gpt5-client-complete.test.cjs tests/engine/core/unified-client-codex-oauth.test.cjs tests/cosmo23/codex-unified-client-request.test.cjs
```

Result: 34 tests passed, 0 failed.

```bash
node --test --test-concurrency=1 tests/engine/mcp/http-loopback.test.cjs tests/cosmo23/mcp-http-loopback.test.cjs tests/engine/mcp/memory-tools.test.js tests/engine/dashboard/mcp-availability.test.cjs tests/engine/dashboard/mcp-proxy-availability.test.cjs tests/cli/brain-operations-capability.test.js
```

Result: 41 tests passed, 0 failed.

```bash
node --test --test-concurrency=1 tests/engine/memory/network-memory-temporal.test.js tests/engine/dashboard/memory-search.test.js
```

Result: 23 tests passed, 0 failed.

```bash
node --test --test-concurrency=1 tests/engine/memory/network-memory-temporal.test.js tests/engine/dashboard/memory-search.test.js tests/engine/dashboard/brain-operation-authority.test.js tests/engine/dashboard/brain-operation-coordinator.test.js tests/engine/dashboard/brain-source-api.test.js tests/engine/dashboard/brain-source-executors.test.js tests/shared/memory-source-reader.test.js tests/shared/memory-source-graph.test.js
```

Result: 118 tests passed, 0 failed.

```bash
node --test --test-concurrency=1 tests/engine/agents/agent-executor-followups.test.js tests/engine/agents/agent-executor-metrics.test.js tests/engine/ingestion/document-feeder-policy.test.js tests/engine/cli-onboarding.test.js
```

Result: 19 tests passed, 0 failed.

Final repository verification:

```bash
npm run build
```

Result: passed.

```bash
npm test
```

Result: 837 tests passed, 0 failed.

```bash
npm run test:contracts
```

Result: 12 tests passed, 1 skipped, 0 failed.

Final post-live verification on the completed branch:

```bash
npm run build
npm run test:contracts
npm test
```

Result: build passed; contracts passed 36 with one intentional live-contract skip; every registered repository test batch passed with zero failures. The final modified coordinator, PGS/store, live-smoke, and guarded-PM2 suites passed 267/267 together, followed by the final guarded-PM2 regression suite at 58/58.

## Live acceptance

Receipt run: `/Users/jtr/_JTR23_/release/home23/runtime/brain-acceptance/04535539-6892-460a-bead-27477b09b04d` (`authority=live`, mode `0700`).

- Provider probing passed for the exact direct-query, PGS sweep, and PGS synthesis pairs.
- Jerry direct Query `brop_ub_r2HpWvuoBvWpc-O1hOU8bwZZZSwwk` completed with a 1,349-byte answer and validated provider terminal evidence over the operation stream. Its pinned source reported 141,669 nodes and 463,259 edges.
- Frozen Jerry canary search `brop_HQ3Wp5JoWrjBJOfF9fh5zYxqFuNstlco` crossed the authoritative source at revision `897536144096813` and found node `545452`.
- Large Jerry PGS `brop_JeG41Ma-bOygMWdsj4qKC3YMgWAeDdUu` returned a truthful useful partial for `sweepFraction=0.001`: one successful `gpt-5.4-mini` sweep, 2,647 pending units, a 2,667-byte `gpt-5.5` synthesis, exact frozen source totals of 141,679 nodes and 463,305 edges, fresh progress timestamps, and validated provider terminal evidence.
- Jerry discovered Forrest's canary at source revision `3320450366665203`, then sibling Query `brop_5yjXwmifWE2wf3XFu10ZZxITxCpsmq5O` completed against Forrest's canonical brain with `accessMode=read-only`, a 1,894-byte answer, and validated provider terminal evidence. The target tree remained protected by the same read-only authority tested in the automated mutation suites.
- The exact nine Home23 PM2 rows are online, stable across the delayed readback, and match generated ecosystem script/cwd authority. Jerry/Forrest dashboards, engines, harnesses, MCP services, catalogs/readiness, and COSMO status all passed live HTTP checks; COSMO was healthy-idle and both requester stores ended with zero nonterminal operations.
- Final guarded PM2 dry-run transaction `be332720-33cd-422c-87bc-20111603efb2` and apply transaction `490086e2-8119-4f3a-8b4d-7fce56b3119e` both committed. The final apply invoked `pm2 save`, reloaded ecosystem authority, revalidated immediately before save, froze PM2 modules and all unrelated rows, retained an exclusive backup, and produced dump SHA-256 `fe79305d399b23d5bc3916c9188b50f6f6e01842ffc06d6b30e38667f36b7f3c`.
- A redundant direct save was detected after the first guarded apply and was not accepted as final authority. The fresh guarded pair above immediately superseded it from the then-current dump with new retained backups and exact post-save readback.
- Final `brain-operations prepare --dry-run` reported `liveEnvVerified=true`, `restartRequired=false`, and `changedProcessNames=[]` with no filesystem or permission changes required.

## Operational notes

- Portable source and tests are committed; ignored installation state and private acceptance artifacts remain local.
- The live checkout's pre-existing dirty state was preserved. Deployment changed only the scoped Home23 implementation files/build output and exact named PM2 rows; unrelated work and PM2 processes were not removed or reset.
- The requirement to avoid treating zero as proof of an empty brain is enforced by source evidence, complete-coverage requirements, watermarks, unavailable envelopes, base-plus-delta tests, stale ANN canaries, MCP unavailable-source tests, and live canary crossing proof.
