# Home23 Worker Agents Design

Date: 2026-05-02
Status: Draft for jtr review

## Summary

Home23 needs a reusable worker-agent tier: named specialist agents with their own workspace, identity, logs, sessions, and artifacts, but without an engine loop, dashboard, feeder, or autonomous brain. Jerry and Forrest remain the living house agents. Workers are reusable limbs they can call, observe, learn from, and remember through.

This is both a small user-facing tool and a major system primitive. The surface should feel simple:

```bash
node cli/home23.js worker create systems --template systems
node cli/home23.js worker run systems "diagnose this verifier"
```

Under the surface, worker runs must connect to Live Problems, Good Life governance, the engine channel bus, house-agent brain memory, cron automations, and dashboard observability.

## Problem

The existing `home23 agent create <name>` path creates a full Home23 citizen:

- engine PM2 process
- dashboard PM2 process
- harness PM2 process
- workspace
- brain
- feeder config
- ports

That is correct for house agents like Jerry and Forrest, but too heavy for specialist task execution. Running many full engines creates CPU, memory, process, dashboard, and governance overhead. Home23 needs only a few living engines, while most specialized work should be handled by reusable workers.

The current generic diagnostic dispatch also has limits. Live Problems can send work to Jerry through `/api/diagnose`, but every hard problem becomes a generic Jerry turn. Recent Home23 pain shows why typed workers are needed:

- bad rigid remediation loops repeated irrelevant actions such as Docker pruning against unrelated verifiers
- freshness bugs confused fresh wrapper timestamps with stale underlying data
- PM2 and process operations require strict non-destructive rules
- brain persistence and restart flows are high-risk and need dedicated guardrails
- cron drift, dead chat targets, suspect-short jobs, and delivery failures recur
- Jerry and Forrest ownership boundaries need to be explicit at dispatch time
- subagent findings can be wrong unless file paths, evidence, and verifier status are checked

## Goals

- Add reusable named worker agents without creating new engines.
- Give each worker a persistent workspace, identity, session history, artifacts, and logs.
- Let humans, Jerry, Forrest, Live Problems, Good Life, and cron call workers.
- Make worker runs observable to the engine as first-class work events.
- Feed useful worker results into the owning house-agent brain as structured receipts and memory-worthy findings.
- Prevent repeat failed remediations by recording prior attempts and recipes.
- Keep strong safety boundaries around PM2, filesystem, engine restarts, and brain persistence.
- Preserve a small number of full living engines while making specialist capacity broad.

## Non-Goals

- Do not create a new autonomous engine per worker.
- Do not create dashboards per worker.
- Do not give workers independent long-running cognition loops.
- Do not ingest every raw worker token directly into the brain.
- Do not make workers peer house agents. They are specialist action contexts owned by house agents.
- Do not replace Live Problems, Good Life, or the current Jerry/Forrest split.

## Core Model

```text
Engine observes reality
  -> Live Problems / Good Life decide action is needed
    -> Dispatcher chooses worker
      -> Worker acts in isolated workspace
        -> Receipt is written
          -> Engine observes receipt
            -> Brain gets structured memory
              -> Jerry/Forrest see it in context
                -> Future action improves
```

A worker run is complete only when it leaves behind:

- evidence
- verifier result
- receipt
- artifact pointers
- memory-worthy lessons
- owning house-agent routing

## Worker Types

Initial default worker pack:

| Worker | Owner | Purpose |
| --- | --- | --- |
| `systems` | Jerry | PM2, host, process, ports, logs, scoped service diagnostics |
| `scheduler` | Jerry | cron catalog, job drift, delivery targets, suspect-short jobs |
| `freshness` | Jerry/Forrest | semantic freshness for health, pressure, sauna, weather, bridges |
| `brain-guardian` | Jerry | brain persistence, load checks, high-water checks, restart safety |
| `coder` | Jerry | bounded implementation work with file ownership and tests |
| `reviewer` | Jerry | code review, regression risk, missing tests, evidence checks |
| `researcher` | Jerry/Forrest | documentation/web/source research with citations |
| `browser` | Jerry | dashboard/browser flows, screenshots, local UI checks |
| `file-surfer` | Jerry/Forrest | repository, PDF, document, and artifact reading |
| `release` | Jerry | git status, changelog, commit/PR prep, push only when explicitly allowed |
| `memory-curator` | Jerry/Forrest | summarize worker outputs into memory receipts and handoffs |
| `router` | Jerry | classify ambiguous tasks and pick the right worker or house agent |

