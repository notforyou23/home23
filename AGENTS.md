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

### 1. COSMO 2.3 Integration (NEXT SESSION)

Make COSMO 2.3 work properly as part of the Home23 AI OS — both for the user (dashboard tab, direct UI access) and for agents (research tool, brain compilation).

**What exists:**
- cosmo23 bundled at `cosmo23/`, PM2 process `home23-cosmo23` on port 43210
- Dashboard COSMO tab embeds cosmo23 UI via iframe
- Agent has a `research` tool with search/launch/status/compile actions
- Design docs at `docs/design/STEP9-COSMO23-INTEGRATION-DESIGN.md` and `STEP9B-DASHBOARD-COSMO-EMBED-DESIGN.md`

**What to verify/fix:**
1. Is cosmo23 accessible at http://localhost:43210? Does the UI load?
2. Does the agent's research tool launch COSMO runs?
3. Can completed research runs compile into the agent brain?
4. Do research brains appear in evobrew's brain picker?
5. Does the COSMO tab iframe in the dashboard work?
6. API keys — does cosmo23 read from Home23's secrets.yaml?
7. Models — does cosmo23 use models from home.yaml?

**Key files:**
- `cosmo23/` — bundled COSMO 2.3 installation
- `cosmo23/.cosmo23-config/config.json` — COSMO config (auto-generated?)
- `src/agent/tools/research.ts` — agent's research tool
- `engine/src/dashboard/home23-dashboard.js` — COSMO tab iframe logic

### 2. Done: Engine Sleep/Wake (FIXED)

Sleep/wake rebalanced for Home23. Config-driven, ~90s naps, fast maintenance always runs.
See `docs/design/SLEEP-WAKE-DESIGN.md`.

### 3. Done: Live Activity Indicator (FIXED)

Engine pulse bar on dashboard via WebSocket (port 5001). Shows state, phase, energy, cycle, ago timer.

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
- 5 PM2 processes: home23-jerry, home23-jerry-dash, home23-jerry-harness, home23-evobrew, home23-cosmo23
- Standalone feeder (home23-jerry-feeder) is STOPPED — engine's built-in DocumentFeeder handles ingestion
- Dashboard: http://localhost:5002/home23
- Evobrew: http://localhost:3415 (managed by Home23, config.json gitignored + auto-generated)
- COSMO 2.3: http://localhost:43210
- Engine: cognitive loops with config-driven sleep/wake (~90s naps), pulse bar on dashboard
- Ingestion: engine DocumentFeeder processing ~4400 files through LLM compiler (minimax-m2.7)
- Jerry's model: configurable via dashboard dropdown (currently grok-4.20-reasoning-latest / xai)
- Model change flow: dashboard dropdown → config.yaml → harness auto-restart → evobrew config regen
- Config single source of truth: `config/home.yaml` + `config/secrets.yaml` + `instances/jerry/config.yaml`
- Design: ReginaCosmo glass-morphism (space gradient, particles, translucent tiles)
