export class AgencyEditor {
  constructor({ charter = {} } = {}) {
    this.charter = charter;
  }

  evaluate(pursuit = {}) {
    const text = `${pursuit.title || ''} ${pursuit.summary || ''}`.toLowerCase();
    const kind = String(pursuit.kind || '').toLowerCase();
    const source = String(pursuit.source || '').toLowerCase();
    const skeleton = this.charter.editor?.repeatedNewsletterSkeleton || [];
    const requireConsequence = new Set(this.charter.editor?.requireConsequenceFor || []);

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

    if (requireConsequence.has(kind) && !pursuit.desiredChangedFuture) {
      return {
        verdict: 'demote',
        reason: 'output_has_no_declared_changed_future',
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

    return {
      verdict: 'allow',
      reason: 'pursuit_has_no_editor_block',
      action: 'advance_one_step',
    };
  }
}
