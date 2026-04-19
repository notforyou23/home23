# Brain Tools Rework + Research Run Storage Topology

**Date:** 2026-04-19
**Status:** Design (approved by jtr through Section 5, awaiting spec review)
**Author:** Claude + jtr
**Related:** `docs/design/STEP16-AGENT-COSMO-TOOLKIT-DESIGN.md`, `docs/design/COSMO23-VENDORED-PATCHES.md`, `docs/design/STEP9-COSMO23-INTEGRATION-DESIGN.md`

## Summary

The agent's `brain_*` tools were built against an older version of the cognitive-query API and now speak a different dialect than the dashboard's Query tab. They call engine-local endpoints (`/api/query`, `/api/pgs`) with outdated parameter shapes, cannot invoke the dashboard's new depth chips, synthesis toggles, or follow-up workflows, and are missing entirely the four dashboard endpoints (`followup`, `executive-view`, `export`, `ai-review`). The four parallel endpoints on the engine-dashboard server (`/api/query/followup`, `/api/query/executive-view`, `/api/query/export`, `/api/query/ai-review`) turned out to be legacy — not actually used by the tab. The tab uses three cosmo23 routes: `/query`, `/query/stream`, `/export-query`. Follow-up is state on the tab, not an endpoint.

Meanwhile, `research_launch` creates runs inside `cosmo23/runs/` where agents cannot see them and the feeder cannot ingest them.

This design brings both surfaces into alignment. The dashboard Query tab becomes the canonical protocol: its payload shape, its endpoints, its vocabulary. Agent tools become thin wrappers over `${brainRoute}/<op>` — the same URLs the tab hits. Research runs relocate to `instances/<agent>/workspace/research-runs/<runName>/` with a symlink back to `cosmo23/runs/<runName>` so cosmo23 still finds them by its usual path. Feeder picks up research output automatically because it's inside the agent's workspace.

## Goals

- Close the protocol drift between agent `brain_*` tools and the dashboard Query tab
- Give agents access to every query capability the dashboard tab actually exposes (depth chips, synthesis, PGS toggle, follow-up via `priorContext`, export)
- Lock the tool↔dashboard protocol together with a regression test so future drift is caught in CI
- Make research runs visible to their launching agent and ingestible by the feeder
- Preserve backward compatibility for cosmo23 CLI/direct launches and for existing runs on disk

## Non-goals

- Changing the engine's `/api/query` or `/api/pgs` endpoints (leave them for any legacy callers)
- SSE streaming in `brain_query` tool — non-streaming is fine for agent use
- Reworking the other ten `research_*` tools (only `research_launch` changes)
- Windows support for symlink creation
- Relocating non-run content out of `cosmo23/`

## Architecture

### Core idea

The dashboard Query tab is the source of truth for what "the query system can do." Agent tools become thin wrappers over the same cosmo23 brain-API that the tab calls. One protocol. One vocabulary. Adding a toggle to the UI automatically unlocks it for agents.

### Mechanism

`ToolContext` (harness-side) gains four new fields:

```ts
interface ToolContext {
  // ...existing (enginePort, dashboardPort, etc.)
  agentName: string;        // HOME23_AGENT
  brainRoute: string;       // http://localhost:43210/api/brain/<brainId>
  cosmo23BaseUrl: string;   // http://localhost:43210
  workspacePath: string;    // /abs/path/to/instances/<agent>/workspace
}
```

Every brain tool POSTs to `${brainRoute}/<op>` with the dashboard's exact payload shape. `research_launch` uses `workspacePath` to compute `runRoot` before calling cosmo23.

## Tool Surface

### Kept as-is

Independent endpoints, no dashboard drift:

- **`brain_search`** — semantic search on memory nodes (`/api/memory/search` on engine)
- **`brain_memory_graph`** — graph structure summary (`/api/memory` on engine)
- **`brain_status`** — node count / cycle / health (`/api/state` on engine)
- **`brain_synthesize`** — meta-cognition run/status (`/api/synthesis/*` on engine)

### Reworked

**`brain_query`** — new payload mirrors the dashboard Query tab exactly:

