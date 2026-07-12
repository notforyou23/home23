# Brain Tool Contract Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Home23 brain surface truthful, self-describing, and consistent: agents and Query use the same direct/PGS contract, long work is discoverable and reattachable, research guidance matches runtime behavior, and MCP never reports invented empty state.

**Architecture:** The durable brain-operation coordinator remains the authority. Agent tools and Query are validated adapters over that authority; PGS is a named mode of `brain_query`, not a separate tool. Discovery tools expose only requester-authorized catalog, operation, research-run, model, and partition metadata. MCP remains an own-brain read-only diagnostic surface unless a capability is explicitly backed by the canonical source.

**Tech Stack:** TypeScript, Node.js/CommonJS, JSON Schema, Express, MCP JSON-RPC, `node:test`, PM2-scoped live verification.

## Global Constraints

- Preserve all existing working-tree changes and local runtime state. Never discard, overwrite, or broadly clean the checkout.
- `brain_pgs` remains removed. Its complete replacement is `brain_query` with `enablePGS:true`, `pgsMode`, `pgsLevel`, exact sweep/synthesis pairs, durable operation IDs, and continuation.
- PGS levels are cumulative targets: `skim` 10%, `sample` 25%, `deep` 50%, `full` 100%. Continuation reuses successful prior sweeps and may only expand coverage; targeted continuation may only add canonical partitions.
- A fractional or targeted scope may prove its requested scope complete; only `fullCoverage:true` supports a graph-wide absence claim.
- Direct-only parameters (`mode`, `modelSelection`, synthesis/output/action flags, `priorContext`, `topK`) are rejected when PGS is enabled. `priorContext` is direct-query-only and limited to 20,000 characters combined.
- Exact provider/model pairs are authoritative. Never infer a provider from model ID alone.
- Durable operations may detach without failing. Agents must retain or rediscover the `brop_...` ID and use wait/result/cancel controls.
- Cross-brain reads remain requester-authorized and read-only. Synthesis remains own-brain-only.
- MCP tools return explicit `unsupported`/`degraded` state when the canonical runtime cannot supply a field; absence of a projection must never become a false zero.
- Use TDD for behavior changes: add a focused failing regression, confirm the expected failure, implement minimally, then rerun the focused suite.
- Do not run broad PM2 commands. Restart only named affected Home23 processes after all static tests pass.

---

### Task 1: Agent schemas and PGS usage doctrine

**Files:**
- Modify: `src/agent/tools/brain.ts`
- Modify: `src/agent/tools/research.ts`
- Modify: `src/agents/system-prompt.ts`
- Modify: `tests/agent/tools/brain.test.ts`
- Modify: `tests/agent/tools/research.test.ts`

**Interfaces:**
- Consumes: existing durable `BrainOperationsClient` methods.
- Produces: model-visible JSON Schemas whose accepted combinations exactly equal runtime validation, plus one canonical prompt section describing direct versus PGS use.

- [ ] Add failing schema tests proving every PGS/direct-only conflict is rejected, action-specific status/export/graph/synthesis shapes are enforced, and combined prior context cannot exceed 20,000 characters.
- [ ] Run `npx tsx --test tests/agent/tools/brain.test.ts tests/agent/tools/research.test.ts` and confirm those new assertions fail for the missing schema constraints.
- [ ] Replace loose conditionals with exact `oneOf`/`allOf` shapes, remove the no-op `resultHandle` export input, and make search-all direct-only.
- [ ] Consolidate brain guidance in `system-prompt.ts`: when to use direct query, each PGS level, fresh/continue/targeted, scope-vs-global evidence, operation reattachment, and the prohibition on direct route bypass.
- [ ] Rerun the focused tests and require zero failures.

### Task 2: Research-run truth and compile behavior

**Files:**
- Modify: `src/agent/tools/research.ts`
- Modify: `cli/templates/COSMO_RESEARCH.md`
- Modify: `cli/lib/agent-config-builder.cjs`
- Modify: `docs/design/STEP16-AGENT-COSMO-TOOLKIT-DESIGN.md`
- Test: `tests/agent/tools/research.test.ts`
- Test: matching CLI/config tests under `tests/cli/`

**Interfaces:**
- Consumes: requester-owned durable research-run adapter and `workspace/research/` output writer.
- Produces: active-run discovery based on run state, honest bounded-compile wording, and fresh-install feeder coverage for compiled artifacts.

- [ ] Add failing tests for a terminal launch operation whose underlying run remains active, `includeReferences:false` retaining resident brains, search-all rejecting PGS continuation/targeting, and `workspace/research` appearing in generated feeder paths.
- [ ] Run the focused research/config tests and confirm expected failures.
- [ ] Query the research-run adapter rather than operation terminal state, preserve resident brains when references are hidden, and update seeded instructions to describe bounded compile plus durable detach/reattach.
- [ ] Add `workspace/research` to public fresh-install feeder defaults without changing local runtime data.
- [ ] Rerun focused tests and require zero failures.

### Task 3: Query facade, UI, and legacy compatibility

**Files:**
- Modify: `contracts/schemas/query.schema.json`
- Modify: `engine/src/dashboard/home23-query-api.js`
- Modify: `engine/src/dashboard/home23-query.js`
- Modify: `engine/src/dashboard/client-capabilities.js`
- Modify: `engine/src/dashboard/server.js`
- Modify or retire: `engine/src/dashboard/query.html`
- Test: `tests/contracts/query-facade-route.test.cjs`
- Test: `tests/engine/dashboard/home23-query-client.test.cjs`