Later workers can be packaged as templates. Home23 should ship with the first four because they map directly to repeated system pain.

## Filesystem Layout

Workers live outside `instances/<agent>/` so ecosystem generation does not treat them as full engines.

```text
instances/workers/
  systems/
    worker.yaml
    workspace/
      IDENTITY.md
      PLAYBOOK.md
      NOW.md
      MEMORY.md
      sessions/
      artifacts/
    runs/
      <run-id>/
        input.md
        transcript.md
        receipt.json
        artifacts/
    logs/
```

Full-agent discovery continues to scan only `instances/<name>/config.yaml`. Worker discovery scans `instances/workers/<name>/worker.yaml`.

## Worker Config

Example:

```yaml
kind: worker
name: systems
displayName: Systems
ownerAgent: jerry
class: ops
purpose: Diagnose host/process/PM2/system issues without destructive global operations.
provider: xai
model: grok-4.20-non-reasoning-latest
tools:
  shell: true
  files: true
  cron: true
  brain: true
  web: false
safetyPolicy:
  pm2Scope: home23-only
  forbidGlobalPm2: true
  forbidForcePush: true
  requireVerifierBeforeSuccess: true
feedsBrains:
  - jerry
visibleTo:
  - jerry
  - forrest
limits:
  maxRuntimeMinutes: 45
  maxToolCalls: 80
  maxTokens: 120000
```

## Dispatch Surfaces

### CLI

```bash
node cli/home23.js worker create systems --template systems
node cli/home23.js worker list
node cli/home23.js worker run systems "check why this verifier fails"
```

### Chat

House agents should support natural delegation:

```text
use systems to diagnose the host contention signal
use brain-guardian before touching persistence
use reviewer to check this patch
```

### Live Problems

Add a typed remediator:

```json
{
  "type": "dispatch_to_worker",
  "args": {
    "worker": "freshness",
    "budgetHours": 4
  }
}
```

Backward compatibility remains:

- `dispatch_to_agent` keeps working.
- If no worker is named, `router` chooses one or falls back to Jerry.

### Good Life

Good Life should route repair/recover/help work into workers when the lane maps cleanly:

- viability critical -> `systems` or `brain-guardian`
- continuity strained -> `memory-curator` or `scheduler`
- friction strained -> `systems` or `scheduler`
- usefulness watch -> `coder`, `researcher`, or `browser`

Worker results become Good Life evidence when they verify the expected outcome.

### Cron and Automations

Deterministic cron jobs should package work for workers only when needed:

- process-memory-sampler
- freshness-check
- cron-watch-catalog-refresh
- brain-storage-check
- worker-run-digest

Cheap checks run often. LLM workers run only when checks produce an actionable packet.

## Worker Run Receipt

Every worker run writes `receipt.json`:

```json
{
  "schema": "home23.worker-run.v1",
  "runId": "wr_20260502_143000_systems_ab12",
  "worker": "systems",
  "ownerAgent": "jerry",
  "requestedBy": "live-problems",
  "startedAt": "2026-05-02T14:30:00Z",
  "finishedAt": "2026-05-02T14:42:00Z",
  "status": "fixed",
  "verifierStatus": "pass",
  "summary": "Scoped restart cleared dashboard verifier failure.",
  "rootCause": "Dashboard served stale tile state after hidden tile skipped background refresh.",
  "actions": [
    {
      "type": "file_edit",
      "path": "engine/src/dashboard/home23-tiles.js"
    },
    {
      "type": "pm2_restart",
      "target": "home23-jerry-dash"
    }
  ],
  "evidence": [
    {
      "type": "http_jsonpath",
      "detail": "tile.sauna-control.latencyMs <= 200"
    }
  ],
  "artifacts": [
    "instances/workers/systems/runs/wr_20260502_143000_systems_ab12/transcript.md"
  ],
  "memoryCandidates": [
    {
      "type": "procedure",
      "title": "Hidden custom telemetry tiles still need background refresh",
      "appliesTo": ["home23-dashboard", "tile-refresh", "live-problems"]
    }
  ],
  "feedBrains": ["jerry"]
}
```

