# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

COSMO 2.3 is the standalone carve-out of COSMO Unified — a local AI research system with Launch, Brains, Watch, Query, Brain Map, and Intelligence surfaces. It runs research "brains" using multi-agent orchestration with LLM providers (OpenAI, OpenAI Codex, Anthropic via OAuth, xAI, Ollama, Ollama Cloud, LM Studio).

## Commands

```bash
# Setup
npm install
npm run db:generate          # Generate Prisma client (SQLite)

# Run
npm start                    # Production: node server/index.js
npm run dev                  # Development: nodemon server/index.js

# Tests (run from engine/ directory)
cd engine
npm test                     # Unit + integration tests
npm run test:unit            # mocha tests/unit/**/*.test.js --timeout 10000
npm run test:integration     # mocha tests/integration/**/*.test.js --timeout 30000
npm run test:agents          # Agent structure validation
npm run test:single-instance # Unit + single-instance tests
npm run test:multi-instance  # Multi-instance cluster tests (--timeout 120000)

# Run a single test
cd engine && npx mocha tests/unit/guided-mode-planner.test.js --timeout 10000
```

## Ports

| Service        | Default | Env Override              |
|----------------|---------|---------------------------|
| Web app        | 43110   | `COSMO23_PORT`            |
| WebSocket      | 43140   | `COSMO23_WS_PORT`         |
| Watch dashboard| 43144   | `COSMO23_DASHBOARD_PORT`  |
| MCP HTTP       | 43147   | `COSMO23_MCP_HTTP_PORT`   |

## External / merged run note

When COSMO 2.3 surfaces are pointed at an external merged run instead of the repo-local default runtime tree, both MCP and dashboard layers must honor `COSMO_RUNTIME_DIR`, and dashboard routes must resolve `current` against the active run dir.

Otherwise the UI/intelligence surface can falsely report a fresh zero-state run even while the real run is live and progressing on disk.

## Architecture

### Server Layer (`server/`)
Express.js app in `server/index.js`. Routes for launch control, brain queries, intelligence data, provider management, and Anthropic OAuth. Provider adapters in `server/providers/` (Anthropic, OpenAI, Ollama, Ollama Cloud, xAI). Services in `server/services/` (OAuth, encryption). Config in `server/config/` (model catalog, platform detection). Intelligence endpoints serve goals, plans, thoughts, agents, insights, trajectory, executive, and deliverables from any brain's saved state.

### Engine (`engine/src/`)
The core runtime, separate from the standalone server wrapper.

- **`core/orchestrator.js`** — Main runtime loop: spawn → execute → review → integration cycles
- **`core/guided-mode-planner.js`** — Guided-run plan generation with brain-informed decisions and state audit on resume
- **`core/unified-client.js`** — LLM client abstraction across all providers (OpenAI, Anthropic, xAI, local Ollama, Ollama Cloud)
- **`coordinator/meta-coordinator.js`** — Strategic coordination every N cycles: goal-setting, prioritization, tier spawning
- **`coordinator/executive-coordinator.js`** — Tactical coordination every cycle
- **`coordinator/action-coordinator.js`** — Transforms knowledge into executable actions, key discovery
- **`agents/agent-executor.js`** — Agent spawning, execution, result integration, follow-ups
- **`agents/research-agent.js`** — Research handoff and output generation
- **`agents/execution-base-agent.js`** — Shared base for execution agents: bash, Python, filesystem, HTTP, SQLite, sandbox, agentic loop
- **`agents/data-acquisition-agent.js`** — Web scraping, API consumption, file downloading, feed ingestion (CLI-first, tool-composing)
- **`agents/data-pipeline-agent.js`** — ETL, database creation (SQLite/DuckDB), validation, export
- **`agents/infrastructure-agent.js`** — Container management, service setup, environment provisioning
- **`agents/automation-agent.js`** — General-purpose OS automation with graduated safety (replaces ExperimentalAgent)
- **`agents/`** — 33+ agent types including DisconfirmationAgent (adversarial hypothesis testing)
- **`memory/network-memory.js`** — Multi-dimensional knowledge graph (nodes, edges, embeddings, validations)
- **`execution/`** — Plugin→Skill→Tool execution architecture:
  - `tool-registry.js` — Discovers and tracks atomic executables (27 tools: python, node, docker, git, curl, jq, sqlite3, wget, ffmpeg, pandoc, duckdb, httpie, rsync, gh, etc.)
  - `skill-registry.js` — Reusable operations with invocation, learned skill pipeline
  - `plugin-registry.js` — Domain bundles with relevance scoring
  - `capability-manifest.js` — Structured JSON descriptions of execution agent capabilities, injected into coordinator LLM prompts
  - `tool-discovery.js` — Active runtime tool discovery via npm/pip/GitHub search, scoped package installation
  - `environment-provisioner.js` — Local pip + Docker container provisioning
  - `execution-monitor.js` — Code execution, output contract validation, memory ingestion
  - `campaign-memory.js` — Cross-run learning (patterns, skill effectiveness, fork strategies)
  - `schemas.js` — Contract schemas for tools, skills, plugins, output contracts
