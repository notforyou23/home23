'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CHAIN_REFS = 8;
const MAX_REF_LENGTH = 240;

const MEMORY_DOMAINS = Object.freeze([
  'current_ops',
  'closed_incidents',
  'project_history',
  'external_intake',
]);

const CLAIM_AUTHORITY_CLASSES = Object.freeze([
  'verified_current_state',
  'jtr_correction',
  'artifact_log',
  'worker_receipt',
  'generated_doctrine',
  'narrative',
]);

const DOMAIN_SET = new Set(MEMORY_DOMAINS);
const AUTHORITY_SET = new Set(CLAIM_AUTHORITY_CLASSES);

const GENERATED_TAGS = new Set([
  'reasoning', 'curator', 'critic', 'analyst', 'curiosity', 'proposal',
  'novel_hypothesis', 'novel_implication', 'speculative_hypothesis',
  'synthesis', 'synthesis_report', 'deep_thought', 'introspection',
  'agent_insight', 'analysis_insight', 'consolidated',
]);

const EXTERNAL_TAGS = new Set([
  'jerry_cron_docs', 'cron_docs',
  'news', 'rss', 'twitter', 'x', 'market_signal', 'market-signals',
]);

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function lower(value) {
  return String(value || '').trim().toLowerCase();
}

function isGeneratedMemoryMethod(value) {
  const method = lower(value);
  if (!method) return false;
  if (/(?:^|[^a-z0-9])(?:generated|synthesis|summary|narrative|reflection|report|llm|model|compiler|query|pgs)(?=$|[^a-z0-9]|\d)/.test(method)) {
    return true;
  }
  const compact = method.replace(/[^a-z0-9]/g, '');
  return /(?:generated|query|pgs|compiler|model|llm)/.test(compact)
    && /(?:report|result|output|answer|response|synthesis|summary)/.test(compact);
}

function tagsOf(node) {
  const tags = [];
  if (node?.tag) tags.push(node.tag);
  if (node?.type) tags.push(node.type);
  if (Array.isArray(node?.tags)) tags.push(...node.tags);
  return tags.map(lower).filter(Boolean);
}

function textOf(node) {
  return [
    node?.concept, node?.summary, node?.keyPhrase, node?.title, node?.statement,
    node?.metadata?.source, node?.metadata?.channel, node?.metadata?.kind,
    node?.metadata?.source_path, node?.metadata?.sourcePath,
  ].filter(Boolean).join('\n').toLowerCase();
}

function nodeProfile(node) {
  const metadata = asRecord(node?.metadata);
  const metadataProfile = asRecord(metadata.provenance);
  if (metadataProfile.schema === 'home23.node-provenance.v1') return metadataProfile;
  const provenance = asRecord(node?.provenance);
  const nested = asRecord(provenance.node_profile);
  if (nested.schema === 'home23.node-provenance.v1') return nested;
  if (provenance.schema === 'home23.node-provenance.v1'
      || provenance.authorityClass || provenance.retrievalDomain
      || provenance.sourceRefs || provenance.evidenceRefs
      || provenance.operationalAuthority !== undefined) {
    return provenance;
  }
  return metadataProfile.schema ? metadataProfile : nested;
}

function storedDomain(node) {
  const profile = nodeProfile(node);
  const candidates = [
    profile.retrievalDomain,
    profile.retrieval_domain,
    node?.retrievalDomain,
    node?.retrieval_domain,
    node?.metadata?.retrievalDomain,
    node?.metadata?.retrieval_domain,
  ];
  return candidates.map(lower).find((value) => DOMAIN_SET.has(value)) || null;
}

function storedAuthority(node) {
  const profile = nodeProfile(node);
  const candidates = [
    profile.authorityClass,
    profile.authority_class,
    node?.authorityClass,
    node?.authority_class,
    node?.metadata?.authorityClass,
    node?.metadata?.authority_class,
  ];
  return candidates.map(lower).find((value) => AUTHORITY_SET.has(value)) || null;
}

function provenanceAuthority(node) {
  return asRecord(asRecord(node?.provenance).authority);
}

function isResolution(node) {
  const tags = new Set(tagsOf(node));
  const status = lower(node?.status || node?.metadata?.status);
  return tags.has('goal_resolution')
    || lower(node?.metadata?.kind) === 'goal_resolution'
    || Boolean(node?.metadata?.resolved_at || node?.metadata?.resolutionType)
    || ['resolved', 'completed', 'archived', 'closed', 'superseded'].includes(status);
}

