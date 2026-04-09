---
name: Session 2026-04-09 — Full context for next session
description: Complete session narrative covering Steps 12-13 build, all bugs found/fixed, design decisions, and the public release discussion. Essential context for the next session.
type: project
---

## Session 2026-04-09 — Complete Context

### What happened in order:

**1. Started with onboarding/settings UI (Step 12)**
- Brainstormed design: settings as a full tab (not modal), nested sub-tabs (Providers, Agents, Models, System), agent creation wizard (3 steps), welcome screen for first-run
- jtr preferences: full tab not modal for settings, step wizard for agent creation, explicit save buttons (not auto-save)
- Built via subagent-driven development: 12 tasks, 8 commits
- First bug: CSS/JS paths were relative, broke on `/home23/settings` route (needed leading slashes for absolute paths)

**2. Settings UX overhaul**
- jtr feedback: "should reflect current state, actual info, much more clear and user friendly across all tabs"
- Fixed: green/red status dots on providers, model counts, masked keys shown clearly, agent cards with model/provider/owner/ports at a glance, system tab with human-readable hints (e.g., "30 min of silence starts a new session"), Primary/Fallback labels on embeddings

**3. Agent status bug**
- `getAgentStatus()` used `startsWith('home23-cosmo')` which matched `home23-cosmo23` (shared COSMO process). Fixed to exact name matching against 4 expected process names.

**4. Primary agent concept**
- jtr: "the first model is the main model and the default. all other agents can do things but not the main agent. can't just delete a primary agent"
- Added `primaryAgent` field to home.yaml, set on first agent create, blocks deletion, blue PRIMARY badge, sorted first in list

**5. Telegram made optional**
- jtr: "we don't need those to start, can't we just connect direct to the agent"
- Removed botToken requirement from wizard, Step 2 became "Channels (optional)", agent works via dashboard direct chat out of the box

**6. Dashboard Chat Tile (Step 13)**
- Brainstormed: chat as a tile in the home screen (not a separate tab), replaces System tile position. Expandable to overlay and standalone `/home23/chat` page.
- jtr preferences: full visibility always (thinking + tool calls), server-persisted conversations, agent + model selector
- Built via subagent-driven: 7 tasks, 6 commits
- System tile relocated to horizontal stats bar below the grid

**7. Chat fixes (multiple rounds)**
- Tile overflow: added max-height so page doesn't expand
- Model dropdown: added next to agent selector, changes persist to agent config via settings API
- Markdown rendering: basic parser for code blocks, bold, italic, lists
- Enter to send, Shift+Enter for newline
- Conversation retention: standalone page gets agent via URL param, loads from localStorage cache

**8. Event streaming from agent loop**
- Bridge was only sending `text` + `done` events (waited for completion, then chunked)
- Added `AgentEvent` type + `AgentEventCallback` to agent types
- `agent.run()` now accepts optional `onEvent` callback
- All 3 provider paths (Claude, Ollama/OpenAI, Codex) fire: tool_start, tool_result, response_chunk, media, subagent_result
- Bridge streams events live via SSE instead of waiting

**9. spawn_agent fixed (no Telegram requirement)**
- Was hardcoded to deliver results via Telegram API
- Added 3 delivery channels: onEvent (dashboard real-time), conversationHistory (persisted), Telegram (if available)
- Added `onEvent` and `conversationHistory` to ToolContext

**10. Cron multi-channel delivery**
- Default channel changed from 'telegram' to 'auto'
- DeliveryManager picks first available adapter for 'auto'
- Session boundary trigger derives from chatId prefix, not hardcoded 'telegram'

**11. Image display in chat**
- New 'media' event type fired from all provider paths when tools return media
- Dashboard chat renders `<img>` via `/home23/api/media?path=...` endpoint
- Path validation: only serves from workspace/temp directories

**12. Cleanup**
- Removed Alpaca trading tools (6 tools, alpaca.ts deleted)
- web_search description updated for searxng primary
- Browser config: enabled by default, port 9222 (was 18793)
- MEMORY.md cleaned of stale debug notes from previous test-agent run

