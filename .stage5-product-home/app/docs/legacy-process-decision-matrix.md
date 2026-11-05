# Legacy Process Decision Matrix

Date: 2026-04-17
Scope: legacy and adjacent PM2 processes outside the current Home23 release stack
Home23 release root: `/Users/jtr/_JTR23_/release/home23`

## Purpose

This is the cautious cleanup matrix for the older COSMO stacks and adjacent services.
It is for decision support only.
Nothing here implies deletion yet.

Goals:
- identify what each process actually is
- identify which ones can still spend API tokens
- identify which ones can still accumulate new data
- separate "protect", "observe", and "retire candidate" processes

## Risk Key

**Token spend risk**
- `High`: autonomous engine or feeder likely to call models on its own
- `Medium`: can call models when messaged, triggered, or externally used
- `Low`: mostly dashboard/support surface
- `Local only`: local model or local work only, not cloud-token risk
- `None`: stopped or stale

**Data growth risk**
- `High`: writes runtime state, brain state, manifests, or ingest outputs
- `Medium`: logs, session artifacts, webhook/event files, or derived files
- `Low`: mostly read-only surface
- `None`: stopped or stale

**Decision status**
- `Protect`: do not stop without explicit decision
- `Observe`: keep mapped, not yet safe to retire
- `Freeze candidate`: likely safe to freeze before deeper migration
- `Retire candidate`: likely stale/replaceable once snapshots are taken
- `Broken stale`: PM2 entry appears invalid already

## Matrix

