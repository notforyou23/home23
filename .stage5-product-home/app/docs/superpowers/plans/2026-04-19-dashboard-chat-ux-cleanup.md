# Dashboard Chat UX Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify dashboard chat state across tile/overlay/standalone modes, trim visible controls into a shared `⋯` menu, and apply responsive sizing rules — keeping all three modes but making them share one conversation cleanly.

**Architecture:** Central `ChatState` module as source of truth for conversation + streaming state. A single message-list + input DOM subtree moves between tile and overlay via `appendChild` (not innerHTML copy) so mid-stream transitions survive. Visible controls trimmed per view; overflow goes into a consistent click-to-open `⋯` menu. Sizing rules extracted to a dedicated `home23-chat.css` file and applied via responsive breakpoints. Overlay uses native `<dialog>`.

**Tech Stack:** Vanilla JS (no framework), CSS, Node built-in test runner via tsx for `ChatState` unit tests. No new runtime deps.

**Reference spec:** `docs/superpowers/specs/2026-04-19-dashboard-chat-ux-cleanup-design.md`

---

## File Structure

**Frontend — new:**
- `engine/src/dashboard/home23-chat-state.js` — central state store with event emitter API
- `engine/src/dashboard/home23-chat.css` — all responsive styles (extracted from inline `<style>` currently injected by `home23-chat.js`)
- `tests/dashboard/chat-state.test.ts` — unit tests for ChatState

**Frontend — modified:**
- `engine/src/dashboard/home23-chat.js` — refactored to read/write through ChatState; globals eliminated; DOM-move on expand/collapse; `⋯` menu component
- `engine/src/dashboard/home23-dashboard.html` — tile markup trimmed, overlay becomes `<dialog>` element
- `engine/src/dashboard/home23-chat.html` — standalone page sidebar becomes persistent, content max-width applied
- `engine/src/dashboard/home23-dashboard.css` — minor, if any tile styles referenced there today

**Manual verification** is the primary test for DOM/CSS tasks (existing codebase has no frontend test harness). `ChatState` is unit-testable and gets real tests.

---

## Task 1: Create ChatState module with unit tests

**Files:**
- Create: `engine/src/dashboard/home23-chat-state.js`
- Create: `tests/dashboard/chat-state.test.ts`
- Modify: `package.json` (add test file to `test` script)

- [ ] **Step 1: Write the failing test**

Create `tests/dashboard/chat-state.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — vanilla JS module, no .d.ts
import { createChatState } from '../../engine/src/dashboard/home23-chat-state.js';

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
    // subsequent get() reflects the merged state
    assert.equal(state.get().conversationId, 'abc');
  });

  it('fires topic-specific events for conversation switch + agent switch + streaming start/stop', () => {
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
```

- [ ] **Step 2: Add test file to npm test script**

Edit `package.json`, the `test` script. Append `tests/dashboard/chat-state.test.ts` to the existing explicit list:

```json
"test": "node --import tsx --test --test-concurrency=1 tests/agent/brain-route-resolver.test.ts tests/agent/tools/brain.test.ts tests/agent/tools/research.test.ts tests/dashboard/chat-state.test.ts",
```

- [ ] **Step 3: Run tests to confirm they fail**

```bash
cd /Users/jtr/_JTR23_/release/home23 && npm test 2>&1 | tail -15
```

Expected: FAIL with `Cannot find module '.../home23-chat-state.js'`.

- [ ] **Step 4: Create the ChatState module**

Create `engine/src/dashboard/home23-chat-state.js`:

```js
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
    // Shallow clone + re-wrap arrays so consumers can't mutate internal state.
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

    // Topic events first (more specific), then general 'change'.
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
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /Users/jtr/_JTR23_/release/home23 && npm test 2>&1 | tail -25
```

Expected: all 6 ChatState tests pass plus all existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add engine/src/dashboard/home23-chat-state.js tests/dashboard/chat-state.test.ts package.json
git commit -m "$(cat <<'EOF'
feat(dashboard): add ChatState module — single source of truth for chat UI

New home23-chat-state.js exports a ChatState object with get/set/event
API. Replaces the scatter of global \`let\` vars in home23-chat.js in
the next task. Unit tests cover snapshot isolation, merge-set semantics,
topic events (conversation:switch, agent:switch, turn:start/end), and
listener off().

No wiring yet — this task only adds the module and its tests. Migration
of home23-chat.js to use it comes next.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Migrate home23-chat.js to use ChatState

**Files:**
- Modify: `engine/src/dashboard/home23-chat.js` (major refactor)

**Context:** The file is 908 lines today with global `let` variables for every piece of conversation state. Replace every read/write with `chatState.get().X` / `chatState.set({ X })`. Visible behavior unchanged.

- [ ] **Step 1: Import chatState at the top of the file**

Edit `engine/src/dashboard/home23-chat.js`, at the very top, below the opening comment block:

```js
import { chatState } from './home23-chat-state.js';
```

Then find the HTML file that loads this JS (`engine/src/dashboard/home23-dashboard.html` around line 409+, and `engine/src/dashboard/home23-chat.html`) — ensure the `<script>` tag has `type="module"`. If not, add it:

```bash
cd /Users/jtr/_JTR23_/release/home23 && grep -n 'home23-chat.js' engine/src/dashboard/home23-dashboard.html engine/src/dashboard/home23-chat.html
```

For each matching line, verify `type="module"` is present. If missing, edit the HTML to add it.

- [ ] **Step 2: Remove the global `let` declarations**

In `engine/src/dashboard/home23-chat.js` at the top (around lines 10-25), delete these lines:

```js
let chatAgent = null;
let chatAgents = [];
let chatModels = {};
let chatModel = null;
let chatStreaming = false;
let activeTurnId = null;
let activeChatId = null;
let activeCursor = -1;
let activeEventSource = null;
let currentTurnCtx = null;
let chatConversationId = null;
let chatConversations = [];
let chatPersistTimer = null;
let chatPersistenceBound = false;
let chatCurrentAgentName = null;
```

Keep `activeEventSource` and `chatPersistTimer` as module-local since they're transient handles, not conversation state:

```js
// Transient handles — not conversation state, don't live in ChatState.
let activeEventSource = null;
let chatPersistTimer = null;
let chatPersistenceBound = false;

