/** Runtime ownership around the pure Seed conversational selector. */
import { randomUUID, createHash } from 'node:crypto';
import { classifyOwnerConversation } from '../../shared/owner-conversation-policy.cjs';
import type { LearningSnapshot } from '../../shared/seed-learning.cjs';
import type { EventLedger } from './event-ledger.js';
import type { ToolContext, TurnRuntimeContext } from './types.js';
import { containsOwnerSecret } from './owner-distill.js';
import { buildConversationProposalPrompt, parseConversationProposal, selectConversationReply,
  buildConversationDecisionPayloads, buildConversationSelectionPayload, conversationResponseHash,
  type ConversationDecisionContext } from './conversation-judgment.js';
import type { TextGenerationOptions } from './text-generation.js';
import { estimateContextChars } from './context-pressure.js';

export const CONVERSATION_PROPOSAL_MAX_TOKENS = 6_000;
const MAX_PROPOSAL_CHARS = 28_000;
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export interface ConversationCompletion {
  selectionId: string; conversationRef: string; turnId: string; originMessageId: string;
  responseHash: string; candidateSetHash: string; decisionIds: string[];
}

type OwnerOpportunity = { owner: { chatId: string; messageRef: string; text: string }; conversationRef: string; originMessageId: string };
export type ConversationOpportunityReason = 'not_native_conversation' | 'owner_authority_unavailable'
  | 'owner_text_bounds' | 'canonical_contact_path_unavailable' | 'delegated_turn' | 'media_requires_ordinary_loop'
  | 'owner_secret_requires_ordinary_loop' | 'owner_evidence_unavailable' | 'not_direct_owner_channel'
  | 'operator_trial' | 'explicit_action_requested' | 'structured_owner_envelope';
type OpportunityAssessment = { opportunity: OwnerOpportunity; reason?: never }
  | { opportunity: null; reason: ConversationOpportunityReason };

