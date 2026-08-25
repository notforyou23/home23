/**
 * Live reasoning/thinking parse for Responses-API streams (Codex + xAI).
 *
 * Prefer `response.reasoning_text` (full CoT) when the API emits it.
 * Fall back to `response.reasoning_summary_text` only when no full channel
 * arrived. Do not invent thinking when neither channel is present.
 */

export const THINKING_CHUNK_TARGET_CHARS = 96;
export const THINKING_CHUNK_MAX_CHARS = 240;

export type ReasoningStreamState = {
  reasoningText: string;
  reasoningSummary: string;
  pendingThinking: string;
  hasFullReasoning: boolean;
};

export function createReasoningStreamState(): ReasoningStreamState {
  return {
    reasoningText: '',
    reasoningSummary: '',
    pendingThinking: '',
    hasFullReasoning: false,
  };
}

export function shouldFlushThinkingBuffer(content: string): boolean {
  return content.length >= THINKING_CHUNK_MAX_CHARS
    || (content.length >= THINKING_CHUNK_TARGET_CHARS && /(?:\n|[.!?]\s*)$/.test(content));
}

function eventType(event: Record<string, unknown>): string {
  if (typeof event.type === 'string' && event.type) return event.type;
  if (typeof event._event === 'string' && event._event) return event._event;
  return '';
}

function eventString(event: Record<string, unknown>, key: 'delta' | 'text'): string {
  const value = event[key];
  return typeof value === 'string' ? value : '';
}

function spliceCompleted(already: string, completed: string, pending: string): {
  text: string;
  pending: string;
} {
  if (!completed) return { text: already, pending };
  if (!already) return { text: completed, pending: pending + completed };
  if (completed.startsWith(already)) {
    return { text: completed, pending: pending + completed.slice(already.length) };
  }
  return { text: completed, pending };
}

function textParts(
  parts: unknown,
  typeName: string,
): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part): part is { type: string; text: string } => {
      if (!part || typeof part !== 'object') return false;
      const rec = part as Record<string, unknown>;
      return rec.type === typeName && typeof rec.text === 'string' && rec.text.length > 0;
    })
    .map(part => part.text)
    .join('');
}

/** Apply a streamed reasoning event. Returns whether pending thinking changed. */
export function applyReasoningStreamEvent(
  event: Record<string, unknown>,
  state: ReasoningStreamState,
): 'delta' | 'done' | null {
  const evType = eventType(event);

  if (evType === 'response.reasoning_text.delta') {
    const delta = eventString(event, 'delta');
    if (!state.hasFullReasoning) state.pendingThinking = '';
    state.hasFullReasoning = true;
    state.reasoningText += delta;
    state.pendingThinking += delta;
    return 'delta';
  }

  if (evType === 'response.reasoning_text.done') {
    if (!state.hasFullReasoning) state.pendingThinking = '';
    state.hasFullReasoning = true;
    const next = spliceCompleted(state.reasoningText, eventString(event, 'text'), state.pendingThinking);
    state.reasoningText = next.text;
    state.pendingThinking = next.pending;
    return 'done';
  }

  if (evType === 'response.reasoning_summary_text.delta') {
    const delta = eventString(event, 'delta');
    state.reasoningSummary += delta;
    if (state.hasFullReasoning) return null;
    state.pendingThinking += delta;
    return 'delta';
  }

  if (evType === 'response.reasoning_summary_text.done') {
    const completed = eventString(event, 'text');
    if (completed) {
      if (!state.reasoningSummary) {
        if (!state.hasFullReasoning) state.pendingThinking += completed;
      } else if (completed.startsWith(state.reasoningSummary)) {
        if (!state.hasFullReasoning) {
          state.pendingThinking += completed.slice(state.reasoningSummary.length);
        }
      }
      state.reasoningSummary = completed;
    }
    return state.hasFullReasoning ? null : 'done';
  }

  return null;
}

/**
 * Catch completed reasoning items that carry plaintext the SSE deltas missed.
 * Prefer `content[].reasoning_text`; use `summary[].summary_text` only as fallback.
 */
export function applyReasoningOutputItem(
  item: Record<string, unknown> | undefined,
  state: ReasoningStreamState,
): 'done' | null {
  if (!item || item.type !== 'reasoning') return null;

  const full = textParts(item.content, 'reasoning_text');
  if (full) {
    if (!state.hasFullReasoning) state.pendingThinking = '';
    state.hasFullReasoning = true;
    const next = spliceCompleted(state.reasoningText, full, state.pendingThinking);
    state.reasoningText = next.text;
    state.pendingThinking = next.pending;
    return 'done';
  }

  if (state.hasFullReasoning) return null;
  const summary = textParts(item.summary, 'summary_text');
  if (!summary) return null;
  const next = spliceCompleted(state.reasoningSummary, summary, state.pendingThinking);
  state.reasoningSummary = next.text;
  state.pendingThinking = next.pending;
  return 'done';
}

export function visibleReasoningText(state: ReasoningStreamState): string {
  return (state.hasFullReasoning ? state.reasoningText : state.reasoningSummary).trim();
}