// Legacy adapter: most of the file still reads these names. Map to chatState.
// Migrated incrementally; every assignment route through chatState.set().
function _s() { return chatState.get(); }
```

- [ ] **Step 3: Migrate reads — replace bare variable references with `_s().X`**

In `engine/src/dashboard/home23-chat.js`, do these find/replace operations:

| Old read | New read |
|---|---|
| `chatAgent` (bare) | `_s().agent` |
| `chatAgents` | `_s().conversations` is WRONG; `chatAgents` is the list of agents → store in state or keep as module-local? See note. |
| `chatModel` | `_s().model` |
| `chatStreaming` | `_s().streaming` |
| `activeTurnId` | `_s().activeTurnId` |
| `activeChatId` | `_s().activeTurnId` is WRONG; `activeChatId` was a stream-local shadow of conversationId — use `_s().conversationId` |
| `activeCursor` | `_s().activeCursor` |
| `currentTurnCtx` | `_s().turnCtx` |
| `chatConversationId` | `_s().conversationId` |
| `chatConversations` | `_s().conversations` |

**Note on `chatAgents` / `chatModels` / `chatCurrentAgentName`**: these are registry/catalog data loaded once at init, not per-conversation state. Keep them as module-local `let` vars — they don't need event subscription. Only the *selected* agent belongs in ChatState.

Do this with grep-verify per variable:

```bash
cd /Users/jtr/_JTR23_/release/home23 && grep -n "\\bchatConversationId\\b" engine/src/dashboard/home23-chat.js
```

For each hit, read the context and decide: is it a read (replace with `_s().conversationId`) or a write (see next step).

- [ ] **Step 4: Migrate writes — replace assignments with `chatState.set()`**

Every `chatConversationId = X` becomes `chatState.set({ conversationId: X })`. Same for the other migrated vars.

Example pattern inside `newConversation()`:

```js
// Before
chatConversationId = `dashboard-${chatAgent?.agentName || 'agent'}-${Date.now()}`;

// After
chatState.set({ conversationId: `dashboard-${_s().agent?.agentName || 'agent'}-${Date.now()}` });
```

Inside `sendMessage()` where streaming starts:

```js
// Before
chatStreaming = true;
currentTurnCtx = { containerId, responseEl: null, currentResponse: '', thinkingEl: null, currentThinking: '' };
activeChatId = chatConversationId;
activeCursor = -1;

// After
chatState.set({
  streaming: true,
  turnCtx: { containerId, responseEl: null, currentResponse: '', thinkingEl: null, currentThinking: '' },
  activeCursor: -1,
});
```

Inside the turn's end handler:

```js
// Before
chatStreaming = false;
activeTurnId = null;
currentTurnCtx = null;

// After
chatState.set({ streaming: false, activeTurnId: null, turnCtx: null });
```

- [ ] **Step 5: Update `restoreChatState()` and `saveChatState()` to read/write through ChatState**

`restoreChatState()` previously sets `chatConversationId = saved.conversationId`. Change to:

```js
chatState.set({ conversationId: saved.conversationId || `dashboard-${agentName}-${Date.now()}` });
```

`saveChatState()` (around line ~760) reads `chatConversationId`. Change to `_s().conversationId`.

- [ ] **Step 6: Verify TypeScript / JS still parses**

```bash
cd /Users/jtr/_JTR23_/release/home23 && node -e "import('./engine/src/dashboard/home23-chat.js').catch(e => { console.error(e.message); process.exit(1); })"
```

Expected: may error on imports that only work in browser (e.g., `document`, `window`) — that's fine. We only care about syntax. If it hits a SyntaxError, fix it; if it hits a ReferenceError for `document` etc., that's expected.

- [ ] **Step 7: Run tests to verify nothing broke**

```bash
cd /Users/jtr/_JTR23_/release/home23 && npm test 2>&1 | tail -10
```

Expected: all tests still pass.

- [ ] **Step 8: Manual browser smoke**

Restart the dashboard so the new JS loads:

```bash
pm2 restart home23-jerry-dash
```

Open `http://<host>:5002/home23` in a browser. In the Chat tile:
1. Send a message → response streams in → verify
2. Click expand → overlay opens with the same conversation
3. Click close → back to tile, same state
4. Switch agent via selector → conversation list updates
5. Click a historical conversation → loads correctly
6. Refresh the page → chat restores from localStorage

All must work exactly as before. If any regression, fix before committing.

- [ ] **Step 9: Commit**

```bash
git add engine/src/dashboard/home23-chat.js engine/src/dashboard/home23-dashboard.html engine/src/dashboard/home23-chat.html
git commit -m "$(cat <<'EOF'
refactor(dashboard): migrate home23-chat.js to use ChatState

Replaces the scatter of global \`let\` vars (chatConversationId,
chatStreaming, activeTurnId, currentTurnCtx, chatConversations, etc.)
with reads/writes through chatState. Registry data (chatAgents,
chatModels, chatCurrentAgentName) stays module-local — not per-
conversation state.

No visible behavior change. Prereq for the DOM-move transition in the
next task: with state flowing through one store, views can subscribe to
changes rather than polling globals.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Unify message-list + input DOM, move on expand/collapse

**Files:**
- Modify: `engine/src/dashboard/home23-dashboard.html`
- Modify: `engine/src/dashboard/home23-chat.js`

**Context:** Today there are two sets: `#chat-messages` + `#chat-input` + `#chat-send-btn` in the tile, and `#chat-overlay-body` + `#chat-overlay-input` + `#chat-overlay-send-btn` in the overlay. We collapse to ONE set that physically moves between the containers via `appendChild`.

