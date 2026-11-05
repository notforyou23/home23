# Step 9: COSMO 2.3 Integration Design

**Date:** 2026-04-07
**Status:** Approved · Smoke-tested 2026-04-10

> **Vendored patches:** structural fixes to the bundled `cosmo23/` source are
> tracked in [COSMO23-VENDORED-PATCHES.md](./COSMO23-VENDORED-PATCHES.md).
> **Re-apply or re-verify those patches any time `cli/home23.js cosmo23 update`
> pulls fresh upstream.** Without them, config reads and writes diverge and
> encrypted API keys leak into outbound HTTP as literal bearer tokens.

## Summary

Bundle COSMO 2.3 (deep research engine) into Home23 as a managed component. One `home23-cosmo23` PM2 process runs the COSMO server; COSMO internally manages its own subprocesses (engine, MCP, dashboard) during active research runs. Config is pre-seeded from Home23's sources of truth (API keys + ports only — COSMO's own config system handles everything else). Dashboard gets a simplified COSMO monitor panel. The Home23 agent gets a `research` tool to search existing brains, launch new runs, and check status. Research brains are browsable from evobrew and queryable by agents.

## 1. Packaging

COSMO 2.3 source lives at `Home23/cosmo23/` as a committed directory.

**Excluded from copy:**
- `node_modules/`
- `.git/`
- `runs/` (existing research runs — fresh installs start clean)
- `runtime/` (symlink to active run)
- `investigations/` (local synthesis documents)
- `~/.cosmo2.3/` config (auto-generated)

**Gitignored:**
- `cosmo23/node_modules/`
- `cosmo23/runs/`
- `cosmo23/runtime/`
- `cosmo23/.cosmo23-config/`

`home23 init` installs cosmo23's npm deps (including Prisma generate).

**Update command:** `home23 cosmo23 update`. COSMO 2.3 currently has no GitHub remote — it's a local-only repo. The update command copies from a configured source path (default: `/path/to/cosmo_2.3`). When a remote is added later, the command can be updated to pull from GitHub (same pattern as evobrew). Source path configurable in `home.yaml` under `cosmo23.source`.

## 2. Process Architecture

One PM2 process at the home level:

| Process | Script | Purpose |
|---|---|---|
| `home23-cosmo23` | `cosmo23/server/index.js` | COSMO server (web UI, API, brain queries) |

COSMO internally spawns its own subprocesses when a run is launched:
- Engine (WebSocket)
- Dashboard server (HTTP)
- MCP server (HTTP)

These are managed by COSMO's own ProcessManager — Home23 doesn't touch them. When the run stops, COSMO cleans them up. When idle, only the Express server runs.

### Ports

Configured in `home.yaml` under `cosmo23.ports`, different from standalone COSMO defaults:

| Service | Home23 Default | Standalone Default | Env Var |
|---|---|---|---|
| Web/API | 43210 | 43110 | `COSMO23_PORT` |
| WebSocket | 43240 | 43140 | `COSMO23_WS_PORT` |
| Dashboard | 43244 | 43144 | `COSMO23_DASHBOARD_PORT` |
| MCP | 43247 | 43147 | `COSMO23_MCP_HTTP_PORT` |

## 3. Config

COSMO 2.3 has a complex config system — per-run config generation, model role assignments (Primary/Fast/Strategic), config-generator.js, encryption, Prisma/SQLite for OAuth. We don't replicate or replace any of this.

Home23 only pre-seeds two things:
1. **Provider API keys** — written into COSMO's config format so it doesn't prompt for setup
2. **Ports** — set via environment variables passed through PM2

