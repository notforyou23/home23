---
name: Session handoff — 2026-04-09 (afternoon/evening)
description: Public release built, migrated, pushed to GitHub. Design overhaul, vibe, brain map, dream log all shipped. Next: cosmo23 documentation, evobrew model config.
type: project
---

## Session 2026-04-09b — Handoff

### What was built:

**Public Release (Tasks 1-14):**
- Clean monorepo at `/Users/jtr/_JTR23_/release/home23/` — 27 commits, 1310+ files, 25MB source
- All personal data stripped (3 component audits, multiple verification passes)
- Jerry migrated — running from new repo, brain intact, PM2 saved
- Pushed to GitHub: https://github.com/notforyou23/home23

**Vibe Feature (carried from jtr's parallel work):**
- CHAOS MODE image generation with archive rotation
- Gallery page, hidden triple-click trigger
- Per-agent storage under instances/<agent>/workspace/vibe/

**ReginaCosmo Design Language Overhaul:**
- Space gradient background with particles.js star field
- Glass-morphism tiles (backdrop-filter, translucent borders, shadow)
- Dual timezone clocks, emoji tile headers, status pills
- Applied to ALL pages: home, intelligence, settings, chat, gallery, welcome

**Brain Map Tab:**
- 3D force-directed graph using 3d-force-graph (three.js)
- Adapted from COSMO 2.3's brain-map.js
- `/home23/api/brain/graph` endpoint serving node/edge data
- Search, reset, click-to-inspect nodes, connection navigation

**Dream Log:**
- Dream log tile side-by-side with brain log
- Click-to-expand overlay with full detail view
- Fetches from `/api/dreams` endpoint

**About Page:**
- System overview, four systems cards, dashboard guide
- Embedding guidance, GitHub link

**Engine Fixes:**
- meta-coordinator crash: `n.weight.toFixed()` → `(n.weight || 0).toFixed()`
- Minimum sleep cycles: 12 → 3 (energy is the real gate)
- Force thought generation when dashboard goes stale (>2 cycles without thought)

### Migration notes:
- Feeder manifest paths needed fixing (old repo → new repo)
- Vibe manifest paths needed fixing (absolute paths from old repo)
- `engine/runtime/thoughts.jsonl` warning is from insight-curator using wrong path (non-fatal)
- Feeder re-queued ~6000 files due to timestamp mismatch from cp -R (letting it process naturally)

### Current state:
- Repo: `/Users/jtr/_JTR23_/release/home23/` (THE repo, running + public)
- GitHub: https://github.com/notforyou23/home23
- Agent "jerry" running from new repo, all 6 PM2 processes online
- Old repo at `/Users/jtr/_JTR23_/Home23/` — retired, can be archived
- Engine cycling, brain 4000+ nodes, feeder processing doc queue

### Next session agenda (PRIORITY ORDER):

1. **Engine sleep/wake cycle — proper fix** — CRITICAL. The engine gets stuck sleeping for 25+ min showing stale thoughts. Three partial fixes applied this session (min cycles 12→3, wake threshold 0.8→0.6, force-thought-on-stale at line 1028) but none fully solve it. Root cause: the sleep branch in orchestrator.js (line ~943) returns before reaching thought generation (line ~1028). The sleep path processes feeder nodes and dreams but never writes a journal thought. Needs a proper architectural fix — either generate thoughts during sleep cycles, or restructure so thought generation happens BEFORE agent work drains energy. This is the #1 user-facing problem.

2. **Live activity indicator on dashboard** — CRITICAL UX. The dashboard needs a real-time heartbeat showing what the engine is doing RIGHT NOW (sleeping cycle 8/energy 0.65, thinking phase 3, dreaming, consolidating, running AnalysisAgent on goal X, feeder compiling document Y). The user should never wonder "is this thing stuck?" Needs: a visible pulse/heartbeat, current phase display, time-since-last-activity counter, and the current state (awake/sleeping/dreaming). The engine already logs all this — it just needs to be exposed via SSE or polling to the dashboard.

3. **cosmo23 documentation** — jtr has extensive build history across cosmo lineage (cosmo, cosmo-unified-dev, cosmo_2.3). Deep public-facing docs for the AI nerds.

4. **evobrew model config** — local:<agent-name> in model dropdown immediately, plus all configured providers from home.yaml.

5. **Custom tiles** — future feature for personal dashboard tiles (weather, sauna).

### Key files changed this session (in the new repo):
- All dashboard files (CSS, HTML, JS) — design overhaul
- engine/src/dashboard/home23-brain-map.js (new)
- engine/src/dashboard/home23-vibe/service.js (carried from old repo)
- engine/src/core/orchestrator.js (sleep fix, thought freshness)
- engine/src/coordinator/meta-coordinator.js (toFixed crash fix)
- docs/design/PUBLIC-RELEASE-DESIGN.md
- docs/design/STEP15-DESIGN-LANGUAGE-OVERHAUL.md
- docs/audits/ (3 component audits)
- README.md, LICENSE, .gitignore

### Critical rules (unchanged):
- NEVER use pm2 stop/delete all
- Engine modifications OK for root-cause fixes
- New repo at release/home23 is THE repo now
- Old repo at _JTR23_/Home23 is retired