```ts
{
  query: string;
  model?: string;                   // any model from cosmo23 catalog
  mode?: 'full' | 'expert' | 'dive';      // default 'full'
  enableSynthesis?: boolean;
  includeOutputs?: boolean;
  includeThoughts?: boolean;
  includeCoordinatorInsights?: boolean;
  allowActions?: boolean;
  enablePGS?: boolean;
  pgsMode?: string;                 // default 'full'
  pgsConfig?: { sweepFraction: 0.10 | 0.25 | 0.50 | 1.0 };
  pgsFullSweep?: boolean;           // derived from sweepFraction >= 1.0
  pgsSweepModel?: string;
  pgsSynthModel?: string;
  priorContext?: { query: string; answer: string };   // for follow-up
}
```

Endpoint: POST `${brainRoute}/query`. Non-streaming. The legacy 9 modes (`fast/normal/deep/raw/report/innovation/consulting/grounded/executive`) are dropped — dashboard uses three, agents use three.

### Removed

**`brain_pgs`** — merged into `brain_query` as `enablePGS: true`. Matches how the dashboard treats PGS (a checkbox, not a separate button). Single mental model for agents. Grep + replace in identity/skill files is a one-liner.

### Added

One new tool — the only sub-operation the tab actually hits beyond the base query:

- **`brain_query_export`** — `{ query, answer, format: 'markdown' | 'json', metadata? }` → POST `${brainRoute}/export-query`. Writes formatted file to the brain's export dir.

Follow-up is handled in-band on `brain_query` via the optional `priorContext` field — no separate tool, matching how the tab's "Follow-up" button just flips state for the next query.

**Deliberately not added** (endpoints exist on the engine-dashboard server but are not used by the tab):

- `/api/query/followup`, `/api/query/executive-view`, `/api/query/ai-review` — parallel legacy surfaces. If agents ever demonstrate need, can be added later; no point preemptively wiring UI-dead endpoints as tools.

**Net:** 6 tools → 6 tools (clean swap). Simpler system prompt, less clutter. PGS is a flag, not a tool.

## Research Run Storage Topology

### Today

`research_launch` calls cosmo23, which creates a run at `cosmo23/runs/<runName>/` containing the run's brain dir, thought logs, coordinator state, exports. Problems:

- Agent never sees the run in its own workspace
- Feeder doesn't ingest it (cosmo23 isn't a feeder watch path)
- Agent must call `research_compile_brain` to get a summary back into its workspace — manual, lossy
- When jtr reorganizes brains later, everything inside cosmo23/ gets left behind

### Proposed

```
instances/<agent>/workspace/research-runs/<runName>/     ← real run dir (primary)
cosmo23/runs/<runName>                                    ← symlink back to primary
```

Research runs live in the launching agent's workspace. cosmo23's runs directory gets a symlink alias so cosmo23 (and any other consumer) still resolves `<runName>` by the path it expects.

### How cosmo23 finds the right workspace (COSMO23 Patch 7)

`research_launch` (harness-side) computes `runRoot = ${workspacePath}/research-runs/${proposedRunName}` and includes it in the launch POST body. cosmo23's launch endpoint accepts an optional `runRoot` parameter:

- If `runRoot` is present → create the run dir at that path, then `fs.symlink(runRoot, cosmo23/runs/<runName>)`
- If `runRoot` is absent (cosmo23 CLI, direct dashboard launch, anything not owner-aware) → fall back to current behavior (create at `cosmo23/runs/<runName>`)

If symlink creation fails (perms, existing path conflict), cosmo23 logs a warning but the run proceeds — the real dir exists at `runRoot`, only cosmo23's alias is missing for that specific run.

macOS/Linux only for v1.

### Ownership record

Each run writes `run.json` in its root with `{ owner: "<agent>", createdAt, topic }`. Future tools and the relocation script use this to reason about runs without prompting.

### Backward compat for existing runs

If `cosmo23/runs/<runName>` already exists as a regular directory (not a symlink), cosmo23 leaves it alone. Only new launches go through the new path. Existing runs are migrated opt-in via the relocation script (below).

### Feeder implications

`instances/<agent>/workspace/research-runs/**/*.md` is already inside the agent's workspace, which the feeder watches recursively. Research markdown flows into the agent's brain automatically.

