/**
 * Live reasoning/thinking parse for Responses-API streams (Codex + xAI).
 *
 * Retain both provider channels when emitted. The legacy visible projection
 * prefers `response.reasoning_text` and falls back to the summary only when no
 * full channel arrived. Neither representation invents missing reasoning.
 */

export const THINKING_CHUNK_TARGET_CHARS = 96;
export const THINKING_CHUNK_MAX_CHARS = 240;

export type ReasoningStreamState = {
  reasoningText: string;
  reasoningSummary: string;
  pendingThinking: string;
  hasFullReasoning: boolean;
  pendingEvidence: ReasoningEvidenceChunk[];
};

export interface ReasoningEvidenceChunk {
  content: string;
  provenance: 'provider_verbatim_reasoning' | 'provider_reasoning_summary';
  sourceEventType: string;
  /** Exact provider object that caused this evidence event. */
  providerEvent: Readonly<Record<string, unknown>>;
}

export function createReasoningStreamState(): ReasoningStreamState {
  return {
    reasoningText: '',
    reasoningSummary: '',
    pendingThinking: '',
    hasFullReasoning: false,
    pendingEvidence: [],
  };
}

export function takeReasoningEvidence(state: ReasoningStreamState): ReasoningEvidenceChunk[] {
  const evidence = state.pendingEvidence;
  state.pendingEvidence = [];
  return evidence;
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

function completedSuffix(already: string, completed: string): string {
  if (!completed) return '';
  if (!already) return completed;
  return completed.startsWith(already) ? completed.slice(already.length) : '';
}

function recordEvidence(
  state: ReasoningStreamState,
  content: string,
  provenance: ReasoningEvidenceChunk['provenance'],
  sourceEventType: string,
  providerEvent: Record<string, unknown>,
): void {
  state.pendingEvidence.push(Object.freeze({
    content,
    provenance,
    sourceEventType,
    providerEvent: Object.freeze({ ...providerEvent }),
  }));
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
    recordEvidence(state, delta, 'provider_verbatim_reasoning', evType, event);
    if (!state.hasFullReasoning) state.pendingThinking = '';
    state.hasFullReasoning = true;
    state.reasoningText += delta;
    state.pendingThinking += delta;
    return 'delta';
  }

  if (evType === 'response.reasoning_text.done') {
    const completed = eventString(event, 'text');
    recordEvidence(state, completedSuffix(state.reasoningText, completed),
      'provider_verbatim_reasoning', evType, event);
    if (!state.hasFullReasoning) state.pendingThinking = '';
    state.hasFullReasoning = true;
    const next = spliceCompleted(state.reasoningText, completed, state.pendingThinking);
    state.reasoningText = next.text;
    state.pendingThinking = next.pending;
    return 'done';
  }

  if (evType === 'response.reasoning_summary_text.delta') {
    const delta = eventString(event, 'delta');
    recordEvidence(state, delta, 'provider_reasoning_summary', evType, event);
    state.reasoningSummary += delta;
    if (state.hasFullReasoning) return null;
    state.pendingThinking += delta;
    return 'delta';
  }

  if (evType === 'response.reasoning_summary_text.done') {
    const completed = eventString(event, 'text');
    recordEvidence(state, completedSuffix(state.reasoningSummary, completed),
      'provider_reasoning_summary', evType, event);
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
  const summary = textParts(item.summary, 'summary_text');
  let changed = false;
  if (full) {
    recordEvidence(state, completedSuffix(state.reasoningText, full),
      'provider_verbatim_reasoning', 'response.output_item.done', item);
    if (!state.hasFullReasoning) state.pendingThinking = '';
    state.hasFullReasoning = true;
    const next = spliceCompleted(state.reasoningText, full, state.pendingThinking);
    state.reasoningText = next.text;
    state.pendingThinking = next.pending;
    changed = true;
  }

  if (summary) {
    recordEvidence(state, completedSuffix(state.reasoningSummary, summary),
      'provider_reasoning_summary', 'response.output_item.done', item);
    const next = spliceCompleted(state.reasoningSummary, summary,
      state.hasFullReasoning ? '' : state.pendingThinking);
    state.reasoningSummary = next.text;
    if (!state.hasFullReasoning) state.pendingThinking = next.pending;
    changed = true;
  }
  return changed ? 'done' : null;
}

export function visibleReasoningText(state: ReasoningStreamState): string {
  return (state.hasFullReasoning ? state.reasoningText : state.reasoningSummary).trim();
}
