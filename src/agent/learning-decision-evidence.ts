import { createRequire } from 'node:module';
import { constants, promises as fs } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { LearningDecision } from '../../shared/seed-learning.cjs';
import { normalizeLearningDecision } from '../../shared/seed-learning.cjs';
import { CONDUCT_AXES, conversationCandidateSetHash, conversationResponseHash, parseConversationProposal,
  type ConversationDecisionPayload, type ConversationReplyProposal } from './conversation-judgment.js';

const { readRecentJsonlTail } = createRequire(import.meta.url)('../../shared/bounded-jsonl-tail.cjs') as {
  readRecentJsonlTail: (file: string, options: {
    limit: number; maxEntries: number; maxBytes: number; maxLineBytes: number; signal?: AbortSignal;
  }) => Promise<unknown[]>;
};

const MAX_RECORDS = 512;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_LINE_BYTES = 256 * 1024;
const SURFACE_COMPONENTS = {
  AGENCY_STATUS: { component: 'routine-operational-status', tag: 'agency_status' },
  AGENCY: { component: 'pursuit-context', tag: 'agency_pursuits' },
  WORKERS: { component: 'worker-context', tag: 'workers' },
} as const;

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | null => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as RecordValue : null;
const boundedText = (value: unknown, max: number): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const stringArray = (value: unknown, max = 64): value is string[] => Array.isArray(value) && value.length <= max
  && value.every(item => boundedText(item, 512)) && new Set(value).size === value.length;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const timestamp = (value: unknown): number | null => typeof value === 'string' && value.length <= 100
  && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

export interface ContextDecisionBehavior {
  kind: 'context-selection';
  surface: string;
  component: 'routine-operational-status' | 'pursuit-context' | 'worker-context';
  description: string;
}
export type ConversationDecisionBehavior = ConversationDecisionPayload['behavior'] & { component?: undefined; surface?: undefined };
export type LearningDecisionBehavior = ContextDecisionBehavior | ConversationDecisionBehavior;

export interface LearningDecisionDelivery {
  status: 'observed' | 'unavailable';
  reason?: string;
  sourceEventId?: string;
  timestamp?: string;
  selected?: boolean;
  loaded?: boolean;
  deliveredChars?: number;
  pointerOnly?: boolean;
  complete?: boolean;
  responseHash?: string;
  messageRef?: string;
  sourceSequence?: number;
}

export type LearningDecisionEvidence = {
  status: 'unavailable'; reason: string;
} | {
  status: 'verified';
  sourceEventId: string;
  timestamp: string;
  sessionRef: string;
  behavior: LearningDecisionBehavior;
  choice: string;
  relevant: boolean;
  explicit: boolean;
  delivery: LearningDecisionDelivery;
};

export type ReadLearningDecisionEvidence = (
  decisions: readonly LearningDecision[],
) => Promise<Record<string, LearningDecisionEvidence>>;

function coreWitness(decision: LearningDecision) {
  return { schema: decision.schema, decisionId: decision.decisionId, scope: decision.scope,
    tags: decision.tags, sourceRefs: decision.sourceRefs, criterion: decision.criterion };
}

function behaviorOf(value: unknown, witness: LearningDecision): ContextDecisionBehavior | null {
  const behavior = object(value);
  const expected = behavior && boundedText(behavior.surface, 64) && Object.hasOwn(SURFACE_COMPONENTS, behavior.surface)
    ? SURFACE_COMPONENTS[behavior.surface as keyof typeof SURFACE_COMPONENTS] : undefined;
  if (!behavior || behavior.kind !== 'context-selection' || !boundedText(behavior.surface, 64)
    || !expected || behavior.component !== expected.component || !witness.tags.includes('operational')
    || !witness.tags.includes(expected.tag) || !boundedText(behavior.description, 600)
    || !witness.sourceRefs.includes(`surface:${behavior.surface}`)) return null;
  return { kind: 'context-selection', surface: behavior.surface,
    component: behavior.component as ContextDecisionBehavior['component'], description: behavior.description };
}

