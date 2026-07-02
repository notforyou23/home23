# Active Projects

## Home23 Dashboard (SHIPPED 2026-04-14)
Live data dashboard at port 8090 (Tailscale). Sections: Docs, Live Data (Sauna, Pressure, Health, Weather). Location: `instances/jerry/projects/Dashboard/`. Stack: Node.js + Express, vanilla JS, ES modules, pm2-managed (name: `home23-dashboard`). Data sources: `~/.sauna_usage_log.jsonl`, `~/.pressure_log.jsonl`, `~/.health_log.jsonl`, `engine/data/sensor-cache.json`, Pi API. Key routes: `/`, `/docs/:file`, `/data/:stream`, `/api/:stream`. Update: edit `server.js`, then `pm2 restart home23-dashboard`. New sections need sidebar + route handler additions.

## Situational Awareness Engine (Step 20, SHIPPED)
All 6 phases live. Brain-driven pre-turn context assembly: 10 brain cues + 5 domain surfaces loaded before every LLM call. Components: Assembly layer, MemoryObject (state_deltas), ProblemThreads, event ledger, trigger index, curator cycle, promote_to_memory tool. Verified: agent answers "what port is published docs on?" immediately without tool calls.

## Telegram Message Handling (Step 19, SHIPPED 2026-04-12)
Adaptive debounce (1.5s-6s), queue-during-run.

## Scheduler / Cron System (ACTIVE)
Recurring/one-shot tasks. Engine: `src/scheduler/cron.ts`, 6 tools in `src/agent/tools/cron.ts`, delivery in `src/scheduler/delivery.ts`. Jobs file: `instances/jerry/conversations/cron-jobs.json` (~15 jobs). Key jobs: ticker-home23-pre-market (5:30am ET), mid-session (11:30am), evening-research (8pm), brain-housekeeping (hourly), pi-pressure-bridge (5min), pi-health-bridge (15min), x-timeline-morning/evening. `field-report-cycle` is disabled as of 2026-06-17 after jtr called out the From The Inside loop as repetitive literary theatre; do not re-enable until the applied-curriculum contract, learning ledger, and consequence-gated dispatcher are verified. Tools: `cron_schedule`, `cron_list`, `cron_delete`, `cron_enable`, `cron_disable`, `cron_update`. Delivery to Telegram `8317115546` or Discord `1480393008791818474` (must be numeric chat ID, never `dashboard-jerry-*`). Bug fixes 2026-04-16: timezone-aware matching, delivery failure surfacing, input validation, enable/disable/update tools, corrupt job cleanup.

## Home23 iOS App (SHIPPED 2026-04-15)
Native iOS app: chat with agents, sauna controls, pulse/vibe/dreams/sensors/goals on Home tab, push notifications. Location: `/Users/jtr/xCode_Builds/Home23/`. Backend: Turn protocol (POST /api/chat/turn + SSE stream), APNs pusher, device registry, per-turn model override, TTS via MiniMax Speech 2.8.

## Brain Insights (curator-promoted)
- Brain: 21,048+ nodes, 44,649+ edges, 1,468+ cognitive cycles — rich knowledge




### Failure mode confidence level
Old failure mode is now materially harder but still requires monitoring
_Changed: Failure mode was not addressed → Failure mode addressed with monitoring in place (Confidence in fix is high but not absolute)_
_Added: 2026-06-17_