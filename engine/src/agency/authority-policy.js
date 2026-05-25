const AUTHORITY_LEVELS = Object.freeze(['L0', 'L1', 'L2', 'L3', 'L4']);

export class AuthorityPolicy {
  constructor({ mode = 'dry_run', approvals = [] } = {}) {
    this.mode = mode || 'dry_run';
    this.approvals = new Set(approvals);
  }

  normalizeLevel(level) {
    const value = String(level || 'L1').toUpperCase();
    return AUTHORITY_LEVELS.includes(value) ? value : 'L1';
  }

  evaluate({ authorityLevel = 'L1', action = '', approvalId = null } = {}) {
    const level = this.normalizeLevel(authorityLevel);
    if (this.mode !== 'live') {
      return { allowed: false, level, reason: 'dry_run_records_intent_only' };
    }
    if (level === 'L4') {
      const approved = approvalId && this.approvals.has(String(approvalId));
      return approved
        ? { allowed: true, level, reason: 'explicit_human_approval' }
        : { allowed: false, level, reason: 'requires_human_approval' };
    }
    if (level === 'L3') {
      return { allowed: false, level, reason: 'requires_explicit_policy_expansion' };
    }
    return { allowed: true, level, reason: 'live_low_risk_allowed' };
  }
}

export { AUTHORITY_LEVELS };
