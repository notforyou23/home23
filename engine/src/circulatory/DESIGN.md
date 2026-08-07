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
**Residence-Time Admission (From The Inside — Unit 4).** A composting pass is
admitted when **either** of two arms fires:

- **Count arm** — the number of *valid* (JSON-parseable) entries reaches
  `countThreshold` (default **500**).
- **Age arm** — the oldest *valid, timestamped* entry has resided longer than
  `oldestAgeThresholdMs` (default **7 days**, bounded). This keeps a small but
  stale pile from lingering indefinitely between the rare times the count arm
  fires.

Both thresholds are constructor-configurable (`countThreshold`,
`oldestAgeThresholdMs`) so tests can drive deterministic triggers.

**Action:**
- Read `discarded-thoughts.jsonl`, parsing line by line.
- Compute operational evidence and report it in the return value + log:
  - `validEntryCount` — successfully parsed entries.
  - `oldestValidEntryAgeMs` — residence age of the oldest valid timestamped
    entry (`null` when no entry carries a usable timestamp; clamped at ≥0).
  - `arrivalRatePerHour` — observed rate estimated from valid timestamps as
    `(n − 1) / span_hours`; **`null`** when there are fewer than two timestamps
    or the span is zero, to avoid divide-by-zero and false precision.
  - `timestampedCount`, `malformedLines`, and which arm(s) triggered.
- Extract patterns: top discard reasons, top signals discarded, top time-of-day
  patterns.
- Produce a one-paragraph human-readable summary.
- **Log the summary and evidence. This is log-only.**
- Truncate the file (post-compost).

**Malformed-input handling (explicit):**
- Lines that fail `JSON.parse` are skipped and counted as `malformedLines`.
- Entries with a missing or malformed timestamp still count toward the **count
  arm** but are excluded from the age arm and the arrival-rate estimate.
- **Missing, empty, or entirely malformed input is a safe no-op: it returns
  without truncating**, so unreadable content is never destroyed.

**No brain write.** The composter does **not** write a brain observation node
and does **not** revive the old `compost_receipt` node. It is the janitor for
`discarded-thoughts.jsonl` and must not file a receipt into the thing it
cleans. A `memory` graph may still be passed in for wiring compatibility, but it
is never called.

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