- [ ] **Step 1: Refactor the dashboard HTML — single shared message/input nodes**

Edit `engine/src/dashboard/home23-dashboard.html`. Find the chat tile markup (grep for `chat-messages` tile area) and the overlay (line 409+).

Replace the separate `#chat-messages` / `#chat-overlay-body` and separate inputs with named slots:

Tile becomes:

```html
<div class="h23-chat-tile" id="chat-tile">
  <div class="h23-chat-tile-header">
    <!-- agent picker + expand + ⋯ menu go here in Task 4 -->
  </div>
  <div class="h23-chat-slot" id="chat-slot-tile" data-slot="tile">
    <!-- Shared message-list + input DOM lives here when tile is active -->
  </div>
</div>
```

Overlay becomes a `<dialog>` element:

```html
<dialog class="h23-chat-overlay" id="chat-overlay">
  <div class="h23-chat-overlay-header">
    <!-- agent name + controls go here in Task 5 -->
  </div>
  <div class="h23-chat-slot" id="chat-slot-overlay" data-slot="overlay">
    <!-- Shared message-list + input DOM moves here when overlay is open -->
  </div>
</dialog>
```

Create a **shared detached template** that gets inserted into whichever slot is active:

```html
<template id="chat-shared-template">
  <div class="h23-chat-shared" id="chat-shared">
    <div class="h23-chat-messages" id="chat-messages"></div>
    <div class="h23-chat-input-area" id="chat-input-area">
      <textarea class="h23-chat-input" id="chat-input" placeholder="Message your agent..." rows="1"></textarea>
      <button class="h23-chat-send-btn" id="chat-send-btn">&#9654;</button>
    </div>
  </div>
</template>
```

- [ ] **Step 2: On chat init, clone the template into the tile slot**

In `engine/src/dashboard/home23-chat.js` `initChat()`, near the start:

```js
function mountSharedChatNodes() {
  const existing = document.getElementById('chat-shared');
  if (existing) return existing;  // already mounted (e.g., HMR, re-init)
  const tpl = document.getElementById('chat-shared-template');
  const tileSlot = document.getElementById('chat-slot-tile');
  if (!tpl || !tileSlot) return null;
  const node = tpl.content.firstElementChild.cloneNode(true);
  tileSlot.appendChild(node);
  return node;
}
```

Call `mountSharedChatNodes()` at the start of `initChat()`.

- [ ] **Step 3: Rewrite `openOverlay()` and `closeOverlay()` to move DOM**

Replace the existing `openOverlay()` / `closeOverlay()`:

```js
function openOverlay() {
  const shared = document.getElementById('chat-shared');
  const overlaySlot = document.getElementById('chat-slot-overlay');
  const overlay = document.getElementById('chat-overlay');
  if (!shared || !overlaySlot || !overlay) return;

  // Move the shared DOM into the overlay slot — appendChild relocates
  // the same node, preserving all event bindings and streaming state.
  overlaySlot.appendChild(shared);

  // Native <dialog> — open modal. Gives us free Esc + backdrop + focus trap.
  if (typeof overlay.showModal === 'function') overlay.showModal();
  else overlay.classList.add('open');

  document.getElementById('chat-input')?.focus();
  scrollToBottom();
}

function closeOverlay() {
  const overlay = document.getElementById('chat-overlay');
  const shared = document.getElementById('chat-shared');
  const tileSlot = document.getElementById('chat-slot-tile');
  if (!overlay || !shared || !tileSlot) return;

  if (typeof overlay.close === 'function') overlay.close();
  else overlay.classList.remove('open');

  // Move shared DOM back to the tile slot.
  tileSlot.appendChild(shared);

  scrollToBottom();
}
```

- [ ] **Step 4: Remove the duplicate overlay-specific element IDs from the code**

Grep for every reference to `chat-overlay-body`, `chat-overlay-input`, `chat-overlay-send-btn` in `home23-chat.js`:

```bash
cd /Users/jtr/_JTR23_/release/home23 && grep -n "chat-overlay-body\|chat-overlay-input\|chat-overlay-send-btn" engine/src/dashboard/home23-chat.js
```

For each match, change the reference to use the unified id (`chat-messages`, `chat-input`, `chat-send-btn`). The `source === 'overlay'` branches that pick between two sets of IDs collapse to a single path.

Also update the `<dialog>`-aware backdrop close: native `<dialog>` emits a `close` event when Esc is pressed or when the user clicks a `formmethod="dialog"` button. For click-on-backdrop-to-close, add:

```js
document.getElementById('chat-overlay')?.addEventListener('click', (e) => {
  if (e.target.id === 'chat-overlay') closeOverlay();  // backdrop click
});
```

- [ ] **Step 5: Browser smoke — streaming survives expand**

```bash
pm2 restart home23-jerry-dash
```

In the browser:
1. In the tile, send a message that will produce a long response (e.g., "list 20 interesting things")
2. **While the response is still streaming in**, click the expand button
3. The overlay opens, and the streaming response **continues rendering into the same message bubble** — no flash, no lost text, no duplicate bubble
4. Close the overlay mid-stream (Esc or backdrop click) → streaming continues into the tile, still same bubble
5. Complete flow works to end of turn

If streaming doesn't continue seamlessly, the DOM move isn't complete — check that every element referenced by the response handler is the shared one (not a stale overlay-specific id).

