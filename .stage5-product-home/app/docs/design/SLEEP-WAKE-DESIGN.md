# Home23 Engine — Sleep/Wake Architecture

## Overview

Home23's cognitive engine runs continuous cycles of thought, goal pursuit, and memory formation. Between productive awake periods, the engine enters short sleep sessions for brain maintenance — memory consolidation, garbage collection, dream rewiring, and decay. Unlike COSMO 2.3 (the research engine this was derived from), Home23 is an always-on personal AI that prioritizes responsiveness. Sleep is a quick maintenance pass, not a deep research hibernation.

## Energy Model

Energy is the primary gate for sleep/wake transitions. All values are configurable in `configs/base-engine.yaml` under `architecture.cognitiveState`.

| Parameter | Value | Config Key | Effect |
|---|---|---|---|
| Initial energy | 1.0 | `initialEnergy` | Starting energy on boot |
| Drain rate | 0.01/cycle | `energyDrainRate` | Cost per awake cycle |
| Recovery rate | 0.10/cycle | `energyRecoveryRate` | Gained per sleep cycle |
| Sleep threshold | 0.15 | `sleepThreshold` | Enter sleep below this |
| Wake threshold | 0.35 | `wakeThreshold` | Wake when energy reaches this |
| Sleep cycle cap | 45s | `maxSleepCycleInterval` | Max seconds between sleep cycles |

### Typical Timing

- **Awake window**: ~85 cycles from full energy (~2.5–3 hours at ~2 min/cycle)
- **Sleep duration**: ~2–3 cycles (~90–135 seconds with 45s cap)
- **Full LLM consolidation**: every 20+ minutes (rate-limited)

### Why the Cap Matters

The engine uses adaptive timing: `interval = baseInterval × (2 - curiosity) × (2 - energy)`. Low energy during sleep would stretch cycle intervals to 4–5 minutes, making recovery painfully slow. The `maxSleepCycleInterval` caps sleep cycles at 45 seconds regardless of energy level, so recovery is always fast.

## Two Sleep Triggers

Sleep is triggered by **either** of two independent systems. Both cross-sync the other when activated.

### 1. Cognitive System (`engine/src/cognition/state-modulator.js`)

Monitors energy on every `updateState()` call. When `energy < sleepThreshold` (0.15), transitions mode to `sleeping`. Wakes when `energy > wakeThreshold` (0.35).

### 2. Temporal System (`engine/src/temporal/rhythms.js`)

Two sub-triggers:
- **Cycle-based**: Every 200 awake cycles, forces a sleep for scheduled consolidation (~6+ hours at normal cycle speed)
- **Emergency backup**: If energy drops below 0.10 (below the cognitive threshold) or fatigue exceeds 0.7

Temporal has a 10-minute debounce after wake to prevent thrashing.

## What Happens During Sleep

### Cycle 1: Brain Maintenance

The first sleep cycle runs `performDeepSleepConsolidation()`, which attempts the full LLM-driven maintenance suite. If the LLM consolidation is rate-limited (< 20 minutes since last run), the system falls back to `performFastSleepMaintenance()` instead.

#### Full Consolidation (LLM, rate-limited to 20 min)

| Step | What | LLM? | Duration |
|---|---|---|---|
| 1. Journal summarization | Summarize recent thoughts into a memory node | Yes (gpt-5-mini × 2) | Fast |
| 2. Memory consolidation | Cluster similar nodes, produce abstractions | Yes (gpt-5.2) | Slow |
| 3. Goal analysis | Extract goals from journal | Yes (1 call) | Medium |
| 4. Dream generation | 2–3 creative dreams, save to log, capture goals | Yes (2–3 calls) | Slow |
| 5. Dream rewiring | Watts-Strogatz rewire at p=0.5 (aggressive cross-cluster bridging) | No | Fast |
| 6. Garbage collection | Remove weak/old nodes and their edges | No | Fast |
| 7. Mood recovery | Restore mood if < 0.3 | No | Instant |
| 8. State save | Persist full brain to disk | No | Fast |

#### Fast Maintenance (no LLM, runs when rate-limited)