async function completeTailIdentity(file: string) {
  let handle;
  try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Runtime ledger is not a regular file');
    if (stat.size) {
      const finalByte = Buffer.alloc(1);
      const read = await handle.read(finalByte, 0, 1, stat.size - 1);
      if (read.bytesRead !== 1 || finalByte[0] !== 10) throw new Error('Runtime ledger has an incomplete final record');
    }
    return { device: stat.dev, inode: stat.ino, size: stat.size };
  } finally { await handle.close(); }
}

function deliveryOf(rows: RecordValue[], decision: RecordValue, behavior: ContextDecisionBehavior): LearningDecisionDelivery {
  const matches = rows.filter(row => row.event_type === 'RetrievalExecuted'
    && Array.isArray(object(row.payload)?.learningDecisionIds)
    && (object(row.payload)!.learningDecisionIds as unknown[]).includes(decision.event_id));
  if (!matches.length) return { status: 'unavailable', reason: 'explicit_delivery_reference_not_observed' };
  if (matches.length !== 1) return { status: 'unavailable', reason: 'conflicting_delivery_references' };
  const receipt = matches[0]!;
  const payload = object(receipt.payload)!;
  const decisionTime = timestamp(decision.timestamp);
  const receiptTime = timestamp(receipt.timestamp);
  if (receipt.actor !== 'assembly' || !boundedText(receipt.event_id, 512) || receipt.session_id !== decision.session_id
    || decisionTime === null || receiptTime === null || receiptTime < decisionTime
    || !stringArray(payload.learningDecisionIds) || !stringArray(payload.surfaces_selected)
    || !stringArray(payload.surfaces_loaded) || !Array.isArray(payload.surface_delivery)) {
    return { status: 'unavailable', reason: 'delivery_provenance_mismatch' };
  }
  const selected = payload.surfaces_selected.includes(behavior.surface);
  const loaded = payload.surfaces_loaded.includes(behavior.surface);
  const entries = payload.surface_delivery.map(object).filter(entry => entry?.surface === behavior.surface);
  const choice = object(decision.payload)?.choice;
  if ((choice === 'omit' && (selected || loaded || entries.length > 0))
    || (!selected && (loaded || entries.length > 0)) || entries.length > 1 || (loaded && entries.length !== 1)) {
    return { status: 'unavailable', reason: 'delivery_selection_conflict' };
  }
  const entry = entries[0];
  if (entry && (entry.source !== `surface:${behavior.surface}`
    || !Number.isSafeInteger(entry.delivered_chars) || (entry.delivered_chars as number) < 0
    || typeof entry.pointer_only !== 'boolean' || typeof entry.complete !== 'boolean'
    || loaded !== ((entry.delivered_chars as number) > 0)
    || entry.pointer_only !== (entry.delivered_chars === 0))) {
    return { status: 'unavailable', reason: 'delivery_details_invalid' };
  }
  return { status: 'observed', sourceEventId: receipt.event_id, timestamp: receipt.timestamp as string,
    selected, loaded, deliveredChars: entry ? entry.delivered_chars as number : 0,
    ...(entry ? { pointerOnly: entry.pointer_only as boolean, complete: entry.complete as boolean } : {}) };
}

/** The same bounded, no-follow, complete-record checks serve source readback
 * and canonical-contact joins. Missing or torn evidence is never invented. */
export async function readBoundedLearningEvidenceRows(file: string, signal?: AbortSignal): Promise<RecordValue[]> {
  if (!isAbsolute(file)) throw new Error('Evidence path must be absolute');
  const before = await completeTailIdentity(file);
  const recent = await readRecentJsonlTail(file, {
    limit: MAX_RECORDS, maxEntries: MAX_RECORDS, maxBytes: MAX_BYTES, maxLineBytes: MAX_LINE_BYTES, signal,
  });
  const after = await completeTailIdentity(file);
  if ((before === null) !== (after === null) || (before && after
    && (before.device !== after.device || before.inode !== after.inode || after.size < before.size))
    || recent.some(row => object(row) === null)) throw new Error('Bounded evidence changed or contains malformed records');
  return recent as RecordValue[];
}

