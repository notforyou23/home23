import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyReasoningOutputItem,
  applyReasoningStreamEvent,
  createReasoningStreamState,
  visibleReasoningText,
} from '../../src/agent/reasoning-stream.js';

function flushPending(state: ReturnType<typeof createReasoningStreamState>): string {
  const text = state.pendingThinking;
  state.pendingThinking = '';
  return text;
}

function play(events: Array<Record<string, unknown>>): {
  thinking: string[];
  visible: string;
  hasFull: boolean;
} {
  const state = createReasoningStreamState();
  const thinking: string[] = [];
  for (const event of events) {
    const evType = typeof event.type === 'string' ? event.type : '';
    if (evType === 'response.output_item.done') {
      const kind = applyReasoningOutputItem(event.item as Record<string, unknown> | undefined, state);
      if (kind === 'done') {
        const chunk = flushPending(state);
        if (chunk) thinking.push(chunk);
      }
      continue;
    }
    const kind = applyReasoningStreamEvent(event, state);
    if (kind === 'delta' || kind === 'done') {
      if (kind === 'done' || state.pendingThinking.length >= 8) {
        const chunk = flushPending(state);
        if (chunk) thinking.push(chunk);
      }
    }
  }
  const leftover = flushPending(state);
  if (leftover) thinking.push(leftover);
  return { thinking, visible: visibleReasoningText(state), hasFull: state.hasFullReasoning };
}

test('forwards full Codex/xAI reasoning_text deltas, not the synopsis titles', () => {
  const result = play([
    { type: 'response.reasoning_text.delta', delta: 'The operator asked for a live thought stream. ' },
    { type: 'response.reasoning_summary_text.delta', delta: '**Planning concise natural response**' },
    { type: 'response.reasoning_text.delta', delta: 'I should emit the full chain of thought, not a title.' },
    { type: 'response.reasoning_summary_text.done', text: '**Planning concise natural response**' },
    { type: 'response.reasoning_text.done', text: 'The operator asked for a live thought stream. I should emit the full chain of thought, not a title.' },
  ]);

  assert.equal(result.hasFull, true);
  assert.match(result.thinking.join(''), /full chain of thought/);
  assert.doesNotMatch(result.thinking.join(''), /Planning concise natural response/);
  assert.equal(
    result.visible,
    'The operator asked for a live thought stream. I should emit the full chain of thought, not a title.',
  );
});

test('falls back to reasoning_summary_text only when no full channel exists', () => {
  const result = play([
    { type: 'response.reasoning_summary_text.delta', delta: 'Need ' },
    { type: 'response.reasoning_summary_text.delta', delta: 'the files.' },
    { type: 'response.reasoning_summary_text.done', text: 'Need the files.' },
  ]);

  assert.equal(result.hasFull, false);
  assert.equal(result.thinking.join(''), 'Need the files.');
  assert.equal(result.visible, 'Need the files.');
});

test('does not invent thinking when the stream has neither reasoning channel', () => {
  const result = play([
    { type: 'response.output_text.delta', delta: 'Hello' },
    { type: 'response.output_item.done', item: { type: 'reasoning', encrypted_content: 'opaque' } },
  ]);

  assert.equal(result.hasFull, false);
  assert.deepEqual(result.thinking, []);
  assert.equal(result.visible, '');
});

test('extracts full reasoning_text from a completed reasoning output item', () => {
  const result = play([
    {
      type: 'response.output_item.done',
      item: {
        type: 'reasoning',
        encrypted_content: 'opaque',
        summary: [{ type: 'summary_text', text: '**Title only**' }],
        content: [{ type: 'reasoning_text', text: 'Here is the actual multi-sentence thought the operator asked to see.' }],
      },
    },
  ]);

  assert.equal(result.hasFull, true);
  assert.equal(result.thinking.join(''), 'Here is the actual multi-sentence thought the operator asked to see.');
  assert.doesNotMatch(result.thinking.join(''), /Title only/);
});

test('reads reasoning event type from the SSE event header when JSON type is absent', () => {
  const result = play([
    { _event: 'response.reasoning_text.delta', delta: 'Grok full thought. ' },
    { _event: 'response.reasoning_text.delta', delta: 'Still going.' },
    { _event: 'response.reasoning_text.done', text: 'Grok full thought. Still going.' },
  ]);

  assert.equal(result.hasFull, true);
  assert.equal(result.thinking.join(''), 'Grok full thought. Still going.');
});
