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
import { enrichTerminalEnvelope } from './history-projection.js';
import type { ReasoningEffort } from '../agent/reasoning-effort.js';

/**
 * Turn lifecycle on top of the conversation JSONL.
 * All reads scan the file — fine until conversations get huge; defer an index sidecar until it hurts.
 */
export class TurnStore {
  constructor(private history: ConversationHistory) {}

  writeStart(chatId: string, turn_id: string, model?: string, provider?: string, extras: {
    deadline_at?: string;
    activity_deadline_at?: string;
    hard_deadline_at?: string;
    first_token_deadline_at?: string;
    reasoning_effort?: ReasoningEffort;
    coordination_origin?: import('../agent/types.js').CoordinationTurnOrigin;
  } = {}): TurnEnvelope {
    const env: TurnEnvelope = {
      type: 'turn',
      turn_id,
      chat_id: chatId,
      status: 'pending',
      role: 'assistant',
      started_at: new Date().toISOString(),
      deadline_at: extras.deadline_at,
      activity_deadline_at: extras.activity_deadline_at,
      hard_deadline_at: extras.hard_deadline_at,
      first_token_deadline_at: extras.first_token_deadline_at,
      model,
      provider,
      reasoning_effort: extras.reasoning_effort,
      coordination_origin: extras.coordination_origin,
    };
    this.history.appendRecord(chatId, env);
    return env;
  }

  /** One fresh journal read for fenced replay; no cache can outlive a journal append. */
  replaySnapshot(chatId: string, turn_id: string): {
    start: TurnEnvelope | null; final: TurnEnvelope | null; events: TurnEvent[];
  } {
    const records = this.history.loadRaw(chatId);
    let start: TurnEnvelope | null = null;
    let final: TurnEnvelope | null = null;
    const events: TurnEvent[] = [];
    for (const record of records) {
      if (isTurnEnvelope(record) && record.turn_id === turn_id) {
        if (record.status === 'pending') start ??= record;
        else final = record;
      } else if (isTurnEvent(record) && record.turn_id === turn_id) events.push(record);
    }
    return { start, final: final ? enrichTerminalEnvelope(records, final) : null, events };
  }

  startEnvelope(chatId: string, turn_id: string): TurnEnvelope | null {
    return this.history.loadRaw(chatId).find(
      record => isTurnEnvelope(record) && record.turn_id === turn_id && record.status === 'pending',
    ) as TurnEnvelope | undefined ?? null;
  }

