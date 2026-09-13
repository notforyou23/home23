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
  workConversationId,
  readableToolResult,
  toolLabel,
  toolOutcome,
  subagentProgressRow,
  activityStatusLabel,
  turnContinuation,
  workReceiptPresentation,
} from '../../engine/src/dashboard/home23-chat-transcript.mjs';
import * as chatModule from '../../engine/src/dashboard/home23-chat.js';
import { reconcileCanonicalAssistantElements } from '../../engine/src/dashboard/home23-chat-reconstruction.mjs';

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
  open = false;
  hidden = false;
  private listeners = new Map<string, Array<(event: any) => void>>();
  private markup = '';

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get classList() {
    return {
      contains: (name: string) => this.className.split(/\s+/).includes(name),
      add: (name: string) => { this.className += ` ${name}`; },
      toggle: (name: string, enabled: boolean) => {
        this.className = this.className.split(/\s+/).filter(value => value !== name).concat(enabled ? [name] : []).join(' ');
      },
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

  insertBefore(child: FakeElement, reference: FakeElement) {
    this.children.splice(this.children.indexOf(reference), 0, child);
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

  querySelectorAll(selector: string): FakeElement[] {
    const parts = selector.split(' ');
    const matches = (element: FakeElement, part: string) => part.startsWith('.')
      ? part.slice(1).split('.').every(name => element.classList.contains(name))
      : element.tagName === part.toUpperCase();
    const descendants = (element: FakeElement): FakeElement[] => element.children.flatMap(child => [child, ...descendants(child)]);
    let scope: FakeElement[] = [this];
    for (const part of parts) scope = scope.flatMap(element => descendants(element).filter(child => matches(child, part)));
    return scope;
  }

  querySelector(selector: string): FakeElement | null { return this.querySelectorAll(selector)[0] || null; }
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
    assert.equal(rows[0].status, 'finished');
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

describe('inline activity continuity', () => {
  const event = (kind: string, data: any, turn = 't1') => ({ type: 'event', kind, turn_id: turn, data });

  it('pairs concurrent same-name tool calls by ID and leaves ambiguous legacy results separate', () => {
    const rows = projectHistoryToRows([
      event('tool_start', { tool: 'read', toolCallId: 'a', args: 'alpha' }),
      event('tool_start', { tool: 'read', toolCallId: 'b', args: 'beta' }),
      event('tool_result', { tool: 'read', toolCallId: 'a', result: 'A' }),
      event('tool_result', { tool: 'read', toolCallId: 'b', result: 'B' }),
      event('tool_start', { tool: 'read' }, 't2'),
      event('tool_start', { tool: 'read' }, 't2'),
      event('tool_result', { tool: 'read', result: 'unattributed' }, 't2'),
    ]);
    assert.deepEqual(rows.slice(0, 2).map(row => [row.toolCallId, row.result]), [['a', 'A'], ['b', 'B']]);
    assert.deepEqual(rows.slice(2).map(row => row.status), ['running', 'running', 'finished']);
    assert.equal(rows[4].result, 'unattributed');
  });

  it('keeps historical thoughts in order and updates the original subagent bubble', () => {
    const rows = projectHistoryToRows([
      event('thinking', { content: 'First ' }), event('thinking', { content: 'thought.' }),
      event('subagent_start', { subagentId: 's1', label: 'Check navigation', task: 'Inspect the back gesture' }),
      event('thinking', { content: 'While it runs.' }),
      event('subagent_result', { subagentId: 's1', task: 'Inspect the back gesture', result: 'Verified', success: true }),
    ]);
    assert.deepEqual(rows.map(row => row.kind), ['thinking', 'work', 'thinking']);
    assert.equal(rows[0].text, 'First thought.');
    assert.equal(rows[1].label, 'Check navigation');
    assert.equal(rows[1].status, 'completed');
    assert.equal(rows[1].result, 'Verified');
    assert.equal(workConversationId({ originChatId: 'project-chat', resultHandle: { type: 'subagent_chat', chatId: 'hidden-child' } }), 'project-chat');
  });

  it('preserves cancellation and legacy failure outcomes in subagent history', () => {
    const rows = projectHistoryToRows([
      event('subagent_result', { subagentId: 'cancelled', result: 'Cancelled: owner stopped', success: false, sourceEventType: 'runtime.subagent_cancelled' }),
      event('subagent_result', { subagentId: 'failed', result: 'Error: unavailable' }),
    ]);
    assert.deepEqual(rows.map(row => row.status), ['cancelled', 'failed']);
  });

  it('keeps nested subagent text and thoughts inside its named bubble in live and history views', () => withFakeDocument(() => {
    const host = new FakeElement('div');
    const view = createTranscript(host);
    view.appendWorkReceipt({ workId: 's1', label: 'Navigation check', task: 'Inspect the back gesture', status: 'running' });
    const parent = view.appendAssistant('Parent explanation', 't1');
    const progress = (activity: any) => ({ type: 'subagent_progress', subagentId: 's1', label: 'Navigation check', task: 'Inspect the back gesture', activity });
    view.appendSubagentProgress(progress({ type: 'thinking', content: '**Inspecting** ' }));
    view.appendSubagentProgress(progress({ type: 'thinking', content: 'the gesture' }));
    const card = host.querySelector('.h23-chat-work');
    assert.match(card.querySelector('.h23-chat-work-progress').innerHTML, /<strong>Inspecting<\/strong> the gesture/);
    assert.equal(card.dataset.status, 'running');
    view.appendSubagentProgress(progress({ type: 'response_chunk', chunk: 'Child ' }));
    view.appendSubagentProgress(progress({ type: 'response_chunk', chunk: 'finding' }));
    view.updateAssistant('Parent explanation continues', 't1');
    assert.equal(host.querySelectorAll('.assistant').length, 1);
    assert.equal(parent.dataset.sourceText, 'Parent explanation continues');
    assert.match(card.querySelector('.h23-chat-work-progress').innerHTML, /Child finding/);
    view.appendSubagentProgress(progress({ type: 'tool_start', tool: 'channel_manage', args: { operation: 'list' } }));
    assert.match(card.querySelector('.h23-chat-work-progress').innerHTML, /List channels/);
    assert.equal(card.querySelector('.h23-chat-technical').open, false);
    const rows = projectHistoryToRows([
      event('subagent_start', { subagentId: 's1', label: 'Navigation check' }),
      event('response_chunk', { chunk: 'Parent explanation' }),
      event('subagent_progress', progress({ type: 'response_chunk', chunk: 'Child ' })),
      event('subagent_progress', progress({ type: 'response_chunk', chunk: 'finding' })),
    ]);
    assert.deepEqual(rows.map(row => row.kind), ['work', 'assistant']);
    assert.equal(rows[0].progressSummary, 'Child finding');
    assert.equal(rows[0].status, 'running');
    assert.equal(rows[1].text, 'Parent explanation');
    view.appendSubagentProgress(progress({ type: 'subagent_progress', subagentId: 's2', label: 'Gesture specialist', activity: { type: 'response_chunk', chunk: 'Nested finding' } }));
    assert.match(card.querySelector('.h23-chat-work-progress').innerHTML, /Gesture specialist/);
    assert.match(card.querySelector('.h23-chat-work-progress').innerHTML, /Nested finding/);
    assert.equal(parent.dataset.sourceText, 'Parent explanation continues');
  }));

  it('preserves a manually opened thought through streaming updates and completion', () => withFakeDocument(() => {
    const host = new FakeElement('div');
    const view = createTranscript(host, { showThinking: false, renderMarkdown: (text: string) => text });
    const thought = view.appendThinking('Inspecting');
    assert.equal(thought.open, false);
    thought.open = true;
    view.updateThinking('Inspecting the timeline');
    view.collapseThinking();
    assert.equal(thought.open, true);
    assert.equal(thought.querySelector('.h23-chat-thinking-body').dataset.sourceText, 'Inspecting the timeline');
  }));

  it('starts a new parent response segment when an existing specialist finishes', () => withFakeDocument(() => {
    const host = new FakeElement('div');
    const view = createTranscript(host);
    view.appendWorkReceipt({ workId: 's1', label: 'Specialist', status: 'running' });
    view.appendAssistant('Parent before child finished', 't1');
    view.appendWorkReceipt({ workId: 's1', status: 'completed', result: 'Child finding' });
    view.updateAssistant('Parent after child finished', 't1');
    assert.deepEqual(host.querySelectorAll('.assistant').map(element => element.dataset.sourceText),
      ['Parent before child finished', 'Parent after child finished']);
    assert.equal(host.querySelectorAll('.h23-chat-work').length, 1);
  }));

  it('retains expandable child history, exact tool IDs, nested ownership and replay identity', () => withFakeDocument(() => {
    const host = new FakeElement('div');
    const view = createTranscript(host);
    const records: any[] = [{ ...event('subagent_start', { subagentId: 's1', label: 'Researcher', task: 'Check sources' }), seq: 1 }];
    view.appendWorkReceipt({ workId: 's1', turnId: 't1', label: 'Researcher', status: 'running' });
    const send = (activity: any, sequence = records.length + 1) => {
      const progress = { type: 'subagent_progress', subagentId: 's1', label: 'Researcher', task: 'Check sources', activity };
      records.push({ ...event('subagent_progress', progress), seq: sequence });
      view.appendSubagentProgress(progress, { turnId: 't1', sequence });
    };
    send({ type: 'thinking', content: '**Read** both sources' });
    send({ type: 'tool_start', tool: 'read_file', toolCallId: 'a', args: { path: 'alpha.txt' } });
    send({ type: 'tool_start', tool: 'read_file', toolCallId: 'b', args: { path: 'beta.txt' } });
    send({ type: 'tool_result', tool: 'read_file', toolCallId: 'b', result: 'Beta result', success: true });
    const parent = host.children[0];
    parent.querySelector('button')!.click();
    let childHost = parent.querySelector('.h23-chat-child-activity')!;
    assert.deepEqual(childHost.children.map(element => element.className), ['h23-chat-thinking', 'h23-chat-tool', 'h23-chat-tool']);
    childHost.children[0].open = true;
    childHost.children[1].querySelector('button')!.click();
    childHost.children[1].querySelector('.h23-chat-technical')!.open = true;
    send({ type: 'tool_result', tool: 'read_file', toolCallId: 'a', result: 'Alpha result', success: true });
    const calls = childHost.querySelectorAll('.h23-chat-tool');
    assert.deepEqual(calls.map(card => [card.dataset.toolCallId, card.querySelector('.h23-chat-tool-result .h23-chat-machine-body')!.textContent]),
      [['a', 'Alpha result'], ['b', 'Beta result']]);
    assert.equal(childHost.children[0].open, true);
    assert.equal(calls[0].querySelector('button')!.getAttribute('aria-expanded'), 'true');
    assert.equal(calls[0].querySelector('.h23-chat-technical')!.open, true);
    send({ type: 'subagent_start', subagentId: 's2', label: 'Verifier', task: 'Verify one fact' });
    send({ type: 'subagent_progress', subagentId: 's2', label: 'Verifier', activity: { type: 'tool_start', tool: 'read_file', toolCallId: 'a', args: { path: 'child.txt' } } });
    send({ type: 'subagent_progress', subagentId: 's2', label: 'Verifier', activity: { type: 'tool_result', tool: 'read_file', toolCallId: 'a', result: 'Nested result', success: true } });
    const nested = childHost.querySelector('.h23-chat-work')!;
    nested.querySelector('button')!.click();
    assert.equal(nested.querySelector('.h23-chat-tool-result .h23-chat-machine-body')!.textContent, 'Nested result');
    send({ type: 'response_chunk', chunk: 'Child final answer' });
    const last = records.at(-1);
    view.appendSubagentProgress(last.data, { turnId: 't1', sequence: last.seq });
    assert.equal(childHost.children.filter(element => element.classList.contains('assistant')).length, 1);
    assert.equal(childHost.children.at(-1)!.dataset.sourceText, 'Child final answer');
    view.appendWorkReceipt({ workId: 's1', turnId: 't1', status: 'completed', result: 'Child final answer' });
    assert.equal(parent.querySelector('.h23-chat-work-result'), null, 'exact final stream is not duplicated');
    assert.equal(snapshotTranscriptRows(host)[0].result, 'Child final answer', 'export keeps the child result rather than its first nested tool payload');
    records.push({ ...event('subagent_result', { subagentId: 's1', result: 'Child final answer', success: true }), seq: records.length + 1 });
    view.renderHistory(records);
    const restored = host.children[0];
    childHost = restored.querySelector('.h23-chat-child-activity')!;
    assert.equal(restored.dataset.status, 'completed');
    assert.equal(restored.querySelector('button')!.getAttribute('aria-expanded'), 'true');
    assert.equal(childHost.children[0].open, true);
    assert.equal(childHost.children[1].querySelector('.h23-chat-technical')!.open, true);
    assert.equal(childHost.querySelector('.h23-chat-work')!.querySelector('button')!.getAttribute('aria-expanded'), 'true');
    assert.equal(childHost.querySelectorAll('.h23-chat-tool').length, 3);
    // A bounded reread may include the child receipt without its earlier events.
    view.renderHistory([records[0], records.at(-1)]);
    assert.equal(host.children[0].querySelectorAll('.h23-chat-tool').length, 3);
    // A separate Work terminal receipt may beat the final child event in flight.
    send({ type: 'tool_start', tool: 'read_file', toolCallId: 'late', args: { path: 'receipt.txt' } });
    assert.equal(host.children[0].dataset.status, 'completed');
    assert.equal(host.children[0].querySelectorAll('.h23-chat-tool').length, 4);
  }));

  it('replaces retained child deltas with their coalesced history span without duplication', () => withFakeDocument(() => {
    const host = new FakeElement('div');
    const view = createTranscript(host);
    const progress = (chunk: string) => ({ type: 'subagent_progress', subagentId: 'child', label: 'Researcher', activity: { type: 'response_chunk', chunk } });
    view.appendSubagentProgress(progress('A'), { turnId: 't1', sequence: 1 });
    view.appendSubagentProgress(progress('B'), { turnId: 't1', sequence: 2 });
    host.children[0].querySelector('button')!.click();
    view.renderHistory([{ ...event('subagent_progress', progress('AB')), seq: 2, display_start_seq: 1 }]);
    const activity = host.children[0].querySelector('.h23-chat-child-activity')!;
    assert.equal(activity.children.length, 1);
    assert.equal(activity.children[0].dataset.sourceText, 'AB');
    view.appendSubagentProgress(progress('C'), { turnId: 't1', sequence: 3 });
    assert.equal(activity.children[0].dataset.sourceText, 'ABC');
  }));

  it('keeps historical disclosure choices on refresh and tool results on the correct card', () => withFakeDocument(() => {
    const host = new FakeElement('div');
    const view = createTranscript(host, { showThinking: false, renderMarkdown: (text: string) => text });
    const history = [event('thinking', { content: 'Inspecting' }), event('tool_start', { tool: 'read', toolCallId: 'a' })];
    view.renderHistory(history);
    host.children[0].open = true;
    host.children[1].querySelector('button')!.click();
    view.renderHistory(history);
    assert.equal(host.children[0].open, true);
    assert.equal(host.children[1].querySelector('button')!.getAttribute('aria-expanded'), 'true');
    view.appendTool('read', 'beta', 'running', 'b', 't1');
    view.updateTool('read', 'A', true, 'a', 't1');
    view.updateTool('read', 'B', false, 'b', 't1');
    const cards = host.querySelectorAll('.h23-chat-tool');
    assert.equal(cards[0].querySelector('.h23-chat-tool-result .h23-chat-machine-body')!.textContent, 'A');
    assert.equal(cards[1].querySelector('.h23-chat-tool-result .h23-chat-machine-body')!.textContent, 'B');
    assert.equal(cards[1].dataset.status, 'error');
  }));

  it('preserves expanded subagent details and removes Stop when the same work finishes', () => withFakeDocument(() => {
    const host = new FakeElement('div');
    const view = createTranscript(host, { showThinking: false });
    const card = view.appendWorkReceipt({ workId: 's1', label: 'Navigation', task: 'Inspect it', status: 'running', onCancel() {} });
    card.querySelector('button').click();
    view.appendWorkReceipt({ workId: 's1', status: 'completed', result: 'Verified', onCancel: undefined });
    assert.equal(host.children.length, 1);
    assert.equal(card.querySelector('.h23-chat-work-body').hidden, false);
    assert.equal(card.querySelector('.h23-chat-work-status').textContent, 'completed');
    assert.equal(card.querySelectorAll('.h23-chat-work-actions button').length, 0);
    assert.equal(card.querySelector('.h23-chat-machine-body').textContent, 'Verified');
  }));

  it('resumes pending thinking after its persisted cursor without adding another thought', () => withFakeDocument(() => {
    const host = new FakeElement('div');
    const view = createTranscript(host, { showThinking: false });
    const history = [
      { type: 'turn', turn_id: 't1', status: 'pending' },
      { ...event('thinking', { content: 'Inspecting the timeline' }), seq: 8 },
    ];
    view.renderHistory(history);
    host.children[0].open = true;
    const state = view.resumeTurn(history, 't1');
    assert.equal(state.cursor, 8);
    assert.equal(state.currentThinkingSegment, 'Inspecting the timeline');
    view.updateThinking(state.currentThinkingSegment + ' and tools', { turnId: 't1' });
    assert.equal(host.children.length, 1);
    assert.equal(host.children[0].open, true);
    assert.equal(host.children[0].dataset.live, 'true');
    assert.equal(host.children[0].querySelector('.h23-chat-thinking-body').dataset.sourceText, 'Inspecting the timeline and tools');
  }));

  it('hydrates pending assistant text and keeps repeated starts on the same tool card', () => withFakeDocument(() => {
    const host = new FakeElement('div');
    const view = createTranscript(host, { showThinking: false });
    const history = [
      { type: 'turn', turn_id: 't1', status: 'pending' },
      { ...event('thinking', { content: 'Inspecting' }), seq: 1 },
      { ...event('tool_start', { tool: 'read', toolCallId: 'a' }), seq: 2 },
      { ...event('tool_result', { tool: 'read', toolCallId: 'a', result: 'Found it' }), seq: 3 },
      { ...event('response_chunk', { chunk: 'The file ' }), seq: 5 },
    ];
    view.renderHistory(history);
    const state = view.resumeTurn(history, 't1');
    assert.equal(state.cursor, 5);
    assert.equal(state.currentResponse, 'The file ');
    view.updateAssistant(state.currentResponse + 'is ready.', 't1');
    assert.equal(host.querySelectorAll('.assistant').length, 1);
    view.appendTool('read', null, 'running', 'a', 't1');
    view.updateTool('read', 'Found it', true, 'a', 't1');
    assert.equal(host.querySelectorAll('.h23-chat-tool').length, 1);
    assert.equal(host.querySelector('.h23-chat-tool').dataset.status, 'complete');
  }));

  it('retains response segments when bounded history no longer includes the pending envelope', () => {
    const history = [
      { ...event('response_chunk', { chunk: 'Earlier explanation.' }), seq: 203 },
      { ...event('tool_start', { tool: 'read', toolCallId: 'a' }), seq: 204 },
      { ...event('tool_result', { tool: 'read', toolCallId: 'a', result: 'Found it' }), seq: 205 },
      { ...event('thinking', { content: 'Current thought' }), seq: 207 },
    ];
    assert.deepEqual(projectHistoryToRows(history).map(row => row.kind), ['assistant', 'tool', 'thinking']);
    const state = turnContinuation(history, 't1');
    assert.equal(state.cursor, 207);
    assert.equal(state.currentThinkingSegment, 'Current thought');
    assert.equal(state.currentResponse, '');
  });

  it('keeps thought segments on either side of a subagent completion when resuming', () => withFakeDocument(() => {
    const host = new FakeElement('div');
    const view = createTranscript(host);
    const history = [
      { type: 'turn', turn_id: 't1', status: 'pending' },
      { ...event('subagent_start', { subagentId: 's1', label: 'Check' }), seq: 0 },
      { ...event('thinking', { content: 'Before result' }), seq: 1 },
      { ...event('subagent_result', { subagentId: 's1', result: 'Verified', success: true }), seq: 2 },
      { ...event('thinking', { content: 'After result' }), seq: 3 },
    ];
    view.renderHistory(history);
    const state = view.resumeTurn(history, 't1');
    view.updateThinking(state.currentThinkingSegment + ' continues', { turnId: 't1' });
    assert.deepEqual(host.querySelectorAll('.h23-chat-thinking-body').map(body => body.dataset.sourceText), ['Before result', 'After result continues']);
  }));

  it('keeps response segments on either side of a subagent completion when resuming', () => withFakeDocument(() => {
    const host = new FakeElement('div');
    const view = createTranscript(host);
    const history = [
      { type: 'turn', turn_id: 't1', status: 'pending' },
      { ...event('subagent_start', { subagentId: 's1', label: 'Check' }), seq: 0 },
      { ...event('response_chunk', { chunk: 'Before result' }), seq: 1 },
      { ...event('subagent_result', { subagentId: 's1', result: 'Verified', success: true }), seq: 2 },
      { ...event('response_chunk', { chunk: 'After result' }), seq: 3 },
    ];
    view.renderHistory(history);
    const state = view.resumeTurn(history, 't1');
    view.updateAssistant(state.currentResponse + ' continues', 't1');
    assert.deepEqual(host.querySelectorAll('.h23-chat-msg-text').map(body => body.innerHTML), ['<p>Before result</p>', '<p>After result continues</p>']);
  }));

  it('keeps live disclosure choices when history replaces the streamed transcript', () => withFakeDocument(() => {
    const host = new FakeElement('div');
    const view = createTranscript(host, { showThinking: false });
    const thought = view.appendThinking('Inspecting', { turnId: 't1' });
    thought.open = true;
    const tool = view.appendTool('read', null, 'running', 'a', 't1');
    tool.querySelector('button').click();
    tool.querySelector('.h23-chat-technical').open = true;
    const work = view.appendWorkReceipt({ workId: 's1', turnId: 't1', label: 'Check', status: 'running' });
    work.querySelector('button').click();
    view.renderHistory([
      event('thinking', { content: 'Inspecting' }),
      event('tool_start', { tool: 'read', toolCallId: 'a' }),
      event('subagent_start', { subagentId: 's1', label: 'Check' }),
    ]);
    assert.equal(host.children[0].open, true);
    assert.equal(host.children[1].querySelector('button').getAttribute('aria-expanded'), 'true');
    assert.equal(host.children[1].querySelector('.h23-chat-technical').open, true);
    assert.equal(host.children[2].querySelector('button').getAttribute('aria-expanded'), 'true');
  }));

  it('keeps exact work output visible after receipt loading and late active snapshots', () => withFakeDocument(() => {
    const host = new FakeElement('div');
    const view = createTranscript(host);
    const work = { workId: 's1', status: 'completed', terminalResult: { resultText: 'Navigation is verified.' } };
    const card = view.appendWorkReceipt({ ...work, result: work.terminalResult.resultText });
    card.querySelector('button').click();
    card.querySelector('.h23-chat-technical').open = true;
    view.appendWorkReceipt({ ...work, ...workReceiptPresentation(work, { messages: [{ role: 'assistant', content: 'Diagnostic history' }] }) });
    assert.match(card.querySelector('.h23-chat-work-result').innerHTML, /Navigation is verified/);
    assert.equal(card.querySelector('.h23-chat-technical').open, true);
    view.appendWorkReceipt({ workId: 's1', status: 'running', updatedAt: '2026-09-13T12:00:00Z' });
    assert.equal(card.dataset.status, 'completed');
    view.appendWorkReceipt({ workId: 's1', status: 'completed', ...workReceiptPresentation({}, { messages: [] }) });
    assert.match(card.querySelector('.h23-chat-work-result').innerHTML, /Navigation is verified/);
  }));

  it('places historical work with its originating turn without splitting the live answer', () => withFakeDocument(() => {
    const host = new FakeElement('div');
    const view = createTranscript(host);
    view.appendAssistant('Older answer', 'old');
    view.appendUser('Next request');
    view.appendAssistant('Current ', 'now');
    view.appendWorkReceipt({ workId: 's1', turnId: 'old', status: 'completed', preserveStream: true });
    view.updateAssistant('Current answer', 'now');
    assert.deepEqual(host.children.map(child => child.dataset.turnId || 'user'), ['old', 'old', 'user', 'now']);
    assert.equal(host.querySelectorAll('.assistant').length, 2);
  }));

  it('preserves the assistant body, Copy control and exported answer after canonical reconciliation', () => withFakeDocument(() => {
    const host = new FakeElement('div');
    const view = createTranscript(host);
    const card = view.appendAssistant('Partial', 't1');
    const body = card.querySelector('.h23-chat-msg-text');
    const copy = card.querySelector('.h23-chat-copy-btn');
    const copied: string[] = [];
    const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (text: string) => { copied.push(text); } } } });
    try {
      reconcileCanonicalAssistantElements(host.children, 't1', 'Full **answer**', (text: string) => text);
      assert.equal(card.querySelector('.h23-chat-msg-text'), body);
      assert.equal(card.querySelector('.h23-chat-copy-btn'), copy);
      assert.equal(snapshotTranscriptRows(host)[0].text, 'Full **answer**');
      copy.click();
      assert.deepEqual(copied, ['Full **answer**']);
    } finally {
      if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
      else delete (globalThis as any).navigator;
    }
  }));
});