- **`cluster/`** — Multi-instance support via Redis or filesystem (leader election, goal allocation, CRDT merging)
- **`cognition/`** — Dynamic roles, state modulation, trajectory forking
- **`dashboard/`** — Terminal UI for monitoring active runs
- **`realtime/`** — WebSocket server for live streaming
- **`ingestion/`** — Document ingestion pipeline for feeding files into a run's memory graph:
  - `document-feeder.js` — Entry point, lifecycle, chokidar file watcher, runtime API
  - `document-converter.js` — Binary-to-markdown via MarkItDown + GPT-4o-mini vision (PDF, DOCX, images, audio, etc.)
  - `document-chunker.js` — Semantic chunking (headings, paragraphs, code fences) with sliding-window fallback
  - `ingestion-manifest.js` — SHA256 dedup, pending queue, batched flush to live NetworkMemory
  - `convert-file.py` — Python MarkItDown wrapper for document conversion

### Launcher (`launcher/`)
Bridges the web UI and engine. `config-generator.js` converts UI model selections (Primary/Fast/Strategic roles) into engine YAML config. `process-manager.js` spawns engine subprocesses and emits `cosmo-exit` events on engine exit for lifecycle cleanup. `run-manager.js` manages run lifecycle.

### Frontend (`public/`)
Vanilla JS single-page app (no framework, no build step). `index.html` has six views: Launch, Brains, Watch, Query, Brain Map, Intelligence. `app.js` is the core controller. Module files in `js/`:
- **`js/query-tab.js`** — Research/query interface with streaming, PGS controls (dual sweep/synthesis model selectors), suggestions, and export
- **`js/brain-map.js`** — 3D force-directed knowledge graph visualization using `3d-force-graph` (three.js). Node click inspection, connection navigation, Query tab bridge
- **`js/intelligence-tab.js`** — Brain data explorer with 8 sub-tabs (Goals, Plans, Thoughts, Agents, Insights, Executive, Trajectory, Deliverables). All data works on any saved brain regardless of run status

Design system uses Google Fonts (Instrument Serif, DM Sans, JetBrains Mono), petrol accent (`#1a5c52`), warm parchment ground (`#f4f1eb`). CSS variables bridge the query tab's parallel token system.

### Shared Libraries (`lib/`)
Brain query engine (`query-engine.js`), PGS semantic search (`pgs-engine.js`), brain semantic search, suggestions, export, config loading, encryption, daemon management.

### Prisma (`prisma/`)
Minimal SQLite schema — single `SystemConfig` table for encrypted OAuth tokens, feature flags, and system settings.

## Safety Rules (from AGENTS.md)

- **Never delete or modify `runs/` artifacts** unless explicitly asked — they are historical evidence.
- **Never mutate archived plans, tasks, or old outputs.**
- Guided runs are exclusive: no autonomous discovery or slot reservation during guided execution.
- If a guided-run fix would change autonomous mode behavior, isolate it.
- Preserve backward compatibility at API boundaries; normalize old inputs internally.
- The wrapper (`server/`, `launcher/`) is not the engine. Guided-run behavior changes usually belong in `engine/src/`, not only in the standalone server.

