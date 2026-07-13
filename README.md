# Home23 v1.0.0

**An installable AI operating system — persistent agents with living brains.**

Home23 is not another chatbot framework. It is a complete AI operating system that runs on your machine, with agents that think autonomously, grow a persistent brain over time, dream during idle periods, and are reachable through Telegram, Discord, a web dashboard, an AI IDE, a research engine, and a mobile-optimized chat page you can Add to Home Screen on iOS.

**Documentation status:** refreshed 2026-07-02 for the 1.0 release. The release metadata, README, changelog, manifest, onboarding guide, and validation commands now agree on v1.0.0. Older step-by-step design files in `docs/design/` are historical build records; use this README plus `docs/ONBOARDING.md`, `CHANGELOG.md`, `docs/MANIFEST.md`, `CLAUDE.md`, and `AGENTS.md` for the current public repo shape.

## Current Public State

- **Good Life governance is first-class.** The engine evaluates viability, continuity, usefulness, development, coherence, friction, and recovery, then routes bounded repair/recover/help policies into the live operator loop.
- **Live problems are verifier-backed.** The dashboard exposes deterministic problem state, remediation steps, escalation/user-intervention receipts, and re-check actions instead of relying on stale narrative status.
- **Resident agency and scheduler loops are guarded.** Pursuits close only on independent receipts, stale high-salience signals are deferred without interrupting chat, and repeated scheduler failures are escalated instead of stampeding the harness.
- **Contracts are first-class.** Apple/client-facing routes ship schemas, fixtures, a manifest, and read-only live validation via `npm run test:contracts:live`.
- **The agent runtime ships a broad, discoverable tool registry.** That includes files, shell, web, nine brain surfaces, COSMO research and run discovery, workers, skills, cron, media, TTS, agency, and governed memory promotion. The inventory is capability-based rather than tied to a brittle fixed count.
- **The dashboard is the main operating surface.** Home, Intelligence, Workers, Query, Brain Map, Settings, Good Life/operator panels, Evobrew, and COSMO are wired from the browser, with the CLI used for setup, lifecycle, and updates.
- **The bundled systems are still one install.** Home23 owns provider configuration; Evobrew and COSMO23 consume the same managed config instead of becoming separate setup islands.
- **COSMO23 completed-run answers are artifact-grounded.** Structured run artifact inventories now surface extracted record counts, route receipts, invalid JSON status, and markdown report headings before graph synthesis.

Four integrated systems, one install:

- **Agent** — always-on AI with a cognitive loop, a discoverable tool registry (full COSMO research toolkit, brain catalog/query/operation/graph access, workers, skills, cron/media/TTS tools, agency, and `promote_to_memory` for governed memory promotion), multi-channel (Telegram, Discord, iMessage, webhooks), and an LLM-powered conversation interface with **situational awareness** — the agent queries its brain and loads domain-specific context before every response
- **COSMO 2.3** — multi-phase research engine with guided runs, brain integration, and a 9-tab UI. Fully agent-drivable: your agent can launch runs, monitor them, query completed brains, and compile findings into its own memory
- **Evobrew** — AI-powered IDE with brain connectivity, multi-provider LLM support, and code editing
- **Dashboard** — OS home screen with real-time thoughts, chat (with mobile-first standalone page), Good Life governance, workers, Query, intelligence synthesis, live-problems monitoring, brain storage visibility, settings (incl. **per-slot cognitive model assignments** for every place the engine calls a model), and full access to COSMO and Evobrew

## Prerequisites

- **Node.js 20+** (LTS recommended)
- **PM2** — process manager (`npm install -g pm2`)
- **Python 3** — for the document feeder's binary-format converter (MarkItDown installed automatically by init)
- **An LLM provider** — at least one of: Ollama Cloud (free), Anthropic, OpenAI, xAI, MiniMax
- **Recommended: an embedding provider** — Ollama local (free), OpenAI API, or Ollama Cloud. Without embeddings, Home23 runs in Memory Lite mode: it stores text memory and uses keyword retrieval until semantic embeddings are configured.

## Install

For the shortest path, follow [docs/ONBOARDING.md](docs/ONBOARDING.md). The core flow is:

