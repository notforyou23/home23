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

  summarize(claims = []) {
    return {
      currentSourceHierarchy: [...this.hierarchy],
      unresolvedContradictions: claims.filter(claim => claim.contradicts && claim.status !== 'resolved').length,
      recentBeliefChanges: claims.slice(-10).reverse(),
    };
  }
}
