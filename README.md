# Home23

**An installable AI operating system — persistent agents with living brains.**

Home23 is not another chatbot framework. It is a complete AI operating system that runs on your machine, with agents that think autonomously, grow a persistent brain over time, dream during idle periods, and are reachable through Telegram, a web dashboard, an AI IDE, and a research engine.

Four integrated systems, one install:

- **Agent** — always-on AI with a cognitive loop, 30+ tools (including a full research toolkit for driving COSMO), Telegram channel, and an LLM-powered conversation interface
- **COSMO 2.3** — multi-phase research engine with guided runs, brain integration, and a 9-tab UI. Fully agent-drivable: your agent can launch runs, monitor them, query completed brains, and compile findings into its own memory
- **Evobrew** — AI-powered IDE with brain connectivity, multi-provider LLM support, and code editing
- **Dashboard** — OS home screen with real-time thoughts, chat, intelligence synthesis, settings, and full access to COSMO and Evobrew

## Prerequisites

- **Node.js 20+** (LTS recommended)
- **PM2** — process manager (`npm install -g pm2`)
- **Python 3** — for the document feeder's binary-format converter
- **MarkItDown** — optional but recommended: `pip install markitdown` lets the feeder ingest PDFs, DOCX, images, audio, and more
- **An LLM provider** — at least one of: Ollama Cloud (free), Anthropic, OpenAI, xAI
- **An embedding provider** — Ollama local (free, recommended), OpenAI, or Ollama Cloud

## Install

```bash
git clone https://github.com/notforyou23/home23.git
cd home23
node cli/home23.js init
```

The init wizard walks you through API keys, installs dependencies, and builds the TypeScript harness.

## Create an Agent

```bash
node cli/home23.js agent create my-agent
```

This creates the agent's directory structure, identity files, and config. Telegram is optional — skip the bot token prompt if you only want dashboard/IDE access.

## Start

```bash
node cli/home23.js start my-agent
```

This launches 3 processes for your agent plus 2 shared processes (Evobrew and COSMO). Open your browser:

- **Dashboard:** `http://localhost:5002/home23`
- **Settings:** `http://localhost:5002/home23/settings`
- **Evobrew IDE:** `http://localhost:3415`
- **COSMO Research:** `http://localhost:43210`

## Commands

```bash
node cli/home23.js status              # Check what's running
node cli/home23.js logs my-agent       # Tail agent logs
node cli/home23.js stop                # Stop all Home23 processes
node cli/home23.js evobrew update      # Pull latest Evobrew from GitHub
node cli/home23.js cosmo23 update      # Sync latest COSMO from source
```

## Embedding Provider

Your agent's brain uses vector embeddings for semantic memory. Pick one provider and stick with it — switching embedding providers means re-embedding your entire brain.

