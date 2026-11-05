# Home23 Release Manifest

Everything that ships in the public repository.

## Root Files

| File | Purpose |
|---|---|
| package.json | Node project config |
| package-lock.json | Dependency lock |
| tsconfig.json | TypeScript config |
| .gitignore | Repository ignore rules |
| README.md | Project documentation |
| docs/ONBOARDING.md | Fresh-install and first-run validation guide |
| AGENTS.md | Repository-specific operating instructions for AI assistants |
| LICENSE | MIT license |
| CLAUDE.md | Codebase instructions for AI assistants |

## engine/ — Cognitive Engine (JS)

The COSMO-derived cognitive loop engine. Handles thinking, dreaming, brain growth, memory, and persistence.

### Source directories
- `src/` — Core engine source (cognition, dashboard, agents, ingestion, etc.)
- `tests/` — Test suite
- `scripts/` — Utility scripts
- `lib/` — Shared libraries
- `prompts/` — System prompts and templates
- `mcp/` — MCP server integration
- `tools/` — Engine tools
- `docs/` — Engine documentation
- `data/` — Static data files
- `config/` — Engine config templates
- `prisma/` — Database schema and migrations

### Root files
- package.json, package-lock.json
- .gitignore, .mocharc.json
- Dockerfile, docker-compose.yml
- .env.example
- external-integrations-starter.yaml

## src/ — TypeScript Agent Harness

The agent runtime layer: AgentLoop, tools, channels, routes, scheduler, worker routing, and situational awareness.

### Structure
- `agent/` — Core agent loop, discoverable tool registry, LLM integration, workers, skills, agency, and memory promotion. Brain access includes catalog, recent operations, canonical PGS partitions, search, direct/PGS query, export, graph, synthesis, and status; research access includes active/completed run discovery.
- `channels/` — Telegram, Discord, iMessage, and webhook channel adapters
- `routes/` — HTTP bridge endpoints (evobrew, chat, dashboard)
- `brain/` — Brain query and memory interface
- `config/` — Config loader (merges home.yaml + agent config + secrets)
- `home.ts` — Main entry point

## cli/ — CLI Installer

The `home23` command-line tool for guided setup, init, agent creation, start/stop/status/logs, and update checks.

### Structure
- `home23.js` — CLI entry point
- `lib/` — Command implementations (init, agent-create, start, stop, status, logs, etc.)
- `templates/` — Identity file templates for new agents

## Ingestion Pipeline

The standalone `feeder/` process is legacy and does not ship as an active component. Document ingestion now runs inside each agent's cognitive engine through `engine/src/ingestion/`, with dashboard control through Settings -> Feeder.

## config/ — Home-Level Config

| File | Purpose |
|---|---|
| home.yaml.example | Provider URLs, model aliases, chat defaults, embeddings, and default disabled local integrations |
| targets.yaml.example | Example host/target configuration |
| cron-jobs.json.example | Example scheduled job configuration |
| secrets.yaml.example | Template for API keys (copy to secrets.yaml) |

## configs/ — Engine Config Templates

| File | Purpose |
|---|---|
| base-engine.yaml | Cognitive loop config shared by all agents |

## evobrew/ — AI IDE

Bundled AI IDE for brain exploration, code editing, and agent interaction.

### Source directories
- `server/` — Express server, AI handler, brain integration
- `lib/` — Shared libraries
- `public/` — Frontend assets (HTML, CSS, JS)
- `scripts/` — Utility scripts
- `bin/` — CLI binaries
- `prisma/` — Database schema and migrations
- `docs/` — Documentation
- `storage/` — Storage layer
- `.github/` — CI/CD workflows

### Root files
- package.json, package-lock.json
- .gitignore, .env.example
- README.md, INSTALL.md, QUICKSTART.md, CLAUDE.md, AGENTS.md, LICENSE
- index.js

## cosmo23/ — Research Engine (COSMO 2.3)

Full research engine with 9-tab UI, multi-phase research runs, and brain integration.

### Source directories
- `engine/src/` — Core engine (cognition, dashboard, agents, ingestion)
- `engine/scripts/` — Engine utility scripts
- `engine/tests/` — Engine test suite
- `engine/mcp/` — MCP integration
- `engine/docs/` — Engine documentation
- `engine/brain-studio/` — Brain visualization tool
- `engine/brain-studio-new/` — Updated brain visualization
- `engine/lib/` — Engine libraries
- `engine/prompts/` — Engine prompts
- `engine/tools/` — Engine tools
- `engine/data/` — Engine data files
- `engine/config/` — Engine config
- `lib/` — Shared libraries
- `server/` — HTTP server
- `launcher/` — Process launcher
- `public/` — Frontend UI
- `ide/` — IDE integration
- `pgs-engine/` — PGS engine component

### Root files
- package.json, package-lock.json
- .env.example, .gitignore
- README.md, CLAUDE.md, AGENTS.md
- prisma/schema.prisma

### Engine root files
- engine/package.json, engine/package-lock.json
- engine/.gitignore, engine/.mocharc.json
- engine/Dockerfile, engine/docker-compose.yml
- engine/.env.example

## docs/ — Documentation

- `design/` — Design specs for each build step
- `vision/` — Product vision documents
- `audits/` — Pre-release audit reports
- `handoff/` — Recent implementation handoffs and verified runtime snapshots, including the 1.0 release receipt
- `SECURITY-AUDIT.md` — Security audit findings
- `ONBOARDING.md` — Fresh-install quickstart, validation commands, and no-data-loss operating notes

## scripts/ — Dev Scripts

- start-agent.sh — Agent start helper
- stop-agent.sh — Agent stop helper
- rebuild-ann-indexes.sh — Rebuild configured agents' ANN indexes, or a bounded explicit list of agent selectors, without hardcoded installation names

## What Does NOT Ship

- `node_modules/` — Install via npm
- `dist/` — Build via npm run build
- `ecosystem.config.cjs` — Generated by setup/agent creation for the local installation
- `config/home.yaml` — Created from `config/home.yaml.example`
- `config/targets.yaml` — Created from `config/targets.yaml.example`
- `config/cron-jobs.json` — Created from `config/cron-jobs.json.example`
- `config/agents.json` — Generated from local agent instances
- `config/secrets.yaml` — Create from secrets.yaml.example
- `instances/` — Local per-agent config, workspace, brain, logs, and conversation state
- `instances/*/brain/` — Generated at runtime
- `instances/*/logs/` — Generated at runtime
- `instances/*/conversations/` — Generated at runtime
- `runtime/` — Engine runtime state
- `runs/` — Research run output
- Any `.env` files — Create from .env.example templates
- Any `.DS_Store`, `.cursor/`, `.vscode/` files
