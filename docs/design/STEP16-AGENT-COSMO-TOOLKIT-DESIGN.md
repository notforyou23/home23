# Step 16: Agent ↔ COSMO 2.3 Full Toolkit Design

**Date:** 2026-04-10
**Status:** Approved · implementation pending

## Summary

Expand jerry's interaction with COSMO 2.3 from the current 4-action `research`
tool into a proper **tool + skill** split covering COSMO's real API surface:

- **11 atomic tools** (`research_*` prefix) in `src/agent/tools/research.ts` —
  one per COSMO operation, each a thin HTTP wrapper with a focused schema.
- **1 skill file** at `instances/<agent>/workspace/COSMO_RESEARCH.md` — the
  when-and-why policy (workflow, mode selection, "always pass context", etc.),
  loaded into every turn's system prompt via the existing identity layer.
- **1 inline situational-awareness injection** in `src/agent/loop.ts` — polls
  `GET /api/status` at turn start; when a run is active, injects a live
  `[COSMO ACTIVE RUN]` block so jerry doesn't double-launch.

## Why tool + skill, not one mega-tool

- **Tools are mechanism** — atomic, side-effect-bearing HTTP calls. Stateless,
  composable, schema-constrained. They describe what each endpoint DOES, not
  when jerry should use it.
- **Skill is policy** — workflow, judgment calls, mode heuristics, "always
  pass context", "check existing brains before launching", "watch sparingly
  not every turn". This is behavior, not mechanism, and it evolves independently
  of the tool code.
- **Split matches existing pattern**: jerry already layers SOUL.md / MISSION.md /
  LEARNINGS.md on top of atomic tools. Adding COSMO_RESEARCH.md as a new
  identity-layer file slots in naturally with zero new infrastructure.
- **Policy without code churn**: editing a markdown file retrains jerry's
  behavior. Updating the tool code requires a rebuild + harness restart.

## Tool inventory — 11 tools, all v1

| Name | COSMO endpoint(s) | Purpose |
|---|---|---|
| `research_list_brains` | `GET /api/brains` | enumerate available research brains with metadata |
| `research_query_brain` | `POST /api/brain/:name/query` | query ONE brain with full mode control (quick/full/expert/dive) |
| `research_search_all_brains` | `GET /api/brains` + `POST /api/brain/:name/query` × top-N | query the top N most recent brains at once |
| `research_launch` | `POST /api/launch` | start a new run with full parameters: topic, **context**, depth, cycles, maxConcurrent, per-role models |
| `research_continue` | `POST /api/continue/:brainId` | resume a completed brain with new overrides |
| `research_stop` | `POST /api/stop` | stop the active run |
| `research_watch_run` | `GET /api/watch/logs?after=<cursor>` | cursor-paginated log tail during a run |
| `research_get_brain_summary` | `GET /api/brain/:name/intelligence/{executive,goals,trajectory,thoughts,insights}` | structured high-level brain overview |
| `research_get_brain_graph` | `GET /api/brain/:name/graph` | nodes/edges/clusters for structure inspection |
| `research_compile_brain` | `POST /api/brain/:name/query` + workspace write | whole-brain compile into `workspace/research/` |
| `research_compile_section` | `GET /api/brain/:name/intelligence/insight/:filename` (or goals/agents filter) + workspace write | compile ONE goal, insight, or agent's output — narrower than whole-brain |

All 11 implemented in v1 — no deferral. Graph and compile_section are
load-bearing for precise brain navigation; cutting them would force jerry to
always dump a whole brain when he only wants one thread.

## Schemas

### `research_list_brains`
```ts
{
  limit?: number;           // default 20
  includeReferences?: boolean; // default true
}
```
Returns: markdown list `[{id, name, nodeCount, cycleCount, mtime, source, topic}]`.

### `research_query_brain`
```ts
{
  brainId: string;           // required — from research_list_brains
  query: string;             // required
  mode?: 'quick'|'full'|'expert'|'dive';  // default 'full'
  includeThoughts?: boolean;           // default true
  includeCoordinatorInsights?: boolean; // default: true for expert/dive
}
```
Returns: synthesized response text (can be 5-30KB).

### `research_search_all_brains`
```ts
{
  query: string;     // required
  topN?: number;     // default 5
  mode?: 'quick'|'full'|'expert';  // default 'full'
}
```
Returns: per-brain findings, concatenated with headers.

### `research_launch`
```ts
{
  topic: string;              // required — focused, not "everything about X"
  context?: string;           // CRITICAL — framing, source preferences, scope, rails
  cycles?: number;            // default 20
  explorationMode?: 'guided'|'autonomous';  // default 'guided'
  analysisDepth?: 'shallow'|'normal'|'deep'; // default 'normal'
  maxConcurrent?: number;     // default 6
  primaryModel?: string;      // research/analysis agents
  primaryProvider?: string;
  fastModel?: string;         // coordinator/planner
  fastProvider?: string;
  strategicModel?: string;    // synthesis/QA
  strategicProvider?: string;
}
```
Returns: `{success, runName, brainId, cycles, dashboardUrl}` as markdown.

