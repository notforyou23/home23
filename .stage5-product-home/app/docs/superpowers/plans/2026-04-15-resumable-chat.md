# Resumable Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/home23/chat` survive iOS Safari backgrounding — when the browser suspends the tab, the agent keeps working server-side and the UI catches up on return with zero lost events.

**Architecture:** Turn-based protocol layered onto the existing conversation JSONL. Each assistant reply is a `turn_id` with numbered events appended as the agent runs. A new POST endpoint detaches the agent run from the HTTP response (returns `turn_id` immediately). A new GET SSE endpoint replays events from a client-supplied `cursor` and then tails live events. Client reconnects on `visibilitychange:visible` with its last `cursor` — missed events are replayed, then live streaming resumes. Pending turns on page load auto-resume.

**Tech Stack:** TypeScript (src/, Node 20), Express (bridge per-agent on port 50x4), vanilla JS dashboard (engine/src/dashboard/home23-chat.js), JSONL append-only persistence (existing `HistoryStore`). No new dependencies.

**Codebase context engineers need:**
- `src/agent/history.ts` — `HistoryStore` class. Appends JSONL lines per `chatId` to `instances/<agent>/conversations/<chatId>.jsonl`. Already tolerates heterogeneous record types (checks `'type' in r`).
- `src/agent/loop.ts` — `AgentLoop.run(chatId, userText, media?, onEvent?)`. The `onEvent` callback is called ~20 sites (`response_chunk`, `thinking`, `tool_start`, `tool_result`, `media`, etc.). Final assistant messages are persisted via `this.history.append(chatId, turnMessages)`.
- `src/routes/evobrew-bridge.ts` — existing SSE-on-POST chat endpoint. `createEvobrewChatHandler` awaits `agent.run` inside the HTTP handler; streams `onEvent` directly via `writeSse`. Connection drop = lost events.
- `engine/src/dashboard/home23-chat.js` — client. Uses `fetch` with streaming response reader for SSE. `chatConversationId` is the chat key.
- No unit test runner in this repo. Verification = `npm run build` (tsc) + PM2 restart + manual smoke test in browser (`/home23/chat`) + tailing `pm2 logs home23-<agent>-harness`.
- PM2 process naming: `home23-<agent>-harness` is the bridge/TS process; `home23-<agent>` is the engine/cognitive loop; `home23-<agent>-dash` is the dashboard HTTP.

---

## File Structure

**Create:**
- `src/chat/turn-store.ts` — turn lifecycle: append envelopes/events with `seq`, scan for pending/orphaned, list events by turn_id + cursor.
- `src/chat/turn-bus.ts` — in-memory pub/sub keyed by `chatId:turn_id`. Subscribe, emit, close.
- `src/chat/turn-types.ts` — `TurnEnvelope`, `TurnEvent`, record type guards.
- `src/routes/chat-turn.ts` — new HTTP handlers: `POST /api/chat/turn`, `GET /api/chat/stream`, `POST /api/chat/stop`.

**Modify:**
- `src/agent/history.ts` — add `appendRecord` (single record) + `loadRaw` (returns all records including turn/event types) + update `load()` filter to skip new types so existing callers don't break.
- `src/agent/loop.ts` — inside `run()`: write `turn:pending` envelope at start, wrap `onEvent` to persist `event` records with `seq`, write `turn:complete|error|stopped` envelope at end. Add optional `turnId` parameter.
- `src/agent/types.ts` — extend `AgentEventCallback` call signature is unchanged, but add an internal `wrapOnEvent` helper comment.
- `src/home.ts` — register the new bridge routes alongside existing `/api/chat`.
- `engine/src/dashboard/home23-chat.js` — replace `postMessage` flow: POST `/api/chat/turn` → open GET `/api/chat/stream` → `visibilitychange` reconnect → on-load pending-turn resume.
- `engine/src/dashboard/home23-chat.css` — add "reconnecting" indicator style (subtle).

**Leave untouched:**
- Existing `POST /api/chat` in `evobrew-bridge.ts` — evobrew still calls it, don't break that path.
- Telegram adapter — runs its own agent.run calls; unaffected.

---

## Task 1: Turn type definitions

**Files:**
- Create: `src/chat/turn-types.ts`

- [ ] **Step 1: Write the types file**

