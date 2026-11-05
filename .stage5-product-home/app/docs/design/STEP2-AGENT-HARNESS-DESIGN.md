# Step 2 Design: One Agent Harness Working

> Approved 2026-04-07. Approach A: copy-and-parameterize.

**Goal:** Extract the full TS harness layer from cosmo-home_2.3, wire it to the running engine from Step 1, and get one agent responding to Telegram messages with tool use via Ollama Cloud (kimi2.5).

**Approach:** Copy the entire `src/` directory from cosmo-home_2.3. Parameterize ~10 hardcoded values. Wire config to Home23's existing YAML structure. Add dashboard server to the process architecture. Add WebSocket event listener for real-time engine events (improvement over cosmo-home_2.3's HTTP-only integration).

---

## What Gets Copied

The full `src/` directory from `/path/to/cosmo-home_2.3/src/` into `Home23/src/`.

| Directory | What | Approx Lines |
|---|---|---|
| `src/agent/` | AgentLoop, ContextManager, History, Compaction, Memory, tools | ~3,800 |
| `src/channels/` | Telegram, Discord, iMessage, Webhooks, Router | ~2,000 |
| `src/scheduler/` | Cron, Delivery | ~600 |
| `src/commands/` | Slash command handler | ~600 |
| `src/agents/` | System prompt, provider overlays, voice | ~800 |
| `src/sibling/` | Inter-instance protocol, bridge chat | ~400 |
| `src/observability/` | TTS, monitoring | ~200 |
| `src/browser/` | CDP browser control | ~200 |
| `src/config.ts` | YAML config loader | 86 |
| `src/home.ts` | Entry point | 696 |

Everything comes in. Discord, iMessage, Webhooks, and Sibling sit inert — only activated if their config section exists. No code is removed, just not wired.

Also copied: `tsconfig.json` from cosmo-home_2.3. TS dependencies added to root `package.json`.

---

## What Gets Parameterized

| Hardcoded value | Location | Replacement |
|---|---|---|
| `owner-name (Telegram ID: xxxxxxxxx)` | context.ts, system-prompt.ts | Agent config: `agent.owner.name`, `agent.owner.telegramId` |
| `cosmo23-<name>`, `cosmo23-<name>-dash` | system-prompt.ts | `home23-${agentName}` from config |
| `Platform: macOS (Mac mini)` | system-prompt.ts | Runtime detection: `os.platform()` + `os.hostname()` |
| `Timezone: America/New_York` | system-prompt.ts, cron.ts | Agent config: `agent.timezone`, default to system TZ |
| `COSMO_INSTANCE ?? 'coz'` | home.ts | Agent name from config.yaml |
| Model alias map (100+ lines) | home.ts | Config: `models.aliases` in home.yaml |
| `http://localhost:${ENGINE_PORT}` | brain tools, home.ts | Built from agent config.yaml ports |
| `/opt/homebrew/bin` PATH append | shell.ts | Detect OS, append platform-appropriate paths |
| Max 3 sub-agents | home.ts | Config: `agent.maxSubAgents`, default 3 |
| Session gap 30 min | loop.ts | Config: `chat.sessionGapMs`, default 1800000 |

Pattern: hardcoded value becomes config value, old value becomes default fallback. No behavioral changes.

---

## Config Structure

Home23 already has `config/home.yaml`, `config/secrets.yaml`, and `instances/test-agent/config.yaml` from Step 1. The harness plugs into this existing structure.

### Config loader

Rewrite `src/config.ts` to do a three-layer merge against Home23's file layout:

1. Load `config/home.yaml` (home-level defaults, providers, models)
2. Merge `instances/{agent}/config.yaml` (agent-specific overrides)
3. Overlay `config/secrets.yaml` (API keys, bot tokens)

Same deep-merge pattern as cosmo-home_2.3, different file paths.

### config/home.yaml additions

```yaml
# Added to existing file (providers + embeddings already present)

chat:
  defaultProvider: ollama-cloud
  defaultModel: kimi2.5
  maxTokens: 4096
  temperature: 0.7
  historyBudget: 400000
  sessionGapMs: 1800000

models:
  aliases:
    gpt-5.4: { provider: openai, model: gpt-5.4 }
    gpt-5.4-mini: { provider: openai, model: gpt-5.4-mini }
    claude-sonnet: { provider: anthropic, model: claude-sonnet-4-6 }
    claude-opus: { provider: anthropic, model: claude-opus-4-6 }
    kimi2.5: { provider: ollama-cloud, model: kimi2.5 }
    grok-4: { provider: xai, model: grok-4-0709 }
    # Full alias map externalized from home.ts
```

### instances/test-agent/config.yaml additions

```yaml
# Added to existing file (agent.name, ports, engine assignments already present)

agent:
  owner:
    name: "owner"
    telegramId: "123456789"
  timezone: "America/New_York"
  maxSubAgents: 3

channels:
  telegram:
    streaming: partial
    dmPolicy: open
    ackReaction: true
```

### config/secrets.yaml additions

```yaml
# Added to existing file (provider API keys already present)

channels:
  telegram:
    botToken: "<bot-token-here>"
```

---

## Process Architecture

Step 2 adds two processes to Step 1's two:

