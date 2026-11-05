---
name: Session handoff — 2026-04-09
description: Steps 12-13 built, 40+ commits, engine root-cause fixes, fresh onboarding tested, brain is thinking autonomously. Next session: plan public release as monorepo.
type: project
---

## Session 2026-04-09 — Handoff

### What was built:

**Step 12: Onboarding & Settings UI** — Welcome screen, 4-tab settings (Providers, Agents, Models, System), agent creation wizard, primary agent concept, channel management with Telegram toggle, restart button after save.

**Step 13: Dashboard Chat Tile** — Native chat on home screen via SSE bridge, full thinking/tool visibility, agent + model selectors, conversation history panel (all channels), expand overlay + standalone /home23/chat, stop button, /new /stop /help slash commands, Enter to send.

### Engine root-cause fixes (all permanent):
1. state-compression.js — empty state on fresh brain (was throwing)
2. index.js — mission plan 30s timeout (was hanging indefinitely)
3. orchestrator.js — save state every cycle (was every 5)
4. server.js — adaptive z-score for brain search (was 3.0, too strict for small brains)
5. server.js — HOME23_ROOT env var for standalone dashboard
6. server.js — broken StateCompression import (missing destructuring)
7. document-feeder.js — background scan for start() + addWatchPath() (was blocking init for hours with 1800+ files)

### Multi-channel fixes:
- spawn_agent works without Telegram (onEvent + conversationHistory + Telegram if available)
- Cron delivery defaults to 'auto' channel, not 'telegram'
- Images stream as media events, displayed in dashboard chat
- Sub-agent results stream via subagent_result events

### Cleanup:
- Removed Alpaca trading tools (6 tools)
- web_search description updated for searxng
- Browser config: enabled by default, port 9222
- Stale cosmo/test-agent instances removed
- Fresh onboarding tested end-to-end

### Current state:
- Agent "jerry" — primary, COZ identity, Telegram connected
- Engine: cycling (cycle 12+), brain 4740+ nodes, growing autonomously
- Brain producing real insights (infrastructure vulnerabilities, cross-domain synthesis)
- All 4 PM2 processes stable
- Dashboard at http://localhost:5002/home23
- 56 other PM2 processes restored (websites, agents, services)

### Next session: Public release planning
- Package as monorepo (evobrew + cosmo23 as first-class dirs)
- Standalone repos stay for independent dev, sync via update commands
- Public repo = clean copy, personal data stripped
- Need to plan: what goes/stays, evobrew/cosmo23 cleanup, licensing, README, install flow
- DO NOT modify the running Home23 instance during this — build the public version separately

### Critical rules:
- NEVER use pm2 stop/delete all (56+ processes across many projects)
- Engine modifications OK for root-cause fixes (not wholesale rewrites)
- Save state every cycle (dashboard must always be in sync)
- Document feeder scans must be non-blocking (background)