| PM2 name | Family | Root | What it runs | Listener | Token spend risk | Data growth risk | Decision status | Notes |
|---|---|---|---|---|---|---|---|---|
| `cosmo23-coz` | COSMO23 legacy | `/Users/jtr/_JTR23_/cosmo-home_2.3` | `dist/home.js` COZ agent bridge | `4611` | Medium | Medium | Protect | Memory explicitly says this is a live agent jtr still uses. |
| `cosmo23-home` | COSMO23 legacy | `/Users/jtr/_JTR23_/cosmo-home_2.3` | `dist/home.js` Althea/Home bridge | `4610` | Medium | Medium | Protect | Same protected class as other live 2.3 agents. |
| `cosmo23-edison` | COSMO23 legacy | `/Users/jtr/_JTR23_/cosmo-home_2.3` | `dist/home.js` Edison specialist | `4612` | Medium | Medium | Protect | Live agent with its own bot/runtime state. |
| `cosmo23-tick` | COSMO23 legacy | `/Users/jtr/_JTR23_/cosmo-home_2.3` | `dist/home.js` Tick market agent | `4613` | Medium | Medium | Protect | Live agent; also has market API keys. |
| `cosmo23-jtr` | COSMO23 legacy | `/Users/jtr/_JTR23_/cosmo-home_2.3/engine` | `src/index.js` old 2.3 jtr brain engine | `4640` realtime | High | High | Observe | Actual engine loop; most likely old stack component to keep under watch for token/data growth. |
| `cosmo23-jtr-dash` | COSMO23 legacy | `/Users/jtr/_JTR23_/cosmo-home_2.3/engine` | `src/dashboard/server.js` old 2.3 jtr dashboard | `4601` | Low | Low | Freeze candidate | Surface around old engine, not the engine itself. |
| `cosmo23-jtr-feeder` | COSMO23 legacy | `/Users/jtr/_JTR23_/cosmo-home_2.3/feeder` | `server.js` feeder watching session/memory dirs | no public port | High | High | Observe | Watches `jtrbrain-feed` and workspace memory; can ingest and grow old brain state. |
| `cosmo23-knowledge` | COSMO23 legacy | `/Users/jtr/_JTR23_/cosmo-home_2.3/knowledge-dashboard` | `server.js` knowledge dashboard | `3700` | Low | Low | Freeze candidate | Dashboard surface, not primary runtime. |
| `cosmo23-voice` | COSMO23 legacy | `/Users/jtr/_JTR23_/cosmo-home_2.3/voice` | `server.js` voice daemon | `4670` | Local only | Medium | Observe | Uses local Ollama-style voice model path; lower cloud cost risk, still may write journal/output. |
| `cosmo23-mcp` | COSMO23 legacy | `/Users/jtr/_JTR23_/cosmo-home_2.3/engine` | `mcp/http-server.js` | `4650` when running | Low | Low | Freeze candidate | Currently stopped in PM2. |
| `althea-dashboard` | COSMO23 legacy | `/Users/jtr/_JTR23_/cosmo-home_2.3/dashboard` | `server.js` dashboard shell | `3600` | Low | Low | Freeze candidate | Support UI around old 2.3 surfaces. |
| `regina-jtr` | COSMO old | `/Users/jtr/_JTR23_/cosmo-home/engine` | `src/index.js` old jtr brain engine | stopped | None | None | Retire candidate | Oldest generation engine; currently not running. Snapshot before any delete. |
| `regina-jtr-dash` | COSMO old | `/Users/jtr/_JTR23_/cosmo-home/engine` | `src/dashboard/server.js` old jtr dashboard | `3501` | Low | Low | Freeze candidate | Legacy dashboard still serving. |
| `regina-mcp` | COSMO old | `/Users/jtr/_JTR23_/cosmo-home/engine` | `mcp/http-server.js` | `3510` | Low | Low | Freeze candidate | Legacy MCP bridge. |
| `regina-terrapin` | COSMO old | `/Users/jtr/_JTR23_/cosmo-home/engine` | `src/index.js` Terrapin engine | stopped | None | None | Retire candidate | Old engine, currently stopped. |
| `regina-terrapin-dash` | COSMO old | `/Users/jtr/_JTR23_/cosmo-home/engine` | `src/dashboard/server.js` Terrapin dashboard | `3509` | Low | Low | Freeze candidate | Legacy surface around stopped engine lineage. |
| `regina-tile-dash` | COSMO old | `/Users/jtr/_JTR23_/cosmo-home/dashboard` | `server.js` old tile UI | `3508` | Low | Low | Freeze candidate | Old front-end shell. |
| `regina-voice` | COSMO old | `/Users/jtr/_JTR23_/cosmo-home/voice` | `server.js` old voice server | stopped | None | None | Retire candidate | Old voice service; currently stopped. |
| `coz-dashboard` | OpenClaw | `/Users/jtr/.openclaw/workspace/projects/coz-dashboard` | `api/server.js` COZ dashboard | `3500` | Low | Medium | Observe | Still actively maps many PM2 services; low token risk, but still an active control/report surface. |
| `brain-agent` | OpenClaw | `/Users/jtr/.openclaw/workspace/agents/brain` | `bin/brain-agent.js` session spawner | no listener | Medium | Medium | Observe | Spawns OpenClaw brain sessions; not a web server but still active agent behavior. |
| `coz-cortex` | OpenClaw | `/Users/jtr/.openclaw/workspace` | `bin/coz-cortex.js` watcher/wake daemon | `9877` | Low | Medium | Observe | File watcher and wake system; not a major token spender itself but it does create event/wake artifacts. |
| `cosmo-studio` | Website | `/Users/jtr/websites/cosmos.evobrew.com` | `studio/server/server.js` public studio UI | `3406`, `3409` | Medium | Medium | Observe | Separate website stack, not legacy brain engine cleanup. |
| `cosmo-unified` | Website | `/Users/jtr/websites/cosmos.evobrew.com` | `server/index.js` public COSMO backend | `9100`, `3400` | Medium | Medium | Observe | Public-facing service; separate retirement decision from brain stacks. |
| `cosmo-ide-local` | Adjacent | recorded as `/Users/jtr/_JTR23_/cosmo_ide_v2_dev` | stale PM2 record for missing IDE path | no live listener | None | None | Broken stale | PM2 says online, but path is gone, PID is absent, and nothing listens on `4410/4411`. |

## Immediate Takeaways

- The current Home23 release stack is not the main cleanup risk here.
- The highest legacy token/data-risk processes are:
  - `cosmo23-jtr`
  - `cosmo23-jtr-feeder`
  - the four protected live 2.3 agent bridges: `cosmo23-coz`, `cosmo23-home`, `cosmo23-edison`, `cosmo23-tick`