- [ ] **Step 6: Commit**

```bash
git add engine/src/dashboard/home23-dashboard.html engine/src/dashboard/home23-chat.js
git commit -m "$(cat <<'EOF'
refactor(dashboard): unified chat DOM — one message-list/input, moves on expand

Replaces the split tile (#chat-messages + #chat-input) / overlay
(#chat-overlay-body + #chat-overlay-input) DOMs with a single shared
subtree that physically relocates between tile and overlay slots via
appendChild. Preserves all event bindings + mid-turn streaming state
across expand/collapse — no more innerHTML copy breakage.

Overlay is now a native <dialog> element for free Esc/backdrop/focus-
trap handling. Backdrop click still closes via event handler.

Fixes pain point A (state/message sync between modes) directly.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Trim tile controls + add `⋯` menu component

**Files:**
- Modify: `engine/src/dashboard/home23-dashboard.html`
- Modify: `engine/src/dashboard/home23-chat.js`

**Context:** Tile today has: agent select, model select, new conversation button, conversation-list toggle, expand button, standalone button, send button. We reduce the *visible* controls to agent picker + expand button + `⋯` menu + single send/stop button. Everything else lives inside the `⋯` menu.

- [ ] **Step 1: Add tile header HTML**

In `engine/src/dashboard/home23-dashboard.html`, replace the tile header (inside `#chat-tile` above the shared slot) with:

```html
<div class="h23-chat-tile-header">
  <button class="h23-chat-agent-pill" id="chat-agent-pill" title="Switch agent">
    <span class="h23-chat-agent-avatar" id="chat-agent-avatar">●</span>
    <span class="h23-chat-agent-name" id="chat-agent-name">…</span>
  </button>
  <div class="h23-chat-tile-actions">
    <button class="h23-chat-icon-btn" id="chat-expand-btn" title="Expand">&#8599;</button>
    <button class="h23-chat-icon-btn" id="chat-more-btn" title="More" aria-haspopup="menu" aria-expanded="false">&#8230;</button>
  </div>
</div>

<!-- Menu popover — shared between tile and overlay; rendered at body level -->
<div class="h23-chat-menu" id="chat-more-menu" role="menu" hidden>
  <button class="h23-chat-menu-item" data-action="new-conversation" role="menuitem">New conversation</button>
  <button class="h23-chat-menu-item" data-action="toggle-conversations" role="menuitem">Show conversations</button>
  <button class="h23-chat-menu-item" data-action="change-model" role="menuitem">Change model</button>
  <button class="h23-chat-menu-item" data-action="open-standalone" role="menuitem">Open in new tab</button>
</div>

<div class="h23-chat-conv-popover" id="chat-conv-popover" hidden>
  <!-- Conversation list renders here when invoked from ⋯ → "Show conversations" -->
</div>
```

Remove the old tile buttons that moved into the menu: old `#chat-standalone-btn`, old conversation-toggle if in the tile, old model/agent `<select>` elements.

- [ ] **Step 2: Wire the `⋯` menu in JS**

In `engine/src/dashboard/home23-chat.js`, add after `initChat()`:

```js
function setupMoreMenu() {
  const btn = document.getElementById('chat-more-btn');
  const menu = document.getElementById('chat-more-menu');
  if (!btn || !menu) return;

  function openMenu() {
    const rect = btn.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.right = `${window.innerWidth - rect.right}px`;
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  }
  function closeMenu() {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden ? openMenu() : closeMenu();
  });

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-action]');
    if (!item) return;
    const action = item.dataset.action;
    closeMenu();
    handleMenuAction(action);
  });

  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) closeMenu();
  });
}

function handleMenuAction(action) {
  if (action === 'new-conversation') {
    newConversation();
  } else if (action === 'toggle-conversations') {
    toggleConversationList();
  } else if (action === 'change-model') {
    showModelPicker();
  } else if (action === 'open-standalone') {
    openStandalone();
  }
}

function openStandalone() {
  const agent = chatState.get().agent;
  const url = `/home23/chat${agent?.name ? `?agent=${encodeURIComponent(agent.name)}` : ''}`;
  window.open(url, '_blank', 'noopener');
}

function showModelPicker() {
  // For v1, defer to a simple prompt() or trigger a lightweight popover.
  // Implementation: reuse the existing model-select dropdown, now hidden
  // from the tile header, by toggling a popover that mounts a temporary
  // <select> populated from chatModels.
  const snap = chatState.get();
  const provider = snap.agent?.provider;
  const models = (chatModels?.[provider] || []).map(m => typeof m === 'string' ? m : m.id);
  if (models.length === 0) { alert('No models available for this provider.'); return; }
  const current = snap.model;
  const picked = prompt(`Pick a model (current: ${current}):\n\n${models.join('\n')}`);
  if (picked && models.includes(picked)) {
    chatState.set({ model: picked });
    // Existing model-swap endpoint + persistence logic stays — ChatState emits 'change'.
  }
}
```

Call `setupMoreMenu()` from `initChat()` after `mountSharedChatNodes()`.

- [ ] **Step 3: Wire the agent pill**

```js
function setupAgentPill() {
  const pill = document.getElementById('chat-agent-pill');
  if (!pill) return;
  pill.addEventListener('click', () => {
    const names = chatAgents.map(a => a.name).join('\n');
    const picked = prompt(`Switch agent to:\n\n${names}`);
    if (picked && chatAgents.find(a => a.name === picked)) {
      switchAgent(picked, { preferRestore: false });
    }
  });
}
```

Call from `initChat()`. On `chatState.on('agent:switch', …)`, update pill avatar + name.

- [ ] **Step 4: Subscribe to state changes to keep the pill + menu in sync**

In `initChat()`, after setup:

```js
chatState.on('agent:switch', (snap) => {
  const nameEl = document.getElementById('chat-agent-name');
  const avatarEl = document.getElementById('chat-agent-avatar');
  if (nameEl) nameEl.textContent = snap.agent?.displayName || snap.agent?.name || '…';
  if (avatarEl) avatarEl.textContent = (snap.agent?.displayName || snap.agent?.name || '?').slice(0, 1).toUpperCase();
});
```

- [ ] **Step 5: Single send/stop toggle**

In `initChat()`:

```js
chatState.on('turn:start', () => {
  const btn = document.getElementById('chat-send-btn');
  if (!btn) return;
  btn.innerHTML = '&#9632;';
  btn.title = 'Stop';
  btn.onclick = stopChat;
  btn.style.background = 'var(--accent-red)';
});
chatState.on('turn:end', () => {
  const btn = document.getElementById('chat-send-btn');
  if (!btn) return;
  btn.innerHTML = '&#9654;';
  btn.title = 'Send';
  btn.onclick = () => sendMessage('tile');
  btn.style.background = '';
});
```

The `sendMessage(source)` function's `source` argument is now unused — the shared input is the only input. Simplify the signature to `sendMessage()` and drop the overlay branch:

```js
async function sendMessage() {
  const input = document.getElementById('chat-input');
  const text = input?.value.trim();
  if (!text || chatState.get().streaming) return;
  input.value = '';
  // ... rest of existing logic ...
}
```

- [ ] **Step 6: Browser smoke**

```bash
pm2 restart home23-jerry-dash
```

Verify:
- Tile shows: agent pill, expand button, ⋯ button, plus the shared message-list + input. No model select, no new-conversation button, no standalone button visible at top level.
- Click ⋯ → menu opens below the button, 4 items. Click outside → closes. Esc → closes.
- "New conversation" → empties the message area, fresh chatId. Verify by sending a message.
- "Show conversations" → popover lists conversations; clicking one loads it.
- "Change model" → prompt; picking a valid model updates state; next message uses that model.
- "Open in new tab" → opens `/home23/chat?agent=jerry`.
- Agent pill → prompt; switching agent reloads the chat.
- Send/stop toggle works during streaming.

- [ ] **Step 7: Commit**

```bash
git add engine/src/dashboard/home23-dashboard.html engine/src/dashboard/home23-chat.js
git commit -m "$(cat <<'EOF'
refactor(dashboard): trim chat tile controls + unified ⋯ menu

Tile header reduces to: agent pill, expand button, ⋯ menu. Secondary
controls (new conversation, show conversations, change model, open in
new tab) collapse into the menu. Single send/stop toggle bound to
chatState streaming events — no more per-view button swapping.

Fixes pain point B (control clutter) for the tile; same menu component
reused by the overlay in the next task.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Trim overlay controls + reuse `⋯` menu

**Files:**
- Modify: `engine/src/dashboard/home23-dashboard.html`
- Modify: `engine/src/dashboard/home23-chat.js`

**Context:** Overlay header gets the same `⋯` menu + conversation-list panel (inline left column), plus close button and agent name.

- [ ] **Step 1: Rewrite overlay header markup**

In `engine/src/dashboard/home23-dashboard.html`, replace the contents of `<dialog id="chat-overlay">` with:

```html
<div class="h23-chat-overlay-layout">
  <aside class="h23-chat-overlay-sidebar" id="chat-overlay-sidebar" hidden>
    <!-- Conversation list renders here when toggled via ⋯ → "Show conversations" -->
    <div class="h23-chat-conv-list" id="chat-overlay-conv-list"></div>
  </aside>
  <div class="h23-chat-overlay-main">
    <div class="h23-chat-overlay-header">
      <div class="h23-chat-overlay-title" id="chat-overlay-title">Loading agent…</div>
      <div class="h23-chat-overlay-actions">
        <button class="h23-chat-icon-btn" id="chat-overlay-more-btn" title="More" aria-haspopup="menu" aria-expanded="false">&#8230;</button>
        <button class="h23-chat-icon-btn" id="chat-overlay-close-btn" title="Close">&#10005;</button>
      </div>
    </div>
    <div class="h23-chat-slot" id="chat-slot-overlay" data-slot="overlay">
      <!-- Shared message-list + input moves here -->
    </div>
  </div>
</div>
```

- [ ] **Step 2: Wire overlay-specific buttons**

In `engine/src/dashboard/home23-chat.js`, in `initChat()`:

```js
document.getElementById('chat-overlay-close-btn')?.addEventListener('click', closeOverlay);

// The overlay gets the same menu as the tile. Reuse handleMenuAction; position
// relative to the overlay more-btn instead of the tile more-btn.
const overlayMoreBtn = document.getElementById('chat-overlay-more-btn');
const menu = document.getElementById('chat-more-menu');
overlayMoreBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!menu.hidden) { menu.hidden = true; return; }
  const rect = overlayMoreBtn.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.right = `${window.innerWidth - rect.right}px`;
  menu.hidden = false;
});
```

- [ ] **Step 3: Adjust `handleMenuAction('toggle-conversations')` to know which slot is active**

```js
function handleMenuAction(action) {
  if (action === 'new-conversation') { newConversation(); return; }
  if (action === 'change-model') { showModelPicker(); return; }
  if (action === 'open-standalone') { openStandalone(); return; }
  if (action === 'toggle-conversations') {
    // If overlay is open, toggle the inline sidebar.
    // If tile is active, toggle the tile's popover.
    const overlay = document.getElementById('chat-overlay');
    if (overlay?.open) {
      const sidebar = document.getElementById('chat-overlay-sidebar');
      if (sidebar) sidebar.hidden = !sidebar.hidden;
      if (!sidebar.hidden) renderConversationListInto(document.getElementById('chat-overlay-conv-list'));
    } else {
      const popover = document.getElementById('chat-conv-popover');
      if (popover) popover.hidden = !popover.hidden;
      if (!popover.hidden) renderConversationListInto(popover);
    }
  }
}

