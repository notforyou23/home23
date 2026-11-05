# Dashboard Chat UX Cleanup

**Date:** 2026-04-19
**Status:** Design (approved by jtr through all sections, proceeding to plan)
**Author:** Claude + jtr
**Related:** earlier today's `fix(dashboard): chat history normalization + agent-switch resume` + `fix(agent): search_files capped output + per-turn wall-clock watchdog`

## Summary

The dashboard chat has three surfaces — **tile** (embedded in the dashboard grid), **overlay** (modal expansion), and **standalone** (`/home23/chat` full page). Today each surface has its own DOM for messages, its own input, its own send button, and state is shuttled between tile and overlay via `innerHTML` copy. Results: mid-turn streaming lost on expand, duplicated inputs fighting for focus, controls clutter the tile, the overlay and tile fight for sizing, and the three modes feel like three different apps.

User uses all three modes depending on context, so the fix is to **polish each mode and unify their state**, not collapse modes. Three pain points to attack:

- **A. State/message sync between modes** — lose streaming, messages, focus when transitioning
- **B. Control clutter** — too many visible buttons, unclear which does what
- **E. Sizing / cramped** — overlay too small or awkwardly sized; tile gets squeezed

The approach: introduce a central `ChatState` module as the source of truth, physically **move** (not copy) a single message-list + input DOM subtree between tile and overlay, trim each view's visible controls to essentials (overflow goes into a `⋯` menu), and apply clear responsive sizing rules extracted into a dedicated CSS file.

## Goals

- One source of truth for conversation state — no more `innerHTML` syncing
- Each mode keeps its own purpose but shares the same conversation seamlessly
- Visible controls in each mode are the essentials; secondary options live in a consistent `⋯` menu
- Overlay feels right-sized (min 900×800, max 80vw/85vh, backdrop dismissal)
- Tile works at all grid widths without cramping
- Standalone uses its viewport deliberately (persistent sidebar, max-width content pane)
- Mid-turn streaming survives tile ↔ overlay transitions without flicker

## Non-goals

- Cross-tab live sync between standalone and tile (fall back to backend refresh)
- Keyboard shortcuts (separate spec if desired)
- Mobile-optimized layouts (desktop only; iOS app is separate)
- Turn protocol / backend changes (pure frontend work)
- Merging any of the three modes into one (user confirmed all three stay)

## Architecture

### `ChatState` — central source of truth

New module `engine/src/dashboard/home23-chat-state.js` exports a singleton with:

```js
{
  // routing
  agent: { name, displayName, bridgePort, ... } | null,
  model: string | null,
  provider: string | null,

  // conversation
  conversationId: string | null,     // clean chatId, no namespace prefix
  conversations: Conversation[],     // sidebar list
  messages: Message[],               // rendered list, source of truth

  // composition
  input: string,                     // draft text (single source for all 3 views)

  // streaming
  streaming: boolean,
  activeTurnId: string | null,
  activeCursor: number,
  turnCtx: { responseEl, currentResponse, thinkingEl, currentThinking } | null,
}
```

Public API:

- `chatState.get()` — returns a shallow-copy snapshot
- `chatState.set(patch)` — merges and fires `change` events
- `chatState.on(event, cb) / off(event, cb)` — event subscriptions
- Events: `change` (general), `message:append`, `turn:start`, `turn:end`, `conversation:switch`, `agent:switch`

No direct global `let` variables for conversation state anywhere else in `home23-chat.js`. Views read and write exclusively through `chatState`.

### DOM-move transition (tile ↔ overlay, same page)

Today: `overlayBody.innerHTML = tileMessages.innerHTML` — pure markup transfer, loses event bindings, breaks mid-stream rendering, duplicates nodes on close.

Proposed: there is **one** message-list DOM subtree (`#h23-chat-messages`) and **one** input (`#h23-chat-input`). On overlay open, `appendChild(messagesEl)` into overlay body and `appendChild(inputEl)` into overlay footer. On overlay close, move both back to tile. Event bindings, streaming state, scroll position, and focus all survive because we're moving the same nodes, not cloning markup.

### Cross-page (standalone)

Standalone is a separate window at `/home23/chat` loaded via popout button. It has its own `ChatState` instance (separate page = separate JS runtime). State sync is via backend: on load, fetch conversations and selected conversation's history. For v1 we don't do live cross-window sync — if user sends a message in standalone, the tile won't reflect it until refresh. Revisit if it becomes painful.

## Control Surface (per mode)

### Tile

Visible controls:

- Agent avatar + name (click → agent picker popover)
- Expand button (→ overlay)
- `⋯` menu button
- Input + single send/stop toggle button (bound to `chatState.streaming`)

Moved into `⋯`:

