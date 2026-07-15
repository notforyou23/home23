const DAY_MS = 24 * 60 * 60 * 1000;
const {
  classifyMemoryDomain,
  classifyClaimAuthority,
  projectSourceChain,
  scoreMemoryAuthority,
  explainMemoryAuthorityScore,
  projectMemoryAuthority,
} = require('../../../shared/memory-authority.cjs');

const TELEMETRY_TAGS = new Set([
  'jerry_cron_docs',
  'cron_docs',
  'cron',
  'telemetry',
  'metrics',
]);

const AUTONOMOUS_TAGS = new Set([
  'reasoning',
  'curator',
  'critic',
  'analyst',
  'curiosity',
  'proposal',
  'novel_hypothesis',
  'novel_implication',
  'speculative_hypothesis',
  'synthesis',
  'synthesis_report',
  'deep_thought',
  'introspection',
  'agent_insight',
  'analysis_insight',
]);

const IDENTITY_TAGS = new Set([
  'jtr_life',
  'garcia_jerry',
  'legacy_jtrbrain_feed',
  'daily-notes',
  'daily_notes',
]);

function textOf(node) {
  return [
    node?.concept,
    node?.summary,
    node?.keyPhrase,
    node?.metadata?.source,
    node?.metadata?.channel,
  ].filter(Boolean).join('\n');
}

function lowerTextOf(node) {
  return textOf(node).toLowerCase();
}

function tagOf(node) {
  return String(node?.tag || node?.type || '').toLowerCase();
}

function includesAny(value, patterns) {
  return patterns.some((pattern) => pattern.test(value));
}

function isStateSnapshot(node) {
  const tags = Array.isArray(node?.tags) ? node.tags.map((t) => String(t).toLowerCase()) : [];
  const tag = tagOf(node);
  return tag === 'state_snapshot' ||
    node?.type === 'state_snapshot' ||
    tags.includes('state_snapshot') ||
    node?.metadata?.kind === 'state_snapshot';
}

function isTelemetryLike(node) {
  const tag = tagOf(node);
  if (TELEMETRY_TAGS.has(tag)) return true;

  const text = lowerTextOf(node);
  return includesAny(text, [
    /\bchannel:\s*cron-/,
    /\bcron-agent[-\s]/,
    /\bticker-home23-/,
    /\bevening-research\b/,
    /\bmid-session\b/,
    /\bpre-market\b/,
    /\btrading signals?\b/,
    /\bportfolio\b/,
    /\bsignals-\d{6,}\b/,
  ]);
}

function isDirectConversation(node) {
  const tag = tagOf(node);
  if (tag !== 'conversation_sessions' && tag !== 'conversation') return false;
  if (isTelemetryLike(node)) return false;

  const text = lowerTextOf(node);
  return includesAny(text, [
    /\*\*user:\*\*/,
    /\buser:\s/,
    /\bjtr\b/,
    /\bchannel:\s*dashboard/,
    /\bchannel:\s*telegram/,
    /\bchannel:\s*discord/,
    /\bchat\b/,
  ]);
}

function isIdentityLike(node) {
  const tag = tagOf(node);
  return IDENTITY_TAGS.has(tag);
}