```typescript
/**
 * Turn & event record types for resumable chat.
 *
 * Both types live in the conversation JSONL alongside StoredMessage and session_boundary.
 * HistoryStore.load() filters these out so the agent's message history stays clean;
 * the turn endpoints read them via HistoryStore.loadRaw().
 */

export type TurnStatus = 'pending' | 'complete' | 'error' | 'stopped' | 'orphaned';

export interface TurnEnvelope {
  type: 'turn';
  turn_id: string;
  chat_id: string;
  status: TurnStatus;
  role: 'assistant';
  started_at: string;
  ended_at?: string;
  model?: string;
  stop_reason?: string;
  error?: string;
  /** Max seq of any event belonging to this turn. Written on status-end records. */
  last_seq?: number;
}

export interface TurnEvent {
  type: 'event';
  turn_id: string;
  seq: number;
  ts: string;
  kind: 'thinking' | 'tool_start' | 'tool_result' | 'response_chunk' | 'media' | 'subagent_result' | 'cache';
  data: Record<string, unknown>;
}

export type TurnRecord = TurnEnvelope | TurnEvent;

export function isTurnEnvelope(r: unknown): r is TurnEnvelope {
  return typeof r === 'object' && r !== null && (r as { type?: string }).type === 'turn';
}

export function isTurnEvent(r: unknown): r is TurnEvent {
  return typeof r === 'object' && r !== null && (r as { type?: string }).type === 'event';
}

export function isTurnRecord(r: unknown): r is TurnRecord {
  return isTurnEnvelope(r) || isTurnEvent(r);
}

/** ULID-lite: time-ordered, URL-safe, no deps. */
export function newTurnId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `t_${ts}_${rand}`;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: exits 0, no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/chat/turn-types.ts
git commit -m "feat(chat): turn/event record types for resumable chat"
```

---

## Task 2: Extend HistoryStore with raw-read and single-record append

**Files:**
- Modify: `src/agent/history.ts`

- [ ] **Step 1: Add `appendRecord` and `loadRaw` methods**

Open `src/agent/history.ts`. Find the existing `load(chatId)` method (around line 30-70). Update the `load` return so it filters out turn records (so callers like the agent loop's message-building logic don't see them as messages). Add two new methods below `append`:

```typescript
/** Load ALL records including turn envelopes and events. Use for turn endpoints, not message-building. */
loadRaw(chatId: string): unknown[] {
  const filePath = this.filePath(chatId);
  if (!existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    const records: unknown[] = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch {
        // skip bad line
      }
    }
    return records;
  } catch {
    return [];
  }
}

/** Append a single arbitrary record as JSONL. No transformation. */
appendRecord(chatId: string, record: unknown): void {
  const filePath = this.filePath(chatId);
  // Ensure directory exists (mirrors filePath() side-effect in other methods)
  const line = JSON.stringify(record) + '\n';
  appendFileSync(filePath, line);
}
```

