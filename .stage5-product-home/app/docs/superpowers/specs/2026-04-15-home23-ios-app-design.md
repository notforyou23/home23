# Home23 iOS App — Design

**Status:** Spec (brainstorm approved)
**Owner:** jtr
**Date:** 2026-04-15
**Follows:** 2026-04-15-resumable-chat.md (backend turn protocol, shipped)

## Goal

A first-class native iOS app for chatting with home23 agents. Primary pain point: Safari loses in-flight replies when you hop apps; when the agent replies you don't find out. The app solves both — persistent connection via the resumable turn protocol, APNs push notifications when replies land.

V1 scope is chat-only. Architecture is built so future features (pulse, brain map, vibe, research, sensor controls) slot in without a rewrite.

## Strategy

**Fork, don't add-a-section.** Clone the existing `Cosmo.xcodeproj` into a new `Home23.xcodeproj`. Keep the learned scaffolding (SSE streaming, SwiftUI chat patterns, conversation store, APIClient architecture). Rip out Cosmo-specific pieces (Supabase auth, regina6.com networking, ImageGen, Gallery, Brains graph — all deferred to later phases). Rebuild the networking layer against the home23 bridge. New bundle ID, new app identity. Cosmo continues unchanged as a separate product.

## Repository location

The iOS project lives as a sibling to Cosmo, not inside the home23 Node repo:

```
/Users/jtr/xCode_Builds/
  Cosmo/                      ← existing, untouched
    Cosmo.xcodeproj
    Cosmo/…
  Home23/                     ← NEW (this project)
    Home23.xcodeproj
    Home23/
      Home23App.swift
      ContentView.swift
      Info.plist
      Home23.entitlements
      Assets.xcassets/
      Sources/
        App/
        Core/
        Features/
        Shared/
    Configs/                  ← xcconfig files (mirrors Cosmo pattern)
    AGENTS.md
    CLAUDE.md
    README.md

/Users/jtr/_JTR23_/release/home23/   ← existing Node/TS monorepo, untouched
  (backend additions from "Backend changes" section land here)
```

**Rationale:** the app and the backend version independently, TestFlight/signing is a per-app concern, and the home23 repo already has enough going on. Cross-references between repos happen via:
- This spec and plan (in `home23/docs/superpowers/`)
- A pointer file in `Home23/` (`README.md` links back to the home23 repo + this spec)
- Git history on both sides references the other by commit SHA when coordinated changes ship (e.g. "iOS v0.1.0 requires home23 ≥ commit X")

Home23 is its own git repo initialized at `Home23/`. First commit lands the fork + initial rip-out.

## Non-goals (v1)

- No public endpoint. Tailscale-only.
- No multi-agent parity across different home23 *instances* (one install = one home23 target host).
- No pulse tile, brain map, vibe gallery, research controls, sensor controls — all future phases.
- No voice input, Siri shortcuts, widgets, Live Activities — future phases.
- No share sheet extension — future.
- No queued-send offline mode — offline is read-only.
- No App Store distribution. TestFlight only (personal / trusted testers).

## Architecture

```
┌─────────────────────────────────────────────┐
│  Home23 iOS App                             │
│                                             │
│  ┌────────────┐  ┌──────────────────────┐   │
│  │  TabView   │  │  ChatShellView       │   │
│  │  [Chat]    │──│  - AgentPicker       │   │
│  │  [Settings]│  │  - ConversationList  │   │
│  └────────────┘  │  - ChatView          │   │
│                  │    - MessageList     │   │
│                  │    - Composer        │   │
│                  └──────────────────────┘   │
│                                             │
│  ChatViewModel ── TurnStream (EventSource)  │
│       │              │                      │
│       └── APIClient ─┴── URLSession         │
│                 │                           │
│       ConversationCache (SQLite)            │
│                                             │
│  NotificationCenter ── APNs delegate        │
│  KeychainStore ── bearer token              │
└──────────────┬──────────────────────────────┘
               │ Tailscale (HTTP)
               ▼
┌─────────────────────────────────────────────┐
│  home23 Mac (localhost over Tailscale)      │
│                                             │
│  Bridge (per-agent, port 50X4)              │
│    /api/chat/turn (POST)                    │
│    /api/chat/stream (GET SSE)               │
│    /api/chat/stop-turn (POST)               │
│    /api/chat/pending (GET)                  │
│    /api/chat/history (NEW — GET)            │
│    /api/device/register (NEW — POST)        │
│                                             │
│  Dashboard HTTP (port 50X2)                 │
│    /home23/api/settings/agents (existing —  │
│      returns agent list w/ bridge ports)    │
│                                             │
│  APNs Pusher (NEW — server-side)            │
│    Bridge → apns-jwt → Apple → device       │
└─────────────────────────────────────────────┘
```

**Networking model:** App stores one thing — the home23 host URL (e.g. `http://jtr-mac.tailnet.ts.net`) — and a bearer token. It discovers agents by hitting `/home23/api/settings/agents` on the dashboard port, gets back a list of agents each with their own bridge port. All chat operations go to the per-agent bridge.