function isAutonomousChatterLike(node) {
  const text = lowerTextOf(node);
  return includesAny(text, [
    /\blet me\s+(?:query|read|check|ground|inspect|pull|look)/,
    /\bi(?:'ll| will| am going to)?\s+(?:query|read|check|ground|inspect|pull|look)/,
    /\bbefore (?:responding|producing|answering)/,
    /\bi (?:do not|don't) have access to (?:an )?(?:external )?(?:brain|database)/,
    /\bground (?:my|this|the) (?:response|answer|thought) in\b/,
    /\bsurface to ground this\b/,
  ]);
}

function classifyMemoryProvenance(node = {}) {
  const existingClass = node?.source_class || node?.sourceClass || node?.metadata?.source_class;
  if (existingClass && typeof existingClass === 'string') {
    const sourceClass = existingClass.toLowerCase();
    const salienceWeight = Number(node.salienceWeight ?? node.metadata?.salienceWeight);
    return {
      sourceClass,
      salienceWeight: Number.isFinite(salienceWeight) ? salienceWeight : classWeight(sourceClass),
      retention: sourceClass === 'telemetry' ? 'ephemeral' : 'durable',
      reason: 'stored_source_class',
    };
  }

  if (isStateSnapshot(node)) {
    return {
      sourceClass: 'state',
      salienceWeight: 1.6,
      retention: 'durable',
      reason: 'state_snapshot',
    };
  }

  if (isTelemetryLike(node)) {
    return {
      sourceClass: 'telemetry',
      salienceWeight: 0.18,
      retention: 'ephemeral',
      halfLifeDays: 3,
      reason: 'cron_or_telemetry',
    };
  }

  if (isDirectConversation(node)) {
    return {
      sourceClass: 'conversation',
      salienceWeight: 2.25,
      retention: 'durable',
      reason: 'direct_user_conversation',
    };
  }

  if (isAutonomousChatterLike(node)) {
    return {
      sourceClass: 'autonomous',
      salienceWeight: 0.45,
      retention: 'durable',
      reason: 'autonomous_preamble',
    };
  }

  if (isIdentityLike(node)) {
    return {
      sourceClass: 'identity',
      salienceWeight: 1.8,
      retention: 'durable',
      reason: 'identity_or_preference',
    };
  }

  const tag = tagOf(node);
  if (AUTONOMOUS_TAGS.has(tag)) {
    return {
      sourceClass: 'autonomous',
      salienceWeight: 0.45,
      retention: 'durable',
      reason: 'autonomous_system_output',
    };
  }

  return {
    sourceClass: 'durable',
    salienceWeight: 1,
    retention: 'durable',
    reason: 'default',
  };
}

function classWeight(sourceClass) {
  switch (sourceClass) {
    case 'conversation': return 2.25;
    case 'identity': return 1.8;
    case 'state': return 1.6;
    case 'autonomous': return 0.45;
    case 'telemetry': return 0.18;
    default: return 1;
  }
}

function nodeTimeMs(node) {
  const value = node?.asserted_at || node?.metadata?.asserted_at || node?.created;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function telemetryDecay(node, provenance, nowMs) {
  if (provenance.sourceClass !== 'telemetry') return 1;
  const ms = nodeTimeMs(node);
  if (!ms) return 1;
  const halfLifeDays = Number(provenance.halfLifeDays) || 3;
  const ageDays = Math.max(0, (nowMs - ms) / DAY_MS);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

function explainMemorySalienceScore(node, baseScore, opts = {}) {
  const score = Number(baseScore) || 0;
  if (score <= 0) return {
    score,
    factors: [{ name: 'base', value: score }],
  };

  const provenance = classifyMemoryProvenance(node);
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const verifiedLiveTelemetry = (opts.intent || opts.query)
    && provenance.sourceClass === 'telemetry'
    && classifyMemoryDomain(node) === 'current_ops'
    && classifyClaimAuthority(node) === 'verified_current_state';
  const decay = verifiedLiveTelemetry ? 1 : telemetryDecay(node, provenance, nowMs);
  const salienceWeight = verifiedLiveTelemetry ? 1.6 : provenance.salienceWeight;
  const legacyWeighted = score * salienceWeight * decay;
  if (!(opts.intent || opts.query)) {
    return {
      score: legacyWeighted,
      factors: [
        { name: 'base', value: score },
        { name: 'legacy_salience', value: salienceWeight },
        { name: 'legacy_decay', value: decay },
      ],
    };
  }
  const authority = explainMemoryAuthorityScore(node, legacyWeighted, opts);
  return {
    score: authority.score,
    factors: [
      { name: 'base', value: score },
      { name: 'legacy_salience', value: salienceWeight },
      { name: 'legacy_decay', value: decay },
      ...authority.factors.filter((factor) => factor.name !== 'base'),
    ],
  };
}

function scoreMemorySalience(node, baseScore, opts = {}) {
  return explainMemorySalienceScore(node, baseScore, opts).score;
}

module.exports = {
  classifyMemoryProvenance,
  scoreMemorySalience,
  explainMemorySalienceScore,
  classifyMemoryDomain,
  classifyClaimAuthority,
  projectSourceChain,
  scoreMemoryAuthority,
  projectMemoryAuthority,
};
