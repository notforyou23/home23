import { createHash, randomUUID } from 'node:crypto';

function nowIso() {
  return new Date().toISOString();
}

function stableId(input) {
  return createHash('sha256').update(String(input || randomUUID())).digest('hex').slice(0, 12);
}

export class SourceTruthHierarchy {
  constructor({ hierarchy = [] } = {}) {
    this.hierarchy = hierarchy.length ? hierarchy : [
      'current_verified_state',
      'jtr_correction',
      'verifier_receipt',
      'worker_receipt',
      'source_artifact',
      'generated_doctrine',
      'narrative',
    ];
  }

  rank(sourceType) {
    const idx = this.hierarchy.indexOf(sourceType);
    return idx >= 0 ? idx : this.hierarchy.length;
  }

  claim(input = {}) {
    const at = input.at || nowIso();
    const sourceType = input.sourceType || 'generated_doctrine';
    return {
      schema: 'home23.agency.truth-claim.v1',
      id: input.id || `claim_${stableId(`${input.claim}|${sourceType}|${at}`)}`,
      claim: String(input.claim || '').trim(),
      sourceType,
      sourceRef: input.sourceRef || null,
      authorityRank: this.rank(sourceType),
      contradicts: input.contradicts || null,
      status: input.status || (input.contradicts ? 'contested' : 'current'),
      acceptedAt: at,
      decay: input.decay || null,
    };
  }

  settleClaim(input = {}, existingClaims = []) {
    const claim = this.claim(input);
    const latest = this.latestClaims(existingClaims);
    const target = claim.contradicts
      ? latest.find(row => row.id === claim.contradicts)
      : null;
    const superseded = [];

    if (!target) {
      return { claim, superseded };
    }

    if (claim.authorityRank < Number(target.authorityRank ?? this.rank(target.sourceType))) {
      const at = claim.acceptedAt || nowIso();
      claim.status = input.status || 'current';
      claim.resolvesContradiction = target.id;
      superseded.push({
        ...target,
        status: 'superseded',
        supersededBy: claim.id,
        supersededAt: at,
        supersessionReason: 'higher_authority_claim',
      });
    } else {
      claim.status = input.status || 'contested';
      claim.contestedAgainst = target.id;
    }

    return { claim, superseded };
  }

  latestClaims(claims = []) {
    const latest = new Map();
    for (const claim of claims) {
      if (claim?.id) latest.set(claim.id, claim);
    }
    return Array.from(latest.values());
  }

  summarize(claims = []) {
    const latest = this.latestClaims(claims);
    const stale = latest
      .filter(claim => claim.status === 'current' && isStaleClaim(claim))
      .map(claim => ({
        id: claim.id,
        claim: claim.claim,
        sourceType: claim.sourceType,
        sourceRef: claim.sourceRef,
        staleAt: claim.decay?.staleAt || null,
        decayReason: claim.decay?.reason || 'claim_decay_policy_elapsed',
      }));
    const staleIds = new Set(stale.map(claim => claim.id));
    const currentClaims = latest
      .filter(claim => claim.status === 'current' && !staleIds.has(claim.id))
      .sort((a, b) => {
        const byRank = Number(a.authorityRank ?? this.rank(a.sourceType)) - Number(b.authorityRank ?? this.rank(b.sourceType));
        if (byRank !== 0) return byRank;
        return String(b.acceptedAt || '').localeCompare(String(a.acceptedAt || ''));
      });
    const unresolved = latest.filter(claim => claim.contradicts && claim.status !== 'resolved' && claim.status !== 'superseded' && !claim.resolvesContradiction);
    const superseded = latest.filter(claim => claim.status === 'superseded');
    return {
      currentSourceHierarchy: [...this.hierarchy],
      unresolvedContradictions: unresolved.length,
      supersededClaims: superseded.length,
      staleClaims: stale.length,
      staleClaimRefs: stale.slice(0, 20),
      currentClaims: currentClaims.slice(0, 20),
      unresolvedClaims: unresolved.slice(-20).reverse(),
      recentBeliefChanges: latest.slice(-10).reverse(),
    };
  }
}

function isStaleClaim(claim = {}) {
  const staleAt = claim.decay?.staleAt || claim.decay?.expiresAt || null;
  if (staleAt && !Number.isNaN(new Date(staleAt).getTime())) {
    return Date.now() >= new Date(staleAt).getTime();
  }
  const hours = Number(claim.decay?.staleAfterHours || 0);
  if (hours > 0 && claim.acceptedAt && !Number.isNaN(new Date(claim.acceptedAt).getTime())) {
    return Date.now() >= new Date(claim.acceptedAt).getTime() + hours * 60 * 60 * 1000;
  }
  return false;
}