function renderConversationListInto(container) {
  if (!container) return;
  const convs = chatState.get().conversations;
  container.innerHTML = convs.map(c => `
    <button class="h23-chat-conv-item" data-id="${escapeHtml(c.id)}">
      <div class="h23-chat-conv-preview">${escapeHtml(c.preview || 'New conversation')}</div>
      <div class="h23-chat-conv-meta">${escapeHtml(c.source || 'chat')} · ${c.messageCount || 0}</div>
    </button>
  `).join('');
  container.querySelectorAll('[data-id]').forEach(el => {
    el.addEventListener('click', () => {
      openConversation(el.getAttribute('data-id'));
      // Close popover/sidebar after selection (tidier).
      const popover = document.getElementById('chat-conv-popover');
      if (popover) popover.hidden = true;
    });
  });
}
```

- [ ] **Step 4: Update overlay title on agent switch**

In the `chatState.on('agent:switch', …)` handler (added in Task 4), also update:

```js
const overlayTitle = document.getElementById('chat-overlay-title');
if (overlayTitle) overlayTitle.textContent = `Talk to ${snap.agent?.displayName || snap.agent?.name || ''}`.trim();
```

- [ ] **Step 5: Browser smoke**

```bash
pm2 restart home23-jerry-dash
```

- Open overlay: shows title + `⋯` + close.
- Click `⋯` inside overlay → same menu. "Show conversations" opens the inline left sidebar inside the overlay (not a popover).
- Close overlay with X, backdrop click, and Esc — all three work (native `<dialog>` gives us Esc free).
- The shared message + input still move in and out cleanly.

- [ ] **Step 6: Commit**

```bash
git add engine/src/dashboard/home23-dashboard.html engine/src/dashboard/home23-chat.js
git commit -m "$(cat <<'EOF'
refactor(dashboard): trim overlay controls, reuse ⋯ menu + inline sidebar

Overlay header becomes agent title + ⋯ menu + close button. Same menu
component as the tile; 'Show conversations' renders into an inline left
sidebar when the overlay is open (vs a popover when the tile is active).
Native <dialog> handles Esc + backdrop + focus trap.

Fixes pain point B for the overlay; consistent menu across modes.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Extract CSS + apply responsive sizing

**Files:**
- Create: `engine/src/dashboard/home23-chat.css`
- Modify: `engine/src/dashboard/home23-chat.js` (remove injected `<style>` block)
- Modify: `engine/src/dashboard/home23-dashboard.html` (add `<link rel="stylesheet">`)
- Modify: `engine/src/dashboard/home23-chat.html` (same link)

**Context:** Existing styles are injected by `home23-chat.js` into a `<style>` tag. Extract to a real CSS file, then add responsive rules for tile min-height, overlay min/max dimensions, and standalone layout.

- [ ] **Step 1: Locate the injected `<style>` block in home23-chat.js**

```bash
cd /Users/jtr/_JTR23_/release/home23 && grep -n "style>\\|injectStyles\\|h23-chat-overlay {" engine/src/dashboard/home23-chat.js | head -20
```

Identify the start and end of the injected CSS string. Note the line range.

- [ ] **Step 2: Create the CSS file**

Create `engine/src/dashboard/home23-chat.css`. Paste the entire injected style content there, then add the new responsive rules at the bottom:

```css
/* ============================================================
   Task 6 additions — responsive sizing per spec Section 3
   ============================================================ */

/* Tile */
.h23-chat-tile {
  display: flex;
  flex-direction: column;
  min-height: 360px;
  min-width: 320px;
}
.h23-chat-tile .h23-chat-messages {
  flex: 1 1 auto;
  overflow-y: auto;
}
.h23-chat-tile .h23-chat-input {
  max-height: 8em;       /* ~4 lines; grows then scrolls */
  resize: none;
}
@media (max-width: 320px) {
  .h23-chat-agent-name { display: none; }
}

/* Conversation list popover (when tile is active) */
.h23-chat-conv-popover {
  position: absolute;
  top: 48px;
  right: 12px;
  width: 280px;
  max-height: 60vh;
  overflow-y: auto;
  background: var(--bg-secondary, #1a1a1a);
  border: 1px solid var(--border-color, #333);
  border-radius: 8px;
  padding: 8px;
  z-index: 100;
  box-shadow: 0 8px 24px rgba(0,0,0,0.3);
}

/* Overlay — native <dialog> */
dialog.h23-chat-overlay {
  width: min(80vw, 900px);
  height: min(85vh, 800px);
  max-width: 100vw;
  max-height: 100vh;
  padding: 0;
  border: 1px solid var(--border-color, #333);
  border-radius: 12px;
  background: var(--bg-secondary, #1a1a1a);
  color: inherit;
}
dialog.h23-chat-overlay::backdrop {
  background: rgba(0,0,0,0.6);
}
.h23-chat-overlay-layout {
  display: flex;
  height: 100%;
}
.h23-chat-overlay-sidebar {
  width: 300px;
  border-right: 1px solid var(--border-color, #333);
  overflow-y: auto;
}
.h23-chat-overlay-sidebar[hidden] { display: none; }
.h23-chat-overlay-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;  /* allows flex child to shrink */
}
.h23-chat-overlay-header {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color, #333);
}
.h23-chat-overlay-title {
  flex: 1;
  font-size: 16px;
  font-weight: 600;
}
.h23-chat-overlay-actions {
  display: flex;
  gap: 8px;
}
@media (max-width: 900px) {
  dialog.h23-chat-overlay {
    width: 100vw;
    height: 100vh;
    border-radius: 0;
  }
}

/* ⋯ Menu popover */
.h23-chat-menu {
  position: fixed;
  width: 220px;
  background: var(--bg-secondary, #1a1a1a);
  border: 1px solid var(--border-color, #333);
  border-radius: 8px;
  padding: 4px;
  z-index: 1000;
  box-shadow: 0 8px 24px rgba(0,0,0,0.3);
}
.h23-chat-menu[hidden] { display: none; }
.h23-chat-menu-item {
  display: block;
  width: 100%;
  padding: 8px 12px;
  background: transparent;
  color: inherit;
  border: none;
  text-align: left;
  border-radius: 4px;
  cursor: pointer;
  font: inherit;
}
.h23-chat-menu-item:hover { background: var(--bg-hover, #2a2a2a); }

/* Icon buttons */
.h23-chat-icon-btn {
  width: 32px;
  height: 32px;
  padding: 0;
  background: transparent;
  color: inherit;
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
  font-size: 18px;
}
.h23-chat-icon-btn:hover { background: var(--bg-hover, #2a2a2a); border-color: var(--border-color, #333); }

/* Agent pill */
.h23-chat-agent-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: transparent;
  color: inherit;
  border: 1px solid var(--border-color, #333);
  border-radius: 16px;
  cursor: pointer;
  font: inherit;
}
.h23-chat-agent-pill:hover { background: var(--bg-hover, #2a2a2a); }
.h23-chat-agent-avatar {
  width: 20px; height: 20px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 50%;
  background: var(--accent-color, #0a84ff);
  color: white;
  font-size: 12px;
  font-weight: 700;
}

/* Tile header layout */
.h23-chat-tile-header {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color, #333);
  gap: 8px;
}
.h23-chat-tile-actions {
  margin-left: auto;
  display: flex;
  gap: 4px;
}
```

