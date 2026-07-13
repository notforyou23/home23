# Step 16: Agent COSMO Research Toolkit

**Original date:** 2026-04-10

**Current contract:** 2026-07-12
**Status:** Implemented through requester-bound durable brain operations

## Purpose

Home23 agents can inspect completed research, start and manage requester-owned COSMO runs, and compile bounded results without bypassing the durable brain-operation authority. Tool schemas are mechanism; `workspace/COSMO_RESEARCH.md` contains the usage policy loaded into agent context.

The original v1 tools called COSMO HTTP routes directly. That transport is deprecated. Current tools use the turn-scoped `BrainOperationsClient`, requester-derived authorization, durable operation IDs, bounded reads, and protected result/export paths.

## Current inventory

| Tool | Durable operation or authority | Purpose |
|---|---|---|
| `research_runs_list` | requester research-run catalog | discover exact active/recent run IDs and states |
| `research_list_brains` | canonical brain catalog | list resident and completed research brains |
| `research_query_brain` | `query` or `pgs` | query one exact completed research brain |
| `research_search_all_brains` | bounded parallel `query` | Direct Query over up to 20 completed brains; PGS is intentionally unsupported |
| `research_launch` | `research_launch` | start one requester-owned durable run |
| `research_continue` | `research_continue` | continue one exact requester-owned continuable run |
| `research_stop` | `research_stop` | stop and wait for one exact stoppable run |
| `research_watch_run` | `research_watch` | read a bounded cursor-paginated run log |
| `research_get_brain_summary` | `research_intelligence` | read selected bounded intelligence sections |
| `research_get_brain_graph` | `graph` | read a bounded graph sample |
| `research_compile_brain` | `research_compile` | compile a bounded pinned brain projection into requester output |
| `research_compile_section` | `research_compile` | compile one exact goal, insight, or agent section |

## Query contract

Direct research queries default to `quick` and accept `quick`, `full`, `expert`, or `dive`, plus an optional exact `{provider, model}` pair.

Single-brain PGS uses the same named contract as `brain_query` and launches detached immediately from agent tools:

- cumulative levels: `skim` 10%, `sample` 25%, `deep` 50%, `full` 100%;
- modes: `fresh`, `continue`, `targeted`;
- exact `pgsSweep` and `pgsSynth` provider/model pairs;
- `continueFromOperationId` for continuation;
- canonical `targetPartitionIds` from `brain_pgs_partitions` for targeted work.

Targeted levels apply to the cumulative union of named partitions. Use `full` when every work unit in those partitions must run. A targeted continuation includes all earlier target IDs and adds new IDs; successful prior units are reused and the scope cannot shrink.

PGS rejects Direct Query fields, including `mode`, `modelSelection`, and `priorContext`. A scoped result proves only its requested scope. Only `fullCoverage:true` supports a graph-wide absence claim.

`research_search_all_brains` is direct-only because one continuation lineage or partition list cannot be valid across unrelated brains.

## Run lifecycle

Before launch, call `research_runs_list {state:"active"}` and inspect existing brains. Research launch, continue, stop, and compile may remain attached for up to six hours. A single-brain PGS call returns its `brop_...` operation ID immediately; use `brain_status` status/result later. `wait` is an explicit blocking reattachment, Chat Stop only detaches durable work, and only the exact cancel action stops the operation.

The live `[COSMO ACTIVE RUN]` prompt block is derived from canonical requester-owned run metadata, not from whether the short launch operation record is still nonterminal.

Exact run states:

- active/stoppable: `starting`, `active`, `stopping`;
- continuable: `paused`, `failed`, `completed`;
- terminal/non-continuable: `stopped`.

Run-control tools require the exact `runId` returned by `research_runs_list`. They never infer a run from a topic or brain display name.

## Compile and ingestion

Compile output is durable requester-owned workspace output under `workspace/research/`. Fresh-install feeder defaults include that directory, so completed compile artifacts are eligible for ingestion.

`research_compile_brain` is bounded by the pinned compile limits (currently 2,000 nodes, 8,000 edges, and 8 MiB). It is not an unlimited whole-brain dump. Prefer `research_compile_section` for focused durable knowledge that clusters cleanly.

## Safety and failure semantics

- Resident and completed-research reads are requester-authorized and read-only.
- Research launch/continue/stop write only within the requester-owned run boundary.
- Unknown, ambiguous, cross-owner, active-brain read, or invalid-state targets fail closed.
- Tool failures remain errors; per-brain failures in search-all are retained rather than converted to no findings.
- Direct COSMO/dashboard route fallback is forbidden because it loses authorization, source pins, durable receipts, and reattachment.
- Fixed sleeps are forbidden. Wait on durable activity or reattach by exact operation ID.

## Verification authority

Executable schemas and focused regressions live in:

- `src/agent/tools/research.ts`
- `src/agent/brain-operations/client.ts`
- `tests/agent/tools/research.test.ts`
- `tests/agent/brain-operations-client.test.ts`
- `cli/templates/COSMO_RESEARCH.md`

When this document and executable schemas differ, the discrepancy is a contract bug and must be resolved; neither surface is allowed to remain silently stale.
