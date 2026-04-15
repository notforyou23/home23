# Agent Work Consolidation

Date: 2026-04-14
Home base: `/Users/jtr/_JTR23_/release/home23/instances/jerry`
Status: **Stage 2 complete** — full machine census with verified PIDs, memory, and system classification

## Why this exists

Consolidate the **work of the agents** across the house:
- cron jobs, dashboards, PM2 services, projects, outputs/artifacts
- specialist pipelines, overlapping operator roles
- legacy processes still consuming resources

This is a work-surface consolidation problem, not an identity problem.

---

## Machine-wide process census

**58 PM2 processes. 56 alive. ~8.2 GB total RAM.**

| System | Processes | Alive | RAM |
|--------|-----------|-------|-----|
| HOME23-RELEASE | 7 | 7 | 2,812 MB |
| COSMO-OLD (cosmo-home) | 12 | 12 | 2,520 MB |
| COSMO23-LEGACY (cosmo-home_2.3) | 14 | 14 | 1,661 MB |
| OPENCLAW | 11 | 10 | 503 MB |
| WEBSITES | 9 | 9 | 462 MB |
| OTHER | 4 | 3 | 188 MB |
| EVOBREW | 1 | 1 | 51 MB |

**Key finding:** The legacy systems (COSMO-OLD + COSMO23-LEGACY) consume **4.2 GB combined** — more than the active Home23 release system. All 26 processes are alive and consuming real memory.

---

## System A: HOME23-RELEASE (the current system)
**Root:** `/Users/jtr/_JTR23_/release/home23`
**7 processes, 2,812 MB RAM — this is us**

| Process | Script | RAM | Role |
|---------|--------|-----|------|
| `home23-jerry` | engine/src/index.js | ~1,120 MB | Jerry engine (brain, cognitive loops) |
| `home23-jerry-dash` | engine/src/dashboard/server.js | ~1,860 MB | Jerry dashboard (port 5002) |
| `home23-jerry-feeder` | feeder/server.js | ~87 MB | Document ingestion |
| `home23-jerry-harness` | dist/home.js | ~95 MB | Telegram harness |
| `home23-dashboard` | instances/jerry/projects/Dashboard/server.js | ~49 MB | Live data dashboard (port 8090) |
| `home23-cosmo23` | cosmo23/server/index.js | ~62 MB | COSMO research engine |
| `home23-evobrew` | evobrew/server/server.js | ~51 MB | Evobrew IDE (port 3415) |

**Cron jobs owned here:**
- `ticker-home23-site`
- `ticker-home23-pre-market`
- `ticker-home23-mid-session`
- `ticker-home23-evening-research`

**Status:** Clean. Everything here is live and serving a purpose.

---

## System B: COSMO23-LEGACY
**Root:** `/Users/jtr/_JTR23_/cosmo-home_2.3`
**14 processes, 1,661 MB RAM**

| Process | Instance | Port | Role |
|---------|----------|------|------|
| `cosmo23-coz` | coz | 4611 | COZ operator runtime |
| `cosmo23-home` | althea | 4610 | Althea/Home runtime |
| `cosmo23-edison` | edison | 4612 | Edison specialist |
| `cosmo23-tick` | tick | 4613 | Tick market agent |
| `cosmo23-jtr` | coz | 4611 | JTR engine (duplicate?) |
| `cosmo23-jtr-dash` | coz | 4611 | JTR dashboard |
| `cosmo23-jtr-feeder` | coz | 4611 | JTR feeder |
| `cosmo23-terrapin` | coz | 4611 | Terrapin engine |
| `cosmo23-terrapin-dash` | coz | 4611 | Terrapin dashboard |
| `cosmo23-terrapin-feeder` | coz | 4611 | Terrapin feeder |
| `cosmo23-knowledge` | coz | 4611 | Knowledge dashboard |
| `cosmo23-mcp` | coz | 4611 | MCP server |
| `cosmo23-voice` | coz | 4670 | Voice server |
| `althea-dashboard` | coz | 4611 | Althea dashboard |

**Key observations:**
- COZ, Althea, Edison, Tick all have distinct instances with distinct ports
- Terrapin is a full agent stack (engine + dash + feeder) — another agent identity
- Many processes share port 4611 / inst=coz, suggesting shared config inheritance
- This is the **previous generation** of the multi-agent house

**Question for consolidation:** Are any of these still being actively used, or has Home23-release fully replaced them?

---

## System C: COSMO-OLD
**Root:** `/Users/jtr/_JTR23_/cosmo-home` (no version suffix)
**12 processes, 2,520 MB RAM — the heaviest legacy system**

| Process | Role | RAM |
|---------|------|-----|
| `regina-jtr` | JTR engine (old "Regina" naming) | ~842 MB |
| `regina-jtr-dash` | JTR dashboard | ~595 MB |
| `regina-terrapin` | Terrapin engine | ~85 MB |
| `regina-terrapin-dash` | Terrapin dashboard | ~112 MB |
| `regina-tile-dash` | Tile dashboard | ~119 MB |
| `regina-mcp` | MCP server | ~47 MB |
| `regina-voice` | Voice server | ~77 MB |
| `jtr-feeder` (×2) | Two feeder instances | ~95 MB |
| `terrapin-feeder` | Terrapin feeder | ~476 MB |
| `drop-converter` | Drop converter | ~45 MB |
| `cosmo-gallery` | Gallery | ~27 MB |

