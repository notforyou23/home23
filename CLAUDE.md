# Home23

Installable AI operating system — persistent agents with living brains.

## What This Is

Home23 takes the proven COSMO engine (JS, cognitive loops, dreaming, brain) and the TS agent harness (AgentLoop, tools, channels, scheduler) and packages them into something installable and portable — any machine, any OS, with an internet connection.

## Quick Start

```bash
# First time setup
node cli/home23.js init                    # API keys, deps, build

# Create an agent
node cli/home23.js agent create <name>     # Guided setup

# Run it
node cli/home23.js start <name>            # Starts agent + evobrew + COSMO
node cli/home23.js status                  # Check what's running
node cli/home23.js logs <name>             # Tail logs
node cli/home23.js stop                    # Stop everything
node cli/home23.js evobrew update          # Pull latest evobrew from GitHub
node cli/home23.js cosmo23 update          # Sync latest COSMO from source
```

## Architecture

```
Home23/
  engine/              <- JS COSMO engine (DO NOT REWRITE)
  feeder/              <- Ingestion pipeline
  src/                 <- TS harness layer (40 files)
  dist/                <- Compiled JS output (gitignored)
  cli/                 <- CLI installer + management commands
    lib/               <- Command implementations
    templates/         <- Identity file templates for new agents
  config/              <- Home-level config
    home.yaml          <- Provider URLs, model aliases, chat defaults
    secrets.yaml       <- API keys, bot tokens (gitignored)
  configs/             <- Engine config templates
    base-engine.yaml   <- Cognitive loop config (shared by all agents)
  instances/           <- Per-agent directories
    <agent-name>/
      workspace/       <- Identity files (SOUL.md, MISSION.md, BRAIN_INDEX.md, etc.)
      brain/           <- Engine state (thoughts, goals, dreams, metrics)
      conversations/   <- JSONL chat history
      config.yaml      <- Agent-specific config (ports, model, channels)
      feeder.yaml      <- Feeder config for this agent
      logs/            <- Process logs
  evobrew/             <- Bundled AI IDE
  cosmo23/             <- Bundled research engine (COSMO 2.3)
  logs/                <- Home-level logs (evobrew)
  scripts/             <- Dev start/stop scripts (PM2 is primary)
  ecosystem.config.cjs <- PM2 config (auto-generated from instances)
```

## Process Architecture (per agent)

Each agent runs 4 processes managed by PM2, plus 2 shared processes:

| Process | Script | Purpose | Port |
|---|---|---|---|
| `home23-<name>` | `engine/src/index.js` | Cognitive engine (loops, dreaming, brain growth) | WS |
| `home23-<name>-dash` | `engine/src/dashboard/server.js` | HTTP API (brain queries, state, memory) | HTTP |
| `home23-<name>-feeder` | `feeder/server.js` | File watcher, chunker, embedder, compiler | — |
| `home23-<name>-harness` | `dist/home.js` | TS agent (Telegram, 26 tools, LLM loop) | bridge |
| `home23-evobrew` | `evobrew/server/server.js` | AI IDE (shared, all agents) | 3415 |
| `home23-cosmo23` | `cosmo23/server/index.js` | Research engine (shared, on-demand runs) | 43210 |

Ports auto-assigned per agent: first agent 5001/5002/5003/5004, second 5011/5012/5013/5014, etc.

## Front Door (UI Layer)

```
Front Door (dashboard, onboarding, chat)    <- BUILT
House Runtime (agent loop, tools, channels) <- BUILT
Brain (cortex, continuity, memory)          <- BUILT
Ingestion Compiler (LLM synthesis, index)   <- BUILT
Engine (cognitive loops, persistence)       <- BUILT
```

### Dashboard — OS Home Screen

The dashboard is the AI OS home screen, served at `/home23` on each agent's dashboard port (e.g., `http://localhost:5002/home23`).

Tab bar (the OS dock): Home, Intelligence, Settings, COSMO, evobrew.