export interface VerifiedConversationSelection {
  eventId: string; timestamp: string; sessionRef: string;
  selectionId: string; conversationRef: string; turnId: string; messageRef: string; originMessageId: string;
  responseHash: string; candidateSetHash: string; reply: string;
  proposal: ConversationReplyProposal;
  decisions: ConversationDecisionPayload[];
  completedEventId: string;
}

/** A completed harness reply is distinct from a canonically delivered message. */
export function verifiedConversationSelections(rows: RecordValue[]): VerifiedConversationSelection[] {
  const result: VerifiedConversationSelection[] = [];
  for (const event of rows.filter(row => row.event_type === 'ConversationReplySelected' && row.actor === 'conversation')) {
    const payload = object(event.payload);
    if (!payload || payload.schema !== 'home23.conversation-selection.v1'
      || !boundedText(event.event_id, 512) || timestamp(event.timestamp) === null || !boundedText(event.session_id, 512)
      || !boundedText(payload.selectionId, 450) || !boundedText(payload.conversationRef, 512)
      || !payload.conversationRef.startsWith('coordination:') || !boundedText(payload.turnId, 512)
      || !boundedText(payload.messageRef, 512) || !boundedText(payload.originMessageId, 512)
      || typeof payload.selectedReply !== 'string' || typeof payload.responseHash !== 'string'
      || conversationResponseHash(payload.selectedReply) !== payload.responseHash
      || !stringArray(payload.decisionIds, 4) || payload.decisionIds.length !== 4) continue;
    const selections = rows.filter(row => row.event_type === 'ConversationReplySelected' && object(row.payload)?.selectionId === payload.selectionId);
    if (selections.length !== 1) continue;
    const proposal = parseConversationProposal(JSON.stringify({ schema: 'home23.conversation-proposal.v1', route: 'conversation',
      situation: payload.situation, candidates: payload.candidates }));
    if (!proposal || proposal.route !== 'conversation' || conversationCandidateSetHash(proposal) !== payload.candidateSetHash) continue;
    const selected = proposal.candidates.find(candidate => candidate.id === payload.selectedId);
    if (!selected || selected.reply !== payload.selectedReply || !same(selected.axes, payload.selectedAxes)) continue;
    const completed = rows.filter(row => row.event_type === 'ConversationReplyCompleted' && object(row.payload)?.selectionId === payload.selectionId);
    const terminal = completed.length === 1 ? completed[0] : undefined;
    const done = object(terminal?.payload);
    if (!terminal || terminal.actor !== 'conversation' || terminal.session_id !== event.session_id
      || !boundedText(terminal.event_id, 512) || timestamp(terminal.timestamp) === null
      || timestamp(terminal.timestamp)! < timestamp(event.timestamp)! || !done || done.schema !== 'home23.conversation-completion.v1' || done.status !== 'complete'
      || !['conversationRef', 'turnId', 'responseHash', 'candidateSetHash', 'originMessageId'].every(key => done[key] === payload[key])
      || !same(done.decisionIds, payload.decisionIds)) continue;
    const decisions: ConversationDecisionPayload[] = [];
    for (const axis of Object.keys(CONDUCT_AXES) as Array<keyof typeof CONDUCT_AXES>) {
      const id = `${payload.selectionId}:${axis}`;
      const events = rows.filter(row => row.event_id === id || object(row.payload)?.decisionId === id);
      if (events.length !== 1) break;
      const original = events[0]!;
      const raw = object(original.payload);
      const normalized = normalizeLearningDecision(raw);
      const behavior = object(raw?.behavior);
      if (!payload.decisionIds.includes(id) || original.event_type !== 'LearningDecisionObserved' || original.actor !== 'conversation'
        || original.event_id !== id || original.session_id !== event.session_id || timestamp(original.timestamp) === null
        || timestamp(original.timestamp)! < timestamp(event.timestamp)! || timestamp(original.timestamp)! > timestamp(terminal.timestamp)! || !normalized
        || normalized.scope !== `foreground.conduct.${axis}` || normalized.criterion !== 'owner-value'
        || !same(normalized.tags, [`situation:${proposal.situation}`, `choice:${selected.axes[axis]}`])
        || !same(normalized.sourceRefs, [payload.messageRef, payload.conversationRef, payload.selectionId])
        || raw?.choice !== selected.axes[axis] || !behavior || behavior.kind !== 'conversation-response'
        || behavior.axis !== axis || behavior.value !== selected.axes[axis] || behavior.situation !== proposal.situation
        || !['selectionId', 'conversationRef', 'turnId', 'responseHash', 'candidateSetHash'].every(key => behavior[key] === payload[key])) break;
      decisions.push({ ...normalized, behavior: behavior as unknown as ConversationDecisionPayload['behavior'], choice: selected.axes[axis] });
    }
    if (decisions.length !== 4) continue;
    result.push({ eventId: event.event_id, timestamp: event.timestamp as string, sessionRef: event.session_id,
      selectionId: payload.selectionId, conversationRef: payload.conversationRef, turnId: payload.turnId,
      messageRef: payload.messageRef, originMessageId: payload.originMessageId, responseHash: payload.responseHash,
      candidateSetHash: payload.candidateSetHash as string, reply: selected.reply, proposal, decisions,
      completedEventId: terminal.event_id });
  }
  return result;
}