## Key Conventions

- Three model roles for launch: **Primary** (default agent work), **Fast** (coordinator, planner, quick turns), **Strategic** (synthesis, QA, higher-value reasoning)
- Embeddings are locked to OpenAI `text-embedding-3-small` at 512 dimensions — not user-configurable in v1
- Local storage lives in `~/.cosmo2.3/` (config, model catalog, OAuth DB)
- Brain directories configured in `~/.cosmo2.3/config.json` under `features.brains.directories[]` — scans all configured paths for runs
- Reference brains from external directories are read-only; continuing one imports it into local `runs/` first
- **Ollama Cloud** provider (`ollama.com/v1`) uses OpenAI-compatible API with dynamic model discovery and 5-min TTL cache. API key in config under `providers.ollama-cloud.api_key`
- **Anthropic and OpenAI Codex are both OAuth-only** — neither accepts API keys. Anthropic uses PKCE OAuth via claude.ai; OpenAI Codex uses JWT OAuth via api.openai.com with OAuth JWT. Both store tokens in SQLite via Prisma. Both `server/services/anthropic-oauth.js` and `engine/src/services/anthropic-oauth-engine.js` must stay in sync
- **OpenAI Codex** is a distinct provider from standard OpenAI (API key). Both can be active simultaneously. Overlapping model names appear in both providers; the user's picker selection determines routing. Codex uses `api.openai.com with OAuth JWT` with Codex-specific headers and dynamic model discovery.
- **No hardcoded model names** in agent/coordinator code — all model selection is config-driven via `config.models.primary`, `config.models.fast`, `config.models.strategicModel`, etc.
- **PGS sweep model** is configurable per-query (UI has dual model selectors for sweep and synthesis). Falls back to catalog default then synthesis model
- **Three-level execution hierarchy:** Plugin → Skill → Tool. Plugins are domain bundles, Skills are reusable operations, Tools are atomic executables. Full self-extension: COSMO can discover tools, learn skills from successful executions, and generate plugins at runtime
- **Execution results become memory nodes** — tag `execution_result` (success) or `execution_failure` (failure), both protected from decay
- **Campaign memory** persists cross-run at `~/.cosmo2.3/campaign-memory/` — assumption-sensitivity patterns, skill effectiveness, fork strategies
- **DisconfirmationAgent** — adversarial hypothesis testing spawned after synthesis reviews, generates falsification targets
- Coordinators influence via goals and priorities, not direct agent commands (state-driven, not command-driven)
- **Execution agent layer** — four CLI-first, tool-composing agents (DataAcquisition, DataPipeline, Infrastructure, Automation) that extend `ExecutionBaseAgent`. They compose existing CLI tools (curl, jq, sqlite3, playwright, etc.) via an agentic LLM loop. Differentiated by domain knowledge in system prompts, not hardcoded logic. Coordinators dispatch them via a Capability Manifest injected into LLM prompts. Extended timeouts (15-30 min). Three-tier tool discovery: static registry scan → runtime npm/pip/GitHub search → learned skills from prior runs.
- **ExperimentalAgent is deprecated** — replaced by AutomationAgent with graduated safety (non-destructive ops free, destructive require approval)
- **Document feeder** is part of the run lifecycle — starts with the engine, stops on shutdown. Default drop zone is `runs/<name>/ingestion/documents/` (recursive). Files dropped in subdirectories get labeled by directory name. Feeder writes directly to live `NetworkMemory` via `addNode()`. Config under `feeder:` block in `config.yaml`. Requires `chokidar` (Node) and optionally `markitdown` (Python) for binary formats.

## Investigation Corpus

`investigations/` contains research and synthesis docs. Read `investigations/cosmo-2.3-master-synthesis.md` before working on guided runs. Verify implementation files before editing — some investigation references may be stale even when conclusions are correct.
