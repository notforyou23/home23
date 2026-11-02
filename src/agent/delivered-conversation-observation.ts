/** Canonical delivered conduct is an observation, never a reconstructed choice. */
import { createHash } from 'node:crypto';
import { CONDUCT_AXES, conversationResponseHash, type ConductAxes, type ConversationSituation } from './conversation-judgment.js';
import { readBoundedLearningEvidenceRows, verifiedDeliveredConductObservations, observedConversationDelivery } from './learning-decision-evidence.js';
import { readPriorDeliveredConversation, type CanonicalConversationOwnerContext, type DeliveredConversation } from './conversation-feedback.js';
import type { LearningDecision } from '../../shared/seed-learning.cjs';
import type { EventLedger } from './event-ledger.js';

export interface DeliveredConductDecision extends LearningDecision {
  choice: string;
  behavior: { kind: 'delivered-conversation-observation'; axis: keyof ConductAxes; value: string; situation: ConversationSituation;
    observationId: string; conversationRef: string; deliveryMessageRef: string; responseHash: string };
}
export interface CanonicalDeliveredReply {
  conversationRef: string; deliveryMessageRef: string; deliverySourceSequence: number; deliveryTimestamp: string;
  reply: string; responseHash: string; replyToMessageId: string; originalOwnerText: string;
  currentOwnerMessageRef: string; currentOwnerText: string; currentOwnerSourceSequence: number;
  observationId: string; selected: DeliveredConversation | null;
  retainedObservation?: {timestamp:string;sessionRef:string;situation:ConversationSituation;axes:ConductAxes};
}
const text = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0');
const obj = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const stamp = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
export const deliveredConductObservationId = (ref: string, hash: string): string => `conduct-observed:${createHash('sha256').update(ref + '\n' + hash).digest('hex')}`;

/** Read the nearest actual reply and its exact originating owner message.
 * Worker-owned publications may be ordinary replies; scheduled/runtime notices
 * cannot teach. A missing/newer/ambiguous source cannot be replaced with an
 * older teachable one. */