**Feeder exclusion patterns** (added to `configs/base-engine.yaml feeder.exclusionPatterns`):

- `**/research-runs/*/brain/**` — don't ingest raw brain state as brain nodes (recursion noise)
- `**/research-runs/*/*.jsonl` — cycle logs and thought JSONL are operational, not brain content

Only research markdown/docs get ingested.

### Brain discovery

No change — evobrew and cosmo23 already discover brains across agent workspaces and external roots. Relocated runs' brains remain visible in pickers.

## Plumbing

### brainRoute resolution (harness startup)

In `src/agent/init.ts` or equivalent bootstrap:

1. Read `HOME23_AGENT` → `agentName`
2. Read `cosmo23.port` from `config/home.yaml` (default `43210`)
3. GET `${cosmo23BaseUrl}/api/brains` → list of brains
4. Match the brain where `brain.root === instances/<agent>/brain` OR `brain.name === agentName` (mirror cosmo23's brain-registry matching rules)
5. Cache `brainRoute`; retry twice on startup failure before failing hard
6. If no match: harness logs a clear warning and boots anyway. All brain tools return `is_error: true` with the message:

   > `Agent brain not registered in cosmo23 — is ${agentName} running and has cosmo23 indexed it? Try curl ${cosmo23BaseUrl}/api/brains to verify.`

### workspacePath resolution

Already known — `instances/${agentName}/workspace` relative to repo root. Harness exposes it on `ToolContext`.

### research_launch → runName + runRoot

The tool computes both name and path up front so cosmo23 and the filesystem agree on what to call the run:

```ts
const runName = proposedRunName ?? generateRunName(topic);   // e.g. "sauna-hrv-correlation-20260419-143022"
const runRoot = path.join(ctx.workspacePath, 'research-runs', runName);
```

Sends `{ topic, runName, runRoot, ... }` in the launch POST body. cosmo23 uses `runName` as the canonical identifier (for status, API lookups, symlink name) and `runRoot` as the filesystem location. If both are omitted, cosmo23 generates a runName itself and creates the run at `cosmo23/runs/<runName>` (legacy).

## Data Flow Examples

### brain_query with PGS

```
Agent: brain_query({ query: "what do we know about sauna health data?",
                     enablePGS: true,
                     pgsConfig: { sweepFraction: 0.25 } })
  ↓
Tool: POST ${brainRoute}/query
       { query, enablePGS: true, pgsConfig: { sweepFraction: 0.25 },
         pgsFullSweep: false, mode: "full", ... }
  ↓
cosmo23 routes to PGS engine, sweeps 25% of partitions, synthesizes
  ↓
Returns { answer, evidence, metadata: { models, pgsPartitions, ... } }
  ↓
Tool formats: "<answer>\n\n---\n[12 evidence nodes · PGS: 7/28 partitions swept · sweep=MiniMax-M2.7-highspeed / synth=claude-opus-4-7]"
```

### research_launch

```
Agent: research_launch({ topic: "longitudinal sauna + HRV correlation" })
  ↓
Tool: computes runName = "sauna-hrv-correlation-20260419-143022"
      computes runRoot = "/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/research-runs/sauna-hrv-correlation-20260419-143022"
      POST ${cosmo23BaseUrl}/api/launch { topic, runRoot, ... }
  ↓
cosmo23: mkdir -p <runRoot>
         fs.symlink(runRoot, 'cosmo23/runs/sauna-hrv-correlation-20260419-143022')
         writes run.json { owner: "jerry", ... }
         starts research process with runDir = runRoot
  ↓
Returns { runName, topic, startedAt, ... }
  ↓
Feeder sees new files appear in instances/jerry/workspace/research-runs/.../
         → ingests *.md files
         → skips brain/ and *.jsonl per exclusion patterns
```

## Error Handling

- **brainRoute unresolved** → tool returns `is_error: true` with cosmo23 verification hint
- **HTTP 4xx/5xx** → tool returns the engine's error body (truncated to 500 chars) with HTTP code
- **Timeout** → 30 min for `brain_query` with PGS enabled, 2 min otherwise; on timeout tool returns a message including the PGS depth as context
- **Missing required field** → synchronous schema error before the HTTP call
- **Symlink creation failure** (research_launch) → run proceeds, cosmo23 logs warning, tool result notes "alias not created" in metadata
- **runRoot collision** (rare — someone manually created that dir) → cosmo23 refuses, returns error, agent gets a clear message and can retry with a different runName

## Testing

### Unit tests (TS, harness)

One test per reworked/new brain tool. Mock `ToolContext` with fixture `brainRoute`. Mock `fetch`. Assert:

- POST body matches the dashboard's exact payload shape (field-by-field, pinned as fixture)
- Response is parsed and surfaced with expected fields

The payload-shape assertion is the regression guard. If the dashboard changes a field and the tool doesn't, the test fails.

### Integration smoke (Node script)

`scripts/smoke-brain-tools.js` runs against live jerry:

- One call per tool
- Assert non-error result + presence of expected response fields
- Total runtime ~5 min including one PGS run

Run before every deploy that touches brain tools.

### Cosmo23 patch tests

Add to `cosmo23/server/lib/brains-router.test.js` (or the run-launch test file):

- POST with `runRoot` → dir created at that path + symlink at `cosmo23/runs/<runName>`
- POST without `runRoot` → legacy behavior preserved (dir at `cosmo23/runs/<runName>`, no symlink)
- Symlink failure → run still created, warning logged, no crash

## Migration

1. **Deploy together:** harness changes + cosmo23 Patch 7 land in the same release. Restart both.
2. **Relocation script** (`cli/lib/relocate-research-runs.js`, interactive):
   - Walks `cosmo23/runs/`
   - For each regular dir (not symlink), asks which agent owns it
   - On confirm: moves dir into `instances/<owner>/workspace/research-runs/<runName>`, creates symlink at original path, writes `run.json`
   - Skippable per-run
3. **Skill/identity file grep** — one-shot:
   - `instances/*/workspace/*.md` + `cli/templates/COSMO_RESEARCH.md`
   - Replace `brain_pgs` references with `brain_query` + `enablePGS: true` note
4. **24-hour verification:**
   - Tail event ledger for `tool_call` events with `brain_pgs` (expected: zero after the skill grep)
   - Tail for `brain_query` `tool_error` events (expected: zero in normal operation)
   - Clean 24h = migration done

## Rollback

**Brain tool rework:** pure harness. Revert `src/agent/tools/brain.ts` + `src/agent/context.ts` (or wherever ToolContext lives) + rebuild + restart harness. Zero data risk.

**Cosmo23 Patch 7:** additive — `runRoot` parameter is optional with a sensible default. Reverting just means new runs go back to `cosmo23/runs/<runName>` as regular dirs. Existing relocated runs keep working via the symlink regardless.

**Full rollback:** revert both, run the relocation script in reverse (move each symlinked dir back to `cosmo23/runs/`). But the script isn't built unless we need it — the asymmetry favors forward progress.

## COSMO23 Patch 7 (to be added to `COSMO23-VENDORED-PATCHES.md`)

**Patch 7: `runRoot` parameter on research-run launch + symlink alias**

- **File:** `cosmo23/server/lib/` (whichever module owns run creation — likely `hub-routes.js` or a run-service module)
- **Change:** launch endpoint accepts optional `runRoot` in POST body. When present:
  - `mkdir -p <runRoot>`
  - `fs.symlink(runRoot, path.join(cosmo23RunsDir, runName))` — failures logged, not fatal
  - Run process uses `runRoot` as its `runDir`
- **When absent:** legacy behavior (create at `cosmo23RunsDir/<runName>`, no symlink)
- **Why:** agent workspace is the durable home for research runs; cosmo23 provides the alias so existing callers continue to work
- **Must survive upstream resync**

## Open Questions (for implementation plan phase)

- Where exactly is `ToolContext` constructed in the harness? Confirm during plan-writing so we know where `brainRoute` resolution hooks in.
- Exact cosmo23 module that owns run creation — `hub-routes.js` vs a dedicated service. Audit during Patch 7 implementation.
- Whether `brain_search`, `brain_memory_graph`, `brain_status`, `brain_synthesize` should also eventually migrate to cosmo23-routed equivalents or stay on the engine. Out of scope for this spec — revisit once the query-side rework is stable.
