# Home23

Installable AI operating system — persistent agents with living brains.

## What This Is

Home23 takes the proven COSMO engine (JS, cognitive loops, dreaming, brain) and the TS agent harness (AgentLoop, tools, channels, scheduler) and packages them into something installable and portable — any machine, any OS, with an internet connection.

## Quick Start

```bash
# First time setup
node cli/home23.js init                    # Deps, build, encryption key, config seeding

# Create an agent
node cli/home23.js agent create <name>     # Guided setup

# Run it
node cli/home23.js start <name>            # Starts agent + evobrew + COSMO
node cli/home23.js status                  # Check what's running
node cli/home23.js logs <name>             # Tail logs
node cli/home23.js stop                    # Stop everything
node cli/home23.js update                  # Update to latest release
```

## Architecture

```
Home23/
  engine/              <- JS COSMO engine (DO NOT REWRITE)
    src/ingestion/     <- Document feeder (chokidar, compiler, converter, manifest)
    src/realtime/      <- WebSocket + /admin/feeder/* HTTP on port 5001
  src/                 <- TS harness layer
    agent/tools/       <- 31 agent tools (files, web, brain, research_*, promote_to_memory, etc.)
    agent/context-assembly.ts  <- Situational awareness: pre-turn brain query + surface loading
    agent/memory-objects.ts    <- MemoryObject + ProblemThread CRUD (Step 20)
    agent/event-ledger.ts      <- Continuity proof chain (append-only JSONL)
    agent/trigger-index.ts     <- Trigger-based memory reactivation
  dist/                <- Compiled JS output (gitignored)
  cli/                 <- CLI installer + management commands
    lib/               <- Command implementations
    templates/         <- Identity file templates (incl. COSMO_RESEARCH.md skill)
  config/              <- Home-level config
    home.yaml          <- Provider URLs, model aliases, chat defaults
    secrets.yaml       <- API keys, bot tokens (gitignored)
  configs/             <- Engine config templates
    base-engine.yaml   <- Cognitive loop + feeder config (shared by all agents)
  instances/           <- Per-agent directories (all gitignored)
    <agent-name>/
      workspace/       <- Identity files (SOUL.md, MISSION.md, COSMO_RESEARCH.md, BRAIN_INDEX.md, etc.)
      brain/           <- Engine state (thoughts, goals, dreams, metrics, ingestion-manifest.json)
      conversations/   <- JSONL chat history
      config.yaml      <- Agent-specific config (ports, model, channels)
      logs/            <- Process logs
  evobrew/             <- Bundled AI IDE
  cosmo23/             <- Bundled research engine (COSMO 2.3) — see COSMO23-VENDORED-PATCHES.md
  logs/                <- Home-level logs (evobrew)
  scripts/             <- Dev start/stop scripts (PM2 is primary)
  ecosystem.config.cjs <- PM2 config (auto-generated from instances)
```

Note: `feeder/` (a standalone feeder process) is legacy and gone. All document ingestion happens inside the cognitive engine via `engine/src/ingestion/`.

## Process Architecture (per agent)

Each agent runs 3 processes managed by PM2, plus 2 shared processes:

| Process | Script | Purpose | Port |
|---|---|---|---|
| `home23-<name>` | `engine/src/index.js` | Cognitive engine (loops, dreaming, brain growth, **document ingestion**) | 5001 (WS + admin HTTP) |
| `home23-<name>-dash` | `engine/src/dashboard/server.js` | HTTP API (brain queries, state, settings, feeder upload/proxy) | 5002 (HTTP) |
| `home23-<name>-harness` | `dist/home.js` | TS agent (Telegram, 31 tools incl. research_* + promote_to_memory, LLM loop, situational awareness engine) | 5004 (bridge) |
| `home23-evobrew` | `evobrew/server/server.js` | AI IDE (shared, all agents) | 3415 |
| `home23-cosmo23` | `cosmo23/server/index.js` | Research engine (shared, on-demand runs) | 43210 |

Ports auto-assigned per agent: first agent 5001/5002/5003/5004, second 5011/5012/5013/5014, etc.

The cognitive engine process owns both the cognitive loop AND the document feeder. The dashboard process proxies feeder admin commands (flush, add-watch-path, etc.) to the engine's `/admin/feeder/*` endpoints on port 5001.

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

Tab bar (the OS dock): Home, Intelligence, Brain Map, About, Settings, COSMO, evobrew.