- The safest first-wave freeze candidates are dashboards and support surfaces, not engines:
  - `cosmo23-jtr-dash`
  - `cosmo23-knowledge`
  - `althea-dashboard`
  - `regina-jtr-dash`
  - `regina-mcp`
  - `regina-terrapin-dash`
  - `regina-tile-dash`
- The cleanest obvious stale candidate is:
  - `cosmo-ide-local`

## Snapshot Targets Before Any Freeze Or Retirement

Do not delete any of this yet.
If a process family gets frozen later, snapshot the state first.

### COSMO23 legacy
- `/Users/jtr/_JTR23_/cosmo-home_2.3/runs/`
- `/Users/jtr/_JTR23_/cosmo-home_2.3/state-*`
- `/Users/jtr/_JTR23_/cosmo-home_2.3/workspace/`
- `/Users/jtr/_JTR23_/cosmo-home_2.3/logs/`
- `/Users/jtr/_JTR23_/cosmo-home_2.3/feeder/manifest*.json`

### COSMO old / Regina
- `/Users/jtr/_JTR23_/cosmo-home/runs/`
- `/Users/jtr/_JTR23_/cosmo-home/logs/`
- `/Users/jtr/_JTR23_/cosmo-home/feeder/manifest*.json`
- `/Users/jtr/_JTR23_/cosmo-home/workspace/`

### OpenClaw adjacent
- `/Users/jtr/.openclaw/workspace/state/`
- `/Users/jtr/.openclaw/workspace/logs/`
- `/Users/jtr/.openclaw/workspace/memory/`

## Safe-First Decision Path

1. Keep the protected live 2.3 agents untouched until you explicitly decide their migration target.
2. Map which old dashboards you still open in practice.
3. Snapshot runtime and feeder state before touching any engine or feeder.
4. Freeze support surfaces first, not engines:
   dashboards, MCP, stale PM2 records.
5. Freeze feeders only after confirming their watched paths are already covered elsewhere.
6. Freeze old engines only after the target Home23 or merged system has the data you care about.

## Suggested Next Matrix Expansion

The next useful pass is not deletion.
It is a second matrix with these columns:

- last user-facing purpose
- last known access path or URL
- data that must be merged first
- replacement target in Home23
- freeze order

That will turn this from inventory into an actual migration plan.

## Migration Surface Matrix

This is the second matrix.
It is about migration sequencing, not just process classification.

### Freeze Order Key

- `F0`: protected, no freeze planning yet
- `F1`: broken or stale metadata, lowest-risk cleanup
- `F2`: passive UI surface or dashboard
- `F3`: support service or bridge
- `F4`: feeder or watcher with ongoing data intake
- `F5`: engine or live agent runtime with highest migration risk

### Current Home23 replacement surfaces

- Main dashboard: `http://localhost:5002/home23`
- Settings: `http://localhost:5002/home23/settings`
- Chat: `http://localhost:5002/home23/chat`
- Home23 COSMO23 research engine: `http://localhost:43210`
- Home23 COSMO23 dashboard surface: `http://localhost:43244`
- Home23 Evobrew: `http://localhost:3415`
- Home23 engine feeder source of truth: `configs/base-engine.yaml`
- Home23 feeder runtime: built into `home23-jerry` engine, not a standalone service
- Home23 agent MCP / companion port family: current stack uses the Home23 engine ports (`5001/5002/5003`) plus `home23-cosmo23`

### Matrix