COSMO's `config.json` normally lives at `~/.cosmo2.3/`. We add a `COSMO23_CONFIG_DIR` env var override to COSMO's config loader (same pattern as evobrew's `EVOBREW_CONFIG_DIR`), pointing at `cosmo23/.cosmo23-config/`.

The pre-seeded config contains:
- API keys from `config/secrets.yaml` (OpenAI, Anthropic, xAI)
- Ollama URL from `config/home.yaml`
- Encryption key (generated once, stored in the config)

Everything else — model selection, run settings, engine YAML generation — is handled by COSMO's own UI and config-generator.js untouched.

On every start, the pre-seeder merges updated API keys into the existing config (read → update keys → write). It does NOT replace the whole file — model selections, encryption key, and other user settings are preserved.

## 4. Dashboard Integration

A "COSMO" button in the dashboard tab bar (alongside evobrew). Clicking shows a monitor panel:

- **Status indicator** — idle / running / completed (polls COSMO's `/api/status`)
- **Active run info** — name, progress, cycle count, active agents (if running)
- **Recent runs** — list of completed runs with brain sizes
- **Launch button** — opens COSMO's full UI (`http://localhost:43210`) in a new tab
- **Brain links** — completed run brains clickable, open in evobrew

The panel is a lightweight monitor, not a rebuild of COSMO's UI. Run configuration and launch happen in COSMO's own full UI.

## 5. Agent Research Tool

The Home23 agent gets a `research` tool with three actions:

### `search` — Query existing research brains
```
research({ action: "search", query: "quantum computing cryptography" })
```
Queries across all completed run brains using COSMO's brain query endpoints (`/api/brain/:name/query`). Returns relevant findings. Agent checks this FIRST before launching new research.

### `launch` — Start a new research run
```
research({ action: "launch", topic: "quantum computing applications in cryptography", mode: "guided" })
```
Hits COSMO's `/api/launch` with the topic. Home23 fills in model assignments from existing COSMO config. Returns a run ID. Does NOT wait for completion — runs take minutes to hours.

### `status` — Check on runs
```
research({ action: "status" })
research({ action: "status", runId: "quantum-crypto-2026-04-07" })
```
Returns active run progress or list of recent completed runs.

### Agent Identity Context

Added to the agent's system prompt:
> "You have access to COSMO 2.3, a deep research engine with multi-agent orchestration. Before answering complex research questions, check if relevant research already exists using the research tool's search action. If existing knowledge is insufficient, you can launch a new research run — these take time (minutes to hours) but produce thorough, multi-agent investigations with their own knowledge brains."

## 6. Brain Visibility

Research brains are discoverable from two places:

### Evobrew
The evobrew config generator (`cli/lib/evobrew-config.js`) is extended to scan `cosmo23/runs/` for completed runs with `state.json.gz`. These appear in evobrew's brain picker as `research:<run-name>` alongside `agent:<agent-name>` brains.

### COSMO's own UI
Already handles this natively — its brain registry scans `runs/` and serves them via `/api/brains`. No changes needed.

### Agent queries
The `research({ action: "search" })` tool queries across these brains via COSMO's existing brain query API.

## 7. CLI Commands

### New
- `home23 cosmo23 update` — copies latest from source path (configurable in `home.yaml` under `cosmo23.source`). Excludes runs, node_modules, config. Reinstalls deps if package.json changed. When a GitHub remote is added, switches to tarball download.

### Modified
- `home23 init` — installs cosmo23 npm deps + Prisma generate
- `home23 start` — starts `home23-cosmo23` (if not already running), pre-seeds config
- `home23 stop` — stops `home23-cosmo23`
- `home23 status` — shows cosmo23 process status
- `home23 logs cosmo23` — tails cosmo23 logs

## 8. What Already Exists (in COSMO 2.3)

| Component | Status | Notes |
|---|---|---|
| Full web UI (Launch, Watch, Brains, Query, Map, Intelligence) | Built | Opens in new tab from dashboard |
| Server with all API routes | Built | `server/index.js` (2,174 lines) |
| Brain registry + query endpoints | Built | `/api/brains`, `/api/brain/:name/query` |
| Config generator (UI → engine YAML) | Built | `launcher/config-generator.js` |
| Process manager (engine, MCP, dashboard) | Built | `launcher/process-manager.js` |
| Run manager (CRUD, fork, dream-fork) | Built | `launcher/run-manager.js` |
| 40+ agent types | Built | `engine/src/agents/` |
| PGS query engine | Built | `pgs-engine/` |
| Launch/stop API | Built | `/api/launch`, `/api/stop` |
| Status API | Built | `/api/status` |

## 9. What Needs Building

1. Copy COSMO 2.3 source into `Home23/cosmo23/` (excluding runs, .git, etc.)
2. `COSMO23_CONFIG_DIR` env var override in COSMO's config loader
3. Config pre-seeder — writes API keys + generates encryption key into COSMO's config format
4. Ecosystem config — add `home23-cosmo23` PM2 entry with port env vars
5. Dashboard COSMO panel — status, active run, recent runs, launch button, brain links
6. Dashboard COSMO button + styling (tab bar, alongside evobrew)
7. Agent `research` tool — search, launch, status actions
8. Agent identity context update — awareness of COSMO capabilities
9. Evobrew config extension — scan cosmo23/runs/ for research brains
10. CLI `cosmo23 update` command
11. CLI init/start/stop modifications
12. `home.yaml` additions — cosmo23 ports + source path

## 10. Design Principles

- COSMO 2.3 is a dependency, not a fork. Its internals stay untouched.
- Only pre-seed credentials and ports. COSMO's config system handles everything else.
- COSMO manages its own subprocesses. PM2 only manages the server process.
- The dashboard monitors, it doesn't replace COSMO's UI.
- Research brains stay separate from agent brains. User decides when to connect them.
- Agent checks existing research before launching new runs.