**13. Channels section in settings**
- jtr tried to add Telegram via settings but token landed in wrong field (telegramId instead of secrets)
- Built proper Channels section: Telegram toggle + bot token field, Discord (coming soon, disabled)
- API handles channel config + bot token → secrets.yaml
- Restart button after save so channel changes take effect

**14. Conversation history**
- jtr: "need a way to track and open prior conversations"
- Added: + (new), ☰ (history), ↗ (expand) buttons in chat header
- Each conversation gets unique chatId (dashboard-agent-timestamp)
- History panel lists all conversations from all channels
- BIG BUG: harness writes to `conversations/<namespace>__<chatId>.jsonl` but API was looking in `conversations/sessions/`. Found 103-message dashboard session that was invisible. Fixed to scan both directories.
- Source detection: dashboard, evobrew, telegram, cron

**15. Stop button**
- Send button becomes red ■ during streaming
- Clicking: aborts fetch stream + calls POST /api/stop on bridge
- Bridge endpoint calls agent.stop(chatId) to abort the run
- /stop slash command in dashboard chat

**16. PM2 disaster**
- During fresh onboarding test, I ran `pm2 stop all && pm2 delete all` which wiped ALL 56 PM2 processes (websites, agents, services — not just Home23)
- Restored from ~/.pm2/dump.pm2.bak via `pm2 resurrect`
- Nothing permanently lost (processes are just pointers to scripts)
- HARD RULE SAVED: NEVER use pm2 stop/delete all. Always scope to specific names.

**17. Fresh onboarding test**
- Saved identity files + conversations to saved/
- Moved jtr/ docs (13K files, 165MB) to saved/jtr-docs for staged ingestion
- Clean instances/ directory
- Tested full flow: welcome screen → settings → create agent → start
- Agent "jerry" created as primary, gemma4:31b model
- Restored COZ identity files into jerry workspace
- Staged doc loading: Priority 1 (420 files), Priority 2 (1405 files)

**18. Engine root-cause fixes (5 permanent fixes)**

1. **state-compression.js** — `loadCompressed()` threw non-ENOENT error when no state file existed. Now returns empty initial state. Every fresh install works.

2. **index.js** — `coordinator.initiateMission()` hangs indefinitely on fresh brains (no state = LLM call to generate mission plan). Wrapped in 30s timeout with graceful fallback.

3. **orchestrator.js** — state saved every 5 cycles. Dashboard and brain_search showed stale data. Changed to save every cycle.

4. **server.js brain search** — z-score noise filter was 3.0 (requires result to be 3 std devs above mean). With small brains (<50 nodes), nothing passes. Made adaptive: <50 nodes: z>=1.0, <500: z>=2.0, 500+: z>=3.0. Plus absolute similarity floor (0.45).

5. **document-feeder.js** — `start()` and `addWatchPath()` awaited `_scanDirectory()` synchronously. With 1800+ workspace files, each requiring LLM compilation, this blocked `orchestrator.initialize()` for HOURS. The engine appeared stuck at cycle 8 for 11+ hours. Fixed: both now fire-and-forget the scan in the background. Cognitive loop starts immediately.

**19. Brain is thinking autonomously**
- By cycle 12, the brain (4740+ nodes) was producing real insights:
  - Identified state.json.gz as single point of failure with no backups
  - Connected COSMO incident to broader pattern about policy auditing
  - Synthesized HAL trading rule context (autonomous action boundary)
  - Pulled newsletter financial model together from scattered docs
  - Connected Jerry Garcia research pipeline to newsletter use case
  - Identified voice DNA anti-patterns as authenticity guardrails

