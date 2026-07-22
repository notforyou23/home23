# Fix 2.3 — H4 resource enforcement: ResourceMonitor-driven backpressure (heap fraction + RSS budget, hysteresis) gating AgentExecutor spawn concurrency; saves untouched

## Target current state

1) cosmo23/engine/src/core/resource-monitor.js — the monitor measures but never enforces. resource-monitor.js:18 `this.memoryLimitMB = config.resources?.memoryLimitMB || 512;` (512MB default; generated run configs carry 1024 — launcher/config-generator.js:644-647). resource-monitor.js:128-134: exceeding the limit only does `this.limitExceededCount++` + an error log + optional `global.gc()`. Nothing downstream reads `isHealthy()` for control flow. No backpressure concept exists anywhere in the engine (`grep -rn backpressure cosmo23/engine/src` → 0 hits; only server/lib/brain-operation-routes.js uses the word, unrelated).

2) Instantiation: orchestrator.js:246 `this.resourceMonitor = new ResourceMonitor(config, logger);` (constructor, "Phase A: Hardening modules" block); the only call site is orchestrator.js:3296 `const resourceSnapshot = this.resourceMonitor.snapshot();` at end-of-cycle — so between cycles (which can be minutes during a hung LLM await) memory is never evaluated. No interval timer exists.

3) Spawn path: agents/agent-executor.js:182 `this.maxConcurrent = config.coordinator?.maxConcurrent || 2;` and agent-executor.js:324 `if (!isStrategic && !this.registry.canSpawnMore(this.maxConcurrent))` — a static limit, never modulated by resource state; agent-executor.js:334 lets strategic missions bypass it entirely. `spawnAgent()` is the single choke point (25 call sites all route through it; agents/CLAUDE.md confirms "single entry point").

4) Save path: orchestrator saveState()/persistResearchState() and core/state-compression.js contain no resource checks today and must stay that way (H4: saves are sacred). Verified `grep backpressure state-compression.js` → 0, and the proposal adds nothing there.

5) Config: generated run config (launcher/config-generator.js:644-647) and engine/src/config.yaml:278-281 carry only `resources: {memoryLimitMB, memoryWarningThreshold, cpuWarningThreshold}` — no rssBudgetMb, no thresholds with hysteresis. launcher/process-manager.js:279 spawns the engine with plain `spawn('node', ['src/index.js'], ...)` — NO --max-old-space-size, no NODE_OPTIONS injection → default V8 old-space (~4GB on 64-bit), which is why the rssBudgetMb default is 4096.