```bash
git clone https://github.com/notforyou23/home23.git
cd home23
node cli/home23.js setup
```

`setup` runs install initialization, starts a temporary local setup page, and opens the browser to the guided first-run flow. Keep that terminal open while you finish setup.

The web setup page walks through provider sign-in/API keys, the first personal agent name, owner name, up-front user facts, purpose, project folders/imports to ingest, model choice, and launch. Starter folders can be normal work folders, Claude/Codex project exports, or other local project directories you want the agent to learn from.

Manual operator flow:

```bash
node cli/home23.js init
node cli/home23.js agent create <name>
node cli/home23.js start <name>
```

Init checks prerequisites, installs all dependencies (including MarkItDown for document ingestion), sets up encryption keys and the OAuth database, builds the TypeScript harness, and seeds all configuration. No API keys needed — provider setup happens in the web dashboard.

`agent create` creates the first local runtime under `instances/<name>/`, records its purpose, configures starter feeder watch paths, and regenerates the PM2 ecosystem. Local runtime/config files are intentionally ignored by Git; public defaults live in `config/*.example`.

For the older terminal-guided setup path, run `node cli/home23.js setup --cli`.

Fresh agents also preserve conversation continuity by default: session transcripts are written into `workspace/sessions`, historical JSONL chats are backfilled daily into that same watched folder, chat searches brain memory, and compaction/memory extraction use the agent's configured provider/model defaults.

Before handing a fresh install to someone else, run:

```bash
npm run build
npm test
npm run test:contracts
node cli/home23.js start
npm run test:contracts:live
node cli/home23.js status
```

Those checks verify TypeScript, unit coverage, schema/fixture contracts, read-only live API contracts, and PM2 process wiring.

## Setup — Web Dashboard

`setup` opens **`/home23/setup`** on a temporary local setup server, usually `http://localhost:50523/home23/setup` or the next available port.

Use the setup page to finish first run:
1. **Providers** — sign in with Anthropic or OpenAI Codex OAuth, or enter API keys for OpenAI, Ollama Cloud, MiniMax, xAI, or Anthropic fallback access.
2. **Agent** — name the first personal agent, name the owner, add up-front user facts, set purpose, and add project/import folders.
3. **Model** — choose the provider/model default, including Ollama Cloud, Anthropic, OpenAI Codex, OpenAI, MiniMax, and xAI options.
4. **Launch** — start the agent and then use the live dashboard at **`http://localhost:5002/home23`**.

The web dashboard is the primary interface for everything — provider configuration, agent creation, model selection, feeder settings, and day-to-day use. The CLI handles init, start/stop, and updates.

**What you see:**
- **Dashboard:** `http://localhost:5002/home23` — OS home screen
- **Settings:** `http://localhost:5002/home23/settings` — all configuration
- **Chat:** `http://localhost:5002/home23/chat` — standalone chat page (mobile-first; bookmark on your phone or use Safari → Share → Add to Home Screen to launch as a full-screen PWA)
- **Evobrew IDE:** `http://localhost:3415` — AI code editor with brain access
- **COSMO Research:** `http://localhost:43210` — research engine UI

COSMO Query uses normal direct Query for small completed brains and Progressive Graph Search for large-graph coverage. As of Patch 20, small PGS requests fall back to direct Query and one-partition graphs skip fake cross-partition synthesis; vendored COSMO changes are tracked in `docs/design/COSMO23-VENDORED-PATCHES.md`.

## Commands

```bash
node cli/home23.js status              # Check what's running
node cli/home23.js logs my-agent       # Tail agent logs
node cli/home23.js stop                # Stop all Home23 processes
node cli/home23.js update              # Update to latest release
node cli/home23.js update --check      # Check for updates
```

## Updating

```bash
node cli/home23.js update
```

One command handles everything: pulls the latest tagged release from GitHub, installs new dependencies, rebuilds TypeScript, runs any data migrations, and restarts all processes. Your agent's brain, conversations, and configuration are preserved.

Check for updates without applying: `node cli/home23.js update --check`

The dashboard sidebar and update bar compare the local `package.json` version with Git tags. If it says an update is available, the installed package metadata is behind the newest release tag.

## Channels