- **Home tab** — Three-column tile grid: Thoughts (left), Vibe (center), **Chat** (right). System stats bar below. Feeder + Brain Log at bottom. Chat tile connects to agent loop via SSE with full thinking/tool visibility, agent selector, model selector, conversation history, expand to overlay or standalone `/home23/chat`.
- **Settings tab** — Full settings page at `/home23/settings` with nested sub-tabs: Providers (API keys), Agents (create/edit/channels/start/stop), Models (aliases/defaults), System (ports/embeddings/maintenance). First-run shows welcome screen -> Settings onboarding flow. Primary agent concept (first agent, can't be deleted).
- **Intelligence tab** — Synthesis agent reads brain + index and produces curated insights. Scheduled synthesis every 4 hours; manual trigger button also available.
- **COSMO tab** — Full COSMO 2.3 research UI embedded via iframe (all 9 tabs). Iframe preserves state across tab switches.
- **Evobrew button** — Opens AI IDE in new tab with `?agent=<name>` pre-selection.

All URLs use `window.location.hostname` (not hardcoded localhost) — works over Tailscale, LAN, or localhost.

### Evobrew (AI IDE)

Bundled at `evobrew/`, served at `http://localhost:3415`. One shared PM2 process for all agents. Auto-configured from home.yaml + secrets.yaml + instances. Dashboard button opens evobrew with `?agent=<name>` to pre-select model + brain.

Agents appear as `local:<name>` in the model dropdown. Chat goes through the bridge endpoint (`src/routes/evobrew-bridge.ts`) which runs the full agent loop with identity/tools/memory. Brain auto-connects on launch.

### COSMO 2.3 (Research Engine)

Bundled at `cosmo23/`, served at `http://localhost:43210`. One shared PM2 process — COSMO manages its own subprocesses internally when a run is active. Config pre-seeded with API keys from Home23.

Full COSMO UI embedded in dashboard via iframe (all 9 tabs). The agent has a `research` tool with search/launch/status actions. Research brains visible in evobrew.

### Ingestion Compiler

Documents ingested through the feeder are synthesized by an LLM before brain entry (`engine/src/ingestion/document-compiler.js`). Compiler produces a structured synthesis (key concepts, relationships, insights) that is stored as the brain node rather than raw text. A brain knowledge index is maintained automatically at `instances/<name>/workspace/BRAIN_INDEX.md` — a human-readable map of everything the agent knows.

Conversation sessions are compiled to workspace on session gap (idle timeout). The agent's `research` tool supports a `compile` action: `research({ action: "compile", runId: "..." })` to compile a completed COSMO research run into the brain.

> The model is the current voice. The engine is the living process. The brain is the enduring cortex.

## Config (Single Source of Truth)

| File | What | Committed? |
|---|---|---|
| `config/home.yaml` | Provider URLs, model aliases, chat defaults, embeddings, evobrew port, cosmo23 ports | Yes |
| `config/secrets.yaml` | API keys (providers + per-agent bot tokens) | No (gitignored) |
| `instances/<name>/config.yaml` | Per-agent: ports (incl. bridge), owner, channels, model, all harness settings | Yes |
| `configs/base-engine.yaml` | Engine cognitive loop config (shared, structural only) | Yes |
| `evobrew/config.json` | Evobrew config (auto-generated from above on start) | No (gitignored) |
| `cosmo23/.cosmo23-config/config.json` | COSMO config (API keys pre-seeded, rest managed by COSMO) | No (gitignored) |

Config loader merges: `home.yaml` <- `agent config.yaml` <- `secrets.yaml` <- per-agent secrets.

## Design Principles

- Build inside-out (engine/runtime first, UI last)
- Start flat (one project, not a monorepo)
- Settings must be real, not decorative
- The brain is the enduring cortex, not optional
- Engine stays JS. Harness is TS. Two languages, one system.
- Every change must be testable

## Rules

- Do NOT rewrite engine/. It is battle-tested JS.
- Do NOT rewrite feeder/. It works.
- ecosystem.config.cjs is auto-generated — do not edit manually.

## Key Documents

| Doc | Purpose |
|---|---|
| `docs/design/HOME23-DESIGN.md` | Original design spec |
| `docs/design/STEP2-AGENT-HARNESS-DESIGN.md` | Harness architecture |
| `docs/design/STEP3-UNIFIED-PROVIDERS-DESIGN.md` | Provider unification |
| `docs/design/STEP4-PROCESS-MANAGER-DESIGN.md` | PM2 setup |
| `docs/design/STEP5-CLI-INSTALLER-DESIGN.md` | CLI design |
| `docs/design/STEP7-DASHBOARD-DESIGN.md` | Dashboard design |
| `docs/design/STEP8-EVOBREW-INTEGRATION-DESIGN.md` | Evobrew integration design |
| `docs/design/STEP9-COSMO23-INTEGRATION-DESIGN.md` | COSMO 2.3 integration design |
| `docs/design/STEP9B-DASHBOARD-COSMO-EMBED-DESIGN.md` | Dashboard as OS home screen (iframe embed) |
| `docs/vision/HOME23_CANONICAL_VISION.md` | Product thesis |
| `docs/vision/HOME23_STACK_PYRAMID.md` | Architectural law |
| `docs/vision/HOME23_DRIFT_ANALYSIS_FROM_SESSION_HISTORY.md` | What went wrong last time |

## Engine Env Vars (Verified)

| Env var | What |
|---|---|
| `COSMO_CONFIG_PATH` | Engine YAML config path |
| `COSMO_RUNTIME_DIR` | Brain/state output dir |
| `COSMO_WORKSPACE_PATH` | Identity files path |
| `DASHBOARD_PORT` | Dashboard HTTP port (also set `COSMO_DASHBOARD_PORT`) |
| `REALTIME_PORT` | Engine WebSocket port |
| `MCP_HTTP_PORT` | MCP server port |
| `OLLAMA_CLOUD_API_KEY` | Ollama Cloud API key |
| `ANTHROPIC_AUTH_TOKEN` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `XAI_API_KEY` | xAI API key |
| `INSTANCE_ID` | Instance identifier |
| `OLLAMA_URL` | Ollama base URL |
| `HOME23_AGENT` | Agent name (harness reads this) |
