# Telegram Message Handling — Adaptive Debounce + Queue-During-Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Telegram conversation UX — agent should wait for users to finish multi-message input, and buffer follow-up messages during active runs instead of bouncing them.

**Architecture:** Two features in existing files. (1) Adaptive debounce in `router.ts` uses message length + punctuation to pick wait times. (2) Queue-during-run in `router.ts` + `home.ts` buffers messages while agent is busy and drains them as follow-up turns when the run completes.

**Tech Stack:** TypeScript harness layer (src/), no new dependencies

**Spec:** `docs/design/STEP19-TELEGRAM-MESSAGE-HANDLING-DESIGN.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/types.ts` | Modify line 198 | Add `adaptiveDebounce` and `queueDuringRun` to `SessionsConfig.messageQueue` type |
| `src/channels/router.ts` | Modify | Add `computeAdaptiveDelay()`, modify `enqueue()`, add `activeRuns` tracking + `markRunActive`/`markRunComplete`/`drainPending` methods, modify `flushQueue()` |
| `src/home.ts` | Modify lines 306–331 | Replace bounce guard with run-tracking + drain-pending flow |
| `instances/jerry/config.yaml` | Modify lines 57–61 | Add two new config fields |

---

### Task 1: Update the type definition

**Files:**
- Modify: `src/types.ts:198`

- [ ] **Step 1: Add new optional fields to `SessionsConfig.messageQueue`**

In `src/types.ts`, line 198, change:

```typescript
messageQueue: { mode: string; debounceMs: number; cap: number; overflowStrategy: string };
```

to:

```typescript
messageQueue: {
  mode: string;
  debounceMs: number;
  cap: number;
  overflowStrategy: string;
  adaptiveDebounce?: boolean;
  queueDuringRun?: boolean;
};
```

- [ ] **Step 2: Verify the build compiles**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors (existing errors may be present)

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add adaptiveDebounce and queueDuringRun to message queue config type"
```

---

### Task 2: Add adaptive debounce to router

**Files:**
- Modify: `src/channels/router.ts:175-215`

- [ ] **Step 1: Add the `computeAdaptiveDelay` function**

Add this function at the top of the file, after the imports (after line 17, before the Types section at line 20):

```typescript
/**
 * Compute adaptive debounce delay based on message content.
 * Short fragments get longer waits (user likely typing more).
 * Long complete sentences get shorter waits (likely a full turn).
 * Commands bypass debounce entirely.
 */
function computeAdaptiveDelay(text: string, fallbackMs: number): number {
  const trimmed = text.trim();

  // Commands bypass debounce
  if (trimmed.startsWith('/')) return 0;

  const len = trimmed.length;
  const lastChar = trimmed.slice(-1);
  const hasTerminalPunctuation = lastChar === '.' || lastChar === '?' || lastChar === '!';

  if (len > 80) return 1500;

  if (len >= 15) {
    return hasTerminalPunctuation ? 2000 : 4000;
  }

  // Short message (< 15 chars)
  return hasTerminalPunctuation ? 2500 : 6000;
}
```

- [ ] **Step 2: Modify `enqueue()` to use adaptive delay**

In the `enqueue()` method, change line 213:

```typescript
    }, this.config.messageQueue.debounceMs);
```

to:

```typescript
    }, this.config.messageQueue.adaptiveDebounce !== false
        ? computeAdaptiveDelay(message.text, this.config.messageQueue.debounceMs)
        : this.config.messageQueue.debounceMs);
```

- [ ] **Step 3: Verify the build compiles**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors

- [ ] **Step 4: Commit**

```bash
git add src/channels/router.ts
git commit -m "feat: adaptive debounce based on message length and punctuation"
```

---

### Task 3: Add queue-during-run to router

**Files:**
- Modify: `src/channels/router.ts` (SessionRouter class)

- [ ] **Step 1: Add `activeRuns` set and three new public methods**

In the `SessionRouter` class, after the existing private fields (after line 95, `private deliveryReceiptsPath: string;`), add:

```typescript
  private activeRuns: Set<string> = new Set();
```

Then add these three public methods after the `stopAll()` method (after line 148), before the `handleMessage()` method:

```typescript
  /**
   * Mark a router key as having an active agent run.
   * While active, flushQueue will hold messages instead of processing.
   */
  markRunActive(key: string): void {
    this.activeRuns.add(key);
  }

  /**
   * Mark a router key's agent run as complete.
   */
  markRunComplete(key: string): void {
    this.activeRuns.delete(key);
  }

  /**
   * Drain any messages that queued during an active run.
   * Called after markRunComplete. If nothing queued, this is a no-op.
   */
  async drainPending(key: string): Promise<void> {
    const queue = this.queues.get(key);
    if (!queue || queue.length === 0) return;
    await this.flushQueue(key);
  }
```

- [ ] **Step 2: Modify `flushQueue()` to check active runs**

In the `flushQueue()` method, after the early return check (after line 223: `if (!queue || queue.length === 0) return;`), add:

```typescript
    // If an agent run is active for this key, hold messages in queue
    // They'll be drained via drainPending() when the run completes
    if (this.config.messageQueue.queueDuringRun !== false && this.activeRuns.has(key)) {
      return;
    }