Your agent can communicate through multiple channels simultaneously:

| Channel | Setup | Notes |
|---|---|---|
| **Dashboard Chat** | Built-in, always available | SSE streaming with full thinking/tool visibility, model selector, conversation history |
| **Telegram** | Settings → Agents → enable + paste bot token from @BotFather | DMs + group support, adaptive debounce, queue-during-run, streaming partial responses |
| **Discord** | Settings → Agents → enable + paste bot token from Discord Developer Portal | DMs + guild allowlist (one guild ID per line), rate limit handling, Gateway v10 WebSocket |
| **iMessage** | Settings → Agents → enable (macOS only) | Uses `imessage-cli` bridge, DM + group policy |
| **Webhooks** | `config.yaml` per-agent | Generic HTTP webhook adapter for custom integrations |
| **Evobrew** | Built-in via bridge endpoint | Full agent loop with identity/tools/memory |
| **Mobile (iOS)** | Bookmark `http://<host>:5002/home23/chat` → Add to Home Screen | Full-screen PWA, no app install needed |

Channel configuration is per-agent in **Settings → Agents**. Multiple channels can be active simultaneously — the agent maintains separate conversation sessions per channel + chat ID.

## Embedding Provider

Your agent's brain uses vector embeddings for semantic memory and higher-quality file retrieval. Pick one provider and stick with it — switching embedding providers means re-embedding your entire brain.

Embeddings are recommended, not required for first launch. If embeddings are unavailable, Home23 stores memory as text and uses keyword retrieval in Memory Lite mode. When you add an embedding provider later, semantic search can be backfilled.