/** Routing declines are not lessons. Owner text is never silently shortened. */
export function assessConversationalOwnerOpportunity(input: {
  context: Pick<ToolContext, 'authenticatedUserMessage' | 'chatId' | 'ownerConversationContactPath'>;
  runtime?: TurnRuntimeContext;
  mediaCount: number;
}): OpportunityAssessment {
  const { context, runtime } = input;
  const owner = context.authenticatedUserMessage;
  const origin = runtime?.coordinationOrigin;
  const decline = (reason: ConversationOpportunityReason): OpportunityAssessment => ({ opportunity: null, reason });
  if (!runtime || runtime.contextPurpose !== 'conversation' || !origin?.originMessageId) return decline('not_native_conversation');
  if (!owner || owner.chatId !== context.chatId) return decline('owner_authority_unavailable');
  if (!owner.text.trim() || owner.text.length > 6_000) return decline('owner_text_bounds');
  if (!context.ownerConversationContactPath) return decline('canonical_contact_path_unavailable');
  if (runtime.delegatedContext || runtime.delegatedTurn || runtime.delegationOrigin) return decline('delegated_turn');
  if (input.mediaCount > 0) return decline('media_requires_ordinary_loop');
  if (containsOwnerSecret(owner.text)) return decline('owner_secret_requires_ordinary_loop');
  if (!classifyOwnerConversation({ text: owner.text, chatId: origin.channelId }).ownerEvidence) return decline('owner_evidence_unavailable');
  const canonical = owner as typeof owner & { channelKind?: string; channelId?: string };
  if (canonical.channelKind !== undefined && (canonical.channelKind !== 'direct' || canonical.channelId !== origin.channelId)) return decline('not_direct_owner_channel');
  // Operator trials remain history, but do not create general conduct authority.
  if (/\b(?:codex|claude code|operator)\b[^.!?\n]{0,100}\b(?:on behalf|verif(?:y|ication)|proof|test)\b/i.test(owner.text)
    || /\b(?:controlled|live|behavioral|learning|seed|runtime|production)\s+(?:proof|verification|test)\b/i.test(owner.text)
    || /\b(?:for|during)\s+(?:this|the)\s+(?:verification|experiment|test)\b/i.test(owner.text)) return decline('operator_trial');
  if (/^\s*(?:(?:please|can you|could you|will you|would you)\s+)*(?:read|search|look up|find|check|fetch|open|run|execute|build|implement|fix|deploy|restart|send|schedule|create|delete|update|commit|push|install|save|record|remember(?!\s+to\b)|forget)\b/i.test(owner.text)) return decline('explicit_action_requested');
  if (/^\s*(?:\/|\[|<|\{)/.test(owner.text)) return decline('structured_owner_envelope');
  return { opportunity: { owner, conversationRef: `coordination:${origin.channelId}`, originMessageId: origin.originMessageId } };
}

export function conversationalOwnerOpportunity(input: Parameters<typeof assessConversationalOwnerOpportunity>[0]): OwnerOpportunity | null {
  return assessConversationalOwnerOpportunity(input).opportunity;
}

/** Bounded routing evidence only; never raw owner text, provider errors or lessons. */
export function recordConversationProposalDecline(input: {
  eventLedger: EventLedger; context: Pick<ToolContext, 'chatId'>; runtime: TurnRuntimeContext;
}, reason: string, stage: string, details: { requestChars?: number; requestBudgetChars?: number;
  budgetSource?: 'configured_context_policy' | 'default_context_policy' } = {}): void {
  if (input.runtime.contextPurpose !== 'conversation' || !input.runtime.coordinationOrigin?.originMessageId) return;
  input.eventLedger.record('ConversationProposalDeferred', input.context.chatId, {
    turnId: input.runtime.turnId, originMessageId: input.runtime.coordinationOrigin.originMessageId,
    reason, stage, ...details,
  }, { actor: 'conversation' });
}

export async function attemptConversationReply(input: {
  context: ToolContext;
  runtime: TurnRuntimeContext;
  mediaCount: number;
  system: string;
  history: readonly { role: string; content: unknown }[];
  provider: string;
  model: string;
  reasoningEffort: string;
  requestBudgetChars: number;
  budgetSource?: 'configured_context_policy' | 'default_context_policy';
  eventLedger: EventLedger;
  readLearning: () => LearningSnapshot;
  generate: (request: Pick<TextGenerationOptions, 'system' | 'prompt' | 'maxTokens' | 'timeoutMs' | 'requireComplete' | 'maxOutputChars' | 'usageSink'>) => Promise<string>;
  readPrior?: (input: { conversationRef: string; currentMessageId: string }) => Promise<unknown>;
  verifyOwnerSource?: (input: { conversationRef: string; currentMessageId: string; text: string }) => Promise<boolean>;
  feedback?: (input: { proposals: unknown[]; owner: { chatId: string; messageRef: string; text: string }; prior: unknown }) => unknown | Promise<unknown>;
  stillCurrent?: () => boolean;
}): Promise<{ text: string; completion: ConversationCompletion } | null> {
  const assessment = assessConversationalOwnerOpportunity(input);
  const decline = (reason: string, stage: string, details: Parameters<typeof recordConversationProposalDecline>[3] = {}) => {
    recordConversationProposalDecline(input, reason, stage, details);
    return null;
  };
  const opportunity = assessment.opportunity;
  if (!opportunity) return decline(assessment.reason, 'eligibility');
  let snapshot: LearningSnapshot;
  try { snapshot = input.readLearning(); } catch { return decline('seed_snapshot_unavailable', 'seed'); }
  if (snapshot.available !== true) return decline('seed_snapshot_unavailable', 'seed');
  // Non-text attachments and tool-use blocks need the ordinary provider loop.
  if (input.history.some(message => typeof message.content !== 'string'
    && (!Array.isArray(message.content) || message.content.some(part => !part || typeof part !== 'object'
      || (part as { type?: string }).type !== 'text')))) return decline('structured_history_requires_ordinary_loop', 'history');
  const signal = input.runtime.signal;
  signal.throwIfAborted();
  const started = Date.now();
  let stage = 'canonical_source';
  try {
    const canonical = opportunity.owner as typeof opportunity.owner & { channelKind?: string; channelId?: string };
    const direct = canonical.channelKind === 'direct' && canonical.channelId === input.runtime.coordinationOrigin?.channelId;
    if (!direct && !await input.verifyOwnerSource?.({ conversationRef: opportunity.conversationRef,
      currentMessageId: opportunity.originMessageId, text: opportunity.owner.text })) {
      return decline('canonical_owner_source_unavailable', stage);
    }
    signal.throwIfAborted();
    stage = 'prior_delivery';
    const prior = await input.readPrior?.({ conversationRef: opportunity.conversationRef,
      currentMessageId: opportunity.originMessageId }) ?? null;
    signal.throwIfAborted();
    stage = 'proposal_context';
    const prompt = buildConversationProposalPrompt({ ownerText: opportunity.owner.text,
      history: input.history, ...(prior ? { priorResponse: prior } : {}) });
    const requestChars = estimateContextChars([{ role: 'system', content: input.system }, { role: 'user', content: prompt }]);
    if (!Number.isSafeInteger(input.requestBudgetChars) || input.requestBudgetChars <= 0) {
      return decline('request_budget_unavailable', 'context_budget');
    }
    if (requestChars > input.requestBudgetChars) return decline('request_exceeds_context_budget', 'context_budget',
      { requestChars, requestBudgetChars: input.requestBudgetChars, ...(input.budgetSource ? { budgetSource: input.budgetSource } : {}) });
    const usage = { tokensIn: 0, tokensOut: 0 };
    stage = 'provider';
    const raw = await input.generate({ system: input.system, prompt, maxTokens: CONVERSATION_PROPOSAL_MAX_TOKENS, timeoutMs: 90_000,
      requireComplete: true, maxOutputChars: MAX_PROPOSAL_CHARS, usageSink: usage });
    signal.throwIfAborted();
    if (input.stillCurrent && !input.stillCurrent()) return decline('turn_steered', 'selection');
    const proposal = parseConversationProposal(raw);
    input.eventLedger.record('ConversationProposalCompleted', input.context.chatId, {
      turnId: input.runtime.turnId, conversationRef: opportunity.conversationRef,
      originMessageId: opportunity.originMessageId, provider: input.provider, model: input.model,
      reasoningEffort: input.reasoningEffort, durationMs: Date.now() - started,
      inputHash: sha(input.system + '\n' + prompt), outputHash: sha(raw), usage,
      route: proposal?.route ?? 'invalid',
    }, { actor: 'conversation' });
    if (!proposal) return decline('invalid_proposal', 'proposal');
    // The writer validates source/delivery/attribution independently. Rejection
    // does not turn an otherwise answerable conversation into a tool failure.
    if (proposal.feedback.length && input.feedback) {
      try {
        const result = await input.feedback({ proposals: proposal.feedback, owner: opportunity.owner, prior });
        const record = result && typeof result === 'object' && !Array.isArray(result)
          ? result as Record<string, unknown> : {};
        const ids = (value: unknown) => Array.isArray(value) ? value
          .filter((item): item is string => typeof item === 'string' && item.length <= 256).slice(0, 4) : [];
        input.eventLedger.record('ConversationFeedbackProcessed', input.context.chatId, {
          turnId: input.runtime.turnId, conversationRef: opportunity.conversationRef,
          originMessageId: opportunity.originMessageId,
          status: ['no_feedback', 'refused', 'source_recorded'].includes(String(record.status)) ? record.status : 'unknown',
          ...(typeof record.reason === 'string' ? { reason: record.reason.slice(0, 200) } : {}),
          ...(typeof record.entryId === 'string' && record.entryId.length <= 256 ? { entryId: record.entryId } : {}),
          projectionIds: ids(record.projectionIds), lessonIds: ids(record.lessonIds),
          ...(Number.isSafeInteger(record.projected) ? { projected: record.projected } : {}),
          ...(Number.isSafeInteger(record.pending) ? { pending: record.pending } : {}),
          seedApplication: 'not_yet_confirmed',
        }, { actor: 'conversation' });
      }
      catch { input.eventLedger.record('ConversationFeedbackDeferred', input.context.chatId,
        { turnId: input.runtime.turnId, reason: 'source_feedback_unavailable' }, { actor: 'conversation' }); }
    }
    signal.throwIfAborted();
    if (input.stillCurrent && !input.stillCurrent()) return decline('turn_steered', 'selection');
    if (proposal.route !== 'conversation') return decline('proposal_requires_ordinary_loop', 'proposal');
    if (proposal.candidates.some(candidate => containsOwnerSecret(candidate.reply))) return decline('candidate_secret_requires_ordinary_loop', 'selection');
    stage = 'selection';
    const selected = selectConversationReply(proposal, input.readLearning());
    const context: ConversationDecisionContext = {
      selectionId: `conversation:${randomUUID()}`, turnId: input.runtime.turnId,
      messageRef: opportunity.owner.messageRef, conversationRef: opportunity.conversationRef,
      originMessageId: opportunity.originMessageId, provider: input.provider, model: input.model,
    };
    const decisions = buildConversationDecisionPayloads(selected, context);
    const payload = buildConversationSelectionPayload(selected, context);
    const timestamp = new Date().toISOString();
    // Every prospective witness is required before any candidate becomes a
    // visible reply. A partial append cannot acquire delivery evidence.
    input.eventLedger.emitDurable({ event_id: context.selectionId, event_type: 'ConversationReplySelected',
      session_id: input.context.chatId, actor: 'conversation', timestamp,
      payload: { ...payload, reasoningEffort: input.reasoningEffort, inputHash: sha(input.system + '\n' + prompt),
        usage, annotationSource: 'model-proposal', status: 'selected' } }, { newUnique: true });
    for (const decision of decisions) input.eventLedger.emitDurable({ event_id: decision.decisionId,
      event_type: 'LearningDecisionObserved', session_id: input.context.chatId, actor: 'conversation', timestamp,
      payload: { ...decision, learningVersion: 2 } }, { newUnique: true });
    signal.throwIfAborted();
    return { text: selected.selected.reply, completion: {
      selectionId: context.selectionId, conversationRef: context.conversationRef, turnId: context.turnId,
      originMessageId: opportunity.originMessageId, responseHash: selected.responseHash,
      candidateSetHash: selected.candidateSetHash, decisionIds: decisions.map(decision => decision.decisionId),
    } };
  } catch (error) {
    signal.throwIfAborted();
    return decline(stage === 'proposal_context' ? 'proposal_context_bounds'
      : stage === 'selection' ? 'selection_evidence_unavailable'
        : stage === 'canonical_source' || stage === 'prior_delivery' ? 'canonical_evidence_unavailable' : 'bounded_proposal_unavailable', stage);
  }
}

/** Harness completion is not canonical delivery. The feedback reader also
 * requires the matching committed assistant Message from the contact stream. */
export function completeConversationReply(input: {
  completion: ConversationCompletion; text: string; status: string; chatId: string; eventLedger: EventLedger;
}): boolean {
  if (input.status !== 'complete' || conversationResponseHash(input.text) !== input.completion.responseHash) return false;
  const timestamp = new Date().toISOString();
  input.eventLedger.emitDurable({ event_id: `${input.completion.selectionId}:completed`, event_type: 'ConversationReplyCompleted',
    session_id: input.chatId, actor: 'conversation', timestamp,
    payload: { schema: 'home23.conversation-completion.v1', ...input.completion, status: 'complete',
      canonicalDelivery: 'requires_contact_join' } }, { newUnique: true });
  return true;
}
