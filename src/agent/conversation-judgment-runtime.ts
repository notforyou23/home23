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

const MAX_REQUEST_CHARS = 120_000;
const MAX_PROPOSAL_CHARS = 28_000;
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export interface ConversationCompletion {
  selectionId: string; conversationRef: string; turnId: string; originMessageId: string;
  responseHash: string; candidateSetHash: string; decisionIds: string[];
}

/** Routing declines are not lessons. Owner text is never silently shortened. */
export function conversationalOwnerOpportunity(input: {
  context: Pick<ToolContext, 'authenticatedUserMessage' | 'chatId' | 'ownerConversationContactPath'>;
  runtime?: TurnRuntimeContext;
  mediaCount: number;
}): { owner: { chatId: string; messageRef: string; text: string }; conversationRef: string; originMessageId: string } | null {
  const { context, runtime } = input;
  const owner = context.authenticatedUserMessage;
  const origin = runtime?.coordinationOrigin;
  if (!runtime || runtime.contextPurpose !== 'conversation' || !origin?.originMessageId
    || !owner || owner.chatId !== context.chatId || !owner.text.trim() || owner.text.length > 6_000
    || !context.ownerConversationContactPath || runtime.delegatedContext || runtime.delegatedTurn || runtime.delegationOrigin
    || input.mediaCount > 0 || containsOwnerSecret(owner.text)) return null;
  if (!classifyOwnerConversation({ text: owner.text, chatId: origin.channelId }).ownerEvidence) return null;
  const canonical = owner as typeof owner & { channelKind?: string; channelId?: string };
  if (canonical.channelKind !== undefined && (canonical.channelKind !== 'direct' || canonical.channelId !== origin.channelId)) return null;
  // Operator trials remain history, but do not create general conduct authority.
  if (/\b(?:codex|claude code|operator)\b[^.!?\n]{0,100}\b(?:on behalf|verif(?:y|ication)|proof|test)\b/i.test(owner.text)
    || /\b(?:controlled|live|behavioral|learning|seed|runtime|production)\s+(?:proof|verification|test)\b/i.test(owner.text)
    || /\b(?:for|during)\s+(?:this|the)\s+(?:verification|experiment|test)\b/i.test(owner.text)) return null;
  if (/^\s*(?:(?:please|can you|could you|will you|would you)\s+)*(?:read|search|look up|find|check|fetch|open|run|execute|build|implement|fix|deploy|restart|send|schedule|create|delete|update|commit|push|install|save|record|remember(?!\s+to\b)|forget)\b/i.test(owner.text)) return null;
  if (/^\s*(?:\/|\[|<|\{)/.test(owner.text)) return null;
  return { owner, conversationRef: `coordination:${origin.channelId}`, originMessageId: origin.originMessageId };
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
  eventLedger: EventLedger;
  readLearning: () => LearningSnapshot;
  generate: (request: Pick<TextGenerationOptions, 'system' | 'prompt' | 'maxTokens' | 'timeoutMs' | 'requireComplete' | 'maxOutputChars' | 'usageSink'>) => Promise<string>;
  readPrior?: (input: { conversationRef: string; currentMessageId: string }) => Promise<unknown>;
  verifyOwnerSource?: (input: { conversationRef: string; currentMessageId: string; text: string }) => Promise<boolean>;
  feedback?: (input: { proposals: unknown[]; owner: { chatId: string; messageRef: string; text: string }; prior: unknown }) => unknown | Promise<unknown>;
  stillCurrent?: () => boolean;
}): Promise<{ text: string; completion: ConversationCompletion } | null> {
  const opportunity = conversationalOwnerOpportunity(input);
  if (!opportunity) return null;
  let snapshot: LearningSnapshot;
  try { snapshot = input.readLearning(); } catch { return null; }
  if (snapshot.available !== true) return null;
  // Non-text attachments and tool-use blocks need the ordinary provider loop.
  if (input.history.some(message => typeof message.content !== 'string'
    && (!Array.isArray(message.content) || message.content.some(part => !part || typeof part !== 'object'
      || (part as { type?: string }).type !== 'text')))) return null;
  const signal = input.runtime.signal;
  signal.throwIfAborted();
  const started = Date.now();
  try {
    const canonical = opportunity.owner as typeof opportunity.owner & { channelKind?: string; channelId?: string };
    const direct = canonical.channelKind === 'direct' && canonical.channelId === input.runtime.coordinationOrigin?.channelId;
    if (!direct && !await input.verifyOwnerSource?.({ conversationRef: opportunity.conversationRef,
      currentMessageId: opportunity.originMessageId, text: opportunity.owner.text })) {
      input.eventLedger.record('ConversationProposalDeferred', input.context.chatId,
        { turnId: input.runtime.turnId, reason: 'canonical_owner_source_unavailable' }, { actor: 'conversation' });
      return null;
    }
    signal.throwIfAborted();
    const prior = await input.readPrior?.({ conversationRef: opportunity.conversationRef,
      currentMessageId: opportunity.originMessageId }) ?? null;
    signal.throwIfAborted();
    const prompt = buildConversationProposalPrompt({ ownerText: opportunity.owner.text,
      history: input.history, ...(prior ? { priorResponse: prior } : {}) });
    if (prompt.length + input.system.length > MAX_REQUEST_CHARS) return null;
    const usage = { tokensIn: 0, tokensOut: 0 };
    const raw = await input.generate({ system: input.system, prompt, maxTokens: 6_000, timeoutMs: 90_000,
      requireComplete: true, maxOutputChars: MAX_PROPOSAL_CHARS, usageSink: usage });
    signal.throwIfAborted();
    if (input.stillCurrent && !input.stillCurrent()) return null;
    const proposal = parseConversationProposal(raw);
    input.eventLedger.record('ConversationProposalCompleted', input.context.chatId, {
      turnId: input.runtime.turnId, conversationRef: opportunity.conversationRef,
      originMessageId: opportunity.originMessageId, provider: input.provider, model: input.model,
      reasoningEffort: input.reasoningEffort, durationMs: Date.now() - started,
      inputHash: sha(input.system + '\n' + prompt), outputHash: sha(raw), usage,
      route: proposal?.route ?? 'invalid',
    }, { actor: 'conversation' });
    if (!proposal) return null;
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
    if (input.stillCurrent && !input.stillCurrent()) return null;
    if (proposal.route !== 'conversation' || proposal.candidates.some(candidate => containsOwnerSecret(candidate.reply))) return null;
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
    input.eventLedger.record('ConversationProposalDeferred', input.context.chatId,
      { turnId: input.runtime.turnId, reason: 'bounded_proposal_unavailable', durationMs: Date.now() - started }, { actor: 'conversation' });
    return null;
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