**Recommended (free):** Install [Ollama](https://ollama.com) locally and pull `nomic-embed-text`:

```bash
ollama pull nomic-embed-text
```

This runs entirely on your machine with no API key needed. The default config (`config/home.yaml`) is pre-configured for local Ollama embeddings.

**Alternatives:**
- **Ollama Cloud** — same model, hosted (requires Ollama Cloud API key)
- **OpenAI** — `text-embedding-3-small` (requires OpenAI API key, 1536 dimensions)

## LLM Providers

Unlike embeddings, you can switch LLM providers freely. Configure any combination in `config/secrets.yaml`:

| Provider | What you need | Models |
|---|---|---|
| **Ollama Cloud** | API key from ollama.com | kimi-k2.5, minimax-m2.7, qwen3.5, deepseek-v3.2, and more |
| **Anthropic** | API key | Claude Sonnet, Claude Opus |
| **OpenAI** | API key | GPT-5.4, GPT-5.4-mini |
| **xAI** | API key | Grok-4 |
| **Ollama Local** | Ollama running locally | Any pulled model |

Model aliases are defined in `config/home.yaml` — use short names like `sonnet`, `gpt`, `kimi` instead of full model IDs.

**Minimum setup (free):** Ollama Cloud provides free API access to many models. Use it for both LLM and embeddings to run Home23 with zero cost.

## Architecture

```
Home23/
  engine/        JS cognitive engine (loops, dreaming, brain growth, memory, ingestion)
  src/           TS agent harness (AgentLoop, 30+ tools, channels, routes)
  cli/           CLI installer and management commands
  config/        Provider URLs, model aliases, API keys
  configs/       Shared engine config templates (base-engine.yaml incl. feeder block)
  instances/     Per-agent directories (workspace, brain, conversations)
  evobrew/       AI IDE (brain exploration, code editing, multi-provider)
  cosmo23/       Research engine (guided runs, multi-phase, brain integration)
  scripts/       Helper scripts
  docs/          Design specs and vision documents
```

### Processes (per agent)

Each agent runs 3 PM2 processes, plus 2 shared:

| Process | Purpose | Default Port |
|---|---|---|
| `home23-<name>` | Cognitive engine — thinking, dreaming, brain growth, document ingestion | 5001 (WS + admin HTTP) |
| `home23-<name>-dash` | Dashboard API — brain queries, state, settings, feeder drop zone | 5002 (HTTP) |
| `home23-<name>-harness` | Agent runtime — Telegram, 30+ tools, LLM loop | 5004 (bridge) |
| `home23-evobrew` | AI IDE (shared across all agents) | 3415 |
| `home23-cosmo23` | Research engine (shared, on-demand) | 43210 |

Multiple agents get sequential port blocks: first agent 5001-5004, second 5011-5014, etc.

The document feeder runs **inside** the cognitive engine process (no separate PM2 entry). Configure it from the Feeder tab in Settings.

## Configuration

| File | Purpose |
|---|---|
| `config/home.yaml` | Provider URLs, model aliases, embedding config, defaults |
| `config/secrets.yaml` | API keys and bot tokens (create from `secrets.yaml.example`) |
| `instances/<name>/config.yaml` | Per-agent: ports, owner, channels, model, scheduler |
| `configs/base-engine.yaml` | Cognitive loop timing and behavior (shared) |

## How It Works

The cognitive engine runs continuous think-consolidate-dream cycles. During waking hours, it processes thoughts, pursues goals, and responds to messages. During sleep periods, it dreams — synthesizing connections across its brain, consolidating knowledge, and growing.

Documents fed through the feeder are LLM-synthesized before brain entry: raw text becomes structured knowledge with extracted concepts, relationships, and insights. A brain knowledge index is maintained automatically as a human-readable map of everything the agent knows. Feeder behavior is fully configurable from the dashboard's Settings → Feeder tab (watch paths, exclusion patterns, chunking, compiler model, converter, drop zone) — see "Document Feeder" below.

The dashboard is the OS home screen. It shows real-time thoughts, provides a native chat interface with full thinking/tool visibility, runs intelligence synthesis on a schedule, and gives access to COSMO research and Evobrew IDE — all from a single URL.

## Agent Research Toolkit

Your agent has 11 atomic tools for driving COSMO 2.3 research runs directly from a chat message or autonomous action. Each tool maps to one COSMO HTTP endpoint:

| Tool | Purpose |
|---|---|
| `research_list_brains` | Enumerate available research brains with node/cycle counts |
| `research_query_brain` | Query ONE brain (modes: quick / full / expert / dive) |
| `research_search_all_brains` | Query the top-N most recent brains in parallel |
| `research_launch` | Start a new research run with full parameters (topic, **context**, cycles, models) |
| `research_continue` | Resume a completed brain with new focus |
| `research_stop` | Gracefully stop the active run |
| `research_watch_run` | Cursor-paginated log tail during a run |
| `research_get_brain_summary` | Aggregated executive/goals/trajectory overview |
| `research_get_brain_graph` | Knowledge graph structure (nodes, edges, clusters) |
| `research_compile_brain` | Save whole-brain synthesis to your workspace (auto-ingested into agent memory) |
| `research_compile_section` | Save one specific goal or insight as a focused memory node |

The workflow policy lives in a skill file (`workspace/COSMO_RESEARCH.md`) that is loaded into every agent turn — it tells the agent when to use which mode, why `context` is critical for guided runs, and the rules (never double-launch, always check existing brains first, prefer section compiles for focused knowledge).

When a research run is active, the agent's system prompt automatically receives a live `[COSMO ACTIVE RUN]` block with the run name, topic, and status — so it can't accidentally launch a second one or lose track of what's in flight.

**Typical interaction:**

```
You:     "Research the invention of the Post-it Note. Keep it light — general audience,
          5 cycles, Wikipedia sources fine."

Agent:   [launches with context → waits → compiles → reports]
         "Launched run 'invention-of-the-post-it-note' (5 cycles, gpt-5.2).
          … [10 minutes later] …
          Compiled the synthesis to workspace/research/. Key finding:
          Post-it Note is a two-stage invention — Spencer Silver's 1968
          repositionable adhesive plus Art Fry's 1974 hymnal bookmark
          application, commercialized in the late 1970s."
```

The compiled research lands in `instances/<agent>/workspace/research/` and the engine feeder automatically ingests it as a permanent memory node with citations back to the COSMO brain. Your agent now knows that fact forever.

See `docs/design/STEP16-AGENT-COSMO-TOOLKIT-DESIGN.md` for the full design, schemas, and smoke test procedure.

## Document Feeder

The Feeder continuously ingests documents from watched directories into your agent's brain. Each file is LLM-synthesized by the document compiler into structured knowledge (concepts, relationships, insights) before being stored as a memory node. Binary formats (PDF, DOCX, images, audio) are converted to markdown first via MarkItDown.

Configure everything from the dashboard at **Settings → Feeder**:

| Section | What you control |
|---|---|
| **Live Status** | Real-time view: running state, watcher count, files processed / total, compiled count, pending queue, converter availability. `Force Flush Now` button to process the queue immediately. |
| **Paths & Patterns** | Auto-watched paths (drop zone + workspace, shown read-only). Add your own watch paths with labels. Exclusion patterns (glob syntax, one per line) for things like `node_modules/**` or `.git/**`. |
| **Frequency & Batching** | Flush interval (seconds), batch size, chunking parameters (max chunk size, overlap). |
| **Compiler** | Enable/disable the LLM-powered document compiler. Choose the model (default: `minimax-m2.7`). Disabling means raw chunks enter the brain — lower quality, more noise. |
| **Converter** | Enable/disable binary-to-markdown conversion. Pick the vision model for PDFs/images (default: `gpt-4o-mini`). Live status indicator shows whether MarkItDown is installed. |
| **Drop Zone** | Drag-and-drop files directly into a watched directory. Optional label groups uploads. Max 100MB per file, 20 files per upload. Files are picked up within ~1 second and automatically ingested. |

Settings are stored in `configs/base-engine.yaml` under the `feeder:` block and apply host-wide to all Home23 agents. Some changes hot-apply (compiler model, adding watch paths); others (flush interval, chunking, exclusion patterns, converter) require an engine restart — the UI shows a clear restart banner when needed.

**Typical use:**
- Drop a folder of reference PDFs into the dropzone — the feeder converts them to markdown, the compiler extracts key concepts, and each becomes a brain node the agent can recall via semantic search
- Add a watch path to your project's docs directory — any new markdown file you save there is automatically ingested within a few seconds
- Tune the compiler model to something cheaper/faster for bulk ingestion, then switch back for quality

See `docs/design/STEP17-FEEDER-SETTINGS-DESIGN.md` for the full design.

## License

MIT. See [LICENSE](LICENSE).