export async function readPriorCanonicalDeliveredReply(input: {
  ledgerPath: string; contactPath: string; conversationRef: string; currentMessageId: string;
  currentOwner?: CanonicalConversationOwnerContext; signal?: AbortSignal;
}): Promise<CanonicalDeliveredReply | null> {
  if (!input.conversationRef.startsWith('coordination:') || !text(input.currentMessageId)) return null;
  try {
    const contacts = await readBoundedLearningEvidenceRows(input.contactPath, input.signal);
    const channel = input.conversationRef.slice('coordination:'.length);
    const owners = contacts.filter(r => r.messageId === input.currentMessageId && r.channelId === channel);
    const owner = owners.length === 1 ? owners[0]! : null;
    if (owners.length > 1) return null;
    const trusted = input.currentOwner;
    if (trusted && (trusted.messageRef !== `coordination.message:${input.currentMessageId}` || !text(trusted.text, 2000)
      || !Number.isSafeInteger(trusted.sourceSequence) || trusted.sourceSequence < 0)) return null;
    const canonical = (r: Record<string, unknown>, role: 'user' | 'assistant') => r.schema === 'home23.resident.contact.v1'
      && r.channelId === channel && r.session === input.conversationRef && r.channelKind === 'direct'
      && r.role === role && r.voice === (role === 'user' ? 'jtr' : 'self')
      && obj(r.actor)?.kind === (role === 'user' ? 'owner' : 'bot') && text(obj(r.actor)?.principalId)
      && text(r.messageId) && r.sourceRef === `coordination.message:${r.messageId}` && r.contactId === `message:${r.messageId}`
      && Number.isSafeInteger(r.sourceSequence) && (r.sourceSequence as number) >= 0 && stamp(r.ts)
      && text(r.content, 6000) && !r.scheduled && !r.runtime && (role === 'assistant' || !r.worker);
    if (owner && (!canonical(owner, 'user') || (trusted && (owner.content !== trusted.text || owner.sourceSequence !== trusted.sourceSequence)))) return null;
    if (!owner && !trusted) return null;
    const current = owner ? { messageRef: owner.sourceRef as string, text: owner.content as string, sourceSequence: owner.sourceSequence as number } : trusted!;
    if (current.text.length > 2000) return null;
    const earlier = contacts.filter(r => r.channelId === channel && r.session === input.conversationRef && r.role === 'assistant'
      && Number.isSafeInteger(r.sourceSequence) && (r.sourceSequence as number) < current.sourceSequence)
      .sort((a,b) => (b.sourceSequence as number) - (a.sourceSequence as number));
    const reply = earlier[0];
    if (!reply || !canonical(reply, 'assistant') || earlier.filter(r => r.sourceSequence === reply.sourceSequence).length !== 1
      || (trusted && reply.messageId !== trusted.previousAssistantMessageId) || !text(reply.replyToMessageId)) return null;
    const originalOwners = contacts.filter(r => r.messageId === reply.replyToMessageId && r.channelId === channel);
    if (originalOwners.length !== 1) return null;
    const originalOwner = originalOwners[0]!;
    if (!canonical(originalOwner, 'user') || (originalOwner.sourceSequence as number) >= (reply.sourceSequence as number)
      || (owner && obj(originalOwner.actor)?.principalId !== obj(owner.actor)?.principalId)
      || Date.parse(originalOwner.ts as string) > Date.parse(reply.ts as string)
      || (owner && Date.parse(reply.ts as string) > Date.parse(owner.ts as string))) return null;
    const hash = conversationResponseHash(reply.content as string);
    const observationId=deliveredConductObservationId(reply.sourceRef as string,hash);
    const runtimeRows=await readBoundedLearningEvidenceRows(input.ledgerPath,input.signal);
    const found=verifiedDeliveredConductObservations(runtimeRows).filter(o=>o.observationId===observationId&&observedConversationDelivery(o,contacts).status==='observed');
    if(found.length>1)return null;
    const retained=runtimeRows.filter(r=>r.event_id===observationId);
    if(retained.length>1)return null;
    const event=retained[0],payload=event&&obj(event.payload),a=payload&&obj(payload.axes);
    const retainedObservation=event&&payload&&a&&event.event_type==='ConversationConductObserved'&&event.actor==='conversation'&&payload.schema==='home23.delivered-conduct-observation.v1'&&payload.annotationSource==='delivered-reply-observation'
      &&payload.responseHash===hash&&payload.deliveryMessageRef===reply.sourceRef&&payload.reply===reply.content
      &&payload.observationId===observationId&&payload.conversationRef===input.conversationRef&&payload.replyToMessageId===reply.replyToMessageId
      &&payload.deliverySourceSequence===reply.sourceSequence&&stamp(event.timestamp)&&text(event.session_id)
      &&['sharing','reflection','deliberation'].includes(String(payload.situation))
      &&Object.keys(a).length===4&&Object.entries(CONDUCT_AXES).every(([axis,values])=>(values as readonly unknown[]).includes(a[axis]))
      ?{timestamp:event.timestamp,sessionRef:event.session_id,situation:payload.situation as ConversationSituation,axes:a as ConductAxes}:undefined;
    if(event&&!retainedObservation)return null;
    const observed=found[0];
    const selected=await readPriorDeliveredConversation(input)??(observed?{
      selection:{selectionId:observed.observationId,reply:observed.reply,responseHash:observed.responseHash,decisions:observed.decisions,annotationSource:'delivered-reply-observation' as const},
      deliveryMessageRef:observed.deliveryMessageRef,deliverySourceSequence:observed.deliverySourceSequence,
      currentOwnerMessageRef:current.messageRef,currentOwnerText:current.text,currentOwnerSourceSequence:current.sourceSequence,
      modelView:{selectionId:observed.observationId,reply:observed.reply,deliveryMessageRef:observed.deliveryMessageRef,
        dimensions:observed.decisions.map(d=>({decisionId:d.decisionId,axis:d.behavior.axis,value:d.behavior.value,situation:d.behavior.situation}))}}:null);
    return { conversationRef: input.conversationRef, deliveryMessageRef: reply.sourceRef as string,
      deliverySourceSequence: reply.sourceSequence as number, deliveryTimestamp: reply.ts as string,
      reply: reply.content as string, responseHash: hash, replyToMessageId: reply.replyToMessageId,
      originalOwnerText: originalOwner.content as string, currentOwnerMessageRef: current.messageRef,
      currentOwnerText: current.text, currentOwnerSourceSequence: current.sourceSequence,
      observationId, selected, ...(retainedObservation?{retainedObservation}:{}) };
  } catch { return null; }
}