Then update `load(chatId)` — find the loop that parses JSONL and returns `records`. Add a filter that drops turn/event records (they're not message history):

```typescript
// Inside the parse loop, after JSON.parse(line):
const rec = JSON.parse(line);
if (rec && typeof rec === 'object' && (rec.type === 'turn' || rec.type === 'event')) {
  continue; // not part of message history
}
records.push(rec);
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 3: Smoke test existing chat still works**

Run:
```bash
pm2 restart home23-<your-agent>-harness
pm2 logs home23-<your-agent>-harness --lines 20
```

Open `/home23/chat`, send "hi". Expected: normal reply. Nothing new persisted yet.

- [ ] **Step 4: Commit**

```bash
git add src/agent/history.ts
git commit -m "feat(history): add loadRaw + appendRecord for turn records"
```

---

## Task 3: TurnStore — lifecycle helpers over HistoryStore

**Files:**
- Create: `src/chat/turn-store.ts`

- [ ] **Step 1: Write the TurnStore**

```typescript
import type { HistoryStore } from '../agent/history.js';
import {
  type TurnEnvelope,
  type TurnEvent,
  type TurnStatus,
  isTurnEnvelope,
  isTurnEvent,
} from './turn-types.js';

/**
 * Turn lifecycle on top of the conversation JSONL.
 * All reads scan the file — fine until conversations get huge; defer an index sidecar until it hurts.
 */
export class TurnStore {
  constructor(private history: HistoryStore) {}

  writeStart(chatId: string, turn_id: string, model?: string): TurnEnvelope {
    const env: TurnEnvelope = {
      type: 'turn',
      turn_id,
      chat_id: chatId,
      status: 'pending',
      role: 'assistant',
      started_at: new Date().toISOString(),
      model,
    };
    this.history.appendRecord(chatId, env);
    return env;
  }

  writeEnd(chatId: string, turn_id: string, status: Exclude<TurnStatus, 'pending'>, extras: { last_seq: number; stop_reason?: string; error?: string }): TurnEnvelope {
    const env: TurnEnvelope = {
      type: 'turn',
      turn_id,
      chat_id: chatId,
      status,
      role: 'assistant',
      started_at: '', // envelope records the END event — started_at lives on the start record
      ended_at: new Date().toISOString(),
      last_seq: extras.last_seq,
      stop_reason: extras.stop_reason,
      error: extras.error,
    };
    this.history.appendRecord(chatId, env);
    return env;
  }

  writeEvent(chatId: string, event: TurnEvent): void {
    this.history.appendRecord(chatId, event);
  }

  /** Return all events for a turn with seq > cursor, in order. */
  eventsSince(chatId: string, turn_id: string, cursor: number): TurnEvent[] {
    const all = this.history.loadRaw(chatId);
    const events: TurnEvent[] = [];
    for (const r of all) {
      if (isTurnEvent(r) && r.turn_id === turn_id && r.seq > cursor) events.push(r);
    }
    return events;
  }

  /** Find the final envelope for a turn, if any. */
  finalEnvelope(chatId: string, turn_id: string): TurnEnvelope | null {
    const all = this.history.loadRaw(chatId);
    let last: TurnEnvelope | null = null;
    for (const r of all) {
      if (isTurnEnvelope(r) && r.turn_id === turn_id && r.status !== 'pending') last = r;
    }
    return last;
  }

  /** List all turns in a chat, last-record-wins per turn_id. */
  listTurns(chatId: string): TurnEnvelope[] {
    const all = this.history.loadRaw(chatId);
    const byId = new Map<string, TurnEnvelope>();
    for (const r of all) {
      if (isTurnEnvelope(r)) byId.set(r.turn_id, r);
    }
    return [...byId.values()];
  }

  /** Any turn whose most recent envelope is still pending. */
  pendingTurns(chatId: string): TurnEnvelope[] {
    return this.listTurns(chatId).filter(t => t.status === 'pending');
  }

  /** Mark any pending turn older than maxAgeMs as orphaned. Returns the turn_ids marked. */
  sweepOrphans(chatId: string, maxAgeMs: number): string[] {
    const now = Date.now();
    const marked: string[] = [];
    for (const t of this.pendingTurns(chatId)) {
      const age = now - new Date(t.started_at).getTime();
      if (age >= maxAgeMs) {
        // Find the last event for this turn to get last_seq
        const events = this.eventsSince(chatId, t.turn_id, -1);
        const last_seq = events.length ? events[events.length - 1]!.seq : 0;
        this.writeEnd(chatId, t.turn_id, 'orphaned', { last_seq, error: 'process restarted or turn exceeded max age' });
        marked.push(t.turn_id);
      }
    }
    return marked;
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/chat/turn-store.ts
git commit -m "feat(chat): TurnStore for turn lifecycle on JSONL"
```

---

## Task 4: TurnBus — in-memory pub/sub for live subscribers

**Files:**
- Create: `src/chat/turn-bus.ts`

- [ ] **Step 1: Write the bus**

```typescript
import type { TurnEnvelope, TurnEvent } from './turn-types.js';

type Subscriber = (record: TurnEvent | TurnEnvelope) => void;

/**
 * Per-turn pub/sub. Subscribers get live events as the agent emits them.
 * A closed turn flushes all subscribers and deletes the bus entry.
 */
export class TurnBus {
  private channels = new Map<string, Set<Subscriber>>();

  private key(chatId: string, turnId: string): string {
    return `${chatId}::${turnId}`;
  }

  subscribe(chatId: string, turnId: string, cb: Subscriber): () => void {
    const k = this.key(chatId, turnId);
    let set = this.channels.get(k);
    if (!set) {
      set = new Set();
      this.channels.set(k, set);
    }
    set.add(cb);
    return () => {
      const s = this.channels.get(k);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) this.channels.delete(k);
    };
  }

  emit(chatId: string, turnId: string, record: TurnEvent | TurnEnvelope): void {
    const k = this.key(chatId, turnId);
    const set = this.channels.get(k);
    if (!set) return;
    for (const cb of set) {
      try { cb(record); } catch { /* swallow subscriber errors */ }
    }
  }

  /** Fired after the final envelope is emitted. Drops all subscribers. */
  close(chatId: string, turnId: string): void {
    this.channels.delete(this.key(chatId, turnId));
  }

  hasSubscribers(chatId: string, turnId: string): boolean {
    const s = this.channels.get(this.key(chatId, turnId));
    return !!s && s.size > 0;
  }
}

/** Singleton — one bus per process. */
export const turnBus = new TurnBus();
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/chat/turn-bus.ts
git commit -m "feat(chat): TurnBus in-memory pub/sub for live events"
```

---

## Task 5: Instrument AgentLoop to write turn envelopes + seq'd events

**Files:**
- Modify: `src/agent/loop.ts`

- [ ] **Step 1: Add TurnStore + TurnBus imports and a `runWithTurn` wrapper**

Open `src/agent/loop.ts`. At the top imports, add:

```typescript
import { TurnStore } from '../chat/turn-store.js';
import { turnBus } from '../chat/turn-bus.js';
import { newTurnId, type TurnEvent } from '../chat/turn-types.js';
```

Find the `AgentLoop` class constructor (search for `constructor(`). Find where `this.history` is assigned. Right after it, add:

```typescript
this.turnStore = new TurnStore(this.history);
```

And at the top of the class, add the field:

```typescript
private turnStore: TurnStore;
```

- [ ] **Step 2: Add a public `runWithTurn` method**

Find the existing `async run(chatId, userText, userMedia?, onEvent?): Promise<AgentResponse>` method (around line 369). Add a new public method **above** it:

```typescript
/**
 * Run a turn with lifecycle tracking. Writes a `pending` envelope, persists every
 * onEvent as a seq'd `event` record, and writes a final envelope on completion/error.
 * Returns the turn_id immediately — the agent run is awaited by the caller but can
 * be detached (caller fires-and-forgets the returned promise).
 */
async runWithTurn(
  chatId: string,
  userText: string,
  opts: { turnId?: string; media?: import('../types.js').MediaAttachment[]; onEvent?: import('./types.js').AgentEventCallback } = {},
): Promise<{ turnId: string; response: Promise<import('./types.js').AgentResponse> }> {
  const turnId = opts.turnId ?? newTurnId();
  const model = this.getModel?.() ?? undefined;
  this.turnStore.writeStart(chatId, turnId, model);

  let seq = 0;
  const persistAndFanOut = (event: import('./types.js').AgentEvent): void => {
    seq++;
    const record: TurnEvent = {
      type: 'event',
      turn_id: turnId,
      seq,
      ts: new Date().toISOString(),
      kind: event.type,
      data: { ...event } as Record<string, unknown>,
    };
    this.turnStore.writeEvent(chatId, record);
    turnBus.emit(chatId, turnId, record);
    if (opts.onEvent) {
      try { opts.onEvent(event); } catch { /* caller errors don't kill the run */ }
    }
  };

  const response = (async () => {
    try {
      const result = await this.run(chatId, userText, opts.media, persistAndFanOut);
      const endEnv = this.turnStore.writeEnd(chatId, turnId, 'complete', { last_seq: seq, stop_reason: 'end_turn' });
      turnBus.emit(chatId, turnId, endEnv);
      turnBus.close(chatId, turnId);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isAbort = msg.includes('aborted') || msg.includes('AbortError');
      const status = isAbort ? 'stopped' : 'error';
      const endEnv = this.turnStore.writeEnd(chatId, turnId, status, { last_seq: seq, error: msg });
      turnBus.emit(chatId, turnId, endEnv);
      turnBus.close(chatId, turnId);
      throw err;
    }
  })();

  return { turnId, response };
}
```

Note: this wraps the existing `run()` — no changes to the ~20 onEvent call sites.

- [ ] **Step 3: Typecheck**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add src/agent/loop.ts
git commit -m "feat(loop): runWithTurn — persistent turn envelopes + seq'd events"
```

---

## Task 6: HTTP routes — POST /turn, GET /stream, POST /stop-turn

**Files:**
- Create: `src/routes/chat-turn.ts`

- [ ] **Step 1: Write the route handlers**

```typescript
import type { Request, Response } from 'express';
import type { AgentLoop } from '../agent/loop.js';
import type { HistoryStore } from '../agent/history.js';
import { TurnStore } from '../chat/turn-store.js';
import { turnBus } from '../chat/turn-bus.js';
import { isTurnEnvelope, isTurnEvent } from '../chat/turn-types.js';

export interface ChatTurnConfig {
  agentName: string;
  agent: AgentLoop;
  history: HistoryStore;
  token?: string;
}

function checkAuth(req: Request, res: Response, token?: string): boolean {
  if (!token) return true;
  const h = req.headers.authorization;
  if (!h || h !== `Bearer ${token}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

/** POST /api/chat/turn — start a turn, return turn_id immediately. Agent runs detached. */
export function createTurnStartHandler(config: ChatTurnConfig) {
  return async (req: Request, res: Response): Promise<void> => {
    if (!checkAuth(req, res, config.token)) return;

    const { chatId, message } = req.body ?? {};
    if (!chatId || typeof chatId !== 'string') {
      res.status(400).json({ error: 'chatId required' }); return;
    }
    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'message required' }); return;
    }

    // Reject concurrent runs for same chatId — surface the already-running turn
    if (config.agent.isRunning(chatId)) {
      const store = new TurnStore(config.history);
      const pending = store.pendingTurns(chatId);
      const existing = pending[pending.length - 1];
      if (existing) {
        res.status(409).json({ error: 'turn in progress', turn_id: existing.turn_id });
        return;
      }
    }

    try {
      const { turnId, response } = await config.agent.runWithTurn(chatId, message);

      // Detach — don't await. Swallow errors (already persisted to JSONL as error envelope).
      response.catch(err => {
        console.error(`[chat-turn] ${config.agentName} ${turnId} error:`, err?.message || err);
      });

      res.json({ turn_id: turnId });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error(`[chat-turn] ${config.agentName} start error:`, m);
      res.status(500).json({ error: m });
    }
  };
}