- [ ] **Step 3: Remove the injected `<style>` block from home23-chat.js**

Edit `engine/src/dashboard/home23-chat.js`. Find the large CSS string being injected (the lines identified in Step 1). Delete the whole `<style>` injection block — the function that creates it and the code that calls it.

- [ ] **Step 4: Link the CSS from the dashboard HTML**

Edit `engine/src/dashboard/home23-dashboard.html`. In the `<head>`, add:

```html
<link rel="stylesheet" href="/home23/static/home23-chat.css" />
```

Check that the existing server serves the dashboard directory as static. Grep:

```bash
cd /Users/jtr/_JTR23_/release/home23 && grep -n "express.static\|sendFile.*home23-chat.css\|/home23/static" engine/src/dashboard/server.js | head -10
```

If `home23-chat.css` isn't served, add a route:

```js
this.app.get('/home23/static/home23-chat.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'home23-chat.css'));
});
```

Or check how `home23-chat.js` is served (likely by the same mechanism) and mirror it.

- [ ] **Step 5: Link the CSS from the standalone chat HTML**

Edit `engine/src/dashboard/home23-chat.html`, same `<link>` in `<head>`.

- [ ] **Step 6: Browser smoke across viewport sizes**

```bash
pm2 restart home23-jerry-dash
```

Resize the browser window and check visual state at:
- **320px wide**: tile agent name hides, avatar + buttons remain
- **600px**: tile looks normal; overlay would fullscreen (not testable here unless resized before opening)
- **900px**: overlay opens at 900×800 comfortable size
- **1400px**: overlay still 900×800 (capped), plenty of dashboard visible around
- **1920px**: standalone page content max-widths correctly (checked in Task 7)

- [ ] **Step 7: Commit**

```bash
git add engine/src/dashboard/home23-chat.css engine/src/dashboard/home23-chat.js engine/src/dashboard/home23-dashboard.html engine/src/dashboard/home23-chat.html engine/src/dashboard/server.js
git commit -m "$(cat <<'EOF'
refactor(dashboard): extract chat CSS + apply responsive sizing

Moves the previously-injected <style> block out of home23-chat.js into
a real home23-chat.css file served as a static asset. Adds responsive
rules per spec Section 3: tile min-height/width, overlay min/max
dimensions via native <dialog> with ::backdrop, breakpoint at 900px
where overlay fills viewport, consistent ⋯ menu + icon button styles.

Fixes pain point E (sizing / cramped).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Standalone page polish

**Files:**
- Modify: `engine/src/dashboard/home23-chat.html`
- Modify: `engine/src/dashboard/home23-chat.css` (add standalone-specific rules)
- Modify: `engine/src/dashboard/home23-chat.js` (initial-mount difference for standalone)

**Context:** Standalone is a separate page that loads the same `home23-chat.js`. On that page, tile/overlay concepts don't apply — we want a persistent sidebar + a max-width content pane.

- [ ] **Step 1: Rewrite home23-chat.html body**

Edit `engine/src/dashboard/home23-chat.html`. The shared chat template + JS should still load, but the page layout becomes:

```html
<body class="h23-standalone">
  <aside class="h23-standalone-sidebar">
    <div class="h23-standalone-agent-pick" id="standalone-agent-pick"></div>
    <div class="h23-standalone-conv-list" id="standalone-conv-list"></div>
  </aside>
  <main class="h23-standalone-main">
    <div class="h23-chat-slot" id="chat-slot-standalone" data-slot="standalone"></div>
  </main>

  <template id="chat-shared-template">
    <!-- same as in home23-dashboard.html — shared message/input subtree -->
  </template>

  <!-- No tile, no overlay on this page -->
</body>
```

Include `<link rel="stylesheet" href="/home23/static/home23-chat.css" />` in `<head>`.

- [ ] **Step 2: Detect standalone mode in home23-chat.js**

In `initChat()`:

```js
const standaloneSlot = document.getElementById('chat-slot-standalone');
const tileSlot = document.getElementById('chat-slot-tile');
const isStandalone = !!standaloneSlot && !tileSlot;