| Process | What | Port | Started by |
|---|---|---|---|
| Engine (index.js) | Cognitive loops, brain growth | 5001 (WS) | start-agent.sh |
| Dashboard (dashboard/server.js) | HTTP API for brain queries | 5002 | start-agent.sh |
| Feeder (server.js) | File watcher, embedder, ingester | — | start-agent.sh |
| **Harness (home.ts → home.js)** | **TS agent: Telegram, tools, LLM loop** | — | **start-agent.sh** |

### Start order

1. **Engine** first (brain must be running)
2. **Dashboard** second (needs engine's orchestrator registered globally)
3. **Feeder** third (watches workspace)
4. **Harness** last (needs engine WS + dashboard HTTP available)

### Health check flow

```
Engine starts → wait for WS /health on port 5001 →
Dashboard starts → poll GET /api/state on port 5002 until 200 →
Feeder starts →
Harness starts → connects engine WS + verifies Telegram polling
```

### Dashboard startup

The dashboard server (`engine/src/dashboard/server.js`) supports standalone execution via `require.main === module`. Start it with the same env vars as the engine (`COSMO_RUNTIME_DIR`, `DASHBOARD_PORT`). It reads the brain directory from `COSMO_RUNTIME_DIR` to serve state, thoughts, goals, and memory.

### stop-agent.sh

Extended to stop all four processes in reverse order (harness → feeder → dashboard → engine).

---

## Engine Integration

### HTTP API (via dashboard server on port 5002)

Brain tools use these endpoints — same as cosmo-home_2.3:

| Endpoint | Method | Used by | Purpose |
|---|---|---|---|
| `/api/state` | GET | brain_status tool | System health, cycle count, cognitive state |
| `/api/memory` | GET | brain_search tool | Memory network nodes + edges |
| `/api/query` | POST | brain_query tool | Deep semantic query with evidence |
| `/api/thoughts` | GET | (future) | Recent thoughts |
| `/api/goals` | GET | (future) | Active research goals |
| `/api/operations/pause` | POST | (future) | Pause cognitive loop |
| `/api/operations/resume` | POST | (future) | Resume cognitive loop |

### WebSocket events (new — improvement over cosmo-home_2.3)

The harness connects to engine WS on port 5001 at startup and subscribes to events:

```javascript
ws.send(JSON.stringify({
  type: 'subscribe',
  events: [
    'thought_generated',
    'dream_started',
    'dream_phase',
    'cognitive_state_changed',
    'goal_created',
    'goal_completed',
    'agent_completed',
    'sleep_triggered',
    'wake_triggered'
  ]
}));
```

For Step 2, the harness logs these events. In later steps, the agent can react to them (e.g., share a dream insight unprompted on Telegram, notify when a research goal completes).

---

## Harness Entry Point (home.ts)

The entry point does the same wiring as cosmo-home_2.3's home.ts, adapted for Home23:

### Startup sequence

1. Load config (home.yaml ← agent config.yaml ← secrets.yaml)
2. Resolve agent paths (workspace, brain, conversations, logs from `instances/{agent}/`)
3. Create ContextManager (loads identity files from workspace)
4. Create ConversationHistory (writes JSONL to conversations dir)
5. Create ToolRegistry (all tools, brain tools pointed at dashboard port)
6. Create AgentLoop (default: Ollama Cloud / kimi2.5)
7. Create MemoryManager + CompactionManager
8. Connect to engine WebSocket (subscribe to events, log them)
9. Create channel adapters — only those with config (Telegram for Step 2)
10. Create SessionRouter, wire active adapters
11. Create CronScheduler (if cron config exists)
12. Start adapters (Telegram long-polling)
13. Print startup banner, listen for SIGINT/SIGTERM

### What changes from cosmo-home_2.3

- Config loading uses Home23 YAML files
- Paths use `instances/{agent}/` structure
- Model alias map loaded from config
- Channel adapters created conditionally (only if configured)
- WebSocket event listener added (new)
- Sibling protocol skipped unless configured
- User identity from config, not hardcoded

### What stays the same

The wiring logic. ContextManager → AgentLoop → Router → Adapter. Same objects, same interfaces, same message flow.

---

## Verification Checklist

Step 2 is done when:

1. **TS builds clean** — `npx tsc` produces no errors
2. **All four processes start** — engine, dashboard, feeder, harness
3. **Dashboard API responds** — `curl http://localhost:5002/api/state` returns JSON
4. **WebSocket connected** — harness log shows engine WS connection + event subscription
5. **Telegram polling works** — harness log shows Telegram polling started
6. **Send a message, get a response** — send "hello" on Telegram, get a reply from kimi2.5
7. **Tool use works** — ask "what files are in your workspace?" → agent uses tool → returns list
8. **Brain query works** — ask "what have you been thinking about?" → agent queries engine → returns thoughts
9. **Conversation persists** — JSONL file appears in `instances/test-agent/conversations/`
10. **Identity loads** — agent responses reflect SOUL.md and MISSION.md
11. **Stop cleanly** — `bash scripts/stop-agent.sh test-agent` kills all four processes

### Not required for Step 2

- Discord/iMessage/Webhook channels (not configured)
- Sibling protocol (no second instance)
- Sub-agent spawning (inert until needed)
- Cron scheduling (verify later)
- Image generation / TTS (separate API key setup)

---

## What's Next

Step 3: Unified provider system — consolidate the engine's model routing and the harness's provider config into one system. Both consumers (engine cognitive loops + harness chat) draw from the same provider catalog.