export function canonicalConversationDelivery(selection: VerifiedConversationSelection, contacts: RecordValue[]): LearningDecisionDelivery {
  const channelId = selection.conversationRef.slice('coordination:'.length);
  const matches = contacts.filter(row => row.schema === 'home23.resident.contact.v1' && row.channelId === channelId
    && row.replyToMessageId === selection.originMessageId && row.role === 'assistant' && row.voice === 'self');
  if (matches.length !== 1) return { status: 'unavailable', reason: matches.length ? 'canonical_delivery_ambiguous' : 'canonical_delivery_not_observed' };
  const message = matches[0]!;
  const actor = object(message.actor);
  if (message.session !== selection.conversationRef || message.channelKind !== 'direct' || actor?.kind !== 'bot'
    || message.scheduled || message.runtime || message.worker
    || !boundedText(actor.principalId, 512) || !boundedText(message.messageId, 512)
    || message.contactId !== `message:${message.messageId}` || message.sourceRef !== `coordination.message:${message.messageId}`
    || typeof message.content !== 'string' || conversationResponseHash(message.content) !== selection.responseHash
    || !Number.isSafeInteger(message.sourceSequence) || (message.sourceSequence as number) < 0
    || timestamp(message.ts) === null || timestamp(message.ts)! < timestamp(selection.timestamp)!) {
    return { status: 'unavailable', reason: 'canonical_delivery_mismatch' };
  }
  return { status: 'observed', sourceEventId: message.sourceRef as string, messageRef: message.sourceRef as string,
    timestamp: message.ts as string, sourceSequence: message.sourceSequence as number,
    responseHash: selection.responseHash, deliveredChars: message.content.length, complete: true };
}

/** Read descriptions from the resident's runtime ledger, never from tool arguments.
 * These details explain an existing Seed witness; they do not grant teaching authority.
 */
