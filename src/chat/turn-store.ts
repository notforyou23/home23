import type { ConversationHistory } from '../agent/history.js';
import {
  type TurnEnvelope,
  type TurnEvent,
  type TurnStatusOptions,
  type TurnStatusResponse,
  type TurnStatus,
  isTurnEnvelope,
  isTurnEvent,
} from './turn-types.js';

/**
 * Turn lifecycle on top of the conversation JSONL.
 * All reads scan the file — fine until conversations get huge; defer an index sidecar until it hurts.
 */
export class TurnStore {
  constructor(private history: ConversationHistory) {}

  writeStart(chatId: string, turn_id: string, model?: string, provider?: string, extras: { deadline_at?: string; first_token_deadline_at?: string } = {}): TurnEnvelope {
    const env: TurnEnvelope = {
      type: 'turn',
      turn_id,
      chat_id: chatId,
      status: 'pending',
      role: 'assistant',
      started_at: new Date().toISOString(),
      deadline_at: extras.deadline_at,
      first_token_deadline_at: extras.first_token_deadline_at,
      model,
      provider,
    };
    this.history.appendRecord(chatId, env);
    return env;
  }

  writeEnd(chatId: string, turn_id: string, status: Exclude<TurnStatus, 'pending'>, extras: { last_seq: number; stop_reason?: string; error?: string; error_code?: string; error_message?: string; deadline_at?: string; first_token_deadline_at?: string }): TurnEnvelope {
    const env: TurnEnvelope = {
      type: 'turn',
      turn_id,
      chat_id: chatId,
      status,
      role: 'assistant',
      started_at: '', // envelope records the END event — started_at lives on the start record
      ended_at: new Date().toISOString(),
      deadline_at: extras.deadline_at,
      first_token_deadline_at: extras.first_token_deadline_at,
      last_seq: extras.last_seq,
      stop_reason: extras.stop_reason,
      error: extras.error,
      error_code: extras.error_code,
      error_message: extras.error_message,
    };
    this.history.appendRecord(chatId, env);
    return env;
  }

  writeEvent(chatId: string, event: TurnEvent): void {
    this.history.appendRecord(chatId, event);
  }

  /** Return all events for a turn with seq > cursor, in order. */
  eventsSince(chatId: string, turn_id: string, cursor: number): TurnEvent[] {
    const all = this.history.loadRaw(chatId);
    const events: TurnEvent[] = [];
    for (const r of all) {
      if (isTurnEvent(r) && r.turn_id === turn_id && r.seq > cursor) events.push(r);
    }
    return events;
  }

  /** Find the final envelope for a turn, if any. */
  finalEnvelope(chatId: string, turn_id: string): TurnEnvelope | null {
    const all = this.history.loadRaw(chatId);
    let last: TurnEnvelope | null = null;
    for (const r of all) {
      if (isTurnEnvelope(r) && r.turn_id === turn_id && r.status !== 'pending') last = r;
    }
    return last;
  }

  /** List all turns in a chat, last-record-wins per turn_id. */
  listTurns(chatId: string): TurnEnvelope[] {
    const all = this.history.loadRaw(chatId);
    const byId = new Map<string, TurnEnvelope>();
    for (const r of all) {
      if (isTurnEnvelope(r)) byId.set(r.turn_id, r);
    }
    return [...byId.values()];
  }

  /** Any turn whose most recent envelope is still pending. */
  pendingTurns(chatId: string): TurnEnvelope[] {
    return this.listTurns(chatId).filter(t => t.status === 'pending');
  }

  statusForTurn(chatId: string, turn_id: string, options: TurnStatusOptions = {}): TurnStatusResponse | null {
    const all = this.history.loadRaw(chatId);
    let start: TurnEnvelope | null = null;
    let final: TurnEnvelope | null = null;
    let firstEvent: TurnEvent | null = null;
    let lastEvent: TurnEvent | null = null;

    for (const record of all) {
      if (isTurnEnvelope(record) && record.turn_id === turn_id) {
        if (record.status === 'pending') start = record;
        else final = record;
      } else if (isTurnEvent(record) && record.turn_id === turn_id) {
        if (!firstEvent) firstEvent = record;
        lastEvent = record;
      }
    }

    if (!start && !final && !lastEvent) return null;

    const active = Boolean(options.active);
    const base = start ?? final;
    const startedAt = base?.started_at || final?.ended_at || lastEvent?.ts || new Date().toISOString();
    const lastSeq = final?.last_seq ?? lastEvent?.seq ?? null;
    const model = start?.model ?? final?.model ?? options.defaultModel ?? null;
    const provider = start?.provider ?? final?.provider ?? options.provider ?? options.defaultProvider ?? null;
    const terminalStatus = final?.status && final.status !== 'pending' ? final.status : null;
    const status = terminalStatus ?? statusFromPending(active, lastEvent);
    const updatedAt = final?.ended_at ?? lastEvent?.ts ?? startedAt;

    return {
      turn_id,
      chat_id: chatId,
      status,
      phase: phaseForStatus(status, lastEvent),
      active: terminalStatus ? false : active,
      started_at: startedAt,
      updated_at: updatedAt,
      last_event_at: lastEvent?.ts ?? final?.ended_at ?? null,
      first_event_at: firstEvent?.ts ?? null,
      deadline_at: final?.deadline_at ?? start?.deadline_at ?? null,
      first_token_deadline_at: final?.first_token_deadline_at ?? start?.first_token_deadline_at ?? null,
      last_seq: lastSeq,
      model,
      provider,
      configured_default: {
        provider: options.defaultProvider ?? null,
        model: options.defaultModel ?? null,
      },
      runtime_model: {
        provider,
        model,
      },
      stop_reason: final?.stop_reason ?? null,
      error_code: final?.error_code ?? (status === 'error' ? 'provider_error' : null),
      error_message: final?.error_message ?? final?.error ?? null,
      recoverable: status !== 'complete',
    };
  }

  /** Mark any pending turn older than maxAgeMs as orphaned. Returns the turn_ids marked. */
  sweepOrphans(chatId: string, maxAgeMs: number, options: { activeTurnIds?: Set<string> } = {}): string[] {
    const now = Date.now();
    const marked: string[] = [];
    for (const t of this.pendingTurns(chatId)) {
      if (options.activeTurnIds?.has(t.turn_id)) continue;
      const age = now - new Date(t.started_at).getTime();
      if (age >= maxAgeMs) {
        // Find the last event for this turn to get last_seq
        const events = this.eventsSince(chatId, t.turn_id, -1);
        const last_seq = events.length ? events[events.length - 1]!.seq : 0;
        this.writeEnd(chatId, t.turn_id, 'orphaned', { last_seq, error: 'process restarted or turn exceeded max age' });
        marked.push(t.turn_id);
      }
    }
    return marked;
  }
}

function statusFromPending(active: boolean, lastEvent: TurnEvent | null): Exclude<TurnStatus, 'pending'> {
  if (lastEvent?.kind === 'response_chunk') return 'streaming';
  if (lastEvent?.kind === 'tool_start') return 'tool_running';
  if (lastEvent?.kind === 'tool_result') return 'running';
  if (lastEvent?.kind === 'thinking' || lastEvent?.kind === 'cache' || lastEvent?.kind === 'status') return 'awaiting_model';
  return active ? 'running' : 'accepted';
}

function phaseForStatus(status: Exclude<TurnStatus, 'pending'>, lastEvent: TurnEvent | null): string {
  if (lastEvent?.kind) return lastEvent.kind;
  return status;
}