**20. Public release discussion**
- jtr: "this thing is an ai nerds dream"
- OpenClaw comparison: went from 0 to 100K GitHub stars. But OpenClaw is just "AI + tools via messaging" — Home23 has the living brain, cognitive loops, research engine, IDE, dashboard
- Positioning: OpenClaw = "AI that does things for you", Home23 = "AI that thinks for you"
- Decision: monorepo (evobrew + cosmo23 as first-class dirs, not submodules)
- jtr wants standalone evobrew/cosmo23 repos to stay for independent dev, sync via update commands
- Public repo = clean copy built from working system, personal data stripped
- CRITICAL: do not modify the running Home23 instance — build public version separately
- Next session: full brainstorm on what goes/stays, cleanup needed, licensing, README, install flow

### Key design decisions made this session:
- Settings is a full tab, not modal
- Primary agent = first created, can't delete, gets system defaults
- Telegram/Discord optional — dashboard chat is the native interface
- Chat tile on home screen (not separate tab), expandable to overlay + standalone
- Full thinking/tool visibility always (no collapsing)
- Model changes persist globally to agent config
- Conversation history across all channels in one panel
- State saves every cycle (real-time dashboard sync)
- Document feeder scans must be non-blocking

### jtr communication style notes:
- Wants real-time feedback, not polished summaries
- Gets frustrated when things don't reflect actual state ("should show current state")
- Prefers fixing at root cause, not workarounds ("the rule is not hard and fast" re: engine modifications)
- Respects the system architecture but expects it to work for users, not just developers
- Thinks in terms of product, not features ("this thing is an ai nerds dream")
- Direct about bugs and expectations ("what the actual fuck" when PM2 was wiped)
- Wants to capture momentum but also plan properly ("before we prep anything we'll need to plan")

### Files changed this session (40+ commits):
- engine/src/core/state-compression.js (fresh brain fix)
- engine/src/core/orchestrator.js (save every cycle)
- engine/src/index.js (mission plan timeout)
- engine/src/ingestion/document-feeder.js (background scan)
- engine/src/dashboard/server.js (HOME23_ROOT, search threshold, media endpoint, conversations API, channels API)
- engine/src/dashboard/home23-settings-api.js (full settings REST API, primary agent, channels)
- engine/src/dashboard/home23-settings.html (settings page)
- engine/src/dashboard/home23-settings.css (settings styles)
- engine/src/dashboard/home23-settings.js (settings client — providers, agents, wizard, models, system, channels)
- engine/src/dashboard/home23-welcome.html (first-run welcome)
- engine/src/dashboard/home23-chat.html (standalone chat)
- engine/src/dashboard/home23-chat.css (chat styles)
- engine/src/dashboard/home23-chat.js (chat client — SSE, history, conversations, slash commands, stop)
- engine/src/dashboard/home23-dashboard.html (chat tile, system stats bar, overlay)
- engine/src/dashboard/home23-dashboard.js (chat init, settings tab)
- engine/src/dashboard/home23-dashboard.css (settings tab, system stats bar)
- src/agent/types.ts (AgentEvent, AgentEventCallback, ToolContext additions)
- src/agent/loop.ts (onEvent firing, conversationHistory on context)
- src/agent/tools/subagent.ts (multi-channel delivery)
- src/agent/tools/cron.ts (auto channel default)
- src/agent/tools/index.ts (removed alpaca)
- src/agent/tools/web.ts (searxng description)
- src/agent/tools/alpaca.ts (DELETED)
- src/routes/evobrew-bridge.ts (live event streaming, chatId from body, stop endpoint)
- src/home.ts (createStopHandler import + registration)
- src/scheduler/delivery.ts (auto channel support)
- cli/lib/agent-create.js (browser config fix)
- config/home.yaml (primaryAgent)
- instances/jerry/config.yaml (channels, browser)
- instances/jerry/workspace/MEMORY.md (fresh state)
- CLAUDE.md (Steps 12-13 complete)
- docs/design/STEP12-ONBOARDING-SETTINGS-DESIGN.md
- docs/design/STEP13-DASHBOARD-CHAT-DESIGN.md
- docs/superpowers/plans/2026-04-08-onboarding-settings.md
- docs/superpowers/plans/2026-04-08-dashboard-chat.md