**Recommended (free):** Install [Ollama](https://ollama.com) locally and pull `nomic-embed-text`:

```bash
ollama pull nomic-embed-text
```

This runs entirely on your machine with no API key needed. `node cli/home23.js init` seeds local `config/home.yaml` from `config/home.yaml.example`, which is pre-configured for local Ollama embeddings.

**Alternatives:**
- **Ollama Cloud** — same model, hosted (requires Ollama Cloud API key)
- **OpenAI** — `text-embedding-3-small` (requires OpenAI API key, 1536 dimensions)

If you only have one paid chat subscription, use this rule:

- **Claude Max OAuth or ChatGPT/Codex OAuth:** use that for chat, and use local Ollama for embeddings.
- **OpenAI API key:** can cover both chat and embeddings.
- **Ollama Cloud API key:** can cover chat and hosted embeddings when configured as the embedding provider.

## LLM Providers

Unlike embeddings, you can switch LLM providers freely. Configure providers from the dashboard at **Settings → Providers** (API keys or OAuth sign-in):

| Provider | What you need | Models |
|---|---|---|
| **Anthropic** | OAuth (recommended, requires Claude Max plan) OR API key | Claude Sonnet, Claude Opus |
| **OpenAI Codex** | OAuth (recommended, requires ChatGPT Plus/Pro) | GPT-5.5, GPT-5.5 Pro, Codex |
| **OpenAI** | API key | GPT-5.4, GPT-5.4-mini |
| **Ollama Cloud** | API key from ollama.com | kimi-k2.6, qwen3.5, deepseek-v4, nemotron-3, gemma4, GLM-5.1, and more |
| **MiniMax** | API key | MiniMax-M3 |
| **xAI** | API key | Grok-4.3, Grok-4.20 variants |
| **Ollama Local** | Ollama running locally | Any pulled model |

Model aliases are defined in `config/home.yaml` — use short names like `sonnet`, `gpt`, `kimi` instead of full model IDs.

**Minimum practical setup:** one chat LLM provider. For durable semantic memory, add one embedding provider. The lowest-friction baseline is any paid/free chat provider plus local Ollama `nomic-embed-text` for embeddings.

The web setup page shows this explicitly: Chat Provider is required, Memory Lite is available without embeddings, Semantic Brain appears when embeddings are configured, and Backfill Needed appears when stored text memory can be vectorized later.

## OAuth Sign-in (Anthropic + ChatGPT)

If you have a **Claude Max** plan or a **ChatGPT Plus/Pro** subscription, you can sign in with OAuth instead of managing API keys. OAuth is the preferred path — it's free (included in your subscription), tokens refresh automatically, and no billing surprises.

Configure from the dashboard: **Settings → Providers → OAuth Sign-in**.

### Anthropic (claude.ai)

Two options:

- **Import from Claude CLI** — if you already have the [Claude CLI](https://docs.anthropic.com/claude/docs/claude-code) signed in on this machine, click Import. Home23 reads your existing credentials from `~/.claude/.credentials.json` and you're done.
- **Start OAuth Flow** — clicks open a new browser tab to claude.ai's OAuth page. Authorize, copy the entire callback URL from your browser, paste it into the Complete OAuth textarea, and click Complete. The token is stored encrypted and refreshes automatically.

### OpenAI Codex (ChatGPT)

Two options:

- **Import from Evobrew** — if you already have a standalone evobrew installation signed in with Codex OAuth at `~/.evobrew/auth-profiles.json`, click Import.
- **Start OAuth Flow** — runs the full PKCE flow via a loopback callback server. Your browser opens automatically to OpenAI's authorize page. After authorizing, the flow completes and the status flips to Connected.

### How it works

Home23 uses the bundled cosmo23 server as an OAuth broker. cosmo23 has a battle-tested PKCE implementation with encrypted token storage (SQLite + Prisma + AES-256-GCM) and automatic refresh. Home23's Settings tab proxies to cosmo23's OAuth endpoints and then mirrors the resulting access token into `config/secrets.yaml` under the appropriate provider slot, where it flows to the agent harness and engine via the standard PM2 env-injection pipeline.

A background poller on the dashboard checks every 30 minutes for token rotation (cosmo23 refreshes transparently) and re-syncs to `secrets.yaml` + restarts the affected processes if the token has changed. Research runs in flight are detected and the restart is skipped to avoid disruption.

### Logout

Click Logout on either OAuth card to revoke. This clears the token from both cosmo23's DB and Home23's `secrets.yaml`, and restarts the engine + harness so they drop the credential.

## Architecture

```
Home23/
  engine/              JS cognitive engine (loops, dreaming, brain growth, memory, ingestion)
    src/core/          Orchestrator, state compression, brain-snapshot, memory-sidecar, brain-backups
    src/live-problems/ Autonomous problem detection, verification, remediation, agent dispatch
    src/pulse/         Pulse remarks (jerry's voice layer)
    src/ingestion/     Document feeder (chokidar, compiler, converter, manifest)
    src/cognition/     Dynamic roles, thought-action parser, action dispatcher + handlers
    src/dashboard/     Dashboard server, settings API, tiles, home page
  src/                 TS agent harness
    agent/tools/       Agent tools (shell, files, web, brain, research_*, workers, skills, agency, cron, media, tts, promote)
    agent/             Context assembly, memory objects, event ledger, trigger index
    channels/          Telegram, Discord, iMessage, webhooks adapters + session router
    routes/            Evobrew bridge, chat turn, device registration, chat history
  dist/                Compiled JS output (gitignored)
  cli/                 CLI installer, update system, and management commands
  config/              Example defaults plus generated local config/secrets
  configs/             Shared engine config templates (base-engine.yaml, action-allowlist.yaml)
  instances/           Per-agent directories (workspace, brain, conversations)
  workspace/skills/    Shared skill definitions (auto-research, x-research, etc.)
  evobrew/             Bundled AI IDE (brain exploration, code editing, multi-provider)
  cosmo23/             Bundled research engine (guided runs, multi-phase, brain integration)
  docs/                Design specs and vision documents
```

All systems are bundled — evobrew and cosmo23 ship with the repo and update together via `home23 update`. Provider configuration is managed centrally by Home23's Settings UI; evobrew and cosmo23 receive API keys via environment variables and show model pickers only.

### Processes (per agent)

Each agent runs 3 PM2 processes, plus 2 shared:

| Process | Purpose | Default Port |
|---|---|---|
| `home23-<name>` | Cognitive engine — thinking, dreaming, brain growth, document ingestion, **live-problems loop** | 5001 (WS + admin HTTP) |
| `home23-<name>-dash` | Dashboard API — brain queries, state, settings, feeder drop zone, model assignments, live-problems API, brain storage API | 5002 (HTTP) |
| `home23-<name>-harness` | Agent runtime — Telegram, Discord, iMessage, discoverable tool registry, LLM loop, situational awareness, `/api/notify` + `/api/diagnose` endpoints | 5004 (bridge) |
| `home23-evobrew` | AI IDE (shared across all agents) | 3415 |
| `home23-cosmo23` | Research engine (shared, on-demand) | 43210 |

Multiple agents get sequential port blocks: first agent 5001-5004, second 5011-5014, etc.

The document feeder runs **inside** the cognitive engine process (no separate PM2 entry). Configure it from the Feeder tab in Settings.

## Brain Persistence

The brain is the agent's enduring cortex. It persists across restarts, grows during every cycle, and is protected by multiple layers of safeguards.

### Storage format

| File | What | Typical size |
|---|---|---|
| `state.json.gz` | Small-shape state: goals, journal, cognitive state, clusters. NO nodes/edges. | ~1-2 MB |
| `memory-nodes.jsonl.gz` | One node per line, gzipped (streaming read/write). Authoritative for the graph. | ~200+ MB |
| `memory-edges.jsonl.gz` | One edge per line, gzipped. Authoritative for edge data. | ~0.5 MB |
| `brain-snapshot.json` | Tiny sidecar: `{cycle, nodeCount, edgeCount, fileSize, memorySource}`. Updated after every successful save. | ~220 bytes |
| `brain-high-water.json` | All-time maximum node count. Updates upward only. | ~50 bytes |
| `backups/backup-<iso>/` | Hourly coherent snapshots of all 4 files above. Last 5 kept. | ~200 MB each |

Memory nodes and edges are stored as **gzipped JSONL** (one record per line, streamed through gzip) rather than inside the monolithic state JSON. This eliminates Node.js V8's ~536 MB string length limit — the brain can grow to any size without hitting parse/serialize barriers.

### Safeguards

- **50%-drop refusal** — saves are blocked if the current in-memory node count dropped >50% from the last known-good count recorded in `brain-snapshot.json`
- **Fail-loud halt** — on load, if the brain-snapshot says the brain had N≥100 nodes but the loader produced 0, the engine refuses to start with a clear error message rather than silently booting as a fresh brain
- **Atomic writes** — all files use `.tmp` + rename to prevent partial-write corruption
- **Rolling backups** — every hour, a coherent snapshot of all 4 brain files is copied to `backups/backup-<iso>/`, keeping the last 5
- **High-water drop detector** — a live-problem monitors the node count against the all-time high-water mark and escalates if it drops >10%
- **GracefulShutdown protection** — PM2 stop triggers a final state save that goes through the same 50%-drop safeguard

### Dashboard visibility

The pulse bar on the dashboard home screen shows a 🧠 badge with the current disk node count + save age. Click to open a Brain Storage panel with:
- Side-by-side disk vs memory counts
- File sizes for all brain files
- High-water mark
- Rolling backup list
- Mismatch warning (red alert if disk and memory diverge)

## Live Problems

The live-problems system replaces the pattern of stale assertions cycling through the pulse ("health log dark since the 13th" repeated 30 times without ever checking if it's still true). Every tracked problem is **deterministically verified** every ~90 seconds, and remediation happens **autonomously** before escalating to the user.

### Three-tier remediation

Every problem has an ordered plan:

1. **Tier 1 — rigid fix** (e.g. `pm2_restart`, `run_shortcut`, `exec_command`). Cheap, deterministic, per-step cooldowns.
2. **Tier 2 — dispatch to agent** (`dispatch_to_agent`). The agent gets a focused diagnostic mission with its full toolbox (shell, files, cron, brain, web). Time-budgeted (2-12h depending on problem severity). The engine tracks dispatch state and re-verifies while the agent works — if the fix lands, the problem closes automatically.
3. **Tier 3 — notify user** (`notify_jtr`). Last resort, after autonomous remediation is exhausted. Sends a Telegram message once with cooldown.

### Verifier types

| Type | What it checks |
|---|---|
| `file_mtime` | File modified within N minutes |
| `file_exists` | File exists (optionally non-empty) |
| `pm2_status` | PM2 process is online |
| `http_ping` | URL returns 2xx within timeout |
| `disk_free` | Mount has ≥N GiB free |
| `graph_not_empty` | Brain graph has ≥N nodes |
| `node_count_stable` | Node count hasn't regressed >N% below all-time high-water |

### Seeded invariants

Every agent gets these tracked out of the box:
- Health log freshness (iOS Shortcut / Pi bridge writing `~/.health_log.jsonl`)
- Disk free ≥10 GiB
- Harness process online
- Dashboard HTTP responding
- Brain graph ≥100 nodes
- Node count stable (no regression >10% from high-water)

### Dashboard UI

The pulse bar shows a 🩺 badge (amber = open problems, red = chronic, green = all clear). Click to open a full panel with:
- Per-problem cards: state, age, verifier type, last result, remediation step/count, escalation status
- Add / edit / delete problems with JSON editors for verifier spec + remediation plan
- Re-verify-now button
- Reference text listing all available verifier and remediator types

### Pulse integration

The pulse LLM brief includes a `--- LIVE PROBLEMS (verified just now — ground truth) ---` block. The system prompt hard-blocks the agent from asserting anything is broken unless it appears in that block. Status changes only (newly opened, chronic, resolved-just-now). Stable-open problems are NOT restated. This eliminates the stale-assertion loop.

## Configuration

| File | Purpose |
|---|---|
| `config/home.yaml` | Provider URLs, model aliases, embedding config, chat defaults |
| `config/secrets.yaml` | API keys and bot tokens (managed by dashboard Settings, gitignored) |
| `instances/<name>/config.yaml` | Per-agent: ports, owner, channels (Telegram/Discord/iMessage/webhooks), chat model, scheduler, `modelAssignments` overrides |
| `configs/base-engine.yaml` | Cognitive loop timing, feeder block, default `modelAssignments` (shared across agents) |
| `configs/action-allowlist.yaml` | Autonomous action governance — enabled actions, rate limits, dry-run flags, integrations |

### Cognitive Model Assignments

Every place the engine calls a model is individually configurable from **Settings → Models → Cognitive Assignments**. 15 slots grouped by purpose:

- **Cognition** — `quantumReasoner.branches` (per-cycle parallel branches — fast + cheap), `quantumReasoner.singleReasoning` (dreams + single-shot fallback — quality)
- **Agents** — `agents.research`, `agents.research-synthesis`, `agents.research-fallback`, `agents.analytical`, `agents.discovery`, `agents.clustering`, `agents.synthesis`, `agents.quality_assurance`, `agents`
- **Coordination** — `coordinator`
- **Goals** — `goalCurator`, `intrinsicGoals`
- **Default** — catch-all for any unmarked call

Each slot has a primary provider + model and an optional fallback chain that kicks in on error or rate-limit. Click the `?` button on a slot for a plain-language description of what it does and guidance on which trade-offs matter for that slot (speed vs quality vs cost). Saves to the agent's instance config and hot-restarts its engine.

### Autonomous Actions

The cognitive engine can execute actions autonomously when a thought produces an `ACT:` tag. Actions are governed by `configs/action-allowlist.yaml`:

| Action | Purpose |
|---|---|
| `run_shortcut` | Invoke an iOS Shortcut via HTTP bridge |
| `refresh_sensor` | Force-poll a sensor source (weather, sauna, pressure) |
| `launch_research` | Start a COSMO 2.3 research run |
| `promote_to_memory` | Create a durable MemoryObject from a cycle insight |
| `prune_stale_cluster` | Flag low-activation cluster nodes as stale |
| `compile_research_section` | Save a COSMO research goal/insight as a focused memory node |
| `update_surface` | Rewrite a domain surface file (TOPOLOGY, PROJECTS, etc.) |
| `write_note` | Write a markdown note to workspace/notes/ |
| `create_goal` / `break_goal` | Self-manage intrinsic goals |
| `ack_notification` | Self-clear a queued notification |

Each action is rate-limited (per-action + global), can be dry-run tested, and has an allowed-targets list. The agent can REQUEST actions not in the allowlist — they're logged to `requested-actions.jsonl` for user review.

## How It Works

The cognitive engine runs continuous think-consolidate-dream cycles. During waking hours, it processes thoughts through analyst, critic, curiosity, proposal, and **curator** roles, pursues goals, and responds to messages. During sleep periods, it dreams — synthesizing connections across its brain, consolidating knowledge, and growing.

Every thought produces a structured action tag at the end: `INVESTIGATE:` (spawns a research task), `NOTIFY:` (queues a user notification visible as a 🔔 badge in the dashboard), `TRIGGER:` (installs a standing memory-reactivation rule), or `NO_ACTION` when the thought is pure reflection.

Cycles are tool-capable — a branch can call `read_surface` / `query_brain` / `get_active_goals` / `get_recent_thoughts` / `get_pending_notifications` mid-thought to ground its reasoning in real data instead of stale memory.

### Pulse Remarks (Jerry's Voice Layer)

The pulse tile on the dashboard home screen shows short remarks from the agent — its real-time take on what's happening in its brain. Every 3-8 minutes, the pulse system:

1. **Gathers** a snapshot across every signal source (thoughts, actions, notifications, goals, surfaces, sensors, brain state, live problems)
2. **Synthesizes** by deduping, filtering by novelty, and flagging notable events
3. **Generates** a 2-4 sentence remark through a voice-tuned LLM call
4. **Logs** to `pulse-remarks.jsonl` with the full brief the LLM saw (click history on the tile to review)

The pulse brief includes a **live-problems block** (ground truth, re-verified every 90s). The system prompt hard-blocks the agent from asserting anything is broken unless it's in that block — no more stale-assertion loops.

### Situational Awareness Engine

The agent doesn't just respond to messages — it **shows up already knowing what it needs to know**. Before every LLM call, a context assembly layer:

1. **Queries the brain** via semantic search (the maintainer's live Jerry brain was ~74,000 nodes on 2026-05-16; installed agents grow over time)
2. **Evaluates trigger conditions** on durable memory objects (keyword, temporal, domain-entry triggers)
3. **Loads domain surfaces** — living workspace documents maintained by the curator cycle:
   - `TOPOLOGY.md` — active ports, services, URLs (fact surface, registry-backed)
   - `PROJECTS.md` — what's in flight, what was decided, what's next
   - `PERSONAL.md` — ongoing personal threads with the owner
   - `DOCTRINE.md` — conventions, boundaries, operating constraints
   - `RECENT.md` — last 24-48 hours digest
4. **Applies salience ranking** within a 6000-char budget — triggered memories outrank similarity results, higher confidence outranks lower
5. **Verifies freshness** — stale fact surfaces get tagged `[UNVERIFIED]`, expired checkpoints get flagged
6. **Enters explicit degraded mode** if the brain is unreachable — the agent knows it's operating without continuity

Memory is governed, not accumulated. The **Memory Object Model** stores knowledge as typed objects with state deltas (before/after/why), trigger conditions, provenance, confidence scores constrained by evidence type, and scope boundaries. Every promotable memory must belong to a **Problem Thread** — evolving questions organized in a goal hierarchy.

An **Event Ledger** proves continuity with an 8-stage chain. If any link breaks, the system knows where continuity failed.

### Document Ingestion

Documents fed through the feeder are LLM-synthesized before brain entry: raw text becomes structured knowledge with extracted concepts, relationships, and insights. A brain knowledge index is maintained automatically as a human-readable map of everything the agent knows. Feeder behavior is fully configurable from the dashboard's Settings → Feeder tab.

## Brain-Tier Tools

Your agent has nine tools for discovering and working with living brains through the durable operation boundary:

| Tool | Purpose |
|---|---|
| `brain_catalog` | Discover requester-authorized brains and exact configured/selectable provider/model pairs before querying; catalog selection is not credential health |
| `brain_operations_list` | Rediscover recent or nonterminal requester-owned operations when an operation ID is not already in context |
| `brain_pgs_partitions` | List bounded canonical partition IDs and estimates before targeted PGS |
| `brain_status` | Node count, cluster count, last cycle, activity over recent windows |
| `brain_search` | Bounded hybrid semantic/keyword retrieval with salience and explicit ANN/scan fallback evidence |
| `brain_query` | Direct Query or Progressive Graph Search through one durable operation contract |
| `brain_query_export` | Export a stored durable Query result to the agent workspace |
| `brain_memory_graph` | Bounded structural sample ranked by activation, weight, access, and recency, with cluster totals |
| `brain_synthesize` | Start or reattach to an own-brain meta-cognition synthesis operation |

Direct `brain_query` accepts `quick`, `full`, `expert`, and `dive` modes with an exact `modelSelection` provider/model pair. Progressive Graph Search is not a separate capability: `brain_pgs` was merged into `brain_query`. PGS calls set `enablePGS: true`, omit direct-only fields such as `mode`, and choose the named cumulative levels `skim`, `sample`, `deep`, and `full` with exact `pgsSweep` and `pgsSynth` provider/model pairs from `brain_catalog`.

PGS supports `fresh`, `continue`, and `targeted` modes. Start with `pgsMode: "fresh"`; expand a durable session with `pgsMode: "continue"` plus `continueFromOperationId`; or obtain canonical partition IDs from `brain_pgs_partitions` before a targeted request. Targeted levels apply across the cumulative target union: use `full` to run every work unit in the named partitions, and include all earlier target IDs when adding new ones so completed units are reused. Agent PGS calls launch detached immediately and return the exact `brop_...` ID. Check with `brain_status` action `status`, fetch with `result` after terminal state, and use `wait` only when intentionally blocking. Chat Stop detaches durable work; only the exact `cancel` action cancels it.

Coverage evidence is scoped. A fractional or targeted run can prove its requested scope complete, but only `fullCoverage: true` supports a graph-wide absence claim. Reused work, requested-scope completion, and whole-graph coverage are separate facts.

## Agent Research Toolkit

Your agent has a bounded research toolkit for driving COSMO 2.3 runs directly from a chat message or autonomous action:

| Tool | Purpose |
|---|---|
| `research_runs_list` | Discover active and completed requester-authorized research runs before status, continuation, or compile work |
| `research_list_brains` | Enumerate available research brains with node/cycle counts |
| `research_query_brain` | Query ONE brain (modes: quick / full / expert / dive) |
| `research_search_all_brains` | Query the top-N most recent brains in parallel |
| `research_launch` | Start a new research run with full parameters |
| `research_continue` | Resume a completed brain with new focus |
| `research_stop` | Gracefully stop the active run |
| `research_watch_run` | Cursor-paginated log tail during a run |
| `research_get_brain_summary` | Aggregated executive/goals/trajectory overview |
| `research_get_brain_graph` | Knowledge graph structure (nodes, edges, clusters) |
| `research_compile_brain` | Compile a bounded pinned brain projection to requester workspace output (auto-ingested) |
| `research_compile_section` | Save one specific goal or insight as a focused memory node |

The workflow policy lives in a skill file (`workspace/COSMO_RESEARCH.md`) loaded into every agent turn. When a research run is active, the agent's system prompt automatically receives a live `[COSMO ACTIVE RUN]` block.

## Document Feeder

The Feeder continuously ingests documents from watched directories into your agent's brain. Configure everything from **Settings → Feeder**:

| Section | What you control |
|---|---|
| **Live Status** | Running state, watcher count, files processed / total, pending queue. Force Flush button. |
| **Paths & Patterns** | Auto-watched paths + custom watch paths. Exclusion patterns (glob). |
| **Frequency & Batching** | Flush interval, batch size, chunking parameters. |
| **Compiler** | Enable/disable LLM-powered document compiler. Choose the model. |
| **Converter** | Enable/disable binary-to-markdown conversion. Vision model for PDFs/images. |
| **Drop Zone** | Drag-and-drop files for immediate ingestion. Max 100MB per file, 20 files per upload. |

## Skills System

Agents can load shared skills from `workspace/skills/`. Each skill has a `manifest.json` defining its name, description, and entry point, plus a `SKILL.md` with the full skill prompt loaded into the agent's system context. Skills are registered in `workspace/skills/REGISTRY.md`.

Built-in skills include:
- **Auto-research** — autonomous research with structured report generation
- **X-research** — extended research with data caching and multi-source synthesis

## License

MIT. See [LICENSE](LICENSE).
