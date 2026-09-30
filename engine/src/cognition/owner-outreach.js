'use strict';

const { createMemoryAuthorityResolver } = require('../../../shared/memory-authority.cjs');

function outreachEvidenceRefs(memory, candidate, dive, conversationRefs = []) {
  const refs = new Set();
  const nodes = memory.nodes;
  if (nodes?.values && nodes?.get) {
    const resolver = createMemoryAuthorityResolver({ intent: 'general', authorityCandidates: nodes.values() });
    for (const id of dive.referencedNodes || []) {
      const source = nodes.get(id);
      if (!source) continue;
      const node = resolver.apply([source])[0];
      if (node && !node.supersessionEvidence && !node.closureEvidence) refs.add(`memory:${id}`);
    }
  }
  if (candidate.conversation?.source === 'seed_contact' && candidate.conversation.eventId) refs.add(candidate.conversation.eventId);
  if (candidate.observation?.sourceRef) refs.add(candidate.observation.sourceRef);
  if (dive.conversationContext) for (const ref of conversationRefs) refs.add(ref);
  return [...refs].filter(ref => typeof ref === 'string' && ref.length <= 500).slice(0, 40);
}

function normalizeOwnerOutreach(value, allowedRefs = []) {
  if (!value || typeof value !== 'object' || !['question', 'insight', 'action'].includes(value.category)) return null;
  if (typeof value.text !== 'string' || typeof value.reason !== 'string') return null;
  const text = value.text.trim();
  const reason = value.reason.trim();
  if (!text || text.length > 4000 || text.includes('\0') || reason.length < 10 || reason.length > 1000 || reason.includes('\0')) return null;
  if (!Array.isArray(value.evidenceRefs) || !value.evidenceRefs.length || value.evidenceRefs.length > 12) return null;
  const allowed = new Set(allowedRefs);
  if (value.evidenceRefs.some(ref => typeof ref !== 'string' || !allowed.has(ref))) return null;
  const result = { category: value.category, text, reason, evidenceRefs: [...new Set(value.evidenceRefs)] };
  if (value.attention != null) {
    const attention = value.attention;
    if (!attention || typeof attention !== 'object'
      || !['problem', 'recovery', 'progress', 'decision', 'connection'].includes(attention.kind)
      || typeof attention.consequence !== 'string' || attention.consequence.trim().length < 10
      || attention.consequence.length > 1000 || attention.consequence.includes('\0')
      || !Array.isArray(attention.evidenceRefs) || !attention.evidenceRefs.length || attention.evidenceRefs.length > 12
      || attention.evidenceRefs.some(ref => !result.evidenceRefs.includes(ref))) return null;
    result.attention = { kind: attention.kind, consequence: attention.consequence.trim(), evidenceRefs: [...new Set(attention.evidenceRefs)] };
  }
  return result;
}

module.exports = { outreachEvidenceRefs, normalizeOwnerOutreach };
