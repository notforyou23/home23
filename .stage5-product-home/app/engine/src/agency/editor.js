export class AgencyEditor {
  constructor({ charter = {} } = {}) {
    this.charter = charter;
  }

  evaluate(pursuit = {}) {
    const text = `${pursuit.title || ''} ${pursuit.summary || ''}`.toLowerCase();
    const kind = String(pursuit.kind || '').toLowerCase();
    const source = String(pursuit.source || '').toLowerCase();
    const skeleton = this.charter.editor?.repeatedNewsletterSkeleton || [];
    const dashboardClarityKinds = new Set(this.charter.editor?.dashboardAgencyClarityKinds || []);
    const requireConsequence = new Set(this.charter.editor?.requireConsequenceFor || []);
    const hasDeclaredChangedFuture = pursuit.declaredChangedFuture === true
      || Boolean(pursuit.changedFuture)
      || (Boolean(pursuit.desiredChangedFuture) && pursuit.desiredChangedFuture !== pursuit.summary);

    const exhaustedNewsletterFrame =
      skeleton.filter(term => text.includes(term)).length >= 2 ||
      (text.includes('home23') && text.includes('becomes') && text.includes('feedback loop'));
    if ((kind === 'newsletter_draft' || source === 'newsletter') && exhaustedNewsletterFrame) {
      return {
        verdict: 'veto',
        reason: 'newsletter_repeats_exhausted_feedback_loop_skeleton',
        action: 'require_consequence',
      };
    }

    if (pursuit.status === 'watch' && Number(pursuit.seenCount || 0) > 20) {
      return {
        verdict: 'kill',
        reason: 'watch_item_repeated_without_consequence',
        action: 'kill_stale_thread',
      };
    }

    const isDashboardExpansion = source === 'dashboard' || dashboardClarityKinds.has(kind) || pursuit.tags?.includes('dashboard');
    if (isDashboardExpansion && !hasDeclaredChangedFuture) {
      return {
        verdict: 'demote',
        reason: 'dashboard_panel_lacks_agency_clarity',
        action: 'demote_ornamental_dashboard_panel',
      };
    }

    if (requireConsequence.has(kind) && !hasDeclaredChangedFuture) {
      return {
        verdict: 'demote',
        reason: 'output_has_no_declared_changed_future',
        action: 'require_consequence',
      };
    }

    return {
      verdict: 'allow',
      reason: 'pursuit_has_no_editor_block',
      action: 'advance_one_step',
    };
  }
}
