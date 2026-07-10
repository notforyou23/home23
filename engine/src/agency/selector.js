const ACTIONABLE = /\b(verify|fix|repair|restore|route|worker|receipt|stale|drift|broken|failed|failure|action|pursue|publish|contradiction|watch)\b/i;

export class AgencySelector {
  select(candidate, { existing = null, budget = null } = {}) {
    if (!candidate.summary) {
      return { route: 'discard', reason: 'empty_candidate' };
    }
    if (candidate.explicitNoChange) {
      return { route: 'discard', reason: 'explicit_no_change' };
    }
    if (candidate.kind === 'discarded_by_chat') {
      return { route: 'discard', reason: 'operator_discarded_candidate' };
    }
    if (existing) {
      return { route: existing.status === 'watch' ? 'watch' : 'pursue', reason: 'merged_with_existing_pursuit' };
    }
    if (candidate.authorityLevel === 'L4') {
      return { route: 'request-authority', reason: 'high_authority_requires_operator' };
    }
    if (isRawTelemetryObservation(candidate)) {
      return { route: 'discard', reason: 'raw_observation_not_attention' };
    }
    if (isMechanicalCronNoChange(candidate)) {
      return { route: 'discard', reason: 'mechanical_cron_no_change_not_attention' };
    }
    let route = 'discard';
    let reason = 'no_changed_future_detected';
    if (
      candidate.desiredChangedFuture ||
      ACTIONABLE.test(candidate.summary) ||
      candidate.source?.startsWith('work.') ||
      candidate.source === 'x.timeline' ||
      candidate.source === 'curriculum' ||
      candidate.tags.includes('good-life')
    ) {
      route = 'pursue';
      reason = 'actionable_candidate_with_evidence_or_governance_signal';
    } else if (candidate.tags.includes('cron-report') || candidate.tags.includes('research')) {
      route = 'watch';
      reason = 'report_or_research_signal_needs_continuity';
    } else if (candidate.evidence.length > 0) {
      route = 'watch';
      reason = 'observed_signal_without_changed_future';
    }

    if (budget && route === 'pursue' && Number(budget.activeCount || 0) >= Number(budget.maxActivePursuits || 0)) {
      return { route: 'defer', reason: 'active_attention_budget_exhausted' };
    }
    if (budget && route === 'watch' && Number(budget.watchCount || 0) >= Number(budget.maxWatchItems || 0)) {
      return { route: 'defer', reason: 'watch_attention_budget_exhausted' };
    }
    return { route, reason };
  }
}

function isRawTelemetryObservation(candidate = {}) {
  if (candidate.kind !== 'observation') return false;
  if (candidate.desiredChangedFuture || candidate.stopCondition || candidate.changedFuture) return false;
  const source = String(candidate.source || '');
  return source.startsWith('machine.')
    || source.startsWith('os.')
    || (source.startsWith('domain.') && source !== 'domain.good-life')
    || source === 'work.agenda'
    || source === 'work.heartbeat';
}

function isSyntheticCronBindingFuture(text = '') {
  return /cron outcome updates (?:a bound )?resident pursuit/i.test(String(text));
}

function isMechanicalCronNoChange(candidate = {}) {
  if (candidate.kind !== 'cron_report') return false;
  if (candidate.stopCondition || candidate.changedFuture) return false;
  const source = String(candidate.source || '');
  const summary = String(candidate.summary || '');
  if (!source.startsWith('cron.') || !/finished with status ok/i.test(summary)) return false;
  // Real intake/operator desired futures keep attention. Synthetic bootcamp binding
  // futures ("Cron outcome updates resident pursuit ap_…") and summary-placeholder
  // desired futures do not — pursuitId alone is not an actionable changed future.
  const desired = String(candidate.desiredChangedFuture || '').trim();
  if (desired && desired !== summary.trim() && !isSyntheticCronBindingFuture(desired)) {
    return false;
  }
  return true;
}
