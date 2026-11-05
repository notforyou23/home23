const { isPromptHandlingPreamble } = require('../cognition/hallucinated-tool-call-detector');

const AUTONOMOUS_TAGS = new Set([
  'reasoning',
  'curator',
  'critic',
  'analyst',
  'curiosity',
  'proposal',
  'novel_hypothesis',
  'novel_implication',
  'synthesis',
  'deep_thought',
  'introspection'
]);

const SHORT_META_FRAGMENT_PATTERN = /^(?:let me (?:ground|check|read|think|look)(?: this)?(?: properly)?|let me check the current state|i need to (?:ground|check|read)|checking current state|grounding current state)\.?$/i;
const META_REASONING_OPENER_PATTERN = /^(?:the user (?:is asking|wants|asked) me to|i need to (?:produce output|answer|respond|follow)|let me (?:first )?(?:ground|check|read|understand)|i should (?:first )?(?:ground|check|read))/i;

function isAutonomousNode(node) {
  const tag = String(node?.tag || '').toLowerCase();
  if (AUTONOMOUS_TAGS.has(tag)) return true;
  const tags = Array.isArray(node?.tags) ? node.tags.map(t => String(t).toLowerCase()) : [];
  return tags.some(t => AUTONOMOUS_TAGS.has(t));
}

function getNodeText(node) {
  return String(node?.concept || node?.content || node?.text || '').trim();
}

function classifyBrainCleanupCandidate(node) {
  if (!node || !isAutonomousNode(node)) return null;
  const text = getNodeText(node);
  if (!text) return null;

  const normalized = text.replace(/\s+/g, ' ').trim();
  if (SHORT_META_FRAGMENT_PATTERN.test(normalized)) {
    return { reason: 'short_meta_grounding_fragment', confidence: 0.97 };
  }

  if (isPromptHandlingPreamble(text)) {
    return { reason: 'prompt_handling_preamble', confidence: 0.98 };
  }

  if (
    normalized.length < 220 &&
    META_REASONING_OPENER_PATTERN.test(normalized) &&
    /\b(?:current state|relevant files|surfaces|instructions|tools|context)\b/i.test(normalized)
  ) {
    return { reason: 'meta_reasoning_opener', confidence: 0.92 };
  }

  return null;
}

function collectBrainCleanupCandidates(memory, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(0, options.limit) : Infinity;
  const reasonFilter = options.reason ? String(options.reason) : null;
  const nodes = memory?.nodes instanceof Map
    ? Array.from(memory.nodes.values())
    : Array.isArray(memory?.nodes)
      ? memory.nodes
      : [];
  const candidates = [];

  for (const node of nodes) {
    const classification = classifyBrainCleanupCandidate(node);
    if (!classification) continue;
    if (reasonFilter && classification.reason !== reasonFilter) continue;
    candidates.push({
      id: String(node.id),
      tag: node.tag || null,
      reason: classification.reason,
      confidence: classification.confidence,
      preview: getNodeText(node).slice(0, 220)
    });
    if (candidates.length >= limit) break;
  }

  const byReason = candidates.reduce((acc, candidate) => {
    acc[candidate.reason] = (acc[candidate.reason] || 0) + 1;
    return acc;
  }, {});

  return {
    totalCandidates: candidates.length,
    byReason,
    candidates
  };
}

module.exports = {
  AUTONOMOUS_TAGS,
  classifyBrainCleanupCandidate,
  collectBrainCleanupCandidates,
  isAutonomousNode
};
