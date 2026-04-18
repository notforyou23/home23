/**
 * Convergence Detector — heuristics for terminating critique recursion
 *
 * Phase 4 of thinking-machine-cycle rebuild. Pure function, no state.
 *
 * Terminates recursion on any of:
 *   - verdict stable + confidence delta < 0.05 over 2 consecutive passes (converged)
 *   - critique text similarity > 0.85 vs previous pass (plateau — we're repeating ourselves)
 *   - hard cap reached (safety fallback; forces discard with reason 'non_convergence')
 */

'use strict';

const DEFAULT_THRESHOLDS = {
  confidenceDelta: 0.05,   // |confidence_n - confidence_{n-1}| < this → stable
  plateauSimilarity: 0.85, // jaccard similarity > this → plateau
  hardCapPasses: 5,        // safety ceiling
};

/**
 * Given the sequence of critique passes so far, decide whether to stop or continue.
 *
 * @param {Array<{verdict, confidence, rationale, gaps}>} passes - in order, most recent last
 * @param {object} [thresholds] - override defaults
 * @returns {{terminate, reason, forcedVerdict}}
 *   - terminate: boolean
 *   - reason: null | 'keep_verdict' | 'discard_verdict' | 'stable_convergence' | 'plateau' | 'hard_cap'
 *   - forcedVerdict: null | 'discard' — set when we're forcing termination via hard_cap
 */
function assessConvergence(passes, thresholds = {}) {
  const T = { ...DEFAULT_THRESHOLDS, ...thresholds };
  if (!Array.isArray(passes) || passes.length === 0) {
    return { terminate: false, reason: null, forcedVerdict: null };
  }

  const latest = passes[passes.length - 1];

  // Immediate terminal verdicts: keep and discard always end the loop
  if (latest.verdict === 'keep') {
    return { terminate: true, reason: 'keep_verdict', forcedVerdict: null };
  }
  if (latest.verdict === 'discard') {
    return { terminate: true, reason: 'discard_verdict', forcedVerdict: null };
  }

  // Hard cap — safety ceiling. Force discard on behalf of honesty.
  if (passes.length >= T.hardCapPasses) {
    return { terminate: true, reason: 'hard_cap', forcedVerdict: 'discard' };
  }

  // Plateau detection — critique is repeating itself
  if (passes.length >= 2) {
    const prev = passes[passes.length - 2];
    const sim = jaccardSimilarity(
      tokenize(textOfPass(prev)),
      tokenize(textOfPass(latest))
    );
    if (sim >= T.plateauSimilarity) {
      // Plateau: commit to the current (revise) verdict with whatever confidence.
      // But if confidence is low, it's more honest to discard than to force-emit.
      const forced = latest.confidence < 0.5 ? 'discard' : null;
      return { terminate: true, reason: 'plateau', forcedVerdict: forced };
    }

    // Stable convergence — verdict unchanged + confidence barely moving
    if (prev.verdict === latest.verdict && Math.abs(prev.confidence - latest.confidence) < T.confidenceDelta) {
      // If both are 'revise' we're actually NOT converged — revise+revise means loop continues.
      // Treat as plateau-adjacent: if 3 consecutive 'revise' with tight confidence, force discard.
      if (latest.verdict === 'revise' && passes.length >= 3) {
        const third = passes[passes.length - 3];
        if (third.verdict === 'revise' && Math.abs(third.confidence - latest.confidence) < T.confidenceDelta) {
          return { terminate: true, reason: 'stable_convergence', forcedVerdict: 'discard' };
        }
      }
    }
  }

  return { terminate: false, reason: null, forcedVerdict: null };
}

/**
 * Jaccard similarity between two token sets. 0 = disjoint, 1 = identical.
 */
function jaccardSimilarity(a, b) {
  if (!a?.size || !b?.size) return 0;
  let intersection = 0;
  for (const tok of a) if (b.has(tok)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function tokenize(text) {
  if (!text || typeof text !== 'string') return new Set();
  const lower = text.toLowerCase();
  const tokens = lower.match(/[a-z0-9]+/g) || [];
  return new Set(tokens);
}

function textOfPass(pass) {
  if (!pass) return '';
  return [pass.rationale, (pass.gaps || []).join(' ')].filter(Boolean).join(' ');
}

module.exports = {
  assessConvergence,
  DEFAULT_THRESHOLDS,
  // exported for testing
  _internal: { jaccardSimilarity, tokenize, textOfPass },
};
