# Home23 — Agent Instructions

## What This Is

Home23 is a running AI operating system. The repo at `/Users/jtr/_JTR23_/release/home23/` is both the public GitHub repo AND jtr's live running system. Agent "jerry" runs from here via PM2.

**GitHub:** https://github.com/notforyou23/home23

## Before You Do Anything

1. Read the handoff docs in this repo:
   - `docs/handoff/session_2026-04-09b_handoff.md` — LATEST: what was built, current state, priority work
   - `docs/handoff/session_2026-04-09_full_context.md` — complete build narrative (all bugs, fixes, design decisions)
   - `docs/handoff/session_2026-04-09_handoff.md` — Steps 12-13 context
   - `docs/handoff/session_2026-04-08_handoff.md` — Steps 8-11 context

2. Also read memory files (if available) at `/Users/jtr/.claude/projects/-Users-jtr--JTR23--release-home23/memory/`:
   - `next_session_instructions.md` — startup checklist
   - `user_jtr.md` — who you're working with

2. Verify the system is running:
```bash
pm2 jlist | python3 -c "import sys,json; [print(f\"{p['name']:30s} {p['pm2_env']['status']}\") for p in json.load(sys.stdin) if 'home23' in p['name']]"
curl -s http://localhost:5002/api/state | python3 -c "import sys,json; d=json.load(sys.stdin); m=d.get('memory',{}); print(f'cycle={d.get(\"cycleCount\",0)} nodes={len(m.get(\"nodes\",[]))}')"
```

## Priority Work

### 1. Engine Sleep/Wake Fix (CRITICAL)

The cognitive engine gets stuck sleeping for 25+ minutes, showing stale thoughts on the dashboard. Three partial fixes were applied but none fully solve it.

**Root cause:** The sleep branch in `engine/src/core/orchestrator.js` (around line 943) returns before reaching thought generation code (around line 1028). During sleep, the engine processes feeder nodes and dreams but never writes a journal thought — so the dashboard goes stale.

**What was tried:**
- Reduced minimum sleep cycles from 12 to 3 (line 116)
- Lowered wake energy threshold from 0.8 to 0.6 (line 968)
- Added force-thought-on-stale check (line 1028-1039) — but this code is unreachable during sleep

**What needs to happen:** Either:
- Generate a thought during sleep cycles (modify the sleep branch to produce at least one thought per cycle), OR
- Restructure the cycle so thought generation happens BEFORE agent work drains energy to zero

The engine already thinks during sleep (dreams, consolidation) — it just doesn't write those as journal entries that the dashboard can display.

**Key files:**
- `engine/src/core/orchestrator.js` — the main cycle logic, sleep branch ~line 900-990, thought generation ~line 1020-1100
- `engine/src/cognition/state-modulator.js` — `shouldThink` gate at line 252 (returns false when mode is 'sleeping')

### 2. Live Activity Indicator (CRITICAL UX)

The dashboard needs a real-time heartbeat showing what the engine is doing RIGHT NOW. When the user sees the dashboard, they should instantly know:
- Is it awake or sleeping?
- What phase is it in? (Phase 1: analyzing, Phase 2: goals, Phase 3: memory, Phase 4: health, Phase 5: decisions)
- Current energy level
- Time since last thought
- What it's actively doing (running AnalysisAgent, compiling document X, dreaming)

The engine already logs all this to stdout. It needs to be exposed to the dashboard — either via SSE (real-time event stream), WebSocket (the engine already has one on the realtime port), or a polling endpoint.

**Where to put it on the dashboard:** A persistent status bar or indicator that's always visible — not hidden in a tab. Could be:
- An enhanced version of the existing status pills
- A dedicated "engine pulse" section
- The COSMO status indicator expanded to show full engine state

**Key files:**
- `engine/src/dashboard/server.js` — dashboard API, already has SSE for log streaming
- `engine/src/dashboard/home23-dashboard.html` — the dashboard page
- `engine/src/dashboard/home23-dashboard.js` — client-side logic
- `engine/src/core/orchestrator.js` — where phase/state info originates

## Hard Rules

- **NEVER** `pm2 stop all` or `pm2 delete all` — jtr has 50+ other processes
- **NEVER** modify `/Users/jtr/_JTR23_/Home23/` — that's the archived old repo
- Engine modifications for root-cause fixes are OK — wholesale rewrites are not
- Don't add features without asking jtr first
- After making changes, restart only the specific process: `pm2 restart home23-jerry` (engine), `pm2 restart home23-jerry-dash` (dashboard)
- Commit and push when work is verified: `cd /Users/jtr/_JTR23_/release/home23 && git add -A && git commit -m "..." && git push`

## The User

jtr is the architect. He doesn't write code — he works through AI agents. He's direct, catches drift fast, and thinks in terms of product not engineering. When something's wrong he'll tell you immediately. Don't over-engineer. Don't add things he didn't ask for. Make it work for users, not just developers.

## System State

- Agent "jerry" running from `/Users/jtr/_JTR23_/release/home23/`
- 6 PM2 processes: home23-jerry, home23-jerry-dash, home23-jerry-feeder, home23-jerry-harness, home23-evobrew, home23-cosmo23
- Dashboard: http://localhost:5002/home23
- Engine: cognitive loops with sleep/wake cycles, 4000+ brain nodes
- Feeder: processing ~6000 doc queue from workspace migration
- Design: ReginaCosmo glass-morphism (space gradient, particles, translucent tiles)