6) Shutdown: graceful-shutdown-handler.js:308-311 comment says "Cleanup resource monitor (no active timers, just state)" — becomes stale once the monitor owns an interval (unref'd, but should be cleared explicitly).

## CHANGE: cosmo23/engine/src/core/resource-monitor.js

Constructor: add H4 backpressure state — the shared level object (created here, aliased by the orchestrator), rssBudgetMb, hysteresis thresholds, interval, heap floor, and internal flags.

### Anchor
```
    // GC stats tracking
    this.lastGCTime = Date.now();
    this.gcCount = 0;
  }
```

### Code
```js
    // GC stats tracking
    this.lastGCTime = Date.now();
    this.gcCount = 0;

    // H4 backpressure: single-source-of-truth object. Producers (this monitor)
    // WRITE it in place; consumers (AgentExecutor spawn gate) hold a reference
    // and READ it. NEVER reassign this.backpressure — the orchestrator and the
    // agent executor alias the same object instance.
    const bp = config.resources?.backpressure || {};
    this.rssBudgetMb = config.resources?.rssBudgetMb
      ?? config.resourceLimits?.rssBudgetMb
      ?? 4096; // engine child runs with default V8 heap (~4GB old space)
    this.bpIntervalMs = bp.intervalMs ?? 10000;
    this.bpThresholds = {
      elevatedEnterPct: bp.elevatedEnterPct ?? 0.70,
      elevatedExitPct: bp.elevatedExitPct ?? 0.60,
      criticalEnterPct: bp.criticalEnterPct ?? 0.85,
      criticalExitPct: bp.criticalExitPct ?? 0.75
    };
    // Heap fraction is meaningless on tiny heaps (V8 keeps heapTotal tight);
    // only count it once heapTotal crosses this floor. RSS-vs-budget always counts.
    this.bpHeapMinTotalMb = bp.heapMinTotalMb ?? 512;
    this.backpressure = { level: 'none', reasons: [] };
    this._bpElevatedActive = false;
    this._bpCriticalActive = false;
    this._bpTimer = null;
  }
```

## CHANGE: cosmo23/engine/src/core/resource-monitor.js

snapshot(): refresh backpressure at cycle boundaries with the reading already taken (interval covers long inter-cycle gaps; this covers fast cycles between ticks).

### Anchor
```
    // Check limits
    this.checkLimits(snapshot);

    this.lastCheck = Date.now();
```

### Code
```js
    // Check limits
    this.checkLimits(snapshot);

    // H4: refresh backpressure at cycle boundaries too (interval timer covers
    // long gaps between cycles; this covers fast cycles between ticks)
    this.evaluateBackpressure({
      heapUsed: memUsage.heapUsed,
      heapTotal: memUsage.heapTotal,
      rss: memUsage.rss
    });

    this.lastCheck = Date.now();
```

## CHANGE: cosmo23/engine/src/core/resource-monitor.js

New methods: evaluateBackpressure (two-flag hysteresis, mutate-in-place, log on level change only, injectable reading for tests), startBackpressureMonitor (unref'd setInterval, idempotent), stopBackpressureMonitor. Inserted immediately before the isHealthy() doc comment.

### Anchor
```
  /**
   * Check if resources are healthy
   */
```

### Code
```js
  /**
   * H4 backpressure evaluation with hysteresis.
   *
   * Pressure = max(heapUsed/heapTotal [only when heapTotal >= heapMinTotalMb],
   *                rss / rssBudgetMb).
   * Two-flag hysteresis: enter elevated at 70%, exit at 60%; enter critical at
   * 85%, exit at 75%. Exiting critical drops into the elevated band unless
   * pressure also cleared the elevated exit threshold. Logs on level CHANGE only.
   *
   * Writes this.backpressure IN PLACE (same object identity) so consumers
   * holding the reference observe updates. Saves are never gated on this —
   * enforcement is spawn-side only (AgentExecutor).
   *
   * @param {Object|null} reading - optional injected {heapUsed, heapTotal, rss} in BYTES (tests)
   * @returns {string} the new level: 'none' | 'elevated' | 'critical'
   */
  evaluateBackpressure(reading = null) {
    const mem = reading || process.memoryUsage();
    const heapTotalMb = mem.heapTotal / 1024 / 1024;
    const rawHeapFraction = mem.heapTotal > 0 ? mem.heapUsed / mem.heapTotal : 0;
    const heapFraction = heapTotalMb >= this.bpHeapMinTotalMb ? rawHeapFraction : 0;
    const rssMb = mem.rss / 1024 / 1024;
    const rssFraction = this.rssBudgetMb > 0 ? rssMb / this.rssBudgetMb : 0;
    const pressure = Math.max(heapFraction, rssFraction);
    const t = this.bpThresholds;

    // Two-flag hysteresis; critical implies elevated
    this._bpCriticalActive = this._bpCriticalActive
      ? pressure >= t.criticalExitPct
      : pressure >= t.criticalEnterPct;
    this._bpElevatedActive = (this._bpElevatedActive || this._bpCriticalActive)
      ? pressure >= t.elevatedExitPct
      : pressure >= t.elevatedEnterPct;
    if (this._bpCriticalActive) this._bpElevatedActive = true;

    const level = this._bpCriticalActive ? 'critical'
      : (this._bpElevatedActive ? 'elevated' : 'none');
    const reasons = [];
    if (level !== 'none') {
      const driver = heapFraction >= rssFraction ? 'heap' : 'rss';
      reasons.push(`pressure=${(pressure * 100).toFixed(1)}% driver=${driver}`);
      reasons.push(`heap ${(rawHeapFraction * 100).toFixed(1)}% of ${heapTotalMb.toFixed(0)}MB heapTotal${heapTotalMb < this.bpHeapMinTotalMb ? ' (below floor, ignored)' : ''}`);
      reasons.push(`rss ${rssMb.toFixed(0)}MB / ${this.rssBudgetMb}MB budget (${(rssFraction * 100).toFixed(1)}%)`);
    }

    const previousLevel = this.backpressure.level;
    // Mutate in place — consumers hold this object reference (H4)
    this.backpressure.level = level;
    this.backpressure.reasons = reasons;

    if (level !== previousLevel) {
      const line = '[ResourceMonitor] Backpressure level change';
      const detail = {
        from: previousLevel,
        to: level,
        pressurePct: (pressure * 100).toFixed(1),
        heapPct: (rawHeapFraction * 100).toFixed(1),
        heapTotalMb: heapTotalMb.toFixed(0),
        rssMb: rssMb.toFixed(0),
        rssBudgetMb: this.rssBudgetMb,
        reasons
      };
      if (level === 'none') {
        this.logger.info(line, detail);
      } else {
        this.logger.warn(line, detail);
      }
    }

    return level;
  }

  /**
   * Start the periodic backpressure evaluator (unref'd — never holds the
   * process open). Idempotent. Cycle boundaries also refresh via snapshot().
   */
  startBackpressureMonitor() {
    if (this._bpTimer) return;
    this._bpTimer = setInterval(() => {
      try {
        this.evaluateBackpressure();
      } catch (err) {
        this.logger.warn('[ResourceMonitor] Backpressure evaluation failed', { error: err.message });
      }
    }, this.bpIntervalMs);
    if (typeof this._bpTimer.unref === 'function') this._bpTimer.unref();
    this.logger.info('[ResourceMonitor] Backpressure monitor started', {
      intervalMs: this.bpIntervalMs,
      rssBudgetMb: this.rssBudgetMb,
      thresholds: this.bpThresholds
    });
  }

  /**
   * Stop the periodic backpressure evaluator. Level/reasons are left as-is.
   */
  stopBackpressureMonitor() {
    if (this._bpTimer) {
      clearInterval(this._bpTimer);
      this._bpTimer = null;
    }
  }

  /**
   * Check if resources are healthy
   */
```

## CHANGE: cosmo23/engine/src/core/resource-monitor.js

getStats(): surface current backpressure level + reasons (additive JSON, safe for existing consumers).

### Anchor
```
      healthy: this.isHealthy(),
      snapshotCount: this.memorySnapshots.length
    };
```

### Code
```js
      backpressure: {
        level: this.backpressure.level,
        reasons: this.backpressure.reasons.slice()
      },
      healthy: this.isHealthy(),
      snapshotCount: this.memorySnapshots.length
    };
```

## CHANGE: cosmo23/engine/src/core/resource-monitor.js

reset(): clear hysteresis flags and reset the level IN PLACE (never reassign the shared object).

### Anchor
```
    this.gcCount = 0;
    this.startTime = Date.now();
  }
```

### Code
```js
    this.gcCount = 0;
    this.startTime = Date.now();
    this._bpElevatedActive = false;
    this._bpCriticalActive = false;
    // In place — never reassign (H4 shared object identity)
    this.backpressure.level = 'none';
    this.backpressure.reasons = [];
  }
```

## CHANGE: cosmo23/engine/src/agents/agent-executor.js

Constructor: declare the injected read-only backpressure reference. WARNING: do NOT extend this anchor downward — the next line in the file is four spaces of trailing whitespace ('    ').

### Anchor
```
    // Configuration
    this.maxConcurrent = config.coordinator?.maxConcurrent || 2;
    this.initialized = false;
```

### Code
```js
    // Configuration
    this.maxConcurrent = config.coordinator?.maxConcurrent || 2;
    // H4: backpressure single source of truth — injected by the Orchestrator
    // after construction (same object instance as orchestrator.backpressure,
    // written by ResourceMonitor). READ ONLY here. Null in standalone/CLI
    // contexts → treated as level 'none'.
    this.backpressure = null;
    this.initialized = false;
```

## CHANGE: cosmo23/engine/src/agents/agent-executor.js

New helper getEffectiveMaxConcurrent(): 'elevated' → ceil(maxConcurrent/2) floor 1; otherwise configured limit. Inserted directly above isApprovedStrategicBypass.

### Anchor
```
  isApprovedStrategicBypass(missionSpec = {}) {
```

### Code
```js
  /**
   * H4: effective concurrency under backpressure.
   * 'elevated' halves the configured limit (ceil, floor 1). 'critical' is a
   * hard no-new-spawns gate enforced separately in spawnAgent(). Saves are
   * NEVER throttled by backpressure — this only shapes agent spawning.
   */
  getEffectiveMaxConcurrent() {
    if (this.backpressure?.level === 'elevated') {
      return Math.max(1, Math.ceil(this.maxConcurrent / 2));
    }
    return this.maxConcurrent;
  }

  isApprovedStrategicBypass(missionSpec = {}) {
```

## CHANGE: cosmo23/engine/src/agents/agent-executor.js

spawnAgent() gate: 'critical' refuses ALL new spawns (strategic bypass included) before any other gate; 'elevated' applies the halved effective limit to the existing concurrency check and to the strategic-bypass log. CRITICAL ANCHOR WARNING: the two apparently-blank lines inside this anchor (after 'const isStrategic ...;' and after the first 'return null;\n    }') each contain EXACTLY four trailing spaces ('    ') — the anchor will not match without them. The replacement intentionally normalizes them to empty lines.

### Anchor
```
    const isStrategic = this.isApprovedStrategicBypass(missionSpec);
    
    // Check concurrency limit (but skip for strategic goals)
    if (!isStrategic && !this.registry.canSpawnMore(this.maxConcurrent)) {
      this.logger.warn('❌ Max concurrent agents reached, cannot spawn', {
        limit: this.maxConcurrent,
        active: this.registry.getActiveCount(),
        missionGoal: missionSpec.goalId
      }, 3);
      return null;
    }
    
    // Log if bypassing limit for strategic goal
    if (isStrategic && this.registry.getActiveCount() >= this.maxConcurrent) {
      this.logger.info('🚨 Spawning strategic agent (bypassing maxConcurrent limit)', {
        active: this.registry.getActiveCount(),
        limit: this.maxConcurrent,
        missionGoal: missionSpec.goalId,
        reason: 'strategic_priority'
      }, 3);
    }
```

### Code
```js
    const isStrategic = this.isApprovedStrategicBypass(missionSpec);

    // H4 backpressure gate — single source of truth (orchestrator.backpressure,
    // written by ResourceMonitor, injected as this.backpressure).
    // 'critical' blocks ALL new spawns, including strategic bypass; agents
    // already running finish normally. State saves are NEVER throttled here —
    // backpressure only shapes nonessential work (new agent spawns).
    const backpressureLevel = this.backpressure?.level || 'none';
    if (backpressureLevel === 'critical') {
      this.logger.warn('🧯 Backpressure CRITICAL — refusing new agent spawn', {
        reasons: this.backpressure?.reasons || [],
        active: this.registry.getActiveCount(),
        isStrategic,
        missionGoal: missionSpec.goalId
      }, 3);
      return null;
    }

    // 'elevated' halves effective concurrency (ceil(maxConcurrent / 2))
    const effectiveMaxConcurrent = this.getEffectiveMaxConcurrent();

    // Check concurrency limit (but skip for strategic goals)
    if (!isStrategic && !this.registry.canSpawnMore(effectiveMaxConcurrent)) {
      this.logger.warn('❌ Max concurrent agents reached, cannot spawn', {
        limit: effectiveMaxConcurrent,
        configuredLimit: this.maxConcurrent,
        backpressure: backpressureLevel,
        active: this.registry.getActiveCount(),
        missionGoal: missionSpec.goalId
      }, 3);
      return null;
    }

    // Log if bypassing limit for strategic goal
    if (isStrategic && this.registry.getActiveCount() >= effectiveMaxConcurrent) {
      this.logger.info('🚨 Spawning strategic agent (bypassing maxConcurrent limit)', {
        active: this.registry.getActiveCount(),
        limit: effectiveMaxConcurrent,
        configuredLimit: this.maxConcurrent,
        backpressure: backpressureLevel,
        missionGoal: missionSpec.goalId,
        reason: 'strategic_priority'
      }, 3);
    }
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

Constructor ('Phase A: Hardening modules' block, ~line 246): alias the monitor-owned backpressure object onto the orchestrator (H4 single source of truth — same object instance, never reassigned) and inject the reference into agentExecutor (assigned earlier at line ~100 from subsystems). CONCURRENCY WARNING: another session is actively editing orchestrator.js (shutdown-deadline work near lines ~488 and ~9280); re-grep this anchor before applying — it was unique and non-overlapping when verified.

### Anchor
```
    this.resourceMonitor = new ResourceMonitor(config, logger);
```

### Code
```js
    this.resourceMonitor = new ResourceMonitor(config, logger);
    // H4: backpressure single source of truth. ResourceMonitor owns the writes;
    // the orchestrator exposes the SAME object instance (alias — never
    // reassigned) and injects the reference into consumers. Saves are never
    // gated on backpressure; only nonessential work (agent spawns) throttles.
    this.backpressure = this.resourceMonitor.backpressure;
    if (this.agentExecutor) {
      this.agentExecutor.backpressure = this.backpressure;
    }
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

start(): begin periodic backpressure evaluation right after the Guardian poller starts (before the while loop).

### Anchor
```
    // Start Guardian control file poller (checks for wake/restart/consolidate commands)
    // Guardian writes these files when it detects COSMO is stuck or needs intervention
    this.startGuardianControlPoller();
```

### Code
```js
    // Start Guardian control file poller (checks for wake/restart/consolidate commands)
    // Guardian writes these files when it detects COSMO is stuck or needs intervention
    this.startGuardianControlPoller();

    // H4: periodic backpressure evaluation (unref'd interval; cycle boundaries
    // also refresh via resourceMonitor.snapshot() at end of executeCycle)
    this.resourceMonitor.startBackpressureMonitor();
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

stop(): clear the interval alongside the other pollers.

### Anchor
```
    // Stop Guardian control file poller
    this.stopGuardianControlPoller();
```

### Code
```js
    // Stop Guardian control file poller
    this.stopGuardianControlPoller();

    // H4: stop periodic backpressure evaluation
    this.resourceMonitor.stopBackpressureMonitor();
```

## CHANGE: cosmo23/engine/src/core/graceful-shutdown-handler.js

cleanup(): stop the backpressure interval (guarded with typeof so older monitors don't throw) and fix the now-stale 'no active timers' comment. CONCURRENCY WARNING: this file is also being edited by the shutdown-budget session (hunks at ~117 and ~164); this anchor at ~308 did not overlap when verified — re-grep before applying.

### Anchor
```
      // Cleanup resource monitor (no active timers, just state)
      if (this.orchestrator.resourceMonitor) {
        this.logger.info('[GracefulShutdown] ResourceMonitor state preserved');
      }
```

### Code
```js
      // Cleanup resource monitor (stop the H4 backpressure interval; stats
      // state itself is preserved)
      if (this.orchestrator.resourceMonitor) {
        if (typeof this.orchestrator.resourceMonitor.stopBackpressureMonitor === 'function') {
          this.orchestrator.resourceMonitor.stopBackpressureMonitor();
        }
        this.logger.info('[GracefulShutdown] ResourceMonitor state preserved');
      }
```

## CHANGE: cosmo23/launcher/config-generator.js

Generated run config: carry the new keys under the existing resources: block (template literal — this exact 4-line text occurs once in the file; the engine defaults match, so older configs without these keys behave identically).

### Anchor
```
resources:
  memoryLimitMB: 1024
  memoryWarningThreshold: 0.8
  cpuWarningThreshold: 0.9
```

### Code
```js
resources:
  memoryLimitMB: 1024
  memoryWarningThreshold: 0.8
  cpuWarningThreshold: 0.9
  rssBudgetMb: 4096
  backpressure:
    intervalMs: 10000
    elevatedEnterPct: 0.70
    elevatedExitPct: 0.60
    criticalEnterPct: 0.85
    criticalExitPct: 0.75
    heapMinTotalMb: 512
```

## CHANGE: cosmo23/engine/src/config.yaml

Local-dev config parity: same resources: block extension (identical 4-line anchor, occurs once in this file too).

### Anchor
```
resources:
  memoryLimitMB: 1024
  memoryWarningThreshold: 0.8
  cpuWarningThreshold: 0.9
```

### Code
```js
resources:
  memoryLimitMB: 1024
  memoryWarningThreshold: 0.8
  cpuWarningThreshold: 0.9
  rssBudgetMb: 4096
  backpressure:
    intervalMs: 10000
    elevatedEnterPct: 0.70
    elevatedExitPct: 0.60
    criticalEnterPct: 0.85
    criticalExitPct: 0.75
    heapMinTotalMb: 512
```

## CHANGE: package.json

Register the new suite in the cosmo23 node --test chain (scripts.test). Insert between graceful-shutdown-honesty and research-run-operation-adapter. Anchor substring occurs exactly once. NOTE: package.json is dirty with other sessions' work — string-anchor edit only, do not reformat.

### Anchor
```
tests/cosmo23/graceful-shutdown-honesty.test.cjs tests/cosmo23/research-run-operation-adapter.test.cjs
```

### Code
```js
tests/cosmo23/graceful-shutdown-honesty.test.cjs tests/cosmo23/resource-backpressure.test.cjs tests/cosmo23/research-run-operation-adapter.test.cjs
```

## CHANGE: tests/cosmo23/package-test-registration.test.cjs

Add the new suite to the exactly-once registration list (file is dirty with other sessions' additions — anchor on the graceful-shutdown-honesty entry, occurs once).

### Anchor
```
    'tests/cosmo23/graceful-shutdown-honesty.test.cjs',
```

### Code
```js
    'tests/cosmo23/graceful-shutdown-honesty.test.cjs',
    'tests/cosmo23/resource-backpressure.test.cjs',
```

## TEST FILE: tests/cosmo23/resource-backpressure.test.cjs

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ResourceMonitor } = require('../../cosmo23/engine/src/core/resource-monitor');
const { AgentExecutor } = require('../../cosmo23/engine/src/agents/agent-executor');
const COSMO_ROOT = path.resolve(__dirname, '../../cosmo23');

const MB = 1024 * 1024;

function captureLogger() {
  const entries = [];
  const push = (level) => (message, detail) => entries.push({ level, message, detail });
  return {
    entries,
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
    levelChanges() {
      return entries.filter((e) => e.message === '[ResourceMonitor] Backpressure level change');
    },
  };
}

function makeMonitor(overrides = {}) {
  const logger = captureLogger();
  const monitor = new ResourceMonitor({
    resources: {
      rssBudgetMb: 1000,
      backpressure: { intervalMs: 10 },
      ...overrides,
    },
  }, logger);
  return { monitor, logger };
}

// Heap-driven reading: heapTotal 1024MB (above the 512MB floor), heapUsed = pct of it.
function heapReading(pct) {
  return { heapUsed: 1024 * pct * MB, heapTotal: 1024 * MB, rss: 100 * MB };
}

// RSS-driven reading: tiny heap (below floor, ignored), rss = mb against the 1000MB budget.
function rssReading(mb) {
  return { heapUsed: 40 * MB, heapTotal: 50 * MB, rss: mb * MB };
}

test('backpressure hysteresis: elevated 70/60, critical 85/75, exit-critical lands in elevated band', () => {
  const { monitor, logger } = makeMonitor();
  assert.equal(monitor.backpressure.level, 'none');

  assert.equal(monitor.evaluateBackpressure(heapReading(0.65)), 'none');
  assert.equal(monitor.evaluateBackpressure(heapReading(0.72)), 'elevated'); // enter at >= 0.70
  assert.equal(monitor.evaluateBackpressure(heapReading(0.64)), 'elevated'); // hysteresis: no exit until < 0.60
  assert.equal(monitor.evaluateBackpressure(heapReading(0.59)), 'none');     // exit below 0.60
  assert.equal(monitor.evaluateBackpressure(heapReading(0.86)), 'critical'); // enter at >= 0.85
  assert.equal(monitor.evaluateBackpressure(heapReading(0.80)), 'critical'); // hysteresis: no exit until < 0.75
  assert.equal(monitor.evaluateBackpressure(heapReading(0.74)), 'elevated'); // exits critical INTO elevated
  assert.equal(monitor.evaluateBackpressure(heapReading(0.55)), 'none');     // clears elevated exit too

  // Loud logs on level change ONLY: none->elevated, elevated->none, none->critical,
  // critical->elevated, elevated->none = 5 changes for 8 evaluations.
  assert.equal(logger.levelChanges().length, 5);
});

test('rss vs rssBudgetMb drives backpressure even when heap is below the floor', () => {
  const { monitor } = makeMonitor();
  assert.equal(monitor.evaluateBackpressure(rssReading(500)), 'none');      // 50% of budget
  assert.equal(monitor.evaluateBackpressure(rssReading(720)), 'elevated');  // 72%
  assert.equal(monitor.evaluateBackpressure(rssReading(880)), 'critical');  // 88%
  assert.equal(monitor.evaluateBackpressure(rssReading(760)), 'critical');  // 76% — still >= exit 75%
  assert.equal(monitor.evaluateBackpressure(rssReading(740)), 'elevated');  // exits critical
  assert.equal(monitor.evaluateBackpressure(rssReading(100)), 'none');
});

test('heap fraction is ignored below heapMinTotalMb floor (tiny heaps do not flap)', () => {
  const { monitor } = makeMonitor();
  // 90% of a 100MB heapTotal, rss well under budget → none
  const level = monitor.evaluateBackpressure({ heapUsed: 90 * MB, heapTotal: 100 * MB, rss: 100 * MB });
  assert.equal(level, 'none');
});

test('backpressure object identity is preserved across transitions (H4 mutate-in-place)', () => {
  const { monitor } = makeMonitor();
  const ref = monitor.backpressure;
  monitor.evaluateBackpressure(heapReading(0.90));
  assert.equal(monitor.backpressure, ref);
  assert.equal(ref.level, 'critical');
  assert.ok(ref.reasons.length > 0);
  monitor.evaluateBackpressure(heapReading(0.10));
  assert.equal(monitor.backpressure, ref);
  assert.equal(ref.level, 'none');
  assert.deepEqual(ref.reasons, []);
  monitor.reset();
  assert.equal(monitor.backpressure, ref);
});

test('snapshot() refreshes backpressure with the live memory reading', () => {
  const { monitor } = makeMonitor();
  const calls = [];
  monitor.evaluateBackpressure = (reading) => { calls.push(reading); return 'none'; };
  monitor.snapshot();
  assert.equal(calls.length, 1);
  assert.equal(typeof calls[0].heapUsed, 'number');
  assert.equal(typeof calls[0].heapTotal, 'number');
  assert.equal(typeof calls[0].rss, 'number');
});

test('startBackpressureMonitor ticks on the configured interval, is idempotent, and stop clears it', async () => {
  const { monitor } = makeMonitor();
  let ticks = 0;
  monitor.evaluateBackpressure = () => { ticks += 1; return 'none'; };
  monitor.startBackpressureMonitor();
  const timer = monitor._bpTimer;
  assert.ok(timer);
  monitor.startBackpressureMonitor(); // idempotent — same timer
  assert.equal(monitor._bpTimer, timer);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.ok(ticks >= 1, `expected at least one tick, got ${ticks}`);
  monitor.stopBackpressureMonitor();
  assert.equal(monitor._bpTimer, null);
  const after = ticks;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(ticks, after); // no ticks after stop
});

test('getStats() surfaces the current backpressure level and reasons', () => {
  const { monitor } = makeMonitor();
  monitor.evaluateBackpressure(heapReading(0.90));
  const stats = monitor.getStats();
  assert.equal(stats.backpressure.level, 'critical');
  assert.ok(Array.isArray(stats.backpressure.reasons));
  assert.ok(stats.backpressure.reasons.length > 0);
});

// ---------------------------------------------------------------------------
// AgentExecutor spawn-gate behavior — real prototype methods on a minimal fake
// ---------------------------------------------------------------------------

function makeExecutorFake({ backpressure, maxConcurrent = 4, activeCount = 2 } = {}) {
  const fake = Object.create(AgentExecutor.prototype);
  fake.initialized = true;
  fake.maxConcurrent = maxConcurrent;
  fake.backpressure = backpressure ?? null;
  fake.logger = captureLogger();
  fake.gateCalls = { isGoalBeingPursued: 0 };
  fake.registry = {
    getActiveCount: () => activeCount,
    canSpawnMore: (limit) => activeCount < limit,
    isGoalBeingPursued: () => {
      fake.gateCalls.isGoalBeingPursued += 1;
      return true; // controlled stop: gate passed, spawn halts here deterministically
    },
  };
  return fake;
}

const MISSION = { goalId: 'goal-bp-1', agentType: 'research', description: 'backpressure gate test' };
const STRATEGIC_MISSION = {
  goalId: 'goal-bp-2',
  agentType: 'research',
  description: 'strategic under critical',
  triggerSource: 'system_repair',
  metadata: { systemRepair: true, urgentGoal: true, strategicPriority: true },
};

test('critical backpressure blocks new spawns before any other gate', async () => {
  const fake = makeExecutorFake({ backpressure: { level: 'critical', reasons: ['rss 880MB / 1000MB'] } });
  const result = await AgentExecutor.prototype.spawnAgent.call(fake, { ...MISSION });
  assert.equal(result, null);
  assert.equal(fake.gateCalls.isGoalBeingPursued, 0); // never reached the registry gates
  const warn = fake.logger.entries.find((e) => e.message.includes('Backpressure CRITICAL'));
  assert.ok(warn, 'expected a loud CRITICAL refusal log');
  assert.deepEqual(warn.detail.reasons, ['rss 880MB / 1000MB']);
});

test('critical backpressure blocks strategic-bypass spawns too', async () => {
  const fake = makeExecutorFake({ backpressure: { level: 'critical', reasons: [] } });
  assert.equal(AgentExecutor.prototype.isApprovedStrategicBypass.call(fake, STRATEGIC_MISSION), true);
  const result = await AgentExecutor.prototype.spawnAgent.call(fake, { ...STRATEGIC_MISSION });
  assert.equal(result, null);
  const warn = fake.logger.entries.find((e) => e.message.includes('Backpressure CRITICAL'));
  assert.ok(warn);
  assert.equal(warn.detail.isStrategic, true);
});

test('elevated backpressure halves effective concurrency: ceil(4/2)=2 blocks at 2 active', async () => {
  const fake = makeExecutorFake({
    backpressure: { level: 'elevated', reasons: ['heap 72.0%'] },
    maxConcurrent: 4,
    activeCount: 2,
  });
  const result = await AgentExecutor.prototype.spawnAgent.call(fake, { ...MISSION });
  assert.equal(result, null);
  assert.equal(fake.gateCalls.isGoalBeingPursued, 0);
  const warn = fake.logger.entries.find((e) => e.message.includes('Max concurrent agents reached'));
  assert.ok(warn, 'expected the concurrency refusal log');
  assert.equal(warn.detail.limit, 2);
  assert.equal(warn.detail.configuredLimit, 4);
  assert.equal(warn.detail.backpressure, 'elevated');
});

test('same load with level none passes the concurrency gate (proves elevated did the blocking)', async () => {
  const fake = makeExecutorFake({
    backpressure: { level: 'none', reasons: [] },
    maxConcurrent: 4,
    activeCount: 2,
  });
  const result = await AgentExecutor.prototype.spawnAgent.call(fake, { ...MISSION });
  assert.equal(result, null); // halted by the controlled isGoalBeingPursued stop
  assert.equal(fake.gateCalls.isGoalBeingPursued, 1); // gate was passed
});

test('null backpressure reference (standalone/CLI) behaves as level none', async () => {
  const fake = makeExecutorFake({ backpressure: null, maxConcurrent: 4, activeCount: 2 });
  const result = await AgentExecutor.prototype.spawnAgent.call(fake, { ...MISSION });
  assert.equal(result, null);
  assert.equal(fake.gateCalls.isGoalBeingPursued, 1);
});

test('getEffectiveMaxConcurrent: none/critical keep configured limit, elevated halves with ceil and floor 1', () => {
  const eff = (level, maxConcurrent) => AgentExecutor.prototype.getEffectiveMaxConcurrent.call({
    backpressure: level ? { level, reasons: [] } : null,
    maxConcurrent,
  });
  assert.equal(eff('none', 4), 4);
  assert.equal(eff(null, 4), 4);
  assert.equal(eff('critical', 4), 4); // critical is a hard spawn gate, not a limit change
  assert.equal(eff('elevated', 4), 2);
  assert.equal(eff('elevated', 5), 3); // ceil(2.5)
  assert.equal(eff('elevated', 1), 1); // floor 1
});

test('end-to-end: monitor writes, aliased object read by executor gate (H4 composition)', async () => {
  const { monitor } = makeMonitor();
  // Orchestrator wiring: alias the SAME object instance into the executor
  const fake = makeExecutorFake({ maxConcurrent: 4, activeCount: 2 });
  fake.backpressure = monitor.backpressure;

  monitor.evaluateBackpressure(heapReading(0.90)); // → critical
  let result = await AgentExecutor.prototype.spawnAgent.call(fake, { ...MISSION });
  assert.equal(result, null);
  assert.equal(fake.gateCalls.isGoalBeingPursued, 0);

  monitoredRecovery: {
    monitor.evaluateBackpressure(heapReading(0.10)); // → none (same object, no re-injection)
    result = await AgentExecutor.prototype.spawnAgent.call(fake, { ...MISSION });
    assert.equal(result, null);
    assert.equal(fake.gateCalls.isGoalBeingPursued, 1); // gate now passes
  }
});

test('wiring source contract: orchestrator aliases and starts/stops the monitor; saves are not gated', () => {
  const orchestratorSrc = fs.readFileSync(
    path.join(COSMO_ROOT, 'engine/src/core/orchestrator.js'),
    'utf8',
  );
  assert.ok(orchestratorSrc.includes('this.backpressure = this.resourceMonitor.backpressure;'),
    'orchestrator must alias the monitor-owned backpressure object');
  assert.ok(orchestratorSrc.includes('this.agentExecutor.backpressure = this.backpressure;'),
    'orchestrator must inject the shared reference into the agent executor');
  assert.ok(orchestratorSrc.includes('this.resourceMonitor.startBackpressureMonitor();'),
    'orchestrator start() must start the periodic evaluator');
  assert.ok(orchestratorSrc.includes('this.resourceMonitor.stopBackpressureMonitor();'),
    'orchestrator stop() must stop the periodic evaluator');
  const shutdownSrc = fs.readFileSync(
    path.join(COSMO_ROOT, 'engine/src/core/graceful-shutdown-handler.js'),
    'utf8',
  );
  assert.ok(shutdownSrc.includes('stopBackpressureMonitor'),
    'graceful shutdown must stop the backpressure interval');
  // H4 sacred saves: the save path must never consult backpressure
  const compressionSrc = fs.readFileSync(
    path.join(COSMO_ROOT, 'engine/src/core/state-compression.js'),
    'utf8',
  );
  assert.ok(!compressionSrc.includes('backpressure'),
    'state-compression (save path) must not consult backpressure');
});

```

## API NOTES

VALIDATED LIVE, THEN FULLY REVERTED: I temporarily applied every engine change to the real tree, ran the proposed suite (15/15 pass) plus adjacent existing suites tests/cosmo23/agent-executor-memory-context.test.cjs + graceful-shutdown-honesty.test.cjs + crash-recovery-scalar-checkpoints.test.cjs (28/28 pass, INCLUDING the concurrent session's new shutdown-budget tests — the fixes compose), then reverted every edit surgically. resource-monitor.js and agent-executor.js hash-match their pre-edit state (shasum verified); orchestrator.js and graceful-shutdown-handler.js now contain zero backpressure markers and only the other session's work. The validation test copy (absolute requires) is at /private/tmp/claude-501/-Users-jtr--JTR23--release-home23/a403bbd0-d1fd-461a-91bc-9cc077611c0c/scratchpad/resource-backpressure.validate.test.cjs; pre-edit file copies at .../scratchpad/fix23-backup/.

DESIGN DECISIONS + DONOR/TARGET NOTES:
1. Ownership vs H4 wording: H4 says the object lives on the orchestrator; here the ResourceMonitor CREATES {level,reasons} and the orchestrator ALIASES it (`this.backpressure = this.resourceMonitor.backpressure`). Same object instance everywhere (orchestrator === monitor === agentExecutor reference), monitor is sole writer, all writes mutate in place. Chosen because the monitor must work when constructed standalone and because injection into agentExecutor happens in the Orchestrator constructor — agentExecutor is built in engine/src/index.js (lines 413/1065) and worker/orchestrator-worker.js (line 286) and passed as subsystems.agentExecutor (orchestrator.js:100), so constructor-time injection covers all three construction sites with one edit.
2. Config key naming: the fix brief said `resourceLimits.rssBudgetMb`, but cosmo23's native section is `resources:` (config-generator.js:644, engine/src/config.yaml:278). The code reads `config.resources?.rssBudgetMb ?? config.resourceLimits?.rssBudgetMb ?? 4096` so both spellings work; the generated config carries `resources.rssBudgetMb`.
3. rssBudgetMb default 4096: launcher/process-manager.js:279 spawns the engine with NO --max-old-space-size and no NODE_OPTIONS override → default V8 old-space (~4GB on 64-bit). RSS is the stable pressure signal.
4. heapMinTotalMb floor (512, config resources.backpressure.heapMinTotalMb): heapUsed/heapTotal is contractually required but is noisy — V8 keeps heapTotal close to usage, so a healthy 60MB heap can read 85%+. Below the floor the heap term contributes 0; RSS-vs-budget always counts. Without this, small runs would flap into false 'critical' and block all spawns. Pressure = max(heapFraction, rssFraction).
5. Hysteresis is a two-flag state machine (critical implies elevated): exiting critical at e.g. 74% lands in 'elevated', not 'none'; validated in tests. Enter/exit: elevated 70/60, critical 85/75 (config: resources.backpressure.{elevated,critical}{Enter,Exit}Pct). Logs fire on level CHANGE only (warn entering elevated/critical, info returning to none).
6. Enforcement point: spawnAgent() is the single choke point (25 non-test call sites all funnel through it). 'critical' blocks ALL new spawns including the strategic/system-repair bypass — H4 carves out no exception, and spawning anything under critical memory pressure worsens the OOM it is defending against; the refusal log carries isStrategic so operators can see suppressed repairs. 'elevated' → effectiveMaxConcurrent = max(1, ceil(maxConcurrent/2)) applied to the existing canSpawnMore check; strategic bypass still bypasses the LIMIT under elevated (unchanged semantics, now logged with configuredLimit + backpressure level).
7. Saves are sacred (H4): zero changes to saveState/persistResearchState/state-compression; the new suite pins this with a source assertion that state-compression.js never mentions backpressure. Backpressure gates ONLY new agent spawns.
8. Composition with other Phase 2 fixes: the interval is unref'd (never holds the process open — same rule the H1 heartbeat timer follows); getStats() now carries backpressure{level,reasons} additively so the H2 status contract can surface it for free; enforcement is read-side via the shared object so the H3 watchdog can also read orchestrator.backpressure without new wiring.
9. CONCURRENCY (critical for the implementer): orchestrator.js and graceful-shutdown-handler.js are being ACTIVELY edited by another session (shutdown-deadline budget work; during my session those files changed on disk twice, including one restore that transiently resurrected my temp edits — I stripped them again and verified 0 markers). Re-grep every anchor immediately before applying; all anchors were unique in the tree as of this session's end and none overlap the other session's hunks (theirs: ~117/~164 in the handler, ~488/~8160/~9280 in orchestrator; mine: ~246/~943/~9333 and ~308). Never git-stash or checkout these files.
10. Anchor whitespace traps (agent-executor.js only): the spawnAgent anchor contains two lines that are exactly four spaces ('    ') — after `const isStrategic ...;` and after the first `return null;\n    }`. The constructor anchor must STOP at `this.initialized = false;` because the next line is also '    '. All other files' anchors verified trailing-whitespace-free via sed -n l.
11. Tests use Object.create(AgentExecutor.prototype) fakes so the REAL spawnAgent/getEffectiveMaxConcurrent/isApprovedStrategicBypass execute; registry.isGoalBeingPursued returning true is the deterministic post-gate stop, letting the same fixture prove both 'blocked by backpressure' (gate counter 0) and 'passed under none' (counter 1). The interval test uses a 10ms interval + 120ms wait — validated non-flaky but it is timing-based; if it ever flakes in CI, raise the wait, not the interval.
12. Dashboard/status consumers of getStats() get the new backpressure field additively (JSON, no schema enforcement server-side — checked brain-operation-routes.js usage is unrelated).
