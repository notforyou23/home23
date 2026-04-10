# Home23 — Agent Instructions

## What This Is

Home23 is a running AI operating system. The repo at `/Users/jtr/_JTR23_/release/home23/` is both the public GitHub repo AND jtr's live running system. Agent "jerry" runs from here via PM2.

**GitHub:** https://github.com/notforyou23/home23

## Before You Do Anything

1. Read memory files (if available) at `/Users/jtr/.claude/projects/-Users-jtr--JTR23--release-home23/memory/`:
   - `MEMORY.md` — index of all memory files (start here)
   - Most recent `session_*_handoff.md` — latest session context, what was built, any open issues
   - `user_jtr.md` — who you're working with

2. Read the design docs for whatever area you're touching:
   - `docs/design/STEP16-AGENT-COSMO-TOOLKIT-DESIGN.md` — if working on research tools
   - `docs/design/STEP17-FEEDER-SETTINGS-DESIGN.md` — if working on ingestion or the Feeder tab
   - `docs/design/COSMO23-VENDORED-PATCHES.md` — **CRITICAL: read before touching anything in `cosmo23/`**

3. Verify the system is running:
```bash
pm2 jlist | python3 -c "import sys,json; [print(f\"{p['name']:30s} {p['pm2_env']['status']}\") for p in json.load(sys.stdin) if 'home23' in p['name']]"
curl -s http://localhost:5002/api/state | python3 -c "import sys,json; d=json.load(sys.stdin); m=d.get('memory',{}); print(f'cycle={d.get(\"cycleCount\",0)} nodes={len(m.get(\"nodes\",[]))}')"
curl -s http://localhost:43210/api/status | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'cosmo23 running={d.get(\"running\")}')"
```

## Priority Work

No pressing priority. The recent major work is shipped and verified. Ask jtr what's next.

### Recent completions (most recent first)

#### Done: Step 17 — Feeder Settings Tab (2026-04-10)

Full configuration surface for the document feeder in the dashboard Settings UI: live status, watch paths, exclusion patterns, chunking, compiler model, converter, drag-and-drop drop zone. Backend split: engine-side admin HTTP on port 5001 (via RealtimeServer), dashboard-side upload via multer + proxies for commands. Hot-apply vs restart-required classification in the save response drives a UI banner.

- `src/ingestion/document-feeder.js` — added `removeWatchPath`, `forceFlush`, `excludePatterns` plumbing
- `src/realtime/websocket-server.js` — `/admin/feeder/*` routes, `setOrchestrator` wiring
- `src/dashboard/server.js` — multer upload + proxy handlers
- `src/dashboard/home23-settings-api.js` — `GET/PUT /api/settings/feeder` with hot/restart split
- `src/dashboard/home23-settings.{html,js,css}` — new Feeder tab with 5 sections + drop zone
- `docs/design/STEP17-FEEDER-SETTINGS-DESIGN.md`

Verified end-to-end: file upload → chokidar → compiler → brain node creation, config changes correctly classified, UI renders with live data.

**Known pre-existing issue** (not Step 17's bug, but affects the Feeder tab): js-yaml strips comments when the settings API writes `configs/base-engine.yaml`. This affects every settings tab, not just Feeder. Fix is a migration to a comment-preserving yaml library — flagged as a follow-up.

#### Done: Step 16 — Agent COSMO Toolkit (2026-04-10)

Replaced the 4-action `research` tool with 11 atomic `research_*` tools + a `COSMO_RESEARCH.md` skill file (loaded via identity layer) + a live `[COSMO ACTIVE RUN]` injection in the agent loop. Jerry can now launch with full context, watch, query, compile sections, and get brain graphs directly from chat. All verified end-to-end including a real 5-cycle gpt-5.2 run that produced 26 nodes and a compiled post-it-note summary.

- `src/agent/tools/research.ts` — 11 tools + `checkCosmoActiveRun()` helper
- `src/agent/tools/index.ts` — 11 registrations
- `src/agent/loop.ts` — active-run awareness injection (~line 385)
- `src/agent/context.ts` — `COSMO_RESEARCH.md` size cap
- `instances/<agent>/workspace/COSMO_RESEARCH.md` — skill file (seeded by agent-create)
- `cli/templates/COSMO_RESEARCH.md` — ships with repo
- `cli/lib/agent-create.js` — new agents get the skill file + identityFiles entry
- `docs/design/STEP16-AGENT-COSMO-TOOLKIT-DESIGN.md`

#### Done: COSMO 2.3 Integration (2026-04-10)

Config unification patches, env-first key resolution, engine heap bump from 768MB→4GB, dashboard Tailscale timeouts, ENGINE indicator. Smoke test: 5-cycle gpt-5.2 run completed clean with 26 brain nodes and 84 edges. Compile path verified end-to-end. See `docs/design/COSMO23-VENDORED-PATCHES.md` for vendored patches that MUST be re-verified on any cosmo23 update.

#### Done: Engine Sleep/Wake

Sleep/wake rebalanced for Home23. Config-driven, ~90s naps, fast maintenance always runs. See `docs/design/SLEEP-WAKE-DESIGN.md`.

#### Done: Live Activity Indicator

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
- 5 PM2 processes: `home23-jerry`, `home23-jerry-dash`, `home23-jerry-harness`, `home23-evobrew`, `home23-cosmo23`
- Standalone feeder (`home23-jerry-feeder`) is STOPPED and removed from ecosystem — the engine's built-in DocumentFeeder handles all ingestion from inside `home23-jerry`
- Dashboard: http://localhost:5002/home23
- Settings (incl. Feeder tab): http://localhost:5002/home23/settings
- Evobrew: http://localhost:3415 (managed by Home23, config.json gitignored + auto-generated)
- COSMO 2.3: http://localhost:43210
- Engine: cognitive loops with config-driven sleep/wake (~90s naps), pulse bar on dashboard
- Ingestion: engine DocumentFeeder processing thousands of files through LLM compiler (minimax-m2.7 default, configurable in Feeder tab)
- Jerry has 30 tools including the 11 `research_*` tools for COSMO 2.3
- Jerry's model: configurable via dashboard dropdown (currently grok-4.20-non-reasoning-latest / xai)
- Model change flow: dashboard dropdown → config.yaml → harness auto-restart → evobrew config regen
- Config single source of truth: `config/home.yaml` + `config/secrets.yaml` + `instances/jerry/config.yaml` + `configs/base-engine.yaml` (feeder block)
- Engine heap: `--max-old-space-size=4096`, `max_memory_restart: 5G` (raised from 768M / 900M to prevent OOM flap with growing brains)
- Design: ReginaCosmo glass-morphism (space gradient, particles, translucent tiles)
