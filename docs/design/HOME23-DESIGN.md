# Home23 Design Spec

Status: approved design
Created: 2026-04-07
Purpose: design for a new, installable AI operating system built from cosmo-home_2.3

---

## What Home23 Is

Home23 is an installable AI operating system. It runs on any machine with Node.js and an internet connection — Mac, Linux, Raspberry Pi.

It provides:

- A **living cognitive engine** — not a stateless chatbot, but a system that thinks, dreams, consolidates, and grows its knowledge over time
- **Multi-agent support** — a home instance hosts one or more agents, each with their own brain, identity, cognitive loop, and channels
- **Multi-provider model access** — one unified provider/model config, engine and harness draw from the same pool but can use different models
- **Channel ingress** — Telegram, webhooks, extensible to others
- **Tool-use agent loop** — LLM-driven tool calling across Anthropic, OpenAI, Ollama Cloud, xAI, Codex
- **Cron scheduler** — timed agent turns, shell exec, brain queries
- **Feeder pipeline** — file watching, chunking, embedding, ingestion into the brain
- **Configurable embeddings** — local Ollama, Ollama Cloud, or OpenAI with fallback chain

Home23 is the house. Agents are the inhabitants. The engine is the living process. The brain is the enduring cortex. The model is the current voice.

### What it is not (initial build)

- Not a web app yet (UI comes after engine + harness work)
- Not a multi-tenant SaaS
- Not a rewrite of the COSMO engine
- Not a dashboard project

---

## Architecture

### Source: cosmo-home_2.3

Home23 is built from cosmo-home_2.3, which is two systems:

**The JS Engine** (~20,000 lines, 178 files) — the living brain. Cognitive loops, dreaming, sleep consolidation, network memory, query engine, dashboard API, 14+ specialist agents, goal system, quantum reasoner. This is copied as-is.

**The TS Bridge** (~9,300 lines, 39 files) — the agent harness. AgentLoop, tools, channels, scheduler, commands, system prompt, conversation history. This is extracted and made config-driven.

**The Feeder** (522 lines, standalone) — file watcher, chunker, embedder, brain ingester. Copied as-is with configurable embedding endpoint.

### Directory structure

```
Home23/
  engine/              <- JS COSMO engine (copied, not rewritten)
  feeder/              <- Ingestion pipeline (copied)
  src/                 <- TS harness layer (extracted + cleaned)
    agent/             <- AgentLoop, ContextManager, ConversationHistory, tools
    channels/          <- Telegram, webhooks, router
    scheduler/         <- Cron system
    commands/          <- Slash commands
    providers/         <- Unified provider/model config (new)
    config.ts          <- YAML config loader
    home.ts            <- Entry point / orchestrator
    process-manager.ts <- Child process lifecycle
  cli/                 <- Install + management commands (new)
    install.ts         <- Create home instance + register system service
    agent-create.ts    <- Create a new agent
    start.ts           <- Start the home
    stop.ts            <- Stop the home
    status.ts          <- Health check all agents
  templates/           <- Identity file templates for new agents (new)
  config/              <- Generated per-install
    home.yaml          <- Home-level config (providers, embedding, ports)
    secrets.yaml       <- API keys (gitignored)
  instances/           <- Per-agent directories
    <agent-name>/
      workspace/       <- Identity files (SOUL.md, MISSION.md, etc.)
      brain/           <- Engine state (state.json.gz, thoughts.jsonl, dreams.jsonl)
      conversations/   <- JSONL chat history
      cron-runs/       <- Scheduler state
      logs/            <- Process logs
      config.yaml      <- Agent-specific config (model choices, channel bindings)
```

### Key structural changes from cosmo-home_2.3

1. **`instances/` replaces `runs/` + `workspace/` + `state/`** — all per-agent state lives under one directory.

2. **Unified provider config** — replaces hardcoded `MODEL_ALIASES` in home.ts, `configs/jtr.yaml` engine model assignments, and `config/default.yaml` LLM section. One place to configure providers, one place for API keys.

3. **Agent as first-class entity** — each agent is a self-contained directory with its own brain, identity, and config. Creating a new agent means creating a new directory, not editing config files.

4. **Engine stays JS, harness stays TS** — two languages, one system. The engine is copied in and not rewritten.

5. **Embeddings configurable** — local Ollama, Ollama Cloud, or OpenAI. Fallback chain in config.

6. **System service** — Home23 registers itself as a launchd (Mac) or systemd (Linux) service. It starts on boot and runs continuously.

---

## Unified Provider System

### One config, two consumers

`config/home.yaml` has a `providers` section defining all available providers and their API keys:

