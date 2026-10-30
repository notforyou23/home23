/** Prospective, attributable learning. Legacy plasticity remains replayable;
 * these receipts change scoped decision state without repurposing old deltas. */
import type { SourceEvent } from './types.js';
import type { DevelopmentalState } from './plasticity.js';
import { emptyCellPlasticState } from './plasticity.js';
import { normalizeLearningDecision, normalizeLearningFeedback, normalizeLearningState, recordLearningDecision, applyLearningFeedback, executionTargetTag, learningStateWithinBudget, isConductLearningDecision } from '../../shared/seed-learning.cjs';

export function experienceCells(development: DevelopmentalState, before?: DevelopmentalState): Record<string, unknown> {
  return Object.fromEntries(Object.entries(development).filter(([, p]) => p.experience !== undefined)
    .filter(([id, p]) => before === undefined || JSON.stringify(p.experience) !== JSON.stringify(before[id]?.experience))
    .map(([id, p]) => [id, structuredClone(p.experience)]));
}

export function applyExperienceEvent(development: DevelopmentalState, event: SourceEvent, routedCellId: string): Record<string, unknown> | null {
  if (event.payload['learningVersion'] !== 2) return null;
  const trusted = ['home23.event-ledger', 'home23.engine', 'home23.agent.loop'].includes(event.sourceAuthority);
  if (!trusted) return { rule: 'experience.v1', applied: false, reason: 'untrusted_learning_source' };
  const rawDecision = normalizeLearningDecision(event.payload['learningDecision']);
  const feedback = normalizeLearningFeedback(event.payload['learning']);
  let cellId = routedCellId;
  const conductDecision = isConductLearningDecision(rawDecision);
  if (conductDecision) {
    // The existing cell that first receives a prospective conversational choice
    // owns this policy thereafter. Metabolic routing can keep changing without
    // scattering one policy into independently accumulating contributions.
    const anchors = Object.entries(development).filter(([, p]) => p.experience?.conductAnchor === true
      || p.experience?.conductCredits !== undefined);
    if (anchors.length > 1) return { rule: 'experience.v1', applied: false, reason: 'conduct_anchor_conflict' };
    const priorConductCells = anchors.length ? anchors : Object.entries(development).filter(([, p]) =>
      p.experience?.decisions.some(isConductLearningDecision) || p.experience?.lessons.some(lesson => isConductLearningDecision(lesson.eligibility)));
    if (priorConductCells.length > 1) return { rule: 'experience.v1', applied: false, reason: 'conduct_anchor_conflict' };
    cellId = priorConductCells[0]?.[0] ?? routedCellId;
  }
  if (feedback?.decisionId) {
    cellId = Object.entries(development).find(([, p]) => p.experience?.decisions.some(d => d.decisionId === feedback.decisionId)
      || p.experience?.lessons.some(lesson => lesson.eligibility?.decisionId === feedback.decisionId))?.[0] ?? routedCellId;
  }
  const trial = event.payload['outcomeCriterion'] === 'execution' ? event.payload['outcomeTrialId'] : null;
  if (typeof trial === 'string') cellId = Object.entries(development)
    .find(([, p]) => p.experience?.decisions.some(decision => decision.decisionId === trial))?.[0] ?? cellId;
  const existing = development[cellId];
  if (rawDecision) {
    // Runtime provenance, semantic source tags and refs are the eligibility
    // witness. Do not use the cell's later mixed numeric residue as credit.
    const occurrence = typeof event.payload['learningStream'] === 'string' && Number.isSafeInteger(event.payload['learningSequence'])
      && (event.payload['learningSequence'] as number) >= 0
      ? { stream: event.payload['learningStream'], sequence: event.payload['learningSequence'] as number } : undefined;
    const result = recordLearningDecision(existing?.experience, { ...rawDecision, cellId,
      observedAt: conductDecision ? event.producedAt : rawDecision.observedAt ?? event.producedAt,
      ...(conductDecision ? { occurrence } : {}) });
    if (result.applied) {
      if (conductDecision) result.state.conductAnchor = true;
      if (!learningStateWithinBudget(result.state)) return { rule: 'experience.v1', applied: false, reason: 'learning_state_capacity', cellId };
      const p = existing ?? emptyCellPlasticState(); p.experience = result.state; development[cellId] = p;
    }
    const deferred: string[] = [];
    const deferredRefused: Array<{ feedbackId: string; reason: string }> = [];
    // Source adapters advance independently. A relationship event can precede
    // its already-committed decision projection; retain it until the witness
    // arrives instead of manufacturing a target or silently losing teaching.
    for (const [pendingCellId, plastic] of Object.entries(development)) {
      for (const pending of plastic.experience?.pendingFeedback ?? []) {
        if (pending.feedback.decisionId !== rawDecision.decisionId) continue;
        const target = development[cellId] ?? emptyCellPlasticState();
        // This exact authenticated feedback was admitted to the pending queue
        // before a newer stream watermark. It has not received credit yet.
        // Keep its ID dedupe, but do not confuse delayed eligibility with a
        // lost-cursor replay or move the newer watermark backwards.
        const { stream: _stream, sequence: _sequence, ...admittedPending } = pending.authority;
        const applied = applyLearningFeedback(target.experience, pending.feedback, { ...admittedPending,
          ...(isConductLearningDecision(rawDecision) && typeof _stream === 'string' && typeof _sequence === 'number'
            ? { occurrence: { stream: _stream, sequence: _sequence } } : {}) });
        if (applied.applied) {
          target.experience = applied.state; development[cellId] = target;
          const source = development[pendingCellId]?.experience;
          if (source) source.pendingFeedback = source.pendingFeedback.filter(item => item.authority.feedbackId !== pending.authority.feedbackId);
          deferred.push(pending.authority.feedbackId);
        } else if (conductDecision && ['conduct_trial_already_credited', 'conduct_revision_precedes_feedback_watermark',
          'conduct_context_invalid', 'standing_conduct_instruction_requires_revision', 'conduct_corroboration_requires_new_feedback']
          .includes(applied.reason)) {
          // This admitted source cannot become applicable by retrying it. Keep
          // its refusal in the receipt, rather than exhausting pending slots.
          const source = development[pendingCellId]?.experience;
          if (source) source.pendingFeedback = source.pendingFeedback.filter(item => item.authority.feedbackId !== pending.authority.feedbackId);
          deferredRefused.push({ feedbackId: pending.authority.feedbackId, reason: applied.reason });
        }
      }
    }
    return { rule: 'experience.v1', ...result, state: undefined, cellId, decisionId: rawDecision.decisionId, deferredApplied: deferred,
      ...(deferredRefused.length ? { deferredRefused } : {}) };
  }
  if (feedback) {
    const ownerAuthenticated = event.sourceAuthority === 'home23.event-ledger' && event.sourceRef.startsWith('relationship.')
      && event.payload['actor'] === 'jtr';
    const authority = { feedbackId: event.eventId,
      observedAt: event.producedAt, ownerAuthenticated,
      ...(typeof event.payload['learningStream'] === 'string' && typeof event.payload['learningSequence'] === 'number'
        ? { stream: event.payload['learningStream'], sequence: event.payload['learningSequence'] } : {}) };
    const result = applyLearningFeedback(existing?.experience, feedback, authority);
    if (result.applied) { const p = existing ?? emptyCellPlasticState(); p.experience = result.state; development[cellId] = p; }
    else if (result.reason === 'decision_not_retained' && ownerAuthenticated) {
      const state = normalizeLearningState(existing?.experience);
      if (!state.pendingFeedback.some(item => item.authority.feedbackId === event.eventId) && state.pendingFeedback.length < 16) {
        state.pendingFeedback.push({ feedback, authority });
        if (!learningStateWithinBudget(state)) return { rule: 'experience.v1', applied: false, reason: 'learning_state_capacity', cellId };
        const p = existing ?? emptyCellPlasticState(); p.experience = state; development[cellId] = p;
        return { rule: 'experience.v1', applied: false, reason: 'pending_decision_witness', cellId, feedbackId: event.eventId };
      }
    }
    return { rule: 'experience.v1', ...result, state: undefined, cellId };
  }
  if (event.payload['outcomeCriterion'] === 'execution') {
    if (event.payload['executionKind'] === 'action' && event.payload['executionAttempted'] === false) {
      return { rule: 'experience.v1', applied: false, reason: 'execution_not_attempted', cellId };
    }
    const status = event.payload['status'];
    if (status !== 'completed' && status !== 'failed' && status !== 'blocked' && status !== 'rejected') {
      return { rule: 'experience.v1', applied: false, reason: 'execution_pending_or_unevaluated', cellId };
    }
    const trial = event.payload['outcomeTrialId'];
    if (typeof trial !== 'string' || !trial) return { rule: 'experience.v1', applied: false, reason: 'execution_trial_missing', cellId };
    const action = String(event.payload['action'] ?? event.payload['executionKind'] ?? 'work').replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 80);
    const scope = `execution:${action}`;
    const sourceRefs = [event.sourceRef, event.eventId];
    const tag = executionTargetTag(event.payload['target']);
    const boundTarget = tag && (event.payload['executionContext'] as { targetTag?: unknown } | undefined)?.targetTag === tag ? tag : null;
    const decision = { schema: 'home23.learning-decision.v1', decisionId: trial, scope,
      tags: ['execution', String(event.payload['executionKind'] ?? 'work'), ...(boundTarget ? [boundTarget] : [])], sourceRefs, criterion: 'execution', cellId, observedAt: event.producedAt };
    const recorded = recordLearningDecision(existing?.experience, decision);
    // One attempt has one execution outcome credit even if more evidence is
    // projected later. This cannot corroborate owner value or accomplishment.
    const result = applyLearningFeedback(recorded.state, { schema: 'home23.learning-feedback.v1', decisionId: trial, scope,
      tags: decision.tags, direction: status === 'completed' ? 'reinforce' : 'attenuate', evidenceRefs: sourceRefs,
      basis: 'verified-outcome' }, { feedbackId: `execution:${trial}`, observedAt: event.producedAt,
      ...(typeof event.payload['learningStream'] === 'string' && typeof event.payload['learningSequence'] === 'number'
        ? { stream: event.payload['learningStream'], sequence: event.payload['learningSequence'] } : {}),
      verification: { criterion: 'execution', evidenceRefs: sourceRefs } });
    if (result.applied) { const p = existing ?? emptyCellPlasticState(); p.experience = result.state; development[cellId] = p; }
    return { rule: 'experience.v1', ...result, state: undefined, cellId, outcomeTrialId: trial, criterion: 'execution' };
  }
  return { rule: 'experience.v1', applied: false, reason: 'unattributed_observation_not_teaching', cellId };
}
