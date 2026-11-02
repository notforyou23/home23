/** Authenticated conversational feedback, linked to an actually delivered reply. */
import { previewLearningFeedback, emptyLearningState, learningLessonId, normalizeLearningDecision, normalizeLearningFeedback, readSeedLearning,
  recordLearningDecision, type LearningDecision, type LearningState } from '../../shared/seed-learning.cjs';
import { canonicalConversationDelivery, readBoundedLearningEvidenceRows, verifiedConversationSelections,
  type VerifiedConversationSelection } from './learning-decision-evidence.js';
import { isExplicitStandingConversationInstruction, validateConversationFeedbackClaim, type ConversationFeedbackInterpretation } from './conversation-feedback-contract.js';
import type { DeliveredConductDecision } from './delivered-conversation-observation.js';
import type { RelationshipLedger, RelationshipLearningFeedback } from './relationship-ledger.js';

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | null => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as RecordValue : null;
const text = (value: unknown, max = 512): value is string => typeof value === 'string' && value.length > 0
  && value.length <= max && !value.includes('\0');

export interface CanonicalConversationOwner {
  messageRef: string; text: string; sourceSequence: number;
}
/** Runtime-owned Core result, never proposal/model arguments. */
export interface CanonicalConversationOwnerContext extends CanonicalConversationOwner {
  previousAssistantMessageId: string | null;
}
function currentOwner(contacts: RecordValue[], conversationRef: string, currentMessageId: string): CanonicalConversationOwner | null {
  if (!conversationRef.startsWith('coordination:') || !text(currentMessageId)) return null;
  const channelId = conversationRef.slice('coordination:'.length);
  const matches = contacts.filter(row => row.schema === 'home23.resident.contact.v1'
    && row.messageId === currentMessageId && row.channelId === channelId);
  if (matches.length !== 1) return null;
  const current = matches[0]!;
  const actor = object(current.actor);
  if (current.session !== conversationRef || current.channelKind !== 'direct' || current.scheduled || current.runtime || current.worker
    || current.role !== 'user' || current.voice !== 'jtr' || actor?.kind !== 'owner'
    || !text(actor.principalId) || !text(current.content, 6000)
    || current.sourceRef !== `coordination.message:${currentMessageId}`
    || current.contactId !== `message:${currentMessageId}` || !Number.isSafeInteger(current.sourceSequence)
    || (current.sourceSequence as number) < 0) return null;
  return { messageRef: current.sourceRef as string, text: current.content, sourceSequence: current.sourceSequence as number };
}

export async function readCurrentConversationOwner(input: {
  contactPath: string; conversationRef: string; currentMessageId: string; signal?: AbortSignal;
}): Promise<CanonicalConversationOwner | null> {
  try { return currentOwner(await readBoundedLearningEvidenceRows(input.contactPath, input.signal), input.conversationRef, input.currentMessageId); }
  catch { return null; }
}

export interface DeliveredConversation {
  selection: Pick<VerifiedConversationSelection, 'selectionId' | 'reply' | 'responseHash'> & {
    decisions: Array<VerifiedConversationSelection['decisions'][number] | DeliveredConductDecision>;
    annotationSource?: 'delivered-reply-observation';
  };
  deliveryMessageRef: string;
  deliverySourceSequence: number;
  currentOwnerMessageRef: string;
  currentOwnerText: string;
  currentOwnerSourceSequence: number;
  modelView: { selectionId: string; reply: string; dimensions: Array<{
    decisionId: string; axis: string; value: string; situation: string;
  }>; deliveryMessageRef: string };
}

/** Inspect the nearest preceding visible assistant reply, never skip a newer
 * ordinary/tool reply to find an older teachable conversation. */
