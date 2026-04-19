import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — vanilla JS module, no .d.ts
import { createChatState } from '../../engine/src/dashboard/home23-chat-state.mjs';

describe('ChatState', () => {
  it('starts with an empty snapshot', () => {
    const state = createChatState();
    const snap = state.get();
    assert.equal(snap.agent, null);
    assert.equal(snap.conversationId, null);
    assert.deepEqual(snap.messages, []);
    assert.deepEqual(snap.conversations, []);
    assert.equal(snap.input, '');
    assert.equal(snap.streaming, false);
    assert.equal(snap.activeTurnId, null);
  });

  it('set() merges and fires "change" listeners', () => {
    const state = createChatState();
    let calls = 0;
    let lastSnap: any = null;
    state.on('change', (snap: any) => { calls++; lastSnap = snap; });
    state.set({ conversationId: 'abc', input: 'hi' });
    assert.equal(calls, 1);
    assert.equal(lastSnap.conversationId, 'abc');
    assert.equal(lastSnap.input, 'hi');
    assert.equal(state.get().conversationId, 'abc');
  });

  it('fires topic-specific events for conversation / agent / turn changes', () => {
    const state = createChatState();
    const events: string[] = [];
    state.on('conversation:switch', () => events.push('conv'));
    state.on('agent:switch', () => events.push('agent'));
    state.on('turn:start', () => events.push('start'));
    state.on('turn:end', () => events.push('end'));

    state.set({ conversationId: 'c1' });
    state.set({ agent: { name: 'jerry' } });
    state.set({ streaming: true, activeTurnId: 't1' });
    state.set({ streaming: false, activeTurnId: null });

    assert.deepEqual(events, ['conv', 'agent', 'start', 'end']);
  });

  it('appendMessage() pushes and emits change', () => {
    const state = createChatState();
    let snap: any = null;
    state.on('change', (s: any) => { snap = s; });
    state.appendMessage({ role: 'user', content: 'hi' });
    assert.equal(snap.messages.length, 1);
    assert.equal(snap.messages[0].content, 'hi');
  });

  it('off() removes listeners', () => {
    const state = createChatState();
    let calls = 0;
    const cb = () => { calls++; };
    state.on('change', cb);
    state.set({ input: 'a' });
    state.off('change', cb);
    state.set({ input: 'b' });
    assert.equal(calls, 1);
  });

  it('get() returns a fresh snapshot each call (no shared mutation)', () => {
    const state = createChatState();
    state.set({ conversations: [{ id: 'x', preview: 'x' }] });
    const snap1 = state.get();
    snap1.conversations.push({ id: 'y', preview: 'y' });
    const snap2 = state.get();
    assert.equal(snap2.conversations.length, 1);
  });
});