function mountSharedChatNodes() {
  const existing = document.getElementById('chat-shared');
  if (existing) return existing;
  const tpl = document.getElementById('chat-shared-template');
  const destSlot = isStandalone ? standaloneSlot : tileSlot;
  if (!tpl || !destSlot) return null;
  const node = tpl.content.firstElementChild.cloneNode(true);
  destSlot.appendChild(node);
  return node;
}
```

- [ ] **Step 3: On standalone, render the sidebar directly (not as a popover)**

After init, if `isStandalone`:

```js
if (isStandalone) {
  // Persistent sidebar — render conv list into the sidebar container.
  chatState.on('change', () => {
    renderConversationListInto(document.getElementById('standalone-conv-list'));
  });
  // Agent picker — simple list of agents.
  const agentPick = document.getElementById('standalone-agent-pick');
  chatState.on('agent:switch', (snap) => {
    if (!agentPick) return;
    agentPick.innerHTML = chatAgents.map(a => `
      <button class="h23-standalone-agent-btn${a.name === snap.agent?.name ? ' active' : ''}" data-name="${escapeHtml(a.name)}">
        ${escapeHtml(a.displayName || a.name)}
      </button>
    `).join('');
    agentPick.querySelectorAll('[data-name]').forEach(el => {
      el.addEventListener('click', () => switchAgent(el.getAttribute('data-name'), { preferRestore: false }));
    });
  });
}
```

- [ ] **Step 4: Add standalone CSS rules**

Append to `engine/src/dashboard/home23-chat.css`:

```css
/* ============================================================
   Standalone page layout
   ============================================================ */
body.h23-standalone {
  display: flex;
  height: 100vh;
  margin: 0;
}
.h23-standalone-sidebar {
  width: 300px;
  border-right: 1px solid var(--border-color, #333);
  overflow-y: auto;
  padding: 12px;
  flex-shrink: 0;
}
.h23-standalone-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.h23-standalone-main .h23-chat-slot {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.h23-standalone-main .h23-chat-messages {
  max-width: 880px;
  margin: 0 auto;
  width: 100%;
  flex: 1;
  overflow-y: auto;
}
.h23-standalone-main .h23-chat-input-area {
  max-width: 880px;
  margin: 0 auto;
  width: 100%;
}
.h23-standalone-agent-btn {
  display: block;
  width: 100%;
  padding: 8px 12px;
  background: transparent;
  color: inherit;
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
  font: inherit;
  margin-bottom: 4px;
}
.h23-standalone-agent-btn:hover { background: var(--bg-hover, #2a2a2a); }
.h23-standalone-agent-btn.active { border-color: var(--accent-color, #0a84ff); }

@media (max-width: 900px) {
  body.h23-standalone .h23-standalone-sidebar {
    position: fixed;
    left: 0; top: 0; bottom: 0;
    background: var(--bg-primary, #0a0a0a);
    z-index: 10;
    transform: translateX(-100%);
    transition: transform 0.2s ease;
  }
  body.h23-standalone.sidebar-open .h23-standalone-sidebar {
    transform: translateX(0);
  }
}
```

- [ ] **Step 5: Browser smoke**

Open `http://localhost:5002/home23/chat` in a new tab.

- Sidebar shows agent picker + conversation list
- Click a conversation → loads it into the main pane
- Main content pane has max-width on wide viewports (visible around 1400px+)
- Resize to < 900px: sidebar collapses to drawer (optional: verify `.sidebar-open` toggle works if wired to a hamburger button; if not, that's a nice-to-have for later)

- [ ] **Step 6: Commit**

```bash
git add engine/src/dashboard/home23-chat.html engine/src/dashboard/home23-chat.js engine/src/dashboard/home23-chat.css
git commit -m "$(cat <<'EOF'
refactor(dashboard): standalone chat page — persistent sidebar + max-width

Standalone (/home23/chat) gets a persistent left sidebar with agent
picker and conversations list — no popover, no toggle. Main pane caps
message + input at max-width 880px centered, so wide viewports don't
create long lines of text.

Below 900px viewport, sidebar collapses to a drawer (CSS ready; open/
close wiring is nice-to-have separate change if not needed).

Fixes pain point E for standalone; completes the 5-step rollout from
the spec.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task(s) |
|---|---|
| ChatState architecture | Task 1 |
| Global var migration | Task 2 |
| DOM-move for tile ↔ overlay | Task 3 |
| Control trim — tile | Task 4 |
| Control trim — overlay | Task 5 |
| Sizing + CSS extraction | Task 6 |
| Standalone polish | Task 7 |
| Overlay as native `<dialog>` | Task 3 + Task 6 CSS |
| `⋯` click-to-open menu | Task 4 (shared with Task 5) |
| Skip input-draft undo | Not in plan (YAGNI — confirmed) |
| Cross-tab sync | Out of scope per spec |

All spec requirements have a corresponding task.

**Placeholder scan:** No TBD, no "implement later," every step shows exact code or exact commands.

**Type consistency:** `chatState` singleton imported from `home23-chat-state.js` — used consistently. `_s()` helper alias for `chatState.get()` used where brevity helps. `chatAgents` / `chatModels` / `chatCurrentAgentName` remain module-local (registry data), intentionally not in state — documented in Task 2 Step 3.

**Scope:** Single cohesive feature — the UX cleanup. 7 tasks, ~2-3 hours focused work. Fits one plan.

**Rollback:** Each task is one or two commits. Revert a specific commit if it causes a regression; later commits depend on earlier ones only topologically (state → DOM → controls → CSS → standalone). Backend is untouched except the one static file route in Task 6.
