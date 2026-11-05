/**
 * done-when-gate.js — validates a doneWhen block at goal creation.
 * Rejects missing, empty, unknown-type, or vague criteria.
 */

const DEFAULT_VAGUENESS_CONFIG = {
  minCriterionLength: 40,
  vaguenessAnchors: [
    'file', 'output', 'memory', 'node', 'count', 'exists',
    'at least', 'contains', 'written', 'published', 'produced',
    'delivered', 'ships', 'emits'
  ]
};

const REQUIRED_FIELDS = {
  file_exists: ['path'],
  file_created_after: ['path', 'since'],
  memory_node_tagged: ['tag'],
  memory_node_matches: ['regex'],
  output_count_since: ['since', 'gte'],
  judged: ['criterion'],
};

/**
 * Resilient variant: instead of rejecting a whole doneWhen when one
 * criterion is invalid, returns a cleaned block containing only the
 * valid criteria. If NONE are valid, returns { valid: false, reason }.
 * Primary use: LLM-produced doneWhen blocks where a hallucinated
 * placeholder criterion shouldn't blow away the good ones.
 */
function validateDoneWhenResilient(dw, opts = {}) {
  if (!dw || typeof dw !== 'object') return { valid: false, reason: 'missing doneWhen' };
  if (!Array.isArray(dw.criteria) || dw.criteria.length === 0) {
    return { valid: false, reason: 'empty doneWhen.criteria' };
  }
  const cleaned = [];
  const dropped = [];
  for (let i = 0; i < dw.criteria.length; i++) {
    const single = { ...dw, criteria: [dw.criteria[i]] };
    const r = validateDoneWhen(single, opts);
    if (r.valid) cleaned.push(dw.criteria[i]);
    else dropped.push({ index: i, reason: r.reason });
  }
  if (cleaned.length === 0) {
    return { valid: false, reason: `all criteria invalid: ${dropped.map(d => d.reason).join('; ')}` };
  }
  return { valid: true, cleaned: { ...dw, criteria: cleaned }, dropped };
}

function validateDoneWhen(dw, opts = {}) {
  const knownTypes = opts.knownTypes || Object.keys(REQUIRED_FIELDS);
  const minLen = opts.minCriterionLength ?? DEFAULT_VAGUENESS_CONFIG.minCriterionLength;
  const anchors = opts.vaguenessAnchors || DEFAULT_VAGUENESS_CONFIG.vaguenessAnchors;

  if (!dw || typeof dw !== 'object') {
    return { valid: false, reason: 'missing doneWhen' };
  }
  if (!Array.isArray(dw.criteria)) {
    return { valid: false, reason: 'missing doneWhen.criteria array' };
  }
  if (dw.criteria.length === 0) {
    return { valid: false, reason: 'empty doneWhen.criteria' };
  }

  for (let i = 0; i < dw.criteria.length; i++) {
    const c = dw.criteria[i];
    if (!c || typeof c !== 'object') {
      return { valid: false, reason: `criterion[${i}] is not an object` };
    }
    if (!knownTypes.includes(c.type)) {
      return { valid: false, reason: `criterion[${i}] unknown type: ${c.type}` };
    }
    const required = REQUIRED_FIELDS[c.type] || [];
    for (const field of required) {
      if (c[field] === undefined || c[field] === null || c[field] === '') {
        return { valid: false, reason: `criterion[${i}] (${c.type}) missing field: ${field}` };
      }
    }
    if (c.type === 'judged') {
      const s = String(c.criterion);
      if (s.length < minLen) {
        return { valid: false, reason: `criterion[${i}] judged text too short (<${minLen} chars) — too vague` };
      }
      const lower = s.toLowerCase();
      const hasAnchor = anchors.some(a => lower.includes(a));
      if (!hasAnchor) {
        return { valid: false, reason: `criterion[${i}] judged text has no concreteness anchor — too vague` };
      }
    }
  }
  return { valid: true };
}

/**
 * Legacy fallback: synthesize a doneWhen from a goal's description so
 * pre-closer call sites keep working while we migrate them one by one.
 * Off switch: set goals.doneWhen.autoSynthesizeLegacy = false.
 *
 * Prefer machine-checkable file_exists when the description names concrete
 * output paths. Fall back to judged only when no path is available.
 */
function applyLegacyFallback(goalData, config = {}) {
  if (!goalData || goalData.doneWhen) return goalData;
  if (config.autoSynthesizeLegacy === false) return goalData;
  const desc = String(goalData.description || '').slice(0, 300);

  let filePaths = [];
  try {
    const { extractFileDeliverablesFromGoal } = require('./deliverable-paths');
    filePaths = extractFileDeliverablesFromGoal({
      description: goalData.description,
      reason: goalData.reason,
      metadata: goalData.metadata,
    });
  } catch {
    filePaths = [];
  }

  if (filePaths.length > 0) {
    const criteria = filePaths.slice(0, 3).map((p) => ({
      type: 'file_exists',
      path: p.startsWith('outputs/') ? p : `outputs/${p}`,
    }));
    // Keep a judged criterion as secondary for multi-file / quality cases
    criteria.push({
      type: 'judged',
      criterion: `The goal "${desc}" is satisfied when the named output file(s) exist under outputs/ and document a concrete resolution.`,
      judgeModel: 'gpt-5.4-mini',
      judgedAt: null,
      judgedVerdict: null,
    });
    return {
      ...goalData,
      doneWhen: {
        version: 1,
        mode: 'all',
        criteria,
      },
      _legacyDoneWhenSynthesized: true,
      _legacyDoneWhenPreferredFileExists: true,
    };
  }

  return {
    ...goalData,
    doneWhen: {
      version: 1,
      criteria: [{
        type: 'judged',
        criterion: `The goal "${desc}" is satisfied when a memory node or output file in outputs/ documents its resolution with at least one concrete finding.`,
        judgeModel: 'gpt-5.4-mini',
        judgedAt: null, judgedVerdict: null
      }]
    },
    _legacyDoneWhenSynthesized: true,
  };
}

module.exports = {
  validateDoneWhen,
  validateDoneWhenResilient,
  applyLegacyFallback,
  DEFAULT_VAGUENESS_CONFIG,
  REQUIRED_FIELDS,
};