| Step | What |
|---|---|
| 1. Garbage collection | Remove weak/old nodes |
| 2. Memory decay | Weaken old/unused node and edge weights |
| 3. Moderate rewiring | Watts-Strogatz at p=0.1 (balanced cross-linking) |
| 4. Goal maintenance | Elevate stale priorities, merge similar goals |
| 5. Mood recovery | Restore mood if < 0.3 |

#### NoticePass (always runs, no LLM)

Five read-only scanners run after both full and deferred consolidation:

| Scanner | What it finds |
|---|---|
| `scanGaps` | Memory clusters with low cross-cluster connectivity |
| `scanStale` | Nodes not accessed in 7+ days inside active clusters |
| `scanTimeSensitive` | Nodes with dates within a 14-day horizon |
| `scanConnections` | Weak edges between important cross-cluster nodes |
| `scanEmotional` | Recently accessed nodes with affective content |

Produces up to 5 noticings, each routed to `bridge-chat`, `heartbeat`, `reminder`, `newsletter`, or `morning-briefing`.

### Cycles 2+: Recovery

Subsequent sleep cycles just recover energy (+0.10/cycle) and emit a sleep-status thought so the dashboard stays fresh. No LLM calls, no maintenance work. The engine wakes as soon as energy reaches the wake threshold.

## Awake Maintenance (independent of sleep)

These operations run during normal awake cycles and are unaffected by sleep duration:

| Trigger | What | LLM? |
|---|---|---|
| Every 30 cycles | Gentle rewiring (p=0.01), decay, GC, role pruning, goal merge | No |
| Every 20 cycles | Journal reflection, goal curation | Yes |
| Every 10 cycles | Goal discovery from recent output | Yes |
| Every 5 cycles | Checkpoint save | No |

## Dashboard: Engine Pulse Bar

The dashboard displays a real-time activity indicator ("engine pulse bar") below the header. It connects directly to the engine's WebSocket server (port 5001) for real-time events.

Shows: animated state dot (green=awake, purple=sleeping, blue=thinking), current phase, energy %, cycle number, and time since last thought.

Events handled: `cycle_start`, `thought_generated`, `sleep_triggered`, `wake_triggered`, `coordinator_review`, `executive_decision`, `agent_spawned`, `agent_completed`, `dream_rewiring`, `cognitive_state_changed`, `cognitive_state_update`, `cycle_complete`, `node_created`.

Falls back to REST polling via `/api/state` every 30 seconds.

## Key Files

| File | What |
|---|---|
| `configs/base-engine.yaml` | All sleep/wake config values |
| `engine/src/core/orchestrator.js` | Main cycle, sleep branch, consolidation, fast maintenance |
| `engine/src/cognition/state-modulator.js` | Energy model, mode transitions, thresholds |
| `engine/src/temporal/rhythms.js` | Temporal triggers, rate limits, scheduled sleep |
| `engine/src/memory/network-memory.js` | `rewire()`, `applyDecay()` |
| `engine/src/memory/summarizer.js` | `summarizeRecentThoughts()`, `consolidateMemories()`, `garbageCollect()` |
| `engine/src/sleep/notice-pass.js` | Five memory health scanners |
| `engine/src/dashboard/home23-dashboard.js` | Pulse bar WebSocket client |

## Design Decisions

**Why short sleep?** Home23 is an always-on personal AI. Users should never see "stuck sleeping for 25 minutes." Sleep is a 90-second maintenance pass that happens every ~3 hours.

**Why two maintenance paths?** LLM consolidation is rate-limited to prevent thrashing. But GC, decay, and rewiring are fast and free — they should run every sleep session regardless. The fast path ensures the brain never goes unmaintained even when LLM calls are on cooldown.

**Why config-driven?** All thresholds were previously hardcoded across 3 files. Now they're in one YAML file, so tuning the sleep/wake balance doesn't require code changes.

**Why Watts-Strogatz rewiring at three levels?** Awake (p=0.01) gently maintains small-world properties. Fast sleep (p=0.1) does moderate cross-linking during maintenance. Dream sleep (p=0.5) aggressively bridges distant clusters for creative associations. The gradient ensures the graph stays navigable without becoming random.

**Why the sleep cycle interval cap?** The adaptive timing formula `(2 - energy)` stretches cycles when energy is low — which is counterproductive during sleep. Capping at 45 seconds means recovery doesn't drag.
