# Step 13: Dashboard Chat Tile

Native chat interface built into the Home23 dashboard. Talk to your agent directly from the home screen — no Telegram, no evobrew, no external app required.

## Architecture

### Three Surfaces, One Component

The chat is a single JS component rendered in three contexts:

1. **Tile** — right column of the Home tab's 3-column grid (replaces System tile position). Fixed height (~280px), expand button in header.
2. **Overlay** — full-viewport overlay triggered by the expand button. Same component, bigger container. Minimize returns to tile.
3. **Standalone page** — `/home23/chat`, full-page layout. Bookmarkable, works over Tailscale/LAN.

All three share the same JS module, conversation state, and SSE connection.

### Connection: SSE via Bridge

The existing bridge endpoint (`src/routes/evobrew-bridge.ts`) runs the full agent loop with identity, memory, and all 26 tools. The dashboard chat connects to it via SSE streaming.

**Flow:**
1. Client POSTs `{ message, conversationHistory }` to the bridge's `/api/chat` endpoint
2. Bridge invokes `agent.run(chatId, message)` — full agent loop
3. SSE events stream back: thinking, tool calls, response chunks, completion
4. Client renders each event type inline

**Chat ID:** `dashboard:<agentName>` — stable per agent, so the harness maintains conversation context across sessions.

**Bridge URL:** Constructed from the agent's bridge port in its config. Primary agent's bridge port is known from `/home23/api/settings/agents`.

### Event Types and Rendering

All agent activity shown inline — full transparency, no collapsing.

| SSE Event | Rendering |
|-----------|-----------|
| `thinking` | Muted italic text block in `--h23-text-muted` color |
| `tools_start` | Ignored (tool_start handles individual tools) |
| `tool_start` | Card with tool name + args preview, pending state |
| `tool_complete` / `tool_result` | Card updates with result summary, success/fail dot |
| `response_chunk` | Appended to current assistant message bubble, streamed live |
| `complete` | Final message rendered, scroll to bottom |
| `error` | Red inline error message |

### Persistence

**Server-side (primary):** Conversations stored by the harness in `instances/<name>/conversations/` keyed by chatId. The agent loop handles this automatically when `agent.run()` is called with a stable chatId.

**History loading:** New API endpoint `GET /home23/api/chat/history/:agentName` reads recent messages from the harness conversation store. Returns last N messages (default 50) as `[{ role, content, timestamp }]`.

**localStorage (cache):** Last messages cached at `home23:chat:<agentName>` for instant render on page load. Overwritten when server history arrives. Provides instant UI while the server fetch completes.

**Cross-device:** Same conversation accessible from any machine hitting the same dashboard URL — history comes from server, not browser.

### Agent Selector

Dropdown in the chat tile header. Primary agent pre-selected and labeled.

- Populated from `/home23/api/settings/agents`
- Switching agents: saves scroll position, loads new agent's history, targets new agent's bridge port
- Primary agent marked with "(primary)" label in dropdown

### Home Tab Layout Changes

**Before (3-column top row):**
```
[ Thoughts ] [ Vibe ] [ System ]
```

**After:**
```
[ Thoughts ] [ Vibe ] [ Chat ]
```

The System tile relocates below the top row as a compact stats bar alongside the Feeder tile. System data (uptime, thoughts, nodes, last thought) displayed horizontally rather than in a grid.

### Chat Tile Layout

```
┌─────────────────────────────────┐
│ COZ ▾          [↗ expand]       │  ← header: agent dropdown + expand btn
├─────────────────────────────────┤
│                                 │
│  [messages scroll area]         │  ← thinking, tools, responses
│                                 │
│  🤔 considering your question...│  ← thinking block
│                                 │
│  🔧 brain_search               │  ← tool card
│     query: "recent goals"       │
│     ✓ 3 results                 │
│                                 │
│  The current goals are...       │  ← response
│                                 │
├─────────────────────────────────┤
│ [message input...        ] [⏎]  │  ← textarea + send
└─────────────────────────────────┘
```

### Overlay Layout

Same as tile but `position:fixed; inset:0; z-index:1000`. Dark backdrop. Header adds a minimize button (returns to tile) and retains the expand-to-standalone link.

### Standalone Page (`/home23/chat`)

Full-page layout:
- Header: Home23 logo, agent selector, "← Dashboard" link
- Chat fills remaining viewport height
- Same `home23-chat.js` module, just mounted differently
- Linked from overlay header and directly accessible

## API Endpoints

### New

- `GET /home23/api/chat/history/:agentName` — returns recent conversation messages
  - Query params: `?limit=50` (default 50)
  - Response: `{ messages: [{ role, content, timestamp, toolCalls? }] }`
  - Reads from `instances/<name>/conversations/` using the `dashboard:<name>` chatId

- `GET /home23/api/chat/config/:agentName` — returns bridge connection info
  - Response: `{ bridgePort, agentName, displayName }`

### Existing (used as-is)

- `POST /api/chat` on bridge port — SSE streaming agent interaction (evobrew-bridge.ts)
- `GET /home23/api/settings/agents` — agent list for selector dropdown

## Files

| File | Purpose |
|------|---------|
| `engine/src/dashboard/home23-chat.js` | Chat client: SSE connection, message rendering, history loading, agent switching, tile/overlay/standalone modes |
| `engine/src/dashboard/home23-chat.css` | Chat styles: tile, messages, tool cards, thinking blocks, overlay, standalone |
| `engine/src/dashboard/home23-chat.html` | Standalone chat page (`/home23/chat`) |
| `engine/src/dashboard/home23-dashboard.html` | Modified: replace System tile with Chat tile, relocate System to stats bar |
| `engine/src/dashboard/home23-dashboard.js` | Modified: initialize chat component on load |
| `engine/src/dashboard/home23-dashboard.css` | Modified: system stats bar styling, grid adjustment |
| `engine/src/dashboard/server.js` | Modified: `/home23/chat` route, `/home23/api/chat/*` endpoints |

## Scope Boundaries

**In scope:**
- Chat tile on Home tab, overlay, standalone page
- SSE streaming to bridge endpoint
- Full thinking/tool visibility
- Agent selector with primary default
- Conversation persistence via server + localStorage cache
- System tile relocation

**Out of scope:**
- File/document context (that's evobrew's job)
- Pending edit approval (no code editing from dashboard)
- Voice/TTS integration
- Multi-agent conversations (one agent at a time)
- New bridge features (use existing bridge as-is)
