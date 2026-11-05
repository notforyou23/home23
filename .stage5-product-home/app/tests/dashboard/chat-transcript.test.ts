import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHOW_MORE_CHARS,
  collectThinkingText,
  createTranscript,
  formatTranscriptMarkdown,
  projectHistoryToRows,
  snapshotTranscriptRows,
  stringifyPayload,
} from '../../engine/src/dashboard/home23-chat-transcript.mjs';
import * as chatModule from '../../engine/src/dashboard/home23-chat.js';

const STARTER_PROMPTS = [
  'Hey Jerry. Where are we?',
  'What changed since we last talked that actually matters?',
  'What have we forgotten or let fall by the wayside?',
  'What are you noticing that I’m not?',
  'TCB: pick the most worthwhile thing you can finish right now.',
  'Pick up our most alive thread and make the next move.',
  'What actually needs me today—and what can you handle?',
  'Let’s make something. Give me three directions worth pursuing.',
];

class FakeElement {
  tagName: string;
  className = '';
  children: FakeElement[] = [];
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  textContent = '';
  type = '';
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  private listeners = new Map<string, Array<(event: any) => void>>();
  private markup = '';

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get classList() {
    return {
      contains: (name: string) => this.className.split(/\s+/).includes(name),
    };
  }

  get innerHTML() {
    return this.markup;
  }

  set innerHTML(value: string) {
    this.markup = String(value);
    this.children = [];
    const plainEmpty = this.markup.match(/^<div class="h23-chat-empty">([^<]*)<\/div>$/);
    if (plainEmpty) {
      const child = new FakeElement('div');
      child.className = 'h23-chat-empty';
      child.textContent = plainEmpty[1];
      this.append(child);
    }
  }

  append(...children: FakeElement[]) {
    this.markup = '';
    this.children.push(...children);
  }

  appendChild(child: FakeElement) {
    this.append(child);
    return child;
  }

  replaceChildren(...children: FakeElement[]) {
    this.markup = '';
    this.children = children;
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = String(value);
  }

  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }

  addEventListener(type: string, listener: (event: any) => void) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event: any) {
    for (const listener of this.listeners.get(event.type) || []) listener(event);
    return true;
  }

  click() {
    this.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} });
  }
}

function withFakeDocument(run: () => void) {
  const previous = (globalThis as any).document;
  (globalThis as any).document = {
    createElement: (tagName: string) => new FakeElement(tagName),
  };
  try {
    run();
  } finally {
    if (previous === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = previous;
  }
}

describe('stringifyPayload', () => {
  it('does not silently slice at 1200 or 4000 characters', () => {
    const mid = 'x'.repeat(5000);
    const parsed = stringifyPayload({ body: mid });
    assert.ok(parsed.text.includes(mid));
    assert.equal(parsed.overflow, false);
    assert.doesNotMatch(parsed.display, /truncated/i);
  });

  it('only caps pathological blobs above SHOW_MORE_CHARS', () => {
    const huge = 'a'.repeat(SHOW_MORE_CHARS + 20);
    const parsed = stringifyPayload(huge);
    assert.equal(parsed.overflow, true);
    assert.equal(parsed.display.length, SHOW_MORE_CHARS);
    assert.equal(parsed.text.length, SHOW_MORE_CHARS + 20);
  });
});

describe('projectHistoryToRows', () => {
  it('keeps thinking rows collapsed in projection so the Chat toggle can open them', () => {
    const rows = projectHistoryToRows([
      { role: 'user', content: 'check status' },
      {
        type: 'event', kind: 'thinking', turn_id: 't1',
        data: { type: 'thinking', content: 'looking up brain_status' },
      },
      {
        type: 'event', kind: 'tool_start', turn_id: 't1',
        data: { type: 'tool_start', tool: 'brain_status', args: { deep: true } },
      },
      {
        type: 'event', kind: 'tool_result', turn_id: 't1',
        data: { type: 'tool_result', tool: 'brain_status', result: 'nodes=12', success: true },
      },
      { role: 'assistant', content: 'Brain is healthy.', turn_id: 't1', canonical: true },
      { type: 'turn', turn_id: 't1', status: 'complete' },
    ]);

    assert.equal(rows[0].kind, 'user');
    assert.equal(rows[1].kind, 'thinking');
    assert.equal(rows[1].text, 'looking up brain_status');
    assert.equal(rows[1].collapsed, true);
    assert.equal(rows[2].kind, 'tool');
    assert.equal(rows[2].name, 'brain_status');
    assert.equal(rows[2].status, 'complete');
    assert.equal(rows[2].result, 'nodes=12');
    assert.deepEqual(rows[2].args, { deep: true });
    assert.equal(rows[3].kind, 'assistant');
    assert.equal(rows[3].text, 'Brain is healthy.');
    assert.ok(!rows.some((row) => row.kind === 'turn'));
  });

  it('joins only the current turn for the thought rail', () => {
    const text = collectThinkingText([
      { role: 'user', content: 'first' },
      { type: 'event', kind: 'thinking', turn_id: 't1', data: { type: 'thinking', content: 'old look' } },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'second' },
      { type: 'event', kind: 'thinking', turn_id: 't2', data: { type: 'thinking', content: 'first look' } },
      { type: 'event', kind: 'tool_start', turn_id: 't2', data: { type: 'tool_start', tool: 'brain_status' } },
      { type: 'event', kind: 'thinking', turn_id: 't2', data: { type: 'thinking', content: 'then the graph' } },
    ]);
    assert.equal(text, 'first look\n\nthen the graph');
  });

  it('uses the latest turn when history records thinking before the persisted user row', () => {
    const text = collectThinkingText([
      { type: 'event', kind: 'thinking', turn_id: 't1', data: { type: 'thinking', content: 'old look' } },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'done' },
      { type: 'event', kind: 'thinking', turn_id: 't2', data: { type: 'thinking', content: 'first look' } },
      { type: 'event', kind: 'tool_start', turn_id: 't2', data: { type: 'tool_start', tool: 'brain_status' } },
      { type: 'event', kind: 'thinking', turn_id: 't2', data: { type: 'thinking', content: 'then the graph' } },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'answered' },
    ]);
    assert.equal(text, 'first look\n\nthen the graph');
  });

  it('can still join every thinking row when asked', () => {
    const records = [
      { role: 'user', content: 'first' },
      { type: 'event', kind: 'thinking', data: { type: 'thinking', content: 'old look' } },
      { role: 'user', content: 'second' },
      { type: 'event', kind: 'thinking', data: { type: 'thinking', content: 'new look' } },
    ];
    assert.equal(collectThinkingText(records, { currentTurnOnly: false }), 'old look\n\nnew look');
    assert.equal(collectThinkingText(records), 'new look');
  });

  it('projects subagent results as work rows', () => {
    const rows = projectHistoryToRows([
      {
        type: 'event', kind: 'subagent_result',
        data: { type: 'subagent_result', task: 'audit ports', result: '5002 open' },
      },
    ]);
    assert.equal(rows[0].kind, 'work');
    assert.equal(rows[0].label, 'audit ports');
    assert.equal(rows[0].status, 'completed');
  });
});

