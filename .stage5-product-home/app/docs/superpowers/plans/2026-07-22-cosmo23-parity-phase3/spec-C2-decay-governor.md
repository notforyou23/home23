# cosmo23 memory hygiene — research-timescale GC criteria (config-gated, default OFF) + MemoryGovernor enforcement mode (opt-in, bounded, ledger-logged, save-interlocked)

## Target current state

WHAT THE CONFIG SAYS vs WHAT ACTUALLY RUNS (reconciled by reading, all paths verified in current tree):

1) Decay (cosmo23/engine/src/memory/network-memory.js applyDecay, lines 2306-2360): run config.yaml carries architecture.memory.decay = { function: exponential, baseFactor: 0.995, minimumWeight: 0.1, decayInterval: 3600, exemptTags: [agent_insight, agent_finding, mission_plan, cross_agent_pattern, execution_result, execution_failure, capability_gap, disconfirmation] } (engine/src/config.yaml lines 61-73; run configs identical). What runs: orchestrator wake maintenance every 30 cycles (orchestrator.js line 3624-3627) calls applyDecay(); nodes NOT in exemptTags and untouched > 3600s get weight *= 0.995 under withPersistenceBarrier. minimumWeight 0.1 is NOT a decay floor and NOT a GC threshold — it is only read by getStats() to count "activeNodes". Weights decay toward 0 unboundedly. Edge decay: edges idle > 7200s get weight *= hebbian.weakenFactor (0.05) — a 95% cut per pass, almost certainly an intended (1 - weakenFactor) bug; NOT changed by this fix (behavior pin), flagged in apiNotes.

2) GC (cosmo23/engine/src/memory/summarizer.js garbageCollect, lines 418-510): signature (memoryNetwork, minWeight = 0.01, minAccessAgeDays = 730). Called with NO ARGS at both sites — orchestrator.js line 3632 (wake, every 30 cycles) and line 4184 (dream cleanup) — so the config decay block has ZERO influence on GC and the 730-day gate means GC never fires on research runs that live hours-to-weeks. Removal criteria today: NOT consolidatedAt, NOT merged/inherited (sourceRuns || mergedAt || inheritedArtifact || domain !== 'unknown'), tag NOT in a hardcoded 18-tag protected set (agent_insight, agent_finding, mission_plan, cross_agent_pattern, consolidated, breakthrough, synthesis, goal, milestone, research, analysis, important, core, foundation, execution_result, execution_failure, capability_gap, disconfirmation — a strict superset of the 8 config exemptTags), AND weight < 0.01 AND untouched > 730d. Removal goes through memoryNetwork.removeNodes(toRemove) — barrier-wrapped (_removeNodeUnsafe, network-memory.js 1147-1172): deletes node, cascades edge deletion, prunes cluster membership, and records deletedNodeIds/deletedEdgeKeys tombstones + advances persistenceGeneration for the manifest/delta protocol. The in-code comment "180+ days" is stale (default is 730).

3) MemoryGovernor (cosmo23/engine/src/system/memory-governor.js, 125 lines, read fully): constructed with the FULL config (orchestrator.js 847-851); reads config.memoryGovernance { enabled: true, applyPruning: false, decayHalfLifeCycles: 200, pruneThreshold: 0.1, maxNodesConsidered: 200 } (config.yaml 349-355). Advisory evaluate() runs in executeCycle phase 6, every 20 cycles, gated on memoryGovernance.enabled (orchestrator.js 1911-1917). CRITICAL FINDING: registerNode()/touchNode() have ZERO callers anywhere in engine/src — the governor's private nodeIndex registry is never populated, so evaluate() early-returns on `!this.nodeIndex.size` every time. The advisory path is permanently inert, and even flipping the legacy memoryGovernance.applyPruning to true would prune NOTHING (no candidates ever exist). Today's "prune" branch (lines 100-118) would call this.memory.removeNode(id) per candidate — the same underlying _removeNodeUnsafe path GC's batch removeNodes uses — with NO protected-tag check, NO batch bound beyond the 200-node scan, NO ledger event. Also: the maxNodesConsidered bound has an off-by-one (`count++ > max` breaks after max+1 entries) — irrelevant while the registry is empty; left byte-identical per the off-gate pin.

4) Save/prune interlock (analyzed honestly, as asked): saveState() (orchestrator.js 8480-8492) join-guards concurrent saves via this._saveStatePromise. The graph capture is SYNCHRONOUS: _saveStateUnlocked builds state with this.memory.exportGraph() (sync, network-memory.js 2420-2465), and persistResearchState() deliberately captures before its first await (lib/memory-sidecar.js 166-183: "capture deliberately happens before this async function's first await so a writer wait cannot blend two live graph generations"). Phase 6 runs synchronously earlier in the same executeCycle that later awaits saveState(), and the previous cycle awaited its own save — so _saveStatePromise is normally null at phase 6. CONCLUSION: a synchronous governor prune can NEVER interleave inside the synchronous capture (single-threaded event loop); a torn save from phase-6 mutation is impossible as long as enforcement stays synchronous (the persistence barrier already throws on async callbacks and reentry). If an out-of-band save (shutdown join via saveStateForShutdown, consolidation path) is in its ASYNC write window when phase 6 fires, the captured generation is already complete and immutable; a prune during that window lands in deletedNodeIds and advances persistenceGeneration, so markPersistenceCleanIfGeneration (network-memory.js 1504-1513) refuses to clear dirty tracking for the older generation and the NEXT save carries the deletions — no tear. The design therefore (a) pins enforce() as synchronous-by-contract, and (b) adds a belt-and-suspenders saveInFlight stand-down (skip + ledger event when this._saveStatePromise is non-null), honoring "never runs during an active save" literally at near-zero cost.

5) Test registration surfaces: package.json test chain and tests/cosmo23/package-test-registration.test.cjs both carry FOREIGN UNCOMMITTED HUNKS from concurrent sessions (git status: both M; e.g. model-catalog/memory-sidecar-streamed-capture churn observed mid-session). Anchors below were re-verified unique against the CURRENT tree at proposal time; implementer must stage surgically (git add -p), never whole-file.

## CHANGE: cosmo23/engine/src/memory/gc-policy.js