export async function readPriorDeliveredConversation(input: {
  ledgerPath: string; contactPath: string; conversationRef: string; currentMessageId: string; signal?: AbortSignal;
  currentOwner?: CanonicalConversationOwnerContext;
}): Promise<DeliveredConversation | null> {
  if (!input.conversationRef.startsWith('coordination:') || !text(input.currentMessageId)) return null;
  try {
    const [rows, contacts] = await Promise.all([
      readBoundedLearningEvidenceRows(input.ledgerPath, input.signal),
      readBoundedLearningEvidenceRows(input.contactPath, input.signal),
    ]);
    const channelId = input.conversationRef.slice('coordination:'.length);
    const projectedCurrent = currentOwner(contacts, input.conversationRef, input.currentMessageId);
    const trusted = input.currentOwner;
    if (!projectedCurrent && contacts.some(row => row.messageId === input.currentMessageId)) return null;
    if (trusted && (trusted.messageRef !== `coordination.message:${input.currentMessageId}` || !text(trusted.text, 2000)
      || !Number.isSafeInteger(trusted.sourceSequence) || trusted.sourceSequence < 0
      || !(trusted.previousAssistantMessageId === null || text(trusted.previousAssistantMessageId)))) return null;
    if (trusted && projectedCurrent && (trusted.text !== projectedCurrent.text || trusted.sourceSequence !== projectedCurrent.sourceSequence)) return null;
    // Core can bind the current contact before the asynchronous projection
    // catches up. Its exact previous-message identity closes the lagging-tail
    // ambiguity; the previous reply itself must still exist in canonical source.
    const current = projectedCurrent ?? trusted;
    if (!current || current.text.length > 2000) return null;
    const earlier = contacts.filter(row => row.channelId === channelId && row.session === input.conversationRef
      && row.role === 'assistant' && Number.isSafeInteger(row.sourceSequence)
      && (row.sourceSequence as number) < current.sourceSequence)
      .sort((a, b) => (b.sourceSequence as number) - (a.sourceSequence as number));
    const preceding = earlier[0];
    if (!preceding || earlier.filter(row => row.sourceSequence === preceding.sourceSequence).length !== 1) return null;
    if (trusted && preceding.messageId !== trusted.previousAssistantMessageId) return null;
    const eligible = verifiedConversationSelections(rows).filter(selection => selection.conversationRef === input.conversationRef);
    const matches = eligible.flatMap(selection => {
      const delivery = canonicalConversationDelivery(selection, contacts);
      return delivery.status === 'observed' && delivery.messageRef === preceding.sourceRef ? [{ selection, delivery }] : [];
    });
    if (matches.length !== 1) return null;
    const { selection, delivery } = matches[0]!;
    const deliveryMessageRef = delivery.messageRef!;
    return { selection, deliveryMessageRef, deliverySourceSequence: delivery.sourceSequence!,
      currentOwnerMessageRef: current.messageRef, currentOwnerText: current.text,
      currentOwnerSourceSequence: current.sourceSequence,
      modelView: { selectionId: selection.selectionId, reply: selection.reply, deliveryMessageRef,
        dimensions: selection.decisions.map(decision => ({ decisionId: decision.decisionId,
          axis: decision.behavior.axis, value: decision.behavior.value, situation: decision.behavior.situation })) } };
  } catch { return null; }
}

export interface ConversationFeedbackResult {
  status: 'no_feedback' | 'refused' | 'source_recorded';
  reason?: string;
  entryId?: string;
  projectionIds?: string[];
  lessonIds?: string[];
  projected?: number;
  pending?: number;
  seedApplication?: 'not_yet_confirmed';
}

function core(decision: LearningDecision) {
  return { schema: decision.schema, decisionId: decision.decisionId, scope: decision.scope,
    tags: decision.tags, sourceRefs: decision.sourceRefs, criterion: decision.criterion };
}

/** Model output proposes attribution; verified source/delivery and conservative
 * conduct checks decide whether it can enter the existing owner teaching path. */