**Conversation identity:** `chatId` = `ios:<deviceId>:<agentName>:<ulid>` — distinct namespace from dashboard (`dashboard-<agent>-<ts>`) and Telegram. Each device owns its own conversations; they don't sync across devices (v1 limitation, acceptable).

## Components

### 1. SwiftUI shell

```
Home23App.swift            — entry point, env stores
ContentView.swift          — TabView root (Chat, Settings)
Features/
  Chat/
    ChatShellView.swift    — list of conversations for selected agent
    ChatView.swift         — single conversation streaming
    ChatViewModel.swift    — owns TurnStream, state
    Composer.swift         — input bar (text only in v1)
    MessageRow.swift       — individual message/tool/thinking render
  Settings/
    SettingsView.swift     — host URL, token, push permission, diagnostics
    OnboardingView.swift   — first-run: paste host + token, test, done
Core/
  Networking/
    APIClient.swift        — bearer-auth URLSession wrapper
    TurnStream.swift       — EventSource-like for /api/chat/stream
    AgentDirectory.swift   — queries dashboard, caches agent list
  Persistence/
    ConversationCache.swift— SQLite (GRDB) read-only offline cache
    KeychainStore.swift    — bearer token
  Push/
    PushRegistrar.swift    — APNs registration, delegate, device-token upload
    PushRouter.swift       — userNotificationCenter delegate (foreground suppression, deep-link)
  Models/
    Agent.swift
    Conversation.swift
    TurnEvent.swift        — matches backend wire format
    PushPayload.swift
```

No `Brains/`, `Gallery/`, `ImageGen/`, `CosmoRun/` in v1. Those dirs get deleted from the fork.

### 2. Chat data flow

Identical to the web `/home23/chat` we just shipped, ported to Swift:

1. User sends message → `ChatViewModel.sendTurn(text)`
2. `APIClient.post("/api/chat/turn", {chatId, message})` → returns `{turn_id}` in ~30ms
3. `TurnStream.open(chatId, turnId, cursor: -1)` → URLSession data task with `Accept: text/event-stream`, custom line parser
4. Each `{type:"event", seq, data:{...}}` record:
   - Append to `currentTurnCtx` in ViewModel
   - Render into message bubble
   - Persist to `ConversationCache` (SQLite)
   - Update `activeCursor = seq`
5. Each `{type:"turn", status:"complete"|"error"|"stopped"|"orphaned"}`:
   - Finalize turn UI, reset send button
   - Cache write
   - Stream closes

**On app background:** URLSession streams persist briefly but iOS will suspend within ~30s. Stream closes. `activeTurnId` and `activeCursor` remain in ViewModel state.

**On app foreground:** `ChatViewModel.onScenePhaseActive` — if `activeTurnId` set and no open stream, reopen `TurnStream(cursor: activeCursor)` → catch-up replay + live tail.

**On app launch:** For the currently selected conversation, hit `GET /api/chat/pending?chatId=X`. Any pending turn auto-resumes (same flow as web).

### 3. Push notifications

**Backend additions (see "Backend changes" section):**
- `POST /api/device/register` — app uploads device token, chatId, agent name
- Bridge, on turn completion (`runWithTurn` end), if any device tokens are registered for this chatId, fire an APNs push with `alert.body = firstChars(replyText, 100)` and `mutable-content: 1`.

**App-side behavior:**
- On first launch after token entry, `PushRegistrar.register()` requests `.alert, .badge, .sound`, registers for remote notifications.
- Device token handed to `/api/device/register` along with the currently-selected `chatId`s (one per active conversation).
- `UNUserNotificationCenterDelegate.willPresent` — if app foreground AND the conversation that owns this push is currently visible, return `[]` (suppress). Otherwise `[.banner, .sound]`.
- Tap push → deep-link into the originating conversation (`turn_id` and `chatId` in payload userInfo).

**Payload shape (from bridge):**
```json
{
  "aps": {
    "alert": { "title": "<agentName>", "body": "<first 100 chars>" },
    "mutable-content": 1,
    "sound": "default"
  },
  "chatId": "ios:...",
  "turnId": "t_...",
  "agent": "jerry"
}
```

No Notification Service Extension for v1 — server already has the text, no transform needed on-device.

### 4. Auth + onboarding

First-launch flow:

1. Welcome screen: "Home23 on your phone."
2. Prompt: "Host URL" (default placeholder `http://<your-mac>.tailnet.ts.net`) + "Bearer Token" (paste from `config/secrets.yaml` → `bridge.token` or wherever you configure it).
3. "Test connection" button: hits `/home23/api/settings/agents` with bearer. Success → list of agents shown. Failure → error.
4. "Allow notifications?" → APNs permission prompt.
5. Done → lands on Chat tab.

Token stored in Keychain. Host URL in UserDefaults. Both editable via Settings tab.

No Supabase. No external auth provider. No remote config service. The app is self-contained and points at a single home23 instance.

### 5. Offline cache

SQLite (GRDB.swift) with schema:

```
conversations(id TEXT PK, agent TEXT, title TEXT, updated_at INT)
messages(id INT PK AUTO, conv_id TEXT FK, role TEXT, content TEXT, ts INT, turn_id TEXT NULL)
turns(turn_id TEXT PK, conv_id TEXT FK, status TEXT, last_seq INT, started_at INT, ended_at INT NULL)
events(turn_id TEXT FK, seq INT, kind TEXT, data_json TEXT, ts INT, PK(turn_id, seq))
```

Writes: streamed into cache as events arrive, plus final user+assistant messages on turn complete.

Reads: when network unreachable or app first-launches, load from cache. Composer disabled with banner: "Off-network — reading from cache."

Cache cap: last 100 conversations per agent, pruned LRU.

Delete cache option in Settings.

## Backend changes

Four small additions to home23 (all in the existing bridge/dashboard):

### A. `GET /api/chat/history?chatId=X&limit=50`
Server-side read of the JSONL, returns a bounded window of messages + turn envelopes for initial load. The existing `ConversationHistory.load(chatId)` already does most of this; thin HTTP wrapper needed.

### B. `POST /api/device/register`
```json
{
  "deviceToken": "...",        // APNs token (hex string)
  "agent": "jerry",
  "chatIds": ["ios:xxx:jerry:..."]  // subscribe this device to these conversations
}
```
Stored in `instances/<agent>/brain/device-registry.json`. Tokens deduped. `DELETE /api/device/register` to unregister.

### C. APNs pusher module (`src/push/apns.ts`)
- Reads `.p8` key from `config/secrets.yaml` (`apns.keyId`, `apns.teamId`, `apns.bundleId`, `apns.keyPath`)
- Generates JWT provider token (cached ~50 min, max 60)
- HTTP/2 POST to `api.push.apple.com/3/device/<token>` with the payload
- Prod vs sandbox selected via build config (sandbox for TestFlight builds that haven't been submitted yet — actually TestFlight uses prod APNs, local Xcode builds use sandbox)

### D. `runWithTurn` hook
On turn completion (inside `src/agent/loop.ts` or the route handler), after the `complete` envelope is written:
- Look up device tokens registered for this chatId
- For each token, post APNs payload with `alert.body` = `assistantText.slice(0, 100)`
- Fire-and-forget, log errors

No change to the turn protocol itself — push is an output side-effect of turn completion.

## Distribution

- **TestFlight personal group.** Upload builds from Xcode Cloud or manually via Xcode Organizer. 90-day install window per build; over-the-air updates. Same paid dev account as Cosmo.
- **Bundle ID:** `com.regina6.home23` (same team as Cosmo, new identifier registered with Push capability).
- **Provisioning:** automatic (Xcode managed), Apple Development + Apple Distribution certificates from the team.
- No App Store submission planned. TestFlight is the distribution channel for v1 and foreseeable future.

## Error handling

- **Can't reach bridge** → show offline cache if any, banner "Can't reach home23." Retry button re-tests.
- **401 Unauthorized** → kick to Settings, "Token rejected. Please re-enter."
- **Turn stream dies mid-stream** → catch-up on next foreground or next scene-phase-active. Behavior already verified on web.
- **Push fails to deliver** → fallback = user sees the reply next time they open the app (pending-turn resume catches it).
- **Cache corruption** → "Reset cache" in Settings; reinitializes SQLite.

## Testing

No iOS unit test runner for this app in v1 (matching home23's no-unit-test convention). Verification = manual:

- Chat send/receive on Wi-Fi, cellular-with-Tailscale, off-Tailscale
- Background / foreground cycle mid-reply (30s, 5min, app kill)
- Lock screen push received with preview
- Tap push → deep-link to conversation
- Foreground-while-conversation-open → push suppressed
- Foreground-in-settings-tab, push for chat → banner shown
- Multi-agent switcher
- Cache survives app quit
- Off-Tailscale → read-only banner + scrollable cached messages
- Token rotation: rotate bridge token, app → 401 → re-onboard works

## Roadmap (non-binding)

**v1 — Chat MVP** (this spec)
**v2** — Pulse tile on Chat tab (mobile version of Jerry's voice remarks)
**v3** — Widget (latest pulse remark on home screen)
**v4** — Share sheet ("Send to Jerry" from any iOS app → ingestion / chat)
**v5** — Brain map (3D graph, native Metal or SceneKit)
**v6** — Vibe gallery
**v7** — Voice in (on-device Whisper → chat) / voice out (TTS)
**v8** — Live Activity for long-running research (COSMO runs)
**v9** — Siri shortcut ("Hey Siri, ask Jerry …")

None are committed. Listed to show the architecture leaves room.

## Open design decisions (deferred to plan)

- Exact push text for empty replies (agent ran tools but produced no text) — probably agent name + "replied" fallback
- Agent list refresh cadence (on-launch only, or poll)
- Conversation list grouping (by agent? chronological?)
- Deep link URL scheme (`home23://chat?chatId=X&turnId=Y`)
- Swift concurrency model (async/await for URLSession; figure out TurnStream as AsyncSequence)
- Settings: which diagnostics to expose (last error, cache size, device token last-registered at, etc.)

These don't block the spec — they get answered in the implementation plan.