## Engine Channel

Add `work.worker-runs`, modeled after `work.live-problems`.

The channel polls worker receipts and emits observations for:

- worker run started
- worker run completed
- worker run failed
- verifier passed or failed
- files changed
- recipes recorded
- memory candidates created

These observations crystallize as work events so the engine knows what the workers did.

## Brain Feeding

Worker output feeds brains in layers:

1. Raw transcript remains in the worker run directory.
2. Receipt summary is copied/indexed into the owner house-agent workspace:

   ```text
   instances/jerry/workspace/worker-runs/<run-id>.md
   ```

3. Structured receipt lands in the owner brain:

   ```text
   instances/jerry/brain/worker-runs.jsonl
   ```

4. Memory candidates are reviewed/promoted through the existing memory-object path or a dedicated `memory-curator` worker.
5. Cross-agent summaries are routed by ownership rules.

The brain should receive distilled findings and pointers, not raw transcript flood.

## House-Agent Awareness

Jerry and Forrest pre-turn context should include:

```text
[WORKER ROSTER]
systems: available, last run 20m ago, last outcome fixed
scheduler: available, owns cron drift
freshness: available, owns stale stream checks
brain-guardian: available, use before persistence/restart changes

[RECENT WORKER RUNS]
systems fixed sauna latency verifier at 09:51
systems found runaway forrest pressure-correlate jobs at 08:29
```

This keeps house agents aware of specialist capacity and recent outcomes without requiring them to inspect folders manually.

## Cross-Agent Routing

Workers may feed more than one brain, but routing must preserve ownership:

- Jerry owns house ops, infra, dashboard plumbing, cron, shared telemetry movement, Good Life governance.
- Forrest owns health interpretation, longitudinal health judgment, body metrics, recovery meaning, and health UX.
- Shared zone: pressure x health x sauna correlation and dashboard/API surfaces that join house telemetry with health decisions.

Example:

1. `freshness` detects HealthKit stale.
2. Receipt feeds Jerry because data movement/bridge freshness is Jerry-owned.
3. If health interpretation changes, a routed summary also feeds Forrest.

## Safety Policies

Safety is per-worker, not just prompt text.

`systems` must enforce:

- never `pm2 stop all`
- never `pm2 delete all`
- never `pm2 kill`
- never stop live `cosmo23-*` agents without explicit permission
- restart only scoped process names
- verify before declaring success
- list commands and targets in the receipt

`brain-guardian` must enforce:

- run standalone load checks before persistence-related engine restart
- compare loaded node count to `brain-snapshot.json`
- check high-water count
- verify post-restart logs
- block or escalate if node count drops unexpectedly

`release` must enforce:

- never force push
- never stage unrelated dirty files
- show exact files before commit
- push only when explicitly requested or policy allows

## Dashboard

Add a Workers surface showing:

- roster
- owner agent
- availability
- active runs
- recent outcomes
- verifier status
- files changed
- brain feed status
- blocked/failing workers

This is not a marketing page. It is an operator surface attached to the live OS.

## Backend Connector Layer

Workers need a backend connector layer that can serve any frontend: the Home23 web dashboard, a future macOS app, the iOS app, Evobrew, or a CLI. Frontends should never read worker folders directly or guess filesystem state. They should talk to stable Home23 APIs and event streams.

The connector layer has four jobs:

1. Present worker state to clients.
2. Accept worker run requests from humans and house agents.
3. Stream run progress and completion events.
4. Expose receipts, artifacts, and brain-feed status after the run.

Recommended backend modules:

