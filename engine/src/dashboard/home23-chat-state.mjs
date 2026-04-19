/**
 * ChatState — central source of truth for the dashboard chat UI.
 *
 * Replaces the scatter of global `let chatConversationId` / `let chatStreaming`
 * / etc. in home23-chat.js. All three modes (tile, overlay, standalone within
 * this page) read and write through this singleton.
 *
 * Emits both a generic 'change' event and topic events ('conversation:switch',
 * 'agent:switch', 'turn:start', 'turn:end') so views can subscribe to just
 * the slices they care about.
 */

function defaultState() {
  return {
    agent: null,             // { name, displayName, bridgePort, ... }
    model: null,
    provider: null,
    conversationId: null,    // clean chatId (no namespace prefix)
    conversations: [],       // [{ id, preview, source, messageCount, ... }]
    messages: [],            // [{ role, content, ... }]
    input: '',
    streaming: false,
    activeTurnId: null,
    activeCursor: -1,
    turnCtx: null,           // { responseEl, currentResponse, thinkingEl, currentThinking }
  };
}

export function createChatState() {
  let state = defaultState();
  const listeners = new Map();   // event -> Set<cb>

  function emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const cb of Array.from(set)) {
      try { cb(payload); } catch (err) { console.warn('[chatState]', event, 'listener threw:', err); }
    }
  }

  function get() {
    return {
      ...state,
      conversations: state.conversations.slice(),
      messages: state.messages.slice(),
    };
  }

  function set(patch) {
    const prev = state;
    state = { ...state, ...patch };

    const snap = get();

    if ('conversationId' in patch && patch.conversationId !== prev.conversationId) {
      emit('conversation:switch', snap);
    }
    if ('agent' in patch && patch.agent !== prev.agent) {
      emit('agent:switch', snap);
    }
    if ('streaming' in patch && patch.streaming !== prev.streaming) {
      emit(patch.streaming ? 'turn:start' : 'turn:end', snap);
    }
    emit('change', snap);
  }

  function appendMessage(msg) {
    state = { ...state, messages: [...state.messages, msg] };
    const snap = get();
    emit('message:append', msg);
    emit('change', snap);
  }

  function on(event, cb) {
    let set = listeners.get(event);
    if (!set) { set = new Set(); listeners.set(event, set); }
    set.add(cb);
    return () => off(event, cb);
  }

  function off(event, cb) {
    const set = listeners.get(event);
    if (set) set.delete(cb);
  }

  function reset() {
    state = defaultState();
    emit('change', get());
  }

  return { get, set, appendMessage, on, off, reset };
}

// Singleton for the dashboard — tests use createChatState() directly.
export const chatState = createChatState();