export function applyConversationFeedback(input: {
  proposals: unknown;
  owner: { chatId: string; messageRef: string; text: string };
  prior: DeliveredConversation | null;
  relationshipLedger: RelationshipLedger;
  seedStateDir: string;
}): ConversationFeedbackResult {
  const refuse = (reason: string): ConversationFeedbackResult => ({ status: 'refused', reason });
  if (Array.isArray(input.proposals) && input.proposals.length === 0) return { status: 'no_feedback' };
  if (!Array.isArray(input.proposals) || input.proposals.length > 4 || input.proposals.length < 1) return refuse('invalid_feedback_batch');
  const prior = input.prior;
  if (!prior || input.owner.text !== prior.currentOwnerText) return refuse('delivered_reply_or_current_owner_source_unavailable');
  const snapshot = readSeedLearning(input.seedStateDir);
  if (snapshot.available === false) return refuse('seed_projection_unavailable');
  const interpretations: ConversationFeedbackInterpretation[] = [];
  const learning: RelationshipLearningFeedback[] = [];
  const axes = new Set<string>();
  for (const raw of input.proposals) {
    const proposal = object(raw);
    if (!proposal || Object.keys(proposal).some(key => !['decisionId', 'quote', 'direction', 'standing', 'conditions', 'supersedes'].includes(key))
      || !text(proposal.decisionId) || !text(proposal.quote, 1000)
      || !['attenuate', 'reinforce'].includes(String(proposal.direction))
      || (proposal.standing !== undefined && typeof proposal.standing !== 'boolean')) return refuse('invalid_feedback_interpretation');
    const conditions = proposal.conditions ?? [];
    const supersedes = proposal.supersedes ?? [];
    if (!Array.isArray(conditions) || conditions.length > 4 || conditions.some(value => !text(value, 300))
      || !Array.isArray(supersedes) || supersedes.length > 4 || supersedes.some(value => !text(value))
      || new Set(supersedes).size !== supersedes.length) return refuse('invalid_feedback_conditions');
    const decision = prior.selection.decisions.find(item => item.decisionId === proposal.decisionId);
    if (!decision || axes.has(decision.behavior.axis)) return refuse('feedback_decision_not_delivered_or_duplicate');
    let retained = [...snapshot.decisions, ...snapshot.lessons.flatMap(lesson => lesson.eligibility ? [lesson.eligibility] : [])]
      .map(normalizeLearningDecision).filter((item): item is LearningDecision => item !== null)
      .filter(item => item.decisionId === decision.decisionId);
    if (!retained.length && prior.selection.annotationSource === 'delivered-reply-observation') {
      // This is a validated runtime observation of exact delivered bytes, not a
      // prospective choice. The existing Seed adapters may consume feedback
      // before its decision; their pending-witness path resolves that ordering.
      retained = [{ ...decision, cellId: snapshot.conductAnchorCellId ?? 'pending.conduct.anchor' }];
    }
    if (!retained.length || retained.some(item => JSON.stringify(core(item)) !== JSON.stringify(core(decision)))) {
      return refuse('original_decision_not_retained');
    }
    const cells = [...new Set(retained.map(item => item.cellId))];
    if (cells.length !== 1 || (decision.cellId !== undefined && decision.cellId !== cells[0])) return refuse('original_decision_cell_ambiguous');
    const interpretation: ConversationFeedbackInterpretation = {
      decisionId: decision.decisionId, axis: decision.behavior.axis, value: decision.behavior.value,
      situation: decision.behavior.situation, quote: proposal.quote,
      direction: proposal.direction as 'attenuate' | 'reinforce', standing: proposal.standing === true
        || isExplicitStandingConversationInstruction(proposal.quote, conditions as string[], prior.selection.reply),
      conditions: conditions as string[], supersedes: supersedes as string[],
    };
    const invalid = validateConversationFeedbackClaim(input.owner.text, interpretation, prior.selection.reply);
    if (invalid) return refuse(invalid);
    if (interpretation.supersedes.some(id => !snapshot.lessons.some(lesson => lesson.lessonId === id
      && lesson.scope === decision.scope && lesson.active !== false && lesson.authority === 'owner'
      && lesson.tags.includes(`situation:${decision.behavior.situation}`)))) return refuse('revision_target_not_applicable');
    const feedback: RelationshipLearningFeedback = {
      schema: 'home23.learning-feedback.v1', decisionId: decision.decisionId, scope: decision.scope,
      ...(prior.selection.annotationSource !== 'delivered-reply-observation' && cells[0] ? { cellId: cells[0] } : {}),
      direction: interpretation.direction, tags: [...decision.tags], excludes: [], basis: 'owner-feedback',
      evidenceRefs: [input.owner.messageRef, prior.deliveryMessageRef, prior.currentOwnerMessageRef],
      supersedes: interpretation.supersedes, corroborates: [], ...(interpretation.standing ? { standing: true } : {}),
    };
    axes.add(interpretation.axis); interpretations.push(interpretation); learning.push(feedback);
  }
  const record = (): ConversationFeedbackResult => {
    try {
      const entry = input.relationshipLedger.addConversationFeedbackBatch({ learning, interpretations, deliveredReply: prior.selection.reply,
        episode: { selectionId: prior.selection.selectionId, responseHash: prior.selection.responseHash,
          deliveryMessageRef: prior.deliveryMessageRef, ownerMessageRef: prior.currentOwnerMessageRef } }, {
        chatId: input.owner.chatId, messageRef: input.owner.messageRef, userText: input.owner.text,
      });
      const projections = entry.seed_projections ?? [];
      return { status: 'source_recorded', entryId: entry.id, projectionIds: projections.map(item => item.event.event_id),
        lessonIds: projections.map((item, index) => learningLessonId(item.event.event_id, entry.learning_batch![index]!.scope)),
        projected: projections.filter(item => item.status === 'projected').length,
        pending: projections.filter(item => item.status === 'pending').length, seedApplication: 'not_yet_confirmed' };
    } catch (error) { return refuse(error instanceof Error ? error.message : 'feedback_source_failed'); }
  };
  // Exact source retry only flushes the original outbox. It must not be refused
  // because its already-applied episode now correctly rejects duplicate credit.
  input.relationshipLedger.reload();
  const sourceEntries = input.relationshipLedger.listEntries({ includeRemoved: true }).filter(entry => entry.actor === 'jtr'
    && (entry.provenance.source_refs.includes(input.owner.messageRef) || entry.provenance.source_refs.includes(prior.currentOwnerMessageRef)));
  if (sourceEntries.length) {
    const entry = sourceEntries.length === 1 ? sourceEntries[0] : undefined;
    const canonicalRefs = [prior.currentOwnerMessageRef, prior.deliveryMessageRef];
    const oldIngress = entry?.provenance.source_refs.filter(ref => !canonicalRefs.includes(ref)) ?? [];
    const semantic = (feedback: RelationshipLearningFeedback, ephemeral: readonly string[]) => {
      const normalized = normalizeLearningFeedback(feedback);
      if (!normalized || !canonicalRefs.every(ref => normalized.evidenceRefs.includes(ref))) return null;
      return { ...normalized, evidenceRefs: normalized.evidenceRefs.filter(ref => !ephemeral.includes(ref)).sort() };
    };
    const episode = { selectionId: prior.selection.selectionId, responseHash: prior.selection.responseHash,
      deliveryMessageRef: prior.deliveryMessageRef, ownerMessageRef: prior.currentOwnerMessageRef };
    const oldLearning = entry?.learning_batch?.map(item => semantic(item, oldIngress));
    const newLearning = learning.map(item => semantic(item, [input.owner.messageRef]));
    if (!entry || entry.statement !== input.owner.text || oldIngress.length > 1
      || !entry.provenance.source_refs.includes(prior.currentOwnerMessageRef)
      || JSON.stringify(entry.conduct_episode) !== JSON.stringify(episode)
      || JSON.stringify(entry.learning_interpretations) !== JSON.stringify(interpretations)
      || !oldLearning || oldLearning.some(item => item === null) || newLearning.some(item => item === null)
      || JSON.stringify(oldLearning) !== JSON.stringify(newLearning)) return refuse('canonical_encounter_already_spent_differently');
    // The canonical encounter was already authenticated and persisted. A new
    // transport turn may flush that exact immutable source, never spend fresh
    // authority or add the new turn reference to its learning evidence.
    input.relationshipLedger.flushSeedTeaching();
    const retained = input.relationshipLedger.listEntries({ includeRemoved: true }).find(item => item.id === entry.id)!;
    const projections = retained.seed_projections ?? [];
    return { status: 'source_recorded', entryId: retained.id, projectionIds: projections.map(item => item.event.event_id),
      lessonIds: projections.map((item,index) => learningLessonId(item.event.event_id,retained.learning_batch![index]!.scope)),
      projected: projections.filter(item => item.status === 'projected').length,
      pending: projections.filter(item => item.status === 'pending').length, seedApplication: 'not_yet_confirmed' };
  }
  // Preflight the entire batch against current bounded Seed capacity. Source
  // projection and subsequent Seed application are still separate receipts.
  const simulations = new Map<string, LearningState>();
  for (const [index, feedback] of learning.entries()) {
    const cellId = feedback.cellId ?? (prior.selection.annotationSource === 'delivered-reply-observation' ? snapshot.conductAnchorCellId ?? 'pending.conduct.anchor' : undefined);
    if (!cellId || (snapshot.conductAnchorCellId && cellId !== snapshot.conductAnchorCellId)) return refuse('conduct_anchor_unavailable');
    let simulation = simulations.get(cellId);
    if (!simulation) {
      simulation = { ...emptyLearningState(), decisions: snapshot.decisions.filter(item => item.cellId === cellId),
        lessons: snapshot.lessons.filter(item => (item as typeof item & { cellId?: string }).cellId === cellId),
        ...(snapshot.conductAnchorCellId === cellId ? { conductAnchor: true,
          ...(snapshot.conductCredits ? { conductCredits: snapshot.conductCredits } : {}) } : {}) };
    }
    if (prior.selection.annotationSource === 'delivered-reply-observation') {
      const observed = prior.selection.decisions.find(item => item.decisionId === feedback.decisionId);
      if (!observed) return refuse('observed_decision_unavailable');
      if (!simulation.decisions.some(item => item.decisionId === observed.decisionId)) {
        const admission = recordLearningDecision(simulation, { ...observed, cellId });
        if (!admission.applied && admission.reason !== 'duplicate_decision') return refuse(`seed_preflight:${admission.reason}`);
        simulation = admission.state;
      }
    }
    const trial = previewLearningFeedback(simulation, { ...feedback, cellId }, {
      feedbackId: `conversation-preflight:${input.owner.messageRef}:${index}`, ownerAuthenticated: true,
      observedAt: new Date().toISOString(),
    });
    if (!trial.applied) return refuse(`seed_preflight:${trial.reason}`);
    simulations.set(cellId, trial.state);
  }
  return record();
}
