# Step 19: Telegram Message Handling — Adaptive Debounce + Queue-During-Run

## Problem

Two issues with the current Telegram message handling:

1. **Agent fires too early.** The 3-second flat debounce means the agent picks up a conversation before the user finishes typing across multiple messages. User sends "hey", pauses to type the next message, and the agent fires after 3 seconds.

2. **Messages during active runs are lost.** The concurrent-run guard in `home.ts` returns "I'm still working on something. Send /stop to interrupt me." — follow-up messages sent while the agent is processing get bounced instead of queued.

The combination is brutal: short debounce fires early, then the concurrent guard blocks everything after.

## Research

Studied OpenClaw, Hermes Agent, and broader Telegram bot ecosystem:

- **OpenClaw**: 2s debounce, per-channel overrides, queue modes (`collect`, `steer`, `followup`, `interrupt`). Media flushes immediately. Commands bypass debounce.
- **Hermes Agent**: No debounce — queue-based. Messages during processing go to `_pending_messages`, processed after current turn. Has a critical bug with dual queues dropping messages.
- **Telegram Bot API limitation**: Does not expose user typing events to bots. No typing detection possible without MTProto user-session hack.
- **Nobody has built adaptive debounce** based on message content analysis. LLM-based end-of-turn detection exists (n8n workflow) but is overkill.

## Design

### 1. Adaptive Debounce

**File:** `src/channels/router.ts` — `enqueue()` method

Replace the flat `debounceMs` with a heuristic function `computeAdaptiveDelay(text, fallbackMs)` that examines the message text:

| Signal | Delay | Rationale |
|--------|-------|-----------|
| Starts with `/` | **0ms** | Command — bypass debounce, flush immediately |
| < 15 chars, no terminal punctuation (`.?!`) | **6000ms** | Fragment — "hey", "also", "wait" — more likely coming |
| < 15 chars, WITH terminal punctuation | **2500ms** | Short but complete — "ok?", "yes.", "stop!" |
| 15–80 chars, no terminal punctuation | **4000ms** | Medium fragment, might be followed up |
| 15–80 chars, WITH terminal punctuation | **2000ms** | Likely a complete thought |
| > 80 chars | **1500ms** | Long message — almost certainly a full turn |

The existing `debounceMs` config value becomes the fallback when adaptive is disabled. A new boolean config field `adaptiveDebounce` (default `true`) enables/disables the heuristic.

Each new message resets the timer (sliding window behavior unchanged). The adaptive delay is computed from the *last* message received — so if the user sends "hey" (6s) then "check the logs please" (2s), the effective wait is 2s from the second message.

Terminal punctuation check: last non-whitespace character of `text.trim()` is `.`, `?`, or `!`.

### 2. Queue-During-Run

**Files:** `src/channels/router.ts`, `src/home.ts`

#### Router changes

Router gains awareness of active agent runs:

- **`activeRuns: Set<string>`** — tracks keys (e.g. `telegram:12345`) with an active agent run.
- **`markRunActive(key: string)`** — adds key to `activeRuns`.
- **`markRunComplete(key: string)`** — removes key from `activeRuns`.
- **`flushQueue(key)` modification** — before calling `processMessage()`, checks if `activeRuns.has(key)`. If yes, leaves messages in the queue and returns (they'll be drained later). If no, processes normally.
- **`drainPending(key: string)`** — called after a run completes. If the queue has messages for this key, flushes them through the normal `flushQueue` path (which combines messages and calls `processMessage`). If queue is empty, no-op.

#### home.ts changes

Replace the bounce guard (lines 314–321) with queue-aware flow:

```
// Before agent run
const routerKey = `${message.channel}:${message.chatId}`;
router.markRunActive(routerKey);

try {
  const result = await agent.run(message.chatId, text, message.media);
  // ... send response ...
} finally {
  router.markRunComplete(routerKey);
  // Process any messages that arrived during the run
  await router.drainPending(routerKey);
}
```

The router needs to be accessible from the message handler. Currently `messageHandler` is a closure inside `home.ts` that already has access to `router` in scope — no wiring changes needed.

The old bounce message ("I'm still working on something") stays as a dead-code safety net. With queue-during-run active, messages arriving during a run go into the router's debounce queue. When `flushQueue` fires and sees an active run, it holds. When the run completes, `drainPending` flushes. The bounce path in `home.ts` should never fire in normal flow, but we keep it defensive.

#### Message flow

```
User sends "hey"
  → enqueue(), adaptive delay = 6000ms (short fragment)
User sends "check the logs" (3s later)
  → enqueue(), timer resets, adaptive delay = 2000ms (complete sentence)
2s silence
  → flushQueue() → no active run → processMessage("[1/2] hey\n\n[2/2] check the logs")
  → markRunActive("telegram:12345")
  → agent starts processing...

User sends "actually the ones from yesterday"
  → enqueue(), adaptive delay = 1500ms (long message)
1.5s silence
  → flushQueue() → active run detected → messages stay in queue

Agent finishes
  → markRunComplete("telegram:12345")
  → drainPending("telegram:12345") → flushQueue() → processMessage("actually the ones from yesterday")
  → markRunActive("telegram:12345")
  → agent processes the follow-up...
```

### 3. Config Changes

**File:** `instances/jerry/config.yaml` — `sessions.messageQueue`

New fields:

```yaml
messageQueue:
  mode: collect
  debounceMs: 3000            # fallback when adaptive is off
  adaptiveDebounce: true      # enable length/punctuation heuristic
  cap: 10
  overflowStrategy: summarize
  queueDuringRun: true        # buffer messages while agent is busy
```

Both new fields default to `true` if omitted — existing configs get the new behavior without edits. Setting either to `false` restores the old behavior.

**File:** `src/types.ts` — `SessionsConfig.messageQueue`

Add to the type:

```typescript
messageQueue: {
  mode: string;
  debounceMs: number;
  cap: number;
  overflowStrategy: string;
  adaptiveDebounce?: boolean;   // default true
  queueDuringRun?: boolean;     // default true
};
```

### 4. Files Changed

| File | Change |
|------|--------|
| `src/channels/router.ts` | Add `computeAdaptiveDelay()` function, modify `enqueue()` to call it, add `activeRuns` Set + `markRunActive`/`markRunComplete`/`drainPending` methods, modify `flushQueue()` to check active runs |
| `src/home.ts` | Replace bounce guard with `markRunActive` before run, `markRunComplete` + `drainPending` after run in finally block |
| `src/types.ts` | Add `adaptiveDebounce?: boolean` and `queueDuringRun?: boolean` to `SessionsConfig.messageQueue` |
| `instances/jerry/config.yaml` | Add `adaptiveDebounce: true` and `queueDuringRun: true` |

No new files. No architectural changes. All logic stays in the files that already own message routing and the agent entry point.

### 5. Edge Cases

- **User sends only commands during a run**: `/stop` goes through `commandHandler.handle()` before the `isRunning` check — already works. Commands starting with `/` get 0ms adaptive delay so they flush instantly and bypass the queue.
- **Multiple drain cycles**: If the user keeps sending messages and the agent keeps finishing, each `drainPending` triggers a new run, which triggers a new `markRunActive`. The queue correctly holds subsequent messages until that run finishes too.
- **Queue overflow during long run**: The existing `cap: 10` + `overflowStrategy: summarize` handles this — if 10+ messages arrive during a run, the summarize logic keeps first + last + count.
- **Media messages**: No special handling — they go through the same adaptive debounce. A photo with caption follows the same length heuristics on the caption text. A photo with no text gets the short-fragment delay (6s), which is reasonable since users often send a photo then describe it.