function isGenerated(node) {
  const tags = tagsOf(node);
  if (tags.some((tag) => GENERATED_TAGS.has(tag))) return true;
  const method = lower(nodeProfile(node).generationMethod || nodeProfile(node).generation_method
    || node?.provenance?.generation_method || node?.metadata?.generation_method);
  return isGeneratedMemoryMethod(method);
}

function isExternal(node) {
  const tags = tagsOf(node);
  if (tags.some((tag) => EXTERNAL_TAGS.has(tag))) return true;
  return /\b(?:x digest|x[-_]timeline|twitter|tweet|rss|news digest|market signals?|ticker-|pre-market|portfolio|external intake)\b/.test(textOf(node));
}

function isHistorical(node) {
  const tags = tagsOf(node);
  const temporalStatus = lower(provenanceAuthority(node).temporalStatus);
  return temporalStatus === 'historical'
    || tags.some((tag) => ['historical', 'historical_context', 'historical-context', 'archive', 'project_history'].includes(tag))
    || /(?:^|[\/._-])archive(?:[\/._-]|$)|\/sessions\/|\/dreams\//.test(textOf(node));
}

function hasEvidence(node) {
  const profile = nodeProfile(node);
  return (Array.isArray(profile.evidenceRefs) && profile.evidenceRefs.length > 0)
    || (Array.isArray(profile.evidence_refs) && profile.evidence_refs.length > 0)
    || (Array.isArray(node?.evidence?.evidence_links) && node.evidence.evidence_links.length > 0)
    || (Array.isArray(node?.provenance?.source_refs) && node.provenance.source_refs.length > 0)
    || Boolean(node?.metadata?.content_hash || node?.metadata?.source_hash || node?.metadata?.receipt_id);
}

function hasDirectVerifierEvidence(node) {
  const profile = nodeProfile(node);
  const evidenceRefs = [
    ...(Array.isArray(profile.evidenceRefs) ? profile.evidenceRefs : []),
    ...(Array.isArray(profile.evidence_refs) ? profile.evidence_refs : []),
    ...(Array.isArray(node?.evidence?.evidence_links) ? node.evidence.evidence_links : []),
    ...(Array.isArray(node?.metadata?.verifier_refs) ? node.metadata.verifier_refs : []),
  ].map(lower).filter(Boolean);
  return evidenceRefs.some((ref) => ref.startsWith('verifier:'));
}

function classifyMemoryDomain(node = {}) {
  const explicit = storedDomain(node);
  if (explicit) return explicit;
  if (isResolution(node)) return 'closed_incidents';
  if (isExternal(node)) return 'external_intake';
  if (isHistorical(node)) return 'project_history';
  return 'current_ops';
}

function classifyClaimAuthority(node = {}) {
  const explicit = storedAuthority(node);
  const actor = lower(node?.metadata?.actor || node?.actor || node?.provenance?.actor);

  // Generated prose cannot promote itself through copied current-state flags.
  if (isGenerated(node)) {
    const adopted = node?.metadata?.adopted_doctrine === true
      || nodeProfile(node).adoptedDoctrine === true
      || tagsOf(node).includes('adopted_doctrine');
    return adopted ? 'generated_doctrine' : 'narrative';
  }
  if (explicit) {
    if (explicit === 'verified_current_state' && !hasDirectVerifierEvidence(node)) return 'narrative';
    if (explicit === 'jtr_correction' && actor !== 'jtr') return 'narrative';
    return explicit;
  }

  const correction = node?.metadata?.correction === true
    || nodeProfile(node).jtrCorrection === true;
  if (correction && actor === 'jtr') {
    return 'jtr_correction';
  }

  if (isResolution(node)
      || tagsOf(node).some((tag) => /(?:^|_)receipt$/.test(tag))
      || Boolean(node?.metadata?.receipt_id || node?.metadata?.worker_receipt)) {
    return 'worker_receipt';
  }

  const profile = nodeProfile(node);
  const authority = provenanceAuthority(node);
  const operationalAuthority = profile.operationalAuthority === true
    || authority.presentTenseAuthority === true;
  if (operationalAuthority && hasDirectVerifierEvidence(node)) return 'verified_current_state';

  if (node?.metadata?.source_path || node?.metadata?.sourcePath || node?.metadata?.content_hash
      || node?.metadata?.source_hash || tagsOf(node).some((tag) => ['artifact', 'log', 'raw_log'].includes(tag))) {
    return 'artifact_log';
  }

  if (tagsOf(node).some((tag) => ['doctrine', 'generated_doctrine'].includes(tag))) {
    return 'generated_doctrine';
  }
  return 'narrative';
}