**Interfaces:**
- Consumes: the four-mode durable query resolver and durable export route.
- Produces: one accepted mode set (`quick`, `full`, `expert`, `dive`), exact PGS shapes, truthful streaming capability, and one unambiguous export contract.

- [ ] Add failing tests proving every facade-accepted mode normalizes successfully, invalid compatibility modes are rejected before operation creation, the legacy export caller cannot hit a shadowed incompatible route, and streaming capability matches the catalog.
- [ ] Run focused Query tests and confirm expected failures.
- [ ] Remove the nine unsupported modes from facade/schema, eliminate the duplicate legacy export registration or migrate its caller, enforce 20,000 combined prior context, and label export as workspace export rather than brain mutation.
- [ ] Remove model-ID-only provider fallback; display a typed configuration error when an exact pair is unavailable.
- [ ] Rerun focused Query tests and require zero failures.

### Task 4: Truthful MCP memory surface

**Files:**
- Modify: `shared/memory-source/mcp-http-runtime.cjs`
- Modify: `shared/memory-source/mcp-tools.cjs`
- Modify: `engine/mcp/http-server.js`
- Modify: `engine/mcp/stdio-server.js`
- Modify: `engine/mcp/claude_desktop_config_example.json`
- Add or modify focused MCP tests under `tests/engine/mcp/` or `tests/shared/`.

**Interfaces:**
- Consumes: canonical own-brain manifest reader.
- Produces: bounded own-brain read-only diagnostics with honest capability metadata; no false zero for unavailable goals, journal, dreams, agent activity, or oscillator state.

- [ ] Add failing tests proving unavailable snapshot fields return typed unsupported/degraded results, graph schema matches handler controls, and setup examples name real entrypoints.
- [ ] Run the focused MCP tests and confirm expected failures.
- [ ] Make unsupported projections explicit, align graph arguments and descriptions, and mark legacy stdio as deprecated unless it uses the same canonical runtime.
- [ ] Document that MCP is own-brain diagnostics only; direct/cross-brain/PGS work belongs to durable brain operations.
- [ ] Rerun focused MCP tests and require zero failures.

### Task 5: Missing discovery tools

**Files:**
- Modify: `src/agent/brain-operations/client.ts`
- Modify: `src/agent/brain-operations/types.ts`
- Modify: `src/agent/tools/brain.ts`
- Modify: `src/agent/tools/research.ts`
- Modify: `src/agent/tools/index.ts`
- Modify: coordinator/catalog routes only where existing authority does not expose the bounded data.
- Test: `tests/agent/brain-operations-client.test.ts`
- Test: `tests/agent/tools/brain.test.ts`
- Test: `tests/agent/tools/research.test.ts`

**Interfaces:**
- Produces: `brain_catalog`, `brain_operations_list`, `brain_pgs_partitions`, and `research_runs_list`/status semantics, all requester-authorized and bounded.

- [ ] Add failing tests for model/catalog exact pairs, requester-owned recent/nonterminal operations, canonical PGS partition IDs and estimates, and active/completed research-run listing.
- [ ] Run focused client/tool tests and confirm expected failures.
- [ ] Implement bounded read-only discovery adapters over existing authorities; do not accept paths or caller-supplied requester identity.
- [ ] Register the tools and update prompt guidance so agents discover IDs/pairs before invoking targeted or long operations.
- [ ] Rerun focused tests and require zero failures.

### Task 6: Public docs, local Jerry instructions, and portable maintenance

**Files:**
- Modify: `README.md`
- Modify: `docs/MANIFEST.md`
- Modify: `scripts/rebuild-ann-indexes.sh`
- Modify local ignored files: `instances/jerry/workspace/SOUL.md`, `instances/jerry/workspace/cron-prompts/weekly-deep-dive.md`
- Test: `tests/scripts/rebuild-ann-indexes.test.cjs`
- Add a contract-doc regression test that scans active/public instructions for removed `brain_pgs`, raw public `sweepFraction`, fixed sleeps, and direct-route bypass.

**Interfaces:**
- Produces: accurate tool inventory and PGS usage examples for public installs and the active Jerry agent.

- [ ] Add failing scans proving active instructions contain no removed command or raw public fraction, and ANN rebuild discovers configured agents rather than hardcoding Jerry/Forrest.
- [ ] Run the focused doc/script tests and confirm expected failures.
- [ ] Replace stale examples with named levels/modes and continuation examples; explain that `brain_pgs` was merged into `brain_query`, not removed as a capability.
- [ ] Make ANN rebuild use configured instance discovery plus explicit bounded selectors.
- [ ] Rerun focused tests and require zero failures.

### Task 7: Integrated verification and scoped live rollout

**Files:**
- Modify: `docs/receipts/2026-07-12-brain-tool-contract-cleanup.md`

**Interfaces:**
- Consumes: all preceding task outputs plus the existing PGS-session cleanup change.
- Produces: exact automated and live evidence, then a scoped restart/commit/push.

- [ ] Run all focused suites changed above, `npm run build`, `npm run test:contracts`, and `npm test`; record exact pass/fail counts.
- [ ] Run instruction scans and the live brain-tool smoke with waits configured for the production attachment windows.
- [ ] Verify no active durable operation or research run would be interrupted, then restart only `home23-jerry-harness`, `home23-jerry-dash`, `home23-jerry`, and the exact MCP processes whose loaded code changed.
- [ ] Verify dashboard, Chat, Query catalog/direct query, PGS preflight/fractional continuation, operation listing/reattach, research-run listing, and MCP own-brain status with live receipts.
- [ ] Inspect the complete diff, preserve ignored runtime files, commit the verified combined work intentionally, pull/reconcile the 23 remote commits without deleting local work, push, and verify remote readback.