- **Home tab** — Three-column tile grid: Thoughts (left), Vibe (center), **Chat** (right). System stats bar + engine pulse bar at top. Feeder + Brain Log at bottom. Chat tile connects to agent loop via SSE with full thinking/tool visibility, agent selector, model selector, conversation history, expand to overlay or standalone `/home23/chat`.
- **Settings tab** — Full settings page at `/home23/settings` with nested sub-tabs: Providers (API keys), Agents (create/edit/channels/start/stop), Models (aliases/defaults), **Feeder** (watch paths, exclusion patterns, chunking, compiler model, converter, drop zone), System (ports/embeddings/maintenance). First-run shows welcome screen -> Settings onboarding flow. Primary agent concept (first agent, can't be deleted).
- **Intelligence tab** — Synthesis agent reads brain + index and produces curated insights. Scheduled synthesis every 4 hours; manual trigger button also available.
- **Brain Map tab** — 3D force-directed knowledge graph visualization of the agent's brain.
- **COSMO tab** — Full COSMO 2.3 research UI embedded via iframe (all 9 tabs). Iframe preserves state across tab switches.
- **Evobrew button** — Opens AI IDE in new tab with `?agent=<name>` pre-selection.

All URLs use `window.location.hostname` (not hardcoded localhost) — works over Tailscale, LAN, or localhost.

### Evobrew (AI IDE)

Bundled at `evobrew/`, served at `http://localhost:3415`. One shared PM2 process for all agents. Auto-configured from home.yaml + secrets.yaml + instances. Dashboard button opens evobrew with `?agent=<name>` to pre-select model + brain.

Agents appear as `local:<name>` in the model dropdown. Chat goes through the bridge endpoint (`src/routes/evobrew-bridge.ts`) which runs the full agent loop with identity/tools/memory. Brain auto-connects on launch.

### COSMO 2.3 (Research Engine + OAuth Broker)

Bundled at `cosmo23/`, served at `http://localhost:43210`. One shared PM2 process — COSMO manages its own subprocesses internally when a run is active. Config pre-seeded with API keys from Home23 via `cli/lib/cosmo23-config.js` (plaintext in gitignored `.cosmo23-config/` dir, env vars via PM2 as the authoritative source).

Full COSMO UI embedded in dashboard via iframe (all 9 tabs). The agent has 11 `research_*` tools (list/query/search_all/launch/continue/stop/watch/get_brain_summary/get_brain_graph/compile_brain/compile_section) mapping to COSMO's HTTP API. Workflow policy lives in `instances/<agent>/workspace/COSMO_RESEARCH.md` (loaded as an identity layer file). When a COSMO run is active, `src/agent/loop.ts` polls `/api/status` and injects a live `[COSMO ACTIVE RUN]` block into the system prompt. Research brains are visible in evobrew.

**OAuth broker**: cosmo23 doubles as Home23's OAuth provider for Anthropic and OpenAI Codex. cosmo23 has a battle-tested PKCE implementation with encrypted token storage (SQLite + Prisma + AES-256-GCM) and automatic refresh. Home23's Settings → Providers → OAuth Sign-in UI proxies to cosmo23's `/api/oauth/anthropic/*` and `/api/oauth/openai-codex/*` routes, then mirrors the resulting access tokens into `config/secrets.yaml` where they flow to the engine/harness via PM2 env injection. A 30-minute background poller in `engine/src/dashboard/server.js` catches cosmo23-side token rotations and re-syncs secrets.yaml + restarts the engine + harness (skipped during active research runs).

**Critical:** `cosmo23/` has been patched with 5 structural fixes (config dir unification, env-first key resolution, decrypt-safe bootstrap, raw-token admin endpoints, and HOME23_MANAGED provider suppression). All patches are tracked in `docs/design/COSMO23-VENDORED-PATCHES.md`.

### Ingestion Compiler + Feeder

Documents are watched by `engine/src/ingestion/document-feeder.js` (chokidar-based), converted from binary formats via `document-converter.js` (MarkItDown + vision OCR), chunked, validated, classified, and then synthesized by an LLM via `document-compiler.js` before brain entry. Compiler produces structured synthesis (key concepts, relationships, insights) stored as brain nodes rather than raw text. A brain knowledge index is maintained automatically at `instances/<name>/workspace/BRAIN_INDEX.md`.

Feeder configuration lives in `configs/base-engine.yaml` under the `feeder:` block and is fully editable from the dashboard's **Settings → Feeder** tab: watch paths, exclusion patterns, chunking, flush cadence, compiler model, converter settings, and a drag-and-drop drop zone. Settings classify as hot-apply (compiler model, new watch paths) or restart-required (flush interval, chunking, converter) with a UI banner when a restart is needed.

Conversation sessions are compiled to workspace on session gap (idle timeout). The agent's `research_compile_brain` and `research_compile_section` tools write compiled COSMO research summaries into `workspace/research/` where the feeder auto-ingests them as permanent brain nodes.

> The model is the current voice. The engine is the living process. The brain is the enduring cortex.

### Situational Awareness Engine (Step 20)

Before every LLM call, the agent's context assembly layer (`src/agent/context-assembly.ts`) queries the brain and loads domain surfaces into the system prompt. This replaces the old static `MEMORY.md` + `semanticRecall` approach.

**Key files:**
- `src/agent/context-assembly.ts` — pre-turn brain query + trigger eval + surface loading + salience ranking + degraded mode
- `src/agent/memory-objects.ts` — MemoryObject + ProblemThread CRUD with confidence anti-theater constraints
- `src/agent/event-ledger.ts` — append-only JSONL at `instances/<agent>/brain/event-ledger.jsonl`
- `src/agent/trigger-index.ts` — trigger-based reactivation (keyword, temporal, domain_entry)
- `src/agent/tools/promote.ts` — `promote_to_memory` tool for mid-conversation promotion
- `engine/src/core/curator-cycle.js` — brain-node intake governance, surface rewriting, audit metrics

**Domain surfaces** (per-agent, curator-maintained in `instances/<agent>/workspace/`):
- `TOPOLOGY.md` — fact surface (ports, services, URLs)
- `PROJECTS.md` — active project state
- `PERSONAL.md` — owner relationship context (consent-gated)
- `DOCTRINE.md` — conventions, boundaries, constraints
- `RECENT.md` — last 24-48h digest

**Memory objects** live in `instances/<agent>/brain/memory-objects.json`. Problem threads in `problem-threads.json`. Trigger index in `trigger-index.json`. All are JSON, all are gitignored.

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
- Home23 is the single authority for all provider configuration. Cosmo23 and evobrew are consumers — they get keys via PM2 env vars.
- Every change must be testable

## Rules

- Do NOT rewrite engine/. It is battle-tested JS. Fix root-cause bugs directly; avoid wholesale rewrites.
- Do NOT rewrite `engine/src/ingestion/`. It is the ingestion pipeline — the legacy `feeder/` dir is gone.
- Do NOT edit `cosmo23/` without reading `docs/design/COSMO23-VENDORED-PATCHES.md` first. Five vendored patches must survive every upstream resync.
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
| `docs/design/STEP10-INGESTION-COMPILER-DESIGN.md` | LLM-powered document compiler |
| `docs/design/STEP11-INTELLIGENCE-TAB-DESIGN.md` | Intelligence tab + scheduled synthesis |
| `docs/design/STEP13-DASHBOARD-CHAT-DESIGN.md` | Dashboard chat with SSE + tool visibility |
| `docs/design/STEP14-VIBE-INTEGRATION-DESIGN.md` | Vibe tile + CHAOS MODE image flow |
| `docs/design/STEP15-DESIGN-LANGUAGE-OVERHAUL.md` | ReginaCosmo design language |
| `docs/design/STEP16-AGENT-COSMO-TOOLKIT-DESIGN.md` | 11 `research_*` tools + skill file + active-run injection |
| `docs/design/STEP17-FEEDER-SETTINGS-DESIGN.md` | Feeder settings tab + drop zone |
| `docs/design/STEP18-OAUTH-SETTINGS-DESIGN.md` | Anthropic + OpenAI Codex OAuth via cosmo23 broker |
| `docs/design/STEP19-TELEGRAM-MESSAGE-HANDLING-DESIGN.md` | Adaptive debounce + queue-during-run for Telegram |
| `docs/design/STEP20-SITUATIONAL-AWARENESS-ENGINE-DESIGN.md` | **CORE:** Brain-driven pre-turn context assembly, governed memory objects, event ledger, curator cycle |
| `docs/design/STEP21-PROVIDER-AUTHORITY-DESIGN.md` | **CORE:** Home23 owns all provider config — single encryption key, guided onboarding, cosmo23/evobrew as consumers |
| `docs/design/STEP22-UPDATE-SYSTEM-DESIGN.md` | Update system — one command, versioned releases, migration system |
| `docs/design/STEP23-SITUATIONAL-AWARENESS-PRIMITIVE.md` | **CORE:** Per-session NOW.md + PLAYBOOK.md bootstrap. System-level primitive; every agent + subagent + cron run grounded on fresh sessions |
| `docs/design/COSMO23-VENDORED-PATCHES.md` | **CRITICAL:** patches to vendored cosmo23 that must survive updates |
| `docs/design/SLEEP-WAKE-DESIGN.md` | Engine sleep/wake tuning for Home23 |
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
| `HOME23_MANAGED` | Set to 'true' for evobrew + cosmo23 — suppresses their provider UI |
| `ENCRYPTION_KEY` | 64-char hex key for cosmo23 OAuth token encryption (generated by init) |
| `DATABASE_URL` | Prisma SQLite path for cosmo23 OAuth token storage |