/** GET /api/chat/stream?chatId=X&turn_id=Y&cursor=N — SSE replay + live tail. */
export function createTurnStreamHandler(config: ChatTurnConfig) {
  return async (req: Request, res: Response): Promise<void> => {
    if (!checkAuth(req, res, config.token)) return;

    const chatId = String(req.query.chatId || '');
    const turnId = String(req.query.turn_id || '');
    const cursor = Number(req.query.cursor ?? -1);

    if (!chatId || !turnId) {
      res.status(400).json({ error: 'chatId and turn_id required' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const write = (data: unknown): void => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const store = new TurnStore(config.history);

    // Phase 1: catch-up from JSONL
    const catchup = store.eventsSince(chatId, turnId, cursor);
    let lastSeq = cursor;
    for (const ev of catchup) {
      write(ev);
      lastSeq = ev.seq;
    }

    // Check if turn already finished before we subscribe
    const finalEnv = store.finalEnvelope(chatId, turnId);
    if (finalEnv) {
      write(finalEnv);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Phase 2: subscribe for live events (dedup against what we just replayed)
    let finished = false;
    const unsubscribe = turnBus.subscribe(chatId, turnId, (record) => {
      if (finished) return;
      if (isTurnEvent(record) && record.seq <= lastSeq) return; // already sent during catch-up
      write(record);
      if (isTurnEvent(record)) lastSeq = record.seq;
      if (isTurnEnvelope(record) && record.status !== 'pending') {
        finished = true;
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });

    // Client disconnect
    req.on('close', () => {
      finished = true;
      unsubscribe();
    });

    // Heartbeat to keep connection alive through proxies (every 15s)
    const heartbeat = setInterval(() => {
      if (finished) { clearInterval(heartbeat); return; }
      res.write(': heartbeat\n\n');
    }, 15000);

    res.on('close', () => clearInterval(heartbeat));
  };
}

/** POST /api/chat/stop-turn {chatId, turn_id} — stop the active run. */
export function createTurnStopHandler(config: ChatTurnConfig) {
  return (req: Request, res: Response): void => {
    if (!checkAuth(req, res, config.token)) return;

    const chatId = req.body?.chatId;
    if (!chatId) { res.status(400).json({ error: 'chatId required' }); return; }

    const result = config.agent.stop(chatId);
    res.json(result);
  };
}

/** GET /api/chat/pending?chatId=X — list pending turns (for page-load resume). */
export function createPendingTurnsHandler(config: ChatTurnConfig) {
  return (req: Request, res: Response): void => {
    if (!checkAuth(req, res, config.token)) return;

    const chatId = String(req.query.chatId || '');
    if (!chatId) { res.status(400).json({ error: 'chatId required' }); return; }

    const store = new TurnStore(config.history);
    res.json({ pending: store.pendingTurns(chatId) });
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/routes/chat-turn.ts
git commit -m "feat(routes): chat-turn endpoints — POST /turn, GET /stream, pending, stop"
```

---

## Task 7: Wire routes into the bridge (src/home.ts)

**Files:**
- Modify: `src/home.ts`

- [ ] **Step 1: Find where evobrew-bridge routes are registered**

Run:
```bash
grep -n "evobrew-bridge\|createEvobrewChatHandler\|/api/chat" src/home.ts
```

Expected: lines showing where `app.post('/api/chat', ...)` or equivalent is wired. Note the file and import pattern.

- [ ] **Step 2: Register the new routes alongside existing ones**

In `src/home.ts`, near the existing `/api/chat` wiring, add:

```typescript
import {
  createTurnStartHandler,
  createTurnStreamHandler,
  createTurnStopHandler,
  createPendingTurnsHandler,
} from './routes/chat-turn.js';

// ... where the existing /api/chat route is registered, add:
const chatTurnConfig = {
  agentName,        // existing variable
  agent: agentLoop, // existing variable — the AgentLoop instance
  history,          // existing HistoryStore instance
  token,            // existing bearer token (may be undefined)
};

app.post('/api/chat/turn', createTurnStartHandler(chatTurnConfig));
app.get('/api/chat/stream', createTurnStreamHandler(chatTurnConfig));
app.post('/api/chat/stop-turn', createTurnStopHandler(chatTurnConfig));
app.get('/api/chat/pending', createPendingTurnsHandler(chatTurnConfig));
```

Adapt variable names if the real ones differ — keep the existing config's shape.

- [ ] **Step 3: Add orphan sweep on startup**

In the same file, after all routes are registered but before `app.listen`, add:

```typescript
// Orphan sweep: any turn still 'pending' from a prior process is dead.
// We don't know all chatIds here without scanning the conversations dir; do it lazily per-request instead.
// (Page-load /api/chat/pending will naturally surface orphans; sweep happens there.)
```

Actually — sweep **per chatId on first pending-list request**. Update `createPendingTurnsHandler` in `src/routes/chat-turn.ts`:

```typescript
// Before returning, sweep orphans older than 10 minutes for this chatId
store.sweepOrphans(chatId, 10 * 60 * 1000);
res.json({ pending: store.pendingTurns(chatId) });
```

(This is the second edit to that file — commit together with the wiring.)

- [ ] **Step 4: Typecheck + restart + smoke test**

```bash
npm run build
pm2 restart home23-<your-agent>-harness
pm2 logs home23-<your-agent>-harness --lines 30
```

In another terminal:
```bash
curl -s -X POST http://localhost:<bridgePort>/api/chat/turn \
  -H 'Content-Type: application/json' \
  -d '{"chatId":"smoke-test-turn","message":"hi"}'
```

Expected: `{"turn_id":"t_..."}` returned within ~100ms (not blocked on agent response).

Then:
```bash
curl -s "http://localhost:<bridgePort>/api/chat/stream?chatId=smoke-test-turn&turn_id=<turn_id>&cursor=-1"
```

Expected: SSE events streaming, ending with a `complete` envelope and `[DONE]`.

Check the JSONL:
```bash
tail -20 instances/<agent>/conversations/smoke-test-turn.jsonl
```

Expected: `{"type":"turn",...,"status":"pending",...}` then `{"type":"event",...,"seq":1,...}` ... then `{"type":"turn",...,"status":"complete","last_seq":N,...}`.

- [ ] **Step 5: Commit**

```bash
git add src/home.ts src/routes/chat-turn.ts
git commit -m "feat(bridge): register resumable chat routes + lazy orphan sweep"
```

---

## Task 8: Dashboard client — switch to turn protocol

**Files:**
- Modify: `engine/src/dashboard/home23-chat.js`

- [ ] **Step 1: Add turn state + stream helper**

Open `engine/src/dashboard/home23-chat.js`. Near the top where other `let` state lives (around line 16-17), add:

```javascript
let activeTurnId = null;
let activeTurnCursor = -1;
let activeEventSource = null;
let activeChatId = null; // chatId used for the active turn (conversation id)
```

Below existing helpers (find a reasonable spot — near `postMessage` or wherever the chat-send logic lives), add the core stream helper:

```javascript
/** Open an SSE stream for a turn, handling catch-up + live events. */
function openTurnStream({ bridgePort, chatId, turnId, cursor, onEvent, onEnd }) {
  const url = `http://${window.location.hostname}:${bridgePort}/api/chat/stream?chatId=${encodeURIComponent(chatId)}&turn_id=${encodeURIComponent(turnId)}&cursor=${cursor}`;
  const es = new EventSource(url);

  es.onmessage = (msg) => {
    if (msg.data === '[DONE]') {
      es.close();
      if (onEnd) onEnd(null);
      return;
    }
    let record;
    try { record = JSON.parse(msg.data); } catch { return; }
    if (record.type === 'event') {
      activeTurnCursor = record.seq;
      if (onEvent) onEvent(record);
    } else if (record.type === 'turn' && record.status !== 'pending') {
      es.close();
      if (onEnd) onEnd(record);
    }
  };

  es.onerror = () => {
    // Browser will auto-reconnect unless we close. We handle reconnect explicitly
    // in visibilitychange below, so close here to prevent duplicate streams.
    es.close();
  };

  return es;
}
```

- [ ] **Step 2: Replace `postMessage` flow**

Find the existing message-send function (likely `postMessage` or similar — it does `fetch(bridgeUrl, {method:'POST', body: {messages:...}})`). Replace its core with:

```javascript
async function sendTurn(userText) {
  if (!chatAgent?.bridgePort || !chatConversationId) return;
  const bridgePort = chatAgent.bridgePort;
  activeChatId = chatConversationId;

  // Start the turn
  let turnId;
  try {
    const res = await fetch(`http://${window.location.hostname}:${bridgePort}/api/chat/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: activeChatId, message: userText }),
    });
    if (res.status === 409) {
      const data = await res.json();
      turnId = data.turn_id;
      console.warn('[chat] resuming in-flight turn', turnId);
    } else if (!res.ok) {
      throw new Error(`turn start failed: ${res.status}`);
    } else {
      const data = await res.json();
      turnId = data.turn_id;
    }
  } catch (err) {
    console.error('[chat] turn start failed', err);
    renderError('Failed to send — ' + err.message);
    return;
  }

  activeTurnId = turnId;
  activeTurnCursor = -1;

  // Stream events
  activeEventSource = openTurnStream({
    bridgePort,
    chatId: activeChatId,
    turnId,
    cursor: activeTurnCursor,
    onEvent: (ev) => renderEvent(ev),       // existing event-rendering function
    onEnd: (finalEnv) => {
      activeEventSource = null;
      activeTurnId = null;
      if (finalEnv && finalEnv.status === 'error') renderError(finalEnv.error || 'Error');
      if (finalEnv && finalEnv.status === 'stopped') renderInfo('Stopped');
      finalizeChat();                        // existing wrap-up hook
    },
  });
}
```

`renderEvent(ev)` should call existing render logic keyed by `ev.kind` (which is the same as the old `event.type`) and `ev.data` (the original event payload). If the existing code was switching on `event.type` directly, add a shim:

```javascript
function renderEvent(turnEvent) {
  const legacy = { type: turnEvent.kind, ...turnEvent.data };
  renderAgentEvent(legacy); // whatever the existing dispatch function is named
}
```

Rename `postMessage` callers to `sendTurn` or wrap: whichever is fewer edits.

- [ ] **Step 3: Reconnect on visibilitychange**

At the bottom of the file (or near init), add:

```javascript
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!activeTurnId || !activeChatId || activeEventSource) return; // nothing to resume
  if (!chatAgent?.bridgePort) return;

  console.log('[chat] tab visible — resuming stream from cursor', activeTurnCursor);
  activeEventSource = openTurnStream({
    bridgePort: chatAgent.bridgePort,
    chatId: activeChatId,
    turnId: activeTurnId,
    cursor: activeTurnCursor,
    onEvent: (ev) => renderEvent(ev),
    onEnd: (finalEnv) => {
      activeEventSource = null;
      activeTurnId = null;
      if (finalEnv && finalEnv.status === 'error') renderError(finalEnv.error || 'Error');
      finalizeChat();
    },
  });
});
```

- [ ] **Step 4: On-load pending-turn resume**

Find where `loadHistory(agentName, conversationId)` finishes (around line 245-275). Right after it, call:

```javascript
async function resumePendingTurns() {
  if (!chatAgent?.bridgePort || !chatConversationId) return;
  try {
    const res = await fetch(`http://${window.location.hostname}:${chatAgent.bridgePort}/api/chat/pending?chatId=${encodeURIComponent(chatConversationId)}`);
    if (!res.ok) return;
    const data = await res.json();
    const pending = data.pending || [];
    if (pending.length === 0) return;

    // Resume the most recent pending turn
    const turn = pending[pending.length - 1];
    activeTurnId = turn.turn_id;
    activeChatId = chatConversationId;
    activeTurnCursor = -1; // replay everything — user hasn't seen it

    renderInfo('Resuming previous turn…');
    activeEventSource = openTurnStream({
      bridgePort: chatAgent.bridgePort,
      chatId: activeChatId,
      turnId: turn.turn_id,
      cursor: -1,
      onEvent: (ev) => renderEvent(ev),
      onEnd: (finalEnv) => {
        activeEventSource = null;
        activeTurnId = null;
        if (finalEnv?.status === 'orphaned') renderInfo('Previous turn was interrupted — try resending.');
        finalizeChat();
      },
    });
  } catch (err) {
    console.warn('[chat] pending-turn resume failed', err);
  }
}
```

Call `resumePendingTurns()` at the end of the chat init flow (after `loadHistory` completes).

- [ ] **Step 5: Typecheck (dashboard is vanilla JS; no build) + restart + test**

```bash
pm2 restart home23-<agent>-dash home23-<agent>-harness
```

Browser:
1. Open `/home23/chat` in Safari.
2. Send a message. Confirm normal streaming.
3. Send another, immediately backgrounded tab (switch apps) for ~15s while reply streams.
4. Return to Safari. Expected: stream catches up + finishes. Zero missed events.
5. Send another, immediately close + reopen the tab mid-reply. Expected: reopen triggers pending-turn resume; stream replays and completes.
6. Stop button: send a long request, hit stop. Expected: `stopped` envelope arrives, UI shows "Stopped".

- [ ] **Step 6: Commit**

```bash
git add engine/src/dashboard/home23-chat.js engine/src/dashboard/home23-chat.css
git commit -m "feat(dashboard): resumable chat — turn protocol + reconnect on visibilitychange"
```

---

## Task 9: Subtle "reconnecting" indicator

**Files:**
- Modify: `engine/src/dashboard/home23-chat.css`, `engine/src/dashboard/home23-chat.js`

- [ ] **Step 1: Add CSS**

Append to `engine/src/dashboard/home23-chat.css`:

```css
.h23-chat-reconnecting {
  position: absolute;
  top: 4px;
  right: 8px;
  font-size: 11px;
  color: var(--text-muted);
  opacity: 0.7;
  font-style: italic;
}
```

- [ ] **Step 2: Toggle the indicator on reconnect**

In the `visibilitychange` handler (from Task 8 Step 3), wrap the stream open:

```javascript
const indicator = document.createElement('div');
indicator.className = 'h23-chat-reconnecting';
indicator.textContent = 'reconnecting…';
const container = document.getElementById('h23-chat-messages') || document.body;
container.appendChild(indicator);

activeEventSource = openTurnStream({
  // ... as before, but wrap onEvent/onEnd to remove the indicator once we see the first event or the end:
  onEvent: (ev) => { indicator.remove(); renderEvent(ev); },
  onEnd: (finalEnv) => {
    indicator.remove();
    activeEventSource = null;
    activeTurnId = null;
    finalizeChat();
  },
});
```

Use the same pattern in `resumePendingTurns`.

- [ ] **Step 3: Smoke test**

Restart dashboard:
```bash
pm2 restart home23-<agent>-dash
```

Reproduce the backgrounding scenario. Expected: "reconnecting…" flashes briefly on return, then disappears as events flow.

- [ ] **Step 4: Commit**

```bash
git add engine/src/dashboard/home23-chat.css engine/src/dashboard/home23-chat.js
git commit -m "feat(dashboard): reconnecting indicator during stream resume"
```

---

## Task 10: Flush cadence for token-heavy streams (optimization)

Only do this if Task 8 smoke testing showed noticeable disk-write pressure (e.g. `iotop` shows heavy writes during streaming, or chat feels laggy during long replies).

**Files:**
- Modify: `src/agent/loop.ts` (the `persistAndFanOut` function inside `runWithTurn`)

- [ ] **Step 1: Add token batching**

Replace the body of `persistAndFanOut` with:

```typescript
const TOKEN_BATCH_SIZE = 8;
const TOKEN_BATCH_INTERVAL_MS = 100;
let tokenBuffer: string[] = [];
let tokenBufferTimer: NodeJS.Timeout | null = null;

const flushTokenBuffer = (): void => {
  if (tokenBuffer.length === 0) return;
  seq++;
  const record: TurnEvent = {
    type: 'event',
    turn_id: turnId,
    seq,
    ts: new Date().toISOString(),
    kind: 'response_chunk',
    data: { type: 'response_chunk', chunk: tokenBuffer.join('') },
  };
  this.turnStore.writeEvent(chatId, record);
  turnBus.emit(chatId, turnId, record);
  tokenBuffer = [];
  if (tokenBufferTimer) { clearTimeout(tokenBufferTimer); tokenBufferTimer = null; }
};

const persistAndFanOut = (event: import('./types.js').AgentEvent): void => {
  // Still fire the caller's onEvent live (unbuffered) so UI feels snappy
  if (opts.onEvent) { try { opts.onEvent(event); } catch {} }

  // Batch response_chunk tokens; persist everything else immediately
  if (event.type === 'response_chunk') {
    tokenBuffer.push(event.chunk);
    // Also fan out to bus immediately (not batched) so live subscribers feel snappy
    seq++;
    const liveOnly: TurnEvent = {
      type: 'event',
      turn_id: turnId,
      seq,
      ts: new Date().toISOString(),
      kind: 'response_chunk',
      data: { type: 'response_chunk', chunk: event.chunk },
    };
    turnBus.emit(chatId, turnId, liveOnly);
    // Decrement and hold for disk — seq is only "committed" when the batch flushes
    seq--;

    if (tokenBuffer.length >= TOKEN_BATCH_SIZE) flushTokenBuffer();
    else if (!tokenBufferTimer) tokenBufferTimer = setTimeout(flushTokenBuffer, TOKEN_BATCH_INTERVAL_MS);
    return;
  }

  // Non-token event: flush any pending tokens first, then persist this one
  flushTokenBuffer();
  seq++;
  const record: TurnEvent = {
    type: 'event',
    turn_id: turnId,
    seq,
    ts: new Date().toISOString(),
    kind: event.type,
    data: { ...event } as Record<string, unknown>,
  };
  this.turnStore.writeEvent(chatId, record);
  turnBus.emit(chatId, turnId, record);
};
```

Then in the end of the `response` promise body, call `flushTokenBuffer()` before the end-envelope write.

**Tradeoff now named in code:** live bus emits immediately (snappy for connected clients) but disk is batched. A backgrounded-then-reconnected client that resumes via JSONL catch-up will see tokens in 8-token or 100ms chunks rather than individual chars — acceptable. A crash loses ≤100ms of tokens; their turn is already marked `pending` → becomes `orphaned`; acceptable.

- [ ] **Step 2: Typecheck + restart + smoke test**

```bash
npm run build
pm2 restart home23-<agent>-harness
```

Send a long-reply message. Watch:
```bash
tail -f instances/<agent>/conversations/dashboard-<agent>-*.jsonl
```

Expected: `response_chunk` events appear in batches of ~8 tokens or every ~100ms, not per-character.

- [ ] **Step 3: Commit**

```bash
git add src/agent/loop.ts
git commit -m "perf(loop): batch response_chunk disk writes (live bus unchanged)"
```

---

## Task 11: End-to-end verification

- [ ] **Step 1: Run through the scenarios**

With `pm2 logs home23-<agent>-harness` tailing, in Safari:

| # | Scenario | Expected |
|---|---|---|
| 1 | Send short message, tab stays foreground | Identical to pre-change behavior |
| 2 | Send message, hide Safari 30s, return | Full reply rendered; "reconnecting…" flashes briefly |
| 3 | Send message, hide Safari 5min, return | Pending-turn resume triggers; full reply rendered |
| 4 | Send message, kill Safari tab, reopen `/home23/chat` mid-reply | Pending-turn resume; reply completes |
| 5 | Send message, hit Stop | `stopped` envelope; UI shows "Stopped" |
| 6 | Send two messages in quick succession | Second POST returns 409 with in-flight turn_id; UI handles gracefully |
| 7 | Restart harness mid-turn (`pm2 restart`), reopen chat | Pending turn marked `orphaned`; UI shows "interrupted — try resending" |
| 8 | Evobrew chat still works | Old `/api/chat` endpoint untouched — evobrew unaffected |

- [ ] **Step 2: Confirm JSONL shape**

```bash
tail -30 instances/<agent>/conversations/dashboard-<agent>-*.jsonl | jq -c 'select(.type == "turn" or .type == "event") | {type, turn_id, seq, kind, status}'
```

Expected: alternating pending envelopes → event records with incrementing seq → complete/error/stopped envelope with `last_seq` matching the final event's seq.

- [ ] **Step 3: Final commit — update plan with observed behavior (optional)**

If anything surprised you, note it at the bottom of this plan as a postmortem block. Then:

```bash
git push origin main
```

(Or create a PR if this landed on a branch.)

---

## Deferred (explicit non-goals)

- **Web Push / PWA notifications.** Separate plan. Requires VAPID keys, service worker, iOS 16.4+ Home Screen install, manifest. Worth ~1 focused session later.
- **Native iOS wrapper.** Separate plan. WKWebView + APNs + Xcode project. Leverages all of the above.
- **Byte-offset index sidecar for catch-up.** Only needed when conversations exceed ~10MB. Defer.
- **Multi-tab coordination.** Current design already works — both tabs subscribe to the same TurnBus. No extra work needed.
- **Replacing evobrew's `/api/chat`.** Out of scope. Evobrew keeps the old endpoint.