| PM2 name | Last user-facing purpose | Last known access path / URL | Data that must be merged first | Replacement target in Home23 | Freeze order | Migration note |
|---|---|---|---|---|---|---|
| `cosmo23-coz` | Live COZ agent jtr still talks to | runtime on `4611`; Telegram-facing agent | `state-coz/`, relevant session/runtime logs, any distinct memory or task state | No direct replacement yet; keep separate until you choose whether COZ becomes a Home23 agent instance | F0 | Protected live agent. Do not freeze before an explicit migration plan. |
| `cosmo23-home` | Live Althea/Home agent | runtime on `4610`; Telegram-facing agent | `state-home/`, logs, any distinct memory/personality files | No direct replacement yet; possible future Home23 agent instance | F0 | Protected live agent. |
| `cosmo23-edison` | Live Edison specialist | runtime on `4612`; Telegram-facing agent | `state-edison/`, logs, any specialist prompts/workspace | No direct replacement yet; possible future Home23 specialist instance | F0 | Protected live agent. |
| `cosmo23-tick` | Live Tick market agent | runtime on `4613`; Telegram-facing agent | `state-tick/`, logs, ticker/portfolio artifacts, any strategy notes | No direct replacement yet; possible future Home23 specialist instance | F0 | Protected live agent with external market integrations. |
| `cosmo23-jtr` | Old 2.3 jtr brain engine | realtime on `4640`; paired with dashboard `4601` | `/Users/jtr/_JTR23_/cosmo-home_2.3/runs/jtr/`, configs, workspace memory, state snapshots | `home23-jerry` engine + `instances/jerry/brain` | F5 | Major merge candidate. This is one of the highest-risk token and data-growth surfaces. |
| `cosmo23-jtr-dash` | Old jtr brain dashboard / query surface | `http://192.168.7.131:4601` | Mostly none beyond logs and any dashboard-only artifacts | Main target: `http://localhost:5002/home23`; research-specific target: `http://localhost:43210` / `43244` | F2 | Safe to treat as a UI layer once engine migration is complete. |
| `cosmo23-jtr-feeder` | Old jtr feeder ingesting memory/session docs into 2.3 brain | no public URL; feeder config at `/Users/jtr/_JTR23_/cosmo-home_2.3/feeder/feeder.yaml` | feeder manifest files, watched-path backlog, any unflushed documents, `jtrbrain-feed`, old workspace memory | Home23 built-in feeder in `home23-jerry`, configured from `configs/base-engine.yaml` | F4 | Do not freeze until you verify old watched paths are covered or intentionally retired. |
| `cosmo23-knowledge` | Knowledge / doc dashboard surface | `http://192.168.7.131:3700` | Any unique docs, indexes, or report data behind the dashboard | Home23 dashboard intelligence surfaces, Home23 chat/history, possibly Evobrew for brain browsing | F2 | Likely a UI/archive migration rather than engine migration. |
| `cosmo23-voice` | Voice daemon against 2.3 jtr brain | `4670` | voice journal/output, any generated utterance history tied to old brain | No clean one-to-one replacement yet in Home23 | F3 | Keep until you decide whether voice matters enough to re-home. |
| `cosmo23-mcp` | MCP bridge for 2.3 stack | `4650` when running | probably none beyond config and logs | Home23 MCP family on `5003` plus `home23-cosmo23` | F3 | Support bridge; not a primary data holder. |
| `althea-dashboard` | COSMO Center shell / 2.3 control surface | `http://192.168.7.131:3600` | none beyond UI-specific notes/assets if still needed | `http://localhost:5002/home23` | F2 | Strong UI freeze candidate once nothing still points at it. |
| `regina-jtr` | Oldest jtr engine lineage | stopped | `/Users/jtr/_JTR23_/cosmo-home/runs/jtr/`, old state, old workspace | `home23-jerry` engine + `instances/jerry/brain` | F5 | Already stopped; snapshot first, then retire once merge confidence is high. |
| `regina-jtr-dash` | Old Regina jtr dashboard | `http://192.168.7.131:3501` | none beyond logs or any saved dashboard-only content | `http://localhost:5002/home23` | F2 | UI-only freeze path. |
| `regina-mcp` | Old Regina MCP bridge | `http://192.168.7.131:3510` | likely none beyond config/logs | Home23 MCP family on `5003` | F3 | Bridge replacement is conceptually straightforward. |
| `regina-terrapin` | Old Terrapin engine | stopped | `/Users/jtr/_JTR23_/cosmo-home/runs/terrapin/`, Terrapin-specific state and graph data | No Home23 replacement yet | F5 | Treat as archive-and-decide, not immediate retire-until-snapshotted. |
| `regina-terrapin-dash` | Old Terrapin dashboard | `http://192.168.7.131:3509` | likely no unique data beyond logs and UI artifacts | No direct Home23 replacement yet | F2 | Freeze only after deciding whether Terrapin survives as a future Home23 agent. |
| `regina-tile-dash` | Legacy Regina/COSMO front door | `http://192.168.7.131:3508` | maybe bookmarks/workflow dependency, but little runtime data | `http://localhost:5002/home23` | F2 | Important as a habit surface, but technically a front-end shell. |
| `regina-voice` | Old Regina voice server | stopped | any old voice journals or generated text/audio | No direct Home23 replacement yet | F3 | Retire later if no voice history needs preserving. |
| `coz-dashboard` | COZ dashboard / graph browser / ops registry | `http://192.168.7.131:3500` | project data, `coz.db`, dashboard logs, any operational docs it aggregates | Partial replacement only: Home23 dashboard + docs; no true one-to-one replacement yet | F2 | Useful operational memory surface. Preserve until its report value is replicated or archived. |
| `brain-agent` | OpenClaw brain session spawner | no URL; session-spawn script only | session history, queue/task coupling, agent-specific logs | Partial replacement: `home23-jerry` engine + scheduler/live-problems, but not one-to-one | F3 | Needs behavior mapping before retirement. |
| `coz-cortex` | File watcher / wake daemon / sibling comms bridge | `9877` | `workspace/state/`, `cortex-events.jsonl`, wake queues, sibling comms artifacts | Partial replacement: Home23 live-problems, scheduler, sensors; not one-to-one today | F4 | Not a huge token spender, but it is active automation glue. |
| `cosmo-studio` | Public studio UI for old COSMO website stack | `3406`, `3409` | website content/config, public app data, logs | Maybe `home23-evobrew` for local brain browsing, but no real public-site replacement in Home23 | F2 | Separate website/product decision, not core legacy brain cleanup. |
| `cosmo-unified` | Public COSMO backend / website stack | `9100`, `3400` | website app state, content, logs, any public API consumers | No replacement in Home23 | F3 | Keep outside the Home23 migration track unless you want to retire the public COSMO site itself. |
| `cosmo-ide-local` | Former local COSMO IDE | supposed `4410/4411`, but no live listener | none; path is missing | `home23-evobrew` on `3415` | F1 | Cleanest stale-record cleanup candidate. |