export function observeDeliveredConduct(input: { prior: CanonicalDeliveredReply; situation: ConversationSituation;
  axes: ConductAxes; eventLedger: EventLedger; chatId: string }): DeliveredConversation {
  const {prior, situation, axes} = input;
  if (!['sharing','reflection','deliberation'].includes(situation)
    || !Object.keys(CONDUCT_AXES).every(axis => (CONDUCT_AXES[axis as keyof ConductAxes] as readonly string[]).includes(axes[axis as keyof ConductAxes]))) throw Error('invalid_observed_conduct');
  if(prior.retainedObservation&&(JSON.stringify(prior.retainedObservation.axes)!==JSON.stringify(axes)||prior.retainedObservation.situation!==situation))throw Error('observed_conduct_conflict');
  const observedAt = prior.retainedObservation?.timestamp ?? new Date().toISOString();
  const sessionRef=prior.retainedObservation?.sessionRef??input.chatId;
  const decisions: DeliveredConductDecision[] = (Object.keys(CONDUCT_AXES) as Array<keyof ConductAxes>).map(axis => ({
    schema: 'home23.learning-decision.v1', decisionId: `${prior.observationId}:${axis}`,
    scope: `foreground.conduct.${axis}`, tags: [`situation:${situation}`, `choice:${axes[axis]}`],
    sourceRefs: [prior.deliveryMessageRef, prior.conversationRef, prior.observationId], criterion: 'owner-value', observedAt,
    choice: axes[axis], behavior: { kind: 'delivered-conversation-observation', axis, value: axes[axis], situation,
      observationId: prior.observationId, conversationRef: prior.conversationRef, deliveryMessageRef: prior.deliveryMessageRef, responseHash: prior.responseHash },
  }));
  // Stable IDs make exact observation retries idempotent. No ConversationReplySelected
  // or prospective candidate receipt is created for a past ordinary reply.
  input.eventLedger.emitDurable({ event_id: prior.observationId, event_type: 'ConversationConductObserved',
    actor: 'conversation', session_id: sessionRef, timestamp: observedAt,
    payload: { schema: 'home23.delivered-conduct-observation.v1', annotationSource: 'delivered-reply-observation',
      observationId: prior.observationId, conversationRef: prior.conversationRef, deliveryMessageRef: prior.deliveryMessageRef,
      deliverySourceSequence: prior.deliverySourceSequence, responseHash: prior.responseHash, reply: prior.reply,
      replyToMessageId: prior.replyToMessageId, situation, axes, decisionIds: decisions.map(d=>d.decisionId) } });
  for (const d of decisions) input.eventLedger.emitDurable({ event_id: d.decisionId, event_type: 'LearningDecisionObserved',
    actor: 'conversation', session_id: sessionRef, timestamp: observedAt, payload: { ...d, learningVersion: 2 } });
  return { selection: {selectionId: prior.observationId, reply: prior.reply, responseHash: prior.responseHash,
    decisions, annotationSource: 'delivered-reply-observation'}, deliveryMessageRef: prior.deliveryMessageRef,
    deliverySourceSequence: prior.deliverySourceSequence, currentOwnerMessageRef: prior.currentOwnerMessageRef,
    currentOwnerText: prior.currentOwnerText, currentOwnerSourceSequence: prior.currentOwnerSourceSequence,
    modelView: { selectionId: prior.observationId, reply: prior.reply, deliveryMessageRef: prior.deliveryMessageRef,
      dimensions: decisions.map(d=>({decisionId:d.decisionId,axis:d.behavior.axis,value:d.behavior.value,situation})) } };
}
