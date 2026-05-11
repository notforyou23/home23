'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { RECEIPT_VERSION, canonicalJson } = require('../evidence/evidence-v1');

const TRUST_EVENT_SCHEMA = 'home23.trust-event.v1';
const TRUST_CLAIM_SCHEMA = 'home23.trust-claim.v1';

const TRUST_STATUSES = Object.freeze({
  RAW_OBSERVATION: 'raw_observation',
  CANDIDATE_CLAIM: 'candidate_claim',
  KNOWN_VERIFIED: 'known_verified',
  KNOWN_UNVERIFIED: 'known_unverified',
  KNOWN_STALE: 'known_stale',
  KNOWN_CONFLICTED: 'known_conflicted',
  KNOWN_SUPERSEDED: 'known_superseded',
  UNKNOWN_BUT_EXPECTED: 'unknown_but_expected',
  UNKNOWN_NOT_APPLICABLE: 'unknown_not_applicable',
  DURABLE_MEMORY: 'durable_memory',
});

const SAFE_STATUSES = new Set([
  TRUST_STATUSES.KNOWN_VERIFIED,
  TRUST_STATUSES.DURABLE_MEMORY,
]);

const CONSEQUENTIAL_SCOPES = new Set([
  'autonomous_action',
  'durable_memory',
  'live_problem',
  'project_status',
  'public_artifact',
  'schedule',
  'user_facing_status',
  'personal_context',
]);

const TRUST_AUTHORITY_RANKS = Object.freeze({
  inherited_assumption: 10,
  machine_observation: 30,
  agent_inference: 40,
  verified_receipt: 60,
  user_correction: 90,
  operator_override: 100,
});

class TrustKernel {
  constructor(opts = {}) {
    if (!opts.storePath && !opts.brainDir) {
      throw new Error('TrustKernel requires storePath or brainDir');
    }
    this.storePath = opts.storePath
      ? path.resolve(opts.storePath)
      : path.join(path.resolve(opts.brainDir), 'trust', 'claims.jsonl');
    this.logger = opts.logger || null;
  }

  recordClaim(claim, opts = {}) {
    const normalized = normalizeClaim(claim);
    const event = {
      schema: TRUST_EVENT_SCHEMA,
      eventId: opts.eventId || crypto.randomUUID(),
      eventType: opts.eventType || 'claim.observed',
      createdAt: opts.createdAt || new Date().toISOString(),
      claim: normalized,
    };
    if (opts.causedBy) event.causedBy = opts.causedBy;
    this._append(event);
    return normalized;
  }

  recordVerifiedClaim({ claim, receipt, receiptPath, causedBy, createdAt } = {}) {
    const resolvedReceipt = receipt || readReceipt(receiptPath);
    const evidenceRef = evidenceRefFromReceipt(resolvedReceipt, receiptPath);
    const status = evidenceRef.verified
      ? TRUST_STATUSES.KNOWN_VERIFIED
      : TRUST_STATUSES.KNOWN_UNVERIFIED;
    const existingEvidence = Array.isArray(claim?.evidenceRefs) ? claim.evidenceRefs : [];
    return this.recordClaim({
      ...claim,
      status,
      evidenceRefs: [...existingEvidence, evidenceRef],
    }, {
      eventType: evidenceRef.verified ? 'claim.verified' : 'claim.verification_failed',
      causedBy,
      createdAt,
    });
  }

  explain(claimRef, opts = {}) {
    const now = parseTime(opts.now) || Date.now();
    const projection = this.projectClaim(claimRef, { now });
    if (!projection.claim) {
      return {
        claimId: claimRef,
        status: TRUST_STATUSES.UNKNOWN_BUT_EXPECTED,
        safeToInherit: false,
        claim: null,
        evidence: [],
        conflicts: [],
        reasons: ['claim_not_found'],
        freshness: null,
        recommendedAction: 'record_or_refresh_claim',
      };
    }
    return projection;
  }