```yaml
providers:
  anthropic:
    apiKey: "${ANTHROPIC_AUTH_TOKEN}"
    models:
      - claude-sonnet-4-6
      - claude-opus-4-6
      - claude-haiku-4-5

  openai:
    apiKey: "${OPENAI_API_KEY}"
    models:
      - gpt-5.4
      - gpt-5.4-mini

  ollama-cloud:
    apiKey: "${OLLAMA_CLOUD_API_KEY}"
    baseUrl: "https://ollama.com/v1"
    models:
      - minimax-m2.7
      - qwen3.5:397b
      - deepseek-v3.2

  ollama-local:
    baseUrl: "http://127.0.0.1:11434"
    models: "auto"

  xai:
    apiKey: "${XAI_API_KEY}"
    baseUrl: "https://api.x.ai/v1"
    models:
      - grok-4-0709

embeddings:
  providers:
    - provider: ollama-local
      model: nomic-embed-text
    - provider: openai
      model: text-embedding-3-small
    - provider: ollama-cloud
      model: nomic-embed-text
  # First available wins
```

Per-agent config (`instances/<name>/config.yaml`) assigns models from this pool:

```yaml
harness:
  defaultModel: claude-sonnet-4-6
  aliases:
    claude: claude-sonnet-4-6
    gpt: gpt-5.4
    qwen: qwen3.5:397b

engine:
  thought: minimax-m2.7
  consolidation: minimax-m2.7
  dreaming: minimax-m2.7
  query: gpt-5.4
```

### What this replaces

| Today in cosmo-home_2.3 | In Home23 |
|---|---|
| `MODEL_ALIASES` hardcoded in home.ts | `harness.aliases` in per-agent config |
| `configs/jtr.yaml` model assignments | `engine.*` in per-agent config |
| `config/default.yaml` LLM providers | `providers` in home.yaml |
| `config/secrets.yaml` API keys | `config/secrets.yaml` (same, referenced by home.yaml) |
| Feeder hardcoded to localhost Ollama | `embeddings.providers` fallback chain |

### Engine integration

The JS engine reads model assignments from a YAML config and API keys from env vars. The harness that spawns the engine:

1. Reads the unified provider config
2. Sets appropriate environment variables
3. Generates a `configs/<agent>.yaml` that the engine reads

Minimal changes to engine internals — it still reads YAML + env, they're just generated from the unified source.

---

## Process Management

### Internal process management

Home23 manages child processes per agent:

- **Spawns**: engine, feeder, harness per agent via `child_process`
- **Auto-restart on crash**: brief delay (1-5s), exponential backoff
- **Health checks**: periodic HTTP pings to engine dashboard ports
- **Crash ceiling**: if a process restarts more than N times in M minutes, stop trying and log
- **Clean shutdown**: SIGTERM propagates to all children, SIGKILL after timeout
- **Startup ordering**: engine first (brain up), then feeder (needs state file), then harness (needs engine API)
- **Port assignment**: each agent gets a port range at creation, no collisions. Each agent runs its own engine (cognitive loop + dashboard API), its own feeder, and its own harness process.
- **Logging**: stdout/stderr captured to `instances/<name>/logs/`, rotated by date

### System service

Home23 registers itself as a system service during install:

- **Mac**: launchd plist — starts on boot, restarts on crash
- **Linux**: systemd unit — same behavior

The install detects the OS and sets up the appropriate service. Uninstall removes the registration.

---

## Install and Agent Creation

### Installing Home23

```bash
git clone <repo> Home23
cd Home23
npm install
node cli/install.js
```

The install script asks:
1. Home name (e.g., "jtr-home", "pi-station")
2. Providers to configure (walks through API keys)
3. Embedding provider preference (local Ollama, cloud, OpenAI)
4. Create first agent? (prompts agent creation)

Produces `config/home.yaml`, `config/secrets.yaml`, registers system service.

### Creating an agent

```bash
node cli/agent-create.js
```