### `research_continue`
```ts
{
  brainId: string;   // required
  context?: string;  // new focus for the continuation
  cycles?: number;
  primaryModel?: string; primaryProvider?: string;
  // Other fields fall through to prior effectiveContinueSettings
}
```
Returns: same shape as launch.

### `research_stop`
```ts
{}   // no params — stops the single active run
```
Returns: confirmation or "no active run".

### `research_watch_run`
```ts
{
  after?: number;  // log cursor, default 0
  limit?: number;  // default 50
  filter?: 'all'|'errors'|'progress'|'cycles';  // default 'progress'
}
```
Returns: log entries with new cursor for follow-up calls. Active run state at top.

### `research_get_brain_summary`
```ts
{
  brainId: string;   // required
  include?: Array<'executive'|'goals'|'trajectory'|'thoughts'|'insights'>;
  // default: ['executive', 'goals', 'trajectory']
}
```
Returns: structured markdown pulling from `/api/brain/:name/intelligence/*` endpoints.

### `research_get_brain_graph`
```ts
{
  brainId: string;     // required
  clusterId?: string;  // filter to one cluster
  minWeight?: number;  // filter edges by weight
  limit?: number;      // max nodes returned (default 100 to control context size)
}
```
Returns: `{clusters: [...], nodes: [...], edges: [...]}` as structured markdown +
summary counts. Does NOT embed full embeddings.

### `research_compile_brain`
```ts
{
  brainId: string;  // required
  focus?: string;   // optional prompt override (default: comprehensive summary)
}
```
Returns: workspace path + summary preview. Writes to
`instances/<agent>/workspace/research/cosmo-<runId>-<date>.md`. Engine feeder
auto-ingests.

### `research_compile_section`
```ts
{
  brainId: string;               // required
  section: 'goal'|'insight'|'agent';  // required — which kind of slice
  sectionId: string;             // required — goalId, insight filename, or agentId
  focus?: string;                // optional query override
}
```
Returns: workspace path + summary preview. File named
`cosmo-<runId>-<section>-<sectionId>-<date>.md` so multiple sections from one
run don't collide.

## Skill file — `instances/<agent>/workspace/COSMO_RESEARCH.md`

New identity-layer file, ~2000-2500 chars (hard cap in `context.ts`). Content:

```markdown
# COSMO Research Skill

You have access to COSMO 2.3 — a deep research engine that runs multi-agent
orchestration with LLM providers to build knowledge brains. Use it when a
question needs real investigation beyond what's already in your own brain.

## Core workflow

1. **Check existing brains first.** Use `research_list_brains` to see what you
   already have. Use `research_search_all_brains` to query the top few for your
   question. If an existing brain already answers it, don't re-launch.

2. **Frame before you launch.** `research_launch` takes TWO critical fields:
   - `topic`: focused, specific. "Cosine similarity in semantic search" not
     "everything about embeddings"
   - `context`: WHY you're researching, what sources are acceptable, scope,
     depth, any rails. **Do not skip this.** Without it, COSMO's guided planner
     invents framing from model priors and builds over-prescriptive plans.
     A good context paragraph: "I need a one-page primer for a user who knows
     linear algebra. Wikipedia + primary docs are fine. 5 cycles, normal depth.
     No deep academic sourcing needed."

3. **Sizing**: 5-10 cycles for a primer, 20-40 for a real investigation,
   60-80 for a deep dive. `maxConcurrent: 6` is a good default.

4. **Watch sparingly.** `research_watch_run` is for checking progress, not
   for tailing every turn. Check every 2-3 turns or when you think the run
   should be done. Don't spam it.

5. **Query modes**:
   - `quick` — fast overview, small token budget
   - `full` — standard (default)
   - `expert` — deep, with coordinator insights
   - `dive` — exhaustive, for a crucial question

6. **Compile to your brain.** When a run finishes and you want to KEEP the
   knowledge:
   - `research_compile_brain` for the whole run (one big node)
   - `research_compile_section` for one specific thread (one goal or insight)
   The engine feeder auto-ingests files written to workspace/research/.

## Rules

- **Never launch a run while another is active.** Check active state first
  (you'll also see a [COSMO ACTIVE RUN] block in your prompt when one is in
  flight). If you need to cancel, use `research_stop`.
- **Never re-launch research that already exists in a brain.** Query the
  existing brain.
- **Never skip `context` in `research_launch`.** Guided planner needs it.
- **Prefer `research_compile_section` over `research_compile_brain`** when you
  only need one thread. Whole-brain compiles produce one giant node; section
  compiles produce focused nodes that cluster better.
```

This gets loaded into every turn's system prompt via the identity layer (same
mechanism as SOUL.md, MISSION.md). Size-capped in `context.ts:readIdentityFile`
to ~2500 chars.

## Situational awareness — inline in loop.ts

Dynamic state belongs in code, not in a skill file. Add a poll at turn start:

