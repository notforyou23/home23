/**
 * Home23 — Curator Cycle (Step 20)
 *
 * Runs as part of the engine's cognitive cycle (alongside analyst, critic, curiosity).
 * Responsibilities:
 *   1. Brain-node intake governance (filter, rate-limit, dedup)
 *   2. Surface rewriting (compress, prioritize, drop stale)
 *   3. Usage-based decay (flag zero-reuse durable memories)
 *   4. Continuity gap detection (read event ledger)
 *
 * This module provides utility functions called from the orchestrator
 * when the curator role is active.
 */

const fs = require('fs');
const path = require('path');

// ─── Constants ──────────────────────────────────────────
const MAX_NODES_PER_CYCLE = 50;
const MIN_NODE_LENGTH = 100;
const ELIGIBLE_TAGS = ['analysis_insight', 'critic_insight', 'curiosity_insight', 'operational', 'insight', 'agent_finding'];
const SURFACE_BUDGETS = {
  'TOPOLOGY.md': 2500,
  'PROJECTS.md': 3000,
  'PERSONAL.md': 2500,
  'DOCTRINE.md': 2500,
  'RECENT.md': 3000,
};

/**
 * Filter brain nodes eligible for curator consideration.
 * @param {Array} nodes - Recent brain nodes
 * @param {Array} existingObjects - Current working MemoryObjects (for dedup)
 * @returns {Array} Eligible nodes, rate-limited
 */
function filterEligibleNodes(nodes, existingObjects = []) {
  const eligible = nodes.filter(node => {
    // Minimum content length
    if (!node.content || node.content.length < MIN_NODE_LENGTH) return false;

    // Tag filter
    const tag = (node.tag || node.role || '').toLowerCase();
    if (!ELIGIBLE_TAGS.some(t => tag.includes(t))) return false;

    // Skip pure self-referential nodes
    if (node.content.match(/^home23.*(is|seems|appears).*(interesting|notable|significant)/i)) return false;

    return true;
  });

  // Rate limit
  return eligible.slice(0, MAX_NODES_PER_CYCLE);
}

/**
 * Check if a surface needs updating based on working memory objects.
 * @param {string} surfacePath - Path to the surface markdown file
 * @param {Array} relevantObjects - MemoryObjects relevant to this surface's domain
 * @param {number} budget - Character budget for this surface
 * @returns {{ needsUpdate: boolean, suggestions: string[] }}
 */
function checkSurfaceFreshness(surfacePath, relevantObjects, budget) {
  if (!fs.existsSync(surfacePath)) {
    return { needsUpdate: relevantObjects.length > 0, suggestions: relevantObjects.map(o => o.statement) };
  }

  const content = fs.readFileSync(surfacePath, 'utf-8');

  // Check if any working objects mention things not in the surface
  const suggestions = [];
  for (const obj of relevantObjects) {
    // Simple check: is the title or key terms mentioned in the surface?
    const terms = obj.title.toLowerCase().split(/\s+/).filter(t => t.length > 3);
    const inSurface = terms.some(t => content.toLowerCase().includes(t));
    if (!inSurface) {
      suggestions.push(obj.statement);
    }
  }

  return {
    needsUpdate: suggestions.length > 0,
    suggestions,
  };
}

/**
 * Read the event ledger and detect continuity gaps.
 * @param {string} ledgerPath - Path to event-ledger.jsonl
 * @returns {{ gaps: string[] }} List of detected gap descriptions
 */
function detectContinuityGaps(ledgerPath) {
  const gaps = [];

  if (!fs.existsSync(ledgerPath)) {
    gaps.push('No event ledger found — continuity tracking not active');
    return { gaps };
  }

  try {
    const events = fs.readFileSync(ledgerPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));

    // Check for sessions without CheckpointLoaded
    const sessions = new Map();
    for (const e of events) {
      if (!sessions.has(e.session_id)) sessions.set(e.session_id, new Set());
      sessions.get(e.session_id).add(e.event_type);
    }

    for (const [sessionId, types] of sessions) {
      if (types.has('SessionStarted') && !types.has('CheckpointLoaded')) {
        gaps.push(`Session ${sessionId}: started without loading checkpoint`);
      }
      if (types.has('RetrievalDegraded')) {
        gaps.push(`Session ${sessionId}: operated in degraded mode`);
      }
    }

    // Check for zero-reuse durable memories (from MemoryReactivated events)
    // This is tracked on the MemoryObject itself, not computed here

  } catch (err) {
    gaps.push(`Failed to read event ledger: ${err.message}`);
  }

  return { gaps };
}

/**
 * Get behavioral audit metrics from the event ledger.
 * @param {string} ledgerPath
 * @returns {Object} Metrics summary
 */
function computeAuditMetrics(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return { error: 'No ledger' };

  try {
    const events = fs.readFileSync(ledgerPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));

    const counts = {};
    for (const e of events) {
      counts[e.event_type] = (counts[e.event_type] || 0) + 1;
    }

    const reactivated = counts['MemoryReactivated'] || 0;
    const actedOn = counts['MemoryActedOn'] || 0;
    const degraded = counts['RetrievalDegraded'] || 0;
    const breakdowns = counts['BreakdownDiagnosed'] || 0;
    const triggersFired = counts['TriggerFired'] || 0;
    const triggersAccepted = counts['TriggerAccepted'] || 0;
    const triggersRejected = counts['TriggerRejected'] || 0;

    return {
      total_events: events.length,
      reactivation_count: reactivated,
      acted_on_count: actedOn,
      acted_on_rate: reactivated > 0 ? (actedOn / reactivated).toFixed(2) : 'N/A',
      degraded_sessions: degraded,
      breakdowns: breakdowns,
      trigger_precision: triggersFired > 0 ? (triggersAccepted / triggersFired).toFixed(2) : 'N/A',
      trigger_nuisance_rate: triggersFired > 0 ? (triggersRejected / triggersFired).toFixed(2) : 'N/A',
    };
  } catch {
    return { error: 'Failed to compute' };
  }
}

module.exports = {
  filterEligibleNodes,
  checkSurfaceFreshness,
  detectContinuityGaps,
  computeAuditMetrics,
  SURFACE_BUDGETS,
  MAX_NODES_PER_CYCLE,
  ELIGIBLE_TAGS,
};