## Feeder Coverage Notes

These matter before freezing any old feeder or watcher.

### Old `cosmo23-jtr-feeder` watched

- `/Users/jtr/jtrbrain-feed`
- `/Users/jtr/_JTR23_/cosmo-home_2.3/workspace/memory/sessions`
- `/Users/jtr/_JTR23_/cosmo-home_2.3/workspace/memory`

### Current Home23 feeder watches

Home23's built-in feeder in `configs/base-engine.yaml` currently includes:

- `/Users/jtr/_JTR23_/cosmo-home_2.3/projects`
- `/Users/jtr/life/`
- `/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/sessions`
- `/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/projects`
- `/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/reports`
- `/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/jtr`
- `/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/memory`
- `/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/cron`

### Gap to resolve before freezing `cosmo23-jtr-feeder`

- `/Users/jtr/_JTR23_/cosmo-home_2.3/workspace/memory` is not listed in Home23's current feeder coverage.
- `jtrbrain-feed` is not listed in Home23's current feeder coverage.
- `cosmo-home_2.3/workspace/memory/sessions` is not explicitly mirrored in Home23 the way the release workspace sessions are.

That means `cosmo23-jtr-feeder` is not yet a safe freeze candidate.

## Practical Freeze Sequence

If you want a careful migration ladder later, this is the order:

1. `cosmo-ide-local`
2. passive dashboards with clear Home23 replacements:
   `althea-dashboard`, `cosmo23-jtr-dash`, `regina-jtr-dash`, `regina-tile-dash`
3. old bridges and support services:
   `regina-mcp`, `cosmo23-mcp`
4. archive-only stopped engines and voice services after snapshot:
   `regina-jtr`, `regina-terrapin`, `regina-voice`
5. watcher/feeder layer only after path coverage is proven:
   `cosmo23-jtr-feeder`, `coz-cortex`, `brain-agent`
6. live old engines and protected live agents only after explicit migration:
   `cosmo23-jtr`, `cosmo23-coz`, `cosmo23-home`, `cosmo23-edison`, `cosmo23-tick`

## What This Still Does Not Decide

- whether COZ, Home, Edison, or Tick should become Home23-native agents
- whether Terrapin is worth preserving as a live future lineage
- whether COZ Dashboard should be archived as a report surface or actively migrated
- whether voice deserves a new Home23-native implementation