```ts
// src/agent/loop.ts around line 374, before the evobrew block

const activeRun = await checkCosmoActiveRun();  // 1 HTTP call, ~100ms
if (activeRun) {
  rawSystemPrompt += `\n\n[COSMO ACTIVE RUN]
A research run is currently in flight — do not launch another.
- runName: ${activeRun.runName}
- topic: ${activeRun.topic}
- started: ${activeRun.startedAt}
- processes: ${activeRun.processCount}
Use research_watch_run to check progress, research_stop to cancel.`;
}
```

`checkCosmoActiveRun()` is a small helper (in `src/agent/tools/research.ts` as
an internal export) that hits `GET /api/status`, returns `null` on idle or
unreachable, returns `{runName, topic, startedAt, processCount}` on active.
Guard with "if any research_* tool is registered" so agents without COSMO
access don't pay the poll cost.

## Implementation plan

1. **Rewrite `src/agent/tools/research.ts`** — replace the single `researchTool`
   export with 11 named exports: `listBrainsTool`, `queryBrainTool`,
   `searchAllBrainsTool`, `launchTool`, `continueRunTool`, `stopRunTool`,
   `watchRunTool`, `getBrainSummaryTool`, `getBrainGraphTool`, `compileBrainTool`,
   `compileSectionTool`. Plus internal helper `checkCosmoActiveRun()`.
2. **Update `src/agent/tools/index.ts`** — import and register all 11.
3. **Extend `src/agent/loop.ts`** — add the active-run poll + inject, guarded
   on research tool presence.
4. **Write `instances/jerry/workspace/COSMO_RESEARCH.md`** — the skill file.
5. **Update `instances/jerry/config.yaml`** — add `COSMO_RESEARCH.md` to
   `identityFiles`.
6. **Update `src/agent/context.ts:readIdentityFile`** — add a size cap branch
   for `COSMO_RESEARCH.md` (~2500 chars).
7. **Build and restart harness** — `npm run build && pm2 restart home23-jerry-harness`.
8. **Smoke test each tool** — individual HTTP calls through the bridge, plus a
   composite test via dashboard chat.

## Smoke test checklist

- [ ] `research_list_brains` returns the 4 runs from 2026-04-10 testing
- [ ] `research_query_brain` with brainId of run #4 + `mode='expert'` returns the 15KB synthesis
- [ ] `research_search_all_brains` queries top 5 and concatenates
- [ ] `research_launch` with topic + explicit `context` produces a plan that honors the context
- [ ] `research_continue` resumes a completed brain
- [ ] `research_watch_run` returns paginated logs with working cursor
- [ ] `research_stop` cleanly kills an active run
- [ ] `research_get_brain_summary` returns structured markdown from 3 intelligence endpoints
- [ ] `research_get_brain_graph` returns nodes/edges/clusters without embedding blob
- [ ] `research_compile_brain` writes to workspace and feeder ingests (manifest `status=ok, compiled=true`)
- [ ] `research_compile_section` writes one-thread file and feeder ingests
- [ ] Situational awareness: `[COSMO ACTIVE RUN]` block appears only when running
- [ ] Skill file: `COSMO_RESEARCH.md` in identity layer, loaded into every turn
- [ ] Composite test: via dashboard chat, ask jerry "launch a 5-cycle run on X with context Y, watch it, then compile the synthesis goal section to your brain". Verify end-to-end without manual API hits.

## Risks and how they're addressed

- **Tool count creep (19 → 30)**: Mitigation — all 11 share the `research_`
  prefix so LLMs pattern-match the cluster. Existing agents handle 30+ tools
  with good naming discipline.
- **Query response size (15KB+ eats context)**: Jerry paraphrases or compiles
  rather than quoting verbatim. The skill file tells him to prefer compile
  over query for anything he wants to keep.
- **Watch-loop pathology (agents spam or forget)**: Skill file says "check
  every 2-3 turns, not every turn". Tool response includes clear stopping
  conditions ("run completed" / "no new entries since cursor").
- **Continuation context inheritance**: `research_continue` lets COSMO's
  `/api/continue/:brainId` handle prior settings via `effectiveContinueSettings`.
  We only pass overrides.
- **Active-run poll cost**: 1 HTTP call / turn, ~100ms, localhost. Negligible.
  Guarded on research tool presence so non-COSMO agents don't pay it.

## Key files

- `src/agent/tools/research.ts` — rewrite: 11 tools + active-run helper
- `src/agent/tools/index.ts` — register 11 tools
- `src/agent/loop.ts` — add active-run awareness injection
- `src/agent/context.ts` — add COSMO_RESEARCH.md size cap branch
- `instances/jerry/workspace/COSMO_RESEARCH.md` — new skill file
- `instances/jerry/config.yaml` — add COSMO_RESEARCH.md to identityFiles
- `docs/design/COSMO23-VENDORED-PATCHES.md` — reference (do not modify bundled
  cosmo23 unless this doc says so)
- `cosmo23/server/CLAUDE.md` — authoritative COSMO route map