```

- [ ] **Step 3: Verify the build compiles**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors

- [ ] **Step 4: Commit**

```bash
git add src/channels/router.ts
git commit -m "feat: queue-during-run — hold messages while agent is busy, drain on completion"
```

---

### Task 4: Wire queue-during-run into home.ts message handler

**Files:**
- Modify: `src/home.ts:305-331`

- [ ] **Step 1: Replace the message handler with run-tracking + drain flow**

Replace the entire message handler block (lines 305–331):

```typescript
  // ── Message handler ──
  const messageHandler = async (message: IncomingMessage): Promise<OutgoingResponse> => {
    const text = message.text.trim();

    // Slash commands — handled pre-AgentLoop, no LLM.
    // This includes /stop, which fires instantly even while the agent is busy.
    const cmdResult = await commandHandler.handle(text, message.chatId, message.channel);
    if (cmdResult) return cmdResult;

    // If the agent is already running for this chat, don't start a concurrent run
    if (agent.isRunning(message.chatId)) {
      return {
        text: "I'm still working on something. Send /stop to interrupt me.",
        channel: message.channel,
        chatId: message.chatId,
      };
    }

    // Everything else → agent loop
    const result = await agent.run(message.chatId, text, message.media);
    return {
      text: result.text,
      channel: message.channel,
      chatId: message.chatId,
      media: result.media,
    };
  };
```

with:

```typescript
  // ── Message handler ──
  const messageHandler = async (message: IncomingMessage): Promise<OutgoingResponse> => {
    const text = message.text.trim();

    // Slash commands — handled pre-AgentLoop, no LLM.
    // This includes /stop, which fires instantly even while the agent is busy.
    const cmdResult = await commandHandler.handle(text, message.chatId, message.channel);
    if (cmdResult) return cmdResult;

    // Safety net: if somehow a message reaches here while agent is busy
    // (should not happen with queueDuringRun, but defensive)
    if (agent.isRunning(message.chatId)) {
      return {
        text: "I'm still working on something. Send /stop to interrupt me.",
        channel: message.channel,
        chatId: message.chatId,
      };
    }

    // Track active run so router holds incoming messages during processing
    const routerKey = `${message.channel}:${message.chatId}`;
    router.markRunActive(routerKey);

    try {
      const result = await agent.run(message.chatId, text, message.media);
      return {
        text: result.text,
        channel: message.channel,
        chatId: message.chatId,
        media: result.media,
      };
    } finally {
      router.markRunComplete(routerKey);
      // Process any messages that arrived during the run
      await router.drainPending(routerKey);
    }
  };
```

- [ ] **Step 2: Verify the build compiles**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
git add src/home.ts
git commit -m "feat: wire queue-during-run — track active runs, drain pending on completion"
```

---

### Task 5: Update agent config

**Files:**
- Modify: `instances/jerry/config.yaml:57-61`

- [ ] **Step 1: Add new config fields**

In `instances/jerry/config.yaml`, change the `messageQueue` block (lines 57–61):

```yaml
  messageQueue:
    mode: collect
    debounceMs: 3000
    cap: 10
    overflowStrategy: summarize
```

to:

```yaml
  messageQueue:
    mode: collect
    debounceMs: 3000
    adaptiveDebounce: true
    cap: 10
    overflowStrategy: summarize
    queueDuringRun: true
```

- [ ] **Step 2: Commit**

```bash
git add instances/jerry/config.yaml
git commit -m "feat: enable adaptive debounce and queue-during-run in jerry config"
```

---

### Task 6: Build, deploy, and verify

- [ ] **Step 1: Full build**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx tsc`
Expected: Clean compile to `dist/`

- [ ] **Step 2: Restart the harness process**

Run: `pm2 restart home23-jerry-harness`
Expected: Process restarts, logs show normal startup banner

- [ ] **Step 3: Verify adaptive debounce in logs**

Send a short message ("hey") via Telegram, then immediately send a second message ("check the logs"). Watch the PM2 logs:

Run: `pm2 logs home23-jerry-harness --lines 30`

Expected: Both messages should appear as a single combined message in the routing log, like:
```
[router] Queue flush... 
[telegram] → Routing message from jtr: "[1/2] hey\n\n[2/2] check the logs"
```

The key signal is that both messages are combined — the adaptive debounce waited long enough for the second message.

- [ ] **Step 4: Verify queue-during-run**

While the agent is processing a response, send another message. Watch the logs:

Expected: No "I'm still working on something" bounce message. Instead, after the agent finishes the first response, the follow-up message should be processed as a second turn.

- [ ] **Step 5: Verify commands bypass debounce**

While the agent is processing, send `/stop`. It should fire instantly and abort the run.

- [ ] **Step 6: Commit the design doc**

```bash
git add docs/design/STEP19-TELEGRAM-MESSAGE-HANDLING-DESIGN.md docs/design/STEP19-TELEGRAM-MESSAGE-HANDLING-PLAN.md
git commit -m "docs: Step 19 — adaptive debounce + queue-during-run design and plan"
```