NEW FILE. Shared memory-hygiene policy module: canonical 18-tag protected set (single source of truth for GC + governor enforcement), legacy vs research GC criteria resolution (memory.gc gate, default OFF returns today's 0.01/730 bit-for-bit), governor enforcement gate resolution (memory.governor.applyPruning default FALSE, maxPrunesPerEval default 50 clamped 1..1000), fail-closed protection check, and bounded live-graph candidate selection. Pure and synchronous by design — the no-torn-save argument depends on it. Create with exactly this content.

### Code
```js
// src/memory/gc-policy.js
/**
 * Shared memory-hygiene policy (Fix 3.2).
 *
 * ONE source of truth for:
 *  - the protected-tag set that GC and MemoryGovernor enforcement must never
 *    touch (execution_result / execution_failure and friends — the same set
 *    MemorySummarizer.garbageCollect has always used);
 *  - GC criteria resolution: legacy ultra-conservative criteria
 *    (weight < 0.01 AND untouched 730+ days) unless the run opts into
 *    research-lifetime criteria via memory.gc.enabled;
 *  - MemoryGovernor enforcement gating (memory.governor.applyPruning,
 *    default OFF) and its bounded batch size;
 *  - candidate selection over a LIVE NetworkMemory graph, fail-closed on
 *    malformed weight/accessed fields.
 *
 * Everything here is pure and synchronous — callers on the cycle path rely on
 * that: a synchronous prune can never interleave with the synchronous
 * exportGraph()/captureResearchState() save capture.
 */
'use strict';

// Canonical protected-tag set. Byte-identical to the inline set that lived in
// MemorySummarizer.garbageCollect — summarizer.js now imports it from here so
// GC and governor enforcement can never drift apart. NEVER remove
// execution_result / execution_failure (cosmo23 convention: protected from
// decay and from every destructive hygiene action).
const GC_PROTECTED_TAGS = new Set([
  'agent_insight', 'agent_finding', 'mission_plan', 'cross_agent_pattern',
  'consolidated', 'breakthrough', 'synthesis', 'goal', 'milestone',
  'research', 'analysis', 'important', 'core', 'foundation',
  'execution_result', 'execution_failure', 'capability_gap', 'disconfirmation'
]);

// Today's shipped GC behavior — summarizer.garbageCollect's default params.
const LEGACY_GC_CRITERIA = Object.freeze({
  enabled: false,
  minWeight: 0.01,
  maxAgeDays: 730,
});

const RESEARCH_GC_MAX_AGE_DAYS_DEFAULT = 14;
const GOVERNOR_MAX_PRUNES_PER_EVAL_DEFAULT = 50;
const GOVERNOR_MAX_PRUNES_PER_EVAL_CEILING = 1000;

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Research-lifetime GC criteria (runs live hours-to-weeks, not years):
 *   weight < minWeight (default architecture.memory.decay.minimumWeight, the
 *   config value that historically influenced nothing at GC time) AND
 *   untouched > maxAgeDays (default 14). Both overridable under memory.gc.
 */
function resolveResearchGcCriteria(fullConfig = {}) {
  const gcCfg = fullConfig?.memory?.gc || {};
  const decayCfg = fullConfig?.architecture?.memory?.decay || {};
  const minWeight = finitePositive(gcCfg.minWeight)
    ?? finitePositive(decayCfg.minimumWeight)
    ?? 0.1;
  const maxAgeDays = finitePositive(gcCfg.maxAgeDays) ?? RESEARCH_GC_MAX_AGE_DAYS_DEFAULT;
  return Object.freeze({ enabled: true, minWeight, maxAgeDays });
}

/**
 * Criteria for the scheduled summarizer GC call sites. Config-gated
 * (memory.gc.enabled, default OFF): while the gate is off this returns the
 * exact defaults garbageCollect has always used, so fresh runs and all
 * current production brains keep today's behavior bit-for-bit.
 */
function resolveGcCriteria(fullConfig = {}) {
  if (fullConfig?.memory?.gc?.enabled !== true) return LEGACY_GC_CRITERIA;
  return resolveResearchGcCriteria(fullConfig);
}

/**
 * MemoryGovernor enforcement gate. applyPruning defaults FALSE — enforcement
 * is opt-in. The legacy memoryGovernance.applyPruning knob is NOT consulted
 * here on purpose: it gates the legacy registry-based advisory path, which
 * stays untouched (and inert — nothing ever calls registerNode).
 */
function resolveGovernorEnforcement(fullConfig = {}) {
  const govCfg = fullConfig?.memory?.governor || {};
  const applyPruning = govCfg.applyPruning === true;
  const rawBatch = Number(govCfg.maxPrunesPerEval);
  const maxPrunesPerEval = Number.isSafeInteger(rawBatch) && rawBatch > 0
    ? Math.min(rawBatch, GOVERNOR_MAX_PRUNES_PER_EVAL_CEILING)
    : GOVERNOR_MAX_PRUNES_PER_EVAL_DEFAULT;
  return Object.freeze({ applyPruning, maxPrunesPerEval });
}

/**
 * Protection check for one live graph node. Mirrors the skip ladder in
 * MemorySummarizer.garbageCollect: consolidated, merged/inherited, protected
 * tag. `extraExemptTags` unions in the run's architecture.memory.decay
 * exemptTags so custom user exemptions are honored by enforcement too.
 * Fail-closed: a malformed node is treated as protected.
 */
function isGcProtectedNode(node, extraExemptTags = null) {
  if (!node || typeof node !== 'object') return true;
  if (node.consolidatedAt) return true;
  if (node.sourceRuns || node.mergedAt || node.inheritedArtifact
      || (node.domain && node.domain !== 'unknown')) {
    return true;
  }
  if (node.tag) {
    if (GC_PROTECTED_TAGS.has(node.tag)) return true;
    if (extraExemptTags) {
      if (Array.isArray(extraExemptTags) && extraExemptTags.includes(node.tag)) return true;
      if (typeof extraExemptTags.has === 'function' && extraExemptTags.has(node.tag)) return true;
    }
  }
  return false;
}

/**
 * Select GC candidates from a live NetworkMemory graph.
 * Criteria: NOT protected AND weight < criteria.minWeight AND untouched for
 * more than criteria.maxAgeDays. Bounded by options.limit.
 *
 * Fail-closed divergences from summarizer.garbageCollect (deliberate — this
 * path feeds ENFORCEMENT, the summarizer path keeps its historical
 * semantics): a NaN weight or unparseable accessed timestamp SKIPS the node
 * here, whereas the summarizer's NaN comparisons fall through to removal.
 */
function selectGcCandidates(memoryNetwork, criteria, options = {}) {
  const nodes = memoryNetwork?.nodes;
  if (!nodes || typeof nodes.entries !== 'function') return [];
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0
    ? options.limit
    : Infinity;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const maxAgeMs = criteria.maxAgeDays * 24 * 60 * 60 * 1000;
  const extraExemptTags = options.extraExemptTags || null;

  const candidates = [];
  for (const [id, node] of nodes.entries()) {
    if (candidates.length >= limit) break;
    if (isGcProtectedNode(node, extraExemptTags)) continue;
    const weight = Number(node.weight);
    if (!(weight < criteria.minWeight)) continue; // NaN weight → skip (fail-closed)
    const accessedTime = node.accessed instanceof Date
      ? node.accessed.getTime()
      : (node.accessed ? new Date(node.accessed).getTime() : now);
    if (!Number.isFinite(accessedTime)) continue; // unparseable → skip (fail-closed)
    if ((now - accessedTime) <= maxAgeMs) continue;
    candidates.push(id);
  }
  return candidates;
}

module.exports = {
  GC_PROTECTED_TAGS,
  LEGACY_GC_CRITERIA,
  RESEARCH_GC_MAX_AGE_DAYS_DEFAULT,
  GOVERNOR_MAX_PRUNES_PER_EVAL_DEFAULT,
  resolveResearchGcCriteria,
  resolveGcCriteria,
  resolveGovernorEnforcement,
  isGcProtectedNode,
  selectGcCandidates,
};

```

## CHANGE: cosmo23/engine/src/memory/summarizer.js

Edit A of B — add the gc-policy import. Replace the anchor line (line 1, grep-unique) with the two-line version. No trailing whitespace in anchor.

### Anchor
```
const { UnifiedClient } = require('../core/unified-client');
```

### Code
```js
const { UnifiedClient } = require('../core/unified-client');
const { GC_PROTECTED_TAGS } = require('./gc-policy');
```

## CHANGE: cosmo23/engine/src/memory/summarizer.js

Edit B of B — swap the inline protected-tag set (garbageCollect, lines 423-429) for the shared canonical set. Contents are byte-identical, so garbageCollect behavior is unchanged (pinned by the existing engine mocha suite memory-summarizer-mutation-api.test.js, re-run green 5/5 against this edit). Anchor is the full 7-line block, grep-unique, 4-space indent on line 1 and 6-space on tag lines, no trailing whitespace.

### Anchor
```
    // Protected tags that should NEVER be garbage collected
    const protectedTags = new Set([
      'agent_insight', 'agent_finding', 'mission_plan', 'cross_agent_pattern',
      'consolidated', 'breakthrough', 'synthesis', 'goal', 'milestone',
      'research', 'analysis', 'important', 'core', 'foundation',
      'execution_result', 'execution_failure', 'capability_gap', 'disconfirmation'
    ]);
```

### Code
```js
    // Protected tags that should NEVER be garbage collected — canonical set
    // shared with MemoryGovernor enforcement (see ./gc-policy.js). Contents
    // are byte-identical to the inline set that used to live here.
    const protectedTags = GC_PROTECTED_TAGS;
```

## CHANGE: cosmo23/engine/src/system/memory-governor.js

Edit A of B — add gc-policy imports above the class. Anchor `class MemoryGovernor {` is grep-unique (the file has no requires today; the block comment ends on the line above).

### Anchor
```
class MemoryGovernor {
```

### Code
```js
const {
  resolveResearchGcCriteria,
  resolveGovernorEnforcement,
  selectGcCandidates,
} = require('../memory/gc-policy');

class MemoryGovernor {
```

## CHANGE: cosmo23/engine/src/system/memory-governor.js

Edit B of B — add the enforce() method after evaluate(). The legacy evaluate()/applyPruning path is left byte-identical (off-gate pin; it is inert anyway — nodeIndex is never populated). enforce() selects candidates from the LIVE graph with the shared research-lifetime criteria + full protected set + decay.exemptTags union, bounded per eval, and removes through this.memory.removeNodes() — the exact barrier-wrapped path summarizer GC uses, so edges/clusters stay consistent and deletions are delta-tombstoned. Synchronous by contract. Anchor is the end of evaluate() + class close (grep-unique: `return { pruneCandidates: candidates };` occurs once), no trailing whitespace.

### Anchor
```
    return { pruneCandidates: candidates };
  }
}
```

### Code
```js
    return { pruneCandidates: candidates };
  }

  /**
   * ENFORCEMENT (Fix 3.2) — opt-in via memory.governor.applyPruning
   * (default FALSE; the orchestrator gates the call on the same flag).
   *
   * Unlike the legacy advisory path above — which reads this.nodeIndex, a
   * private registry nothing in the engine ever populates (registerNode /
   * touchNode have no callers), making it permanently inert — enforcement
   * selects candidates from the LIVE graph using the shared research-lifetime
   * GC criteria (weight < minWeight AND untouched > maxAgeDays), with the
   * full protected-tag set plus the run's decay.exemptTags exempt, and
   * removes at most maxPrunesPerEval nodes per evaluation through
   * NetworkMemory.removeNodes() — the exact same barrier-wrapped removal
   * path summarizer.garbageCollect uses, so edges and clusters stay
   * consistent and deletions land in the delta tombstone sets
   * (deletedNodeIds/deletedEdgeKeys) for the manifest writer.
   *
   * SYNCHRONOUS BY CONTRACT: this method must never await. The cycle loop
   * serializes phase 6 with the end-of-cycle save capture, and a synchronous
   * prune cannot interleave with the synchronous exportGraph()/
   * captureResearchState() snapshot. `options.saveInFlight` additionally
   * stands enforcement down while an out-of-band save's async write window
   * is open (shutdown joins an in-flight save, etc.).
   *
   * @param {number} cycle - Current cycle number
   * @param {Object} options - { saveInFlight?: boolean, now?: number }
   * @returns {Object} result — { applied, skipped?, removedNodes,
   *   removedEdges, candidateCount, batchLimit, criteria, nodeIds }
   */
  enforce(cycle, options = {}) {
    const enforcement = resolveGovernorEnforcement(this.config);
    const base = {
      applied: false,
      removedNodes: 0,
      removedEdges: 0,
      candidateCount: 0,
      batchLimit: enforcement.maxPrunesPerEval,
      criteria: null,
      nodeIds: [],
    };
    if (!enforcement.applyPruning) {
      return { ...base, skipped: 'not_armed' };
    }
    if (options.saveInFlight) {
      this.logger.info('🧹 MemoryGovernor: enforcement skipped — save in flight', 3);
      return { ...base, skipped: 'save_in_flight' };
    }
    if (!this.memory || typeof this.memory.removeNodes !== 'function') {
      this.logger.warn('MemoryGovernor: enforcement skipped — memory removeNodes API missing');
      return { ...base, skipped: 'memory_remove_api_missing' };
    }

    const criteria = resolveResearchGcCriteria(this.config);
    const exemptTags = this.config?.architecture?.memory?.decay?.exemptTags || null;
    const candidates = selectGcCandidates(this.memory, criteria, {
      limit: enforcement.maxPrunesPerEval,
      extraExemptTags: exemptTags,
      now: options.now,
    });
    if (candidates.length === 0) {
      return { ...base, applied: true, criteria };
    }

    const removal = this.memory.removeNodes(candidates);
    const removedNodes = removal?.removedNodes || 0;
    const removedEdges = removal?.removedEdges || 0;
    this.logger.info(
      `🧹 MemoryGovernor: enforced prune — ${removedNodes} nodes, ${removedEdges} edges `
      + `(batch limit ${enforcement.maxPrunesPerEval}, weight < ${criteria.minWeight}, `
      + `untouched > ${criteria.maxAgeDays}d, cycle ${cycle})`,
      3
    );
    return {
      ...base,
      applied: true,
      removedNodes,
      removedEdges,
      candidateCount: candidates.length,
      criteria,
      nodeIds: candidates.slice(0, 20),
    };
  }
}
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

Edit A of D — import the policy resolvers next to the MemoryGovernor require (line 28, grep-unique).

### Anchor
```
const { MemoryGovernor } = require('../system/memory-governor');
```

### Code
```js
const { MemoryGovernor } = require('../system/memory-governor');
const { resolveGcCriteria, resolveGovernorEnforcement } = require('../memory/gc-policy');
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

Edit B of D — append the enforcement block after the phase-6 advisory block (lines 1911-1917; the advisory block itself is untouched). WARNING: the line ABOVE this anchor (line 1910) contains ONLY 6 spaces of trailing whitespace — anchor starts at the comment line to avoid it. Anchor block is grep-unique (`candidates (advisory only)` occurs once). Ledger events fire via this.eventLedger?.log — synchronous, never awaited. `not_armed` is not ledger-logged (it is the default state every 20 cycles when the orchestrator-level gate raced a config edit; the gate normally prevents the call entirely).

### Anchor
```
      // Memory Governance evaluation (every 20 cycles)
      if (this.memoryGovernor && this.config.memoryGovernance?.enabled && this.cycleCount % 20 === 0) {
        const evaluation = this.memoryGovernor.evaluate(this.cycleCount);
        if (evaluation.pruneCandidates.length > 0) {
          this.logger.info(`🧹 MemoryGovernor: ${evaluation.pruneCandidates.length} candidates (advisory only)`, 3);
        }
      }
```

### Code
```js
      // Memory Governance evaluation (every 20 cycles)
      if (this.memoryGovernor && this.config.memoryGovernance?.enabled && this.cycleCount % 20 === 0) {
        const evaluation = this.memoryGovernor.evaluate(this.cycleCount);
        if (evaluation.pruneCandidates.length > 0) {
          this.logger.info(`🧹 MemoryGovernor: ${evaluation.pruneCandidates.length} candidates (advisory only)`, 3);
        }
      }

      // Memory Governance ENFORCEMENT (Fix 3.2) — opt-in, default OFF via
      // memory.governor.applyPruning. Runs SYNCHRONOUSLY inside the cycle:
      // the cycle loop already serializes phase 6 with the end-of-cycle
      // saveState() capture (exportGraph + captureResearchState are
      // synchronous), so a sync prune can never tear a save. The
      // saveInFlight guard additionally stands enforcement down while an
      // out-of-band save's async write window is open (shutdown join, etc.).
      if (this.memoryGovernor && this.cycleCount % 20 === 0
          && resolveGovernorEnforcement(this.config).applyPruning) {
        const enforcement = this.memoryGovernor.enforce(this.cycleCount, {
          saveInFlight: Boolean(this._saveStatePromise)
        });
        if (enforcement.skipped && enforcement.skipped !== 'not_armed') {
          this.eventLedger?.log('memory_governor_prune_skipped', {
            cycle: this.cycleCount,
            reason: enforcement.skipped
          });
        } else if (enforcement.removedNodes > 0) {
          this.eventLedger?.log('memory_governor_prune', {
            cycle: this.cycleCount,
            removedNodes: enforcement.removedNodes,
            removedEdges: enforcement.removedEdges,
            candidateCount: enforcement.candidateCount,
            batchLimit: enforcement.batchLimit,
            minWeight: enforcement.criteria?.minWeight,
            maxAgeDays: enforcement.criteria?.maxAgeDays,
            nodeIds: enforcement.nodeIds
          });
        }
      }
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

Edit C of D — wake-maintenance GC site (lines 3629-3633): route criteria through resolveGcCriteria (gate off returns exactly the historical defaults → bit-identical graph behavior) and add the durable memory_gc ledger event when anything was removed. WARNING: two lines above the anchor there is a line containing ONLY 8 spaces (after `await this.memory.applyDecay();`) — anchor starts at the comment line to avoid it. Anchor is grep-unique via the 'Ultra-conservative' comment (the bare garbageCollect call line appears twice in the file — do NOT anchor on it alone).

### Anchor
```
        // Ultra-conservative garbage collection - only removes truly abandoned nodes
        // Requires ALL: weight < 0.01 AND not accessed in 2+ YEARS
        // Protected tags, consolidated nodes, and merged nodes are NEVER deleted
        const removed = this.summarizer.garbageCollect(this.memory);
        // Logging is handled inside garbageCollect now
```

### Code
```js
        // Garbage collection (Fix 3.2): legacy ultra-conservative criteria by
        // default (weight < 0.01 AND not accessed in 730+ days — protected
        // tags, consolidated nodes, and merged nodes are NEVER deleted).
        // memory.gc.enabled=true opts this run into research-lifetime
        // criteria: weight < decay.minimumWeight AND untouched >
        // memory.gc.maxAgeDays (default 14).
        const gcCriteria = resolveGcCriteria(this.config);
        const removed = this.summarizer.garbageCollect(
          this.memory, gcCriteria.minWeight, gcCriteria.maxAgeDays
        );
        if (removed > 0) {
          this.eventLedger?.log('memory_gc', {
            cycle: this.cycleCount,
            removed,
            minWeight: gcCriteria.minWeight,
            maxAgeDays: gcCriteria.maxAgeDays,
            mode: gcCriteria.enabled ? 'research' : 'legacy'
          });
        }
        // Detailed skip/remove logging is handled inside garbageCollect
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

Edit D of D — dream-cleanup GC site (lines 4183-4185): same criteria routing + memory_gc ledger event (with phase: 'dream_cleanup'). The `removed` variable is still consumed by the existing info log and dream_phase emitEvent below — both untouched. Anchor is grep-unique via the dream_phase cleanup-started emitEvent line; no trailing whitespace in anchor.

### Anchor
```
    this._getEvents().emitEvent('dream_phase', { phase: 'cleanup', status: 'started' });
    const removed = this.summarizer.garbageCollect(this.memory);
    this.logger.info('✓ Cleanup complete', { removed });
```

### Code
```js
    this._getEvents().emitEvent('dream_phase', { phase: 'cleanup', status: 'started' });
    const gcCriteria = resolveGcCriteria(this.config);
    const removed = this.summarizer.garbageCollect(
      this.memory, gcCriteria.minWeight, gcCriteria.maxAgeDays
    );
    if (removed > 0) {
      this.eventLedger?.log('memory_gc', {
        cycle: this.cycleCount,
        removed,
        minWeight: gcCriteria.minWeight,
        maxAgeDays: gcCriteria.maxAgeDays,
        mode: gcCriteria.enabled ? 'research' : 'legacy',
        phase: 'dream_cleanup'
      });
    }
    this.logger.info('✓ Cleanup complete', { removed });
```

## CHANGE: cosmo23/engine/src/config.yaml

Document the new gates in the default engine config, both OFF (no top-level `memory:` key exists today — verified; ConfigLoader is a plain yaml.load so unknown top-level keys pass through, and the non-breaking validator ignores them; run configs generated by the launcher simply omit the block and code defaults apply). Insert AFTER the memoryGovernance block. Anchor is the full existing block (grep-unique: `maxNodesConsidered: 200` occurs once in this file); there is a blank line after it in the file — the replacement preserves it before the new block. NOTE: if Fix 3.1 (delta compaction) also lands a top-level `memory:` block in this file, merge the two blocks under ONE `memory:` key — YAML forbids duplicate top-level keys.

### Anchor
```
memoryGovernance:
  enabled: true
  applyPruning: false
  decayHalfLifeCycles: 200
  pruneThreshold: 0.1
  maxNodesConsidered: 200
```

### Code
```js
memoryGovernance:
  enabled: true
  applyPruning: false
  decayHalfLifeCycles: 200
  pruneThreshold: 0.1
  maxNodesConsidered: 200

# Phase 3 memory hygiene gates (Fix 3.2) — BOTH DEFAULT OFF.
# memory.gc — criteria for the scheduled summarizer garbage collection:
#   enabled: false keeps the legacy ultra-conservative criteria
#   (weight < 0.01 AND untouched 730+ days) bit-for-bit.
#   enabled: true switches to research-lifetime criteria:
#   weight < minWeight (defaults to architecture.memory.decay.minimumWeight)
#   AND untouched > maxAgeDays (default 14). Protected tags, consolidated
#   and merged/inherited nodes are NEVER collected under either mode.
# memory.governor — opt-in MemoryGovernor enforcement (actual pruning):
#   applyPruning: false keeps the governor advisory-only (today's behavior).
#   When true, at most maxPrunesPerEval nodes are removed per evaluation
#   (every 20 cycles), through the same removal path GC uses, with counts
#   logged and a durable memory_governor_prune ledger event.
memory:
  gc:
    enabled: false
    maxAgeDays: 14
  governor:
    applyPruning: false
    maxPrunesPerEval: 50
```

## CHANGE: package.json

Register the new suite in the root test chain exactly once. WARNING: package.json carries FOREIGN UNCOMMITTED HUNKS from concurrent sessions — stage this hunk surgically (git add -p), never the whole file. Anchor is the space-separated neighbor pair inside the scripts.test chain (grep-unique, verified count 1 in the current tree); insert the new entry between them, single spaces.

### Anchor
```
tests/cosmo23/network-memory-embedding-batch.test.cjs tests/cosmo23/query-engine-provider-ownership.test.cjs
```

### Code
```js
tests/cosmo23/network-memory-embedding-batch.test.cjs tests/cosmo23/memory-gc-governor.test.cjs tests/cosmo23/query-engine-provider-ownership.test.cjs
```

## CHANGE: tests/cosmo23/package-test-registration.test.cjs

Register the new suite in the registration-authority list exactly once (order in the list is not asserted, only exactly-once membership). WARNING: this file also carries FOREIGN UNCOMMITTED HUNKS — stage surgically. Anchor line is grep-unique, 4-space indent, no trailing whitespace.

### Anchor
```
    'tests/cosmo23/network-memory-embedding-batch.test.cjs',
```

### Code
```js
    'tests/cosmo23/network-memory-embedding-batch.test.cjs',
    'tests/cosmo23/memory-gc-governor.test.cjs',
```

## TEST FILE: tests/cosmo23/memory-gc-governor.test.cjs

```js
'use strict';

// Fix 3.2 — decay retuned to research timescales + MemoryGovernor enforcement.
//
// Pins, in order:
//  1. gc-policy criteria resolution: memory.gc gate OFF returns the legacy
//     ultra-conservative criteria (weight < 0.01 AND untouched 730+ days)
//     bit-for-bit; ON returns research-lifetime criteria (weight <
//     decay.minimumWeight, untouched > memory.gc.maxAgeDays default 14).
//  2. Governor enforcement gate: memory.governor.applyPruning default FALSE;
//     the legacy memoryGovernance.applyPruning knob does NOT arm live-graph
//     enforcement; batch bound clamped.
//  3. selectGcCandidates hits exactly the intended set on a mixed fixture —
//     protected tags (execution_result / execution_failure et al.),
//     consolidated, merged/inherited, domain-stamped and decay.exemptTags
//     nodes are immune; malformed weight/accessed fail closed.
//  4. The REAL removal path: summarizer.garbageCollect with research criteria
//     removes exactly the intended nodes through NetworkMemory.removeNodes —
//     edges cleaned up, delta tombstones (deletedNodeIds/deletedEdgeKeys)
//     recorded, numeric return preserved.
//  5. applyPruning=false bit-identical pin: advisory evaluate() and unarmed
//     enforce() leave exportGraph() byte-equal.
//  6. Armed enforce(): bounded batches per eval, protected survivors, result
//     payload carries the ledger-event fields, synchronous by contract.
//  7. save-in-flight stand-down: armed enforce() with saveInFlight refuses to
//     mutate.
//  8. Legacy default pin: garbageCollect with no explicit criteria still
//     enforces 0.01 / 730d.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GC_PROTECTED_TAGS,
  LEGACY_GC_CRITERIA,
  resolveResearchGcCriteria,
  resolveGcCriteria,
  resolveGovernorEnforcement,
  isGcProtectedNode,
  selectGcCandidates,
} = require('../../cosmo23/engine/src/memory/gc-policy');
const { NetworkMemory } = require('../../cosmo23/engine/src/memory/network-memory');
const { MemorySummarizer } = require('../../cosmo23/engine/src/memory/summarizer');
const { MemoryGovernor } = require('../../cosmo23/engine/src/system/memory-governor');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();

const quietLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

function makeNode(id, overrides = {}) {
  const ageDays = overrides.ageDays ?? 30;
  const accessed = overrides.accessed ?? new Date(NOW - ageDays * DAY_MS);
  const node = {
    id,
    concept: `concept ${id}`,
    tag: 'thought',
    embedding: null,
    weight: 0.05,
    activation: 0.1,
    cluster: 1,
    created: accessed,
    accessed,
    accessCount: 0,
    ...overrides,
  };
  delete node.ageDays;
  return node;
}

// Real-behavior fixture: NetworkMemory.prototype methods over hand-built
// graph state, so removeNodes / withPersistenceBarrier / exportGraph are the
// production implementations, not stubs.
function buildMemoryFixture(nodes, edges = []) {
  const memory = Object.create(NetworkMemory.prototype);
  memory.config = { decay: { minimumWeight: 0.1 } };
  memory.logger = null;
  memory.events = { emitEvent() {}, emit() {} };
  memory.nodes = new Map();
  memory.edges = new Map();
  memory.clusters = new Map();
  memory.activations = new Map();
  memory.nextNodeId = 1;
  memory.nextClusterId = 2;
  memory.nodeIdFormat = 'numeric';
  memory.nodeIdPrefix = null;
  memory.persistenceRevision = 0;
  memory.persistenceGeneration = 0;
  memory.persistenceBarrierActive = false;
  memory.dirtyNodeIds = new Set();
  memory.dirtyEdgeKeys = new Set();
  memory.deletedNodeIds = new Set();
  memory.deletedEdgeKeys = new Set();

  const clusterMembers = new Set();
  for (const node of nodes) {
    memory.nodes.set(node.id, node);
    clusterMembers.add(node.id);
  }
  memory.clusters.set(1, clusterMembers);

  for (const [a, b] of edges) {
    const pair = [a, b].sort((x, y) => String(x).localeCompare(String(y)));
    const key = pair.join('->');
    memory.edges.set(key, {
      source: pair[0],
      target: pair[1],
      weight: 0.3,
      type: 'associative',
      created: new Date(NOW - 30 * DAY_MS),
      accessed: new Date(NOW - 30 * DAY_MS),
    });
  }
  return memory;
}

function runGarbageCollect(memory, ...criteriaArgs) {
  return MemorySummarizer.prototype.garbageCollect.call(
    { logger: quietLogger },
    memory,
    ...criteriaArgs,
  );
}

test('resolveGcCriteria: gate off returns the legacy ultra-conservative criteria bit-for-bit', () => {
  for (const config of [
    undefined,
    {},
    { memory: {} },
    { memory: { gc: {} } },
    { memory: { gc: { enabled: false, maxAgeDays: 3 } } },
    { memory: { gc: { enabled: 'true' } } }, // strings never arm the gate
  ]) {
    const criteria = resolveGcCriteria(config);
    assert.deepEqual(
      { enabled: criteria.enabled, minWeight: criteria.minWeight, maxAgeDays: criteria.maxAgeDays },
      { enabled: false, minWeight: 0.01, maxAgeDays: 730 },
    );
  }
  assert.equal(LEGACY_GC_CRITERIA.minWeight, 0.01);
  assert.equal(LEGACY_GC_CRITERIA.maxAgeDays, 730);
});

test('resolveGcCriteria: gate on resolves research-lifetime criteria with decay.minimumWeight fallback', () => {
  const enabled = resolveGcCriteria({
    memory: { gc: { enabled: true } },
    architecture: { memory: { decay: { minimumWeight: 0.1 } } },
  });
  assert.deepEqual(
    { enabled: enabled.enabled, minWeight: enabled.minWeight, maxAgeDays: enabled.maxAgeDays },
    { enabled: true, minWeight: 0.1, maxAgeDays: 14 },
  );

  const overridden = resolveGcCriteria({
    memory: { gc: { enabled: true, minWeight: 0.25, maxAgeDays: 3 } },
  });
  assert.equal(overridden.minWeight, 0.25);
  assert.equal(overridden.maxAgeDays, 3);

  // Garbage values fall back instead of arming nonsense criteria.
  const garbage = resolveResearchGcCriteria({
    memory: { gc: { enabled: true, minWeight: 'lots', maxAgeDays: -5 } },
    architecture: { memory: { decay: { minimumWeight: 'also garbage' } } },
  });
  assert.equal(garbage.minWeight, 0.1);
  assert.equal(garbage.maxAgeDays, 14);
});

test('resolveGovernorEnforcement: default OFF, legacy memoryGovernance knob does not arm it, batch bound clamped', () => {
  assert.equal(resolveGovernorEnforcement().applyPruning, false);
  assert.equal(resolveGovernorEnforcement({}).applyPruning, false);
  // The legacy advisory knob must NOT arm live-graph enforcement.
  assert.equal(
    resolveGovernorEnforcement({ memoryGovernance: { enabled: true, applyPruning: true } }).applyPruning,
    false,
  );
  assert.equal(
    resolveGovernorEnforcement({ memory: { governor: { applyPruning: true } } }).applyPruning,
    true,
  );
  assert.equal(resolveGovernorEnforcement({}).maxPrunesPerEval, 50);
  assert.equal(
    resolveGovernorEnforcement({ memory: { governor: { maxPrunesPerEval: 7 } } }).maxPrunesPerEval,
    7,
  );
  assert.equal(
    resolveGovernorEnforcement({ memory: { governor: { maxPrunesPerEval: 999999 } } }).maxPrunesPerEval,
    1000,
  );
  assert.equal(
    resolveGovernorEnforcement({ memory: { governor: { maxPrunesPerEval: -3 } } }).maxPrunesPerEval,
    50,
  );
});

test('protected-tag set: execution_result / execution_failure and the full summarizer list stay exempt', () => {
  for (const tag of [
    'agent_insight', 'agent_finding', 'mission_plan', 'cross_agent_pattern',
    'consolidated', 'breakthrough', 'synthesis', 'goal', 'milestone',
    'research', 'analysis', 'important', 'core', 'foundation',
    'execution_result', 'execution_failure', 'capability_gap', 'disconfirmation',
  ]) {
    assert.equal(GC_PROTECTED_TAGS.has(tag), true, `expected protected tag: ${tag}`);
    assert.equal(isGcProtectedNode(makeNode(1, { tag, weight: 0, ageDays: 5000 })), true);
  }
  assert.equal(GC_PROTECTED_TAGS.size, 18);
  assert.equal(isGcProtectedNode(makeNode(2, { consolidatedAt: new Date() })), true);
  assert.equal(isGcProtectedNode(makeNode(3, { sourceRuns: ['run-a'] })), true);
  assert.equal(isGcProtectedNode(makeNode(4, { mergedAt: new Date() })), true);
  assert.equal(isGcProtectedNode(makeNode(5, { inheritedArtifact: true })), true);
  assert.equal(isGcProtectedNode(makeNode(6, { domain: 'physics' })), true);
  assert.equal(isGcProtectedNode(makeNode(7, { domain: 'unknown' })), false);
  assert.equal(isGcProtectedNode(makeNode(8, { tag: 'custom_keep' }), ['custom_keep']), true);
  assert.equal(isGcProtectedNode(makeNode(9, { tag: 'custom_keep' }), new Set(['custom_keep'])), true);
  assert.equal(isGcProtectedNode(null), true); // fail-closed
});

test('selectGcCandidates: mixed fixture hits exactly the intended set, fail-closed on malformed fields', () => {
  const criteria = { enabled: true, minWeight: 0.1, maxAgeDays: 14 };
  const memory = buildMemoryFixture([
    makeNode(1, { weight: 0.05, ageDays: 20 }),                       // eligible
    makeNode(2, { weight: 0.09, ageDays: 15 }),                       // eligible
    makeNode(3, { weight: 0.05, ageDays: 2 }),                        // too fresh
    makeNode(4, { weight: 0.5, ageDays: 200 }),                       // weight too high
    makeNode(5, { weight: 0.0, ageDays: 400, tag: 'execution_result' }),   // protected
    makeNode(6, { weight: 0.0, ageDays: 400, tag: 'execution_failure' }),  // protected
    makeNode(7, { weight: 0.0, ageDays: 400, consolidatedAt: new Date() }),// protected
    makeNode(8, { weight: 0.0, ageDays: 400, sourceRuns: ['r'] }),    // protected (merged)
    makeNode(9, { weight: 0.0, ageDays: 400, tag: 'custom_keep' }),   // decay.exemptTags
    makeNode(10, { weight: NaN, ageDays: 400 }),                      // fail-closed
    makeNode(11, { weight: 0.05, accessed: 'not-a-date', ageDays: 0 }), // fail-closed
    makeNode(12, { weight: 0.05, ageDays: 20 }),                      // eligible
  ]);

  const candidates = selectGcCandidates(memory, criteria, {
    now: NOW,
    extraExemptTags: ['custom_keep'],
  });
  assert.deepEqual(candidates.sort((a, b) => a - b), [1, 2, 12]);

  const bounded = selectGcCandidates(memory, criteria, {
    now: NOW,
    extraExemptTags: ['custom_keep'],
    limit: 2,
  });
  assert.equal(bounded.length, 2);

  assert.deepEqual(selectGcCandidates({}, criteria), []);
  assert.deepEqual(selectGcCandidates(null, criteria), []);
});

test('summarizer.garbageCollect with research criteria removes exactly the intended set through the real removal path', () => {
  const memory = buildMemoryFixture(
    [
      makeNode(1, { weight: 0.05, ageDays: 20 }),                        // removed
      makeNode(2, { weight: 0.01, ageDays: 60 }),                        // removed
      makeNode(3, { weight: 0.05, ageDays: 2 }),                         // survives: fresh
      makeNode(4, { weight: 0.5, ageDays: 200 }),                        // survives: weight
      makeNode(5, { weight: 0.0, ageDays: 400, tag: 'execution_result' }),  // survives: protected
      makeNode(6, { weight: 0.0, ageDays: 400, tag: 'execution_failure' }), // survives: protected
      makeNode(7, { weight: 0.0, ageDays: 400, consolidatedAt: new Date() }),
      makeNode(8, { weight: 0.0, ageDays: 400, mergedAt: new Date() }),
    ],
    [[1, 4], [2, 5], [4, 5], [3, 6]],
  );

  const removed = runGarbageCollect(memory, 0.1, 14);

  assert.equal(typeof removed, 'number'); // numeric return contract preserved
  assert.equal(removed, 2);
  assert.deepEqual(Array.from(memory.nodes.keys()).sort((a, b) => a - b), [3, 4, 5, 6, 7, 8]);
  // Edges touching removed nodes are gone; the rest survive.
  assert.equal(memory.edges.has('1->4'), false);
  assert.equal(memory.edges.has('2->5'), false);
  assert.equal(memory.edges.has('4->5'), true);
  assert.equal(memory.edges.has('3->6'), true);
  // Removal is tombstoned for the delta/manifest protocol.
  assert.deepEqual(Array.from(memory.deletedNodeIds).sort((a, b) => a - b), [1, 2]);
  assert.equal(memory.deletedEdgeKeys.has('1->4'), true);
  assert.equal(memory.deletedEdgeKeys.has('2->5'), true);
  // Cluster membership pruned with the nodes.
  assert.equal(memory.clusters.get(1).has(1), false);
  assert.equal(memory.clusters.get(1).has(4), true);
});

test('summarizer.garbageCollect default criteria still enforce 0.01 / 730d (legacy pin)', () => {
  const memory = buildMemoryFixture([
    makeNode(1, { weight: 0.005, ageDays: 400 }), // old + tiny, but < 730d → survives defaults
    makeNode(2, { weight: 0.005, ageDays: 800 }), // beyond 730d → removed by defaults
    makeNode(3, { weight: 0.05, ageDays: 800 }),  // weight >= 0.01 → survives defaults
  ]);
  const removed = runGarbageCollect(memory);
  assert.equal(removed, 1);
  assert.deepEqual(Array.from(memory.nodes.keys()).sort((a, b) => a - b), [1, 3]);
});

test('applyPruning=false pin: advisory evaluate() and unarmed enforce() leave the graph bit-identical', () => {
  const memory = buildMemoryFixture(
    [
      makeNode(1, { weight: 0.05, ageDays: 20 }),
      makeNode(2, { weight: 0.0, ageDays: 400, tag: 'execution_result' }),
      makeNode(3, { weight: 0.5, ageDays: 2 }),
    ],
    [[1, 3]],
  );
  const config = {
    memoryGovernance: { enabled: true, applyPruning: false },
    architecture: { memory: { decay: { minimumWeight: 0.1, exemptTags: [] } } },
    // no memory.governor block → enforcement stays OFF by default
  };
  const governor = new MemoryGovernor(config, quietLogger, memory);

  // Populate the legacy registry so the advisory path actually produces
  // candidates (in production nothing calls registerNode — the registry is
  // empty and evaluate() is inert; this exercises the worst case).
  governor.registerNode(1, { activation: 1.0, cycle: 0 });
  governor.registerNode(3, { activation: 1.0, cycle: 0 });

  const before = JSON.stringify(memory.exportGraph());
  const evaluation = governor.evaluate(10000);
  assert.ok(Array.isArray(evaluation.pruneCandidates));
  assert.ok(evaluation.pruneCandidates.length > 0, 'advisory path should identify candidates');
  assert.equal(JSON.stringify(memory.exportGraph()), before, 'advisory evaluate() must not mutate the graph');

  const enforcement = governor.enforce(10000, {});
  assert.equal(enforcement.applied, false);
  assert.equal(enforcement.skipped, 'not_armed');
  assert.equal(enforcement.removedNodes, 0);
  assert.equal(JSON.stringify(memory.exportGraph()), before, 'unarmed enforce() must not mutate the graph');

  // Legacy knob alone must not arm enforcement either.
  const legacyArmed = new MemoryGovernor(
    { memoryGovernance: { enabled: true, applyPruning: true } },
    quietLogger,
    memory,
  );
  const legacyResult = legacyArmed.enforce(10000, {});
  assert.equal(legacyResult.skipped, 'not_armed');
  assert.equal(JSON.stringify(memory.exportGraph()), before);
});

test('armed enforce(): bounded batches, protected survivors, ledger-ready payload, synchronous', () => {
  const nodes = [];
  for (let i = 1; i <= 12; i++) {
    nodes.push(makeNode(i, { weight: 0.05, ageDays: 30 })); // eligible garbage
  }
  nodes.push(makeNode(100, { weight: 0.0, ageDays: 400, tag: 'execution_result' }));
  nodes.push(makeNode(101, { weight: 0.0, ageDays: 400, tag: 'custom_keep' }));
  nodes.push(makeNode(102, { weight: 0.05, ageDays: 1 })); // fresh
  const memory = buildMemoryFixture(nodes, [[1, 100], [2, 3]]);

  const config = {
    memory: { governor: { applyPruning: true, maxPrunesPerEval: 5 } },
    architecture: { memory: { decay: { minimumWeight: 0.1, exemptTags: ['custom_keep'] } } },
  };
  const governor = new MemoryGovernor(config, quietLogger, memory);

  const first = governor.enforce(20, { now: NOW });
  assert.equal(typeof first.then, 'undefined', 'enforce() must be synchronous');
  assert.equal(first.applied, true);
  assert.equal(first.removedNodes, 5, 'bounded batch respected');
  assert.equal(first.batchLimit, 5);
  assert.equal(first.candidateCount, 5);
  assert.equal(first.criteria.minWeight, 0.1);
  assert.equal(first.criteria.maxAgeDays, 14);
  assert.ok(Array.isArray(first.nodeIds) && first.nodeIds.length === 5);
  assert.equal(memory.nodes.size, 15 - 5);

  const second = governor.enforce(40, { now: NOW });
  assert.equal(second.removedNodes, 5);
  const third = governor.enforce(60, { now: NOW });
  assert.equal(third.removedNodes, 2, 'only the remaining eligible nodes are pruned');
  const fourth = governor.enforce(80, { now: NOW });
  assert.equal(fourth.applied, true);
  assert.equal(fourth.removedNodes, 0, 'steady state: nothing eligible left');

  // Survivors: protected tag, decay-exempt custom tag, fresh node.
  assert.deepEqual(Array.from(memory.nodes.keys()).sort((a, b) => a - b), [100, 101, 102]);
  // Edges referencing pruned nodes were cleaned through the real removal path.
  assert.equal(memory.edges.has('2->3'), false);
  assert.equal(memory.edges.size, 0);
  assert.equal(memory.deletedNodeIds.size, 12);
});

test('armed enforce() stands down while a save is in flight', () => {
  const memory = buildMemoryFixture([
    makeNode(1, { weight: 0.05, ageDays: 30 }),
    makeNode(2, { weight: 0.05, ageDays: 30 }),
  ]);
  const config = {
    memory: { governor: { applyPruning: true, maxPrunesPerEval: 5 } },
    architecture: { memory: { decay: { minimumWeight: 0.1, exemptTags: [] } } },
  };
  const governor = new MemoryGovernor(config, quietLogger, memory);
  const before = JSON.stringify(memory.exportGraph());

  const result = governor.enforce(20, { saveInFlight: true, now: NOW });
  assert.equal(result.applied, false);
  assert.equal(result.skipped, 'save_in_flight');
  assert.equal(result.removedNodes, 0);
  assert.equal(JSON.stringify(memory.exportGraph()), before, 'no mutation while a save is in flight');

  const after = governor.enforce(20, { saveInFlight: false, now: NOW });
  assert.equal(after.removedNodes, 2, 'same evaluation succeeds once the save window closes');
});

```

## API NOTES

NEW PUBLIC API (cosmo23/engine/src/memory/gc-policy.js): GC_PROTECTED_TAGS (Set, 18 tags — canonical, now also consumed by summarizer.garbageCollect), LEGACY_GC_CRITERIA ({enabled:false, minWeight:0.01, maxAgeDays:730}), resolveGcCriteria(fullConfig) (legacy unless memory.gc.enabled===true), resolveResearchGcCriteria(fullConfig) (minWeight: memory.gc.minWeight → architecture.memory.decay.minimumWeight → 0.1; maxAgeDays: memory.gc.maxAgeDays → 14), resolveGovernorEnforcement(fullConfig) ({applyPruning: memory.governor.applyPruning===true, maxPrunesPerEval: default 50, clamp 1..1000}), isGcProtectedNode(node, extraExemptTags), selectGcCandidates(memoryNetwork, criteria, {limit, now, extraExemptTags}). MemoryGovernor gains enforce(cycle, {saveInFlight, now}) → {applied, skipped?, removedNodes, removedEdges, candidateCount, batchLimit, criteria, nodeIds(first 20)}; evaluate() and the legacy registry are byte-untouched. summarizer.garbageCollect signature/return unchanged (numeric count; engine mocha memory-summarizer-mutation-api re-run green 5/5 against the edit).

CONFIG SURFACE: memory.gc.{enabled:false, maxAgeDays:14, minWeight?} and memory.governor.{applyPruning:false, maxPrunesPerEval:50} — new top-level memory: block (none exists today; yaml.load passes it through, validator non-breaking; launcher-generated run configs omit it and code defaults apply = gates off). DELIBERATE SCOPE DECISION (No-backend-magic): the legacy memoryGovernance.applyPruning knob does NOT arm the new live-graph enforcement — it keeps gating only the legacy registry path, which is provably inert (registerNode/touchNode have zero callers, nodeIndex always empty, evaluate() early-returns). Pinned by test. If Fix 3.1 also adds a top-level memory: block to config.yaml, merge under one memory: key.

LEDGER EVENTS (G3, all via this.eventLedger?.log, synchronous, never awaited): memory_gc {cycle, removed, minWeight, maxAgeDays, mode:'research'|'legacy', phase?:'dream_cleanup'} at both GC sites when removed>0; memory_governor_prune {cycle, removedNodes, removedEdges, candidateCount, batchLimit, minWeight, maxAgeDays, nodeIds} ; memory_governor_prune_skipped {cycle, reason}. One observability-only delta with gates OFF: memory_gc now logs if legacy GC ever removes (G1 requires destructive actions logged; graph behavior is bit-identical — pinned by the legacy-defaults test).

G1/REVERSIBILITY: there is no soft-delete in this codebase — decay is weight-multiplication, GC/governor removal is hard removal through the ONE shared path (removeNodes → _removeNodeUnsafe under withPersistenceBarrier) that cascades edges, prunes clusters, and records deletedNodeIds/deletedEdgeKeys tombstones + advances persistenceGeneration for the manifest/delta writer. Reversibility in design intent = prior immutable manifest generations + 6h interval backups retain removed nodes until a base rewrite, plus the ledger records IDs/counts. The every-save brain-snapshot guard (refuses >50% drop of a >100-node brain) remains a hard backstop above the governor's batch bound.

INTERLOCK (analyzed honestly): enforce() is synchronous-by-contract; save capture (exportGraph + captureResearchState) is synchronous pre-first-await, so a phase-6 prune cannot tear a capture on the single-threaded loop; a prune during an out-of-band save's async write window lands in the tombstone sets and advances persistenceGeneration, so markPersistenceCleanIfGeneration refuses the stale clean-mark and the next save carries it. The saveInFlight stand-down (this._saveStatePromise non-null) is belt-and-suspenders honoring 'never during an active save' literally.

DELIBERATE DIVERGENCE: selectGcCandidates fails CLOSED on NaN weight / unparseable accessed; summarizer's historical NaN-falls-through-to-remove semantics are retained on its own path (documented in gc-policy comments).

OBSERVED BUGS NOT FIXED (behavior pins, flag for separate decisions): (1) applyDecay edge decay multiplies edge weight by hebbian.weakenFactor (0.05) — a 95% cut per pass for edges idle >2h; almost certainly intended ×(1−0.05). (2) evaluate()'s maxNodesConsidered bound is off-by-one. (3) garbageCollect's '180+ days' comment is stale (default 730). Also: do NOT add a decay floor at minimumWeight — the research GC criterion (weight < minimumWeight) requires weights to decay through it; a floor would make GC unreachable for decayed nodes.

VALIDATION (all in scratchpad — NO repo files were edited; git status re-checked, nothing of mine present, nothing to revert): new suite 10/10 green (node:test) against a mirror tree using the REAL NetworkMemory.prototype removal path + edited summarizer/governor copies (validation copy differed from the deliverable only in require path prefix); engine mocha memory-summarizer-mutation-api 5/5 green against the edited summarizer; node --check green on gc-policy.js, summarizer.js, memory-governor.js, and a fully-edited orchestrator copy; every anchor programmatically asserted count==1 against the CURRENT tree (the tree is shared and moving — implementer should re-grep each anchor before applying, and stage package.json + package-test-registration.test.cjs hunks surgically because both carry foreign uncommitted work). Run the new suite standalone with: node --test --test-concurrency=1 tests/cosmo23/memory-gc-governor.test.cjs