```text
src/workers/
  registry.ts          # load config/workers.json + instances/workers/*/worker.yaml
  runner.ts            # execute named workers through owner-agent harness context
  receipts.ts          # write/read receipt.json + worker-runs.jsonl
  router.ts            # deterministic task->worker classification
  connector.ts         # HTTP/SSE/WebSocket API handlers shared by dashboard/macOS
```

The dashboard server can mount these routes first. Later, the same connector can move behind the harness bridge or a shared local API process if the macOS app needs direct access without the dashboard page loaded.

## Frontend API Contract

Minimum HTTP contract:

```text
GET  /api/workers
GET  /api/workers/:name
GET  /api/workers/templates
POST /api/workers
POST /api/workers/:name/runs
GET  /api/workers/runs
GET  /api/workers/runs/:runId
GET  /api/workers/runs/:runId/receipt
GET  /api/workers/runs/:runId/artifacts
POST /api/workers/runs/:runId/cancel
POST /api/workers/runs/:runId/promote-memory
```

Minimum event stream:

```text
GET /api/workers/events
```

Event types:

```json
{"type":"worker_run_started","runId":"...","worker":"systems","ownerAgent":"jerry"}
{"type":"worker_run_progress","runId":"...","message":"checking pm2 process table"}
{"type":"worker_run_tool","runId":"...","tool":"shell","summary":"pm2 jlist"}
{"type":"worker_run_receipt","runId":"...","status":"fixed","verifierStatus":"pass"}
{"type":"worker_run_failed","runId":"...","status":"blocked","summary":"needs physical access"}
{"type":"worker_brain_feed","runId":"...","brain":"jerry","status":"written"}
```

The web app can render the full Workers surface from these APIs. A macOS app can use the same endpoints for a native roster, active-run view, notifications, and artifact opening. The API should be local-first and work over localhost/Tailscale with the same auth model as the rest of Home23.

## Frontend Behavior

Frontend clients should support:

- worker roster and template browser
- create worker from template
- start a run with task text, owner agent, optional verifier, and optional source context
- show active run status without polling the filesystem
- stream progress events
- show receipt and artifacts after completion
- show which house-agent brain received the run
- let the user ask Jerry/Forrest to summarize or promote a worker result
- display safety blocks clearly when a worker refuses an operation

The frontend should not expose raw implementation paths as the main interaction model. Paths are evidence, not navigation. The primary model is worker -> run -> receipt -> artifacts -> brain feed.

## Connector To House Agents

Jerry and Forrest need the same connector layer as humans, but through tools and pre-turn context:

- `worker_list`
- `worker_run`
- `worker_status`
- `worker_receipt`
- `worker_promote_memory`

These tools should call the backend connector, not duplicate worker runtime logic inside the prompt layer. This keeps chat, web, macOS, and automation clients attached to one source of truth.

When a house agent calls `worker_run`, the connector should:

1. resolve the worker and owner agent
2. create the run directory
3. write `input.md`
4. start the worker through the runner
5. stream events
6. write the receipt
7. write owner-agent workspace/brain receipt copies
8. emit `work.worker-runs` observations for the engine

## Connector To Automations

Cron and heartbeat automations should also use the connector layer. They should not shell into worker files directly.

Examples:

```text
freshness-check -> POST /api/workers/freshness/runs
brain-storage-check -> POST /api/workers/brain-guardian/runs
worker-run-digest -> GET /api/workers/runs?since=...
```

This keeps automations, Live Problems, Good Life, and frontend clients using the same run records.

## Implementation Notes

Implementation should be staged:

1. Worker registry and filesystem scaffolding.
2. Worker runner that can execute a named worker from CLI and write receipts.
3. Backend connector API and event stream.
4. Harness tools so Jerry and Forrest can call workers through the connector.
5. Live Problems `dispatch_to_worker`.
6. Engine `work.worker-runs` channel.
7. Brain/workspace receipt ingestion.
8. Good Life routing.
9. Dashboard Workers surface.
10. macOS/iOS-ready frontend contract validation.
11. Default worker templates.

