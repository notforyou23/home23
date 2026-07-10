/**
 * Turn & event record types for resumable chat.
 *
 * Both types live in the conversation JSONL alongside StoredMessage and session_boundary.
 * HistoryStore.load() filters these out so the agent's message history stays clean;
 * the turn endpoints read them via HistoryStore.loadRaw().
 */

export type TurnStatus =
  | 'pending'
  | 'accepted'
  | 'running'
  | 'awaiting_model'
  | 'streaming'
  | 'tool_running'
  | 'stopping'
  | 'stopped'
  | 'complete'
  | 'error'
  | 'timeout'
  | 'orphaned';

export interface TurnEnvelope {
  type: 'turn';
  turn_id: string;
  chat_id: string;
  status: TurnStatus;
  role: 'assistant';
  started_at: string;
  ended_at?: string;
  deadline_at?: string;
  activity_deadline_at?: string;
  hard_deadline_at?: string;
  first_token_deadline_at?: string;
  model?: string;
  provider?: string;
  stop_reason?: string;
  error?: string;
  error_code?: string;
  error_message?: string;
  /** Max seq of any event belonging to this turn. Written on status-end records. */
  last_seq?: number;
}

export interface TurnEvent {
  type: 'event';
  turn_id: string;
  seq: number;
  ts: string;
  kind: 'thinking' | 'tool_start' | 'tool_result' | 'response_chunk' | 'media' | 'subagent_result' | 'cache' | 'status';
  data: Record<string, unknown>;
}

export type TurnRecord = TurnEnvelope | TurnEvent;

export interface TurnStatusOptions {
  active?: boolean;
  provider?: string | null;
  defaultModel?: string | null;
  defaultProvider?: string | null;
}

export interface TurnStatusResponse {
  turn_id: string;
  chat_id: string;
  status: Exclude<TurnStatus, 'pending'>;
  phase: string;
  active: boolean;
  started_at: string;
  updated_at: string;
  last_event_at: string | null;
  first_event_at: string | null;
  deadline_at?: string | null;
  activity_deadline_at?: string | null;
  hard_deadline_at?: string | null;
  first_token_deadline_at?: string | null;
  last_seq: number | null;
  model: string | null;
  provider: string | null;
  configured_default: {
    provider: string | null;
    model: string | null;
  };
  runtime_model: {
    provider: string | null;
    model: string | null;
  };
  stop_requested_at?: string | null;
  stop_reason?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  recoverable: boolean;
}

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
