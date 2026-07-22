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