- New conversation
- Show conversations list (opens popover over tile — doesn't steal horizontal space)
- Change model
- Open in new tab (→ standalone)

Removed: separate popout/standalone button, separate conversation-list toggle, model dropdown.

Narrow-width behavior: when tile width < 320px, hide agent name text (show avatar only).

### Overlay

Visible controls:

- Agent name (large) + inline model indicator (click → change)
- Close (X)
- Conversation-list panel toggle (left column, inline — pushes message area right when open, not a popover)
- `⋯` menu button
- Same shared message-list + input DOM, moved in from tile on open

`⋯` menu (identical shape to tile's, modulo expand/popout):

- New conversation
- Show/hide conversations (toggles the inline left panel)
- Change model
- Open in new tab (→ standalone)

Dismissal: X button, backdrop click, `Esc` key.

### Standalone

Visible controls:

- Persistent left sidebar (300px, always shown above viewport width 900px)
  - Agent picker at top
  - Full conversations list below
- Main pane top bar:
  - Agent name
  - Inline model picker
  - `⋯` menu (smaller: New conversation only; no expand/popout since we're already at max)
- Main pane body: messages + input

Below viewport width 900px: sidebar becomes a collapsible drawer.

### Shared rule

Send/stop is a single toggle button bound to `chatState.streaming`. When `streaming === false`, button is "send"; when `true`, "stop". One binding, rendered per-view.

## Sizing + Layout

### Tile

- Min height 360px (keeps messages readable at default grid height)
- Min width 320px
- Messages area: flex-grow, scrollable
- Input: pinned to bottom, auto-growing textarea capped at 4 lines
- Conversation-list (invoked via `⋯`): popover over tile — does NOT push message area

### Overlay

- Centered over the dashboard
- `min(80vw, 900px) × min(85vh, 800px)`
- Backdrop darkens the dashboard (but remains visible — reinforces "same chat, bigger")
- Conversation-list panel (toggle): inline 300px left column; when open, message area shrinks to the right within the overlay
- Below 900px viewport width: overlay auto-fills viewport with small padding

### Standalone

- Full viewport
- Left sidebar fixed 300px
- Main pane flexes
- Above 1400px viewport: message area has `max-width: 880px` centered so long lines don't sprawl
- Below 900px viewport: sidebar collapses to drawer (toggled by a menu button in top bar)

### Transitions

- Tile → overlay: 200ms overlay fade-in; DOM move happens mid-fade so message list doesn't flash
- Overlay → tile: reverse fade-out, DOM move at end
- Opening standalone: new tab navigation — no transition (it's a full page)

### CSS location

All responsive rules live in `engine/src/dashboard/home23-chat.css` (new file). Today's styles are embedded inline in `home23-chat.js` via a `<style>` injection; that logic moves to the CSS file. Inline JS styling stays only for dynamic per-instance values (scroll positions, calculated heights).

## Rollout

Five steps, each independently shippable and reviewable:

1. **State layer** — create `home23-chat-state.js`, refactor `home23-chat.js` to use it. No visible change. Validates the shape.
2. **DOM-move transition** — replace `innerHTML` copies with `appendChild` moves. Fixes streaming-across-expand. Visible improvement.
3. **Control trim** — consolidate buttons into `⋯` menu per the Control Surface section. Biggest visible UX win.
4. **Sizing + responsive CSS** — extract to `home23-chat.css`, apply dimensions. Overlay and tile feel right-sized.
5. **Standalone polish** — persistent sidebar, max-width content pane. Smallest risk, do last.

Each step is 1-3 commits. After each, jtr can eyeball in browser.

## Error / edge cases

- **Streaming turn active when overlay opens**: DOM move preserves the stream. New behavior: `chatState.streaming` stays `true` during the move; input stays disabled; stop button stays wired. No state loss.
- **User closes overlay mid-stream**: DOM moves back to tile. Streaming continues to render into the tile's message list. If tile isn't visible in the current dashboard scroll position, scroll-on-event brings it into view (nice-to-have; acceptable v1 is that messages finish streaming off-screen and user can scroll back).
- **Conversation switched during stream**: cancel the in-flight turn (`stopChat()`), clear `turnCtx`, swap `conversationId`, load new history. Current behavior preserved.
- **User opens overlay twice / two overlay instances**: guarded; only one `#h23-chat-overlay` instance in DOM. Re-opening focuses input.
- **Standalone opened while tile/overlay has unsent input**: standalone starts blank (separate state instance). Input text in tile/overlay is NOT carried to standalone — acceptable for v1 (cross-window sync is non-goal).
- **Agent switch while conversation loaded**: flush current state, `conversation:switch` event fires with new conversation id from the new agent's list (top of `loadConversationList` result, per earlier fix).

## Testing

- **Manual browser smoke per step:**
  - Step 1: open tile, send message, receive response, switch conversation. No visual change expected; verify no regressions.
  - Step 2: start a response streaming in tile, expand to overlay mid-stream — streaming continues uninterrupted. Collapse mid-stream — same.
  - Step 3: verify each view's visible controls match spec. Click each `⋯` item, verify behavior.
  - Step 4: resize browser; verify tile, overlay, standalone each respond to widths 320 / 600 / 900 / 1400 / 1920.
  - Step 5: standalone with sidebar, switch conversations, verify max-width at wide viewports.
- No new automated tests (current dashboard has none; introducing a UI test harness is a separate spec).

## Preserves

- Today's recent fixes: history file-naming normalization, switchAgent resume, search_files bounds, turn watchdog.
- Turn protocol (SSE turn envelopes, pending-turn resume on visibilitychange).
- Telegram/Discord adapters (they share conversation storage on disk but not the dashboard UI — untouched).

## Rollback

Each step is a separate commit or tight commit pair. Revert the specific step if it goes wrong; later steps depend on state-layer (step 1), but step 1 is a no-op refactor so reverting it is always safe. Backend is untouched — zero data or config risk.

## Open questions for the plan phase

- Exact shape of `⋯` menu interaction: click-to-open / hover-to-open / keyboard-accessible? Pick one during implementation.
- Whether to give `ChatState` a history/undo layer (for input draft recovery on refresh beyond current localStorage behavior). Probably YAGNI — skip unless it falls out naturally.
- Whether to use native `<dialog>` for the overlay (modern browsers support it well, gives free Esc + focus trap + backdrop) vs the current custom modal pattern.
