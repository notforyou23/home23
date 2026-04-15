/**
 * Turn & event record types for resumable chat.
 *
 * Both types live in the conversation JSONL alongside StoredMessage and session_boundary.
 * HistoryStore.load() filters these out so the agent's message history stays clean;
 * the turn endpoints read them via HistoryStore.loadRaw().
 */

export type TurnStatus = 'pending' | 'complete' | 'error' | 'stopped' | 'orphaned';

export interface TurnEnvelope {
  type: 'turn';
  turn_id: string;
  chat_id: string;
  status: TurnStatus;
  role: 'assistant';
  started_at: string;
  ended_at?: string;
  model?: string;
  stop_reason?: string;
  error?: string;
  /** Max seq of any event belonging to this turn. Written on status-end records. */
  last_seq?: number;
}

export interface TurnEvent {
  type: 'event';
  turn_id: string;
  seq: number;
  ts: string;
  kind: 'thinking' | 'tool_start' | 'tool_result' | 'response_chunk' | 'media' | 'subagent_result' | 'cache';
  data: Record<string, unknown>;
}

export type TurnRecord = TurnEnvelope | TurnEvent;

export function isTurnEnvelope(r: unknown): r is TurnEnvelope {
  return typeof r === 'object' && r !== null && (r as { type?: string }).type === 'turn';
}

export function isTurnEvent(r: unknown): r is TurnEvent {
  return typeof r === 'object' && r !== null && (r as { type?: string }).type === 'event';
}

export function isTurnRecord(r: unknown): r is TurnRecord {
  return isTurnEnvelope(r) || isTurnEvent(r);
}

/** ULID-lite: time-ordered, URL-safe, no deps. */
export function newTurnId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `t_${ts}_${rand}`;
}