  writeEnd(chatId: string, turn_id: string, status: Exclude<TurnStatus, 'pending'>, extras: {
    last_seq: number;
    stop_reason?: string;
    error?: string;
    error_code?: string;
    error_message?: string;
    deadline_at?: string;
    activity_deadline_at?: string;
    hard_deadline_at?: string;
    first_token_deadline_at?: string;
  }): TurnEnvelope {
    const env: TurnEnvelope = {
      type: 'turn',
      turn_id,
      chat_id: chatId,
      status,
      role: 'assistant',
      started_at: '', // envelope records the END event — started_at lives on the start record
      ended_at: new Date().toISOString(),
      deadline_at: extras.deadline_at,
      activity_deadline_at: extras.activity_deadline_at,
      hard_deadline_at: extras.hard_deadline_at,
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
    return last ? enrichTerminalEnvelope(all, last) : null;
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
    let activityDeadlineAt: string | null = null;
    let hardDeadlineAt: string | null = null;

    for (const record of all) {
      if (isTurnEnvelope(record) && record.turn_id === turn_id) {
        if (record.status === 'pending') start = record;
        else final = record;
      } else if (isTurnEvent(record) && record.turn_id === turn_id) {
        if (!firstEvent) firstEvent = record;
        lastEvent = record;
        if (typeof record.data.activity_deadline_at === 'string') {
          activityDeadlineAt = record.data.activity_deadline_at;
        }
        if (typeof record.data.hard_deadline_at === 'string') {
          hardDeadlineAt = record.data.hard_deadline_at;
        }
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
      deadline_at: final?.deadline_at ?? activityDeadlineAt ?? start?.deadline_at ?? null,
      activity_deadline_at: final?.activity_deadline_at
        ?? activityDeadlineAt
        ?? start?.activity_deadline_at
        ?? null,
      hard_deadline_at: final?.hard_deadline_at
        ?? hardDeadlineAt
        ?? start?.hard_deadline_at
        ?? null,
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
        reasoning_effort: start?.reasoning_effort ?? final?.reasoning_effort ?? null,
      },
      stop_reason: final?.stop_reason ?? null,
      error_code: final?.error_code ?? (status === 'error' ? 'provider_error' : null),
      error_message: final?.error_message ?? final?.error ?? null,
      recoverable: status !== 'complete',
    };
  }

  /** Async janitor path; retain metadata only, never materialize message/event bodies. */
  async sweepOrphansAsync(chatId: string, maxAgeMs: number, preserve: (turn: TurnEnvelope) => boolean, onDeferred: (reason: string) => void = () => {}): Promise<TurnEnvelope[]> {
    const turns = new Map<string, TurnEnvelope>();
    const lastSeq = new Map<string, number>();
    const scalar = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
    let retainedBytes = 0;
    const metadataBytes = (turn: TurnEnvelope | undefined): number => turn ? 2 * (turn.turn_id.length + turn.chat_id.length + turn.started_at.length) + 256 : 0;
    const commit = await this.history.scanForRecovery(chatId, record => {
      if (isTurnEnvelope(record)) {
        if (!scalar(record.turn_id, 256) || !scalar(record.chat_id, 512)
          || record.chat_id.replace(/[^a-zA-Z0-9_-]/g, '_') !== chatId.replace(/[^a-zA-Z0-9_-]/g, '_')
          || !['pending', 'accepted', 'running', 'awaiting_model', 'streaming', 'tool_running', 'stopping', 'stopped', 'complete', 'error', 'timeout', 'orphaned'].includes(record.status)) throw new Error('invalid_turn_metadata');
        if (record.status === 'pending') {
          if (!scalar(record.started_at, 64) || !Number.isFinite(Date.parse(record.started_at))) throw new Error('invalid_turn_metadata');
          retainedBytes -= metadataBytes(turns.get(record.turn_id));
          retainedBytes += 2 * (record.turn_id.length + record.chat_id.length + record.started_at.length) + 256;
          if (retainedBytes > 4 * 1024 * 1024) throw new Error('metadata_limit');
          turns.set(record.turn_id, {
            type: 'turn', role: 'assistant', status: 'pending',
            turn_id: record.turn_id, chat_id: record.chat_id, started_at: record.started_at,
            coordination_origin: record.coordination_origin?.kind === 'coordination'
              ? { kind: 'coordination' } as TurnEnvelope['coordination_origin'] : undefined,
          });
        } else { retainedBytes -= metadataBytes(turns.get(record.turn_id)); turns.delete(record.turn_id); lastSeq.delete(record.turn_id); }
      } else if (isTurnEvent(record)) {
        if (!scalar(record.turn_id, 256) || !Number.isSafeInteger(record.seq) || record.seq < 0) throw new Error('invalid_turn_metadata');
        if (turns.has(record.turn_id)) lastSeq.set(record.turn_id, record.seq);
      }
      // Corrupt or pathological journals must not exhaust the harness heap.
      if (turns.size + lastSeq.size > 100_000) throw new Error('metadata_limit');
    }, onDeferred);
    const recovered: TurnEnvelope[] = [];
    commit?.(() => {
      for (const turn of turns.values()) {
        // Bound synchronous terminal writes; remaining orphans wait for the next sweep.
        if (recovered.length >= 32) break;
        if (turn.status !== 'pending' || preserve(turn)) continue;
        if (Date.now() - Date.parse(turn.started_at) < maxAgeMs || !Number.isFinite(Date.parse(turn.started_at))) continue;
        recovered.push(this.writeEnd(turn.chat_id || chatId, turn.turn_id, 'orphaned', {
          last_seq: lastSeq.get(turn.turn_id) ?? 0,
          error: 'process restarted or turn exceeded max age',
        }));
      }
    });
    return recovered;
  }

  /** Mark any pending turn older than maxAgeMs as orphaned. Returns the turn_ids marked. */
  sweepOrphans(chatId: string, maxAgeMs: number, options: { activeTurnIds?: Set<string> } = {}): string[] {
    const now = Date.now();
    const marked: string[] = [];
    for (const t of this.pendingTurns(chatId)) {
      if (options.activeTurnIds?.has(t.turn_id)) continue;
      const age = now - new Date(t.started_at).getTime();
      if (age >= maxAgeMs) {
        // listChatIds() necessarily returns the filesystem-safe storage key.
        // A turn envelope retains the canonical chat identity (notably the
        // colon-bearing coordination IDs), so terminalize against that exact
        // identity instead of leaking the storage key into durable state.
        const durableChatId = t.chat_id || chatId;
        // Find the last event for this turn to get last_seq
        const events = this.eventsSince(durableChatId, t.turn_id, -1);
        const last_seq = events.length ? events[events.length - 1]!.seq : 0;
        this.writeEnd(durableChatId, t.turn_id, 'orphaned', { last_seq, error: 'process restarted or turn exceeded max age' });
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
  if (lastEvent?.kind === 'thinking' || lastEvent?.kind === 'cache' || lastEvent?.kind === 'status'
      || lastEvent?.kind === 'subagent_start' || lastEvent?.kind === 'subagent_result') return 'awaiting_model';
  return active ? 'running' : 'accepted';
}

function phaseForStatus(status: Exclude<TurnStatus, 'pending'>, lastEvent: TurnEvent | null): string {
  if (lastEvent?.kind) return lastEvent.kind;
  return status;
}