  projectClaim(claimRef, opts = {}) {
    const now = parseTime(opts.now) || Date.now();
    const events = this.readEvents();
    const latestById = latestClaimsById(events);
    const claim = latestById.get(claimRef);
    if (!claim) return { claim: null };

    const evidence = evidenceRefsWithVerification(claim.evidenceRefs || []);
    const freshness = freshnessState(claim, now);
    const conflicts = findConflicts(claim, latestById, now);
    const blockingConflicts = conflicts.filter((conflict) => conflict.resolution !== 'current_claim_overrides_lower_authority');
    const reasons = [];
    let status = effectiveStatusWithoutConflicts(claim, now);

    if (freshness.stale) {
      status = TRUST_STATUSES.KNOWN_STALE;
      reasons.push('freshness_ttl_expired');
    }
    if (blockingConflicts.length > 0) {
      status = TRUST_STATUSES.KNOWN_CONFLICTED;
      reasons.push('claim_conflict_detected');
      if (blockingConflicts.some((conflict) => conflict.resolution === 'higher_authority_claim_overrides_current')) {
        reasons.push('higher_authority_correction_present');
      }
    } else if (conflicts.length > 0) {
      reasons.push('lower_authority_conflict_overridden');
    }

    const hasVerifiedReceipt = evidence.some((ref) => ref.verified);
    if (!SAFE_STATUSES.has(status)) reasons.push('claim_not_verified');
    if (isConsequential(claim) && !hasVerifiedReceipt) {
      reasons.push('consequential_claim_requires_verified_receipt');
    }
    reasons.push(...analogyDisciplineReasons(claim));
    if (claim.privacyClass === 'sensitive' && claim.scope === 'public_artifact') {
      reasons.push('sensitive_claim_cannot_be_public_artifact');
    }

    const blockers = new Set([
      'claim_not_verified',
      'consequential_claim_requires_verified_receipt',
      'freshness_ttl_expired',
      'claim_conflict_detected',
      'sensitive_claim_cannot_be_public_artifact',
      'analogy_requires_structural_mapping',
      'analogy_requires_mechanism',
      'analogy_requires_falsifiable_predictions',
    ]);
    const safeToInherit = reasons.every((reason) => !blockers.has(reason));

    return {
      claimId: claim.id,
      status,
      safeToInherit,
      claim,
      evidence,
      conflicts,
      reasons,
      freshness,
      recommendedAction: recommendedAction(reasons),
    };
  }

  listConflicts(opts = {}) {
    const now = parseTime(opts.now) || Date.now();
    const latestById = latestClaimsById(this.readEvents());
    const out = [];
    for (const claim of latestById.values()) {
      const conflicts = findConflicts(claim, latestById, now);
      if (conflicts.length > 0) out.push({ claimId: claim.id, conflicts });
    }
    return out;
  }