## Initial Decisions

- Worker runs default to the owner agent's current chat provider/model unless `worker.yaml` overrides it.
- Only receipts are fed into house-agent brains by default. Raw transcripts stay linked as evidence.
- Start with one active worker run per owner agent. Add parallelism only after receipts, locks, and dashboard visibility are stable.
- `router` starts as deterministic classification plus a worker fallback for ambiguous cases. Deterministic routing handles clear categories; the `router` worker handles unclear ownership or mixed-domain tasks.

## References

- Claude Code subagents: https://docs.claude.com/en/docs/claude-code/subagents
- OpenAI Agents SDK handoffs: https://openai.github.io/openai-agents-python/handoffs/
- OpenAI multi-agent patterns: https://openai.github.io/openai-agents-python/multi_agent/
- Microsoft Magentic-One: https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/
- CrewAI introduction: https://docs.crewai.com/en/introduction

CONVERSATION:
i want a way to spin up agents here, but not the ful blown engine and everyting.  is there a way to do this in a non destructuve way?  now we have ability to create agents, but that makes a full engine, etc with brain...  would be good to have agents that are just workers or soemthing you know....  so create agent option without the brain?
9:56 AM


Worked for 1m 1s
Yes. The non-destructive path is to add a separate worker agent mode, not change what a full Home23 agent means.

What exists now:

home23 agent create <name> creates a full instance:
instances/<name>/config.yaml
workspace
brain files
feeder config
engine PM2 process
dashboard PM2 process
harness PM2 process
generate-ecosystem.js assumes every instance with config.yaml is a full agent and emits all three PM2 processes.
There is already an in-process spawn_agent tool, but that is a temporary sub-agent inside an existing harness, not a named reusable worker identity.
The clean design would be:

home23 worker create <name>

It would create something like:

instances/workers/<name>/
  worker.yaml
  workspace/
  logs/
No brain. No engine. No dashboard. No feeder. No PM2 engine process.

Then workers run only when called, probably through Jerry/Forrest’s existing harness as bounded task executors. They would have identity, tools, workspace, model/provider settings, and output logs, but they would not become autonomous Home23 citizens.

Recommended shape:

Full agent = alive system with brain, dashboard, engine loop.
Worker = task runner with identity and workspace, launched by an existing full agent.
Ephemeral subagent = current one-off spawn_agent behavior.
One key question before I spec it: should these workers be reusable named workers like researcher, coder, ops, with persistent workspace/logs, or should they be throwaway per-task workers that leave only a transcript/artifact behind?





9:57 AM
they should be fully reusable, and have a workspace etc.  just not the engine behind it.  we cant have all these engines running.  ideally its a few at the max we do the rest with these specialzed worker agents.
9:59 AM

That tracks. I’d design it as a new tier:

Approaches

Recommended: reusable worker agents under full agents

jerry / forrest remain the few full engines.
Workers are named, reusable, specialized identities with workspaces.
No engine PM2 process, no dashboard, no feeder, no autonomous cognition loop.
Jerry can delegate to them through an upgraded worker runner.
PM2 worker processes

Each worker has a lightweight harness PM2 process, but no engine/dashboard.
Easier to message directly later, but still creates process sprawl.
I’d avoid this unless we need always-on workers.
Profiles inside Jerry only

Store worker prompts/config in Jerry’s workspace and run them as personas.
Smallest implementation, but they don’t feel like real reusable agents with their own files/history.
Recommended Design

Add a new CLI path:

node cli/home23.js worker create coder
node cli/home23.js worker list
node cli/home23.js worker run coder "fix this bounded task..."
Worker layout:

instances/workers/coder/
  worker.yaml
  workspace/
    IDENTITY.md
    PLAYBOOK.md
    NOW.md
    MEMORY.md
    sessions/
    artifacts/
  logs/
worker.yaml would define:

kind: worker
name: coder
displayName: Coder
ownerAgent: jerry
provider: xai
model: grok-4.20-non-reasoning-latest
tools:
  shell: true
  files: true
  web: false
