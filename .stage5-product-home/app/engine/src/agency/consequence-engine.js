export class ConsequenceEngine {
  constructor({ charter = {} } = {}) {
    this.charter = charter;
  }

  evaluate(pursuit, transition = {}) {
    const evidence = Array.isArray(transition.evidence) ? transition.evidence : [];
    const changed = transition.status === 'closed' || evidence.length > 0 || Boolean(transition.consequence);
    return {
      changed,
      pursuitId: pursuit?.id || null,
      summary: transition.summary || transition.reason || null,
      evidence,
    };
  }

  arbitrateDelta(input = {}, authority = { allowed: false, level: 'L1', reason: 'unknown' }, mode = 'dry_run') {
    const level = authority.level || input.authorityLevel || 'L1';
    const reversible = input.reversible !== false;
    const highRisk = level === 'L4' || reversible === false || requiresApproval(input.changeType, this.charter);
    if (highRisk) {
      return {
        route: 'requires_approval',
        reason: 'delta_exceeds_autonomous_authority',
        apply: false,
      };
    }
    if (mode !== 'live') {
      return {
        route: 'approved_dry_run',
        reason: 'bounded_delta_recorded_without_execution',
        apply: false,
      };
    }
    if (authority.allowed) {
      return {
        route: 'approved_live',
        reason: 'bounded_reversible_delta_allowed',
        apply: true,
      };
    }
    return {
      route: 'blocked_by_authority',
      reason: authority.reason || 'authority_policy_blocked',
      apply: false,
    };
  }
}

function requiresApproval(changeType, charter = {}) {
  const approvals = new Set(charter.authority?.requiresApproval || []);
  return approvals.has(changeType);
}
