# Circulatory System — Design

## Problem

The system generates waste faster than it clears it. Five specific clogs:

1. **833 empty agent directories** — Created during cognitive cycles, never cleaned up. Only file across all 833: a `.DS_Store`. Pure cholesterol.
2. **402 discarded thoughts** — Pile up in `discarded-thoughts.jsonl` since May 4. No composting, no pattern extraction, no clearing. Dead blood cells accumulating.
3. **Synthesis is effectively manual** — `shouldTriggerSynthesis()` exists in meta-coordinator but is probabilistic (60-90% chance every 3-4 reviews). The brain has 28K cycles but synthesis was last triggered manually. Blood never gets oxygenated.
4. **Suppression spam** — Discovery engine suppresses repeated observations and logs each one. 54 in 5 minutes. The system generates signal, kills it, writes a receipt for the killing. Heart beating against a closed valve.
5. **Empty thoughts** — Thinking machine generates thoughts with `hasContent: false, hasHypothesis: false`. These enter the pipeline, get critiqued, get discarded, get logged. Waste flowing through the entire system before being filtered.

## Design

Five components, each addressing one clog. All local, no LLM calls, all bounded.

### 1. Waste Sweeper (`sweeper.js`)
**Schedule:** Every 30 minutes (cron-driven from engine)
**Actions:**
- Scan `brain/agents/` for directories with no real files (only .DS_Store or empty). Remove dirs older than 6 hours.
- Scan `discarded-thoughts.jsonl` — if > 500 lines, trigger composting pass, then truncate.
- Scan `dreams.jsonl` — if > 2000 lines, keep last 500, archive rest to `dreams-archive-{date}.jsonl`.
- Scan `thoughts.jsonl` — if > 1000 lines, keep last 500.
- Scan cron-decision archives older than 30 days — remove.

**Safety:**
- Never delete non-empty agent dirs (dirs with real files).
- Never delete the file itself, only truncate content.
- Archive before truncating (dreams, thoughts).
- Log every action with counts.

### 2. Composting Pass (`composter.js`)
**Trigger:** When sweeper detects > 500 discarded thoughts.
**Action:**
- Read last 500 discarded thoughts.
- Extract patterns: top discard reasons, top signals discarded, top time-of-day patterns.
- Produce a one-paragraph summary: "Of 500 discarded thoughts, 73% were novelty signal with no content, 15% were verbatim restatements of discovery metadata, 12% other. Primary discard pattern: empty nodes discovered by novelty probe."
- Write summary as a brain observation node (tag: `compost_receipt`).
- Truncate the file.
- Log the composting.

**No LLM calls.** Pure local pattern extraction.

### 3. Auto-Synthesis Trigger (`synthesis-trigger.js`)
**Schedule:** Every 6 hours, checked during cognitive cycle.
**Action:**
- Read `brain-state.json` `generatedAt` timestamp.
- If older than 6 hours, trigger synthesis agent.
- If synthesis fails, log and retry next cycle.
- Maximum 1 synthesis per 4 hours (rate limit).

**Fixes:** The probabilistic trigger in meta-coordinator stays for review-cycle synthesis. This adds a time-based guarantee: synthesis runs at least every 6 hours regardless of review cycle count.

### 4. Suppression Rate Limiter
**Location:** `engine/src/cognition/discovery-engine.js`
**Change:** Replace per-suppression debug logging with batched logging.
- Track suppression count per channel.
- Log once every 50 suppressions (not every 1).
- Reset counters on log.

**Fixes:** The 54 log lines in 5 minutes become 1 log line.

### 5. Empty Thought Filter
**Location:** `engine/src/cognition/thinking-machine.js` (or wherever thoughts are first generated)
**Change:** Before entering the critique pipeline, check:
- `text.length < 10` → skip, increment counter
- `!hasHypothesis && !hasContent` → skip, increment counter
- Log batched: "Skipped N empty thoughts this cycle"

**Fixes:** Empty thoughts never enter the pipeline, never get critiqued, never get discarded, never get logged.

## Integration

- **Sweeper + Composter** run as a periodic check inside the orchestrator's cognitive cycle (every 30 min, checked via timestamp).
- **Synthesis trigger** runs as a periodic check inside the orchestrator's cognitive cycle (every 6h, checked via timestamp).
- **Suppression rate limiter** is a code change in discovery-engine.js.
- **Empty thought filter** is a code change in thinking-machine.js.

All components log to the engine logger. All are reversible. All have bounded scope.

## File layout

```
engine/src/circulatory/
├── DESIGN.md           (this file)
├── sweeper.js           (waste directory/file cleanup)
├── composter.js         (discarded thought pattern extraction)
└── synthesis-trigger.js (time-based synthesis guarantee)
```

Modifications to existing files:
- `engine/src/cognition/discovery-engine.js` — batched suppression logging
- `engine/src/cognition/thinking-machine.js` — empty thought pre-filter
- `engine/src/core/orchestrator.js` — wire up periodic checks

## What this does NOT do

- Does not change what the brain thinks about.
- Does not change what gets promoted to memory.
- Does not add new LLM calls.
- Does not change the cognitive cycle structure.
- Does not touch the agency system.

It only ensures the pipes stay clear so signal can flow.