---
name: Session handoff — 2026-04-08/09
description: Massive build session. Steps 12-13 built, 38+ commits, onboarding UI, dashboard chat, engine root-cause fixes, fresh install tested. Next: polish, more channels, advanced chat features.
type: project
---

## Session 2026-04-08/09 — Handoff

### What was built (this session):

**Step 12: Onboarding & Settings UI** (12 tasks)
- Welcome screen at `/home23` for first-run (no agents)
- Settings page at `/home23/settings` with 4 sub-tabs: Providers, Agents, Models, System
- Agent creation wizard (3 steps: Identity, Channels, Model)
- Primary agent concept (first agent, can't be deleted, blue badge)
- Telegram/Discord optional — channels section in agent detail
- Restart button after saving agent config
- Provider cards with green/red status, model counts, Test Connection
- Full REST API: 15 endpoints under `/home23/api/settings/*`

**Step 13: Dashboard Chat Tile** (7 tasks + many fixes)
- Chat tile on Home tab (replaced System tile, which moved to stats bar)
- SSE streaming via existing bridge endpoint, full agent loop
- Live thinking blocks, tool cards, response streaming with markdown
- Agent selector + model selector (model changes persist to config)
- Expand to overlay, standalone page at `/home23/chat`
- Conversation history panel (☰ button) — lists all conversations (Telegram + dashboard)
- New conversation (+) with unique chatIds per conversation
- Stop button (■) during streaming — aborts fetch + agent run
- `/new`, `/stop`, `/help` slash commands
- Enter to send, Shift+Enter for newline

**Engine Root-Cause Fixes (permanent, all fresh installs benefit):**
- state-compression.js: `loadCompressed` returns empty state when no file exists (was throwing non-ENOENT error)
- index.js: mission plan generation wrapped in 30s timeout (was hanging indefinitely on fresh brains)
- orchestrator.js: saves state every cycle, not every 5 (dashboard always in sync)
- server.js: adaptive z-score threshold for brain search (<50 nodes: z>=1.0, <500: z>=2.0, 500+: z>=3.0)
- server.js: `HOME23_ROOT` env var for direct path resolution (standalone dashboard works)
- server.js: fixed broken `StateCompression` import (missing destructuring)

**Multi-Channel Fixes:**
- spawn_agent: works without Telegram, delivers via onEvent + conversation history + Telegram (if available)
- cron delivery: default channel 'auto' instead of 'telegram', picks first available adapter
- Session boundary trigger: derives from chatId prefix, not hardcoded 'telegram'
- Agent events: tool_start, tool_result, response_chunk, media, subagent_result streamed live from all 3 provider paths
- Image display: media events + `/home23/api/media` endpoint for serving generated images in chat

**Cleanup:**
- Removed Alpaca trading tools (6 tools deleted)
- Cleaned MEMORY.md of stale debug notes
- web_search description updated for searxng
- Browser config: enabled by default, correct CDP port 9222
- Removed stale `cosmo` and `test-agent` instances
- Fresh onboarding tested end-to-end

### Current running state:
- Agent "jerry" — primary, gemma4:31b, Telegram connected
- 4 PM2 processes: engine, dash, feeder, harness
- Brain: 4600+ nodes, growing every cycle
- Feeder: 1800+ docs ingested, processing Priority 2 batch
- Chrome headless on port 9222
- searxng on port 8888
- Dashboard at `http://localhost:5002/home23`

### What's preserved in saved/:
- `saved/identity/` — COZ's 9 identity files
- `saved/conversations/` — old chat history (also copied to jerry's sessions)
- `saved/jtr-docs/` — remaining docs for slow ingestion:
  - `COSMObrains/` — 722 files (125MB) — feed selectively
  - Priorities 1+2 already loaded into jerry's workspace

### Known issues:
- Vibe tile placeholder (no image generation wired to it)
- Dashboard chat overlay send should mirror tile conversation
- Chrome headless needs manual start (not PM2-managed)
- COSMO 2.3 not started (shared process, start separately if needed)
- Evobrew not started (shared process, start separately if needed)
