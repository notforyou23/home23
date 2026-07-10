# Brain Tools Hardening Receipt

Date: 2026-07-10  
Design: `docs/superpowers/specs/2026-07-09-brain-operations-reliability-design.md`  
Branch: `codex/brain-operations-reliability`  
Scope: Brain Operations Reliability and Cross-Brain Read implementation through Task 9.

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

## Operational notes

- This branch changes portable source, tests, docs, and examples only. Runtime state under ignored installation paths remains local.
- Live PM2 mutation was not performed as part of this receipt. The implementation was verified through deterministic source, contract, focused, and full repository tests.
- A read-only live PM2 probe after push showed all listed Home23 processes online, but the currently deployed live COSMO process is not this branch and did not answer 5-second probes for `/`, `/api/health`, or `/api/status` on port 43210. That is live-runtime evidence that the old deployed bug class is still observable until the verified branch is deliberately applied/restarted.
- The final design requirement to avoid treating a zero result as proof of an empty brain is covered by source evidence, unavailable envelopes, base-plus-delta tests, stale ANN canaries, MCP unavailable-source tests, and read-only pinned source mutation tests.