limits:
  maxRuntimeMinutes: 30
  maxTokens: 120000
Important boundary: generate-ecosystem.js should ignore instances/workers/*, and full-agent discovery should keep requiring instances/<name>/config.yaml. That keeps this non-destructive and prevents accidental PM2 engine creation.

Runtime behavior:

Jerry’s existing spawn_agent tool grows a worker option.
Example: “spin up coder for this” calls reusable worker coder.
The worker gets its own identity files and workspace history.
Result returns to Jerry/chat.
Worker transcript lands in instances/workers/coder/workspace/sessions/.
Artifacts land in instances/workers/coder/workspace/artifacts/.
No autonomous memory graph. If a worker produces something worth remembering, Jerry decides whether to ingest/promote it.
This gives you a small number of living engines and a bench of specialized reusable workers.

If this design is right, I’ll write the short design spec next, then we can implement it.





9:59 AM
lets think about this too.  its a brilliant idea, and we can package in some of these specialist agents with set defaults and things to do.  a systems agents, for example.  it makes sesne to research this futher - there are likely many examples of potetnial useful default worker agents that an AI OS would want to hae to leverage.
10:01 AM


Worked for 30s
Yes. This is the right shape for Home23.

I researched the current multi-agent patterns, and the useful pattern is consistent: keep a strong orchestrator, then delegate bounded work to reusable specialists with isolated context and restricted tools. Claude Code subagents emphasize reusable specialized assistants with their own context and tool permissions. OpenAI Agents SDK uses handoffs to transfer work to specialists. Microsoft’s Magentic-One uses an orchestrator plus named specialists like coder, terminal, web, and file agents. CrewAI/LangGraph land in the same neighborhood, but heavier than Home23 needs right now.

Home23 Version
Home23 should package worker agents as installable/reusable specialist identities.

Full agents stay rare:

jerry     = full living engine
forrest   = full living engine
workers   = reusable specialists, no engine
Worker agents should have:

instances/workers/systems/
  worker.yaml
  workspace/
    IDENTITY.md
    PLAYBOOK.md
    NOW.md
    MEMORY.md
    sessions/
    artifacts/
  logs/
No brain graph. No engine loop. No dashboard. No PM2 engine. No feeder unless later explicitly enabled.

Default Worker Pack
I’d ship Home23 with a starter bench:

systems — PM2, ports, logs, host health, non-destructive diagnostics.
coder — bounded code edits with file ownership and tests.
reviewer — code review, regression checks, missing tests.
researcher — web/docs research with citations and source notes.
browser — local dashboard/browser interaction and screenshots.
file-surfer — repo/file/PDF/document reading and extraction.
qa — test running, smoke tests, verification reports.
release — git status, changelog, commit/PR prep, push only when told.
memory-curator — summarize worker outputs into handoffs/promotable memory.
dashboard-ui — focused frontend/UI implementation and polish.
integrations — APIs, sensors, bridges, health of external connectors.
ops-sentinel — periodic diagnostic recipes, but not autonomous repair unless routed through Jerry.
The important one for your example is systems: it should know Home23’s hard rules by default, especially “never stop/delete all PM2,” only inspect or restart scoped processes, and always return evidence.

Template System
CLI should support:

node cli/home23.js worker create systems --template systems
node cli/home23.js worker create coder --template coder
node cli/home23.js worker list
node cli/home23.js worker run systems "diagnose why home23-cosmo23 says running false"
And eventually from Jerry chat:

use systems to check the host contention signal
use coder to implement this narrow fix
use reviewer to check the patch
Design Principle
Workers are not “lesser agents.” They are tool-bearing specialists without autonomous life support. Jerry remains the living agent that decides what matters, integrates results, and promotes durable memory.

Sources:
Claude Code subagents
,
OpenAI Agents SDK handoffs
,
OpenAI multi-agent patterns
,
Magentic-One
,
CrewAI docs
.





10:01 AM
also - review our memory and conversations and maybe even jerry itself to identify the pain points of a system like this that can be tackled by automations and worker agents.
this needs to be tightly tied into the system
10:02 AM


Worked for 1m 5s
Yes. After reading the memory, Jerry surfaces, cron status, and recent diagnostic transcripts, the worker system should be tied directly into Live Problems + Good Life + Cron + Memory, not just be a CLI convenience.

The pain points are clear:

Bad rigid remediation loops

Example: sauna latency problem repeated docker builder prune -f dozens of times, unrelated to the verifier.
Need: systems worker that diagnoses before acting, reads prior attempts, refuses repeated nonsense.
Stale-vs-fresh confusion

Weather/health/sauna repeatedly looked fresh by wrapper timestamp while underlying data was stale.
Need: freshness worker plus deterministic freshness automations.
PM2/process safety

Memory records multiple hard rules: never global PM2 commands, don’t kill live cosmo23 agents, restart only scoped processes.
Need: systems worker with hardcoded safety policy and scoped PM2 tools.
Brain persistence danger

Save/load bugs nearly erased Jerry’s brain; restarts can be dangerous after persistence changes.
Need: brain-guardian worker that runs standalone load checks, high-water checks, and post-restart verification.
Cron drift and delivery failure

Past issues: timezone ignored, dead dashboard chat IDs, suspect-short jobs, stale job state.
Need: scheduler worker that owns cron catalog diagnosis and fixes job metadata safely.
Role-boundary drift

Jerry vs Forrest health ownership keeps surfacing: data movement vs body interpretation.
Need: router or handoff worker/automation that classifies work before dispatch.
Host contention and runaway jobs

Recent pressure-correlate runaway jobs caused RSS/CPU pressure.
Need: ops-sentinel automation plus systems worker for process attribution.
Worker findings can be wrong

Memory explicitly says subagents conflate engine/ and cosmo23/engine/.
Need: every worker result returns evidence paths and a verification status; Jerry verifies before presenting as fact.
Revised Design
Workers become a system primitive:

Full engines:
  jerry
  forrest

Reusable workers:
  systems
  scheduler
  freshness
  brain-guardian
  coder
  reviewer
  researcher
  browser
  file-surfer
  release
  memory-curator
  router
They plug into these surfaces:

Live Problems Tier 2  -> dispatch named worker by problem class
Good Life repair      -> selects worker for verified repair action
Cron                  -> recurring worker runs for diagnostics/curation
Chat                  -> "use systems/coder/reviewer..."
Memory                -> worker outputs become receipts/promotable artifacts
Dashboard             -> worker roster, recent runs, verifier status
The key rule: automations detect and package work; workers investigate and act; Jerry integrates and decides what becomes memory or user-facing truth.

So I’d spec this as two linked systems:

Worker Agent Runtime

reusable named workers
workspace/history/artifacts/logs
no engine, no brain graph, no PM2 engine
explicit tools + safety policy per worker
Worker Dispatch Layer

maps live-problem categories to workers
records worker runs as structured receipts
prevents repeat failed remediations
exposes status to Good Life and dashboard
I’d make systems, scheduler, freshness, and brain-guardian the first default pack because they directly target the repeated Home23 pain. Then add coder/reviewer as the build loop workers.

If this shape is right, I’ll write the design spec next.





10:03 AM
yes on the right track.  lets dig further into this - the connections that NEED TO HAPPEN.  we have a live engine - the backbone to everything that should know about these as well.
the house main agents (here, jerry/forrest) need to be well aware and connected to what these do.
they need to feed into the brain(s) of house agents anythning and everything so its connected.
dont just think at surface level here, this goes deep. many layers.
we are adding a major thing - but also just a new little tool for human and house agents
10:07 AM



Worked for 50s
Yes. This cannot be “a folder of prompts.” It has to become part of the Home23 nervous system.

The important distinction:

Workers are not outside helpers. They are limbs.
Jerry/Forrest are the living house agents. Workers are reusable specialist limbs they can call, observe, learn from, and remember through.

The Connections That Need To Exist

Worker Registry

A durable registry, probably:

config/workers.json
instances/workers/<name>/worker.yaml
Each worker declares:

name: systems
ownerAgent: jerry
class: ops
purpose: diagnose host/process/PM2/system issues
tools: [shell, files, brain, cron]
safetyPolicy: scoped-home23-ops
feedsBrains: [jerry]
visibleTo: [jerry, forrest]
Worker Run Ledger

Every worker run creates a structured receipt:

instances/workers/systems/runs/<run-id>/
  input.md
  transcript.md
  receipt.json
  artifacts/
And a copy/index lands in the owning house agent:

instances/jerry/workspace/worker-runs/<run-id>.md
instances/jerry/brain/worker-runs.jsonl
Engine Channel

The engine should poll worker receipts through a new channel:

work.worker-runs
Similar to work.live-problems. That means worker activity becomes normal engine observation material:

worker started
worker used tools
worker found root cause
worker changed files
worker verified
worker failed / blocked
worker produced reusable recipe
Brain Feeding

The raw transcript should stay available, but the brain should get structured material:

run summary
root cause
files touched
commands run
verifier status
reusable recipe
new rules/corrections
unresolved follow-ups
artifact paths
So yes: everything connects, but not every raw token becomes a brain node. The brain gets receipts, distilled findings, and pointers to full evidence.

Live Problems Dispatch

Current Tier 2 is generic:

dispatch_to_agent -> Jerry diagnose turn
It should become typed:

dispatch_to_worker({ worker: "freshness" })
dispatch_to_worker({ worker: "systems" })
dispatch_to_worker({ worker: "scheduler" })
dispatch_to_worker({ worker: "brain-guardian" })
Backward compatible: if no worker is named, route to router, which picks one.

Good Life Integration

Good Life should know worker capacity exists. In repair mode, it should not simply create generic agenda diagnostics. It should route by lane:

viability critical → systems or brain-guardian
continuity strained → memory-curator or scheduler
friction strained → ops-sentinel
usefulness watch → coder, researcher, or dashboard-ui
Worker success becomes Good Life evidence: “verified system evidence returned to healthy bounds.”

House Agent Awareness

Jerry and Forrest need worker state in pre-turn context:

[WORKER ROSTER]
systems: available, last run 20m ago, last outcome fixed
scheduler: available, owns cron drift
freshness: available, owns stale stream checks
brain-guardian: available, use before persistence/restart changes
And:

[RECENT WORKER RUNS]
systems fixed sauna latency verifier at 09:51
systems found runaway forrest pressure-correlate jobs at 08:29
Cross-Agent Routing

Workers need an ownership boundary.

Example:

freshness detects HealthKit stale → Jerry owns bridge/data movement; Forrest owns interpretation.
Worker writes receipt to Jerry.
If health meaning changed, a routed summary also lands in Forrest’s workspace/brain.
So workers can feed multiple brains, but with clear routing rules.

Automation Layer

Automations should package work for workers.

Cheap deterministic automation:

process-memory-sampler
freshness-check
cron-watch-catalog-refresh
brain-storage-check
worker-run-digest
Expensive LLM worker only runs when deterministic checks say, “this needs judgment/action.”

Dashboard Layer

Dashboard should show:

Worker roster
Active worker runs
Last outcomes
Failed/blocked runs
Which house agent owns each worker
Which brain received the receipt
Not a toy “agent list.” More like a crew board attached to the live OS.

The Deeper Model

Engine observes reality
  -> Live Problems / Good Life decide action is needed
    -> Dispatcher chooses worker
      -> Worker acts in isolated workspace
        -> Receipt is written
          -> Engine observes receipt
            -> Brain gets structured memory
              -> Jerry/Forrest see it in context
                -> Future action improves
That is the loop. Workers are not parallel brains. They are reusable specialist action contexts that make the main brains better.

Critical Rule

A worker run is not complete when it answers. It is complete when it leaves behind:

1. evidence
2. verifier result
3. receipt
4. artifact pointers
5. memory-worthy lessons
6. owning house-agent routing
That’s the difference between “little tool” and “major system primitive.” It is both: a simple thing to call, deeply wired into the living engine.
