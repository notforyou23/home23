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

module.exports = { validateDoneWhen, DEFAULT_VAGUENESS_CONFIG, REQUIRED_FIELDS };