**Key observation:** This is the **oldest generation** — "Regina" naming predates both cosmo-home_2.3 and Home23. It's consuming 2.5 GB for what appears to be a fully superseded system.

---

## System D: OPENCLAW
**Root:** `/Users/jtr/.openclaw`
**11 processes, 503 MB RAM**

| Process | Role | Status |
|---------|------|--------|
| `coz-dashboard` | COZ dashboard (port 3500) | alive |
| `mission-control-api` | Mission control API | alive |
| `mission-control-ui` | Mission control UI | ⚠️ crash-loop (2,594 restarts) |
| `project-board-site` | Project board | alive |
| `brain-agent` | Brain agent | alive |
| `intel-agent` | Intel agent | alive |
| `shakedown-agent` | Shakedown agent | alive |
| `shakedown-dashboard` | Shakedown dashboard | alive |
| `shakedown-image-filter` | Image filter cron | alive |
| `ecosystem.walkaway` | Walk-away automation | alive |
| `jerry-daily` | Jerry daily job | stopped |

**Key observation:** OpenClaw is a separate agent ecosystem with its own agent types (brain, intel, shakedown) and project surfaces (mission-control, project-board, walk-away). This is yet another layer of agent work.

---

## System E: WEBSITES
**Root:** various under `~/websites/`
**9 processes, 462 MB RAM**

| Process | Site |
|---------|------|
| `shakedown-audio-static` | shakedownshuffle.com |
| `jerry-api` | shakedownshuffle.com/jerry-api |
| `cosmo-backend` | regina6.com/html/cosmo |
| `cosmo-admin` | cosmos.evobrew.com/admin |
| `cosmo-studio` | cosmos.evobrew.com |
| `cosmo-unified` | cosmos.evobrew.com |
| `jogging-with-ghosts` | joggingwithghosts.com |
| `from-the-inside-api` | olddeadshows.com |
| `shore-collectibles` | shorecollectiblesnj.com ⚠️ crash-loop (2,583 restarts) |

**These are web properties, not agents.** They belong in a separate "websites" bucket entirely.

---

## System F: OTHER

| Process | Location | Status |
|---------|----------|--------|
| `evobrew` | `_JTR23_/evobrew` (standalone, port 3405) | alive |
| `cosmo-ide-local` | `_JTR23_/cosmo_ide_v2_dev` | alive |
| `coz-cortex` | `/Users/jtr` (root!) | alive |
| `jerry-tool` | `~/jerry-tool` | ⚠️ crash-loop (1,374 restarts) |
| `pm2-logrotate` | pm2 module | alive |

---

## Problems identified

### 1. Three generations of the same system running simultaneously
- **COSMO-OLD** (Regina) → **COSMO23-LEGACY** (2.3) → **HOME23-RELEASE** (current)
- All three are alive and consuming ~8 GB combined
- Unless the older generations are actively serving something Home23 can't, they're wasting resources

### 2. Crash-looping processes
- `jerry-tool` — 1,374 restarts
- `mission-control-ui` — 2,594 restarts
- `shore-collectibles` — 2,583 restarts

### 3. Agent identity sprawl across systems
The same conceptual agents exist in multiple systems:
- **JTR/Jerry:** `home23-jerry` + `cosmo23-jtr` + `regina-jtr`
- **Terrapin:** `cosmo23-terrapin` + `regina-terrapin`
- **COZ:** `cosmo23-coz` + `coz-dashboard` + `coz-cortex`
- **Feeder:** `home23-jerry-feeder` + `cosmo23-jtr-feeder` + `jtr-feeder` (×2) + `terrapin-feeder`

### 4. Port collision risk
Many COSMO23-LEGACY processes all claim port 4611 with inst=coz — unclear if they're actually binding or just inheriting env.

---

## Stages ahead

### Stage 3 — Dependency & overlap map
For each legacy system: what is it still providing that Home23-release doesn't?
- Are any dashboards still being accessed?
- Are any agents still receiving Telegram messages?
- Are any feeders still ingesting documents?

### Stage 4 — Consolidation recommendations
Per-process: keep / migrate / retire
With estimated RAM recovery and risk assessment

### Stage 5 — Execution plan
Ordered shutdown/migration steps
Rollback plan if something breaks

---

## Open questions for jtr
1. Are you still actively using any COSMO-OLD or COSMO23-LEGACY surfaces?
2. Is Terrapin an agent you want to carry forward?
3. Are the OpenClaw agents (brain, intel, shakedown) still doing useful work?
4. Are any of the websites (shore-collectibles, jogging-with-ghosts, etc.) still needed?
5. What's coz-cortex? It's running from `/Users/jtr` root — unusual.