describe('human activity presentation', () => {
  it('keeps protocol-only reasoning markers out of thought text without losing real whitespace', () => {
    const rows = projectHistoryToRows([
      { kind: 'thinking', data: { content: '**Checking support**' } },
      { kind: 'thinking', data: { content: '', sourceEventType: 'response.reasoning_summary_text.done' } },
      { kind: 'thinking', data: { content: '', sourceEventType: 'response.output_item.done' } },
      { kind: 'thinking', data: { content: ' ' } },
      { kind: 'thinking', data: { content: 'Available.' } },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, '**Checking support** Available.');
    assert.equal(activityStatusLabel('provider_active'), null);
    assert.equal(activityStatusLabel('awaiting_model'), null);
    assert.equal(activityStatusLabel('operator_steer'), 'Direction updated');
  });

  it('uses tool names and structured result summaries as human text', () => {
    assert.equal(toolLabel('channel_manage', { operation: 'list' }), 'List channels');
    assert.equal(readableToolResult({ channels: [{ id: 'a' }, { id: 'b' }] }), '2 channels returned.');
    assert.equal(readableToolResult('{"summary":"Channel updated","secretTechnicalId":"internal"}'), 'Channel updated');
    assert.equal(readableToolResult({ error: { message: 'Channel unavailable' } }), 'Channel unavailable');
  });

  it('gives failure evidence priority and distinguishes finished from confirmed success', () => withFakeDocument(() => {
    const host = new FakeElement('div');
    const view = createTranscript(host);
    const cases = [
      { result: '{"ok":false,"error":"Channel unavailable"}', success: true, status: 'error', label: 'Failed' },
      { result: { data: { output: { success: false } } }, success: true, status: 'error', label: 'Failed' },
      { result: 'Result received', success: undefined, status: 'finished', label: 'Finished' },
      { result: '{"ok":true}', success: undefined, status: 'complete', label: 'Complete' },
    ];
    cases.forEach(({ result, success, status, label }, index) => {
      const id = `call-${index}`;
      assert.equal(toolOutcome(result, success), status);
      view.appendTool('channel_manage', { operation: 'list' }, 'running', id, 't1');
      view.updateTool('channel_manage', result, success, id, 't1');
      const card = host.querySelectorAll('.h23-chat-tool')[index];
      assert.equal(card.dataset.status, status);
      assert.equal(card.querySelector('.h23-chat-tool-status').textContent, label);
      const rows = projectHistoryToRows([{ type: 'event', turn_id: 't1', kind: 'tool_result',
        data: { tool: 'channel_manage', toolCallId: id, result, success } }]);
      assert.equal(rows[0].status, status);
      const child = subagentProgressRow({ subagentId: 'child', activity: { type: 'tool_result', tool: 'channel_manage', result, success } });
      assert.match(child.progressSummary, new RegExp(`· ${label}`));
    });
  }));

  it('renders thinking Markdown and keeps full tool JSON behind a second disclosure', () => withFakeDocument(() => {
    const host = new FakeElement('div');
    const view = createTranscript(host, { showThinking: false });
    const thought = view.appendThinking('**Checking support**');
    assert.match(thought.querySelector('.h23-chat-thinking-body').innerHTML, /<strong>Checking support<\/strong>/);
    view.appendTool('channel_manage', { action: 'list' }, 'running', 'c1');
    view.updateTool('channel_manage', { channels: [{ id: 'private-id' }] }, true, 'c1');
    const card = host.querySelector('.h23-chat-tool')!;
    assert.match(card.querySelector('.h23-chat-tool-summary')!.innerHTML, /1 channel returned/);
    assert.equal(card.querySelector('.h23-chat-technical')!.open, false);
    assert.match(card.querySelector('.h23-chat-tool-result .h23-chat-machine-body')!.textContent, /private-id/);
  }));
});