function boundedRef(value) {
  if (value === null || value === undefined) return null;
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return null;
  }
  const trimmed = String(text || '').replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, MAX_REF_LENGTH) : null;
}

function projectSourceChain(node = {}, options = {}) {
  const limit = Math.max(1, Math.min(MAX_CHAIN_REFS, Number(options.limit) || MAX_CHAIN_REFS));
  const profile = nodeProfile(node);
  const candidates = [];
  const append = (kind, values) => {
    for (const value of Array.isArray(values) ? values : [values]) {
      const ref = boundedRef(value);
      if (ref) candidates.push({ kind, ref });
    }
  };

  append('source', profile.sourceRefs || profile.source_refs || []);
  append('source', node?.provenance?.source_refs || []);
  append('source', provenanceAuthority(node).sourceRef);
  append('source', node?.metadata?.source_refs || []);
  append('evidence', profile.evidenceRefs || profile.evidence_refs || []);
  append('evidence', node?.evidence?.evidence_links || []);
  append('artifact', node?.metadata?.source_path || node?.metadata?.sourcePath || profile.sourcePath);
  append('artifact', node?.metadata?.content_hash || node?.metadata?.source_hash || profile.contentHash);
  append('trace', profile.traceId || profile.trace_id || node?.provenance?.trace_id
    || node?.metadata?.trace_id || node?.metadata?.traceId);
  append('generation', profile.generationMethod || profile.generation_method
    || node?.provenance?.generation_method || node?.metadata?.generation_method);
  append('lineage', profile.consolidationSourceIds || profile.consolidation_source_ids
    || node?.metadata?.consolidation_source_ids || node?.provenance?.consolidation_source_ids || []);
  append('verification', profile.verificationRequirements || profile.verification_requirements
    || node?.metadata?.verification_requirements || provenanceAuthority(node).verificationBeforeReuse || []);
  append('closure', profile.closureProofRefs || profile.closure_proof_refs
    || node?.metadata?.closure_proof_refs || node?.metadata?.resolution_proof_refs || []);

  const seen = new Set();
  const result = [];
  const offer = (entry) => {
    const key = `${entry.kind}\0${entry.ref}`;
    if (seen.has(key) || result.length >= limit) return;
    seen.add(key);
    result.push(entry);
  };
  // Reserve one slot per evidence category before filling extras. A long list
  // of source refs must not hide verifier or closure proof from the envelope.
  for (const kind of ['evidence', 'closure', 'trace', 'verification', 'source', 'artifact', 'generation', 'lineage']) {
    const entry = candidates.find((candidate) => candidate.kind === kind);
    if (entry) offer(entry);
  }
  for (const entry of candidates) {
    offer(entry);
    if (result.length >= limit) break;
  }
  return result;
}