  readEvents() {
    if (!fs.existsSync(this.storePath)) return [];
    try {
      return fs.readFileSync(this.storePath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter((event) => event?.schema === TRUST_EVENT_SCHEMA && event?.claim?.id);
    } catch (err) {
      this.logger?.warn?.('[trust-kernel] read failed', { error: err?.message });
      return [];
    }
  }

  _append(event) {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    fs.appendFileSync(this.storePath, `${JSON.stringify(event)}\n`, 'utf8');
  }
}

function normalizeClaim(claim = {}) {
  if (!claim.type) throw new Error('claim.type required');
  if (!claim.subject) throw new Error('claim.subject required');
  if (!claim.predicate) throw new Error('claim.predicate required');
  const observedAt = claim.observedAt || new Date().toISOString();
  const normalized = compactObject({
    schema: TRUST_CLAIM_SCHEMA,
    id: claim.id || buildClaimId(claim),
    type: String(claim.type),
    subject: String(claim.subject),
    predicate: String(claim.predicate),
    value: claim.value,
    actor: String(claim.actor || 'unknown'),
    observedAt,
    sourceRefs: Array.isArray(claim.sourceRefs) ? claim.sourceRefs : [],
    evidenceRefs: Array.isArray(claim.evidenceRefs) ? claim.evidenceRefs : [],
    confidence: Number.isFinite(claim.confidence) ? claim.confidence : null,
    freshnessTTL: normalizeTtl(claim.freshnessTTL),
    scope: String(claim.scope || 'operational_internal'),
    authority: normalizeAuthority(claim.authority || inferAuthority(claim)),
    actionPosture: String(claim.actionPosture || inferActionPosture(claim)),
    privacyClass: String(claim.privacyClass || 'operational_internal'),
    verifier: claim.verifier || null,
    analogy: normalizeAnalogy(claim.analogy),
    status: claim.status || TRUST_STATUSES.CANDIDATE_CLAIM,
    supersedes: claim.supersedes || null,
    contradicts: claim.contradicts || null,
  });
  return normalized;
}

function normalizeAnalogy(analogy) {
  if (!analogy || typeof analogy !== 'object') return null;
  return compactObject({
    sourceDomain: analogy.sourceDomain ? String(analogy.sourceDomain) : null,
    targetDomain: analogy.targetDomain ? String(analogy.targetDomain) : null,
    structuralMapping: Array.isArray(analogy.structuralMapping) ? analogy.structuralMapping : [],
    mechanism: analogy.mechanism ? String(analogy.mechanism) : null,
    falsifiablePredictions: Array.isArray(analogy.falsifiablePredictions) ? analogy.falsifiablePredictions.map(String).filter(Boolean) : [],
    limits: Array.isArray(analogy.limits) ? analogy.limits.map(String).filter(Boolean) : [],
  });
}

function analogyDisciplineReasons(claim = {}) {
  if (claim.type !== 'analogy_hypothesis') return [];
  const analogy = claim.analogy || {};
  const reasons = [];
  if (!Array.isArray(analogy.structuralMapping) || analogy.structuralMapping.length === 0) {
    reasons.push('analogy_requires_structural_mapping');
  }
  if (!analogy.mechanism) {
    reasons.push('analogy_requires_mechanism');
  }
  if (!Array.isArray(analogy.falsifiablePredictions) || analogy.falsifiablePredictions.length === 0) {
    reasons.push('analogy_requires_falsifiable_predictions');
  }
  return reasons;
}

function buildClaimId(claim) {
  const base = canonicalJson({
    type: claim.type,
    subject: claim.subject,
    predicate: claim.predicate,
    value: claim.value,
  });
  return `cl_${sha256(base).slice(0, 24)}`;
}

function evidenceRefFromReceipt(receipt, receiptPath) {
  const verified = receipt?.receiptVersion === RECEIPT_VERSION
    && receipt?.result === 'pass'
    && (receipt?.claimLevel === 'verified_claim' || receipt?.claimLevel === 'durable_memory');
  return compactObject({
    type: 'evidence_receipt',
    receiptVersion: receipt?.receiptVersion || null,
    receiptId: receipt?.receiptId || null,
    path: receiptPath ? path.resolve(receiptPath) : null,
    subject: receipt?.subject || null,
    action: receipt?.action || null,
    result: receipt?.result || null,
    claimLevel: receipt?.claimLevel || null,
    createdAt: receipt?.createdAt || null,
    verified,
  });
}

function evidenceRefsWithVerification(refs) {
  return refs.map((ref) => {
    if (ref?.type === 'evidence_receipt' && ref.verified === true) return ref;
    if (ref?.type === 'evidence_receipt' && ref.path && fs.existsSync(ref.path)) {
      const receipt = readReceipt(ref.path);
      return { ...ref, ...evidenceRefFromReceipt(receipt, ref.path) };
    }
    return { ...ref, verified: false };
  });
}

function readReceipt(receiptPath) {
  if (!receiptPath) return null;
  try {
    return JSON.parse(fs.readFileSync(path.resolve(receiptPath), 'utf8'));
  } catch {
    return null;
  }
}

function latestClaimsById(events) {
  const latest = new Map();
  for (const event of events) latest.set(event.claim.id, event.claim);
  return latest;
}

function findConflicts(claim, latestById, now) {
  if (!claim) return [];
  if (!SAFE_STATUSES.has(effectiveStatusWithoutConflicts(claim, now))) return [];
  const out = [];
  for (const other of latestById.values()) {
    if (other.id === claim.id) continue;
    if (other.type !== claim.type) continue;
    if (other.subject !== claim.subject) continue;
    if (other.predicate !== claim.predicate) continue;
    if (!SAFE_STATUSES.has(effectiveStatusWithoutConflicts(other, now))) continue;
    if (canonicalJson(other.value) === canonicalJson(claim.value)) continue;
    const resolution = compareAuthority(claim, other);
    out.push({
      claimId: other.id,
      status: other.status,
      value: other.value,
      actor: other.actor,
      observedAt: other.observedAt,
      authority: other.authority || inferAuthority(other),
      actionPosture: other.actionPosture || inferActionPosture(other),
      resolution,
    });
  }
  return out;
}

function compareAuthority(current, other) {
  const currentRank = authorityRank(current);
  const otherRank = authorityRank(other);
  if (currentRank > otherRank) return 'current_claim_overrides_lower_authority';
  if (otherRank > currentRank) return 'higher_authority_claim_overrides_current';
  return 'same_authority_requires_reconciliation';
}

function effectiveStatusWithoutConflicts(claim, now) {
  if (claim.status === TRUST_STATUSES.KNOWN_SUPERSEDED) return TRUST_STATUSES.KNOWN_SUPERSEDED;
  const freshness = freshnessState(claim, now);
  if (freshness.stale) return TRUST_STATUSES.KNOWN_STALE;
  return claim.status || TRUST_STATUSES.CANDIDATE_CLAIM;
}

function freshnessState(claim, now) {
  const ttlMs = normalizeTtl(claim.freshnessTTL);
  const observedAtMs = parseTime(claim.observedAt);
  if (!ttlMs || !observedAtMs) {
    return {
      observedAt: claim.observedAt || null,
      ttlMs: ttlMs || null,
      ageMs: observedAtMs ? Math.max(0, now - observedAtMs) : null,
      expiresAt: null,
      stale: false,
    };
  }
  const expiresAtMs = observedAtMs + ttlMs;
  return {
    observedAt: claim.observedAt,
    ttlMs,
    ageMs: Math.max(0, now - observedAtMs),
    expiresAt: new Date(expiresAtMs).toISOString(),
    stale: now > expiresAtMs,
  };
}

function recommendedAction(reasons) {
  if (reasons.includes('higher_authority_correction_present')) return 'accept_higher_authority_correction';
  if (reasons.includes('claim_conflict_detected')) return 'write_reconciliation_receipt';
  if (reasons.includes('freshness_ttl_expired')) return 'refresh_claim_verification';
  if (reasons.includes('sensitive_claim_cannot_be_public_artifact')) return 'redact_or_reclassify_claim';
  if (reasons.some((reason) => reason.startsWith('analogy_requires_'))) return 'refine_analogy_hypothesis';
  if (reasons.includes('consequential_claim_requires_verified_receipt')) return 'run_or_attach_verifier_receipt';
  if (reasons.includes('claim_not_verified')) return 'run_or_attach_verifier_receipt';
  return null;
}

function normalizeAuthority(value) {
  const key = String(value || '').trim();
  return TRUST_AUTHORITY_RANKS[key] ? key : 'agent_inference';
}

function inferAuthority(claim = {}) {
  const actor = String(claim.actor || '').toLowerCase();
  if (actor === 'jtr' || actor === 'user') return 'user_correction';
  if (claim.status === TRUST_STATUSES.KNOWN_VERIFIED || Array.isArray(claim.evidenceRefs) && claim.evidenceRefs.length > 0) {
    return 'verified_receipt';
  }
  if (claim.type === 'observation' || String(claim.type || '').includes('observation')) return 'machine_observation';
  return 'agent_inference';
}

function inferActionPosture(claim = {}) {
  if (claim.authority === 'user_correction') return 'inherit_for_subject_only';
  if (claim.status === TRUST_STATUSES.RAW_OBSERVATION || claim.status === TRUST_STATUSES.CANDIDATE_CLAIM) return 'verify_before_action';
  if (isConsequential(claim)) return 'inherit_only_with_fresh_receipt';
  return 'context_only';
}

function authorityRank(claim = {}) {
  return TRUST_AUTHORITY_RANKS[normalizeAuthority(claim.authority || inferAuthority(claim))] || 0;
}

function isConsequential(claim) {
  return CONSEQUENTIAL_SCOPES.has(claim.scope);
}

function normalizeTtl(value) {
  if (value === undefined || value === null || value === '') return null;
  if (Number.isFinite(value)) return value > 0 ? value : null;
  const raw = String(value).trim();
  const match = raw.match(/^(\d+)(ms|s|m|h|d)?$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] || 'ms').toLowerCase();
  const factors = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return amount * factors[unit];
}

function parseTime(value) {
  if (!value) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function compactObject(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

module.exports = {
  CONSEQUENTIAL_SCOPES,
  TRUST_CLAIM_SCHEMA,
  TRUST_EVENT_SCHEMA,
  TRUST_STATUSES,
  TrustKernel,
  TRUST_AUTHORITY_RANKS,
  _test: {
    authorityRank,
    evidenceRefFromReceipt,
    freshnessState,
    normalizeClaim,
    normalizeTtl,
  },
};