describe('formatTranscriptMarkdown', () => {
  it('renders user, thought, tool, and assistant rows as readable markdown', () => {
    const markdown = formatTranscriptMarkdown([
      { kind: 'user', text: 'check status' },
      { kind: 'thinking', text: 'looking up brain_status' },
      { kind: 'tool', name: 'brain_status', status: 'complete', args: '{ deep: true }', result: 'nodes=12' },
      { kind: 'assistant', text: 'Brain is healthy.' },
    ], { agent: 'Jerry', conversationId: 'chat-1', exportedAt: '2026-08-20T16:00:00.000Z' });

    assert.match(markdown, /^# Chat transcript/m);
    assert.match(markdown, /Agent: Jerry/);
    assert.match(markdown, /## User\n\ncheck status/);
    assert.match(markdown, /## Thought\n\nlooking up brain_status/);
    assert.match(markdown, /## Tool `brain_status` \(complete\)/);
    assert.match(markdown, /## Assistant\n\nBrain is healthy\./);
  });
});

describe('empty conversation starters', () => {
  it('renders exactly eight accessible prompt buttons and keeps them out of transcript snapshots', () => {
    withFakeDocument(() => {
      const container = new FakeElement('div');
      const selected: string[] = [];
      const transcript = createTranscript(container as any, {
        onPromptSelect: (prompt: string) => selected.push(prompt),
      });

      transcript.emptyState();

      assert.equal(container.children.length, 1);
      const empty = container.children[0];
      assert.ok(empty.classList.contains('h23-chat-empty'));
      assert.equal(empty.getAttribute('role'), 'group');
      assert.equal(empty.getAttribute('aria-label'), 'Conversation starters');
      assert.equal(empty.children.length, 1);

      const buttons = empty.children[0].children;
      assert.equal(buttons.length, 8);
      assert.deepEqual(buttons.map((button) => button.textContent), STARTER_PROMPTS);
      for (const button of buttons) {
        assert.equal(button.tagName, 'BUTTON');
        assert.equal(button.type, 'button');
      }

      buttons[3].click();
      assert.deepEqual(selected, [STARTER_PROMPTS[3]]);
      assert.deepEqual(snapshotTranscriptRows(container as any), []);
    });
  });

  it('keeps explicit special empty states as plain text', () => {
    withFakeDocument(() => {
      const container = new FakeElement('div');
      const transcript = createTranscript(container as any);

      transcript.emptyState('No agents configured. Create one in Settings.');

      assert.equal(container.children.length, 1);
      const empty = container.children[0];
      assert.equal(empty.textContent, 'No agents configured. Create one in Settings.');
      assert.equal(empty.children.length, 0);
    });
  });

  it('populates and focuses the composer through its existing input event without sending', () => {
    const chatExports = Reflect.get(chatModule, 'default') || chatModule;
    const populateChatInput = Reflect.get(chatExports, 'populateChatInput');
    assert.equal(typeof populateChatInput, 'function');

    const events: string[] = [];
    let focused = false;
    const input = {
      value: '',
      dispatchEvent(event: Event) { events.push(event.type); },
      focus() { focused = true; },
    };

    assert.equal(populateChatInput(STARTER_PROMPTS[0], input), true);
    assert.equal(input.value, STARTER_PROMPTS[0]);
    assert.deepEqual(events, ['input']);
    assert.equal(focused, true);
  });
});