function parseTime(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function getSemanticTimeMs(node = {}, options = {}) {
  const profile = nodeProfile(node);
  const authority = provenanceAuthority(node);
  const fields = [
    node?.metadata?.resolved_at, node?.resolved_at,
    ...(options.trustedProjection === true
      && typeof node?.semanticTime === 'string'
      && Buffer.byteLength(node.semanticTime, 'utf8') <= 64
      ? [node.semanticTime]
      : []),
    profile.semanticTime, profile.semantic_time,
    node?.source_event_at, node?.metadata?.source_event_at,
    node?.metadata?.source_time, node?.source_time, authority.producedAt,
    node?.asserted_at, node?.metadata?.asserted_at,
    node?.metadata?.report_time, node?.reported_at, node?.metadata?.reported_at,
    node?.created, node?.created_at, node?.metadata?.created_at,
  ];
  for (const value of fields) {
    const ms = parseTime(value);
    if (ms) return ms;
  }
  return 0;
}

function normalizeRetrievalIntent(intent) {
  const value = lower(intent);
  if (/\b(?:history|historical|recurrence|resolution|closed|incident review|what happened)\b/.test(value)) return 'history';
  if (/\b(?:current|now|today|live|status|health|active|present)\b/.test(value)) return 'current_state';
  return value === 'current_state' ? value : 'general';
}

function explainMemoryAuthorityScore(node, baseScore, options = {}) {
  const base = Number(baseScore) || 0;
  if (base <= 0) return { score: base, factors: [{ name: 'base', value: base }] };

  const domain = classifyMemoryDomain(node);
  const stored = storedAuthority(node);
  const authorityClass = options.trustedProjection === true
    && node?.evidencePresent === true
    && stored === 'verified_current_state'
    ? stored
    : classifyClaimAuthority(node);
  const intent = normalizeRetrievalIntent(options.intent || options.query || 'general');
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();

  const domainWeights = intent === 'current_state'
    ? { current_ops: 1.35, closed_incidents: 0.8, project_history: 0.28, external_intake: 0.08 }
    : intent === 'history'
      ? { current_ops: 1, closed_incidents: 1.25, project_history: 1, external_intake: 0.55 }
      : { current_ops: 1.15, closed_incidents: 1, project_history: 0.75, external_intake: 0.35 };
  const authorityWeights = {
    verified_current_state: 1.5,
    jtr_correction: 1.35,
    artifact_log: 1.2,
    worker_receipt: 1.15,
    generated_doctrine: 0.6,
    narrative: 0.2,
  };
  const halfLifeDays = {
    current_ops: 14,
    closed_incidents: 180,
    project_history: 120,
    external_intake: 2,
  }[domain];
  const semanticTime = getSemanticTimeMs(node, options);
  const ageDays = semanticTime ? Math.max(0, (nowMs - semanticTime) / DAY_MS) : null;
  const freshness = ageDays === null ? 0.65 : Math.max(0.03, Math.pow(0.5, ageDays / halfLifeDays));
  const freshnessBlend = domain === 'external_intake' ? freshness : 0.35 + (0.65 * freshness);
  const profile = nodeProfile(node);
  const needsFreshVerification = profile.requiresFreshVerification === true
    || (Array.isArray(provenanceAuthority(node).verificationBeforeReuse)
      && provenanceAuthority(node).verificationBeforeReuse.includes('check_current_source_of_truth'));
  const guard = intent === 'current_state' && ['generated_doctrine', 'narrative'].includes(authorityClass)
    ? (needsFreshVerification ? 0.3 : 0.45)
    : 1;
  const reportOnly = !hasDirectVerifierEvidence(node)
    && ['generated_doctrine', 'narrative'].includes(authorityClass) ? 0.5 : 1;
  const factors = [
    { name: 'base', value: base },
    { name: `domain:${domain}`, value: domainWeights[domain] },
    { name: `authority:${authorityClass}`, value: authorityWeights[authorityClass] },
    { name: 'freshness', value: freshnessBlend },
    { name: 'current_state_guard', value: guard },
    { name: 'direct_evidence', value: reportOnly },
  ];
  return {
    score: factors.reduce((score, factor) => score * factor.value, 1),
    factors,
  };
}

function scoreMemoryAuthority(node, baseScore, options = {}) {
  return explainMemoryAuthorityScore(node, baseScore, options).score;
}

function projectMemoryAuthority(node = {}, options = {}) {
  const retrievalDomain = classifyMemoryDomain(node);
  const stored = storedAuthority(node);
  const authorityClass = options.trustedProjection === true
    && node?.evidencePresent === true
    && stored === 'verified_current_state'
    ? stored
    : classifyClaimAuthority(node);
  const profile = nodeProfile(node);
  const operationalAuthority = authorityClass === 'verified_current_state';
  const requiresFreshVerification = profile.requiresFreshVerification === true
    || (!operationalAuthority && ['generated_doctrine', 'narrative'].includes(authorityClass));
  const result = {
    schema: 'home23.memory-authority-profile.v1',
    domain: retrievalDomain,
    retrievalDomain,
    authorityClass,
    operationalAuthority,
    requiresFreshVerification,
    semanticTime: getSemanticTimeMs(node, options)
      ? new Date(getSemanticTimeMs(node, options)).toISOString()
      : null,
    sourceChain: projectSourceChain(node, options),
  };
  if (Number.isFinite(options.baseScore)) {
    result.scoreExplanation = explainMemoryAuthorityScore(node, options.baseScore, options);
  }
  return result;
}

module.exports = {
  MEMORY_DOMAINS,
  CLAIM_AUTHORITY_CLASSES,
  classifyMemoryDomain,
  classifyClaimAuthority,
  projectSourceChain,
  scoreMemoryAuthority,
  explainMemoryAuthorityScore,
  getSemanticTimeMs,
  normalizeRetrievalIntent,
  projectMemoryAuthority,
  isGeneratedMemoryMethod,
};