export function createLearningDecisionEvidenceReader(
  ledgerPath: string,
  { signal, contactPath }: { signal?: AbortSignal; contactPath?: string } = {},
): ReadLearningDecisionEvidence {
  if (!isAbsolute(ledgerPath)) throw new Error('Learning evidence needs an absolute runtime-owned ledger path');
  return async decisions => {
    const result: Record<string, LearningDecisionEvidence> = Object.create(null);
    const unavailable = (reason: string) => {
      for (const decision of decisions) result[decision.decisionId] = { status: 'unavailable', reason };
      return result;
    };
    if (!decisions.length) return result;
    if (decisions.length > 20) return unavailable('witness_request_exceeds_limit');
    if (signal?.aborted) return unavailable('bounded_runtime_ledger_unavailable');
    let rows: RecordValue[];
    try {
      rows = await readBoundedLearningEvidenceRows(ledgerPath, signal);
    } catch {
      // A torn tail, cancellation, unsafe link or oversized record cannot become evidence.
      return unavailable('bounded_runtime_ledger_unavailable');
    }
    const conversations = verifiedConversationSelections(rows);
    let contacts: RecordValue[] = [];
    if (contactPath && conversations.length) {
      try { contacts = await readBoundedLearningEvidenceRows(contactPath, signal); } catch { /* Unavailable means no delivery claim. */ }
    }
    for (const witness of decisions) {
      if (witness.scope.startsWith('foreground.conduct.')) {
        const selection = conversations.find(item => item.decisions.some(decision => decision.decisionId === witness.decisionId));
        const original = selection?.decisions.find(decision => decision.decisionId === witness.decisionId);
        if (!selection || !original || !same(coreWitness(original), coreWitness(witness))) {
          result[witness.decisionId] = { status: 'unavailable', reason: 'conversation_response_evidence_unavailable' }; continue;
        }
        result[witness.decisionId] = { status: 'verified', sourceEventId: original.decisionId, timestamp: selection.timestamp,
          sessionRef: selection.sessionRef, behavior: original.behavior, choice: original.choice, relevant: true, explicit: false,
          delivery: canonicalConversationDelivery(selection, contacts) };
        continue;
      }
      const candidates = rows.filter(row => row.event_id === witness.decisionId
        || (row.event_type === 'LearningDecisionObserved' && object(row.payload)?.decisionId === witness.decisionId));
      if (!candidates.length) { result[witness.decisionId] = { status: 'unavailable', reason: 'decision_outside_recent_window' }; continue; }
      if (candidates.length !== 1) { result[witness.decisionId] = { status: 'unavailable', reason: 'conflicting_decision_identity' }; continue; }
      const event = candidates[0]!;
      const payload = object(event.payload);
      const normalized = normalizeLearningDecision(payload);
      if (event.event_type !== 'LearningDecisionObserved' || event.actor !== 'assembly'
        || event.event_id !== witness.decisionId || payload?.decisionId !== witness.decisionId
        || !normalized || !same(coreWitness(normalized), coreWitness(witness))
        || !boundedText(event.session_id, 512) || timestamp(event.timestamp) === null
        || (witness.observedAt !== undefined && event.timestamp !== witness.observedAt)) {
        result[witness.decisionId] = { status: 'unavailable', reason: 'retained_witness_mismatch' }; continue;
      }
      const behavior = behaviorOf(payload.behavior, witness);
      if (!behavior || !['admit', 'omit'].includes(String(payload.choice))
        || typeof payload.relevant !== 'boolean' || typeof payload.explicit !== 'boolean'
        || (payload.choice === 'admit' && !payload.relevant)
        || !witness.tags.includes(payload.explicit ? 'requested' : 'automatic')
        || witness.tags.includes(payload.explicit ? 'automatic' : 'requested')) {
        result[witness.decisionId] = { status: 'unavailable', reason: 'runtime_behavior_details_unavailable' }; continue;
      }
      result[witness.decisionId] = { status: 'verified', sourceEventId: event.event_id as string,
        timestamp: event.timestamp as string, sessionRef: event.session_id,
        behavior, choice: payload.choice as 'admit' | 'omit', relevant: payload.relevant, explicit: payload.explicit,
        delivery: deliveryOf(rows, event, behavior) };
    }
    return result;
  };
}