Asks:
1. Agent name
2. Identity basics (who is this agent, what's it for)
3. Model preferences (chat model, engine model)
4. Channels (Telegram bot token, webhooks)

Produces:
- `instances/<name>/workspace/` — SOUL.md, MISSION.md, HEARTBEAT.md, MEMORY.md, LEARNINGS.md from templates
- `instances/<name>/brain/` — empty, engine initializes on first run
- `instances/<name>/config.yaml` — model assignments, channel bindings, port assignments

### Management

```bash
node cli/start.js               # start everything
node cli/stop.js                # stop everything
node cli/status.js              # health of all agents
node cli/agent-create.js        # add another agent
node cli/agent-stop.js <name>   # stop one agent
```

---

## What Gets Copied, Cleaned, or Built New

### Copied as-is

| Source | What |
|---|---|
| `engine/` | Full COSMO engine (178 files, ~20K lines) |
| `feeder/` | Ingestion pipeline (522 lines) |
| `voice/` | Voice pulse daemon |

### Extracted and cleaned (made config-driven)

| Source | Lines | Changes |
|---|---|---|
| `src/agent/loop.ts` | 1,180 | OAuth headers into provider config |
| `src/agent/context.ts` | 193 | Paths from instance config |
| `src/agent/history.ts` | 206 | Paths from instance config |
| `src/agent/tools/*.ts` | 1,205 | Engine port from per-agent config. Drop alpaca tool. |
| `src/channels/telegram.ts` | 544 | As-is (already config-driven) |
| `src/channels/router.ts` | 560 | As-is |
| `src/scheduler/cron.ts` | 421 | Paths from instance config |
| `src/commands/handler.ts` | 606 | `/status` fix, model switching from unified config |
| `src/agents/system-prompt.ts` | 327 | Strip Althea-specific content, identity from workspace |
| `src/config.ts` | 86 | Expand for home + per-agent config layering |
| `src/home.ts` | 695 | Major refactor into multi-agent orchestrator |

### New

| Component | Purpose |
|---|---|
| `cli/install.ts` | Home setup, provider config, service registration |
| `cli/agent-create.ts` | Agent creation with identity templates |
| `cli/start.ts` | Start home, manage processes |
| `src/providers/` | Unified provider registry |
| `src/process-manager.ts` | Child process lifecycle, health checks, crash recovery |
| `templates/` | Identity file templates |
| Embedding abstraction | Config-driven embedding with fallback chain |

### Left behind

| What | Why |
|---|---|
| `engine-ukg/` | Shelved |
| `src/sibling/` | COZ-Axiom specific, add later if needed |
| `src/browser/cdp.ts` | Optional, not core |
| `src/observability/tts.ts` | Optional, not core |
| `src/channels/discord.ts` | Not tested, broken |
| `src/channels/imessage.ts` | Broken |
| `src/acp/` | Not tested |
| `projects/` | Instance-specific |
| `memory-pipeline/` | Replaced by feeder |

---

## Lessons from home23-canonical

### Patterns to re-implement

1. **Provider catalog as single source of truth** — one place for provider/model metadata
2. **Bootstrap-then-activate** — creating an agent is separate from running it
3. **Instance directory as canonical state** — agent truth lives in its directory
4. **Resume contract with fingerprinting** — detect config changes across restarts
5. **Identity file templates** — generate real identity prose from setup answers

### Mistakes to not repeat

1. Don't build outside-in (UI before runtime)
2. Don't create premature structure (9 packages before one working agent)
3. Don't build frontend ahead of backend truth
4. Don't skip live testing
5. Every build step should produce something that runs from the command line

---

## Build Order

Each step produces something testable before moving to the next.

### Step 1: Repo + engine + feeder running

- Create the repo
- Copy engine/ and feeder/ in
- Make engine start from config-driven instance path
- Make feeder read embedding endpoint from config
- Verify: engine runs a cognitive cycle, feeder ingests a file, brain grows

### Step 2: One agent harness working

- Extract TS bridge files, clean hardcoded paths
- Wire AgentLoop to provider config
- Wire ContextManager to instance workspace
- Wire ConversationHistory to instance directory
- Wire tools to agent's engine port
- Verify: send message via Telegram, get response, tools work, brain tools return results

### Step 3: Unified provider system

- Build provider config layer
- Engine reads from generated config
- Harness reads from per-agent config
- Embedding fallback chain works
- Verify: switch models via command, engine uses assigned models

### Step 4: Process manager + system service

- Internal process management (spawn/restart/health per agent)
- Startup ordering (engine -> feeder -> harness)
- Crash ceiling with backoff
- Register as launchd (Mac) or systemd (Linux)
- Verify: kill engine process, it restarts. Reboot machine, Home23 comes back.

### Step 5: CLI installer

- install.js, agent-create.js, start.js, stop.js, status.js
- Identity generation from templates
- Verify: fresh clone, run install, create agent, alive on Telegram

### Step 6: Multi-agent

- Create second agent in same home
- Separate brain, identity, channels
- Verify: two agents running, each with own cognitive loop and brain

After step 6, engine + harness level is complete. Front door (UI) is a separate phase.

---

## Design principles

From the canonical vision:

> The model is the current voice. The engine is the living process. The brain is the enduring cortex.

> Do not let Home23 collapse upward into "just chat." Do not let it collapse sideways into "just dashboards and settings." Do not let it collapse downward into "just a raw engine with no humane front door."

Build inside-out. Test from the command line. Every step runs before the next step starts.
